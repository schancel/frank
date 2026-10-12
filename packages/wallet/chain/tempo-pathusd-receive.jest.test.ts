import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LevelRecordStore, MemoryRecordStore } from '../storage/evm-coin-store'
import type { RecordStore } from '../storage/evm-coin-store'
import {
  TempoPathUsdReceiveScanner,
  type TempoReceiveBatch,
  type TempoReceiveItem,
  type TempoReceiveRpc,
} from './tempo-pathusd-receive'

const RECIPIENT = '0x2222222222222222222222222222222222222222'
const SOURCE = '0x1111111111111111111111111111111111111111'
const BLOCK = '0x' + '44'.repeat(32)
const OTHER = '0x' + '55'.repeat(32)
const TX = '0x' + '33'.repeat(32)

function harness(store = new MemoryRecordStore<TempoReceiveBatch>()) {
  let finalized = 12n
  let blockHash = BLOCK
  let transfers = [{
    transactionHash: TX, logIndex: 0, blockHash: BLOCK, blockNumber: 10,
    sender: SOURCE, recipient: RECIPIENT, amountAtomic: 1_000_000n,
  }]
  const ranges: [bigint, bigint][] = []
  const rpc: TempoReceiveRpc = {
    finalizedHead: async () => ({ number: finalized, hash: blockHash }),
    blockHash: async () => blockHash,
    receivedTransfers: async (_recipient, from, to) => {
      ranges.push([from, to])
      return transfers.filter(item => BigInt(item.blockNumber) >= from && BigInt(item.blockNumber) <= to)
    },
  }
  let tail: Promise<unknown> = Promise.resolve()
  const scanner = new TempoPathUsdReceiveScanner('tempo-testnet', store, rpc, (_recipient, task) => {
    const run = tail.then(task)
    tail = run.catch(() => undefined)
    return run
  })
  return {
    scanner, store, ranges,
    setHead: (value: bigint) => { finalized = value },
    setBlockHash: (value: string) => { blockHash = value },
    setTransfers: (value: typeof transfers) => { transfers = value },
  }
}

