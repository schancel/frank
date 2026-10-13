import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import level from 'level'
import { LevelRecordStore } from './evm-coin-store'

jest.mock('level', () => jest.fn(jest.requireActual('level')))

test('refresh reads one durable owner without writes and replaces stale caches only after a complete valid read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frank-record-refresh-'))
  const actual: typeof level = jest.requireActual('level')
  const db = actual(join(root, 'records'))
  jest.mocked(level).mockImplementation(() => db)
  const stores: LevelRecordStore<{ value: number }>[] = []
  try {
    const first = await LevelRecordStore.open<{ value: number }>(
      root,
      'records',
    )
    const second = await LevelRecordStore.open<{ value: number }>(
      root,
      'records',
    )
    stores.push(first, second)
    await first.put('old', { value: 1 })
    expect(second.all()).toEqual([])
    const put = jest.spyOn(db, 'put'),
      del = jest.spyOn(db, 'del'),
      batch = jest.spyOn(db, 'batch')
    await second.refresh()
    expect(second.get('old')).toEqual({ value: 1 })
    expect(put).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
    expect(batch).not.toHaveBeenCalled()
    await first.delete('old')
    await first.put('new', { value: 2 })
    await second.refresh()
    expect(second.get('old')).toBeUndefined()
    expect(second.all()).toEqual([{ value: 2 }])
    await db.put('broken', '{invalid')
    await expect(second.refresh()).rejects.toThrow()
    expect(second.all()).toEqual([{ value: 2 }])
    expect(String(await db.get('broken'))).toBe('{invalid')
  } finally {
    await Promise.all(stores.map(store => store.close()))
    jest.mocked(level).mockImplementation(actual)
    await rm(root, { recursive: true, force: true })
  }
})
