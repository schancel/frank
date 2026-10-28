/**
 * Background coin consolidation and the change splitter read one coin distribution
 * (`evm-coin-distribution.ts`), so they never undo each other.
 *
 * Real here: the coin list, the transaction-set journal (on disk where a restart is tested) and
 * the preparer that selects, reserves, signs and journals every payment and every merge. Not
 * real, and narrow: the chain. Settlement is recorded through the preparer's own observation
 * entry point with the values the signed transactions carry, and a merge's fresh account is
 * listed as the coin-list sync lists it after reading the chain (its balance, at the head).
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Transaction, Wallet } from 'ethers'
import { NativeTransactionSubmissionError } from './chain/chain-wallet'
import { EvmCoinList, type EvmListCoin, type StoredEvmListCoin } from './evm-coin-list'
import {
  consolidationId,
  createEvmCoinConsolidator,
  EVM_CONSOLIDATION_PREFIX,
} from './evm-coin-consolidator'
import {
  countPoolCoins,
  evmCoinDistribution,
  planEvmCoinMerge,
} from './evm-coin-distribution'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import {
  EVM_TRANSACTION_SET_SOURCE_ORDER,
  EvmTransactionSetFeeExceededError,
  EvmTransactionSetInsufficientFundsError,
  type EvmTransactionSetPolicy,
  type PreparedEvmTransactionSet,
} from './evm-transaction-set-types'
import { MemoryRecordStore } from './storage/evm-coin-store'
import { EvmNativeOperationJournal } from './storage/evm-native-operation-journal'
import type { TransactionSetSubmission } from './transaction-set'
import { classifyEvmOperation } from './chain/evm-native-operation-status'
import { EVM_MERGE_TARGET_BASE, EvmMergeTargets, evmMergeAnchor } from './evm-merge-targets'
import type { MonadChangeKeyring } from './secp256k1-hd-keyring'

const PRICE = 1_000n
const D = evmCoinDistribution(PRICE)
const FLOOR = D.floorWei
const FEE = D.moveFeeWei
const signer = (index: number) => new Wallet('0x' + index.toString(16).padStart(64, '0'))
const recipient = (index: number) => signer(900_000 + index).address

type Store = MemoryRecordStore<StoredEvmListCoin>

/** One wallet: its list, journal, preparer and consolidator, on one chain. */
async function open(
  options: {
    coinStore?: Store
    journalPath?: string
    chain?: string
    nativeChainId?: string
    head?: { value: number }
    nextIndex?: { value: number }
    keyBase?: number
  } = {},
) {
  const coinStore = options.coinStore ?? new MemoryRecordStore<StoredEvmListCoin>()
  const head = options.head ?? { value: 100 }
  const chain = options.chain ?? 'monad-regtest'
  const keyBase = options.keyBase ?? 10_000
  const coins = await EvmCoinList.open(coinStore)
  const journal = new EvmNativeOperationJournal({
    ...(options.journalPath === undefined
      ? { testOnlyEphemeral: true }
      : { location: options.journalPath }),
    binding: {
      chainIdentifier: chain,
      nativeChainId: options.nativeChainId ?? '20143',
      publicTuple: `consolidation-${chain}`,
    },
  })
  await journal.Open()
  const policy = (): EvmTransactionSetPolicy => ({
    sourceOrder: EVM_TRANSACTION_SET_SOURCE_ORDER,
    gasPriceWei: PRICE,
    paymentGasLimit: () => 21_000n,
    changeGasLimit: 21_000n,
    paymentFeeIsExact: true,
    dustWei: D.floorWei,
    radix: 2,
    jitterBps: 1_500,
    maxChangeOutputs: D.maxChangeOutputs,
    coinDistribution: D,
    head: head.value,
  })
  const derive = (index: number) => ({
    account: signer(keyBase + index).address.toLowerCase(),
    privateKey: signer(keyBase + index).privateKey,
    changeIndex: index,
  })
  // One durable allocator for change and merges, as the change pool is in production.
  const nextIndex = options.nextIndex ?? { value: 0 }
  const allocate = (minimum: number) => {
    const index = Math.max(minimum, nextIndex.value)
    nextIndex.value = index + 1
    return derive(index)
  }
  const included: string[] = []
  let entropy = 11
  const preparer = new EvmTransactionSetPreparer({
    coins,
    journal,
    policy,
    random: () => (entropy = (entropy * 48_271) % 2_147_483_647) / 2_147_483_647,
    deriveChange: derive,
    reserveChange: async (_operation, minimum) => allocate(minimum),
    onPaymentIncluded: account => included.push(account),
  })
  const keyring = {
    deriveChangeAccount: (index: number) => ({ address: derive(index).account, privateKey: derive(index).privateKey }),
  } as unknown as Pick<MonadChangeKeyring, 'deriveChangeAccount'>
  const targets = new EvmMergeTargets(chain, keyring)
  const submitted: PreparedEvmTransactionSet[] = []
  const listed: string[] = []
  let submitFailure: Error | undefined
  const consolidator = createEvmCoinConsolidator({
    chainIdentifier: chain,
    coins,
    preparer,
    operations: () => journal.list(),
    targetFor: anchor => targets.targetFor(anchor),
    listTarget: async target => {
      listed.push(target.account)
    },
    submit: async prepared => {
      submitted.push(prepared)
      if (submitFailure) throw submitFailure
      return {
        operationId: prepared.operationId,
        chainIdentifier: prepared.chainIdentifier,
        status: 'pending',
        pendingTransactionIds: [...prepared.bundle, ...prepared.otherTransactions].map(tx => tx.txHash),
        failedTransactionIds: [],
      } as TransactionSetSubmission
    },
  })
  return {
    coins,
    coinStore,
    journal,
    preparer,
    consolidator,
    head,
    nextIndex,
    included,
    listed,
    targets,
    submitted,
    failSubmit: (error: Error | undefined) => {
      submitFailure = error
    },
    derive,
  }
}
type Fixture = Awaited<ReturnType<typeof open>>

