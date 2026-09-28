/**
 * Unit tests for `monad-stamp-client.ts` (ticket #13).
 *
 * `axios` is mocked (`jest.mock('axios')`) so `PUT /message/monad` / `GET
 * /message/monad/:payload_hash` never touch a real network — each test drives the mock to exercise
 * one of `submitStampedMessage`'s documented outcomes (2xx success, HTTP-level rejection,
 * network-failure-then-found-via-poll, network-failure-then-abandoned). Payment construction goes
 * through a real `MonadSubAccountPool`/`MonadAccountTxSigner` against a stubbed ethers
 * `JsonRpcProvider._perform` (same technique `monad-account-tx.jest.test.ts` uses), so the signed
 * raw tx and its calldata are real, decodable bytes, not placeholders.
 */
import {
  JsonRpcProvider,
  SigningKey,
  Transaction,
  computeAddress,
  getBytes,
  getAddress,
  sha256,
} from 'ethers'
import axios from 'axios'

import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadSubAccountPool } from './monad-account-pool'
import { SubAccountLeaseManager } from './monad-account-lease'
import { MonadTxSubmitter } from './monad-account-tx'
import { MonadChangePool } from './monad-change-pool'
import {
  InMemoryStampAttemptJournal,
  StampAttemptJournal,
} from './storage/stamp-attempt-journal'
import {
  MonadStampAbandonedError,
  MonadStampClient,
  MonadStampRejectedError,
  MonadStampPendingAttemptError,
  MONAD_STAMP_CALLDATA_LENGTH,
  buildMonadStampCalldata,
  computeMonadStampCommitment,
  computeMonadStampPaymentCommitment,
  decodeMonadStampedMessage,
  decodeStoredMonadMessage,
  encodeMonadStampedMessage,
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
  const provider = overrides?.provider ?? makeChainProvider()
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
        expect(parsed.value).toBe(5_000n)
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
      abandonPoll: { maxAttempts: 1, intervalMs: 0 },
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
    expect(recovered[0].valueWei).toBe(5_000n)
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
      abandonPoll: { maxAttempts: 1, intervalMs: 0 },
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

  it('falls back to polling GET and confirms when a network failure is followed by a found message', async () => {
    const { client, pool } = makeClient()
    const encryptedPayload = new TextEncoder().encode('flaky network')

    let putCalls = 0
    let getCalls = 0
    let submittedMessage: MonadStampedMessageProto | undefined
    mockedAxios.mockImplementation(async config => {
      if (config.method === 'put') {
        putCalls++
        submittedMessage = decodeMonadStampedMessage(
          new Uint8Array(config.data as Buffer),
        )
        const networkErr = Object.assign(new Error('socket hang up'), {
          isAxiosError: true,
          response: undefined,
        })
        throw networkErr
      }
      // GET /message/monad/:payload_hash
      getCalls++
      if (submittedMessage === undefined) throw new Error('missing PUT message')
      return {
        data: storedMessageBytes(submittedMessage),
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
    expect(pool.getRecord(result.leaseIndices[0])?.status).toBe('spent')
  })

  it('retires as stuck and throws MonadStampAbandonedError when the fallback poll never finds it', async () => {
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
        abandonPoll: {
          maxAttempts: 2,
          intervalMs: 0,
          sleep: async () => undefined,
        },
      }),
    ).rejects.toThrow(MonadStampAbandonedError)

    const retired = pool.records().filter(r => r.status === 'retired')
    expect(retired).toHaveLength(2)
    expect(stampAttemptJournal.getAll()).toHaveLength(1)
    await expect(
      client.submitStampedMessage({
        encryptedPayload: new TextEncoder().encode('replacement with new salt'),
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        stampValueWei: 10_000n,
        overrides: FEE_OVERRIDES,
      }),
    ).rejects.toThrow(MonadStampPendingAttemptError)

    // Simulate a cross-store crash where the awaited attempt journal persisted but the pool's
    // earlier status writes did not. A failed startup replay must reserve those
    // accounts again before returning control to the wallet.
    for (const record of retired) pool.setStatus(record.index, 'available')
    await expect(client.resumePendingAttempts()).resolves.toEqual([])
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

  it('does not confirm a different stored payment set after an ambiguous PUT', async () => {
    const { client, pool } = makeClient()
    mockedAxios.mockImplementation(async config => {
      if (config.method === 'put') {
        throw Object.assign(new Error('socket hang up'), {
          isAxiosError: true,
          response: undefined,
        })
      }
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
        abandonPoll: { maxAttempts: 1, intervalMs: 0 },
      }),
    ).rejects.toThrow(MonadStampAbandonedError)

    expect(pool.records().filter(r => r.status === 'retired')).toHaveLength(2)
  })
})

function hexOf(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex')
}

function hexNoPrefix(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}
