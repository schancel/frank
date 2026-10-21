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

export class EvmCoinListSync {
  /** Accounts to read again before the list trusts what it has of them. */
  private readonly dirty = new Set<string>()
  /** Accounts read and found empty: not read again until something marks them dirty. */
  private readonly empty = new Set<string>()
  private running: Promise<void> | undefined
  private again = false
  private againAll = false
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
        await this.pass(all)
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
      if (all) return coin === undefined || coin.state === 'unspent' || coin.state === 'spent'
      if (this.empty.has(account)) return false
      return coin === undefined
    })
  }

  private async pass(all: boolean): Promise<void> {
    const due = this.dueSources(all)
    if (due.length === 0) return
    const head = await this.config.watcher.current()
    let cursor = 0
    await Promise.all(
      Array.from({ length: Math.min(READS_AT_ONCE, due.length) }, async () => {
        while (cursor < due.length) {
          const source = due[cursor++]!
          try {
            await this.readOne(source, head)
          } catch (error) {
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
  }

  private async readOne(source: CoinListSource, head: number): Promise<void> {
    const { list, provider } = this.config
    const account = source.account.toLowerCase()
    const generation = this.generations.get(account) ?? 0
    const spacing = this.config.spendSpacingBlocks ?? 0
    const lag = spacing + 1
    const [latest, pending, balance, settledBalance, before] = await Promise.all([
      provider.getTransactionCount(account, 'latest'),
      provider.getTransactionCount(account, 'pending'),
      provider.getBalance(account),
      spacing > 0 && head >= lag
        ? provider.getBalance(account, head - lag).catch(() => undefined)
        : Promise.resolve(undefined),
      spacing > 0 && head >= spacing
        ? provider
            .getTransactionCount(account, head - spacing)
            .catch(() => undefined)
        : Promise.resolve(undefined),
    ])
    // Marked dirty while these reads were out: they may predate what the mark announced.
    if ((this.generations.get(account) ?? 0) !== generation) return
    // Something of this account is in the mempool: no coin until it is mined.
    if (pending > latest) return
    const live = list.latestOf(account)
    // An operation holds the account's coin: settlement decides what became of it.
    if (live !== undefined && live.state !== 'unspent' && live.state !== 'spent')
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
