/**
 * Canonical (#778) direct messages for a typed Monad wallet: type8 -> type6 -> type5/schema2/suite1
 * sealed by `@frank/cashweb/relay/canonical-dm`, paid and journaled by the wallet's own
 * `MonadCanonicalStampClient`, and carried by the canonical transport and mailbox clients.
 *
 * This file contains no wire encoding and no cryptography of its own. It only orders the public
 * steps and keeps the consumer's durable workflow links, which the canonical wallet requires
 * before it will replay or finish anything.
 *
 * Directory trust is never created here. The caller installs a {@link CanonicalDirectory} whose
 * `Current` values come from its own admission stores (the open directory: every account signs its
 * own entry, and any address with a published entry can be messaged). Until this account's own
 * entry is published every operation rejects with {@link CanonicalMessagingPendingError} before
 * funding, signing or any relay request.
 */
import { Transaction, computeAddress, getAddress, hexlify } from 'ethers'
import level, { type LevelDB } from 'level'
import { join } from 'path'
import {
  cborMap,
  decodeDirectMessageCryptoContext,
  encodeFrame,
  fromHex,
  isStealthMessageItemFrame,
  parseFrame,
  paymentCommitment,
  paymentTransferFromMember,
  paymentTransferFromStealthItem,
  paymentTransferToMember,
  paymentTransferToStealthItem,
  projectStealthMessageItem,
  recipientPayloadDigest,
  toHex,
  type CanonicalStealthItem,
  type ChildFrame,
  type NestedItemBudget,
  type PaymentMember,
  type PaymentTransfer,
} from '@frank/codec'
import { randomBytes } from '@frank/crypto-box'
import type { Current, HistoricalEvidence } from '../../directory-admission/src'
import {
  DirectMessageError,
  openDirectMessage,
  openOwnDirectMessage,
  prepareDirectMessage,
} from '@frank/cashweb/relay/canonical-dm'
import {
  describeCanonicalParts,
  freezeCanonicalRequest,
  installedCanonicalOrigin,
  submitCanonicalRequest,
  type CanonicalFetch,
} from '@frank/cashweb/relay/canonical-dm-transport'
import { canonicalStampDestination } from '@frank/cashweb/relay/canonical-dm-stamp'
import { allocateOpeningConversationId } from '@frank/cashweb/relay/conversation-id'
import {
  connectCanonicalMailboxStream,
  fetchCanonicalInboxPage,
  fetchCanonicalMailboxPage,
  MonadMailboxChallengeCapacityError,
  type CanonicalMailboxAuthParams,
  type CanonicalMailboxRecord,
} from '@frank/cashweb/relay/monad-mailbox-client'
import type { MessageItem, StealthItem } from '@frank/cashweb/types/messages'
import type { MessageItemRegistry } from '../message-item-plugins/registry'
import {
  MessageItemBudgetExceededError,
  decodeItemFrames,
  encodeItemFrames,
} from '../message-item-plugins/wire'
export { applyWalletSyncItem } from '../sync-dispatcher'
import {
  DirectMessageAlreadyAttemptedError,
  DirectMessageArgumentError,
  DirectMessageAttemptUnlinkedError,
  directMessageNotAttempted,
} from './active-chain'
import type {
  ChainAddress,
  DirectMessageAttemptStatus,
  DirectMessageClient,
  DirectMessageReceived,
  DirectMessageSendResult,
  StampPaymentInfo,
} from './active-chain'
import {
  MonadStampPendingAttemptError,
  MonadStampTerminalError,
  type CanonicalWorkflowLink,
  type MonadCanonicalStampClient,
} from '../monad-stamp-client'
import type { MonadCanonicalRoleOwner } from '../monad-wallet-material'
import {
  durableDelete,
  durablePut,
  openDurableLevel,
} from '../storage/level-durability'
import { deriveEvmStealthPrivateKey } from '../monad-stealth'
import type { EvmChainWalletHandle } from "../evm-wallet-handle";
import type { NativeWalletHandle, WalletHandle } from './active-chain'

/** Public directory access owned by the caller. Every call must return a fresh admitted Current. */
export interface CanonicalDirectory {
  /** Exact canonical network of every entry, e.g. `monad-testnet`. */
  readonly network: string
  /** HTTPS root endpoint of the relay this wallet submits to and reads its mailbox from. */
  readonly homeEndpoint: string
  /**
   * Whether an endpoint belongs to this relay (either exact origin match, or through loopback / tunnel proxying).
   */
  isHomeRelay?(endpoint: string): boolean | Promise<boolean>
  /** Fresh Current of the wallet's own entry. */
  selfCurrent(): Promise<Current>
  /**
   * Fresh Current of any account, by address or by signing key. `undefined` when that account has
   * not published an entry. Throws when an entry exists but is refused (wrong key for the address,
   * rolled back, forked, expired) or cannot be obtained right now.
   */
  peerCurrent(
    peer: { address: string } | { subject: string },
  ): Promise<
    { subject: string; endpoint: string; current: Current } | undefined
  >
  /**
   * Looks up historical directory evidence for a subject by statement hash.
   */
  peerHistorical?(peer: {
    subject: string
    statementHash: string
  }): Promise<HistoricalEvidence | undefined>
  /**
   * Whether this wallet's relay says it delivers to accounts that live on other relays. Absent
   * counts as no: a message for another relay is then refused before anything is funded.
   */
  forwarding?(): Promise<boolean>
  /** Transport override for tests and controlled origins; defaults to global fetch. */
  readonly fetch?: CanonicalFetch
}

/** Messaging is unavailable until this account's own directory entry is published. */
export class CanonicalMessagingPendingError extends Error {
  constructor(
    message = 'Direct messages are not available yet: this account’s directory entry has not been published to its relay.',
  ) {
    super(message)
    this.name = 'CanonicalMessagingPendingError'
  }
}

/** The recipient address has no published directory entry. Nothing was paid or sent. */
export class CanonicalRecipientNotPublishedError extends Error {
  constructor(readonly address: string) {
    super(
      `${address} has not published a directory entry, so it cannot receive messages yet. Nothing was paid or sent.`,
    )
    this.name = 'CanonicalRecipientNotPublishedError'
  }
}

/** The recipient lives on another relay and this wallet's relay does not forward there yet.
 * Raised before anything is funded, signed or sent. */
export class CanonicalRelayCannotForwardError extends Error {
  constructor(readonly address: string, readonly recipientRelay: string) {
    super(
      `Your relay cannot deliver to ${recipientRelay} yet, the relay ${address} lives on. Nothing was paid or sent.`,
    )
    this.name = 'CanonicalRelayCannotForwardError'
  }
}

/** The relay accepted the submission for checking and then ended it because it cannot deliver to
 * the recipient's relay. The relay decides that before it broadcasts anything. This attempt is over
 * and later sends proceed; the wallet still keeps its signed set and its reserved accounts. */
export class CanonicalRecipientUndeliverableError extends MonadStampTerminalError {
  constructor() {
    super(
      'Your relay could not deliver to the relay this address lives on. This message was not sent. The relay reports that it broadcast no payment; the payment stays reserved in your wallet.',
      422,
      'mailbox_terminal',
      false,
      'undeliverable',
    )
    this.name = 'CanonicalRecipientUndeliverableError'
  }
}

/** The relay rejected the submission because the sender's own directory entry is not published. */
export class CanonicalSenderUnpublishedError extends MonadStampTerminalError {
  constructor(
    message = 'Your directory entry is not published on the relay. This message was not sent.',
  ) {
    super(
      message,
      422,
      'mailbox_terminal',
      false,
      'sender_unpublished',
    )
    this.name = 'CanonicalSenderUnpublishedError'
  }
}

/** A durable canonical payment record exists that no saved message accounts for. */
export class CanonicalMessagingHoldError extends Error {
  /** The original failure, unchanged, when an earlier payment could not be finished. Callers
   * read its class (not enough funds, no response) from here to tell the user why. */
  readonly cause?: unknown
  constructor(
    message = 'An earlier canonical payment record cannot be matched to a saved message. Sending is held so nothing is paid twice.',
    cause?: unknown,
  ) {
    super(message)
    this.name = 'CanonicalMessagingHoldError'
    if (cause !== undefined) this.cause = cause
  }
}

