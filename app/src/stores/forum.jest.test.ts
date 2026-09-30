/**
 * Unit tests for `stores/forum.ts` (ticket #43) -- see `stores/topics.jest.test.ts`'s header for
 * the shared rationale (mocking `activeChain`, not the underlying Monad clients; the
 * signed-vote-number -> `{ direction, voteWeightWei }` mapping this store's own callers
 * (`ForumMessage.vue`/`ForumPost.vue`'s up/down vote buttons, `CreatePost.vue`'s offering field)
 * still produce as a single signed `satoshis` number).
 */
import { setActivePinia, createPinia } from 'pinia'

import { useForumStore } from './forum'
import { ForumMessage } from '@frank/cashweb/types/forum'
import { WalletHandle } from '@frank/wallet/chain'
import { sortPostsByMode } from 'src/utils/sorting'

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    topics: {
      post: jest.fn(),
      vote: jest.fn(),
      fetchByTopic: jest.fn(),
      fetchOne: jest.fn(),
    },
  },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { activeChain } = jest.requireMock('@frank/wallet/chain')

const mockedPost = activeChain.topics.post as jest.Mock
const mockedVote = activeChain.topics.vote as jest.Mock
const mockedFetchByTopic = activeChain.topics.fetchByTopic as jest.Mock
const mockedFetchOne = activeChain.topics.fetchOne as jest.Mock

const testWallet = {
  identity: { address: { raw: '0xabc' }, displayAddress: '0xabc' },
} as unknown as WalletHandle

