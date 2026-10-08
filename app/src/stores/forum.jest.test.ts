/** @jest-environment jsdom */
// Exact paid amounts, request ownership, and atomic canonical Pinia publication.
import { BurnRefreshError } from 'src/utils/burn-refresh-error'
import { setActivePinia, createPinia } from 'pinia'
import { mount, flushPromises } from '@vue/test-utils'
import { computed, createApp, defineComponent, h, nextTick } from 'vue'

import { MessageWithReplies, useForumStore } from './forum'
import { ForumMessage } from '@frank/wallet/forum-model'
import { WalletHandle } from '@frank/wallet/chain'
import { TopicPostOutcomeUnknownError } from '@frank/wallet/chain/active-chain'
import { sortPostsByMode } from 'src/utils/sorting'

jest.mock('src/accounts/session', () => ({
  accountStatus: { revision: 1, status: 'ready' },
}))

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    defaultTopicVoteValue: 100_000_000n,
    topics: {
      reconcileOperations: jest.fn(),
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
    voteWeightWei: '10000000',
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
      satoshis: 10_000_000n,
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
      satoshis: 10_000_000n,
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
        satoshis: 250n,
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
        satoshis: 10_000_000n,
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
        satoshis: 250n,
      }),
    ).rejects.toThrow('Nothing was sent')
    expect(mockedFetchOne).not.toHaveBeenCalled()
    const failure = await store
      .addOffering({
        wallet: testWallet,
        payloadDigest: 'deadbeef',
        satoshis: 250n,
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
        satoshis: 10_000_000n,
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
        satoshis: 10_000_000n,
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
      satoshis: 250n,
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
      satoshis: -250n,
    })

    expect(mockedVote).toHaveBeenCalledWith({
      wallet: testWallet,
      payloadDigest: 'deadbeef',
      direction: 'down',
      voteWeightWei: BigInt(250),
    })
  })

  it("hands the caller's progress callback to activeChain.topics.vote", async () => {
    const store = useForumStore()
    mockedVote.mockResolvedValueOnce(undefined)
    mockedFetchOne.mockResolvedValueOnce(makeMessage())
    const onPreparationProgress = jest.fn()

    await store.addOffering({
      wallet: testWallet,
      payloadDigest: 'deadbeef',
      satoshis: 250n,
      onPreparationProgress,
    })

    expect(mockedVote.mock.calls[0][0].onPreparationProgress).toBe(
      onPreparationProgress,
    )
  })
})

