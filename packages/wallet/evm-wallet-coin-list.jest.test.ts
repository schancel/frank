import { Wallet, Transaction } from 'ethers'
import { InMemorySubAccountPoolStore } from './storage/sub-account-pool-storage'
import { installEvmWalletCoinList } from './evm-wallet-coin-list'
import { NEW_SEED_NO_WALK_MS } from './evm-coin-list-sync'
import { EvmCoinList } from './evm-coin-list'
import { EvmBlockWatcher } from './evm-block-watcher'
import { EvmChangePool } from './evm-change-pool'
import { EvmSubAccountPool } from './evm-account-pool'
import { MonadHdKeyring, MonadChangeKeyring } from './secp256k1-hd-keyring'
import { MonadIdentity } from './evm-identity'
import { MemoryRecordStore, type EvmCoin } from './storage/evm-coin-store'

const mnemonic = 'test test test test test test test test test test test junk'
it('registers root, identity, deterministic, received and change sources without a mailbox coordinator and keeps change ordering after refresh', async () => {
  const mainAccount = new Wallet('0x' + '11'.repeat(32))
  const identity = MonadIdentity.fromSeed({ mnemonic })
  const changeKeyring = MonadChangeKeyring.fromMnemonic(mnemonic)
  const changePool = new EvmChangePool({ keyring: changeKeyring })
  const change = changeKeyring.deriveChangeAccount(7)
  changePool.applyRecoveredAccounts([
    { index: 7, address: change.address, nonce: 0, balanceWei: '1000000' },
  ])
  const poolStore = new InMemorySubAccountPoolStore()
  const pool = new EvmSubAccountPool({
    store: poolStore,
    keyring: MonadHdKeyring.fromMnemonic(mnemonic),
    mainAccountAddress: mainAccount.address,
  })
  const legacy = pool.ensureUnfundedSize(6)
  pool.setStatus(0, 'available')
  pool.restoreTerminalEvidence({ ...legacy[1]!, status: 'spent' })
  pool.restoreTerminalEvidence({ ...legacy[2]!, status: 'retired' })
  const fundingRaw = await mainAccount.signTransaction({
    to: legacy[4]!.address, value: 1_000_000n, nonce: 0,
    chainId: 10143, gasLimit: 21_000n, gasPrice: 1n,
  })
  poolStore.put({ ...legacy[4]!, status: 'funding', fundingAttempt: {
    rawTx: fundingRaw, txHash: Transaction.from(fundingRaw).hash!,
  } })
  pool.setStatus(5, 'in-use')
  pool.restoreClaim('legacy-funding-operation', [4])
  expect(legacy.map(record => pool.getRecord(record.index)?.status)).toEqual([
    'available', 'spent', 'retired', 'unfunded', 'funding', 'in-use',
  ])
  const received = [2, 3, 4, 5].map(
    index => new Wallet('0x' + index.toString(16).padStart(64, '0')),
  )
  const coinStore = new MemoryRecordStore<EvmCoin>()
  for (const [index, account] of received.entries())
    await coinStore.put(account.address.toLowerCase(), {
      address: account.address,
      privateKey: account.privateKey,
      state: (['unspent', 'pending', 'failed', 'spent'] as const)[index],
      origin: index === 0 ? 'stamp' : 'stealth',
    } as EvmCoin)
  const coinList = await EvmCoinList.open(new MemoryRecordStore())
  const provider = {
    getBalance: jest.fn(async () => 1000000n),
    getTransactionCount: jest.fn(async () => 7),
  }
  const watcher = { current: async () => 100 } as EvmBlockWatcher
  const sync = installEvmWalletCoinList({
    mainAccount,
    identity,
    pool,
    changePool,
    changeKeyring,
    coinStore,
    coinList,
    provider: provider as never,
    watcher,
  })
  expect(provider.getBalance).not.toHaveBeenCalled()
  await sync.refresh()
  expect(new Set(coinList.all().map(coin => coin.origin))).toEqual(
    new Set(['root', 'identity', 'deterministic', 'stealth', 'stamp', 'change']),
  )
  // Only received coins the chain verified are watched: a pending or failed claim's account
  // is never listed, whatever money sits there.
  expect(received.map(account => coinList.latestOf(account.address)?.valueWei)).toEqual([
    1000000n, undefined, undefined, 1000000n,
  ])
  expect(legacy.map(record => coinList.latestOf(record.address)?.valueWei)).toEqual([
    1000000n, 1000000n, 1000000n, 1000000n, 1000000n, 1000000n,
  ])
  expect(coinList.all().every(coin => coin.nonce === 7)).toBe(true)
  const count = coinList.all().length
  await sync.refresh({ all: true })
  expect(coinList.all()).toHaveLength(count)
  expect(legacy.map(record => coinList.latestOf(record.address)?.valueWei)).toEqual([
    1000000n, 1000000n, 1000000n, 1000000n, 1000000n, 1000000n,
  ])
  // A real list reservation survives repeated imports, even when a newer observation would
  // change that account's nonce/value. Only its operation may reconcile this held source.
  const heldAddress = legacy[5]!.address.toLowerCase()
  const reserved = coinList.reserveTransactionSetSources({
    holder: 'active-payment-operation',
    amountWei: 1000n,
    feeWei: 1n,
    head: 100,
    sourceOrder: ['deterministic'],
    canSelect: coin => coin.account === heldAddress,
  })
  expect(reserved).toHaveLength(1)
  const held = { ...coinList.get(heldAddress, 7)! }
  expect(held).toMatchObject({ holder: 'active-payment-operation', state: 'spend_pending' })
  provider.getBalance.mockResolvedValue(2_000_000n)
  provider.getTransactionCount.mockResolvedValue(9)
  await sync.refresh({ all: true })
  const refreshed = coinList.all()
  for (const record of legacy.slice(0, 5))
    expect(coinList.latestOf(record.address)).toMatchObject({ nonce: 9, valueWei: 2_000_000n })
  expect(coinList.get(heldAddress, 7)).toEqual(held)
  expect(coinList.get(heldAddress, 9)).toBeUndefined()
  expect(pool.claimedBy(4)).toBe('legacy-funding-operation')
  expect(coinList.reserveTransactionSetSources({
    holder: 'competing-operation', amountWei: 1000n, feeWei: 1n, head: 100,
    sourceOrder: ['deterministic'], canSelect: coin => coin.account === heldAddress,
  })).toBeUndefined()
  await sync.refresh({ all: true })
  expect(coinList.all()).toEqual(refreshed)
  expect(coinList.heldBy('active-payment-operation')).toEqual([held])
  expect(pool.claimedBy(4)).toBe('legacy-funding-operation')
  expect(pool.getRecord(4)).toMatchObject({
    status: 'funding', fundingAttempt: { rawTx: fundingRaw, txHash: Transaction.from(fundingRaw).hash },
  })
  expect(coinList.latestOf(change.address)?.changeIndex).toBe(7)
  expect(sync.keyOf(change.address)).toBe(change.privateKey)
})

