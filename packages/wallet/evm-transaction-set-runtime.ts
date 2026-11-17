import { recordWalletFailure } from './wallet-failure'
/** Shared native-wallet composition. Installation derives no new roots and performs no RPC. */
import { EvmBlockWatcher } from './evm-block-watcher'
import { installEvmWalletCoinList } from './evm-wallet-coin-list'
import { EvmTransactionSetPolicyCache } from './evm-transaction-set-policy'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import { EvmTransactionSetLifecycle } from './evm-transaction-set-lifecycle'
import { isConsolidation, mergeAnchorOf } from './evm-coin-consolidator'
import { FinalizedHeadUnavailableError, spendRuleHeadReader } from './chain/evm-spend-rule'
import type { EvmListCoin } from './evm-coin-list'
import type {
  EvmTransactionSetJournal,
  EvmTransactionSetPolicy,
} from './evm-transaction-set-types'

/** How old a fee quote a spendable-balance read may reuse. The balance loop asks every poll; a
 * new quote per ask was one of the RPC batches an idle wallet sent. Construction always reads a
 * new quote (`refresh()`). */
export const SPENDABLE_POLICY_MAX_AGE_MS = 30_000

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
  let coinFailure: { error: unknown } | undefined
  let stopped = false
  const assertFundingObserved = () => {
    try {
      if (stopped) throw new Error('The wallet observation runtime is stopped')
      // A pass can fail before per-account observation records the failure.
      if (coinFailure) throw coinFailure.error
      coinListSync.assertFundingObserved()
      if (policyFailure) throw policyFailure.error
    } catch (error) {
      throw recordWalletFailure(error, { observationUnavailable: true })
    }
  }
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
    assertFundingObserved,
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
    // Ownership is derived from the merge's sources; receipts alone cannot establish what
    // remains at its target when another frontend may already have spent it.
    mergeTarget: row => {
      if (!params.mergeTargets || !isConsolidation(row)) return undefined
      const target = params.mergeTargets.targetFor(mergeAnchorOf(row))
      return {
        account: target.account,
        privateKey: changeKeyring.deriveChangeAccount(target.changeIndex).privateKey,
        changeIndex: target.changeIndex,
      }
    },
    observeMergeTarget: async target => {
      params.mergeTargets!.watch(target)
      coinListSync.markDirty(target.account)
      await coinListSync.refreshAccounts([target.account])
      // Sync also retains dirtiness for failed, overtaken, stopped or pending observations.
      // Keep this member's projection unfinished so restart/reconciliation retries discovery.
      if (coinListSync.isDirty(target.account))
        throw new Error('Merge target chain observation incomplete')
    },
    observeOwnedRecoveryTarget: async (target, minimumBlock) => {
      if (stopped) throw new Error('Archived target observation runtime is stopped')
      // Original derivation authority comes from the signed archive. If the old allocator's
      // target is no longer watched, register actual chain state through its existing owner.
      const at = await spendRuleHead.getBlockNumber()
      if (at < minimumBlock) throw new Error('Archived own receipt is beyond the configured canonical head')
      const [nonce, balance] = await Promise.all([
        provider.getTransactionCount(target.account, at), provider.getBalance(target.account, at),
      ])
      if (stopped) throw new Error('Archived target observation runtime is stopped')
      const registered = [...changePool.records(), ...changePool.recoveredAccounts()]
        .some(record => record.index === target.changeIndex && record.address.toLowerCase() === target.account)
      if (!registered) {
        changePool.applyRecoveredAccounts([{index: target.changeIndex, address: target.account, nonce, balanceWei: balance.toString()}])
        await changePool.flush()
      }
      coinListSync.markDirty(target.account)
      await coinListSync.refreshAccounts([target.account])
      if (stopped || coinListSync.isDirty(target.account)) throw new Error('Archived own target chain observation incomplete')
    },
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
  const refresh = (options: { policyMaxAgeMs?: number } = {}): Promise<void> => {
    if (stopped) return Promise.resolve()
    // A recorded policy failure is always read again: it must not linger behind a recent quote.
    const policy =
      options.policyMaxAgeMs !== undefined && policyFailure === undefined
        ? transactionSetPolicy.refreshIfOlderThan(options.policyMaxAgeMs)
        : transactionSetPolicy.refresh()
    // The policy part is per caller (the cache itself joins a quote being read): a display read
    // may reuse a recent quote (`SPENDABLE_POLICY_MAX_AGE_MS`); construction always reads anew.
    const policyPass = policy.then(
      () => { policyFailure = undefined },
      error => { policyFailure = { error } },
    )
    // The coin pass is shared: a periodic tick joins the one already running.
    const coinPass = (refreshing ??= Promise.race([
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
      ]).then(([coins]) => {
        coinFailure = coins.status === 'rejected' ? { error: coins.reason } : undefined
      }),
      stoppedRefresh,
    ]).finally(() => {
      refreshing = undefined
    }))
    return Promise.race([
      Promise.all([coinPass, policyPass]).then(() => undefined),
      stoppedRefresh,
    ])
  }
  // A program offering a payable amount needs a complete current observation, unlike an
  // ordinary send that can use other trusted inputs while one observation is unavailable.
  const refreshSpendable = async (): Promise<void> => {
    await refresh({ policyMaxAgeMs: SPENDABLE_POLICY_MAX_AGE_MS })
    assertFundingObserved()
  }
  return {
    refreshSpendable,
    /** The spend-rule head reader the watcher, the fee quote and the coin-list sync share. The
     * wallet's balance read uses it too, so reads close together share one look. */
    readSpendRuleHead: spendRuleHead.getBlockNumber,
    blockWatcher,
    coinListSync,
    transactionSetPolicy,
    transactionSetPreparer,
    transactionSetLifecycle,
    refresh,
    stop,
  }
}