let keys = 1
async function putCoin(
  f: Fixture,
  spec: {
    valueWei: bigint
    origin?: EvmListCoin['origin']
    listedInBlock?: number
    changeIndex?: number
  },
): Promise<string> {
  const key = signer(keys++)
  await f.coins.put({
    account: key.address,
    privateKey: key.privateKey,
    nonce: 0,
    valueWei: spec.valueWei,
    origin: spec.origin ?? 'stamp',
    ...(spec.listedInBlock === undefined ? {} : { listedInBlock: spec.listedInBlock }),
    ...(spec.changeIndex === undefined ? {} : { changeIndex: spec.changeIndex }),
  })
  return key.address.toLowerCase()
}

const pool = (f: Fixture) => countPoolCoins(f.coins.liveUnspent(), D)
const all = (set: PreparedEvmTransactionSet) => [...set.bundle, ...set.otherTransactions]
const sources = (set: PreparedEvmTransactionSet) => new Set(all(set).map(tx => tx.sourceAccount.toLowerCase()))

/** Records every member of a journalled set as included at `block`, as settlement does from the
 * chain: each source's account ends at the nonce after its last member, holding what that
 * member left. */
async function settle(f: Fixture, logicalId: string, block: number): Promise<void> {
  const row = (await f.preparer.readOperation(logicalId))!
  const last = new Map<string, { nonce: number; balanceWei: string }>()
  for (const member of row.members)
    last.set(member.source.address, {
      nonce: Transaction.from(member.unsignedTransaction).nonce,
      balanceWei: member.transactionSet!.balanceAfterWei,
    })
  const blockHash = '0x' + block.toString(16).padStart(64, '0')
  for (const [index, member] of row.members.entries()) {
    const end = last.get(member.source.address)!
    await f.preparer.markExposed(logicalId, index)
    await f.preparer.recordObservation(
      logicalId,
      index,
      {
        state: 'included-success',
        transactionHash: member.signed!.transactionHash,
        blockHash,
        blockNumber: block,
        transactionIndex: index,
        feeWei: (21_000n * PRICE).toString(),
      },
      { blockHash, blockNumber: block, nonce: end.nonce + 1, balanceWei: end.balanceWei },
    )
  }
}

/** A merge landed: what the chain read of its fresh account lists (`EvmCoinListSync`). */
async function listMergeTarget(f: Fixture, set: PreparedEvmTransactionSet, block: number) {
  const target = set.bundle[0]!.destination.toLowerCase()
  const derived = f.targets.targetFor(evmMergeAnchor(all(set).map(tx => ({ account: tx.sourceAccount, nonce: tx.nonce }))))
  expect(derived.account).toBe(target)
  const index = { ...f.derive(derived.changeIndex), changeIndex: derived.changeIndex }
  await f.coins.put({
    account: target,
    privateKey: index.privateKey,
    nonce: 0,
    valueWei: all(set).reduce((sum, tx) => sum + tx.valueWei, 0n),
    origin: 'change',
    changeIndex: index.changeIndex,
    listedInBlock: block,
  })
  return target
}

/** Deterministic pseudo-random numbers for the property run. */
function prng(seed: number) {
  let state = seed
  return () => (state = (state * 48_271) % 2_147_483_647) / 2_147_483_647
}

