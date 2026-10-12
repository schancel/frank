import type { SolanaPaymentPersistence, SolanaPaymentSnapshot } from '../solana-contact-payments/types'

/** Native IndexedDB transactions provide cross-tab selection exclusion. Opening a
 * missing database read-only aborts its upgrade: hydration never creates defaults.
 * Initialization is deferred to the first authorized state mutation. */
export class IndexedDbSolanaPaymentPersistence implements SolanaPaymentPersistence {
  constructor(private readonly name: string, private readonly factory: IDBFactory = indexedDB) {}

  private open(initialize: boolean): Promise<IDBDatabase | undefined> {
    return new Promise((resolve, reject) => {
      const request = this.factory.open(this.name, 1)
      let absent = false
      request.onupgradeneeded = () => {
        if (!initialize) {
          absent = true
          request.transaction!.abort()
        } else request.result.createObjectStore('authority')
      }
      request.onerror = () => absent ? resolve(undefined) : reject(request.error)
      request.onblocked = () => reject(new Error('Solana payment state upgrade blocked'))
      request.onsuccess = () => {
        const db = request.result
        if (!db.objectStoreNames.contains('authority')) {
          db.close()
          reject(new Error('Invalid Solana payment database schema'))
        } else resolve(db)
      }
    })
  }

  async read(): Promise<unknown | undefined> {
    const db = await this.open(false)
    if (!db) return undefined
    return new Promise((resolve, reject) => {
      const tx = db.transaction('authority', 'readonly')
      const request = tx.objectStore('authority').get('snapshot')
      tx.oncomplete = () => { db.close(); resolve(request.result) }
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? request.error) }
    })
  }

  async update<T>(mutate: (previous: unknown | undefined) => { value: SolanaPaymentSnapshot; result: T }): Promise<T> {
    const db = await this.open(true)
    if (!db) throw new Error('Solana payment state initialization failed')
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction
      try {
        tx = db.transaction('authority', 'readwrite', { durability: 'strict' })
        if (tx.durability !== 'strict') { tx.abort(); throw new Error('Strict IndexedDB durability required') }
      } catch (error) { db.close(); reject(error); return }
      let result: T
      let failure: unknown
      const store = tx.objectStore('authority')
      const request = store.get('snapshot')
      request.onsuccess = () => {
        try {
          const next = mutate(request.result)
          result = next.result
          store.put(next.value, 'snapshot')
        } catch (error) { failure = error; tx.abort() }
      }
      tx.oncomplete = () => { db.close(); resolve(result) }
      tx.onabort = tx.onerror = () => { db.close(); reject(failure ?? tx.error ?? request.error) }
    })
  }
}

/** Test-only volatile backend. Reusing this instance models one shared authority;
 * it makes no disk durability or browser coordination claim. */
export class MemorySolanaPaymentPersistence implements SolanaPaymentPersistence {
  private value: unknown
  private queue: Promise<unknown> = Promise.resolve()
  async read(): Promise<unknown | undefined> { await this.queue; return structuredClone(this.value) }
  update<T>(mutate: (previous: unknown | undefined) => { value: SolanaPaymentSnapshot; result: T }): Promise<T> {
    const run = this.queue.then(() => {
      const next = mutate(structuredClone(this.value))
      this.value = structuredClone(next.value)
      return structuredClone(next.result)
    })
    this.queue = run.catch(() => undefined)
    return run
  }
}
