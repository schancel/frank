/** @jest-environment jsdom */
/**
 * Unit tests for `stores/forum.ts` (ticket #43) -- see `stores/topics.jest.test.ts`'s header for
 * the shared rationale (mocking `activeChain`, not the underlying Monad clients; the
 * signed-vote-number -> `{ direction, voteWeightWei }` mapping this store's own callers
 * (`ForumMessage.vue`/`ForumPost.vue`'s up/down vote buttons, `CreatePost.vue`'s offering field)
 * still produce as a single signed `satoshis` number).
 */
import { BurnRefreshError } from 'src/utils/burn-refresh-error'
import { setActivePinia, createPinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, nextTick } from 'vue'

import { MessageWithReplies, useForumStore } from './forum'
import { ForumMessage } from '@frank/cashweb/types/forum'
import { WalletHandle } from '@frank/wallet/chain'
import { TopicPostOutcomeUnknownError } from '@frank/wallet/chain/active-chain'
import { sortPostsByMode } from 'src/utils/sorting'

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
  mockedDiscoverTopics.mockResolvedValue([])
})

describe('useForumStore: session post reservations', () => {
  it('starts in-flight and can be marked outcome-unknown only by its own reservation id', () => {
    const store = useForumStore()
    const reservationId = store.reservePostSubmission({
      wallet: testWallet,
      destination: 'reply:parent',
    })
    expect(reservationId).toEqual(expect.any(Number))
    expect(
      store.getPostReservationStatus({
        wallet: testWallet,
        destination: 'reply:parent',
      }),
    ).toBe('in-flight')

    expect(
      store.markPostSubmissionOutcomeUnknown({
        wallet: testWallet,
        destination: 'reply:parent',
        reservationId: (reservationId as number) + 1,
      }),
    ).toBe(false)
    expect(
      store.getPostReservationStatus({
        wallet: testWallet,
        destination: 'reply:parent',
      }),
    ).toBe('in-flight')

    expect(
      store.markPostSubmissionOutcomeUnknown({
        wallet: testWallet,
        destination: 'reply:parent',
        reservationId: reservationId as number,
      }),
    ).toBe(true)
    expect(
      store.getPostReservationStatus({
        wallet: testWallet,
        destination: 'reply:parent',
      }),
    ).toBe('outcome-unknown')
    // Release: the module-scope reservation map is process-lifetime, and later tests in this
    // file must be able to reserve the same destination again.
    expect(
      store.releasePostSubmission({
        wallet: testWallet,
        destination: 'reply:parent',
        reservationId: reservationId as number,
      }),
    ).toBe(true)
  })

  it('reports no status once the reservation is released', () => {
    const store = useForumStore()
    const reservationId = store.reservePostSubmission({
      wallet: testWallet,
      destination: 'top-level',
    })
    store.markPostSubmissionOutcomeUnknown({
      wallet: testWallet,
      destination: 'top-level',
      reservationId: reservationId as number,
    })
    expect(
      store.releasePostSubmission({
        wallet: testWallet,
        destination: 'top-level',
        reservationId: reservationId as number,
      }),
    ).toBe(true)
    expect(
      store.getPostReservationStatus({
        wallet: testWallet,
        destination: 'top-level',
      }),
    ).toBeUndefined()
  })

  it('survives a Pinia remount and treats rebuilt handles for one identity as one owner', () => {
    const firstStore = useForumStore()
    const rebuiltWallet = {
      identity: {
        address: { raw: '0xAbC' },
        displayAddress: '0xAbC',
      },
    } as unknown as WalletHandle
    const reservationId = firstStore.reservePostSubmission({
      wallet: testWallet,
      destination: 'reply:parent',
    })

    expect(reservationId).toEqual(expect.any(Number))
    setActivePinia(createPinia())
    const remountedStore = useForumStore()
    expect(
      remountedStore.getPostReservationId({
        wallet: rebuiltWallet,
        destination: 'reply:parent',
      }),
    ).toBe(reservationId)
    expect(
      remountedStore.reservePostSubmission({
        wallet: rebuiltWallet,
        destination: 'reply:parent',
      }),
    ).toBeUndefined()
    expect(
      remountedStore.releasePostSubmission({
        wallet: rebuiltWallet,
        destination: 'reply:parent',
        reservationId: (reservationId as number) + 1,
      }),
    ).toBe(false)
    expect(
      remountedStore.releasePostSubmission({
        wallet: rebuiltWallet,
        destination: 'reply:parent',
        reservationId: reservationId as number,
      }),
    ).toBe(true)
  })

  it('allows distinct wallets at one destination and keeps release scoped to wallet plus request', () => {
    const store = useForumStore()
    const otherWallet = {
      identity: {
        address: { raw: '0xdef' },
        displayAddress: '0xdef',
      },
    } as unknown as WalletHandle
    const first = store.reservePostSubmission({
      wallet: testWallet,
      destination: 'reply:parent',
    })
    const second = store.reservePostSubmission({
      wallet: otherWallet,
      destination: 'reply:parent',
    })

    expect(first).toEqual(expect.any(Number))
    expect(second).toEqual(expect.any(Number))
    expect(second).not.toBe(first)
    expect(
      store.getPostReservationId({
        wallet: testWallet,
        destination: 'reply:parent',
      }),
    ).toBe(first)
    expect(
      store.getPostReservationId({
        wallet: otherWallet,
        destination: 'reply:parent',
      }),
    ).toBe(second)

    expect(
      store.releasePostSubmission({
        wallet: otherWallet,
        destination: 'reply:parent',
        reservationId: first as number,
      }),
    ).toBe(false)
    expect(
      store.releasePostSubmission({
        wallet: testWallet,
        destination: 'reply:parent',
        reservationId: first as number,
      }),
    ).toBe(true)
    expect(
      store.getPostReservationId({
        wallet: otherWallet,
        destination: 'reply:parent',
      }),
    ).toBe(second)
    expect(
      store.releasePostSubmission({
        wallet: otherWallet,
        destination: 'reply:parent',
        reservationId: second as number,
      }),
    ).toBe(true)
  })

  it('reactively exposes a real reservation across mounted component instances', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useForumStore()
    const Probe = defineComponent({
      setup() {
        const reservationId = computed(() =>
          useForumStore().getPostReservationId({
            wallet: testWallet,
            destination: 'reply:parent',
          }),
        )
        return () => h('div', reservationId.value ?? 'idle')
      },
    })
    const first = mount(Probe, { global: { plugins: [pinia] } })
    expect(first.text()).toBe('idle')

    const reservationId = store.reservePostSubmission({
      wallet: testWallet,
      destination: 'reply:parent',
    })
    await nextTick()
    expect(first.text()).toBe(String(reservationId))

    first.unmount()
    const remounted = mount(Probe, { global: { plugins: [pinia] } })
    expect(remounted.text()).toBe(String(reservationId))

    store.releasePostSubmission({
      wallet: testWallet,
      destination: 'reply:parent',
      reservationId: reservationId as number,
    })
    await nextTick()
    expect(remounted.text()).toBe('idle')
  })
})

