import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LevelSubAccountPoolStore } from './level-sub-account-pool-store'
import * as durability from './level-durability'
import type { SubAccountRecord, TerminalSubAccountCheckpoint } from './sub-account-pool-storage'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
const address = '0x' + '12'.repeat(20)
const transfer = { rawTx: '00', txHash: '00', valueWei: '7' }
const terminal: SubAccountRecord = { index: 0, address, status: 'retired', lifecycle: {
  funding: transfer, spend: transfer, recovery: { kind: 'none', valueWei: '0' },
} }

describe('persistent account mutation order', () => {
  let location: string
  let store: LevelSubAccountPoolStore
  beforeEach(async () => {
    location = await mkdtemp(join(tmpdir(), 'pool-order-'))
    store = new LevelSubAccountPoolStore(location)
    await store.Open()
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await store.Close().catch(() => undefined)
    await rm(location, { recursive: true, force: true })
  })

  it.each(['record', 'checkpoint', 'clear'] as const)('a delayed earlier write cannot overwrite later %s state or allocation', async mode => {
    const entered = barrier(), release = barrier(), original = durability.durableBatch
    const batch = jest.spyOn(durability, 'durableBatch').mockImplementationOnce(async (...args) => {
      entered.release()
      await release.promise
      return original(...args)
    })
    store.put({ index: 0, address, status: 'in-use' })
    const initialFlush = store.flush()
    await entered.promise
    let cleared: Promise<void> | undefined
    const checkpoint: TerminalSubAccountCheckpoint = { version: 1, index: 0, address,
      status: 'retired', denominationWei: '7', lifecycle: terminal.lifecycle as TerminalSubAccountCheckpoint['lifecycle'], compactedAt: 10 }
    if (mode === 'record') store.put(terminal)
    if (mode === 'checkpoint') store.replaceWithCheckpoint(checkpoint)
    if (mode === 'clear') {
      cleared = store.clear()
      store.put({ index: 1, address, status: 'available' })
    }
    store.setNextIndex(32)
    // Let a backend that starts later writes immediately commit those first.
    await new Promise(resolve => setTimeout(resolve, 20))
    release.release()
    await initialFlush
    await cleared
    await store.flush()
    batch.mockRestore()
    await store.Close()
    store = new LevelSubAccountPoolStore(location)
    await store.Open()
    expect(store.getNextIndex()).toBe(32)
    if (mode === 'record') expect(store.getByIndex(0)).toEqual(terminal)
    if (mode === 'checkpoint') {
      expect(store.getByIndex(0)).toBeUndefined()
      expect(store.getCheckpoints()).toEqual([checkpoint])
    }
    if (mode === 'clear') {
      expect(store.getByIndex(0)).toBeUndefined()
      expect(store.getByIndex(1)?.status).toBe('available')
    }
  })

  it('a flush after an empty flush still acknowledges every newly queued write', async () => {
    const original = durability.durableBatch
    let acknowledged = false
    jest.spyOn(durability, 'durableBatch').mockImplementation(async (...args) => {
      const result = await original(...args)
      acknowledged = true
      return result
    })
    const empty = store.flush()
    store.put(terminal)
    await store.flush()
    expect(acknowledged).toBe(true)
    await empty
    await store.Close()
    store = new LevelSubAccountPoolStore(location)
    await store.Open()
    expect(store.getByIndex(0)).toEqual(terminal)
  })

  it('snapshots checkpoint keys and values before the caller can mutate its object', async () => {
    store.put(terminal)
    store.put({ index: 1, address, status: 'available' })
    await store.flush()
    const checkpoint: TerminalSubAccountCheckpoint = { version: 1, index: 0, address,
      status: 'retired', denominationWei: '7', lifecycle: terminal.lifecycle as TerminalSubAccountCheckpoint['lifecycle'], compactedAt: 10 }
    const expected = JSON.parse(JSON.stringify(checkpoint))
    store.replaceWithCheckpoint(checkpoint)
    checkpoint.index = 2
    checkpoint.address = 'changed'
    expect(store.scanRecords(-1, 10).map(row => row.index)).toEqual([1])
    await store.flush()
    await store.Close()
    store = new LevelSubAccountPoolStore(location)
    await store.Open()
    expect(store.getCheckpoints()).toEqual([expected])
    expect(store.getByIndex(0)).toBeUndefined()
  })

  it('keeps an uncertain write observable and stops dependent writes until actual reopen', async () => {
    const error = new Error('commit outcome unknown')
    const original = durability.durableBatch
    jest.spyOn(durability, 'durableBatch').mockImplementation(async (...args) => {
      await original(...args)
      throw error
    })
    store.put(terminal)
    store.setNextIndex(32)
    await expect(store.flush()).rejects.toBe(error)
    await expect(store.flush()).rejects.toBe(error)
    store.put({ index: 1, address, status: 'available' })
    await expect(store.Close()).rejects.toBe(error)
    jest.restoreAllMocks()
    await store.Open()
    expect(store.getByIndex(0)).toEqual(terminal)
    expect(store.getNextIndex()).toBe(1)
    expect(store.getByIndex(1)).toBeUndefined()
    store.setNextIndex(32)
    await store.flush()
  })
})
