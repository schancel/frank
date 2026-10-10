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
import { Transaction, computeAddress, getAddress, getBytes, hexlify } from 'ethers'
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
  paymentTransferToStealthItem,
  projectStealthMessageItem,
  recipientPayloadDigest,
  toHex,
  type CanonicalStealthItem,
  type ChildFrame,
  type Encodable,
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
  freezeCanonicalRequest,
  installedCanonicalOrigin,
  restoreCanonicalRequest,
  submitCanonicalRequest,
  CanonicalTransportError,
  type CanonicalAcceptedBody,
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
  DirectMessageStampBelowFeeError,
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
} from '../monad-stamp-client'
import type { EvmStampPayer, StampClaim } from '../evm-stamp-payer'
import { inspectCanonicalPreparedEnvelope } from '../monad-stamp-stealth'
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
      'Your relay could not deliver to the relay this address lives on. This message was not sent and nothing was paid.',
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

/** No wallet state raises this any more: a message is never held behind another one. The class
 * remains only because hosts still import it; delete it with their imports. */
export class CanonicalMessagingHoldError extends Error {
  readonly cause?: unknown
  constructor(
    message = 'An earlier canonical payment record cannot be matched to a saved message.',
    cause?: unknown,
  ) {
    super(message)
    this.name = 'CanonicalMessagingHoldError'
    if (cause !== undefined) this.cause = cause
  }
}

/** What the wallet knows of one signed stamp payment of a stored message. */
export interface StoredPayment {
  /** The coin it spends: a funded sub-account of the pool (with its index), the main account or
   * the identity account; and that account's address. */
  source: 'pool' | 'main' | 'identity'
  index?: number
  address: string
  /** The exact signed bytes. The same bytes are re-sent; nothing is ever signed again. */
  rawTx: string
  /**
   * - `pending`: signed; the chain has not shown what became of it. Its account stays claimed.
   * - `spent` / `reverted`: the chain shows it in a block (a revert consumes the nonce too).
   * - `failed`: the chain shows the account's nonce consumed by another transaction, so this
   *   payment can never land. It is never paid again.
   * - `unsent`: the relay refused the message for good before it stored or broadcast anything,
   *   so these bytes never reached anything that could broadcast them. They are dropped
   *   (`rawTx` is empty) and the coin was freed at once.
   */
  state: 'pending' | 'spent' | 'reverted' | 'failed' | 'unsent'
}

/**
 * One paid message this wallet sent, with everything needed to finish it: the complete encrypted
 * message and its signed payments, exactly as they were first handed out. This row is the whole
 * record of the send. It is written, durably, before any byte reaches a relay or a node, and the
 * accounts it pays from are claimed for as long as a payment in it is `pending`.
 */
export interface StoredMessage {
  version: 1
  /** `frank-dm:<message ID>`: the row's key. A message ID has one row, so one payment, ever. */
  consumerId: string
  digest: string
  /** The compressed signing key (hex) the message was sealed to. */
  recipientSubject: string
  /** The exact relay request. Kept until the relay has answered for it. */
  request?: { body: string; contentType: string }
  payments: StoredPayment[]
  /** `delivered`: the relay stored this exact message. `dead`: the relay refused it for good
   * (`reason`) and stored nothing. Absent: not known yet; it is re-sent until it is. */
  outcome?: 'delivered' | 'dead'
  reason?: string
  /** A host message points at this attempt, or the user answered for it. */
  accounted?: boolean
  createdAt: number
}

