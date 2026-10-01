/** @jest-environment jsdom */

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    name: 'test',
    parseAddress: jest.fn(),
    formatAddress: jest.fn(),
    topics: {},
    directMessages: {},
  },
}))
jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({}),
}))
jest.mock('../adapters/level-utxo-store', () => ({
  store: Promise.resolve({}),
}))

import { createApp, nextTick } from 'vue'
import { createPinia, defineStore } from 'pinia'
import type { Pinia } from 'pinia'
import type { LevelDB } from 'level'

import { createStoragePlugin, StoreMetadata } from './pinia'
import { useAppearanceStore } from '../stores/appearance'
import { useChatStore } from '../stores/chats'
import { useContactStore } from '../stores/contacts'
import { useForumStore } from '../stores/forum'
import { useProfileStore } from '../stores/my-profile'
import { useRelayClientStore } from '../stores/relay-client'
import { useTopicStore } from '../stores/topics'
import { useWalletStore } from '../stores/wallet'

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
  it.each([
    ['appearance', useAppearanceStore],
    ['chats', useChatStore],
    ['contacts', useContactStore],
    ['forum', useForumStore],
    ['profile', useProfileStore],
    ['relay client', useRelayClientStore],
    ['topics', useTopicStore],
    ['wallet', useWalletStore],
  ])('tracks the real %s store write promise', async (_name, useStore) => {
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
      .mockResolvedValueOnce()
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
    const save = jest
      .fn<Promise<void>, []>()
      .mockResolvedValueOnce()
      .mockReturnValueOnce(write.promise)
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
