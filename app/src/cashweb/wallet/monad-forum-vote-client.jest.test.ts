/**
 * Unit tests for `monad-forum-vote-client.ts` (ticket #32).
 *
 * `axios` is mocked (`jest.mock('axios')`) so `PUT /message/monad/forum/vote` never touches a
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
import { SubAccountLeaseManager } from './monad-account-lease'
import { MonadTxSubmitter } from './monad-account-tx'
import {
  MONAD_FORUM_VOTE_CALLDATA_LENGTH,
  MonadForumVoteAbandonedError,
  MonadForumVoteClient,
  MonadForumVoteProto,
  MonadForumVoteRejectedError,
  StoredMonadForumVoteEntryProto,
  buildMonadForumVoteCalldata,
  decodeMonadForumVote,
  decodeStoredMonadForumVoteEntry,
  encodeMonadForumVote,
} from './monad-forum-vote-client'

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
  entry: StoredMonadForumVoteEntryProto,
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

function makeClient(overrides?: { pool?: MonadSubAccountPool }) {
  const pool = overrides?.pool ?? makePool()
  const leaseManager = new SubAccountLeaseManager(pool)
  const provider = makeChainProvider()
  const httpClient = makeMockHttpClient()
  const client = new MonadForumVoteClient({
    pool,
    leaseManager,
    provider,
    httpClient,
    relayBaseUrl: 'https://relay.example.com/',
  })
  return { client, pool, leaseManager, provider, httpClient }
}

describe('calldata construction', () => {
  it('builds calldata as <FRUM><0x01><direction><32-byte commitment>, 38 bytes total (up)', () => {
    const commitment = new Uint8Array(32).fill(0xab)
    const calldata = buildMonadForumVoteCalldata('up', commitment)
    const bytes = getBytes(calldata)

    expect(bytes).toHaveLength(38)
    expect(MONAD_FORUM_VOTE_CALLDATA_LENGTH).toBe(38)
    // "FRUM" == 0x4652554d -- FORUM_VOTE_LOKAD_ID (monad_forum_verify.rs line 94).
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x46, 0x52, 0x55, 0x4d])
    // FORUM_COMMITMENT_VERSION_TAG (monad_forum_verify.rs line 99).
    expect(bytes[4]).toBe(0x01)
    // VoteDirection::UP_BYTE (monad_forum_verify.rs line 118).
    expect(bytes[5]).toBe(0x01)
    expect(Array.from(bytes.slice(6))).toEqual(Array.from(commitment))
  })

  it('encodes the down-vote direction byte as 0x00', () => {
    const commitment = new Uint8Array(32).fill(0xcd)
    const calldata = buildMonadForumVoteCalldata('down', commitment)
    const bytes = getBytes(calldata)

    expect(bytes).toHaveLength(38)
    // VoteDirection::DOWN_BYTE (monad_forum_verify.rs line 120).
    expect(bytes[5]).toBe(0x00)
    expect(Array.from(bytes.slice(6))).toEqual(Array.from(commitment))
  })

  it('rejects a commitment that is not exactly 32 bytes', () => {
    expect(() => buildMonadForumVoteCalldata('up', new Uint8Array(31))).toThrow(
      /32 bytes/,
    )
  })

  it('never hashes the commitment -- it is the target payload_hash verbatim', () => {
    // Distinct from `monad-stamp-client.ts`'s `buildMonadStampCalldata`, which is always paired
    // with a fresh `computeMonadStampCommitment` call: a forum vote has no payload of its own to
    // hash, so the commitment bytes passed in must appear byte-for-byte in the calldata's tail.
    const targetPayloadHash = new Uint8Array(32).fill(0x42)
    const calldata = buildMonadForumVoteCalldata('up', targetPayloadHash)
    expect(Array.from(getBytes(calldata).slice(6))).toEqual(
      Array.from(targetPayloadHash),
    )
  })
})

describe('protobuf encode/decode round trip', () => {
  it('round-trips MonadForumVote through encode -> decode', () => {
    const vote: MonadForumVoteProto = {
      targetPayloadHash: new Uint8Array(32).fill(0x42),
      rawBurnTx: new Uint8Array([1, 2, 3, 4]),
    }
    const decoded = decodeMonadForumVote(encodeMonadForumVote(vote))
    expect(decoded).toEqual(vote)
  })

  it('decodes a StoredMonadForumVoteEntry, including a negative (down-vote) weight', () => {
    const entry: StoredMonadForumVoteEntryProto = {
      targetPayloadHash: new Uint8Array(32).fill(0x11),
      senderAddress: getBytes('0x' + '22'.repeat(20)),
      txHash: getBytes('0x' + '33'.repeat(32)),
      timestamp: 1_700_000_000_000,
      weight: -5_000,
    }
    const decoded = decodeStoredMonadForumVoteEntry(storedVoteEntryBytes(entry))
    expect(decoded).toEqual(entry)
  })

  it('decodes a positive (up-vote) weight', () => {
    const entry: StoredMonadForumVoteEntryProto = {
      targetPayloadHash: new Uint8Array(32).fill(0x99),
      senderAddress: getBytes('0x' + '44'.repeat(20)),
      txHash: getBytes('0x' + '55'.repeat(32)),
      timestamp: 1_700_000_000_001,
      weight: 12_345,
    }
    const decoded = decodeStoredMonadForumVoteEntry(storedVoteEntryBytes(entry))
    expect(decoded.weight).toBe(12_345)
  })
})

describe('MonadForumVoteClient.castVote', () => {
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
      const sentVote = decodeMonadForumVote(
        new Uint8Array(config.data as Buffer),
      )
      const parsed = Transaction.from(hexOf(sentVote.rawBurnTx))
      // The exact wei value signed into the tx must equal the requested vote weight exactly.
      expect(parsed.value).toBe(oddWeightWei)

      const stored: StoredMonadForumVoteEntryProto = {
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

    expect(result.stored.weight).toBe(Number(oddWeightWei))
  })

  it('PUTs the assembled MonadForumVote referencing the target payload_hash and releases the lease as confirmed on 2xx', async () => {
    const { client, pool } = makeClient()

    mockedAxios.mockImplementationOnce(async config => {
      expect(config.method).toBe('put')
      expect(config.url).toBe(
        'https://relay.example.com/message/monad/forum/vote',
      )
      expect(config.headers).toEqual({
        'Content-Type': 'application/x-protobuf',
      })
      const sentVote = decodeMonadForumVote(
        new Uint8Array(config.data as Buffer),
      )
      expect(sentVote.targetPayloadHash).toEqual(TARGET_PAYLOAD_HASH)

      // The raw burn tx must be a validly-decodable, real signed transaction whose calldata
      // commits to the target payload_hash (not a new hash of anything).
      const parsed = Transaction.from(hexOf(sentVote.rawBurnTx))
      expect(getBytes(parsed.data).slice(6)).toEqual(TARGET_PAYLOAD_HASH)
      expect(getBytes(parsed.data).slice(0, 4)).toEqual(
        new Uint8Array([0x46, 0x52, 0x55, 0x4d]),
      )
      expect(getBytes(parsed.data)[5]).toBe(0x01) // up-vote
      expect(parsed.value).toBe(10_000n)
      expect(parsed.to?.toLowerCase()).toBe(BURN_ADDRESS.toLowerCase())

      const stored: StoredMonadForumVoteEntryProto = {
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
    expect(result.stored.weight).toBe(10_000)
    // Ticket #34: a confirmed release retires the account as 'spent' -- permanently excluded from
    // future selection, never back to 'available' for reuse.
    expect(pool.getRecord(result.leaseIndex)?.status).toBe('spent')
  })

  it('encodes a down-vote direction byte in the signed calldata', async () => {
    const { client } = makeClient()

    mockedAxios.mockImplementationOnce(async config => {
      const sentVote = decodeMonadForumVote(
        new Uint8Array(config.data as Buffer),
      )
      const parsed = Transaction.from(hexOf(sentVote.rawBurnTx))
      expect(getBytes(parsed.data)[5]).toBe(0x00) // down-vote

      const stored: StoredMonadForumVoteEntryProto = {
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

    expect(result.stored.weight).toBe(-5_000)
  })

  it('retires the sub-account and throws MonadForumVoteRejectedError on an HTTP error response', async () => {
    const { client, pool } = makeClient()
    mockedAxios.mockImplementationOnce(async () => {
      const err = Object.assign(new Error('Bad Request'), {
        isAxiosError: true,
        response: { status: 400, data: { error: 'invalid_forum_vote' } },
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
    ).rejects.toThrow(MonadForumVoteRejectedError)

    // Every sub-account in the pool must now be 'retired' (only one was leased; find it).
    const retired = pool.records().filter(r => r.status === 'retired')
    expect(retired).toHaveLength(1)
  })

  it('retires as stuck and throws MonadForumVoteAbandonedError on a network-level failure -- no read-back fallback in this ticket scope', async () => {
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
    ).rejects.toThrow(MonadForumVoteAbandonedError)

    // Unlike `monad-stamp-client.ts`, there is no fallback GET poll available in this ticket's
    // scope -- a network failure always retires immediately, never confirms.
    const retired = pool.records().filter(r => r.status === 'retired')
    expect(retired).toHaveLength(1)
  })

  it('retires the sub-account and rethrows without ever calling axios when signing itself throws', async () => {
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
    ).rejects.toThrow()

    expect(mockedAxios).not.toHaveBeenCalled()
    const retired = pool.records().filter(r => r.status === 'retired')
    expect(retired).toHaveLength(1)
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
