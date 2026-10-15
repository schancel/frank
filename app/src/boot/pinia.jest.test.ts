/** @jest-environment jsdom */

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    defaultTopicVoteValue: 100_000_000n,
    name: 'test',
    parseAddress: jest.fn(),
    formatAddress: jest.fn(),
    topics: {},
    directMessages: {},
  },
}))
jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({ getIterator: async () => [] }),
}))
jest.mock('../adapters/level-utxo-store', () => ({
  store: Promise.resolve({}),
}))

import { createApp, nextTick } from 'vue'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createPinia, defineStore } from 'pinia'
import type { Pinia } from 'pinia'
import type { LevelDB } from 'level'

import {
  createStoragePlugin,
  resolveStoreMetadata,
  STORE_SCHEMA_VERSION,
  StoreMetadata,
} from './pinia'
import { displayNetwork } from '../utils/constants'
import { useAppearanceStore } from '../stores/appearance'
import { useChatStore } from '../stores/chats'
import { useContactStore } from '../stores/contacts'
import { useForumStore } from '../stores/forum'
import { useProfileStore } from '../stores/my-profile'
import { useRelayClientStore } from '../stores/relay-client'
import { useTopicStore } from '../stores/topics'

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
  it('hydrates without saving and still persists later user changes', async () => {
    const save = jest.fn(async () => undefined)
    const { pinia } = installPinia()
    const useTestStore = defineStore(`initial-hydration-${nextStoreId++}`, {
      state: () => ({ value: 0 }),
      storage: { save, restore: async () => ({ value: 7 }) },
    })
    const store = useTestStore(pinia)
    await store.restored
    await store.flushPersistence()
    expect(store.value).toBe(7)
    expect(save).not.toHaveBeenCalled()
    store.value = 8
    await store.flushPersistence()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['appearance', useAppearanceStore],
    ['chats', useChatStore],
    ['contacts', useContactStore],
    ['forum', useForumStore],
    ['profile', useProfileStore],
    ['relay client', useRelayClientStore],
    ['topics', useTopicStore],
  ])('tracks the real %s store write promise', async (_name, useStore) => {
    const writes: Deferred[] = []
    const storage = {
      get: jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('not found'), { notFound: true }),
        ),
      put: jest.fn(() => {
        const write = deferred()
        writes.push(write)
        return write.promise
      }),
    } as unknown as LevelDB
    const { pinia } = installPinia(storage)
    const store = useStore(pinia as Pinia)
    await store.restored

    writes.forEach(write => write.resolve())
    await store.flushPersistence()
    writes.splice(0)

    store.$patch({})
    const barrier = store.flushPersistence()
    await nextTick()
    expect(writes).toHaveLength(1)

    let settled = false
    const observedBarrier = barrier.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    writes[0].resolve()
    await observedBarrier
  })

  it('tracks the real profile store LevelDB write', async () => {
    const writes: Deferred[] = []
    const storage = {
      get: jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('not found'), { notFound: true }),
        ),
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
    const save = jest.fn<Promise<void>, []>().mockReturnValue(write.promise)
    const store = persistentStore(save)
    await store.restored
    await store.flushPersistence()

    const catchSpy = jest.spyOn(Promise.prototype, 'catch')
    const catchesBeforeMutation = catchSpy.mock.calls.length
    store.setValue(1)
    await nextTick()
    // No consumer has called the barrier yet. The plugin itself must already
    // have attached a rejection handler to the newly-created aggregate.
    expect(catchSpy.mock.calls.length).toBeGreaterThan(catchesBeforeMutation)

    const barrier = store.flushPersistence()
    write.reject(new Error('disk unavailable'))
    await expect(barrier).rejects.toThrow('disk unavailable')
    catchSpy.mockRestore()
  })

  it('drains a later physical write before surfacing the retained error', async () => {
    const failedWrite = deferred()
    const laterWrite = deferred()
    const save = jest
      .fn<Promise<void>, []>()
      .mockReturnValueOnce(failedWrite.promise)
      .mockReturnValueOnce(laterWrite.promise)
    const store = persistentStore(save)
    await store.restored
    await store.flushPersistence()

    store.setValue(1)
    const firstBarrier = store.flushPersistence()
    await nextTick()
    failedWrite.reject(new Error('disk unavailable'))
    await expect(firstBarrier).rejects.toThrow('disk unavailable')

    store.setValue(2)
    const laterBarrier = store.flushPersistence()
    await nextTick()
    const outcome = laterBarrier.then(
      () => 'resolved',
      () => 'rejected',
    )
    const beforeWriteSettles = await Promise.race([
      outcome,
      new Promise<'pending'>(resolve =>
        setTimeout(() => resolve('pending'), 0),
      ),
    ])
    expect(beforeWriteSettles).toBe('pending')

    laterWrite.resolve()
    await expect(laterBarrier).rejects.toThrow('disk unavailable')
  })

  it('coalesces same-tick mutations and waits for the final-state write', async () => {
    const write = deferred()
    const save = jest.fn<Promise<void>, []>().mockReturnValueOnce(write.promise)
    const store = persistentStore(save)
    await store.restored
    await store.flushPersistence()
    save.mockClear()

    store.setValue(1)
    store.setValue(2)
    const barrier = store.flushPersistence()
    await nextTick()

    expect(save).toHaveBeenCalledTimes(1)
    let settled = false
    const observedBarrier = barrier.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    write.resolve()
    await observedBarrier
  })

  it.each(['initial restore', 'rehydrate'])(
    'propagates an unsupported-format error from %s without patching or saving',
    async phase => {
      const { pinia } = installPinia()
      const failure = new Error('Unsupported stored conversation format')
      const save = jest.fn(async () => undefined)
      const restore = jest.fn(async () => ({ value: 7 }))
      if (phase === 'initial restore') restore.mockRejectedValueOnce(failure)
      const useTestStore = defineStore(`restore-failure-${nextStoreId++}`, {
        state: () => ({ value: 0 }),
        storage: { save, restore },
      })
      const store = useTestStore(pinia)
      if (phase === 'initial restore') {
        await expect(store.restored).rejects.toBe(failure)
        expect(store.value).toBe(0)
      } else {
        await store.restored
        await store.flushPersistence()
        save.mockClear()
        restore.mockRejectedValueOnce(failure)
        await expect(store.rehydrate()).rejects.toBe(failure)
        expect(store.value).toBe(7)
      }
      await nextTick()
      expect(save).not.toHaveBeenCalled()
    },
  )

  it('resolves immediately for stores without persistence', async () => {
    const { pinia } = installPinia()
    const useTransientStore = defineStore(`transient-test-${nextStoreId++}`, {
      state: () => ({ value: 0 }),
    })
    const store = useTransientStore(pinia)

    await expect(store.restored).resolves.toBe(true)
    await expect(store.flushPersistence()).resolves.toBeUndefined()
    await expect(store.rehydrate()).resolves.toBeUndefined()
  })

  it('rehydrates persisted state from storage, patches store, and does not re-save to storage (#308)', async () => {
    let persistedValue = 10
    const storage = {
      get: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(JSON.stringify({ value: persistedValue })),
        ),
      put: jest.fn().mockResolvedValue(undefined),
    } as unknown as LevelDB
    const { pinia } = installPinia(storage)
    const saveSpy = jest.fn(async (s: any, _m: any, state: any) => {
      await s.put('test', JSON.stringify(state))
    })
    const useTestStore = defineStore(`rehydrate-test-${nextStoreId++}`, {
      state: () => ({ value: 0 }),
      actions: {
        setValue(value: number) {
          this.value = value
        },
      },
      storage: {
        save: saveSpy,
        restore: async (s: any) => {
          const raw = await s.get('test')
          return JSON.parse(raw)
        },
      },
    })
    const store = useTestStore(pinia)
    await store.restored
    expect(store.value).toBe(10)

    // Clear initial restore write from mock
    ;(storage.put as jest.Mock).mockClear()
    saveSpy.mockClear()

    // Simulating external write (e.g. another tab)
    persistedValue = 99
    await store.rehydrate()
    expect(store.value).toBe(99)

    // Crucial premise: rehydrate() must NOT trigger a save back to storage!
    expect(storage.put).not.toHaveBeenCalled()
    expect(saveSpy).not.toHaveBeenCalled()

    // But subsequent ordinary mutations still save as expected:
    store.setValue(100)
    const barrier = store.flushPersistence()
    await nextTick()
    await barrier
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(storage.put).toHaveBeenCalledTimes(1)
    expect(storage.put).toHaveBeenCalledWith(
      'test',
      JSON.stringify({ value: 100 }),
    )
  })

  describe('schema version migration', () => {
    it('rejects a known version mismatch without rewriting metadata', async () => {
      const storage = {
        get: jest.fn().mockResolvedValue(
          JSON.stringify({
            networkName: displayNetwork,
            version: STORE_SCHEMA_VERSION - 1,
          }),
        ),
        put: jest.fn().mockResolvedValue(undefined),
      } as unknown as LevelDB

      await expect(resolveStoreMetadata(storage)).rejects.toThrow(
        'Unsupported application store metadata',
      )
      expect(storage.put).not.toHaveBeenCalled()
    })

    it('does not overwrite storeMetadata when schema version matches', async () => {
      const storage = {
        get: jest.fn().mockResolvedValue(
          JSON.stringify({
            networkName: displayNetwork,
            version: STORE_SCHEMA_VERSION,
          }),
        ),
        put: jest.fn().mockResolvedValue(undefined),
      } as unknown as LevelDB

      const metadata = await resolveStoreMetadata(storage)
      expect(metadata.version).toBe(STORE_SCHEMA_VERSION)
      expect(storage.put).not.toHaveBeenCalled()
    })
  })
})