/** The wallet's sent messages. Per wallet: never shared with another wallet on the same coins. */
export interface OutgoingMessageStore {
  all(): StoredMessage[]
  get(consumerId: string): StoredMessage | undefined
  put(row: StoredMessage): Promise<void>
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
  /** The multipart boundary of the request as first sent. The relay recognises a repeat by the
   * request's exact bytes (content type and body): the same envelope under another boundary is
   * answered 409, not `delivered`, so a repeat is framed with this one. The boundary is the only
   * part of the request that is not fixed by the envelope. A record without it, written by
   * earlier code, cannot be repeated exactly and is not used: the message is sealed again. */
  boundary: string
}
export class MemoryOutgoingMessageStore implements OutgoingMessageStore {
  private readonly rows = new Map<string, StoredMessage>()
  all(): StoredMessage[] {
    return [...this.rows.values()]
  }
  get(consumerId: string): StoredMessage | undefined {
    return this.rows.get(consumerId)
  }
  async put(row: StoredMessage): Promise<void> {
    this.rows.set(row.consumerId, { ...row })
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
/** Development reset: this directory holds only sent-message records, never a key. Deleting it
 * (with the wallet closed) forgets unfinished sends; funded accounts stay derivable from the
 * seed. The earlier `canonical-dm-workflow-links` directory is no longer read. */
export const OUTGOING_MESSAGE_NAMESPACE = 'outgoing-messages-v1'
export class LevelOutgoingMessageStore implements OutgoingMessageStore {
  private readonly rows = new Map<string, StoredMessage>()
  private constructor(private readonly db: LevelDB) {}
  static async open(location: string): Promise<LevelOutgoingMessageStore> {
    const database = level(join(location, OUTGOING_MESSAGE_NAMESPACE))
    try {
      await openDurableLevel(database, location, OUTGOING_MESSAGE_NAMESPACE)
      const store = new LevelOutgoingMessageStore(database)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const [key, value] of store.db.iterator({}) as any) {
        if (String(key).startsWith(UNPAID_PREFIX)) {
          store.envelopes.set(
            String(key).slice(UNPAID_PREFIX.length),
            JSON.parse(value) as UnpaidEnvelope,
          )
          continue
        }
        const row = JSON.parse(value) as StoredMessage
        if (row.version !== 1 || row.consumerId !== key)
          throw new Error(
            `Unsupported sent-message record in ${OUTGOING_MESSAGE_NAMESPACE}. Development reset: close the wallet and delete that directory (it holds no keys).`,
          )
        store.rows.set(row.consumerId, row)
      }
      return store
    } catch (error) {
      await database.close()
      throw error
    }
  }
  all(): StoredMessage[] {
    return [...this.rows.values()]
  }
  get(consumerId: string): StoredMessage | undefined {
    return this.rows.get(consumerId)
  }
  /** Resolves once the row is on stable storage. */
  async put(row: StoredMessage): Promise<void> {
    await durablePut(this.db, row.consumerId, JSON.stringify(row))
    this.rows.set(row.consumerId, { ...row })
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
  readonly installedNetworkTag: 'MONT' | 'MON1' | 'MONR'
  /** The native chain ID stamp payments are signed for. */
  readonly chainId: bigint
  /** The wallet's installed relay origin; messages are submitted only there. */
  readonly relayBaseUrl: string
  readonly identityAddress: string
  readonly subject: string
  readonly roles: MonadCanonicalRoleOwner
  /** This wallet's sent messages. */
  readonly messages: OutgoingMessageStore
  /** The coins this wallet pays from. Several wallets may be given the same one. */
  payer(): EvmStampPayer
  signDigest(digest: Uint8Array): Uint8Array
  /** Runs `operation` as part of the open wallet: close waits for it. Not a queue. */
  lifetime<T>(operation: () => Promise<T>): Promise<T>
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
/** Messages whose sender could not be checked yet: digest -> when that was first seen. */
const unreadable = new WeakMap<object, Map<string, number>>()
const UNREADABLE_RETRY_MS = 24 * 60 * 60_000
const MAX_UNREADABLE = 1024


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

const consumerOf = (messageId: Uint8Array) => `frank-dm:${toHex(messageId)}`
/** The claim holder of one message: unique across every wallet that shares the same coins. */
const holderOf = (owner: CanonicalMessagingOwner, consumerId: string) =>
  `${owner.subject}:${consumerId}`
const isPending = (payment: StoredPayment) => payment.state === 'pending'
/** Delivery or payment is not known to be finished: the resend pass still has work on it. */
const isUnresolved = (row: StoredMessage) =>
  row.outcome === undefined || row.payments.some(isPending)

/**
 * What this process is doing with each message, by `consumerId`. Process memory only.
 * - `creating`: a `send` for this message ID is before its durable record; a second `send` of the
 *   same ID waits for it and then answers with the original.
 * - `unrecorded`: the record's write failed, so whether it is on disk is unknown. This ID is
 *   refused for the rest of the session and its accounts stay claimed; a restart decides.
 * - `busy`: one step (a submit, a look at the chain) is in flight for this row, settling when it
 *   ends; a second pass
 *   leaves the row alone instead of repeating the step.
 * - `submit` / `chain`: how often the background pass has come by, and when it acts next.
 */
interface MessageWork {
  creating?: Promise<void>
  unrecorded?: boolean
  busy?: Promise<void>
  submit: Pace
  chain: Pace
}
interface Pace {
  passes: number
  next: number
  gap: number
}
const works = new WeakMap<object, Map<string, MessageWork>>()
function workOf(owner: CanonicalMessagingOwner, consumerId: string): MessageWork {
  let map = works.get(owner.messages)
  if (!map) works.set(owner.messages, (map = new Map()))
  let work = map.get(consumerId)
  if (!work) {
    work = {
      submit: { passes: 0, next: 1, gap: 0 },
      chain: { passes: 0, next: 1, gap: 0 },
    }
    map.set(consumerId, work)
  }
  return work
}
/** The background pass comes by on every host tick. A step that keeps finding nothing new is
 * taken on the 1st, 2nd, 4th, 8th pass and then every `every`-th: bounded work for a message
 * that stays stuck, without ever giving it up. A caller's explicit retry always acts. */
function due(pace: Pace, every: number, always: boolean): boolean {
  pace.passes++
  if (!always && pace.passes < pace.next) return false
  pace.gap = Math.min(Math.max(pace.gap * 2, 1), every)
  pace.next = pace.passes + pace.gap
  return true
}
const SUBMIT_EVERY = 8
const CHAIN_EVERY = 8

function statusOf(
  owner: CanonicalMessagingOwner,
  digest: string,
): DirectMessageAttemptStatus {
  const row = owner.messages.all().find(r => r.digest === digest)
  if (!row) return 'unknown'
  return row.outcome ?? 'live'
}

/** Durably marks delivered attempts as accounted for. An attempt with no outcome is never marked:
 * it may still be delivered, so it has to stay reported. One the relay ended is never marked
 * either: its signed payments are still kept. */
async function account(
  owner: CanonicalMessagingOwner,
  matches: (row: StoredMessage) => boolean,
): Promise<void> {
  for (const row of owner.messages.all())
    if (row.outcome === 'delivered' && !row.accounted && matches(row))
      await owner.messages.put({
        ...owner.messages.get(row.consumerId)!,
        accounted: true,
      })
}

/** Errors that left a `send` at or after its payment was being prepared. Error objects get
 * reused (a directory or the wallet may throw one it kept), so such an object is never reported
 * as not attempted afterwards, by any send, whichever refusal it comes from. */
const possiblyAttemptedErrors = new WeakSet<object>()

/** Labels the error of one `send` call refused before its payment was prepared and returns the
 * same object. The label is about that call only: it claimed, funded, signed, stored and
 * submitted nothing. Only the labelled object itself answers, not one that inherits from it or
 * wraps it. An error that cannot take the label is returned as it is. */
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
    | 'senderCurrent'
    | 'recipientCurrent'
    | 'messageId'
    | 'conversationId'
    | 'conversationName'
    | 'items'
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
  const boundary = `frank-${toHex(randomBytes(24))}`
  return {
    digest: toHex(digest),
    delivery,
    context: sealed.context,
    boundary,
    request: freezeCanonicalRequest(
      { delivery, context: sealed.context, transactions: [] },
      boundary,
    ),
  }
}

/** The relay request of one paid message: the delivery envelope naming each signed payment, the
 * context, and the payments' bytes, frozen exactly as they will be sent every time. */
function freezePaidMessage(
  network: string,
  sealed: { payload: Uint8Array; context: Uint8Array },
  digest: Uint8Array,
  rawTransactions: readonly string[],
) {
  const inspected = inspectCanonicalPreparedEnvelope(
    sealed.payload,
    sealed.context,
  )
  const payments = rawTransactions.map((rawTx, i) => {
    const tx = Transaction.from(rawTx)
    const entries: [number, Encodable][] = [
      [0, i],
      [1, getBytes(tx.hash!)],
      [2, getBytes('0x' + tx.value.toString(16).padStart(64, '0'))],
      [3, getBytes(tx.to!)],
      [4, paymentCommitment(digest, i)],
      [6, getBytes(rawTx)],
    ]
    return cborMap(entries)
  })
  const delivery = encodeFrame(
    { typeId: 1, schemaVersion: 1, minReaderVersion: 1 },
    cborMap([
      [0, network],
      [
        1,
        cborMap([
          [0, 1],
          [1, inspected.stampKey.keyBytes],
        ]),
      ],
      [2, sealed.payload],
      [3, digest],
      [4, payments],
      [
        5,
        cborMap([
          [0, inspected.payload.recipient.keyType],
          [1, inspected.payload.recipient.keyBytes],
        ]),
      ],
      [6, inspected.payload.dleqProof],
    ]),
  )
  return freezeCanonicalRequest(
    {
      delivery,
      context: sealed.context,
      transactions: rawTransactions.map(rawTx => getBytes(rawTx)),
    },
    `frank-${toHex(randomBytes(24))}`,
  )
}

/**
 * Hands one stored message to the relay, the same bytes every time, and saves the relay's
 * answer. Returns the row as it now stands. A request that fails or is not answered changes
 * nothing: the outcome is unknown and the message is submitted again later.
 */
async function submitStored(
  owner: CanonicalMessagingOwner,
  directory: CanonicalDirectory,
  row: StoredMessage,
): Promise<{ row: StoredMessage; error?: unknown }> {
  if (row.outcome !== undefined || row.request === undefined) return { row }
  let accepted: CanonicalAcceptedBody
  try {
    accepted = await submitCanonicalRequest({
      installedRelayOrigin: owner.relayBaseUrl,
      expectedNetworkTag: owner.installedNetworkTag,
      request: restoreCanonicalRequest({
        body: fromHex(row.request.body),
        contentType: row.request.contentType,
      }),
      fetch: directory.fetch,
    })
  } catch (error) {
    // The relay's own "this request is not acceptable": nothing was stored and nothing was
    // broadcast, and sending the same bytes again can never succeed.
    if (
      error instanceof CanonicalTransportError &&
      error.status !== undefined &&
      REFUSED_FOR_GOOD.has(error.status)
    )
      return {
        row: await refuseUnexposed(owner, row, `refused_${error.status}`),
        error,
      }
    return { row, error }
  }
  // An older relay's "kept, not delivered yet" is not an answer: submit again later.
  if (accepted.phase === 'retained') return { row }
  if (accepted.phase === 'dead' && DEAD_BEFORE_EXPOSURE.has(accepted.reason))
    return { row: await refuseUnexposed(owner, row, accepted.reason) }
  // The relay has answered for these exact bytes: the request body has done its work.
  const { request: _request, ...kept } = owner.messages.get(row.consumerId)!
  const answered: StoredMessage =
    accepted.phase === 'delivered'
      ? { ...kept, outcome: 'delivered' }
      : { ...kept, outcome: 'dead', reason: accepted.reason }
  await owner.messages.put(answered)
  return { row: answered }
}

/** HTTP answers that refuse the request itself: malformed, too large, unprocessable. */
const REFUSED_FOR_GOOD = new Set([400, 413, 422])
/** `dead` reasons the relay decides before it stores or broadcasts anything. Every other dead
 * reason may follow a broadcast, so its payments stay claimed until the chain decides. */
const DEAD_BEFORE_EXPOSURE = new Set<string>(['undeliverable', 'sender_unpublished'])

/**
 * The relay refused this message for good, before anything could broadcast its payments. The
 * message is failed, its signed bytes are dropped, and every coin it claimed is free again:
 * nothing was exposed, so nothing waits for the chain. The record is written first, the claims
 * released after.
 */
async function refuseUnexposed(
  owner: CanonicalMessagingOwner,
  row: StoredMessage,
  reason: string,
): Promise<StoredMessage> {
  const { request: _request, ...kept } = owner.messages.get(row.consumerId)!
  const refused: StoredMessage = {
    ...kept,
    outcome: 'dead',
    reason,
    payments: kept.payments.map(payment =>
      payment.state === 'pending'
        ? { ...payment, rawTx: '', state: 'unsent' }
        : payment,
    ),
  }
  await owner.messages.put(refused)
  const holder = holderOf(owner, row.consumerId)
  for (const payment of row.payments)
    if (payment.state === 'pending') owner.payer().releasePayment(holder, payment)
  return refused
}

/** How long a payment must keep looking replaced (nonce consumed, no receipt) before it is
 * recorded as failed: a node that lags shows a landed payment the same way for a while. */
export const REPLACED_AFTER_MS = { value: 60_000 }
/** Payment transaction hash -> when it first looked replaced. Process memory. */
const replacedSince = new Map<string, number>()

/**
 * One look at the chain for every payment of `row` that is still pending, and the only place a
 * claimed account is let go after its signed bytes left the wallet: on what the chain shows.
 * With `broadcast` (the relay has confirmed it stored the message) a payment the chain has not
 * seen is handed to the chain again, the same bytes. Before the relay has the message this
 * wallet never broadcasts: a payment that lands for a message nobody can fetch is burned.
 */
async function settlePayments(
  owner: CanonicalMessagingOwner,
  row: StoredMessage,
  broadcast: boolean,
): Promise<StoredMessage> {
  const payer = owner.payer()
  const holder = holderOf(owner, row.consumerId)
  const states = await Promise.all(
    row.payments.map(async (payment): Promise<StoredPayment['state']> => {
      if (payment.state !== 'pending') return payment.state
      try {
        const seen = await payer.observe(payment.rawTx)
        if (seen.state === 'included') {
          await payer.recordSpent(holder, payment)
          return seen.reverted ? 'reverted' : 'spent'
        }
        if (seen.state === 'replaced') {
          const since = replacedSince.get(payment.rawTx) ?? Date.now()
          replacedSince.set(payment.rawTx, since)
          if (Date.now() - since < REPLACED_AFTER_MS.value) return 'pending'
          await payer.recordFailed(holder, payment)
          return 'failed'
        }
        replacedSince.delete(payment.rawTx)
        if (broadcast) await payer.broadcast(payment.rawTx)
      } catch {
        // The chain could not be read or reached: nothing is known, so nothing changes.
      }
      return 'pending'
    }),
  )
  if (states.every((state, i) => state === row.payments[i].state)) return row
  const next: StoredMessage = {
    ...owner.messages.get(row.consumerId)!,
    payments: row.payments.map((payment, i) => ({
      ...payment,
      state: states[i],
    })),
  }
  // The record first, the claim after: until the record says what became of a payment, its
  // claim is what keeps the coin from a second spender, across a crash too.
  await owner.messages.put(next)
  row.payments.forEach((payment, i) => {
    if (states[i] !== 'pending') {
      replacedSince.delete(payment.rawTx)
      payer.releasePayment(holder, payment)
    }
  })
  return next
}

/**
 * One look at the chain, and only the chain, for the one message that holds a coin another
 * operation is waiting for. `holder` is the claim's holder; anything that is not an unsettled
 * message of this wallet is left alone. No relay request is made.
 */
async function settleHolder(
  owner: CanonicalMessagingOwner,
  holder: string,
): Promise<void> {
  const prefix = `${owner.subject}:`
  if (!holder.startsWith(prefix)) return
  const consumerId = holder.slice(prefix.length)
  const row = owner.messages.get(consumerId)
  if (!row || !row.payments.some(isPending)) return
  const work = workOf(owner, consumerId)
  if (work.creating) return
  if (work.busy) return void (await work.busy)
  let ended!: () => void
  work.busy = new Promise<void>(resolve => (ended = resolve))
  try {
    await settlePayments(owner, row, row.outcome === 'delivered')
  } finally {
    work.busy = undefined
    ended()
  }
}

/**
 * The resend queue: the only queue there is. Every stored message whose delivery or payment is
 * not known to be finished is driven one step further, each on its own and all at once; a message
 * that cannot make progress holds nothing else back. Hosts call this on their tick. With nothing
 * unresolved it makes no request.
 *
 * - Not delivered: the exact stored message is submitted again. Never a new payment.
 * - Payments pending: the chain is asked what became of them. Included means spent; a nonce
 *   consumed otherwise means failed, recorded and never re-paid. A delivered message's unseen
 *   payments are broadcast again; an undelivered message's are only looked for (the relay may
 *   have broadcast them before its answer was lost).
 */
async function resend(
  owner: CanonicalMessagingOwner,
  directory: CanonicalDirectory,
  options: { digests?: ReadonlySet<string>; now?: boolean } = {},
): Promise<void> {
  await Promise.all(
    owner.messages
      .all()
      .filter(isUnresolved)
      .map(async stored => {
        const work = workOf(owner, stored.consumerId)
        if (work.creating) return
        if (work.busy) {
          // A caller that asked about this message waits for the step in flight, so the status
          // it reads is the one that step leaves. Nobody else waits on it.
          if (options.digests?.has(stored.digest)) await work.busy
          return
        }
        let ended!: () => void
        work.busy = new Promise<void>(resolve => (ended = resolve))
        try {
          const now =
            options.now === true &&
            options.digests?.has(stored.digest) !== false
          let row = owner.messages.get(stored.consumerId)!
          if (row.outcome === undefined && due(work.submit, SUBMIT_EVERY, now)) {
            const submitted = await submitStored(owner, directory, row)
            if (submitted.error)
              console.warn(
                '[monad-canonical-dm] resend failed; the same message is sent again later:',
                submitted.error,
              )
            row = submitted.row
            // Just delivered: its payments are broadcast in this same pass.
            if (row.outcome === 'delivered')
              work.chain = { passes: 0, next: 1, gap: 0 }
          }
          if (
            row.payments.some(isPending) &&
            due(work.chain, CHAIN_EVERY, now)
          ) {
            const settled = await settlePayments(
              owner,
              row,
              row.outcome === 'delivered',
            )
            if (settled !== row) work.chain = { passes: 0, next: 1, gap: 0 }
          }
        } finally {
          work.busy = undefined
          ended()
          // Finished: nothing is remembered about it in memory any more.
          const row = owner.messages.get(stored.consumerId)
          if (row && !isUnresolved(row))
            works.get(owner.messages)?.delete(stored.consumerId)
        }
      }),
  )
}

/** At open, before the wallet is handed out: the accounts every stored message with a pending
 * payment pays from are claimed again, so nothing else selects them. Synchronous, no request. */
export function restoreOutgoingClaims(owner: CanonicalMessagingOwner): void {
  const payer = owner.payer()
  for (const row of owner.messages.all()) {
    const pending = row.payments.filter(isPending)
    if (pending.length === 0) continue
    // Two records naming one coin must never stop the wallet from opening: the first keeps the
    // claim, both stay in the resend pass, and the chain says which payment landed.
    const contested = payer.restore(holderOf(owner, row.consumerId), pending)
    if (contested.length > 0)
      console.warn(
        `[monad-canonical-dm] sent message ${row.digest} names ${contested.join(
          ', ',
        )}, which another unsettled message also pays from. Both are kept; the chain decides.`,
      )
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
  const messageId = suppliedId('messageId') ?? randomBytes(16)
  const consumerId = consumerOf(messageId)
  let work = workOf(owner, consumerId)
  // The repeat rule, before the directory or anything else that can refuse or act: a message ID
  // that already has a payment attempt is never given a second one. Its record is the row keyed
  // by the ID, written before anything is handed out and never deleted; one here means an
  // attempt exists, and the answer is the original. A send of the same ID that is still on its
  // way to that record is waited for (this ID only; no other message waits on anything).
  for (;;) {
    const original = owner.messages.get(consumerId)
    if (original)
      throw new DirectMessageAlreadyAttemptedError(
        formatUuid(messageId),
        original.digest,
        original.recipientSubject,
      )
    // Its record's write failed: whether it is on disk is unknown, so never a second payment.
    if (work.unrecorded)
      throw new DirectMessageAttemptUnlinkedError(formatUuid(messageId))
    if (!work.creating) break
    await work.creating
    work = workOf(owner, consumerId)
  }
  let created!: () => void
  work.creating = new Promise<void>(resolve => (created = resolve))
  const holder = holderOf(owner, consumerId)
  const payer = owner.payer()
  let attempted = false
  let claim: StampClaim | undefined
  let recorded = false
  try {
    const directory = requireDirectory(owner)
    // Encoded before anything is claimed, funded or stored: an unregistered type, an item its
    // plugin refuses, or a set of items a reader would refuse rejects here, labelled as not
    // attempted. Nothing was paid or sent.
    // Whether this wallet is writing to itself is all the item rule is told; which items that
    // permits is the rule's own business.
    const selfAddressed =
      params.recipient.raw.toLowerCase() === owner.identityAddress.toLowerCase()
    const items = encodeItemFrames(requireMessageItems(owner), params.items, {
      selfAddressed,
    })
    let stampValueWei = params.stampValue ?? defaultStampValueWei
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
    // One conversation ID and one subject for this message, paid or not. A caller that named no
    // conversation gets the one this account opens with this recipient.
    const conversationId =
      conversationIdBytes ??
      allocateOpeningConversationId(
        owner.roles.conversationIdSalt(),
        params.recipient.raw.toLowerCase(),
      )
    const conversationName =
      params.conversationName === undefined
        ? {}
        : { conversationName: params.conversationName }
    if (stampValueWei === 0n) {
      // No stamp: the message is sealed and handed to the relay. No account is funded or
      // reserved, no coin is claimed, and no paid message is waited for or touched: like every send, it
      // runs on its own.
      //
      // A caller that names the message (`messageId`) may send it again after any failure, and
      // the relay may already hold the first copy. So the sealed envelope is kept, durably,
      // from before it is handed over until the relay says what became of it, and a repeat
      // sends those same bytes: every copy has the one payload digest.
      const name =
        params.messageId !== undefined ? toHex(messageId) : undefined
      const stored = name ? owner.messages.unpaid(name) : undefined
      // An envelope kept before the request's boundary was recorded cannot be repeated as the
      // same bytes: it is sealed afresh.
      const kept = stored?.boundary ? stored : undefined
      if (kept && kept.recipientSubject !== peer.subject)
        throw new DirectMessageArgumentError('messageId')
      let request: ReturnType<typeof freezeCanonicalRequest>
      let digest: string
      if (kept) {
        digest = kept.digest
        request = freezeCanonicalRequest(
          {
            delivery: fromHex(kept.delivery),
            context: fromHex(kept.context),
            transactions: [],
          },
          kept.boundary,
        )
      } else {
        const unpaid = sealUnpaid(owner, directory, {
          senderCurrent: await directory.selfCurrent(),
          recipientCurrent: peer.current,
          messageId,
          // Sealed into the kept envelope, so a repeat resends these same bytes: a stored
          // envelope's conversation ID and subject are never recomputed or changed.
          conversationId,
          ...conversationName,
          items,
        })
        digest = unpaid.digest
        request = unpaid.request
        if (name)
          await owner.messages.setUnpaid(name, {
            digest,
            delivery: toHex(unpaid.delivery),
            context: toHex(unpaid.context),
            recipientSubject: peer.subject,
            boundary: unpaid.boundary,
          })
      }
      // The caller learns the message's digest, durably on its side, BEFORE the relay is handed
      // a byte: a free message has no payment attempt to announce it.
      await params.onBeforeExposure?.(digest)
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
        if (name) await owner.messages.setUnpaid(name, undefined)
        if (accepted.reason === 'undeliverable')
          throw new CanonicalRecipientUndeliverableError()
        if (accepted.reason === 'sender_unpublished')
          throw new CanonicalSenderUnpublishedError()
        throw new UnpaidDirectMessageNotDeliveredError(accepted.reason)
      }
      // Anything but delivered is the caller's error to act on; the envelope stays for its repeat.
      if (accepted.phase !== 'delivered')
        throw new UnpaidDirectMessageNotDeliveredError(accepted.phase)
      if (name) await owner.messages.setUnpaid(name, undefined)
      return {
        payloadDigest: digest,
        stampValueWei: 0n,
        stampPayments: [],
        paymentTransfers: [],
        preparationTxHashes: [],
      }
    }
    if (stampValueWei <= 0n || stampValueWei >= 1n << 256n)
      throw new Error('canonical-wallet:economics-invalid')
    // A paid stamp is never smaller than what the chain charges to move it. The wallet's own
    // default is raised to that; an amount the caller chose is refused, not changed.
    const floorWei = await owner.lifetime(() => payer.minimumPaymentWei())
    if (stampValueWei < floorWei) {
      if (params.stampValue !== undefined)
        throw new DirectMessageStampBelowFeeError(stampValueWei, floorWei)
      stampValueWei = floorWei
    }
    // This message's own paying coins: claimed in one synchronous step, so no other message,
    // topic or native send being built at this moment can be given them. Nothing is funded.
    // From here a rejection is never labelled.
    attempted = true
    claim = await owner.lifetime(() =>
      payer.claim({
        holder,
        stampValueWei,
        // The only coin that could pay is spent by an earlier payment: this send waits its
        // turn, and meanwhile asks the chain about that one payment (never the relay).
        whileBusy: busyHolder => settleHolder(owner, busyHolder),
        onWaiting: () => params.onPreparationProgress?.({ stage: 'checking' }),
      }),
    )
    // Fresh snapshots after any wait: the message is sealed to the Current pair in force.
    const senderCurrent = await directory.selfCurrent()
    const recipient = await directory.peerCurrent({ subject: peer.subject })
    if (!recipient)
      throw new CanonicalRecipientNotPublishedError(params.recipient.raw)
    const roles = owner.roles.create(directory.network, senderCurrent)
    let sealed
    try {
      sealed = prepareDirectMessage({
        network: directory.network,
        senderCurrent,
        recipientCurrent: recipient.current,
        messageId,
        conversationId,
        ...conversationName,
        items,
        roles,
      })
    } finally {
      roles.dispose()
    }
    const digestBytes = recipientPayloadDigest(directory.network, sealed.payload)
    const digest = toHex(digestBytes)
    const payload = parseFrame(sealed.payload)
    if (payload.kind !== 'parsed' || payload.typed?.type !== 5)
      throw new Error('canonical-wallet:payload-required')
    const sharedPoint = payload.typed.sharedPoint
    const stampKey = {
      keyType: 1,
      keyBytes: new Uint8Array(recipient.current.stampKey.keyBytes),
    }
    const signed = await payer.sign(claim, owner.chainId, childIndex =>
      hexlify(
        canonicalStampDestination({
          network: directory.network,
          stampKey,
          sharedPoint,
          childIndex,
        }).address,
      ),
    )
    // Before the record (and so before any durable row from which these bytes could later be
    // submitted): the caller learns the digest of what is about to become sendable. If it
    // refuses, nothing signed leaves the wallet and the coins are free again.
    await params.onBeforeExposure?.(digest)
    const request = freezePaidMessage(
      directory.network,
      sealed,
      digestBytes,
      signed.map(payment => payment.rawTx),
    )
    // The complete message and its signed payments are on stable storage before any byte is
    // handed to anything that can broadcast. From here only these bytes are ever sent for it.
    let row: StoredMessage = {
      version: 1,
      consumerId,
      digest,
      recipientSubject: toHex(payload.typed.recipient.keyBytes),
      request: { body: toHex(request.body), contentType: request.contentType },
      payments: signed.map(payment => ({ ...payment, state: 'pending' })),
      createdAt: Date.now(),
    }
    try {
      await owner.lifetime(() => owner.messages.put(row))
    } catch (error) {
      // Not known to be on disk, not known to be absent. Nothing was handed out; the accounts
      // stay claimed for this session and this ID is not attempted again in it.
      work.unrecorded = true
      recorded = true
      throw error
    }
    recorded = true
    let ended!: () => void
    work.busy = new Promise<void>(resolve => (ended = resolve))
    work.creating = undefined
    created()
    try {
      await params.onAttemptCreated?.(digest)
      const submitted = await owner.lifetime(() =>
        submitStored(owner, directory, row),
      )
      row = submitted.row
      if (row.outcome === 'dead') {
        if (row.reason === 'undeliverable')
          throw new CanonicalRecipientUndeliverableError()
        if (row.reason === 'sender_unpublished')
          throw new CanonicalSenderUnpublishedError()
        throw new MonadStampTerminalError(
          row.payments.some(isPending)
            ? `The relay ended this payment set (${row.reason ?? 'no reason given'}); it can never be delivered. Its payments stay claimed until the chain shows what became of them.`
            : `The relay refused this message (${row.reason ?? 'no reason given'}). It was not sent and nothing was paid.`,
          422,
          'mailbox_terminal',
          undefined,
          row.reason,
        )
      }
      // No answer: the relay may or may not hold the message. This wallet broadcasts nothing;
      // the stored message is submitted again by the resend pass.
      if (row.outcome !== 'delivered') {
        if (submitted.error)
          console.warn(
            '[monad-canonical-dm] submit failed; the same message is sent again later:',
            submitted.error,
          )
        throw new MonadStampPendingAttemptError([digest])
      }
      // The relay has the message. Now, and only now, this wallet broadcasts the payments
      // itself as well; the relay does the same, so the usual answer is "already known".
      // "Spent" is learned from the chain by the resend pass, never from either answer.
      await owner.lifetime(() =>
        Promise.all(
          signed.map(payment =>
            payer.broadcast(payment.rawTx).catch(error => {
              console.warn(
                '[monad-canonical-dm] own broadcast failed; it is repeated until the chain shows the payment:',
                error,
              )
            }),
          ),
        ),
      )
      // A payment from the main or identity account holds that account for the next payment:
      // one look at the chain now, so a block that already has it frees the account at once.
      if (signed.some(payment => payment.source !== 'pool'))
        row = await owner
          .lifetime(() => settlePayments(owner, row, true))
          .catch(() => row)
    } finally {
      work.busy = undefined
      ended()
    }
    const transactions = signed.map(payment => getBytes(payment.rawTx))
    return {
      payloadDigest: digest,
      stampValueWei,
      stampPayments: payments(transactions),
      paymentTransfers: constructStampPaymentTransfers({
        networkTag: directory.network,
        transactions,
      }),
      // A send funds nothing: its stamp is paid from coins the wallet already has.
      preparationTxHashes: [],
    }
  } catch (error) {
    // Nothing signed left the wallet and nothing is stored: the accounts are free at once.
    if (!recorded) payer.release(holder)
    throw attempted ? possiblyAttempted(error) : notAttempted(error)
  } finally {
    if (work.creating) {
      work.creating = undefined
      created()
    }
    // Nothing stored and nothing in doubt, or stored and finished: forget the bookkeeping.
    const row = owner.messages.get(consumerId)
    if (row ? !isUnresolved(row) : !work.unrecorded)
      works.get(owner.messages)?.delete(consumerId)
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
  // A received stealth payment becomes a coin where the wallet reads its mailbox
  // (`recordReceivedCoins` in monad-chain.ts), from the decoded item. Nothing is done here.
  return decodeItemFrames(registry, opened.items, opened.itemBudget, {
    selfAddressed,
  })
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
        const waiting = unreadable.get(owner.messages) ?? new Map<string, number>()
        unreadable.set(owner.messages, waiting)
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
      unreadable.get(owner.messages)?.delete(digest)
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
        childIndex: member.childIndex,
        ...(member.rawTx ? { rawTx: hexlify(member.rawTx) } : {}),
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
        stampSharedPoint: toHex(payload.sharedPoint),
        paymentTransfers,
        receivedTime: record.timestampMs,
      })
    }
    cursor = page.nextCursor
    if (cursor === undefined) break
  }
  // Stopped at the page limit with more to read: said so, like any other cut-off read, so no
  // caller takes this for the whole mailbox. The last timestamp may continue on the next page,
  // so its records are left for the next read (which starts after the last complete one),
  // unless that would leave nothing to advance on.
  if (cursor !== undefined) {
    const last = received.reduce(
      (latest, message) => Math.max(latest, message.receivedTime ?? 0),
      0,
    )
    const complete = received.filter(
      message => (message.receivedTime ?? 0) < last,
    )
    params.onTruncated?.(
      new Error(`The mailbox read stopped after ${MAX_INBOX_PAGES} pages`),
    )
    if (complete.length > 0) return complete
  }
  return received
}

