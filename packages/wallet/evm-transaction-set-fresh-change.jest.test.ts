// Change of any amount is fresh money: on Monad the node judges a transfer against the sender's
// balance of `spendSpacingBlocks + 1` blocks back, so a transfer out of change offered sooner is
// refused, and those bytes stay refused (docs/protocol/chains/monad-reserve-balance.md, "Money
// that has just arrived"; measured again in #1939 on a 20 MON deposit). Change of 10 MON or more
// used to be listed as spendable at once.
import { Transaction, Wallet, parseEther } from 'ethers'
import { EvmCoinList, type StoredEvmListCoin } from './evm-coin-list'
import { MemoryRecordStore } from './storage/evm-coin-store'
import { EvmNativeOperationJournal } from './storage/evm-native-operation-journal'
import { constructWhenSpendable, EvmTransactionSetPreparer } from './evm-transaction-set'
import {
  EvmTransactionSetInsufficientFundsError,
  type EvmTransactionSetPolicy,
  type PreparedEvmTransactionSet,
} from './evm-transaction-set-types'
import { fundsSettleBlocks } from './chain/evm-spend-rule'

const signer = (index: number) => new Wallet('0x' + index.toString(16).padStart(64, '0'))
const RECIPIENT = signer(50).address
const kdf = () => RECIPIENT
// The Monad rule as the registry configures it (chains-registry.ts): 10 MON, 3 blocks.
const spendRule = { belowWei: parseEther('10'), waitBlocks: 3 }
const MINED = 101
const policyAt = (head: number): EvmTransactionSetPolicy => ({
  sourceOrder: ['stealth', 'stamp', 'change', 'deterministic', 'root', 'identity'],
  gasPriceWei: 1n,
  paymentGasLimit: () => 21000n,
  changeGasLimit: 21000n,
  paymentFeeIsExact: true,
  dustWei: 1000n,
  radix: 2,
  jitterBps: 0,
  // One change output, so the change is one coin well above the 10 MON reserve.
  maxChangeOutputs: 1,
  head,
  spendRule,
})

const feePaid = (set: PreparedEvmTransactionSet) =>
  [...set.bundle, ...set.otherTransactions].reduce((sum, tx) => {
    const parsed = Transaction.from(tx.rawTransaction)
    return sum + parsed.gasLimit * parsed.gasPrice!
  }, 0n)

async function withLargeChange() {
  let head = 100
  const coins = await EvmCoinList.open(new MemoryRecordStore<StoredEvmListCoin>())
  await coins.put({
    account: signer(1).address,
    privateKey: signer(1).privateKey,
    nonce: 0,
    valueWei: parseEther('50'),
    origin: 'stealth',
  })
  const journal = new EvmNativeOperationJournal({
    testOnlyEphemeral: true,
    binding: { chainIdentifier: 'monad-testnet', nativeChainId: '10143', publicTuple: 'fresh-change' },
  })
  await journal.Open()
  const preparer = new EvmTransactionSetPreparer({
    coins,
    journal,
    policy: () => policyAt(head),
    recoverySpendRule: spendRule,
    random: () => 0.5,
    deriveChange: (index: number) => ({
      account: signer(100 + index).address.toLowerCase(),
      privateKey: signer(100 + index).privateKey,
      changeIndex: index,
    }),
  })
  await preparer.constructTransactionSet({ operationId: 'first', amountWei: parseEther('5'), kdf })
  const row = preparer.getOperation('first')!
  const changeIndex = row.members.findIndex(member => member.transactionSet?.role === 'change')
  const member = row.members[changeIndex]!
  const tx = Transaction.from(member.signed!.rawTransaction)
  expect(tx.value).toBeGreaterThanOrEqual(spendRule.belowWei)
  const blockHash = '0x' + '22'.repeat(32)
  // Every member of the first send is mined in block 101; the change goes to its own account.
  for (const [index, each] of row.members.entries()) {
    const signed = Transaction.from(each.signed!.rawTransaction)
    await preparer.recordObservation(
      'first',
      index,
      {
        state: 'included-success',
        transactionHash: each.signed!.transactionHash,
        blockHash,
        blockNumber: MINED,
        transactionIndex: index,
        feeWei: '21000',
      },
      {
        blockHash,
        blockNumber: MINED,
        nonce: signed.nonce + 1,
        balanceWei: each.transactionSet!.balanceAfterWei,
      },
    )
  }
  return {
    coins,
    journal,
    preparer,
    change: tx.to!.toLowerCase(),
    changeValue: tx.value,
    setHead: (block: number) => {
      head = block
    },
  }
}

