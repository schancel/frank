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
