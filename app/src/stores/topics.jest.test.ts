/**
 * Unit tests for `stores/topics.ts` (ticket #43): verifies the store's actions call through
 * `activeChain.topics` (ticket #41's seam) with the right arguments, rather than constructing a
 * `RegistryHandler` directly. Per the ticket's own instructions, this mocks `activeChain` itself
 * (`@frank/wallet/chain`) -- not the underlying Monad wallet clients, which are #41's own,
 * already-tested layer (see `@frank/wallet/chain/monad-chain.jest.test.ts`).
 *
 * Special attention to the signed-vote-number -> `{ direction, voteWeightWei }` mapping: Lotus's
 * `RegistryHandler.addOfferings(payloadDigest, vote: number)` folded up/down direction into the
 * sign of a single number (positive => up, negative => down -- see
 * `@frank/cashweb/registry/index.ts`'s `constructBurnTransaction`). This store's own callers
 * (`TopicMessage.vue`'s up/down vote buttons) still produce that signed number, so the store
 * itself is where the conversion into `ActiveChain.topics.vote`'s separate `direction`/
 * `voteWeightWei` happens.
 */
import { setActivePinia, createPinia } from 'pinia'

import { useTopicStore } from './topics'
import { ForumMessage } from '@frank/cashweb/types/forum'
import { WalletHandle } from '@frank/wallet/chain'

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
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
    satoshis: 100_000_000,
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
      satoshis: 500,
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
      satoshis: -500,
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
    mockedFetchOne.mockResolvedValueOnce(makeMessage({ satoshis: 600 }))

    await store.addOffering({
      wallet: testWallet,
      payloadDigest: 'deadbeef',
      satoshis: 500,
      topic: 'stamp',
    })

    expect(mockedFetchOne).toHaveBeenCalledWith('deadbeef')
    expect(store.getMessage('deadbeef')?.satoshis).toBe(600)
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

    await store.refreshMessages({ wallet: testWallet, topic: 'stamp' })

    expect(store.topics['stamp'].messages).toHaveLength(0)
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
      { topic: 'general', postCount: 5, lastActivityMs: 1_000 },
      { topic: 'trading', postCount: 1, lastActivityMs: 2_000 },
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
      satoshis: 1,
      entries: [],
      payloadDigest: 'existing',
      timestamp: new Date(),
      replies: [],
    })

    mockedDiscoverTopics.mockResolvedValueOnce([
      { topic: 'stamp', postCount: 10, lastActivityMs: 999 },
    ])

    await store.refreshDiscoveredTopics()

    expect(store.topics['stamp'].messages).toHaveLength(1)
    expect(store.topics['stamp'].messages[0].payloadDigest).toBe('existing')
  })

  it('does nothing (and does not throw) when discovery returns no topics', async () => {
    const store = useTopicStore()
    store.ensureTopic('stamp')
    mockedDiscoverTopics.mockResolvedValueOnce([])

    await expect(store.refreshDiscoveredTopics()).resolves.toBeUndefined()

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