describe('change of 10 MON or more is fresh money', () => {
  it('is listed as spendable only from the block the node judges it from', async () => {
    const f = await withLargeChange()
    try {
      expect(fundsSettleBlocks(spendRule.waitBlocks)).toBe(4)
      expect(f.coins.get(f.change, 0)?.spendableFromBlock).toBe(MINED + 4)
    } finally {
      await f.journal.Close()
    }
  })

  it('is not selected before that block, by the quote or by construction, and is after it', async () => {
    const f = await withLargeChange()
    try {
      const request = { amountWei: parseEther('3'), kdf }
      for (const head of [MINED, MINED + 3]) {
        f.setHead(head)
        const quoted = await f.preparer.quoteTransactionSet(request).catch(error => error)
        expect(quoted).toBeInstanceOf(EvmTransactionSetInsufficientFundsError)
        const refused = await f.preparer
          .constructTransactionSet({ ...request, operationId: `early-${head}` })
          .catch(error => error)
        expect(refused).toBeInstanceOf(EvmTransactionSetInsufficientFundsError)
        // The send waits for that block (the existing rule), it is not refused outright.
        expect(refused.spendableFromBlock).toBe(MINED + 4)
      }
      f.setHead(MINED + 4)
      const quote = await f.preparer.quoteTransactionSet(request)
      const set = await f.preparer.constructTransactionSet({
        ...request,
        operationId: 'on-time',
        maxFeeWei: quote.feeWei,
      })
      expect(set.bundle.map(tx => tx.sourceAccount)).toEqual([f.change])
      expect(feePaid(set)).toBe(quote.feeWei)
      expect(quote.inputCount).toBe(1)
    } finally {
      await f.journal.Close()
    }
  })

  it('a send that would pick it too early waits for its block once and then pays from it', async () => {
    const f = await withLargeChange()
    try {
      f.setHead(MINED + 1)
      const waited: number[] = []
      const set = await constructWhenSpendable(
        () => f.preparer.constructTransactionSet({ operationId: 'waits', amountWei: parseEther('3'), kdf }),
        {
          untilBlock: async block => {
            waited.push(block)
          },
          refresh: async () => f.setHead(waited.at(-1)!),
        },
      )
      expect(waited).toEqual([MINED + 4])
      expect(set.bundle.map(tx => tx.sourceAccount)).toEqual([f.change])
    } finally {
      await f.journal.Close()
    }
  })

  it('a send picks another settled coin instead while the change is too fresh', async () => {
    const f = await withLargeChange()
    try {
      const other = signer(9)
      await f.coins.put({
        account: other.address,
        privateKey: other.privateKey,
        nonce: 0,
        valueWei: parseEther('8'),
        // Later in the source order than change: picked only because the change must wait.
        origin: 'root',
      })
      f.setHead(MINED + 1)
      const request = { amountWei: parseEther('3'), kdf }
      const quote = await f.preparer.quoteTransactionSet(request)
      const set = await f.preparer.constructTransactionSet({
        ...request,
        operationId: 'other-coin',
        maxFeeWei: quote.feeWei,
      })
      expect(set.bundle.map(tx => tx.sourceAccount)).toEqual([other.address.toLowerCase()])
      expect(feePaid(set)).toBe(quote.feeWei)
    } finally {
      await f.journal.Close()
    }
  })
})
