/**
 * Unit + integration tests for `monad-topic-tally-client.ts` (ticket #33).
 *
 * `axios` is mocked (`jest.mock('axios')`) so nothing here ever touches a real network -- see this
 * file's header comment on why a live Monad-testnet run wasn't practical in this environment
 * (no funded testnet wallet / running relay reachable here), and why a thorough mocked-HTTP
 * integration test is this ticket's actual proof instead.
 *
 * Three groups of tests:
 *
 * 1. "decode correctness" -- builds `MonadTopicPostView`/`MonadTopicPostViews` fixtures directly
 *    via the real generated bindings (`topic_message_pb.js`), then asserts
 *    `fetchMonadTopicPostView`/`fetchMonadTopicPostsSince` decode them into the exact plain-object
 *    shape expected, including the nested `post.post` mapping and negative `voteWeight`.
 * 2. "URL / query-param construction" -- asserts the exact route, method, and query params each
 *    function sends, matching `handle_list_monad_topic_posts`/`handle_get_monad_topic_post`'s real
 *    contract (`ListMonadTopicPostsQuery { topic: String, since: Option<i64> }` -- `topic`
 *    required, `since` optional/omittable).
 * 3. "post -> vote -> tally" integration -- the ticket's core acceptance criterion. Chains the real
 *    `MonadTopicPostClient` (#31) and `MonadTopicVoteClient` (#32) against an in-memory fake relay
 *    (backed by the same mocked `axios`) that mimics the *actual* server-side tally rule
 *    (`process_monad_topic_post`/`process_monad_topic_vote` in `http/monad_topics.rs`: a vote's
 *    weight is its exact burned tx value, signed by its calldata's direction byte, summed across
 *    every vote recorded against a `payload_hash`) -- then proves this ticket's own
 *    `fetchMonadTopicPostView`/`fetchMonadTopicPostsSince` reflect the updated weight afterwards.
 *    Every burn tx involved is a real, locally-signed EIP-1559 transaction (same
 *    `MonadSubAccountPool`/`MonadAccountTxSigner`-against-a-stubbed-provider technique
 *    `monad-topic-post-client.jest.test.ts`/`monad-topic-vote-client.jest.test.ts` use), so the fake
 *    relay derives each vote's weight the same way the real Rust relay would: by parsing the
 *    signed tx's value and calldata direction byte, never by trusting a value the test hands it
 *    directly.
 */
import { JsonRpcProvider, Transaction, getBytes } from 'ethers'
import axios from 'axios'

import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadSubAccountPool } from './monad-account-pool'
import { SubAccountLeaseManager } from './monad-account-lease'
import { MonadTxSubmitter } from './monad-account-tx'
import { ForumMessageEntry } from '@frank/cashweb/types/forum'
import {
  defaultContext,
  topicBurnCommitment,
  validateFrame,
} from '@frank/codec'
import {
  ListTopicsResponse,
  MonadTopicPost,
  MonadTopicPostView,
  MonadTopicPostViews,
  StoredMonadTopicPost,
  StoredMonadTopicVoteEntry,
  TopicDiscoveryEntry,
} from './topic_message_pb'
import {
  MonadTopicPostClient,
  MonadTopicPostProto,
} from './monad-topic-post-client'
import { MonadTopicVoteClient } from './monad-topic-vote-client'
import {
  fetchDiscoveredTopics,
  fetchMonadTopicPostView,
  fetchMonadTopicPostsSince,
} from './monad-topic-tally-client'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk'
const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD'
const CHAIN_ID = 10143
const RELAY_BASE_URL = 'https://relay.example.com'

const FEE_OVERRIDES = {
  gasLimit: 60_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
}

function hexOf(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex')
}

function bareHexOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

// --- Fixture builders (real generated bindings, no hand-rolled bytes) -------------------------

