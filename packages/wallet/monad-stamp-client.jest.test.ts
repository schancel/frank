import { deriveRoleLeaves } from '../role-keys/src'
import { canonicalAdmissionPool } from './evm-input-admission'
import * as canonicalMailboxModule from '@frank/cashweb/relay/monad-mailbox-client'
import { freezeCanonicalRequest, type CanonicalFetch } from '@frank/cashweb/relay/canonical-dm-transport'
import { canonicalStampDestination } from '@frank/cashweb/relay/canonical-dm-stamp'
import { inspectCanonicalPreparedEnvelope } from './monad-stamp-stealth'
/**
 * Unit tests for `monad-stamp-client.ts` (ticket #13).
 *
 * `axios` is mocked (`jest.mock('axios')`) so `PUT /message/monad` never touches a real network
 * (there is no sender-side GET any more: PR #197 removed `GET /message/monad/:payload_hash`; an
 * idempotent re-PUT of the same exact bytes is the confirmation) — each test drives the mock to exercise
 * one of `submitStampedMessage`'s documented outcomes (2xx success, HTTP-level rejection,
 * network-failure-then-idempotent-re-PUT, 503 `mailbox_retryable` retries, 409/422 terminal
 * verdicts, 404 mailbox-disabled, retry exhaustion). Payment construction goes
 * through a real `MonadSubAccountPool`/`MonadAccountTxSigner` against a stubbed ethers
 * `JsonRpcProvider._perform` (same technique `monad-account-tx.jest.test.ts` uses), so the signed
 * raw tx and its calldata are real, decodable bytes, not placeholders.
 */
import {
  JsonRpcProvider,
  Wallet,
  SigningKey,
  Transaction,
  TransactionResponse,
  TransactionReceipt,
  computeAddress,
  getBytes,
  hexlify,
  getAddress,
  sha256,
} from 'ethers'
import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios'

import { MonadMailboxUnavailableError } from '@frank/cashweb/relay/monad-mailbox-client'
import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadSubAccountPool } from './monad-account-pool'
import { SubAccountLeaseManager } from './monad-account-lease'
import { MonadAccountTxSigner, MonadTxSubmitter } from './monad-account-tx'
import { MonadChangePool } from './monad-change-pool'
import {
  InMemoryStampAttemptJournal,
  LevelStampAttemptJournal,
  LevelCanonicalStampAttemptJournal,
  StampAttemptJournal,
} from './storage/stamp-attempt-journal'
import {
  MonadStampAbandonedError,
  MonadStampClient,
  MonadStampRejectedError,
  MonadStampPendingAttemptError,
  MonadStampRecoveredAttemptError,
  MonadStampTerminalError,
  MONAD_STAMP_CALLDATA_LENGTH,
  buildMonadStampCalldata,
  computeMonadStampCommitment,
  computeMonadStampPaymentCommitment,
  decodeMonadStampedMessage,
  decodeStoredMonadMessage,
  encodeMonadStampedMessage,
  quoteMonadStampPaymentGasReserve,
  recoverMonadStampPayments,
  sweepRecoveredMonadStampPayment,
  STAMP_FEE_CACHE_TTL_MS,
  MonadStampedMessageProto,
  StoredMonadMessageProto,
} from './monad-stamp-client'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk'
const RECIPIENT_PUBLIC_KEY = getBytes(
  SigningKey.computePublicKey(`0x${'44'.repeat(32)}`, true),
)
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
  perform: (req: {
    method: string
    transaction?: { data?: string }
  }) => Promise<unknown>,
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
    if (req.method === 'getBalance') return '0xde0b6b3a7640000'
    throw new Error(`unexpected _perform: ${req.method}`)
  })
}

function makeCapacityProvider(capacities: bigint[]) {
  let nonce = 0
  let balanceRead = 0
  const feeReserve = FEE_OVERRIDES.gasLimit * FEE_OVERRIDES.maxFeePerGas
  return makeStubProvider(async req => {
    if (req.method === 'getTransactionCount') {
      return `0x${(nonce++).toString(16)}`
    }
    if (req.method === 'estimateGas') return '0x5208'
    if (req.method === 'getBalance') {
      const capacity = capacities[balanceRead++] ?? 0n
      return `0x${(feeReserve + capacity).toString(16)}`
    }
    throw new Error(`unexpected _perform: ${req.method}`)
  })
}

function storedMessageBytes(message: MonadStampedMessageProto): Uint8Array {
  const stored: StoredMonadMessageProto = {
    message,
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
  writer.writeInt64(4, stored.timestamp)
  writer.writeBytes(5, stored.networkTag)
  return writer.getResultBuffer()
}

function makeClient(overrides?: {
  pool?: MonadSubAccountPool
  changePool?: MonadChangePool
  provider?: ReturnType<typeof makeChainProvider>
  stampAttemptJournal?: StampAttemptJournal
}) {
  const pool = overrides?.pool ?? makePool()
  const leaseManager = new SubAccountLeaseManager(pool)
  // The normal fixture models segmented account inventory: each account can contribute 6,000
  // wei, so a 10,000-wei stamp naturally consumes 6,000 + 4,000 without an artificial split.
  const provider = overrides?.provider ?? makeCapacityProvider([6_000n, 6_000n])
  const httpClient = makeMockHttpClient()
  const client = new MonadStampClient({
    pool,
    leaseManager,
    provider,
    httpClient,
    changePool: overrides?.changePool,
    stampAttemptJournal: overrides?.stampAttemptJournal,
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

  it('builds calldata as <POND><0x02><32-byte commitment>, 37 bytes total', () => {
    const commitment = new Uint8Array(32).fill(0xab)
    const calldata = buildMonadStampCalldata(commitment)
    const bytes = getBytes(calldata)

    expect(bytes).toHaveLength(37)
    expect(MONAD_STAMP_CALLDATA_LENGTH).toBe(37)
    // "POND" == 0x504f4e44 -- BROADCAST_MESSAGE_LOKAD_ID
    // (backend/cashweb/cashweb-payload/src/verify.rs:15).
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4f, 0x4e, 0x44])
    // COMMITMENT_VERSION_TAG (monad_stamp_verify.rs:66).
    expect(bytes[4]).toBe(0x02)
    expect(Array.from(bytes.slice(5))).toEqual(Array.from(commitment))
  })

  it('domain-separates otherwise-related payment children', () => {
    const payloadHash = new Uint8Array(32).fill(0x42)
    const child0 = computeMonadStampPaymentCommitment(payloadHash, 0)
    const child1 = computeMonadStampPaymentCommitment(payloadHash, 1)
    expect(child0).toHaveLength(32)
    expect(child1).toHaveLength(32)
    expect(child0).not.toEqual(child1)
  })

  it('rejects a commitment that is not exactly 32 bytes', () => {
    expect(() => buildMonadStampCalldata(new Uint8Array(31))).toThrow(
      /32 bytes/,
    )
  })

  it('quotes a worst-case stamp-payment fee reserve with headroom', async () => {
    const provider = makeStubProvider(async req => {
      throw new Error(`unexpected _perform: ${req.method}`)
    })
    const signer = new MonadAccountTxSigner({
      privateKey: `0x${'55'.repeat(32)}`,
      provider,
      httpClient: makeMockHttpClient(),
    })

    await expect(
      quoteMonadStampPaymentGasReserve({
        signer,
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        overrides: {
          nonce: 0,
          gasLimit: 60_000n,
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
          chainId: BigInt(CHAIN_ID),
        },
      }),
    ).resolves.toBe(150_000_000_000_000n)
  })
})

describe('recipient stamp-payment sweep', () => {
  const childPrivateKey = getBytes(`0x${'55'.repeat(32)}`)
  const childAddress = computeAddress(new SigningKey(childPrivateKey).publicKey)
  const payment = {
    childIndex: 0,
    address: childAddress,
    privateKey: childPrivateKey,
    txHash: `0x${'aa'.repeat(32)}`,
    valueWei: 10_000n,
  }

  it('subtracts child-paid gas and submits a plain transfer', async () => {
    const provider = makeStubProvider(async req => {
      if (req.method === 'getBalance') return '0x2710'
      throw new Error(`unexpected _perform: ${req.method}`)
    })
    const httpClient = makeMockHttpClient()
    httpClient.getTransactionReceipt.mockResolvedValue({
      status: 'success',
    } as never)
    httpClient.submitRawTransaction.mockImplementation(async rawTx => {
      const hash = Transaction.from(rawTx).hash
      if (hash === null) throw new Error('expected signed transaction')
      return hash
    })

    const outcome = await sweepRecoveredMonadStampPayment({
      payment,
      destinationAddress: `0x${'66'.repeat(20)}`,
      provider,
      httpClient,
      dustThresholdWei: 1_000n,
      overrides: {
        ...FEE_OVERRIDES,
        nonce: 0,
        chainId: BigInt(CHAIN_ID),
      },
    })

    expect(outcome.swept).toBe(true)
    if (!outcome.swept) throw new Error('expected sweep')
    expect(outcome.valueWei).toBe(9_000n)
    const submitted = Transaction.from(
      httpClient.submitRawTransaction.mock.calls[0][0],
    )
    expect(submitted.value).toBe(9_000n)
    expect(submitted.data).toBe('0x')
    expect(submitted.to).toBe(getAddress(`0x${'66'.repeat(20)}`))
  })

  it('leaves an uneconomic child untouched', async () => {
    const provider = makeStubProvider(async req => {
      if (req.method === 'getBalance') return '0x3e8'
      throw new Error(`unexpected _perform: ${req.method}`)
    })
    const httpClient = makeMockHttpClient()

    await expect(
      sweepRecoveredMonadStampPayment({
        payment,
        destinationAddress: `0x${'66'.repeat(20)}`,
        provider,
        httpClient,
        dustThresholdWei: 1_000n,
      }),
    ).resolves.toEqual({
      swept: false,
      reason: 'below-dust-threshold',
      balanceWei: 1_000n,
      dustThresholdWei: 1_000n,
    })
    expect(httpClient.submitRawTransaction).not.toHaveBeenCalled()
  })
})

