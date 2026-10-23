import { Wallet, type Provider } from 'ethers'
import { EvmCoinList } from './evm-coin-list'
import { EvmCoinListSync } from './evm-coin-list-sync'
import { EvmBlockWatcher } from './evm-block-watcher'
import { MemoryRecordStore } from './storage/evm-coin-store'
import { EvmNativeOperationJournal } from './storage/evm-native-operation-journal'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import {
  EVM_TRANSACTION_SET_SOURCE_ORDER,
  EvmTransactionSetInsufficientFundsError,
  type EvmTransactionSetPolicy,
} from './evm-transaction-set-types'

const key = (index: number) =>
  new Wallet('0x' + index.toString(16).padStart(64, '0'))

async function fixture(
  historyAvailable: boolean,
  maxChangeOutputs = 16,
  onlySecondary = false,
  matureAlternative = false,
) {
  let head = 100
  const secondary = key(2).address.toLowerCase()
  const coins = await EvmCoinList.open(new MemoryRecordStore())
  // This account spent in block100. Latest state is available; some real RPCs cannot
  // answer historical state queries. Inventory sync deliberately treats those as optional.
  const provider = {
    getBlockNumber: jest.fn(async () => head),
    getBalance: jest.fn(async (address: string) =>
      address.toLowerCase() === key(1).address.toLowerCase()
        ? 321001n
        : 1000000n,
    ),
    getTransactionCount: jest.fn(
      async (address: string, block?: number | string) => {
        if (address.toLowerCase() !== secondary) return 0
        if (typeof block === 'number') {
          if (!historyAvailable) throw new Error('historical state unavailable')
          return block < 100 ? 0 : 1
        }
        return 1
      },
    ),
    broadcastTransaction: jest.fn(),
  }
  const watcher = new EvmBlockWatcher({ provider })
  const sync = new EvmCoinListSync({
    list: coins,
    provider: provider as unknown as Provider,
    watcher,
    spendSpacingBlocks: 2,
    sources: () =>
      (onlySecondary ? [2] : matureAlternative ? [1, 2, 3] : [1, 2]).map(
        index => ({
          account: key(index).address,
          origin:
            index === 1
              ? ('stealth' as const)
              : index === 2
              ? ('root' as const)
              : ('identity' as const),
          privateKey: () => key(index).privateKey,
        }),
      ),
  })
  await sync.refresh({ all: true })
  const journal = new EvmNativeOperationJournal({
    testOnlyEphemeral: true,
    binding: {
      chainIdentifier: 'monad-testnet',
      nativeChainId: '10143',
      publicTuple: 'continuation-spacing',
    },
  })
  await journal.Open()
  const policy = (): EvmTransactionSetPolicy => ({
    sourceOrder: EVM_TRANSACTION_SET_SOURCE_ORDER,
    gasPriceWei: 1n,
    paymentGasLimit: () => 21000n,
    paymentFeeIsExact: true,
    changeGasLimit: 21000n,
    dustWei: 210000n,
    radix: 2,
    jitterBps: 1500,
    maxChangeOutputs,
    head,
    spendRule: { belowWei: 950000n, waitBlocks: 2 },
  })
  const preparer = new EvmTransactionSetPreparer({
    coins,
    journal,
    policy,
    recoverySpendRule: policy().spendRule,
    canSelectCoin: coin => !sync.isDirty(coin.account),
    random: () => 0.01,
    deriveChange: index => ({
      account: key(index + 100).address,
      privateKey: key(index + 100).privateKey,
      changeIndex: index,
    }),
  })
  return {
    coins,
    journal,
    preparer,
    provider,
    secondary,
    advance: async (height: number) => {
      head = height
      await sync.refresh({ all: true })
    },
    close: async () => {
      await sync.stop()
      watcher.stop()
      await journal.Close()
    },
  }
}

