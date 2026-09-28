/**
 * Unit tests for `monad-stamp-client.ts` (ticket #13).
 *
 * `axios` is mocked (`jest.mock('axios')`) so `PUT /message/monad` / `GET
 * /message/monad/:payload_hash` never touch a real network — each test drives the mock to exercise
 * one of `submitStampedMessage`'s documented outcomes (2xx success, HTTP-level rejection,
 * network-failure-then-found-via-poll, network-failure-then-abandoned). Burn-tx construction goes
 * through a real `MonadSubAccountPool`/`MonadAccountTxSigner` against a stubbed ethers
 * `JsonRpcProvider._perform` (same technique `monad-account-tx.jest.test.ts` uses), so the signed
 * raw tx and its calldata are real, decodable bytes, not placeholders.
 */
import { JsonRpcProvider, Transaction, getBytes, sha256 } from 'ethers'
import axios from 'axios'

import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadSubAccountPool } from './monad-account-pool'
import { SubAccountLeaseManager } from './monad-account-lease'
import { MonadTxSubmitter } from './monad-account-tx'
import {
  MonadStampAbandonedError,
  MonadStampClient,
  MonadStampRejectedError,
  MONAD_STAMP_CALLDATA_LENGTH,
  buildMonadStampCalldata,
  computeMonadStampCommitment,
  decodeMonadStampedMessage,
  decodeStoredMonadMessage,
  encodeMonadStampedMessage,
  MonadStampedMessageProto,
  StoredMonadMessageProto,
} from './monad-stamp-client'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk'
const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD'
const CHAIN_ID = 10143

// Explicit fee/gas overrides for every `submitStampedMessage` call below, so `ethers`'
// `populateTransaction` never needs to call `eth_feeHistory`/`eth_getBlockByNumber` (`getFeeData`)
// against the stub provider -- only `getTransactionCount`/`estimateGas` are stubbed (matching
// `monad-account-tx.jest.test.ts`'s own "does not re-fetch nonce/gas when overrides are supplied"
// precedent).
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

function storedMessageBytes(message: MonadStampedMessageProto): Uint8Array {
  const stored: StoredMonadMessageProto = {
    message,
    senderAddress: getBytes('0x' + '11'.repeat(20)),
    txHash: getBytes('0x' + '22'.repeat(32)),
    timestamp: 1_700_000_000_000,
    // Ticket #39: exercise a nonzero network_tag through the round trip below too, so
    // `decodeStoredMonadMessage` is proven to decode field 5 correctly, not just fields 1-4.
    networkTag: new TextEncoder().encode('MONT'),
  }
  // Hand-encode a StoredMonadMessage the same way the relay's protobuf response would be encoded on
  // the wire, using the same primitives `encodeMonadStampedMessage` uses (see that function and its
  // module header for why there's no generated jspb class here).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jspb = require('google-protobuf')
  const writer = new jspb.BinaryWriter()
  writer.writeBytes(
    1,
    encodeMonadStampedMessage(stored.message as MonadStampedMessageProto),
  )
  writer.writeBytes(2, stored.senderAddress)
  writer.writeBytes(3, stored.txHash)
  writer.writeInt64(4, stored.timestamp)
  writer.writeBytes(5, stored.networkTag)
  return writer.getResultBuffer()
}

function makeClient(overrides?: { pool?: MonadSubAccountPool }) {
  const pool = overrides?.pool ?? makePool()
  const leaseManager = new SubAccountLeaseManager(pool)
  const provider = makeChainProvider()
  const httpClient = makeMockHttpClient()
  const client = new MonadStampClient({
    pool,
    leaseManager,
    provider,
    httpClient,
    relayBaseUrl: 'https://relay.example.com/',
  })
  return { client, pool, leaseManager, provider, httpClient }
}

