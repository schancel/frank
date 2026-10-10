/**
 * The one source of "what block is the chain at" for a wallet on one EVM chain, and of whether
 * that chain can be reached at all.
 *
 * Everything that waits on the chain waits here: a payment waiting for a block number (the
 * spacing after the account's last transaction), a payment waiting for the account another
 * payment holds, a send waiting for the chain to be reachable again. There is one read of the
 * block number per interval for all of them together, and none while nothing waits. Waiters are
 * woken in the order they began to wait.
 *
 * The interval grows while the chain does not advance and while the node does not answer, and
 * returns to its base on the next new block.
 */
import type { Provider } from 'ethers'

/** Whether the chain's node answers. `unreachable`: since when, and the kind of the last error. */
export type ChainHealth =
  | { readonly reachable: true }
  | {
      readonly reachable: false
      readonly sinceMs: number
      readonly errorKind: string
    }

/** A wait was ended by its caller (the user cancelled the send). Nothing was signed for it. */
export class ChainWaitCancelledError extends Error {
  constructor() {
    super('The wait was cancelled. Nothing was signed or sent.')
    this.name = 'ChainWaitCancelledError'
  }
}

/** A read of the chain failed: the node did not answer, or answered with an error. Nothing was
 * claimed or signed by the operation that made the read. */
export class ChainUnreachableError extends Error {
  constructor(readonly cause: unknown) {
    super(
      `The chain could not be read (${errorKindOf(cause)}). Nothing was signed.`,
    )
    this.name = 'ChainUnreachableError'
  }
}

/** A short word for what went wrong, for display: never the node's URL or a raw message. */
export function errorKindOf(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  if (typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code)) return code
  const text = String((error as { message?: unknown })?.message ?? error)
  if (/timeout|timed out/i.test(text)) return 'TIMEOUT'
  if (/fetch|network|ECONN|ENOTFOUND|socket/i.test(text)) return 'NETWORK_ERROR'
  if (/50[234]|429/.test(text)) return 'SERVER_ERROR'
  return 'ERROR'
}

interface Waiter {
  /** Called on every look with the head, or `undefined` when the look failed. True: done. */
  ready(head: number | undefined): boolean
  resolve(head: number): void
  reject(error: unknown): void
}

export interface EvmBlockWatcherConfig {
  provider: Pick<Provider, 'getBlockNumber'>
  /** Time between looks while the chain advances. About one block. Default 500 ms. */
  intervalMs?: number
  /** The longest time between looks while the node does not answer. Default 15 s. */
  maxBackoffMs?: number
  /** Called when the chain becomes unreachable, and when it is reachable again. */
  onHealth?: (health: ChainHealth) => void
}

export class EvmBlockWatcher {
  private readonly waiters: Waiter[] = []
  private head: number | undefined
  private state: ChainHealth = { reachable: true }
  private timer: ReturnType<typeof setTimeout> | undefined
  private looking = false
  private delayMs: number
  private stopped = false
  /** Looks made so far. For tests and logs. */
  looks = 0

  constructor(private readonly config: EvmBlockWatcherConfig) {
    this.delayMs = config.intervalMs ?? 500
  }

  /** The last block number seen, if any. No request. */
  latest(): number | undefined {
    return this.head
  }

  health(): ChainHealth {
    return this.state
  }

  /** Another read of this chain failed (a fee, a balance, a nonce): the chain is unreachable
   * until a read succeeds. */
  noteFailure(error: unknown): void {
    if (this.state.reachable) {
      this.state = {
        reachable: false,
        sinceMs: Date.now(),
        errorKind: errorKindOf(error),
      }
      this.config.onHealth?.(this.state)
    } else
      this.state = { ...this.state, errorKind: errorKindOf(error) }
  }

  /** A read of this chain succeeded. */
  noteSuccess(): void {
    if (this.state.reachable) return
    this.state = { reachable: true }
    this.config.onHealth?.(this.state)
  }

