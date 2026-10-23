/** Shared native-wallet composition. Installation derives no new roots and performs no RPC. */
import { EvmBlockWatcher } from './evm-block-watcher'
import { installEvmWalletCoinList } from './evm-wallet-coin-list'
import { EvmTransactionSetPolicyCache } from './evm-transaction-set-policy'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import { EvmTransactionSetLifecycle } from './evm-transaction-set-lifecycle'
import type { EvmListCoin } from './evm-coin-list'
import type {
  EvmTransactionSetJournal,
  EvmTransactionSetPolicy,
} from './evm-transaction-set-types'

export function installEvmTransactionSetRuntime(
  params: Omit<Parameters<typeof installEvmWalletCoinList>[0], 'watcher'> & {
    journal: EvmTransactionSetJournal
    kind: string
    knownNoCodeAddress: string
    reserveBalanceWei?: bigint
    paymentPollIntervalMs?: number
    policy?: () => EvmTransactionSetPolicy
    canSelectCoin?: (coin: EvmListCoin) => boolean
  },
) {
  const { coinList, provider, changeKeyring, changePool, pool } =
    params
  const blockWatcher = new EvmBlockWatcher({
    provider,
    intervalMs: params.paymentPollIntervalMs,
  })
  const coinListSync = installEvmWalletCoinList({
    ...params,
    watcher: blockWatcher,
  })
  const transactionSetPolicy = new EvmTransactionSetPolicyCache({
    provider,
    kind: params.kind,
    knownNoCodeAddress: params.knownNoCodeAddress,
    spendSpacingBlocks: params.spendSpacingBlocks,
    reserveBalanceWei: params.reserveBalanceWei,
    override: params.policy,
  })
  const transactionSetPreparer = new EvmTransactionSetPreparer({
    coins: coinList,
    journal: params.journal,
    recoverySpendRule:
      params.spendSpacingBlocks === undefined
        ? undefined
        : {
            belowWei: params.reserveBalanceWei ?? 0n,
            waitBlocks: params.spendSpacingBlocks,
          },
    policy: () => transactionSetPolicy.snapshot(),
    deriveChange: index => {
      const derived = changeKeyring.deriveChangeAccount(index)
      return {
        account: derived.address.toLowerCase(),
        privateKey: derived.privateKey,
        changeIndex: index,
      }
    },
    reserveChange: (_operationId, minimumIndex) =>
      changePool.reserveFreshChange(minimumIndex),
    canSelectCoin: coin =>
      !coinListSync.isDirty(coin.account) &&
      pool.accountClaimedBy(coin.account) === undefined &&
      (params.canSelectCoin?.(coin) ?? true),
  })
  const transactionSetLifecycle = new EvmTransactionSetLifecycle({
    authority: transactionSetPreparer,
    provider,
    head: () => transactionSetPolicy.snapshot().head,
  })
  let refreshing: Promise<void> | undefined
  let initialized = false
  let stopped = false
  let stopRefresh!: () => void
  const stoppedRefresh = new Promise<void>(resolve => {
    stopRefresh = resolve
  })
  const stop = (): Promise<void> => {
    stopped = true
    stopRefresh()
    blockWatcher.stop()
    return coinListSync.stop()
  }
  // A periodic tick joins the current complete pass. It must never enqueue another sync pass
  // behind one whose completion a balance caller already awaits.
  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    return (refreshing ??= Promise.race([
      Promise.allSettled([
        (async () => {
          if (!initialized) {
            await coinListSync.refresh({ all: true })
            initialized = true
          } else {
            // Valid inventory is trusted. Only new/dirty accounts and public deposit roots
            // need observations between explicit full recovery scans.
            await coinListSync.refresh()
            await coinListSync.refreshAccounts([
              params.mainAccount.address,
              params.identity.address.raw,
            ])
          }
        })(),
        transactionSetPolicy.refresh(),
      ]).then(() => undefined),
      stoppedRefresh,
    ]).finally(() => {
      refreshing = undefined
    }))
  }
  return {
    blockWatcher,
    coinListSync,
    transactionSetPolicy,
    transactionSetPreparer,
    transactionSetLifecycle,
    refresh,
    stop,
  }
}
