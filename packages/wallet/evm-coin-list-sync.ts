/**
 * Keeps an EVM wallet's coin list in step with the chain, off the send path.
 *
 * The list is what a payment selects from, without a request. What it holds is learned here:
 * for an account of the wallet that has no live coin in the list (never read, or marked dirty
 * because something outside the list may have spent from it), one look at the chain gives the
 * account's nonce and what it holds, and that is its coin. A send reads nothing; it asks for a
 * refresh only when the list does not cover it, and then only the accounts that need it.
 *
 * The chain's spacing rule (Monad's reserve balance) is the adapter's: money that arrived less
 * than `spendSpacingBlocks + 1` blocks ago, or an account that sent less than
 * `spendSpacingBlocks` blocks ago, is listed with the block from which it may be spent.
 */
import type { Provider } from 'ethers'
import {
  EvmCoinListError,
  type EvmCoinList,
  type EvmCoinListOrigin,
} from './evm-coin-list'
import type { EvmBlockWatcher } from './evm-block-watcher'

/** An account of the wallet the list may hold a coin of. */
export interface CoinListSource {
  /** Lower-case 0x address. */
  readonly account: string
  readonly origin: EvmCoinListOrigin
  readonly changeIndex?: number
  readonly privateKey: () => string
}

import {
  READS_AT_ONCE,
  RATE_LIMIT_INITIAL_BACKOFF_MS,
  RATE_LIMIT_MAX_BACKOFF_MS,
  isRateLimited,
} from './evm-rpc-read-budget'

export class EvmCoinListSync {
  /** Accounts to read again before the list trusts what it has of them. */
  private readonly dirty = new Set<string>()
  /** Retry an unsuccessful observation without withdrawing an otherwise trusted coin. */
  private readonly failedObservations = new Map<string, unknown>()
  /** Accounts read and found empty: not read again until something marks them dirty. */
  private readonly empty = new Set<string>()
  private stopped = false
  private readonly writes = new Set<Promise<unknown>>()
  private running: Promise<void> | undefined
  private again = false
  private rateLimit: { until: number; error: unknown } | undefined
  private rateLimitBackoffMs = RATE_LIMIT_INITIAL_BACKOFF_MS
  private againAll = false
  private againDue = false
  private readonly againAccounts = new Set<string>()
  /** Counts the times each account was marked dirty: a read that a later mark overtook does not
   * clear it (what that read saw may predate what the mark announced). */
  private readonly generations = new Map<string, number>()

  constructor(
    private readonly config: {
      readonly list: EvmCoinList
      readonly provider: Provider
      readonly watcher: EvmBlockWatcher
      readonly spendSpacingBlocks?: number
      /** Every account of the wallet that may hold a coin, as of now. */
      readonly sources: () => readonly CoinListSource[]
    },
  ) {}

  /** End observation logically. Drain only local mutations already started, never node reads. */
  async stop(): Promise<void> {
    this.stopped = true
    const results = await Promise.allSettled([...this.writes])
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }

  private async mutate(operation: () => Promise<unknown>): Promise<void> {
    if (this.stopped) return
    const write = operation()
    this.writes.add(write)
    try {
      await write
    } finally {
      this.writes.delete(write)
    }
  }

  /** Something outside the list may have spent from `account` (or paid into it): its coin is
   * dropped from selection until the chain has been read again. */
  markDirty(account: string): void {
    const key = account.toLowerCase()
    this.empty.delete(key)
    this.dirty.add(key)
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
  }

  /** Selection could not fund a request. Incomplete observations are not proof of insufficient
   * funds. Successful selection does not call this: other trusted coins remain usable. */
  assertFundingObserved(): void {
    const failed = this.failedObservations.values().next()
    if (!failed.done) throw failed.value
  }

  /** The key of a wallet account the list may hold coins of, or undefined. */
  keyOf(account: string): string | undefined {
    const key = account.toLowerCase()
    return this.config
      .sources()
      .find(source => source.account.toLowerCase() === key)
      ?.privateKey()
  }

  isDirty(account: string): boolean {
    return this.dirty.has(account.toLowerCase())
  }

  /** Derived observation only: a successful accepted read found zero balance. A dirty mark or
   * failed refresh cannot provide this evidence; CoinList still owns every spendable coin. */
  hasObservedEmpty(account: string): boolean {
    const key = account.toLowerCase()
    return !this.dirty.has(key) && this.empty.has(key)
  }

