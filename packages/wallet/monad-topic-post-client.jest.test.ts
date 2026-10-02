/**
 * Unit tests for `monad-topic-post-client.ts` (ticket #31).
 *
 * `axios` is mocked (`jest.mock('axios')`) so `PUT /message/monad/topics` / `GET
 * /message/monad/topics/:payload_hash` never touch a real network -- each test drives the mock to
 * exercise one of `submitTopicPost`'s documented outcomes (2xx success, HTTP-level rejection,
 * network-failure-then-found-via-poll, network-failure-then-abandoned). Burn-tx construction goes
 * through a real `MonadSubAccountPool`/`MonadAccountTxSigner` against a stubbed ethers
 * `JsonRpcProvider._perform`, so the signed raw tx and its calldata are real, decodable bytes --
 * same technique `monad-stamp-client.jest.test.ts` uses.
 */
import { JsonRpcProvider, Transaction, getBytes, sha256 } from 'ethers'
import axios from 'axios'

import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadSubAccountPool } from './monad-account-pool'
import { BurnNotSentError, SubAccountLeaseManager } from './monad-account-lease'
import { MonadTxSubmitter } from './monad-account-tx'
import {
  MonadTopicPost,
  MonadTopicPostView,
  StoredMonadTopicPost,
} from './topic_message_pb'
import { ForumMessageEntry } from '@frank/cashweb/types/forum'
import {
  defaultContext,
  encodeTopicPost,
  topicBurnCommitment,
  validateFrame,
} from '@frank/codec'
import {
  MONAD_TOPIC_VOTE_CALLDATA_LENGTH,
  MonadTopicPostAbandonedError,
  MonadTopicPostClient,
  MonadTopicPostProto,
  MonadTopicPostRejectedError,
  buildTopicPostPayload,
  buildTopicVoteCalldata,
  computeTopicPostCommitment,
  decodeMonadTopicPost,
  decodeStoredMonadTopicPost,
} from './monad-topic-post-client'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk'
const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD'
const CHAIN_ID = 10143

// Explicit fee/gas overrides so `populateTransaction` never needs to call
// `eth_feeHistory`/`eth_getBlockByNumber` against the stub provider -- matches
// `monad-stamp-client.jest.test.ts`'s own precedent.
const FEE_OVERRIDES = {
  gasLimit: 60_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
}

const ENTRIES: ForumMessageEntry[] = [
  { kind: 'post', title: 'Hello', message: 'First topic post' },
]

function makePool(size = 2): MonadSubAccountPool {
  const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
  const pool = new MonadSubAccountPool({ keyring })
  pool.ensureSize(size)
  return pool
}

