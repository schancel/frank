/**
 * #1323 item 1: a paid message the relay has ended gets a final status and stops holding every
 * later paid message of the wallet. Its signed payment set and its reserved accounts are kept.
 *
 * The relay ends an attempt only by answering the exact payment set with `200` and
 * `{ phase: 'dead', reason }` (`canonical-dm-transport.ts`, `CANONICAL_TERMINAL_REASONS`). The
 * stamp client records that answer in the wallet's journal; `settle` then saves the final status
 * `dead` and the reason on the message's link. Nothing else may produce that status: a timeout, a
 * network error or an HTTP error leaves the attempt unresolved and blocking, exactly as before.
 *
 * Real typed custody, real Level journals, the real link store, real directory admission, real
 * sealing and real stamp funding, from the shared two-wallet fixture
 * (`canonical-two-wallets.testutil.ts`); only the chain RPC, the chain HTTP client and the message
 * relay's HTTP surface are stand-ins. Each test names what it reproduces on the revision before
 * the fix; tests labelled "pin" pass on both and guard what the fix must not loosen.
 */
// First: the mock factories below load this file while the wallet modules are still loading.
import {
  fixture,
  mailboxes,
  mockBalances,
  mockFunded,
  type Fixture,
  type InboxRecord,
} from './canonical-two-wallets.testutil'
import { Transaction, getBytes, hexlify } from 'ethers'
import { toHex } from '@frank/codec'
import {
  CANONICAL_TERMINAL_REASONS,
  restoreCanonicalRequest,
  type CanonicalTerminalReason,
} from '@frank/cashweb/relay/canonical-dm-transport'
import domainVectors from '../../domain-roots/vectors/domain-roots-v1.json'
import type { MonadRootBundle } from '../monad-wallet-material'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import {
  MonadCanonicalStampClient,
  MonadStampPendingAttemptError,
  MonadStampTerminalError,
} from '../monad-stamp-client'
import { LevelCanonicalStampAttemptJournal } from '../storage/stamp-attempt-journal'
import { isDirectMessageNotAttempted } from './active-chain'
import {
  CanonicalRecipientUndeliverableError,
  CanonicalSenderUnpublishedError,
  LevelCanonicalLinkStore,
  type CanonicalDirectory,
} from './monad-canonical-dm'
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

/** What the tests read off the stamp client; the client keeps these private. */
interface ClientInternals {
  journal: {
    getIntents(): { attemptRef: string }[]
    getAll(): {
      attemptRef: string
      reservations: { id: string; index: number }[]
      terminal: { phase: string; reason?: string } | null
      cleanupComplete: boolean
      acknowledged: boolean
    }[]
  }
}

/** How the message relay answers a payment set. `fixture` is the shared fixture's own answer
 * (delivered or retained, by `f.setPhase`); the others are this suite's. */
type RelayMode =
  | { kind: 'fixture' }
  | { kind: 'ended'; reason: CanonicalTerminalReason }
  | { kind: 'network-error' }
  | { kind: 'timeout' }
  | { kind: 'http'; status: number; body: string }