  /** Whether the accounts that need a look have none pending: the list is all the wallet knows. */
  settled(): boolean {
    return this.dueSources().length === 0
  }

  /** Observe only these already-owned accounts, sharing the existing refresh queue. */
  refreshAccounts(accounts: readonly string[]): Promise<void> {
    return this.refresh({ accounts })
  }

  /**
   * Reads every account that needs it, once; concurrent callers share the pass. With `all`,
   * every account whose coin is not held is read again, empty or not: for a payment the list
   * does not cover, money may have arrived that nothing announced (a deposit to the main
   * account, say).
   */
  refresh(
    options: { all?: boolean; accounts?: readonly string[] } = {},
  ): Promise<void> {
    if (this.stopped) return Promise.resolve()
    // A targeted request invalidates old empty evidence even when a shared cooldown refuses RPC.
    if (options.accounts !== undefined)
      for (const account of options.accounts) this.markDirty(account)
    if (this.rateLimit && Date.now() < this.rateLimit.until)
      return Promise.reject(this.rateLimit.error)
    if (options.all === true) this.againAll = true
    if (options.accounts === undefined) this.againDue = true
    else
      for (const account of options.accounts) {
        this.againAccounts.add(account.toLowerCase())
      }
    if (this.running) {
      this.again = true
      return this.running
    }
    const run = (async () => {
      do {
        this.again = false
        const all = this.againAll
        const due = this.againDue
        const accounts = new Set(this.againAccounts)
        this.againAll = false
        this.againDue = false
        this.againAccounts.clear()
        try {
          await this.pass(all, due ? undefined : accounts)
        } catch (error) {
          if (isRateLimited(error)) {
            this.rateLimit = {
              until: Date.now() + this.rateLimitBackoffMs,
              error,
            }
            this.rateLimitBackoffMs = Math.min(
              this.rateLimitBackoffMs * 2,
              RATE_LIMIT_MAX_BACKOFF_MS,
            )
          }
          throw error
        }
      } while (this.again && !this.stopped)
    })().finally(() => {
      this.running = undefined
    })
    this.running = run
    return run
  }

  private dueSources(all = false): CoinListSource[] {
    const { list } = this.config
    return this.config.sources().filter(source => {
      const account = source.account.toLowerCase()
      if (this.dirty.has(account) || this.failedObservations.has(account))
        return true
      const coin = list.latestOf(account)
      if (all)
        return (
          coin === undefined ||
          coin.state === 'unspent' ||
          coin.state === 'spent'
        )
      if (this.empty.has(account)) return false
      return coin === undefined
    })
  }

  private async pass(
    all: boolean,
    accounts?: ReadonlySet<string>,
  ): Promise<void> {
    const due =
      accounts === undefined
        ? this.dueSources(all)
        : this.config
            .sources()
            .filter(source => accounts.has(source.account.toLowerCase()))
    if (due.length === 0) return
    const head = await this.config.watcher.current()
    let cursor = 0
    let limited: { error: unknown } | undefined
    await Promise.all(
      Array.from({ length: Math.min(READS_AT_ONCE, due.length) }, async () => {
        while (!this.stopped && cursor < due.length && !limited) {
          const source = due[cursor++]!
          const account = source.account.toLowerCase()
          const generation = this.generations.get(account) ?? 0
          try {
            await this.readOne(source, head, error => {
              limited ??= { error }
            })
          } catch (error) {
            if (
              !this.stopped &&
              (this.generations.get(account) ?? 0) === generation
            )
              this.failedObservations.set(account, error)
            if (isRateLimited(error)) {
              limited ??= { error }
              continue
            }
            // Nothing is known of it: it stays due, and is read on the next pass.
            if (!(error instanceof EvmCoinListError))
              console.warn(
                `[evm-coin-list] could not read ${source.account}:`,
                error,
              )
          }
        }
      }),
    )
    if (limited) throw limited.error
    this.rateLimit = undefined
    this.rateLimitBackoffMs = RATE_LIMIT_INITIAL_BACKOFF_MS
  }

