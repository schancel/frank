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
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonRpcProvider, Transaction, Wallet, getBytes, sha256 } from 'ethers'
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
import { openMonadWalletBundle } from './storage/monad-wallet-bundle'

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

async function fundPersistentPool(pool: MonadSubAccountPool): Promise<void> {
  const fundingWallet = new Wallet(`0x${'66'.repeat(32)}`)
  const signer = {
    address: fundingWallet.address,
    buildAndSignTransfer: async (to: string, value: bigint) => {
      const rawTx = await fundingWallet.signTransaction({
        to,
        value,
        nonce: 0,
        gasLimit: 21_000n,
        gasPrice: 1n,
        chainId: CHAIN_ID,
      })
      const parsed = Transaction.from(rawTx)
      return {
        rawTx,
        txHash: parsed.hash as string,
        from: fundingWallet.address,
        to,
        value,
        data: '0x',
        nonce: 0,
        gasLimit: 21_000n,
        maxFeePerGas: undefined,
        maxPriorityFeePerGas: undefined,
        gasPrice: 1n,
        chainId: BigInt(CHAIN_ID),
      }
    },
    submit: async (signed: { txHash: string }) => signed.txHash,
    getStatus: async () => 'confirmed' as const,
  }
  await pool.topUpPool({
    mainAccountSigner: signer as never,
    burnValue: 100_000n,
    gasReserve: 0n,
    bufferSize: 1,
  })
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
function storedTopicPostBytes(post: MonadTopicPostProto): Uint8Array {
  const pb = new StoredMonadTopicPost()
  pb.setPost(encodeTopicPostPb(post))
  pb.setSenderAddress(getBytes('0x' + '11'.repeat(20)))
  pb.setTxHash(getBytes('0x' + '22'.repeat(32)))
  pb.setTimestamp(1_700_000_000_000)
  pb.setNetworkTag(new TextEncoder().encode('MONT'))
  return pb.serializeBinary()
}

function matchingStoredTopicPostBytes(post: MonadTopicPostProto): Uint8Array {
  const transaction = Transaction.from(hexOf(post.rawBurnTx))
  const pb = new StoredMonadTopicPost()
  pb.setPost(encodeTopicPostPb(post))
  pb.setSenderAddress(getBytes(transaction.from as string))
  pb.setTxHash(getBytes(transaction.hash as string))
  pb.setTimestamp(1_700_000_000_000)
  pb.setNetworkTag(new TextEncoder().encode('MONT'))
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

  it('builds up-vote calldata as <TPIC><0x01><0x01><32-byte commitment>, 38 bytes total', () => {
    const commitment = new Uint8Array(32).fill(0xab)
    const calldata = buildTopicVoteCalldata('up', commitment)
    const bytes = getBytes(calldata)

    expect(bytes).toHaveLength(38)
    expect(MONAD_TOPIC_VOTE_CALLDATA_LENGTH).toBe(38)
    // "TPIC" == 0x54504943 -- TOPIC_VOTE_LOKAD_ID (monad_topic_verify.rs:94).
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x54, 0x50, 0x49, 0x43])
    // TOPIC_COMMITMENT_VERSION_TAG (monad_topic_verify.rs:99).
    expect(bytes[4]).toBe(0x01)
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
    expect(bytes[4]).toBe(0x01)
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
      0x01, // version
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

  it.each(['direct', 'fallback'] as const)(
    'persists exact spend authority across reopen for a %s confirmation',
    async confirmation => {
      const parent = mkdtempSync(join(tmpdir(), 'monad-topic-post-durable-'))
      const location = join(parent, 'wallet')
      try {
        const bundle = await openMonadWalletBundle({
          location,
          seed: { mnemonic: TEST_MNEMONIC },
          mode: 'create',
        })
        await fundPersistentPool(bundle.pool)
        const row = bundle.pool.getRecord(0)
        if (row === undefined) throw new Error('missing funded topic row')
        const client = new MonadTopicPostClient({
          pool: bundle.pool,
          leaseManager: bundle.leaseManager,
          provider: makeChainProvider(),
          httpClient: makeMockHttpClient(),
          relayBaseUrl: 'https://relay.example.com/',
        })
        let exactRawTx = ''
        let calls = 0
        ;(mockedAxios as unknown as jest.Mock).mockImplementation(
          async (config: any) => {
            calls++
            if (config.method === 'put') {
              const sent = decodeMonadTopicPost(
                new Uint8Array(config.data as Buffer),
              )
              exactRawTx = hexOf(sent.rawBurnTx)
              expect(
                bundle.pool.getRecord(row.index)?.lifecycle?.spend?.rawTx,
              ).toBe(exactRawTx)
              if (confirmation === 'fallback' && calls === 1) {
                throw Object.assign(new Error('socket hang up'), {
                  isAxiosError: true,
                  response: undefined,
                })
              }
              return {
                data: storedTopicPostBytes(sent),
                status: 200,
                statusText: 'OK',
                headers: {},
                config,
              }
            }
            const checkpoint = bundle.pool.getRecord(row.index)?.lifecycle
              ?.spend
            if (checkpoint === undefined) {
              throw new Error('missing spend checkpoint')
            }
            exactRawTx = checkpoint.rawTx
            const payload = buildTopicPostPayload({
              topic: 'durable',
              entries: ENTRIES,
              parentPostHash: new Uint8Array(0),
              timestampMs: 1_700_000_000_000,
            })
            const sent: MonadTopicPostProto = {
              topic: 'durable',
              parentPostHash: new Uint8Array(0),
              rawBurnTx: getBytes(exactRawTx),
              encryptedPayload: payload,
              payloadHash: computeTopicPostCommitment(payload),
            }
            return {
              data: topicPostViewBytes(sent, 5_000),
              status: 200,
              statusText: 'OK',
              headers: {},
              config,
            }
          },
        )

        const result = await client.submitTopicPost({
          topic: 'durable',
          entries: ENTRIES,
          direction: 'up',
          burnAddress: BURN_ADDRESS,
          voteWeightWei: 5_000n,
          overrides: FEE_OVERRIDES,
          timestampMs: 1_700_000_000_000,
          abandonPoll: {
            intervalMs: 0,
            maxAttempts: 1,
            sleep: async () => undefined,
          },
        })
        const expectedHash = Transaction.from(exactRawTx).hash
        expect(result.txHash).toBe(expectedHash)
        await bundle.close()

        const reopened = await openMonadWalletBundle({
          location,
          seed: { mnemonic: TEST_MNEMONIC },
        })
        expect(reopened.pool.getRecord(row.index)).toMatchObject({
          status: 'spent',
          lifecycle: {
            spend: {
              rawTx: exactRawTx,
              txHash: expectedHash,
              valueWei: '5000',
            },
          },
        })
        await reopened.close()
      } finally {
        rmSync(parent, { recursive: true, force: true })
      }
    },
  )

  it.each(['relay-stored', 'relay-not-stored'] as const)(
    'replays the exact durable post after a lost response (%s)',
    async () => {
      const parent = mkdtempSync(join(tmpdir(), 'monad-topic-post-replay-'))
      const location = join(parent, 'wallet')
      let first: Awaited<ReturnType<typeof openMonadWalletBundle>> | undefined
      let reopened:
        | Awaited<ReturnType<typeof openMonadWalletBundle>>
        | undefined
      try {
        first = await openMonadWalletBundle({
          location,
          seed: { mnemonic: TEST_MNEMONIC },
          mode: 'create',
        })
        await fundPersistentPool(first.pool)
        const provider = makeChainProvider()
        const httpClient = makeMockHttpClient()
        const handle = {
          pool: first.pool,
          leaseManager: first.leaseManager,
          provider,
          httpClient,
          changePool: first.changePool,
          stampPaymentJournal: first.stampPaymentJournal,
          stampAttemptJournal: first.stampAttemptJournal,
          topicOperationJournal: first.topicOperationJournal,
          walletState: first,
          relayBaseUrl: 'https://relay.example.com/',
        }
        let exactRequest: Uint8Array | undefined
        mockedAxios.mockImplementation(async config => {
          if (config.method === 'put') {
            expect(first?.topicOperationJournal.getAll()).toHaveLength(1)
            exactRequest = new Uint8Array(config.data as Buffer)
            throw Object.assign(new Error('lost response'), {
              isAxiosError: true,
              response: undefined,
            })
          }
          throw new Error('unexpected topic readback')
        })
        await expect(
          new MonadTopicPostClient(handle).submitTopicPost({
            topic: 'replay',
            entries: ENTRIES,
            direction: 'up',
            burnAddress: BURN_ADDRESS,
            voteWeightWei: 5_000n,
            overrides: FEE_OVERRIDES,
            timestampMs: 1_700_000_000_000,
            abandonPoll: { maxAttempts: 0, intervalMs: 0 },
          }),
        ).rejects.toThrow(MonadTopicPostAbandonedError)
        expect(first.topicOperationJournal.getAll()).toHaveLength(1)
        expect(first.pool.getRecord(0)?.status).toBe('in-use')
        const staged = first.pool.getRecord(0)!
        const { spend: _spend, ...retainedLifecycle } = staged.lifecycle ?? {}
        first.pool.applyPrevalidatedRecoveryRecords([
          { ...staged, lifecycle: retainedLifecycle },
        ])
        await first.pool.flush()
        expect(first.pool.getRecord(0)?.lifecycle?.spend).toBeUndefined()
        await first.close()
        first = undefined

        reopened = await openMonadWalletBundle({
          location,
          seed: { mnemonic: TEST_MNEMONIC },
        })
        const replayed: Uint8Array[] = []
        mockedAxios.mockImplementation(async config => {
          expect(reopened?.pool.getRecord(0)?.lifecycle?.spend).toBeDefined()
          const bytes = new Uint8Array(config.data as Buffer)
          replayed.push(bytes)
          const post = decodeMonadTopicPost(bytes)
          return {
            data: matchingStoredTopicPostBytes(post),
            status: 200,
            statusText: 'OK',
            headers: {},
            config,
          }
        })
        await new MonadTopicPostClient({
          ...handle,
          pool: reopened.pool,
          leaseManager: reopened.leaseManager,
          changePool: reopened.changePool,
          stampPaymentJournal: reopened.stampPaymentJournal,
          stampAttemptJournal: reopened.stampAttemptJournal,
          topicOperationJournal: reopened.topicOperationJournal,
          walletState: reopened,
        }).resumePendingOperations()
        expect(replayed).toHaveLength(1)
        expect(replayed[0]).toEqual(exactRequest)
        expect(reopened.topicOperationJournal.getAll()).toEqual([])
        expect(reopened.pool.getRecord(0)?.status).toBe('spent')
      } finally {
        await first?.close().catch(() => undefined)
        await reopened?.close().catch(() => undefined)
        rmSync(parent, { recursive: true, force: true })
      }
    },
  )

  it('retains durable authority when a valid 2xx post response is mismatched', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'monad-topic-post-mismatch-'))
    const location = join(parent, 'wallet')
    const bundle = await openMonadWalletBundle({
      location,
      seed: { mnemonic: TEST_MNEMONIC },
      mode: 'create',
    })
    try {
      await fundPersistentPool(bundle.pool)
      const provider = makeChainProvider()
      const httpClient = makeMockHttpClient()
      mockedAxios.mockImplementationOnce(async config => {
        const post = decodeMonadTopicPost(new Uint8Array(config.data as Buffer))
        return {
          data: storedTopicPostBytes(post),
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        }
      })
      await expect(
        new MonadTopicPostClient({
          pool: bundle.pool,
          leaseManager: bundle.leaseManager,
          provider,
          httpClient,
          changePool: bundle.changePool,
          stampPaymentJournal: bundle.stampPaymentJournal,
          stampAttemptJournal: bundle.stampAttemptJournal,
          topicOperationJournal: bundle.topicOperationJournal,
          walletState: bundle,
          relayBaseUrl: 'https://relay.example.com/',
        }).submitTopicPost({
          topic: 'mismatch',
          entries: ENTRIES,
          direction: 'up',
          burnAddress: BURN_ADDRESS,
          voteWeightWei: 5_000n,
          overrides: FEE_OVERRIDES,
        }),
      ).rejects.toThrow(MonadTopicPostAbandonedError)
      expect(bundle.topicOperationJournal.getAll()).toHaveLength(1)
      expect(bundle.pool.getRecord(0)?.status).toBe('in-use')
    } finally {
      await bundle.close()
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('PUTs the assembled MonadTopicPost and releases the lease as confirmed on 2xx', async () => {
    const { client, pool } = makeClient()

    const expectedPayload = buildTopicPostPayload({
      topic: 'general',
      entries: ENTRIES,
      timestampMs: 1_700_000_000_000,
    })
    const expectedCommitment = computeTopicPostCommitment(expectedPayload)

    mockedAxios.mockImplementationOnce(async config => {
      expect(config.method).toBe('put')
      expect(config.url).toBe('https://relay.example.com/message/monad/topics')
      expect(config.headers).toEqual({
        'Content-Type': 'application/x-protobuf',
      })
      const sentPost = decodeMonadTopicPost(
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
        new Uint8Array([0x54, 0x50, 0x49, 0x43]),
      )
      expect(calldataBytes[4]).toBe(0x01)
      expect(calldataBytes[5]).toBe(0x01) // up
      expect(calldataBytes.slice(6)).toEqual(expectedCommitment)
      expect(parsed.value).toBe(5_000n)

      return {
        data: storedTopicPostBytes(sentPost),
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
    expect(result.payloadHashHex).toBe(
      Buffer.from(expectedCommitment).toString('hex'),
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
        decodeMonadTopicPost(new Uint8Array(config.data as Buffer)),
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

  it('builds down-vote calldata for an initial down-vote post', async () => {
    const { client } = makeClient()
    mockedAxios.mockImplementationOnce(async config => {
      const sentPost = decodeMonadTopicPost(
        new Uint8Array(config.data as Buffer),
      )
      const parsed = Transaction.from(hexOf(sentPost.rawBurnTx))
      const calldataBytes = getBytes(parsed.data)
      expect(calldataBytes[5]).toBe(0x00) // down
      return {
        data: storedTopicPostBytes(sentPost),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    await client.submitTopicPost({
      topic: 'general',
      entries: ENTRIES,
      direction: 'down',
      burnAddress: BURN_ADDRESS,
      voteWeightWei: 1_000n,
      overrides: FEE_OVERRIDES,
    })
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