function encodeTopicPostPb(post: MonadTopicPostProto): MonadTopicPost {
  const pb = new MonadTopicPost()
  pb.setTopic(post.topic)
  pb.setParentPostHash(post.parentPostHash)
  pb.setRawBurnTx(post.rawBurnTx)
  pb.setEncryptedPayload(post.encryptedPayload)
  pb.setPayloadHash(post.payloadHash)
  return pb
}

function storedTopicPostPb(
  post: MonadTopicPostProto,
  opts?: { timestamp?: number; networkTag?: string },
): StoredMonadTopicPost {
  const pb = new StoredMonadTopicPost()
  pb.setPost(encodeTopicPostPb(post))
  pb.setSenderAddress(getBytes('0x' + '11'.repeat(20)))
  pb.setTxHash(getBytes('0x' + '22'.repeat(32)))
  pb.setTimestamp(opts?.timestamp ?? 1_700_000_000_000)
  pb.setNetworkTag(new TextEncoder().encode(opts?.networkTag ?? 'MONT'))
  return pb
}

function topicPostViewPb(
  post: MonadTopicPostProto,
  voteWeight: number,
  opts?: { timestamp?: number },
): MonadTopicPostView {
  const view = new MonadTopicPostView()
  view.setPost(storedTopicPostPb(post, opts))
  view.setVoteWeight(voteWeight)
  return view
}

function makePost(payloadHashByte: number): MonadTopicPostProto {
  return {
    topic: 'general',
    parentPostHash: new Uint8Array(0),
    rawBurnTx: new Uint8Array([1, 2, 3]),
    encryptedPayload: new Uint8Array([4, 5, 6]),
    payloadHash: new Uint8Array(32).fill(payloadHashByte),
  }
}

// =================================================================================================
// 1. Decode correctness
// =================================================================================================

describe('decode correctness against real generated bindings', () => {
  beforeEach(() => jest.clearAllMocks())

  it('fetchMonadTopicPostView decodes a MonadTopicPostView, including the nested post', async () => {
    const post = makePost(0x11)
    const viewBytes = topicPostViewPb(post, 4_500).serializeBinary()
    mockedAxios.mockImplementationOnce(async () => ({
      data: Buffer.from(viewBytes),
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    }))

    const result = await fetchMonadTopicPostView({
      relayBaseUrl: RELAY_BASE_URL,
      payloadHashHex: bareHexOf(post.payloadHash),
    })

    expect(result).toBeDefined()
    expect(result?.voteWeight).toBe(4_500)
    expect(result?.post?.post).toEqual(post)
    expect(result?.post?.senderAddress).toEqual(
      getBytes('0x' + '11'.repeat(20)),
    )
    expect(result?.post?.txHash).toEqual(getBytes('0x' + '22'.repeat(32)))
    expect(result?.post?.timestamp).toBe(1_700_000_000_000)
    expect(result?.post?.networkTag).toEqual(new TextEncoder().encode('MONT'))
  })

  it('decodes a negative voteWeight (a net down-voted post) faithfully', async () => {
    const post = makePost(0x22)
    const viewBytes = topicPostViewPb(post, -3_200).serializeBinary()
    mockedAxios.mockImplementationOnce(async () => ({
      data: Buffer.from(viewBytes),
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    }))

    const result = await fetchMonadTopicPostView({
      relayBaseUrl: RELAY_BASE_URL,
      payloadHashHex: bareHexOf(post.payloadHash),
    })

    expect(result?.voteWeight).toBe(-3_200)
  })

  it('fetchMonadTopicPostsSince decodes a MonadTopicPostViews list, preserving server order', async () => {
    const postA = makePost(0xaa)
    const postB = makePost(0xbb)
    const views = new MonadTopicPostViews()
    views.setViewsList([
      topicPostViewPb(postA, 1_000, { timestamp: 100 }),
      topicPostViewPb(postB, -500, { timestamp: 200 }),
    ])
    mockedAxios.mockImplementationOnce(async () => ({
      data: Buffer.from(views.serializeBinary()),
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    }))

    const result = await fetchMonadTopicPostsSince({
      relayBaseUrl: RELAY_BASE_URL,
      topic: 'general',
    })

    expect(result).toHaveLength(2)
    expect(result[0].post?.post).toEqual(postA)
    expect(result[0].voteWeight).toBe(1_000)
    expect(result[0].post?.timestamp).toBe(100)
    expect(result[1].post?.post).toEqual(postB)
    expect(result[1].voteWeight).toBe(-500)
    expect(result[1].post?.timestamp).toBe(200)
  })

  it('fetchMonadTopicPostsSince decodes an empty list as an empty array', async () => {
    mockedAxios.mockImplementationOnce(async () => ({
      data: Buffer.from(new MonadTopicPostViews().serializeBinary()),
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    }))

    const result = await fetchMonadTopicPostsSince({
      relayBaseUrl: RELAY_BASE_URL,
      topic: 'empty-topic',
    })
    expect(result).toEqual([])
  })
})

