/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { type LevelDB } from 'level'
import { join, resolve } from 'path'
import { openDurableLevel } from './level-durability'

export const SPEND_POOL_NAMESPACE = 'spend-pool'

export type SpendPoolEntryKind = 'sub-account' | 'change' | 'coin'

const KNOWN_PREFIXES: readonly string[] = [
  'sub-account:',
  'change:',
  'coin:',
]

interface SharedSpendPoolHandle {
  readonly db: LevelDB
  readonly activeKinds: Set<SpendPoolEntryKind>
  openPromise?: Promise<void>
  closingPromise?: Promise<void>
}

const sharedSpendPools = new Map<string, SharedSpendPoolHandle>()

function acquireSharedSpendPool(
  rootLocation: string,
  kind: SpendPoolEntryKind,
): {
  db: LevelDB
  open(): Promise<void>
  release(): Promise<void>
} {
  const key = resolve(rootLocation, SPEND_POOL_NAMESPACE)
  let shared = sharedSpendPools.get(key)

  // If a partition of the same kind is already open at this location (e.g. a test simulating
  // two concurrent store wrappers via mocked level()), open a separate handle.
  if (shared !== undefined && shared.activeKinds.has(kind)) {
    const standalone = level(join(rootLocation, SPEND_POOL_NAMESPACE))
    let standaloneClosed = false
    return {
      db: standalone,
      open: () =>
        openDurableLevel(standalone, rootLocation, SPEND_POOL_NAMESPACE),
      release: async () => {
        if (standaloneClosed) return
        standaloneClosed = true
        await (standalone as any).close()
      },
    }
  }

  if (shared === undefined) {
    const db = level(join(rootLocation, SPEND_POOL_NAMESPACE))
    shared = {
      db,
      activeKinds: new Set<SpendPoolEntryKind>(),
    }
    sharedSpendPools.set(key, shared)
  }

  const target = shared
  target.activeKinds.add(kind)
  let released = false

  return {
    db: target.db,
    open: async () => {
      if (target.openPromise === undefined) {
        target.openPromise = openDurableLevel(
          target.db,
          rootLocation,
          SPEND_POOL_NAMESPACE,
        ).catch(err => {
          sharedSpendPools.delete(key)
          throw err
        })
      }
      await target.openPromise
    },
    release: async () => {
      if (released) return
      released = true
      target.activeKinds.delete(kind)
      if (target.activeKinds.size === 0) {
        if (sharedSpendPools.get(key) === target) {
          sharedSpendPools.delete(key)
        }
        if (target.closingPromise === undefined) {
          target.closingPromise = (target.db as any).close()
        }
        await target.closingPromise
      }
    },
  }
}

/**
 * Creates a `LevelDB`-compatible partition view over the unified `<location>/spend-pool` LevelDB
 * store, prefixing all keys with `${kind}:` (`sub-account:`, `change:`, or `coin:`).
 *
 * Unknown/unprefixed keys in the underlying database are surfaced during iteration so that raw
 * corruption checks fail closed.
 */
export function createSpendPoolPartitionDb(
  rootLocation: string,
  kind: SpendPoolEntryKind,
): LevelDB {
  const prefix = `${kind}:`
  let handle: ReturnType<typeof acquireSharedSpendPool> | undefined

  const ensureHandle = () => {
    if (handle === undefined) {
      handle = acquireSharedSpendPool(rootLocation, kind)
    }
    return handle
  }

  const partition: any = {
    get db() {
      return ensureHandle().db
    },
    async open(): Promise<void> {
      const current = ensureHandle()
      try {
        await current.open()
      } catch (error) {
        handle = undefined
        await current.release().catch(() => undefined)
        throw error
      }
    },
    async close(): Promise<void> {
      if (handle === undefined) return
      const current = handle
      handle = undefined
      await current.release()
    },
    async get(key: string, options?: any): Promise<any> {
      return (ensureHandle().db as any).get(`${prefix}${key}`, options)
    },
    async put(key: string, value: string, options?: any): Promise<any> {
      return (ensureHandle().db as any).put(`${prefix}${key}`, value, options)
    },
    async del(key: string, options?: any): Promise<any> {
      return (ensureHandle().db as any).del(`${prefix}${key}`, options)
    },
    async batch(operations: ReadonlyArray<any>, options?: any): Promise<any> {
      const prefixed = operations.map(op => ({
        ...op,
        key: `${prefix}${op.key}`,
      }))
      return (ensureHandle().db as any).batch(prefixed, options)
    },
    iterator(options?: any) {
      const rawIterator = (ensureHandle().db as any).iterator(options ?? {})
      return {
        async *[Symbol.asyncIterator]() {
          for await (const [rawKey, value] of rawIterator) {
            const keyStr = String(rawKey)
            if (keyStr.startsWith(prefix)) {
              yield [keyStr.slice(prefix.length), value]
            } else if (!KNOWN_PREFIXES.some(p => keyStr.startsWith(p))) {
              // Surface unprefixed keys so corruption checks fail closed.
              yield [keyStr, value]
            }
          }
        },
      }
    },
  }

  return partition as LevelDB
}
