import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { messageMetadataBackend } from './message-store-backend'

it('commits the first Node immutable binding with its format marker and retains both on reopen', async () => {
  const location = await mkdtemp(join(tmpdir(), 'message-metadata-node-'))
  try {
    let backend = messageMetadataBackend(location, error => {
      if (error) throw error
    })
    await backend.db.open()
    await backend.bindImmutable('binding', 'original', ['schemaVersion', '3'])
    await backend.db.close()
    backend = messageMetadataBackend(location, error => {
      if (error) throw error
    })
    await backend.db.open()
    expect(await backend.db.get('schemaVersion')).toBe('3')
    expect(await backend.db.get('binding')).toBe('original')
    await expect(
      backend.bindImmutable('binding', 'replacement', ['schemaVersion', '3']),
    ).rejects.toThrow('conflict')
    await backend.db.close()
  } finally {
    await rm(location, { recursive: true, force: true })
  }
})