  private async readOne(
    source: CoinListSource,
    head: number,
    onRateLimit: (error: unknown) => void,
  ): Promise<void> {
    const { list, provider } = this.config
    const account = source.account.toLowerCase()
    const generation = this.generations.get(account) ?? 0
    const spacing = this.config.spendSpacingBlocks ?? 0
    const lag = spacing + 1
    const optionalHistoricalRead = (error: unknown): undefined => {
      if (isRateLimited(error)) {
        onRateLimit(error)
        throw error
      }
      return undefined
    }
    const observeRead = <T>(read: Promise<T>): Promise<T> =>
      read.catch(error => {
        // Observe each rejection immediately. Promise.all exposes only its first rejection;
        // another read may report a rate limit while that first failure is still draining.
        if (isRateLimited(error)) onRateLimit(error)
        throw error
      })
    const reads = [
      observeRead(provider.getTransactionCount(account, 'latest')),
      observeRead(provider.getTransactionCount(account, 'pending')),
      observeRead(provider.getBalance(account)),
      spacing > 0 && head >= lag
        ? provider.getBalance(account, head - lag).catch(optionalHistoricalRead)
        : Promise.resolve(undefined),
      spacing > 0 && head >= spacing
        ? provider
            .getTransactionCount(account, head - spacing)
            .catch(optionalHistoricalRead)
        : Promise.resolve(undefined),
    ] as const
    const [latest, pending, balance, settledBalance, before] =
      await Promise.all(reads).catch(async error => {
        if (isRateLimited(error)) onRateLimit(error)
        // Do not release a worker slot while its other RPCs are still in flight: early rejection
        // otherwise multiplies the advertised concurrency and leaves requests running after refresh.
        const settled = await Promise.allSettled(reads)
        const rateFailure = settled.find(
          result =>
            result.status === 'rejected' && isRateLimited(result.reason),
        )
        if (rateFailure?.status === 'rejected') {
          onRateLimit(rateFailure.reason)
          throw rateFailure.reason
        }
        throw error
      })
    // Marked dirty while these reads were out: they may predate what the mark announced.
    if (this.stopped || (this.generations.get(account) ?? 0) !== generation)
      return
    this.failedObservations.delete(account)
    // Something of this account is in the mempool: no coin until it is mined.
    if (pending > latest) {
      this.markDirty(account)
      return
    }
    const live = list.latestOf(account)
    // An operation holds the account's coin: settlement decides what became of it.
    if (
      live !== undefined &&
      live.state !== 'unspent' &&
      live.state !== 'spent'
    )
      return
    // The node lags what the list already knows.
    if (
      live !== undefined &&
      (live.nonce > latest || (live.state === 'spent' && live.nonce >= latest))
    )
      return
    if (balance <= 0n) {
      // A persona is a durable owned deposit address. Keep its zero-value coin so a
      // later top-up remains discoverable after refresh and restart.
      if (live?.state === 'unspent' && live.origin !== 'legacy-subaccount')
        await this.mutate(() => list.recordGone(live))
      if (
        !this.stopped &&
        (this.generations.get(account) ?? 0) === generation
      ) {
        this.empty.add(account)
        this.failedObservations.delete(account)
        this.dirty.delete(account)
      }
      return
    }
    let spendableFromBlock: number | undefined
    if (settledBalance !== undefined && settledBalance < balance)
      spendableFromBlock = head + lag
    if (before !== undefined && before !== latest)
      spendableFromBlock = Math.max(spendableFromBlock ?? 0, head + spacing)
    // A read never makes the same coin spendable sooner than the list already knew (settlement
    // set it from the block that included the account's last spend).
    if (
      live?.nonce === latest &&
      live.spendableFromBlock !== undefined &&
      live.spendableFromBlock > (spendableFromBlock ?? 0)
    )
      spendableFromBlock = live.spendableFromBlock
    if (
      live?.state === 'unspent' &&
      live.nonce === latest &&
      live.valueWei === balance &&
      live.spendableFromBlock === spendableFromBlock &&
      (latest === 0 || live.lastSpentInBlock !== undefined)
    ) {
      this.empty.delete(account)
      this.failedObservations.delete(account)
      this.dirty.delete(account)
      return
    }
    await this.mutate(() =>
      list.put({
        account,
        nonce: latest,
        privateKey: source.privateKey(),
        valueWei: balance,
        origin: source.origin,
        ...(source.changeIndex === undefined
          ? {}
          : { changeIndex: source.changeIndex }),
        ...(latest === 0
          ? {}
          : {
              lastSpentInBlock:
                live?.nonce === latest ? live.lastSpentInBlock ?? head : head,
            }),
        ...(spendableFromBlock === undefined ? {} : { spendableFromBlock }),
      }),
    )
    if (!this.stopped && (this.generations.get(account) ?? 0) === generation) {
      this.empty.delete(account)
      this.failedObservations.delete(account)
      this.dirty.delete(account)
    }
  }
}
