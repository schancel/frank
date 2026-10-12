import 'fake-indexeddb/auto'
import { IDBDatabase } from 'fake-indexeddb'
import { messageMetadataBackend } from './message-store-backend'

let sequence = 0
async function open(location: string) {
  const backend = messageMetadataBackend(location, error => {
    if (error) throw error
  })
  await backend.db.open()
  return backend
}

describe('owned MessageStore strict browser backend', () => {
  afterEach(() => jest.restoreAllMocks())
  it('keeps readonly open empty and uses strict transactions for metadata mutations and CAS', async () => {
    const backend = await open(`/metadata-backend-${++sequence}`)
    expect(await backend.db.iterator().next()).toBeUndefined()
    const transactions = jest.spyOn(IDBDatabase.prototype, 'transaction')
    await backend.db.put('ordinary', 'value')
    await backend.bindImmutable('binding', 'original', ['schemaVersion', '2'])
    await backend.bindImmutable('binding', 'original', ['schemaVersion', '2'])
    await expect(
      backend.bindImmutable('binding', 'changed', ['schemaVersion', '2']),
    ).rejects.toThrow('conflict')
    expect(await backend.db.get('binding')).toBe('original')
    expect(await backend.db.get('schemaVersion')).toBe('2')
    expect(
      transactions.mock.calls
        .filter(call => call[1] === 'readwrite')
        .every(call => call[2]?.durability === 'strict'),
    ).toBe(true)
    await backend.db.close()
  })
  it('rejects competing CAS from distinct handles without overwriting a winner', async () => {
    const location = `/metadata-backend-${++sequence}`
    const a = await open(location),
      b = await open(location)
    const results = await Promise.allSettled([
      a.bindImmutable('binding', 'A', ['schemaVersion', '2']),
      b.bindImmutable('binding', 'B', ['schemaVersion', '2']),
    ])
    expect(
      results.filter(result => result.status === 'fulfilled'),
    ).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(
      1,
    )
    await Promise.all([a.db.close(), b.db.close()])
    const reopened = await open(location)
    expect(['A', 'B']).toContain(await reopened.db.get('binding'))
    await reopened.db.close()
  })
  it('fails closed before CAS if strict durability is unavailable', async () => {
    const backend = await open(`/metadata-backend-${++sequence}`)
    const original = IDBDatabase.prototype.transaction
    const transaction = jest
      .spyOn(IDBDatabase.prototype, 'transaction')
      .mockImplementation(function (
        this: IDBDatabase,
        ...args: Parameters<typeof original>
      ) {
        const result = original.apply(this, args)
        if (args[1] === 'readwrite')
          Object.defineProperty(result, 'durability', { value: 'relaxed' })
        return result
      })
    await expect(
      backend.bindImmutable('binding', 'A', ['schemaVersion', '2']),
    ).rejects.toThrow('durability')
    transaction.mockRestore()
    expect(await backend.db.iterator().next()).toBeUndefined()
    await backend.db.close()
  })
})
