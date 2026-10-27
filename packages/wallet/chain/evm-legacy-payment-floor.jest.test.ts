/** Send to Address (a transfer to an address outside the wallet) is refused below the payment
 * floor before anything is signed, like Send to Contact and chat stealth payments; "Send max"
 * is refused the same way when everything the wallet can send is below it. A transfer to an
 * address the wallet owns (its main account, a dApp persona) is not a payment to anyone else
 * and is not held to it. */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Wallet, Transaction, type Provider } from 'ethers'
import { EvmNativeOperationJournal } from '../storage/evm-native-operation-journal'
import { LevelRecordStore } from '../storage/evm-coin-store'
import { EvmCoinList, type StoredEvmListCoin } from '../evm-coin-list'
import { EvmTransactionSetPreparer } from '../evm-transaction-set'
import { EvmTransactionSetLifecycle } from '../evm-transaction-set-lifecycle'
import { EVM_TRANSACTION_SET_SOURCE_ORDER } from '../evm-transaction-set-types'
import { createEvmTransactionSetSubmission } from '../evm-transaction-set-submission'
import { createLegacyTransactionSetPayments } from './evm-legacy-transaction-set'
import { ContactPaymentBelowFloorError } from './chain-wallet'
import { evmPaymentFloorWei } from './payment-floor'

const key = (n: number) => new Wallet('0x' + n.toString(16).padStart(64, '0'))
const blockHash = '0x' + 'ab'.repeat(32)
const external = '0x00000000000000000000000000000000000be5e5'
// Gas price 1 wei, so a plain transfer costs 21,000 wei and the payment floor is ten of them;
// the policy's `dustWei` is the same floor, as in the wallet.
const FLOOR = evmPaymentFloorWei(1n)
// An account the wallet owns (a dApp persona, say): the composed wallet derives this from its keys.
const OWN = key(50).address

function network() {
  const head = 10
  const mined = new Map<string, { tx: Transaction; block: number; index: number }>()
  const broadcasts: string[] = []
  const provider = {
    getNetwork: async () => ({ chainId: 10143n }),
    getBlock: async (block: number) => ({ hash: blockHash, number: typeof block === 'number' ? block : head }),
    getBlockNumber: async () => head,
    getTransactionReceipt: async (hash: string) => {
      const item = mined.get(hash)
      return item
        ? { hash, from: item.tx.from, to: item.tx.to, status: 1, blockHash, blockNumber: item.block, index: item.index, fee: item.tx.gasLimit }
        : null
    },
    getTransaction: async (hash: string) => {
      const item = mined.get(hash)
      return item
        ? { hash, from: item.tx.from, to: item.tx.to, chainId: 10143n, value: item.tx.value, data: item.tx.data, blockNumber: item.block, index: item.index }
        : null
    },
    getTransactionCount: async (address: string) =>
      [...mined.values()]
        .filter(item => item.tx.from!.toLowerCase() === address.toLowerCase())
        .reduce((nonce, item) => Math.max(nonce, item.tx.nonce + 1), 0),
    getBalance: async () => 0n,
    broadcastTransaction: jest.fn(async (raw: string) => {
      broadcasts.push(raw)
      const tx = Transaction.from(raw)
      mined.set(tx.hash!, { tx, block: head, index: mined.size })
      return { hash: tx.hash! }
    }),
  }
  return { provider: provider as unknown as Provider, broadcasts, head: () => head }
}

async function fixture(coinValueWei: bigint) {
  const location = await mkdtemp(join(tmpdir(), 'legacy-floor-'))
  const chain = network()
  const store = await LevelRecordStore.open<StoredEvmListCoin>(location, 'inventory')
  const coins = await EvmCoinList.open(store)
  await coins.put({
    account: key(1).address,
    privateKey: key(1).privateKey,
    nonce: 0,
    valueWei: coinValueWei,
    origin: 'stealth',
  })
  const journal = new EvmNativeOperationJournal({
    location,
    binding: { chainIdentifier: 'monad-testnet', nativeChainId: '10143', publicTuple: 'legacy-floor-test' },
  })
  await journal.Open()
  const preparer = new EvmTransactionSetPreparer({
    coins,
    journal,
    policy: () => ({
      sourceOrder: EVM_TRANSACTION_SET_SOURCE_ORDER,
      gasPriceWei: 1n,
      paymentGasLimit: () => 21_000n,
      changeGasLimit: 21_000n,
      paymentFeeIsExact: true,
      dustWei: FLOOR,
      radix: 2,
      jitterBps: 0,
      maxChangeOutputs: 8,
      head: chain.head(),
    }),
    deriveChange: index => ({
      account: key(100 + index).address,
      privateKey: key(100 + index).privateKey,
      changeIndex: index,
    }),
  })
  const lifecycle = new EvmTransactionSetLifecycle({ authority: preparer, provider: chain.provider, head: chain.head })
  const submission = createEvmTransactionSetSubmission({
    preparer,
    lifecycle,
    provider: chain.provider,
    refresh: async () => undefined,
    operations: () => journal.list(),
  })
  const legacy = createLegacyTransactionSetPayments({
    preparer,
    sendTransaction: prepared => submission.sendTransaction(prepared),
    refresh: async () => undefined,
    operations: () => journal.list(),
    readOperation: id => journal.readOperation(id),
    isOwnAccount: address => address.toLowerCase() === OWN.toLowerCase(),
  })
  return {
    chain,
    coins,
    journal,
    legacy,
    close: async () => {
      await journal.Close()
      await store.close()
      await rm(location, { recursive: true, force: true })
    },
  }
}