describe('calldata / commitment construction', () => {
  it('computes h_m as plain SHA256(encrypted_payload) -- no pubkey folded in', () => {
    const payload = new TextEncoder().encode('hello, monad')
    const commitment = computeMonadStampCommitment(payload)
    expect(getBytes(sha256(payload))).toEqual(commitment)
    expect(commitment).toHaveLength(32)
  })

  it('builds calldata as <POND><0x01><32-byte commitment>, 37 bytes total', () => {
    const commitment = new Uint8Array(32).fill(0xab)
    const calldata = buildMonadStampCalldata(commitment)
    const bytes = getBytes(calldata)

    expect(bytes).toHaveLength(37)
    expect(MONAD_STAMP_CALLDATA_LENGTH).toBe(37)
    // "POND" == 0x504f4e44 -- BROADCAST_MESSAGE_LOKAD_ID
    // (backend/cashweb/cashweb-payload/src/verify.rs:15).
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4f, 0x4e, 0x44])
    // COMMITMENT_VERSION_TAG (monad_stamp_verify.rs:66).
    expect(bytes[4]).toBe(0x01)
    expect(Array.from(bytes.slice(5))).toEqual(Array.from(commitment))
  })

  it('rejects a commitment that is not exactly 32 bytes', () => {
    expect(() => buildMonadStampCalldata(new Uint8Array(31))).toThrow(
      /32 bytes/,
    )
  })
})

describe('protobuf encode/decode round trip', () => {
  it('round-trips MonadStampedMessage through encode -> decode', () => {
    const message: MonadStampedMessageProto = {
      rawBurnTx: new Uint8Array([1, 2, 3, 4]),
      encryptedPayload: new TextEncoder().encode('super secret'),
      payloadHash: new Uint8Array(32).fill(0x42),
    }
    const decoded = decodeMonadStampedMessage(
      encodeMonadStampedMessage(message),
    )
    expect(decoded).toEqual(message)
  })

  it('round-trips a StoredMonadMessage, including the nested MonadStampedMessage', () => {
    const message: MonadStampedMessageProto = {
      rawBurnTx: new Uint8Array([9, 9, 9]),
      encryptedPayload: new Uint8Array([7, 7]),
      payloadHash: new Uint8Array(32).fill(0x11),
    }
    const decoded = decodeStoredMonadMessage(storedMessageBytes(message))
    expect(decoded.message).toEqual(message)
    expect(decoded.senderAddress).toEqual(getBytes('0x' + '11'.repeat(20)))
    expect(decoded.txHash).toEqual(getBytes('0x' + '22'.repeat(32)))
    expect(decoded.timestamp).toBe(1_700_000_000_000)
    // Ticket #39: network_tag (field 5) round-trips through the real generated bindings.
    expect(decoded.networkTag).toEqual(new TextEncoder().encode('MONT'))
  })
})

