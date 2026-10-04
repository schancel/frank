// Canonical topic store boundary and exact signed paid amounts.
import { flushPromises } from '@vue/test-utils'
import { createApp } from 'vue'
import { setActivePinia, createPinia } from 'pinia'

import { useTopicStore } from './topics'
import { ForumMessage } from '@frank/wallet/forum-model'
import { WalletHandle } from '@frank/wallet/chain'

jest.mock('src/accounts/session', () => ({
  accountStatus: { revision: 1, status: 'ready' },
}))

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    defaultTopicVoteValue: 100_000_000n,
    topics: {
      post: jest.fn(),
      vote: jest.fn(),
      fetchByTopic: jest.fn(),
      fetchOne: jest.fn(),
      discoverTopics: jest.fn(),
    },
  },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { activeChain } = jest.requireMock('@frank/wallet/chain')

const mockedPost = activeChain.topics.post as jest.Mock
const mockedVote = activeChain.topics.vote as jest.Mock
const mockedFetchByTopic = activeChain.topics.fetchByTopic as jest.Mock
const mockedFetchOne = activeChain.topics.fetchOne as jest.Mock
const mockedDiscoverTopics = activeChain.topics.discoverTopics as jest.Mock

const testWallet = {
  identity: { address: { raw: '0xabc' }, displayAddress: '0xabc' },
} as unknown as WalletHandle

// `putMessage` deliberately fires-and-forgets its own `fetchMessage` follow-up call (matching
// the pre-rewrite behavior), so tests that assert on its effect need to flush one extra
// microtask tick after `await`ing `putMessage` itself.
const flushMicrotasks = () => new Promise(resolve => setImmediate(resolve))

function makeMessage(overrides: Partial<ForumMessage> = {}): ForumMessage {
  return {
    poster: '0xposter',
    topic: 'stamp',
    voteWeightWei: '100000000',
    visibleTimestamp: { seconds: '1', nanoseconds: 0 },
    epoch: '00'.repeat(16),
    revision: '1',
    transactionHash: '11'.repeat(32),
    authorBurnTx: '0x01',
    blockNumber: '1',
    transactionIndex: '0',
    entries: [{ kind: 'post', message: 'hello' }],
    payloadDigest: 'deadbeef',
    timestamp: new Date(),
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  jest.clearAllMocks()
})

describe('useTopicStore: putMessage', () => {
  it('posts through activeChain.topics.post with an "up" direction and the topic offering as voteWeightWei', async () => {
    const store = useTopicStore()
    mockedPost.mockResolvedValueOnce({ payloadDigest: 'deadbeef' })
    mockedFetchOne.mockResolvedValueOnce(makeMessage())

    await store.putMessage({
      wallet: testWallet,
      topic: 'stamp',
      entry: { kind: 'post', message: 'hello' },
    })

    expect(mockedPost).toHaveBeenCalledWith({
      wallet: testWallet,
      topic: 'stamp',
      entries: [{ kind: 'post', message: 'hello' }],
      direction: 'up',
      voteWeightWei: BigInt(100_000_000),
      parentDigest: undefined,
    })
    // Should have fetched the freshly-posted message back through fetchOne (no wallet param).
    await flushMicrotasks()
    expect(mockedFetchOne).toHaveBeenCalledWith('deadbeef')
    expect(store.getMessage('deadbeef')?.payloadDigest).toBe('deadbeef')
  })

  it('passes parentDigest through when replying', async () => {
    const store = useTopicStore()
    mockedPost.mockResolvedValueOnce({ payloadDigest: 'reply-digest' })
    mockedFetchOne.mockResolvedValueOnce(
      makeMessage({ payloadDigest: 'reply-digest', parentDigest: 'deadbeef' }),
    )

    await store.putMessage({
      wallet: testWallet,
      topic: 'stamp',
      entry: { kind: 'post', message: 'a reply' },
      parentDigest: 'deadbeef',
    })

    expect(mockedPost).toHaveBeenCalledWith(
      expect.objectContaining({ parentDigest: 'deadbeef' }),
    )
  })
})

