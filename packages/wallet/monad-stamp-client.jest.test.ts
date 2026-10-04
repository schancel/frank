import { deriveRoleLeaves } from '../role-keys/src'
import * as canonicalMailboxModule from '@frank/cashweb/relay/monad-mailbox-client'
import { freezeCanonicalRequest } from '@frank/cashweb/relay/canonical-dm-transport'
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
  computeAddress,
  getBytes,
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

    expect(estimatedData).toHaveLength(4)
    for (const quoteData of estimatedData.slice(0, 2)) {
      expect(Array.from(getBytes(quoteData).slice(5))).toEqual(
        Array(32).fill(0xff),
      )
    }
    expect(estimatedData[2]).not.toBe(estimatedData[3])
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
        // Current construction signs two capacity probes and two retained members.
        expect(signCount).toBe(4)
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
import { mkdtemp, rm } from 'node:fs/promises'
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
import {
  MonadCanonicalStampClient,
  type CanonicalWorkflowLink,
} from './monad-stamp-client'
import {
  prepareDirectMessage,
  directMessageText,
} from '@frank/cashweb/relay/canonical-dm'
import {
  decodeCanonical,
  encodeCanonical,
  encodeFrame,
  directorySignatureDigest,
  paymentCommitment,
  recipientPayloadDigest,
  cborMap,
  toHex,
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
async function makeCanonicalConsumerFixture() {
  const location = await mkdtemp(join(tmpdir(), 'canonical-consumer-'))
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
        data: '0x504f4e4402' + toHex(paymentCommitment(digest, 0)),
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
  const leaseManager = new SubAccountLeaseManager(pool)
  let enclosed = false
  let queue = Promise.resolve()
  const state = await openExistingPoolMonadTopicOwner({
    encloseFinancialOperation: operation => exclusive(operation, false),
    location,
    pool,
    changePool,
    leaseManager,
    subKeyring: material.keyring,
    changeKeyring: material.changeKeyring,
    canonicalBinding: canonicalWalletPublicBinding(
      material,
      'monad-testnet',
      10143n,
    ),
    stampReferencesLeaseIndex: () => false,
    assertEnclosingAdmission: () => {
      if (!enclosed) throw new Error('missing outer owner admission')
    },
  })
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
  const client = new MonadCanonicalStampClient({
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
    client,
    state,
    incomingRecovery,
    rotateOwnStamp,
    material,
    senderDirectory,
    senderExport,
    subStore,
    pool,
    leaseManager,
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
  it.each(['release', 'reject'] as const)(
    'starts no actual pool write, signature or callback before Level intent completion: %s',
    async outcome => {
      await withCanonicalConsumer(async f => {
        const db = (
          f.state.canonicalJournal as unknown as {
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
      expect(() => f.state.assertSemanticallyValid()).not.toThrow()
      expect(f.client.terminalOutcomes()).toHaveLength(1)
      await f.client.acknowledgeWorkflow(link.attemptRef, link.consumerId)
      expect(f.client.wasAcknowledged(link.attemptRef)).toBe(true)
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
      jest
        .spyOn(f.state.canonicalJournal!, 'beginReplay')
        .mockRejectedValue(refused)
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
      const first = f.state.canonicalJournal!.getIntents()[0]
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
      expect(f.state.canonicalJournal!.getIntents()).toHaveLength(1)
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
      expect(f.state.canonicalJournal!.getIntents()).toHaveLength(0)
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
      expect(f.state.canonicalJournal!.getIntents()).toHaveLength(1)
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
      const intent = f.state.canonicalJournal!.getIntents()[0]
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
        'foreign-lease-hold',
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
            f.state.canonicalJournal!.retainedRecoveryCustody(
              imported.obligationId,
            ),
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
            f.state.canonicalJournal!.retainedRecoveryCustody(
              imported.obligationId,
            ),
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
      const journal = f.state.canonicalJournal!
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
      await f.state.canonicalJournal!.Close()
      await f.state.canonicalJournal!.Open()
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
        const journal = f.state.canonicalJournal!
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
        await journal.Close()
        await journal.Open()
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
})
