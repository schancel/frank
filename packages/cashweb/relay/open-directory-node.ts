/**
 * Node storage for the open directory (bots, and tests that use real admission stores):
 * one Level admission store per account under `root`, and one small JSON file beside them that
 * holds the first-contact pins and the whole checkpoints outside the stores.
 */
import level from 'level'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
interface State {
  version: 1
  pins: Record<string, string>
  checkpoints: Record<string, string>
}

/** `root` is created if missing. It holds only public directory evidence, no secrets. */
export function nodeDirectoryStorage(root: string): Storage {
  mkdirSync(root, { recursive: true })
  const file = join(root, 'directory-state.json')
  const state: State = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as State)
    : { version: 1, pins: {}, checkpoints: {} }
  if (state.version !== 1) throw new Error('Unknown directory state version')
  const save = () => {
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(state))
    renameSync(temporary, file)
  }
  // Store names contain ':'; a hash keeps every path portable and bounded.
  const location = (name: string) =>
    join(root, createHash('sha256').update(name).digest('hex'))
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
      load: name =>
        name in state.checkpoints
          ? parseCheckpoint(state.checkpoints[name])
          : null,
      save(name, checkpoint) {
        state.checkpoints[name] = serializeCheckpoint(checkpoint)
        save()
      },
    },
    pins: {
      load: key => state.pins[key] ?? null,
      save(key, revisionZero) {
        state.pins[key] = revisionZero
        save()
      },
    },
  }
}
