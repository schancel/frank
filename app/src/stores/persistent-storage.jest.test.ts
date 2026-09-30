/** @jest-environment jsdom */

import { createPinia, setActivePinia } from 'pinia'

jest.mock('src/stores/wallet', () => {
  const state = { seedPhrase: null as string | null }
  return { useWalletStore: () => state, __state: state }
})
// eslint-disable-next-line @typescript-eslint/no-var-requires
const walletState = jest.requireMock('src/stores/wallet').__state

import { usePersistentStorageStore } from './persistent-storage'

function setManager(value: unknown) {
  Object.defineProperty(navigator, 'storage', { configurable: true, value })
}

describe('persistent storage store (ticket #370)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    walletState.seedPhrase = 'a seed'
  })
  afterEach(() => setManager(undefined))

  it('starts unknown', () => {
    expect(usePersistentStorageStore().status).toBe('unknown')
  })

  it('returning user, not granted yet: asks once and surfaces granted', async () => {
    const persist = jest.fn(async () => true)
    setManager({ persisted: async () => false, persist })
    const store = usePersistentStorageStore()

    await store.ensureForAccount()

    expect(persist).toHaveBeenCalledTimes(1)
    expect(store.status).toBe('granted')
  })

  it('returning user, denied: surfaces not-granted', async () => {
    setManager({ persisted: async () => false, persist: async () => false })
    const store = usePersistentStorageStore()
    await store.ensureForAccount()
    expect(store.status).toBe('not-granted')
  })

  it('already granted: does not ask again', async () => {
    const persist = jest.fn(async () => true)
    setManager({ persisted: async () => true, persist })
    const store = usePersistentStorageStore()
    await store.ensureForAccount()
    expect(persist).not.toHaveBeenCalled()
    expect(store.status).toBe('granted')
  })

  it('unsupported browser: reports unsupported and never throws', async () => {
    setManager(undefined)
    const store = usePersistentStorageStore()
    await expect(store.ensureForAccount()).resolves.toBeUndefined()
    expect(store.status).toBe('unsupported')
  })

  it('no account yet: asks nothing', async () => {
    walletState.seedPhrase = null
    const persist = jest.fn(async () => true)
    setManager({ persisted: async () => false, persist })
    const store = usePersistentStorageStore()
    await store.ensureForAccount()
    expect(persist).not.toHaveBeenCalled()
    expect(store.status).toBe('unknown')
  })

  it('request() from Settings asks again after a denial', async () => {
    const persist = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    setManager({ persisted: async () => false, persist })
    const store = usePersistentStorageStore()
    await store.request()
    expect(store.status).toBe('not-granted')
    await store.request()
    expect(store.status).toBe('granted')
  })
})