interface StoredLink {
  digest: string
  attemptRef: string
  consumerId: string
  prepared: Record<string, string>
  /** `dead`: the relay answered that it ended delivery of this exact set for good (`reason`).
   * Final for delivery only. The attempt's journal record and reserved accounts are kept, and
   * later sends, which use other accounts, are not held behind it. */
  outcome?: 'delivered' | 'dead'
  /** The relay's terminal reason; it does not prove the signed payments cannot execute. */
  reason?: string
  acknowledged?: boolean
  /** Saved once a message pointed at this delivered attempt, or the user answered for it. Until
   * then a delivered attempt is reported as unattributed in every session. */
  accounted?: boolean
  putAttempts?: number
  lastPutAttemptAt?: number
  createdAt?: number
}
const PREPARED_BYTES = ['payload', 'context', 'economicBinding'] as const
function storeLink(digest: string, link: CanonicalWorkflowLink): StoredLink {
  const prepared: Record<string, string> = {}
  for (const [key, value] of Object.entries(link.prepared))
    prepared[key] =
      value instanceof Uint8Array ? toHex(value) : (value as string)
  return {
    digest,
    attemptRef: link.attemptRef,
    consumerId: link.consumerId,
    prepared,
    createdAt: Date.now(),
  }
}
function restoreLink(row: StoredLink): CanonicalWorkflowLink {
  const prepared: Record<string, unknown> = { ...row.prepared }
  for (const key of PREPARED_BYTES) prepared[key] = fromHex(row.prepared[key])
  return {
    attemptRef: row.attemptRef,
    consumerId: row.consumerId,
    prepared: prepared as unknown as CanonicalWorkflowLink['prepared'],
  }
}

/** Durable consumer-side workflow links, separate from the wallet's own canonical journal. */
export interface CanonicalLinkStore {
  all(): StoredLink[]
  put(row: StoredLink): Promise<void>
  close(): Promise<void>
  /** The sealed envelope of an unpaid message that was handed to the relay and is not known to
   * have been delivered, by message ID. Kept so that sending the same message again sends the
   * same bytes: one digest, however many copies the relay ends up holding. Not a link and not
   * in `all()`: it stands for no payment. */
  unpaid(messageId: string): UnpaidEnvelope | undefined
  /** `undefined` drops the record. */
  setUnpaid(messageId: string, envelope: UnpaidEnvelope | undefined): Promise<void>
}
/** Hex throughout. `recipientSubject`: whom the envelope is sealed to. */
export interface UnpaidEnvelope {
  digest: string
  delivery: string
  context: string
  recipientSubject: string
}
export class MemoryCanonicalLinkStore implements CanonicalLinkStore {
  private readonly rows = new Map<string, StoredLink>()
  all(): StoredLink[] {
    return [...this.rows.values()]
  }
  async put(row: StoredLink): Promise<void> {
    this.rows.set(row.attemptRef, { ...row })
  }
  async close(): Promise<void> {
    return undefined
  }
  private readonly envelopes = new Map<string, UnpaidEnvelope>()
  unpaid(messageId: string): UnpaidEnvelope | undefined {
    return this.envelopes.get(messageId)
  }
  async setUnpaid(messageId: string, envelope: UnpaidEnvelope | undefined) {
    if (envelope) this.envelopes.set(messageId, { ...envelope })
    else this.envelopes.delete(messageId)
  }
}
const UNPAID_PREFIX = 'unpaid-envelope:'
const CANONICAL_LINK_NAMESPACE = 'canonical-dm-workflow-links'
/** The link ties a durable payment intent to the message it pays for, so it is a wallet authority
 * record: it opens and writes through the durable Level helpers, and an awaited `put` means the
 * link is on stable storage before anything is signed. */
export class LevelCanonicalLinkStore implements CanonicalLinkStore {
  private readonly rows = new Map<string, StoredLink>()
  private constructor(private readonly db: LevelDB) {}
  static async open(location: string): Promise<LevelCanonicalLinkStore> {
    const database = level(join(location, CANONICAL_LINK_NAMESPACE))
    try {
      await openDurableLevel(database, location, CANONICAL_LINK_NAMESPACE)
      const store = new LevelCanonicalLinkStore(database)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const [key, value] of store.db.iterator({}) as any) {
        if (String(key).startsWith(UNPAID_PREFIX))
          store.envelopes.set(
            String(key).slice(UNPAID_PREFIX.length),
            JSON.parse(value) as UnpaidEnvelope,
          )
        else {
          const row = JSON.parse(value) as StoredLink
          store.rows.set(row.attemptRef, row)
        }
      }
      return store
    } catch (error) {
      await database.close()
      throw error
    }
  }
  all(): StoredLink[] {
    return [...this.rows.values()]
  }
  async put(row: StoredLink): Promise<void> {
    await durablePut(this.db, row.attemptRef, JSON.stringify(row))
    this.rows.set(row.attemptRef, { ...row })
  }
  private readonly envelopes = new Map<string, UnpaidEnvelope>()
  unpaid(messageId: string): UnpaidEnvelope | undefined {
    return this.envelopes.get(messageId)
  }
  async setUnpaid(messageId: string, envelope: UnpaidEnvelope | undefined) {
    if (envelope) {
      await durablePut(this.db, UNPAID_PREFIX + messageId, JSON.stringify(envelope))
      this.envelopes.set(messageId, { ...envelope })
    } else if (this.envelopes.has(messageId)) {
      await durableDelete(this.db, UNPAID_PREFIX + messageId)
      this.envelopes.delete(messageId)
    }
  }
  async close(): Promise<void> {
    await this.db.close()
  }
}

/** Everything the composition root lends to this workflow for one live typed wallet. */
export interface CanonicalMessagingOwner {
  readonly installedNetworkTag: 'MONT' | 'MON1'
  /** The wallet's installed relay origin; the canonical client submits only there. */
  readonly relayBaseUrl: string
  readonly identityAddress: string
  readonly subject: string
  readonly roles: MonadCanonicalRoleOwner
  readonly links: CanonicalLinkStore
  client(): MonadCanonicalStampClient
  signDigest(digest: Uint8Array): Uint8Array
  /** Funds single-use sender accounts under the wallet's ordinary financial admission. */
  prepareInventory(input: {
    stampValueWei: bigint
    recipientStampKey: Uint8Array
    onProgress?: Parameters<
      DirectMessageClient['send']
    >[0]['onPreparationProgress']
  }): Promise<string[]>
  directory(): CanonicalDirectory | undefined
  /** The message-item registry composition installed for this wallet
   * ({@link installMessageItemRegistry}). Every item sent or received goes through it. */
  messageItems(): MessageItemRegistry | undefined
}

/** No message-item registry has been installed for this wallet. Nothing is sent, and nothing is
 * read from the mailbox, until the host installs one; the mailbox is left as it is. */
export class CanonicalMessageItemsNotInstalledError extends Error {
  constructor() {
    super(
      'No message item registry is installed for this wallet. Nothing was paid, sent or read.',
    )
    this.name = 'CanonicalMessageItemsNotInstalledError'
  }
}

const installedMessageItems = new WeakMap<object, MessageItemRegistry>()

/**
 * Composition installs the registry of message-item plugins a live wallet sends and receives
 * with, the same way it installs the wallet's directory. The canonical workflow never builds one
 * and never imports a plugin. Returns the removal.
 */
export function installMessageItemRegistry(
  wallet: object,
  registry: MessageItemRegistry,
): () => void {
  installedMessageItems.set(wallet, registry)
  return () => {
    if (installedMessageItems.get(wallet) === registry)
      installedMessageItems.delete(wallet)
  }
}

/** The registry installed for `wallet`, for the composition root that builds its workflow. */
export function installedMessageItemRegistry(
  wallet: object,
): MessageItemRegistry | undefined {
  return installedMessageItems.get(wallet)
}

function requireMessageItems(
  owner: CanonicalMessagingOwner,
): MessageItemRegistry {
  const registry = owner.messageItems()
  if (!registry) throw new CanonicalMessageItemsNotInstalledError()
  return registry
}

const MAX_INBOX_PAGES = 8
const queues = new WeakMap<object, Promise<unknown>>()
/** Messages whose sender could not be checked yet: digest -> when that was first seen. */
const unreadable = new WeakMap<object, Map<string, number>>()
const UNREADABLE_RETRY_MS = 24 * 60 * 60_000
const MAX_UNREADABLE = 1024