/** The canonical implementation of the app-facing direct-message operations for one wallet.
 * Nothing here queues: every send does its own work and holds no lock over a network wait. */
export function canonicalDirectMessages(
  owner: CanonicalMessagingOwner,
  defaultStampValueWei: bigint,
) {
  return {
    send: (params: Parameters<DirectMessageClient['send']>[0]) =>
      send(owner, params, defaultStampValueWei),
    /**
     * The host's tick. Drives every unresolved message of this wallet one step (see `resend`),
     * whichever digests are named, and answers for the named ones. `maxPutAttempts` above 1 is
     * a person asking now: the named messages are acted on at once instead of on their turn.
     */
    reconcileAttempts: async (
      params: Parameters<DirectMessageClient['reconcileAttempts']>[0],
    ) => {
      const directory = requireDirectory(owner)
      await owner.lifetime(() =>
        resend(owner, directory, {
          digests: new Set(params.payloadDigests),
          now: (params.maxPutAttempts ?? 1) > 1,
        }),
      )
      return Object.fromEntries(
        params.payloadDigests.map(digest => [digest, statusOf(owner, digest)]),
      )
    },
    /** One look at the chain for the message that holds a coin another operation is waiting
     * for (a native send waiting for the main account). No relay request. */
    settleHolder: (holder: string) =>
      owner.lifetime(() => settleHolder(owner, holder)),
    /** The smallest paid stamp right now: one transfer's fee at the node's gas price. */
    minimumStamp: () => owner.lifetime(() => owner.payer().minimumPaymentWei()),
    /** What the chain has shown of the payments of one sent message. No request is made. */
    paymentsOf: (payloadDigest: string): StoredPayment['state'][] | undefined =>
      owner.messages
        .all()
        .find(row => row.digest === payloadDigest)
        ?.payments.map(payment => payment.state),
    discardAttempt: async (params: { payloadDigest: string }) => {
      const clean = (s?: string) =>
        s ? (s.startsWith('0x') ? s.slice(2).toLowerCase() : s.toLowerCase()) : ''
      const target = clean(params.payloadDigest)
      // Discard is presentation accounting, never cancellation of an exposed payment: an
      // undelivered message stays in the resend queue and its accounts stay claimed.
      await account(owner, row =>
        target === '*' || target === 'all' || clean(row.digest) === target,
      )
    },
    /** The attempts no host message accounts for. Reads the wallet's own record: no request. */
    unattributedAttempts: async (
      params: Parameters<DirectMessageClient['unattributedAttempts']>[0],
    ) => {
      requireDirectory(owner)
      const known = new Set(params.knownDigests)
      // A message points at it: that is saved, so it stays accounted for if the message goes.
      await account(owner, row => known.has(row.digest))
      return owner.messages
        .all()
        .filter(
          row =>
            !known.has(row.digest) &&
            // Unresolved and relay-ended attempts are always reported; see `account`.
            (row.outcome !== 'delivered' || !row.accounted),
        )
        .map(row => row.digest)
    },
    resolveUnattributedAttempts: async (
      params: Parameters<DirectMessageClient['resolveUnattributedAttempts']>[0],
    ) => {
      const answered = new Set(params.payloadDigests)
      await account(owner, row => answered.has(row.digest))
    },
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
