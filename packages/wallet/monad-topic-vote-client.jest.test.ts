/**
 * Unit tests for `monad-topic-vote-client.ts` (ticket #32).
 *
 * `axios` is mocked (`jest.mock('axios')`) so `PUT /message/monad/topics/vote` never touches a
 * real network — each test drives the mock to exercise one of `castVote`'s documented outcomes
 * (2xx success, HTTP-level rejection, network-failure abandonment). Burn-tx construction goes
 * through a real `MonadSubAccountPool`/`MonadAccountTxSigner` against a stubbed ethers
 * `JsonRpcProvider._perform` (same technique `monad-stamp-client.jest.test.ts`/
 * `monad-account-tx.jest.test.ts` use), so the signed raw tx and its calldata are real, decodable
 * bytes, not placeholders.
 */
import { JsonRpcProvider, Transaction, getBytes } from 'ethers'
import axios from 'axios'

import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadSubAccountPool } from './monad-account-pool'
import { BurnNotSentError, SubAccountLeaseManager } from './monad-account-lease'
import { MonadTxSubmitter } from './monad-account-tx'
import {
  defaultContext,
  topicVoteCommitment,
  validateFrame,
} from '@frank/codec'
import {
  MONAD_TOPIC_VOTE_CALLDATA_LENGTH,
  MonadTopicVoteAbandonedError,
  MonadTopicVoteClient,
  MonadTopicVoteProto,
  MonadTopicVoteRejectedError,
  StoredMonadTopicVoteEntryProto,
  buildCborMonadTopicVoteCalldata,
  buildMonadTopicVoteCalldata,
  decodeMonadTopicVote,
  decodeStoredMonadTopicVoteEntry,
  encodeMonadTopicVote,
} from './monad-topic-vote-client'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk'
const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD'
const CHAIN_ID = 10143
const TARGET_PAYLOAD_HASH = new Uint8Array(32).fill(0x77)

// Explicit fee/gas overrides for every `castVote` call below, so `ethers`' `populateTransaction`
// never needs to call `eth_feeHistory`/`eth_getBlockByNumber` (`getFeeData`) against the stub
// provider -- only `getTransactionCount`/`estimateGas` are stubbed (matching
// `monad-stamp-client.jest.test.ts`'s own precedent).
const FEE_OVERRIDES = {
  gasLimit: 60_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
}

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

function storedVoteEntryBytes(
  entry: StoredMonadTopicVoteEntryProto,
): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jspb = require('google-protobuf')
  const writer = new jspb.BinaryWriter()
  writer.writeBytes(1, entry.targetPayloadHash)
  writer.writeBytes(2, entry.senderAddress)
  writer.writeBytes(3, entry.txHash)
  writer.writeInt64(4, entry.timestamp)
  writer.writeSint64(5, entry.weight)
  return writer.getResultBuffer()
}

function makeClient(overrides?: {
  pool?: MonadSubAccountPool
  topicWriteFormat?: 'protobuf' | 'cbor'
  omitTopicWriteFormat?: boolean
}) {
  const pool = overrides?.pool ?? makePool()
  const leaseManager = new SubAccountLeaseManager(pool)
  const provider = makeChainProvider()
  const httpClient = makeMockHttpClient()
  const handle = {
    pool,
    leaseManager,
    provider,
    httpClient,
    relayBaseUrl: 'https://relay.example.com/',
    ...(overrides?.omitTopicWriteFormat
      ? {}
      : { topicWriteFormat: overrides?.topicWriteFormat ?? ('cbor' as const) }),
  }
  const client = new MonadTopicVoteClient(handle)
  return { client, pool, leaseManager, provider, httpClient }
}

function decodeCborVote(bytes: Uint8Array) {
  const result = validateFrame(bytes, defaultContext({ operation: 'typed' }))
  if (result.kind !== 'parsed' || result.typed?.type !== 11) {
    throw new Error('expected a typed type-11 topic vote')
  }
  return {
    targetPayloadHash: result.typed.targetHash,
    rawBurnTx: result.typed.burnTx,
    network: result.typed.network,
  }
}