  /** Resolves, with the head, at the next look that reaches the node (whether or not the chain
   * advanced): the moment to look again at something that may have changed. */
  next(signal?: AbortSignal): Promise<number> {
    let first = true
    return this.wait(head => {
      if (first) return (first = false)
      return head !== undefined
    }, signal)
  }

  /** Resolves once the chain is at `block` or past it. At once when that is already known. */
  until(block: number, signal?: AbortSignal): Promise<number> {
    if (this.head !== undefined && this.head >= block && !signal?.aborted)
      return Promise.resolve(this.head)
    return this.wait(head => head !== undefined && head >= block, signal)
  }

  /** Resolves once a look has reached the node. At once while the chain is reachable. */
  whenReachable(signal?: AbortSignal): Promise<void> {
    if (this.state.reachable && !signal?.aborted) return Promise.resolve()
    return this.wait(head => head !== undefined, signal).then(() => undefined)
  }

  /** The head now: one look, shared with whoever else is waiting. */
  current(signal?: AbortSignal): Promise<number> {
    return this.wait(head => head !== undefined, signal, true)
  }

  /** Ends every wait (the wallet is closed). */
  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    for (const waiter of this.waiters.splice(0))
      waiter.reject(new ChainWaitCancelledError())
  }

  private wait(
    ready: Waiter['ready'],
    signal?: AbortSignal,
    now = false,
  ): Promise<number> {
    if (this.stopped || signal?.aborted)
      return Promise.reject(new ChainWaitCancelledError())
    return new Promise<number>((resolve, reject) => {
      const waiter: Waiter = {
        ready,
        resolve: head => {
          signal?.removeEventListener('abort', cancel)
          resolve(head)
        },
        reject: error => {
          signal?.removeEventListener('abort', cancel)
          reject(error)
        },
      }
      const cancel = () => {
        const at = this.waiters.indexOf(waiter)
        if (at >= 0) this.waiters.splice(at, 1)
        if (this.waiters.length === 0) {
          clearTimeout(this.timer)
          this.timer = undefined
        }
        reject(new ChainWaitCancelledError())
      }
      signal?.addEventListener('abort', cancel, { once: true })
      this.waiters.push(waiter)
      this.schedule(now ? 0 : undefined)
    })
  }

  private schedule(delayMs?: number): void {
    if (this.stopped || this.looking || this.waiters.length === 0) return
    if (this.timer !== undefined) {
      if (delayMs !== 0) return
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.look()
    }, delayMs ?? this.delayMs)
    // Not unref'd: the timer exists only while something waits, and a wait is work in flight.
    // (Unref'd, a short-lived process whose only pending work was a send waiting for a block
    // ended, with exit code 0, in the middle of that send.)
  }

  private async look(): Promise<void> {
    if (this.stopped || this.looking || this.waiters.length === 0) return
    this.looking = true
    const base = this.config.intervalMs ?? 500
    let head: number | undefined
    try {
      this.looks++
      head = await this.config.provider.getBlockNumber()
      this.noteSuccess()
      // A chain that stands still is looked at less often, up to four intervals apart.
      this.delayMs =
        this.head !== undefined && head <= this.head
          ? Math.min(this.delayMs * 1.5, base * 4)
          : base
      if (this.head === undefined || head > this.head) this.head = head
    } catch (error) {
      this.noteFailure(error)
      this.delayMs = Math.min(
        Math.max(this.delayMs * 2, base * 2),
        this.config.maxBackoffMs ?? 15_000,
      )
    } finally {
      this.looking = false
    }
    // In arrival order. A waiter may register another wait as it resumes; that one is for the
    // next look.
    for (const waiter of [...this.waiters])
      if (waiter.ready(head)) {
        const at = this.waiters.indexOf(waiter)
        if (at >= 0) this.waiters.splice(at, 1)
        waiter.resolve(head!)
      }
    this.schedule()
  }
}