function makeMessage(overrides: Partial<ForumMessage> = {}): ForumMessage {
  return {
    poster: '0xposter',
    topic: 'stamp',
    satoshis: 10_000_000,
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

describe('useForumStore: putMessage', () => {
  it('posts through activeChain.topics.post, mapping a positive satoshis offering to direction "up"', async () => {
    const store = useForumStore()
    mockedPost.mockResolvedValueOnce({ payloadDigest: 'deadbeef' })
    mockedFetchOne.mockResolvedValueOnce(makeMessage())

    await store.putMessage({
      wallet: testWallet,
      entry: { kind: 'post', message: 'hello' },
      satoshis: 10_000_000,
      topic: 'stamp',
    })

    expect(mockedPost).toHaveBeenCalledWith({
      wallet: testWallet,
      topic: 'stamp',
      entries: [{ kind: 'post', message: 'hello' }],
      direction: 'up',
      voteWeightWei: BigInt(10_000_000),
      parentDigest: undefined,
    })
    expect(mockedFetchOne).toHaveBeenCalledWith('deadbeef')
  })
})

describe('useForumStore: putMessage preparation progress (ticket #273)', () => {
  it("hands the caller's progress callback to activeChain.topics.post", async () => {
    const store = useForumStore()
    mockedPost.mockResolvedValueOnce({ payloadDigest: 'deadbeef' })
    mockedFetchOne.mockResolvedValueOnce(makeMessage())
    const onPreparationProgress = jest.fn()

    await store.putMessage({
      wallet: testWallet,
      entry: { kind: 'post', message: 'hello' },
      satoshis: 10_000_000,
      topic: 'stamp',
      onPreparationProgress,
    })

    expect(mockedPost.mock.calls[0][0].onPreparationProgress).toBe(
      onPreparationProgress,
    )
  })
})

describe('useForumStore: addOffering', () => {
  it('maps a positive signed vote number to direction "up"', async () => {
    const store = useForumStore()
    mockedVote.mockResolvedValueOnce(undefined)
    mockedFetchOne.mockResolvedValueOnce(makeMessage())

    await store.addOffering({
      wallet: testWallet,
      payloadDigest: 'deadbeef',
      satoshis: 250,
    })

    expect(mockedVote).toHaveBeenCalledWith({
      wallet: testWallet,
      payloadDigest: 'deadbeef',
      direction: 'up',
      voteWeightWei: BigInt(250),
    })
  })

  it('maps a negative signed vote number to direction "down" with the absolute-value magnitude', async () => {
    const store = useForumStore()
    mockedVote.mockResolvedValueOnce(undefined)
    mockedFetchOne.mockResolvedValueOnce(makeMessage())

    await store.addOffering({
      wallet: testWallet,
      payloadDigest: 'deadbeef',
      satoshis: -250,
    })

    expect(mockedVote).toHaveBeenCalledWith({
      wallet: testWallet,
      payloadDigest: 'deadbeef',
      direction: 'down',
      voteWeightWei: BigInt(250),
    })
  })
})

describe('useForumStore: refreshMessages', () => {
  it('fetches all topics (empty topic filter) through activeChain.topics.fetchByTopic', async () => {
    const store = useForumStore()
    const message = makeMessage()
    mockedFetchByTopic.mockResolvedValueOnce([message])

    await store.refreshMessages({ wallet: testWallet, topic: 'ignored' })

    expect(mockedFetchByTopic).toHaveBeenCalledWith(
      expect.objectContaining({ wallet: testWallet, topic: '' }),
    )
    expect(store.getMessage('deadbeef')).toBeTruthy()
  })

  it('does nothing if fetchByTopic returns no entries', async () => {
    const store = useForumStore()
    mockedFetchByTopic.mockResolvedValueOnce(undefined)

    await store.refreshMessages({ wallet: testWallet, topic: 'ignored' })

    expect(store.messages).toHaveLength(0)
  })

  it('updates an existing digest in every lookup without duplicating it', async () => {
    const store = useForumStore()
    const initial = makeMessage({ satoshis: 10 })
    const updated = makeMessage({
      poster: '0xdifferent-poster',
      topic: 'different-topic',
      satoshis: 25,
      entries: [{ kind: 'post', message: 'different content' }],
      timestamp: new Date('2030-01-01T00:00:00.000Z'),
    })
    mockedFetchByTopic
      .mockResolvedValueOnce([initial])
      .mockResolvedValueOnce([updated])
      .mockResolvedValueOnce([updated])

    await store.refreshMessages({ wallet: testWallet, topic: 'ignored' })
    const canonicalMessage = store.messages[0]
    await store.refreshMessages({ wallet: testWallet, topic: 'ignored' })
    await store.refreshMessages({ wallet: testWallet, topic: 'ignored' })

    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]).toBe(canonicalMessage)
    expect(store.messages[0].satoshis).toBe(25)
    expect(store.messages[0]).toMatchObject({
      poster: initial.poster,
      topic: initial.topic,
      entries: initial.entries,
      timestamp: initial.timestamp,
    })
    expect(store.index.deadbeef).toBe(canonicalMessage)
    expect(store.getMessage('deadbeef')?.satoshis).toBe(25)
    expect(
      store.messages.filter(message => message.payloadDigest === 'deadbeef'),
    ).toHaveLength(1)
  })

  it('makes refreshed satoshis available to hot/top ordering and threshold filtering', async () => {
    const store = useForumStore()
    const timestamp = new Date('2026-01-01T00:00:00.000Z')
    const refreshed = makeMessage({ satoshis: 10, timestamp })
    const comparison = makeMessage({
      payloadDigest: 'comparison',
      satoshis: 20,
      timestamp,
    })
    mockedFetchByTopic
      .mockResolvedValueOnce([refreshed, comparison])
      .mockResolvedValueOnce([{ ...refreshed, satoshis: 25 }, comparison])

    await store.refreshMessages({ wallet: testWallet, topic: 'ignored' })
    expect(sortPostsByMode(store.messages, 'hot')[0].payloadDigest).toBe(
      'comparison',
    )
    expect(sortPostsByMode(store.messages, 'top')[0].payloadDigest).toBe(
      'comparison',
    )
    expect(store.messages.filter(message => message.satoshis >= 15)).toEqual([
      expect.objectContaining({ payloadDigest: 'comparison' }),
    ])

    await store.refreshMessages({ wallet: testWallet, topic: 'ignored' })

    expect(sortPostsByMode(store.messages, 'hot')[0].payloadDigest).toBe(
      'deadbeef',
    )
    expect(sortPostsByMode(store.messages, 'top')[0].payloadDigest).toBe(
      'deadbeef',
    )
    expect(
      store.messages
        .filter(message => message.satoshis >= 15)
        .map(message => message.payloadDigest),
    ).toEqual(['deadbeef', 'comparison'])
  })
})