describe('a paid message the relay has ended (#1323)', () => {
  jest.setTimeout(120_000)
  let f: Fixture
  let alice: EvmChainWalletHandle
  let directory: CanonicalDirectory
  let bobInbox: InboxRecord[]
  /** Every payment-set body the message relay was handed, in any mode, in order. */
  let relayBodies: { body: Uint8Array; contentType: string }[]
  let relayMode: RelayMode
  let prepareIntent: jest.SpyInstance
  /** Where each wallet's link store was opened, in order; Alice's is the first. */
  let linkLocations: string[]

  beforeEach(async () => {
    mockBalances.clear()
    mockFunded.length = 0
    mailboxes.clear()
    relayBodies = []
    relayMode = { kind: 'fixture' }
    linkLocations = []
    const open = LevelCanonicalLinkStore.open.bind(LevelCanonicalLinkStore)
    jest
      .spyOn(LevelCanonicalLinkStore, 'open')
      .mockImplementation(async location => {
        linkLocations.push(location)
        return open(location)
      })
    f = await fixture()
    alice = f.alice
    const base = await f.directoryFor('alice', f.alice, f.bob)
    const respond = (status: number, url: string, text: string) => {
      const answer = new TextEncoder().encode(text)
      let read = false
      return {
        status,
        url,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-type' ? 'application/json' : null,
        },
        body: {
          getReader: () => ({
            read: async () =>
              read
                ? { done: true as const }
                : ((read = true), { done: false as const, value: answer }),
            cancel: async () => undefined,
            releaseLock: () => undefined,
          }),
        },
      }
    }
    directory = {
      ...base,
      fetch: async (url, init) => {
        const request = {
          body: new Uint8Array(init.body!),
          contentType: init.headers['Content-Type'],
        }
        relayBodies.push(request)
        const mode = relayMode
        if (mode.kind === 'fixture') return base.fetch!(url, init)
        if (mode.kind === 'network-error') throw new TypeError('fetch failed')
        if (mode.kind === 'timeout')
          throw Object.assign(new Error('The operation was aborted'), {
            name: 'AbortError',
          })
        if (mode.kind === 'http') return respond(mode.status, url, mode.body)
        // The relay's terminal answer: 200, the exact identity echoed, phase dead and a reason.
        return respond(
          200,
          url,
          JSON.stringify({
            version: 1,
            phase: 'dead',
            identity: restoreCanonicalRequest(request).identity,
            reason: mode.reason,
          }),
        )
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
    f.setPhase('delivered')
    prepareIntent = jest.spyOn(
      MonadCanonicalStampClient.prototype,
      'prepareIntent',
    )
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await alice.close().catch(() => undefined)
    await f.close().catch(() => undefined)
  })

  // ---- helpers ---------------------------------------------------------------------------------

  /** Closes the file-backed wallet and opens it again from its storage: a real restart. `between`
   * runs while it is closed. */
  async function reopen(between?: () => Promise<void>) {
    await alice.close()
    await between?.()
    alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    installCanonicalDirectory(alice, directory)
  }
  const journal = () =>
    (canonicalMonadStampClient(alice) as unknown as ClientInternals).journal
  const recordOf = (attemptRef: string) =>
    journal()
      .getAll()
      .find(attempt => attempt.attemptRef === attemptRef)
  /** One journal record as the bytes a restart would read back. */
  const recordBytes = (attemptRef: string) => JSON.stringify(recordOf(attemptRef))
  const status = (index: number) => alice.pool.getRecord(index)!.status
  const identityOf = (request: { body: Uint8Array; contentType: string }) =>
    restoreCanonicalRequest(request).identity.submission_identity
  /** The accounts each payment set handed to the relay spends from, by payment set. */
  function sendersBySet() {
    const senders = new Map<string, string[]>()
    for (const request of relayBodies) {
      const restored = restoreCanonicalRequest(request)
      senders.set(
        restored.identity.submission_identity,
        restored.parts.transactions.map(raw =>
          Transaction.from(hexlify(raw)).from!.toLowerCase(),
        ),
      )
    }
    return senders
  }
  const reconcile = (digest: string) =>
    f.chain.directMessages
      .reconcileAttempts({ wallet: alice, payloadDigests: [digest] })
      .then(statuses => statuses[digest])

  /** One `send` from Alice to Bob and what it did. */
  async function send(text: string) {
    let error: unknown
    let digest = ''
    let result:
      | Awaited<ReturnType<typeof f.chain.directMessages.send>>
      | undefined
    try {
      result = await f.chain.directMessages.send({
        wallet: alice,
        recipient: f.bob.identity.address,
        items: [{ type: 'text', text }],
        onAttemptCreated: created => void (digest = created),
      })
    } catch (caught) {
      error = caught
    }
    return { result, error, digest }
  }

  /** Message A, answered by the relay in `mode`. Returns what the wallet holds for it. */
  async function messageA(mode: RelayMode) {
    relayMode = mode
    const sent = await send('message A')
    relayMode = { kind: 'fixture' }
    expect(sent.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(journal().getAll()).toHaveLength(1)
    const attempt = journal().getAll()[0]
    const indices = attempt.reservations.map(r => r.index)
    expect(indices.length).toBeGreaterThan(0)
    expect(relayBodies).toHaveLength(1)
    return {
      ...sent,
      attemptRef: attempt.attemptRef,
      indices,
      addresses: indices.map(index =>
        alice.pool.getRecord(index)!.address.toLowerCase(),
      ),
      identity: identityOf(relayBodies[0]),
      bytes: recordBytes(attempt.attemptRef),
    }
  }
  type A = Awaited<ReturnType<typeof messageA>>

  /** A is exactly as it was: same journal record, not cleaned up, its accounts still held, and
   * its bytes were handed to the relay `offered` times in all. */
  function expectAKept(a: A, offered = 1) {
    expect(recordBytes(a.attemptRef)).toBe(a.bytes)
    expect(recordOf(a.attemptRef)).toMatchObject({
      cleanupComplete: false,
      acknowledged: false,
    })
    for (const index of a.indices) expect(status(index)).toBe('in-use')
    expect(relayBodies.filter(r => identityOf(r) === a.identity)).toHaveLength(
      offered,
    )
  }

  /** A later message is sent and delivered on accounts A does not hold. */
  async function expectLaterMessageDelivered(a: A, text: string) {
    const prepared = prepareIntent.mock.calls.length
    const sets = sendersBySet().size
    const delivered = bobInbox.length
    const later = await send(text)

    expect(later.error).toBeUndefined()
    expect(later.result?.payloadDigest).toBe(later.digest)
    expect(later.digest).not.toBe(a.digest)
    // Exactly one new intent and one new payment set, delivered once.
    expect(prepareIntent.mock.calls.length).toBe(prepared + 1)
    expect(sendersBySet().size).toBe(sets + 1)
    expect(bobInbox).toHaveLength(delivered + 1)
    const own = sendersBySet().get(identityOf(relayBodies[relayBodies.length - 1]))!
    expect(own.length).toBeGreaterThan(0)
    for (const sender of own) expect(a.addresses).not.toContain(sender)
    // The later message is finished: delivered, cleaned up and acknowledged. The journal drops
    // finished records only in order, so it stays held behind A; A is the only open record.
    expect(journal().getIntents()).toHaveLength(0)
    for (const record of journal().getAll())
      if (record.attemptRef !== a.attemptRef)
        expect(record).toMatchObject({
          terminal: { phase: 'delivered' },
          cleanupComplete: true,
          acknowledged: true,
        })
    expect(journal().getAll()).toHaveLength(sets + 1)
    expect(await reconcile(later.digest)).toBe('delivered')
    return later
  }

  /** The stored link row of A, read from disk through the real store; the wallet is closed. */
  async function rewriteStoredLink(
    a: A,
    change: (row: Record<string, unknown>) => Record<string, unknown>,
  ) {
    const store = await LevelCanonicalLinkStore.open(linkLocations[0])
    try {
      const row = store.all().find(r => r.attemptRef === a.attemptRef)
      if (!row) throw new Error('expected the stored link')
      await store.put(change({ ...row }) as never)
    } finally {
      await store.close()
    }
  }
  async function storedLink(a: A): Promise<Record<string, unknown>> {
    const store = await LevelCanonicalLinkStore.open(linkLocations[0])
    try {
      return {
        ...store.all().find(r => r.attemptRef === a.attemptRef),
      } as Record<string, unknown>
    } finally {
      await store.close()
    }
  }

  // ---- the fix -----------------------------------------------------------------------------------

  // On the revision before the fix, for every reason: A's own send reports the pending error, A
  // reads `live` on every reconcile, and B and C are refused with the pending error for good.
  it.each(CANONICAL_TERMINAL_REASONS.map(reason => [reason]))(
    'relay answer dead/%s: A is final, later messages are delivered from other accounts, and A keeps its record and accounts',
    async reason => {
      const a = await messageA({ kind: 'ended', reason })

      // The send that was ended reports the relay's answer, not a pending attempt, and is never
      // labelled as not attempted: it created a payment set.
      expect(a.error).toBeInstanceOf(MonadStampTerminalError)
      expect(a.error).not.toBeInstanceOf(MonadStampPendingAttemptError)
      expect(isDirectMessageNotAttempted(a.error)).toBe(false)
      if (reason === 'undeliverable')
        expect(a.error).toBeInstanceOf(CanonicalRecipientUndeliverableError)
      else if (reason === 'sender_unpublished')
        expect(a.error).toBeInstanceOf(CanonicalSenderUnpublishedError)
      else {
        expect((a.error as Error).message).toContain(reason)
        expect((a.error as MonadStampTerminalError).detail).toBe(reason)
      }
      expect(recordOf(a.attemptRef)!.terminal).toMatchObject({
        phase: 'dead',
        reason,
      })
      expect(await reconcile(a.digest)).toBe('dead')
      expectAKept(a)
      // No message accounts for A here, so it is still reported as a payment nobody points at.
      expect(
        await f.chain.directMessages.unattributedAttempts({
          wallet: alice,
          knownDigests: [],
        }),
      ).toEqual([a.digest])

      // Two more messages in the same session: the second is sent while the first one's finished
      // record is still held in the journal behind A.
      await expectLaterMessageDelivered(a, 'message B')
      expectAKept(a)
      await expectLaterMessageDelivered(a, 'message B2')
      expectAKept(a)
      // Reconciling an ended attempt asks the relay nothing more about it.
      for (let pass = 0; pass < 2; pass++)
        expect(await reconcile(a.digest)).toBe('dead')
      expectAKept(a)

      // After a restart the final status is read back, and sending still works.
      await reopen()
      expect(await storedLinkWhileOpen(a)).toMatchObject({
        outcome: 'dead',
        reason,
      })
      expect(await reconcile(a.digest)).toBe('dead')
      expectAKept(a)
      await expectLaterMessageDelivered(a, 'message C')
      expectAKept(a)
      expect(await reconcile(a.digest)).toBe('dead')
    },
  )
  /** A's link as the open wallet's store holds it (the store reads the disk once, at open). */
  async function storedLinkWhileOpen(a: A) {
    let row: Record<string, unknown> = {}
    await reopen(async () => {
      row = await storedLink(a)
    })
    return row
  }

  // A wallet that is stuck today holds exactly this row: the relay's reason and no outcome, written
  // by the previous code. The second row is a stop between the journal's terminal record and the
  // link write. On the revision before the fix both keep refusing message B with the pending error.
  it.each([
    [
      'the relay reason and no outcome, as the previous code wrote it',
      (row: Record<string, unknown>) => {
        delete row.outcome
        return row
      },
    ],
    [
      'neither reason nor outcome, as a stop before the link write leaves it',
      (row: Record<string, unknown>) => {
        delete row.outcome
        delete row.reason
        return row
      },
    ],
  ])(
    'a stored link with %s reads as ended and does not block',
    async (_name, change) => {
      const a = await messageA({ kind: 'ended', reason: 'expired' })
      await reopen(() => rewriteStoredLink(a, change))
      let stale: Record<string, unknown> = {}
      await reopen(async () => {
        stale = await storedLink(a)
      })
      expect(stale).not.toHaveProperty('outcome')

      // The very next send completes the row from the journal's terminal record and proceeds.
      await expectLaterMessageDelivered(a, 'message B')
      expect(await reconcile(a.digest)).toBe('dead')
      expectAKept(a)
      expect(await storedLinkWhileOpen(a)).toMatchObject({
        outcome: 'dead',
        reason: 'expired',
      })
      expectAKept(a)
    },
  )

  // A stop between the journal's acknowledgement of a delivered message and the link write that
  // records it. Before the fix this state could not exist with an older attempt kept; with it, the
  // next settle must finish the link instead of holding the wallet.
  it('finishes the link of a message delivered after an ended one when the wallet stopped before saving it', async () => {
    const a = await messageA({ kind: 'ended', reason: 'undeliverable' })
    const b = await expectLaterMessageDelivered(a, 'message B')
    const bRef = journal()
      .getAll()
      .find(record => record.attemptRef !== a.attemptRef)!.attemptRef
    await reopen(() =>
      rewriteStoredLink({ ...a, attemptRef: bRef }, row => {
        expect(row).toMatchObject({ outcome: 'delivered', acknowledged: true })
        delete row.acknowledged
        return row
      }),
    )

    expect(await reconcile(b.digest)).toBe('delivered')
    expect(await reconcile(a.digest)).toBe('dead')
    await expectLaterMessageDelivered(a, 'message C')
    expectAKept(a)
    // Nothing was handed to the relay again for B.
    expect(sendersBySet().size).toBe(3)
    expect(relayBodies).toHaveLength(3)
  })

  // The new steady state: every message delivered after an ended one stays in the journal behind
  // it until the ended attempt is resolved. This pins what that costs a later send, as counts and
  // not as time: one relay request, for its own payment set, and a number of journal searches
  // (a search validates the prepared bytes and scans the journal) that does not grow with the
  // finished records held. Before the by-reference lookup, with an ended attempt every settle
  // searched the journal for each held record, so the count grew with every message delivered.
  // The same must hold with no ended attempt, where nothing is held.
  it.each([
    ['one ended attempt and its finished records held', true],
    ['no ended attempt', false],
  ])(
    'with %s, each of 10 sends makes one relay request and the same number of journal searches',
    async (_name, ended) => {
      const a = ended
        ? await messageA({ kind: 'ended', reason: 'expired' })
        : undefined
      const searches = [
        jest.spyOn(LevelCanonicalStampAttemptJournal.prototype, 'lookup'),
        jest.spyOn(LevelCanonicalStampAttemptJournal.prototype, 'lookupIntent'),
      ]
      const searched = () =>
        searches.reduce((sum, spy) => sum + spy.mock.calls.length, 0)
      const perSend: number[] = []
      for (let n = 1; n <= 10; n++) {
        const requests = relayBodies.length
        const before = searched()
        const sent = await send(`message ${n}`)
        expect(sent.error).toBeUndefined()
        perSend.push(searched() - before)
        // Exactly one request, and it carries this message's own payment set.
        expect(relayBodies).toHaveLength(requests + 1)
        expect(
          relayBodies.filter(
            r => identityOf(r) === identityOf(relayBodies[requests]),
          ),
        ).toHaveLength(1)
      }
      expect(bobInbox).toHaveLength(10)
      // Held behind the ended attempt, or dropped as each one finishes.
      expect(journal().getAll()).toHaveLength(ended ? 11 : 0)
      expect(perSend[0]).toBeGreaterThan(0)
      expect(new Set(perSend).size).toBe(1)

      // A reconcile with every finished record held: no request, and no more searches than one
      // per unfinished link.
      const requests = relayBodies.length
      const before = searched()
      if (a) expect(await reconcile(a.digest)).toBe('dead')
      else expect(await reconcile('00'.repeat(32))).toBe('unknown')
      expect(relayBodies).toHaveLength(requests)
      expect(searched() - before).toBeLessThanOrEqual(ended ? 2 : 0)
      expect(new Set(relayBodies.map(identityOf)).size).toBe(relayBodies.length)
      if (a) expectAKept(a)
    },
  )

  // ---- pins: what the fix must not loosen ------------------------------------------------------

  // PIN: with no terminal answer (the relay retained the set and has not decided), A still blocks.
  it('pin: an attempt with no terminal answer still refuses later sends, before and after a restart', async () => {
    f.setPhase('retained')
    const a = await messageA({ kind: 'fixture' })
    expect(a.error).toBeInstanceOf(MonadStampPendingAttemptError)
    expect(recordOf(a.attemptRef)!.terminal).toBeNull()

    for (const restart of [false, true]) {
      if (restart) await reopen()
      const funded = mockFunded.length
      const prepared = prepareIntent.mock.calls.length
      const refused = await send('message B')
      expect(refused.error).toBeInstanceOf(MonadStampPendingAttemptError)
      expect(
        (refused.error as MonadStampPendingAttemptError).payloadHashes,
      ).toEqual([a.digest])
      expect(isDirectMessageNotAttempted(refused.error)).toBe(true)
      expect(prepareIntent.mock.calls.length).toBe(prepared)
      expect(mockFunded.length).toBe(funded)
      expect(journal().getIntents()).toHaveLength(0)
      expect(journal().getAll()).toHaveLength(1)
      expect(await reconcile(a.digest)).toBe('live')
      expect(recordOf(a.attemptRef)!.terminal).toBeNull()
    }
    expect(sendersBySet().size).toBe(1)
  })

  // PIN: the dangerous mistake. A request that failed, timed out or was answered with an HTTP
  // error is not the relay ending the attempt: the set may have been accepted and broadcast.
  it.each<[string, RelayMode]>([
    ['a network error', { kind: 'network-error' }],
    ['a timeout', { kind: 'timeout' }],
    ['a 503', { kind: 'http', status: 503, body: 'upstream unavailable' }],
    [
      'a 500 carrying a dead body',
      {
        kind: 'http',
        status: 500,
        body: JSON.stringify({ version: 1, phase: 'dead', reason: 'expired' }),
      },
    ],
    [
      'a 422 mailbox_terminal error body',
      {
        kind: 'http',
        status: 422,
        body: JSON.stringify({ error: 'mailbox_terminal' }),
      },
    ],
    [
      'a 200 dead answer with an unknown reason',
      {
        kind: 'http',
        status: 200,
        body: JSON.stringify({ version: 1, phase: 'dead', reason: 'gave_up' }),
      },
    ],
  ])(
    'pin: %s is not treated as ended; the attempt stays live and keeps refusing later sends',
    async (_name, mode) => {
      const a = await messageA(mode)
      expect(a.error).toBeInstanceOf(MonadStampPendingAttemptError)
      expect(recordOf(a.attemptRef)!.terminal).toBeNull()

      // Still failing the same way: every pass re-offers A's own bytes and learns nothing.
      relayMode = mode
      expect(await reconcile(a.digest)).toBe('live')
      const refused = await send('message B')
      expect(refused.error).toBeInstanceOf(MonadStampPendingAttemptError)
      expect(
        (refused.error as MonadStampPendingAttemptError).payloadHashes,
      ).toEqual([a.digest])
      expect(recordOf(a.attemptRef)!.terminal).toBeNull()
      expect(journal().getIntents()).toHaveLength(0)
      expect(journal().getAll()).toHaveLength(1)
      expect(sendersBySet().size).toBe(1)
      expect(await storedLinkWhileOpen(a)).not.toHaveProperty('outcome')
      relayMode = mode
      expect(await reconcile(a.digest)).toBe('live')
      for (const index of a.indices) expect(status(index)).toBe('in-use')

      // The relay answers at last: the same bytes are delivered, and only then are sends free.
      relayMode = { kind: 'fixture' }
      expect(await reconcile(a.digest)).toBe('delivered')
      expect((await send('message B')).error).toBeUndefined()
    },
  )
})
