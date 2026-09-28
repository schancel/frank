/**
 * Acceptance-bearing proof for ticket #21 ("nonce-race sequencing proof via wallet lease").
 *
 * Parent context: `MonadAccountTxSigner.buildAndSignCall` (#11) fetches a fresh nonce from the
 * chain on every call, with no local caching -- so two concurrent stamp submissions leasing the
 * *same* sub-account would race for the same "next" nonce (double-spend, or a stuck/dropped tx)
 * without something serializing access to that sub-account. `SubAccountLeaseManager` (#18) is that
 * serialization: `acquireLease()`/`acquireForIndex()` are synchronous end-to-end, with no `await`
 * between the `'available'` read and the `'in-use'` write (see that file's own doc comment), so two
 * same-tick attempts against the same sub-account can never both observe it as free.
 *
 * `MonadStampClient.submitStampedMessage` (#13, `./monad-stamp-client.ts`) is the real caller of
 * that lease. Reading its header comment and its `submitStampedMessage` body (this file does not
 * modify #13/#18/#14/#11's modules -- see the ticket's non-goals) shows it uses
 * `SubAccountLeaseManager.acquireLease()` -- the never-waits variant -- by default, and only uses
 * the waiting `acquireLeaseWhenAvailable` when the caller explicitly opts in via
 * `params.waitForLease`. Both call shapes are exercised below, against the real
 * `MonadSubAccountPool` / `SubAccountLeaseManager` / `MonadAccountTxSigner` classes (only `axios`
 * and the ethers JSON-RPC transport are mocked/stubbed, matching `monad-stamp-client.jest.test.ts`'s
 * own established technique), so the sequencing proved here is the lease module's real synchronous
 * accounting, not a re-implementation of it.
 *
 * Three scenarios:
 *
 *   1. Default (`acquireLease`, no `waitForLease`): firing a second `submitStampedMessage` call
 *      against a pool with exactly one sub-account, before the first's relay PUT has resolved, is
 *      rejected immediately with `NoAvailableSubAccountError` -- it never reaches
 *      `MonadAccountTxSigner`, so no second nonce is ever fetched for that sub-account while the
 *      first is in flight.
 *   2. Opt-in `waitForLease` (`acquireLeaseWhenAvailable`): the second attempt queues/polls while
 *      the pool's only sub-account is in flight, and picks up a *fresh* sub-account -- never the
 *      first's -- as soon as one becomes available, proving both that waiting/serialization still
 *      works correctly and that the two stamps never share a nonce/account, even once the first's
 *      lease is released as `'confirmed'`.
 *
 *      **Correction (ticket #34, after #14/#18/#21 shipped):** this scenario originally asserted
 *      the *opposite* -- that once the first's lease released as `'confirmed'`, the second attempt
 *      would reuse that same sub-account. That was `SubAccountLeaseManager.releaseLease`'s bug:
 *      mapping `'confirmed'` back to `'available'` let a small, fixed pool cycle through reuse
 *      across many messages, defeating Stamp's UTXO-style unlinkability goal (`PLAN.md` constraint
 *      3). Now `'confirmed'` retires the account as `'spent'` (terminal, like `'retired'`) --
 *      released back to nothing to reuse -- so this scenario instead exercises
 *      `MonadSubAccountPool`'s "growing/pre-funded" side (ticket #34's other acceptance criteria):
 *      a fresh account becoming available (e.g. via `topUpPool()`, simulated here as `ensureSize`
 *      since this file doesn't touch chain-funding infra) is what actually unblocks the waiter, not
 *      the first's release.
 *   3. Documented "first tx never confirms" case: a network failure on the PUT followed by an
 *      exhausted `GET` poll budget releases the lease as `'stuck'`, which `SubAccountLeaseManager`
 *      maps to `'retired'` (per #18 -- never reused with a guessed nonce). This does not deadlock a
 *      later, unrelated stamp attempt: with a second sub-account still `'available'` in the pool,
 *      `acquireLease()` simply picks that other account and proceeds normally. (Recovering the
 *      retired account itself is explicitly out of scope, per #18 and this ticket's non-goals --
 *      only "does it deadlock or silently misbehave" is asserted here, per the ticket's acceptance
 *      criteria.)
 */
import { JsonRpcProvider, Transaction, getBytes } from 'ethers'
import axios from 'axios'

