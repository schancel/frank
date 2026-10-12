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