describe('a seed this device generated', () => {
  const NOW = 1_800_000_000_000
  /** A wallet's inventory on an empty chain; `walkReads` counts the seed walk's nonce reads. */
  async function open(options: { generatedAtMs?: number; changePool?: EvmChangePool } = {}) {
    jest.spyOn(Date, 'now').mockImplementation(() => NOW)
    const keyring = MonadHdKeyring.fromMnemonic(mnemonic)
    const changeKeyring = MonadChangeKeyring.fromMnemonic(mnemonic)
    const changePool = options.changePool ?? new EvmChangePool({ keyring: changeKeyring })
    const mainAccount = new Wallet('0x' + '11'.repeat(32))
    const provider = {
      getBalance: jest.fn(async () => 0n),
      getTransactionCount: jest.fn(async () => 0),
    }
    const sync = installEvmWalletCoinList({
      mainAccount,
      identity: MonadIdentity.fromSeed({ mnemonic }),
      pool: new EvmSubAccountPool({
        store: new InMemorySubAccountPoolStore(),
        keyring,
        mainAccountAddress: mainAccount.address,
      }),
      changePool,
      changeKeyring,
      coinStore: new MemoryRecordStore<EvmCoin>(),
      coinList: await EvmCoinList.open(new MemoryRecordStore()),
      provider: provider as never,
      watcher: { current: async () => 100 } as EvmBlockWatcher,
      seedDiscovery: {
        keyring,
        ...(options.generatedAtMs === undefined ? {} : { generatedAtMs: options.generatedAtMs }),
      },
    })
    await sync.refresh({ all: true })
    return { sync, changePool, walkReads: () => provider.getTransactionCount.mock.calls.length }
  }
  afterEach(() => jest.restoreAllMocks())

  it('a brand-new store opened minutes after generation does not walk, and records the walk', async () => {
    const generatedAtMs = NOW - 2 * 60_000
    const f = await open({ generatedAtMs })
    expect(f.walkReads()).toBeLessThan(10)
    // Stored as a real walk at generation: a later open, mark or none, trusts it.
    expect(f.changePool.seedWalkedAtMs()).toBe(generatedAtMs)
    const reopened = await open({ changePool: f.changePool })
    expect(reopened.walkReads()).toBeLessThan(10)
  })

  it('walks in full when the mark is older than the window (a chain first opened later)', async () => {
    const f = await open({ generatedAtMs: NOW - NEW_SEED_NO_WALK_MS - 1 })
    // Both branches to the gap (50 each).
    expect(f.walkReads()).toBeGreaterThanOrEqual(100)
    expect(f.changePool.seedWalkedAtMs()).toBe(NOW)
  })

  it('walks in full when an existing store has state but no walk record, however recent the mark', async () => {
    const changeKeyring = MonadChangeKeyring.fromMnemonic(mnemonic)
    const changePool = new EvmChangePool({ keyring: changeKeyring })
    changePool.applyRecoveredAccounts([{
      index: 0, address: changeKeyring.deriveChangeAccount(0).address, nonce: 1, balanceWei: '0',
    }])
    const f = await open({ generatedAtMs: NOW - 60_000, changePool })
    expect(f.walkReads()).toBeGreaterThanOrEqual(100)
  })
})
