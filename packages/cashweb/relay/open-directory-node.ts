/**
 * Node storage for the open directory (bots, and tests that use real admission stores):
 * one Level admission store per account under `root`, and beside them one small file per pin and
 * per checkpoint (kept outside the stores). Each write replaces only its own small file, off the
 * event loop; nothing is rewritten in full when one account is admitted.
 */
import level from 'level'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { openNodeDirectoryStore } from '@frank/directory-admission/node'
import {
  parseCheckpoint,
  serializeCheckpoint,
  type OpenDirectoryDeps,
} from './open-directory'

type Storage = Pick<
  OpenDirectoryDeps,
  'openStore' | 'discardUnenrolled' | 'checkpoints' | 'pins'
>
/** `root` is created if missing. It holds only public directory evidence, no secrets. */
export function nodeDirectoryStorage(root: string): Storage {
  mkdirSync(join(root, 'state'), { recursive: true })
  const digest = (value: string) =>
    createHash('sha256').update(value).digest('hex')
  // Store names and pin keys contain ':'; a hash keeps every path portable and bounded.
  const location = (name: string) => join(root, digest(name))
  const file = (kind: 'pin' | 'checkpoint', key: string) =>
    join(root, 'state', `${kind}-${digest(key)}`)
  // The single-file layout of the first version of this helper, read if it is still there.
  const legacyFile = join(root, 'directory-state.json')
  const legacy: {
    pins?: Record<string, string>
    checkpoints?: Record<string, string>
  } = existsSync(legacyFile) ? JSON.parse(readFileSync(legacyFile, 'utf8')) : {}
  let sequence = 0
  const read = async (path: string): Promise<string | null> => {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  const write = async (path: string, value: string): Promise<void> => {
    const temporary = `${path}.${process.pid}.${sequence++}.tmp`
    await writeFile(temporary, value)
    await rename(temporary, path)
  }
  return {
    openStore: ({ name, anchor, mode }) =>
      openNodeDirectoryStore({ location: location(name), anchor, mode }),
    async discardUnenrolled(name) {
      const path = location(name)
      if (!existsSync(path)) return 'absent'
      const db = level(path, { createIfMissing: false })
      let admitted = false
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for await (const [key] of db.iterator({ values: false }) as any)
          if (String(key) !== 'format') {
            admitted = true
            break
          }
      } finally {
        await db.close()
      }
      if (admitted) return 'retained'
      rmSync(path, { recursive: true, force: true })
      return 'discarded'
    },
    checkpoints: {
      async load(name) {
        const saved =
          (await read(file('checkpoint', name))) ??
          legacy.checkpoints?.[name] ??
          null
        return saved === null ? null : parseCheckpoint(saved)
      },
      save: (name, checkpoint) =>
        write(file('checkpoint', name), serializeCheckpoint(checkpoint)),
    },
    pins: {
      load: async key =>
        (await read(file('pin', key))) ?? legacy.pins?.[key] ?? null,
      save: (key, value) => write(file('pin', key), value),
    },
  }
}