describe('metadata read failures', () => {
  it('preserves non-NotFound read error identity', async () => {
    const failure = new Error('storage unavailable')
    const storage = {
      get: jest.fn().mockRejectedValue(failure),
      put: jest.fn(),
    } as unknown as LevelDB
    await expect(resolveStoreMetadata(storage)).rejects.toBe(failure)
    expect(storage.put).not.toHaveBeenCalled()
  })
  it.each([
    '{corrupt',
    JSON.stringify({
      networkName: 'another-network',
      version: STORE_SCHEMA_VERSION,
    }),
  ])(
    'rejects invalid existing metadata without patching or saving: %s',
    async bytes => {
      const storage = {
        get: jest.fn().mockResolvedValue(bytes),
        put: jest.fn(),
      } as unknown as LevelDB
      const pinia = createPinia()
      pinia.use(createStoragePlugin(storage, resolveStoreMetadata(storage)))
      createApp({}).use(pinia)
      const restore = jest.fn(async () => ({ value: 9 }))
      const save = jest.fn(async () => undefined)
      const useStore = defineStore(`bad-metadata-${nextStoreId++}`, {
        state: () => ({ value: 7 }),
        storage: { restore, save },
      })
      const store = useStore(pinia)
      await expect(store.restored).rejects.toThrow()
      await expect(store.rehydrate()).rejects.toThrow()
      expect(store.value).toBe(7)
      expect(restore).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      expect(storage.put).not.toHaveBeenCalled()
    },
  )
  it.each([
    '{}',
    'null',
    '[]',
    JSON.stringify({ networkName: null, version: null }),
  ])('preserves current field defaults for %s', async bytes => {
    const storage = {
      get: jest.fn().mockResolvedValue(bytes),
    } as unknown as LevelDB
    await expect(resolveStoreMetadata(storage)).resolves.toEqual({
      networkName: displayNetwork,
      version: STORE_SCHEMA_VERSION,
    })
  })
})

