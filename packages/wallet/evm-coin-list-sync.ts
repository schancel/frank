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
  private againEmpties = false

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
   * Reads every account that needs it, once; concurrent callers share the pass. With
   * `empties`, the accounts last read empty are read again too: for a payment the list does not
   * cover, money may have arrived that nothing announced.
   */
  refresh(options: { empties?: boolean } = {}): Promise<void> {
    if (options.empties === true) this.againEmpties = true
    if (this.running) {
      this.again = true
      return this.running
    }
    const run = (async () => {
      do {
        this.again = false
        const empties = this.againEmpties
        this.againEmpties = false
        await this.pass(empties)
      } while (this.again)
    })().finally(() => {
      this.running = undefined
    })
    this.running = run
    return run
  }

  private dueSources(empties = false): CoinListSource[] {
    const { list } = this.config
    return this.config.sources().filter(source => {
      const account = source.account.toLowerCase()
      if (this.dirty.has(account)) return true
      if (this.empty.has(account)) return empties
      return list.latestOf(account) === undefined
    })
  }

  private async pass(empties: boolean): Promise<void> {
    const due = this.dueSources(empties)
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
