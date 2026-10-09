// Compile-time contract for ./level.d.ts, the repository's single declaration of the bare `level`
// module. This file is never imported and emits nothing. It is compiled by packages/wallet's
// tsconfig, so `yarn typecheck` fails if the declaration stops describing the installed Level 7
// API. Each `@ts-expect-error` below is an assertion, not a suppression: the compiler reports an
// unused directive (TS2578) if the line under it ever starts to compile.
import type {
  LevelBatchOperation,
  LevelDB,
  LevelDBIterator,
  LevelDBKeyIterator,
  LevelEntryCallback,
} from 'level'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false
type Expect<T extends true> = T

declare const db: LevelDB

// iterator() returns the iterator itself, synchronously, with or without options.
const entries = db.iterator()
const ranged = db.iterator({ gte: 'a', lt: 'b', limit: 1 })
const keysOnly = db.iterator({ values: false })
export type IteratorIsSynchronous = [
  Expect<Equal<typeof entries, LevelDBIterator>>,
  Expect<Equal<typeof ranged, LevelDBIterator>>,
  Expect<Equal<typeof keysOnly, LevelDBKeyIterator>>,
]
// @ts-expect-error iterator() is not a Promise.
export const notAPromise: Promise<unknown> = db.iterator()

// Promise-mode next() resolves an entry tuple or undefined, never a bare string.
const pending = entries.next()
export type NextResolvesAnEntry = Expect<
  Equal<Awaited<typeof pending>, [key: string, value: string] | undefined>
>
// @ts-expect-error next() does not resolve a string.
export const notAString: Promise<string> = entries.next()

// Async iteration yields [key, value] string tuples; a keys-only iterator yields no value.
export async function iterate(): Promise<void> {
  for await (const [key, value] of entries) {
    const k: string = key
    const v: string = value
    void k
    void v
  }
  for await (const [key, value] of keysOnly) {
    const k: string = key
    const v: undefined = value
    void k
    void v
  }
}

// Callback-mode next(): unannotated parameters narrow together.
export const entryCallback: LevelEntryCallback = (error, key, value) => {
  if (error) {
    const failed: Error = error
    void failed
    return
  }
  if (key === undefined) {
    const exhausted: undefined = value
    void exhausted
    return
  }
  const k: string = key
  const v: string = value
  void k
  void v
}
entries.next(entryCallback)
declare const assumesAnError: (error: Error, key: string, value: string) => void
// @ts-expect-error a callback that assumes `error` is always an Error is rejected.
entries.next(assumesAnError)
keysOnly.next((error, key) => void [error, key])
entries.end(error => void error)

// Durable writes and batches.
const put: LevelBatchOperation = { type: 'put', key: 'k', value: 'v' }
const del: LevelBatchOperation = { type: 'del', key: 'k' }
export const writes: Promise<void>[] = [
  db.put('k', 'v', { sync: true }),
  db.del('k', { sync: true }),
  db.batch([put, del], { sync: true }),
  db.batch().put('k', 'v').del('k').write({ sync: true }),
]
// @ts-expect-error a batch operation needs a literal 'put' or 'del' type.
db.batch([{ type: 'merge', key: 'k', value: 'v' }])
// @ts-expect-error an unmodelled write option is rejected.
db.put('k', 'v', { fsync: true })
// @ts-expect-error an unmodelled iterator option is rejected.
db.iterator({ keys: false })
