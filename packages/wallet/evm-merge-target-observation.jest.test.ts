import { mkdir, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Transaction, Wallet, type Provider } from 'ethers'
import { installEvmTransactionSetRuntime } from './evm-transaction-set-runtime'
import { EvmCoinList, type StoredEvmListCoin } from './evm-coin-list'
import { EvmChangePool } from './evm-change-pool'
import { EvmSubAccountPool } from './evm-account-pool'
import { MonadHdKeyring, MonadChangeKeyring } from './secp256k1-hd-keyring'
import { MonadIdentity } from './evm-identity'
import { MemoryRecordStore, type EvmCoin } from './storage/evm-coin-store'
import { EvmNativeOperationJournal } from './storage/evm-native-operation-journal'
import { EvmMergeTargets, evmMergeAnchor } from './evm-merge-targets'
import { consolidationId } from './evm-coin-consolidator'
import {
  EVM_TRANSACTION_SET_SOURCE_ORDER,
  EvmTransactionSetInsufficientFundsError,
} from './evm-transaction-set-types'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it.each([
  { remaining: 0n, concurrentSync: false, newerFailure: false },
  { remaining: 300000n, concurrentSync: false, newerFailure: false },
  { remaining: 0n, concurrentSync: true, newerFailure: false },
  { remaining: 1000n, concurrentSync: true, newerFailure: false },
  { remaining: 1000n, concurrentSync: true, newerFailure: true },
])(
  'observes merge state with $remaining wei remaining and concurrent source sync $concurrentSync; newer failed evidence $newerFailure',
  async ({ remaining, concurrentSync, newerFailure }) => {
    const mnemonic =
      'test test test test test test test test test test test junk'
    const keyring = MonadHdKeyring.fromMnemonic(mnemonic)
    const changes = MonadChangeKeyring.fromMnemonic(mnemonic)
    const main = new Wallet('0x' + '11'.repeat(32))
    const identity = MonadIdentity.fromSeed({ mnemonic })
    const sourceKeys = [
      keyring.deriveSubAccount(0),
      keyring.deriveSubAccount(1),
    ]
    const balances = new Map(
      sourceKeys.map((key) => [key.address.toLowerCase(), 1000000n])
    )
    const nonces = new Map<string, number>()
    const receipts = new Map<
      string,
      {
        status: number
        hash: string
        blockHash: string
        blockNumber: number
        index: number
        fee: bigint
      }
    >()
    const hash = '0x' + 'ab'.repeat(32)
    let failTarget: string | undefined
    let freshTargetDeposit: string | undefined
    let chainHead = 100
    let heldBalanceRead:
      | { account: string; entered: () => void; promise: Promise<void> }
      | undefined
    let deadlocked = false
    const provider = {
      getBlockNumber: async () => chainHead,
      getBlock: async (block: number) => ({
        number: typeof block === 'number' ? block : 100,
        hash,
      }),
      getTransactionCount: jest.fn(
        async (address: string) => nonces.get(address.toLowerCase()) ?? 0
      ),
      getBalance: jest.fn(async (address: string, block?: number) => {
        if (
          heldBalanceRead?.account === address.toLowerCase() &&
          block === undefined
        ) {
          heldBalanceRead.entered()
          await heldBalanceRead.promise
        }
        if (address.toLowerCase() === failTarget)
          throw new Error('target observation unavailable')
        if (
          address.toLowerCase() === freshTargetDeposit &&
          typeof block === 'number' &&
          block < 100
        )
          return 0n
        return balances.get(address.toLowerCase()) ?? 0n
      }),
      getTransactionReceipt: async (tx: string) => receipts.get(tx) ?? null,
    }
    const directory = await mkdtemp(join(tmpdir(), 'frank-merge-observation-'))
    const devices = []
    for (const device of ['A', 'B']) {
      const inventoryStore = new MemoryRecordStore<StoredEvmListCoin>()
      const coins = await EvmCoinList.open(inventoryStore)
      for (const key of sourceKeys)
        await coins.put({
          account: key.address,
          privateKey: key.privateKey,
          nonce: 0,
          valueWei: 1000000n,
          origin: 'deterministic',
        })
      const journalOptions = {
        location: join(directory, device),
        binding: {
          chainIdentifier: 'monad-regtest',
          nativeChainId: '20143',
          publicTuple: 'same-wallet',
        },
      }
      await mkdir(journalOptions.location, { recursive: true })
      const journal = new EvmNativeOperationJournal(journalOptions)
      await journal.Open()
      const targets = new EvmMergeTargets('monad-regtest', changes)
      const makeRuntime = (
        coins: EvmCoinList,
        journal: EvmNativeOperationJournal,
        targets: EvmMergeTargets
      ) =>
        installEvmTransactionSetRuntime({
          mainAccount: main,
          identity,
          pool: new EvmSubAccountPool({ keyring }),
          coinList: coins,
          changeKeyring: changes,
          changePool: new EvmChangePool({ keyring: changes }),
          coinStore: new MemoryRecordStore<EvmCoin>(),
          journal,
          provider: provider as unknown as Provider,
          kind: 'monad',
          knownNoCodeAddress: main.address,
          mergeTargets: targets,
          spendSpacingBlocks: 3,
          policy: () => ({
            sourceOrder: EVM_TRANSACTION_SET_SOURCE_ORDER,
            gasPriceWei: 1n,
            paymentGasLimit: () => 21000n,
            changeGasLimit: 21000n,
            paymentFeeIsExact: true,
            dustWei: 1000n,
            radix: 2,
            jitterBps: 0,
            maxChangeOutputs: 16,
            head: chainHead,
            spendRule: { belowWei: 0n, waitBlocks: 3 },
          }),
        })
      const runtime = makeRuntime(coins, journal, targets)
      // Warm runtime before the original merge lands, as a running second frontend would be.
      await runtime.refresh()
      const target = targets.targetFor(
        evmMergeAnchor(
          sourceKeys.map((key) => ({ account: key.address, nonce: 0 }))
        )
      )
      const id = consolidationId(
        'monad-regtest',
        target.account,
        coins.liveUnspent()
      )
      const prepared =
        await runtime.transactionSetPreparer.constructTransactionSet({
          operationId: id,
          amountWei: 1958000n,
          kdf: () => target.account,
          sourceAccounts: sourceKeys.map((key) => key.address),
          maxPaymentParts: 2,
          maxFeeWei: 42000n,
        })
      devices.push({
        device,
        coins,
        journal,
        runtime,
        target,
        id,
        prepared,
        inventoryStore,
        journalOptions,
        makeRuntime,
        targets,
      })
    }
    try {
      const [a, b] = devices
      expect(a.prepared).toEqual(b.prepared)
      for (const tx of a.prepared.bundle) {
        balances.set(tx.sourceAccount, 0n)
        nonces.set(tx.sourceAccount, 1)
        receipts.set(tx.txHash, {
          status: 1,
          hash: tx.txHash,
          blockHash: hash,
          blockNumber: 10,
          index: 0,
          fee: 21000n,
        })
      }
      balances.set(a.target.account, 1958000n)
      if (concurrentSync) {
        const members = (await a.runtime.transactionSetPreparer.readOperation(
          a.id
        ))!.members
        const first = members[0]!,
          last = members.at(-1)!
        const included = (transactionHash: string) => ({
          state: 'included-success' as const,
          transactionHash,
          blockHash: hash,
          blockNumber: 10,
          transactionIndex: 0,
          feeWei: '21000',
        })
        const account = (balanceWei: bigint) => ({
          blockHash: hash,
          blockNumber: 100,
          nonce: 1,
          balanceWei: balanceWei.toString(),
        })
        await a.runtime.transactionSetPreparer.recordObservation(
          a.id,
          0,
          included(first.signed!.transactionHash),
          account(0n)
        )
        // A previously discovered target causes onPaymentIncluded to launch broad sync. That
        // pass must write a dirty source's residual while settlement observes the target.
        a.targets.watch(a.target)
        balances.set(last.source.address, remaining)
        a.runtime.coinListSync.markDirty(last.source.address)
        const sourceRead = deferred(),
          releaseRead = deferred()
        heldBalanceRead = {
          account: last.source.address,
          entered: sourceRead.resolve,
          promise: releaseRead.promise,
        }
        const put = jest.spyOn(a.coins, 'put')
        let completed = false
        const observing = a.runtime.transactionSetPreparer
          .recordObservation(
            a.id,
            members.length - 1,
            included(last.signed!.transactionHash),
            account(0n)
          )
          .then(() => {
            completed = true
          })
        await sourceRead.promise
        expect(completed).toBe(false)
        expect(
          (await a.runtime.transactionSetPreparer.readOperation(
            a.id
          ))!.members.at(-1)!.transactionSet!.inventoryApplied
        ).not.toBe(true)
        const newerAccount = { ...account(777n), nonce: 2, blockNumber: 101 }
        if (newerFailure) {
          const originalPut = a.inventoryStore.put.bind(a.inventoryStore)
          const failNewer = jest
            .spyOn(a.inventoryStore, 'put')
            .mockImplementation(async (key, coin) => {
              if (coin.account === last.source.address && coin.nonce === 2)
                throw new Error('newer source projection failed')
              await originalPut(key, coin)
            })
          // This call can project while the older call's target RPC is out. Its durable journal
          // evidence changes, but a failed local write must remain incomplete after the old RPC.
          await expect(
            a.runtime.transactionSetPreparer.recordObservation(
              a.id,
              members.length - 1,
              included(last.signed!.transactionHash),
              newerAccount
            )
          ).rejects.toThrow('newer source projection failed')
          failNewer.mockRestore()
        }
        releaseRead.resolve()
        let deadline!: ReturnType<typeof setTimeout>
        const finished = await Promise.race([
          observing.then(() => true),
          new Promise<boolean>((resolve) => {
            deadline = setTimeout(() => resolve(false), 1000)
          }),
        ]).finally(() => clearTimeout(deadline))
        deadlocked = !finished
        // The positive residual queued a real authoritative sync put; zero is the control.
        expect(
          put.mock.calls.some(
            ([coin]) =>
              coin.account === last.source.address &&
              coin.nonce === 1 &&
              coin.valueWei === remaining
          )
        ).toBe(remaining > 0n)
        expect(finished).toBe(true)
        if (newerFailure) {
          expect(
            (await a.runtime.transactionSetPreparer.readOperation(
              a.id
            ))!.members.at(-1)!.transactionSet!.inventoryApplied
          ).not.toBe(true)
          nonces.set(last.source.address, 2)
          balances.set(last.source.address, 777n)
          await a.runtime.transactionSetPreparer.recordObservation(
            a.id,
            members.length - 1,
            included(last.signed!.transactionHash),
            newerAccount
          )
          expect(a.coins.latestOf(last.source.address)).toMatchObject({
            nonce: 2,
            valueWei: 777n,
          })
        }
        expect(
          (await a.runtime.transactionSetPreparer.readOperation(
            a.id
          ))!.members.every((member) => member.transactionSet!.inventoryApplied)
        ).toBe(true)
        expect(a.coins.latestOf(a.target.account)).toMatchObject({
          nonce: 0,
          valueWei: 1958000n,
        })
        put.mockRestore()
        return
      }
      await a.runtime.transactionSetLifecycle.observe(
        a.id,
        provider as unknown as Provider
      )
      expect(a.coins.latestOf(a.target.account)?.nonce).toBe(0)
      const spent =
        await a.runtime.transactionSetPreparer.constructTransactionSet({
          operationId: 'device-a-spends-target',
          amountWei: 1937000n,
          kdf: () => new Wallet('0x' + '22'.repeat(32)).address,
          sourceAccounts: [a.target.account],
        })
      expect(spent.bundle[0].nonce).toBe(0)
      const tx = spent.bundle[0]
      receipts.set(tx.txHash, {
        status: 1,
        hash: tx.txHash,
        blockHash: hash,
        blockNumber: 20,
        index: 0,
        fee: 21000n,
      })
      balances.set(a.target.account, 0n)
      nonces.set(a.target.account, 1)
      await a.runtime.transactionSetLifecycle.observe(
        'device-a-spends-target',
        provider as unknown as Provider
      )
      // Another frontend can have spent and received a fresh deposit since these old receipts.
      balances.set(b.target.account, remaining)
      if (remaining > 0n) freshTargetDeposit = b.target.account
      expect(b.coins.latestOf(b.target.account)).toBeUndefined()
      provider.getBalance.mockClear()
      provider.getTransactionCount.mockClear()
      failTarget = b.target.account
      const warning = jest
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined)
      try {
        await expect(
          b.runtime.transactionSetLifecycle.observe(
            b.id,
            provider as unknown as Provider
          )
        ).rejects.toThrow('Merge target chain observation incomplete')
      } finally {
        warning.mockRestore()
      }
      expect(b.runtime.coinListSync.isDirty(b.target.account)).toBe(true)
      expect(b.coins.latestOf(b.target.account)).toBeUndefined()
      const interrupted = await b.runtime.transactionSetPreparer.readOperation(
        b.id
      )
      expect(
        interrupted!.members.at(-1)!.transactionSet!.inventoryApplied
      ).not.toBe(true)
      // Restart with no in-memory watched targets or dirty marks: unfinished projection must
      // restore target ownership and observe again from the durable original journal.
      await b.runtime.stop()
      await b.journal.Close()
      b.coins = await EvmCoinList.open(b.inventoryStore)
      b.journal = new EvmNativeOperationJournal(b.journalOptions)
      await b.journal.Open()
      b.runtime = b.makeRuntime(
        b.coins,
        b.journal,
        new EvmMergeTargets('monad-regtest', changes)
      )
      failTarget = undefined
      await b.runtime.transactionSetLifecycle.observe(
        b.id,
        provider as unknown as Provider
      )
      expect(b.runtime.coinListSync.isDirty(b.target.account)).toBe(false)
      if (remaining === 0n)
        expect(b.coins.latestOf(b.target.account)).toBeUndefined()
      else
        expect(b.coins.latestOf(b.target.account)).toMatchObject({
          nonce: 1,
          valueWei: remaining,
          state: 'unspent',
        })
      expect(
        provider.getBalance.mock.calls.some(
          ([account]) => account === b.target.account
        )
      ).toBe(true)
      await b.runtime.refresh()
      // Repeated settlement cannot resurrect nonce zero or the old receipt's full amount.
      await b.runtime.transactionSetLifecycle.observe(
        b.id,
        provider as unknown as Provider
      )
      await expect(
        b.runtime.transactionSetPreparer.constructTransactionSet({
          operationId: 'device-b-stale-payment',
          amountWei: 1937000n,
          kdf: () => new Wallet('0x' + '33'.repeat(32)).address,
          sourceAccounts: [b.target.account],
        })
      ).rejects.toBeInstanceOf(EvmTransactionSetInsufficientFundsError)
      if (remaining > 0n) {
        expect(b.coins.latestOf(b.target.account)?.fundsVisibleFromBlock).toBe(
          104
        )
        await expect(
          b.runtime.transactionSetPreparer.constructTransactionSet({
            operationId: 'device-b-premature-deposit',
            amountWei: remaining - 21000n,
            kdf: () => new Wallet('0x' + '33'.repeat(32)).address,
            sourceAccounts: [b.target.account],
          })
        ).rejects.toBeInstanceOf(EvmTransactionSetInsufficientFundsError)
        chainHead = 104
        const observed =
          await b.runtime.transactionSetPreparer.constructTransactionSet({
            operationId: 'device-b-current-payment',
            amountWei: remaining - 21000n,
            kdf: () => new Wallet('0x' + '33'.repeat(32)).address,
            sourceAccounts: [b.target.account],
          })
        expect(Transaction.from(observed.bundle[0].rawTransaction).nonce).toBe(
          1
        )
        expect(observed.bundle[0].valueWei).toBe(remaining - 21000n)
      }
    } finally {
      for (const d of devices) {
        // Failed liveness assertion must not hang cleanup on the deliberately reproduced cycle.
        if (deadlocked) d.runtime.blockWatcher.stop()
        else await d.runtime.stop()
        await d.journal.Close()
      }
      await rm(directory, { recursive: true, force: true })
    }
  }
)
