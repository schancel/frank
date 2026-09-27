/**
 * Unit tests for `monad-forum-post-client.ts` (ticket #31).
 *
 * `axios` is mocked (`jest.mock('axios')`) so `PUT /message/monad/forum` / `GET
 * /message/monad/forum/:payload_hash` never touch a real network -- each test drives the mock to
 * exercise one of `submitForumPost`'s documented outcomes (2xx success, HTTP-level rejection,
 * network-failure-then-found-via-poll, network-failure-then-abandoned). Burn-tx construction goes
 * through a real `MonadSubAccountPool`/`MonadAccountTxSigner` against a stubbed ethers
 * `JsonRpcProvider._perform`, so the signed raw tx and its calldata are real, decodable bytes --
 * same technique `monad-stamp-client.jest.test.ts` uses.
 */
import { JsonRpcProvider, Transaction, getBytes, sha256 } from 'ethers'
import axios from 'axios'

import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadSubAccountPool } from './monad-account-pool'
import { SubAccountLeaseManager } from './monad-account-lease'
import { MonadTxSubmitter } from './monad-account-tx'
import {
  MonadForumPost,
  MonadForumPostView,
  StoredMonadForumPost,
} from './forum_message_pb'
import { ForumMessageEntry } from '../types/forum'
import {
  MONAD_FORUM_VOTE_CALLDATA_LENGTH,
  MonadForumPostAbandonedError,
  MonadForumPostClient,
  MonadForumPostProto,
  MonadForumPostRejectedError,
  buildForumPostPayload,
  buildForumVoteCalldata,
  computeForumPostCommitment,
  decodeMonadForumPost,
  decodeStoredMonadForumPost,
} from './monad-forum-post-client'

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
  { kind: 'post', title: 'Hello', message: 'First forum post' },
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
  const client = new MonadForumPostClient({
    pool,
    leaseManager,
    provider,
    httpClient,
    relayBaseUrl: 'https://relay.example.com/',
  })
  return { client, pool, leaseManager, provider, httpClient }
}

/** Encode a `MonadForumPostProto` via the real generated `MonadForumPost` binding -- used both to
 * build fixture bytes and (indirectly, via `decodeMonadForumPost`) to prove the module's own
 * decode path round-trips against it. */
function encodeForumPostPb(post: MonadForumPostProto): MonadForumPost {
  const pb = new MonadForumPost()
  pb.setTopic(post.topic)
  pb.setParentPostHash(post.parentPostHash)
  pb.setRawBurnTx(post.rawBurnTx)
  pb.setEncryptedPayload(post.encryptedPayload)
  pb.setPayloadHash(post.payloadHash)
  return pb
}

/** Builds the wire bytes a `PUT /message/monad/forum` (or `GET .../forum/:hash`'s nested `post`)
 * response would carry, via the real generated `StoredMonadForumPost` binding. */
function storedForumPostBytes(post: MonadForumPostProto): Uint8Array {
  const pb = new StoredMonadForumPost()
  pb.setPost(encodeForumPostPb(post))
  pb.setSenderAddress(getBytes('0x' + '11'.repeat(20)))
  pb.setTxHash(getBytes('0x' + '22'.repeat(32)))
  pb.setTimestamp(1_700_000_000_000)
  pb.setNetworkTag(new TextEncoder().encode('MONT'))
  return pb.serializeBinary()
}

/** Builds `GET /message/monad/forum/:payload_hash`'s `MonadForumPostView` response bytes. */
function forumPostViewBytes(post: MonadForumPostProto, voteWeight: number) {
  const view = new MonadForumPostView()
  view.setPost(
    StoredMonadForumPost.deserializeBinary(storedForumPostBytes(post)),
  )
  view.setVoteWeight(voteWeight)
  return view.serializeBinary()
}

function hexOf(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex')
}

