/**
 * #1237 Stage W: a caller of the canonical `send` may choose the sealed message ID, so a caller
 * that stopped mid-send can ask "was this ID already attempted?" instead of paying twice or holding
 * the message for good.
 *
 * Real typed custody, real Level journals, the real link store, real directory admission, real
 * sealing/opening and real stamp funding, from the shared two-wallet fixture
 * (`canonical-two-wallets.testutil.ts`); only the chain RPC and the relay's HTTP surface are
 * stand-ins. Every test counts what reached the wallet's payment journal and the relay, not only
 * which error came back. Each test says what unmodified `main` does instead, or that it is a pin.
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
import { getBytes } from 'ethers'
import { toHex } from '@frank/codec'
import { restoreCanonicalRequest } from '@frank/cashweb/relay/canonical-dm-transport'
import {
  allocateOpeningConversationId,
  formatConversationId,
} from '@frank/cashweb/relay/conversation-id'
import { conversationIdSaltOf } from './monad-chain'
import domainVectors from '../../domain-roots/vectors/domain-roots-v1.json'
import type { MonadRootBundle } from '../monad-wallet-material'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import {
  MonadCanonicalStampClient,
  MonadStampPendingAttemptError,
} from '../monad-stamp-client'
import {
  DirectMessageAlreadyAttemptedError,
  DirectMessageArgumentError,
  DirectMessageAttemptUnlinkedError,
  isDirectMessageNotAttempted,
  type DirectMessageClient,
  type DirectMessageSendResult,
} from './active-chain'
import * as chainIndex from './index'
import {
  CanonicalMessagingHoldError,
  CanonicalMessagingPendingError,
  CanonicalRecipientUndeliverableError,
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
/** Set to make the chain accept a funding transfer and then lose its answer. */
const mockFunding = { loseAnswer: false }
jest.mock('../monad-http', () => {
  const offline = require('./canonical-two-wallets.testutil').offlineHttpModule()
  return {
    ...offline,
    MonadHttpClient: class extends offline.MonadHttpClient {
      async submitRawTransaction(raw: string) {
        const hash = await super.submitRawTransaction(raw)
        if (mockFunding.loseAnswer)
          throw new Error('funding broadcast, answer lost')
        return hash
      }
    },
  }
})
jest.mock('@frank/cashweb/relay/monad-mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule(),
)
/** How the next durable write of a message link behaves. The real write runs unless dropped. */
const mockLinkWrite: { mode: 'ok' | 'dropped' | 'written-then-reported-failed' } =
  { mode: 'ok' }
jest.mock('../storage/level-durability', () => {
  const actual = jest.requireActual<
    typeof import('../storage/level-durability')
  >('../storage/level-durability')
  return {
    ...actual,
    durablePut: async (
      ...args: Parameters<typeof actual.durablePut>
    ): Promise<void> => {
      const isLink =
        typeof args[2] === 'string' &&
        args[2].includes('"consumerId":"frank-dm:')
      if (!isLink || mockLinkWrite.mode === 'ok')
        return actual.durablePut(...args)
      const mode = mockLinkWrite.mode
      mockLinkWrite.mode = 'ok'
      if (mode === 'written-then-reported-failed')
        await actual.durablePut(...args)
      throw new Error(`link write ${mode}`)
    },
  }
})

type SendParams = Parameters<DirectMessageClient['send']>[0]
type Extra = Partial<Omit<SendParams, 'wallet'>>

const ID_A = '0a0b0c0d-1a1b-4c1d-8a2b-3a3b3c3d3e3f'
const ID_B = 'ffeeddcc-bbaa-4988-8766-554433221100'
const CONVERSATION = '11111111-2222-4333-8444-555555555555'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const bytesOf = (id: string) => getBytes('0x' + id.replace(/-/g, ''))
const consumerOf = (id: string) => `frank-dm:${id.replace(/-/g, '')}`

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

