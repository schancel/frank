/**
 * The block watcher: one look per interval for every waiter together, none while nothing waits,
 * arrival order, back-off, health. A stub node that only counts its own answers.
 */
import {
  ChainWaitCancelledError,
  EvmBlockWatcher,
  type ChainHealth,
} from './evm-block-watcher'

function node(state: { head: number; down?: boolean }) {
  let reads = 0
  return {
    reads: () => reads,
    provider: {
      getBlockNumber: async () => {
        reads++
        if (state.down) throw Object.assign(new Error('x'), { code: 'TIMEOUT' })
        return state.head
      },
    },
  }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('EvmBlockWatcher', () => {
  it('makes no request while nothing waits', async () => {
    const chain = node({ head: 10 })
    const watcher = new EvmBlockWatcher({ provider: chain.provider, intervalMs: 20 })
    await sleep(120)
    expect(chain.reads()).toBe(0)
    watcher.stop()
  })

  it('five waiters that began at different moments share one look per interval, and are woken in the order they came', async () => {
    const state = { head: 10 }
    const chain = node(state)
    const watcher = new EvmBlockWatcher({ provider: chain.provider, intervalMs: 50 })
    const woken: number[] = []
    const waits: Promise<unknown>[] = []
    for (let n = 0; n < 5; n++) {
      waits.push(watcher.until(12).then(() => woken.push(n)))
      await sleep(13)
    }
    await sleep(300)
    // About 365 ms at a look every 50 ms (slower while the chain stands still): a handful of
    // reads in all, not five times that.
    expect(chain.reads()).toBeGreaterThanOrEqual(2)
    expect(chain.reads()).toBeLessThanOrEqual(8)
    expect(woken).toEqual([])
    state.head = 12
    await Promise.all(waits)
    expect(woken).toEqual([0, 1, 2, 3, 4])
    const after = chain.reads()
    await sleep(200)
    // Nobody waits any more: the looks stop.
    expect(chain.reads()).toBe(after)
    watcher.stop()
  })

  it('answers at once, with no request, for a block already seen', async () => {
    const chain = node({ head: 30 })
    const watcher = new EvmBlockWatcher({ provider: chain.provider, intervalMs: 20 })
    expect(await watcher.current()).toBe(30)
    const reads = chain.reads()
    expect(await watcher.until(29)).toBe(30)
    expect(chain.reads()).toBe(reads)
    watcher.stop()
  })

  it('reports the chain unreachable when a look fails, looks less and less often, and reports it reachable on the first answer', async () => {
    const state = { head: 5, down: true }
    const chain = node(state)
    const seen: ChainHealth[] = []
    const watcher = new EvmBlockWatcher({
      provider: chain.provider,
      intervalMs: 20,
      maxBackoffMs: 160,
      onHealth: health => seen.push(health),
    })
    let back = false
    const waiting = watcher.whenReachable().then(() => (back = true))
    // Reachable until shown otherwise: that wait resolved at once.
    await waiting
    const queued = watcher.current().then(() => (back = true))
    back = false
    await sleep(700)
    expect(back).toBe(false)
    expect(watcher.health()).toMatchObject({ reachable: false, errorKind: 'TIMEOUT' })
    // 20, 40, 80, 160, 160... ms apart: far fewer than the 35 a fixed interval would make.
    expect(chain.reads()).toBeLessThanOrEqual(9)
    state.down = false
    await queued
    expect(watcher.health()).toEqual({ reachable: true })
    expect(seen.map(health => health.reachable)).toEqual([false, true])
    watcher.stop()
  })

  it('a cancelled wait rejects and stops the looks when it was the only one', async () => {
    const chain = node({ head: 1 })
    const watcher = new EvmBlockWatcher({ provider: chain.provider, intervalMs: 20 })
    const abort = new AbortController()
    const waiting = watcher.until(99, abort.signal)
    await sleep(70)
    abort.abort()
    await expect(waiting).rejects.toBeInstanceOf(ChainWaitCancelledError)
    const reads = chain.reads()
    await sleep(120)
    expect(chain.reads()).toBe(reads)
    watcher.stop()
  })
})

describe('a wait keeps its process alive', () => {
  // Seen on a local Monad chain: a process that opened a wallet, sent one paid message and had
  // nothing else to do ended with exit code 0 while the send was waiting for a block.
  it('the timer of a pending wait is not unref\'d', async () => {
    const { EvmBlockWatcher } = await import('./evm-block-watcher')
    const watcher = new EvmBlockWatcher({
      provider: { getBlockNumber: async () => 1 },
      intervalMs: 60_000,
    })
    const waiting = watcher.until(2)
    waiting.catch(() => undefined)
    const timer = (watcher as unknown as { timer?: { hasRef(): boolean } }).timer
    expect(timer?.hasRef()).toBe(true)
    watcher.stop()
    await expect(waiting).rejects.toThrow()
  })
})