describe('calldata / commitment construction', () => {
  it('computes payload_hash as plain SHA256(serialized payload)', () => {
    const payload = buildForumPostPayload({
      topic: 'general',
      entries: ENTRIES,
      timestampMs: 1_700_000_000_000,
    })
    const commitment = computeForumPostCommitment(payload)
    expect(getBytes(sha256(payload))).toEqual(commitment)
    expect(commitment).toHaveLength(32)
  })

  it('builds deterministic payload bytes for the same inputs (topic/entries/timestamp)', () => {
    const a = buildForumPostPayload({
      topic: 'general',
      entries: ENTRIES,
      timestampMs: 42,
    })
    const b = buildForumPostPayload({
      topic: 'general',
      entries: ENTRIES,
      timestampMs: 42,
    })
    expect(a).toEqual(b)
  })

  it('builds up-vote calldata as <FRUM><0x01><0x01><32-byte commitment>, 38 bytes total', () => {
    const commitment = new Uint8Array(32).fill(0xab)
    const calldata = buildForumVoteCalldata('up', commitment)
    const bytes = getBytes(calldata)

    expect(bytes).toHaveLength(38)
    expect(MONAD_FORUM_VOTE_CALLDATA_LENGTH).toBe(38)
    // "FRUM" == 0x4652554d -- FORUM_VOTE_LOKAD_ID (monad_forum_verify.rs:94).
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x46, 0x52, 0x55, 0x4d])
    // FORUM_COMMITMENT_VERSION_TAG (monad_forum_verify.rs:99).
    expect(bytes[4]).toBe(0x01)
    // VoteDirection::UP_BYTE (monad_forum_verify.rs:118).
    expect(bytes[5]).toBe(0x01)
    expect(Array.from(bytes.slice(6))).toEqual(Array.from(commitment))
  })

  it('builds down-vote calldata with direction byte 0x00', () => {
    const commitment = new Uint8Array(32).fill(0xcd)
    const calldata = buildForumVoteCalldata('down', commitment)
    const bytes = getBytes(calldata)

    expect(bytes).toHaveLength(38)
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x46, 0x52, 0x55, 0x4d])
    expect(bytes[4]).toBe(0x01)
    // VoteDirection::DOWN_BYTE (monad_forum_verify.rs:119).
    expect(bytes[5]).toBe(0x00)
    expect(Array.from(bytes.slice(6))).toEqual(Array.from(commitment))
  })

  it('rejects a commitment that is not exactly 32 bytes', () => {
    expect(() => buildForumVoteCalldata('up', new Uint8Array(31))).toThrow(
      /32 bytes/,
    )
  })

  it('matches a known-good fixture byte-for-byte', () => {
    const commitment = new Uint8Array(32)
    for (let i = 0; i < 32; i++) commitment[i] = i
    const calldata = getBytes(buildForumVoteCalldata('up', commitment))
    const expected = new Uint8Array([
      0x46,
      0x52,
      0x55,
      0x4d, // "FRUM"
      0x01, // version
      0x01, // up
      ...commitment,
    ])
    expect(calldata).toEqual(expected)
  })
})

describe('protobuf encode/decode round trip', () => {
  it('round-trips MonadForumPost through encode -> decode', () => {
    const post: MonadForumPostProto = {
      topic: 'general',
      parentPostHash: new Uint8Array(32).fill(0x77),
      rawBurnTx: new Uint8Array([1, 2, 3, 4]),
      encryptedPayload: new TextEncoder().encode('serialized payload'),
      payloadHash: new Uint8Array(32).fill(0x42),
    }
    const decoded = decodeMonadForumPost(
      encodeForumPostPb(post).serializeBinary(),
    )
    expect(decoded).toEqual(post)
  })

  it('round-trips a StoredMonadForumPost, including the nested MonadForumPost', () => {
    const post: MonadForumPostProto = {
      topic: 'general',
      parentPostHash: new Uint8Array(0),
      rawBurnTx: new Uint8Array([9, 9, 9]),
      encryptedPayload: new Uint8Array([7, 7]),
      payloadHash: new Uint8Array(32).fill(0x11),
    }
    const decoded = decodeStoredMonadForumPost(storedForumPostBytes(post))
    expect(decoded.post).toEqual(post)
    expect(decoded.senderAddress).toEqual(getBytes('0x' + '11'.repeat(20)))
    expect(decoded.txHash).toEqual(getBytes('0x' + '22'.repeat(32)))
    expect(decoded.timestamp).toBe(1_700_000_000_000)
    expect(decoded.networkTag).toEqual(new TextEncoder().encode('MONT'))
  })
})