function makeStubProvider(
  perform: (req: { method: string }) => Promise<unknown>,
) {
  const provider = new JsonRpcProvider('http://127.0.0.1:1', CHAIN_ID, {
    staticNetwork: true,
    cacheTimeout: -1,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(provider as any)._perform = perform
  return provider
}

function makeMockHttpClient(): jest.Mocked<MonadTxSubmitter> {
  return {
    submitRawTransaction: jest.fn(),
    getTransactionReceipt: jest.fn(),
  }
}

function makeChainProvider() {
  let nonce = 0
  return makeStubProvider(async req => {
    if (req.method === 'getTransactionCount')
      return `0x${(nonce++).toString(16)}`
    if (req.method === 'estimateGas') return '0x5208'
    throw new Error(`unexpected _perform: ${req.method}`)
  })
}

function makeClient(overrides?: { pool?: MonadSubAccountPool }) {
  const pool = overrides?.pool ?? makePool()
  const leaseManager = new SubAccountLeaseManager(pool)
  const provider = makeChainProvider()
  const httpClient = makeMockHttpClient()
  const client = new MonadTopicPostClient({
    pool,
    leaseManager,
    provider,
    httpClient,
    relayBaseUrl: 'https://relay.example.com/',
  })
  return { client, pool, leaseManager, provider, httpClient }
}

/** Encode a `MonadTopicPostProto` via the real generated `MonadTopicPost` binding -- used both to
 * build fixture bytes and (indirectly, via `decodeMonadTopicPost`) to prove the module's own
 * decode path round-trips against it. */
function encodeTopicPostPb(post: MonadTopicPostProto): MonadTopicPost {
  const pb = new MonadTopicPost()
  pb.setTopic(post.topic)
  pb.setParentPostHash(post.parentPostHash)
  pb.setRawBurnTx(post.rawBurnTx)
  pb.setEncryptedPayload(post.encryptedPayload)
  pb.setPayloadHash(post.payloadHash)
  return pb
}

/** Builds the wire bytes a `PUT /message/monad/topics` (or `GET .../topics/:hash`'s nested `post`)
 * response would carry, via the real generated `StoredMonadTopicPost` binding. */
function storedTopicPostBytes(
  post: MonadTopicPostProto,
  cborPostFrame?: Uint8Array,
): Uint8Array {
  const pb = new StoredMonadTopicPost()
  pb.setPost(encodeTopicPostPb(post))
  pb.setSenderAddress(getBytes('0x' + '11'.repeat(20)))
  pb.setTxHash(getBytes('0x' + '22'.repeat(32)))
  pb.setTimestamp(1_700_000_000_000)
  pb.setNetworkTag(new TextEncoder().encode('MONT'))
  if (cborPostFrame !== undefined) pb.setCborPostFrame(cborPostFrame)
  return pb.serializeBinary()
}

/** Builds `GET /message/monad/topics/:payload_hash`'s `MonadTopicPostView` response bytes. */
function topicPostViewBytes(post: MonadTopicPostProto, voteWeight: number) {
  const view = new MonadTopicPostView()
  view.setPost(
    StoredMonadTopicPost.deserializeBinary(storedTopicPostBytes(post)),
  )
  view.setVoteWeight(voteWeight)
  return view.serializeBinary()
}

function hexOf(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex')
}

function decodeCborSubmission(bytes: Uint8Array) {
  const result = validateFrame(bytes, defaultContext({ operation: 'typed' }))
  if (
    result.kind !== 'parsed' ||
    result.typed?.type !== 10 ||
    result.typed.postFrame.typed?.type !== 9
  ) {
    throw new Error('expected a typed type-10 topic submission')
  }
  const post = result.typed.postFrame.typed
  const identity = topicBurnCommitment(result.typed.postFrame.frame)
  return {
    topic: post.topic,
    parentPostHash: post.parentHash ?? new Uint8Array(0),
    rawBurnTx: result.typed.burnTx,
    encryptedPayload: post.body,
    payloadHash: identity.hash,
    commitment: identity.commitment,
  }
}

describe('calldata / commitment construction', () => {
  it('computes payload_hash as plain SHA256(serialized payload)', () => {
    const payload = buildTopicPostPayload({
      topic: 'general',
      entries: ENTRIES,
      timestampMs: 1_700_000_000_000,
    })
    const commitment = computeTopicPostCommitment(payload)
    expect(getBytes(sha256(payload))).toEqual(commitment)
    expect(commitment).toHaveLength(32)
  })

  it('builds deterministic payload bytes for the same inputs (topic/entries/timestamp)', () => {
    const a = buildTopicPostPayload({
      topic: 'general',
      entries: ENTRIES,
      timestampMs: 42,
    })
    const b = buildTopicPostPayload({
      topic: 'general',
      entries: ENTRIES,
      timestampMs: 42,
    })
    expect(a).toEqual(b)
  })

  it('builds up-vote calldata as <TPIC><0x02><0x01><32-byte commitment>, 38 bytes total', () => {
    const commitment = new Uint8Array(32).fill(0xab)
    const calldata = buildTopicVoteCalldata('up', commitment)
    const bytes = getBytes(calldata)

    expect(bytes).toHaveLength(38)
    expect(MONAD_TOPIC_VOTE_CALLDATA_LENGTH).toBe(38)
    // "TPIC" == 0x54504943 -- TOPIC_VOTE_LOKAD_ID (monad_topic_verify.rs:94).
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x54, 0x50, 0x49, 0x43])
    // TOPIC_COMMITMENT_VERSION_TAG (monad_topic_verify.rs:99).
    expect(bytes[4]).toBe(0x02)
    // VoteDirection::UP_BYTE (monad_topic_verify.rs:118).
    expect(bytes[5]).toBe(0x01)
    expect(Array.from(bytes.slice(6))).toEqual(Array.from(commitment))
  })

  it('builds down-vote calldata with direction byte 0x00', () => {
    const commitment = new Uint8Array(32).fill(0xcd)
    const calldata = buildTopicVoteCalldata('down', commitment)
    const bytes = getBytes(calldata)

    expect(bytes).toHaveLength(38)
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x54, 0x50, 0x49, 0x43])
    expect(bytes[4]).toBe(0x02)
    // VoteDirection::DOWN_BYTE (monad_topic_verify.rs:119).
    expect(bytes[5]).toBe(0x00)
    expect(Array.from(bytes.slice(6))).toEqual(Array.from(commitment))
  })

  it('rejects a commitment that is not exactly 32 bytes', () => {
    expect(() => buildTopicVoteCalldata('up', new Uint8Array(31))).toThrow(
      /32 bytes/,
    )
  })

  it('matches a known-good fixture byte-for-byte', () => {
    const commitment = new Uint8Array(32)
    for (let i = 0; i < 32; i++) commitment[i] = i
    const calldata = getBytes(buildTopicVoteCalldata('up', commitment))
    const expected = new Uint8Array([
      0x54,
      0x50,
      0x49,
      0x43, // "TPIC"
      0x02, // deterministic-CBOR topic calldata version
      0x01, // up
      ...commitment,
    ])
    expect(calldata).toEqual(expected)
  })
})