describe('canonical send with a caller-chosen message ID (#1237 Stage W)', () => {
  jest.setTimeout(60_000)
  let f: Fixture
  let alice: EvmChainWalletHandle
  let directory: CanonicalDirectory
  let uninstall: () => void
  let bobSubject: string
  let bobInbox: InboxRecord[]
  /** Every body the relay was handed, in any relay mode, in order. */
  let relayBodies: { body: Uint8Array; contentType: string }[]
  let relayMode: 'fixture' | 'ended'
  let prepareIntent: jest.SpyInstance
  let openLinks: jest.SpyInstance

  beforeEach(async () => {
    mockBalances.clear()
    mockFunded.length = 0
    mailboxes.clear()
    mockFunding.loseAnswer = false
    mockLinkWrite.mode = 'ok'
    relayBodies = []
    relayMode = 'fixture'
    openLinks = jest.spyOn(LevelCanonicalLinkStore, 'open')
    f = await fixture()
    alice = f.alice
    const base = await f.directoryFor('alice', f.alice, f.bob)
    directory = {
      ...base,
      // Records every request and can end delivery the way a relay does: a terminal answer.
      fetch: async (url, init) => {
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
    uninstall = installCanonicalDirectory(alice, directory)
    installCanonicalDirectory(
      f.bob,
      await f.directoryFor('bob', f.bob, f.alice),
    )
    bobSubject = toHex(f.bob.identity.compressedPubKey)
    bobInbox = []
    mailboxes.set(bobSubject, bobInbox)
    f.setMailbox(bobInbox)
    prepareIntent = jest.spyOn(MonadCanonicalStampClient.prototype, 'prepareIntent')
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await alice.close().catch(() => undefined)
    await f.close().catch(() => undefined)
  })

  /** Closes the file-backed wallet and opens it again from its storage: a real restart. */
  async function reopen(options: { directory?: boolean } = {}) {
    await alice.close()
    alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    if (options.directory !== false)
      uninstall = installCanonicalDirectory(alice, directory)
  }
  /** One entry per record the wallet's payment journal holds: unsigned intents and signed
   * attempts. Read through the stamp client's own correlation, given no links at all. */
  const journal = () =>
    canonicalMonadStampClient(alice).reconcileWorkflowLinks([])
  /** Whether the journal holds a record made for this message ID. */
  const journalHas = (id: string) =>
    canonicalMonadStampClient(alice).hasConsumerRecord(consumerOf(id))
  /** The live wallet's link rows, as its own store holds them. */
  async function links() {
    const address = (await alice.getReceiveAddress()).raw.toLowerCase()
    const index = openLinks.mock.calls
      .map(call => String(call[0]).endsWith(`-evm-${address}`))
      .lastIndexOf(true)
    const store: LevelCanonicalLinkStore = await openLinks.mock.results[index]
      .value
    return store.all()
  }
  /** Distinct payment sets the relay was handed (a re-send of the same set counts once). */
  const paymentSets = () =>
    new Set(
      relayBodies.map(
        request => restoreCanonicalRequest(request).identity.submission_identity,
      ),
    ).size
  /** One `send` from Alice to Bob and what it did. */
  async function attempt(extra: Extra = {}) {
    const before = {
      intents: prepareIntent.mock.calls.length,
      funded: mockFunded.length,
      requests: relayBodies.length,
    }
    let result: DirectMessageSendResult | undefined
    let error: unknown
    try {
      result = await f.chain.directMessages.send({
        wallet: alice,
        recipient: f.bob.identity.address,
        items: [{ type: 'text', text: 'hello' }],
        ...extra,
      })
    } catch (caught) {
      error = caught
    }
    return {
      result,
      error,
      labelled: isDirectMessageNotAttempted(error),
      intents: prepareIntent.mock.calls.length - before.intents,
      funded: mockFunded.length - before.funded,
      requests: relayBodies.length - before.requests,
    }
  }
  const received = () =>
    f.chain.directMessages.fetchSince({ wallet: f.bob, sinceMs: 0 })
  /** The repeat answer: the original attempt, unlabelled, and this call did nothing at all. */
  function expectAlreadyAttempted(
    repeat: Awaited<ReturnType<typeof attempt>>,
    id: string,
    digest: string,
  ) {
    expect(repeat.error).toBeInstanceOf(DirectMessageAlreadyAttemptedError)
    expect(repeat.error).toMatchObject({
      name: 'DirectMessageAlreadyAttemptedError',
      messageId: id,
      payloadDigest: digest,
      recipientSubject: bobSubject,
    })
    expect(repeat.labelled).toBe(false)
    expect(repeat.intents).toBe(0)
    expect(repeat.funded).toBe(0)
    expect(repeat.requests).toBe(0)
  }

  // On main: `send` has no `messageId` parameter, so the recipient sees two random message IDs.
  it('A1: seals exactly the supplied conversation and message IDs, in either accepted form', async () => {
    const first = await attempt({ conversationId: CONVERSATION, messageId: ID_A })
    const second = await attempt({
      conversationId: bytesOf(CONVERSATION),
      messageId: bytesOf(ID_B),
    })
    expect(first.error).toBeUndefined()
    expect(second.error).toBeUndefined()
    const opened = await received()
    expect(
      opened.map(m => [m.payloadDigest, m.conversationId, m.messageId]),
    ).toEqual([
      [first.result!.payloadDigest, CONVERSATION, ID_A],
      [second.result!.payloadDigest, CONVERSATION, ID_B],
    ])
    // The stored links carry those IDs, one link and one payment set each.
    expect((await links()).map(row => [row.digest, row.consumerId])).toEqual([
      [first.result!.payloadDigest, consumerOf(ID_A)],
      [second.result!.payloadDigest, consumerOf(ID_B)],
    ])
    expect(prepareIntent).toHaveBeenCalledTimes(2)
    expect(paymentSets()).toBe(2)
  })

  // On main: the caller's conversation bytes are held by reference until sealing, so a buffer the
  // caller reuses while the send is waiting is sealed with its later content. With a chosen
  // message ID that would let the repeat check and the intent disagree about the ID.
  it('checks and seals the same bytes, whatever the caller does to its buffers during the send', async () => {
    const id = bytesOf(ID_A)
    const conversation = bytesOf(CONVERSATION)
    uninstall()
    uninstall = installCanonicalDirectory(alice, {
      ...directory,
      // The first thing a send awaits after its own checks.
      peerCurrent: async wanted => {
        id.fill(0xee)
        conversation.fill(0xee)
        return directory.peerCurrent(wanted)
      },
    })
    const sent = await attempt({ messageId: id, conversationId: conversation })
    expect(sent.error).toBeUndefined()
    expect(
      (await received()).map(m => [m.conversationId, m.messageId]),
    ).toEqual([[CONVERSATION, ID_A]])
    expect((await links()).map(row => row.consumerId)).toEqual([consumerOf(ID_A)])
    expectAlreadyAttempted(
      await attempt({ messageId: ID_A }),
      ID_A,
      sent.result!.payloadDigest,
    )
  })

  it('carries the conversation subject only on a message that is given one', async () => {
    const opening = await attempt({
      conversationId: CONVERSATION,
      conversationName: 'Weekend plans',
    } as Extra)
    const followUp = await attempt({ conversationId: CONVERSATION })
    expect(opening.error).toBeUndefined()
    expect(followUp.error).toBeUndefined()
    const opened = await received()
    expect(opened.map(m => [m.conversationId, m.conversationName])).toEqual([
      [CONVERSATION, 'Weekend plans'],
      [CONVERSATION, undefined],
    ])
    expect('conversationName' in opened[1]).toBe(false)
  })

  it('a free message carries the same conversation ID and subject a paid one would', async () => {
    const unnamed = await attempt({ stampValue: 0n })
    const named = await attempt({
      stampValue: 0n,
      conversationId: CONVERSATION,
      conversationName: 'Weekend plans',
    } as Extra)
    const followUp = await attempt({
      stampValue: 0n,
      conversationId: CONVERSATION,
    })
    for (const sent of [unnamed, named, followUp])
      expect(sent.error).toBeUndefined()
    const opened = await received()
    // No conversation named: the one this account opens with the recipient, not none at all.
    const openingId = formatConversationId(
      allocateOpeningConversationId(
        conversationIdSaltOf(f.alice)!,
        f.bob.identity.address.raw.toLowerCase(),
      ),
    )
    expect(opened.map(m => [m.conversationId, m.conversationName])).toEqual([
      [openingId, undefined],
      [CONVERSATION, 'Weekend plans'],
      [CONVERSATION, undefined],
    ])
    expect(opened.every(m => m.stampValueWei === 0n)).toBe(true)
  })

  // PIN (A6): a caller that passes no `messageId` behaves as on main.
  it('pin: without a message ID the wallet draws a fresh random one for every send, as before', async () => {
    const journalRead = jest.spyOn(
      MonadCanonicalStampClient.prototype,
      'hasConsumerRecord',
    )
    const first = await attempt()
    const second = await attempt({ conversationId: CONVERSATION })
    expect(first.error).toBeUndefined()
    expect(second.error).toBeUndefined()
    const opened = await received()
    expect(opened).toHaveLength(2)
    for (const message of opened) expect(message.messageId).toMatch(UUID)
    expect(opened[0].messageId).not.toBe(opened[1].messageId)
    // No conversation supplied: the one this account opens with the recipient, allocated
    // from the sender's private salt. Never a new conversation named after the message.
    expect(opened[0].conversationId).not.toBe(opened[0].messageId)
    const senderSalt = conversationIdSaltOf(f.alice)!
    expect(opened[0].conversationId).toBe(
      formatConversationId(
        allocateOpeningConversationId(
          senderSalt,
          f.bob.identity.address.raw.toLowerCase(),
        ),
      ),
    )
    // The recipient's own salt gives a different ID for the same pair: the recipient learns
    // the sender's ID only by receiving it, and no third account can compute it.
    const recipientSalt = conversationIdSaltOf(f.bob)!
    expect(toHex(recipientSalt)).not.toBe(toHex(senderSalt))
    expect(
      formatConversationId(
        allocateOpeningConversationId(
          recipientSalt,
          f.bob.identity.address.raw.toLowerCase(),
        ),
      ),
    ).not.toBe(opened[0].conversationId)
    // A fresh derivation for the same wallet is the same salt, and it is not the root.
    expect(toHex(conversationIdSaltOf(f.alice)!)).toBe(toHex(senderSalt))
    expect(senderSalt).toHaveLength(16)
    expect(opened[1].conversationId).toBe(CONVERSATION)
    expect((await links()).map(row => row.consumerId)).toEqual(
      opened.map(m => consumerOf(m.messageId!)),
    )
    expect(paymentSets()).toBe(2)
    // The repeat rule's journal read is never made for a caller that chose no ID.
    expect(journalRead).not.toHaveBeenCalled()
  })

  // On main: no parameter and no such read. A journal that cannot be read answers nothing about
  // the ID; the call created nothing, so it is refused like any other refusal before the intent.
  it('refuses, labelled and without an intent, when the journal cannot be read for a supplied ID', async () => {
    const unreadable = new Error('journal unreadable')
    const journalRead = jest
      .spyOn(MonadCanonicalStampClient.prototype, 'hasConsumerRecord')
      .mockImplementation(() => {
        throw unreadable
      })
    const refused = await attempt({ messageId: ID_A })
    expect(refused.error).toBe(unreadable)
    expect(refused.labelled).toBe(true)
    expect(refused.intents).toBe(0)
    expect(refused.funded).toBe(0)
    expect(refused.requests).toBe(0)
    journalRead.mockRestore()
    expect(journal()).toHaveLength(0)
    // The same ID is then a first attempt.
    expect((await attempt({ messageId: ID_A })).error).toBeUndefined()
    expect(prepareIntent).toHaveBeenCalledTimes(1)
    expect(paymentSets()).toBe(1)
  })

  // PIN: the label rules existing callers rely on. A refusal before inventory preparation is
  // labelled exactly as on main; so is the same refusal when the caller chose the ID.
  it('pin: a labelled pre-intent refusal still reads true, with or without a message ID', async () => {
    uninstall()
    for (const extra of [{}, { messageId: ID_A }]) {
      const refused = await attempt(extra)
      expect(refused.error).toBeInstanceOf(CanonicalMessagingPendingError)
      expect(refused.labelled).toBe(true)
      expect(refused.intents).toBe(0)
      expect(refused.funded).toBe(0)
      expect(refused.requests).toBe(0)
    }
    expect(journal()).toHaveLength(0)
    // The three new answers never read true, whatever they are asked about.
    for (const error of [
      new DirectMessageArgumentError('messageId'),
      new DirectMessageAlreadyAttemptedError(ID_A, '00', bobSubject),
      new DirectMessageAttemptUnlinkedError(ID_A),
    ])
      expect(isDirectMessageNotAttempted(error)).toBe(false)
    expect(chainIndex.DirectMessageArgumentError).toBe(DirectMessageArgumentError)
    expect(chainIndex.DirectMessageAlreadyAttemptedError).toBe(
      DirectMessageAlreadyAttemptedError,
    )
    expect(chainIndex.DirectMessageAttemptUnlinkedError).toBe(
      DirectMessageAttemptUnlinkedError,
    )
  })

  // On main (A2): a malformed conversation ID is accepted (uppercase, undashed, stray dashes) or
  // silently dropped so the message is sealed as a new root (non-hex, wrong length), after
  // funding; a malformed message ID is not looked at. Each of these sends pays on main.
  it('A2: refuses every malformed supplied ID as a permanent, unlabelled argument error and does nothing', async () => {
    const hex = ID_A.replace(/-/g, '')
    const malformed: [string, unknown][] = [
      ['uppercase', ID_A.toUpperCase()],
      ['one uppercase digit', ID_A.replace('a', 'A')],
      ['undashed', hex],
      ['undashed uppercase', hex.toUpperCase()],
      ['dashes misplaced', `${hex.slice(0, 4)}-${hex.slice(4, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`],
      ['stray dashes around 32 hex digits', `-${hex}-`],
      ['dashes between every byte', hex.match(/../g)!.join('-')],
      ['32 non-hex characters', 'z'.repeat(32)],
      ['dashed shape with a non-hex character', ID_A.replace('0', 'g')],
      ['one character short', ID_A.slice(1)],
      ['one character long', ID_A + '0'],
      ['trailing newline', ID_A + '\n'],
      ['leading space', ' ' + ID_A],
      ['0x prefix', '0x' + hex],
      ['empty string', ''],
      ['15 bytes', new Uint8Array(15)],
      ['17 bytes', new Uint8Array(17)],
      ['no bytes', new Uint8Array(0)],
      ['null', null],
      ['a number', 7],
      ['an array of 16 numbers', Array.from(new Uint8Array(16))],
      ['16 two-byte elements', new Uint16Array(16)],
    ]
    for (const argument of ['messageId', 'conversationId'] as const)
      for (const [shape, value] of malformed) {
        const refused = await attempt({ [argument]: value } as Extra)
        const where = `${argument}: ${shape}`
        expect([where, refused.error]).toEqual([
          where,
          expect.any(DirectMessageArgumentError),
        ])
        expect(refused.error).toMatchObject({
          name: 'DirectMessageArgumentError',
          argument,
        })
        expect([where, refused.labelled]).toEqual([where, false])
        expect(refused.intents).toBe(0)
        expect(refused.funded).toBe(0)
        expect(refused.requests).toBe(0)
      }
    expect(journal()).toHaveLength(0)
    expect(await links()).toHaveLength(0)
    expect(await received()).toHaveLength(0)
    // It is refused before anything else is looked at: also with no directory installed, where a
    // well-formed call gets the labelled "not available yet" refusal.
    uninstall()
    const first = await attempt({ messageId: ID_A.toUpperCase() })
    expect(first.error).toBeInstanceOf(DirectMessageArgumentError)
    expect(first.labelled).toBe(false)
    // And the valid ID next to a malformed one is not consumed by the refusal.
    uninstall = installCanonicalDirectory(alice, directory)
    const mixed = await attempt({ messageId: ID_A, conversationId: 'z'.repeat(32) })
    expect(mixed.error).toMatchObject({ argument: 'conversationId' })
    const sent = await attempt({ messageId: ID_A })
    expect(sent.error).toBeUndefined()
    expect((await links()).map(row => row.consumerId)).toEqual([consumerOf(ID_A)])
    expect(prepareIntent).toHaveBeenCalledTimes(1)
  })

  // On main (A4): the second call draws a new random ID and pays for the message a second time.
  it('A4: answers a repeat of a delivered ID with the original attempt, before the directory is consulted', async () => {
    const first = await attempt({ messageId: ID_A, conversationId: CONVERSATION })
    expect(first.error).toBeUndefined()
    const digest = first.result!.payloadDigest
    expect(paymentSets()).toBe(1)

    expectAlreadyAttempted(await attempt({ messageId: ID_A }), ID_A, digest)
    // The bytes form names the same ID.
    expectAlreadyAttempted(
      await attempt({ messageId: bytesOf(ID_A) }),
      ID_A,
      digest,
    )
    // Different content and conversation: the wallet compares neither and refuses the same way.
    expectAlreadyAttempted(
      await attempt({
        messageId: ID_A,
        conversationId: ID_B,
        items: [{ type: 'text', text: 'something else entirely' }],
      }),
      ID_A,
      digest,
    )
    // A different recipient, one with no directory entry at all: still the ORIGINAL recipient's
    // subject, and no recipient lookup happened (that would refuse "not published").
    expectAlreadyAttempted(
      await attempt({
        messageId: ID_A,
        recipient: { raw: '0x00000000000000000000000000000000000000aa' },
      }),
      ID_A,
      digest,
    )
    // Ordering: with the directory gone a send without the ID is refused "not available yet";
    // the repeat is still answered, so its check ran first.
    uninstall()
    const unavailable = await attempt()
    expect(unavailable.error).toBeInstanceOf(CanonicalMessagingPendingError)
    expect(unavailable.labelled).toBe(true)
    expectAlreadyAttempted(await attempt({ messageId: ID_A }), ID_A, digest)
    // After a restart, with no directory installed at all, the answer is the same.
    await reopen({ directory: false })
    expectAlreadyAttempted(await attempt({ messageId: ID_A }), ID_A, digest)

    expect(prepareIntent).toHaveBeenCalledTimes(1)
    expect(paymentSets()).toBe(1)
    expect((await links()).map(row => row.consumerId)).toEqual([consumerOf(ID_A)])
    expect((await received()).map(m => m.messageId)).toEqual([ID_A])
    // Another ID is a different message and is sent.
    uninstall = installCanonicalDirectory(alice, directory)
    expect((await attempt({ messageId: ID_B })).error).toBeUndefined()
    expect(paymentSets()).toBe(2)
  })

  // On main (A4): no parameter; a second call for the message would wait behind the ended
  // attempt under a new ID and pay again once it clears.
  it('A4: answers a repeat of an ID whose attempt the relay ended, creating nothing', async () => {
    relayMode = 'ended'
    let digest: string | undefined
    const first = await attempt({
      messageId: ID_A,
      onAttemptCreated: value => void (digest = value),
    })
    // The send reports the relay's final answer, and the link holds the final status (#1323).
    expect(first.error).toBeInstanceOf(CanonicalRecipientUndeliverableError)
    expect(first.labelled).toBe(false)
    expect(first.intents).toBe(1)
    expect(journalHas(ID_A)).toBe(true)
    expect((await links())[0]).toMatchObject({
      outcome: 'dead',
      reason: 'undeliverable',
    })

    expectAlreadyAttempted(await attempt({ messageId: ID_A }), ID_A, digest!)
    await reopen()
    expectAlreadyAttempted(await attempt({ messageId: ID_A }), ID_A, digest!)
    expect(journal()).toHaveLength(1)
    expect(prepareIntent).toHaveBeenCalledTimes(1)
    expect(paymentSets()).toBe(1)
  })

  describe('what a later send with the same ID returns after the first stopped at each point', () => {
    // Row 1. On main: no parameter. Invariant: never "already attempted" when the first call
    // created nothing durable.
    it('row 1, ID validated and nothing durable: the repeat is the first attempt', async () => {
      uninstall()
      const first = await attempt({ messageId: ID_A })
      expect(first.error).toBeInstanceOf(CanonicalMessagingPendingError)
      expect(first.labelled).toBe(true)
      expect(journal()).toHaveLength(0)
      await reopen()
      expect(journal()).toHaveLength(0)
      expect(await links()).toHaveLength(0)

      const second = await attempt({ messageId: ID_A })
      expect(second.error).toBeUndefined()
      expect(second.intents).toBe(1)
      expect((await received()).map(m => m.messageId)).toEqual([ID_A])
      expect(paymentSets()).toBe(1)
      expectAlreadyAttempted(
        await attempt({ messageId: ID_A }),
        ID_A,
        second.result!.payloadDigest,
      )
    })

    // Row 2. On main: no parameter. Funding moved the wallet's own money between its own
    // accounts and paid no one; no intent exists, so the repeat must not be "already attempted".
    it('row 2, inventory funding was broadcast and then threw: no intent, and the repeat is the first attempt', async () => {
      mockFunding.loseAnswer = true
      const first = await attempt({ messageId: ID_A })
      mockFunding.loseAnswer = false
      expect(first.error).toBeDefined()
      expect(first.error).not.toBeInstanceOf(DirectMessageAlreadyAttemptedError)
      expect(first.labelled).toBe(false)
      expect(first.funded).toBeGreaterThan(0)
      expect(first.intents).toBe(0)
      expect(first.requests).toBe(0)
      expect(journal()).toHaveLength(0)
      await reopen()
      expect(journal()).toHaveLength(0)
      expect(await links()).toHaveLength(0)

      const second = await attempt({ messageId: ID_A })
      expect(second.error).not.toBeInstanceOf(DirectMessageAlreadyAttemptedError)
      expect(second.error).not.toBeInstanceOf(DirectMessageAttemptUnlinkedError)
      expect(second.error).toBeUndefined()
      expect(prepareIntent).toHaveBeenCalledTimes(1)
      expect(paymentSets()).toBe(1)
      expect((await received()).map(m => m.messageId)).toEqual([ID_A])
    })

    // Row 3 (A5 as amended by 19.1 rule 4; the power-loss model). On main: no parameter; a
    // repeat draws a new ID and gets the generic labelled hold, which a consumer retries for ever.
    it('row 3, intent durable and the link never written: the distinct unlinked answer, never a second intent', async () => {
      mockLinkWrite.mode = 'dropped'
      const onAttemptCreated = jest.fn()
      const first = await attempt({ messageId: ID_A, onAttemptCreated })
      expect(first.error).toEqual(new Error('link write dropped'))
      expect(first.labelled).toBe(false)
      expect(first.intents).toBe(1)
      expect(first.requests).toBe(0)
      expect(onAttemptCreated).not.toHaveBeenCalled()
      expect(journalHas(ID_A)).toBe(true)
      expect(await links()).toHaveLength(0)

      const expectUnlinked = (repeat: Awaited<ReturnType<typeof attempt>>) => {
        expect(repeat.error).toBeInstanceOf(DirectMessageAttemptUnlinkedError)
        expect(repeat.error).toMatchObject({
          name: 'DirectMessageAttemptUnlinkedError',
          messageId: ID_A,
        })
        expect(repeat.labelled).toBe(false)
        expect(repeat.intents).toBe(0)
        expect(repeat.funded).toBe(0)
        expect(repeat.requests).toBe(0)
      }
      // In the same session, and after a real restart.
      expectUnlinked(await attempt({ messageId: ID_A }))
      await reopen()
      expect(await links()).toHaveLength(0)
      expectUnlinked(await attempt({ messageId: ID_A }))
      expectUnlinked(await attempt({ messageId: bytesOf(ID_A) }))
      // Answered before the directory, like the repeat rule.
      uninstall()
      expectUnlinked(await attempt({ messageId: ID_A }))
      uninstall = installCanonicalDirectory(alice, directory)

      // Pin: every other send is still held by the existing wallet-wide hold, labelled as before.
      for (const extra of [{}, { messageId: ID_B }]) {
        const held = await attempt(extra)
        expect(held.error).toBeInstanceOf(CanonicalMessagingHoldError)
        expect(held.labelled).toBe(true)
        expect(held.intents).toBe(0)
      }
      expect(journal()).toHaveLength(1)
      expect(journalHas(ID_A)).toBe(true)
      expect(prepareIntent).toHaveBeenCalledTimes(1)
      expect(relayBodies).toHaveLength(0)
      expect(await received()).toHaveLength(0)
    })

    // Row 4. On main: no parameter; the repeat draws a new ID, and after the restart heals the
    // first attempt and it delivers, a caller that sent again has paid twice.
    it('row 4, link written durably but its write reported an error: never a second intent, and the original after a restart', async () => {
      mockLinkWrite.mode = 'written-then-reported-failed'
      const first = await attempt({ messageId: ID_A })
      expect(first.error).toEqual(
        new Error('link write written-then-reported-failed'),
      )
      expect(first.labelled).toBe(false)
      expect(first.intents).toBe(1)
      expect(first.requests).toBe(0)
      expect(journalHas(ID_A)).toBe(true)

      // This session never learned the link is there: it reports the record as unlinked.
      const sameSession = await attempt({ messageId: ID_A })
      expect(sameSession.error).toBeInstanceOf(DirectMessageAttemptUnlinkedError)
      expect(sameSession.labelled).toBe(false)
      expect(sameSession.intents).toBe(0)

      await reopen()
      const stored = await links()
      expect(stored.map(row => row.consumerId)).toEqual([consumerOf(ID_A)])
      const digest = stored[0].digest
      expectAlreadyAttempted(await attempt({ messageId: ID_A }), ID_A, digest)
      // Reconciling the returned digest finishes and delivers the ORIGINAL attempt.
      expect(
        await f.chain.directMessages.reconcileAttempts({
          wallet: alice,
          payloadDigests: [digest],
        }),
      ).toEqual({ [digest]: 'delivered' })
      expectAlreadyAttempted(await attempt({ messageId: ID_A }), ID_A, digest)
      expect(prepareIntent).toHaveBeenCalledTimes(1)
      expect(paymentSets()).toBe(1)
      expect(
        (await received()).map(m => [m.payloadDigest, m.messageId]),
      ).toEqual([[digest, ID_A]])
    })

    // Row 5 (A3). On main: the second call draws a new ID; once the first delivers, it pays again.
    it('row 5 (A3), link durable and onAttemptCreated threw: the original digest, one intent, one payment set', async () => {
      let digest: string | undefined
      const refusal = new Error('caller could not save the attempt')
      const first = await attempt({
        messageId: ID_A,
        onAttemptCreated: value => {
          digest = value
          throw refusal
        },
      })
      expect(first.error).toBe(refusal)
      expect(first.labelled).toBe(false)
      expect(first.intents).toBe(1)
      expect(first.requests).toBe(0)
      expect(digest).toMatch(/^[0-9a-f]{64}$/)

      expectAlreadyAttempted(await attempt({ messageId: ID_A }), ID_A, digest!)
      await reopen()
      expectAlreadyAttempted(await attempt({ messageId: ID_A }), ID_A, digest!)
      expect(journal()).toHaveLength(1)
      expect(journalHas(ID_A)).toBe(true)
      expect(relayBodies).toHaveLength(0)

      expect(
        await f.chain.directMessages.reconcileAttempts({
          wallet: alice,
          payloadDigests: [digest!],
        }),
      ).toEqual({ [digest!]: 'delivered' })
      expectAlreadyAttempted(await attempt({ messageId: ID_A }), ID_A, digest!)
      expect(prepareIntent).toHaveBeenCalledTimes(1)
      expect(paymentSets()).toBe(1)
      expect(
        (await received()).map(m => [m.payloadDigest, m.messageId]),
      ).toEqual([[digest, ID_A]])
    })

    // Row 6. On main: no parameter; a timeout is not proof of non-execution, yet a caller that
    // sends again gets a new ID and a second payment set once the first clears.
    it('row 6, signed and handed to a relay that never answered: the original digest, the same single payment set', async () => {
      f.setPhase('fail')
      let digest: string | undefined
      const first = await attempt({
        messageId: ID_A,
        onAttemptCreated: value => void (digest = value),
      })
      expect(first.error).toBeInstanceOf(MonadStampPendingAttemptError)
      expect(first.labelled).toBe(false)
      expect(first.intents).toBe(1)
      expect(first.requests).toBeGreaterThan(0)

      expectAlreadyAttempted(await attempt({ messageId: ID_A }), ID_A, digest!)
      await reopen()
      expectAlreadyAttempted(await attempt({ messageId: ID_A }), ID_A, digest!)
      expect(journal()).toHaveLength(1)
      expect(journalHas(ID_A)).toBe(true)

      f.setPhase('delivered')
      expect(
        await f.chain.directMessages.reconcileAttempts({
          wallet: alice,
          payloadDigests: [digest!],
        }),
      ).toEqual({ [digest!]: 'delivered' })
      expectAlreadyAttempted(await attempt({ messageId: ID_A }), ID_A, digest!)
      expect(prepareIntent).toHaveBeenCalledTimes(1)
      expect(paymentSets()).toBe(1)
      expect(
        (await received()).map(m => [m.payloadDigest, m.messageId]),
      ).toEqual([[digest, ID_A]])
    })
  })

  // On main: both calls draw their own random ID and both pay.
  it('two concurrent sends with one ID make exactly one intent and one payment set', async () => {
    const send = () =>
      f.chain.directMessages.send({
        wallet: alice,
        recipient: f.bob.identity.address,
        items: [{ type: 'text', text: 'hello' }],
        messageId: ID_A,
      })
    const settled = await Promise.allSettled([send(), send(), send()])
    const sent = settled.filter(
      (s): s is PromiseFulfilledResult<DirectMessageSendResult> =>
        s.status === 'fulfilled',
    )
    const refused = settled.filter(
      (s): s is PromiseRejectedResult => s.status === 'rejected',
    )
    expect(sent).toHaveLength(1)
    expect(refused).toHaveLength(2)
    for (const { reason } of refused) {
      expect(reason).toBeInstanceOf(DirectMessageAlreadyAttemptedError)
      expect(reason).toMatchObject({
        messageId: ID_A,
        payloadDigest: sent[0].value.payloadDigest,
        recipientSubject: bobSubject,
      })
      expect(isDirectMessageNotAttempted(reason)).toBe(false)
    }
    expect(prepareIntent).toHaveBeenCalledTimes(1)
    expect(paymentSets()).toBe(1)
    expect((await links()).map(row => row.consumerId)).toEqual([consumerOf(ID_A)])
    expect((await received()).map(m => m.messageId)).toEqual([ID_A])
  })
})