describe('MonadForumPostClient.submitForumPost', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // `jest.mock('axios')` automocks every export, including `isAxiosError`, to a bare `jest.fn()`
    // returning `undefined` -- give it a real implementation so `submitForumPost`'s
    // `axios.isAxiosError(err)` branches work the same way they would against the real library.
    mockedAxios.isAxiosError.mockImplementation(
      (e: unknown) => (e as { isAxiosError?: boolean })?.isAxiosError === true,
    )
  })

  it('PUTs the assembled MonadForumPost and releases the lease as confirmed on 2xx', async () => {
    const { client, pool } = makeClient()

    const expectedPayload = buildForumPostPayload({
      topic: 'general',
      entries: ENTRIES,
      timestampMs: 1_700_000_000_000,
    })
    const expectedCommitment = computeForumPostCommitment(expectedPayload)

    mockedAxios.mockImplementationOnce(async config => {
      expect(config.method).toBe('put')
      expect(config.url).toBe('https://relay.example.com/message/monad/forum')
      expect(config.headers).toEqual({
        'Content-Type': 'application/x-protobuf',
      })
      const sentPost = decodeMonadForumPost(
        new Uint8Array(config.data as Buffer),
      )
      expect(sentPost.topic).toBe('general')
      expect(sentPost.payloadHash).toEqual(expectedCommitment)
      expect(sentPost.encryptedPayload).toEqual(expectedPayload)

      // The raw burn tx must be a validly-decodable, real signed transaction whose calldata
      // carries the same commitment plus the up-vote direction byte.
      const parsed = Transaction.from(hexOf(sentPost.rawBurnTx))
      const calldataBytes = getBytes(parsed.data)
      expect(calldataBytes.slice(0, 4)).toEqual(
        new Uint8Array([0x46, 0x52, 0x55, 0x4d]),
      )
      expect(calldataBytes[4]).toBe(0x01)
      expect(calldataBytes[5]).toBe(0x01) // up
      expect(calldataBytes.slice(6)).toEqual(expectedCommitment)
      expect(parsed.value).toBe(5_000n)

      return {
        data: storedForumPostBytes(sentPost),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    const result = await client.submitForumPost({
      topic: 'general',
      entries: ENTRIES,
      direction: 'up',
      burnAddress: BURN_ADDRESS,
      voteWeightWei: 5_000n,
      overrides: FEE_OVERRIDES,
      timestampMs: 1_700_000_000_000,
    })

    expect(result.stored.post?.topic).toBe('general')
    expect(result.payloadHashHex).toBe(
      Buffer.from(expectedCommitment).toString('hex'),
    )
    // Ticket #34: a confirmed release retires the account as 'spent' -- never back to 'available'.
    expect(pool.getRecord(result.leaseIndex)?.status).toBe('spent')
  })

  it('builds down-vote calldata for an initial down-vote post', async () => {
    const { client } = makeClient()
    mockedAxios.mockImplementationOnce(async config => {
      const sentPost = decodeMonadForumPost(
        new Uint8Array(config.data as Buffer),
      )
      const parsed = Transaction.from(hexOf(sentPost.rawBurnTx))
      const calldataBytes = getBytes(parsed.data)
      expect(calldataBytes[5]).toBe(0x00) // down
      return {
        data: storedForumPostBytes(sentPost),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    await client.submitForumPost({
      topic: 'general',
      entries: ENTRIES,
      direction: 'down',
      burnAddress: BURN_ADDRESS,
      voteWeightWei: 1_000n,
      overrides: FEE_OVERRIDES,
    })
  })

  it('retires the sub-account and throws MonadForumPostRejectedError on an HTTP error response', async () => {
    const { client, pool } = makeClient()
    mockedAxios.mockImplementationOnce(async () => {
      const err = Object.assign(new Error('Bad Request'), {
        isAxiosError: true,
        response: { status: 400, data: { error: 'invalid_forum_post' } },
      })
      throw err
    })

    await expect(
      client.submitForumPost({
        topic: 'general',
        entries: ENTRIES,
        direction: 'up',
        burnAddress: BURN_ADDRESS,
        voteWeightWei: 5_000n,
        overrides: FEE_OVERRIDES,
      }),
    ).rejects.toThrow(MonadForumPostRejectedError)

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
      // GET /message/monad/forum/:payload_hash
      getCalls++
      expect(config.url).toContain('/message/monad/forum/')
      const sentPost: MonadForumPostProto = {
        topic: 'general',
        parentPostHash: new Uint8Array(0),
        rawBurnTx: new Uint8Array([1]),
        encryptedPayload: new Uint8Array([2]),
        payloadHash: new Uint8Array(32).fill(0x9),
      }
      return {
        data: forumPostViewBytes(sentPost, 5_000),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    const result = await client.submitForumPost({
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

  it('retires as stuck and throws MonadForumPostAbandonedError when the fallback poll never finds it', async () => {
    const { client, pool } = makeClient()
    mockedAxios.mockImplementation(async () => {
      const networkErr = Object.assign(new Error('timeout'), {
        isAxiosError: true,
        response: undefined,
      })
      throw networkErr
    })

    await expect(
      client.submitForumPost({
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
    ).rejects.toThrow(MonadForumPostAbandonedError)

    const retired = pool.records().filter(r => r.status === 'retired')
    expect(retired).toHaveLength(1)
  })

  it('rejects an empty entries array before leasing anything', async () => {
    const { client, pool } = makeClient()
    await expect(
      client.submitForumPost({
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