describe('protobuf encode/decode round trip', () => {
  it('round-trips MonadTopicPost through encode -> decode', () => {
    const post: MonadTopicPostProto = {
      topic: 'general',
      parentPostHash: new Uint8Array(32).fill(0x77),
      rawBurnTx: new Uint8Array([1, 2, 3, 4]),
      encryptedPayload: new TextEncoder().encode('serialized payload'),
      payloadHash: new Uint8Array(32).fill(0x42),
    }
    const decoded = decodeMonadTopicPost(
      encodeTopicPostPb(post).serializeBinary(),
    )
    expect(decoded).toEqual(post)
  })

  it('round-trips a StoredMonadTopicPost, including the nested MonadTopicPost', () => {
    const post: MonadTopicPostProto = {
      topic: 'general',
      parentPostHash: new Uint8Array(0),
      rawBurnTx: new Uint8Array([9, 9, 9]),
      encryptedPayload: new Uint8Array([7, 7]),
      payloadHash: new Uint8Array(32).fill(0x11),
    }
    const decoded = decodeStoredMonadTopicPost(storedTopicPostBytes(post))
    expect(decoded.post).toEqual(post)
    expect(decoded.senderAddress).toEqual(getBytes('0x' + '11'.repeat(20)))
    expect(decoded.txHash).toEqual(getBytes('0x' + '22'.repeat(32)))
    expect(decoded.timestamp).toBe(1_700_000_000_000)
    expect(decoded.networkTag).toEqual(new TextEncoder().encode('MONT'))
  })
})

