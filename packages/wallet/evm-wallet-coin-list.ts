/** Wallet inventory composition, independent of canonical messaging and fund-ahead. */
import type { Provider, Wallet } from 'ethers'
import type { EvmCoinList } from './evm-coin-list'
import { EvmCoinListSync, type CoinListSource } from './evm-coin-list-sync'
import type { EvmBlockWatcher } from './evm-block-watcher'
import type { EvmSubAccountPool } from './evm-account-pool'
import type { EvmChangePool } from './evm-change-pool'
import type {
  MonadChangeKeyring,
  MonadHdKeyring,
} from './secp256k1-hd-keyring'
import { discoverSeedBranch } from './evm-seed-discovery'
import type { MonadIdentity } from './evm-identity'
import type { EvmCoin, RecordStore } from './storage/evm-coin-store'

export function installEvmWalletCoinList(params: {
  coinList: EvmCoinList
  provider: Provider
  watcher: EvmBlockWatcher
  spendSpacingBlocks?: number
  mainAccount: Wallet
  identity: MonadIdentity
  pool: EvmSubAccountPool
  changePool: EvmChangePool
  changeKeyring: MonadChangeKeyring
  coinStore: RecordStore<EvmCoin>
  /** The deterministic branch keyring (`m/44'/60'/0'/0/i`). Given, every full refresh walks both
   * seed branches for accounts in use on chain, so a restored device finds them all. */
  seedDiscovery?: { keyring: MonadHdKeyring; gap?: number }
}): EvmCoinListSync {
  const {
    coinList,
    mainAccount,
    identity,
    pool,
    changePool,
    changeKeyring,
    coinStore,
  } = params
  // Deterministic-branch accounts found on chain this session. Once observed they become coins
  // of the list, which is what keeps them watched after a restart.
  const discoveredDeterministic = new Map<number, string>()
  const discover = params.seedDiscovery && (async (
    stopped: () => boolean,
    scope: 'all' | 'change',
  ) => {
    const { keyring, gap } = params.seedDiscovery!
    // Change branch: the change pool owns its derivation high-water mark, so what the walk
    // finds is persisted there (recovered accounts) before any later allocation could reuse it.
    const knownChange = new Set<number>([
      ...changePool.records().map(record => record.index),
      ...changePool.recoveredAccounts().map(record => record.index),
      ...coinList
        .all()
        .flatMap(coin =>
          coin.changeIndex === undefined ? [] : [coin.changeIndex],
        ),
    ])
    const change = await discoverSeedBranch({
      provider: params.provider,
      addressOf: index => changeKeyring.deriveChangeAccount(index).address,
      isKnown: index => knownChange.has(index),
      highWater: Math.max(
        changePool.nextUnusedIndex(),
        coinList.nextChangeIndex(),
      ),
      gap,
      stopped,
    })
    if (change.length > 0) {
      changePool.applyRecoveredAccounts(
        change.map(found => ({
          index: found.index,
          address: changeKeyring.deriveChangeAccount(found.index).address,
          nonce: found.nonce,
          balanceWei: found.balanceWei.toString(),
        })),
      )
      await changePool.flush()
    }
    // Deterministic branch: nothing allocates here any more, but accounts an older wallet used
    // still belong to the seed. Only full walks look here; the periodic one is for change.
    if (scope !== 'all') return []
    const knownDeterministic = new Set<number>(
      pool.records().map(record => record.index),
    )
    const deterministic = await discoverSeedBranch({
      provider: params.provider,
      addressOf: index => keyring.deriveSubAccount(index).address,
      isKnown: index =>
        knownDeterministic.has(index) ||
        coinList.latestOf(keyring.deriveSubAccount(index).address) !==
          undefined,
      highWater: pool.nextUnusedIndex(),
      gap,
      stopped,
    })
    const funded = deterministic.filter(found => found.balanceWei > 0n)
    for (const found of funded)
      discoveredDeterministic.set(found.index, found.account)
    // Not yet coins of the list: read before the walk is recorded as done.
    return funded.map(found => found.account)
  })
  const sync = new EvmCoinListSync({
    discover,
    // The change pool keeps the time of the last completed walk with what it found, so a
    // reopened store is not walked again before its first balance read.
    ...(params.seedDiscovery
      ? {
          lastDiscoveredAtMs: () => changePool.seedWalkedAtMs(),
          recordDiscovered: async (atMs: number) => {
            changePool.recordSeedWalk(atMs)
            await changePool.flush()
          },
        }
      : {}),
    list: coinList,
    provider: params.provider,
    watcher: params.watcher,
    spendSpacingBlocks: params.spendSpacingBlocks,
    sources: () => {
      const sources = new Map<string, CoinListSource>()
      const add = (source: CoinListSource) => {
        const account = source.account.toLowerCase()
        if (!sources.has(account)) sources.set(account, { ...source, account })
      }
      add({
        account: mainAccount.address,
        origin: 'root',
        privateKey: () => mainAccount.privateKey,
      })
      add({
        account: identity.address.raw,
        origin: 'identity',
        privateKey: () => identity.toPrivateKeyHex(),
      })
      for (const record of pool.records()) {
        // Every recorded derivation remains a wallet-owned deposit target. A legacy
        // `spent`/`retired` status describes prior use, not a zero balance; refreshing
        // all indices recovers residual funds even when the new list has no row yet.
        add({
          account: record.address,
          origin: 'deterministic',
          privateKey: () => pool.privateKeyOf(record.index),
        })
      }
      // A received coin is an input only once the wallet has verified on chain that its
      // transfer landed (`unspent`, or `spent` after that). A pending or failed one is a
      // sender's claim: its account is not watched, so whatever money sits there is never
      // listed, spent or swept, and the balance (which counts only verified coins) is what Send
      // can spend. Once verified, its account is read like any other.
      const unverified = new Set<string>()
      for (const coin of coinStore.all()) {
        if (coin.state !== 'unspent' && coin.state !== 'spent') {
          unverified.add(coin.address.toLowerCase())
          continue
        }
        add({
          account: coin.address,
          origin: coin.origin,
          privateKey: () => coin.privateKey,
        })
      }
      for (const record of [
        ...changePool.records(),
        ...changePool.recoveredAccounts(),
      ])
        add({
          account: record.address,
          origin: 'change',
          changeIndex: record.index,
          privateKey: () =>
            changeKeyring.deriveChangeAccount(record.index).privateKey,
        })
      if (params.seedDiscovery)
        for (const [index, account] of discoveredDeterministic)
          add({
            account,
            origin: 'deterministic',
            privateKey: () =>
              params.seedDiscovery!.keyring.deriveSubAccount(index).privateKey,
          })
      // New-format destinations are owned by the list/journal before legacy pool audit records
      // exist. Reopen must keep watching them, including successors at a later nonce.
      for (const coin of coinList.all()) {
        if (unverified.has(coin.account)) continue
        add({
          account: coin.account,
          origin: coin.origin,
          changeIndex: coin.changeIndex,
          privateKey: () => coin.privateKey,
        })
      }
      return [...sources.values()]
    },
  })
  pool.onChange(change => {
    if (change.kind === 'record') sync.markDirty(change.record.address)
    else if (
      !coinList
        .all()
        .some(
          coin =>
            coin.account === change.address && coin.holder === change.holder,
        )
    )
      sync.markDirty(change.address)
  })
  return sync
}