describe('protobuf encode/decode round trip', () => {
  it('round-trips MonadStampedMessage through encode -> decode', () => {
    const message: MonadStampedMessageProto = {
      stampPayments: [{ childIndex: 0, rawTx: new Uint8Array([1, 2, 3, 4]) }],
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
      stampPayments: [{ childIndex: 0, rawTx: new Uint8Array([9, 9, 9]) }],
      encryptedPayload: new Uint8Array([7, 7]),
      payloadHash: new Uint8Array(32).fill(0x11),
    }
    const decoded = decodeStoredMonadMessage(storedMessageBytes(message))
    expect(decoded.message).toEqual(message)
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
    const sweepToChange = jest.fn().mockResolvedValue({
      swept: false,
      reason: 'below-dust-threshold',
      balanceWei: 1n,
      dustThresholdWei: 2n,
    })
    const changePool = { sweepToChange } as unknown as MonadChangePool
    const { client, pool } = makeClient({ changePool })
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
      // The raw payment must be a validly-decodable, real signed transaction whose calldata carries
      // the same commitment.
      expect(sentMessage.stampPayments).toHaveLength(2)
      for (const [index, payment] of sentMessage.stampPayments.entries()) {
        const parsed = Transaction.from(hexOf(payment.rawTx))
        expect(getBytes(parsed.data).slice(5)).toEqual(
          computeMonadStampPaymentCommitment(expectedCommitment, index),
        )
        expect(parsed.value).toBe(index === 0 ? 6_000n : 4_000n)
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
      recipientPublicKey: RECIPIENT_PUBLIC_KEY,
      stampValueWei: 10_000n,
      overrides: FEE_OVERRIDES,
      putRetry: { maxAttempts: 1, intervalMs: 0 },
    })

    expect(result.payloadHashHex).toBe(hexNoPrefix(expectedCommitment))
    expect(result.stored.message?.payloadHash).toEqual(expectedCommitment)
    // Ticket #34: a confirmed release retires the account as 'spent' -- permanently excluded from
    // future selection, never back to 'available' for reuse.
    expect(pool.getRecord(result.leaseIndices[0])?.status).toBe('spent')
    expect(sweepToChange).toHaveBeenCalledTimes(2)
    expect(result.changeSweeps).toEqual(
      Array(2).fill({
        swept: false,
        reason: 'below-dust-threshold',
        balanceWei: 1n,
        dustThresholdWei: 2n,
      }),
    )

    const recovered = recoverMonadStampPayments({
      message: result.stored.message as MonadStampedMessageProto,
      recipientPrivateKey: getBytes(`0x${'44'.repeat(32)}`),
    })
    expect(recovered).toHaveLength(2)
    expect(recovered[0].txHash).toBe(result.txHashes[0])
    expect(recovered[0].valueWei).toBe(6_000n)
    expect(
      computeAddress(new SigningKey(recovered[0].privateKey).publicKey),
    ).toBe(recovered[0].address)
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
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        stampValueWei: 10_000n,
        overrides: FEE_OVERRIDES,
      }),
    ).rejects.toThrow(MonadStampRejectedError)

    // Every selected sub-account is retired after a definitive relay rejection.
    const retired = pool.records().filter(r => r.status === 'retired')
    expect(retired).toHaveLength(2)
  })

  it('keeps an exact journaled set pending after an HTTP response that may follow a partial broadcast', async () => {
    const stampAttemptJournal = new InMemoryStampAttemptJournal()
    const { client, pool } = makeClient({ stampAttemptJournal })
    mockedAxios.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Bad Request'), {
        isAxiosError: true,
        response: { status: 400, data: { error: 'payment_rejected' } },
      })
    })

    await expect(
      client.submitStampedMessage({
        encryptedPayload: new TextEncoder().encode('partial response'),
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        stampValueWei: 10_000n,
        overrides: FEE_OVERRIDES,
      }),
    ).rejects.toThrow(MonadStampPendingAttemptError)

    expect(stampAttemptJournal.getAll()).toHaveLength(1)
    expect(
      pool.records().filter(record => record.status === 'in-use'),
    ).toHaveLength(2)
  })

  it('retires every reservation if the exact-set journal cannot become durable', async () => {
    const stampAttemptJournal: StampAttemptJournal = {
      put: async () => {
        throw new Error('disk full')
      },
      delete: async () => undefined,
      getAll: () => [],
    }
    const { client, pool } = makeClient({ stampAttemptJournal })

    await expect(
      client.submitStampedMessage({
        encryptedPayload: new TextEncoder().encode('journal failure'),
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        stampValueWei: 10_000n,
        overrides: FEE_OVERRIDES,
      }),
    ).rejects.toThrow('disk full')

    expect(
      pool.records().filter(record => record.status === 'retired'),
    ).toHaveLength(2)
    expect(mockedAxios).not.toHaveBeenCalled()
  })

  it('greedily constructs a canonical, domain-separated multi-payment set', async () => {
    const pool = makePool(3)
    const provider = makeCapacityProvider([4_500n, 2_000n, 3_500n])
    const { client } = makeClient({ pool, provider })
    const encryptedPayload = new TextEncoder().encode('segmented payment')
    let sentMessage: MonadStampedMessageProto | undefined

    mockedAxios.mockImplementationOnce(async config => {
      sentMessage = decodeMonadStampedMessage(
        new Uint8Array(config.data as Buffer),
      )
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
      recipientPublicKey: RECIPIENT_PUBLIC_KEY,
      stampValueWei: 10_000n,
      overrides: FEE_OVERRIDES,
      putRetry: { maxAttempts: 1, intervalMs: 0 },
    })

    expect(sentMessage).toBeDefined()
    const payments = (sentMessage as MonadStampedMessageProto).stampPayments
    expect(payments.map(payment => payment.childIndex)).toEqual([0, 1, 2])
    const transactions = payments.map(payment =>
      Transaction.from(hexOf(payment.rawTx)),
    )
    expect(transactions.map(tx => tx.value)).toEqual([4_500n, 3_500n, 2_000n])
    expect(new Set(transactions.map(tx => tx.from)).size).toBe(3)
    expect(new Set(transactions.map(tx => tx.to)).size).toBe(3)
    expect(new Set(transactions.map(tx => tx.data)).size).toBe(3)
    expect(result.txHashes).toHaveLength(3)
    expect(
      pool.records().filter(record => record.status === 'spent'),
    ).toHaveLength(3)
  })

  it('quotes worst-case calldata but estimates each selected child with its exact bytes', async () => {
    const estimatedData: string[] = []
    let nonce = 0
    const calldataFloor = (data: string) =>
      21_000 +
      Array.from(getBytes(data)).reduce(
        (gas, byte) => gas + (byte === 0 ? 10 : 40),
        0,
      )
    const quoteBalance =
      BigInt(
        calldataFloor(buildMonadStampCalldata(new Uint8Array(32).fill(0xff))),
      ) + 6_000n
    const provider = makeStubProvider(async req => {
      if (req.method === 'getBalance') return `0x${quoteBalance.toString(16)}`
      if (req.method === 'getTransactionCount')
        return `0x${(nonce++).toString(16)}`
      if (req.method === 'estimateGas') {
        const data = req.transaction?.data
        if (data === undefined)
          throw new Error('estimateGas request has no data')
        estimatedData.push(data)
        return `0x${calldataFloor(data).toString(16)}`
      }
      throw new Error(`unexpected _perform: ${req.method}`)
    })
    const { client } = makeClient({ provider })
    mockedAxios.mockImplementationOnce(async config => {
      const sent = decodeMonadStampedMessage(
        new Uint8Array(config.data as Buffer),
      )
      for (const payment of sent.stampPayments) {
        const tx = Transaction.from(hexOf(payment.rawTx))
        expect(Number(tx.gasLimit)).toBe(calldataFloor(tx.data))
      }
      return {
        data: storedMessageBytes(sent),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    await client.submitStampedMessage({
      encryptedPayload: new TextEncoder().encode('gas-vector-7'),
      recipientPublicKey: RECIPIENT_PUBLIC_KEY,
      stampValueWei: 10_000n,
      overrides: {
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        chainId: BigInt(CHAIN_ID),
      },
    })

    expect(estimatedData).toHaveLength(3)
    expect(Array.from(getBytes(estimatedData[0]).slice(5))).toEqual(
      Array(32).fill(0xff),
    )
    expect(estimatedData[1]).not.toBe(estimatedData[2])
  })

  it('re-PUTs the identical bytes after a network failure and confirms on the 200 (no GET exists any more)', async () => {
    const { client, pool } = makeClient()
    const encryptedPayload = new TextEncoder().encode('flaky network')

    const sentBodies: Uint8Array[] = []
    const sleeps: number[] = []
    mockedAxios.mockImplementation(async config => {
      expect(config.method).toBe('put')
      const sent = new Uint8Array(config.data as Buffer)
      sentBodies.push(sent)
      if (sentBodies.length === 1) {
        throw Object.assign(new Error('socket hang up'), {
          isAxiosError: true,
          response: undefined,
        })
      }
      // The relay already owns/delivered this exact set: idempotent PUT returns the stored row.
      return {
        data: storedMessageBytes(decodeMonadStampedMessage(sent)),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    const result = await client.submitStampedMessage({
      encryptedPayload,
      recipientPublicKey: RECIPIENT_PUBLIC_KEY,
      stampValueWei: 10_000n,
      overrides: FEE_OVERRIDES,
      putRetry: {
        maxAttempts: 3,
        intervalMs: 50,
        sleep: async ms => void sleeps.push(ms),
      },
    })

    expect(sentBodies).toHaveLength(2)
    expect(Array.from(sentBodies[1])).toEqual(Array.from(sentBodies[0]))
    expect(sleeps).toEqual([50])
    expect(result.stored.message?.encryptedPayload).toEqual(encryptedPayload)
    expect(mockedAxios.mock.calls.every(([c]) => c.method === 'put')).toBe(true)
    // Ticket #34: same as above -- confirmed means 'spent', never 'available' again.
    expect(pool.getRecord(result.leaseIndices[0])?.status).toBe('spent')
  })

  it.each([
    ['an empty protobuf', () => new Uint8Array()],
    [
      'a different stored message',
      (submitted: MonadStampedMessageProto) =>
        storedMessageBytes({
          ...submitted,
          encryptedPayload: new TextEncoder().encode('different message'),
        }),
    ],
    [
      'the same payload with different payment bytes',
      (submitted: MonadStampedMessageProto) =>
        storedMessageBytes({
          ...submitted,
          stampPayments: submitted.stampPayments.map((payment, index) =>
            index === 0
              ? { ...payment, rawTx: new Uint8Array([1, 2, 3]) }
              : payment,
          ),
        }),
    ],
  ])(
    'treats a 2xx containing %s as unverified and confirms only when a re-PUT returns the exact set',
    async (_description, responseBytes) => {
      const stampAttemptJournal = new InMemoryStampAttemptJournal()
      const { client, pool } = makeClient({ stampAttemptJournal })
      let submittedMessage: MonadStampedMessageProto | undefined
      let puts = 0
      mockedAxios.mockImplementation(async config => {
        expect(config.method).toBe('put')
        puts++
        submittedMessage = decodeMonadStampedMessage(
          new Uint8Array(config.data as Buffer),
        )
        return {
          data:
            puts === 1
              ? responseBytes(submittedMessage)
              : storedMessageBytes(submittedMessage),
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        }
      })

      const result = await client.submitStampedMessage({
        encryptedPayload: new TextEncoder().encode('correlate response'),
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        stampValueWei: 10_000n,
        overrides: FEE_OVERRIDES,
        putRetry: {
          maxAttempts: 2,
          intervalMs: 0,
          sleep: async () => undefined,
        },
      })

      expect(mockedAxios).toHaveBeenCalledTimes(2)
      expect(result.stored.message).toEqual(submittedMessage)
      expect(stampAttemptJournal.getAll()).toHaveLength(0)
      expect(
        pool.records().filter(record => record.status === 'spent'),
      ).toHaveLength(2)
    },
  )

  it.each([
    ['an empty protobuf', () => new Uint8Array()],
    [
      'a different stored message',
      (submitted: MonadStampedMessageProto) =>
        storedMessageBytes({
          ...submitted,
          encryptedPayload: new TextEncoder().encode('different message'),
        }),
    ],
    [
      'the same payload with different payment bytes',
      (submitted: MonadStampedMessageProto) =>
        storedMessageBytes({
          ...submitted,
          stampPayments: submitted.stampPayments.map((payment, index) =>
            index === 0
              ? { ...payment, rawTx: new Uint8Array([1, 2, 3]) }
              : payment,
          ),
        }),
    ],
  ])(
    'retains a pending attempt when resume receives %s in a 2xx',
    async (_description, responseBytes) => {
      const stampAttemptJournal = new InMemoryStampAttemptJournal()
      const pool = makePool()
      const first = makeClient({ pool, stampAttemptJournal }).client
      let submittedMessage: MonadStampedMessageProto | undefined
      mockedAxios.mockImplementationOnce(async config => {
        submittedMessage = decodeMonadStampedMessage(
          new Uint8Array(config.data as Buffer),
        )
        throw Object.assign(new Error('connection lost'), {
          isAxiosError: true,
          response: undefined,
        })
      })

      await expect(
        first.submitStampedMessage({
          encryptedPayload: new TextEncoder().encode('resume correlation'),
          recipientPublicKey: RECIPIENT_PUBLIC_KEY,
          stampValueWei: 10_000n,
          overrides: FEE_OVERRIDES,
          putRetry: { maxAttempts: 1, intervalMs: 0 },
        }),
      ).rejects.toThrow(MonadStampAbandonedError)
      expect(stampAttemptJournal.getAll()).toHaveLength(1)
      expect(submittedMessage).toBeDefined()

      mockedAxios.mockReset()
      mockedAxios.isAxiosError.mockImplementation(
        (e: unknown) =>
          (e as { isAxiosError?: boolean })?.isAxiosError === true,
      )
      mockedAxios.mockImplementation(async config => ({
        data: responseBytes(submittedMessage as MonadStampedMessageProto),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }))

      const resumed = makeClient({ pool, stampAttemptJournal }).client
      await expect(
        resumed.resumePendingAttempts({
          maxAttempts: 2,
          intervalMs: 0,
          sleep: async () => undefined,
        }),
      ).resolves.toEqual([])
      expect(stampAttemptJournal.getAll()).toHaveLength(1)
      expect(
        pool.records().filter(record => record.status === 'spent'),
      ).toHaveLength(0)
      expect(pool.selectForStamp()).toBeUndefined()
    },
  )

  it('retires as stuck and throws MonadStampAbandonedError when every idempotent re-PUT gets no response', async () => {
    const stampAttemptJournal = new InMemoryStampAttemptJournal()
    const { client, pool } = makeClient({ stampAttemptJournal })
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
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        stampValueWei: 10_000n,
        overrides: FEE_OVERRIDES,
        putRetry: {
          maxAttempts: 2,
          intervalMs: 0,
          sleep: async () => undefined,
        },
      }),
    ).rejects.toThrow(MonadStampAbandonedError)
    expect(mockedAxios).toHaveBeenCalledTimes(2) // both attempts were PUTs of the same bytes

    const retired = pool.records().filter(r => r.status === 'retired')
    expect(retired).toHaveLength(2)
    expect(stampAttemptJournal.getAll()).toHaveLength(1)
    await expect(
      client.submitStampedMessage({
        encryptedPayload: new TextEncoder().encode('replacement with new salt'),
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        stampValueWei: 10_000n,
        overrides: FEE_OVERRIDES,
        putRetry: { maxAttempts: 1, intervalMs: 0 },
      }),
    ).rejects.toThrow(MonadStampPendingAttemptError)

    // Simulate a cross-store crash where the awaited attempt journal persisted but the pool's
    // earlier status writes did not. A failed startup replay must reserve those
    // accounts again before returning control to the wallet.
    for (const record of retired) pool.setStatus(record.index, 'available')
    await expect(
      client.resumePendingAttempts({ maxAttempts: 1, intervalMs: 0 }),
    ).resolves.toEqual([])
    expect(pool.records().filter(r => r.status === 'in-use')).toHaveLength(2)

    mockedAxios.mockReset()
    mockedAxios.mockImplementationOnce(async config => {
      const message = decodeMonadStampedMessage(
        new Uint8Array(config.data as Buffer),
      )
      return {
        data: storedMessageBytes(message),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })
    await expect(client.resumePendingAttempts()).resolves.toHaveLength(1)
    expect(stampAttemptJournal.getAll()).toHaveLength(0)
    expect(pool.records().filter(r => r.status === 'spent')).toHaveLength(2)
  })

  it('stops a new send after recovering an older exact payment set', async () => {
    const stampAttemptJournal = new InMemoryStampAttemptJournal()
    const { client } = makeClient({
      pool: makePool(4),
      stampAttemptJournal,
    })
    const oldPayload = new TextEncoder().encode('older authorized message')
    const newPayload = new TextEncoder().encode('new draft')
    mockedAxios.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 400,
        data: { exact_set_retained: true },
      },
    })

    await expect(
      client.submitStampedMessage({
        encryptedPayload: oldPayload,
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        stampValueWei: 10_000n,
        overrides: FEE_OVERRIDES,
      }),
    ).rejects.toThrow(MonadStampPendingAttemptError)

    mockedAxios.mockImplementationOnce(async config => {
      const replayed = decodeMonadStampedMessage(
        new Uint8Array(config.data as Buffer),
      )
      expect(replayed.encryptedPayload).toEqual(oldPayload)
      return {
        data: storedMessageBytes(replayed),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })
    await expect(
      client.submitStampedMessage({
        encryptedPayload: newPayload,
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        stampValueWei: 10_000n,
        overrides: FEE_OVERRIDES,
      }),
    ).rejects.toThrow(MonadStampRecoveredAttemptError)

    expect(mockedAxios).toHaveBeenCalledTimes(2)
    expect(stampAttemptJournal.getAll()).toEqual([])
  })

  it('rejects a split larger than the relay maximum before leasing or PUT', async () => {
    const pool = makePool(65)
    const provider = makeCapacityProvider(Array(65).fill(1n))
    const { client } = makeClient({ pool, provider })

    await expect(
      client.submitStampedMessage({
        encryptedPayload: new TextEncoder().encode('too fragmented'),
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        stampValueWei: 65n,
        overrides: FEE_OVERRIDES,
      }),
    ).rejects.toThrow(/within 64 payments/)
    expect(pool.records().every(record => record.status === 'available')).toBe(
      true,
    )
    expect(mockedAxios).not.toHaveBeenCalled()
  })

  it('does not confirm when every PUT answers 2xx with a different payment set', async () => {
    const { client, pool } = makeClient()
    mockedAxios.mockImplementation(async config => {
      const conflicting: MonadStampedMessageProto = {
        encryptedPayload: new TextEncoder().encode('different'),
        payloadHash: new Uint8Array(32).fill(0x55),
        stampPayments: [{ childIndex: 0, rawTx: new Uint8Array([1, 2, 3]) }],
      }
      return {
        data: storedMessageBytes(conflicting),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    await expect(
      client.submitStampedMessage({
        encryptedPayload: new TextEncoder().encode('ambiguous exact set'),
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        stampValueWei: 10_000n,
        overrides: FEE_OVERRIDES,
        putRetry: {
          maxAttempts: 2,
          intervalMs: 0,
          sleep: async () => undefined,
        },
      }),
    ).rejects.toThrow(MonadStampAbandonedError)

    expect(pool.records().filter(r => r.status === 'retired')).toHaveLength(2)
  })
})

/** A relay JSON error as axios delivers it under `responseType: 'arraybuffer'` (raw bytes). */
function relayError(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return Object.assign(new Error(`HTTP ${status}`), {
    isAxiosError: true,
    response: {
      status,
      headers,
      data: new TextEncoder().encode(JSON.stringify(body)).buffer,
    },
  })
}

describe('MonadStampClient: PR #197 durable mailbox PUT semantics', () => {
  const retryable = {
    error: 'mailbox_retryable',
    detail: 'the exact stamp-payment set is pending durable reconciliation',
    exact_set_retained: true,
  }
  const send = (
    client: MonadStampClient,
    putRetry: {
      maxAttempts?: number
      intervalMs?: number
      sleep?: (ms: number) => Promise<void>
    } = { maxAttempts: 3, intervalMs: 10, sleep: async () => undefined },
  ) =>
    client.submitStampedMessage({
      encryptedPayload: new TextEncoder().encode('mailbox semantics'),
      recipientPublicKey: RECIPIENT_PUBLIC_KEY,
      stampValueWei: 10_000n,
      overrides: FEE_OVERRIDES,
      putRetry,
    })

  beforeEach(() => {
    jest.clearAllMocks()
    mockedAxios.mockReset()
    mockedAxios.isAxiosError.mockImplementation(
      (e: unknown) => (e as { isAxiosError?: boolean })?.isAxiosError === true,
    )
  })

  it('retries 503 mailbox_retryable with the SAME exact bytes (honouring Retry-After) until the relay delivers', async () => {
    const { client, pool } = makeClient({
      stampAttemptJournal: new InMemoryStampAttemptJournal(),
    })
    const bodies: Uint8Array[] = []
    const sleeps: number[] = []
    mockedAxios.mockImplementation(async config => {
      const sent = new Uint8Array(config.data as Buffer)
      bodies.push(sent)
      if (bodies.length === 1)
        throw relayError(503, retryable, { 'retry-after': '2' })
      if (bodies.length === 2) throw relayError(429, { error: 'rate_limited' })
      return {
        data: storedMessageBytes(decodeMonadStampedMessage(sent)),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    const result = await send(client, {
      maxAttempts: 4,
      intervalMs: 100,
      sleep: async ms => void sleeps.push(ms),
    })

    expect(bodies).toHaveLength(3)
    expect(
      bodies.every(b => Buffer.from(b).equals(Buffer.from(bodies[0]))),
    ).toBe(true)
    expect(sleeps).toEqual([2000, 200]) // Retry-After beats backoff; then 100 * 2
    expect(pool.records().filter(r => r.status === 'spent')).toHaveLength(2)
    expect(result.payloadHashHex).toHaveLength(64)
  })

  it('keeps the journal and reservations (Pending) when 503 outlasts the budget and the relay may own the set', async () => {
    const stampAttemptJournal = new InMemoryStampAttemptJournal()
    const { client, pool } = makeClient({ stampAttemptJournal })
    mockedAxios.mockImplementation(async () => {
      throw relayError(503, retryable)
    })
    await expect(send(client)).rejects.toThrow(MonadStampPendingAttemptError)
    expect(mockedAxios).toHaveBeenCalledTimes(3)
    expect(stampAttemptJournal.getAll()).toHaveLength(1)
    expect(pool.records().filter(r => r.status === 'in-use')).toHaveLength(2)

    // Later, the relay delivers: resume re-PUTs the identical bytes and completes.
    mockedAxios.mockReset()
    mockedAxios.mockImplementationOnce(async config => ({
      data: storedMessageBytes(
        decodeMonadStampedMessage(new Uint8Array(config.data as Buffer)),
      ),
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }))
    await expect(client.resumePendingAttempts()).resolves.toHaveLength(1)
    expect(stampAttemptJournal.getAll()).toHaveLength(0)
    expect(pool.records().filter(r => r.status === 'spent')).toHaveLength(2)
  })

  it('without a journal, an exhausted 503 retires stuck and throws Abandoned (not a rejection)', async () => {
    const { client, pool } = makeClient()
    mockedAxios.mockImplementation(async () => {
      throw relayError(503, { ...retryable, exact_set_retained: null })
    })
    await expect(send(client)).rejects.toThrow(MonadStampAbandonedError)
    expect(pool.records().filter(r => r.status === 'retired')).toHaveLength(2)
  })

  it('a 503 with exact_set_retained=false (nothing claimed) is a safe rejection after the budget', async () => {
    const stampAttemptJournal = new InMemoryStampAttemptJournal()
    const { client, pool } = makeClient({ stampAttemptJournal })
    // Capacity (per-recipient cap of 32 unconfirmed claims / global outbox bound) is a 503 with
    // exact_set_retained=false and its own detail: nothing was claimed, so say so.
    mockedAxios.mockImplementation(async () => {
      throw relayError(503, {
        ...retryable,
        detail: 'the durable stamp outbox is temporarily at capacity',
        exact_set_retained: false,
      })
    })
    const capacityError = await send(client).catch(e => e)
    expect(capacityError).toBeInstanceOf(MonadStampRejectedError)
    expect(capacityError.message).toMatch(
      /before retaining its payment set.*at capacity/,
    )
    expect(mockedAxios).toHaveBeenCalledTimes(3) // still retried the same bytes first
    expect(stampAttemptJournal.getAll()).toHaveLength(0)
    expect(pool.records().filter(r => r.status === 'retired')).toHaveLength(2)
  })

  it.each([
    [409, 'mailbox_conflict', false, 'failed'],
    [422, 'mailbox_terminal', true, 'stuck'],
    [422, 'mailbox_terminal', false, 'failed'],
  ] as const)(
    '%s %s (retained=%s) is a distinct terminal error: not retried, journal dropped, accounts retired',
    async (status, code, retained) => {
      const stampAttemptJournal = new InMemoryStampAttemptJournal()
      const { client, pool } = makeClient({ stampAttemptJournal })
      mockedAxios.mockImplementation(async () => {
        throw relayError(status, {
          error: code,
          detail: 'x',
          exact_set_retained: retained,
        })
      })
      const error = await send(client).catch(e => e)
      expect(error).toBeInstanceOf(MonadStampTerminalError)
      expect(error).not.toBeInstanceOf(MonadStampRejectedError)
      expect(error).toMatchObject({ status, code, exactSetRetained: retained })
      expect(mockedAxios).toHaveBeenCalledTimes(1)
      expect(stampAttemptJournal.getAll()).toHaveLength(0)
      expect(pool.records().filter(r => r.status === 'retired')).toHaveLength(2)
    },
  )

  it('a 404 means the relay has no mailbox: distinct error, nothing pending, not retried', async () => {
    const stampAttemptJournal = new InMemoryStampAttemptJournal()
    const { client, pool } = makeClient({ stampAttemptJournal })
    mockedAxios.mockImplementation(async () => {
      throw Object.assign(new Error('Not Found'), {
        isAxiosError: true,
        response: { status: 404, headers: {}, data: new ArrayBuffer(0) },
      })
    })
    await expect(send(client)).rejects.toBeInstanceOf(
      MonadMailboxUnavailableError,
    )
    expect(mockedAxios).toHaveBeenCalledTimes(1)
    expect(stampAttemptJournal.getAll()).toHaveLength(0)
    expect(pool.records().filter(r => r.status === 'retired')).toHaveLength(2)
  })

  it('resume drops a journaled set the relay declared terminal, but keeps it when the relay has no mailbox', async () => {
    const stampAttemptJournal = new InMemoryStampAttemptJournal()
    const { client, pool } = makeClient({ stampAttemptJournal })
    mockedAxios.mockImplementation(async () => {
      throw relayError(503, retryable)
    })
    await expect(send(client)).rejects.toThrow(MonadStampPendingAttemptError)

    mockedAxios.mockReset()
    mockedAxios.mockImplementation(async () => {
      throw Object.assign(new Error('Not Found'), {
        isAxiosError: true,
        response: { status: 404, headers: {}, data: new ArrayBuffer(0) },
      })
    })
    await expect(client.resumePendingAttempts()).resolves.toEqual([])
    expect(stampAttemptJournal.getAll()).toHaveLength(1)

    mockedAxios.mockReset()
    mockedAxios.mockImplementation(async () => {
      throw relayError(422, {
        error: 'mailbox_terminal',
        detail: 'stale nonce',
        exact_set_retained: true,
      })
    })
    await expect(client.resumePendingAttempts()).resolves.toEqual([])
    expect(stampAttemptJournal.getAll()).toHaveLength(0)
    expect(pool.records().filter(r => r.status === 'retired')).toHaveLength(2)
  })

  describe('attempt liveness for message-level retry (#269/#270)', () => {
    async function pendingAttempt() {
      const stampAttemptJournal = new InMemoryStampAttemptJournal()
      const { client, pool } = makeClient({ stampAttemptJournal })
      let journaled: string | undefined
      let axiosCallsWhenJournaled = -1
      mockedAxios.mockImplementation(async () => {
        throw relayError(503, retryable)
      })
      await expect(
        client.submitStampedMessage({
          encryptedPayload: new TextEncoder().encode('liveness'),
          recipientPublicKey: RECIPIENT_PUBLIC_KEY,
          stampValueWei: 10_000n,
          overrides: FEE_OVERRIDES,
          putRetry: { maxAttempts: 2, intervalMs: 0, sleep: async () => {} },
          onAttemptJournaled: hash => {
            journaled = hash
            axiosCallsWhenJournaled = mockedAxios.mock.calls.length
          },
        }),
      ).rejects.toThrow(MonadStampPendingAttemptError)
      return {
        client,
        pool,
        stampAttemptJournal,
        journaled,
        axiosCallsWhenJournaled,
      }
    }

    describe('onAttemptJournaled is a durability gate', () => {
      const okPut = async (config: { data?: unknown }) => ({
        data: storedMessageBytes(
          decodeMonadStampedMessage(new Uint8Array(config.data as Buffer)),
        ),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      })
      const submit = (
        client: MonadStampClient,
        onAttemptJournaled: (hash: string) => Promise<void>,
      ) =>
        client.submitStampedMessage({
          encryptedPayload: new TextEncoder().encode('gate'),
          recipientPublicKey: RECIPIENT_PUBLIC_KEY,
          stampValueWei: 10_000n,
          overrides: FEE_OVERRIDES,
          putRetry: { maxAttempts: 1 },
          onAttemptJournaled,
        })

      it('issues no PUT until a slow async callback has resolved', async () => {
        const stampAttemptJournal = new InMemoryStampAttemptJournal()
        const { client } = makeClient({ stampAttemptJournal })
        mockedAxios.mockImplementation(okPut as never)
        let release: () => void = () => undefined
        const sending = submit(
          client,
          () => new Promise<void>(resolve => (release = resolve)),
        )
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(release).not.toBe(undefined)
        expect(stampAttemptJournal.getAll()).toHaveLength(1)
        expect(mockedAxios).not.toHaveBeenCalled()
        release()
        await sending
        expect(mockedAxios).toHaveBeenCalledTimes(1)
      })

      it('a rejecting callback sends nothing, rolls the attempt back and leaves no payment that could land', async () => {
        const stampAttemptJournal = new InMemoryStampAttemptJournal()
        const { client, pool } = makeClient({ stampAttemptJournal })
        mockedAxios.mockImplementation(okPut as never)
        let hash = ''
        const failure = new Error('cannot record the attempt durably')
        await expect(
          submit(client, async h => {
            hash = h
            await new Promise(resolve => setTimeout(resolve, 20))
            throw failure
          }),
        ).rejects.toBe(failure)
        expect(mockedAxios).not.toHaveBeenCalled()
        expect(stampAttemptJournal.getAll()).toHaveLength(0)
        expect(pool.records().filter(r => r.status === 'in-use')).toHaveLength(
          0,
        )
        expect(pool.records().filter(r => r.status === 'retired')).toHaveLength(
          2,
        )
        expect(client.attemptStatus(hash)).toBe('dead')
        // Nothing to resume: a later resume cannot pay or send it.
        await client.resumePendingAttempts()
        expect(mockedAxios).not.toHaveBeenCalled()
      })

      it('if the journal entry cannot be deleted, it is KEPT with its reservations, nothing is sent, and the callback error propagates (no dead record)', async () => {
        const stampAttemptJournal = new InMemoryStampAttemptJournal()
        stampAttemptJournal.delete = jest
          .fn()
          .mockRejectedValue(new Error('journal delete failed'))
        const { client, pool } = makeClient({ stampAttemptJournal })
        mockedAxios.mockImplementation(okPut as never)
        let hash = ''
        const failure = new Error('cannot record the attempt durably')
        await expect(
          submit(client, async h => {
            hash = h
            throw failure
          }),
        ).rejects.toBe(failure)
        expect(mockedAxios).not.toHaveBeenCalled()
        expect(stampAttemptJournal.getAll()).toHaveLength(1)
        expect(pool.records().filter(r => r.status === 'in-use')).toHaveLength(
          2,
        )
        expect(client.attemptStatus(hash)).toBe('live') // not 'dead': resume can still re-send it
      })

      it('the dead outcome is recorded even if flushing the retired reservations fails, and the callback error still wins', async () => {
        const stampAttemptJournal = new InMemoryStampAttemptJournal()
        const { client, pool } = makeClient({ stampAttemptJournal })
        mockedAxios.mockImplementation(okPut as never)
        const realFlush = pool.flush.bind(pool)
        let armed = false
        jest.spyOn(pool, 'flush').mockImplementation(async () => {
          if (armed) throw new Error('flush failed')
          return realFlush()
        })
        let hash = ''
        const failure = new Error('cannot record the attempt durably')
        await expect(
          submit(client, async h => {
            hash = h
            armed = true
            throw failure
          }),
        ).rejects.toBe(failure)
        expect(mockedAxios).not.toHaveBeenCalled()
        expect(stampAttemptJournal.getAll()).toHaveLength(0)
        expect(client.attemptStatus(hash)).toBe('dead')
      })

      it('recordedAttempts lists journaled and resolved attempts', async () => {
        const stampAttemptJournal = new InMemoryStampAttemptJournal()
        const { client } = makeClient({ stampAttemptJournal })
        mockedAxios.mockImplementation(okPut as never)
        const result = await send(client)
        expect(client.recordedAttempts()).toEqual([
          { payloadHashHex: result.payloadHashHex, status: 'delivered' },
        ])
      })
    })

    it('reports the journaled hash before any byte reaches the relay, and the attempt as live while pending', async () => {
      const { client, journaled, axiosCallsWhenJournaled } =
        await pendingAttempt()
      expect(journaled).toMatch(/^[0-9a-f]{64}$/)
      expect(axiosCallsWhenJournaled).toBe(0)
      expect(client.attemptStatus(journaled as string)).toBe('live')
    })

    it('stays live (never dead) while the relay keeps answering 503, and then reports delivered', async () => {
      const { client, journaled } = await pendingAttempt()
      mockedAxios.mockReset()
      mockedAxios.mockImplementation(async () => {
        throw relayError(503, retryable)
      })
      await client.resumePendingAttempts({ maxAttempts: 1 })
      expect(client.attemptStatus(journaled as string)).toBe('live')

      mockedAxios.mockReset()
      mockedAxios.mockImplementationOnce(async config => ({
        data: storedMessageBytes(
          decodeMonadStampedMessage(new Uint8Array(config.data as Buffer)),
        ),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }))
      await client.resumePendingAttempts({ maxAttempts: 1 })
      expect(client.attemptStatus(journaled as string)).toBe('delivered')
    })

    it('reports dead once the relay declares the exact set terminal', async () => {
      const { client, journaled } = await pendingAttempt()
      mockedAxios.mockReset()
      mockedAxios.mockImplementation(async () => {
        throw relayError(422, {
          error: 'mailbox_terminal',
          detail: 'stale nonce',
          exact_set_retained: true,
        })
      })
      await client.resumePendingAttempts({ maxAttempts: 1 })
      expect(client.attemptStatus(journaled as string)).toBe('dead')
    })

    it('reports unknown for a hash it never journaled, and delivered/dead for a direct outcome', async () => {
      const stampAttemptJournal = new InMemoryStampAttemptJournal()
      const { client } = makeClient({ stampAttemptJournal })
      expect(client.attemptStatus('ab'.repeat(32))).toBe('unknown')
      mockedAxios.mockImplementation(async config => ({
        data: storedMessageBytes(
          decodeMonadStampedMessage(new Uint8Array(config.data as Buffer)),
        ),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }))
      const result = await send(client)
      expect(client.attemptStatus(result.payloadHashHex)).toBe('delivered')
    })
  })

  it('never issues a GET (the sender-side read route no longer exists)', async () => {
    const { client } = makeClient()
    mockedAxios.mockImplementation(async config => ({
      data: storedMessageBytes(
        decodeMonadStampedMessage(new Uint8Array(config.data as Buffer)),
      ),
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }))
    await send(client)
    expect(mockedAxios.mock.calls.map(([c]) => c.method)).toEqual(['put'])
    expect(
      (client as unknown as Record<string, unknown>).fetchStoredMessage,
    ).toBeUndefined()
  })
})

function hexOf(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex')
}

function hexNoPrefix(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

// C0 characterizes current economics; clean reopen is not power-loss durability.
describe('C0 disk-backed exact attempt ownership', () => {
  it.each(['delivered', 'dead'] as const)(
    'replays the persisted signed set without signing and loses %s evidence after reopen',
    async terminal => {
      const fs = await import('fs')
      const os = await import('os')
      const path = await import('path')
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c0-stamp-client-'))
      let journal = new LevelStampAttemptJournal(dir)
      let opened = false
      const requests: Uint8Array[] = []
      const http =
        jest.mocked<(config: AxiosRequestConfig) => Promise<AxiosResponse>>(
          axios,
        )
      const sign = jest.spyOn(
        MonadAccountTxSigner.prototype,
        'buildAndSignCall',
      )
      try {
        await journal.Open()
        opened = true
        http.mockReset()
        mockedAxios.isAxiosError.mockImplementation(
          (e: unknown) =>
            (e as { isAxiosError?: boolean })?.isAxiosError === true,
        )
        http.mockImplementation(async config => {
          const bytes = new Uint8Array(config.data as Buffer)
          requests.push(bytes)
          // Observe actual Level inventory before the first relay submission.
          expect(journal.getAll()).toHaveLength(1)
          expect(journal.getAll()[0].messageBytes).toEqual(Array.from(bytes))
          expect(journal.getAll()[0].leaseIndices).toHaveLength(2)
          throw Object.assign(new Error('uncertain submission'), {
            isAxiosError: true,
          })
        })
        const first = makeClient({ stampAttemptJournal: journal }).client
        await expect(
          first.submitStampedMessage({
            encryptedPayload: new TextEncoder().encode('C0 retained exact set'),
            recipientPublicKey: RECIPIENT_PUBLIC_KEY,
            stampValueWei: 10_000n,
            overrides: FEE_OVERRIDES,
            putRetry: { maxAttempts: 1, intervalMs: 0 },
          }),
        ).rejects.toThrow(MonadStampAbandonedError)
        const attempt = journal.getAll()[0]
        const original = requests[0]
        const signed = decodeMonadStampedMessage(original).stampPayments.map(
          p => Transaction.from('0x' + Buffer.from(p.rawTx).toString('hex')),
        )
        expect(signed.map(tx => tx.value)).toEqual([6000n, 4000n])
        expect(signed.every(tx => tx.chainId === BigInt(CHAIN_ID))).toBe(true)
        expect(
          signed.every(
            tx => tx.data.length === 2 + MONAD_STAMP_CALLDATA_LENGTH * 2,
          ),
        ).toBe(true)
        const signCount = sign.mock.calls.length
        // Issue #1216: Single-probe construction signs one capacity probe and two retained members.
        expect(signCount).toBe(3)
        await journal.Close()
        opened = false
        journal = new LevelStampAttemptJournal(dir)
        await journal.Open()
        opened = true
        expect(journal.getAll()).toEqual([attempt])
        const pool = makePool()
        const resumed = makeClient({
          pool,
          stampAttemptJournal: journal,
        }).client
        http.mockImplementation(async config => {
          const bytes = new Uint8Array(config.data as Buffer)
          requests.push(bytes)
          expect(bytes).toEqual(original)
          expect(journal.getAll()).toEqual([attempt])
          expect(
            attempt.leaseIndices.every(
              index => pool.getRecord(index)?.status === 'in-use',
            ),
          ).toBe(true)
          if (terminal === 'dead')
            throw Object.assign(new Error('terminal exact set'), {
              isAxiosError: true,
              response: {
                status: 422,
                data: { error: 'mailbox_terminal', exact_set_retained: true },
              },
            })
          return {
            data: storedMessageBytes(decodeMonadStampedMessage(bytes)),
            status: 200,
            statusText: 'OK',
            headers: {},
            config,
          }
        })
        await resumed.resumePendingAttempts({ maxAttempts: 1, intervalMs: 0 })
        expect(sign).toHaveBeenCalledTimes(signCount)
        expect(requests).toHaveLength(2)
        expect(resumed.attemptStatus(attempt.payloadHashHex)).toBe(terminal)
        expect(journal.getAll()).toEqual([])
        await journal.Close()
        opened = false
        journal = new LevelStampAttemptJournal(dir)
        await journal.Open()
        opened = true
        const restarted = makeClient({ stampAttemptJournal: journal }).client
        // Known gap: completion lives only in a WeakMap keyed by the old journal.
        expect(restarted.attemptStatus(attempt.payloadHashHex)).toBe('unknown')
        expect(restarted.recordedAttempts()).toEqual([])
        await restarted.resumePendingAttempts({ maxAttempts: 1, intervalMs: 0 })
        expect(requests).toHaveLength(2)
        expect(sign).toHaveBeenCalledTimes(signCount)
      } finally {
        sign.mockRestore()
        if (opened) await journal.Close()
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})

// Canonical consumer fixtures use real native directory admission over signed public evidence.
// Chain balances/fees are offline stubs; this is not deployed payment/finality proof.
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openNodeDirectoryStore } from '../directory-admission/src/node'
import {
  createMonadWalletMaterial,
  canonicalWalletPublicBinding,
  type MonadRootBundle,
} from './monad-wallet-material'
import domainVectors from '../domain-roots/vectors/domain-roots-v1.json'
import {
  openExistingPoolMonadTopicOwner,
  MonadWalletOperationAdmission,
} from './storage/monad-wallet-bundle'
import { LevelSubAccountPoolStore } from './storage/level-sub-account-pool-store'
import { LevelChangePoolStore } from './storage/level-change-pool-store'
import { EvmNativeOperationJournal } from './storage/evm-native-operation-journal'
import { EvmLegacyConsolidator } from './chain/evm-legacy-consolidator'
import { NativeEvmTransactionBuilder } from './chain/evm-transaction-builder'
import {
  MonadCanonicalStampClient,
  type CanonicalWorkflowLink,
} from './monad-stamp-client'
import {
  prepareDirectMessage,
  directMessageText,
} from '@frank/cashweb/relay/canonical-dm'
import {
  addressFromCompressedPubkey,
  cborMap,
  decodeCanonical,
  defaultContext,
  directorySignatureDigest,
  encodeCanonical,
  encodeFrame,
  paymentCommitment,
  recipientPayloadDigest,
  toHex,
  validateFrame,
} from '@frank/codec'
import type { PublicRevisionZeroInput } from './monad-wallet-handle'

function canonicalTestRoots(index: number): MonadRootBundle {
  const outputs = domainVectors.vectors[index].outputs
  const root = <
    P extends 'evm-wallet' | 'identity-authentication' | 'messaging-encryption',
  >(
    purpose: P,
  ) => ({
    registry: 'frank-domain-roots-v1' as const,
    purpose,
    bytes: getBytes(`0x${outputs[purpose]}`),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  }
}
function canonicalBarrier() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function withCanonicalConsumer(
  run: (
    f: Awaited<ReturnType<typeof makeCanonicalConsumerFixture>>,
  ) => Promise<void>,
) {
  const fixture = await makeCanonicalConsumerFixture()
  try {
    await run(fixture)
  } finally {
    await fixture.close()
  }
}
async function makeCanonicalConsumerFixture(
  options: {
    beforeOwnerOpen?: (
      journal: EvmNativeOperationJournal,
      material: ReturnType<typeof createMonadWalletMaterial>,
    ) => Promise<void>
    /** Start from a copy of another fixture's wallet files, as a process restarted on them. */
    restoreFrom?: string
  } = {},
) {
  const location = await mkdtemp(join(tmpdir(), 'canonical-consumer-'))
  if (options.restoreFrom)
    await cp(options.restoreFrom, location, {
      recursive: true,
      // The directory stores are per process in this fixture and are created fresh below.
      filter: source => !source.endsWith('-directory'),
    })
  const material = createMonadWalletMaterial(canonicalTestRoots(0)),
    recipient = createMonadWalletMaterial(canonicalTestRoots(1))
  const publicInput = (
    m: typeof material,
    label: 'a' | 'b',
  ): PublicRevisionZeroInput => ({
    networkTag: 'MONT',
    network: 'monad-testnet',
    chainId: 10143n,
    issuedAt: { seconds: 100n, nanoseconds: 0 },
    expiresAt: { seconds: 3700n, nanoseconds: 0 },
    now: { seconds: 100n, nanoseconds: 0 },
    relay: {
      relayId: new Uint8Array(16).fill(label === 'a' ? 1 : 2),
      endpoint: `https://${label}.example`,
      identity: {
        keyType: 1,
        keyBytes: m.canonicalRoles!.publicGenerationZeroPoints().auth,
      },
      expiry: { seconds: 3700n, nanoseconds: 0 },
      unknownFields: new Map(),
    },
  })
  const senderExport = material.canonicalRoles!.prepareRevisionZero(
      publicInput(material, 'a'),
    ),
    recipientExport = recipient.canonicalRoles!.prepareRevisionZero(
      publicInput(recipient, 'b'),
    )
  const senderDirectory = await openNodeDirectoryStore({
      location: join(location, 'sender-directory'),
      anchor: {
        network: 'monad-testnet',
        subject: { keyType: 1, keyBytes: senderExport.auth.compressedPoint },
        revisionZero: senderExport.t1,
      },
      mode: { kind: 'new' },
    }),
    recipientDirectory = await openNodeDirectoryStore({
      location: join(location, 'recipient-directory'),
      anchor: {
        network: 'monad-testnet',
        subject: { keyType: 1, keyBytes: recipientExport.auth.compressedPoint },
        revisionZero: recipientExport.t1,
      },
      mode: { kind: 'new' },
    })
  const senderCurrent = await senderDirectory.enroll(
      [
        {
          statement: senderExport.statement,
          attestation: senderExport.attestation,
        },
      ],
      {
        now: senderExport.configuration.now,
        relay: senderExport.configuration.relay,
      },
    ),
    recipientCurrent = await recipientDirectory.enroll(
      [
        {
          statement: recipientExport.statement,
          attestation: recipientExport.attestation,
        },
      ],
      {
        now: recipientExport.configuration.now,
        relay: recipientExport.configuration.relay,
      },
    )
  const seal = (id = 1) =>
    prepareDirectMessage({
      network: 'monad-testnet',
      senderCurrent,
      recipientCurrent,
      messageId: new Uint8Array(16).fill(id),
      items: [directMessageText('exact frozen text')],
      roles: material.canonicalRoles!.create('monad-testnet', senderCurrent),
    })
  const rotateOwnStamp = async (
    prior: typeof senderCurrent,
    generation: bigint,
  ) => {
    const roots = canonicalTestRoots(0)
    const leaves = deriveRoleLeaves({
      authRoot: roots.authentication,
      messageRoot: roots.messaging,
      stampRoot: roots.evm,
      messageGeneration: 0n,
      stampGeneration: generation,
    })
    try {
      const account = (point: Uint8Array) =>
        cborMap([
          [0, 1],
          [1, point],
        ])
      const timestamp = (seconds: bigint) =>
        cborMap([
          [0, seconds],
          [1, 0],
        ])
      const tuple = senderExport.configuration.relay
      const statement = encodeFrame(
        { typeId: 4, schemaVersion: 4, minReaderVersion: 4 },
        cborMap([
          [0, 'monad-testnet'],
          [1, account(leaves.auth.public.compressedPoint)],
          [2, generation],
          [3, timestamp(100n + generation)],
          [
            4,
            [
              cborMap([
                [0, tuple.relayId],
                [1, tuple.endpoint],
                [2, account(tuple.identity.keyBytes)],
                [3, timestamp(tuple.expiry.seconds)],
              ]),
            ],
          ],
          [6, timestamp(3700n)],
          [8, account(leaves.stamp.public.compressedPoint)],
          [10, account(leaves.message.public.compressedPoint)],
          [11, 0],
          [12, generation],
          [13, prior.evidence.hash],
        ]),
      )
      const attestation = encodeFrame(
        { typeId: 2, schemaVersion: 1, minReaderVersion: 1 },
        cborMap([
          [0, statement],
          [
            1,
            [
              cborMap([
                [0, 1],
                [1, account(leaves.auth.public.compressedPoint)],
                [
                  2,
                  new Uint8Array(
                    material.identity.signHash(
                      Buffer.from(
                        directorySignatureDigest('monad-testnet', statement),
                      ),
                    ),
                  ),
                ],
              ]),
            ],
          ],
        ]),
      )
      return senderDirectory.advance([{ statement, attestation }], {
        now: { seconds: 100n + generation, nanoseconds: 0 },
        relay: tuple,
      })
    } finally {
      leaves.dispose()
    }
  }
  const incomingRecovery = async (
    lifecycle = 'terminal:expired',
    confirmedChildren = [0],
  ) => {
    const saved = prepareDirectMessage({
      network: 'monad-testnet',
      senderCurrent: recipientCurrent,
      recipientCurrent: senderCurrent,
      messageId: new Uint8Array(16).fill(9),
      items: [directMessageText('incoming funds remain recoverable')],
      roles: recipient.canonicalRoles!.create(
        'monad-testnet',
        recipientCurrent,
      ),
    })
    const envelope = inspectCanonicalPreparedEnvelope(
      saved.payload,
      saved.context,
    )
    const digest = recipientPayloadDigest('monad-testnet', saved.payload)
    const destination = canonicalStampDestination({
      network: 'monad-testnet',
      stampKey: envelope.stampKey,
      sharedPoint: envelope.payload.sharedPoint,
      childIndex: 0,
    })
    const raw = await new Wallet('0x' + '00'.repeat(31) + '01').signTransaction(
      {
        type: 2,
        chainId: 10143n,
        nonce: 0,
        gasLimit: 50000n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
        value: 32n,
        to: '0x' + toHex(destination.address),
      },
    )
    const tx = Transaction.from(raw)
    const delivery = encodeFrame(
      { typeId: 1, schemaVersion: 1, minReaderVersion: 1 },
      cborMap([
        [0, 'monad-testnet'],
        [
          1,
          cborMap([
            [0, 1],
            [1, envelope.stampKey.keyBytes],
          ]),
        ],
        [2, saved.payload],
        [3, digest],
        [
          4,
          [
            cborMap([
              [0, 0],
              [1, getBytes(tx.hash!)],
              [2, getBytes('0x' + tx.value.toString(16).padStart(64, '0'))],
              [3, destination.address],
              [4, paymentCommitment(digest, 0)],
            ]),
          ],
        ],
      ]),
    )
    const parts = {
      delivery,
      context: saved.context,
      transactions: [getBytes(raw)],
    }
    const request = freezeCanonicalRequest(parts)
    return {
      record: {
        delivery,
        context: saved.context,
        parts,
        identity: request.identity,
        submissionIdentity: request.identity.submission_identity,
        timestampMs: 100000,
        obligationId: 'ab'.repeat(32),
        confirmedChildren,
        lifecycle,
      },
      senderCurrent: recipientCurrent,
      recipientCurrent: senderCurrent,
    }
  }
  const subStore = new LevelSubAccountPoolStore(location),
    changeStore = new LevelChangePoolStore(location)
  await subStore.Open()
  await changeStore.Open()
  const pool = new MonadSubAccountPool({
      keyring: material.keyring,
      store: subStore,
    }),
    changePool = new MonadChangePool({
      keyring: material.changeKeyring,
      store: changeStore,
    })
  pool.ensureSize(1)
  await pool.flush()
  let leaseManager = new SubAccountLeaseManager(pool)
  let enclosed = false
  let queue = Promise.resolve()
  const nativeBinding = {
    chainIdentifier: 'monad-testnet',
    nativeChainId: '10143',
    publicTuple: JSON.stringify({
      mainAddress: material.mainAccount.address.toLowerCase(),
    }),
  }
  if (options.beforeOwnerOpen) {
    const journal = new EvmNativeOperationJournal({
      location,
      binding: nativeBinding,
    })
    await journal.Open()
    try {
      await options.beforeOwnerOpen(journal, material)
    } finally {
      await journal.Close()
    }
  }
  const captured: {
    canonical?: LevelCanonicalStampAttemptJournal
    native?: EvmNativeOperationJournal
  } = {}
  const openOwner = async (canonicalEnabled = true) => {
    const originalNativeOpen = EvmNativeOperationJournal.prototype.Open
    const captureNative = jest
      .spyOn(EvmNativeOperationJournal.prototype, 'Open')
      .mockImplementation(function (this: EvmNativeOperationJournal) {
        captured.native = this
        return originalNativeOpen.call(this)
      })
    const originalCanonicalOpen =
      LevelCanonicalStampAttemptJournal.prototype.Open
    const captureCanonical = jest
      .spyOn(LevelCanonicalStampAttemptJournal.prototype, 'Open')
      .mockImplementation(function (this: LevelCanonicalStampAttemptJournal) {
        captured.canonical = this
        return originalCanonicalOpen.call(this)
      })
    return openExistingPoolMonadTopicOwner({
      nativeBinding,
      encloseFinancialOperation: operation => exclusive(operation, false),
      location,
      pool,
      changePool,
      leaseManager,
      subKeyring: material.keyring,
      changeKeyring: material.changeKeyring,
      canonicalBinding: canonicalEnabled
        ? canonicalWalletPublicBinding(material, 'monad-testnet', 10143n)
        : undefined,
      stampReferencesLeaseIndex: () => false,
      assertEnclosingAdmission: () => {
        if (!enclosed) throw new Error('missing outer owner admission')
      },
    }).finally(() => {
      captureCanonical.mockRestore()
      captureNative.mockRestore()
    })
  }
  let state = await openOwner()
  const providerCalls = jest.fn(async (req: { method: string }) => {
    if (req.method === 'getBalance') return 1000000000n
    if (req.method === 'getTransactionCount') return 0
    if (req.method === 'estimateGas') return 50000n
    throw new Error(`unexpected canonical provider ${req.method}`)
  })
  const provider = new JsonRpcProvider('http://127.0.0.1:1', CHAIN_ID, {
    staticNetwork: true,
    cacheTimeout: -1,
  })
  ;(provider as unknown as { _perform: typeof providerCalls })._perform =
    providerCalls
  const exclusive = <T>(
    operation: (admission: MonadWalletOperationAdmission) => Promise<T>,
    canonical = true,
  ): Promise<T> => {
    const result = queue.then(async () => {
      enclosed = true
      try {
        return await (canonical
          ? state.runCanonicalOperation(operation)
          : state.runOperation(operation))
      } finally {
        enclosed = false
      }
    })
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  const httpClient = makeMockHttpClientForCanonical()
  const createClient = () =>
    new MonadCanonicalStampClient({
      pool,
      changePool,
      leaseManager,
      provider,
      httpClient,
      walletState: state,
      canonicalRoles: material.canonicalRoles!,
      installedNetworkTag: 'MONT',
      relayBaseUrl: 'https://a.example',
      runCanonicalExclusive: exclusive,
    })
  let client = createClient()
  const prepared = (id = 1) => {
    const saved = seal(id)
    return client.bindPrepared({
      payload: saved.payload,
      context: saved.context,
      stampValueWei: 32n,
      economicBinding: Uint8Array.of(1),
    })
  }
  const prepare = (
    id: number,
    onIntentDurable: (link: CanonicalWorkflowLink) => Promise<void>,
  ) =>
    client.prepareIntent({
      prepared: prepared(id),
      consumerId: `workflow-${id}`,
      stampValueWei: 32n,
      senderCurrent,
      recipientCurrent,
      overrides: {
        ...FEE_OVERRIDES,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
        chainId: 10143n,
      },
      onIntentDurable,
    })
  return {
    location,
    get client() {
      return client
    },
    get state() {
      return state
    },
    get canonicalJournal() {
      return captured.canonical!
    },
    get nativeJournal() {
      return captured.native!
    },
    reopenOwner: async (
      canonicalEnabled = true,
      preserveLiveLeaseManager = false,
    ) => {
      await queue
      await state.close()
      if (!preserveLiveLeaseManager)
        leaseManager = new SubAccountLeaseManager(pool)
      state = await openOwner(canonicalEnabled)
      if (canonicalEnabled) client = createClient()
    },
    incomingRecovery,
    rotateOwnStamp,
    material,
    senderDirectory,
    senderExport,
    subStore,
    pool,
    get leaseManager() {
      return leaseManager
    },
    providerCalls,
    provider,
    httpClient,
    prepared,
    prepare,
    senderCurrent,
    recipientCurrent,
    ordinaryOperation: async (operation: () => Promise<void>) => {
      enclosed = true
      try {
        return await state.runOperation(operation)
      } finally {
        enclosed = false
      }
    },
    close: async () => {
      await queue
      await state.close()
      await subStore.Close()
      await changeStore.Close()
      await senderDirectory.close()
      await recipientDirectory.close()
      provider.destroy()
      material.dispose()
      recipient.dispose()
      await rm(location, { recursive: true, force: true })
    },
  }
}
function makeMockHttpClientForCanonical(): jest.Mocked<MonadTxSubmitter> {
  return { submitRawTransaction: jest.fn(), getTransactionReceipt: jest.fn() }
}

describe('canonical durable consumer barriers', () => {
  it('native_prepare_blocks_canonical_same_pair before another durable authorization or signature', async () => {
    const f = await makeCanonicalConsumerFixture({
      beforeOwnerOpen: async (journal, material) => {
        const address = material.keyring
          .deriveSubAccount(0)
          .address.toLowerCase()
        await journal.prepare({
          kind: 'native',
          recipient: '0x' + '12'.repeat(20),
          intendedValueWei: '32',
          members: [
            {
              source: { kind: 'spend', index: 0, address },
              dependencies: [],
              unsignedTransaction: Transaction.from({
                type: 2,
                chainId: 10143n,
                nonce: 0,
                to: '0x' + '12'.repeat(20),
                value: 32n,
                gasLimit: 50000n,
                maxFeePerGas: 2n,
                maxPriorityFeePerGas: 1n,
              }).unsignedSerialized,
            },
          ],
        })
      },
    })
    const sign = jest.spyOn(
      MonadAccountTxSigner.prototype,
      'signFrozenUnsigned',
    )
    const linked = jest.fn(async () => undefined)
    try {
      await expect(f.prepare(1, linked)).rejects.toThrow()
      expect(f.state.nativeJournal!.list()).toHaveLength(1)
      expect(f.state.canonicalJournal!.getIntents()).toEqual([])
      expect(sign).not.toHaveBeenCalled()
      expect(linked).not.toHaveBeenCalled()
      expect(f.pool.getRecord(0)!.status).toBe('available')
    } finally {
      sign.mockRestore()
      await f.close()
    }
  }, 20000)

  it('equivalent_retained_evidence_is_not_a_second_authorization', async () => {
    await withCanonicalConsumer(async f => {
      let link!: CanonicalWorkflowLink
      await f.prepare(1, async value => {
        link = value
      })
      const attempt = await f.client.finishIntent(
        f.client.reconcileWorkflowLinks([link])[0]!.eligibility!,
      )
      const rawTx =
        '0x' +
        Buffer.from(attempt.request.parts.transactions[0]!).toString('hex')
      const tx = Transaction.from(rawTx)
      f.pool.recordSpendTransaction(0, {
        rawTx,
        txHash: tx.hash!,
        valueWei: tx.value.toString(),
      })
      await f.pool.flush()
      await f.state.runLifetime(async lifetime => {
        const snapshot = f.state.inputAdmission.inspect(lifetime)
        expect(snapshot.status).toBe('ready')
        if (snapshot.status !== 'ready') throw new Error(snapshot.reason)
        expect(
          snapshot.obligations
            .filter(o => o.transaction?.transactionHash === tx.hash)
            .map(o => o.provenance.kind),
        ).toEqual(['canonical-attempt', 'pool-retained', 'live-lease'])
      })
    })
  })
  it('non-canonical reopening still validates and protects retained canonical obligations without granting signing authority', async () => {
    await withCanonicalConsumer(async f => {
      await expect(
        f.prepare(1, async () => {
          throw new Error('link interrupted')
        }),
      ).rejects.toThrow('link interrupted')
      const expected = f.canonicalJournal.getIntents()
      await f.reopenOwner(false)
      expect(f.state.canonicalJournal).toBeUndefined()
      expect(f.state.canonicalRetained!.getIntents()).toEqual(expected)
      const copy = f.state.canonicalRetained!.getIntents()
      copy[0]!.prepared.payload.fill(0)
      expect(f.state.canonicalRetained!.getIntents()).toEqual(expected)
      await f.state.runLifetime(async lifetime => {
        const snapshot = f.state.inputAdmission.inspect(lifetime)
        expect(snapshot.status).toBe('ready')
        if (snapshot.status !== 'ready') throw new Error(snapshot.reason)
        expect(
          snapshot.obligations.some(
            o => o.provenance.kind === 'canonical-intent',
          ),
        ).toBe(true)
        await expect(
          f.state.inputAdmission.authorizeCanonicalSigning(
            lifetime,
            expected[0]!.attemptRef,
          ),
        ).rejects.toThrow('invalid-provenance')
      })
    })
  })
  it('canonical_prepare_blocks_native_same_pair without a second durable authorization', async () => {
    await withCanonicalConsumer(async f => {
      await expect(
        f.prepare(1, async () => {
          throw new Error('link interrupted')
        }),
      ).rejects.toThrow('link interrupted')
      const member = f.canonicalJournal.getIntents()[0]!.members[0]!
      await f.state.runLifetime(async lifetime => {
        const snapshot = f.state.inputAdmission.inspect(lifetime)
        if (snapshot.status !== 'ready') throw new Error(snapshot.reason)
        await expect(
          f.state.inputAdmission.prepareNative(lifetime, snapshot.epoch, {
            kind: 'native',
            recipient: Transaction.from(
              member.unsignedSerialized,
            ).to!.toLowerCase(),
            intendedValueWei: '32',
            members: [
              {
                source: { kind: 'spend', index: 0, address: member.from },
                dependencies: [],
                unsignedTransaction: member.unsignedSerialized,
              },
            ],
          }),
        ).rejects.toThrow('conflicting-authorization')
      })
      expect(f.state.nativeJournal!.list()).toEqual([])
      expect(f.canonicalJournal.getIntents()).toHaveLength(1)
    })
  })
  it.each(['native', 'canonical'] as const)(
    '%s resumed signing rechecks conflicting durable authorization after reopen',
    async kind => {
      await withCanonicalConsumer(async f => {
        let link!: CanonicalWorkflowLink
        await expect(
          f.prepare(1, async value => {
            link = value
            throw new Error('link interrupted')
          }),
        ).rejects.toThrow('link interrupted')
        const member = f.canonicalJournal.getIntents()[0]!.members[0]!
        // Simulate the two independently retained historical owners; equal bytes do not merge authorization.
        const native = await f.nativeJournal.prepare({
          kind: 'native',
          recipient: Transaction.from(
            member.unsignedSerialized,
          ).to!.toLowerCase(),
          intendedValueWei: '32',
          members: [
            {
              source: { kind: 'spend', index: 0, address: member.from },
              dependencies: [],
              unsignedTransaction: member.unsignedSerialized,
            },
          ],
        })
        await f.reopenOwner()
        const originalNative = f.state.nativeJournal!.list(),
          originalCanonical = f.canonicalJournal.getIntents()
        const canonicalSign = jest.spyOn(
          MonadAccountTxSigner.prototype,
          'signFrozenUnsigned',
        )
        const nativeSign = jest.fn(async () => {
          throw new Error('must not sign')
        })
        try {
          if (kind === 'canonical') {
            const token = f.client.reconcileWorkflowLinks([link])[0]!
              .eligibility!
            await expect(f.client.finishIntent(token)).rejects.toThrow(
              'conflicting-authorization',
            )
          } else {
            const executor = new EvmLegacyConsolidator({
              journal: f.state.nativeJournal!,
              inputAdmission: f.state.inputAdmission,
              provider: f.provider,
              transactionBuilder: new NativeEvmTransactionBuilder(),
              getSources: async () => [],
              sign: nativeSign,
            })
            await expect(
              f.state.runLifetime(lifetime =>
                executor.resumeOperation(native.operationId, lifetime),
              ),
            ).rejects.toThrow('conflicting-authorization')
          }
          expect(nativeSign).not.toHaveBeenCalled()
          expect(canonicalSign).not.toHaveBeenCalled()
          // A refused native resume cancels its own never-signed plan (#1235); the canonical
          // path leaves the native plan alone. Nothing else in either journal moves.
          expect(f.state.nativeJournal!.list()).toEqual(
            kind === 'canonical'
              ? originalNative
              : originalNative.map(row => ({ ...row, cancelled: true })),
          )
          expect(f.canonicalJournal.getIntents()).toEqual(originalCanonical)
        } finally {
          canonicalSign.mockRestore()
        }
      })
    },
  )
  it('disjoint native admission progresses while the canonical durable-link callback is blocked', async () => {
    await withCanonicalConsumer(async f => {
      f.pool.ensureSize(2)
      await f.pool.flush()
      const entered = canonicalBarrier(),
        release = canonicalBarrier()
      const preparing = f.prepare(1, async () => {
        entered.resolve()
        await release.promise
      })
      await entered.promise
      try {
        await f.state.runLifetime(async lifetime => {
          const snapshot = f.state.inputAdmission.inspect(lifetime)
          if (snapshot.status !== 'ready') throw new Error(snapshot.reason)
          const address = f.material.keyring
            .deriveSubAccount(1)
            .address.toLowerCase()
          await f.state.inputAdmission.prepareNative(lifetime, snapshot.epoch, {
            kind: 'native',
            recipient: '0x' + '12'.repeat(20),
            intendedValueWei: '32',
            members: [
              {
                source: { kind: 'spend', index: 1, address },
                dependencies: [],
                unsignedTransaction: Transaction.from({
                  type: 2,
                  chainId: 10143n,
                  nonce: 0,
                  to: '0x' + '12'.repeat(20),
                  value: 32n,
                  gasLimit: 21000n,
                  maxFeePerGas: 2n,
                  maxPriorityFeePerGas: 1n,
                }).unsignedSerialized,
              },
            ],
          })
        })
        expect(f.state.nativeJournal!.list()).toHaveLength(1)
        expect(f.canonicalJournal.getIntents()).toHaveLength(1)
      } finally {
        release.resolve()
        await preparing
      }
    })
  })
  it.each(['release', 'reject'] as const)(
    'starts no actual pool write, signature or callback before Level intent completion: %s',
    async outcome => {
      await withCanonicalConsumer(async f => {
        const db = (
          f.canonicalJournal as unknown as {
            database: { batch: (...args: unknown[]) => Promise<unknown> }
          }
        ).database
        const original = db.batch.bind(db),
          entered = canonicalBarrier(),
          gate = canonicalBarrier()
        const batch = jest.spyOn(db, 'batch').mockImplementation((...args) => {
          entered.resolve()
          return gate.promise.then(() => original(...args))
        })
        const poolWrite = jest.spyOn(f.subStore, 'putMany'),
          sign = jest.spyOn(
            MonadAccountTxSigner.prototype,
            'signFrozenUnsigned',
          ),
          linked = jest.fn(async () => undefined)
        const result = f.prepare(1, linked).then(
          () => null,
          error => error,
        )
        await entered.promise
        expect(poolWrite).not.toHaveBeenCalled()
        expect(sign).not.toHaveBeenCalled()
        expect(linked).not.toHaveBeenCalled()
        expect(f.httpClient.submitRawTransaction).not.toHaveBeenCalled()
        if (outcome === 'reject')
          gate.reject(new Error('actual intent completion rejected'))
        else gate.resolve()
        const error = await result
        batch.mockRestore()
        poolWrite.mockRestore()
        sign.mockRestore()
        if (outcome === 'reject') {
          expect(error.message).toBe('actual intent completion rejected')
          expect(linked).not.toHaveBeenCalled()
        } else {
          expect(error).toBeNull()
          expect(linked).toHaveBeenCalledTimes(1)
          expect(f.pool.getRecord(0)!.status).toBe('in-use')
        }
      })
    },
    20000,
  )
  it('keeps the owner valid after delivered cleanup marks accounts spent', async () => {
    await withCanonicalConsumer(async f => {
      let link!: CanonicalWorkflowLink
      await f.prepare(1, async durable => {
        link = durable
      })
      const attempt = await f.client.finishIntent(
        f.client.reconcileWorkflowLinks([link])[0].eligibility!,
      )
      const body = new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          phase: 'delivered',
          identity: attempt.request.identity,
          mailbox_committed_at_ms: 1,
        }),
      )
      const accepted = await f.client.submit(
        f.client.reconcileWorkflowLinks([link])[0].eligibility!,
        {
          fetch: async url => {
            let done = false
            return {
              status: 200,
              url,
              headers: {
                get: name =>
                  name === 'content-type' ? 'application/json' : null,
              },
              body: {
                getReader: () => ({
                  read: async () =>
                    done
                      ? { done: true }
                      : ((done = true), { done: false, value: body }),
                  cancel: async () => undefined,
                  releaseLock: () => undefined,
                }),
              },
            }
          },
        },
      )
      expect(accepted.phase).toBe('delivered')
      await f.client.cleanupTerminal(link.attemptRef, link.consumerId)
      const record = f.pool.getRecord(0)!
      expect(record.status).toBe('spent')
      expect(record.lifecycle?.spend?.rawTx).toBe(
        `0x${toHex(attempt.request.parts.transactions[0])}`,
      )
      // #826: a canonical stamp payment is a plain value transfer. No calldata, and in
      // particular no constant `POND` tag, may appear in any signed member.
      expect(attempt.request.parts.transactions.length).toBeGreaterThan(0)
      for (const raw of attempt.request.parts.transactions) {
        const signed = Transaction.from(`0x${toHex(raw)}`)
        expect(signed.data).toBe('0x')
        expect(toHex(raw)).not.toContain('504f4e44')
      }
      expect(() => f.state.assertSemanticallyValid()).not.toThrow()
      expect(f.client.terminalOutcomes()).toHaveLength(1)
      await f.client.acknowledgeWorkflow(link.attemptRef, link.consumerId)
      expect(f.client.wasAcknowledged(link.attemptRef)).toBe(true)
    })
  }, 20000)
  it('generates Type 1 delivery frames carrying co-located recipient P (field 5) and DLEQ proof (field 6) (#964)', async () => {
    await withCanonicalConsumer(async f => {
      let link!: CanonicalWorkflowLink
      await f.prepare(1, async durable => {
        link = durable
      })
      const attempt = await f.client.finishIntent(
        f.client.reconcileWorkflowLinks([link])[0].eligibility!,
      )
      const delivery = attempt.request.parts.delivery
      const parsed = validateFrame(delivery, defaultContext())
      expect(parsed.kind).toBe('parsed')
      if (parsed.kind !== 'parsed' || parsed.typed?.type !== 1) {
        throw new Error('Expected parsed type 1 delivery frame')
      }
      // Inspect the prepared envelope to get the expected recipient and DLEQ proof
      const envelope = inspectCanonicalPreparedEnvelope(
        link.prepared.payload,
        link.prepared.context,
      )

      // Field 5: recipient identity P (keyType 1, 33 bytes)
      expect(parsed.typed.recipient).toBeDefined()
      expect(parsed.typed.recipient).toEqual(envelope.payload.recipient)
      expect(parsed.typed.recipient?.keyType).toBe(1)
      expect(parsed.typed.recipient?.keyBytes.length).toBe(33)

      // Field 6: Chaum-Pedersen DLEQ proof (64 bytes)
      expect(parsed.typed.dleqProof).toBeDefined()
      expect(parsed.typed.dleqProof).toEqual(envelope.payload.dleqProof)
      expect(parsed.typed.dleqProof?.length).toBe(64)

      // Raw CBOR frame payload has keys 5 and 6
      const payloadMap = parsed.payload as Map<bigint, unknown>
      expect(payloadMap.has(5n)).toBe(true)
      expect(payloadMap.has(6n)).toBe(true)

      // Request identity recipient derives from co-located recipient P directly
      expect(attempt.request.identity.recipient).toBe(
        '0x' +
          toHex(
            addressFromCompressedPubkey(envelope.payload.recipient.keyBytes),
          ),
      )
    })
  }, 20000)
  it('only the issued current lease can correlate with its bound canonical intent', async () => {
    await withCanonicalConsumer(async f => {
      let link!: CanonicalWorkflowLink
      const acquire = jest.spyOn(f.leaseManager, 'acquireForIndex')
      await f.prepare(1, async value => {
        link = value
      })
      const handle = acquire.mock.results[0]!.value
      const forged = { ...handle }
      expect(f.leaseManager.isCurrentLease(forged)).toBe(false)
      expect(() => f.leaseManager.releaseLease(forged, 'unused')).toThrow()
      f.pool.ensureSize(2)
      f.pool.setStatus(1, 'available')
      await f.state.runLifetime(async lifetime => {
        const pool = canonicalAdmissionPool(f.state.inputAdmission, lifetime)
        await expect(pool.acquire(1, link.attemptRef)).rejects.toThrow(
          'invalid-provenance',
        )
        await expect(pool.acquire(1, 'fabricated-attempt')).rejects.toThrow(
          'invalid-provenance',
        )
      })
      expect(f.leaseManager.isLeased(1)).toBe(false)
      // The intent is still unsigned, so explicit unused release is valid in this fixture.
      expect(
        f.canonicalJournal
          .getIntents()[0]!
          .members.every(member => member.rawTx === null),
      ).toBe(true)
      f.leaseManager.releaseLease(handle, 'unused')
      const foreign = f.leaseManager.acquireForIndex(0)
      expect(f.leaseManager.isCurrentLease(handle)).toBe(false)
      expect(f.leaseManager.isCurrentLease(foreign)).toBe(true)
      const sign = jest.spyOn(
        MonadAccountTxSigner.prototype,
        'signFrozenUnsigned',
      )
      await expect(
        f.client.finishIntent(
          f.client.reconcileWorkflowLinks([link])[0].eligibility!,
        ),
      ).rejects.toThrow('conflicting-authorization')
      expect(sign).not.toHaveBeenCalled()
      expect(f.canonicalJournal.getIntents()).toHaveLength(1)
      sign.mockRestore()
    })
  }, 20000)
  it('a reopened admission does not inherit the prior live lease correlation', async () => {
    await withCanonicalConsumer(async f => {
      let link!: CanonicalWorkflowLink
      await f.prepare(1, async value => {
        link = value
      })
      await f.reopenOwner(true, true)
      const sign = jest.spyOn(
        MonadAccountTxSigner.prototype,
        'signFrozenUnsigned',
      )
      await expect(
        f.client.finishIntent(
          f.client.reconcileWorkflowLinks([link])[0].eligibility!,
        ),
      ).rejects.toThrow('conflicting-authorization')
      expect(sign).not.toHaveBeenCalled()
      expect(f.canonicalJournal.getIntents()).toHaveLength(1)
      sign.mockRestore()
    })
  }, 20000)
  it('healthy promoted replay after restart sends the original exact bytes without resigning', async () => {
    await withCanonicalConsumer(async f => {
      let link!: CanonicalWorkflowLink
      await f.prepare(1, async value => {
        link = value
      })
      const attempt = await f.client.finishIntent(
        f.client.reconcileWorkflowLinks([link])[0].eligibility!,
      )
      await f.reopenOwner()
      const sign = jest.spyOn(
        MonadAccountTxSigner.prototype,
        'signFrozenUnsigned',
      )
      const fetch = jest.fn<
        ReturnType<CanonicalFetch>,
        Parameters<CanonicalFetch>
      >(async () => {
        throw new Error('lost relay response')
      })
      await expect(
        f.client.submit(
          f.client.reconcileWorkflowLinks([link])[0].eligibility!,
          { fetch },
        ),
      ).rejects.toThrow('Canonical submission outcome is unknown')
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch.mock.calls[0]![1].body).toEqual(attempt.request.body)
      expect(f.canonicalJournal.getAll()[0]!.request.body).toEqual(
        attempt.request.body,
      )
      expect(sign).not.toHaveBeenCalled()
      sign.mockRestore()
    })
  }, 20000)
  it('promoted replay rechecks foreign durable claims before any relay exposure', async () => {
    await withCanonicalConsumer(async f => {
      let link!: CanonicalWorkflowLink
      await f.prepare(1, async value => {
        link = value
      })
      const attempt = await f.client.finishIntent(
        f.client.reconcileWorkflowLinks([link])[0].eligibility!,
      )
      const tx = Transaction.from(
        hexlify(attempt.request.parts.transactions[0]),
      )
      await f.nativeJournal.prepare({
        kind: 'native',
        recipient: tx.to!.toLowerCase(),
        intendedValueWei: tx.value.toString(),
        members: [
          {
            source: {
              kind: 'spend',
              index: 0,
              address: tx.from!.toLowerCase(),
            },
            dependencies: [],
            unsignedTransaction: tx.unsignedSerialized,
          },
        ],
      })
      await f.reopenOwner()
      const originalNative = f.nativeJournal.list(),
        originalCanonical = f.canonicalJournal.getAll()
      const fetch = jest.fn(async () => {
        throw new Error('unexpected relay exposure')
      })
      await expect(
        f.client.submit(
          f.client.reconcileWorkflowLinks([link])[0].eligibility!,
          { fetch },
        ),
      ).rejects.toThrow('conflicting-authorization')
      expect(fetch).not.toHaveBeenCalled()
      expect(f.nativeJournal.list()).toEqual(originalNative)
      expect(f.canonicalJournal.getAll()).toEqual(originalCanonical)
    })
  }, 20000)
  it('sends nothing to the relay when the journal refuses replay admission', async () => {
    await withCanonicalConsumer(async f => {
      let link!: CanonicalWorkflowLink
      await f.prepare(1, async durable => {
        link = durable
      })
      await f.client.finishIntent(
        f.client.reconcileWorkflowLinks([link])[0].eligibility!,
      )
      const refused = new Error('replay admission refused')
      jest.spyOn(f.canonicalJournal!, 'beginReplay').mockRejectedValue(refused)
      const fetch = jest.fn(async () => {
        throw new Error('relay must not be contacted')
      })
      await expect(
        f.client.submit(
          f.client.reconcileWorkflowLinks([link])[0].eligibility!,
          { fetch },
        ),
      ).rejects.toBe(refused)
      expect(fetch).not.toHaveBeenCalled()
    })
  }, 20000)
  it('retains callback-failed prelease intent and excludes its available account from canonical and topic selection', async () => {
    await withCanonicalConsumer(async f => {
      await expect(
        f.prepare(1, async () => {
          throw new Error('workflow fsync failed')
        }),
      ).rejects.toThrow('workflow fsync failed')
      expect(f.pool.getRecord(0)!.status).toBe('available')
      const first = f.canonicalJournal!.getIntents()[0]
      expect(first.members[0].reservation.index).toBe(0)
      const ordinary = jest.fn(async () => undefined)
      await expect(f.ordinaryOperation(ordinary)).rejects.toThrow(
        'Canonical pre-sign intent',
      )
      expect(ordinary).not.toHaveBeenCalled()
      const legacy = new MonadStampClient({
        pool: f.pool,
        leaseManager: f.leaseManager,
        provider: f.provider,
        httpClient: f.httpClient,
        relayBaseUrl: 'https://a.example',
      })
      await expect(
        legacy.submitStampedMessage({
          encryptedPayload: Uint8Array.of(1),
          recipientPublicKey: RECIPIENT_PUBLIC_KEY,
          stampValueWei: 32n,
        }),
      ).rejects.toThrow('Canonical pre-sign intent')
      const sign = jest.spyOn(
        MonadAccountTxSigner.prototype,
        'signFrozenUnsigned',
      )
      await expect(f.prepare(2, async () => undefined)).rejects.toThrow()
      expect(sign).not.toHaveBeenCalled()
      sign.mockRestore()
      expect(f.canonicalJournal!.getIntents()).toHaveLength(1)
    })
  }, 20000)
  it('holds canonical intent persistence behind a direct legacy quote admission', async () => {
    await withCanonicalConsumer(async f => {
      let releaseQuote!: () => void
      let observedQuote!: () => void
      const held = new Promise<void>(resolve => {
        releaseQuote = resolve
      })
      const observed = new Promise<void>(resolve => {
        observedQuote = resolve
      })
      f.providerCalls.mockImplementation(async req => {
        if (req.method === 'getBalance') {
          observedQuote()
          await held
          throw new Error('held legacy quote rejected')
        }
        throw new Error(`unexpected held quote ${req.method}`)
      })
      const legacy = new MonadStampClient({
        pool: f.pool,
        leaseManager: f.leaseManager,
        provider: f.provider,
        httpClient: f.httpClient,
        relayBaseUrl: 'https://a.example',
      })
      const write = jest.spyOn(f.subStore, 'putMany')
      const sign = jest.spyOn(
        MonadAccountTxSigner.prototype,
        'buildAndSignTransfer',
      )
      const legacyResult = legacy
        .submitStampedMessage({
          encryptedPayload: Uint8Array.of(1),
          recipientPublicKey: RECIPIENT_PUBLIC_KEY,
          stampValueWei: 32n,
        })
        .catch(error => error)
      await observed
      const callback = jest.fn(async () => {
        throw new Error('link was not synced')
      })
      const canonicalResult = f.prepare(1, callback).catch(error => error)
      await new Promise(resolve => setImmediate(resolve))
      expect(f.canonicalJournal!.getIntents()).toHaveLength(0)
      expect(callback).not.toHaveBeenCalled()
      expect(write).not.toHaveBeenCalled()
      expect(sign).not.toHaveBeenCalled()
      f.providerCalls.mockImplementation(async req => {
        if (req.method === 'getBalance') return 1000000000n
        if (req.method === 'getTransactionCount') return 0
        if (req.method === 'estimateGas') return 50000n
        throw new Error(`unexpected canonical quote ${req.method}`)
      })
      releaseQuote()
      expect(await legacyResult).toBeInstanceOf(Error)
      expect(await canonicalResult).toBeInstanceOf(Error)
      expect(callback).toHaveBeenCalledTimes(1)
      expect(f.canonicalJournal!.getIntents()).toHaveLength(1)
      expect(write).not.toHaveBeenCalled()
      expect(sign).not.toHaveBeenCalled()
      await expect(
        legacy.submitStampedMessage({
          encryptedPayload: Uint8Array.of(1),
          recipientPublicKey: RECIPIENT_PUBLIC_KEY,
          stampValueWei: 32n,
        }),
      ).rejects.toThrow('Canonical pre-sign intent')
      write.mockRestore()
      sign.mockRestore()
    })
  }, 20000)
  it('rejects a foreign live lease before signing the correlated intent', async () => {
    await withCanonicalConsumer(async f => {
      const saved = f.prepared(1)
      await expect(
        f.prepare(1, async () => {
          throw new Error('no durable link')
        }),
      ).rejects.toThrow()
      const intent = f.canonicalJournal!.getIntents()[0]
      const foreign = f.leaseManager.acquireForIndex(0)
      await f.pool.flush()
      const links = [
        {
          attemptRef: intent.attemptRef,
          consumerId: intent.consumerId,
          prepared: intent.prepared,
        },
      ]
      const eligibility = f.client.reconcileWorkflowLinks(links)[0].eligibility!
      const sign = jest.spyOn(
        MonadAccountTxSigner.prototype,
        'signFrozenUnsigned',
      )
      await expect(f.client.finishIntent(eligibility)).rejects.toThrow(
        'conflicting-authorization',
      )
      expect(sign).not.toHaveBeenCalled()
      sign.mockRestore()
      f.leaseManager.releaseLease(foreign, 'unused')
      await f.pool.flush()
      expect(saved.payload.length).toBeGreaterThan(0)
    })
  }, 20000)
  it('rejects extra role-map context keys before provider, selection, callback or signature', async () => {
    await withCanonicalConsumer(async f => {
      const prepared = f.prepared(1),
        context = decodeCanonical(prepared.context) as Map<
          bigint,
          Map<bigint, unknown>
        >
      context.get(6n)!.set(2n, new Uint8Array(1))
      f.providerCalls.mockClear()
      const write = jest.spyOn(f.subStore, 'putMany'),
        sign = jest.spyOn(MonadAccountTxSigner.prototype, 'signFrozenUnsigned'),
        callback = jest.fn(async () => undefined)
      expect(() =>
        f.client.prepareIntent({
          prepared: { ...prepared, context: encodeCanonical(context as never) },
          consumerId: 'workflow-1',
          stampValueWei: 32n,
          senderCurrent: f.senderCurrent,
          recipientCurrent: f.recipientCurrent,
          onIntentDurable: callback,
        }),
      ).toThrow('canonical-stamp:role')
      expect(f.providerCalls).not.toHaveBeenCalled()
      expect(write).not.toHaveBeenCalled()
      expect(sign).not.toHaveBeenCalled()
      expect(callback).not.toHaveBeenCalled()
      write.mockRestore()
      sign.mockRestore()
    })
  }, 20000)
  it('retains public recovery accounts and verifies original custody after directory freshness expires', async () => {
    await withCanonicalConsumer(async f => {
      const input = await f.incomingRecovery()
      const imported = await f.client.importRecovery(input)
      expect(imported.accounts).toHaveLength(1)
      expect(imported.accounts[0].valueWei).toBe('32')
      expect(imported.recipientAcknowledged).toBe(false)
      expect(Object.keys(imported.accounts[0])).toEqual([
        'childIndex',
        'transactionHash',
        'address',
        'valueWei',
      ])
      await expect(
        f.senderDirectory.current({
          now: { seconds: 3701n, nanoseconds: 0 },
          relay: f.senderExport.configuration.relay,
        }),
      ).rejects.toThrow()
      expect(() =>
        f.client.verifyImportedRecoveryCustody(imported.obligationId),
      ).not.toThrow()
      const reopenedMaterial = createMonadWalletMaterial(canonicalTestRoots(0))
      try {
        expect(() =>
          reopenedMaterial.canonicalRoles!.verifyRetainedRecoveryCustody(
            f.canonicalJournal!.retainedRecoveryCustody(imported.obligationId),
          ),
        ).not.toThrow()
        expect(() =>
          reopenedMaterial.canonicalRoles!.verifyRetainedRecoveryCustody({
            obligationId: imported.obligationId,
          }),
        ).toThrow()
      } finally {
        reopenedMaterial.dispose()
      }
      const foreign = createMonadWalletMaterial(canonicalTestRoots(1))
      try {
        expect(() =>
          foreign.canonicalRoles!.verifyRetainedRecoveryCustody(
            f.canonicalJournal!.retainedRecoveryCustody(imported.obligationId),
          ),
        ).toThrow('retained-custody')
      } finally {
        foreign.dispose()
      }
    })
  }, 20000)
  it('holds ACK behind real import completion and retains the exact acknowledged row', async () => {
    await withCanonicalConsumer(async f => {
      const input = await f.incomingRecovery()
      const journal = f.canonicalJournal!
      const db = (
        journal as unknown as {
          database: { put: (...args: unknown[]) => Promise<void> }
        }
      ).database
      const original = db.put.bind(db),
        entered = canonicalBarrier(),
        gate = canonicalBarrier()
      const write = jest
        .spyOn(db, 'put')
        .mockImplementation(async (...args) => {
          entered.resolve()
          await gate.promise
          return original(...args)
        })
      const ack = jest
        .spyOn(canonicalMailboxModule, 'ackCanonicalRecovery')
        .mockResolvedValue(undefined)
      const importing = f.client.importRecovery(input)
      await entered.promise
      const auth = {
        expectedNetworkTag: 'MONT' as const,
        subject: toHex(f.senderExport.auth.compressedPoint),
        recipient: input.record.identity.recipient,
        relayBaseUrl: 'https://a.example',
        getCurrent: async () => f.senderCurrent,
        signDigest: async (digest: Uint8Array) =>
          new Uint8Array(f.material.identity.signHash(Buffer.from(digest))),
      }
      const acknowledging = f.client.ackImportedRecovery(
        input.record.obligationId,
        auth,
      )
      expect(journal.getImportedRecoveries()).toEqual([])
      expect(ack).not.toHaveBeenCalled()
      gate.resolve()
      await importing
      await acknowledging
      expect(ack).toHaveBeenCalledTimes(1)
      const row = journal.importedRecovery(input.record.obligationId)!
      expect(row.recipientAcknowledged).toBe(true)
      await f.client.ackImportedRecovery(input.record.obligationId, auth)
      expect(ack).toHaveBeenCalledTimes(1)
      expect(
        journal.importedRecovery(input.record.obligationId)!.accounts,
      ).toEqual(row.accounts)
      write.mockRestore()
      ack.mockRestore()
    })
  }, 20000)
  it('retains a pending prefix without ACK and rejects changed terminal account sets', async () => {
    await withCanonicalConsumer(async f => {
      const input = await f.incomingRecovery('pending', [])
      await f.client.importRecovery(input)
      const auth = {
        expectedNetworkTag: 'MONT' as const,
        subject: toHex(f.senderExport.auth.compressedPoint),
        recipient: input.record.identity.recipient,
        relayBaseUrl: 'https://a.example',
        getCurrent: async () => f.senderCurrent,
        signDigest: async (digest: Uint8Array) =>
          new Uint8Array(f.material.identity.signHash(Buffer.from(digest))),
      }
      const ack = jest
        .spyOn(canonicalMailboxModule, 'ackCanonicalRecovery')
        .mockResolvedValue(undefined)
      await expect(
        f.client.ackImportedRecovery(input.record.obligationId, auth),
      ).rejects.toThrow('durable-terminal-import')
      expect(ack).not.toHaveBeenCalled()
      await f.client.importRecovery({
        ...input,
        record: {
          ...input.record,
          lifecycle: 'terminal:expired',
          confirmedChildren: [0],
        },
      })
      await expect(
        f.client.importRecovery({
          ...input,
          record: {
            ...input.record,
            lifecycle: 'terminal:expired',
            confirmedChildren: [],
          },
        }),
      ).rejects.toThrow('conflict')
      expect(f.client.importedRecoveries()[0].accounts).toHaveLength(1)
      ack.mockRestore()
    })
  }, 20000)
  it('settles only the exact retained obligation after two actual stamp rotations', async () => {
    await withCanonicalConsumer(async f => {
      const input = await f.incomingRecovery('pending', [])
      await f.client.importRecovery(input)
      const first = await f.rotateOwnStamp(f.senderCurrent, 1n)
      const second = await f.rotateOwnStamp(first, 2n)
      expect(second.generations[1]).toBe(2n)
      expect(second.previousStamp!.keyBytes).not.toEqual(
        f.senderCurrent.stampKey.keyBytes,
      )
      expect(() =>
        f.client.verifyImportedRecoveryCustody(input.record.obligationId),
      ).not.toThrow()
      const terminal = {
        ...input.record,
        lifecycle: 'terminal:expired',
        confirmedChildren: [0],
      }
      const imported = await f.client.importRecovery({ record: terminal })
      expect(imported.stampGeneration).toBe('0')
      expect(imported.accounts).toHaveLength(1)
      expect(() =>
        f.client.importRecovery({
          record: { ...terminal, obligationId: 'ef'.repeat(32) },
        }),
      ).toThrow('new-import-admission')
      await expect(
        Promise.resolve().then(() =>
          f.client.importRecovery({
            record: { ...terminal, confirmedChildren: [] },
          }),
        ),
      ).rejects.toThrow('conflict')
      const changedRaw = terminal.parts.transactions[0].slice()
      changedRaw[changedRaw.length - 1] ^= 1
      await expect(
        Promise.resolve().then(() =>
          f.client.importRecovery({
            record: {
              ...terminal,
              parts: { ...terminal.parts, transactions: [changedRaw] },
            },
          }),
        ),
      ).rejects.toThrow()
      const changedContext = terminal.context.slice()
      changedContext[changedContext.length - 1] ^= 1
      await expect(
        Promise.resolve().then(() =>
          f.client.importRecovery({
            record: {
              ...terminal,
              context: changedContext,
              parts: { ...terminal.parts, context: changedContext },
            },
          }),
        ),
      ).rejects.toThrow()
      expect(f.client.importedRecoveries()[0].request.body).toEqual(
        imported.request.body,
      )
      expect(f.client.importedRecoveries()[0].accounts).toEqual(
        imported.accounts,
      )
    })
  }, 20000)
  it('retains uncertain remote ACK and repeats the exact obligation after reopen', async () => {
    await withCanonicalConsumer(async f => {
      const input = await f.incomingRecovery()
      const imported = await f.client.importRecovery(input)
      const auth = {
        expectedNetworkTag: 'MONT' as const,
        subject: toHex(f.senderExport.auth.compressedPoint),
        recipient: input.record.identity.recipient,
        relayBaseUrl: 'https://a.example',
        getCurrent: async () => f.senderCurrent,
        signDigest: async (digest: Uint8Array) =>
          new Uint8Array(f.material.identity.signHash(Buffer.from(digest))),
      }
      const ack = jest
        .spyOn(canonicalMailboxModule, 'ackCanonicalRecovery')
        .mockRejectedValueOnce(new Error('remote result lost'))
        .mockResolvedValue(undefined)
      await expect(
        f.client.ackImportedRecovery(input.record.obligationId, auth),
      ).rejects.toThrow('result lost')
      expect(f.client.importedRecoveries()[0].recipientAcknowledged).toBe(false)
      await f.reopenOwner()
      expect(f.client.importedRecoveries()[0].accounts).toEqual(
        imported.accounts,
      )
      await f.client.ackImportedRecovery(input.record.obligationId, auth)
      expect(ack).toHaveBeenCalledTimes(2)
      expect(ack.mock.calls[0][0].payloadHashHex).toBe(
        ack.mock.calls[1][0].payloadHashHex,
      )
      expect(ack.mock.calls[0][0].obligationIdHex).toBe(
        ack.mock.calls[1][0].obligationIdHex,
      )
      expect(f.client.importedRecoveries()[0].recipientAcknowledged).toBe(true)
      ack.mockRestore()
    })
  }, 20000)
  it.each(['before', 'after'] as const)(
    'preserves custody through an uncertain local ACK marker: %s commit',
    async phase => {
      await withCanonicalConsumer(async f => {
        const input = await f.incomingRecovery(),
          imported = await f.client.importRecovery(input)
        const auth = {
          expectedNetworkTag: 'MONT' as const,
          subject: toHex(f.senderExport.auth.compressedPoint),
          recipient: input.record.identity.recipient,
          relayBaseUrl: 'https://a.example',
          getCurrent: async () => f.senderCurrent,
          signDigest: async (digest: Uint8Array) =>
            new Uint8Array(f.material.identity.signHash(Buffer.from(digest))),
        }
        const journal = f.canonicalJournal!
        const db = (
          journal as unknown as {
            database: { put: (...args: unknown[]) => Promise<void> }
          }
        ).database
        const original = db.put.bind(db)
        const write = jest
          .spyOn(db, 'put')
          .mockImplementation(async (...args) => {
            if (phase === 'after') await original(...args)
            throw new Error('local acknowledged marker uncertain')
          })
        const ack = jest
          .spyOn(canonicalMailboxModule, 'ackCanonicalRecovery')
          .mockResolvedValue(undefined)
        await expect(
          f.client.ackImportedRecovery(input.record.obligationId, auth),
        ).rejects.toThrow('marker uncertain')
        expect(() => f.client.importedRecoveries()).toThrow('corrupt')
        write.mockRestore()
        await f.reopenOwner()
        expect(f.client.importedRecoveries()[0].accounts).toEqual(
          imported.accounts,
        )
        expect(f.client.importedRecoveries()[0].recipientAcknowledged).toBe(
          phase === 'after',
        )
        expect(() =>
          f.client.verifyImportedRecoveryCustody(input.record.obligationId),
        ).not.toThrow()
        await f.client.ackImportedRecovery(input.record.obligationId, auth)
        expect(ack).toHaveBeenCalledTimes(phase === 'after' ? 1 : 2)
        expect(f.client.importedRecoveries()[0].recipientAcknowledged).toBe(
          true,
        )
        ack.mockRestore()
      })
    },
    20000,
  )

  describe('Issue #1216: quoteStampPaymentGasReserve probe reuse and fee/capacity caching', () => {
    it('executes at most 1 network probe across multiple candidate records and reuses sample quote', async () => {
      const pool = makePool(3)
      const capacities = [15_000n, 25_000n, 35_000n]
      const provider = makeCapacityProvider(capacities)
      const { client } = makeClient({ pool, provider })

      const buildAndSignSpy = jest.spyOn(
        MonadAccountTxSigner.prototype,
        'buildAndSignCall',
      )

      const quotes = await client.quoteStampPaymentGasReserve({
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        overrides: FEE_OVERRIDES,
      })

      // 1 probe execution across all 3 available records
      expect(buildAndSignSpy).toHaveBeenCalledTimes(1)
      expect(quotes).toHaveLength(3)

      // Verify accurate quote calculation across all candidate records
      const feeReserve = FEE_OVERRIDES.gasLimit * FEE_OVERRIDES.maxFeePerGas
      for (let i = 0; i < 3; i++) {
        expect(quotes[i].index).toBe(i)
        expect(quotes[i].balanceWei).toBe(feeReserve + capacities[i])
        expect(quotes[i].capacityWei).toBe(capacities[i])
        expect(quotes[i].resolvedOverrides.maxFeePerGas).toBe(
          FEE_OVERRIDES.maxFeePerGas,
        )
        expect(quotes[i].resolvedOverrides.maxPriorityFeePerGas).toBe(
          FEE_OVERRIDES.maxPriorityFeePerGas,
        )
        expect(quotes[i].resolvedOverrides.gasLimit).toBe(
          FEE_OVERRIDES.gasLimit,
        )
      }

      // Only the first probed record has its nonce recorded from the probe; subsequent records leave nonce undefined
      expect(quotes[0].resolvedOverrides.nonce).toBeDefined()
      expect(quotes[1].resolvedOverrides.nonce).toBeUndefined()
      expect(quotes[2].resolvedOverrides.nonce).toBeUndefined()

      buildAndSignSpy.mockRestore()
    })

    it('reuses in-memory capacityCache to bypass live getBalance RPC calls', async () => {
      const pool = makePool(2)
      const feeReserve = FEE_OVERRIDES.gasLimit * FEE_OVERRIDES.maxFeePerGas
      const now = Date.now()

      // Warm the capacityCache for both records
      pool.capacityCache.set(0, {
        capacityWei: 12_000n,
        checkedAtMs: now,
        balanceWei: feeReserve + 12_000n,
      })
      pool.capacityCache.set(1, {
        capacityWei: 18_000n,
        checkedAtMs: now,
        balanceWei: feeReserve + 18_000n,
      })

      const provider = makeStubProvider(async req => {
        if (req.method === 'getTransactionCount') return '0x0'
        if (req.method === 'getBalance') {
          throw new Error(
            'getBalance should not be called when capacityCache is warm',
          )
        }
        throw new Error(`unexpected _perform: ${req.method}`)
      })

      const { client } = makeClient({ pool, provider })
      const quotes = await client.quoteStampPaymentGasReserve({
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        overrides: FEE_OVERRIDES,
      })

      expect(quotes).toHaveLength(2)
      expect(quotes[0].capacityWei).toBe(12_000n)
      expect(quotes[0].balanceWei).toBe(feeReserve + 12_000n)
      expect(quotes[1].capacityWei).toBe(18_000n)
      expect(quotes[1].balanceWei).toBe(feeReserve + 18_000n)
    })

    it('maintains in-memory fee cache for getFeeData with TTL and deduplicates concurrent passes', async () => {
      const mockFeeData = {
        maxFeePerGas: 25_000_000_000n,
        maxPriorityFeePerGas: 2_000_000_000n,
        gasPrice: null,
        baseFeePerGas: 11_500_000_000n,
      }
      let getFeeDataCallCount = 0
      const provider = makeCapacityProvider([5_000n, 5_000n])
      provider.getFeeData = jest.fn(async () => {
        getFeeDataCallCount++
        return mockFeeData as any
      })

      const { client } = makeClient({ provider })

      // First call fetches from provider
      const fee1 = await client.getFeeData()
      expect(fee1.maxFeePerGas).toBe(mockFeeData.maxFeePerGas)
      expect(fee1.baseFee).toBe(mockFeeData.baseFeePerGas)
      expect(getFeeDataCallCount).toBe(1)

      // Second call within TTL returns cached fee data
      const fee2 = await client.getFeeData()
      expect(fee2).toEqual(fee1)
      expect(getFeeDataCallCount).toBe(1)

      // Concurrent calls share the in-flight promise and do not duplicate queries
      client.clearFeeCache()
      const [c1, c2, c3] = await Promise.all([
        client.getFeeData(),
        client.getFeeData(),
        client.getFeeData(),
      ])
      expect(c1).toEqual(fee1)
      expect(c2).toEqual(fee1)
      expect(c3).toEqual(fee1)
      expect(getFeeDataCallCount).toBe(2)

      // After TTL expiry, fetches fresh fee data
      const expiredFee = await client.getFeeData(0)
      expect(expiredFee.maxFeePerGas).toBe(mockFeeData.maxFeePerGas)
      expect(getFeeDataCallCount).toBe(3)
    })

    it('concurrent quote passes without overrides share cached fee query', async () => {
      const pool = makePool(2)
      const quoteBalance = 50_000_000_000n
      let nonce = 0
      const provider = makeStubProvider(async req => {
        if (req.method === 'getBalance') return `0x${quoteBalance.toString(16)}`
        if (req.method === 'getTransactionCount')
          return `0x${(nonce++).toString(16)}`
        if (req.method === 'estimateGas') return '0x5208'
        throw new Error(`unexpected _perform: ${req.method}`)
      })

      let feeDataCalls = 0
      provider.getFeeData = jest.fn(async () => {
        feeDataCalls++
        return {
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
          gasPrice: null,
        } as any
      })

      const { client } = makeClient({ pool, provider })

      // Two concurrent quote passes with no fee overrides
      const [q1, q2] = await Promise.all([
        client.quoteStampPaymentGasReserve({
          recipientPublicKey: RECIPIENT_PUBLIC_KEY,
          overrides: { gasLimit: 21_000n, chainId: BigInt(CHAIN_ID) },
        }),
        client.quoteStampPaymentGasReserve({
          recipientPublicKey: RECIPIENT_PUBLIC_KEY,
          overrides: { gasLimit: 21_000n, chainId: BigInt(CHAIN_ID) },
        }),
      ])

      expect(q1).toHaveLength(2)
      expect(q2).toHaveLength(2)
      expect(feeDataCalls).toBe(1)
    })
  })
})

describe('canonical payment observation capture', () => {
  async function funded(
    f: Awaited<ReturnType<typeof makeCanonicalConsumerFixture>>,
    count = 1,
  ) {
    f.pool.ensureSize(count)
    await f.pool.flush()
    if (count > 1)
      f.providerCalls.mockImplementation(async req => {
        if (req.method === 'getBalance')
          return FEE_OVERRIDES.gasLimit * 2n + 16n
        if (req.method === 'getTransactionCount') return 0
        if (req.method === 'estimateGas') return 50000n
        throw new Error(`unexpected canonical provider ${req.method}`)
      })
    let link!: CanonicalWorkflowLink
    await f.prepare(1, async durable => {
      link = durable
    })
    return f.client.finishIntent(
      f.client.reconcileWorkflowLinks([link])[0].eligibility!,
    )
  }
  function response(
    raw: Uint8Array,
    provider: JsonRpcProvider,
    status = 1,
    txOverrides: Partial<
      ConstructorParameters<typeof TransactionResponse>[0]
    > = {},
    receiptOverrides: Partial<
      ConstructorParameters<typeof TransactionReceipt>[0]
    > = {},
  ) {
    const tx = Transaction.from('0x' + Buffer.from(raw).toString('hex'))
    const common = {
      hash: tx.hash!,
      from: tx.from!,
      to: tx.to,
      type: tx.type!,
      blockHash: `0x${'12'.repeat(32)}`,
      blockNumber: 42,
      index: 0,
    }
    return {
      transaction: new TransactionResponse(
        {
          ...common,
          nonce: tx.nonce,
          chainId: tx.chainId,
          data: tx.data,
          value: tx.value,
          gasLimit: tx.gasLimit,
          gasPrice: tx.gasPrice ?? 2n,
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
          accessList: tx.accessList,
          authorizationList: tx.authorizationList,
          signature: tx.signature!,
          ...txOverrides,
        },
        provider,
      ),
      receipt: new TransactionReceipt(
        {
          ...common,
          contractAddress: null,
          gasUsed: 21000n,
          cumulativeGasUsed: 21000n,
          gasPrice: 2n,
          logs: [],
          logsBloom: `0x${'00'.repeat(256)}`,
          root: null,
          status,
          ...receiptOverrides,
        },
        provider,
      ),
    }
  }

  it('observes partial and late inclusion of the same independent members without releasing, signing or broadcasting', async () => {
    await withCanonicalConsumer(async f => {
      const attempt = await funded(f, 2)
      expect(attempt.request.parts.transactions).toHaveLength(2)
      const replies = attempt.request.parts.transactions.map(raw =>
        response(raw, f.provider),
      )
      let late = false
      jest
        .spyOn(f.provider, 'getTransaction')
        .mockImplementation(
          async hash =>
            replies.find(
              (reply, i) =>
                reply.transaction.hash === hash && (i === 0 || late),
            )?.transaction ?? null,
        )
      jest
        .spyOn(f.provider, 'getTransactionReceipt')
        .mockImplementation(
          async hash =>
            replies.find(
              (reply, i) => reply.receipt.hash === hash && (i === 0 || late),
            )?.receipt ?? null,
        )
      const sign = jest.spyOn(
        MonadAccountTxSigner.prototype,
        'signFrozenUnsigned',
      )
      try {
        const partial = await f.client.capturePaymentObservations(
          attempt.prepared,
        )
        expect(partial.kind).toBe('recorded')
        if (partial.kind !== 'recorded')
          throw new Error('expected current capture')
        expect(
          partial.observations.members.map(member => member.state),
        ).toEqual(['observed', 'missing'])
        late = true
        const full = await f.client.capturePaymentObservations(attempt.prepared)
        expect(full.kind).toBe('recorded')
        if (full.kind !== 'recorded')
          throw new Error('expected current capture')
        expect(full.observations.members.map(member => member.state)).toEqual([
          'observed',
          'observed',
        ])
        expect(f.canonicalJournal!.getAll()).toEqual([attempt])
        for (const reservation of attempt.reservations)
          expect(f.pool.getRecord(reservation.index)!.status).toBe('in-use')
        expect(sign).not.toHaveBeenCalled()
        expect(f.httpClient.submitRawTransaction).not.toHaveBeenCalled()
      } finally {
        sign.mockRestore()
      }
    })
  }, 20000)

  it.each([
    'reverted',
    'missing',
    'pending',
    'rpc-error',
    'wrong-chain',
    'wrong-value',
    'wrong-receipt-hash',
    'wrong-block',
    'missing-transaction',
  ] as const)(
    'distinguishes %s from successful inclusion and never grants cleanup',
    async mode => {
      await withCanonicalConsumer(async f => {
        const attempt = await funded(f)
        const reply = response(
          attempt.request.parts.transactions[0],
          f.provider,
          mode === 'reverted' ? 0 : 1,
          mode === 'wrong-chain'
            ? { chainId: 1n }
            : mode === 'wrong-value'
            ? { value: 999n }
            : {},
          mode === 'wrong-receipt-hash'
            ? { hash: `0x${'ff'.repeat(32)}` }
            : mode === 'wrong-block'
            ? { blockNumber: 100 }
            : {},
        )
        jest
          .spyOn(f.provider, 'getTransaction')
          .mockImplementation(async () => {
            if (mode === 'rpc-error') throw new Error('offline RPC unavailable')
            return mode === 'missing' || mode === 'missing-transaction'
              ? null
              : reply.transaction
          })
        jest
          .spyOn(f.provider, 'getTransactionReceipt')
          .mockResolvedValue(
            mode === 'missing' || mode === 'pending' ? null : reply.receipt,
          )
        const result = await f.client.capturePaymentObservations(
          attempt.prepared,
        )
        if (result.kind !== 'recorded')
          throw new Error('expected current capture')
        expect(result.observations.members[0].state).toBe(
          ['reverted', 'missing', 'pending'].includes(mode) ? mode : 'unknown',
        )
        expect(f.canonicalJournal!.getAll()).toEqual([attempt])
        expect(f.pool.getRecord(0)!.status).toBe('in-use')
      })
    },
    20000,
  )

  it('leaves admission free during RPC and prevents an older delayed response from overwriting newer evidence', async () => {
    await withCanonicalConsumer(async f => {
      const attempt = await funded(f)
      const reply = response(attempt.request.parts.transactions[0], f.provider)
      const entered = canonicalBarrier(),
        gate = canonicalBarrier()
      jest
        .spyOn(f.provider, 'getTransaction')
        .mockImplementationOnce(async () => {
          entered.resolve()
          await gate.promise
          return null
        })
        .mockResolvedValue(reply.transaction)
      jest
        .spyOn(f.provider, 'getTransactionReceipt')
        .mockResolvedValueOnce(null)
        .mockResolvedValue(reply.receipt)
      const older = f.client.capturePaymentObservations(attempt.prepared)
      await entered.promise
      await f.ordinaryOperation(async () => undefined)
      const newer = await f.client.capturePaymentObservations(attempt.prepared)
      expect(newer.kind).toBe('recorded')
      gate.resolve()
      expect(await older).toEqual({ kind: 'stale' })
      expect(
        f.canonicalJournal!.getPaymentObservations(attempt.attemptRef)!
          .members[0].state,
      ).toBe('observed')
      expect(f.canonicalJournal!.getAll()).toEqual([attempt])
    })
  }, 20000)

  it('rejects foreign wallet/network inputs before RPC and a response after owner close', async () => {
    await withCanonicalConsumer(async f => {
      const attempt = await funded(f)
      const entered = canonicalBarrier(),
        gate = canonicalBarrier()
      const query = jest
        .spyOn(f.provider, 'getTransaction')
        .mockImplementation(async () => {
          entered.resolve()
          await gate.promise
          return null
        })
      jest.spyOn(f.provider, 'getTransactionReceipt').mockResolvedValue(null)
      for (const wrong of [
        { walletBindingId: 'other' },
        { network: 'ethereum-sepolia' },
      ])
        await expect(
          f.client.capturePaymentObservations({
            ...attempt.prepared,
            ...wrong,
          }),
        ).rejects.toThrow('binding-mismatch')
      expect(query).not.toHaveBeenCalled()
      const capture = f.client.capturePaymentObservations(attempt.prepared)
      const rejected = capture.catch(error => error)
      await entered.promise
      await f.state.close()
      gate.resolve()
      expect(await rejected).toBeInstanceOf(Error)
      // The closed owner cannot commit a response into a subsequent wallet session.
    })
  }, 20000)
})

/**
 * #1236 Stage 1: `submit` does not hold the wallet queue while its relay request is in flight.
 *
 * `submit` is three steps: inside the wallet queue it checks the permit and marks the attempt as
 * being replayed; outside the queue, under the wallet lifetime only, it sends the frozen bytes;
 * inside the queue again it records an authenticated final answer. Real typed custody, real Level
 * journals and the real input admission; only the relay's fetch is a stand-in. The fixture's
 * `exclusive` queue stands where the chain's wallet queue stands.
 *
 * Each test says what it reproduces on main (5983ecf6), or that it is a pin: behaviour main already
 * had that this change must keep. A test that reproduces a main failure does so by a bounded wait
 * (`soon`): on main the awaited operation queued behind the unanswered request.
 */
describe('canonical submit outside the wallet queue (#1236 Stage 1)', () => {
  type CanonicalFixture = Awaited<
    ReturnType<typeof makeCanonicalConsumerFixture>
  >
  type Promoted = {
    link: CanonicalWorkflowLink
    attempt: Awaited<ReturnType<MonadCanonicalStampClient['finishIntent']>>
  }
  /** Fails after a bound instead of hanging: on main the operation waited behind the request. */
  async function soon<T>(pending: Promise<T>, what: string): Promise<T> {
    let timer!: ReturnType<typeof setTimeout>
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`still waiting after 4 s: ${what}`)),
            4000,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  /** Signs and promotes message `id`. `links` is every link the workflow holds, as correlation needs. */
  async function promote(
    f: CanonicalFixture,
    links: CanonicalWorkflowLink[],
    id = 1,
  ): Promise<Promoted> {
    f.pool.ensureSize(id)
    await f.pool.flush()
    let link!: CanonicalWorkflowLink
    await f.prepare(id, async durable => {
      link = durable
      links.push(durable)
    })
    const attempt = await f.client.finishIntent(permit(f, links, link))
    return { link, attempt }
  }
  /** A fresh permit for one attempt, from a correlation of every link. */
  function permit(
    f: CanonicalFixture,
    links: readonly CanonicalWorkflowLink[],
    link: CanonicalWorkflowLink,
  ) {
    const row = f.client
      .reconcileWorkflowLinks(links)
      .find(item => item.attemptRef === link.attemptRef)
    if (!row?.eligibility)
      throw new Error(`no permit: ${row?.state ?? 'unknown record'}`)
    return row.eligibility
  }
  /** The relay's authenticated answer for one attempt. */
  function answer(
    url: string,
    attempt: Promoted['attempt'],
    phase: 'delivered' | 'dead' | 'retained',
  ): Awaited<ReturnType<CanonicalFetch>> {
    const body = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        phase,
        identity: attempt.request.identity,
        ...(phase === 'delivered' ? { mailbox_committed_at_ms: 7 } : {}),
        ...(phase === 'dead' ? { reason: 'undeliverable' } : {}),
      }),
    )
    let done = false
    return {
      status: phase === 'retained' ? 202 : 200,
      url,
      headers: {
        get: (name: string) =>
          name === 'content-type' ? 'application/json' : null,
      },
      body: {
        getReader: () => ({
          read: async () =>
            done
              ? { done: true }
              : ((done = true), { done: false, value: body }),
          cancel: async () => undefined,
          releaseLock: () => undefined,
        }),
      },
    } as Awaited<ReturnType<CanonicalFetch>>
  }
  /** A relay that takes each request and answers it only when the test says so. */
  function heldRelay() {
    const calls: {
      body: Uint8Array
      answer: (reply: Awaited<ReturnType<CanonicalFetch>> | Error) => void
      url: string
    }[] = []
    let waiting: (() => void) | undefined
    const fetch: CanonicalFetch = (url, init) =>
      new Promise((resolve, reject) => {
        calls.push({
          body: new Uint8Array(init.body!),
          url,
          answer: reply =>
            reply instanceof Error ? reject(reply) : resolve(reply),
        })
        waiting?.()
      })
    return {
      fetch,
      calls,
      /** Resolves once `count` requests have reached the relay. */
      entered: async (count = 1) => {
        while (calls.length < count)
          await new Promise<void>(resolve => (waiting = resolve))
      },
    }
  }
  /** Attempts the journal currently marks as having a request in flight. Memory only. */
  const marks = (f: CanonicalFixture) => [
    ...(f.canonicalJournal as unknown as { replaying: Set<string> }).replaying,
  ]
  const row = (f: CanonicalFixture, ref: string) =>
    f.canonicalJournal.getAll().find(a => a.attemptRef === ref)
  const turns = async (count = 10) => {
    for (let i = 0; i < count; i++)
      await new Promise(resolve => setImmediate(resolve))
  }
  /** One delivered round trip, to show a later submit of the same attempt proceeds. */
  async function deliversNow(
    f: CanonicalFixture,
    links: readonly CanonicalWorkflowLink[],
    p: Promoted,
  ) {
    const fetch = jest.fn<ReturnType<CanonicalFetch>, Parameters<CanonicalFetch>>(
      async url => answer(url, p.attempt, 'delivered'),
    )
    const accepted = await soon(
      f.client.submit(permit(f, links, p.link), { fetch }),
      'a later submit of the same attempt',
    )
    expect(accepted.phase).toBe('delivered')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]![1].body).toEqual(p.attempt.request.body)
    expect(row(f, p.link.attemptRef)!.terminal).toMatchObject({
      phase: 'delivered',
    })
    expect(marks(f)).toEqual([])
  }

  // Reproduces F3 on main at the stamp client: with A's request unanswered, another wallet-queue
  // entry (here: preparing and signing an unrelated message B) waited for the relay. Also contract
  // row 1.4: B's journal rows change while A is in flight, and A's answer is still recorded for A.
  it('with a request unanswered the wallet queue is free, step 2 signs, selects and writes nothing, and the answer is recorded for its own attempt', async () => {
    await withCanonicalConsumer(async f => {
      const links: CanonicalWorkflowLink[] = []
      const a = await promote(f, links, 1)
      const relay = heldRelay()
      const sign = jest.spyOn(
        MonadAccountTxSigner.prototype,
        'signFrozenUnsigned',
      )
      try {
        const submitted = f.client.submit(permit(f, links, a.link), {
          fetch: relay.fetch,
        })
        await soon(relay.entered(), "A's request reaching the relay")
        // Persist before expose: what the relay was handed is what the journal already holds.
        expect(relay.calls[0].body).toEqual(a.attempt.request.body)
        expect(row(f, a.link.attemptRef)!.request.body).toEqual(
          a.attempt.request.body,
        )
        expect(marks(f)).toEqual([a.link.attemptRef])
        // Step 2 is only the request: across many turns nothing is signed, read from the chain,
        // broadcast or written.
        const journalBefore = JSON.stringify([
          f.canonicalJournal.getIntents(),
          f.canonicalJournal.getAll(),
        ])
        const poolBefore = JSON.stringify(f.pool.records())
        const rpcBefore = f.providerCalls.mock.calls.length
        await turns()
        expect(sign).not.toHaveBeenCalled()
        expect(f.providerCalls.mock.calls.length).toBe(rpcBefore)
        expect(f.httpClient.submitRawTransaction).not.toHaveBeenCalled()
        expect(JSON.stringify(f.pool.records())).toBe(poolBefore)
        expect(
          JSON.stringify([
            f.canonicalJournal.getIntents(),
            f.canonicalJournal.getAll(),
          ]),
        ).toBe(journalBefore)

        // The wallet queue is free: an ordinary operation and a whole unrelated message go through.
        await soon(
          f.ordinaryOperation(async () => undefined),
          'an ordinary wallet operation',
        )
        const b = await soon(
          promote(f, links, 2),
          'preparing and signing an unrelated message',
        )
        expect(b.attempt.reservations.map(r => r.index)).not.toEqual(
          a.attempt.reservations.map(r => r.index),
        )
        expect(relay.calls).toHaveLength(1)

        relay.calls[0].answer(answer(relay.calls[0].url, a.attempt, 'delivered'))
        expect((await submitted).phase).toBe('delivered')
        expect(row(f, a.link.attemptRef)!.terminal).toMatchObject({
          phase: 'delivered',
          identity: a.attempt.request.identity,
        })
        expect(row(f, b.link.attemptRef)!.terminal).toBeNull()
        expect(marks(f)).toEqual([])
      } finally {
        sign.mockRestore()
      }
    })
  }, 30000)

  // Contract row 1.2. On main a second submit of the same attempt queued behind the first and,
  // if the first was only kept, then sent the same bytes again. Now it is refused at step 1 by the
  // journal's replay mark, at once, and makes no request.
  it('a second submit of the same attempt while the first is in flight is refused and makes no request', async () => {
    await withCanonicalConsumer(async f => {
      const links: CanonicalWorkflowLink[] = []
      const a = await promote(f, links)
      const relay = heldRelay()
      const first = f.client.submit(permit(f, links, a.link), {
        fetch: relay.fetch,
      })
      await soon(relay.entered(), "A's request reaching the relay")
      await expect(
        soon(
          f.client.submit(permit(f, links, a.link), { fetch: relay.fetch }),
          'the refusal of a second submit',
        ),
      ).rejects.toMatchObject({ code: 'replay' })
      await turns()
      expect(relay.calls).toHaveLength(1)
      // The refusal did not clear the first request's mark.
      expect(marks(f)).toEqual([a.link.attemptRef])
      relay.calls[0].answer(answer(relay.calls[0].url, a.attempt, 'retained'))
      expect((await first).phase).toBe('retained')
      expect(row(f, a.link.attemptRef)!.terminal).toBeNull()
      expect(marks(f)).toEqual([])
      await deliversNow(f, links, a)
    })
  }, 30000)

  // On main two attempts could never be in flight together: B's request was not made until A's
  // was answered. Now both are in flight at once and each answer lands on its own record, in
  // whatever order the relay answers.
  it('two different attempts are in flight at once and each answer is recorded against its own attempt', async () => {
    await withCanonicalConsumer(async f => {
      const links: CanonicalWorkflowLink[] = []
      const a = await promote(f, links, 1)
      const b = await promote(f, links, 2)
      const relay = heldRelay()
      // Both permits come from one correlation, as the workflow issues them.
      const permits = f.client.reconcileWorkflowLinks(links)
      const of = (p: Promoted) =>
        permits.find(item => item.attemptRef === p.link.attemptRef)!
          .eligibility!
      const first = f.client.submit(of(a), { fetch: relay.fetch })
      const second = f.client.submit(of(b), { fetch: relay.fetch })
      await soon(relay.entered(2), 'both requests reaching the relay')
      expect(relay.calls.map(call => call.body)).toEqual([
        a.attempt.request.body,
        b.attempt.request.body,
      ])
      expect(marks(f).sort()).toEqual(
        [a.link.attemptRef, b.link.attemptRef].sort(),
      )
      // B is answered first, and ended; A afterwards, delivered.
      relay.calls[1].answer(answer(relay.calls[1].url, b.attempt, 'dead'))
      expect((await second).phase).toBe('dead')
      expect(marks(f)).toEqual([a.link.attemptRef])
      expect(row(f, a.link.attemptRef)!.terminal).toBeNull()
      relay.calls[0].answer(answer(relay.calls[0].url, a.attempt, 'delivered'))
      expect((await first).phase).toBe('delivered')
      expect(row(f, a.link.attemptRef)!.terminal).toMatchObject({
        phase: 'delivered',
        identity: a.attempt.request.identity,
      })
      expect(row(f, b.link.attemptRef)!.terminal).toMatchObject({
        phase: 'dead',
        reason: 'undeliverable',
        identity: b.attempt.request.identity,
      })
      expect(marks(f)).toEqual([])
      expect(relay.calls).toHaveLength(2)
    })
  }, 30000)

  // Pin (main already refused this in the transport): an answer that echoes another attempt's
  // identity is not an answer for this request. Nothing is recorded on either record.
  it('pin: an answer carrying another attempt\'s identity records nothing on either attempt', async () => {
    await withCanonicalConsumer(async f => {
      const links: CanonicalWorkflowLink[] = []
      const a = await promote(f, links, 1)
      const b = await promote(f, links, 2)
      await expect(
        f.client.submit(permit(f, links, a.link), {
          fetch: async url => answer(url, b.attempt, 'delivered'),
        }),
      ).rejects.toMatchObject({
        disposition: 'uncertain',
        message: 'Unmatched canonical accepted status',
      })
      expect(row(f, a.link.attemptRef)!.terminal).toBeNull()
      expect(row(f, b.link.attemptRef)!.terminal).toBeNull()
      expect(marks(f)).toEqual([])
    })
  }, 30000)

  // A1.1, pins (main cleared the mark in its own `finally`, inside the queue): after a request
  // that threw or was aborted, the attempt is unresolved, the mark is gone, and the next submit
  // of the same attempt proceeds.
  it.each(['thrown', 'aborted'] as const)(
    'A1.1 pin: after a request that was %s the mark is cleared, nothing is recorded and the next submit proceeds',
    async mode => {
      await withCanonicalConsumer(async f => {
        const links: CanonicalWorkflowLink[] = []
        const a = await promote(f, links)
        const relay = heldRelay()
        const abort = new AbortController()
        const submitted = f.client.submit(permit(f, links, a.link), {
          fetch: relay.fetch,
          signal: abort.signal,
        })
        const outcome = submitted.catch((error: Error) => error)
        await soon(relay.entered(), "A's request reaching the relay")
        if (mode === 'thrown') relay.calls[0].answer(new Error('socket hang up'))
        else abort.abort()
        expect(await outcome).toMatchObject({ disposition: 'uncertain' })
        expect(row(f, a.link.attemptRef)!.terminal).toBeNull()
        expect(marks(f)).toEqual([])
        await deliversNow(f, links, a)
      })
    },
    30000,
  )

  // A1.1 and the "relay never answers" row. Pin of the outcome (main also ended at the deadline);
  // what is new is that the queue was free for those 60 seconds (first test of this suite). The
  // transport's own 60 s deadline is fired by hand; nothing else about time is faked.
  it('A1.1: a relay that never answers leaves the attempt unresolved (not ended) at the transport deadline, clears the mark, and a later submit proceeds', async () => {
    await withCanonicalConsumer(async f => {
      const links: CanonicalWorkflowLink[] = []
      const a = await promote(f, links)
      const relay = heldRelay()
      const realSetTimeout = global.setTimeout
      let deadline: (() => void) | undefined
      const timers = jest.spyOn(global, 'setTimeout').mockImplementation(((
        callback: () => void,
        ms?: number,
        ...rest: unknown[]
      ) => {
        if (ms !== 60000) return realSetTimeout(callback, ms, ...rest)
        deadline = callback
        return realSetTimeout(() => undefined, 0)
      }) as typeof setTimeout)
      try {
        const outcome = f.client
          .submit(permit(f, links, a.link), { fetch: relay.fetch })
          .catch((error: Error) => error)
        await soon(relay.entered(), "A's request reaching the relay")
        expect(deadline).toBeDefined()
        await turns()
        expect(marks(f)).toEqual([a.link.attemptRef])
        deadline!()
        expect(await outcome).toMatchObject({
          disposition: 'uncertain',
          message: 'Canonical request aborted',
        })
      } finally {
        timers.mockRestore()
      }
      expect(row(f, a.link.attemptRef)!.terminal).toBeNull()
      expect(f.client.terminalOutcomes()).toHaveLength(0)
      expect(marks(f)).toEqual([])
      await deliversNow(f, links, a)
    })
  }, 30000)

  // A1.1, refused step 3 (the journal refuses the write without faulting). On main the same
  // refusal also cleared the mark; pin. The error is the journal's own, and nothing is recorded.
  it('A1.1 pin: when step 3 is refused the mark is cleared, the error is reported and the next submit proceeds', async () => {
    await withCanonicalConsumer(async f => {
      const links: CanonicalWorkflowLink[] = []
      const a = await promote(f, links)
      const refused = new Error('terminal write refused')
      const record = jest
        .spyOn(f.canonicalJournal, 'recordTerminal')
        .mockRejectedValueOnce(refused)
      await expect(
        f.client.submit(permit(f, links, a.link), {
          fetch: async url => answer(url, a.attempt, 'delivered'),
        }),
      ).rejects.toBe(refused)
      expect(record).toHaveBeenCalledTimes(1)
      expect(row(f, a.link.attemptRef)!.terminal).toBeNull()
      expect(marks(f)).toEqual([])
      record.mockRestore()
      await deliversNow(f, links, a)
    })
  }, 30000)

  // A1.1, step 3 refused because the journal faulted (its durable write reported an error). The
  // journal drops every mark when it faults and refuses everything until reopened; that is main's
  // behaviour and stays. On main the caller saw the journal's later "corrupt" refusal thrown from
  // the cleanup instead of the storage error; now it sees the storage error. After a reopen the
  // attempt is unresolved and the next submit proceeds.
  it('A1.1: when the journal faults on the step-3 write the storage error is reported, no mark survives, and after reopen the next submit proceeds', async () => {
    await withCanonicalConsumer(async f => {
      const links: CanonicalWorkflowLink[] = []
      const a = await promote(f, links)
      const journal = f.canonicalJournal as unknown as {
        persist(write: () => Promise<unknown>): Promise<void>
      }
      const persist = journal.persist.bind(journal)
      const failing = jest
        .spyOn(journal, 'persist')
        .mockImplementationOnce(() =>
          persist(async () => {
            throw new Error('disk failed')
          }),
        )
      await expect(
        f.client.submit(permit(f, links, a.link), {
          fetch: async url => answer(url, a.attempt, 'delivered'),
        }),
      ).rejects.toThrow('disk failed')
      failing.mockRestore()
      expect(marks(f)).toEqual([])
      expect(() => f.canonicalJournal.getAll()).toThrow('corrupt')
      await f.reopenOwner()
      expect(row(f, a.link.attemptRef)!.terminal).toBeNull()
      await deliversNow(f, links, a)
    })
  }, 30000)

  // A1.2, pin: the whole-journal guard on a permit is unchanged, for signing and for submit. A
  // permit issued before any journal row changed is refused, and `finishIntent` signs nothing.
  it('A1.2 pin: finishIntent and submit both still refuse a permit issued before another journal row changed', async () => {
    await withCanonicalConsumer(async f => {
      const links: CanonicalWorkflowLink[] = []
      const a = await promote(f, links, 1)
      f.pool.ensureSize(3)
      await f.pool.flush()
      let linkB!: CanonicalWorkflowLink
      await f.prepare(2, async durable => {
        linkB = durable
        links.push(durable)
      })
      // One correlation issues both permits; then an unrelated third record appears.
      const stale = f.client.reconcileWorkflowLinks(links)
      const of = (ref: string) =>
        stale.find(item => item.attemptRef === ref)!.eligibility!
      await f.prepare(3, async durable => void links.push(durable))
      const sign = jest.spyOn(
        MonadAccountTxSigner.prototype,
        'signFrozenUnsigned',
      )
      const fetch = jest.fn(async () => {
        throw new Error('relay must not be contacted')
      })
      try {
        await expect(
          f.client.finishIntent(of(linkB.attemptRef)),
        ).rejects.toThrow('canonical-wallet:reconcile-required')
        await expect(
          f.client.submit(of(a.link.attemptRef), { fetch }),
        ).rejects.toThrow('canonical-wallet:reconcile-required')
        expect(sign).not.toHaveBeenCalled()
        expect(fetch).not.toHaveBeenCalled()
        expect(marks(f)).toEqual([])
      } finally {
        sign.mockRestore()
      }
    })
  }, 30000)

  // A1.3, pin: step 1 still refuses when a record the workflow has no link for appeared after the
  // permit was issued. No request, no mark. A fresh correlation then holds the attempt.
  it('A1.3 pin: step 1 refuses, with no request, when an uncorrelated record appeared after the permit was issued', async () => {
    await withCanonicalConsumer(async f => {
      const links: CanonicalWorkflowLink[] = []
      const a = await promote(f, links, 1)
      const issued = permit(f, links, a.link)
      f.pool.ensureSize(2)
      await f.pool.flush()
      // An intent whose link the workflow never kept: an uncorrelated record.
      await f.prepare(2, async () => undefined)
      const fetch = jest.fn(async () => {
        throw new Error('relay must not be contacted')
      })
      await expect(f.client.submit(issued, { fetch })).rejects.toThrow(
        'canonical-wallet:reconcile-required',
      )
      expect(fetch).not.toHaveBeenCalled()
      expect(marks(f)).toEqual([])
      expect(
        f.client.reconcileWorkflowLinks(links).map(item => item.state),
      ).toEqual(['hold', 'hold'])
    })
  }, 30000)

  // A1.4. Lifetime shape: one wallet lifetime spans steps 1 to 3, so the owner cannot finish
  // closing in the gap; a close that begins before step 2 is seen there and no request is made.
  // On main the request ran inside the queue entry already admitted and was made regardless.
  it('A1.4: a wallet close between step 1 and step 2 clears the mark and makes no request', async () => {
    await withCanonicalConsumer(async f => {
      const links: CanonicalWorkflowLink[] = []
      const a = await promote(f, links)
      const journal = f.canonicalJournal
      const begin = journal.beginReplay.bind(journal)
      const end = journal.endReplay.bind(journal)
      let closing!: Promise<void>
      const marksAtClose: string[][] = []
      const marksAfterClear: string[][] = []
      jest.spyOn(journal, 'beginReplay').mockImplementationOnce(async token => {
        const marked = await begin(token)
        // The last act of step 1: the mark is set, and the wallet starts closing.
        marksAtClose.push(marks(f))
        closing = f.state.close()
        return marked
      })
      const cleared = jest
        .spyOn(journal, 'endReplay')
        .mockImplementation(token => {
          end(token)
          marksAfterClear.push(marks(f))
        })
      const fetch = jest.fn(async () => {
        throw new Error('relay must not be contacted')
      })
      await expect(
        f.client.submit(permit(f, links, a.link), { fetch }),
      ).rejects.toThrow('Monad wallet bundle is closing or closed')
      expect(fetch).not.toHaveBeenCalled()
      expect(marksAtClose).toEqual([[a.link.attemptRef]])
      // Cleared by `endReplay` itself while the journal was still open, not by the close.
      expect(marksAfterClear).toEqual([[]])
      expect(cleared.mock.results).toEqual([{ type: 'return', value: undefined }])
      await closing
      jest.restoreAllMocks()
      await f.reopenOwner()
      expect(row(f, a.link.attemptRef)!.terminal).toBeNull()
      await deliversNow(f, links, a)
    })
  }, 30000)

  // Contract row 1.3. The wallet closes while the request is in flight: close waits for the
  // request, the answer that then arrives is dropped (step 3 is refused), nothing is written
  // after the close began, nothing faults and no rejection goes unhandled. After reopen the same
  // bytes are replayed once and delivered is recorded then; one signed set throughout. On main
  // the queue entry already admitted wrote the answer after the close had begun.
  it('a relay answer that arrives after the wallet began closing is dropped: nothing recorded, no unhandled rejection, mark cleared; reopen replays the same bytes once', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      await withCanonicalConsumer(async f => {
        const links: CanonicalWorkflowLink[] = []
        const a = await promote(f, links)
        const relay = heldRelay()
        const record = jest.spyOn(f.canonicalJournal, 'recordTerminal')
        const journal = f.canonicalJournal
        const end = journal.endReplay.bind(journal)
        const marksAfterClear: string[][] = []
        const cleared = jest
          .spyOn(journal, 'endReplay')
          .mockImplementation(token => {
            end(token)
            marksAfterClear.push(marks(f))
          })
        const sign = jest.spyOn(
          MonadAccountTxSigner.prototype,
          'signFrozenUnsigned',
        )
        try {
          const outcome = f.client
            .submit(permit(f, links, a.link), { fetch: relay.fetch })
            .catch((error: Error) => error)
          await soon(relay.entered(), "A's request reaching the relay")
          let closed = false
          const closing = f.state.close().then(() => void (closed = true))
          await turns()
          // Close waits for the request in flight (bounded by the transport's deadline).
          expect(closed).toBe(false)
          relay.calls[0].answer(
            answer(relay.calls[0].url, a.attempt, 'delivered'),
          )
          const error = await outcome
          expect(error).toBeInstanceOf(Error)
          expect((error as Error).message).toBe(
            'Monad wallet bundle is closing or closed',
          )
          await closing
          expect(record).not.toHaveBeenCalled()
          expect(marksAfterClear).toEqual([[]])
          expect(cleared.mock.results).toEqual([
            { type: 'return', value: undefined },
          ])
          record.mockRestore()
          cleared.mockRestore()

          await f.reopenOwner()
          // Nothing faulted: the reopened owner is valid and holds the same unanswered record.
          expect(() => f.state.assertSemanticallyValid()).not.toThrow()
          expect(f.canonicalJournal.getIntents()).toHaveLength(0)
          expect(f.canonicalJournal.getAll()).toHaveLength(1)
          expect(row(f, a.link.attemptRef)!.terminal).toBeNull()
          expect(row(f, a.link.attemptRef)!.request.body).toEqual(
            a.attempt.request.body,
          )
          await deliversNow(f, links, a)
          expect(relay.calls).toHaveLength(1)
          expect(sign).not.toHaveBeenCalled()
        } finally {
          sign.mockRestore()
        }
      })
      await turns()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  }, 30000)

  // A1.5. While the request is in flight the record is ended locally, or ended, cleaned up and
  // acknowledged. The relay's later answer is not written over it and nothing faults. On main
  // neither could happen during a request: both waited in the queue behind it.
  it.each(['terminal', 'cleaned'] as const)(
    'A1.5: an answer that arrives after the row is already %s is not written over it and faults nothing',
    async mode => {
      await withCanonicalConsumer(async f => {
        const links: CanonicalWorkflowLink[] = []
        const a = await promote(f, links)
        const relay = heldRelay()
        const submitted = f.client.submit(permit(f, links, a.link), {
          fetch: relay.fetch,
        })
        await soon(relay.entered(), "A's request reaching the relay")
        await soon(
          f.client.markAttemptTerminal(a.link.attemptRef),
          'ending the attempt while its request is in flight',
        )
        if (mode === 'cleaned') {
          await f.client.cleanupTerminal(a.link.attemptRef, a.link.consumerId)
          await f.client.acknowledgeWorkflow(
            a.link.attemptRef,
            a.link.consumerId,
          )
          expect(f.client.wasAcknowledged(a.link.attemptRef)).toBe(true)
        }
        const before = JSON.stringify(f.canonicalJournal.getAll())
        const record = jest.spyOn(f.canonicalJournal, 'recordTerminal')
        relay.calls[0].answer(answer(relay.calls[0].url, a.attempt, 'delivered'))
        // The relay's answer is handed back as it was given; the journal is the record.
        expect((await submitted).phase).toBe('delivered')
        expect(record).not.toHaveBeenCalled()
        expect(JSON.stringify(f.canonicalJournal.getAll())).toBe(before)
        if (mode === 'terminal')
          expect(row(f, a.link.attemptRef)!.terminal).toMatchObject({
            phase: 'dead',
            reason: 'attempts_exhausted',
          })
        expect(marks(f)).toEqual([])
        expect(() => f.state.assertSemanticallyValid()).not.toThrow()
        // Not faulted: the owner still admits ordinary work.
        await f.ordinaryOperation(async () => undefined)
      })
    },
    30000,
  )

  // Pin: an attempt the journal holds as ended is never submitted again, neither with a permit
  // issued before it ended nor through a new correlation, which issues none.
  it('pin: an ended attempt is never submitted again', async () => {
    await withCanonicalConsumer(async f => {
      const links: CanonicalWorkflowLink[] = []
      const a = await promote(f, links)
      const issued = permit(f, links, a.link)
      const dead = await f.client.submit(permit(f, links, a.link), {
        fetch: async url => answer(url, a.attempt, 'dead'),
      })
      expect(dead.phase).toBe('dead')
      const fetch = jest.fn(async () => {
        throw new Error('relay must not be contacted')
      })
      await expect(f.client.submit(issued, { fetch })).rejects.toThrow(
        'canonical-wallet:reconcile-required',
      )
      const again = f.client.reconcileWorkflowLinks(links)
      expect(again).toEqual([
        { attemptRef: a.link.attemptRef, state: 'terminal' },
      ])
      expect(fetch).not.toHaveBeenCalled()
      expect(marks(f)).toEqual([])
    })
  }, 30000)

  // Crash table, "during step 2". The process dies with the request in flight: the files are
  // copied as they are at that moment and a second wallet is opened on the copy, so nothing of the
  // first process (its mark, its permit, its pending answer) carries over. The attempt is
  // unresolved, no mark exists, and the same bytes are replayed once. Pin: main left the same
  // files at this point.
  it('crash during the request: reopened from the files as they were, the attempt is unresolved and replayable and the memory-only mark is gone', async () => {
    await withCanonicalConsumer(async f => {
      const links: CanonicalWorkflowLink[] = []
      const a = await promote(f, links)
      const relay = heldRelay()
      const outcome = f.client
        .submit(permit(f, links, a.link), { fetch: relay.fetch })
        .catch((error: Error) => error)
      await soon(relay.entered(), "A's request reaching the relay")
      expect(marks(f)).toEqual([a.link.attemptRef])

      const reopened = await makeCanonicalConsumerFixture({
        restoreFrom: f.location,
      })
      try {
        expect(marks(reopened)).toEqual([])
        expect(reopened.canonicalJournal.getIntents()).toHaveLength(0)
        expect(reopened.canonicalJournal.getAll()).toHaveLength(1)
        expect(row(reopened, a.link.attemptRef)!.terminal).toBeNull()
        expect(row(reopened, a.link.attemptRef)!.request.body).toEqual(
          a.attempt.request.body,
        )
        const sign = jest.spyOn(
          MonadAccountTxSigner.prototype,
          'signFrozenUnsigned',
        )
        try {
          await deliversNow(reopened, links, a)
          expect(sign).not.toHaveBeenCalled()
        } finally {
          sign.mockRestore()
        }
      } finally {
        await reopened.close()
      }
      // The first process never learns anything: its own record is still unanswered.
      expect(row(f, a.link.attemptRef)!.terminal).toBeNull()
      relay.calls[0].answer(new Error('process gone'))
      expect(await outcome).toMatchObject({ disposition: 'uncertain' })
    })
  }, 30000)
})