it.each([
  [false, 1n, 16],
  [false, 10000n, 16],
  [false, 1n, 1],
  [true, 1n, 16],
  [true, 10000n, 16],
] as const)(
  'waits for full-source continuation eligibility with sync inventory (history=%s,reserve=%s,maxChanges=%s)',
  async (history, reserve, maxChanges) => {
    const f = await fixture(history, maxChanges)
    try {
      const source = f.coins.latestOf(f.secondary)!
      expect(source).toMatchObject({
        nonce: 1,
        lastSpentInBlock: 100,
        valueWei: 1000000n,
      })
      expect(source.spendableFromBlock).toBe(history ? 102 : undefined)
      expect(source.after).toBeUndefined()
      const before = f.coins.all()
      // Both continuation amounts must wait for full-source eligibility, independent
      // of how much nominal reserve could have fitted above this account's threshold.
      const request = {
        operationId: 'quiet-continuation',
        amountWei: 300000n,
        reserveForContinuationWei: reserve,
        kdf: () => key(50).address,
      }
      await expect(
        f.preparer.constructTransactionSet(request),
      ).rejects.toBeInstanceOf(EvmTransactionSetInsufficientFundsError)
      expect(f.coins.all()).toEqual(before)
      expect(f.coins.heldBy(request.operationId)).toEqual([])
      expect(f.journal.list()).toEqual([])
      expect(f.provider.broadcastTransaction).not.toHaveBeenCalled()
      if (!history) {
        await f.advance(101)
        expect(f.coins.latestOf(f.secondary)!.lastSpentInBlock).toBe(100)
        await expect(
          f.preparer.constructTransactionSet(request),
        ).rejects.toBeInstanceOf(EvmTransactionSetInsufficientFundsError)
        expect(f.coins.heldBy(request.operationId)).toEqual([])
        expect(f.journal.list()).toEqual([])
      }
      await f.advance(102)
      expect(f.coins.latestOf(f.secondary)!.lastSpentInBlock).toBe(100)
      const prepared = await f.preparer.constructTransactionSet(request)
      expect(prepared.bundle).toHaveLength(1)
      expect(prepared.bundle[0]!.valueWei).toBe(300000n)
      expect(
        prepared.otherTransactions.some(tx => tx.sourceAccount === f.secondary),
      ).toBe(true)
      expect(f.journal.list()).toHaveLength(1)
      expect(
        f.journal.list()[0]!.members.every(member => !member.exposed),
      ).toBe(true)
      expect(f.provider.broadcastTransaction).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  },
)

it('permits an above-reserve recipient payment before the quiet window and delays its subsequent drain', async () => {
  const f = await fixture(false, 16, true)
  try {
    const prepared = await f.preparer.constructTransactionSet({
      operationId: 'partial-recipient',
      amountWei: 10000n,
      kdf: () => key(50).address,
    })
    expect(prepared.bundle[0]!.sourceAccount).toBe(f.secondary)
    const row = f.journal.list()[0]!
    expect(row.members[0]!.transactionSet).toMatchObject({
      role: 'payment',
      balanceAfterWei: '969000',
    })
    for (const member of row.members.slice(1))
      if (BigInt(member.transactionSet!.balanceAfterWei) < 950000n)
        expect(member.transactionSet!.predecessorWaitBlocks).toBe(2)
  } finally {
    await f.close()
  }
})

it.each([false, true])(
  'funds actual continuation from a mature alternative instead of reserving an immature input (legacy=%s)',
  async legacy => {
    const f = await fixture(false, 16, false, true)
    try {
      const before = f.coins.latestOf(f.secondary)!
      const request = {
        operationId: 'mature-alternative',
        amountWei: 300000n,
        reserveForContinuationWei: 10000n,
        maxFeeWei: 300000n,
        kdf: () => key(50).address,
      }
      const construct = () =>
        legacy
          ? f.preparer.constructLegacyTransactionSet(request)
          : f.preparer.constructTransactionSet(request)
      const prepared = await construct()
      expect(prepared.bundle).toHaveLength(1)
      expect(prepared.bundle[0]!.sourceAccount).toBe(
        key(1).address.toLowerCase(),
      )
      expect(prepared.bundle[0]!.valueWei).toBe(request.amountWei)
      expect(
        prepared.otherTransactions.every(
          tx => tx.sourceAccount === key(3).address.toLowerCase(),
        ),
      ).toBe(true)
      expect(
        prepared.otherTransactions.reduce((sum, tx) => sum + tx.valueWei, 0n),
      ).toBeGreaterThanOrEqual(request.reserveForContinuationWei)
      expect(f.coins.latestOf(f.secondary)).toEqual(before)
      expect(BigInt(f.journal.list()[0]!.maximumFeeWei)).toBeLessThanOrEqual(
        request.maxFeeWei,
      )
      expect(await construct()).toEqual(prepared)
    } finally {
      await f.close()
    }
  },
)
