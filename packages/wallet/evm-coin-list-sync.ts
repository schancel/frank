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
  readonly privateKey: () => string
}

/** How many accounts one refresh reads at the same time. */
const READS_AT_ONCE = 6
const RATE_LIMIT_INITIAL_BACKOFF_MS = 5_000
const RATE_LIMIT_MAX_BACKOFF_MS = 60_000

/** ethers wraps JSON-RPC errors inside UNKNOWN_ERROR and HTTP failures inside SERVER_ERROR. */
function isRateLimited(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== 'object' || error === null) return false
  const value = error as {
    code?: unknown
    status?: unknown
    statusCode?: unknown
    error?: unknown
    response?: unknown
  }
  return (
    value.code === 429 ||
    value.code === -32005 ||
    value.code === -32007 ||
    value.code === -32016 ||
    value.status === 429 ||
    value.statusCode === 429 ||
    (value.error !== error && isRateLimited(value.error, depth + 1)) ||
    (value.response !== error && isRateLimited(value.response, depth + 1))
  )
}

export class EvmCoinListSync {
  /** Accounts to read again before the list trusts what it has of them. */
  private readonly dirty = new Set<string>()
  /** Accounts read and found empty: not read again until something marks them dirty. */
  private readonly empty = new Set<string>()
  private running: Promise<void> | undefined
  private again = false
  private againAll = false
  private rateLimit: { until: number; error: unknown } | undefined
  private rateLimitBackoffMs = RATE_LIMIT_INITIAL_BACKOFF_MS
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

  /** Something outside the list may have spent from `account` (or paid into it): its coin is
   * dropped from selection until the chain has been read again. */
  markDirty(account: string): void {
    const key = account.toLowerCase()
    this.empty.delete(key)
    this.dirty.add(key)
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
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

  /** Whether the accounts that need a look have none pending: the list is all the wallet knows. */
  settled(): boolean {
    return this.dueSources().length === 0
  }

  /**
   * Reads every account that needs it, once; concurrent callers share the pass. With `all`,
   * every account whose coin is not held is read again, empty or not: for a payment the list
   * does not cover, money may have arrived that nothing announced (a deposit to the main
   * account, say).
   */
  refresh(options: { all?: boolean } = {}): Promise<void> {
    if (this.rateLimit && Date.now() < this.rateLimit.until)
      return Promise.reject(this.rateLimit.error)
    if (options.all === true) this.againAll = true
    if (this.running) {
      this.again = true
      return this.running
    }
    const run = (async () => {
      do {
        this.again = false
        const all = this.againAll
        this.againAll = false
        try {
          await this.pass(all)
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
      } while (this.again)
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
      if (this.dirty.has(account)) return true
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

  private async pass(all: boolean): Promise<void> {
    const due = this.dueSources(all)
    if (due.length === 0) return
    const head = await this.config.watcher.current()
    let cursor = 0
    let limited: { error: unknown } | undefined
    await Promise.all(
      Array.from({ length: Math.min(READS_AT_ONCE, due.length) }, async () => {
        while (cursor < due.length && !limited) {
          const source = due[cursor++]!
          try {
            await this.readOne(source, head, error => {
              limited ??= { error }
            })
          } catch (error) {
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
    if ((this.generations.get(account) ?? 0) !== generation) return
    // Something of this account is in the mempool: no coin until it is mined.
    if (pending > latest) return
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
    this.dirty.delete(account)
    if (balance <= 0n) {
      if (live?.state === 'unspent') await list.recordGone(live)
      this.empty.add(account)
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
      live.spendableFromBlock === spendableFromBlock
    )
      return
    await list.put({
      account,
      nonce: latest,
      privateKey: source.privateKey(),
      valueWei: balance,
      origin: source.origin,
      ...(spendableFromBlock === undefined ? {} : { spendableFromBlock }),
    })
  }
}