describe('real Level metadata compatibility', () => {
  const level = jest.requireActual(
    'level/level.js',
  ) as typeof import('level').default
  it.each([
    undefined,
    JSON.stringify({
      networkName: displayNetwork,
      version: STORE_SCHEMA_VERSION,
    }),
  ])(
    'preserves current writer save/reopen without hydration writes (metadata: %s)',
    async marker => {
      const dir = mkdtempSync(join(tmpdir(), 'frank-metadata-compatible-'))
      let db = level(dir)
      try {
        if (marker !== undefined) await db.put('storeMetadata', marker)
        const put = jest.spyOn(db, 'put')
        const makeStore = async () => {
          const metadata = await resolveStoreMetadata(db)
          const pinia = createPinia()
          pinia.use(createStoragePlugin(db, Promise.resolve(metadata)))
          createApp({}).use(pinia)
          const useStore = defineStore(`real-metadata-${nextStoreId++}`, {
            state: () => ({ value: 0 }),
            storage: {
              save: async (storage, _mutation, state) =>
                storage.put('payload', JSON.stringify(state)),
              restore: async storage => {
                try {
                  return JSON.parse(await storage.get('payload'))
                } catch (error) {
                  if (
                    error &&
                    typeof error === 'object' &&
                    'notFound' in error &&
                    error.notFound === true
                  )
                    return {}
                  throw error
                }
              },
            },
          })
          const store = useStore(pinia)
          await store.restored
          return store
        }
        const store = await makeStore()
        expect(put).not.toHaveBeenCalled()
        store.value = 7
        await store.flushPersistence()
        expect(put.mock.calls.map(call => call[0])).toEqual(['payload'])
        await db.close()
        db = level(dir)
        const reopenedPut = jest.spyOn(db, 'put')
        const restored = await makeStore()
        expect(restored.value).toBe(7)
        expect(await db.get('payload')).toBe('{"value":7}')
        if (marker === undefined)
          await expect(db.get('storeMetadata')).rejects.toMatchObject({
            notFound: true,
          })
        else expect(await db.get('storeMetadata')).toBe(marker)
        expect(reopenedPut).not.toHaveBeenCalled()
      } finally {
        await db.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
  it.each([
    '{corrupt',
    JSON.stringify({
      networkName: displayNetwork,
      version: STORE_SCHEMA_VERSION - 1,
    }),
    JSON.stringify({
      networkName: 'another-network',
      version: STORE_SCHEMA_VERSION,
    }),
  ])(
    'rejects existing invalid bytes, then restores after explicit repair: %s',
    async bytes => {
      const dir = mkdtempSync(join(tmpdir(), 'frank-metadata-repair-'))
      let db = level(dir)
      try {
        await db.put('storeMetadata', bytes)
        await db.put('payload', '{"value":7}')
        const put = jest.spyOn(db, 'put')
        await expect(resolveStoreMetadata(db)).rejects.toThrow()
        expect(await db.get('storeMetadata')).toBe(bytes)
        expect(await db.get('payload')).toBe('{"value":7}')
        expect(put).not.toHaveBeenCalled()
        await db.put(
          'storeMetadata',
          JSON.stringify({
            networkName: displayNetwork,
            version: STORE_SCHEMA_VERSION,
          }),
        )
        await db.close()
        db = level(dir)
        const reopenedPut = jest.spyOn(db, 'put')
        await expect(resolveStoreMetadata(db)).resolves.toEqual({
          networkName: displayNetwork,
          version: STORE_SCHEMA_VERSION,
        })
        expect(await db.get('payload')).toBe('{"value":7}')
        expect(reopenedPut).not.toHaveBeenCalled()
      } finally {
        await db.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})