function serial<T>(owner: object, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(owner) ?? Promise.resolve()).then(task, task)
  queues.set(
    owner,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

function requireDirectory(owner: CanonicalMessagingOwner): CanonicalDirectory {
  const directory = owner.directory()
  if (!directory) throw new CanonicalMessagingPendingError()
  return directory
}

function formatUuid(bytes: Uint8Array): string {
  const hex = toHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function payments(transactions: readonly Uint8Array[]): StampPaymentInfo[] {
  return transactions.flatMap(raw => {
    const tx = Transaction.from(hexlify(raw))
    return tx.hash === null || tx.to === null
      ? []
      : [{ txHash: tx.hash, destinationAddress: tx.to, valueWei: tx.value }]
  })
}

export function constructStampPaymentTransfers(params: {
  networkTag: string
  transactions: readonly Uint8Array[]
  vout?: number
}): PaymentTransfer[] {
  return params.transactions.flatMap(raw => {
    const tx = Transaction.from(hexlify(raw))
    if (tx.hash === null || tx.to === null) return []
    const hashHex = tx.hash.startsWith('0x')
      ? tx.hash.slice(2).toLowerCase()
      : tx.hash.toLowerCase()
    const toHexStr = tx.to.startsWith('0x')
      ? tx.to.slice(2).toLowerCase()
      : tx.to.toLowerCase()
    return [
      {
        networkTag: params.networkTag,
        txId: fromHex(hashHex),
        ...(params.vout !== undefined ? { vout: params.vout } : {}),
        destination: fromHex(toHexStr),
        value: tx.value,
        rawTx: raw,
      },
    ]
  })
}

export function constructPaymentTransferFromMember(
  member: PaymentMember,
  networkTag: string,
): PaymentTransfer {
  return paymentTransferFromMember(member, networkTag)
}

export function constructPaymentTransferFromStealth(
  item: CanonicalStealthItem | StealthItem,
  destination?: string | Uint8Array,
): PaymentTransfer {
  return paymentTransferFromStealthItem(item as any, destination)
}

export function consumePaymentTransferToStamp(
  transfer: PaymentTransfer,
): StampPaymentInfo {
  return {
    txHash: '0x' + toHex(transfer.txId),
    destinationAddress: getAddress('0x' + toHex(transfer.destination)),
    valueWei:
      typeof transfer.value === 'bigint'
        ? transfer.value
        : BigInt('0x' + toHex(transfer.value)),
  }
}

export function consumePaymentTransferToStealth(
  transfer: PaymentTransfer,
): CanonicalStealthItem {
  return paymentTransferToStealthItem(transfer)
}

/**
 * The links the wallet's journal must be correlated with: every unfinished one, and a finished one
 * whose journal record is still held. The journal drops finished records only in order, so a
 * message delivered after an attempt the relay ended stays in it behind that kept attempt. Without
 * its link the wallet would see a payment record no message accounts for and hold everything.
 */
function correlatedLinks(
  owner: CanonicalMessagingOwner,
  client: MonadCanonicalStampClient,
): StoredLink[] {
  const held = new Set(
    client
      .terminalOutcomes()
      .filter(attempt => attempt.acknowledged)
      .map(attempt => attempt.attemptRef),
  )
  return owner.links
    .all()
    .filter(row => !row.acknowledged || held.has(row.attemptRef))
}

/**
 * Correlate every durable wallet record with a saved link, finish frozen intents, re-send the same
 * bytes of live attempts and finish delivered ones. A delivery rejection cannot settle the
 * financial effect of bytes already exposed to a relay or recipient.
 */
async function settle(
  owner: CanonicalMessagingOwner,
  fetch: CanonicalFetch | undefined,
  submitBudget: number,
): Promise<void> {
  const client = owner.client()
  const submitted = new Map<string, number>()
  const retained = new Set<string>()
  for (;;) {
    for (const row of owner.links.all()) {
      if (row.acknowledged) continue
      if (
        row.outcome &&
        client.wasAcknowledged(row.attemptRef)
      ) {
        await owner.links.put({ ...row, acknowledged: true })
        continue
      }
      let found: ReturnType<typeof client.lookup> | undefined
      try {
        found = client.lookup(restoreLink(row).prepared)
      } catch {
        found = undefined
      }
      if (!found || found.record.attemptRef !== row.attemptRef) {
        // Missing evidence says nothing about whether previously signed payments can land.
        throw new CanonicalMessagingHoldError()
      }
    }
    const correlated = correlatedLinks(owner, client)
    // Even an empty link store must be correlated: the wallet may still own an exact attempt.
    const states = client.reconcileWorkflowLinks(correlated.map(restoreLink))
    if (states.some(state => state.state === 'hold'))
      throw new CanonicalMessagingHoldError()
    // A finished link is correlated above and needs nothing more.
    const rows = correlated.filter(row => !row.acknowledged)
    const terminal = states.find(
      state =>
        state.state === 'terminal' &&
        !retained.has(state.attemptRef) &&
        rows.some(row => row.attemptRef === state.attemptRef),
    )
    if (terminal) {
      const row = rows.find(r => r.attemptRef === terminal.attemptRef)!
      const attempt = client
        .terminalOutcomes()
        .find(a => a.attemptRef === terminal.attemptRef)
      if (!attempt?.terminal) {
        throw new CanonicalMessagingHoldError()
      }
      if (attempt.terminal.phase === 'dead') {
        // The relay ended delivery, not the ability to broadcast this signed set. Keep its
        // exact request and reservations until a financial recovery owner can resolve them:
        // nothing is cleaned up or acknowledged here. The final status is saved with the relay's
        // reason so the attempt stops reading as live and stops holding later sends, which use
        // other accounts. Only the journal's terminal record, written from the relay's own
        // answer, leads here; a timeout or a failed request never does. A row written before
        // this status existed (a reason and no outcome) is completed here the same way.
        // The row stays unacknowledged, so every settle reaches it again: write it only when
        // what is stored differs from what this would write.
        if (
          row.outcome !== 'dead' ||
          row.reason !== attempt.terminal.reason
        )
          await owner.links.put({
            ...row,
            outcome: 'dead',
            reason: attempt.terminal.reason,
          })
        retained.add(row.attemptRef)
        continue
      }
      // The outcome is saved before the wallet forgets the attempt, so it is never lost.
      await owner.links.put({
        ...row,
        outcome: 'delivered',
      })
      await client.cleanupTerminal(row.attemptRef, row.consumerId)
      await client.acknowledgeWorkflow(row.attemptRef, row.consumerId)
      await owner.links.put({
        ...owner.links.all().find(r => r.attemptRef === row.attemptRef)!,
        acknowledged: true,
      })
      continue
    }
    const ready = states.find(
      state =>
        state.state === 'ready' &&
        (submitted.get(state.attemptRef) ?? 0) < submitBudget,
    )
    if (!ready?.eligibility) return
    const row = rows.find(r => r.attemptRef === ready.attemptRef)!
    const found = client.lookup(restoreLink(row).prepared)
    if (found?.kind === 'intent') {
      try {
        await client.finishIntent(ready.eligibility)
      } catch (error) {
        // The frozen intent stays journaled; only these exact payments may ever be finished.
        throw new CanonicalMessagingHoldError(
          'An earlier payment could not be finished yet. Its exact payment set is kept and nothing new is paid.',
          error,
        )
      }
      continue
    }
    submitted.set(ready.attemptRef, (submitted.get(ready.attemptRef) ?? 0) + 1)
    let submitError: unknown
    try {
      await client.submit(ready.eligibility, { fetch })
    } catch (err) {
      submitError = err
      console.warn('[monad-canonical-dm settle submit failed]:', err)
      // Outcome unknown: the exact bytes stay journaled and are re-sent on a later pass.
    }
    if (submitError) {
      // Retry policy is diagnostic only. Neither its budget nor a later HTTP rejection proves
      // that an earlier request was not accepted, broadcast, or handed to the recipient.
      await owner.links.put({
        ...row,
        putAttempts: (row.putAttempts ?? 0) + 1,
        lastPutAttemptAt: Date.now(),
      })
    }
  }
}

/** Durably marks delivered attempts as accounted for. An attempt with no outcome is never marked:
 * it may still be delivered, so it has to stay reported. One the relay ended is never marked
 * either: its signed payments are still kept. */
async function account(
  owner: CanonicalMessagingOwner,
  matches: (row: StoredLink) => boolean,
): Promise<void> {
  for (const row of owner.links.all())
    if (row.outcome === 'delivered' && !row.accounted && matches(row))
      await owner.links.put({ ...row, accounted: true })
}

function statusOf(
  owner: CanonicalMessagingOwner,
  digest: string,
): DirectMessageAttemptStatus {
  const row = owner.links.all().find(r => r.digest === digest)
  if (!row) return 'unknown'
  return row.outcome ?? 'live'
}

/** Errors that left a `send` at or after inventory preparation. Error objects get reused (a
 * directory or the wallet may throw one it kept), so such an object is never reported as not
 * attempted afterwards, by any send, whichever refusal it comes from. */
const possiblyAttemptedErrors = new WeakSet<object>()

/** Labels the error of one `send` call refused before inventory preparation and returns the same
 * object. The label is about that call only: it created no intent, link, reservation, funding or
 * submission of its own. `settle` may have finished or re-sent earlier attempts inside it, and an
 * earlier call may have paid for the same content; the label says nothing about either. Only the
 * labelled object itself answers, not one that inherits from it or wraps it. An error that cannot
 * carry the label is returned as it is. */
function notAttempted(error: unknown): unknown {
  if (
    typeof error === 'object' &&
    error !== null &&
    !possiblyAttemptedErrors.has(error)
  ) {
    try {
      Object.defineProperty(error, directMessageNotAttempted, {
        get(this: unknown) {
          return this === error && !possiblyAttemptedErrors.has(error)
        },
      })
    } catch {
      // Already labelled, frozen or sealed: the refusal is unchanged either way.
    }
  }
  return error
}

/** Withdraws any label from an error leaving a send that may have had an effect. */
function possiblyAttempted(error: unknown): unknown {
  if (typeof error === 'object' && error !== null)
    possiblyAttemptedErrors.add(error)
  return error
}

/** The relay did not deliver a message sent with no stamp. Nothing was paid and nothing is kept
 * to retry: the caller may send again. */
export class UnpaidDirectMessageNotDeliveredError extends Error {
  constructor(readonly answer: string) {
    super(`The relay did not deliver this unpaid message (${answer}).`)
    this.name = 'UnpaidDirectMessageNotDeliveredError'
  }
}

/** Seals one message and frames it as an unpaid delivery: type 1 at schema 2 with an empty
 * payment list and no transactions. Pure: nothing is stored, reserved or sent. */
function sealUnpaid(
  owner: CanonicalMessagingOwner,
  directory: CanonicalDirectory,
  message: Pick<
    Parameters<typeof prepareDirectMessage>[0],
    'senderCurrent' | 'recipientCurrent' | 'messageId' | 'conversationId' | 'items'
  >,
) {
  const roles = owner.roles.create(directory.network, message.senderCurrent)
  let sealed
  try {
    sealed = prepareDirectMessage({ network: directory.network, ...message, roles })
  } finally {
    roles.dispose()
  }
  const payload = parseFrame(sealed.payload)
  if (payload.kind !== 'parsed' || payload.typed?.type !== 5)
    throw new CanonicalMessagingHoldError()
  const digest = recipientPayloadDigest(directory.network, sealed.payload)
  const account = (ref: { keyType: number; keyBytes: Uint8Array }) =>
    cborMap([
      [0, ref.keyType],
      [1, ref.keyBytes],
    ])
  // The paid delivery's fields in the same order, without payment members.
  const delivery = encodeFrame(
    { typeId: 1, schemaVersion: 2, minReaderVersion: 1 },
    cborMap([
      [0, directory.network],
      [1, account(decodeDirectMessageCryptoContext(sealed.context).stampKey)],
      [2, sealed.payload],
      [3, digest],
      [4, []],
      [5, account(payload.typed.recipient)],
      [6, payload.typed.dleqProof],
    ]),
  )
  return {
    digest: toHex(digest),
    delivery,
    context: sealed.context,
    request: freezeCanonicalRequest({
      delivery,
      context: sealed.context,
      transactions: [],
    }),
  }
}

async function send(
  owner: CanonicalMessagingOwner,
  params: Parameters<DirectMessageClient['send']>[0],
  defaultStampValueWei: bigint,
): Promise<DirectMessageSendResult> {
  // Supplied identities are taken exactly or refused: 16 bytes or their lowercase 8-4-4-4-12
  // form. Nothing is repaired. Bytes are copied, so the repeat check and the sealed message use
  // the same value whatever the caller does to its buffer while this send waits. A refusal here
  // is a permanent caller error and is deliberately not labelled.
  const suppliedId = (
    argument: 'conversationId' | 'messageId',
  ): Uint8Array | undefined => {
    const value: unknown = params[argument]
    if (value === undefined) return undefined
    if (
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    )
      return fromHex(value.replace(/-/g, ''))
    if (
      Object.prototype.toString.call(value) === '[object Uint8Array]' &&
      (value as Uint8Array).length === 16
    )
      return Uint8Array.from(value as Uint8Array)
    throw new DirectMessageArgumentError(argument)
  }
  const conversationIdBytes = suppliedId('conversationId')
  const suppliedMessageId = suppliedId('messageId')
  if (suppliedMessageId) {
    // The repeat rule, before the directory or anything else that can refuse or act. Every send
    // of this wallet runs one at a time, so no other send can create a record for this ID between
    // this check and the intent below. A link is written only after its intent is durable, and
    // links are never deleted: one here means an attempt exists, and the answer is the original.
    const consumerId = `frank-dm:${toHex(suppliedMessageId)}`
    const original = owner.links.all().find(row => row.consumerId === consumerId)
    if (original)
      throw new DirectMessageAlreadyAttemptedError(
        formatUuid(suppliedMessageId),
        original.digest,
        original.prepared.recipientSubject,
      )
    let recorded: boolean
    try {
      recorded = owner.client().hasConsumerRecord(consumerId)
    } catch (error) {
      // The journal could not be read. This call created nothing, like any refusal further down.
      throw notAttempted(error)
    }
    // A payment record with no link: never a second intent, and not the caller's to clear.
    if (recorded)
      throw new DirectMessageAttemptUnlinkedError(formatUuid(suppliedMessageId))
  }
  let attempted = false
  try {
    const directory = requireDirectory(owner)
    // Encoded before anything is funded, reserved or journalled: an unregistered type, an item
    // its plugin refuses, or a set of items a reader would refuse rejects here, labelled as not
    // attempted. Nothing was paid or sent.
    // Whether this wallet is writing to itself is all the item rule is told; which items that
    // permits is the rule's own business.
    const selfAddressed =
      params.recipient.raw.toLowerCase() === owner.identityAddress.toLowerCase()
    const items = encodeItemFrames(requireMessageItems(owner), params.items, {
      selfAddressed,
    })
    const stampValueWei = params.stampValue ?? defaultStampValueWei
    const peer = await directory.peerCurrent({ address: params.recipient.raw })
    if (!peer) throw new CanonicalRecipientNotPublishedError(params.recipient.raw)
    // The items were admitted for a message to this wallet's own key: it is sealed to no other.
    if (selfAddressed && peer.subject.toLowerCase() !== owner.subject.toLowerCase())
      throw new CanonicalRecipientNotPublishedError(params.recipient.raw)
    // The recipient may live on any relay: this wallet always submits to its own relay, which
    // forwards. A relay that does not say it forwards is not handed a payment for another relay.
    let elsewhere = true
    try {
      if (typeof directory.isHomeRelay === 'function') {
        elsewhere = !(await directory.isHomeRelay(peer.endpoint))
      } else {
        const peerOrigin = new URL(peer.endpoint).origin
        const homeOrigin = new URL(directory.homeEndpoint).origin
        const peerIsLoopback =
          new URL(peer.endpoint).hostname === '127.0.0.1' ||
          new URL(peer.endpoint).hostname === 'localhost'
        const homeIsLoopback =
          new URL(directory.homeEndpoint).hostname === '127.0.0.1' ||
          new URL(directory.homeEndpoint).hostname === 'localhost'
        elsewhere =
          peerOrigin !== homeOrigin && !(peerIsLoopback && homeIsLoopback)
      }
    } catch {
      // An endpoint that is not a URL is certainly not this relay.
    }
    if (elsewhere && !(await directory.forwarding?.()))
      throw new CanonicalRelayCannotForwardError(
        params.recipient.raw,
        peer.endpoint,
      )
    if (stampValueWei === 0n) {
      // No stamp: the message is sealed and handed to the relay. No account is funded or
      // reserved, nothing is written to the payment journal or the links, and earlier paid
      // attempts are neither waited for nor touched.
      //
      // A caller that names the message (`messageId`) may send it again after any failure, and
      // the relay may already hold the first copy. So the sealed envelope is kept, durably,
      // from before it is handed over until the relay says what became of it, and a repeat
      // sends those same bytes: every copy has the one payload digest.
      const name = suppliedMessageId ? toHex(suppliedMessageId) : undefined
      const kept = name ? owner.links.unpaid(name) : undefined
      if (kept && kept.recipientSubject !== peer.subject)
        throw new DirectMessageArgumentError('messageId')
      let request: ReturnType<typeof freezeCanonicalRequest>
      let digest: string
      if (kept) {
        digest = kept.digest
        request = freezeCanonicalRequest({
          delivery: fromHex(kept.delivery),
          context: fromHex(kept.context),
          transactions: [],
        })
      } else {
        const unpaid = sealUnpaid(owner, directory, {
          senderCurrent: await directory.selfCurrent(),
          recipientCurrent: peer.current,
          messageId: suppliedMessageId ?? randomBytes(16),
          conversationId: conversationIdBytes,
          items,
        })
        digest = unpaid.digest
        request = unpaid.request
        if (name)
          await owner.links.setUnpaid(name, {
            digest,
            delivery: toHex(unpaid.delivery),
            context: toHex(unpaid.context),
            recipientSubject: peer.subject,
          })
      }
      // From here the relay may hold the message, whatever this call learns of it.
      attempted = true
      const accepted = await submitCanonicalRequest({
        installedRelayOrigin: owner.relayBaseUrl,
        expectedNetworkTag: owner.installedNetworkTag,
        request,
        fetch: directory.fetch,
      })
      if (accepted.phase === 'dead') {
        // The relay ended it: this envelope never arrives. A later send is a new message.
        if (name) await owner.links.setUnpaid(name, undefined)
        if (accepted.reason === 'undeliverable')
          throw new CanonicalRecipientUndeliverableError()
        if (accepted.reason === 'sender_unpublished')
          throw new CanonicalSenderUnpublishedError()
        throw new UnpaidDirectMessageNotDeliveredError(accepted.reason)
      }
      // Anything but delivered is the caller's error to act on; the envelope stays for its repeat.
      if (accepted.phase !== 'delivered')
        throw new UnpaidDirectMessageNotDeliveredError(accepted.phase)
      if (name) await owner.links.setUnpaid(name, undefined)
      return {
        payloadDigest: digest,
        stampValueWei: 0n,
        stampPayments: [],
        paymentTransfers: [],
        preparationTxHashes: [],
      }
    }
    // Earlier attempts first: a live one is re-sent as-is, and an unmatched record holds everything.
    // An attempt the relay ended has an outcome and does not hold this send; its accounts stay
    // reserved, so this send is built from other accounts.
    await settle(owner, directory.fetch, 1)
    const live = owner.links.all().filter(row => !row.outcome && !row.acknowledged)
    if (live.length > 0)
      throw new MonadStampPendingAttemptError(live.map(row => row.digest))
    // Inventory funding can broadcast, so from here a rejection is never labelled.
    attempted = true
    const preparationTxHashes = await owner.prepareInventory({
      stampValueWei,
      recipientStampKey: peer.current.stampKey.keyBytes,
      onProgress: params.onPreparationProgress,
    })
    // Fresh snapshots after funding: sealing and payment intent must see the same Current pair.
    const senderCurrent = await directory.selfCurrent()
    const recipient = await directory.peerCurrent({ subject: peer.subject })
    if (!recipient)
      throw new CanonicalRecipientNotPublishedError(params.recipient.raw)
    const messageId = suppliedMessageId ?? randomBytes(16)
    const roles = owner.roles.create(directory.network, senderCurrent)
    let sealed
    try {
      sealed = prepareDirectMessage({
        network: directory.network,
        senderCurrent,
        recipientCurrent: recipient.current,
        messageId,
        // The caller named no conversation: the one this account opens with this recipient.
        conversationId:
          conversationIdBytes ??
          allocateOpeningConversationId(
            owner.roles.conversationIdSalt(),
            params.recipient.raw.toLowerCase(),
          ),
        ...(params.conversationName === undefined
          ? {}
          : { conversationName: params.conversationName }),
        items,
        roles,
      })
    } finally {
      roles.dispose()
    }
    const digest = toHex(
      recipientPayloadDigest(directory.network, sealed.payload),
    )
    const client = owner.client()
    const prepared = client.bindPrepared({
      payload: sealed.payload,
      context: sealed.context,
      stampValueWei,
      economicBinding: messageId,
    })
    let own: CanonicalWorkflowLink | undefined
    await client.prepareIntent({
      prepared,
      consumerId: `frank-dm:${toHex(messageId)}`,
      stampValueWei,
      senderCurrent,
      recipientCurrent: recipient.current,
      onIntentDurable: async link => {
        await owner.links.put(storeLink(digest, link))
        own = link
        await params.onAttemptCreated?.(digest)
      },
    })
    if (!own) throw new CanonicalMessagingHoldError()
    const attemptRef = own.attemptRef
    // From here a durable payment intent exists: only the same bytes may ever be sent for it.
    let transactions: readonly Uint8Array[]
    try {
      const ready = client
        .reconcileWorkflowLinks(
          correlatedLinks(owner, client).map(restoreLink),
        )
        .find(state => state.attemptRef === attemptRef)
      if (ready?.state !== 'ready' || !ready.eligibility)
        throw new CanonicalMessagingHoldError()
      transactions = (await client.finishIntent(ready.eligibility)).request.parts
        .transactions
      await settle(owner, directory.fetch, 1)
    } catch (error) {
      if (error instanceof CanonicalMessagingHoldError) throw error
      throw new MonadStampPendingAttemptError([digest])
    }
    const status = statusOf(owner, digest)
    if (status === 'dead') {
      const reason = owner.links.all().find(row => row.digest === digest)?.reason
      if (reason === 'undeliverable')
        throw new CanonicalRecipientUndeliverableError()
      if (reason === 'sender_unpublished')
        throw new CanonicalSenderUnpublishedError()
      throw new MonadStampTerminalError(
        `The relay ended this payment set (${reason ?? 'no reason given'}); it can never be delivered. Its payments are kept reserved.`,
        422,
        'mailbox_terminal',
        undefined,
        reason,
      )
    }
    if (status !== 'delivered') throw new MonadStampPendingAttemptError([digest])
    return {
      payloadDigest: digest,
      stampValueWei,
      stampPayments: payments(transactions),
      paymentTransfers: constructStampPaymentTransfers({
        networkTag: directory.network,
        transactions,
      }),
      preparationTxHashes,
    }
  } catch (error) {
    throw attempted ? possiblyAttempted(error) : notAttempted(error)
  }
}

function mailboxAuth(
  owner: CanonicalMessagingOwner,
  directory: CanonicalDirectory,
): CanonicalMailboxAuthParams {
  const dirOrigin = installedCanonicalOrigin(
    new URL(directory.homeEndpoint).origin,
  )
  const ownerOrigin = installedCanonicalOrigin(
    new URL(owner.relayBaseUrl).origin,
  )
  const dirIsLoopback =
    new URL(dirOrigin).hostname === '127.0.0.1' ||
    new URL(dirOrigin).hostname === 'localhost'
  const ownerIsLoopback =
    new URL(ownerOrigin).hostname === '127.0.0.1' ||
    new URL(ownerOrigin).hostname === 'localhost'
  const originsMatch =
    dirOrigin === ownerOrigin ||
    (dirIsLoopback &&
      ownerIsLoopback &&
      new URL(dirOrigin).port === new URL(ownerOrigin).port) ||
    dirIsLoopback ||
    ownerIsLoopback
  if (!originsMatch)
    // Two configured values that must agree; this is a wiring error, not a state of the entry.
    throw new CanonicalMessagingPendingError(
      'This wallet and its directory are configured for different relays.',
    )
  return {
    relayBaseUrl: !dirIsLoopback
      ? directory.homeEndpoint
      : !ownerIsLoopback
      ? owner.relayBaseUrl
      : directory.homeEndpoint,
    recipient: computeAddress('0x' + owner.subject).toLowerCase(),
    expectedNetworkTag: owner.installedNetworkTag,
    subject: owner.subject,
    getCurrent: () => directory.selfCurrent(),
    signDigest: digest => owner.signDigest(digest),
    fetch: directory.fetch,
  }
}

async function resolveHistoricalEvidence(
  directory: CanonicalDirectory,
  context: Uint8Array,
  isOutbound: boolean,
  self: Current,
  selfSubject: string,
  peer: { subject: string; current: Current },
): Promise<{
  senderEvidence?: HistoricalEvidence
  recipientEvidence?: HistoricalEvidence
}> {
  if (!directory.peerHistorical) return {}
  try {
    const ctx = decodeDirectMessageCryptoContext(context)
    const ctxSenderHash = toHex(ctx.senderDirectoryHash).toLowerCase()
    const ctxRecipientHash = toHex(ctx.recipientDirectoryHash).toLowerCase()
    let senderEvidence: HistoricalEvidence | undefined
    let recipientEvidence: HistoricalEvidence | undefined
    if (isOutbound) {
      if (ctxSenderHash !== toHex(self.evidence.hash).toLowerCase()) {
        senderEvidence = await directory.peerHistorical({
          subject: selfSubject,
          statementHash: ctxSenderHash,
        })
      }
      if (
        ctxRecipientHash !== toHex(peer.current.evidence.hash).toLowerCase()
      ) {
        recipientEvidence = await directory.peerHistorical({
          subject: peer.subject,
          statementHash: ctxRecipientHash,
        })
      }
    } else {
      if (ctxSenderHash !== toHex(peer.current.evidence.hash).toLowerCase()) {
        senderEvidence = await directory.peerHistorical({
          subject: peer.subject,
          statementHash: ctxSenderHash,
        })
      }
      if (ctxRecipientHash !== toHex(self.evidence.hash).toLowerCase()) {
        recipientEvidence = await directory.peerHistorical({
          subject: selfSubject,
          statementHash: ctxRecipientHash,
        })
      }
    }
    return { senderEvidence, recipientEvidence }
  } catch {
    return {}
  }
}

/** The authenticated sender mailbox is the surviving raw-set authority after compaction. Its
 * header proves consistency with that delivered set, not an independent local raw-set fingerprint.
 * Opening the exact saved payload/context binds it to this wallet's original authorized message.
 * None of these checks establishes chain settlement or restores financial execution authority. */
async function historicalDeliveryIdentity(
  owner: CanonicalMessagingOwner,
  directory: CanonicalDirectory,
  self: Current,
  row: StoredLink,
  record: CanonicalMailboxRecord,
): Promise<string | undefined> {
  if (record.direction !== 'out') return undefined
  const delivery = parseFrame(record.delivery)
  if (delivery.kind !== 'parsed' || delivery.typed?.type !== 1) return undefined
  const envelope = delivery.typed
  const payload = envelope.payloadFrame.typed
  const { prepared } = restoreLink(row)
  if (
    payload?.type !== 5 ||
    prepared.network !== directory.network ||
    envelope.network !== prepared.network ||
    prepared.senderSubject !== owner.subject ||
    toHex(payload.sender.keyBytes) !== prepared.senderSubject ||
    toHex(payload.recipient.keyBytes) !== prepared.recipientSubject ||
    toHex(envelope.payloadFrame.frame) !== toHex(prepared.payload) ||
    toHex(record.context) !== toHex(prepared.context) ||
    toHex(envelope.payloadDigest) !== row.digest
  )
    return undefined
  const transactions = envelope.payments.map(member => {
    if (!member.rawTx) throw new Error('historical-delivery:missing-member')
    return member.rawTx
  })
  const identity = describeCanonicalParts({
    delivery: record.delivery,
    context: record.context,
    transactions,
  })
  if (
    identity.submission_identity !== record.submissionIdentity ||
    identity.payload_hash !== row.digest ||
    identity.sender_t1 !== prepared.senderT1 ||
    identity.recipient_t1 !== prepared.recipientT1 ||
    identity.recipient !==
      computeAddress('0x' + prepared.recipientSubject).toLowerCase()
  )
    return undefined
  let total = 0n
  for (const [index, member] of envelope.payments.entries()) {
    const tx = Transaction.from(hexlify(transactions[index]))
    const value =
      typeof member.value === 'bigint'
        ? member.value
        : BigInt('0x' + toHex(member.value))
    const destination = canonicalStampDestination({
      network: prepared.network,
      stampKey: envelope.destination,
      sharedPoint: payload.sharedPoint,
      childIndex: member.childIndex,
    })
    if (
      !tx.isSigned() ||
      !tx.from ||
      (tx.type !== 0 && tx.type !== 2) ||
      tx.chainId !== BigInt(prepared.chainId) ||
      tx.hash !== '0x' + toHex(member.transactionId) ||
      tx.to?.toLowerCase() !== '0x' + toHex(destination.address) ||
      toHex(member.address) !== toHex(destination.address) ||
      tx.value !== value ||
      value <= 0n ||
      tx.data !== '0x' ||
      toHex(member.commitment) !==
        toHex(paymentCommitment(envelope.payloadDigest, member.childIndex))
    )
      return undefined
    total += value
  }
  const senderEvidence =
    toHex(self.evidence.hash) === prepared.senderT1
      ? self.evidence
      : await directory
          .peerHistorical?.({
            subject: prepared.senderSubject,
            statementHash: prepared.senderT1,
          })
          .catch(() => undefined)
  if (!senderEvidence || toHex(senderEvidence.hash) !== prepared.senderT1)
    return undefined
  // A historical recipient need not have a live directory entry. Resolve the exact
  // original evidence first; Current is only an optional exact-hash fallback.
  let recipientEvidence = await directory
    .peerHistorical?.({
      subject: prepared.recipientSubject,
      statementHash: prepared.recipientT1,
    })
    .catch(() => undefined)
  if (!recipientEvidence) {
    const peer = await directory
      .peerCurrent({
        subject: prepared.recipientSubject,
      })
      .catch(() => undefined)
    if (peer?.subject === prepared.recipientSubject)
      recipientEvidence = peer.current.evidence
  }
  if (
    !recipientEvidence ||
    toHex(recipientEvidence.hash) !== prepared.recipientT1
  )
    return undefined
  const roles = owner.roles.create(directory.network, self)
  try {
    const opened = openOwnDirectMessage({
      mode: 'archive',
      network: directory.network,
      payload: prepared.payload,
      context: prepared.context,
      roles,
      senderEvidence,
      recipientEvidence,
    })
    // The client owns the economic-binding format. Reconstruct through its effect-free
    // boundary; this allocates no spend inputs, persists nothing and signs no transaction.
    const rebound = owner.client().bindPrepared({
      payload: prepared.payload,
      context: prepared.context,
      stampValueWei: total,
      economicBinding: opened.messageId,
    })
    if (
      PREPARED_BYTES.some(
        key => toHex(rebound[key]) !== toHex(prepared[key]),
      ) ||
      row.consumerId !== `frank-dm:${toHex(opened.messageId)}`
    )
      return undefined
  } finally {
    roles.dispose()
  }
  return identity.submission_identity
}

/** A known exposed historical operation cannot become permission for a replacement payment.
 * Fetch outside the workflow queue; admit only complete bounded scans and unchanged live owners. */
async function recoverHistoricalDelivery(
  owner: CanonicalMessagingOwner,
  digests: readonly string[],
): Promise<void> {
  const requested = new Set(digests)
  const candidates = await serial(owner.links, async () =>
    owner.links
      .all()
      .filter(
        row =>
          requested.has(row.digest) &&
          row.outcome === 'dead' &&
          row.acknowledged,
      )
      .map(row => ({ ...row, prepared: { ...row.prepared } })),
  )
  if (!candidates.length) return
  const directory = requireDirectory(owner)
  const client = owner.client()
  const assertCompacted = (row: StoredLink) => {
    if (
      client.lookup(restoreLink(row).prepared) ||
      !client.wasAcknowledged(row.attemptRef)
    )
      throw new CanonicalMessagingHoldError()
  }
  const proofs = new Map<string, string>()
  try {
    for (const row of candidates) assertCompacted(row)
    const self = await directory.selfCurrent()
    const auth = mailboxAuth(owner, directory)
    let cursor: string | undefined
    let complete = false
    for (let pageIndex = 0; pageIndex < MAX_INBOX_PAGES; pageIndex++) {
      const page = await fetchCanonicalMailboxPage({
        ...auth,
        sinceMs: 0,
        cursor,
      })
      for (const supplied of page.records) {
        const record = {
          ...supplied,
          delivery: new Uint8Array(supplied.delivery),
          context: new Uint8Array(supplied.context),
        }
        for (const row of candidates) {
          let identity: string | undefined
          try {
            identity = await historicalDeliveryIdentity(
              owner,
              directory,
              self,
              row,
              record,
            )
          } catch {
            // Malformed or presently unverifiable evidence never establishes delivery.
            continue
          }
          if (!identity) continue
          if (
            proofs.has(row.attemptRef) &&
            proofs.get(row.attemptRef) !== identity
          )
            throw new CanonicalMessagingHoldError()
          proofs.set(row.attemptRef, identity)
        }
      }
      cursor = page.nextCursor
      if (cursor === undefined) {
        complete = true
        break
      }
    }
    if (!complete || candidates.some(row => !proofs.has(row.attemptRef)))
      throw new CanonicalMessagingHoldError()
  } catch (cause) {
    throw new CanonicalMessagingHoldError(
      'The original payment may have been submitted; its historical delivery cannot yet be verified.',
      cause,
    )
  }
  await serial(owner.links, async () => {
    if (owner.directory() !== directory) throw new CanonicalMessagingHoldError()
    for (const snapshot of candidates) {
      assertCompacted(snapshot) // Also checks that this wallet/session is still open and owns it.
      const current = owner.links
        .all()
        .find(row => row.attemptRef === snapshot.attemptRef)
      const delivered: StoredLink = {
        ...snapshot,
        outcome: 'delivered',
        reason: undefined,
      }
      // Another reconciliation may have completed while this scan was in flight.
      if (JSON.stringify(current) === JSON.stringify(delivered)) continue
      if (JSON.stringify(current) !== JSON.stringify(snapshot))
        throw new CanonicalMessagingHoldError()
      await owner.links.put(delivered)
    }
  })
}

/** The other party of a message is this wallet itself: the key the message names and the key the
 * directory answered for it are both this wallet's own. */
function isOwnSubject(
  owner: CanonicalMessagingOwner,
  named: string,
  resolved: string,
): boolean {
  const own = owner.subject.toLowerCase()
  return named.toLowerCase() === own && resolved.toLowerCase() === own
}

/** The items of an opened message through the installed registry, in order. One item that cannot
 * be read becomes an `unsupported` item; it never fails the message. */
function receivedItems(
  registry: MessageItemRegistry,
  opened: {
    readonly items: readonly ChildFrame[]
    readonly itemBudget: NestedItemBudget
  },
  wallet: WalletHandle,
  isOutbound: boolean,
  timestampMs: number,
  selfAddressed: boolean,
): MessageItem[] {
  const children = opened.items
  const items = decodeItemFrames(registry, children, opened.itemBudget, {
    selfAddressed,
  })
  // A wallet effect, not a plugin's: a received stealth payment is added to this wallet's keys.
  // It reads the validated frame, so the amount is exact.
  children.forEach((child, index) => {
    if (
      items[index].type === 'stealth' &&
      child.kind === 'parsed' &&
      isStealthMessageItemFrame(child)
    )
      indexStealthItemIfRecipient(
        wallet,
        isOutbound,
        projectStealthMessageItem(child),
        timestampMs,
      )
  })
  return items
}

function indexStealthItemIfRecipient(
  wallet: WalletHandle,
  isOutbound: boolean,
  projected: ReturnType<typeof projectStealthMessageItem>,
  timestampMs: number,
) {
  if (!isOutbound && projected.keyType === 1) {
    const liveWallet = wallet as EvmChainWalletHandle
    if (liveWallet?.stealthKeyring && liveWallet?.identity) {
      try {
        const derived = deriveEvmStealthPrivateKey({
          recipientSpendSecret: liveWallet.identity.toPrivateKeyHex(),
          ephemeralPubKey: fromHex(projected.ephemeralPubKey),
        })
        void liveWallet.stealthKeyring.addAccount({
          address: derived.stealthAddress,
          privateKey: derived.stealthPrivateKey,
          ephemeralPubKey: projected.ephemeralPubKey,
          networkTag: projected.networkTag,
          discoveredAtMs: timestampMs,
          initialAmountWei: BigInt(projected.amount),
          txHash: projected.transactions[0],
        })
      } catch {
        // ignore corrupt stealth key derivation
      }
    }
  } else if (!isOutbound && projected.keyType === 2) {
    const solWallet =
      (
        wallet as {
          solanaWallet?: {
            stealthKeyring?: { registerFromStealthItem: Function }
            spendSeed?: Uint8Array
          }
        }
      )?.solanaWallet ?? (wallet as any)
    if (solWallet?.stealthKeyring && solWallet?.spendSeed) {
      try {
        void solWallet.stealthKeyring.registerFromStealthItem({
          item: projected,
          recipientSpendSeed: solWallet.spendSeed,
          timestampMs,
        })
      } catch {
        // ignore corrupt stealth key derivation
      }
    }
  }
}

/** The payment members of a received delivery that pay THIS wallet: a member's address must be
 * the stamp child of one of the wallet's own stamp keys (current or previous) for the message's
 * shared point. The delivery frame is written by the sender, so a member paying any other address
 * is somebody else's money and is never reported as received. Not a chain check: whether a
 * reported transfer was mined is for the caller to look up. */
export function paymentsToSelf<T extends { address: Uint8Array; childIndex: number }>(
  network: string,
  self: Current,
  sharedPoint: Uint8Array,
  payments: readonly T[],
): T[] {
  const keys = [self.stampKey, self.previousStamp].filter(
    (key): key is NonNullable<typeof key> => !!key,
  )
  return payments.filter(member =>
    keys.some(stampKey => {
      try {
        return (
          toHex(
            canonicalStampDestination({
              network,
              stampKey,
              sharedPoint,
              childIndex: member.childIndex,
            }).address,
          ) === toHex(member.address)
        )
      } catch {
        return false
      }
    }),
  )
}

async function fetchSince(
  owner: CanonicalMessagingOwner,
  params: Parameters<DirectMessageClient['fetchSince']>[0],
): Promise<DirectMessageReceived[]> {
  const directory = requireDirectory(owner)
  // Before any request: with no registry nothing is read, so nothing is consumed or dropped.
  const registry = requireMessageItems(owner)
  const auth = mailboxAuth(owner, directory)
  const self = await directory.selfCurrent()
  const received: DirectMessageReceived[] = []
  const own: ChainAddress = { raw: getAddress(owner.identityAddress) }
  let cursor: string | undefined
  for (let pageIndex = 0; pageIndex < MAX_INBOX_PAGES; pageIndex++) {
    let page: {
      records: readonly (
        | CanonicalMailboxRecord
        | {
            delivery: Uint8Array
            context: Uint8Array
            submissionIdentity: string
            timestampMs: number
            direction?: 'in' | 'out'
          }
      )[]
      unreadable?: readonly { submissionIdentity: string; timestampMs: number }[]
      nextCursor?: string
    }
    try {
      page = await fetchCanonicalMailboxPage({
        ...auth,
        sinceMs: params.sinceMs,
        ...(cursor === undefined ? {} : { cursor }),
      })
    } catch (error) {
      if (
        error instanceof MonadMailboxChallengeCapacityError ||
        (error as { status?: number })?.status === 429 ||
        (error as { code?: string })?.code === 'mailbox_challenge_capacity'
      ) {
        if (pageIndex === 0) throw error
        params.onTruncated?.(error as Error)
        break
      }
      try {
        page = await fetchCanonicalInboxPage({
          ...auth,
          sinceMs: params.sinceMs,
          ...(cursor === undefined ? {} : { cursor }),
        })
      } catch {
        if (pageIndex === 0) throw error
        params.onTruncated?.(error as Error)
        break
      }
    }
    // A record this client cannot decode is never a message, never paid and never a received
    // stamp. It is reported as terminal, under the relay's own identity for it, so the host's
    // read position passes it instead of meeting it again on every read.
    for (const skipped of page.unreadable ?? [])
      params.onQuarantinedTimestamp?.(
        skipped.timestampMs,
        skipped.submissionIdentity,
      )
    for (const record of page.records) {
      const delivery = parseFrame(record.delivery)
      if (delivery.kind !== 'parsed' || delivery.typed?.type !== 1) continue
      const deliveryTyped = delivery.typed
      const payload = deliveryTyped.payloadFrame.typed
      if (payload?.type !== 5) continue
      const digest = toHex(deliveryTyped.payloadDigest)
      const isOutbound = record.direction === 'out'
      const peerSubjectKeyBytes = isOutbound
        ? payload.recipient.keyBytes
        : payload.sender.keyBytes
      const peerSubjectHex = toHex(peerSubjectKeyBytes)

      // Any peer with a published entry that verifies is shown; no peer list is consulted.
      let peer
      try {
        peer = await directory.peerCurrent({
          subject: peerSubjectHex,
        })
      } catch (error) {
        const code = (error as { code?: string } | null)?.code
        if (code === 'invalid' || code === 'fork') {
          // The peer's entry is not signed by that peer, or conflicts with the one pinned
          // for it: this message is never shown.
          params.onQuarantinedTimestamp?.(record.timestampMs, digest)
          continue
        }
        // Anything else is about this one peer right now: its entry expired or was rolled
        // back, its history could not be read, the lookup failed. The message is left for a
        // later read and every other peer's mail is still delivered. It is retried for a
        // bounded time, after which it is given up on so it cannot pin the inbox scan forever.
        const waiting = unreadable.get(owner.links) ?? new Map<string, number>()
        unreadable.set(owner.links, waiting)
        const since = waiting.get(digest) ?? Date.now()
        if (waiting.size >= MAX_UNREADABLE && !waiting.has(digest))
          waiting.delete(waiting.keys().next().value as string)
        waiting.set(digest, since)
        if (Date.now() - since >= UNREADABLE_RETRY_MS) {
          waiting.delete(digest)
          params.onQuarantinedTimestamp?.(record.timestampMs, digest)
        } else params.onIncompleteTimestamp?.(record.timestampMs)
        continue
      }
      unreadable.get(owner.links)?.delete(digest)
      if (!peer) {
        // No published entry for the key: nothing can authenticate this message.
        params.onQuarantinedTimestamp?.(record.timestampMs, digest)
        continue
      }
      const { senderEvidence, recipientEvidence } =
        await resolveHistoricalEvidence(
          directory,
          record.context,
          isOutbound,
          self,
          owner.subject,
          peer,
        )
      const roles = owner.roles.create(directory.network, self)
      let items: MessageItem[]
      let conversationIdStr: string | undefined
      let conversationNameStr: string | undefined
      let messageIdStr: string | undefined
      try {
        const opened = isOutbound
          ? openOwnDirectMessage({
              mode: 'send',
              network: directory.network,
              payload: delivery.typed.payloadFrame.frame,
              context: record.context,
              roles,
              senderCurrent: self,
              senderEvidence,
              recipientCurrent: peer.current,
              recipientEvidence,
            })
          : openDirectMessage({
              mode: 'receive',
              network: directory.network,
              payload: delivery.typed.payloadFrame.frame,
              context: record.context,
              roles,
              senderCurrent: peer.current,
              senderEvidence,
              recipientCurrent: self,
              recipientEvidence,
            })
        if (opened.conversationId) {
          conversationIdStr = formatUuid(opened.conversationId)
        }
        conversationNameStr = opened.conversationName
        if (opened.messageId) {
          messageIdStr = formatUuid(opened.messageId)
        }
        items = receivedItems(
          registry,
          opened,
          params.wallet,
          isOutbound,
          record.timestampMs,
          // The message opened with this wallet's own key as its other party: its sender and
          // its recipient are both this wallet.
          isOwnSubject(owner, peerSubjectHex, peer.subject),
        )
      } catch (error) {
        // Tampered, stale-keyed or foreign ciphertext never reaches display or payment import.
        // A message whose items together exceed its limits is refused as a whole and for good.
        // So is one that fails at or after decryption: its sender, recipient, entries and keys
        // all matched what this wallet holds, so no later read can open it. A forged message,
        // also one addressed from this wallet to itself, ends here. Failures before decryption
        // (an entry or key this wallet could not look up yet) are left for a later read.
        if (
          error instanceof MessageItemBudgetExceededError ||
          (error instanceof DirectMessageError &&
            (error.code === 'crypto' ||
              error.code === 'network' ||
              error.code === 'digest'))
        )
          params.onQuarantinedTimestamp?.(record.timestampMs, digest)
        continue
      } finally {
        roles.dispose()
      }
      const paidHere = isOutbound
        ? deliveryTyped.payments
        : paymentsToSelf(
            directory.network,
            self,
            payload.sharedPoint,
            deliveryTyped.payments,
          )
      const stampPayments = paidHere.map(member => ({
        txHash: hexlify(member.transactionId),
        destinationAddress: getAddress(hexlify(member.address)),
        valueWei:
          typeof member.value === 'bigint'
            ? member.value
            : BigInt(hexlify(member.value)),
      }))
      const paymentTransfers = paidHere.map(member =>
        constructPaymentTransferFromMember(member, deliveryTyped.network),
      )
      const peerAddress: ChainAddress = {
        raw: getAddress(computeAddress('0x' + peer.subject)),
      }
      received.push({
        outbound: isOutbound,
        senderAddress: isOutbound ? own : peerAddress,
        senderPublicKey: isOutbound
          ? fromHex(owner.subject)
          : fromHex(peer.subject),
        recipientAddress: isOutbound ? peerAddress : own,
        recipientPublicKey: isOutbound
          ? fromHex(peer.subject)
          : fromHex(owner.subject),
        items,
        conversationId: conversationIdStr,
        ...(conversationNameStr === undefined
          ? {}
          : { conversationName: conversationNameStr }),
        messageId: messageIdStr,
        payloadDigest: digest,
        stampValueWei: stampPayments.reduce((sum, p) => sum + p.valueWei, 0n),
        stampPayments,
        paymentTransfers,
        receivedTime: record.timestampMs,
      })
    }
    cursor = page.nextCursor
    if (cursor === undefined) break
  }
  return received
}

/** The canonical implementation of the app-facing direct-message operations for one wallet. */
export function canonicalDirectMessages(
  owner: CanonicalMessagingOwner,
  defaultStampValueWei: bigint,
) {
  return {
    send: (params: Parameters<DirectMessageClient['send']>[0]) =>
      serial(owner.links, () => send(owner, params, defaultStampValueWei)),
    reconcileAttempts: async (
      params: Parameters<DirectMessageClient['reconcileAttempts']>[0],
    ) => {
      await recoverHistoricalDelivery(owner, params.payloadDigests)
      return serial(owner.links, async () => {
        const directory = requireDirectory(owner)
        await settle(owner, directory.fetch, params.maxPutAttempts ?? 1)
        return Object.fromEntries(
          params.payloadDigests.map(digest => [
            digest,
            statusOf(owner, digest),
          ]),
        )
      })
    },
    discardAttempt: (params: { payloadDigest: string }) =>
      serial(owner.links, async () => {
        const clean = (s?: string) =>
          s ? (s.startsWith('0x') ? s.slice(2).toLowerCase() : s.toLowerCase()) : ''
        const target = clean(params.payloadDigest)
        // Discard is presentation accounting, never cancellation of an exposed payment. A
        // pending record remains recoverable, including an unsigned intent awaiting its owner.
        await account(owner, row =>
          target === '*' ||
          target === 'all' ||
          clean(row.digest) === target ||
          clean(row.attemptRef) === target,
        )
      }),
    unattributedAttempts: (
      params: Parameters<DirectMessageClient['unattributedAttempts']>[0],
    ) =>
      serial(owner.links, async () => {
        const directory = requireDirectory(owner)
        await settle(owner, directory.fetch, 1)
        const known = new Set(params.knownDigests)
        // A message points at it: that is saved, so it stays accounted for if the message goes.
        await account(owner, row => known.has(row.digest))
        return owner.links
          .all()
          .filter(
            row =>
              !known.has(row.digest) &&
              // Unresolved and relay-ended attempts are always reported; see `account`.
              (row.outcome !== 'delivered' || !row.accounted),
          )
          .map(row => row.digest)
      }),
    resolveUnattributedAttempts: (
      params: Parameters<DirectMessageClient['resolveUnattributedAttempts']>[0],
    ) =>
      serial(owner.links, async () => {
        const answered = new Set(params.payloadDigests)
        await account(owner, row => answered.has(row.digest))
      }),
    fetchSince: (params: Parameters<DirectMessageClient['fetchSince']>[0]) =>
      fetchSince(owner, params),
    subscribeMailboxStream: (params: {
      wallet: WalletHandle
      onRecord: (record: DirectMessageReceived) => void
      onError?: (error: Error) => void
    }) => {
      const directory = requireDirectory(owner)
      const registry = requireMessageItems(owner)
      const auth = mailboxAuth(owner, directory)
      let active = true
      let streamHandle: { close: () => void } | undefined

      const connect = async () => {
        try {
          const self = await directory.selfCurrent()
          if (!active) return
          streamHandle = await connectCanonicalMailboxStream({
            ...auth,
            onRecord: async (record: CanonicalMailboxRecord) => {
              if (!active) return
              try {
                const delivery = parseFrame(record.delivery)
                if (delivery.kind !== 'parsed' || delivery.typed?.type !== 1)
                  return
                const deliveryTyped = delivery.typed
                const payload = deliveryTyped.payloadFrame.typed
                if (payload?.type !== 5) return
                const digest = toHex(deliveryTyped.payloadDigest)
                const isOutbound = record.direction === 'out'
                const peerSubjectKeyBytes = isOutbound
                  ? payload.recipient.keyBytes
                  : payload.sender.keyBytes
                const peerSubjectHex = toHex(peerSubjectKeyBytes)
                const peer = await directory.peerCurrent({
                  subject: peerSubjectHex,
                })
                if (!peer) return
                const { senderEvidence, recipientEvidence } =
                  await resolveHistoricalEvidence(
                    directory,
                    record.context,
                    isOutbound,
                    self,
                    owner.subject,
                    peer,
                  )
                const roles = owner.roles.create(directory.network, self)
                let items: MessageItem[]
                let conversationIdStr: string | undefined
                let conversationNameStr: string | undefined
                let messageIdStr: string | undefined
                try {
                  const opened = isOutbound
                    ? openOwnDirectMessage({
                        mode: 'send',
                        network: directory.network,
                        payload: delivery.typed.payloadFrame.frame,
                        context: record.context,
                        roles,
                        senderCurrent: self,
                        senderEvidence,
                        recipientCurrent: peer.current,
                        recipientEvidence,
                      })
                    : openDirectMessage({
                        mode: 'receive',
                        network: directory.network,
                        payload: delivery.typed.payloadFrame.frame,
                        context: record.context,
                        roles,
                        senderCurrent: peer.current,
                        senderEvidence,
                        recipientCurrent: self,
                        recipientEvidence,
                      })
                  if (opened.conversationId) {
                    conversationIdStr = formatUuid(opened.conversationId)
                  }
                  conversationNameStr = opened.conversationName
                  if (opened.messageId) {
                    messageIdStr = formatUuid(opened.messageId)
                  }
                  items = receivedItems(
                    registry,
                    opened,
                    params.wallet,
                    isOutbound,
                    record.timestampMs,
                    isOwnSubject(owner, peerSubjectHex, peer.subject),
                  )
                } finally {
                  roles.dispose()
                }
                const paidHere = isOutbound
                  ? deliveryTyped.payments
                  : paymentsToSelf(
                      directory.network,
                      self,
                      payload.sharedPoint,
                      deliveryTyped.payments,
                    )
                const stampPayments = paidHere.map(member => ({
                  txHash: hexlify(member.transactionId),
                  destinationAddress: getAddress(hexlify(member.address)),
                  valueWei:
                    typeof member.value === 'bigint'
                      ? member.value
                      : BigInt(hexlify(member.value)),
                }))
                const paymentTransfers = paidHere.map(member =>
                  constructPaymentTransferFromMember(
                    member,
                    deliveryTyped.network,
                  ),
                )
                const own: ChainAddress = {
                  raw: getAddress(owner.identityAddress),
                }
                const peerAddress: ChainAddress = {
                  raw: getAddress(computeAddress('0x' + peer.subject)),
                }
                params.onRecord({
                  outbound: isOutbound,
                  senderAddress: isOutbound ? own : peerAddress,
                  senderPublicKey: isOutbound
                    ? fromHex(owner.subject)
                    : fromHex(peer.subject),
                  recipientAddress: isOutbound ? peerAddress : own,
                  recipientPublicKey: isOutbound
                    ? fromHex(peer.subject)
                    : fromHex(owner.subject),
                  items,
                  conversationId: conversationIdStr,
                  ...(conversationNameStr === undefined
                    ? {}
                    : { conversationName: conversationNameStr }),
                  messageId: messageIdStr,
                  payloadDigest: digest,
                  stampValueWei: stampPayments.reduce(
                    (sum, p) => sum + p.valueWei,
                    0n,
                  ),
                  stampPayments,
                  paymentTransfers,
                  receivedTime: record.timestampMs,
                })
              } catch (err) {
                params.onError?.(
                  err instanceof Error ? err : new Error(String(err)),
                )
              }
            },
            onError: err => {
              params.onError?.(err)
            },
          })
        } catch (err) {
          if (active) {
            params.onError?.(
              err instanceof Error ? err : new Error(String(err)),
            )
          }
        }
      }

      void connect()

      return () => {
        active = false
        streamHandle?.close()
      }
    },
  }
}