describe('useTopicStore: addOffering', () => {
  it('maps a positive signed vote number to direction "up" with a positive-magnitude voteWeightWei', async () => {
    const store = useTopicStore()
    mockedVote.mockResolvedValueOnce(undefined)
    mockedFetchOne.mockResolvedValueOnce(makeMessage())

    await store.addOffering({
      wallet: testWallet,
      payloadDigest: 'deadbeef',
      satoshis: 500n,
      topic: 'stamp',
    })

    expect(mockedVote).toHaveBeenCalledWith({
      wallet: testWallet,
      payloadDigest: 'deadbeef',
      direction: 'up',
      voteWeightWei: BigInt(500),
    })
  })

  it('maps a negative signed vote number to direction "down" with the absolute-value magnitude', async () => {
    const store = useTopicStore()
    mockedVote.mockResolvedValueOnce(undefined)
    mockedFetchOne.mockResolvedValueOnce(makeMessage())

    await store.addOffering({
      wallet: testWallet,
      payloadDigest: 'deadbeef',
      satoshis: -500n,
      topic: 'stamp',
    })

    expect(mockedVote).toHaveBeenCalledWith({
      wallet: testWallet,
      payloadDigest: 'deadbeef',
      direction: 'down',
      voteWeightWei: BigInt(500),
    })
  })

  it('refreshes the message via fetchOne after voting', async () => {
    const store = useTopicStore()
    mockedVote.mockResolvedValueOnce(undefined)
    mockedFetchOne.mockResolvedValueOnce(makeMessage({ voteWeightWei: '600' }))

    await store.addOffering({
      wallet: testWallet,
      payloadDigest: 'deadbeef',
      satoshis: 500n,
      topic: 'stamp',
    })

    expect(mockedFetchOne).toHaveBeenCalledWith('deadbeef')
    expect(store.getMessage('deadbeef')?.voteWeightWei).toBe('600')
  })
})

describe('useTopicStore: refreshMessages', () => {
  it('fetches by topic through activeChain.topics.fetchByTopic and stores the results', async () => {
    const store = useTopicStore()
    const message = makeMessage()
    mockedFetchByTopic.mockResolvedValueOnce([message])

    await store.refreshMessages({ wallet: testWallet, topic: 'stamp' })

    expect(mockedFetchByTopic).toHaveBeenCalledWith(
      expect.objectContaining({ wallet: testWallet, topic: 'stamp' }),
    )
    expect(store.getMessage('deadbeef')).toBeTruthy()
    expect(store.topics['stamp'].messages).toHaveLength(1)
  })

  it('does nothing if fetchByTopic returns no entries', async () => {
    const store = useTopicStore()
    mockedFetchByTopic.mockResolvedValueOnce(undefined)

    await expect(
      store.refreshMessages({ wallet: testWallet, topic: 'stamp' }),
    ).rejects.toThrow('Incomplete topic query')

    expect(store.ensureTopic('stamp').messages).toHaveLength(0)
  })
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

  it('does not clobber an already-known topic (e.g. its accumulated messages)', async () => {
    const store = useTopicStore()
    const topicState = store.ensureTopic('stamp')
    topicState.messages.push({
      poster: '0xposter',
      topic: 'stamp',
      voteWeightWei: '1',
      visibleTimestamp: { seconds: '1', nanoseconds: 0 },
      epoch: '00'.repeat(16),
      revision: '1',
      transactionHash: '11'.repeat(32),
      authorBurnTx: '0x01',
      blockNumber: '1',
      transactionIndex: '0',
      entries: [],
      payloadDigest: 'existing',
      timestamp: new Date(),
      replies: [],
    })

    mockedDiscoverTopics.mockResolvedValueOnce([
      { topic: 'stamp', postCount: '10', lastActivityMs: 999 },
    ])

    await store.refreshDiscoveredTopics()

    expect(store.topics['stamp'].messages).toHaveLength(1)
    expect(store.topics['stamp'].messages[0].payloadDigest).toBe('existing')
  })

  it('does nothing (and does not throw) when discovery returns no topics', async () => {
    const store = useTopicStore()
    store.ensureTopic('stamp')
    mockedDiscoverTopics.mockResolvedValueOnce([])

    await expect(store.refreshDiscoveredTopics()).resolves.toBe(true)

    expect(store.getTopics).toEqual(['stamp'])
  })
})

