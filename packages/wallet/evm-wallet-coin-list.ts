/** Wallet inventory composition, independent of canonical messaging and fund-ahead. */
import type { Provider, Wallet } from 'ethers'
import type { EvmCoinList } from './evm-coin-list'
import { EvmCoinListSync, type CoinListSource } from './evm-coin-list-sync'
import type { EvmBlockWatcher } from './evm-block-watcher'
import type { EvmSubAccountPool } from './evm-account-pool'
import type { EvmChangePool } from './evm-change-pool'
import type { MonadChangeKeyring } from './secp256k1-hd-keyring'
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
  const sync = new EvmCoinListSync({
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
      for (const coin of coinStore.all()) {
        // Legacy receipt rows are key ownership evidence even while their old state is
        // pending/spent/failed. The current nonce and balance come from chain observation;
        // the old state must not hide a still-funded account from migration.
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
      // New-format destinations are owned by the list/journal before legacy pool audit records
      // exist. Reopen must keep watching them, including successors at a later nonce.
      for (const coin of coinList.all())
        add({
          account: coin.account,
          origin: coin.origin,
          changeIndex: coin.changeIndex,
          privateKey: () => coin.privateKey,
        })
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