describe('coin distribution: one band for the splitter and the merge', () => {
  it('derives every threshold from the change cap and the payment floor', () => {
    expect(D.maxChangeOutputs).toBe(4)
    expect(D.maxCoins).toBe(8)
    expect(D.mergeDownToCoins).toBe(5)
    expect(D.keepNewestCoins).toBe(4)
    expect(D.confirmationBlocks).toBe(3)
    expect(D.floorWei).toBe(10n * FEE)
  })

  it('a payment makes change only while the pool stays inside the band; with no room its residual stays on its source', async () => {
    const f = await open()
    const root = signer(77)
    await f.coins.put({ account: root.address, privateKey: root.privateKey, nonce: 0, valueWei: 10_000n * FLOOR, origin: 'root' })
    for (let i = 0; i < 7; i++) await putCoin(f, { valueWei: 2n * FLOOR, listedInBlock: 1 })
    expect(pool(f)).toBe(7)
    // Only the root covers it alone; its residual could be split four ways, but one coin of
    // room is left. The quote is the construction's own decision.
    const quote = await f.preparer.quoteLegacyTransactionSet({ destination: recipient(0), amountWei: 2_000n * FLOOR })
    const first = await f.preparer.constructLegacyTransactionSet({ operationId: 'band-1', amountWei: 2_000n * FLOOR, kdf: () => recipient(0), maxFeeWei: quote.feeWei })
    expect(sources(first)).toEqual(new Set([root.address.toLowerCase()]))
    expect(first.otherTransactions.length).toBe(1)
    expect(quote.changeFeeWei).toBe(FEE)
    expect(all(first).reduce((sum, tx) => sum + tx.gasLimit * PRICE, 0n)).toBe(quote.feeWei)
    await settle(f, 'band-1', 101)
    expect(pool(f)).toBe(8)
    // At the top: a payment from an account outside the pool (here the identity account, which
    // alone covers it) makes no change at all; its residual stays on its next nonce.
    const identity = signer(78)
    await f.coins.put({ account: identity.address, privateKey: identity.privateKey, nonce: 0, valueWei: 100_000n * FLOOR, origin: 'identity' })
    const second = await f.preparer.constructLegacyTransactionSet({ operationId: 'band-2', amountWei: 20_000n * FLOOR, kdf: () => recipient(0) })
    expect(sources(second)).toEqual(new Set([identity.address.toLowerCase()]))
    expect(second.otherTransactions).toHaveLength(0)
    await settle(f, 'band-2', 102)
    expect(pool(f)).toBe(8)
    expect(f.coins.latestOf(identity.address)!).toMatchObject({ nonce: 1, state: 'unspent', valueWei: 80_000n * FLOOR - FEE })
    await f.journal.Close()
  })
})

describe('coin distribution: a source spent out leaves no coin', () => {
  it('a payment that spends small coins out entirely still splits the root\'s residual: those coins are gone, not counted against the band', async () => {
    const f = await open()
    const root = signer(79)
    await f.coins.put({ account: root.address, privateKey: root.privateKey, nonce: 0, valueWei: 10_000n * FLOOR, origin: 'root' })
    for (let i = 0; i < 7; i++) await putCoin(f, { valueWei: 2n * FLOOR, listedInBlock: 1 })
    expect(pool(f)).toBe(7)
    const amountWei = 7n * (2n * FLOOR - FEE) + 2_000n * FLOOR
    const quote = await f.preparer.quoteTransactionSet({ amountWei, kdf: recipient })
    const set = await f.preparer.constructTransactionSet({ operationId: 'spent-out', amountWei, kdf: recipient, maxFeeWei: quote.feeWei })
    const change = set.otherTransactions.filter(tx => tx.sourceAccount.toLowerCase() === root.address.toLowerCase())
    // Every small coin went whole into the payment, so the pool outside the root is empty: the
    // root's residual is split as freely as without a band (more than the one coin that would
    // be left if each spent-out coin were still counted).
    expect(sources(set).size).toBe(8)
    expect(change.length).toBeGreaterThan(1)
    expect(all(set).reduce((sum, tx) => sum + tx.gasLimit * PRICE, 0n)).toBe(quote.feeWei)
    await settle(f, 'spent-out', 101)
    expect(pool(f)).toBeLessThanOrEqual(D.maxCoins)
    await f.journal.Close()
  })
})