describe('calldata construction', () => {
  it('preserves legacy v1 calldata by default', () => {
    const commitment = new Uint8Array(32).fill(0xab)
    const calldata = buildMonadTopicVoteCalldata('up', commitment)
    const bytes = getBytes(calldata)

    expect(bytes).toHaveLength(38)
    expect(MONAD_TOPIC_VOTE_CALLDATA_LENGTH).toBe(38)
    // "TPIC" == 0x54504943 -- TOPIC_VOTE_LOKAD_ID (monad_topic_verify.rs line 94).
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x54, 0x50, 0x49, 0x43])
    // TOPIC_COMMITMENT_VERSION_TAG (monad_topic_verify.rs line 99).
    expect(bytes[4]).toBe(0x01)
    // VoteDirection::UP_BYTE (monad_topic_verify.rs line 118).
    expect(bytes[5]).toBe(0x01)
    expect(Array.from(bytes.slice(6))).toEqual(Array.from(commitment))
  })

  it('encodes the down-vote direction byte as 0x00', () => {
    const commitment = new Uint8Array(32).fill(0xcd)
    const calldata = buildMonadTopicVoteCalldata('down', commitment)
    const bytes = getBytes(calldata)

    expect(bytes).toHaveLength(38)
    // VoteDirection::DOWN_BYTE (monad_topic_verify.rs line 120).
    expect(bytes[5]).toBe(0x00)
    expect(Array.from(bytes.slice(6))).toEqual(Array.from(commitment))
  })

  it('rejects a commitment that is not exactly 32 bytes', () => {
    expect(() => buildMonadTopicVoteCalldata('up', new Uint8Array(31))).toThrow(
      /32 bytes/,
    )
  })

  it('never hashes the commitment -- it is the target payload_hash verbatim', () => {
    // Distinct from `monad-stamp-client.ts`'s `buildMonadStampCalldata`, which is always paired
    // with a fresh `computeMonadStampCommitment` call: a topic vote has no payload of its own to
    // hash, so the commitment bytes passed in must appear byte-for-byte in the calldata's tail.
    const targetPayloadHash = new Uint8Array(32).fill(0x42)
    const calldata = buildMonadTopicVoteCalldata('up', targetPayloadHash)
    expect(Array.from(getBytes(calldata).slice(6))).toEqual(
      Array.from(targetPayloadHash),
    )
  })

  it('builds the explicit deterministic-CBOR v2 fixture', () => {
    const commitment = Uint8Array.from({ length: 32 }, (_, index) => index)
    expect(
      getBytes(buildCborMonadTopicVoteCalldata('down', commitment)),
    ).toEqual(
      new Uint8Array([0x54, 0x50, 0x49, 0x43, 0x02, 0x00, ...commitment]),
    )
  })
})

describe('protobuf encode/decode round trip', () => {
  it('round-trips MonadTopicVote through encode -> decode', () => {
    const vote: MonadTopicVoteProto = {
      targetPayloadHash: new Uint8Array(32).fill(0x42),
      rawBurnTx: new Uint8Array([1, 2, 3, 4]),
    }
    const decoded = decodeMonadTopicVote(encodeMonadTopicVote(vote))
    expect(decoded).toEqual(vote)
  })

  it('decodes a StoredMonadTopicVoteEntry, including a negative (down-vote) weight', () => {
    const entry: StoredMonadTopicVoteEntryProto = {
      targetPayloadHash: new Uint8Array(32).fill(0x11),
      senderAddress: getBytes('0x' + '22'.repeat(20)),
      txHash: getBytes('0x' + '33'.repeat(32)),
      timestamp: 1_700_000_000_000,
      weight: -5_000,
    }
    const decoded = decodeStoredMonadTopicVoteEntry(storedVoteEntryBytes(entry))
    expect(decoded).toEqual(entry)
  })

  it('decodes a positive (up-vote) weight', () => {
    const entry: StoredMonadTopicVoteEntryProto = {
      targetPayloadHash: new Uint8Array(32).fill(0x99),
      senderAddress: getBytes('0x' + '44'.repeat(20)),
      txHash: getBytes('0x' + '55'.repeat(32)),
      timestamp: 1_700_000_000_001,
      weight: 12_345,
    }
    const decoded = decodeStoredMonadTopicVoteEntry(storedVoteEntryBytes(entry))
    expect(decoded.weight).toBe(12_345)
  })
})

