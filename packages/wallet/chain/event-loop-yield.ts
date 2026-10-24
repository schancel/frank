/**
 * Cooperative main-thread yielding for CPU-intensive batch message decoding, key derivation,
 * and store persistence loops.
 *
 * Resolving cached promises with `async`/`await` only schedules microtasks, which V8 drains to
 * completion before the browser can dispatch keyboard/pointer events or paint a frame. Yielding
 * via a macrotask (`setTimeout(resolve, 0)`) between small batches returns control to the host
 * event loop so typing and scrolling stay responsive during large mailbox syncs.
 */

export const DEFAULT_DECODE_BATCH_SIZE = 4
export const DEFAULT_YIELD_BUDGET_MS = 8
export const ACTIVE_INPUT_WINDOW_MS = 250
export const ACTIVE_INPUT_BACKOFF_MS = 60

export type EventLoopYieldFn = () => Promise<void>

let customYieldHook: EventLoopYieldFn | null = null
let lastUserInputMs = -Infinity
let inputListenersInstalled = false

function ensureInputListeners(): void {
  if (inputListenersInstalled) return
  if (
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function'
  ) {
    return
  }
  inputListenersInstalled = true
  const markInput = () => {
    lastUserInputMs = nowMs()
  }
  window.addEventListener('keydown', markInput, {
    passive: true,
    capture: true,
  })
  window.addEventListener('input', markInput, {
    passive: true,
    capture: true,
  })
}

ensureInputListeners()

export function isUserActivelyTyping(): boolean {
  ensureInputListeners()
  return nowMs() - lastUserInputMs < ACTIVE_INPUT_WINDOW_MS
}

/**
 * Installs or clears a custom yield callback for deterministic unit testing.
 */
export function setEventLoopYieldForTesting(fn: EventLoopYieldFn | null): void {
  customYieldHook = fn
}

function isFakeTimerActive(): boolean {
  if (typeof setTimeout !== 'function') return false
  const timer = setTimeout as unknown as {
    _isMockFunction?: boolean
    clock?: unknown
  }
  return Boolean(timer._isMockFunction || ('clock' in timer && timer.clock))
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

/**
 * Yields control back to the host macrotask queue so pending UI input and rendering tasks can
 * run before resuming a CPU-heavy batch loop. When the user is actively typing (within 250ms of
 * a `keydown`/`input` event), backs off for 60ms so keypress events are processed immediately
 * without competing with background cryptography. Falls back to a microtask when Jest fake timers
 * are active so unit tests using fake timers do not stall waiting for timer advancement.
 */
export function yieldToEventLoop(): Promise<void> {
  return yieldToHost(true)
}

function yieldToHost(deferWhileTyping: boolean): Promise<void> {
  if (customYieldHook) {
    return customYieldHook()
  }
  if (isFakeTimerActive()) {
    return Promise.resolve()
  }
  const delayMs = deferWhileTyping && isUserActivelyTyping() ? ACTIVE_INPUT_BACKOFF_MS : 0
  return new Promise<void>(resolve => {
    setTimeout(resolve, delayMs)
  })
}

export const yieldToMainThread = yieldToEventLoop

export interface CooperativeBatchYielder {
  /**
   * Call after processing an item in a batch loop. Yields to the event loop when either
   * `batchSize` items have been processed, `budgetMs` wall-clock milliseconds have elapsed,
   * or the user is actively typing (background work only).
   */
  maybeYield(force?: boolean): Promise<boolean>
  readonly yieldCount: number
}

export function createCooperativeBatchYielder(
  batchSize: number = DEFAULT_DECODE_BATCH_SIZE,
  budgetMs: number = DEFAULT_YIELD_BUDGET_MS,
  // Foreground work still yields real host turns, without background typing backoff.
  options: { foreground?: boolean } = {},
): CooperativeBatchYielder {
  const effectiveBatchSize = Math.max(1, Math.floor(batchSize))
  const effectiveBudgetMs = Math.max(0, budgetMs)
  let itemsSinceYield = 0
  let lastYieldTime = nowMs()
  let count = 0

  return {
    async maybeYield(force = false): Promise<boolean> {
      itemsSinceYield += 1
      const elapsed = nowMs() - lastYieldTime
      const activeInput = !options.foreground && !customYieldHook && !isFakeTimerActive() && isUserActivelyTyping()
      if (
        !force &&
        !activeInput &&
        itemsSinceYield < effectiveBatchSize &&
        elapsed < effectiveBudgetMs
      ) {
        return false
      }
      itemsSinceYield = 0
      count += 1
      await yieldToHost(!options.foreground)
      lastYieldTime = nowMs()
      return true
    },
    get yieldCount(): number {
      return count
    },
  }
}