import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadSubAccountPool } from './monad-account-pool'
import {
  NoAvailableSubAccountError,
  SubAccountLeaseManager,
} from './monad-account-lease'
import { MonadTxSubmitter } from './monad-account-tx'
import {
  MonadStampAbandonedError,
  MonadStampClient,
  MonadStampedMessageProto,
  StampMonadMessageResult,
  StoredMonadMessageProto,
  decodeMonadStampedMessage,
  encodeMonadStampedMessage,
} from './monad-stamp-client'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk'
const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD'
const CHAIN_ID = 10143

const FEE_OVERRIDES = {
  gasLimit: 60_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
}

// --- Test helpers (same techniques as monad-stamp-client.jest.test.ts) ---------------------------

function makePool(size: number): MonadSubAccountPool {
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

/** A shared, monotonically-increasing nonce counter across every `getTransactionCount` call --
 * good enough to prove strict ordering between two txs signed one after another (whether for the
 * same sub-account or different ones); this is not meant to model per-address chain state. */
function makeChainProvider() {
  let nonce = 0
  return makeStubProvider(async req => {
    if (req.method === 'getTransactionCount')
      return `0x${(nonce++).toString(16)}`
    if (req.method === 'estimateGas') return '0x5208'
    throw new Error(`unexpected _perform: ${req.method}`)
  })
}

function makeMockHttpClient(): jest.Mocked<MonadTxSubmitter> {
  return {
    submitRawTransaction: jest.fn(),
    getTransactionReceipt: jest.fn(),
  }
}

function storedMessageBytes(message: MonadStampedMessageProto): Uint8Array {
  const stored: StoredMonadMessageProto = {
    message,
    senderAddress: getBytes('0x' + '11'.repeat(20)),
    txHash: getBytes('0x' + '22'.repeat(32)),
    timestamp: 1_700_000_000_000,
    networkTag: new Uint8Array(),
  }
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
  return writer.getResultBuffer()
}

function makeClient(pool: MonadSubAccountPool) {
  const leaseManager = new SubAccountLeaseManager(pool)
  const provider = makeChainProvider()
  const httpClient = makeMockHttpClient()
  const client = new MonadStampClient({
    pool,
    leaseManager,
    provider,
    httpClient,
    relayBaseUrl: 'https://relay.example.com',
  })
  return { client, leaseManager, provider, httpClient }
}

function hexOf(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex')
}

/** Decodes a `PUT /message/monad` request body and returns the nonce the enclosed raw burn tx was
 * actually signed with. */
function nonceOfPutBody(body: Buffer): number {
  const sent = decodeMonadStampedMessage(new Uint8Array(body))
  return Transaction.from(hexOf(sent.rawBurnTx)).nonce
}

function successResponse(sentMessage: MonadStampedMessageProto) {
  return {
    data: storedMessageBytes(sentMessage),
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {},
  }
}

/** A controllable stand-in for an in-flight `PUT /message/monad` call: resolves only when
 * `resolve()` is called, simulating "the relay hasn't responded yet" -- from the client's
 * perspective the burn tx's on-chain confirmation status is simply unknown/pending until then. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  // `jest.mock('axios')` automocks every export, including `isAxiosError`, to a bare `jest.fn()`
  // returning `undefined` -- give it a real implementation so `submitStampedMessage`'s
  // `axios.isAxiosError(err)` branches behave the same way they would against the real library.
  mockedAxios.isAxiosError.mockImplementation(
    (e: unknown) => (e as { isAxiosError?: boolean })?.isAxiosError === true,
  )
})

describe('nonce-race sequencing proof (#21)', () => {
  it('scenario 1: default acquireLease() rejects a second same-account stamp immediately while the first is still in flight, never touching a second nonce', async () => {
    const pool = makePool(1) // exactly one available sub-account, per the ticket's setup.
    const { client } = makeClient(pool)

    const firstPut = deferred<ReturnType<typeof successResponse>>()
    let putCalls = 0
    mockedAxios.mockImplementation(async () => {
      putCalls++
      return firstPut.promise
    })

    const payloadA = new TextEncoder().encode('first stamp')
    const payloadB = new TextEncoder().encode('second stamp, same sub-account')

    // Fire the first stamp -- do not await yet. `submitStampedMessage` runs synchronously (lease
    // acquisition has no `await` before it) through signing the burn tx and issuing the PUT, which
    // is now parked on `firstPut.promise` (the relay "hasn't confirmed yet").
    const firstResultPromise = client.submitStampedMessage({
      encryptedPayload: payloadA,
      destinationAddress: BURN_ADDRESS,
      stampValueWei: 10_000n,
      overrides: FEE_OVERRIDES,
    })

    // Let the first call's build/sign/PUT-issue microtasks run before firing the second -- this is
    // the ticket's "second issued before the first's broadcast has confirmed" race: the relay has
    // not responded (firstPut is still pending) when the second attempt starts.
    await flushMicrotasks()
    expect(pool.getRecord(0)?.status).toBe('in-use')
    expect(putCalls).toBe(1)

    // Second attempt, same pool (its one sub-account is already leased), no `waitForLease`: this
    // is MonadStampClient's real default call shape (`this.leaseManager.acquireLease()`), which
    // never waits.
    const secondResultPromise = client.submitStampedMessage({
      encryptedPayload: payloadB,
      destinationAddress: BURN_ADDRESS,
      stampValueWei: 10_000n,
      overrides: FEE_OVERRIDES,
    })

    await expect(secondResultPromise).rejects.toBeInstanceOf(
      NoAvailableSubAccountError,
    )
    // The second attempt never got far enough to issue its own PUT -- only the first call's PUT
    // was ever made, proving no second nonce was ever fetched/used concurrently.
    expect(putCalls).toBe(1)
    // The lease is still held by the (still in-flight) first call.
    expect(pool.getRecord(0)?.status).toBe('in-use')

    // Now let the first call's relay response land -- it completes normally, unaffected by the
    // second attempt's rejection.
    const sentBody = mockedAxios.mock.calls[0][0].data as Buffer
    const sentMessage = decodeMonadStampedMessage(new Uint8Array(sentBody))
    firstPut.resolve(successResponse(sentMessage))

    const firstResult = await firstResultPromise
    expect(firstResult.stored.message?.encryptedPayload).toEqual(payloadA)
    // Ticket #34: a confirmed release retires the account as 'spent', not 'available' -- never
    // reused. Exactly one PUT ever happened end to end.
    expect(pool.getRecord(0)?.status).toBe('spent')
    expect(putCalls).toBe(1)
  })

  it("scenario 2 (ticket #34 correction): acquireLeaseWhenAvailable (waitForLease) queues the second stamp while the pool is exhausted, then picks up a FRESH sub-account once one becomes available -- never the first's, even after its lease releases as 'confirmed'", async () => {
    const pool = makePool(1)
    const { client } = makeClient(pool)

    const firstPut = deferred<ReturnType<typeof successResponse>>()
    const putBodies: Buffer[] = []
    let putCalls = 0
    mockedAxios.mockImplementation(async config => {
      putCalls++
      const body = config.data as Buffer
      putBodies.push(body)
      if (putCalls === 1) return firstPut.promise
      // Second PUT (once the second attempt finally gets its lease) resolves immediately.
      const sentMessage = decodeMonadStampedMessage(new Uint8Array(body))
      return successResponse(sentMessage)
    })

    const payloadA = new TextEncoder().encode('first stamp, waited-for lease')
    const payloadB = new TextEncoder().encode('second stamp, queued behind it')

    const firstResultPromise = client.submitStampedMessage({
      encryptedPayload: payloadA,
      destinationAddress: BURN_ADDRESS,
      stampValueWei: 10_000n,
      overrides: FEE_OVERRIDES,
    })

    await flushMicrotasks()
    expect(pool.getRecord(0)?.status).toBe('in-use')
    expect(putCalls).toBe(1)

    // Second attempt opts into waiting via `waitForLease` -- MonadStampClient's
    // `acquireLeaseWhenAvailable` call path. Real timers, short poll interval, generous timeout.
    let secondSettled = false
    const secondResultPromise = client
      .submitStampedMessage({
        encryptedPayload: payloadB,
        destinationAddress: BURN_ADDRESS,
        stampValueWei: 10_000n,
        overrides: FEE_OVERRIDES,
        waitForLease: { pollIntervalMs: 5, timeoutMs: 5_000 },
      })
      .finally(() => {
        secondSettled = true
      })

    // Give the poll loop several real ticks to run while the first PUT is still unresolved -- it
    // must NOT have acquired the lease or settled yet: it is genuinely blocked/queued, not racing
    // the first for the same nonce.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(secondSettled).toBe(false)
    expect(pool.getRecord(0)?.status).toBe('in-use') // still held by the first attempt
    expect(putCalls).toBe(1) // second has not built/sent anything yet

    // Now the first attempt's relay response lands, releasing the lease as 'confirmed'.
    const firstSentMessage = decodeMonadStampedMessage(
      new Uint8Array(putBodies[0]),
    )
    firstPut.resolve(successResponse(firstSentMessage))
    const firstResult = await firstResultPromise
    expect(firstResult.stored.message?.encryptedPayload).toEqual(payloadA)
    // Ticket #34: a confirmed release retires the account as 'spent' -- terminal, never reused.
    expect(pool.getRecord(0)?.status).toBe('spent')

    // With the pool's only account now permanently spent (not 'available'), the second attempt
    // must still be genuinely blocked -- there is nothing to reuse. Give its poll loop a few more
    // real ticks to prove it does NOT (incorrectly) pick index 0 back up.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(secondSettled).toBe(false)
    expect(putCalls).toBe(1)

    // A fresh, already-funded sub-account becomes available -- standing in for
    // `MonadSubAccountPool.topUpPool()` completing in the background (this file doesn't exercise
    // real chain-funding infra; `ensureSize` is the same "derive + mark available" primitive
    // `topUpPool` builds on, see `monad-account-pool.ts`). The second attempt's poll loop should
    // now pick up this fresh account and complete.
    pool.ensureSize(2)
    const secondResult = await secondResultPromise
    expect(secondResult.stored.message?.encryptedPayload).toEqual(payloadB)

    // The two stamps NEVER used the same sub-account -- the whole point of this correction.
    expect(firstResult.leaseIndex).toBe(0)
    expect(secondResult.leaseIndex).toBe(1)
    expect(secondResult.leaseIndex).not.toBe(firstResult.leaseIndex)

    // Still strictly sequenced (never built/sent concurrently), independent of sharing an account.
    expect(putBodies).toHaveLength(2)
    const firstNonce = nonceOfPutBody(putBodies[0])
    const secondNonce = nonceOfPutBody(putBodies[1])
    expect(secondNonce).toBeGreaterThan(firstNonce)

    // Final state: BOTH accounts end up permanently 'spent' after their own confirmed release --
    // neither is ever selectable again.
    expect(pool.getRecord(0)?.status).toBe('spent')
    expect(pool.getRecord(1)?.status).toBe('spent')
    expect(putCalls).toBe(2)
  })

  it('scenario 3 (documented): if the first tx never confirms, the lease retires the sub-account (stuck) instead of deadlocking a later, unrelated stamp on a different account', async () => {
    // Two sub-accounts: one gets burned through the abandon path, the other proves the pool isn't
    // deadlocked afterward.
    const pool = makePool(2)
    const { client } = makeClient(pool)

    // Every PUT is a network-level failure (no HTTP response at all -- "genuinely unknown" per
    // monad-stamp-client.ts's header), and the abandon-poll GET never finds a stored message
    // either -- the documented "first tx never confirms" case.
    mockedAxios.mockImplementation(async () => {
      const networkErr = Object.assign(new Error('timeout'), {
        isAxiosError: true,
        response: undefined,
      })
      throw networkErr
    })

    await expect(
      client.submitStampedMessage({
        encryptedPayload: new TextEncoder().encode('never confirms'),
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

    // Per #18: 'stuck' -> 'retired', never 'available' again (never reused with a guessed nonce).
    const retired = pool.records().filter(r => r.status === 'retired')
    expect(retired).toHaveLength(1)
    const retiredIndex = retired[0].index
    expect(pool.getRecord(retiredIndex)?.status).toBe('retired')

    // No deadlock: a subsequent, unrelated stamp attempt (default acquireLease -- never waits)
    // succeeds immediately by picking the other, still-'available' sub-account. If the lease
    // module deadlocked, or the retired account were somehow still selectable, this would either
    // hang or throw (NoAvailableSubAccountError / SubAccountAlreadyLeasedError).
    mockedAxios.mockImplementation(async config => {
      const sentMessage = decodeMonadStampedMessage(
        new Uint8Array(config.data as Buffer),
      )
      return successResponse(sentMessage)
    })

    const nextResult: StampMonadMessageResult =
      await client.submitStampedMessage({
        encryptedPayload: new TextEncoder().encode('unrelated later stamp'),
        destinationAddress: BURN_ADDRESS,
        stampValueWei: 10_000n,
        overrides: FEE_OVERRIDES,
      })

    expect(nextResult.leaseIndex).not.toBe(retiredIndex)
    // Ticket #34: this stamp's own confirmed release retires it as 'spent' -- terminal, never
    // 'available' again (it completed successfully and consumed the account, unlike the first).
    expect(pool.getRecord(nextResult.leaseIndex)?.status).toBe('spent')
    // The retired account is still retired -- this ticket does not implement recovery for it.
    expect(pool.getRecord(retiredIndex)?.status).toBe('retired')
  })
})