describe('MonadStampClient.submitStampedMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // `jest.mock('axios')` automocks every export, including `isAxiosError`, to a bare `jest.fn()`
    // returning `undefined` -- give it a real implementation so `submitStampedMessage`'s
    // `axios.isAxiosError(err)` branches work the same way they would against the real library.
    mockedAxios.isAxiosError.mockImplementation(
      (e: unknown) => (e as { isAxiosError?: boolean })?.isAxiosError === true,
    )
  })

  it('PUTs the assembled MonadStampedMessage and releases the lease as confirmed on 2xx', async () => {
    const { client, pool } = makeClient()
    const encryptedPayload = new TextEncoder().encode('hi')
    const expectedCommitment = computeMonadStampCommitment(encryptedPayload)

    mockedAxios.mockImplementationOnce(async config => {
      expect(config.method).toBe('put')
      expect(config.url).toBe('https://relay.example.com/message/monad')
      const sentMessage = decodeMonadStampedMessage(
        new Uint8Array(config.data as Buffer),
      )
      expect(sentMessage.encryptedPayload).toEqual(encryptedPayload)
      expect(sentMessage.payloadHash).toEqual(expectedCommitment)
      // The raw burn tx must be a validly-decodable, real signed transaction whose calldata carries
      // the same commitment.
      const parsed = Transaction.from(hexOf(sentMessage.rawBurnTx))
      expect(getBytes(parsed.data).slice(5)).toEqual(expectedCommitment)

      return {
        data: storedMessageBytes(sentMessage),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    const result = await client.submitStampedMessage({
      encryptedPayload,
      destinationAddress: BURN_ADDRESS,
      stampValueWei: 10_000n,
      overrides: FEE_OVERRIDES,
    })

    expect(result.payloadHashHex).toBe(hexNoPrefix(expectedCommitment))
    expect(result.stored.message?.payloadHash).toEqual(expectedCommitment)
    // Ticket #34: a confirmed release retires the account as 'spent' -- permanently excluded from
    // future selection, never back to 'available' for reuse.
    expect(pool.getRecord(result.leaseIndex)?.status).toBe('spent')
  })

  it('retires the sub-account and throws MonadStampRejectedError on an HTTP error response', async () => {
    const { client, pool } = makeClient()
    mockedAxios.mockImplementationOnce(async () => {
      const err = Object.assign(new Error('Bad Request'), {
        isAxiosError: true,
        response: { status: 400, data: { error: 'invalid_monad_message' } },
      })
      throw err
    })

    await expect(
      client.submitStampedMessage({
        encryptedPayload: new TextEncoder().encode('rejected'),
        destinationAddress: BURN_ADDRESS,
        stampValueWei: 10_000n,
        overrides: FEE_OVERRIDES,
      }),
    ).rejects.toThrow(MonadStampRejectedError)

    // Every sub-account in the pool must now be 'retired' (only one was leased; find it).
    const retired = pool.records().filter(r => r.status === 'retired')
    expect(retired).toHaveLength(1)
  })

  it('falls back to polling GET and confirms when a network failure is followed by a found message', async () => {
    const { client, pool } = makeClient()
    const encryptedPayload = new TextEncoder().encode('flaky network')

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
      // GET /message/monad/:payload_hash
      getCalls++
      const sentMessage: MonadStampedMessageProto = {
        rawBurnTx: new Uint8Array([1]),
        encryptedPayload,
        payloadHash: computeMonadStampCommitment(encryptedPayload),
      }
      return {
        data: storedMessageBytes(sentMessage),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    const result = await client.submitStampedMessage({
      encryptedPayload,
      destinationAddress: BURN_ADDRESS,
      stampValueWei: 10_000n,
      overrides: FEE_OVERRIDES,
      abandonPoll: {
        maxAttempts: 2,
        intervalMs: 0,
        sleep: async () => undefined,
      },
    })

    expect(putCalls).toBe(1)
    expect(getCalls).toBe(1)
    expect(result.stored.message?.encryptedPayload).toEqual(encryptedPayload)
    // Ticket #34: same as above -- confirmed means 'spent', never 'available' again.
    expect(pool.getRecord(result.leaseIndex)?.status).toBe('spent')
  })

  it('retires as stuck and throws MonadStampAbandonedError when the fallback poll never finds it', async () => {
    const { client, pool } = makeClient()
    mockedAxios.mockImplementation(async () => {
      const networkErr = Object.assign(new Error('timeout'), {
        isAxiosError: true,
        response: undefined,
      })
      throw networkErr
    })

    await expect(
      client.submitStampedMessage({
        encryptedPayload: new TextEncoder().encode('lost forever'),
        destinationAddress: BURN_ADDRESS,
        stampValueWei: 10_000n,
        overrides: FEE_OVERRIDES,
        abandonPoll: {
          maxAttempts: 2,
          intervalMs: 0,
          sleep: async () => undefined,
        },
      }),
    ).rejects.toThrow(MonadStampAbandonedError)

    const retired = pool.records().filter(r => r.status === 'retired')
    expect(retired).toHaveLength(1)
  })
})

function hexOf(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex')
}

function hexNoPrefix(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}