describe('useForumStore: own indexed messages', () => {
  it('rejects an otherwise valid message stored under an empty digest', () => {
    const store = useForumStore()
    store.index[''] = {
      ...makeMessage({ payloadDigest: '' }),
      replies: [],
    }

    expect(store.getMessage('')).toBeNull()
  })

  it('rejects an otherwise valid inherited message', () => {
    const store = useForumStore()
    Object.setPrototypeOf(store.index, {
      inherited: {
        ...makeMessage({ payloadDigest: 'inherited' }),
        replies: [],
      },
    })

    expect(store.getMessage('inherited')).toBeNull()
  })

  it.each([null, undefined])(
    'rejects the falsy own indexed value %s',
    value => {
      const store = useForumStore()
      store.index.candidate = value as unknown as MessageWithReplies

      expect(store.getMessage('candidate')).toBeNull()
    },
  )

  it.each(['__proto__', 'constructor', 'toString'])(
    'does not resolve inherited key %s as a forum parent',
    key => {
      const store = useForumStore()

      expect(store.getMessage(key)).toBeNull()
    },
  )

  it('rejects an own property that is not an indexed ForumMessage', () => {
    const store = useForumStore()
    Object.defineProperty(store.index, 'constructor', {
      configurable: true,
      enumerable: true,
      value: { topic: 'attacker-controlled' },
    })

    expect(store.getMessage('constructor')).toBeNull()
  })

  it('rejects an otherwise valid indexed message whose payload digest does not match its key', () => {
    const store = useForumStore()
    store.index.candidate = {
      ...makeMessage({ payloadDigest: 'different' }),
      replies: [],
    }

    expect(store.getMessage('candidate')).toBeNull()
  })

  it('rejects an otherwise valid indexed message whose topic is not a string', () => {
    const store = useForumStore()
    store.index.candidate = {
      ...makeMessage({ payloadDigest: 'candidate' }),
      topic: null,
      replies: [],
    } as unknown as MessageWithReplies

    expect(store.getMessage('candidate')).toBeNull()
  })

  it('rejects an otherwise valid indexed message whose entries are not an array', () => {
    const store = useForumStore()
    store.index.candidate = {
      ...makeMessage({ payloadDigest: 'candidate' }),
      entries: {},
      replies: [],
    } as unknown as MessageWithReplies

    expect(store.getMessage('candidate')).toBeNull()
  })
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

describe('useForumStore: read-back failure after a landed burn (review F3)', () => {
  it('a vote whose burn was sent but whose read-back throws rejects with BurnRefreshError, after exactly one burn', async () => {
    const store = useForumStore()
    mockedVote.mockResolvedValueOnce(undefined)
    mockedFetchOne.mockRejectedValueOnce(new Error('relay read failed'))

    await expect(
      store.addOffering({
        wallet: testWallet,
        payloadDigest: 'deadbeef',
        satoshis: 250,
      }),
    ).rejects.toMatchObject({ name: 'BurnRefreshError', kind: 'vote' })
    expect(mockedVote).toHaveBeenCalledTimes(1)
  })

  it('a post whose burn was sent but whose read-back throws rejects with BurnRefreshError', async () => {
    const store = useForumStore()
    mockedPost.mockResolvedValueOnce({ payloadDigest: 'deadbeef' })
    mockedFetchOne.mockRejectedValueOnce(new Error('relay read failed'))

    await expect(
      store.putMessage({
        wallet: testWallet,
        entry: { kind: 'post', message: 'hello' },
        satoshis: 10_000_000,
        topic: 'stamp',
      }),
    ).rejects.toMatchObject({ name: 'BurnRefreshError', kind: 'post' })
    expect(mockedPost).toHaveBeenCalledTimes(1)
  })

  it('a failed burn is NOT wrapped: it stays the original error', async () => {
    const store = useForumStore()
    mockedVote.mockRejectedValueOnce(new Error('Nothing was sent'))
    await expect(
      store.addOffering({
        wallet: testWallet,
        payloadDigest: 'deadbeef',
        satoshis: 250,
      }),
    ).rejects.toThrow('Nothing was sent')
    expect(mockedFetchOne).not.toHaveBeenCalled()
    const failure = await store
      .addOffering({
        wallet: testWallet,
        payloadDigest: 'deadbeef',
        satoshis: 250,
      })
      .catch((e: unknown) => e)
    expect(failure).not.toBeInstanceOf(BurnRefreshError)
  })

  it('a failed post burn is NOT wrapped either', async () => {
    const store = useForumStore()
    mockedPost.mockRejectedValueOnce(new Error('Nothing was sent'))
    const failure = await store
      .putMessage({
        wallet: testWallet,
        entry: { kind: 'post', message: 'hello' },
        satoshis: 10_000_000,
        topic: 'stamp',
      })
      .catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(BurnRefreshError)
    expect(mockedFetchOne).not.toHaveBeenCalled()
  })

  it('preserves a typed unknown post outcome without attempting read-back', async () => {
    const store = useForumStore()
    const unknownOutcome = new TopicPostOutcomeUnknownError(
      'The paid post outcome is unknown',
      new Error('Monad post abandoned'),
    )
    mockedPost.mockRejectedValueOnce(unknownOutcome)

    const failure = await store
      .putMessage({
        wallet: testWallet,
        entry: { kind: 'post', message: 'hello' },
        satoshis: 10_000_000,
        topic: 'stamp',
      })
      .catch((err: unknown) => err)

    expect(failure).toBe(unknownOutcome)
    expect(mockedFetchOne).not.toHaveBeenCalled()
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
  // One refresh now issues one request per topic; script only the `stamp` topic's successive
  // responses, everything else is empty.
  const stampResponses = (...batches: (ForumMessage[] | undefined)[]) => {
    const queue = [...batches]
    mockedFetchByTopic.mockImplementation(async ({ topic }) =>
      topic === 'stamp' ? queue.shift() : [],
    )
  }
  const requestedTopics = () =>
    mockedFetchByTopic.mock.calls.map(([params]) => params.topic)

  it('never requests an empty topic: a fresh user queries the default topics', async () => {
    const store = useForumStore()
    const message = makeMessage()
    mockedFetchByTopic.mockImplementation(async ({ topic }) =>
      topic === 'stamp' ? [message] : [],
    )

    await store.refreshMessages({ wallet: testWallet, topic: '' })

    expect(requestedTopics()).toEqual(
      expect.arrayContaining(['stamp', 'news', 'trading', 'memes', 'help']),
    )
    expect(requestedTopics()).not.toContain('')
    expect(store.getMessage('deadbeef')).toBeTruthy()
  })

  it('also queries relay-discovered topics and merges other users posts', async () => {
    const store = useForumStore()
    mockedDiscoverTopics.mockResolvedValue([
      { topic: 'custom-room', postCount: 1, lastActivityMs: 1 },
      { topic: '', postCount: 1, lastActivityMs: 1 },
    ])
    mockedFetchByTopic.mockImplementation(async ({ topic }) =>
      topic === 'custom-room'
        ? [makeMessage({ topic: 'custom-room', payloadDigest: 'other-user' })]
        : topic === 'news'
        ? [makeMessage({ topic: 'news', payloadDigest: 'alice-news' })]
        : [],
    )

    await store.refreshMessages({ wallet: testWallet, topic: '' })

    expect(requestedTopics()).toContain('custom-room')
    expect(requestedTopics()).not.toContain('')
    expect(store.messages.map(m => m.payloadDigest).sort()).toEqual([
      'alice-news',
      'other-user',
    ])
  })

  it('a selected topic is requested by name, plus known topics it prefixes', async () => {
    const store = useForumStore()
    mockedDiscoverTopics.mockResolvedValue([
      { topic: 'news-eu', postCount: 1, lastActivityMs: 1 },
    ])
    mockedFetchByTopic.mockResolvedValue([])

    await store.refreshMessages({ wallet: testWallet, topic: 'news' })

    expect(requestedTopics().sort()).toEqual(['news', 'news-eu'])
  })

  it('a selected topic unknown to the relay is still requested by name', async () => {
    const store = useForumStore()
    mockedFetchByTopic.mockResolvedValue([])

    await store.refreshMessages({ wallet: testWallet, topic: 'brand-new' })

    expect(requestedTopics()).toEqual(['brand-new'])
  })

  it('one failing topic does not hide posts from the others', async () => {
    const store = useForumStore()
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    mockedFetchByTopic.mockImplementation(async ({ topic }) => {
      if (topic === 'stamp') throw new Error('relay hiccup')
      return topic === 'news' ? [makeMessage({ topic: 'news' })] : []
    })

    await store.refreshMessages({ wallet: testWallet, topic: '' })

    expect(store.getMessage('deadbeef')).toBeTruthy()
    expect(store.hasFetchedOnce).toBe(true)
    consoleError.mockRestore()
  })

  it('rejects when every topic fetch fails, without marking the feed as loaded', async () => {
    const store = useForumStore()
    mockedFetchByTopic.mockRejectedValue(new Error('relay down'))

    await expect(
      store.refreshMessages({ wallet: testWallet, topic: '' }),
    ).rejects.toThrow('relay down')
    expect(store.hasFetchedOnce).toBe(false)
  })

  it('does nothing if fetchByTopic returns no entries', async () => {
    const store = useForumStore()
    mockedFetchByTopic.mockResolvedValueOnce(undefined)

    await store.refreshMessages({ wallet: testWallet, topic: '' })

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
    stampResponses([initial], [updated], [updated])

    await store.refreshMessages({ wallet: testWallet, topic: '' })
    const canonicalMessage = store.messages[0]
    await store.refreshMessages({ wallet: testWallet, topic: '' })
    await store.refreshMessages({ wallet: testWallet, topic: '' })

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
    stampResponses(
      [refreshed, comparison],
      [{ ...refreshed, satoshis: 25 }, comparison],
    )

    await store.refreshMessages({ wallet: testWallet, topic: '' })
    expect(sortPostsByMode(store.messages, 'hot')[0].payloadDigest).toBe(
      'comparison',
    )
    expect(sortPostsByMode(store.messages, 'top')[0].payloadDigest).toBe(
      'comparison',
    )
    expect(store.messages.filter(message => message.satoshis >= 15)).toEqual([
      expect.objectContaining({ payloadDigest: 'comparison' }),
    ])

    await store.refreshMessages({ wallet: testWallet, topic: '' })

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
