/** @jest-environment node */

import { rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import level from 'level'
import type { LevelDB } from 'level'

// A failed LevelUP open used to emit 'error' with no listener. Jest reported
// that as "Unhandled error. (Error {})" on whichever test was in the worker,
// including MainLayout's rail-tab test. The guard must keep this test green.
it('keeps a failed level open from becoming an unhandled error event', async () => {
  const file = join(tmpdir(), `frank-level-not-a-dir-${process.pid}`)
  writeFileSync(file, 'x')
  try {
    const db = level(file) as { status: string; close: () => Promise<void> }
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(db.status).not.toBe('open')
    await db.close().catch(() => undefined)
  } finally {
    try {
      unlinkSync(file)
    } catch {
      // leveldown may already have removed the placeholder file
    }
  }
})

it('still reads back a value from a real level database', async () => {
  const dir = join(tmpdir(), `frank-level-ok-${process.pid}`)
  const db: LevelDB = level(dir)
  try {
    await db.put('k', 'v')
    await expect(db.get('k')).resolves.toBe('v')
  } finally {
    await db.close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})
