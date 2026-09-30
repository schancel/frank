import {
  queryPersistentStorage,
  requestPersistentStorage,
  requestPersistentStorageWithin,
} from './persistent-storage'

const manager = (persisted: unknown, persist: unknown) => ({
  persisted: jest.fn(async () => persisted),
  persist: jest.fn(async () => persist),
})

describe('requestPersistentStorage', () => {
  it('granted: asks the browser and reports granted', async () => {
    const m = manager(false, true)
    expect(await requestPersistentStorage(m as never)).toBe('granted')
    expect(m.persist).toHaveBeenCalledTimes(1)
  })

  it('already granted: does not ask again', async () => {
    const m = manager(true, false)
    expect(await requestPersistentStorage(m as never)).toBe('granted')
    expect(m.persist).not.toHaveBeenCalled()
  })

  it('denied: reports not-granted (a "no" is not an error)', async () => {
    const m = manager(false, false)
    expect(await requestPersistentStorage(m as never)).toBe('not-granted')
  })

  it.each([
    ['no storage manager at all', undefined],
    ['a manager without persist()', { persisted: async () => false }],
    ['an empty manager', {}],
  ])('unsupported: %s', async (_name, m) => {
    expect(await requestPersistentStorage(m as never)).toBe('unsupported')
  })

  it('a rejecting persist() is reported as not-granted, never thrown', async () => {
    const m = {
      persisted: async () => false,
      persist: async () => {
        throw new Error('SecurityError')
      },
    }
    expect(await requestPersistentStorage(m as never)).toBe('not-granted')
  })

  it('works when only persist() exists (no persisted())', async () => {
    const m = { persist: jest.fn(async () => true) }
    expect(await requestPersistentStorage(m as never)).toBe('granted')
  })

  it('reads navigator.storage by default', async () => {
    const persist = jest.fn(async () => true)
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persisted: async () => false, persist },
    })
    try {
      expect(await requestPersistentStorage()).toBe('granted')
      expect(persist).toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: undefined,
      })
    }
  })
})

describe('queryPersistentStorage', () => {
  it('reports granted / not-granted without ever prompting', async () => {
    const yes = manager(true, false)
    const no = manager(false, true)
    expect(await queryPersistentStorage(yes as never)).toBe('granted')
    expect(await queryPersistentStorage(no as never)).toBe('not-granted')
    expect(yes.persist).not.toHaveBeenCalled()
    expect(no.persist).not.toHaveBeenCalled()
  })

  it('unsupported without persisted()', async () => {
    expect(await queryPersistentStorage(undefined as never)).toBe('unsupported')
    expect(
      await queryPersistentStorage({ persist: async () => true } as never),
    ).toBe('unsupported')
  })

  it('a rejecting persisted() is not-granted', async () => {
    const m = {
      persisted: async () => {
        throw new Error('boom')
      },
    }
    expect(await queryPersistentStorage(m as never)).toBe('not-granted')
  })
})

describe('requestPersistentStorageWithin', () => {
  beforeEach(() =>
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    }),
  )
  afterEach(() => jest.useRealTimers())

  it('gives up with "unknown" when the browser never answers (open permission prompt)', async () => {
    const m = {
      persisted: async () => false,
      persist: () => new Promise<boolean>(() => undefined),
    }
    const result = requestPersistentStorageWithin(3000, m as never)
    await jest.advanceTimersByTimeAsync(3000)
    expect(await result).toBe('unknown')
  })

  it('returns the real answer when it arrives in time, and clears its timer', async () => {
    const m = manager(false, true)
    expect(await requestPersistentStorageWithin(3000, m as never)).toBe(
      'granted',
    )
    expect(jest.getTimerCount()).toBe(0)
  })
})