// =================================================================================================
// 2. URL / query-param construction
// =================================================================================================

describe('URL / query-param construction', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedAxios.isAxiosError.mockImplementation(
      (e: unknown) => (e as { isAxiosError?: boolean })?.isAxiosError === true,
    )
  })

  it('fetchMonadTopicPostsSince GETs /message/monad/topics with topic + since params', async () => {
    mockedAxios.mockImplementationOnce(async config => {
      expect(config.method).toBe('get')
      expect(config.url).toBe(`${RELAY_BASE_URL}/message/monad/topics`)
      expect(config.params).toEqual({ topic: 'general', since: 12345 })
      expect(config.responseType).toBe('arraybuffer')
      return {
        data: Buffer.from(new MonadTopicPostViews().serializeBinary()),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    await fetchMonadTopicPostsSince({
      relayBaseUrl: RELAY_BASE_URL,
      topic: 'general',
      sinceMs: 12345,
    })
  })

  it('omits `since` (rather than sending 0 or null) when sinceMs is not provided', async () => {
    mockedAxios.mockImplementationOnce(async config => {
      expect(config.params.topic).toBe('general')
      expect(config.params.since).toBeUndefined()
      return {
        data: Buffer.from(new MonadTopicPostViews().serializeBinary()),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    await fetchMonadTopicPostsSince({
      relayBaseUrl: RELAY_BASE_URL,
      topic: 'general',
    })
  })

  it('strips a trailing slash from relayBaseUrl before building the list URL', async () => {
    mockedAxios.mockImplementationOnce(async config => {
      expect(config.url).toBe(`${RELAY_BASE_URL}/message/monad/topics`)
      return {
        data: Buffer.from(new MonadTopicPostViews().serializeBinary()),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    await fetchMonadTopicPostsSince({
      relayBaseUrl: `${RELAY_BASE_URL}/`,
      topic: 'general',
    })
  })

  it('fetchMonadTopicPostView GETs /message/monad/topics/:payload_hash', async () => {
    const hashHex = 'ab'.repeat(32)
    mockedAxios.mockImplementationOnce(async config => {
      expect(config.method).toBe('get')
      expect(config.url).toBe(
        `${RELAY_BASE_URL}/message/monad/topics/${hashHex}`,
      )
      expect(config.responseType).toBe('arraybuffer')
      return {
        data: Buffer.from(topicPostViewPb(makePost(0xab), 1).serializeBinary()),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    await fetchMonadTopicPostView({
      relayBaseUrl: RELAY_BASE_URL,
      payloadHashHex: hashHex,
    })
  })

  it('fetchMonadTopicPostView returns undefined on a 404', async () => {
    mockedAxios.mockImplementationOnce(async () => {
      const err = Object.assign(new Error('Not Found'), {
        isAxiosError: true,
        response: { status: 404, data: undefined },
      })
      throw err
    })

    const result = await fetchMonadTopicPostView({
      relayBaseUrl: RELAY_BASE_URL,
      payloadHashHex: 'ff'.repeat(32),
    })
    expect(result).toBeUndefined()
  })

  it('fetchMonadTopicPostView propagates a non-404 HTTP error', async () => {
    mockedAxios.mockImplementationOnce(async () => {
      const err = Object.assign(new Error('Internal Server Error'), {
        isAxiosError: true,
        response: { status: 500, data: undefined },
      })
      throw err
    })

    await expect(
      fetchMonadTopicPostView({
        relayBaseUrl: RELAY_BASE_URL,
        payloadHashHex: 'ff'.repeat(32),
      }),
    ).rejects.toThrow('Internal Server Error')
  })

  it('fetchMonadTopicPostView propagates a network-level (non-axios) failure', async () => {
    mockedAxios.mockImplementationOnce(async () => {
      throw new Error('socket hang up')
    })

    await expect(
      fetchMonadTopicPostView({
        relayBaseUrl: RELAY_BASE_URL,
        payloadHashHex: 'ff'.repeat(32),
      }),
    ).rejects.toThrow('socket hang up')
  })
})

// =================================================================================================
// 3. post -> vote -> tally integration proof (ticket #33's core acceptance criterion)
// =================================================================================================

describe('post -> vote -> tally, chained through the real #31/#32/#33 clients', () => {
  /** In-memory fake relay, keyed by bare-hex payload_hash. Mimics
   * `process_monad_topic_post`/`process_monad_topic_vote`'s tally rule exactly: each vote's weight
   * is derived from its *signed burn tx's* value and calldata direction byte -- never trusted
   * directly from the test -- and summed across every vote recorded against a payload_hash. */
  class FakeTopicRelay {
    private posts = new Map<string, StoredMonadTopicPost>()
    private tallies = new Map<string, number>()

    /** Parses a real signed EIP-1559 tx's value + calldata direction byte (offset 5, matching both
     * `MonadTopicPostClient`'s and `MonadTopicVoteClient`'s `<TPIC><version><direction><commitment>`
     * calldata layout) into a signed weight -- the same derivation
     * `VoteDirection::signed_weight` performs server-side. */
    private deriveWeight(rawBurnTx: Uint8Array): number {
      const parsed = Transaction.from(hexOf(rawBurnTx))
      const calldata = getBytes(parsed.data)
      const direction = calldata[5]
      const magnitude = Number(parsed.value)
      return direction === 0x01 ? magnitude : -magnitude
    }

    handlePutPost(bytes: Uint8Array): Uint8Array {
      const decoded = validateFrame(
        bytes,
        defaultContext({ operation: 'typed' }),
      )
      if (
        decoded.kind !== 'parsed' ||
        decoded.typed?.type !== 10 ||
        decoded.typed.postFrame.typed?.type !== 9
      ) {
        throw new Error('expected a type-10 CBOR submission')
      }
      const typedPost = decoded.typed.postFrame.typed
      const identity = topicBurnCommitment(decoded.typed.postFrame.frame)
      const post = new MonadTopicPost()
      post.setTopic(typedPost.topic)
      post.setParentPostHash(typedPost.parentHash ?? new Uint8Array(0))
      post.setRawBurnTx(decoded.typed.burnTx)
      post.setEncryptedPayload(typedPost.body)
      post.setPayloadHash(identity.hash)
      const payloadHashHex = bareHexOf(identity.hash)
      const stored = new StoredMonadTopicPost()
      stored.setPost(post)
      stored.setSenderAddress(getBytes('0x' + '33'.repeat(20)))
      stored.setTxHash(getBytes('0x' + '44'.repeat(32)))
      stored.setTimestamp(1_700_000_000_000)
      this.posts.set(payloadHashHex, stored)
      this.tallies.set(
        payloadHashHex,
        this.deriveWeight(post.getRawBurnTx_asU8()),
      )
      return decoded.typed.postFrame.frame
    }

    handlePutVote(
      targetPayloadHash: Uint8Array,
      rawBurnTx: Uint8Array,
    ): { targetPayloadHashHex: string } {
      const targetHex = bareHexOf(targetPayloadHash)
      if (!this.posts.has(targetHex)) {
        throw Object.assign(new Error('unknown target post'), {
          isAxiosError: true,
          response: { status: 400, data: { error: 'unknown_target_post' } },
        })
      }
      const weight = this.deriveWeight(rawBurnTx)
      this.tallies.set(targetHex, (this.tallies.get(targetHex) ?? 0) + weight)
      return { targetPayloadHashHex: targetHex }
    }

    handleGetView(payloadHashHex: string): Uint8Array | undefined {
      const stored = this.posts.get(payloadHashHex)
      if (!stored) return undefined
      const view = new MonadTopicPostView()
      view.setPost(stored)
      view.setVoteWeight(this.tallies.get(payloadHashHex) ?? 0)
      return view.serializeBinary()
    }

    handleListByTopic(topic: string): Uint8Array {
      const views = new MonadTopicPostViews()
      const matching: MonadTopicPostView[] = []
      for (const [hashHex, stored] of this.posts) {
        if (stored.getPost()?.getTopic() === topic) {
          const view = new MonadTopicPostView()
          view.setPost(stored)
          view.setVoteWeight(this.tallies.get(hashHex) ?? 0)
          matching.push(view)
        }
      }
      views.setViewsList(matching)
      return views.serializeBinary()
    }
  }

  function makePool(size = 3): MonadSubAccountPool {
    const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
    const pool = new MonadSubAccountPool({ keyring })
    pool.ensureSize(size)
    return pool
  }

  function makeStubProvider() {
    let nonce = 0
    const provider = new JsonRpcProvider('http://127.0.0.1:1', CHAIN_ID, {
      staticNetwork: true,
      cacheTimeout: -1,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(provider as any)._perform = async (req: { method: string }) => {
      if (req.method === 'getTransactionCount')
        return `0x${(nonce++).toString(16)}`
      if (req.method === 'estimateGas') return '0x5208'
      throw new Error(`unexpected _perform: ${req.method}`)
    }
    return provider
  }

  function makeMockHttpClient(): jest.Mocked<MonadTxSubmitter> {
    return {
      submitRawTransaction: jest.fn(),
      getTransactionReceipt: jest.fn(),
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockedAxios.isAxiosError.mockImplementation(
      (e: unknown) => (e as { isAxiosError?: boolean })?.isAxiosError === true,
    )
  })

  it("post, then vote, then this ticket's fetch reflects the updated tallied weight", async () => {
    const relay = new FakeTopicRelay()
    const pool = makePool()
    const leaseManager = new SubAccountLeaseManager(pool)
    const provider = makeStubProvider()
    const httpClient = makeMockHttpClient()

    const postClient = new MonadTopicPostClient({
      pool,
      leaseManager,
      provider,
      httpClient,
      relayBaseUrl: RELAY_BASE_URL,
      topicWriteFormat: 'cbor',
    })
    const voteClient = new MonadTopicVoteClient({
      pool,
      leaseManager,
      provider,
      httpClient,
      relayBaseUrl: RELAY_BASE_URL,
      topicWriteFormat: 'cbor',
    })

    mockedAxios.mockImplementation(async config => {
      const url = String(config.url)
      if (config.method === 'put' && url.endsWith('/message/monad/topics')) {
        const data = relay.handlePutPost(new Uint8Array(config.data as Buffer))
        return {
          data: Buffer.from(data),
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        }
      }
      if (
        config.method === 'put' &&
        url.endsWith('/message/monad/topics/vote')
      ) {
        const decoded = validateFrame(
          new Uint8Array(config.data as Buffer),
          defaultContext({ operation: 'typed' }),
        )
        if (decoded.kind !== 'parsed' || decoded.typed?.type !== 11) {
          throw new Error('expected a type-11 CBOR vote')
        }
        relay.handlePutVote(decoded.typed.targetHash, decoded.typed.burnTx)
        const entry = new StoredMonadTopicVoteEntry()
        entry.setTargetPayloadHash(decoded.typed.targetHash)
        entry.setSenderAddress(getBytes('0x' + '55'.repeat(20)))
        entry.setTxHash(getBytes('0x' + '66'.repeat(32)))
        entry.setTimestamp(1_700_000_001_000)
        entry.setWeight(0) // unused by this test; the real weight lives in the relay's tally
        return {
          data: Buffer.from(entry.serializeBinary()),
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        }
      }
      if (config.method === 'get' && url.includes('/message/monad/topics/')) {
        const payloadHashHex = url.split('/message/monad/topics/')[1]
        const data = relay.handleGetView(payloadHashHex)
        if (!data) {
          const err = Object.assign(new Error('Not Found'), {
            isAxiosError: true,
            response: { status: 404 },
          })
          throw err
        }
        return {
          data: Buffer.from(data),
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        }
      }
      if (config.method === 'get' && url.endsWith('/message/monad/topics')) {
        const data = relay.handleListByTopic(config.params.topic)
        return {
          data: Buffer.from(data),
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        }
      }
      throw new Error(`unexpected request: ${config.method} ${url}`)
    })

    // --- 1. Post a topic message with an initial up-vote of 5_000 wei (#31). ---
    const entries: ForumMessageEntry[] = [
      { kind: 'post', title: 'Hello', message: 'First topic post' },
    ]
    const postResult = await postClient.submitTopicPost({
      topic: 'tally-demo',
      entries,
      direction: 'up',
      burnAddress: BURN_ADDRESS,
      voteWeightWei: 5_000n,
      overrides: FEE_OVERRIDES,
      timestampMs: 1_700_000_000_000,
    })

    // Before any additional vote, this ticket's fetch should reflect only the initial vote.
    const viewAfterPost = await fetchMonadTopicPostView({
      relayBaseUrl: RELAY_BASE_URL,
      payloadHashHex: postResult.payloadHashHex,
    })
    expect(viewAfterPost).toBeDefined()
    expect(viewAfterPost?.voteWeight).toBe(5_000)
    expect(viewAfterPost?.post?.post?.topic).toBe('tally-demo')

    // --- 2. Cast an additional up-vote of 2_000 wei against the same post (#32). ---
    await voteClient.castVote({
      targetPayloadHash: getBytes('0x' + postResult.payloadHashHex),
      direction: 'up',
      burnAddress: BURN_ADDRESS,
      voteWeightWei: 2_000n,
      overrides: FEE_OVERRIDES,
    })

    // --- 3. Cast a down-vote of 1_500 wei against the same post (#32). ---
    await voteClient.castVote({
      targetPayloadHash: getBytes('0x' + postResult.payloadHashHex),
      direction: 'down',
      burnAddress: BURN_ADDRESS,
      voteWeightWei: 1_500n,
      overrides: FEE_OVERRIDES,
    })

    // --- 4. This ticket's fetch (single) reflects the updated weight: 5_000 + 2_000 - 1_500. ---
    const viewAfterVotes = await fetchMonadTopicPostView({
      relayBaseUrl: RELAY_BASE_URL,
      payloadHashHex: postResult.payloadHashHex,
    })
    expect(viewAfterVotes?.voteWeight).toBe(5_500)

    // --- 5. This ticket's fetch (list, by topic) reflects the same tallied weight. ---
    const listed = await fetchMonadTopicPostsSince({
      relayBaseUrl: RELAY_BASE_URL,
      topic: 'tally-demo',
    })
    expect(listed).toHaveLength(1)
    expect(listed[0].voteWeight).toBe(5_500)
    expect(listed[0].post?.post?.payloadHash).toEqual(
      getBytes('0x' + postResult.payloadHashHex),
    )
  })
})

// =================================================================================================
// 4. fetchDiscoveredTopics (ticket #72)
// =================================================================================================

describe('fetchDiscoveredTopics', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedAxios.isAxiosError.mockImplementation(
      (e: unknown) => (e as { isAxiosError?: boolean })?.isAxiosError === true,
    )
  })

  function discoveryEntry(
    topic: string,
    postCount: number,
    lastActivityMs: number,
  ): TopicDiscoveryEntry {
    const entry = new TopicDiscoveryEntry()
    entry.setTopic(topic)
    entry.setPostCount(postCount)
    entry.setLastActivityMs(lastActivityMs)
    return entry
  }

  it('GETs /message/monad/topics/discover and decodes every entry', async () => {
    const response = new ListTopicsResponse()
    response.setEntriesList([
      discoveryEntry('topic.newest', 3, 300),
      discoveryEntry('topic.oldest', 1, 100),
    ])
    mockedAxios.mockImplementationOnce(async config => {
      expect(config.method).toBe('get')
      expect(config.url).toBe(`${RELAY_BASE_URL}/message/monad/topics/discover`)
      expect(config.responseType).toBe('arraybuffer')
      return {
        data: Buffer.from(response.serializeBinary()),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    const result = await fetchDiscoveredTopics({
      relayBaseUrl: RELAY_BASE_URL,
    })

    expect(result).toEqual([
      { topic: 'topic.newest', postCount: 3, lastActivityMs: 300 },
      { topic: 'topic.oldest', postCount: 1, lastActivityMs: 100 },
    ])
  })

  it('strips a trailing slash from relayBaseUrl before building the discover URL', async () => {
    mockedAxios.mockImplementationOnce(async config => {
      expect(config.url).toBe(`${RELAY_BASE_URL}/message/monad/topics/discover`)
      return {
        data: Buffer.from(new ListTopicsResponse().serializeBinary()),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    await fetchDiscoveredTopics({ relayBaseUrl: `${RELAY_BASE_URL}/` })
  })

  it('decodes an empty response as an empty array', async () => {
    mockedAxios.mockImplementationOnce(async () => ({
      data: Buffer.from(new ListTopicsResponse().serializeBinary()),
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    }))

    expect(
      await fetchDiscoveredTopics({ relayBaseUrl: RELAY_BASE_URL }),
    ).toEqual([])
  })

  it('fails soft (returns []) on a network-level error, unlike the other fetchers in this file', async () => {
    mockedAxios.mockImplementationOnce(async () => {
      throw new Error('socket hang up')
    })

    const result = await fetchDiscoveredTopics({
      relayBaseUrl: RELAY_BASE_URL,
    })
    expect(result).toEqual([])
  })

  it('fails soft (returns []) on a non-2xx HTTP error', async () => {
    mockedAxios.mockImplementationOnce(async () => {
      const err = Object.assign(new Error('Internal Server Error'), {
        isAxiosError: true,
        response: { status: 500, data: undefined },
      })
      throw err
    })

    const result = await fetchDiscoveredTopics({
      relayBaseUrl: RELAY_BASE_URL,
    })
    expect(result).toEqual([])
  })

  it('fails soft (returns []) on a malformed/undecodable response body', async () => {
    mockedAxios.mockImplementationOnce(async () => ({
      // Tag byte 0x0a (field 1, length-delimited) declares a 5-byte payload but supplies none --
      // a truncated length-delimited field, guaranteed to throw during decode.
      data: Buffer.from([0x0a, 0x05]),
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    }))

    const result = await fetchDiscoveredTopics({
      relayBaseUrl: RELAY_BASE_URL,
    })
    expect(result).toEqual([])
  })
})
