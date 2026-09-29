/** @jest-environment jsdom */

import { createApp, nextTick } from 'vue'
import { createPinia, defineStore } from 'pinia'
import type { LevelDB } from 'level'

import { createStoragePlugin, StoreMetadata } from './pinia'
import { useProfileStore } from '../stores/my-profile'

interface Deferred {
  promise: Promise<void>
  resolve(): void
  reject(error: Error): void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const METADATA: StoreMetadata = {
  networkName: 'test',
  version: 4,
}

function installPinia(storage = {} as LevelDB) {
  const pinia = createPinia()
  pinia.use(createStoragePlugin(storage, Promise.resolve(METADATA)))
  createApp({}).use(pinia)
  return { pinia, storage }
}

let nextStoreId = 0

function persistentStore(save: () => Promise<void>) {
  const { pinia } = installPinia()
  const useTestStore = defineStore(`persistence-test-${nextStoreId++}`, {
    state: () => ({ value: 0 }),
    actions: {
      setValue(value: number) {
        this.value = value
      },
    },
    storage: {
      save,
      async restore() {
        return {}
      },
    },
  })
  return useTestStore(pinia)
}

describe('Pinia persistence barrier', () => {
  it('tracks the real profile store LevelDB write', async () => {
    const writes: Deferred[] = []
    const storage = {
      get: jest.fn().mockRejectedValue(new Error('not found')),
      put: jest.fn(() => {
        const write = deferred()
        writes.push(write)
        return write.promise
      }),
    } as unknown as LevelDB
    const { pinia } = installPinia(storage)
    const store = useProfileStore(pinia)
    await store.restored

    // Restoring the initial state retains the legacy plugin behavior of
    // emitting one patch/save. Drain it before exercising the user mutation.
    writes.shift()?.resolve()
    await store.flushPersistence()

    store.setRelayData({
      profile: { name: 'Imported Alice' },
      inbox: { acceptancePrice: 1 },
    })
    await nextTick()
    expect(writes).toHaveLength(1)

    let settled = false
    const barrier = store.flushPersistence().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    writes.forEach(write => write.resolve())
    await barrier
  })

  it('includes immediate mutations and waits for every observed write', async () => {
    const first = deferred()
    const second = deferred()
    const save = jest
      .fn<Promise<void>, []>()
      .mockResolvedValueOnce()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const store = persistentStore(save)
    await store.restored
    await store.flushPersistence()
    save.mockClear()

    store.setValue(1)
    await nextTick()
    store.setValue(2)
    const barrier = store.flushPersistence()
    await nextTick()
    expect(save).toHaveBeenCalledTimes(2)

    let settled = false
    const observedBarrier = barrier.then(() => {
      settled = true
    })
    second.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    first.resolve()
    await observedBarrier
    expect(settled).toBe(true)
  })

  it('surfaces a rejected write without an unhandled rejection window', async () => {
    const write = deferred()
    const save = jest
      .fn<Promise<void>, []>()
      .mockResolvedValueOnce()
      .mockReturnValue(write.promise)
    const store = persistentStore(save)
    await store.restored
    await store.flushPersistence()

    store.setValue(1)
    const barrier = store.flushPersistence()
    await nextTick()
    write.reject(new Error('disk unavailable'))

    await expect(barrier).rejects.toThrow('disk unavailable')
    await expect(store.flushPersistence()).rejects.toThrow('disk unavailable')
  })

  it('resolves immediately for stores without persistence', async () => {
    const { pinia } = installPinia()
    const useTransientStore = defineStore(`transient-test-${nextStoreId++}`, {
      state: () => ({ value: 0 }),
    })
    const store = useTransientStore(pinia)

    await expect(store.restored).resolves.toBe(true)
    await expect(store.flushPersistence()).resolves.toBeUndefined()
  })
})
