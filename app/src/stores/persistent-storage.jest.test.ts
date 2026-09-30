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
  afterEach(() => {
    setManager(undefined)
    localStorage.clear()
  })

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

  it('a dismissed or denied request is not repeated on the next launches for a week', async () => {
    const persist = jest.fn(async () => false)
    setManager({ persisted: async () => false, persist })
    const now = jest.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    await usePersistentStorageStore().ensureForAccount()
    expect(persist).toHaveBeenCalledTimes(1)

    setActivePinia(createPinia())
    now.mockReturnValue(1_000_000 + 6 * 24 * 3600 * 1000)
    await usePersistentStorageStore().ensureForAccount()
    expect(persist).toHaveBeenCalledTimes(1)

    setActivePinia(createPinia())
    now.mockReturnValue(1_000_000 + 7 * 24 * 3600 * 1000)
    await usePersistentStorageStore().ensureForAccount()
    expect(persist).toHaveBeenCalledTimes(2)
    now.mockRestore()
  })

  it('a prompt that never answers still counts as asked', async () => {
    const persist = jest.fn(() => new Promise<boolean>(() => undefined))
    setManager({ persisted: async () => false, persist })
    void usePersistentStorageStore().ensureForAccount()
    await new Promise(r => setTimeout(r, 10))
    setActivePinia(createPinia())
    void usePersistentStorageStore().ensureForAccount()
    await new Promise(r => setTimeout(r, 10))
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('Settings retry ignores the weekly limit', async () => {
    const persist = jest.fn(async () => false)
    setManager({ persisted: async () => false, persist })
    const store = usePersistentStorageStore()
    await store.ensureForAccount()
    await store.request()
    expect(persist).toHaveBeenCalledTimes(2)
  })

  it('unusable localStorage never blocks or throws on launch', async () => {
    const persist = jest.fn(async () => true)
    setManager({ persisted: async () => false, persist })
    const spy = jest
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('denied')
      })
    await expect(
      usePersistentStorageStore().ensureForAccount(),
    ).resolves.toBeUndefined()
    expect(persist).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('a launch never rejects even when the browser call throws', async () => {
    setManager({
      persisted: async () => false,
      persist: async () => {
        throw new Error('SecurityError')
      },
    })
    const store = usePersistentStorageStore()
    await expect(store.ensureForAccount()).resolves.toBeUndefined()
    expect(store.status).toBe('not-granted')
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