describe('background merge', () => {
  it('does nothing inside the band, and never counts or moves coins below the payment floor', async () => {
    const f = await open()
    for (let i = 0; i < 8; i++) await putCoin(f, { valueWei: 3n * FLOOR, listedInBlock: 1 })
    expect(await f.consolidator.maintain()).toEqual({ outcome: 'idle' })
    // Twenty coins worth less than the floor: not spendable money in the wallet's sense.
    for (let i = 0; i < 20; i++) await putCoin(f, { valueWei: FLOOR - 1n, listedInBlock: 1 })
    expect(pool(f)).toBe(8)
    expect(await f.consolidator.maintain()).toEqual({ outcome: 'idle' })
    expect(f.submitted).toHaveLength(0)
    await f.journal.Close()
  })

  it('merges the smallest settled coins into one fresh account, back to five, keeping the newest four and every unconfirmed coin', async () => {
    const f = await open()
    f.head.value = 200
    const old: string[] = []
    for (let i = 0; i < 6; i++) old.push(await putCoin(f, { valueWei: BigInt(10 + i) * FLOOR, listedInBlock: 50 + i }))
    // The newest four, just created by a payment (two blocks ago: also unconfirmed).
    const fresh: string[] = []
    for (let i = 0; i < 4; i++) fresh.push(await putCoin(f, { valueWei: 2n * FLOOR, origin: 'change', changeIndex: 1_000 + i, listedInBlock: 198 }))
    // Listed two blocks ago but older than the newest four by change order: unconfirmed.
    const unconfirmed = await putCoin(f, { valueWei: 2n * FLOOR, listedInBlock: 198 })
    expect(pool(f)).toBe(11)
    const result = await f.consolidator.maintain()
    expect(result.outcome).toBe('merged')
    const [set] = f.submitted
    const moved = sources(set!)
    // Eleven coins need seven merged to be back at five; only the six old ones may be, so all
    // six go (the newest four and the unconfirmed one stay).
    expect(moved).toEqual(new Set(old))
    for (const account of [...fresh, unconfirmed]) expect(moved.has(account)).toBe(false)
    // One fresh account, every coin moved whole, each paying its own transfer fee.
    expect(new Set(all(set!).map(tx => tx.destination.toLowerCase())).size).toBe(1)
    const target = set!.bundle[0]!.destination.toLowerCase()
    expect(f.coins.latestOf(target)).toBeUndefined()
    expect(all(set!).every(tx => tx.valueWei === f.coins.get(tx.sourceAccount.toLowerCase(), 0)!.valueWei - FEE)).toBe(true)
    expect(result).toMatchObject({ coins: 6, feeWei: 6n * FEE, target })
    expect(classifyEvmOperation(`evm-transaction-set:${(result as { operationId: string }).operationId}`).purpose)
      .toBe('consolidation')
    await settle(f, (result as { operationId: string }).operationId, 201)
    // Settlement asks for a chain read of the fresh account, once per landed move.
    expect(new Set(f.included)).toEqual(new Set([target]))
    // The next maintenance step lists the fresh account as the wallet's own (composition records
    // it as a funded change account and reads it); until then nothing new is planned.
    expect(f.listed).toEqual([])
    expect((await f.consolidator.maintain()).outcome).toBe('idle')
    expect(f.listed).toEqual([target])
    await listMergeTarget(f, set!, 201)
    expect(pool(f)).toBe(6)
    // Listed: not asked again.
    await f.consolidator.maintain()
    expect(f.listed).toEqual([target])
    await f.journal.Close()
  })

  it('skips a coin whose move would cost more than it is worth, and coins another operation holds', async () => {
    const f = await open()
    f.head.value = 300
    for (let i = 0; i < 12; i++) await putCoin(f, { valueWei: BigInt(2 + i) * FLOOR, listedInBlock: 10 })
    // A payment holds the largest coins first.
    const payment = await f.preparer.constructTransactionSet({ operationId: 'held', amountWei: 25n * FLOOR, kdf: recipient })
    const held = sources(payment)
    expect(held.size).toBeGreaterThan(0)
    const plan = planEvmCoinMerge({ coins: f.coins.liveUnspent(), distribution: D, head: f.head.value, movable: () => true })
    expect(plan?.some(coin => held.has(coin.account))).toBe(false)
    const result = await f.consolidator.maintain()
    if (result.outcome === 'merged') {
      const moved = sources(f.submitted[0]!)
      for (const account of held) expect(moved.has(account)).toBe(false)
      // Each coin moved is at least the floor: its move costs at most a tenth of it.
      for (const tx of all(f.submitted[0]!)) expect(tx.valueWei + FEE).toBeGreaterThanOrEqual(FLOOR)
    }
    await f.journal.Close()
  })

  it('a send made while a merge is on its way takes other coins and is not held up by it', async () => {
    const f = await open()
    f.head.value = 400
    for (let i = 0; i < 14; i++) await putCoin(f, { valueWei: BigInt(3 + i) * FLOOR, listedInBlock: 10 })
    const merge = await f.consolidator.maintain()
    expect(merge.outcome).toBe('merged')
    const moved = sources(f.submitted[0]!)
    // Not settled, not even broadcast: the merge's coins are its own; a payment selects others.
    const started = Date.now()
    const payment = await f.preparer.constructTransactionSet({ operationId: 'during-merge', amountWei: 12n * FLOOR, kdf: recipient })
    expect(Date.now() - started).toBeLessThan(2_000)
    for (const account of sources(payment)) expect(moved.has(account)).toBe(false)
    // While it is on its way, maintenance only offers the same merge again.
    const again = await f.consolidator.maintain()
    expect(again).toEqual({ outcome: 'waiting', operationId: (merge as { operationId: string }).operationId })
    expect(all(f.submitted[1]!).map(tx => tx.txHash)).toEqual(all(f.submitted[0]!).map(tx => tx.txHash))
    await f.journal.Close()
  })

  it('a merge interrupted after it was journalled resumes after a restart as the same signed set', async () => {
    const coinStore: Store = new MemoryRecordStore()
    const dir = await mkdtemp(join(tmpdir(), 'frank-consolidate-'))
    const head = { value: 500 }
    const nextIndex = { value: 0 }
    try {
      let f = await open({ coinStore, journalPath: dir, head, nextIndex })
      for (let i = 0; i < 12; i++) await putCoin(f, { valueWei: BigInt(3 + i) * FLOOR, listedInBlock: 10 })
      // The handoff's outcome is not known (the process stops right after it).
      f.failSubmit(new NativeTransactionSubmissionError({ transaction: { txHash: '' }, reason: new Error('connection reset') }))
      const merge = await f.consolidator.maintain()
      expect(merge.outcome).toBe('merged')
      const first = f.submitted[0]!
      await f.journal.Close()
      f = await open({ coinStore, journalPath: dir, head, nextIndex })
      // Its coins are still the merge's after the reopen: nothing else may select them.
      for (const account of sources(first)) expect(f.coins.latestOf(account)!.state).not.toBe('unspent')
      const resumed = await f.consolidator.maintain()
      expect(resumed).toEqual({ outcome: 'waiting', operationId: (merge as { operationId: string }).operationId })
      expect(all(f.submitted[0]!).map(tx => tx.txHash)).toEqual(all(first).map(tx => tx.txHash))
      // Settled once, or twice (repeated observation and sync): the same coins.
      await settle(f, (merge as { operationId: string }).operationId, 501)
      const after = f.coins.all().map(coin => [coin.account, coin.nonce, coin.state, coin.valueWei]).sort()
      await settle(f, (merge as { operationId: string }).operationId, 501)
      expect(f.coins.all().map(coin => [coin.account, coin.nonce, coin.state, coin.valueWei]).sort()).toEqual(after)
      await listMergeTarget(f, first, 501)
      // Done: no second merge of the same coins, and inside the band nothing more to do.
      f.head.value = 520
      expect(await f.consolidator.maintain()).toEqual({ outcome: 'idle' })
      await f.journal.Close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('on a device that may not start merges, plans none but still finishes the one it signed: offers it again and lists its target', async () => {
    const f = await open()
    f.head.value = 600
    for (let i = 0; i < 12; i++) await putCoin(f, { valueWei: BigInt(3 + i) * FLOOR, listedInBlock: 10 })
    // Above the band, but this device is not the account's active one: nothing is planned.
    expect(await f.consolidator.maintain({ startNew: false })).toEqual({ outcome: 'idle' })
    expect(f.submitted).toEqual([])
    // A merge it signed while it was active ...
    const merge = (await f.consolidator.maintain()) as { outcome: string; operationId: string }
    expect(merge.outcome).toBe('merged')
    const [set] = f.submitted
    const target = set!.bundle[0]!.destination.toLowerCase()
    // ... is offered again, the same signed set, after it stopped being active.
    expect(await f.consolidator.maintain({ startNew: false })).toEqual({ outcome: 'waiting', operationId: merge.operationId })
    expect(all(f.submitted[1]!).map(tx => tx.txHash)).toEqual(all(set!).map(tx => tx.txHash))
    // Once it lands, its target is listed as the wallet's own, and still nothing new is planned.
    await settle(f, merge.operationId, 601)
    const before = f.submitted.length
    expect(await f.consolidator.maintain({ startNew: false })).toEqual({ outcome: 'idle' })
    expect(f.listed).toContain(target)
    expect(f.submitted.length).toBe(before)
    await f.journal.Close()
  })

  it('concurrent maintenance calls make one merge', async () => {
    const f = await open()
    f.head.value = 600
    for (let i = 0; i < 12; i++) await putCoin(f, { valueWei: BigInt(3 + i) * FLOOR, listedInBlock: 10 })
    const [a, b] = await Promise.all([f.consolidator.maintain(), f.consolidator.maintain()])
    expect(a).toEqual(b)
    expect(f.submitted).toHaveLength(1)
    await f.journal.Close()
  })

  it('keeps chains apart: each wallet merges only its own coins, under an identity bound to its chain', async () => {
    const monad = await open({ chain: 'monad-regtest', nativeChainId: '20143', keyBase: 10_000 })
    const sepolia = await open({ chain: 'ethereum-sepolia', nativeChainId: '11155111', keyBase: 20_000 })
    monad.head.value = sepolia.head.value = 700
    const own = new Map<Fixture, Set<string>>([[monad, new Set()], [sepolia, new Set()]])
    for (const f of [monad, sepolia])
      for (let i = 0; i < 10; i++) own.get(f)!.add(await putCoin(f, { valueWei: BigInt(3 + i) * FLOOR, listedInBlock: 10 }))
    const results = [await monad.consolidator.maintain(), await sepolia.consolidator.maintain()]
    for (const [i, f] of [monad, sepolia].entries()) {
      expect(results[i]!.outcome).toBe('merged')
      const set = f.submitted[0]!
      expect(set.chainIdentifier).toBe(i === 0 ? 'monad-regtest' : 'ethereum-sepolia')
      for (const account of sources(set)) expect(own.get(f)!.has(account)).toBe(true)
      expect(all(set).every(tx => Transaction.from(tx.rawTransaction).chainId === BigInt(i === 0 ? 20143 : 11155111))).toBe(true)
    }
    const coins = [{ account: '0x' + '11'.repeat(20), nonce: 0 }]
    expect(consolidationId('monad-regtest', '0x' + '22'.repeat(20), coins))
      .not.toBe(consolidationId('ethereum-sepolia', '0x' + '22'.repeat(20), coins))
    expect(consolidationId('monad-regtest', '0x' + '22'.repeat(20), coins).startsWith(EVM_CONSOLIDATION_PREFIX)).toBe(true)
    await monad.journal.Close()
    await sepolia.journal.Close()
  })
})

describe('every device of the account makes the same merge', () => {
  it('two devices with the same pool sign byte-identical merges to the same derived account, and the second settles as the first with no transaction of its own', async () => {
    // One account (the same keys) on two devices; each lists the same coins, in another order.
    const a = await open({ keyBase: 30_000 })
    const b = await open({ keyBase: 30_000 })
    a.head.value = b.head.value = 400
    const coinKeys = Array.from({ length: 12 }, (_, i) => signer(60_000 + i))
    const put = (f: Fixture, key: Wallet, i: number) =>
      f.coins.put({ account: key.address, privateKey: key.privateKey, nonce: 0, valueWei: BigInt(3 + i) * FLOOR, origin: 'stamp', listedInBlock: 10 + i })
    for (const [i, key] of coinKeys.entries()) await put(a, key, i)
    for (const [i, key] of [...coinKeys.entries()].reverse()) await put(b, key, i)
    const [first, second] = [await a.consolidator.maintain(), await b.consolidator.maintain()]
    expect(first.outcome).toBe('merged')
    expect(second).toEqual(first)
    const hashes = (f: Fixture) => all(f.submitted[0]!).map(tx => tx.txHash).sort()
    expect(hashes(b)).toEqual(hashes(a))
    expect(all(b.submitted[0]!).map(tx => tx.rawTransaction).sort()).toEqual(all(a.submitted[0]!).map(tx => tx.rawTransaction).sort())
    // Derived in the change branch's reserved half: never an index the allocator hands out, and
    // the allocator's next index is unchanged by it.
    const merged = first as { target: string; operationId: string }
    const target = a.targets.targetFor(evmMergeAnchor(all(a.submitted[0]!).map(tx => ({ account: tx.sourceAccount, nonce: tx.nonce }))))
    expect(target.account).toBe(merged.target)
    expect(target.changeIndex).toBeGreaterThanOrEqual(EVM_MERGE_TARGET_BASE)
    expect(a.nextIndex.value).toBe(0)
    // Device A's broadcast lands. Device B sees its own (identical) transactions included.
    for (const f of [a, b]) {
      await settle(f, merged.operationId, 405)
      await listMergeTarget(f, f.submitted[0]!, 405)
    }
    expect(b.coins.nextChangeIndex()).toBe(0)
    f_head(a, b, 500)
    expect(await a.consolidator.maintain()).toEqual({ outcome: 'idle' })
    expect(await b.consolidator.maintain()).toEqual({ outcome: 'idle' })
    expect(b.submitted).toHaveLength(1)
    expect(b.coins.latestOf(merged.target)).toEqual(a.coins.latestOf(merged.target))
    await a.journal.Close()
    await b.journal.Close()
  })

  it('a device that knows only the emptied accounts finds where the merge went', async () => {
    const a = await open({ keyBase: 40_000 })
    a.head.value = 300
    for (let i = 0; i < 12; i++) await putCoin(a, { valueWei: BigInt(3 + i) * FLOOR, listedInBlock: 10 })
    const merged = (await a.consolidator.maintain()) as { target: string; operationId: string }
    const moves = all(a.submitted[0]!)
    // Restored from the seed: it knows (from its walk) each emptied account and the nonce the
    // account is at now, nothing of the merge. The chain shows the target in use.
    const restored = await open({ keyBase: 40_000 })
    const emptied = moves.map(tx => ({ account: tx.sourceAccount, nonce: tx.nonce }))
    const read: string[] = []
    const found = await restored.targets.probeAnchors(emptied, async account => {
      read.push(account)
      return account === merged.target
    })
    expect(found).toEqual([merged.target])
    expect(restored.targets.watchedTargets().map(target => target.account)).toEqual([merged.target])
    // Every other emptied account names another (unused) account: read once each, not again.
    expect(read).toHaveLength(moves.length)
    expect(await restored.targets.probeAnchors(emptied, async () => true)).toEqual([])
    await a.journal.Close()
    await restored.journal.Close()
  })
})

const f_head = (a: Fixture, b: Fixture, value: number) => {
  a.head.value = b.head.value = value
}

describe('a payment carrying a stamp when the pool is at the top of the band', () => {
  async function atTop() {
    const f = await open()
    f.head.value = 50
    const root = signer(990_081)
    await f.coins.put({ account: root.address, privateKey: root.privateKey, nonce: 0, valueWei: 10_000n * FLOOR, origin: 'root' })
    // Eight pool coins (the band's top) this payment cannot use yet: stamps just received, which
    // the chain's spacing rule keeps until a later block.
    for (let i = 0; i < 8; i++) {
      const key = signer(990_100 + i)
      await f.coins.put({ account: key.address, privateKey: key.privateKey, nonce: 0, valueWei: 2n * FLOOR, origin: 'stamp', listedInBlock: 49, spendableFromBlock: 60 })
    }
    expect(pool(f)).toBe(8)
    return { f, root }
  }
  const stamp = 3n * FLOOR
  const request = {
    amountWei: 2_000n * FLOOR,
    kdf: recipient,
    reserveForContinuationWei: stamp + FEE,
    continuationFeeWei: FEE,
  }

  it('is built as quoted with its stamp: the stamp kept back in its own account, no change at all', async () => {
    const { f, root } = await atTop()
    // The review quotes the payment with its stamp (`quoteNative` with `stampWei`).
    const quote = await f.preparer.quoteTransactionSet(request)
    const set = await f.preparer.constructTransactionSet({ ...request, operationId: 'stamp-at-top', maxFeeWei: quote.feeWei })
    expect(sources(set)).toEqual(new Set([root.address.toLowerCase()]))
    // The quote is the construction, plus the stamp's own transfer (signed by its later stage).
    expect(all(set).reduce((sum, tx) => sum + tx.gasLimit * PRICE, 0n) + FEE).toBe(quote.feeWei)
    // One payment and one transfer keeping the stamp back (exactly its value and fee); no
    // change: what the root holds beyond them stays on it at its next nonce.
    expect(all(set)).toHaveLength(2)
    expect(all(set).filter(tx => tx.valueWei === stamp + FEE)).toHaveLength(1)
    expect(all(set).filter(tx => tx.valueWei === request.amountWei)).toHaveLength(1)
    await f.journal.Close()
  })

  it('authorized without the fee of keeping the stamp back, it is refused before anything is signed or held', async () => {
    const { f } = await atTop()
    const bare = await f.preparer.quoteTransactionSet({ amountWei: request.amountWei, kdf: recipient })
    await expect(f.preparer.constructTransactionSet({ ...request, operationId: 'stamp-unquoted', maxFeeWei: bare.feeWei + FEE }))
      .rejects.toThrow(EvmTransactionSetFeeExceededError)
    expect(await f.journal.list()).toHaveLength(0)
    expect(f.coins.all().filter(coin => coin.holder !== undefined)).toHaveLength(0)
    // Nothing held: the payment quoted with its stamp goes through straight after.
    const quote = await f.preparer.quoteTransactionSet(request)
    await f.preparer.constructTransactionSet({ ...request, operationId: 'stamp-quoted', maxFeeWei: quote.feeWei })
    await f.journal.Close()
  })
})

describe('the splitter and the merge never fight', () => {
  it.each([1, 2, 3, 4, 5])('random sends, received coins and idle ticks (seed %i)', async seed => {
    const random = prng(seed * 7_919)
    const f = await open()
    f.head.value = 1_000
    const root = signer(55)
    await f.coins.put({ account: root.address, privateKey: root.privateKey, nonce: 0, valueWei: 100_000n * FLOOR, origin: 'root' })
    let pending: string | undefined
    let sends = 0
    let merges = 0
    for (let step = 0; step < 120; step++) {
      f.head.value += 1 + Math.floor(random() * 4)
      const action = random()
      if (action < 0.4) {
        // A stamp or payout arrives.
        await putCoin(f, { valueWei: FLOOR + BigInt(Math.floor(random() * 40)) * FLOOR, listedInBlock: f.head.value })
      } else if (action < 0.7) {
        if (pending) {
          await settle(f, pending, f.head.value)
          pending = undefined
        }
        const before = pool(f)
        const id = `pay-${seed}-${sends++}`
        try {
          await f.preparer.constructTransactionSet({
            operationId: id,
            amountWei: FLOOR + BigInt(Math.floor(random() * 300)) * FLOOR,
            kdf: recipient,
          })
        } catch (error) {
          if (!(error instanceof EvmTransactionSetInsufficientFundsError)) throw error
          continue
        }
        // Sometimes the payment is still on its way at the next idle tick.
        if (random() < 0.5) pending = id
        else {
          await settle(f, id, f.head.value)
          // A send never takes the pool over the band's top.
          if (before <= D.maxCoins) expect(pool(f)).toBeLessThanOrEqual(D.maxCoins)
        }
      } else {
        const live = f.coins.liveUnspent()
        const poolCoins = live.filter(coin => countPoolCoins([coin], D) === 1)
        const newest = new Set(
          [...poolCoins]
            .sort((a, b) => (b.listedInBlock ?? -1) - (a.listedInBlock ?? -1) || (b.changeIndex ?? -1) - (a.changeIndex ?? -1) || a.account.localeCompare(b.account))
            .slice(0, D.keepNewestCoins)
            .map(coin => coin.account),
        )
        const free = new Set(live.map(coin => coin.account))
        const before = poolCoins.length
        const submitted = f.submitted.length
        const result = await f.consolidator.maintain()
        if (result.outcome !== 'merged') {
          // Inside the band nothing is ever merged.
          if (before <= D.maxCoins) expect(f.submitted.length).toBe(submitted)
          continue
        }
        merges++
        expect(before).toBeGreaterThan(D.maxCoins)
        const set = f.submitted.at(-1)!
        for (const account of sources(set)) {
          const coin = f.coins.latestOf(account)!
          // Never a coin an operation held, one of the newest, or one listed within the
          // confirmation depth; never one below the floor.
          expect(free.has(account)).toBe(true)
          expect(newest.has(account)).toBe(false)
          expect(f.head.value - (coin.listedInBlock ?? -Infinity)).toBeGreaterThanOrEqual(D.confirmationBlocks)
          expect(coin.valueWei).toBeGreaterThanOrEqual(FLOOR)
        }
        f.head.value += 1
        await settle(f, result.operationId, f.head.value)
        await listMergeTarget(f, set, f.head.value)
        // Back toward the band: n coins became one.
        expect(pool(f)).toBe(before - result.coins + 1)
      }
    }
    if (pending) await settle(f, pending, ++f.head.value)
    // Left idle long enough, every coin settles and the pool ends inside the band.
    for (let tick = 0; tick < 20; tick++) {
      f.head.value += 10
      const result = await f.consolidator.maintain()
      if (result.outcome !== 'merged') break
      merges++
      f.head.value += 1
      await settle(f, result.operationId, f.head.value)
      await listMergeTarget(f, f.submitted.at(-1)!, f.head.value)
    }
    expect(pool(f)).toBeLessThanOrEqual(D.maxCoins)
    expect(sends).toBeGreaterThan(10)
    expect(merges).toBeGreaterThan(0)
    await f.journal.Close()
  })
})
