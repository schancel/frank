/**
 * #1236 Stage 0: a paid message's inputs stay exclusively owned by one operation.
 *
 * Five independent checks keep two paid messages from spending the same sub-account:
 *
 *   1. Selection skips every pool account an intent or an uncleaned attempt names
 *      (`monad-stamp-client.ts`, `protectedIndices`).
 *   2. Selection skips accounts that are not `available` and accounts a pending native send spends
 *      from (`monad-stamp-client.ts`, the candidate filter and `pool.isSpendReserved`).
 *   3. The input admission re-projects every owner and refuses a plan that overlaps a held input
 *      before the intent is written (`evm-input-admission.ts`, `prepareCanonical`).
 *   4. The canonical journal refuses an intent whose reservation index another intent or uncleaned
 *      attempt holds (`storage/stamp-attempt-journal.ts`, `prepareIntent`).
 *   5. Signing and replay re-check: the admission at signing, the pool row at signing, and the
 *      projection before a replay (`evm-input-admission.ts`, `monad-stamp-client.ts`).
 *
 * A later stage loosens a queue that today also keeps these inputs apart; these tests are the
 * proof that the checks, not the queue, carry the guarantee. Each one is written so that it fails
 * when exactly one check is disabled and the other four stay in place. Where a check can only be
 * reached by getting past an earlier one, the test removes the earlier one from the scene by
 * construction (and says so) rather than by editing production code.
 *
 * Real typed custody, real Level journals, the real link store, real directory admission, real
 * sealing/opening and real stamp funding, from the shared two-wallet fixture
 * (`canonical-two-wallets.testutil.ts`); only the chain RPC, the chain HTTP client, the topic
 * relay's HTTP surface and the message relay's HTTP surface are stand-ins. Every test counts what
 * reached the wallet's journal and the relay, not only which error came back.
 *
 * Tests labelled "pin" assert today's blocking and are inverted by the stage named in the label.
 * The Stage 0 pin for the wallet queue (row 0.1) has been inverted by Stage 1 into a proof: the
 * wallet queue is no longer held while a relay request is in flight.
 * The last test is the proof for #1323: an attempt the relay ended no longer blocks later sends.
 */
// First: the mock factories below load this file while the wallet modules are still loading.
import {
  chainHttpRequests,
  fixture,
  mailboxes,
  mockBalances,
  mockFunded,
  providerBroadcasts,
  providerRequests,
  useProviderStandIns,
  type Fixture,
  type InboxRecord,
} from './canonical-two-wallets.testutil'
import axios from 'axios'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  Transaction,
  Wallet,
  getBytes,
  hexlify,
  sha256,
  toUtf8Bytes,
} from 'ethers'
import {
  defaultContext,
  encodeFrame,
  toHex,
  topicBurnCommitment,
  validateFrame,
} from '@frank/codec'
import { restoreCanonicalRequest } from '@frank/cashweb/relay/canonical-dm-transport'
import * as mailboxClient from '@frank/cashweb/relay/monad-mailbox-client'
import domainVectors from '../../domain-roots/vectors/domain-roots-v1.json'
import type { MonadRootBundle } from '../monad-wallet-material'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import {
  MonadCanonicalStampClient,
  MonadStampPendingAttemptError,
} from '../monad-stamp-client'
import { MonadAccountTxSigner } from '../monad-account-tx'
import { EvmNativeOperationJournal } from '../storage/evm-native-operation-journal'
import { LevelCanonicalStampAttemptJournal } from '../storage/stamp-attempt-journal'
import {
  CanonicalMessagingHoldError,
  CanonicalRecipientUndeliverableError,
  LevelCanonicalLinkStore,
  type CanonicalDirectory,
} from './monad-canonical-dm'
import { applyWalletSyncItem } from '../sync-dispatcher'
import type { WalletSyncItem } from '@frank/cashweb/types/messages'
import {
  canonicalMonadStampClient,
  installCanonicalDirectory,
} from './monad-chain'

