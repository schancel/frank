// Canonical topic store boundary and exact signed paid amounts.
import { flushPromises } from '@vue/test-utils'
import { createApp } from 'vue'
import { setActivePinia, createPinia } from 'pinia'

import { useTopicStore } from './topics'

jest.mock('src/accounts/session', () => ({
  accountStatus: { revision: 1, status: 'ready' },
}))

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    topics: {
      discoverTopics: jest.fn(),
    },
  },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { activeChain } = jest.requireMock('@frank/wallet/chain')

const mockedDiscoverTopics = activeChain.topics.discoverTopics as jest.Mock

beforeEach(() => {
  setActivePinia(createPinia())
  jest.clearAllMocks()
})

describe('useTopicStore: refreshDiscoveredTopics', () => {
  it('merges discovered topics into state.topics alongside the hardcoded defaults', async () => {
    const store = useTopicStore()
    // Simulate the hardcoded `defaultTopics` seed (normally hydrated by `storage.restore`):
    // `refreshDiscoveredTopics` must not remove or replace these.
    store.ensureTopic('stamp')
    store.ensureTopic('news')

    mockedDiscoverTopics.mockResolvedValueOnce([
      { topic: 'general', postCount: '5', lastActivityMs: 1_000 },
      { topic: 'trading', postCount: '1', lastActivityMs: 2_000 },
    ])

    await store.refreshDiscoveredTopics()

    expect(mockedDiscoverTopics).toHaveBeenCalledWith()
    // Hardcoded defaults are still present.
    expect(store.getTopics).toEqual(
      expect.arrayContaining(['stamp', 'news', 'general', 'trading']),
    )
  })

  it('keeps an already-known topic as it is', async () => {
    const store = useTopicStore()
    const known = store.ensureTopic('stamp')
    mockedDiscoverTopics.mockResolvedValueOnce([
      { topic: 'stamp', postCount: '10', lastActivityMs: 999 },
    ])

    await store.refreshDiscoveredTopics()

    expect(store.topics['stamp']).toEqual(known)
  })

  it('does nothing (and does not throw) when discovery returns no topics', async () => {
    const store = useTopicStore()
    store.ensureTopic('stamp')
    mockedDiscoverTopics.mockResolvedValueOnce([])

    await expect(store.refreshDiscoveredTopics()).resolves.toBe(true)

    expect(store.getTopics).toEqual(['stamp'])
  })
})

it('distinguishes failed discovery from verified empty without adding topics', async () => {
  const store = useTopicStore()
  mockedDiscoverTopics.mockRejectedValueOnce(new Error('continuation lost'))
  expect(await store.refreshDiscoveredTopics()).toBe(false)
  expect(store.discoveryStatus).toBe('error')
  expect(store.discoveryError).toBe('continuation lost')
  expect(store.getTopics).toEqual([])
  mockedDiscoverTopics.mockResolvedValueOnce([])
  expect(await store.refreshDiscoveredTopics()).toBe(true)
  expect(store.discoveryStatus).toBe('verified')
  expect(store.discoveryError).toBeNull()
})
function topicStorage() {
  let storageOptions:
    | {
        save(storage: unknown, mutation: unknown, state: unknown): Promise<void>
        restore(storage: unknown): Promise<unknown>
      }
    | undefined
  const pinia = createPinia()
  pinia.use(({ options }) => {
    storageOptions = options.storage as typeof storageOptions
  })
  createApp({}).use(pinia)
  setActivePinia(pinia)
  const store = useTopicStore()
  return { store, storage: storageOptions! }
}

it('saves the topic names and restores them with the default topics', async () => {
  const { store, storage } = topicStorage()
  store.ensureTopic('mine')
  let saved = ''
  await storage.save(
    {
      put: async (_key: string, value: string) => {
        saved = value
      },
    },
    undefined,
    store.$state,
  )
  expect(JSON.parse(saved)).toEqual({ topics: [{ topic: 'mine' }] })
  const restored = (await storage.restore({ get: async () => saved })) as {
    topics: Record<string, { topic: string }>
    discoveryStatus: string
  }
  expect(restored.topics.mine).toEqual({ topic: 'mine' })
  expect(restored.topics.stamp).toEqual({ topic: 'stamp' })
  expect(restored.discoveryStatus).toBe('unverified')
})

