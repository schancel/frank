import level from 'level/level.js'
import { lstat, open, stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { fail } from '../policy/history'
import {
  boundedRow,
  FORMAT,
  MAX_ROWS,
  MAX_SERIALIZED_BYTES,
  Row,
  sameRows,
  sorted,
  Storage,
} from './records'

export async function openLevel(
  location: string,
  intent: 'new' | 'reopen',
): Promise<Storage> {
  if (
    typeof location !== 'string' ||
    !isAbsolute(location) ||
    location === dirname(location)
  )
    fail('unavailable')
  // Parent must already exist. This bounds first-creation barriers without creating ancestors.
  let exists = false
  try {
    const stat = await lstat(location)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unavailable')
    exists = true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') fail('unavailable')
  }
  if (intent === 'reopen' && !exists) fail('unavailable')
  if (intent === 'new' && exists) fail('already-enrolled')
  try {
    if (!(await stat(dirname(location))).isDirectory()) fail('unavailable')
  } catch {
    fail('unavailable')
  }
  let closed = false
  let failed = false
  // LevelUP starts opening in its constructor. Await that callback: a second
  // open() during auto-open listens only for success and can hang on lock failure.
  const db = await new Promise<ReturnType<typeof level>>((resolve, reject) => {
    const database = level(
      location,
      {
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
        createIfMissing: intent === 'new',
        errorIfExists: intent === 'new',
      },
      error => {
        if (error) reject(new Error('native Level open failed'))
        else resolve(database)
      },
    )
    database.on('error', () => {
      failed = true
    })
  }).catch(() => fail('unavailable'))
  async function read(): Promise<Row[]> {
    if (closed || failed) fail('unavailable')
    const rows: Row[] = []
    let bytes = 0
    for await (const [key, value] of db.iterator()) {
      boundedRow(key, value)
      bytes += key.length + value.length
      if (rows.length >= MAX_ROWS || bytes > MAX_SERIALIZED_BYTES)
        fail('unavailable')
      rows.push([key, value])
    }
    return sorted(rows)
  }
  try {
    // The native LevelDB lock is exclusive across handles and processes.
    if (intent === 'new') {
      await db.batch([{ type: 'put', key: 'format', value: FORMAT }], {
        sync: true,
      })
      for (const path of [location, dirname(location)]) {
        const descriptor = await open(path, 'r')
        try {
          await descriptor.sync()
        } finally {
          await descriptor.close()
        }
      }
    }
  } catch {
    await db.close().catch(() => undefined)
    fail('unavailable')
  }
  return {
    read,
    async commit(expected, additions) {
      if (!sameRows(await read(), expected)) fail('retryable')
      // The facade serializes validation/read/write on this sole privately owned handle.
      await db.batch(
        additions.map(([key, value]) => ({ type: 'put', key, value })),
        { sync: true },
      )
    },
    async close() {
      if (!closed) {
        closed = true
        await db.close()
      }
    },
  }
}