describe('useForumStore: setEntries', () => {
  it('deduplicates restored rows before refreshing and relinking canonical messages', () => {
    const parent = makeMessage({ payloadDigest: 'parent', satoshis: 10 })
    const child = makeMessage({
      payloadDigest: 'child',
      parentDigest: parent.payloadDigest,
      satoshis: 15,
    })
    const restoredStore = useForumStore()
    restoredStore.$patch(
      JSON.parse(
        JSON.stringify({
          messages: [
            {
              ...parent,
              replies: [
                { ...child, replies: [] },
                { ...child, replies: [] },
              ],
            },
            { ...parent, satoshis: 11, replies: [] },
            { ...child, replies: [] },
            { ...child, satoshis: 16, replies: [] },
          ],
          index: {
            parent: { ...parent, satoshis: 11, replies: [] },
            child: { ...child, satoshis: 16, replies: [] },
          },
        }),
      ),
    )
    const canonicalParent = restoredStore.messages[0]
    const canonicalChild = restoredStore.messages[2]

    restoredStore.setEntries([
      { ...parent, satoshis: 25 },
      { ...child, satoshis: 30 },
    ])

    expect(
      restoredStore.messages.map(message => message.payloadDigest),
    ).toEqual(['parent', 'child'])
    expect(restoredStore.messages[0]).toBe(canonicalParent)
    expect(restoredStore.messages[1]).toBe(canonicalChild)
    expect(canonicalParent.satoshis).toBe(25)
    expect(canonicalChild.satoshis).toBe(30)
    expect(restoredStore.index.parent).toBe(canonicalParent)
    expect(restoredStore.index.child).toBe(canonicalChild)
    expect(canonicalParent.replies).toHaveLength(1)
    expect(canonicalParent.replies[0]).toBe(canonicalChild)
  })

  it('does not restore cyclic reply graphs and keeps valid reply links serializable', () => {
    const selfParent = makeMessage({
      payloadDigest: 'self-parent',
      parentDigest: 'self-parent',
    })
    const cycleA = makeMessage({
      payloadDigest: 'cycle-a',
      parentDigest: 'cycle-b',
    })
    const cycleB = makeMessage({
      payloadDigest: 'cycle-b',
      parentDigest: 'cycle-a',
    })
    const cycleDescendant = makeMessage({
      payloadDigest: 'cycle-descendant',
      parentDigest: 'cycle-a',
    })
    const validParent = makeMessage({ payloadDigest: 'valid-parent' })
    const validChild = makeMessage({
      payloadDigest: 'valid-child',
      parentDigest: 'valid-parent',
    })
    const restoredStore = useForumStore()
    restoredStore.$patch(
      JSON.parse(
        JSON.stringify({
          messages: [
            selfParent,
            cycleA,
            cycleB,
            cycleDescendant,
            validParent,
            validChild,
          ].map(message => ({ ...message, replies: [] })),
          index: {},
        }),
      ),
    )

    restoredStore.setEntries([])

    expect(restoredStore.index['self-parent']?.replies).toEqual([])
    expect(restoredStore.index['cycle-a']?.replies).toEqual([])
    expect(restoredStore.index['cycle-b']?.replies).toEqual([])
    expect(restoredStore.index['cycle-descendant']?.replies).toEqual([])
    expect(restoredStore.index['valid-parent']?.replies).toHaveLength(1)
    expect(restoredStore.index['valid-parent']?.replies[0]).toBe(
      restoredStore.index['valid-child'],
    )
    expect(() => JSON.stringify(restoredStore.$state)).not.toThrow()
  })
})

describe('useForumStore: fetchMessage', () => {
  it('fetches a single message via activeChain.topics.fetchOne without a wallet param', async () => {
    const store = useForumStore()
    mockedFetchOne.mockResolvedValueOnce(makeMessage())

    const result = await store.fetchMessage({ payloadDigest: 'deadbeef' })

    expect(mockedFetchOne).toHaveBeenCalledWith('deadbeef')
    expect(mockedFetchOne).toHaveBeenCalledTimes(1)
    expect(result?.payloadDigest).toBe('deadbeef')
  })

  it('returns undefined when the message is not found', async () => {
    const store = useForumStore()
    mockedFetchOne.mockResolvedValueOnce(undefined)

    const result = await store.fetchMessage({ payloadDigest: 'missing' })

    expect(result).toBeUndefined()
  })
})