describe('useForumStore: optimistic voting and stamp preparation', () => {
  it('updates voteWeightWei optimistically on indexed message and message list', () => {
    const store = useForumStore()
    const msg = makeMessage({
      payloadDigest: 'test-digest',
      voteWeightWei: '100',
    })
    store.setEntries([msg])

    expect(store.getMessage('test-digest')?.voteWeightWei).toBe('100')
    expect(store.messages[0].voteWeightWei).toBe('100')

    store.applyOptimisticVote({
      payloadDigest: 'test-digest',
      deltaWei: 50n,
    })

    expect(store.getMessage('test-digest')?.voteWeightWei).toBe('150')
    expect(store.messages[0].voteWeightWei).toBe('150')

    store.rollbackOptimisticVote({
      payloadDigest: 'test-digest',
      deltaWei: 50n,
    })

    expect(store.getMessage('test-digest')?.voteWeightWei).toBe('100')
    expect(store.messages[0].voteWeightWei).toBe('100')
  })

  it('tracks stamp preparation status in store', () => {
    const store = useForumStore()
    expect(store.stampPreparationStatus).toBeNull()

    store.setStampPreparationStatus('Checking accounts…')
    expect(store.stampPreparationStatus).toBe('Checking accounts…')

    store.setStampPreparationStatus(null)
    expect(store.stampPreparationStatus).toBeNull()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const session = jest.requireMock('src/accounts/session').accountStatus

describe('canonical complete query publication', () => {
  beforeEach(() => {
    session.revision = 1
    session.status = 'ready'
  })
  it('replaces removed rows and all observed author/content facts, with one mutation', async () => {
    const store = useForumStore()
    store.setEntries([makeMessage(), makeMessage({ payloadDigest: 'removed' })])
    const updated = makeMessage({
      poster: 'new author',
      transactionHash: '22'.repeat(32),
      entries: [{ kind: 'post', message: 'new content' }],
      voteWeightWei: '9007199254740993',
    })
    mockedFetchByTopic.mockResolvedValue([updated])
    const mutations: string[] = []
    store.$subscribe(
      (mutation, state) => {
        if (mutation.type === 'patch function')
          mutations.push(state.messages.map(row => row.poster).join(','))
      },
      { flush: 'sync' },
    )
    await store.refreshMessages({ wallet: testWallet, topic: 'stamp' })
    expect(store.messages).toHaveLength(1)
    expect(store.getMessage('removed')).toBeNull()
    expect(store.getMessage('deadbeef')).toMatchObject(updated)
    expect(mutations).toEqual(['new author'])
    expect(() => JSON.stringify(store.$state)).not.toThrow()
  })
  it('publishes verified empty and does not merge old rows into it', async () => {
    const store = useForumStore()
    store.setEntries([makeMessage()])
    mockedFetchByTopic.mockResolvedValue([])
    await store.refreshMessages({ wallet: testWallet, topic: 'stamp' })
    expect(store.messages).toEqual([])
    expect(store.outageStatus).toBe('ok')
  })
  it('uses one query at a time and reports partial query failures explicitly', async () => {
    const store = useForumStore()
    let active = 0,
      maximum = 0
    mockedFetchByTopic.mockImplementation(async ({ topic }) => {
      maximum = Math.max(maximum, ++active)
      await Promise.resolve()
      active--
      if (topic === 'stamp') throw new Error('failed continuation')
      return topic === 'news' ? [makeMessage({ topic: 'news' })] : []
    })
    await expect(
      store.refreshMessages({ wallet: testWallet, topic: '' }),
    ).rejects.toThrow('failed continuation')
    expect(maximum).toBe(1)
    expect(store.outageStatus).toBe('degraded')
    expect(store.getMessage('deadbeef')?.topic).toBe('news')
  })
  it('discovery failure cannot be a verified empty global refresh', async () => {
    const store = useForumStore()
    store.setEntries([makeMessage()])
    mockedDiscoverTopics.mockRejectedValue(new Error('discovery unavailable'))
    await expect(
      store.refreshMessages({ wallet: testWallet, topic: '' }),
    ).rejects.toThrow('discovery unavailable')
    expect(mockedFetchByTopic).not.toHaveBeenCalled()
    expect(store.messages).toHaveLength(1)
    expect(store.outageStatus).toBe('outage')
  })
  it('old results and finally cannot replace a newer generation or clear loading', async () => {
    const store = useForumStore()
    const old = deferred<ForumMessage[]>(),
      fresh = deferred<ForumMessage[]>()
    mockedFetchByTopic
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise)
    const first = store.refreshMessages.call(new Proxy(store, {}), {
      wallet: testWallet,
      topic: 'stamp',
    })
    await flushPromises()
    const second = store.refreshMessages.call(new Proxy(store, {}), {
      wallet: testWallet,
      topic: 'stamp',
    })
    await flushPromises()
    old.resolve([makeMessage({ poster: 'old' })])
    await first
    expect(store.messages).toEqual([])
    expect(store.isRefreshing).toBe(true)
    fresh.resolve([makeMessage({ poster: 'new' })])
    await second
    expect(store.messages[0].poster).toBe('new')
    expect(store.isRefreshing).toBe(false)
  })
  it.each(['route', 'wallet', 'locked'])(
    'invalidates publication on %s change',
    async change => {
      const store = useForumStore(),
        pending = deferred<ForumMessage[]>()
      mockedFetchByTopic.mockReturnValue(pending.promise)
      const task = store.refreshMessages.call(new Proxy(store, {}), {
        wallet: testWallet,
        topic: 'stamp',
      })
      await flushPromises()
      if (change === 'route')
        store.setSelectedTopic.call(new Proxy(store, {}), 'news')
      else if (change === 'wallet') session.revision++
      else session.status = 'locked'
      pending.resolve([makeMessage()])
      await task
      expect(store.messages).toEqual([])
    },
  )
  it('drops delayed view writes scoped to route and latest same-digest request', async () => {
    const store = useForumStore(),
      old = deferred<ForumMessage | undefined>()
    mockedFetchOne
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(makeMessage({ poster: 'new' }))
    const first = store.fetchMessage.call(new Proxy(store, {}), {
      payloadDigest: 'deadbeef',
    })
    await flushPromises()
    const second = store.fetchMessage.call(new Proxy(store, {}), {
      payloadDigest: 'deadbeef',
    })
    old.resolve(makeMessage({ poster: 'old' }))
    await first
    await second
    expect(store.getMessage('deadbeef')?.poster).toBe('new')
    mockedFetchOne.mockResolvedValue(makeMessage({ payloadDigest: 'other' }))
    await store.fetchMessage({ payloadDigest: 'other', isCurrent: () => false })
    expect(store.getMessage('other')).toBeNull()
  })
  it('rebuilds deduplicated reply links and suppresses cyclic ancestry', () => {
    const store = useForumStore()
    store.setEntries([
      makeMessage({ payloadDigest: 'a', parentDigest: 'b' }),
      makeMessage({ payloadDigest: 'b', parentDigest: 'a' }),
      makeMessage({ payloadDigest: 'descendant', parentDigest: 'a' }),
      makeMessage({ payloadDigest: 'root' }),
      makeMessage({ payloadDigest: 'child', parentDigest: 'root' }),
      makeMessage({
        payloadDigest: 'child',
        parentDigest: 'root',
        poster: 'updated',
      }),
    ])
    expect(store.getMessage('a')?.replies).toEqual([])
    expect(store.getMessage('b')?.replies).toEqual([])
    expect(store.getMessage('root')?.replies).toHaveLength(1)
    expect(store.getMessage('root')?.replies[0].poster).toBe('updated')
    expect(() => JSON.stringify(store.$state)).not.toThrow()
  })
  it('never rounds a signed paid amount through number', async () => {
    const store = useForumStore()
    mockedVote.mockResolvedValue(undefined)
    mockedFetchOne.mockResolvedValue(makeMessage())
    await store.addOffering({
      wallet: testWallet,
      payloadDigest: 'deadbeef',
      satoshis: -9007199254740993n,
    })
    expect(mockedVote).toHaveBeenCalledWith({
      wallet: testWallet,
      payloadDigest: 'deadbeef',
      direction: 'down',
      voteWeightWei: 9007199254740993n,
    })
  })
})

it('excludes unverified number-backed cache on actual persistence restore', async () => {
  let storageOptions:
    | { restore(storage: unknown): Promise<unknown> }
    | undefined
  const pinia = createPinia()
  pinia.use(({ options }) => {
    storageOptions = options.storage as typeof storageOptions
  })
  createApp({}).use(pinia)
  setActivePinia(pinia)
  useForumStore()
  const restored = await storageOptions!.restore({
    get: async () =>
      JSON.stringify({
        messages: [{ satoshis: 9007199254740992, payloadDigest: 'old' }],
        index: { old: { satoshis: 5 } },
        voteThreshold: 1,
        isRefreshing: true,
        hasFetchedOnce: true,
      }),
  })
  expect(restored).toMatchObject({
    messages: [],
    index: {},
    voteThreshold: '0',
    isRefreshing: false,
    hasFetchedOnce: false,
  })
})

it('normal status refresh reconciles retained operations without creating paid intent', async () => {
  const store = useForumStore()
  await store.refreshOperationStatus({ wallet: testWallet })
  expect(activeChain.topics.reconcileOperations).toHaveBeenCalledWith({
    wallet: testWallet,
  })
  expect(mockedPost).not.toHaveBeenCalled()
  expect(mockedVote).not.toHaveBeenCalled()
})

it('does not let an old rejected read overwrite newer loading/error state', async () => {
  const store = useForumStore(),
    old = deferred<ForumMessage[]>(),
    fresh = deferred<ForumMessage[]>()
  mockedFetchByTopic
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(fresh.promise)
  const first = store.refreshMessages({ wallet: testWallet, topic: 'stamp' })
  await flushPromises()
  const second = store.refreshMessages({ wallet: testWallet, topic: 'stamp' })
  old.reject(new Error('old continuation failed'))
  await first
  expect(store.isRefreshing).toBe(true)
  expect(store.outageStatus).toBe('ok')
  fresh.resolve([])
  await second
  expect(store.isRefreshing).toBe(false)
  expect(store.outageStatus).toBe('ok')
})
it('rejects an incomplete query instead of treating it as verified empty', async () => {
  const store = useForumStore()
  store.setEntries([makeMessage()])
  mockedFetchByTopic.mockResolvedValue(undefined)
  await expect(
    store.refreshMessages({ wallet: testWallet, topic: 'stamp' }),
  ).rejects.toThrow('Incomplete Forum query')
  expect(store.messages).toHaveLength(1)
  expect(store.outageStatus).toBe('outage')
})

describe('useForumStore: setEntries snapshot diffing', () => {
  it('skips $patch when messages are identical to avoid DOM re-renders', () => {
    const store = useForumStore()
    const msg = makeMessage({ payloadDigest: 'digest-1', voteWeightWei: '100' })
    store.setEntries([msg])

    const patchSpy = jest.spyOn(store, '$patch')
    store.setEntries([msg])
    expect(patchSpy).not.toHaveBeenCalled()

    patchSpy.mockRestore()
  })

  it('triggers $patch when voteWeight changes', () => {
    const store = useForumStore()
    const msg = makeMessage({ payloadDigest: 'digest-1', voteWeightWei: '100' })
    store.setEntries([msg])

    const patchSpy = jest.spyOn(store, '$patch')
    const updatedMsg = makeMessage({
      payloadDigest: 'digest-1',
      voteWeightWei: '200',
    })
    store.setEntries([updatedMsg])
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(store.messages[0].voteWeightWei).toBe('200')

    patchSpy.mockRestore()
  })

  it('triggers $patch when reply count changes', () => {
    const store = useForumStore()
    const root = makeMessage({ payloadDigest: 'root' })
    store.setEntries([root])
    expect(store.getMessage('root')?.replies).toHaveLength(0)

    const patchSpy = jest.spyOn(store, '$patch')
    const child = makeMessage({ payloadDigest: 'child', parentDigest: 'root' })
    store.setEntries([root, child])
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(store.getMessage('root')?.replies).toHaveLength(1)

    patchSpy.mockRestore()
  })

  it('triggers $patch when new messages are added or length changes', () => {
    const store = useForumStore()
    const msg1 = makeMessage({ payloadDigest: 'digest-1' })
    store.setEntries([msg1])

    const patchSpy = jest.spyOn(store, '$patch')
    const msg2 = makeMessage({ payloadDigest: 'digest-2' })
    store.setEntries([msg1, msg2])
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(store.messages).toHaveLength(2)

    patchSpy.mockRestore()
  })
})