it('restores only the names of saved topics, nothing else they carried', async () => {
  const { storage } = topicStorage()
  const restored = (await storage.restore({
    get: async () =>
      JSON.stringify({
        topics: [
          { topic: 'old', offering: 5, threshold: 1, messages: ['digest'] },
          { offering: 5 },
        ],
        messageIndex: { digest: { satoshis: 7 } },
      }),
  })) as Record<string, unknown> & { topics: Record<string, unknown> }
  expect(restored.topics.old).toEqual({ topic: 'old' })
  expect(Object.keys(restored)).not.toContain('messageIndex')
})

it('rejects restore on a storage read error or unparseable topics record', async () => {
  let storageOptions:
    | { restore(storage: unknown): Promise<unknown> }
    | undefined
  const pinia = createPinia()
  pinia.use(({ options }) => {
    storageOptions = options.storage as typeof storageOptions
  })
  createApp({}).use(pinia)
  setActivePinia(pinia)
  useTopicStore()
  const failure = new Error('IO unavailable')
  await expect(
    storageOptions!.restore({
      get: async () => {
        throw failure
      },
    }),
  ).rejects.toBe(failure)
  await expect(
    storageOptions!.restore({ get: async () => '{corrupt' }),
  ).rejects.toBeInstanceOf(SyntaxError)
  const fresh = (await storageOptions!.restore({
    get: async () => {
      throw Object.assign(new Error('not found'), { notFound: true })
    },
  })) as { topics: Record<string, unknown> }
  expect(Object.keys(fresh.topics).length).toBeGreaterThan(0)
})

it('retains the exact canonical u64-max discovery count and metadata', async () => {
  const store = useTopicStore()
  const row = {
    topic: 'news',
    postCount: '18446744073709551615',
    lastActivityMs: 1000,
    lastActivity: { seconds: '1', nanoseconds: 0 },
    epoch: '00'.repeat(16),
    revision: '18446744073709551615',
  }
  mockedDiscoverTopics.mockResolvedValueOnce([row])
  expect(await store.refreshDiscoveredTopics()).toBe(true)
  expect(store.discoveredTopics.news).toEqual(row)
  expect(
    JSON.parse(JSON.stringify(store.$state)).discoveredTopics.news.postCount,
  ).toBe('18446744073709551615')
  mockedDiscoverTopics.mockResolvedValueOnce([])
  await store.refreshDiscoveredTopics()
  expect(store.discoveredTopics).toEqual({})
})
it.each(['18446744073709551616', '01', 9007199254740992])(
  'rejects a noncanonical discovery count %s before publication',
  async postCount => {
    const store = useTopicStore()
    mockedDiscoverTopics.mockResolvedValueOnce([{ topic: 'news', postCount }])
    expect(await store.refreshDiscoveredTopics()).toBe(false)
    expect(store.discoveryStatus).toBe('error')
    expect(store.discoveredTopics).toEqual({})
  },
)

it('shares discovery authority across fresh action proxies', async () => {
  const store = useTopicStore()
  let resolve!: (rows: []) => void
  mockedDiscoverTopics
    .mockReturnValueOnce(
      new Promise<[]>(yes => {
        resolve = yes
      }),
    )
    .mockResolvedValueOnce([])
  const old = store.refreshDiscoveredTopics.call(new Proxy(store, {}))
  await flushPromises()
  const fresh = store.refreshDiscoveredTopics.call(new Proxy(store, {}))
  resolve([])
  await old
  await fresh
  expect(mockedDiscoverTopics).toHaveBeenCalledTimes(2)
  expect(store.discoveryStatus).toBe('verified')
})