test('a transfer to an outside address below the payment floor is refused, naming the minimum, before anything is signed or reserved', async () => {
  const f = await fixture(10_000_000n)
  try {
    const onSigned = jest.fn(async () => undefined)
    const refused = await f.legacy
      .sendLegacy({ recipient: { raw: external }, value: FLOOR - 1n, onSigned })
      .catch(error => error)
    expect(refused).toBeInstanceOf(ContactPaymentBelowFloorError)
    expect(refused.floorWei).toBe(FLOOR)
    expect(refused.valueWei).toBe(FLOOR - 1n)
    expect(refused.message).toContain(`pay at least ${FLOOR} wei`)
    // Nothing signed, recorded, broadcast or held.
    expect(onSigned).not.toHaveBeenCalled()
    expect(f.chain.broadcasts).toEqual([])
    expect(f.journal.list()).toEqual([])
    expect(f.coins.isAccountReserved(key(1).address)).toBe(false)
    expect(f.coins.latestOf(key(1).address)?.state).toBe('unspent')
    // The review's quote says the same, so the page can say it before Confirm.
    await expect(
      f.legacy.estimateLegacyFee({ recipient: { raw: external }, value: FLOOR - 1n }),
    ).rejects.toBeInstanceOf(ContactPaymentBelowFloorError)
  } finally {
    await f.close()
  }
})

test('a transfer to an outside address at the payment floor is sent', async () => {
  const f = await fixture(10_000_000n)
  try {
    const quote = await f.legacy.estimateLegacyFee({ recipient: { raw: external }, value: FLOOR })
    expect(quote.totalFee).toBeGreaterThan(0n)
    const sent = await f.legacy.sendLegacy({ recipient: { raw: external }, value: FLOOR })
    expect(sent.totalValueSent).toBe(FLOOR)
    const paid = f.chain.broadcasts.map(raw => Transaction.from(raw))
    expect(paid.find(tx => tx.to?.toLowerCase() === external.toLowerCase())?.value).toBe(FLOOR)
  } finally {
    await f.close()
  }
})

test('Send max is refused, naming the minimum, when everything the wallet can send is below the payment floor', async () => {
  // One coin: 21,000 wei to move it plus 50,000 wei, half the floor.
  const f = await fixture(21_000n + FLOOR / 2n)
  try {
    const refused = await f.legacy
      .estimateLegacyMax({ recipient: { raw: external } })
      .catch(error => error)
    expect(refused).toBeInstanceOf(ContactPaymentBelowFloorError)
    expect(refused.floorWei).toBe(FLOOR)
    expect(refused.valueWei).toBe(FLOOR / 2n)
    expect(f.chain.broadcasts).toEqual([])
    expect(f.journal.list()).toEqual([])
  } finally {
    await f.close()
  }
})

test('Send max at or above the payment floor is offered, and sends', async () => {
  const f = await fixture(21_000n + FLOOR)
  try {
    const max = await f.legacy.estimateLegacyMax({ recipient: { raw: external } })
    expect(max.value).toBe(FLOOR)
    const sent = await f.legacy.sendLegacy({ recipient: { raw: external }, value: max.value, maxFee: max.totalFee })
    expect(sent.totalValueSent).toBe(FLOOR)
  } finally {
    await f.close()
  }
})

test('moving value to an account the wallet owns is not held to the payment floor', async () => {
  const f = await fixture(10_000_000n)
  try {
    await expect(
      f.legacy.estimateLegacyFee({ recipient: { raw: OWN }, value: FLOOR - 1n }),
    ).resolves.toMatchObject({ inputCount: 1 })
    const sent = await f.legacy.sendLegacy({ recipient: { raw: OWN }, value: FLOOR - 1n })
    expect(sent.totalValueSent).toBe(FLOOR - 1n)
    // The same amount to an address the wallet does not own is still refused.
    await expect(
      f.legacy.sendLegacy({ recipient: { raw: external }, value: FLOOR - 1n }),
    ).rejects.toBeInstanceOf(ContactPaymentBelowFloorError)
  } finally {
    await f.close()
  }
})