jest.mock('../monad-provider', () =>
  require('./canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('../monad-http', () =>
  require('./canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/monad-mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule(),
)
// The topic relay is reached with axios; nothing in this suite may touch a real network.
jest.mock('axios')
const topicRelay = axios as jest.MockedFunction<typeof axios>

/** A balance large enough that an account is never the limiting one. */
const BIG = 10n ** 15n

function roots(index: number): MonadRootBundle {
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

type PrepareInput = Parameters<MonadCanonicalStampClient['prepareIntent']>[0]
/** What the tests read off the stamp client; the client keeps these private. */
interface ClientInternals {
  journal: {
    getIntents(): {
      attemptRef: string
      consumerId: string
      prepared: PrepareInput['prepared']
      members: { reservation: { id: string; index: number }; from: string }[]
    }[]
    getAll(): {
      attemptRef: string
      consumerId: string
      prepared: PrepareInput['prepared']
      request: unknown
      reservations: { id: string; index: number }[]
      cleanupComplete: boolean
    }[]
  }
  wallet: {
    walletState: {
      canonicalBinding: { tuple: string; id: string }
      topicOperationJournal: { put(operation: unknown): Promise<void> }
      runLifetime<T>(task: (lifetime: never) => Promise<T>): Promise<T>
      inputAdmission: {
        inspect(lifetime: never): { status: string; epoch: never }
        prepareNative(
          lifetime: never,
          epoch: never,
          plan: unknown,
        ): Promise<unknown>
      }
    }
  }
}

describe('paid-message input ownership (#1236 Stage 0)', () => {
  jest.setTimeout(120_000)
  let f: Fixture
  let alice: EvmChainWalletHandle
  let directory: CanonicalDirectory
  let bobInbox: InboxRecord[]
  /** Every payment-set body the message relay was handed, in any relay mode, in order. */
  let relayBodies: { body: Uint8Array; contentType: string }[]
  /** Every request of any kind the message relay's fetch was asked to make. */
  let relayCalls: { method: string; url: string }[]
  let relayMode: 'fixture' | 'ended'
  let prepareIntent: jest.SpyInstance
  let finishIntent: jest.SpyInstance
  let sign: jest.SpyInstance

  beforeEach(async () => {
    mockBalances.clear()
    mockFunded.length = 0
    mailboxes.clear()
    providerRequests.length = 0
    chainHttpRequests.length = 0
    providerBroadcasts.length = 0
    // This suite sends native transactions through the wallet's own provider.
    useProviderStandIns()
    topicRelay.mockReset()
    relayBodies = []
    relayCalls = []
    relayMode = 'fixture'
    f = await fixture()
    alice = f.alice
    const base = await f.directoryFor('alice', f.alice, f.bob)
    directory = {
      ...base,
      // Records every request and can end delivery the way a relay does: a terminal answer.
      fetch: async (url, init) => {
        relayCalls.push({ method: init.method, url })
        // Mailbox reads are relay requests too, but they are not payment sets.
        if (!String(init.headers['Content-Type']).startsWith('multipart/'))
          return base.fetch!(url, init)
        const request = {
          body: new Uint8Array(init.body!),
          contentType: init.headers['Content-Type'],
        }
        relayBodies.push(request)
        if (relayMode === 'fixture') return base.fetch!(url, init)
        const answer = new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            phase: 'dead',
            identity: restoreCanonicalRequest(request).identity,
            reason: 'undeliverable',
          }),
        )
        let read = false
        return {
          status: 200,
          url,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === 'content-type' ? 'application/json' : null,
          },
          body: {
            getReader: () => ({
              read: async () =>
                read
                  ? { done: true }
                  : ((read = true), { done: false, value: answer }),
              cancel: async () => undefined,
              releaseLock: () => undefined,
            }),
          },
        }
      },
    }
    installCanonicalDirectory(alice, directory)
    installCanonicalDirectory(
      f.bob,
      await f.directoryFor('bob', f.bob, f.alice),
    )
    bobInbox = []
    mailboxes.set(toHex(f.bob.identity.compressedPubKey), bobInbox)
    f.setMailbox(bobInbox)
    prepareIntent = jest.spyOn(
      MonadCanonicalStampClient.prototype,
      'prepareIntent',
    )
    finishIntent = jest.spyOn(MonadCanonicalStampClient.prototype, 'finishIntent')
    sign = jest.spyOn(MonadAccountTxSigner.prototype, 'signFrozenUnsigned')
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await alice.close().catch(() => undefined)
    await f.close().catch(() => undefined)
  })

  // ---- helpers ---------------------------------------------------------------------------------

  /** Closes the file-backed wallet and opens it again from its storage: a real restart. */
  async function reopen() {
    await alice.close()
    alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    installCanonicalDirectory(alice, directory)
  }
  const internals = () =>
    canonicalMonadStampClient(alice) as unknown as ClientInternals
  const journal = () => internals().journal
  /** Everything the wallet's payment journal holds, as the bytes a restart would read back. */
  const journalBytes = () =>
    JSON.stringify([journal().getIntents(), journal().getAll()])
  const counts = () => ({
    intents: journal().getIntents().length,
    attempts: journal().getAll().length,
    relayRequests: relayBodies.length,
    paymentSets: new Set(
      relayBodies.map(
        request => restoreCanonicalRequest(request).identity.submission_identity,
      ),
    ).size,
  })
  /** The pool indices a record of the journal holds. */
  const heldIndices = () =>
    new Set<number>([
      ...journal()
        .getIntents()
        .flatMap(intent => intent.members.map(m => m.reservation.index)),
      ...journal()
        .getAll()
        .flatMap(attempt => attempt.reservations.map(r => r.index)),
    ])
  const status = (index: number) => alice.pool.getRecord(index)!.status
  /** Lets `count` macrotask turns pass, so everything that can run without a pending promise did. */
  const turns = async (count: number) => {
    for (let i = 0; i < count; i++) await new Promise(resolve => setImmediate(resolve))
  }
  /** Follows a promise without awaiting it, so a test can ask whether it has settled yet. */
  function watch<T>(promise: Promise<T>) {
    const seen: { settled: boolean; value?: T; error?: unknown } = { settled: false }
    const done = promise.then(
      value => void ((seen.settled = true), (seen.value = value)),
      error => void ((seen.settled = true), (seen.error = error)),
    )
    return { seen, done }
  }

  /** One `send` from Alice to Bob and what it did. */
  async function send(text: string, extra: { onAttemptCreated?: (d: string) => void } = {}) {
    let error: unknown
    let result: Awaited<ReturnType<typeof f.chain.directMessages.send>> | undefined
    try {
      result = await f.chain.directMessages.send({
        wallet: alice,
        recipient: f.bob.identity.address,
        items: [{ type: 'text', text }],
        ...extra,
      })
    } catch (caught) {
      error = caught
    }
    return { result, error }
  }
  /** Make message A unresolved: signed, offered to the relay, and not answered as delivered. The
   * relay stays in `phase`; `sign` is cleared so tests count only what they themselves sign. */
  async function pendingA(phase: 'retained' | 'fail' = 'retained') {
    f.setPhase(phase)
    let digest = ''
    const sent = await send('message A', {
      onAttemptCreated: created => void (digest = created),
    })
    expect(sent.error).toBeInstanceOf(MonadStampPendingAttemptError)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    sign.mockClear()
    return { digest }
  }
  /**
   * The exact input the wallet would hand `prepareIntent` for a message (sealed payload, fresh
   * directory snapshots), taken from a real `send` that is stopped at that call. The send has
   * funded its inventory by then and has created nothing in the journal. Tests use it to build a
   * plan for a second message directly through the stamp client, past the messaging pending gate.
   */
  async function sealed(text: string): Promise<PrepareInput> {
    let taken: PrepareInput | undefined
    prepareIntent.mockImplementationOnce(async (input: PrepareInput) => {
      taken = input
      throw new Error('stopped before the intent')
    })
    await send(text)
    if (!taken) throw new Error('the send did not reach prepareIntent')
    return taken
  }
  /** `prepareIntent` for a sealed message. `durable` is the caller's link write. */
  const plan = (
    input: PrepareInput,
    durable: PrepareInput['onIntentDurable'] = async () => undefined,
  ) =>
    canonicalMonadStampClient(alice).prepareIntent({
      ...input,
      onIntentDurable: durable,
    })
  /** Adds funded pool rows beyond the ones stamp funding made. Returns the new indices. */
  function extraRows(count: number): number[] {
    const before = alice.pool.records().map(r => r.index)
    alice.pool.ensureSize(Math.max(...before, -1) + 1 + count)
    const added = alice.pool
      .records()
      .map(r => r.index)
      .filter(index => !before.includes(index))
    for (const index of added) setBalance(index, BIG)
    return added
  }
  /** The account's balance as the chain stub reports it and as the wallet's coin cache holds it
   * (selection reads the cache first when it has a positive entry). */
  function setBalance(index: number, wei: bigint) {
    const address = alice.pool.getRecord(index)!.address
    mockBalances.set(address.toLowerCase(), wei)
    for (const coin of alice.accountUtxoPool?.getCoinsByAddress(address, 'monad') ?? [])
      coin.balanceWei = wei
  }
  /** Balances that make `order[0]` the account selection prefers, then `order[1]`, and so on. */
  function preferInOrder(order: number[]) {
    order.forEach((index, rank) => setBalance(index, BIG + BigInt(rank) * 1_000n))
  }
  /** Rows the tests do not want selected are emptied; selection skips an empty account. */
  function empty(indices: number[]) {
    for (const index of indices) setBalance(index, 0n)
  }
  const indicesOf = (intent: { members: { reservation: { index: number } }[] }) =>
    intent.members.map(m => m.reservation.index)
  const linkOf = (intent: {
    attemptRef: string
    consumerId: string
    prepared: PrepareInput['prepared']
  }) => ({
    attemptRef: intent.attemptRef,
    consumerId: intent.consumerId,
    prepared: intent.prepared,
  })
  /** A pending native send that spends from pool row `index`, written through the admission. */
  async function pendingNativeFrom(index: number) {
    const record = alice.pool.getRecord(index)!
    const unsigned = Transaction.from({
      type: 2,
      chainId: 10143,
      nonce: 0,
      to: f.bob.identity.address.raw,
      value: 1n,
      gasLimit: 21_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    }).unsignedSerialized
    const { walletState } = internals().wallet
    return walletState.runLifetime(async lifetime => {
      const snapshot = walletState.inputAdmission.inspect(lifetime)
      if (snapshot.status !== 'ready') throw new Error('admission not ready')
      return walletState.inputAdmission.prepareNative(lifetime, snapshot.epoch, {
        kind: 'native',
        recipient: f.bob.identity.address.raw.toLowerCase(),
        intendedValueWei: '1',
        members: [
          {
            source: {
              kind: 'spend',
              index,
              address: record.address.toLowerCase(),
            },
            dependencies: [],
            unsignedTransaction: unsigned,
          },
        ],
      })
    })
  }

  /** A separate journal bound to the wallet's tuple and seeded with A's real attempt refuses an
   * intent that reserves an index A holds, and accepts one on a free index. */
  async function journalRefusesHeldIndex(
    attemptA: ReturnType<ClientInternals['journal']['getAll']>[number],
    inputB: PrepareInput,
  ) {
    const location = await mkdtemp(join(tmpdir(), 'ownership-journal-'))
    const own = new LevelCanonicalStampAttemptJournal(location)
    await own.Open()
    try {
      const { prepared } = attemptA
      const { tuple } = internals().wallet.walletState.canonicalBinding
      // The tuple is the wallet's own, so the journal accepts the wallet's real records.
      expect(sha256(toUtf8Bytes(tuple)).slice(2)).toBe(prepared.walletBindingId)
      await own.bindPublicTuple(tuple)
      await own.prepare({
        prepared: attemptA.prepared,
        request: attemptA.request as never,
        reservations: attemptA.reservations,
        consumerId: attemptA.consumerId,
      })
      expect(own.getAll().map(a => a.cleanupComplete)).toEqual([false])
      const held = attemptA.reservations[0]
      const member = (reservation: { id: string; index: number }, nonce = 0) => {
        const tx = Transaction.from({
          type: 2,
          chainId: 10143,
          nonce,
          to: f.bob.identity.address.raw,
          value: 1n,
          gasLimit: 21_000n,
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
        })
        return {
          reservation,
          from: '0x' + '22'.repeat(20),
          unsignedSerialized: tx.unsignedSerialized,
          rawTx: null,
        }
      }
      const intentFor = (reservation: { id: string; index: number }) => ({
        prepared: inputB.prepared,
        consumerId: inputB.consumerId,
        boundary: 'ownership-boundary-0001',
        construction: Uint8Array.of(1),
        members: [member(reservation)],
      })

      // The same index under another id, and the same id under another index, are both refused.
      await expect(
        own.prepareIntent(intentFor({ id: 'canonical:other', index: held.index })),
      ).rejects.toThrow('conflict')
      await expect(
        own.prepareIntent(intentFor({ id: held.id, index: held.index + 100 })),
      ).rejects.toThrow('conflict')
      expect(own.getIntents()).toHaveLength(0)
      // Positive control: the same intent on an unheld index is accepted.
      const accepted = await own.prepareIntent(
        intentFor({ id: 'canonical:free', index: held.index + 100 }),
      )
      expect(accepted.members[0].reservation.index).toBe(held.index + 100)
      expect(own.getIntents()).toHaveLength(1)
    } finally {
      await own.Close()
      await rm(location, { recursive: true, force: true })
    }
  }

  // ---- the five checks, each isolated ----------------------------------------------------------

  // CHECK 1 (and amendment A0.2): the intent is durable and its pool rows are still `available`,
  // so only the intent-derived protection can keep the next plan off them. Check 2 (status) has
  // nothing to say about an available row; checks 3 and 4 would catch a plan that ignored the
  // protection, which is why the test asserts the plan is made, on other accounts.
  it('check 1: a plan for another message avoids the accounts of a durable intent whose rows are still available', async () => {
    const inputA = await sealed('message A')
    const inputB = await sealed('message B')
    // The callback that must link the intent fails: the intent is durable, no lease was taken.
    await expect(
      plan(inputA, async () => {
        throw new Error('the link was not written')
      }),
    ).rejects.toThrow('the link was not written')
    const [intentA] = journal().getIntents()
    const heldByA = indicesOf(intentA)
    expect(heldByA.length).toBeGreaterThan(0)
    for (const index of heldByA) expect(status(index)).toBe('available')
    // Fresh funded rows exist, but A's own rows are the ones selection would prefer.
    const spare = extraRows(2)
    empty(alice.pool.records().map(r => r.index).filter(i => !heldByA.includes(i) && !spare.includes(i)))
    preferInOrder([...heldByA, ...spare])
    const before = counts()

    const intentB = await plan(inputB)

    expect(indicesOf(intentB).length).toBeGreaterThan(0)
    for (const index of indicesOf(intentB)) {
      expect(heldByA).not.toContain(index)
      expect(spare).toContain(index)
    }
    for (const index of heldByA) expect(status(index)).toBe('available')
    expect(counts()).toEqual({ ...before, intents: 2 })
    expect(counts().paymentSets).toBe(0)
    expect(sign).not.toHaveBeenCalled()
  })

  // CHECK 2, the status half: an `in-use` row that no canonical record names (a lease some other
  // operation holds). Nothing in the journal protects it, so only the `available` filter does.
  it('check 2 (status): a plan avoids an in-use account that no canonical record names', async () => {
    const inputB = await sealed('message B')
    const [held, ...others] = extraRows(3)
    empty(alice.pool.records().map(r => r.index).filter(i => i !== held && !others.includes(i)))
    preferInOrder([held, ...others])
    const lease = alice.leaseManager.acquireForIndex(held)
    expect(status(held)).toBe('in-use')
    expect(heldIndices().size).toBe(0)

    const intentB = await plan(inputB)

    for (const index of indicesOf(intentB)) {
      expect(index).not.toBe(held)
      expect(others).toContain(index)
    }
    expect(counts()).toEqual({
      intents: 1,
      attempts: 0,
      relayRequests: 0,
      paymentSets: 0,
    })
    alice.leaseManager.releaseLease(lease, 'unused')
  })

  // CHECK 2, the derived reservation half (#1316): a pending native send spends from the row. The
  // row is `available` and no canonical record names it; the pool predicate, which reads the native
  // journal on every selection, is what keeps it out.
  it('check 2 (reservation): a plan avoids an account a pending native send spends from', async () => {
    const inputB = await sealed('message B')
    const [held, ...others] = extraRows(3)
    empty(alice.pool.records().map(r => r.index).filter(i => i !== held && !others.includes(i)))
    preferInOrder([held, ...others])
    await pendingNativeFrom(held)
    expect(alice.pool.isSpendReserved(held)).toBe(true)
    expect(status(held)).toBe('available')
    expect(heldIndices().size).toBe(0)

    const intentB = await plan(inputB)

    for (const index of indicesOf(intentB)) {
      expect(index).not.toBe(held)
      expect(others).toContain(index)
    }
    expect(counts().intents).toBe(1)
    expect(sign).not.toHaveBeenCalled()
  })

  // CHECK 3: the admission refuses a plan that overlaps a held input, before the intent is
  // written. To reach it, check 2's reservation predicate is made blind for this test only (the
  // pool is told nothing reserves the row), so selection offers the native-held row; the canonical
  // journal (check 4) knows nothing of native sends, so only the admission can refuse.
  it('check 3: the admission refuses a plan over an account a pending native send spends from, and writes no intent', async () => {
    const inputB = await sealed('message B')
    const [held, ...others] = extraRows(2)
    empty(alice.pool.records().map(r => r.index).filter(i => i !== held && !others.includes(i)))
    preferInOrder([held, ...others])
    await pendingNativeFrom(held)
    jest.spyOn(alice.pool, 'isSpendReserved').mockReturnValue(false)
    const before = counts()
    const callbacks = jest.fn(async () => undefined)

    await expect(plan(inputB, callbacks)).rejects.toThrow(
      'conflicting-authorization',
    )

    // Refused in the admission's own section: nothing durable, nothing offered, nothing signed.
    expect(callbacks).not.toHaveBeenCalled()
    expect(counts()).toEqual(before)
    expect(counts().intents).toBe(0)
    expect(sign).not.toHaveBeenCalled()
    expect(status(held)).toBe('available')
  })

  // CHECK 4: the journal itself refuses a reservation another intent or uncleaned attempt holds.
  // A separate journal, bound to this wallet's tuple and seeded with A's real attempt, is asked
  // directly, so no selection or admission step stands in front of it.
  it('check 4: the journal refuses an intent that reserves a pool index an uncleaned attempt holds', async () => {
    const inputB = await sealed('message B')
    const { digest } = await pendingA()
    const [attemptA] = journal().getAll()
    expect(attemptA.cleanupComplete).toBe(false)
    await journalRefusesHeldIndex(attemptA, inputB)
    // The wallet's own record of A was never touched, and no second payment set exists.
    expect(counts()).toMatchObject({ intents: 0, attempts: 1, paymentSets: 1 })
    expect(digest).toHaveLength(64)
  })

  // CHECK 5 (signing, admission half, A0.3): a conflicting owner appears between the durable
  // intent and signing. A foreign lease on the intent's still-available row is such an owner. The
  // pool-row re-check (5b) would also refuse it, but with a different error, so the test asserts
  // the admission's refusal site.
  it('check 5 (signing admission): signing is refused with the admission conflict when an owner appears between intent and signing', async () => {
    const inputA = await sealed('message A')
    await expect(
      plan(inputA, async () => {
        throw new Error('the link was not written')
      }),
    ).rejects.toThrow('the link was not written')
    const [intentA] = journal().getIntents()
    const index = indicesOf(intentA)[0]
    const lease = alice.leaseManager.acquireForIndex(index)
    const client = canonicalMonadStampClient(alice)
    const eligibility = client.reconcileWorkflowLinks([linkOf(intentA)])[0]
      .eligibility!
    const bytes = journalBytes()

    await expect(client.finishIntent(eligibility)).rejects.toThrow(
      'conflicting-authorization',
    )

    expect(sign).not.toHaveBeenCalled()
    expect(journalBytes()).toBe(bytes)
    expect(counts()).toMatchObject({ intents: 1, attempts: 0, relayRequests: 0 })
    alice.leaseManager.releaseLease(lease, 'unused')
  })

  // CHECK 5 (signing, pool-row half): the admission passes, but the signer the pool derives for a
  // member's row no longer produces the member's address. Nothing may be signed.
  it('check 5 (signing pool row): signing is refused when the pool row no longer yields the member address', async () => {
    const inputA = await sealed('message A')
    await expect(
      plan(inputA, async () => {
        throw new Error('the link was not written')
      }),
    ).rejects.toThrow('the link was not written')
    const [intentA] = journal().getIntents()
    const client = canonicalMonadStampClient(alice)
    const eligibility = client.reconcileWorkflowLinks([linkOf(intentA)])[0]
      .eligibility!
    const real = alice.pool.getSigner.bind(alice.pool)
    jest.spyOn(alice.pool, 'getSigner').mockImplementation(((
      index: number,
      wallet: never,
    ) => {
      const signer = real(index, wallet)
      return new Proxy(signer, {
        get: (target, key) =>
          key === 'address'
            ? '0x' + '33'.repeat(20)
            : Reflect.get(target, key, target),
      })
    }) as never)
    const bytes = journalBytes()

    await expect(client.finishIntent(eligibility)).rejects.toThrow(
      'pool-custody-hold',
    )

    expect(sign).not.toHaveBeenCalled()
    expect(journalBytes()).toBe(bytes)
    expect(counts()).toMatchObject({ intents: 1, attempts: 0, relayRequests: 0 })
  })

  // CHECK 5 (replay, A0.3): the projection conflicts when an exact replay is about to leave. A
  // native owner for A's own pair appears (as a bad import or a skipped admission would leave it).
  it('check 5 (replay): an exact replay is refused, with no relay request, when the projection conflicts', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { digest } = await pendingA()
    const [attemptA] = journal().getAll()
    const record = alice.pool.getRecord(attemptA.reservations[0].index)!
    const rival = {
      operationId: 'rival-native-owner',
      cancelled: false,
      members: [
        {
          source: {
            kind: 'spend',
            index: record.index,
            address: record.address.toLowerCase(),
          },
          dependencies: [],
          observation: { state: 'pending' },
          unsignedTransaction: Transaction.from({
            type: 2,
            chainId: 10143,
            nonce: 0,
            to: f.bob.identity.address.raw,
            value: 7n,
            gasLimit: 21_000n,
            maxFeePerGas: 2n,
            maxPriorityFeePerGas: 1n,
          }).unsignedSerialized,
        },
      ],
    }
    const realList = EvmNativeOperationJournal.prototype.list
    jest
      .spyOn(EvmNativeOperationJournal.prototype, 'list')
      .mockImplementation(function (this: EvmNativeOperationJournal) {
        return [...realList.call(this), rival as never]
      })
    const bytes = journalBytes()
    const before = counts()
    expect(before.relayRequests).toBe(1)

    const outcome = await f.chain.directMessages
      .reconcileAttempts({ wallet: alice, payloadDigests: [digest] })
      .then(
        value => ({ value }),
        error => ({ error }),
      )

    // Whatever the surface reports, no byte of A reached the relay again and nothing changed.
    expect(counts()).toEqual(before)
    expect(journalBytes()).toBe(bytes)
    if ('value' in outcome) expect(outcome.value[digest]).not.toBe('delivered')
  })

  // ---- the contract's test 3.2, made to fail where it claims to ----------------------------------

  // The contract's 3.2 empties the main account and funds only A's accounts, then expects a
  // refusal. As written that refusal could come from funding on the empty main account, before
  // selection runs. This one gives the second plan no funding step at all (it goes straight to the
  // stamp client), leaves A's accounts funded, and asserts the selection's own refusal.
  it('a second plan over only the accounts A holds is refused at selection, not at funding', async () => {
    const inputC = await sealed('message C')
    const { digest } = await pendingA()
    const heldByA = [...heldIndices()]
    expect(heldByA.length).toBeGreaterThan(0)
    // Only A's accounts are funded, and the main account is empty.
    empty(alice.pool.records().map(r => r.index))
    for (const index of heldByA) setBalance(index, BIG)
    mockBalances.set((await alice.getReceiveAddress()).raw.toLowerCase(), 0n)
    const before = { ...counts(), bytes: journalBytes(), funded: mockFunded.length }

    await expect(plan(inputC)).rejects.toThrow(
      'Insufficient stamp-account capacity within 64 payments: need 1000 wei, have 0 wei',
    )

    // The refusal is selection's: funding was never run, and A's accounts do hold value.
    expect(mockFunded.length).toBe(before.funded)
    for (const index of heldByA)
      expect(
        mockBalances.get(alice.pool.getRecord(index)!.address.toLowerCase()),
      ).toBe(BIG)
    expect(sign).not.toHaveBeenCalled()
    expect(journalBytes()).toBe(before.bytes)
    expect(counts()).toMatchObject({
      intents: 0,
      attempts: 1,
      relayRequests: 1,
      paymentSets: 1,
    })
    expect(digest).toHaveLength(64)
  })

  // ---- amendment A0.4: unrelated work proceeds on disjoint inputs -----------------------------------

  /** Answers the topic relay and the chain reads the way a confirmed Forum post would be. */
  function confirmTopicPosts() {
    const burns = new Map<string, Transaction>()
    topicRelay.mockImplementation((async (request: { data: Uint8Array }) => {
      const parsed = validateFrame(request.data, defaultContext())
      if (parsed.kind !== 'parsed' || parsed.typed?.type !== 10)
        throw new Error('unexpected topic relay request')
      const tx = Transaction.from(hexlify(parsed.typed.burnTx))
      burns.set(tx.hash!, tx)
      const payload = new Map<number, unknown>([
        [0, 'monad-testnet'],
        [1, request.data],
        [2, topicBurnCommitment(parsed.typed.postFrame.frame).hash],
        [3, getBytes(tx.hash!)],
        [4, getBytes(tx.from!)],
        [5, 1],
        [6, tx.value],
        [7, 2],
        [8, 0n],
        [9, 0n],
        [10, 1n],
        [11, new Uint8Array(16)],
      ])
      return {
        data: encodeFrame(
          { typeId: 15, schemaVersion: 1, minReaderVersion: 1 },
          payload as never,
        ),
        headers: { 'content-type': 'application/cbor' },
      }
    }) as never)
    jest.spyOn(alice.provider, 'getTransactionReceipt').mockImplementation((async (
      hash: string,
    ) => {
      const tx = burns.get(hash)!
      return { hash, from: tx.from, to: tx.to, status: 1, blockNumber: 0, index: 0 }
    }) as never)
    jest.spyOn(alice.provider, 'getTransaction').mockImplementation((async (
      hash: string,
    ) => {
      const tx = burns.get(hash)!
      return {
        hash,
        from: tx.from,
        to: tx.to,
        value: tx.value,
        data: tx.data,
        chainId: tx.chainId,
        blockNumber: 0,
        index: 0,
      }
    }) as never)
  }

  // A0.4: with A unresolved (signed, no outcome), a native send and a topic post each complete on
  // inputs that are not A's, and A's journal record is byte-for-byte what it was.
  it('A0.4: a native send and a topic post complete on inputs disjoint from the unresolved message A, and leave its record unchanged', async () => {
    const { digest } = await pendingA()
    const heldByA = heldIndices()
    const [attemptA] = journal().getAll()
    const sendersOfA = (
      attemptA.request as { parts: { transactions: Uint8Array[] } }
    ).parts.transactions.map(raw => Transaction.from(hexlify(raw)).from!.toLowerCase())
    expect(sendersOfA).toHaveLength(heldByA.size)
    const recordA = JSON.stringify(attemptA)
    const before = counts()
    const rowsOfAbefore = [...heldByA].map(status)

    const native = await alice.sendNative({
      recipient: f.bob.identity.address,
      value: 1_000n,
    })
    expect(native.txHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(providerBroadcasts).toHaveLength(1)
    expect(sendersOfA).not.toContain(providerBroadcasts[0].from)

    confirmTopicPosts()
    const topicJournal = internals().wallet.walletState.topicOperationJournal
    const written = jest.spyOn(topicJournal, 'put')
    const post = await f.chain.topics.post({
      wallet: alice,
      topic: 'general',
      entries: [{ kind: 'post', title: 'hello', message: 'world' }],
      direction: 'up',
      voteWeightWei: 1_000n,
    } as never)
    expect(post.payloadDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(topicRelay).toHaveBeenCalled()
    expect(written).toHaveBeenCalled()
    for (const [row] of written.mock.calls)
      expect(heldByA.has((row as { leaseIndex: number }).leaseIndex)).toBe(false)

    // A is exactly as it was: same record, same rows, same single payment set, no new relay call.
    expect(JSON.stringify(journal().getAll()[0])).toBe(recordA)
    expect(counts()).toEqual(before)
    expect([...heldByA].map(status)).toEqual(rowsOfAbefore)
    expect(heldIndices()).toEqual(heldByA)
    expect(digest).toHaveLength(64)
  })

  // ---- amendment A0.5: reopening is silent until the first explicit reconcile -------------------------

  // A0.5: a wallet opened with A unresolved makes no relay request and no RPC request on its own.
  // The counters are read at the provider's request layer, the chain HTTP client, the mailbox
  // client, the message relay's fetch and the topic relay; the positive controls below show each
  // of them moves when a real call is made.
  it('A0.5: reopening with message A unresolved makes no relay and no RPC request until the first reconcile', async () => {
    const { digest } = await pendingA()
    const mailboxCalls = () =>
      [
        mailboxClient.fetchCanonicalInboxPage,
        mailboxClient.fetchMonadMailboxInboxPage,
        mailboxClient.fetchMonadMailboxInbox,
        mailboxClient.fetchCanonicalRecoveryPage,
      ].map(fn => jest.mocked(fn).mock.calls.length)
    const requests = () => ({
      rpc: providerRequests.length,
      chainHttp: chainHttpRequests.length,
      messageRelay: relayCalls.length,
      topicRelay: topicRelay.mock.calls.length,
      mailbox: mailboxCalls(),
    })
    await alice.close()
    providerRequests.length = 0
    chainHttpRequests.length = 0
    relayBodies.length = 0
    relayCalls.length = 0
    topicRelay.mockClear()
    for (const fn of [
      mailboxClient.fetchCanonicalInboxPage,
      mailboxClient.fetchMonadMailboxInboxPage,
      mailboxClient.fetchMonadMailboxInbox,
      mailboxClient.fetchCanonicalRecoveryPage,
    ])
      jest.mocked(fn).mockClear()
    const quiet = { rpc: 0, chainHttp: 0, messageRelay: 0, topicRelay: 0, mailbox: [0, 0, 0, 0] }

    alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    installCanonicalDirectory(alice, directory)

    // Open, install the directory, and read the payment journal: nothing reached any network. A
    // few macrotask turns first, so a request the open scheduled for later would have been made.
    await turns(5)
    expect(requests()).toEqual(quiet)
    expect(counts()).toMatchObject({ intents: 0, attempts: 1, relayRequests: 0 })
    expect(requests()).toEqual(quiet)

    // Positive controls: each counter moves on a real call.
    await alice.provider.getBalance((await alice.getReceiveAddress()).raw)
    expect(requests().rpc).toBeGreaterThan(0)
    await alice.httpClient.getTransactionReceipt('0x' + '11'.repeat(32))
    expect(requests().chainHttp).toBe(1)
    await mailboxClient.fetchCanonicalInboxPage({ subject: 'control' } as never)
    expect(requests().mailbox[0]).toBe(1)
    await f.chain.directMessages.fetchSince({ wallet: alice, sinceMs: 0 })
    expect(requests().messageRelay).toBeGreaterThan(0)
    expect(relayBodies).toHaveLength(0)

    // The first explicit reconcile is what talks to the relay, once, with A's own bytes.
    await f.chain.directMessages.reconcileAttempts({
      wallet: alice,
      payloadDigests: [digest],
    })
    expect(relayBodies).toHaveLength(1)
    expect(counts()).toMatchObject({ intents: 0, attempts: 1, paymentSets: 1 })
    topicRelay({ method: 'get', url: 'control' } as never)
    expect(requests().topicRelay).toBe(1)
  })

  // ---- the workflow-queue invariant -------------------------------------------------------------------

  // Stated invariant: fund, select, intent and sign for one send happen inside one workflow-queue
  // section, so accounts freshly funded for B are protected from a concurrent C only by that
  // section. Two sends started together must not interleave their steps.
  it('invariant: two concurrent paid sends run their steps one send after the other and end with disjoint inputs, one attempt each', async () => {
    f.setPhase('delivered')
    const [first, second] = await Promise.all([send('message B'), send('message C')])

    expect(first.error).toBeUndefined()
    expect(second.error).toBeUndefined()
    const steps = [
      ...prepareIntent.mock.invocationCallOrder.map(order => [order, 'prepare'] as const),
      ...finishIntent.mock.invocationCallOrder.map(order => [order, 'finish'] as const),
    ]
      .sort(([a], [b]) => a - b)
      .map(([, name]) => name)
    expect(steps).toEqual(['prepare', 'finish', 'prepare', 'finish'])
    // Each delivered set is cleaned up from the journal; the relay's copy names the senders.
    const sendersBySet = new Map<string, string[]>()
    for (const request of relayBodies) {
      const restored = restoreCanonicalRequest(request)
      sendersBySet.set(
        restored.identity.submission_identity,
        restored.parts.transactions.map(raw =>
          Transaction.from(hexlify(raw)).from!.toLowerCase(),
        ),
      )
    }
    const [one, two] = [...sendersBySet.values()]
    expect(sendersBySet.size).toBe(2)
    expect(one.length).toBeGreaterThan(0)
    expect(two.length).toBeGreaterThan(0)
    for (const sender of one) expect(two).not.toContain(sender)
    expect(prepareIntent).toHaveBeenCalledTimes(2)
    expect(counts()).toMatchObject({ intents: 0, attempts: 0, paymentSets: 2 })
    expect(bobInbox).toHaveLength(2)
  })

  // ---- restart: A's inputs stay owned across a real close and reopen --------------------------------

  // PROOF, contract row 0.6 (must keep passing through every stage): after a real close and reopen
  // with A unresolved, the admission's obligations list A's inputs, and a plan naming those
  // accounts is refused before any signature, at the admission and at the journal separately.
  it('0.6: after a restart the admission still lists A as owning its inputs, and a plan over them is refused at the admission and at the journal, with nothing signed', async () => {
    const inputB = await sealed('message B')
    const { digest } = await pendingA()
    const heldByA = heldIndices()
    const [attemptA] = journal().getAll()
    expect(heldByA.size).toBeGreaterThan(0)

    await reopen()

    const snapshot = await internals().wallet.walletState.runLifetime(
      async lifetime =>
        internals().wallet.walletState.inputAdmission.inspect(lifetime) as unknown as {
          status: string
          obligations: { provenance: { kind: string; attemptRef: string; poolIndex: number } }[]
        },
    )
    expect(snapshot.status).toBe('ready')
    const owned = snapshot.obligations
      .map(claim => claim.provenance)
      .filter(provenance => provenance.kind === 'canonical-attempt')
    expect(new Set(owned.map(p => p.attemptRef))).toEqual(new Set([attemptA.attemptRef]))
    expect(new Set(owned.map(p => p.poolIndex))).toEqual(heldByA)
    expect(counts()).toMatchObject({ intents: 0, attempts: 1 })
    sign.mockClear()
    relayBodies.length = 0
    relayCalls.length = 0
    const bytes = journalBytes()

    // At the admission: a native plan spending a row A holds. Nothing durable, nothing signed.
    const [heldRow] = [...heldByA]
    await expect(pendingNativeFrom(heldRow)).rejects.toThrow('conflicting-authorization')
    expect(journalBytes()).toBe(bytes)
    expect(alice.getNativeOperations?.() ?? []).toHaveLength(0)

    // At the journal: a separate journal seeded with A's real (reopened) attempt refuses an intent
    // over an index A holds, with no selection or admission step in front of it.
    const [reopenedA] = journal().getAll()
    await journalRefusesHeldIndex(reopenedA, inputB)

    expect(sign).not.toHaveBeenCalled()
    expect(relayBodies).toHaveLength(0)
    expect(relayCalls).toHaveLength(0)
    expect(journalBytes()).toBe(bytes)
    expect(digest).toHaveLength(64)
  })

  // PROOF, contract row 0.7 (must keep passing through every stage): with an uncorrelated record
  // (a link whose attempt the wallet's journal does not know), nothing is signed and no relay
  // request is made, whether the caller reconciles or sends.
  it('0.7: with an uncorrelated link record a reconcile and a send are held, nothing is signed and no relay request is made', async () => {
    const address = (await alice.getReceiveAddress()).raw.toLowerCase()
    const storageLocation = `${join(f.root, 'wallet')}-evm-${address}`
    await alice.close()
    const digest = 'ab'.repeat(32)
    const row = {
      attemptRef: 'orphaned-ref-999',
      consumerId: 'frank-dm:orphaned',
      digest,
      prepared: { payload: '00', context: '00', economicBinding: '00' },
    }
    const store = await LevelCanonicalLinkStore.open(storageLocation)
    await store.put(row)
    await store.close()
    alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    installCanonicalDirectory(alice, directory)
    relayBodies.length = 0
    relayCalls.length = 0

    await expect(
      f.chain.directMessages.reconcileAttempts({ wallet: alice, payloadDigests: [digest] }),
    ).rejects.toBeInstanceOf(CanonicalMessagingHoldError)
    const refused = await send('behind missing evidence')
    expect(refused.error).toBeInstanceOf(CanonicalMessagingHoldError)

    expect(sign).not.toHaveBeenCalled()
    expect(prepareIntent).not.toHaveBeenCalled()
    expect(relayBodies).toHaveLength(0)
    expect(relayCalls).toHaveLength(0)
    expect(providerBroadcasts).toHaveLength(0)
    expect(counts()).toMatchObject({ intents: 0, attempts: 0 })
  })

  // ---- pins: an unanswered relay request, and what waits behind it ----------------------------------

  /** A signed spend of pool row `index`, as the item another device of this wallet would sync. */
  async function syncSpendOf(index: number): Promise<WalletSyncItem> {
    const record = alice.pool.getRecord(index)!
    const key = (
      alice.pool as unknown as {
        keyring: { deriveSubAccount(i: number): { privateKey: string } }
      }
    ).keyring.deriveSubAccount(index).privateKey
    const rawTx = await new Wallet(key).signTransaction({
      type: 2,
      chainId: 10143,
      nonce: 0,
      to: f.bob.identity.address.raw,
      value: 1_000n,
      gasLimit: 21_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    })
    return {
      type: 'wallet-sync',
      direction: 'out',
      chainIdentifier: alice.chainIdentifier,
      txHash: Transaction.from(rawTx).hash!,
      rawTx,
      spentInputs: [{ address: record.address, nonce: 0, valueWei: '1000' }],
      createdOutputs: [{ address: f.bob.identity.address.raw, valueWei: '1000' }],
      timestamp: 1,
    } as WalletSyncItem
  }

  // PROOF, #1236 Stage 1 (contract row 1.1; this was the Stage 0 pin, row 0.1, inverted). On main
  // the relay request ran inside the wallet queue, so with A's request entered and unanswered a
  // native send and an incoming sync spend took no first step until the relay answered (up to the
  // transport's 60 seconds). Now both run to completion while the request is still unanswered, on
  // inputs that are not A's, and A then completes normally. A is still in flight throughout: its
  // record is byte-identical, it made one relay request, and its `send` has not settled.
  it('#1236 Stage 1: with A\'s relay request unanswered, a native send and a sync spend both complete on inputs disjoint from A\'s, and A completes when the relay answers', async () => {
    const hold = f.holdNextRelayRequest()
    const a = watch(send('message A'))
    await hold.entered
    expect(hold.hasEntered()).toBe(true)
    // A's payments are signed and journaled; its relay request is in flight and unanswered.
    expect(counts()).toMatchObject({ intents: 0, attempts: 1, relayRequests: 1 })
    expect(a.seen.settled).toBe(false)
    const heldByA = heldIndices()
    const [attemptA] = journal().getAll()
    const sendersOfA = (
      attemptA.request as { parts: { transactions: Uint8Array[] } }
    ).parts.transactions.map(raw => Transaction.from(hexlify(raw)).from!.toLowerCase())
    expect(sendersOfA).toHaveLength(heldByA.size)
    expect(heldByA.size).toBeGreaterThan(0)
    const recordA = JSON.stringify(attemptA)
    const rowsOfA = [...heldByA].map(status)
    // A row A does not hold, for the sync item to spend.
    const [spare] = extraRows(1)
    expect(heldByA.has(spare)).toBe(false)
    const item = await syncSpendOf(spare)
    expect(status(spare)).toBe('available')
    let nativeSigned = false
    sign.mockClear()

    const [native, synced] = await Promise.all([
      alice.sendNative({
        recipient: f.bob.identity.address,
        value: 1_000n,
        onSigned: async () => void (nativeSigned = true),
      }),
      applyWalletSyncItem(alice, item),
    ])

    // Both finished, and the relay still has not answered A.
    expect(a.seen.settled).toBe(false)
    expect(relayBodies).toHaveLength(1)
    expect(native.txHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(nativeSigned).toBe(true)
    expect(providerBroadcasts).toHaveLength(1)
    expect(synced).toEqual({ affectedIndices: [spare] })
    expect(status(spare)).toBe('spent')
    // Disjoint inputs: the native send spent from no account A's payments spend from, the sync
    // spend consumed a row A does not hold, and neither moved A's rows or its record.
    expect(sendersOfA).not.toContain(providerBroadcasts[0].from)
    expect(sendersOfA).not.toContain(alice.pool.getRecord(spare)!.address.toLowerCase())
    expect(heldIndices()).toEqual(heldByA)
    expect([...heldByA].map(status)).toEqual(rowsOfA)
    expect(JSON.stringify(journal().getAll()[0])).toBe(recordA)
    // Nothing of A's was signed again while its request was in flight.
    expect(sign).not.toHaveBeenCalled()
    expect(counts()).toMatchObject({ intents: 0, attempts: 1, relayRequests: 1, paymentSets: 1 })

    hold.release('delivered')
    await a.done

    expect(a.seen.value?.error).toBeUndefined()
    expect(a.seen.value?.result).toBeDefined()
    expect(bobInbox).toHaveLength(1)
    expect(providerBroadcasts).toHaveLength(1)
    expect(counts()).toMatchObject({ intents: 0, attempts: 0, relayRequests: 1, paymentSets: 1 })
  })

  // PIN, contract row 0.2 - Stage 2 of #1236 inverts this: with A's relay request unanswered inside
  // a `reconcileAttempts` call, a second message's send (which is refused) and a `discardAttempt`
  // do not return until the relay answers. The second message's first effect would be its own
  // replay of A (a relay request); discard's would be a write to the link store.
  it('pin (Stage 2 of #1236 inverts this): with A\'s relay request unanswered inside a reconcile, a second send and a discard do not return until it answers', async () => {
    const { digest } = await pendingA()
    const linkWrites = jest.spyOn(LevelCanonicalLinkStore.prototype, 'put')
    prepareIntent.mockClear()
    const before = counts()
    const hold = f.holdNextRelayRequest()
    const reconcile = watch(
      f.chain.directMessages.reconcileAttempts({ wallet: alice, payloadDigests: [digest] }),
    )
    await hold.entered
    expect(hold.hasEntered()).toBe(true)
    expect(relayBodies).toHaveLength(before.relayRequests + 1)

    const second = watch(send('message B'))
    const discarded = watch(
      f.chain.directMessages.discardAttempt({ wallet: alice, payloadDigest: digest }),
    )
    await turns(10)

    expect(second.seen.settled).toBe(false)
    expect(discarded.seen.settled).toBe(false)
    expect(reconcile.seen.settled).toBe(false)
    // Neither took a step: no further relay request, no intent, no link write.
    expect(relayBodies).toHaveLength(before.relayRequests + 1)
    expect(prepareIntent).not.toHaveBeenCalled()
    expect(linkWrites).not.toHaveBeenCalled()

    hold.release('retained')
    await Promise.all([reconcile.done, second.done, discarded.done])

    expect(reconcile.seen.error).toBeUndefined()
    expect(reconcile.seen.value).toEqual({ [digest]: expect.any(String) })
    // `send` reports its error in its result.
    expect(second.seen.value?.error).toBeInstanceOf(MonadStampPendingAttemptError)
    expect(discarded.seen.error).toBeUndefined()
    expect(counts().intents).toBe(0)
    expect(counts().paymentSets).toBe(1)
  })

  // ---- pins: today's blocking, each inverted by the stage named ----------------------------------------

  // PIN (inverted by Stage 3 of #1236): while A has no outcome, a second paid send is refused with
  // the pending error before it funds anything or creates an intent.
  it('pin (Stage 3): while A is pending a second paid send is refused with the pending error and creates no intent', async () => {
    const { digest } = await pendingA()
    const before = counts()
    const funded = mockFunded.length

    const refused = await send('message B')

    expect(refused.error).toBeInstanceOf(MonadStampPendingAttemptError)
    expect((refused.error as MonadStampPendingAttemptError).payloadHashes).toEqual([digest])
    expect(mockFunded.length).toBe(funded)
    expect(counts()).toEqual({
      ...before,
      // Only A's own bytes were offered to the relay again.
      relayRequests: before.relayRequests + 1,
    })
    expect(counts().intents).toBe(0)
    expect(counts().paymentSets).toBe(1)
  })

  // PIN (inverted by Stage 3): the same refusal holds after a restart.
  it('pin (Stage 3): after a restart with A still pending a second paid send is still refused and creates no intent', async () => {
    const { digest } = await pendingA()
    await reopen()
    const before = counts()
    expect(before).toMatchObject({ intents: 0, attempts: 1 })

    const refused = await send('message B')

    expect(refused.error).toBeInstanceOf(MonadStampPendingAttemptError)
    expect((refused.error as MonadStampPendingAttemptError).payloadHashes).toEqual([digest])
    expect(counts()).toMatchObject({ intents: 0, attempts: 1 })
    expect(new Set(relayBodies.map(r => restoreCanonicalRequest(r).identity.submission_identity)).size).toBe(1)
  })

  // PROOF for #1323 (was a pin of the opposite): an attempt the relay ended is final and no longer
  // refuses later sends. They are delivered from other accounts; A's record and accounts are kept,
  // because its signed payments may still land.
  it('#1323: after the relay ended A, later sends are delivered from other accounts and A keeps its record and its accounts reserved', async () => {
    relayMode = 'ended'
    const ended = await send('message A')
    // The send reports the relay's final answer, not an unresolved attempt.
    expect(ended.error).toBeInstanceOf(CanonicalRecipientUndeliverableError)
    expect(ended.error).not.toBeInstanceOf(MonadStampPendingAttemptError)
    expect(counts()).toMatchObject({ intents: 0, attempts: 1, paymentSets: 1 })
    const recordA = journal().getAll()[0]
    const bytesA = JSON.stringify(recordA)
    const heldByA = heldIndices()
    expect(heldByA.size).toBeGreaterThan(0)
    const addressesOfA = [...heldByA].map(index =>
      alice.pool.getRecord(index)!.address.toLowerCase(),
    )
    sign.mockClear()
    const funded = mockFunded.length

    relayMode = 'fixture'
    f.setPhase('delivered')
    for (const text of ['message B', 'message C']) {
      const later = await send(text)
      expect(later.error).toBeUndefined()
    }

    // One intent and one payment set for each of B and C, both delivered. Their finished records
    // stay in the journal behind A, which is the only one not cleaned up.
    expect(prepareIntent).toHaveBeenCalledTimes(3)
    expect(counts()).toMatchObject({ intents: 0, attempts: 3, paymentSets: 3 })
    expect(bobInbox).toHaveLength(2)
    expect(mockFunded.length).toBeGreaterThan(funded)
    expect(sign).toHaveBeenCalled()
    const finished = journal()
      .getAll()
      .filter(attempt => attempt.attemptRef !== recordA.attemptRef)
    expect(finished).toHaveLength(2)
    for (const attempt of finished) expect(attempt.cleanupComplete).toBe(true)
    // B and C spend from accounts disjoint from A's and from each other's.
    const laterIndices = finished.flatMap(attempt =>
      attempt.reservations.map(r => r.index),
    )
    expect(new Set(laterIndices).size).toBe(laterIndices.length)
    for (const index of laterIndices) expect(heldByA.has(index)).toBe(false)
    expect(heldIndices()).toEqual(new Set([...heldByA, ...laterIndices]))
    for (const request of relayBodies.slice(1))
      for (const raw of restoreCanonicalRequest(request).parts.transactions)
        expect(addressesOfA).not.toContain(
          Transaction.from(hexlify(raw)).from!.toLowerCase(),
        )
    // A is exactly as it was: same record, not cleaned up, its accounts still in-use, and its
    // bytes were handed to the relay once.
    expect(
      JSON.stringify(
        journal()
          .getAll()
          .find(attempt => attempt.attemptRef === recordA.attemptRef),
      ),
    ).toBe(bytesA)
    expect(recordA.cleanupComplete).toBe(false)
    for (const index of heldByA) expect(status(index)).toBe('in-use')
    const identityOfA = restoreCanonicalRequest(relayBodies[0]).identity
      .submission_identity
    expect(
      relayBodies.filter(
        request =>
          restoreCanonicalRequest(request).identity.submission_identity ===
          identityOfA,
      ),
    ).toHaveLength(1)
  })
})