describe('MonadTopicPostClient.submitTopicPost', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // `jest.mock('axios')` automocks every export, including `isAxiosError`, to a bare `jest.fn()`
    // returning `undefined` -- give it a real implementation so `submitTopicPost`'s
    // `axios.isAxiosError(err)` branches work the same way they would against the real library.
    mockedAxios.isAxiosError.mockImplementation(
      (e: unknown) => (e as { isAxiosError?: boolean })?.isAxiosError === true,
    )
  })

  it('PUTs the assembled MonadTopicPost and releases the lease as confirmed on 2xx', async () => {
    const { client, pool } = makeClient()

    const expectedPayload = buildTopicPostPayload({
      topic: 'general',
      entries: ENTRIES,
      timestampMs: 1_700_000_000_000,
    })
    const expectedPostFrame = encodeTopicPost({
      network: 'monad-testnet',
      topic: 'general',
      body: expectedPayload,
    })
    const expectedIdentity = topicBurnCommitment(expectedPostFrame)

    mockedAxios.mockImplementationOnce(async config => {
      expect(config.method).toBe('put')
      expect(config.url).toBe('https://relay.example.com/message/monad/topics')
      expect(config.headers).toEqual({
        'Content-Type': 'application/cbor',
        'Accept': 'application/x-protobuf',
      })
      const sentPost = decodeCborSubmission(
        new Uint8Array(config.data as Buffer),
      )
      expect(sentPost.topic).toBe('general')
      expect(sentPost.payloadHash).toEqual(expectedIdentity.hash)
      expect(sentPost.encryptedPayload).toEqual(expectedPayload)

      // The raw burn tx must be a validly-decodable, real signed transaction whose calldata
      // carries the same commitment plus the up-vote direction byte.
      const parsed = Transaction.from(hexOf(sentPost.rawBurnTx))
      const calldataBytes = getBytes(parsed.data)
      expect(calldataBytes.slice(0, 4)).toEqual(
        new Uint8Array([0x54, 0x50, 0x49, 0x43]),
      )
      expect(calldataBytes[4]).toBe(0x02)
      expect(calldataBytes[5]).toBe(0x01) // up
      expect(calldataBytes.slice(6)).toEqual(expectedIdentity.commitment)
      expect(parsed.value).toBe(5_000n)

      return {
        data: storedTopicPostBytes(sentPost, expectedPostFrame),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    const result = await client.submitTopicPost({
      topic: 'general',
      entries: ENTRIES,
      direction: 'up',
      burnAddress: BURN_ADDRESS,
      voteWeightWei: 5_000n,
      overrides: FEE_OVERRIDES,
      timestampMs: 1_700_000_000_000,
    })

    expect(result.stored.post?.topic).toBe('general')
    expect(result.stored.cborPostFrame).toEqual(expectedPostFrame)
    expect(result.postFrame).toEqual(expectedPostFrame)
    expect(result.payloadHashHex).toBe(
      Buffer.from(expectedIdentity.hash).toString('hex'),
    )
    // Ticket #34: a confirmed release retires the account as 'spent' -- never back to 'available'.
    expect(pool.getRecord(result.leaseIndex)?.status).toBe('spent')
  })

  it("leases exactly the requested funded account instead of the pool's next one (ticket #273)", async () => {
    const pool = makePool(3)
    pool.setStatus(0, 'available')
    pool.setStatus(2, 'available')
    const { client } = makeClient({ pool })
    mockedAxios.mockImplementationOnce(async config => ({
      data: storedTopicPostBytes(
        decodeCborSubmission(new Uint8Array(config.data as Buffer)),
      ),
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }))

    const result = await client.submitTopicPost({
      topic: 'general',
      entries: ENTRIES,
      direction: 'up',
      burnAddress: BURN_ADDRESS,
      voteWeightWei: 5_000n,
      overrides: FEE_OVERRIDES,
      leaseIndex: 2,
    })

    expect(result.leaseIndex).toBe(2)
    expect(pool.getRecord(2)?.status).toBe('spent')
    expect(pool.getRecord(0)?.status).toBe('available')
  })

  it('returns the untouched account to available and throws BurnNotSentError when signing throws (#273)', async () => {
    const { client, pool } = makeClient()

    await expect(
      client.submitTopicPost({
        topic: 'general',
        entries: ENTRIES,
        direction: 'up',
        burnAddress: 'not-an-address',
        voteWeightWei: 5_000n,
        overrides: FEE_OVERRIDES,
      }),
    ).rejects.toBeInstanceOf(BurnNotSentError)

    expect(mockedAxios).not.toHaveBeenCalled()
    expect(pool.records().filter(r => r.status === 'retired')).toHaveLength(0)
    expect(pool.records().filter(r => r.status === 'in-use')).toHaveLength(0)
  })

  it('rejects a down-vote initial post before leasing or sending', async () => {
    const { client, pool } = makeClient()
    await expect(
      client.submitTopicPost({
        topic: 'general',
        entries: ENTRIES,
        direction: 'down',
        burnAddress: BURN_ADDRESS,
        voteWeightWei: 1_000n,
        overrides: FEE_OVERRIDES,
      }),
    ).rejects.toThrow(/initial vote must be up/)
    expect(mockedAxios).not.toHaveBeenCalled()
    expect(pool.records().every(record => record.status === 'available')).toBe(
      true,
    )
  })

  it('retires the sub-account and throws MonadTopicPostRejectedError on an HTTP error response', async () => {
    const { client, pool } = makeClient()
    mockedAxios.mockImplementationOnce(async () => {
      const err = Object.assign(new Error('Bad Request'), {
        isAxiosError: true,
        response: { status: 400, data: { error: 'invalid_topic_post' } },
      })
      throw err
    })

    await expect(
      client.submitTopicPost({
        topic: 'general',
        entries: ENTRIES,
        direction: 'up',
        burnAddress: BURN_ADDRESS,
        voteWeightWei: 5_000n,
        overrides: FEE_OVERRIDES,
      }),
    ).rejects.toThrow(MonadTopicPostRejectedError)

    const retired = pool.records().filter(r => r.status === 'retired')
    expect(retired).toHaveLength(1)
  })

  it('falls back to polling GET and confirms when a network failure is followed by a found post', async () => {
    const { client, pool } = makeClient()

    let putCalls = 0
    let getCalls = 0
    mockedAxios.mockImplementation(async config => {
      if (config.method === 'put') {
        putCalls++
        const networkErr = Object.assign(new Error('socket hang up'), {
          isAxiosError: true,
          response: undefined,
        })
        throw networkErr
      }
      // GET /message/monad/topics/:payload_hash
      getCalls++
      expect(config.url).toContain('/message/monad/topics/')
      const sentPost: MonadTopicPostProto = {
        topic: 'general',
        parentPostHash: new Uint8Array(0),
        rawBurnTx: new Uint8Array([1]),
        encryptedPayload: new Uint8Array([2]),
        payloadHash: new Uint8Array(32).fill(0x9),
      }
      return {
        data: topicPostViewBytes(sentPost, 5_000),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    const result = await client.submitTopicPost({
      topic: 'general',
      entries: ENTRIES,
      direction: 'up',
      burnAddress: BURN_ADDRESS,
      voteWeightWei: 5_000n,
      overrides: FEE_OVERRIDES,
      abandonPoll: {
        maxAttempts: 2,
        intervalMs: 0,
        sleep: async () => undefined,
      },
    })

    expect(putCalls).toBe(1)
    expect(getCalls).toBe(1)
    expect(result.stored.post?.topic).toBe('general')
    expect(pool.getRecord(result.leaseIndex)?.status).toBe('spent')
  })

  it('retires as stuck and throws MonadTopicPostAbandonedError when the fallback poll never finds it', async () => {
    const { client, pool } = makeClient()
    mockedAxios.mockImplementation(async () => {
      const networkErr = Object.assign(new Error('timeout'), {
        isAxiosError: true,
        response: undefined,
      })
      throw networkErr
    })

    await expect(
      client.submitTopicPost({
        topic: 'general',
        entries: ENTRIES,
        direction: 'up',
        burnAddress: BURN_ADDRESS,
        voteWeightWei: 5_000n,
        overrides: FEE_OVERRIDES,
        abandonPoll: {
          maxAttempts: 2,
          intervalMs: 0,
          sleep: async () => undefined,
        },
      }),
    ).rejects.toThrow(MonadTopicPostAbandonedError)

    const retired = pool.records().filter(r => r.status === 'retired')
    expect(retired).toHaveLength(1)
  })

  it('rejects an empty entries array before leasing anything', async () => {
    const { client, pool } = makeClient()
    await expect(
      client.submitTopicPost({
        topic: 'general',
        entries: [],
        direction: 'up',
        burnAddress: BURN_ADDRESS,
        voteWeightWei: 5_000n,
        overrides: FEE_OVERRIDES,
      }),
    ).rejects.toThrow(/entries must not be empty/)
    expect(pool.records().every(r => r.status === 'available')).toBe(true)
  })
})