describe('MonadTopicVoteClient.castVote', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // `jest.mock('axios')` automocks every export, including `isAxiosError`, to a bare `jest.fn()`
    // returning `undefined` -- give it a real implementation so `castVote`'s
    // `axios.isAxiosError(err)` branches work the same way they would against the real library.
    mockedAxios.isAxiosError.mockImplementation(
      (e: unknown) => (e as { isAxiosError?: boolean })?.isAxiosError === true,
    )
  })

  it('signs the exact vote weight as the tx value -- not merely a minimum', async () => {
    // This is the whole point of a vote vs. a stamp burn (see this file's/module's header): the
    // burned value itself IS the weight. Use a deliberately odd, non-round value to prove nothing
    // rounds/floors/pads it on the way to `buildAndSignCall`.
    const { client } = makeClient()
    const oddWeightWei = 123_456_789_012_345n

    mockedAxios.mockImplementationOnce(async config => {
      const sentVote = decodeCborVote(new Uint8Array(config.data as Buffer))
      const parsed = Transaction.from(hexOf(sentVote.rawBurnTx))
      // The exact wei value signed into the tx must equal the requested vote weight exactly.
      expect(parsed.value).toBe(oddWeightWei)

      const stored: StoredMonadTopicVoteEntryProto = {
        targetPayloadHash: sentVote.targetPayloadHash,
        senderAddress: getBytes('0x' + '11'.repeat(20)),
        txHash: getBytes('0x' + '22'.repeat(32)),
        timestamp: 1_700_000_000_000,
        weight: Number(oddWeightWei),
      }
      return {
        data: storedVoteEntryBytes(stored),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    const result = await client.castVote({
      targetPayloadHash: TARGET_PAYLOAD_HASH,
      direction: 'up',
      burnAddress: BURN_ADDRESS,
      voteWeightWei: oddWeightWei,
      overrides: FEE_OVERRIDES,
    })

    expect(result.stored).toBeUndefined()
  })

  it('PUTs the assembled MonadTopicVote referencing the target payload_hash and releases the lease as confirmed on 2xx', async () => {
    const { client, pool } = makeClient()

    mockedAxios.mockImplementationOnce(async config => {
      expect(config.method).toBe('put')
      expect(config.url).toBe(
        'https://relay.example.com/message/monad/topics/vote',
      )
      expect(config.headers).toEqual({
        'Content-Type': 'application/cbor',
        'Accept': 'application/cbor',
      })
      const sentVote = decodeCborVote(new Uint8Array(config.data as Buffer))
      expect(sentVote.targetPayloadHash).toEqual(TARGET_PAYLOAD_HASH)

      // The raw burn tx must be a validly-decodable, real signed transaction whose calldata
      // commits to the target payload_hash (not a new hash of anything).
      const parsed = Transaction.from(hexOf(sentVote.rawBurnTx))
      expect(getBytes(parsed.data).slice(6)).toEqual(
        topicVoteCommitment('monad-testnet', TARGET_PAYLOAD_HASH),
      )
      expect(getBytes(parsed.data).slice(0, 4)).toEqual(
        new Uint8Array([0x54, 0x50, 0x49, 0x43]),
      )
      expect(getBytes(parsed.data)[5]).toBe(0x01) // up-vote
      expect(getBytes(parsed.data)[4]).toBe(0x02)
      expect(parsed.value).toBe(10_000n)
      expect(parsed.to?.toLowerCase()).toBe(BURN_ADDRESS.toLowerCase())

      const stored: StoredMonadTopicVoteEntryProto = {
        targetPayloadHash: sentVote.targetPayloadHash,
        senderAddress: getBytes('0x' + '11'.repeat(20)),
        txHash: getBytes('0x' + '22'.repeat(32)),
        timestamp: 1_700_000_000_000,
        weight: 10_000,
      }
      return {
        data: storedVoteEntryBytes(stored),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    const result = await client.castVote({
      targetPayloadHash: TARGET_PAYLOAD_HASH,
      direction: 'up',
      burnAddress: BURN_ADDRESS,
      voteWeightWei: 10_000n,
      overrides: FEE_OVERRIDES,
    })

    expect(result.targetPayloadHashHex).toBe(hexNoPrefix(TARGET_PAYLOAD_HASH))
    expect(result.stored).toBeUndefined()
    // Ticket #34: a confirmed release retires the account as 'spent' -- permanently excluded from
    // future selection, never back to 'available' for reuse.
    expect(pool.getRecord(result.leaseIndex)?.status).toBe('spent')
  })

  it('encodes a down-vote direction byte in the signed calldata', async () => {
    const { client } = makeClient()

    mockedAxios.mockImplementationOnce(async config => {
      const sentVote = decodeCborVote(new Uint8Array(config.data as Buffer))
      const parsed = Transaction.from(hexOf(sentVote.rawBurnTx))
      expect(getBytes(parsed.data)[5]).toBe(0x00) // down-vote

      const stored: StoredMonadTopicVoteEntryProto = {
        targetPayloadHash: sentVote.targetPayloadHash,
        senderAddress: getBytes('0x' + '11'.repeat(20)),
        txHash: getBytes('0x' + '22'.repeat(32)),
        timestamp: 1_700_000_000_000,
        weight: -5_000,
      }
      return {
        data: storedVoteEntryBytes(stored),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    const result = await client.castVote({
      targetPayloadHash: TARGET_PAYLOAD_HASH,
      direction: 'down',
      burnAddress: BURN_ADDRESS,
      voteWeightWei: 5_000n,
      overrides: FEE_OVERRIDES,
    })

    expect(result.stored).toBeUndefined()
  })

  it('keeps protobuf as the default write format until CBOR read views are frozen', async () => {
    const { client } = makeClient({ omitTopicWriteFormat: true })
    mockedAxios.mockImplementationOnce(async config => {
      expect(config.headers).toEqual({
        'Content-Type': 'application/x-protobuf',
        'Accept': 'application/x-protobuf',
      })
      const sent = decodeMonadTopicVote(new Uint8Array(config.data as Buffer))
      expect(sent.targetPayloadHash).toEqual(TARGET_PAYLOAD_HASH)
      expect(getBytes(Transaction.from(hexOf(sent.rawBurnTx)).data)[4]).toBe(
        0x01,
      )
      const stored: StoredMonadTopicVoteEntryProto = {
        targetPayloadHash: sent.targetPayloadHash,
        senderAddress: getBytes('0x' + '11'.repeat(20)),
        txHash: getBytes('0x' + '22'.repeat(32)),
        timestamp: 1_700_000_000_000,
        weight: 5_000,
      }
      return {
        data: storedVoteEntryBytes(stored),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    const result = await client.castVote({
      targetPayloadHash: TARGET_PAYLOAD_HASH,
      direction: 'up',
      burnAddress: BURN_ADDRESS,
      voteWeightWei: 5_000n,
      overrides: FEE_OVERRIDES,
    })
    expect(result.stored?.weight).toBe(5_000)
  })

  it('retires the sub-account and throws MonadTopicVoteRejectedError on an HTTP error response', async () => {
    const { client, pool } = makeClient()
    mockedAxios.mockImplementationOnce(async () => {
      const err = Object.assign(new Error('Bad Request'), {
        isAxiosError: true,
        response: { status: 400, data: { error: 'invalid_topic_vote' } },
      })
      throw err
    })

    await expect(
      client.castVote({
        targetPayloadHash: TARGET_PAYLOAD_HASH,
        direction: 'up',
        burnAddress: BURN_ADDRESS,
        voteWeightWei: 10_000n,
        overrides: FEE_OVERRIDES,
      }),
    ).rejects.toThrow(MonadTopicVoteRejectedError)

    // Every sub-account in the pool must now be 'retired' (only one was leased; find it).
    const retired = pool.records().filter(r => r.status === 'retired')
    expect(retired).toHaveLength(1)
  })

  it('retires as stuck on a machine-readable post-broadcast unknown outcome', async () => {
    const { client, pool } = makeClient()
    mockedAxios.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Service Unavailable'), {
        isAxiosError: true,
        response: {
          status: 503,
          data: { error: 'topic_burn_outcome_unknown' },
        },
      })
    })

    await expect(
      client.castVote({
        targetPayloadHash: TARGET_PAYLOAD_HASH,
        direction: 'up',
        burnAddress: BURN_ADDRESS,
        voteWeightWei: 10_000n,
        overrides: FEE_OVERRIDES,
      }),
    ).rejects.toThrow(MonadTopicVoteAbandonedError)
    expect(
      pool.records().filter(record => record.status === 'retired'),
    ).toHaveLength(1)
  })

  it('retires as stuck and throws MonadTopicVoteAbandonedError on a network-level failure -- no read-back fallback in this ticket scope', async () => {
    const { client, pool } = makeClient()
    mockedAxios.mockImplementationOnce(async () => {
      const networkErr = Object.assign(new Error('socket hang up'), {
        isAxiosError: true,
        response: undefined,
      })
      throw networkErr
    })

    await expect(
      client.castVote({
        targetPayloadHash: TARGET_PAYLOAD_HASH,
        direction: 'up',
        burnAddress: BURN_ADDRESS,
        voteWeightWei: 10_000n,
        overrides: FEE_OVERRIDES,
      }),
    ).rejects.toThrow(MonadTopicVoteAbandonedError)

    // Unlike `monad-stamp-client.ts`, there is no fallback GET poll available in this ticket's
    // scope -- a network failure always retires immediately, never confirms.
    const retired = pool.records().filter(r => r.status === 'retired')
    expect(retired).toHaveLength(1)
  })

  it('returns the untouched account to available and throws BurnNotSentError when signing itself throws (#273)', async () => {
    const { client, pool } = makeClient()

    await expect(
      client.castVote({
        targetPayloadHash: TARGET_PAYLOAD_HASH,
        direction: 'up',
        // Not a valid address -- ethers rejects this during populateTransaction/signing, before
        // any HTTP call is made.
        burnAddress: 'not-an-address',
        voteWeightWei: 10_000n,
        overrides: FEE_OVERRIDES,
      }),
    ).rejects.toBeInstanceOf(BurnNotSentError)

    expect(mockedAxios).not.toHaveBeenCalled()
    // Nothing was signed or sent: no account is retired or left leased.
    expect(pool.records().filter(r => r.status === 'retired')).toHaveLength(0)
    expect(pool.records().filter(r => r.status === 'in-use')).toHaveLength(0)
  })

  it("leases exactly the requested funded account instead of the pool's next one (#273)", async () => {
    const pool = makePool(3)
    pool.setStatus(0, 'available')
    pool.setStatus(1, 'retired')
    pool.setStatus(2, 'available')
    const { client } = makeClient({ pool })
    mockedAxios.mockImplementationOnce(async config => ({
      data: storedVoteEntryBytes({
        targetPayloadHash: TARGET_PAYLOAD_HASH,
        senderAddress: getBytes('0x' + '11'.repeat(20)),
        txHash: getBytes('0x' + '22'.repeat(32)),
        timestamp: 1_700_000_000_000,
        weight: 10_000,
      }),
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }))

    const result = await client.castVote({
      targetPayloadHash: TARGET_PAYLOAD_HASH,
      direction: 'up',
      burnAddress: BURN_ADDRESS,
      voteWeightWei: 10_000n,
      overrides: FEE_OVERRIDES,
      leaseIndex: 2,
    })

    expect(result.leaseIndex).toBe(2)
    expect(pool.getRecord(2)?.status).toBe('spent')
    expect(pool.getRecord(0)?.status).toBe('available')
  })

  it('rejects a targetPayloadHash that is not exactly 32 bytes before leasing anything', async () => {
    const { client, pool } = makeClient()

    await expect(
      client.castVote({
        targetPayloadHash: new Uint8Array(31),
        direction: 'up',
        burnAddress: BURN_ADDRESS,
        voteWeightWei: 10_000n,
        overrides: FEE_OVERRIDES,
      }),
    ).rejects.toThrow(/32 bytes/)

    // No lease should have been acquired/consumed at all.
    expect(pool.records().every(r => r.status === 'available')).toBe(true)
  })

  it('rejects a negative voteWeightWei before leasing anything', async () => {
    const { client, pool } = makeClient()

    await expect(
      client.castVote({
        targetPayloadHash: TARGET_PAYLOAD_HASH,
        direction: 'up',
        burnAddress: BURN_ADDRESS,
        voteWeightWei: -1n,
        overrides: FEE_OVERRIDES,
      }),
    ).rejects.toThrow(/nonnegative/)

    expect(pool.records().every(r => r.status === 'available')).toBe(true)
  })
})

function hexOf(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex')
}

function hexNoPrefix(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}