describe('useTopicStore: fetchMessage', () => {
  it('fetches a single message via activeChain.topics.fetchOne without a wallet param', async () => {
    const store = useTopicStore()
    mockedFetchOne.mockResolvedValueOnce(makeMessage())

    const result = await store.fetchMessage({
      topic: 'stamp',
      payloadDigest: 'deadbeef',
    })

    expect(mockedFetchOne).toHaveBeenCalledWith('deadbeef')
    expect(mockedFetchOne).toHaveBeenCalledTimes(1)
    expect(result?.payloadDigest).toBe('deadbeef')
  })

  it('returns undefined and logs when the message is not found', async () => {
    const store = useTopicStore()
    mockedFetchOne.mockResolvedValueOnce(undefined)

    const result = await store.fetchMessage({
      topic: 'stamp',
      payloadDigest: 'missing',
    })

    expect(result).toBeUndefined()
  })
})

it('replaces each complete topic query including author and removes absent rows', async () => {
  const store = useTopicStore()
  store.setEntries(
    'stamp',
    [makeMessage(), makeMessage({ payloadDigest: 'removed' })],
    1,
  )
  mockedFetchByTopic.mockResolvedValue([
    makeMessage({ poster: 'new author', voteWeightWei: '9007199254740993' }),
  ])
  await store.refreshMessages({ wallet: testWallet, topic: 'stamp' })
  expect(store.getMessage('removed')).toBeUndefined()
  expect(store.topics.stamp.messages).toHaveLength(1)
  expect(store.getMessage('deadbeef')).toMatchObject({
    poster: 'new author',
    voteWeightWei: '9007199254740993',
  })
  expect(() => JSON.stringify(store.$state)).not.toThrow()
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
it('cannot publish a delayed old wallet query after a new wallet starts another topic', async () => {
  const store = useTopicStore()
  let resolve!: (rows: ForumMessage[]) => void
  mockedFetchByTopic
    .mockReturnValueOnce(
      new Promise<ForumMessage[]>(yes => {
        resolve = yes
      }),
    )
    .mockResolvedValueOnce([])
  const old = store.refreshMessages({ wallet: testWallet, topic: 'stamp' })
  await flushPromises()
  const wallet = {
    identity: { address: { raw: '0xdef' } },
  } as unknown as WalletHandle
  const fresh = store.refreshMessages({ wallet, topic: 'news' })
  resolve([makeMessage()])
  await old
  await fresh
  expect(store.getMessage('deadbeef')).toBeUndefined()
})

it('excludes old persisted observations and number inputs through actual restore', async () => {
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
  const restored = await storageOptions!.restore({
    get: async () =>
      JSON.stringify({
        topics: [
          { topic: 'stamp', offering: 5, threshold: 1, messages: ['old'] },
        ],
        messageIndex: { old: { satoshis: 7 } },
      }),
  })
  expect(restored).toMatchObject({
    messageIndex: {},
    topics: { stamp: { messages: [], threshold: '0', offering: '100000000' } },
    discoveryStatus: 'unverified',
  })
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

it('shares discovery authority across fresh action proxies and explicit invalidation', async () => {
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
  mockedDiscoverTopics.mockReturnValueOnce(
    new Promise<[]>(yes => {
      resolve = yes
    }),
  )
  const invalidated = store.refreshDiscoveredTopics.call(new Proxy(store, {}))
  await flushPromises()
  store.invalidateRefresh.call(new Proxy(store, {}))
  resolve([])
  expect(await invalidated).toBeUndefined()
  expect(mockedDiscoverTopics).toHaveBeenCalledTimes(3)
})

it('keeps only latest same-view authority across distinct action proxies', async () => {
  const store = useTopicStore()
  let resolve!: (row: ForumMessage) => void
  mockedFetchOne
    .mockReturnValueOnce(
      new Promise<ForumMessage>(yes => {
        resolve = yes
      }),
    )
    .mockResolvedValueOnce(makeMessage({ poster: 'new proxy' }))
  const old = store.fetchMessage.call(new Proxy(store, {}), {
    topic: 'stamp',
    payloadDigest: 'deadbeef',
  })
  await flushPromises()
  const fresh = store.fetchMessage.call(new Proxy(store, {}), {
    topic: 'stamp',
    payloadDigest: 'deadbeef',
  })
  resolve(makeMessage({ poster: 'old proxy' }))
  await old
  await fresh
  expect(mockedFetchOne).toHaveBeenCalledTimes(2)
  expect(store.getMessage('deadbeef')?.poster).toBe('new proxy')
})