describe('Tempo finalized PathUSD receive cursor', () => {
  test('bounded catch-up persists contiguous pages and resumes after reopen', async () => {
    const h = harness()
    h.setHead(25_000n)
    h.setTransfers([])
    expect(await h.scanner.syncCatchUp(RECIPIENT, 0n, async () => undefined, 2)).toEqual({
      nextBlock: 20_000n, finalizedBlock: 25_000n, delivered: 0, complete: false,
    })
    expect(h.ranges).toEqual([[0n, 9_999n], [10_000n, 19_999n]])
    const reopened = harness(h.store)
    reopened.setHead(25_000n)
    reopened.setTransfers([])
    expect(await reopened.scanner.syncCatchUp(RECIPIENT, 0n, async () => undefined, 2)).toEqual({
      nextBlock: 25_001n, finalizedBlock: 25_000n, delivered: 0, complete: true,
    })
    expect(reopened.ranges).toEqual([[20_000n, 25_000n]])
  })

  test('transient range failure halves same cursor and never skips the failed range', async () => {
    const store = new MemoryRecordStore<TempoReceiveBatch>()
    const calls: [bigint, bigint][] = []
    const applied: string[] = []
    const rpc: TempoReceiveRpc = {
      finalizedHead: async () => ({ number: 10_000n, hash: BLOCK }),
      blockHash: async () => BLOCK,
      receivedTransfers: async (_recipient, from, to) => {
        calls.push([from, to])
        if (to - from >= 5_000n) throw new Error('HTTP 502')
        return from <= 9_000n && to >= 9_000n ? [{
          transactionHash: TX, logIndex: 0, blockHash: BLOCK, blockNumber: 9_000,
          sender: SOURCE, recipient: RECIPIENT, amountAtomic: 1_000_000n,
        }] : []
      },
    }
    const scanner = new TempoPathUsdReceiveScanner('tempo-testnet', store, rpc, async (_recipient, task) => task())
    expect(await scanner.syncCatchUp(RECIPIENT, 0n, async item => { applied.push(item.id) }, 3)).toEqual({
      nextBlock: 10_001n, finalizedBlock: 10_000n, delivered: 1, complete: true,
    })
    expect(applied).toEqual([`tempo-testnet:${TX}:0`])
    expect(calls).toEqual([[0n, 9_999n], [0n, 4_999n], [5_000n, 10_000n], [5_000n, 7_500n], [7_501n, 10_000n]])
    expect(store.all().map(row => [row.fromBlock, row.toBlock])).toEqual([
      ['0', '4999'], ['5000', '7500'], ['7501', '10000'],
    ])
    const reopened = new TempoPathUsdReceiveScanner('tempo-testnet', store, rpc, async (_recipient, task) => task())
    expect(await reopened.syncCatchUp(RECIPIENT, 0n, async () => { throw new Error('duplicate') })).toEqual({
      nextBlock: 10_001n, finalizedBlock: 10_000n, delivered: 0, complete: true,
    })
  })

  test('persistent rate limit leaves durable cursor unchanged and can retry later', async () => {
    const store = new MemoryRecordStore<TempoReceiveBatch>()
    let blocked = true
    const rpc: TempoReceiveRpc = {
      finalizedHead: async () => ({ number: 10_000n, hash: BLOCK }),
      blockHash: async () => BLOCK,
      receivedTransfers: async () => {
        if (blocked) throw new Error('HTTP 429 rate limit')
        return []
      },
    }
    const scanner = new TempoPathUsdReceiveScanner('tempo-testnet', store, rpc, async (_recipient, task) => task())
    await expect(scanner.syncCatchUp(RECIPIENT, 0n, async () => undefined, 1)).rejects.toThrow('429')
    expect(store.all()).toEqual([])
    blocked = false
    expect((await scanner.syncCatchUp(RECIPIENT, 0n, async () => undefined, 2)).nextBlock).toBe(10_001n)
  })

  test('two cached tabs refresh under the recipient lock before extending one cursor', async () => {
    const backing = new MemoryRecordStore<TempoReceiveBatch>()
    const cached = () => {
      const rows = new Map<string, TempoReceiveBatch>()
      return {
        get: (key: string) => rows.get(key), all: () => [...rows.values()],
        refresh: async () => {
          rows.clear()
          for (const row of backing.all()) rows.set(row.id, structuredClone(row))
        },
        put: async (key: string, row: TempoReceiveBatch) => {
          await backing.put(key, row)
          rows.set(key, structuredClone(row))
        },
        delete: async (key: string) => { await backing.delete(key); rows.delete(key) },
        close: async () => undefined,
      }
    }
    let tail: Promise<unknown> = Promise.resolve()
    const lock = <T>(_recipient: string, task: () => Promise<T>) => {
      const run = tail.then(task)
      tail = run.catch(() => undefined)
      return run
    }
    const calls: [bigint, bigint][] = []
    const rpc: TempoReceiveRpc = {
      finalizedHead: async () => ({ number: 12n, hash: BLOCK }),
      blockHash: async () => BLOCK,
      receivedTransfers: async (_recipient, from, to) => { calls.push([from, to]); return [] },
    }
    const first = new TempoPathUsdReceiveScanner('tempo-testnet', cached(), rpc, lock)
    const second = new TempoPathUsdReceiveScanner('tempo-testnet', cached(), rpc, lock)
    expect(await Promise.all([
      first.syncOnce(RECIPIENT, 10n, async () => undefined),
      second.syncOnce(RECIPIENT, 10n, async () => undefined),
    ])).toEqual([{ nextBlock: 13n, delivered: 0 }, { nextBlock: 13n, delivered: 0 }])
    expect(calls).toEqual([[10n, 12n]])
    expect(backing.all()).toHaveLength(1)
  })

  test('persists the scan and applies each transfer once by deterministic ID', async () => {
    const h = harness()
    const applied: TempoReceiveItem[] = []
    expect(await h.scanner.syncOnce(RECIPIENT, 10n, async item => { applied.push(item) })).toEqual({ nextBlock: 13n, delivered: 1 })
    expect(applied).toEqual([expect.objectContaining({
      id: `tempo-testnet:${TX}:0`, amountAtomic: '1000000', applied: false,
    })])
    const reopened = harness(h.store)
    expect(await reopened.scanner.syncOnce(RECIPIENT, 10n, async item => { applied.push(item) })).toEqual({ nextBlock: 13n, delivered: 0 })
    expect(applied).toHaveLength(1)
    expect(reopened.ranges).toEqual([])
    expect(reopened.scanner.receivedItems(RECIPIENT, 10n)).toEqual([expect.objectContaining({
      id: `tempo-testnet:${TX}:0`, amountAtomic: '1000000', applied: true,
    })])
    await expect(Promise.resolve().then(() => reopened.scanner.receivedItems(RECIPIENT, 9n))).rejects.toThrow('changed start block')
  })

  test('failed inventory application leaves cursor fact durable and redelivers after restart', async () => {
    const h = harness()
    await expect(h.scanner.syncOnce(RECIPIENT, 10n, async () => { throw new Error('inventory write failed') })).rejects.toThrow('inventory write failed')
    expect(h.store.all()[0]!.items[0]!.applied).toBe(false)
    const reopened = harness(h.store)
    const applied: string[] = []
    expect(await reopened.scanner.syncOnce(RECIPIENT, 10n, async item => { applied.push(item.id) })).toEqual({ nextBlock: 13n, delivered: 1 })
    expect(applied).toEqual([`tempo-testnet:${TX}:0`])
    expect(reopened.ranges).toEqual([])
  })

  test('ack write failure replays same ID; idempotent inventory applier prevents duplicate credit', async () => {
    const backing = new MemoryRecordStore<TempoReceiveBatch>()
    let writes = 0
    const store: RecordStore<TempoReceiveBatch> = {
      get: key => backing.get(key), all: () => backing.all(),
      put: async (key, row) => {
        writes++
        if (writes === 2) throw new Error('ack durability failed')
        await backing.put(key, row)
      },
      delete: key => backing.delete(key), close: () => backing.close(),
    }
    const credited = new Set<string>()
    let credits = 0
    const apply = async (item: TempoReceiveItem) => {
      if (!credited.has(item.id)) { credited.add(item.id); credits++ }
    }
    const first = harness(store)
    await expect(first.scanner.syncOnce(RECIPIENT, 10n, apply)).rejects.toThrow('ack durability failed')
    expect(credits).toBe(1)
    expect(backing.all()[0]!.items[0]!.applied).toBe(false)
    const reopened = harness(store)
    expect(await reopened.scanner.syncOnce(RECIPIENT, 10n, apply)).toEqual({ nextBlock: 13n, delivered: 1 })
    expect(credits).toBe(1)
  })

  test('durable LevelDB reopen retains cursor and applied transfer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'frank-tempo-receive-'))
    try {
      const firstStore = await LevelRecordStore.open<TempoReceiveBatch>(directory, 'pathusd-receive')
      const first = harness(firstStore)
      await first.scanner.syncOnce(RECIPIENT, 10n, async () => undefined)
      await firstStore.close()
      const secondStore = await LevelRecordStore.open<TempoReceiveBatch>(directory, 'pathusd-receive')
      const second = harness(secondStore)
      expect(await second.scanner.syncOnce(RECIPIENT, 10n, async () => { throw new Error('duplicate credit') })).toEqual({ nextBlock: 13n, delivered: 0 })
      await secondStore.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('reorged finalized checkpoint fails closed before crediting or advancing', async () => {
    const h = harness()
    await h.scanner.syncOnce(RECIPIENT, 10n, async () => undefined)
    const reopened = harness(h.store)
    reopened.setBlockHash(OTHER)
    await expect(reopened.scanner.syncOnce(RECIPIENT, 10n, async () => { throw new Error('should not apply') })).rejects.toThrow('reorganized')
    expect(reopened.ranges).toEqual([])
  })

  test('does not scan beyond finalized head and rejects changed start block', async () => {
    const h = harness()
    h.setHead(9n)
    expect(await h.scanner.syncOnce(RECIPIENT, 10n, async () => undefined)).toEqual({ nextBlock: 10n, delivered: 0 })
    h.setHead(12n)
    await h.scanner.syncOnce(RECIPIENT, 10n, async () => undefined)
    await expect(h.scanner.syncOnce(RECIPIENT, 9n, async () => undefined)).rejects.toThrow('changed start block')
  })
})
