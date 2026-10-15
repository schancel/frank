import level from 'level/level.js'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import {
  COVERAGE_KEY,
  inventory,
  requireChain,
  requireCoverageChange,
  nextCoverage,
  appendRecord,
  bind,
  BINDING_KEY,
  checkCapacity,
  requireKey,
  StoreQueue,
  validateRecords,
  validateRow,
  negotiationStorageLimits,
  type NegotiationStorageBinding,
  type OwnedNegotiationJournalStore,
} from './negotiation-common'
export { negotiationStorageLimits } from './negotiation-common'

// One loaded native module/process only. Level's OS lock remains mandatory across processes.
// Avoid even constructing a duplicate same-process Level handle: closing that failed attempt
// can drop POSIX process-scoped file locks held by the original descriptor.
const ownership = new Map<string, object>()

function code(error: unknown, expected: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === expected
  )
}
class NativeCleanupError extends Error {
  constructor(readonly original: unknown, readonly cleanup: unknown) {
    super('Negotiation native operation failed and cleanup failed')
  }
}
async function syncDirectory(location: string): Promise<void> {
  const file = await fs.open(location, 'r')
  let failed = false,
    failure: unknown
  try {
    await file.sync()
  } catch (error) {
    failed = true
    failure = error
  }
  try {
    await file.close()
  } catch (cleanup) {
    if (failed) throw new NativeCleanupError(failure, cleanup)
    throw cleanup
  }
  if (failed) throw failure
}
/** Existing approved POSIX root only; absent factory/read never create a namespace. */
export async function createNativeNegotiationJournalStore(
  input: NegotiationStorageBinding & { readonly rootLocation: string },
): Promise<OwnedNegotiationJournalStore> {
  const binding = bind(input),
    rootLocation = input.rootLocation
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error(
      'Negotiation storage requires qualified POSIX directory fsync',
    )
  if (
    typeof rootLocation !== 'string' ||
    !(await fs.lstat(rootLocation)).isDirectory()
  )
    throw new Error('Existing approved storage root required')
  const root = await fs.realpath(rootLocation),
    location = join(root, binding.namespace)
  const queue = new StoreQueue()
  let database: ReturnType<typeof level> | undefined,
    handle: ReturnType<typeof level> | undefined,
    token: object | undefined
  async function inspect(): Promise<boolean> {
    let stat
    try {
      stat = await fs.lstat(location)
    } catch (error) {
      if (code(error, 'ENOENT')) return false
      throw error
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.realpath(location)) !== location
    )
      throw new Error('Invalid negotiation namespace directory')
    for (const name of await fs.readdir(location)) {
      if (
        !/^(?:CURRENT|LOCK|LOG(?:\.old)?|MANIFEST-[0-9]+|[0-9]+\.(?:log|ldb|sst|dbtmp))$/.test(
          name,
        ) ||
        !(await fs.lstat(join(location, name))).isFile()
      )
        throw new Error('Unexpected negotiation namespace layout')
    }
    const current = await fs.readFile(join(location, 'CURRENT'), 'utf8')
    if (
      !/^MANIFEST-[0-9]+\n$/.test(current) ||
      !(await fs.lstat(join(location, current.trim()))).isFile()
    )
      throw new Error('Incomplete negotiation Level namespace')
    return true
  }
  async function records(db: ReturnType<typeof level>) {
    const rows: Array<[unknown, unknown]> = []
    let rawBytes = 0
    for await (const [key, value] of db.iterator()) {
      rawBytes += appendRecord(rows, key, value)
      if (rawBytes > negotiationStorageLimits.rawBytes)
        throw new Error('Existing negotiation storage exceeds capacity')
    }
    return validateRecords(binding, rows)
  }
  function releaseOwnership(): void {
    if (token && ownership.get(location) === token) ownership.delete(location)
    token = undefined
  }
  async function cleanup(): Promise<void> {
    if (handle) {
      await handle.close()
      handle = undefined
      database = undefined
    }
    releaseOwnership()
  }
  async function open(first?: {
    key: string
    raw: string
  }): Promise<{ db: ReturnType<typeof level>; created: boolean } | undefined> {
    if (database) return { db: database, created: false }
    if (ownership.has(location))
      throw new Error(
        'Negotiation Level LOCK: canonical location already owned in this module',
      )
    token = {}
    ownership.set(location, token)
    let acquired: ReturnType<typeof level> | undefined
    try {
      let exists = await inspect(),
        created = false
      if (!exists && !first) {
        releaseOwnership()
        return undefined
      }
      if (!exists) {
        try {
          await fs.mkdir(location)
          created = true
        } catch (error) {
          if (!code(error, 'EEXIST')) throw error
          exists = await inspect()
          if (!exists) throw new Error('Namespace changed during creation')
        }
      }
      const db = await new Promise<ReturnType<typeof level>>(
        (resolve, reject) => {
          acquired = level(
            location,
            {
              keyEncoding: 'utf8',
              valueEncoding: 'utf8',
              createIfMissing: created,
              errorIfExists: created,
            },
            error => (error ? reject(error) : resolve(acquired!)),
          )
          handle = acquired
          acquired.on('error', error => queue.poison(error))
        },
      )
      if (created) {
        if (!first) throw new Error('Missing first negotiation record')
        await db.batch(
          [
            { type: 'put', key: BINDING_KEY, value: binding.metadata },
            { type: 'put', key: first.key, value: first.raw },
          ],
          { sync: true },
        )
      }
      // Fence recovery manifest changes on every actual open, and first creation's parent.
      await syncDirectory(location)
      if (created) await syncDirectory(root)
      if (!created) await records(db)
      database = db
      return { db, created }
    } catch (error) {
      try {
        await cleanup()
      } catch (cleanupFailure) {
        throw new NativeCleanupError(error, cleanupFailure)
      }
      throw error
    }
  }
  return {
    namespace: binding.namespace,
    async read(key) {
      queue.assertAvailable()
      requireKey(key)
      return queue.run(async () => {
        const opened = await open()
        return opened ? (await records(opened.db)).rows.get(key) : undefined
      })
    },
    async listRecords() {
      queue.assertAvailable()
      return queue.run(async () => {
        const opened = await open()
        return inventory(opened ? (await records(opened.db)).rows : new Map())
      })
    },
    async readCoverage(chainIdentifier) {
      queue.assertAvailable()
      requireChain(chainIdentifier)
      return queue.run(async () => {
        const opened = await open()
        return opened
          ? (await records(opened.db)).coverage.get(chainIdentifier)
          : undefined
      })
    },
    async compareAndSwapCoverage(chainIdentifier, expected, next) {
      queue.assertAvailable()
      requireCoverageChange(chainIdentifier, expected, next)
      return queue.run(async () => {
        let opened = await open()
        if (!opened) {
          if (expected !== undefined) return false
          opened = await open({
            key: COVERAGE_KEY,
            raw: nextCoverage(new Map(), chainIdentifier, next),
          })
          if (opened?.created) return true
        }
        if (!opened) throw new Error('Negotiation namespace unavailable')
        const { coverage } = await records(opened.db)
        if (coverage.get(chainIdentifier) !== expected) return false
        await opened.db.batch(
          [
            {
              type: 'put',
              key: COVERAGE_KEY,
              value: nextCoverage(coverage, chainIdentifier, next),
            },
          ],
          { sync: true },
        )
        return true
      })
    },
    async compareAndSwap(key, expectedRaw, nextRaw) {
      queue.assertAvailable()
      requireKey(key)
      if (expectedRaw !== undefined && typeof expectedRaw !== 'string')
        throw new TypeError('Expected raw must be a string or undefined')
      const next = validateRow(binding, key, nextRaw)
      return queue.run(async () => {
        let opened = await open()
        if (!opened) {
          if (expectedRaw !== undefined) return false
          opened = await open({ key, raw: next })
          if (opened?.created) return true
        }
        if (!opened) throw new Error('Negotiation namespace unavailable')
        const { rows } = await records(opened.db)
        if (rows.get(key) !== expectedRaw) return false
        checkCapacity(rows, key, next)
        await opened.db.batch([{ type: 'put', key, value: next }], {
          sync: true,
        })
        return true
      })
    },
    close: () => queue.close(cleanup),
  }
}
