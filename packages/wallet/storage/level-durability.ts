/* eslint-disable @typescript-eslint/no-explicit-any */
import type { LevelDB } from 'level'
import { join } from 'path'

/** leveldown defaults to `sync: false`. Every wallet authority mutation goes through these
 * helpers so an awaited write means stable storage rather than merely completion of the write
 * callback. In browsers, level-js ignores this option; `openDurableLevel` replaces its transaction
 * factory with strict-durability IndexedDB transactions and fails closed when the runtime cannot
 * prove that capability. */
export const DURABLE_LEVEL_WRITE_OPTIONS = Object.freeze({ sync: true })

function browserStorageRuntime(): boolean {
  const globals = globalThis as any
  return (
    globals.window !== undefined &&
    globals.indexedDB !== undefined &&
    globals.navigator !== undefined
  )
}

function levelJsBackend(database: any): any | undefined {
  const visited = new Set<unknown>()
  const pending = [database]
  while (pending.length > 0) {
    const candidate = pending.shift()
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      visited.has(candidate)
    ) {
      continue
    }
    visited.add(candidate)
    if (
      candidate.type === 'level-js' &&
      candidate.db !== undefined &&
      typeof candidate.location === 'string'
    ) {
      return candidate
    }
    pending.push(candidate.db, candidate._db)
  }
  return undefined
}

function requireStrictIndexedDbTransactions(database: LevelDB): void {
  const backend = levelJsBackend(database)
  if (backend === undefined) {
    throw new Error(
      'Persistent browser wallet storage requires an inspectable level-js backend'
    )
  }
  let probe: any
  try {
    probe = backend.db.transaction([backend.location], 'readonly', {
      durability: 'strict',
    })
  } catch {
    throw new Error(
      'Persistent browser wallet storage requires strict IndexedDB durability'
    )
  }
  if (probe.durability !== 'strict') {
    try {
      probe.abort()
    } catch {
      // The capability check below is authoritative; abort is best-effort cleanup only.
    }
    throw new Error(
      'Persistent browser wallet storage requires strict IndexedDB durability'
    )
  }

  backend.store = function strictWalletStore(mode: string): any {
    const transaction =
      mode === 'readwrite'
        ? this.db.transaction([this.location], mode, { durability: 'strict' })
        : this.db.transaction([this.location], mode)
    if (mode === 'readwrite' && transaction.durability !== 'strict') {
      try {
        transaction.abort()
      } catch {
        // Fail closed below even if the runtime has already completed/aborted it.
      }
      throw new Error(
        'Persistent browser wallet storage lost strict IndexedDB durability'
      )
    }
    return transaction.objectStore(this.location)
  }
}

function fsyncNewLevelNamespace(
  rootLocation: string,
  component: string,
  existedBeforeOpen: boolean
): void {
  if (existedBeforeOpen) return
  // Keep Node's filesystem module outside browser bundles.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs')
  const componentPath = join(rootLocation, component)
  for (const path of [componentPath, rootLocation]) {
    const descriptor = fs.openSync(path, 'r')
    try {
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
  }
}

export async function openDurableLevel(
  database: LevelDB,
  rootLocation: string,
  component: string
): Promise<void> {
  let existedBeforeOpen = true
  if (!browserStorageRuntime()) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs')
    existedBeforeOpen = fs.existsSync(join(rootLocation, component))
  }
  await (database as any).open()
  if (browserStorageRuntime()) {
    requireStrictIndexedDbTransactions(database)
  } else {
    fsyncNewLevelNamespace(rootLocation, component, existedBeforeOpen)
  }
}

export function durablePut(
  database: LevelDB,
  key: string,
  value: string
): Promise<unknown> {
  return (database as any).put(key, value, DURABLE_LEVEL_WRITE_OPTIONS)
}

export function durableDelete(
  database: LevelDB,
  key: string
): Promise<unknown> {
  return (database as any).del(key, DURABLE_LEVEL_WRITE_OPTIONS)
}

export function durableBatch(
  database: LevelDB,
  operations: ReadonlyArray<
    { type: 'put'; key: string; value: string } | { type: 'del'; key: string }
  >
): Promise<unknown> {
  return (database as any).batch(operations, DURABLE_LEVEL_WRITE_OPTIONS)
}

/** level-js implements `clear` through a separate transaction path that cannot request strict
 * durability. Express it as one ordinary batch so both Node and browser use the same barrier. */
export async function durableClear(database: LevelDB): Promise<void> {
  const operations: Array<{ type: 'del'; key: string }> = []
  for await (const [key] of (database as any).iterator({})) {
    operations.push({ type: 'del', key })
  }
  if (operations.length > 0) await durableBatch(database, operations)
}
