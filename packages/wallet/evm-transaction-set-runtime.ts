import { recordWalletFailure } from './wallet-failure'
/** Shared native-wallet composition. Installation derives no new roots and performs no RPC. */
import { EvmBlockWatcher } from './evm-block-watcher'
import { installEvmWalletCoinList } from './evm-wallet-coin-list'
import { EvmTransactionSetPolicyCache } from './evm-transaction-set-policy'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import { EvmTransactionSetLifecycle } from './evm-transaction-set-lifecycle'
import { FinalizedHeadUnavailableError, spendRuleHeadReader } from './chain/evm-spend-rule'
import type { EvmListCoin } from './evm-coin-list'
import type {
  EvmTransactionSetJournal,
  EvmTransactionSetPolicy,
} from './evm-transaction-set-types'

export function installEvmTransactionSetRuntime(
  params: Omit<Parameters<typeof installEvmWalletCoinList>[0], 'watcher'> & {
    onCancellationCheckpoint?: import('./evm-transaction-set-types').EvmTransactionSetPreparerOptions['onCancellationCheckpoint']
    journal: EvmTransactionSetJournal
    kind: string
    knownNoCodeAddress: string
    reserveBalanceWei?: bigint
    /** The head the spend rule counts from (`ChainRegistryEntry.spendRuleHead`). */
    spendRuleHead?: 'latest' | 'finalized'
    paymentPollIntervalMs?: number
    policy?: () => EvmTransactionSetPolicy
    canSelectCoin?: (coin: EvmListCoin) => boolean
  },
) {
  const { coinList, provider, changeKeyring, changePool, pool } =
    params
  // Every block the wallet's spend decisions count (when a coin may be spent, what the
  // coin-list sync reads, what a waiting send waits for) is a block of the head the node judges
  // a new transaction from: on Monad the finalized one, not the proposed one.
  const spendRuleHead = {
    getBlockNumber: spendRuleHeadReader(provider, params.spendRuleHead),
  }
  const blockWatcher = new EvmBlockWatcher({
    provider: spendRuleHead,
    // A node that stopped reporting final blocks: sends say so instead of waiting for it.
    endsWaits: error => error instanceof FinalizedHeadUnavailableError,
    intervalMs: params.paymentPollIntervalMs,
  })
  const coinListSync = installEvmWalletCoinList({
    ...params,
    watcher: blockWatcher,
  })
  const transactionSetPolicy = new EvmTransactionSetPolicyCache({
    provider: {
      getFeeData: () => provider.getFeeData(),
      getBlockNumber: spendRuleHead.getBlockNumber,
    },
    kind: params.kind,
    knownNoCodeAddress: params.knownNoCodeAddress,
    spendSpacingBlocks: params.spendSpacingBlocks,
    reserveBalanceWei: params.reserveBalanceWei,
    override: params.policy,
  })
  let policyFailure: { error: unknown } | undefined
  const transactionSetPreparer = new EvmTransactionSetPreparer({
    coins: coinList,
    journal: params.journal,
    onCancellationCheckpoint: params.onCancellationCheckpoint,
    recoverySpendRule:
      params.spendSpacingBlocks === undefined
        ? undefined
        : {
            belowWei: params.reserveBalanceWei ?? 0n,
            waitBlocks: params.spendSpacingBlocks,
          },
    policy: () => {
      try { return transactionSetPolicy.snapshot() } catch (error) {
        throw recordWalletFailure(policyFailure?.error ?? error, { observationUnavailable: true })
      }
    },
    assertFundingObserved: () => {
      try {
        coinListSync.assertFundingObserved()
        if (policyFailure) throw policyFailure.error
      } catch (error) {
        throw recordWalletFailure(error, { observationUnavailable: true })
      }
    },
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
    onPaymentIncluded: account => coinListSync.noteOwnTransferIncluded(account),
    canSelectCoin: coin =>
      !coinListSync.isDirty(coin.account) &&
      !pool.isAccountClaimed(coin.account) &&
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
      ]).then(([, policy]) => {
        policyFailure = policy.status === 'rejected' ? { error: policy.reason } : undefined
      }),
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
