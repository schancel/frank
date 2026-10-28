import { sharedStampOperationId, validateSharedStoredMessage } from '../storage/outgoing-message-store'
import { recordWalletFailure } from '../wallet-failure'
import type {
  StoredPayment,
  StoredMessage,
  OutgoingMessageStore,
  UnpaidEnvelope,
} from '../storage/outgoing-message-store'
import { EvmTransactionSetInsufficientFundsError, FundsInPendingSendError } from '../evm-transaction-set-types'
import { constructWhenSpendable, EvmTransactionSetFeeExceededError } from '../evm-transaction-set'
import { NativeFeeExceededError } from './chain-wallet'
import { DefaultStampUnavailableError, type DefaultStampQuote } from "../oracle/stamp-policy"
/**
 * Canonical (#778) direct messages for a typed Monad wallet: type20 -> type12 -> type11/schema2/suite1
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
import {
  Transaction,
  computeAddress,
  getAddress,
  getBytes,
  hexlify,
  keccak256,
  toUtf8Bytes,
} from 'ethers'
import {
  ACCOUNT_REF,
  DIRECT_MESSAGE_DELIVERY,
  FrankCodecError,
  KEY_TYPE,
  MESSAGE_CONTENT_REVISION,
  PAYMENT_MEMBER,
  TYPE_DIRECT_MESSAGE_DELIVERY,
  TYPE_MESSAGE_CONTENT_REVISION,
  TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
  cborMap,
  decodeDirectMessageCryptoContext,
  encodeFrame,
  fromHex,
  isStealthMessageItemFrame,
  parseFrame,
  paymentCommitment,
  projectStealthMessageItem,
  recipientPayloadDigest,
  standaloneItemBudget,
  toHex,
  validateFrame,
  type ChildFrame,
  type Encodable,
  type NestedItemBudget,
  type PaymentMember,
} from '@frank/codec'
import { randomBytes } from '@frank/crypto-box'
import type { Current, HistoricalEvidence } from '../../directory-admission/src'
import {
  DirectMessageError,
  openDirectMessage,
  openOwnDirectMessage,
  peekSealedDirectMessageSender,
  prepareDirectMessage,
  type OpenedDirectMessage,
} from '@frank/cashweb/relay/canonical-dm'
import {
  canonicalNetworkDescriptor,
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
} from '@frank/cashweb/relay/mailbox-client'
import type {
  MessageItem,
  OutboxMessageItem,
  WalletSyncItem,
} from '@frank/cashweb/types/messages'
import {
  MessageItemEncodeError,
  MessageItemUnsupportedError,
  type MessageItemRegistry,
} from '@frank/cashweb/message-items/registry'
import {
  MessageItemBudgetExceededError,
  decodeItemFrames,
  encodeItemFrames,
} from '../message-item-plugins/wire'
export { applyWalletSyncItem } from '../sync-dispatcher'
import {
  DEFAULT_DECODE_BATCH_SIZE,
  DEFAULT_YIELD_BUDGET_MS,
  createCooperativeBatchYielder,
  setEventLoopYieldForTesting,
  yieldToEventLoop,
  type CooperativeBatchYielder,
  type EventLoopYieldFn,
} from './event-loop-yield'
export {
  DEFAULT_DECODE_BATCH_SIZE,
  DEFAULT_YIELD_BUDGET_MS,
  createCooperativeBatchYielder,
  setEventLoopYieldForTesting,
  yieldToEventLoop,
  type CooperativeBatchYielder,
  type EventLoopYieldFn,
}
import {
  DirectMessageAlreadyAttemptedError,
  DirectMessageArgumentError,
  DirectMessageAttemptUnlinkedError,
  DirectMessageStampBelowFeeError,
  directMessageNotAttempted,
} from './active-chain'
import type {
  AuthenticatedMailboxRecord,
  ChainAddress,
  DirectMessageAttemptStatus,
  DirectMessageEnd,
  DirectMessagePaymentSummary,
  DirectMessageSelfCopyState,
  DirectMessageClient,
  DirectMessageReceived,
  DirectMessageSendResult,
  StampPaymentInfo,
} from './active-chain'
import {
  MonadStampPendingAttemptError,
  MonadStampTerminalError,
  StampBlockedError,
} from '../evm-stamp-client'
import type { EvmStampPayer, StampClaim, StampPayment } from '../evm-stamp-payer'
import { InsufficientStampFundsError } from '../evm-stamp-payer'
import { ChainUnreachableError } from '../evm-block-watcher'
import { inspectCanonicalPreparedEnvelope } from '../evm-stamp-stealth'
import {
  nativeMemberAbandoned,
  nativeMemberEnded,
  nativeMemberSuperseded,
  type EvmNativeMember,
} from '../storage/evm-native-operation-journal'
import { findNonceConsumer } from '../evm-nonce-consumer'
import { abandonTakenMembers, paymentsEnded, takenMembers } from '../evm-transaction-set-taken'
import { EVM_FAILURE_CONFIRMATIONS } from './evm-settlement'
import { RefusalLedger } from './evm-refused-resign'
import type { MonadCanonicalRoleOwner } from '../evm-wallet-material'
import { deriveEvmStealthPrivateKey } from '../evm-stealth'
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

/** Terminal relay refusal surfaced by an unpaid canonical send. Paid relay refusals retain
 * their original request and unresolved payment claims instead. */
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
  /** The wallet-owned EVM transaction-set capability used for canonical stamp payments. */
  transactionSets?: {
    preparer: import('../evm-transaction-set').EvmTransactionSetPreparer
    lifecycle: import('../evm-transaction-set-lifecycle').EvmTransactionSetLifecycle
    provider: import('ethers').Provider
    refresh: () => Promise<void>
    /** Resolves once the chain is at `block` or past it. */
    untilBlock: (block: number) => Promise<unknown>
    resolvePaymentOperation?: (id: string, amount: bigint) => Promise<string>
    /** Gives back the coins of the payment operation `id` (a message's `paymentOperationId`)
     * through the owner of that payment, which itself proves that nothing of it was exposed.
     * True once it is released (also when it already was); false: it may have been exposed
     * and stays held. `endedMessage` is the digest of the message that ended without being
     * signed or handed to anyone: the payment's owner may release a payment that learned that
     * message's digest, since that message is now proved never to have left the wallet. */
    releasePaymentOperation?: (id: string, endedMessage: string) => Promise<boolean>
    sendTransaction: (prepared: import('../evm-transaction-set-types').PreparedEvmTransactionSet) => Promise<import('../transaction-set').TransactionSetSubmission>
  }
  signDigest(digest: Uint8Array): Uint8Array
  /** Runs `operation` as part of the open wallet: close waits for it. Not a queue. */
  lifetime<T>(operation: () => Promise<T>): Promise<T>
  /** A payment is waiting for the main or identity account and what holds it is not a message
   * of this wallet (a native send, a contract call, a transfer to a contact): one look at the
   * chain for that holder's own transaction, releasing the account when it is decided. */
  settleOtherHolder?(holder: string): Promise<void>
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

const consumerOf = (messageId: Uint8Array) => `frank-dm:${toHex(messageId)}`
/** The claim holder of one message: unique across every wallet that shares the same coins. */
const holderOf = (owner: CanonicalMessagingOwner, consumerId: string) =>
  `${owner.subject}:${consumerId}`
const isPending = (payment: StoredPayment) => payment.state === 'pending'
/** Delivery or payment is not known to be finished: the resend pass still has work on it. */
const isUnresolved = (row: StoredMessage) =>
  row.outcome === undefined ||
  // Delivered sealed: the note to self that stands in for the relay's outbox row is still owed.
  (row.outcome === 'delivered' && row.selfCopyOwed === true) ||
  row.payments.some(isPending) ||
  row.otherTransactions.some(isPending) ||
  sharedConstructionPending(row) ||
  owedRepayments(row).length > 0 ||
  // A shared payment another transaction took, still to be paid again (or being paid again).
  sharedRepaymentCandidates(row).length > 0 ||
  (row.repayments?.some(repayment => repayment.state === 'pending') ?? false)
/** The payments of a delivered message that the chain reverted and that have not been repeated
 * yet: positions in `payments`. The message arrived, so its payment is still owed. */
function owedRepayments(row: StoredMessage): number[] {
  if (row.outcome !== 'delivered') return []
  return row.payments.flatMap((payment, index) =>
    payment.state === 'reverted' &&
    // A repeat is never repeated, however often it was signed.
    row.payments[slotOf(row, index)].repays === undefined &&
    !row.payments.some(other => other.repays === index)
      ? [index]
      : [],
  )
}

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
  repay: Pace
  rebuild: Pace
  /** The earlier payment operations of a message whose payment was built again. */
  replaced: Pace
  /** When a waiter last made the chain look at this message's payments, and how long the next
   * waiter's look must wait after it. One look serves every waiter. */
  lookedAtMs?: number
  lookGapMs?: number
  /** Delivered holders get one probe per shared watcher look, including staggered waiters. */
  lookedAtWatch?: number
}
/** Undelivered holders start at this polling interval; all their waiters share each look. */
export const HOLDER_LOOK_MS = 1_000
/** ...and of a DELIVERED holder's payment at most this often: the block watcher's looks pace it. */
export const DELIVERED_LOOK_MS = 100
/** ...and, while the holder's message is not delivered (its payment can land only if the relay
 * broadcast it before an answer was lost), ever more rarely, up to this. */
export const HOLDER_LOOK_MAX_MS = 16_000
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
      repay: { passes: 0, next: 1, gap: 0 },
      rebuild: { passes: 0, next: 1, gap: 0 },
      replaced: { passes: 0, next: 1, gap: 0 },
    }
    map.set(consumerId, work)
  }
  return work
}
/** The background pass comes by on every host tick. A step that keeps finding nothing new is
 * taken on the 1st, 2nd, 4th, 8th pass and then every `every`-th: bounded work for a message
 * that stays stuck, without ever giving it up. A caller's explicit retry always acts. */
/** How often the resend pass looks at each transaction set another transaction took a nonce
 * of (`abandonTakenMembers`). Process memory. */
const takenSetPaces = new WeakMap<object, Map<string, Pace>>()
function takenSetPace(owner: CanonicalMessagingOwner, operationId: string): Pace {
  let map = takenSetPaces.get(owner.messages)
  if (!map) takenSetPaces.set(owner.messages, (map = new Map()))
  let pace = map.get(operationId)
  if (!pace) map.set(operationId, (pace = { passes: 0, next: 1, gap: 0 }))
  return pace
}

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
  const unpaid = row ? undefined : owner.messages.unpaidByDigest(digest)
  if (!row && !unpaid) return 'unknown'
  const original = (row ?? unpaid)!
  return original.exposurePending ? 'live' : original.outcome ?? 'live'
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

/** The type 11 payload of a delivery frame when it is sealed-sender (names no sender). */
function sealedOriginalPayload(delivery: Uint8Array): Uint8Array | undefined {
  const parsed = parseFrame(delivery)
  if (parsed.kind !== 'parsed' || parsed.typed?.type !== TYPE_DIRECT_MESSAGE_DELIVERY)
    return undefined
  const payload = parsed.typed.payloadFrame.typed
  return payload?.type === TYPE_RECIPIENT_ENCRYPTED_PAYLOAD && payload.sender === undefined
    ? parsed.typed.payloadFrame.frame
    : undefined
}

/** Seals one message and frames it as an unpaid delivery: type 10 at schema 2 with an empty
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
    | 'sealedSender'
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
  if (payload.kind !== 'parsed' || payload.typed?.type !== TYPE_RECIPIENT_ENCRYPTED_PAYLOAD)
    throw new Error('canonical-wallet:payload-required')
  const digest = recipientPayloadDigest(directory.network, sealed.payload)
  const account = (ref: { keyType: number; keyBytes: Uint8Array }) =>
    cborMap([
      [ACCOUNT_REF.keyType, ref.keyType],
      [ACCOUNT_REF.keyBytes, ref.keyBytes],
    ])
  // The paid delivery's fields in the same order, without payment members.
  const D = DIRECT_MESSAGE_DELIVERY
  const delivery = encodeFrame(
    { typeId: TYPE_DIRECT_MESSAGE_DELIVERY, schemaVersion: 2, minReaderVersion: 1 },
    cborMap([
      [D.network, directory.network],
      [D.destination, account(decodeDirectMessageCryptoContext(sealed.context).stampKey)],
      [D.payloadFrame, sealed.payload],
      [D.payloadDigest, digest],
      [D.payments, []],
      [D.recipient, account(payload.typed.recipient)],
      [D.dleqProof, payload.typed.dleqProof],
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
  stableBoundary: string | undefined,
  /** What `inspectCanonicalPreparedEnvelope` found in exactly these `sealed` bytes. */
  inspected: ReturnType<typeof inspectCanonicalPreparedEnvelope>,
) {
  const payments = rawTransactions.map((rawTx, i) => {
    const tx = Transaction.from(rawTx)
    const M = PAYMENT_MEMBER
    const entries: [number, Encodable][] = [
      [M.network, network],
      [M.transactionId, getBytes(tx.hash!)],
      [M.value, getBytes('0x' + tx.value.toString(16).padStart(64, '0'))],
      [M.address, getBytes(tx.to!)],
      [M.commitment, paymentCommitment(digest, i)],
      [M.rawTx, getBytes(rawTx)],
      [M.childIndex, i],
    ]
    return cborMap(entries)
  })
  const D = DIRECT_MESSAGE_DELIVERY
  const delivery = encodeFrame(
    { typeId: TYPE_DIRECT_MESSAGE_DELIVERY, schemaVersion: 1, minReaderVersion: 1 },
    cborMap([
      [D.network, network],
      [
        D.destination,
        cborMap([
          [ACCOUNT_REF.keyType, KEY_TYPE.secp256k1],
          [ACCOUNT_REF.keyBytes, inspected.stampKey.keyBytes],
        ]),
      ],
      [D.payloadFrame, sealed.payload],
      [D.payloadDigest, digest],
      [D.payments, payments],
      [
        D.recipient,
        cborMap([
          [ACCOUNT_REF.keyType, inspected.payload.recipient.keyType],
          [ACCOUNT_REF.keyBytes, inspected.payload.recipient.keyBytes],
        ]),
      ],
      [D.dleqProof, inspected.payload.dleqProof],
    ]),
  )
  return freezeCanonicalRequest(
    {
      delivery,
      context: sealed.context,
      transactions: rawTransactions.map(rawTx => getBytes(rawTx)),
    },
    stableBoundary ?? `frank-${toHex(randomBytes(24))}`,
  )
}

/**
 * Relay refusals given before anything is stored, delivered or broadcast: the recipient's relay
 * cannot be reached from here, or the node shows a payment can never land (its nonce used by
 * another transaction, or its account short of value plus gas) and knows none of the set. On a
 * message's first submission, which nothing else has seen, they prove its payments unexposed.
 *
 * Tied to the relay's message handler (`backend/cashweb/cashweb-registry/src/http/
 * monad_message_cbor.rs`, `handle_put`): there `undeliverable` (`deliverable_recipient` found
 * no mailbox here) and `precheck_payments`' `stale_nonce` / `insufficient_total` are answered by
 * `dead_response` before `owner.claim` stores anything. A change there must change this list.
 *
 * Only for a recipient whose mailbox is on the home relay. A message for a mailbox elsewhere goes
 * through DM federation forwarding, where the home relay retains the request first and a later
 * give-up answers `undeliverable` after that: no answer then proves the bytes unexposed.
 */
export const REFUSED_BEFORE_EXPOSURE: ReadonlySet<string> = new Set([
  'undeliverable',
  'stale_nonce',
  'insufficient_total',
])
/** How often one send pays its message again from other coins after such a refusal. */
const MAX_REFUSAL_REPLANS = 2

/**
 * Before the relay has a message, the wallet puts its own self-sends of the set on the chain
 * (change and the funding of this message's payments), observed until the payments may be handed
 * over or nothing more moves. Recipient payments, the stamps and any contact transfer, are
 * broadcast only once the relay has stored the message (`settleSharedPayments`): a relay that
 * cannot be reached leaves none of them on the chain. There is no exception: the preparer never
 * funds a stage from a move that comes after a payment of the set on the same account.
 * Returns whether the stage's payments may be handed to the relay now.
 */
async function fundStagePayments(
  shared: NonNullable<CanonicalMessagingOwner['transactionSets']>,
  operationId: string,
  stageId: string | undefined,
): Promise<boolean> {
  const progress = async () => {
    const operation = await shared.preparer.readOperation(operationId)
    return JSON.stringify(
      operation?.members.map(member => [member.exposed, member.observation.state]) ?? [],
    )
  }
  // Readiness counts blocks from the wallet's last look at the head (after a reopen there is
  // none yet): each check follows a fresh look, so what landed in the previous pass is judged
  // against the head that followed it. A node that cannot be reached leaves readiness to what
  // is already known: a same-account predecessor counts once it left the wallet, as before.
  // The head only grows, so a stage ready against the last look is ready against a fresh one:
  // the fresh look (a round of node reads) is taken only when the last one does not suffice.
  const ready = async () => {
    if (await shared.lifecycle.readCanSubmitPayments(operationId, stageId).catch(() => false))
      return true
    await shared.refresh().catch(() => undefined)
    return shared.lifecycle.readCanSubmitPayments(operationId, stageId)
  }
  // A handoff the node did not take is not lost: the bytes stay recorded and the resend pass
  // hands them over again. Only readiness decides whether the relay gets the message now.
  const attempt = async (step: () => Promise<void>) => {
    try {
      await step()
    } catch (error) {
      console.warn('[monad-canonical-dm] funding of a message payment did not go out yet:', error)
    }
  }
  for (;;) {
    if (await ready()) return true
    const before = await progress()
    await attempt(() => shared.lifecycle.replay(operationId, { payments: false }))
    // A payment standing only on moves of its own account is ready once they left the wallet:
    // reading the chain is then left to the pass after the relay stored the message.
    if (await shared.lifecycle.readCanSubmitPayments(operationId, stageId).catch(() => false))
      return true
    await attempt(() => shared.lifecycle.observe(operationId, shared.provider))
    // A self-send included now may make the next one on its account ready. A pass that
    // changes nothing waits for blocks or the node. (No stage is funded from behind a payment
    // of its set: the preparer never builds that, so no payment goes out before the relay.)
    if ((await progress()) === before) return await ready()
  }
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
): Promise<{
  row: StoredMessage
  error?: unknown
  dead?: string
  /** Every submission of these bytes, this one included, was refused before exposure. */
  refusedUnexposed?: true
  /** Not handed to the relay: its own payments still wait on their funding transfer. */
  awaitingFunding?: true
  /** Not handed to the relay: the chain shows a payment's coin used by another transaction. */
  paymentTaken?: true
}> {
  if (
    row.exposurePending ||
    row.outcome !== undefined ||
    row.request === undefined
  ) return { row }
  if (row.transactionSetOperationId) {
    const shared = owner.transactionSets
    if (!shared) throw new Error('Shared stamp operation unavailable')
    // The complete message and its signed set are durable: the set is authorized for
    // submission (as the wallet's submission boundary requires) before any of it leaves.
    await shared.preparer.authorizeSubmission(row.transactionSetOperationId)
    // This message's own payments still wait on their funding transactions: nothing failed
    // and no other attempt competes. It is handed to the relay on a later pass.
    if (!await fundStagePayments(shared, row.transactionSetOperationId, row.transactionSetStageId)) {
      // A payment whose nonce another transaction used is not waiting for anything: it can never
      // land, and the resend pass builds the payment again once the chain confirms that.
      const operation = await shared.preparer.readOperation(row.transactionSetOperationId)
      // So is one standing on a move whose nonce another transaction used.
      const taken = operation?.members.some(member =>
        carriedPayment(member, row.transactionSetStageId) &&
        nativeMemberEnded(member)) ||
        await carriedPaymentUsedElsewhere(owner, row.transactionSetOperationId, row.transactionSetStageId)
      return taken ? { row, paymentTaken: true } : { row, awaitingFunding: true }
    }
    // The relay checks a combined message's stamp, not the contact payment inside it: the chain
    // is read first, and a message whose carried payment another transaction took is not handed
    // over. It ends saying so once the chain confirms the take (`rebuildTakenPayment`).
    if (
      row.transactionSetStageId !== undefined && row.unstored === true &&
      await carriedPaymentUsedElsewhere(owner, row.transactionSetOperationId, row.transactionSetStageId)
    )
      return { row, paymentTaken: true }
  }
  // A shared set whose own payments are all this message's and of which nothing has left the
  // wallet yet: a first refusal before the relay stores anything frees it, as for version 1.
  let sharedUnexposed = false
  if (row.transactionSetOperationId && owner.transactionSets) {
    const operation = await owner.transactionSets.preparer.readOperation(row.transactionSetOperationId)
    if (!operation) throw new Error('Shared stamp operation unavailable')
    const carried = new Set(row.payments.map(payment => payment.rawTx))
    sharedUnexposed = operation.members.every(member =>
      !member.exposed &&
      (member.transactionSet?.role !== 'payment' || carried.has(member.signed!.rawTransaction)),
    )
    for (const payment of row.payments) {
      const index = operation.members.findIndex(member => member.signed?.rawTransaction === payment.rawTx)
      if (index < 0) throw new Error('Stamp bytes differ from original operation')
      await owner.transactionSets.preparer.markExposed(row.transactionSetOperationId, index)
    }
  }
  const request = row.request
  let unexposed = false
  // Whether the relay held no copy of this message before this submission (`unstored`).
  const unstored = row.unstored === true
  if (row.unexposed || row.unstored) {
    // From here the bytes may be out: a crash during the request leaves them possibly exposed,
    // and possibly stored by the relay.
    const { unexposed: _unexposed, unstored: _unstored, ...possiblyOut } =
      owner.messages.get(row.consumerId)!
    await owner.messages.put(possiblyOut)
    // A carried payment reaches the chain only after the relay stores its message, so on a
    // first submission the relay is the only party a shared set's payments were handed to.
    unexposed = row.unexposed === true && (row.version === 1 || sharedUnexposed)
    row = possiblyOut
  }
  let accepted: CanonicalAcceptedBody
  try {
    accepted = await submitCanonicalRequest({
      installedRelayOrigin: owner.relayBaseUrl,
      expectedNetworkTag: owner.installedNetworkTag,
      request: restoreCanonicalRequest({
        body: fromHex(request.body),
        contentType: request.contentType,
      }),
      fetch: directory.fetch,
    })
  } catch (error) {
    // Signed bytes have crossed the transport boundary. No HTTP refusal proves that this
    // request (or an earlier copy whose response was lost) cannot still be broadcast.
    return { row, error }
  }
  // A relay's answer cannot prove an exposed signed payment unexecutable. Keep the complete
  // original request and its claims until delivery and chain reconciliation resolve them.
  if (accepted.phase !== 'delivered') {
    if (accepted.phase !== 'dead') {
      // A later answer replaces an earlier refusal: the relay no longer gives that reason.
      if (row.reason === undefined) return { row }
      const { reason: _reason, ...answered } = owner.messages.get(row.consumerId)!
      await owner.messages.put(answered)
      return { row: answered }
    }
    const dead = accepted.reason
    const before =
      unexposed && REFUSED_BEFORE_EXPOSURE.has(dead)
        ? { refusedUnexposed: true as const }
        : {}
    // Refused before the relay stored anything, as every submission before it: the relay still
    // holds no copy.
    const stillUnstored = unstored && REFUSED_BEFORE_EXPOSURE.has(dead)
    if (row.reason === dead && !stillUnstored) return { row, dead, ...before }
    const refused: StoredMessage = {
      ...owner.messages.get(row.consumerId)!,
      reason: dead,
      ...(stillUnstored ? { unstored: true as const } : {}),
    }
    await owner.messages.put(refused)
    return { row: refused, dead, ...before }
  }
  // Delivery resolves the relay obligation, independently of the payments' chain state.
  const { request: _request, reason: _reason, ...kept } =
    owner.messages.get(row.consumerId)!
  const answered: StoredMessage = {
    ...kept,
    outcome: 'delivered',
    deliveredAt: accepted.mailbox_committed_at_ms,
  }
  await owner.messages.put(answered)
  return { row: answered }
}

/**
 * Ends a message whose every submission the home relay refused before storing or broadcasting
 * anything (`refusedUnexposed`): its signed payments never left the wallet. The record first
 * (dead, payments unsent, bytes dropped), then the coins are free and their accounts read again.
 */
/**
 * Whether the chain shows a nonce of the set `operationId` used while none of the set's own
 * transactions has a receipt for it: another transaction took a coin of it. Reads the node only;
 * when it does, the set is observed so the journal records that member superseded (what the
 * rebuild acts on). False when the node cannot say.
 */
async function setNonceUsedElsewhere(
  owner: CanonicalMessagingOwner,
  operationId: string,
): Promise<boolean> {
  const shared = owner.transactionSets
  if (!shared) return false
  try {
    const operation = await shared.preparer.readOperation(operationId)
    if (!operation) return false
    let used = false
    for (const member of operation.members) {
      if (!member.signed) continue
      const nonce = Transaction.from(member.signed.rawTransaction).nonce
      if ((await shared.provider.getTransactionCount(member.source.address, 'latest')) <= nonce) continue
      if (await shared.provider.getTransactionReceipt(member.signed.transactionHash)) continue
      used = true
      break
    }
    if (!used) return false
    await owner.lifetime(() => shared.lifecycle.observe(operationId, shared.provider))
    return (await shared.preparer.readOperation(operationId))?.members.some(nativeMemberSuperseded) ?? false
  } catch {
    return false
  }
}

async function endRefusedUnexposed(
  owner: CanonicalMessagingOwner,
  row: StoredMessage,
): Promise<StoredMessage> {
  const refused = row.payments.filter(isPending)
  // A shared set is freed by its preparer. When any of its own moves went to the node it is
  // not: those may land, so it stays reserved and its payments pending until the chain says.
  if (row.version === 2) {
    const shared = owner.transactionSets
    if (!shared || !row.transactionSetOperationId) return row
    // A refusal for a used nonce or a short account may come from another transaction taking a
    // coin of the set (another device spent it at the same moment): the chain is read first.
    // Such a message does not end here; once the chain confirms the take its payment is built
    // again from other coins (`rebuildTakenPayment`).
    if (await setNonceUsedElsewhere(owner, row.transactionSetOperationId)) return row
    const released = await owner.lifetime(() =>
      shared.preparer.releaseRefusedBeforeBroadcast(row.transactionSetOperationId!),
    )
    if (!released) return row
  }
  const { request: _request, unexposed: _unexposed, ...kept } = row
  const ended: StoredMessage = {
    ...kept,
    // A shared set's signed bytes went with its cancelled operation: the record keeps none.
    ...(row.version === 2
      ? { payments: [], otherTransactions: [] }
      : {
          payments: row.payments.map(payment =>
            payment.state === 'pending'
              ? { ...payment, rawTx: '', state: 'unsent' as const }
              : payment,
          ),
        }),
    outcome: 'dead',
  }
  await owner.lifetime(() => owner.messages.put(ended))
  if (row.version !== 2)
    await owner.lifetime(() =>
      owner.payer().releaseRefused(holderOf(owner, row.consumerId), refused),
    )
  return ended
}

/**
 * The message holding a coin a payment waits for, when its payment cannot finish by itself:
 * not delivered, nothing of it in the node's hands, and the relay's last answer a refusal (or
 * the host has not bound it). Retrying it is what can unblock the wait; its coin stays held.
 * `undefined`: it can still finish (the resend pass is submitting it, or the chain decides).
 */
function blockedBy(
  owner: CanonicalMessagingOwner,
  holder: string,
): StampBlockedError | undefined {
  const prefix = `${owner.subject}:`
  if (!holder.startsWith(prefix)) return undefined
  const row = owner.messages.get(holder.slice(prefix.length))
  if (!row || row.outcome === 'delivered') return undefined
  const pending = row.payments.filter(isPending)
  if (pending.length === 0) return undefined
  if (pending.some(payment => knownToNode.has(payment.rawTx))) return undefined
  // A send or a look in flight for it (an earlier send between its record and the host's
  // binding, the resend pass submitting it) can still finish it.
  const work = works.get(owner.messages)?.get(row.consumerId)
  if (work?.creating || work?.busy) return undefined
  if (row.exposurePending) return new StampBlockedError(row.digest)
  if (row.reason !== undefined) return new StampBlockedError(row.digest, row.reason)
  return undefined
}

/** Signed payments last seen in the mempool or awaiting canonical failure depth. Process memory. */
const knownToNode = new Set<string>()

/** The position of the first transaction signed for the payment that `index` belongs to. */
function slotOf(row: StoredMessage, index: number): number {
  for (let at = index, hops = 0; hops <= row.payments.length; hops++) {
    const earlier = row.payments[at]?.replaces
    if (earlier === undefined) return at
    at = earlier
  }
  return index
}

/** A message's payments in one word. See `DirectMessagePaymentSummary`. One payment may have
 * been signed more than once at its nonce (`replaces`): whichever the chain mined is it. */
function paymentSummary(row: StoredMessage): DirectMessagePaymentSummary {
  const signedFor = (slot: number) =>
    row.payments.flatMap((payment, index) =>
      slotOf(row, index) === slot ? [{ payment, index }] : [],
    )
  const word = (slot: number): DirectMessagePaymentSummary => {
    const signed = signedFor(slot)
    if (signed.some(({ payment }) => payment.state === 'spent')) return 'paid'
    // Taken by another transaction after delivery, and paid again (`repayments`).
    const again = row.repayments?.find(repayment => repayment.payment === slot)
    if (again)
      return again.state === 'spent' ? 'repaid' : again.state === 'pending' ? 'pending' : 'failed'
    const reverted = signed.find(({ payment }) => payment.state === 'reverted')
    if (reverted) {
      // Its one repeat, however often that was signed.
      const repeats = row.payments.filter(
        (_, index) => row.payments[slotOf(row, index)].repays === reverted.index,
      )
      if (repeats.some(payment => payment.state === 'spent')) return 'repaid'
      return repeats.length === 0 || repeats.some(isPending)
        ? 'reverted'
        : 'failed'
    }
    const pending = signed.filter(({ payment }) => payment.state === 'pending')
    if (pending.length > 0)
      return pending.some(({ payment }) => knownToNode.has(payment.rawTx))
        ? 'mempool'
        : 'pending'
    return signed.every(({ payment }) => payment.state === 'unsent')
      ? 'unsent'
      : 'failed'
  }
  const words = row.payments.flatMap((payment, index) =>
    payment.repays === undefined && payment.replaces === undefined
      ? [word(index)]
      : [],
  )
  const order: DirectMessagePaymentSummary[] = [
    'failed',
    'reverted',
    'unsent',
    'pending',
    'mempool',
    'repaid',
  ]
  return order.find(found => words.includes(found)) ?? 'paid'
}

/** What running the node said to each signed payment (by its bytes): when one may be signed
 * again (`evm-refused-resign.ts`, the rule every wallet path that re-signs shares). */
const refusals = new RefusalLedger()

/** Notes what the node said to each payment handed to it. */
function noteHandOver(handed: readonly { rawTx: string; error?: unknown }[]) {
  for (const one of handed) refusals.note(one.rawTx, one.error)
}

/**
 * A payment of a delivered message that the node keeps refusing to take is signed again at the
 * same nonce (`EvmStampPayer.resign`) and that transaction is handed to the node instead. The
 * row with it is on stable storage first. Without this the same refused bytes were offered for
 * ever and the account they spend stayed held (seen on a local Monad chain: a payment refused
 * because its account had just been funded was refused for fifteen minutes). Never throws.
 */
async function resignRefused(
  owner: CanonicalMessagingOwner,
  row: StoredMessage,
): Promise<StoredMessage> {
  const payer = owner.payer()
  for (const [index, payment] of row.payments.entries()) {
    const slot = slotOf(row, index)
    if (
      payment.state !== 'pending' ||
      // Only the newest transaction of a payment is signed again.
      row.payments.some(other => other.replaces === index) ||
      !refusals.due(
        payment.rawTx,
        row.payments.filter((_, at) => slotOf(row, at) === slot).length,
      )
    )
      continue
    try {
      const again = await payer.resign(payment, owner.chainId)
      const next: StoredMessage = {
        ...owner.messages.get(row.consumerId)!,
        payments: [
          ...owner.messages.get(row.consumerId)!.payments,
          { ...again, state: 'pending', replaces: index },
        ],
      }
      await owner.messages.put(next)
      row = next
      refusals.forget(payment.rawTx)
      console.warn(
        `[monad-canonical-dm] the node refused payment ${Transaction.from(payment.rawTx).hash} of a delivered message; the same payment is signed again at its nonce as ${Transaction.from(again.rawTx).hash}`,
      )
      noteHandOver(await payer.submitPaymentSet([again.rawTx]))
    } catch (error) {
      console.warn(
        '[monad-canonical-dm] a refused payment could not be signed again; it is tried later:',
        error,
      )
    }
  }
  return row
}

/** No longer consulted: whether a payment was replaced is read from the node in one look. Kept
 * so existing tests that set it still load; remove with them. */
export const REPLACED_AFTER_MS = { value: 0 }

/** A shared-set message whose stamp stage was never signed: no payment, change or request of
 * it exists, so nothing of it has been handed to the node or the relay. */
function unconstructed(row: StoredMessage): boolean {
  return Boolean(
    row.version === 2 && row.construction && !row.request &&
    row.payments.length === 0 && row.otherTransactions.length === 0,
  )
}

function sharedConstructionPending(row: StoredMessage): boolean {
  return unconstructed(row) && row.outcome === undefined
}

/**
 * Ends a message whose stamp stage was never signed, and gives back the payment it would have
 * joined. Only on evidence that nothing of it can be out: the message has no signed stage and no
 * request (so the relay was handed nothing), and the payment operation it joins shows no member
 * exposed, authorized for submission or seen by the node. Its record first (`dead`, `reason`),
 * then the payment's own owner releases it (and proves non-exposure again); a crash between the
 * two is finished by the resend pass. Returns whether it ended.
 */
async function endUnconstructed(
  owner: CanonicalMessagingOwner,
  row: StoredMessage,
  reason: 'fee_exceeded' | 'funds_tied_up' | 'discarded',
  /** With `funds_tied_up`: what the earlier sends held (`FundsInPendingSendError.tiedUpWei`). */
  tiedUpWei?: bigint,
): Promise<boolean> {
  const shared = owner.transactionSets
  if (!shared || !sharedConstructionPending(row) || !row.transactionSetOperationId) return false
  const operation = await shared.preparer.readOperation(row.transactionSetOperationId)
  if (row.transactionSetStageId === undefined) {
    // A stamp of its own: its operation is written only when its stage is signed.
    if (operation && !operation.cancelled) return false
  } else {
    if (!operation || !shared.releasePaymentOperation) return false
    if (!operation.cancelled && (
      operation.transactionSetStages?.some(stage => stage.stageId === row.transactionSetStageId) ||
      operation.submissionAuthorized ||
      operation.members.some(member => member.exposed || nativeMemberSuperseded(member) ||
        !['unknown', 'missing'].includes(member.observation.state))))
      return false
  }
  const { exposurePending: _pending, unexposed: _unexposed, ...kept } = row
  const ended: StoredMessage = {
    ...kept,
    outcome: 'dead',
    reason,
    ...(reason === 'funds_tied_up' && tiedUpWei !== undefined ? { tiedUpWei: tiedUpWei.toString() } : {}),
  }
  await owner.messages.put(ended)
  await releaseEndedPayment(owner, ended)
  return true
}

/** The payment an ended, never-signed message would have joined: released once. */
async function releaseEndedPayment(
  owner: CanonicalMessagingOwner,
  row: StoredMessage,
): Promise<void> {
  if (row.outcome !== 'dead' || !unconstructed(row) || !row.paymentOperationId || row.paymentReleased)
    return
  if (!(await owner.transactionSets?.releasePaymentOperation?.(row.paymentOperationId, row.digest))) {
    console.warn(
      `[monad-canonical-dm] the payment of ended message ${row.digest} was not released: it may have been exposed, so its coins stay held.`,
    )
    return
  }
  await owner.messages.put({ ...owner.messages.get(row.consumerId)!, paymentReleased: true })
}

/** A message with a stamp of its own that this wallet refused at once because the money that
 * would pay it was still in its earlier sends (`FundsInPendingSendError`), before anything of it
 * was signed or handed out. It stands for nothing: the user's Retry sends it afresh under the
 * same message ID (owner ruling 2026-10-26), and only that Retry does. */
function refusedForTiedUpFunds(row: StoredMessage): boolean {
  return row.version === 2 && row.outcome === 'dead' && row.reason === 'funds_tied_up' &&
    row.paymentOperationId === undefined && unconstructed(row)
}

/** A shared message the relay refused before anything of it was broadcast: its set is cancelled
 * and the record keeps no signed bytes (`endRefusedUnexposed`). */
function sharedRefusedAndReleased(row: StoredMessage): boolean {
  return row.version === 2 && row.outcome === 'dead' &&
    row.payments.length === 0 && row.otherTransactions.length === 0
}

async function finishSharedConstruction(
  owner: CanonicalMessagingOwner,
  row: StoredMessage,
  mode: 'construct' | 'restore' = 'construct',
  /** The user's own send is waiting on this: it may wait the few blocks a fresh deposit needs.
   * The resend pass never waits; it retries on its next turn. */
  waitForSpendable = false,
): Promise<StoredMessage> {
  if (!sharedConstructionPending(row)) return row
  let intent = row.construction!
  const operationId = row.transactionSetOperationId
  const shared = owner.transactionSets
  validateSharedStoredMessage(row)
  if (!operationId) throw new Error('Stored stamp operation identity mismatch')
  if (row.transactionSetStageId && (!shared?.resolvePaymentOperation ||
      await shared.resolvePaymentOperation(row.paymentOperationId!, BigInt(intent.amountWei)) !== operationId))
    throw new Error('Stored payment/stamp operation identity mismatch')
  if (!shared) throw new Error('Shared stamp transaction preparation is unavailable')
  const sealed = { payload: fromHex(intent.payload), context: fromHex(intent.context) }
  const inspected = inspectCanonicalPreparedEnvelope(sealed.payload, sealed.context)
  const network = canonicalNetworkDescriptor(owner.installedNetworkTag).network
  if (intent.network !== network || owner.chainId !== canonicalNetworkDescriptor(owner.installedNetworkTag).chainId ||
      // A sealed-sender payload names no sender outside its ciphertext, so only an unsealed
      // one can be compared with the owner here.
      (inspected.payload.sender !== undefined &&
        toHex(inspected.payload.sender.keyBytes) !== owner.subject) ||
      toHex(inspected.payload.recipient.keyBytes) !== row.recipientSubject ||
      toHex(recipientPayloadDigest(intent.network, sealed.payload)) !== row.digest)
    throw new Error('Stored stamp construction identity mismatch')
  // A sealed payload names its sender only inside the ciphertext. Before anything is signed for
  // it, the original must self-open with this wallet's own key and name this wallet as its
  // sender, as `validateOriginalEnvelope` requires of a free original. A restore at open only
  // rebuilds a stage that this check already passed when it was signed (and has no directory yet).
  if (inspected.payload.sender === undefined && mode === 'construct') {
    const directory = requireDirectory(owner)
    const roles = owner.roles.create(directory.network, await directory.selfCurrent())
    let sealedSender: Uint8Array
    try {
      sealedSender = peekSealedDirectMessageSender({
        mode: 'sender',
        network: directory.network,
        payload: sealed.payload,
        context: sealed.context,
        roles,
      }).sender.keyBytes
    } catch {
      throw new Error('Stored stamp construction identity mismatch')
    } finally {
      roles.dispose()
    }
    if (toHex(sealedSender) !== owner.subject)
      throw new Error('Stored stamp construction identity mismatch')
  }
  if (mode === 'restore') {
    // Opening validates the intent, but must not make its funding availability a condition
    // of opening the wallet. Only finish the envelope when this exact signed stage exists.
    const operation = await shared.preparer.readOperation(operationId)
    if (operation?.cancelled)
      throw new Error('Stored stamp refers to a cancelled transaction set')
    if (!operation || (row.transactionSetStageId !== undefined &&
        !operation.transactionSetStages?.some(stage => stage.stageId === row.transactionSetStageId)))
      return row
    // The preparer's existing-stage path validates the original intent and reconstructs its
    // signed bytes from local authority; it does not select inputs, refresh fees or sign.
  } else {
    await shared.refresh()
  }
  // Existing signed stages replay exactly. An older unfinished intent captures its
  // floor durably before the first signature, without changing the authorized amount.
  const operation = await shared.preparer.readOperation(operationId)
  const signedStage = operation?.members.some(member =>
    member.transactionSet?.stageId === row.transactionSetStageId && member.signed !== null)
  if (intent.minimumPaymentWei === undefined && !signedStage && mode === 'construct') {
    const minimum = await owner.payer().minimumPaymentWei()
    if (BigInt(intent.amountWei) < minimum)
      throw new DirectMessageStampBelowFeeError(BigInt(intent.amountWei), minimum)
    intent = { ...intent, minimumPaymentWei: minimum.toString() }
    row = { ...row, construction: intent }
    await owner.messages.put(row)
  }
  const request = {
    operationId,
    amountWei: BigInt(intent.amountWei),
    ...(intent.minimumPaymentWei === undefined ? {} : { minimumPaymentWei: BigInt(intent.minimumPaymentWei) }),
    kdf: (childIndex: number) => hexlify(canonicalStampDestination({
      network: intent.network,
      stampKey: inspected.stampKey,
      sharedPoint: inspected.payload.sharedPoint,
      childIndex,
    }).address),
  }
  // Money that reached the wallet a few blocks ago may be spendable only from a later block
  // (Monad's spacing rule): the send waits for that block rather than report no funds.
  const construct = () =>
    row.transactionSetStageId
      ? shared.preparer.appendTransactionSet({
          ...request,
          stageId: row.transactionSetStageId,
        })
      : shared.preparer.constructTransactionSet(request)
  const prepared = waitForSpendable
    ? await constructWhenSpendable(construct, shared)
    : await construct()
  // `inspected` is of these same sealed bytes (verified above): its stamp proof is not checked
  // a second time.
  const frozenRequest = freezePaidMessage(
    intent.network, sealed, fromHex(row.digest),
    prepared.bundle.map(payment => payment.rawTransaction), intent.boundary, inspected,
  )
  const next: StoredMessage = {
    ...row,
    request: { body: toHex(frozenRequest.body), contentType: frozenRequest.contentType },
    payments: prepared.bundle.map(payment => ({
      source: 'coin', address: payment.sourceAccount,
      rawTx: payment.rawTransaction, state: 'pending',
    })),
    // Track every owned movement so primary change keeps recovering after the stamp settles.
    otherTransactions: (await shared.preparer.readOperation(operationId))!.members
      .filter(member => member.transactionSet?.role !== 'payment')
      .map(member => ({ source: 'coin', address: member.source.address,
        rawTx: member.signed!.rawTransaction, state: 'pending' })),
  }
  await owner.messages.put(next)
  return next
}

async function settleSharedPayments(
  owner: CanonicalMessagingOwner,
  row: StoredMessage,
  broadcast = true,
): Promise<StoredMessage> {
  const shared = owner.transactionSets
  const operationId = row.transactionSetOperationId
  if (!shared || !operationId) throw new Error('Stored stamp transaction set is unavailable')
  // Until the relay has stored the message only what landed is read: its payments (and a
  // contact transfer it carries) go to the chain once it is delivered, never before.
  if (row.exposurePending || !broadcast)
    await shared.lifecycle.observe(operationId, shared.provider)
  else
    // Submission owns observation failures and retains the original graph for recovery.
    // An extra failing read here must not turn confirmed relay delivery into send failure.
    await shared.sendTransaction(await shared.preparer.readTransactionSet(operationId))
  const operation = await shared.preparer.readOperation(operationId)
  if (!operation) throw new Error('Stored stamp transaction set is unavailable')
  const stateOf = (payment: StoredPayment): StoredPayment => {
    const member = operation.members.find(candidate => candidate.signed?.rawTransaction === payment.rawTx)
    if (!member) throw new Error('Stored stamp differs from durable transaction set')
    const state = member.observation.state === 'included-success' ? 'spent'
      : member.observation.state === 'included-revert' ? 'reverted'
      : nativeMemberEnded(member) ? 'failed' : 'pending'
    return { ...payment, state }
  }
  const next = {
    ...owner.messages.get(row.consumerId)!,
    payments: row.payments.map(stateOf),
    otherTransactions: row.otherTransactions.map(stateOf),
  }
  if (JSON.stringify(next) !== JSON.stringify(row)) await owner.messages.put(next)
  return next
}

/** How often one message's payment is built again after other transactions took its coins. */
const MAX_PAYMENT_REBUILDS = 3

/**
 * The relay's reason recorded on a message this wallet ended because another transaction took a
 * coin its payment stood on, when the payment cannot be built again by itself (a stage of a
 * combined payment operation: the payment it carries is part of the encrypted message). Nothing
 * was paid for it and nothing of it is held; the user sends it again (`DirectMessageEnd`
 * `payment-taken`).
 */
export const PAYMENT_TAKEN_REASON = 'payment_taken'

/**
 * Whether a payment of `row` stands on a transaction another one took: the chain shows a payment
 * of it (or a move it stands on) taken by a different transaction, at least
 * `EVM_FAILURE_CONFIRMATIONS` deep. First gives up what the chain shows can never land
 * (`abandonTakenMembers`). `undefined` when the chain cannot say.
 */
async function paymentTaken(
  owner: CanonicalMessagingOwner,
  operationId: string,
  stageId: string | undefined,
): Promise<boolean> {
  const shared = owner.transactionSets!
  const { taken } = await abandonTakenMembers({
    authority: shared.preparer,
    provider: shared.provider,
    operationId,
  })
  if (taken.length === 0) return false
  const operation = await shared.preparer.readOperation(operationId)
  if (!operation) return false
  // Every member that stands, directly or through others, on a taken or abandoned one.
  const dead = new Set<number>()
  operation.members.forEach((member, index) => {
    if (
      taken.includes(index) ||
      nativeMemberAbandoned(member) ||
      member.dependencies.some(dependency => dead.has(dependency))
    )
      dead.add(index)
  })
  return operation.members.some(
    (member, index) =>
      carriedPayment(member, stageId) &&
      member.observation.state !== 'included-success' &&
      member.observation.state !== 'included-revert' &&
      dead.has(index),
  )
}

/**
 * Whether `member` is a payment the message of `stageId` carries: its own stage's, and for a
 * stage of a combined payment operation also the operation's own payment (the contact payment,
 * no stage), which travels inside that message.
 */
function carriedPayment(member: EvmNativeMember, stageId: string | undefined): boolean {
  return member.transactionSet?.role === 'payment' &&
    (member.transactionSet.stageId === stageId ||
      (stageId !== undefined && member.transactionSet.stageId === undefined))
}

/**
 * Before a message goes to the relay: whether the chain shows the nonce of a payment it carries,
 * or of a move one stands on, used by a different transaction (at any depth). For a stage of a
 * combined payment operation the relay checks only the stamp, so it would store a message whose
 * contact payment can never land. Chain reads only; `false` when the chain cannot say.
 */
async function carriedPaymentUsedElsewhere(
  owner: CanonicalMessagingOwner,
  operationId: string,
  stageId: string | undefined,
): Promise<boolean> {
  if (!(await setNonceUsedElsewhere(owner, operationId))) return false
  const operation = await owner.transactionSets?.preparer.readOperation(operationId)
  if (!operation) return false
  const dead = new Set<number>()
  operation.members.forEach((member, index) => {
    if (
      nativeMemberSuperseded(member) ||
      nativeMemberAbandoned(member) ||
      member.dependencies.some(dependency => dead.has(dependency))
    )
      dead.add(index)
  })
  return operation.members.some(
    (member, index) =>
      carriedPayment(member, stageId) &&
      member.observation.state !== 'included-success' &&
      member.observation.state !== 'included-revert' &&
      dead.has(index),
  )
}

/**
 * A message the relay never held (`unstored`) whose payment stands on a coin another transaction
 * took: another device of this account spent the same coin at the same moment, or a different
 * transaction drained the account its later transactions were signed against. Its payments were
 * handed to nobody but a relay that refused them before storing anything, and this wallet never
 * broadcasts a payment before the relay stores its message: nobody can send them. Every payment
 * of the set that has not landed is given up, with what stands on it (`abandonTakenMembers`), and
 *
 * - a stamp of its own is built again from other coins: same message, same recipient, same
 *   amount, the one payment of the message, finished. The row first: it names the next
 *   operation and holds no request, and the resend pass constructs that operation's payment and
 *   submits the message with it, as after a restart.
 * - a stage of a combined payment operation ends: the payment it joined is carried inside the
 *   encrypted message, so paying it from other coins would be a different message. Nothing was
 *   paid for it, nothing of it stays held, and the user sends it again
 *   (`PAYMENT_TAKEN_REASON`).
 *
 * The earlier operation stays in the wallet journal and settles there. Returns the row as it now
 * stands; unchanged when the chain does not show this (or cannot say).
 */
async function rebuildTakenPayment(
  owner: CanonicalMessagingOwner,
  row: StoredMessage,
): Promise<StoredMessage> {
  const shared = owner.transactionSets
  const operationId = row.transactionSetOperationId
  if (
    !shared || !operationId || row.version !== 2 || row.outcome !== undefined ||
    row.unstored !== true || row.request === undefined || row.payments.length === 0 ||
    (row.transactionSetStageId === undefined &&
      (row.replacedOperationIds?.length ?? 0) >= MAX_PAYMENT_REBUILDS)
  )
    return row
  const operation = await shared.preparer.readOperation(operationId)
  if (!operation || operation.cancelled) return row
  if (!(await paymentTaken(owner, operationId, row.transactionSetStageId))) return row
  // Nobody holds these payments: every one that has not landed is given up.
  await abandonTakenMembers({
    authority: shared.preparer,
    provider: shared.provider,
    operationId,
    withdrawPayments: true,
  })
  const settled = await shared.preparer.readOperation(operationId)
  if (!settled || !paymentsEnded(settled, row.transactionSetStageId)) return row
  const current = owner.messages.get(row.consumerId)!
  if (
    current.transactionSetOperationId !== operationId || current.outcome !== undefined ||
    current.unstored !== true
  )
    return current
  const hashes = current.payments.map(payment => Transaction.from(payment.rawTx).hash).join(', ')
  if (row.transactionSetStageId !== undefined) {
    // Part of a combined payment operation: ends, as a refusal before anything was stored would.
    const { request: _request, unexposed: _unexposed, unstored: _unstored, ...kept } = current
    const ended: StoredMessage = {
      ...kept,
      payments: [],
      otherTransactions: [],
      outcome: 'dead',
      reason: PAYMENT_TAKEN_REASON,
    }
    await owner.messages.put(ended)
    console.warn(
      `[monad-canonical-dm] message ${current.digest} was not sent: another transaction used a coin its combined payment stood on (${hashes}). Nothing was paid for it and its coins are free; it is sent again by the user.`,
    )
    return ended
  }
  const { request: _request, reason: _reason, ...kept } = current
  const replaced = [...(current.replacedOperationIds ?? []), operationId]
  const next: StoredMessage = {
    ...kept,
    transactionSetOperationId: sharedStampOperationId(
      `stamp-${current.consumerId.slice('frank-dm:'.length)}`,
      replaced.length,
    ),
    replacedOperationIds: replaced,
    payments: [],
    otherTransactions: [],
  }
  await owner.messages.put(next)
  console.warn(
    `[monad-canonical-dm] the payment of message ${current.digest} can never land: another transaction used a coin it stood on (${hashes}), and the relay never held the message. Its payment is built again from other coins, once, as ${next.transactionSetOperationId}.`,
  )
  return next
}

/**
 * The earlier payment operations of a message whose payment was built again
 * (`replacedOperationIds`): the wallet's own moves of each still go to the node and are looked
 * for until the chain decides them, and what can never land is given up. Never a payment: those
 * were given up when the payment was built again.
 */
async function settleReplacedOperations(
  owner: CanonicalMessagingOwner,
  row: StoredMessage,
): Promise<void> {
  const shared = owner.transactionSets
  if (!shared) return
  for (const id of row.replacedOperationIds ?? []) {
    if (!shared.preparer.getOperation(id)) continue
    try {
      await shared.lifecycle.replay(id, { payments: false }).catch(() => undefined)
      await shared.lifecycle.observe(id, shared.provider)
      await abandonTakenMembers({ authority: shared.preparer, provider: shared.provider, operationId: id })
    } catch (error) {
      console.warn(`[monad-canonical-dm] earlier payment operation ${id} was not settled yet; looked at again later:`, error)
    }
  }
}

/** Whether an earlier payment operation of `row` (`replacedOperationIds`) is still active. */
function replacedUnsettled(owner: CanonicalMessagingOwner, row: StoredMessage): boolean {
  return (row.replacedOperationIds ?? []).some(id => owner.transactionSets?.preparer.getOperation(id) !== undefined)
}

/** Payments of a delivered shared-set message that ended without landing (`failed`) and are not
 * paid again yet: positions in `payments`. Whether one is owed is the chain's to say
 * (`repayTakenPayments`). */
function sharedRepaymentCandidates(row: StoredMessage): number[] {
  if (row.version !== 2 || row.outcome !== 'delivered' || row.transactionSetStageId !== undefined) return []
  return row.payments.flatMap((payment, index) =>
    payment.state === 'failed' && !row.repayments?.some(repayment => repayment.payment === index)
      ? [index]
      : [],
  )
}

/**
 * A delivered message whose payment another transaction took: its nonce was used by a different
 * transaction (another device of the account spent the same coin while the relay was storing the
 * message), at least `EVM_FAILURE_CONFIRMATIONS` deep, so that payment can never land, and the
 * relay holds the message: the recipient has it, and is still owed its payment. The same value
 * goes to the same destination from other coins, once (`repayments`, written first). A payment
 * the chain shows landed (its own transaction in the block that used its nonce) is recorded
 * `spent`; one the chain cannot say about stays as it is and is looked at again.
 */
async function repayTakenPayments(
  owner: CanonicalMessagingOwner,
  row: StoredMessage,
): Promise<StoredMessage> {
  const shared = owner.transactionSets
  const operationId = row.transactionSetOperationId
  const candidates = sharedRepaymentCandidates(row)
  if (!shared || !operationId) return row
  // Repayments already recorded are finished (built, handed to the node, looked for) each pass.
  if (candidates.length === 0) return finishRepayments(owner, row)
  const operation = await shared.preparer.readOperation(operationId)
  if (!operation) return row
  const head = await shared.provider.getBlockNumber()
  const taken = await takenMembers(shared.provider, operation, head)
  const messageId = row.consumerId.slice('frank-dm:'.length)
  for (const index of candidates) {
    const rawTx = row.payments[index]!.rawTx
    const memberIndex = operation.members.findIndex(member => member.signed?.rawTransaction === rawTx)
    if (memberIndex < 0) continue
    if (!taken.has(memberIndex)) {
      // The block that used its nonce holds this very payment: it landed (on a node that has
      // since dropped it).
      const member = operation.members[memberIndex]!
      if (!nativeMemberSuperseded(member)) continue
      const found = await findNonceConsumer(
        shared.provider,
        { account: member.source.address, nonce: Transaction.from(rawTx).nonce, transactionHash: member.signed!.transactionHash },
        member.account!.blockNumber,
      )
      if (found?.by === 'this') {
        const current = owner.messages.get(row.consumerId)!
        await owner.messages.put({
          ...current,
          payments: current.payments.map((payment, at) => (at === index ? { ...payment, state: 'spent' as const } : payment)),
        })
      }
      continue
    }
    const current = owner.messages.get(row.consumerId)!
    const repayment = { payment: index, operationId: `stamp-${messageId}-p${index}`, state: 'pending' as const }
    await owner.messages.put({ ...current, repayments: [...(current.repayments ?? []), repayment] })
    console.warn(
      `[monad-canonical-dm] payment ${Transaction.from(rawTx).hash} of delivered message ${row.digest} can never land: another transaction used its nonce. The same amount goes to the same destination from other coins, once, as ${repayment.operationId}.`,
    )
  }
  return finishRepayments(owner, owner.messages.get(row.consumerId)!)
}

/**
 * Builds (once, under its recorded operation ID), hands to the node and looks for every pending
 * repayment of `row` (`repayments`). The message is delivered, so its payment goes to the chain at
 * once. Funds that do not cover it yet leave it to a later pass.
 */
async function finishRepayments(
  owner: CanonicalMessagingOwner,
  row: StoredMessage,
): Promise<StoredMessage> {
  const shared = owner.transactionSets
  if (!shared) return row
  for (const repayment of row.repayments ?? []) {
    if (repayment.state !== 'pending') continue
    const original = Transaction.from(row.payments[repayment.payment]!.rawTx)
    try {
      let operation = await shared.preparer.readOperation(repayment.operationId)
      if (!operation) {
        await shared.refresh()
        await shared.preparer.constructTransactionSet({
          operationId: repayment.operationId,
          amountWei: original.value,
          kdf: () => original.to!,
          maxPaymentParts: 1,
          minimumPaymentWei: original.value,
        })
        operation = await shared.preparer.readOperation(repayment.operationId)
      }
      if (!operation) continue
      await shared.preparer.authorizeSubmission(repayment.operationId)
      await shared.sendTransaction(await shared.preparer.readTransactionSet(repayment.operationId))
      const settled = (await shared.preparer.readOperation(repayment.operationId))!
      const payment = settled.members.find(member => member.transactionSet?.role === 'payment')!
      const state =
        payment.observation.state === 'included-success' ? 'spent'
        : payment.observation.state === 'included-revert' ? 'reverted'
        : 'pending'
      if (state === 'pending') continue
      const current = owner.messages.get(row.consumerId)!
      await owner.messages.put({
        ...current,
        repayments: current.repayments!.map(entry =>
          entry.payment === repayment.payment ? { ...entry, state } : entry),
      })
    } catch (error) {
      console.warn(
        `[monad-canonical-dm] the payment of delivered message ${row.digest} that another transaction took is still owed; ${repayment.operationId} is tried again later:`,
        error,
      )
    }
  }
  return owner.messages.get(row.consumerId)!
}

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
  if (row.version === 2) return settleSharedPayments(owner, row, broadcast)
  const payer = owner.payer()
  const holder = holderOf(owner, row.consumerId)
  const resubmit: string[] = []
  const states = await Promise.all(
    row.payments.map(async (payment): Promise<StoredPayment['state']> => {
      if (payment.state !== 'pending') return payment.state
      try {
        const seen = await payer.observe(payment.rawTx)
        if (seen.state === 'included') {
          await payer.recordSpent(holder, payment, seen.block)
          return seen.reverted ? 'reverted' : 'spent'
        }
        // The node knows neither the transaction nor a receipt and the nonce is consumed:
        // read directly, in one look, so there is nothing to wait out.
        if (seen.state === 'replaced') {
          await payer.recordFailed(holder, payment)
          return 'failed'
        }
        // Not known to the node at all: the same bytes are offered again (once the relay has
        // the message). Known to the node, including a shallow revert: only look again.
        const known = seen.where === 'mempool' || seen.where === 'included'
        if (known) knownToNode.add(payment.rawTx)
        else knownToNode.delete(payment.rawTx)
        if (broadcast && !known) resubmit.push(payment.rawTx)
      } catch {
        // The chain could not be read or reached: nothing is known, so nothing changes.
      }
      return 'pending'
    }),
  )
  // What the node did not know goes back to it as one set.
  if (resubmit.length > 0)
    noteHandOver(await payer.submitPaymentSet(resubmit).catch(() => []))
  if (states.every((state, i) => state === row.payments[i].state))
    return broadcast ? resignRefused(owner, row) : row
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
    if (states[i] !== 'pending') payer.releasePayment(holder, payment)
  })
  return next
}

/**
 * Finishes the payment of a delivered message whose transfer the chain mined and reverted: one
 * new transfer of the same value to the same address, from a coin claimed for it now. The row
 * with the new signed transfer is on stable storage before the transfer is handed to the node;
 * from then on it is a payment of this message like any other and the resend pass settles it.
 * When no coin covers it now it stays owed, and a later pass tries again. Never throws.
 */
async function repayReverted(
  owner: CanonicalMessagingOwner,
  consumerId: string,
): Promise<void> {
  const payer = owner.payer()
  const holder = holderOf(owner, consumerId)
  for (const index of owedRepayments(owner.messages.get(consumerId)!)) {
    const reverted = Transaction.from(
      owner.messages.get(consumerId)!.payments[index].rawTx,
    )
    let recorded = false
    // This repayment's own coins: the holder also holds the coins of the message's other,
    // already signed payments, and those stay held whatever happens here.
    let claim: StampClaim | undefined
    try {
      claim = await payer.claim({
        holder,
        stampValueWei: reverted.value,
        allowBelowFee: true,
        whileBusy: busyHolder => {
          owner.payer()
          return settleHolder(owner, busyHolder)
        },
      })
      const [signed] = await payer.sign(claim, owner.chainId, () => reverted.to!)
      if (claim.accounts.length !== 1 || signed === undefined)
        throw new Error('A repeated payment is one transfer')
      await payer.recordSigned(holder, [signed])
      // From the write on, the row may be on disk even when the write reports an error (as in
      // `send`): the coin stays held for this session and the chain decides.
      recorded = true
      await owner.messages.put({
        ...owner.messages.get(consumerId)!,
        payments: [
          ...owner.messages.get(consumerId)!.payments,
          { ...signed, state: 'pending', repays: index },
        ],
      })
      noteHandOver(await payer.submitPaymentSet([signed.rawTx]))
    } catch (error) {
      // Nothing signed left the wallet unless the row has it; then the row keeps the claim.
      // A failed claim let go of what it took itself.
      if (!recorded && claim !== undefined)
        for (const account of claim.accounts) payer.releasePayment(holder, account)
      console.warn(
        `[monad-canonical-dm] the reverted payment ${reverted.hash} of a delivered message is still owed; it is tried again later:`,
        error,
      )
      return
    }
  }
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
  const consumerId = holder.startsWith(prefix)
    ? holder.slice(prefix.length)
    : undefined
  const row =
    consumerId === undefined ? undefined : owner.messages.get(consumerId)
  if (consumerId === undefined || !row)
    return void (await owner.settleOtherHolder?.(holder))
  if (row.exposurePending || !row.payments.some(isPending)) return
  const work = workOf(owner, consumerId)
  if (work.creating) return
  if (work.busy) return void (await work.busy)
  // One look per holder, however many sends wait for its coin: a waiter that comes within the
  // gap of the last look makes none. A delivered message's payment is in the node's hands and
  // is looked for at every look of the block watcher (the waiters come at its pace): a second's
  // gap here cost every main-paid message two or three blocks. Undelivered, the gap doubles
  // from a second to sixteen.
  const now = Date.now()
  const watch = owner.payer().watcher.looks
  if (row.outcome === 'delivered' && work.lookedAtWatch === watch) return
  if (
    work.lookedAtMs !== undefined &&
    now - work.lookedAtMs < (row.outcome === 'delivered'
      ? DELIVERED_LOOK_MS
      : work.lookGapMs ?? HOLDER_LOOK_MS)
  )
    return
  work.lookedAtMs = now
  if (row.outcome === 'delivered') work.lookedAtWatch = watch
  work.lookGapMs =
    row.outcome === 'delivered'
      ? DELIVERED_LOOK_MS
      : Math.min(
          work.lookedAtMs === undefined || work.lookGapMs === undefined
            ? HOLDER_LOOK_MS
            : work.lookGapMs * 2,
          HOLDER_LOOK_MAX_MS,
        )
  let ended!: () => void
  work.busy = new Promise<void>(resolve => (ended = resolve))
  try {
    await settlePayments(owner, row, row.outcome === 'delivered')
  } finally {
    work.busy = undefined
    ended()
  }
}

async function authorizeEnvelope(
  owner: CanonicalMessagingOwner,
  row: StoredMessage,
  callback: (digest: string, messageId?: string) => void | Promise<void>,
): Promise<StoredMessage> {
  await owner.lifetime(async () =>
    callback(row.digest, formatUuid(fromHex(row.consumerId.slice('frank-dm:'.length)))),
  )
  const { exposurePending: _pending, ...authorized } = row
  await owner.lifetime(() => owner.messages.put(authorized))
  return authorized
}

async function validateOriginalEnvelope(
  owner: CanonicalMessagingOwner,
  directory: CanonicalDirectory,
  envelope: Pick<
    UnpaidEnvelope,
    'delivery' | 'context' | 'digest' | 'recipientSubject'
  > & { messageId: string },
): Promise<void> {
  const delivery = parseFrame(fromHex(envelope.delivery))
  if (delivery.kind !== 'parsed' || delivery.typed?.type !== TYPE_DIRECT_MESSAGE_DELIVERY)
    throw new Error('Invalid original delivery')
  if (toHex(delivery.typed.payloadDigest) !== envelope.digest)
    throw new Error('Original envelope affinity mismatch')
  await openOwnOriginal(owner, directory, {
    payload: delivery.typed.payloadFrame.frame,
    context: fromHex(envelope.context),
    digest: envelope.digest,
    recipientSubject: envelope.recipientSubject,
    messageId: envelope.messageId,
  })
}

/**
 * Opens this wallet's own original message (sealed or not) with its own keys, after checking it
 * is addressed as stored: its network, recipient, digest and, for a sealed one, the sender inside
 * its ciphertext. Returns what it carries. Nothing is stored or sent.
 */
async function openOwnOriginal(
  owner: CanonicalMessagingOwner,
  directory: CanonicalDirectory,
  original: {
    payload: Uint8Array
    context: Uint8Array
    digest: string
    recipientSubject: string
    messageId: string
  },
): Promise<OpenedDirectMessage> {
  const parsed = parseFrame(original.payload)
  const payload = parsed.kind === 'parsed' ? parsed.typed : undefined
  if (
    payload?.type !== TYPE_RECIPIENT_ENCRYPTED_PAYLOAD ||
    payload.network !== directory.network ||
    (payload.sender !== undefined &&
      toHex(payload.sender.keyBytes) !== owner.subject) ||
    toHex(payload.recipient.keyBytes) !== original.recipientSubject ||
    toHex(recipientPayloadDigest(directory.network, original.payload)) !==
      original.digest
  )
    throw new Error('Original envelope affinity mismatch')
  const self = await directory.selfCurrent()
  const peer = await directory.peerCurrent({
    subject: original.recipientSubject,
  })
  if (!peer) throw new Error('Original recipient unavailable')
  const context = original.context
  let sealedSenderT1: Uint8Array | undefined
  if (payload.sender === undefined) {
    const roles = owner.roles.create(directory.network, self)
    try {
      const peeked = peekSealedDirectMessageSender({
        mode: 'sender',
        network: directory.network,
        payload: original.payload,
        context,
        roles,
      })
      if (toHex(peeked.sender.keyBytes) !== owner.subject)
        throw new Error('Original envelope affinity mismatch')
      sealedSenderT1 = peeked.senderT1
    } finally {
      roles.dispose()
    }
  }
  const evidence = await resolveHistoricalEvidence(
    directory,
    context,
    true,
    self,
    owner.subject,
    peer,
    sealedSenderT1,
  )
  const roles = owner.roles.create(directory.network, self)
  let opened: OpenedDirectMessage
  try {
    opened = openOwnDirectMessage({
      mode: 'send',
      network: directory.network,
      payload: original.payload,
      context,
      roles,
      senderCurrent: self,
      recipientCurrent: peer.current,
      ...evidence,
    })
  } finally {
    roles.dispose()
  }
  if (toHex(opened.messageId) !== original.messageId)
    throw new Error('Original stable identity mismatch')
  return opened
}

/**
 * A sealed message leaves no outbox row at the relay (the relay is not told who sent it), so
 * the account's other devices, and a restore that reads the mailbox, would never see it or the
 * coins its payment spent. Every sealed send therefore also writes notes to self, free like
 * every note to self: the sent message (`outbox-message`, carrying the original's item frames),
 * and, for a paid send, one `wallet-sync` item per signed transaction of its bundle (the stamp
 * payments and the wallet's own change/self-sends) in a second note. The other devices apply the
 * spends through `applyWalletSyncItem` and show the message as sent.
 *
 * The spends travel in their own note so the message's note is bounded by the message alone: it
 * holds the original's items and a fixed set of fields, in one `outbox-message` item that may hold
 * what a direct message carries (not the 512 KiB of other plugin items). {@link
 * requireSelfCopyFits} checks, before a sealed send pays or hands out anything, that it fits in a
 * direct message.
 *
 * Each note's message ID is derived from the original's payload digest, so a repeat is the same
 * note: named free sends keep their sealed envelope until delivered, and applying a note twice
 * changes nothing. The original is opened again with this wallet's keys to recover what it
 * carries, so a resend after a restart builds exactly the same items without the plaintext ever
 * being stored.
 */
async function deliverSealedSelfCopy(
  owner: CanonicalMessagingOwner,
  directory: CanonicalDirectory,
  original: {
    payload: Uint8Array
    context: Uint8Array
    digest: string
    recipientSubject: string
    messageId: string
    sentAt: number
    stampValueWei?: bigint
    transactions: readonly string[]
  },
): Promise<void> {
  const opened = await openOwnOriginal(owner, directory, original)
  const noStamp = async () => {
    throw new Error('A note to self carries no stamp')
  }
  await send(
    owner,
    {
      recipient: { raw: owner.identityAddress },
      items: [
        selfCopyItem({
          digest: original.digest,
          recipientSubject: original.recipientSubject,
          sentAt: original.sentAt,
          conversationId: opened.conversationId,
          conversationName: opened.conversationName,
          messageId: opened.messageId,
          stampValueWei: original.stampValueWei,
          itemFrames: opened.items.map(item => item.frame),
        }),
      ],
      stampValue: 0n,
      messageId: formatUuid(outboxNoteMessageId(original.digest)),
    },
    noStamp,
  )
  if (original.transactions.length > 0)
    await send(
      owner,
      {
        recipient: { raw: owner.identityAddress },
        items: original.transactions.map(rawTx => spentBySelfCopy(directory.network, rawTx)),
        stampValue: 0n,
        messageId: formatUuid(outboxSpendsMessageId(original.digest)),
      },
      noStamp,
    )
}

/** The `outbox-message` item of a sealed original's note to self. */
function selfCopyItem(original: {
  digest: string
  recipientSubject: string
  sentAt: number
  conversationId?: Uint8Array | string
  conversationName?: string
  messageId: Uint8Array | string
  stampValueWei?: bigint
  itemFrames: readonly Uint8Array[]
}): OutboxMessageItem {
  return buildOutboxMessageItem({
    payloadDigest: original.digest,
    recipientAddress: computeAddress('0x' + original.recipientSubject),
    recipientPublicKey: original.recipientSubject,
    sentAt: original.sentAt,
    ...(original.conversationId === undefined
      ? {}
      : { conversationId: original.conversationId }),
    ...(original.conversationName === undefined
      ? {}
      : { conversationName: original.conversationName }),
    messageId: original.messageId,
    ...(original.stampValueWei === undefined
      ? {}
      : { stampValueWei: original.stampValueWei }),
    itemFrames: original.itemFrames,
  })
}

/** A sealed send whose note to self could not be carried in a direct message: refused before
 * anything was paid, sealed or handed out. The account's other devices would never see it. */
export class SealedSelfCopyTooLargeError extends MessageItemEncodeError {
  constructor(detail: string) {
    super(
      'outbox-message',
      `this sealed message is too large for the note to self that shows it on the account's other devices (${detail}); nothing was paid or sent`,
    )
    this.name = 'SealedSelfCopyTooLargeError'
    Object.setPrototypeOf(this, SealedSelfCopyTooLargeError.prototype)
  }
}

/**
 * Refuses a sealed send whose note to self would not fit in a direct message, before anything is
 * paid, sealed or handed out. The note is built and sealed here exactly as
 * {@link deliverSealedSelfCopy} will build and seal it, under the same codec limits that bound
 * every direct message; the facts not known yet stand in at their widest: the payload digest
 * (always 32 bytes), the relay's time, and a stamp not yet settled (the largest amount).
 *
 * This is the size limit of a sealed message: the original and its note must both fit. The note
 * holds the original's item frames and its own fields, about 170 bytes more than the sealed
 * original (more for a paid one, whose stamp is counted at its widest), so the largest sealed
 * message is a few hundred bytes smaller than the largest message that names its sender. A
 * larger one is refused here rather than delivered without a note the other devices could
 * read.
 */
async function requireSelfCopyFits(
  owner: CanonicalMessagingOwner,
  directory: CanonicalDirectory,
  original: {
    recipientSubject: string
    messageId: Uint8Array
    conversationId: Uint8Array
    conversationName?: string
    paid: boolean
    itemFrames: readonly Uint8Array[]
  },
): Promise<void> {
  const digest = '00'.repeat(32)
  const item = selfCopyItem({
    digest,
    recipientSubject: original.recipientSubject,
    sentAt: Date.now(),
    conversationId: original.conversationId,
    conversationName: original.conversationName,
    messageId: original.messageId,
    stampValueWei: original.paid ? (1n << 256n) - 1n : undefined,
    itemFrames: original.itemFrames,
  })
  let items: Uint8Array[]
  try {
    items = encodeItemFrames(requireMessageItems(owner), [item], { selfAddressed: true })
  } catch (error) {
    if (!selfCopyCannotSucceed(error)) throw error
    throw new SealedSelfCopyTooLargeError(detailOf(error))
  }
  const self = await directory.selfCurrent()
  try {
    sealUnpaid(owner, directory, {
      senderCurrent: self,
      recipientCurrent: self,
      messageId: outboxNoteMessageId(digest),
      conversationId: allocateOpeningConversationId(
        owner.roles.conversationIdSalt(),
        owner.identityAddress.toLowerCase(),
      ),
      items,
    })
  } catch (error) {
    if (!selfCopyCannotSucceed(error)) throw error
    throw new SealedSelfCopyTooLargeError(detailOf(error))
  }
}

/** A note to self that can never be encoded or sealed: an item this path refuses, or more than a
 * direct message may hold. Sending it again fails the same way, so it is not retried. */
function selfCopyCannotSucceed(error: unknown): boolean {
  return (
    error instanceof MessageItemEncodeError ||
    error instanceof MessageItemUnsupportedError ||
    (error instanceof FrankCodecError && error.category === 'resource')
  )
}

const detailOf = (error: unknown): string =>
  error instanceof MessageItemEncodeError
    ? error.detail
    : error instanceof Error
    ? error.message
    : String(error)

/** A note to self that cannot succeed: said loudly, once, and recorded on the message (by the
 * caller), never retried. */
function reportSelfCopyFailure(digest: string, error: unknown): string {
  console.error(
    `[monad-canonical-dm] the note to self for sealed message ${digest} can never be sent; the account's other devices will not show it:`,
    error,
  )
  return detailOf(error)
}

/** The spend fact one signed transaction of a sealed send carries to the account's other devices. */
function spentBySelfCopy(network: string, rawTx: string): WalletSyncItem {
  const tx = Transaction.from(rawTx)
  if (tx.from === null || tx.hash === null)
    throw new Error('A self copy names only signed transactions')
  return {
    type: 'wallet-sync',
    direction: 'out',
    chainIdentifier: network,
    txHash: tx.hash,
    rawTx: tx.serialized,
    spentInputs: [{ address: tx.from.toLowerCase(), nonce: tx.nonce }],
  }
}

/** A delivered free sealed message whose note to self is owed: sends it, then drops the owed
 * mark (and the envelope, unless a host is bound to it). */
async function deliverOwedFreeSelfCopy(
  owner: CanonicalMessagingOwner,
  directory: CanonicalDirectory,
  found: UnpaidEnvelope & { messageId: string },
): Promise<void> {
  const payload = sealedOriginalPayload(fromHex(found.delivery))
  const { messageId, selfCopyOwed: _owed, sentAt, ...envelope } = found
  if (payload)
    try {
      await deliverSealedSelfCopy(owner, directory, {
        payload,
        context: fromHex(found.context),
        digest: found.digest,
        recipientSubject: found.recipientSubject,
        messageId,
        sentAt: sentAt ?? Date.now(),
        transactions: [],
      })
    } catch (error) {
      if (!selfCopyCannotSucceed(error)) throw error
      // Kept, with the reason, so the failure stays visible (`selfCopyOf`); no longer owed.
      const reason = reportSelfCopyFailure(found.digest, error)
      await owner.lifetime(() =>
        owner.messages.setUnpaid(messageId, { ...envelope, selfCopyFailed: reason }),
      )
      return
    }
  await owner.lifetime(() =>
    owner.messages.setUnpaid(messageId, envelope.hostBound ? envelope : undefined),
  )
}

/** A delivered sealed paid message whose self copy is owed: sends it, then records it as sent. */
async function deliverOwedSelfCopy(
  owner: CanonicalMessagingOwner,
  directory: CanonicalDirectory,
  row: StoredMessage,
): Promise<StoredMessage> {
  if (!row.selfCopyOwed || row.outcome !== 'delivered' || !row.construction)
    return row
  let failed: string | undefined
  try {
    await deliverSealedSelfCopy(owner, directory, {
      payload: fromHex(row.construction.payload),
      context: fromHex(row.construction.context),
      digest: row.digest,
      recipientSubject: row.recipientSubject,
      messageId: row.consumerId.slice('frank-dm:'.length),
      // The relay's time, as the recipient sees it; a row delivered before it was kept has only
      // its local creation time.
      sentAt: row.deliveredAt ?? row.createdAt,
      stampValueWei: BigInt(row.construction.amountWei),
      transactions: [...row.payments, ...row.otherTransactions]
        .map(payment => payment.rawTx)
        .filter(rawTx => rawTx !== ''),
    })
  } catch (error) {
    if (!selfCopyCannotSucceed(error)) throw error
    failed = reportSelfCopyFailure(row.digest, error)
  }
  const { selfCopyOwed: _owed, ...copied } = owner.messages.get(row.consumerId)!
  const next = failed === undefined ? copied : { ...copied, selfCopyFailed: failed }
  await owner.lifetime(() => owner.messages.put(next))
  return next
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
  options: {
    digests?: ReadonlySet<string>
    now?: boolean
    onEnvelopeDurable?: (
      digest: string,
      messageId?: string,
    ) => void | Promise<void>
  } = {},
): Promise<void> {
  // Free originals are resumed only when explicitly named, never reconstructed from UI data.
  const freeResends = Promise.all(
    [...(options.digests ?? [])].map(async digest => {
      const found = owner.messages.unpaidByDigest(digest)
      if (!found || found.outcome !== undefined) return
      const consumerId = consumerOf(fromHex(found.messageId))
      const work = workOf(owner, consumerId)
      if (work.creating) return
      if (work.busy) {
        await work.busy
        return
      }
      let ended!: () => void
      work.busy = new Promise<void>(resolve => (ended = resolve))
      try {
        await validateOriginalEnvelope(owner, directory, found)
        let envelope = owner.messages.unpaid(found.messageId)!
        if (envelope.exposurePending) {
          if (!options.onEnvelopeDurable) return
          await owner.lifetime(async () =>
            options.onEnvelopeDurable!(
              digest,
              formatUuid(fromHex(found.messageId)),
            ),
          )
          const { exposurePending: _pending, ...authorized } = envelope
          await owner.lifetime(() =>
            owner.messages.setUnpaid(found.messageId, authorized),
          )
          envelope = authorized
        }
        const accepted = await submitCanonicalRequest({
          installedRelayOrigin: owner.relayBaseUrl,
          expectedNetworkTag: owner.installedNetworkTag,
          request: freezeCanonicalRequest(
            {
              delivery: fromHex(envelope.delivery),
              context: fromHex(envelope.context),
              transactions: [],
            },
            envelope.boundary,
          ),
          fetch: directory.fetch,
        })
        // A delivered sealed original owes its note to self; the owed-copy pass below sends it,
        // in this same call.
        const owesCopy =
          accepted.phase === 'delivered' &&
          sealedOriginalPayload(fromHex(envelope.delivery)) !== undefined
        if (accepted.phase === 'delivered' || accepted.phase === 'dead')
          await owner.lifetime(() =>
            owner.messages.setUnpaid(found.messageId, {
              ...envelope,
              outcome: accepted.phase as 'delivered' | 'dead',
              ...(accepted.phase === 'dead' ? { reason: accepted.reason } : {}),
              ...(owesCopy
                ? {
                    selfCopyOwed: true as const,
                    sentAt: accepted.mailbox_committed_at_ms ?? Date.now(),
                  }
                : {}),
            }),
          )
      } finally {
        work.busy = undefined
        ended()
      }
    }),
  )
  // Free sealed messages already delivered whose note to self is still owed (paid rows owe
  // theirs through `selfCopyOwed` on the row, below).
  const owedCopies = freeResends.then(() =>
    Promise.all(
      owner.messages.owedSelfCopies().map(async found => {
        const work = workOf(owner, consumerOf(fromHex(found.messageId)))
        if (work.creating || work.busy) return
        if (!due(work.submit, SUBMIT_EVERY, options.now === true)) return
        let ended!: () => void
        work.busy = new Promise<void>(resolve => (ended = resolve))
        try {
          await deliverOwedFreeSelfCopy(owner, directory, found)
        } catch (error) {
          console.warn(
            '[monad-canonical-dm] the note to self for a sealed message was not delivered; it is sent again later:',
            error,
          )
        } finally {
          work.busy = undefined
          ended()
        }
      }),
    ),
  )
  // An ended never-signed message whose payment release did not finish (a crash between the two).
  const releases = Promise.all(
    owner.messages
      .all()
      .filter(row => row.outcome === 'dead' && unconstructed(row) && row.paymentOperationId && !row.paymentReleased)
      .map(async row => {
        const work = workOf(owner, row.consumerId)
        if (work.creating || work.busy) return
        await owner.lifetime(() => releaseEndedPayment(owner, row))
      }),
  )
  const paidResends = Promise.all(
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
          // Its payments can never land and the relay never held it: its payment is built again
          // below, and the message is submitted with it in this same pass.
          if (
            row.version === 2 && row.outcome === undefined && row.unstored &&
            row.request !== undefined && row.payments.length > 0 &&
            due(work.rebuild, CHAIN_EVERY, now)
          ) {
            const rebuilt = await owner.lifetime(() => rebuildTakenPayment(owner, row))
            if (rebuilt !== row) work.submit = { passes: 0, next: 1, gap: 0 }
            row = rebuilt
          }
          if (sharedConstructionPending(row)) {
            try {
              row = await owner.lifetime(() => finishSharedConstruction(owner, row))
            } catch (error) {
              // The free coins do not cover it and this wallet's own earlier sends, not on the
              // chain yet, would (owner ruling 2026-10-26, as for a send refused at once): it
              // ends now, saying so and how much, and is never signed or sent by this pass.
              // Only the user's Retry, under the same message ID, sends it again.
              if (error instanceof FundsInPendingSendError &&
                  await endUnconstructed(owner, row, 'funds_tied_up', error.tiedUpWei)) {
                console.warn(
                  `[monad-canonical-dm] message ${row.digest} was not sent: ${error.tiedUpWei} wei is tied up in a previous send that has not reached the chain yet. It ends here; a Retry sends it again.`,
                )
                return
              }
              // This intent remains pending for its own retry. Other operations can still
              // settle and report their status; malformed or uncertain authority still fails.
              if (error instanceof EvmTransactionSetInsufficientFundsError) return
              // Over the fee the user authorized, before anything was signed: it ends, and the
              // payment it would have joined is given back.
              if (error instanceof EvmTransactionSetFeeExceededError &&
                  await endUnconstructed(owner, row, 'fee_exceeded')) return
              throw error
            }
          }
          if (row.exposurePending) {
            if (!options.onEnvelopeDurable || !options.digests?.has(row.digest))
              return
            row = await authorizeEnvelope(owner, row, options.onEnvelopeDurable)
          }
          if (row.outcome === undefined && due(work.submit, SUBMIT_EVERY, now)) {
            const submitted = await submitStored(owner, directory, row)
            if (submitted.error)
              console.warn(
                '[monad-canonical-dm] resend failed; the same message is sent again later:',
                submitted.error,
              )
            row = submitted.row
            // Refused before exposure, as every submission before it: nothing of it left the
            // wallet, so it ends and its coins are free.
            if (submitted.refusedUnexposed)
              row = await endRefusedUnexposed(owner, row)
            // Just delivered: its payments are broadcast in this same pass.
            if (row.outcome === 'delivered')
              work.chain = { passes: 0, next: 1, gap: 0 }
          }
          if (
            (row.payments.some(isPending) || row.otherTransactions.some(isPending)) &&
            due(work.chain, CHAIN_EVERY, now)
          ) {
            const settled = await settlePayments(
              owner,
              row,
              row.outcome === 'delivered',
            )
            if (settled !== row) work.chain = { passes: 0, next: 1, gap: 0 }
          }
          // Delivered, and the chain shows a payment of it taken by another transaction: the
          // same amount goes to the same destination from other coins, once.
          {
            const current = owner.messages.get(stored.consumerId)!
            if (
              (sharedRepaymentCandidates(current).length > 0 ||
                current.repayments?.some(repayment => repayment.state === 'pending')) &&
              due(work.repay, CHAIN_EVERY, now)
            )
              await owner.lifetime(() => repayTakenPayments(owner, current)).catch(error =>
                console.warn('[monad-canonical-dm] a taken payment was not paid again yet; tried later:', error),
              )
          }
          // The earlier payment operations of a payment built again settle on the chain.
          {
            const current = owner.messages.get(stored.consumerId)!
            if (replacedUnsettled(owner, current) && due(work.replaced, CHAIN_EVERY, now))
              await owner.lifetime(() => settleReplacedOperations(owner, current))
          }
          // A delivered sealed message whose note to self is still owed: sent now, paced like a
          // submission. Its failure leaves it owed for a later pass.
          {
            const current = owner.messages.get(stored.consumerId)!
            if (
              current.outcome === 'delivered' &&
              current.selfCopyOwed &&
              due(work.submit, SUBMIT_EVERY, now)
            )
              await deliverOwedSelfCopy(owner, directory, current).catch(error =>
                console.warn(
                  '[monad-canonical-dm] the note to self for a sealed message was not delivered; it is sent again later:',
                  error,
                ),
              )
          }
          // A delivered message whose payment the chain reverted is still owed that payment.
          // (Once nothing of it is pending: its claims are then all settled.)
          if (
            !owner.messages.get(stored.consumerId)!.payments.some(isPending) &&
            owner.messages.get(stored.consumerId)!.version === 1 &&
            owedRepayments(owner.messages.get(stored.consumerId)!).length > 0 &&
            due(work.repay, CHAIN_EVERY, now)
          )
            await repayReverted(owner, stored.consumerId)
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
  // Any transaction set of this wallet another transaction took a nonce of: what stands on it
  // and can never land is given up, so it no longer holds its account or counts as money on its
  // way back (`FundsInPendingSendError`). Chain reads only.
  const takenSets = owner.transactionSets
    ? Promise.all(
        owner.transactionSets.preparer.undecidedSupersededOperations().map(async id => {
          if (!due(takenSetPace(owner, id), CHAIN_EVERY, options.now === true)) return
          await owner.lifetime(() =>
            abandonTakenMembers({
              authority: owner.transactionSets!.preparer,
              provider: owner.transactionSets!.provider,
              operationId: id,
            }),
          )
        }),
      )
    : Promise.resolve()
  await Promise.all([owedCopies, paidResends, releases, takenSets])
}

/** At open, before the wallet is handed out: the coins every stored message with a pending
 * payment pays from are its again, so nothing else selects them; a coin with a transaction out
 * that no stored message names is free again (nothing could have sent it). No request. */
export async function restoreOutgoingClaims(
  owner: CanonicalMessagingOwner,
): Promise<void> {
  const payer = owner.payer()
  for (let row of owner.messages.all()) {
    if (row.version === 2) {
      if (sharedRefusedAndReleased(row)) {
        validateSharedStoredMessage(row)
        continue
      }
      if (sharedConstructionPending(row))
        row = await finishSharedConstruction(owner, row, 'restore')
      const operationId = row.transactionSetOperationId
      validateSharedStoredMessage(row)
      if (!operationId) throw new Error('Stored stamp operation identity mismatch')
      // Ended before its stamp stage was signed: it names no transaction and holds no coin.
      if (row.outcome === 'dead' && unconstructed(row)) continue
      const operation = await owner.transactionSets?.preparer.readOperation(operationId)
      if (!operation && !sharedConstructionPending(row))
        throw new Error('Stored message is missing its durable signed transaction set')
      if (operation && !sharedConstructionPending(row)) {
        const roleMembers = (role: 'payment' | 'change') => operation.members
          .filter(member => role === 'payment'
            ? member.transactionSet?.stageId === row.transactionSetStageId && member.transactionSet?.role === 'payment'
            : member.transactionSet !== undefined && member.transactionSet.role !== 'payment')
        const payments = roleMembers('payment')
        const changes = roleMembers('change')
        if (payments.length !== row.payments.length || changes.length !== row.otherTransactions.length ||
            payments.some((member, i) => member.signed?.rawTransaction !== row.payments[i]!.rawTx) ||
            changes.some((member, i) => member.signed?.rawTransaction !== row.otherTransactions[i]!.rawTx))
          throw new Error('Stored message payment/change roles do not match the wallet journal')
      }
      continue
    }
    // One claim per coin: a payment signed more than once at its nonce names its coin again.
    const pending = row.payments
      .filter(isPending)
      .filter(
        (payment, at, all) =>
          all.findIndex(
            other =>
              other.address === payment.address && other.index === payment.index,
          ) === at,
      )
    if (pending.length === 0) continue
    // Two records naming one coin must never stop the wallet from opening: the first keeps the
    // claim, both stay in the resend pass, and the chain says which payment landed.
    const contested = await payer.restore(
      holderOf(owner, row.consumerId),
      pending,
    )
    if (contested.length > 0)
      console.warn(
        `[monad-canonical-dm] sent message ${row.digest} names ${contested.join(
          ', ',
        )}, which another unsettled message also pays from. Both are kept; the chain decides.`,
      )
  }
  await payer.finishRestore()
}

function unpaidResult(payloadDigest: string): DirectMessageSendResult {
  return {
    payloadDigest,
    stampValueWei: 0n,
    stampPayments: [],
    preparationTxHashes: [],
  }
}

function throwUnpaidTerminal(reason?: string): never {
  if (reason === 'undeliverable') throw new CanonicalRecipientUndeliverableError()
  if (reason === 'sender_unpublished') throw new CanonicalSenderUnpublishedError()
  throw new UnpaidDirectMessageNotDeliveredError(reason ?? 'dead')
}

async function send(
  owner: CanonicalMessagingOwner,
  // The wallet handle is the client's routing concern; the owner is this wallet.
  params: Omit<Parameters<DirectMessageClient['send']>[0], 'wallet'>,
  resolveDefaultStamp: (minimumStamp?: bigint) => Promise<DefaultStampQuote>,
): Promise<DirectMessageSendResult> {
  if (params.onEnvelopeDurable && params.messageId === undefined)
    throw new DirectMessageArgumentError('messageId')
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
    if (Object.prototype.toString.call(value) === '[object Uint8Array]') {
      let copied: Uint8Array
      try {
        copied = Uint8Array.from(value as Uint8Array)
      } catch {
        throw new DirectMessageArgumentError(argument)
      }
      if (copied.length === 16) return copied
    }
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
    // A named envelope fixes its paid/free mode as well as its bytes. Re-read after every
    // creator wait: the creator may have completed and retained a terminal free receipt.
    const previousFree = params.messageId !== undefined
      ? owner.messages.unpaid(toHex(messageId)) : undefined
    if (previousFree) {
      if (params.stampValue !== 0n) throw new DirectMessageArgumentError('messageId')
      if (
        computeAddress('0x' + previousFree.recipientSubject).toLowerCase() !==
        params.recipient.raw.toLowerCase()
      ) throw new DirectMessageArgumentError('messageId')
      if (previousFree.hostBound && previousFree.outcome) {
        if (previousFree.outcome === 'dead') throwUnpaidTerminal(previousFree.reason)
        return unpaidResult(previousFree.digest)
      }
    }
    const original = owner.messages.get(consumerId)
    if (original && !refusedForTiedUpFunds(original)) {
      if (original.exposurePending && params.onEnvelopeDurable) {
        if (
          computeAddress('0x' + original.recipientSubject).toLowerCase() !==
          params.recipient.raw.toLowerCase()
        ) throw new DirectMessageArgumentError('messageId')
        await owner.lifetime(() =>
          resend(owner, requireDirectory(owner), {
            digests: new Set([original.digest]),
            now: true,
            onEnvelopeDurable: params.onEnvelopeDurable,
          }),
        )
      }
      throw new DirectMessageAlreadyAttemptedError(
        formatUuid(messageId),
        original.digest,
        original.recipientSubject,
      )
    }
    // Its record's write failed: whether it is on disk is unknown, so never a second payment.
    if (work.unrecorded)
      throw new DirectMessageAttemptUnlinkedError(formatUuid(messageId))
    // A step for this row is in flight (a resend submitting the stored free envelope): it owns
    // the row until it ends. Wait, then read again what it left, so the same bytes are never
    // handed to the relay by two writers at once.
    if (work.busy) {
      await work.busy
      work = workOf(owner, consumerId)
      continue
    }
    if (!work.creating) break
    await work.creating
    work = workOf(owner, consumerId)
  }
  let created!: () => void
  work.creating = new Promise<void>(resolve => (created = resolve))
  const holder = holderOf(owner, consumerId)
  const payer = owner.payer()
  let attempted = false
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
    let stampValueWei = params.stampValue
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
    // A sealed message is shown on the account's other devices only through its note to self:
    // one whose note could not be carried is refused here, before anything is paid or sent.
    if (params.sealedSender === true && !selfAddressed)
      await requireSelfCopyFits(owner, directory, {
        recipientSubject: peer.subject,
        messageId,
        conversationId,
        ...conversationName,
        paid: stampValueWei !== 0n,
        itemFrames: items,
      })
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
      /** The original's delivery and context bytes, to reopen it for a sealed self copy. */
      let originalDelivery: Uint8Array
      let originalContext: Uint8Array
      let originalBoundary: string
      if (kept) {
        digest = kept.digest
        originalDelivery = fromHex(kept.delivery)
        originalContext = fromHex(kept.context)
        originalBoundary = kept.boundary
        request = freezeCanonicalRequest(
          {
            delivery: fromHex(kept.delivery),
            context: fromHex(kept.context),
            transactions: [],
          },
          kept.boundary,
        )
      } else {
        const sealedSender =
          params.sealedSender === true
        const unpaid = sealUnpaid(owner, directory, {
          senderCurrent: await directory.selfCurrent(),
          recipientCurrent: peer.current,
          messageId,
          // Sealed into the kept envelope, so a repeat resends these same bytes: a stored
          // envelope's conversation ID and subject are never recomputed or changed.
          conversationId,
          ...conversationName,
          items,
          ...(sealedSender ? { sealedSender: true } : {}),
        })
        digest = unpaid.digest
        request = unpaid.request
        originalDelivery = unpaid.delivery
        originalContext = unpaid.context
        originalBoundary = unpaid.boundary
        if (name)
          await owner.messages.setUnpaid(name, {
            digest,
            delivery: toHex(unpaid.delivery),
            context: toHex(unpaid.context),
            recipientSubject: peer.subject,
            boundary: unpaid.boundary,
            ...(params.onEnvelopeDurable ? { exposurePending: true as const } : {}),
            ...(params.onEnvelopeDurable ? { hostBound: true as const } : {}),
          })
      }
      // The caller learns the message's digest, durably on its side, BEFORE the relay is handed
      // a byte: a free message has no payment attempt to announce it.
      await params.onBeforeExposure?.(digest)
      const held = name ? owner.messages.unpaid(name) : undefined
      if (params.onEnvelopeDurable || held?.exposurePending) {
        if (!params.onEnvelopeDurable || !name || !held)
          throw new MonadStampPendingAttemptError([digest], 'awaiting-host-binding')
        // Keep the marker until both the host effect and this durable clear succeed.
        await owner.lifetime(async () => params.onEnvelopeDurable!(digest))
        const { exposurePending: _pending, ...authorized } = held
        await owner.lifetime(() => owner.messages.setUnpaid(name, { ...authorized, hostBound: true }))
      }
      // From here the relay may hold the message, whatever this call learns of it.
      attempted = true
      const accepted = await submitCanonicalRequest({
        installedRelayOrigin: owner.relayBaseUrl,
        expectedNetworkTag: owner.installedNetworkTag,
        request,
        fetch: directory.fetch,
      }).catch((error: unknown) => {
        // A relay that is out of challenge capacity answers 429: resending the same stored
        // envelope is transport retry. This grants no no-effect evidence.
        if (error instanceof CanonicalTransportError && error.status === 429)
          recordWalletFailure(error, { transientTransport: true })
        throw error
      })
      if (accepted.phase === 'dead') {
        // Host-bound IDs retain this terminal receipt; only an unbound send drops its envelope.
        if (name) {
          const envelope = owner.messages.unpaid(name)!
          await owner.messages.setUnpaid(name, envelope.hostBound
            ? { ...envelope, outcome: 'dead', reason: accepted.reason }
            : undefined)
        }
        throwUnpaidTerminal(accepted.reason)
      }
      // Anything but delivered is the caller's error to act on; the envelope stays for its repeat.
      if (accepted.phase !== 'delivered')
        throw new UnpaidDirectMessageNotDeliveredError(accepted.phase)
      // The message is delivered. A sealed one leaves no outbox row, so the account's other
      // devices learn of it from a note to self. That note is a separate fact: if it does not get
      // through now, the send still reports delivered, and the envelope is kept (under the
      // message ID, named or drawn) as owing the note, which every later reconcile pass retries.
      const sealedOriginal = selfAddressed
        ? undefined
        : sealedOriginalPayload(originalDelivery)
      if (sealedOriginal) {
        const sentAt = accepted.mailbox_committed_at_ms ?? Date.now()
        try {
          await deliverSealedSelfCopy(owner, directory, {
            payload: sealedOriginal,
            context: originalContext,
            digest,
            recipientSubject: peer.subject,
            messageId: toHex(messageId),
            sentAt,
            transactions: [],
          })
        } catch (error) {
          // One that can never be sent is kept with its reason (`selfCopyOf`), not retried.
          const cannot = selfCopyCannotSucceed(error)
          if (!cannot)
            console.warn(
              '[monad-canonical-dm] the note to self for a sealed message was not delivered; it is sent again later:',
              error,
            )
          const failed = cannot ? reportSelfCopyFailure(digest, error) : undefined
          const owedName = name ?? toHex(messageId)
          const { selfCopyOwed: _owed, ...envelope } = owner.messages.unpaid(owedName) ?? {
            digest,
            delivery: toHex(originalDelivery),
            context: toHex(originalContext),
            recipientSubject: peer.subject,
            boundary: originalBoundary,
          }
          await owner.messages.setUnpaid(owedName, {
            ...envelope,
            outcome: 'delivered',
            ...(failed === undefined
              ? { selfCopyOwed: true as const, sentAt }
              : { selfCopyFailed: failed }),
          })
          return unpaidResult(digest)
        }
      }
      if (name) {
        const envelope = owner.messages.unpaid(name)!
        await owner.messages.setUnpaid(name, envelope.hostBound
          ? { ...envelope, outcome: 'delivered' }
          : undefined)
      }
      return unpaidResult(digest)
    }
    if (stampValueWei !== undefined && (stampValueWei <= 0n || stampValueWei >= 1n << 256n))
      throw new Error('canonical-wallet:economics-invalid')
    // A paid stamp is never below the payment floor (ten times what the chain charges to
    // move it). The wallet's own default is raised to that; an amount the caller chose is
    // refused, not changed.
    let requestedWei = stampValueWei
    const sharedSets = owner.transactionSets
    if (!sharedSets)
      throw new Error('Shared stamp transaction preparation is unavailable')
    let floorWei: bigint | undefined
    try {
      floorWei = await owner.lifetime(() => payer.minimumPaymentWei())
    } catch (error) {
      if (!(error instanceof ChainUnreachableError) || requestedWei !== undefined)
        throw error
      const quote = await resolveDefaultStamp(undefined)
      if (quote.status === 'unavailable') throw new DefaultStampUnavailableError(quote)
      throw error
    }
    if (requestedWei === undefined) {
      const quote = await owner.lifetime(() => resolveDefaultStamp(floorWei))
      if (quote.status === 'unavailable') throw new DefaultStampUnavailableError(quote)
      requestedWei = quote.amount
    }
    stampValueWei = requestedWei
    if (stampValueWei < floorWei)
      throw new DirectMessageStampBelowFeeError(stampValueWei, floorWei)
    attempted = true
    // Fresh snapshots after any wait: the message is sealed to the Current pair in force.
    const senderCurrent = await directory.selfCurrent()
    const recipient = await directory.peerCurrent({ subject: peer.subject })
    if (!recipient)
      throw new CanonicalRecipientNotPublishedError(params.recipient.raw)
    const roles = owner.roles.create(directory.network, senderCurrent)
    const sealedSender =
      params.sealedSender === true
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
        ...(sealedSender ? { sealedSender: true } : {}),
      })
    } finally {
      roles.dispose()
    }
    const digestBytes = recipientPayloadDigest(directory.network, sealed.payload)
    const digest = toHex(digestBytes)
    const payload = parseFrame(sealed.payload)
    if (payload.kind !== 'parsed' || payload.typed?.type !== TYPE_RECIPIENT_ENCRYPTED_PAYLOAD)
      throw new Error('canonical-wallet:payload-required')
    const stageId = `stamp-${toHex(messageId)}`
    const operationId = params.paymentOperationId === undefined ? stageId
      : await sharedSets.resolvePaymentOperation?.(params.paymentOperationId, stampValueWei!)
    if (!operationId) throw new Error('Combined payment and stamp capability is unavailable')
    const construction = {
      network: directory.network,
      payload: toHex(sealed.payload),
      context: toHex(sealed.context),
      amountWei: stampValueWei!.toString(),
      minimumPaymentWei: floorWei.toString(),
      boundary: `frank-${toHex(randomBytes(24))}`,
    }
    // Approval must precede the recoverable intent: replay can finish and submit it
    // without this caller after a restart, even if construction has not signed yet.
    await params.onBeforeExposure?.(digest)
    let row: StoredMessage = {
      version: 2,
      transactionSetOperationId: operationId,
      ...(params.paymentOperationId === undefined ? {} : {
        transactionSetStageId: stageId, paymentOperationId: params.paymentOperationId,
      }),
      consumerId,
      digest,
      recipientSubject: toHex(payload.typed.recipient.keyBytes),
      construction,
      payments: [],
      otherTransactions: [],
      createdAt: Date.now(),
      ...(params.onEnvelopeDurable ? { exposurePending: true as const } : {}),
      ...(elsewhere ? {} : { unexposed: true as const, unstored: true as const }),
      ...(sealedSender && !selfAddressed ? { selfCopyOwed: true as const } : {}),
    }
    try {
      await owner.lifetime(() => owner.messages.put(row))
      recorded = true
      row = await owner.lifetime(() =>
        finishSharedConstruction(owner, row, 'construct', true),
      )
    } catch (error) {
      // Over the fee the user authorized, refused before anything was signed: the message ends
      // and the payment it would have joined is given back. Nothing was paid or sent.
      const stored = recorded ? owner.messages.get(consumerId) : undefined
      if (error instanceof EvmTransactionSetFeeExceededError && stored &&
          await owner.lifetime(() => endUnconstructed(owner, stored, 'fee_exceeded')).catch(() => false))
        throw new NativeFeeExceededError(error.feeWei)
      // The free coins do not cover it but this wallet's earlier sends will hand money back once
      // they reach the chain (owner ruling 2026-10-26): refused now, not kept to be sent later.
      // The message ends and the payment it would have joined is given back; the user retries.
      if (error instanceof FundsInPendingSendError && stored &&
          await owner.lifetime(() => endUnconstructed(owner, stored, 'funds_tied_up', error.tiedUpWei)).catch(() => false))
        throw error
      // The journal or message write may have reached durable storage. Keep the stable ID
      // and every reservation; reopen will finish this same operation.
      work.unrecorded = true
      recorded = true
      throw error
    }
    const signedPayments = row.payments
    let ended!: () => void
    work.busy = new Promise<void>(resolve => (ended = resolve))
    work.creating = undefined
    created()
    try {
      if (params.onEnvelopeDurable)
        row = await authorizeEnvelope(owner, row, params.onEnvelopeDurable)
      await params.onAttemptCreated?.(digest)
      const submitted = await owner.lifetime(() => submitStored(owner, directory, row))
      row = submitted.row
      // Refused before the relay stored or broadcast anything: nothing of it left the wallet,
      // so it ends and its coins are free.
      if (submitted.refusedUnexposed) row = await endRefusedUnexposed(owner, row)
      if (row.outcome === 'dead') {
        if (row.reason === 'undeliverable') throw new CanonicalRecipientUndeliverableError()
        if (row.reason === 'sender_unpublished') throw new CanonicalSenderUnpublishedError()
        throw new MonadStampTerminalError(
          submitted.refusedUnexposed && row.payments.every(payment => payment.state === 'unsent')
            ? `The relay refused this message (${row.reason ?? 'no reason given'}) before broadcasting anything. Nothing was paid.`
            : `The relay refused this message (${row.reason ?? 'no reason given'}). Its signed transaction set remains reserved until chain reconciliation.`,
          422, 'mailbox_terminal', undefined, row.reason,
        )
      }
      // Refused because another transaction took a coin of the set: kept, and paid again from
      // other coins once the chain confirms it (`endRefusedUnexposed`, `rebuildTakenPayment`).
      const takenBeforeStore = async (): Promise<boolean> =>
        row.outcome === undefined && row.reason !== undefined &&
        row.transactionSetOperationId !== undefined &&
        setNonceUsedElsewhere(owner, row.transactionSetOperationId)
      if (row.outcome !== 'delivered')
        throw new MonadStampPendingAttemptError(
          [digest],
          submitted.paymentTaken || await takenBeforeStore()
            ? 'payment-taken'
            : submitted.awaitingFunding ? 'awaiting-funding' : 'awaiting-delivery',
        )
      row = await owner.lifetime(() => settleSharedPayments(owner, row))
      // The message and its payment are out; telling the account's other devices is not a
      // condition of that. A note that does not get through now is sent by the resend pass.
      try {
        row = await owner.lifetime(() => deliverOwedSelfCopy(owner, directory, row))
      } catch (error) {
        console.warn(
          '[monad-canonical-dm] the note to self for a sealed message was not delivered; it is sent again later:',
          error,
        )
      }
    } finally {
      work.busy = undefined
      ended()
    }
    const transactions = signedPayments.map(payment => getBytes(payment.rawTx))
    return {
      payloadDigest: digest,
      stampValueWei,
      stampPayments: payments(transactions),
      preparationTxHashes: [],
    }


  } catch (error) {
    // Once a shared construction intent is recorded, its operation identity is retained
    // across failure and its reservation is recovered from the wallet journal on reopen.
    const reported =
      error instanceof FundsInPendingSendError
        // The reason stays the cause: the caller tells the user to try again in a moment.
        ? new InsufficientStampFundsError(
            `No free funds cover a stamp of ${String(params.stampValue ?? 0n)} wei plus transaction fees: ${error.tiedUpWei} wei is tied up in a previous send that has not reached the chain yet; try again in a moment.`,
            { cause: error },
          )
        : error instanceof EvmTransactionSetInsufficientFundsError
        ? new InsufficientStampFundsError(
            `No funds cover a stamp of ${String(params.stampValue ?? 0n)} wei plus transaction fees.`,
            { cause: error },
          )
        : error
    throw attempted && !(error instanceof StampBlockedError && !recorded)
      ? possiblyAttempted(reported)
      : notAttempted(reported)
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
  sealedSenderT1?: Uint8Array,
): Promise<{
  senderEvidence?: HistoricalEvidence
  recipientEvidence?: HistoricalEvidence
}> {
  if (!directory.peerHistorical) return {}
  try {
    const ctx = decodeDirectMessageCryptoContext(context)
    const senderHashBytes = ctx.senderDirectoryHash ?? sealedSenderT1
    const ctxSenderHash = senderHashBytes
      ? toHex(senderHashBytes).toLowerCase()
      : undefined
    const ctxRecipientHash = toHex(ctx.recipientDirectoryHash).toLowerCase()
    let senderEvidence: HistoricalEvidence | undefined
    let recipientEvidence: HistoricalEvidence | undefined
    if (isOutbound) {
      if (
        ctxSenderHash !== undefined &&
        ctxSenderHash !== toHex(self.evidence.hash).toLowerCase()
      ) {
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
      if (
        ctxSenderHash !== undefined &&
        ctxSenderHash !== toHex(peer.current.evidence.hash).toLowerCase()
      ) {
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

/**
 * Deterministic 16-byte message ID for the self-addressed `outbox-message` note recording the
 * outbound message with `payloadDigest`.
 */
export function outboxNoteMessageId(payloadDigest: string): Uint8Array {
  return getBytes(
    keccak256(
      toUtf8Bytes(`frank-outbox-message:${payloadDigest.toLowerCase()}`),
    ),
  ).slice(0, 16)
}

/**
 * Deterministic 16-byte message ID for the self-addressed note carrying the `wallet-sync` spends
 * of the sealed outbound message with `payloadDigest`.
 */
export function outboxSpendsMessageId(payloadDigest: string): Uint8Array {
  return getBytes(
    keccak256(
      toUtf8Bytes(`frank-outbox-spends:${payloadDigest.toLowerCase()}`),
    ),
  ).slice(0, 16)
}

/**
 * Constructs a canonical {@link OutboxMessageItem} from an outbound message's delivery metadata
 * and encoded item frames.
 */
export function buildOutboxMessageItem(params: {
  payloadDigest: string
  recipientAddress: string
  recipientPublicKey?: Uint8Array | string
  sentAt: number
  conversationId?: Uint8Array | string
  conversationName?: string
  messageId?: Uint8Array | string
  stampValueWei?: bigint
  itemFrames?: readonly Uint8Array[]
  text?: string
}): OutboxMessageItem {
  const convIdStr =
    params.conversationId === undefined
      ? undefined
      : typeof params.conversationId === 'string'
      ? params.conversationId.toLowerCase()
      : formatUuid(params.conversationId)
  const msgIdStr =
    params.messageId === undefined
      ? undefined
      : typeof params.messageId === 'string'
      ? params.messageId.toLowerCase()
      : formatUuid(params.messageId)
  const recipientPubHex =
    params.recipientPublicKey === undefined
      ? undefined
      : typeof params.recipientPublicKey === 'string'
      ? params.recipientPublicKey.replace(/^0x/i, '').toLowerCase()
      : toHex(params.recipientPublicKey)

  return {
    type: 'outbox-message',
    payloadDigest: params.payloadDigest.replace(/^0x/i, '').toLowerCase(),
    recipientAddress: params.recipientAddress.toLowerCase(),
    sentAt: Math.max(0, Math.floor(params.sentAt)),
    ...(convIdStr !== undefined ? { conversationId: convIdStr } : {}),
    ...(params.conversationName !== undefined &&
    params.conversationName.trim().length > 0
      ? { conversationName: params.conversationName.trim() }
      : {}),
    ...(msgIdStr !== undefined ? { messageId: msgIdStr } : {}),
    ...(params.stampValueWei !== undefined
      ? { stampValueWei: params.stampValueWei.toString(10) }
      : {}),
    ...(recipientPubHex !== undefined
      ? { recipientPublicKey: recipientPubHex }
      : {}),
    ...(params.itemFrames !== undefined && params.itemFrames.length > 0
      ? { itemFrames: params.itemFrames.map(toHex) }
      : {}),
    ...(params.text !== undefined && params.text.length > 0
      ? { text: params.text }
      : {}),
  }
}

/**
 * Unwraps a self-addressed {@link DirectMessageReceived} carrying an `outbox-message` item into
 * the reconstructed outbound {@link DirectMessageReceived} as if read from an outbox index.
 *
 * If the message also carries wallet-internal sync notes (`wallet-sync` or `received-coin`), this
 * returns `record` unchanged until those notes have been consumed by `consumeSelfNotes`.
 */
export function projectOutboxMessageRecord(
  record: DirectMessageReceived,
  registry: MessageItemRegistry,
): DirectMessageReceived {
  const isSelf =
    record.senderAddress.raw.toLowerCase() ===
    record.recipientAddress.raw.toLowerCase()
  if (!isSelf) return record
  if (
    record.items.some(
      item => item.type === 'wallet-sync' || item.type === 'received-coin',
    )
  ) {
    return record
  }
  const outboxItem = record.items.find(
    (item): item is OutboxMessageItem => item.type === 'outbox-message',
  )
  if (!outboxItem) return record

  let decodedItems: MessageItem[] = []
  if (outboxItem.itemFrames && outboxItem.itemFrames.length > 0) {
    try {
      const rawFrames = outboxItem.itemFrames.map(fromHex)
      const revisionFrame = validateFrame(
        encodeFrame(
          { typeId: TYPE_MESSAGE_CONTENT_REVISION, schemaVersion: 1, minReaderVersion: 1 },
          new Map<number, Encodable>([
            [MESSAGE_CONTENT_REVISION.network, 'frank'],
            [MESSAGE_CONTENT_REVISION.items, rawFrames],
          ]),
        ),
      )
      if (
        revisionFrame.kind === 'parsed' &&
        revisionFrame.typed?.type === TYPE_MESSAGE_CONTENT_REVISION
      ) {
        decodedItems = decodeItemFrames(
          registry,
          revisionFrame.typed.items,
          standaloneItemBudget(),
          { selfAddressed: false },
        )
      }
    } catch {
      decodedItems = []
    }
  }
  if (decodedItems.length === 0 && outboxItem.text !== undefined) {
    decodedItems = [{ type: 'text', text: outboxItem.text }]
  }

  // The note's authenticated digest describes its own frame, not this reconstructed message.
  // No original content digest is carried by the note, so that capability is unavailable here.
  const noteRecord = { ...record }
  delete noteRecord.contentDigest
  return {
    ...noteRecord,
    outbound: true,
    senderAddress: record.senderAddress,
    senderPublicKey: record.senderPublicKey,
    recipientAddress: { raw: getAddress(outboxItem.recipientAddress) },
    ...(outboxItem.recipientPublicKey !== undefined
      ? { recipientPublicKey: fromHex(outboxItem.recipientPublicKey) }
      : {}),
    items: decodedItems,
    conversationId: outboxItem.conversationId ?? record.conversationId,
    ...(outboxItem.conversationName !== undefined
      ? { conversationName: outboxItem.conversationName }
      : record.conversationName !== undefined
      ? { conversationName: record.conversationName }
      : {}),
    messageId: outboxItem.messageId ?? record.messageId,
    payloadDigest: outboxItem.payloadDigest,
    stampValueWei:
      outboxItem.stampValueWei !== undefined
        ? BigInt(outboxItem.stampValueWei)
        : record.stampValueWei,
    // The note's sentAt describes the original message, not this mailbox receipt: the receipt
    // stays the read position, and the message is placed at when it was sent.
    receivedTime: record.receivedTime,
    ...(Number.isSafeInteger(outboxItem.sentAt) &&
    outboxItem.sentAt > 0 &&
    outboxItem.sentAt <= record.receivedTime
      ? { sentTime: outboxItem.sentAt }
      : {}),
  }
}

/** The payment members of a received delivery that pay THIS wallet: a member's address must be
 * the stamp child of one of the wallet's own stamp keys (current or previous) for the message's
 * shared point, derived for `network`. The delivery frame is written by the sender, so a member
 * paying any other address is somebody else's money and is never reported as received. Not a
 * chain check: whether a reported transfer was mined is for the caller to look up.
 *
 * `network` is the wallet's own installed network, which the delivery was opened against. A stamp
 * settles on the delivery network (README S3); a member naming another network is dropped, so the
 * stamp coin the wallet records (`recordStampPayments`, derived for the same network) and the
 * payment it reports are always the same account. */
export function paymentsToSelf<
  T extends { address: Uint8Array; childIndex?: number; network: string },
>(
  network: string,
  self: Current,
  sharedPoint: Uint8Array,
  payments: readonly T[],
): T[] {
  const keys = [self.stampKey, self.previousStamp].filter(
    (key): key is NonNullable<typeof key> => !!key,
  )
  return payments.filter(member => {
    if (member.childIndex === undefined || member.network !== network)
      return false
    return keys.some(stampKey => {
      try {
        return (
          toHex(
            canonicalStampDestination({
              network,
              stampKey,
              sharedPoint,
              childIndex: member.childIndex!,
            }).address,
          ) === toHex(member.address)
        )
      } catch {
        return false
      }
    })
  })
}

/** A sealed sender's identity can never be read from this record, by any later read. */
function sealedPeekIsTerminal(error: unknown): boolean {
  return (
    error instanceof DirectMessageError &&
    (error.code === 'crypto' ||
      error.code === 'context' ||
      error.code === 'network')
  )
}

/** The record opened (its sender, recipient, entries and keys matched) and still failed: no later
 * read can open it. Shared by the polled read and the live stream. */
function openFailureIsTerminal(error: unknown): boolean {
  return (
    error instanceof MessageItemBudgetExceededError ||
    (error instanceof DirectMessageError &&
      (error.code === 'crypto' ||
        error.code === 'network' ||
        error.code === 'digest'))
  )
}

async function readMailbox(
  owner: CanonicalMessagingOwner,
  params: Parameters<DirectMessageClient['fetchSince']>[0],
  authenticatedOnly = false,
) {
  if (!Number.isSafeInteger(params.sinceMs) || params.sinceMs < 0)
    throw new Error('Canonical mailbox read has an invalid inclusive position')
  let earliestIncomplete = Infinity
  const authenticated: AuthenticatedMailboxRecord[] = []
  const directory = requireDirectory(owner)
  // Before any request: with no registry nothing is read, so nothing is consumed or dropped.
  const registry = requireMessageItems(owner)
  const incomplete = (timestampMs: number) => {
    if (authenticatedOnly) {
      earliestIncomplete = Math.min(earliestIncomplete, timestampMs)
      return
    }
    if (!params.onIncompleteTimestamp)
      throw new Error(
        `Canonical mailbox read is incomplete at timestamp ${timestampMs}`,
      )
    params.onIncompleteTimestamp(timestampMs)
  }
  const auth = mailboxAuth(owner, directory)
  const self = await directory.selfCurrent()
  const received: DirectMessageReceived[] = []
  const own: ChainAddress = { raw: getAddress(owner.identityAddress) }
  type RawPage = {
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
  const pages: RawPage[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  let greatestTimestamp: number | undefined
  let truncated: Error | undefined
  for (let pageIndex = 0; pageIndex < MAX_INBOX_PAGES; pageIndex++) {
    let page: RawPage
    try {
      page = await fetchCanonicalMailboxPage({
        ...auth,
        sinceMs: params.sinceMs,
        ...(cursor === undefined ? {} : { cursor }),
      })
    } catch (error) {
      if (authenticatedOnly) {
        if (pageIndex === 0) throw error
        truncated = error as Error
        break
      }
      if (
        error instanceof MonadMailboxChallengeCapacityError ||
        (error as { status?: number })?.status === 429 ||
        (error as { code?: string })?.code === 'mailbox_challenge_capacity'
      ) {
        if (pageIndex === 0) throw error
        truncated = error as Error
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
        truncated = error as Error
        break
      }
    }
    // The transport partitions unreadable rows from records, so validate each ordered list
    // and the boundary between pages using all raw timestamps, before publishing anything.
    let pageGreatest = greatestTimestamp
    for (const rows of [page.records, page.unreadable ?? []]) {
      let previous = greatestTimestamp
      for (const row of rows) {
        if (
          !Number.isSafeInteger(row.timestampMs) ||
          row.timestampMs < 0 ||
          (authenticatedOnly &&
            (row.timestampMs < params.sinceMs ||
              row.timestampMs === Number.MAX_SAFE_INTEGER))
        )
          throw new Error('Canonical mailbox read has an invalid timestamp')
        if (previous !== undefined && row.timestampMs < previous)
          throw new Error('Canonical mailbox timestamps are out of order')
        previous = row.timestampMs
        pageGreatest = Math.max(
          pageGreatest ?? row.timestampMs,
          row.timestampMs,
        )
      }
    }
    greatestTimestamp = pageGreatest
    pages.push(page)
    cursor = page.nextCursor
    if (cursor === undefined) break
    if (seenCursors.has(cursor))
      throw new Error('Canonical mailbox read returned a repeated cursor')
    seenCursors.add(cursor)
  }
  if (cursor !== undefined && !truncated)
    truncated = new Error(
      `The mailbox read stopped after ${MAX_INBOX_PAGES} pages`,
    )
  const eligible = (timestampMs: number) =>
    !truncated ||
    (greatestTimestamp !== undefined && timestampMs < greatestTimestamp)
  if (truncated) {
    params.onTruncated?.(truncated)
    if (
      !authenticatedOnly &&
      !pages.some(page =>
        [...page.records, ...(page.unreadable ?? [])].some(row =>
          eligible(row.timestampMs),
        ),
      )
    )
      throw new Error(
        'Canonical mailbox read has no complete timestamp prefix',
        { cause: truncated },
      )
  }
  const batchYielder = createCooperativeBatchYielder()
  let startedDecoding = false
  for (const page of pages) {
    // A record this client cannot decode is never a message, never paid and never a received
    // stamp. It is reported as terminal, under the relay's own identity for it, so the host's
    // read position passes it instead of meeting it again on every read.
    for (const skipped of page.unreadable ?? []) {
      if (!eligible(skipped.timestampMs)) continue
      params.onQuarantinedTimestamp?.(
        skipped.timestampMs,
        skipped.submissionIdentity,
      )
    }
    for (const record of page.records) {
      if (!eligible(record.timestampMs)) continue
      if (startedDecoding) {
        await batchYielder.maybeYield()
      } else {
        startedDecoding = true
      }
      const delivery = parseFrame(record.delivery)
      if (delivery.kind !== 'parsed' || delivery.typed?.type !== TYPE_DIRECT_MESSAGE_DELIVERY) continue
      const deliveryTyped = delivery.typed
      const payload = deliveryTyped.payloadFrame.typed
      if (payload?.type !== TYPE_RECIPIENT_ENCRYPTED_PAYLOAD) continue
      const digest = toHex(deliveryTyped.payloadDigest)
      const isOutbound = record.direction === 'out'
      let peerSubjectKeyBytes: Uint8Array
      let sealedSenderT1: Uint8Array | undefined
      if (isOutbound) {
        peerSubjectKeyBytes = payload.recipient.keyBytes
      } else if (payload.sender !== undefined) {
        peerSubjectKeyBytes = payload.sender.keyBytes
      } else {
        const peekRoles = owner.roles.create(directory.network, self)
        try {
          const peeked = peekSealedDirectMessageSender({
            network: directory.network,
            payload: deliveryTyped.payloadFrame.frame,
            context: record.context,
            roles: peekRoles,
          })
          peerSubjectKeyBytes = peeked.sender.keyBytes
          sealedSenderT1 = peeked.senderT1
        } catch (error) {
          // Ciphertext this wallet's key cannot open, or content that is not a sealed sender's,
          // never becomes openable: the record is passed for good. Anything else (a role
          // session this wallet could not make yet) is left for a later read.
          if (sealedPeekIsTerminal(error))
            params.onQuarantinedTimestamp?.(record.timestampMs, digest)
          else incomplete(record.timestampMs)
          continue
        } finally {
          peekRoles.dispose()
        }
      }
      const peerSubjectHex = toHex(peerSubjectKeyBytes)

      // Any peer with a published entry that verifies is shown; no peer list is consulted.
      let peer
      try {
        peer = await directory.peerCurrent({ subject: peerSubjectHex })
      } catch (error) {
        const code = (error as { code?: string } | null)?.code
        if (code === 'invalid' || code === 'fork') {
          // The peer's entry is not signed by that peer, or conflicts with the one pinned
          // for it: this message is never shown.
          params.onQuarantinedTimestamp?.(record.timestampMs, digest)
          continue
        }
        // A lookup failure is not proof that the original message can never be opened.
        // Keep its timestamp in the host's replay window, while delivering other peers' mail.
        incomplete(record.timestampMs)
        continue
      }
      if (!peer) {
        // A relay 404 cannot establish that the sender or its signed history never existed.
        incomplete(record.timestampMs)
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
          sealedSenderT1,
        )
      const roles = owner.roles.create(directory.network, self)
      let items: MessageItem[]
      let conversationIdStr: string | undefined
      let conversationNameStr: string | undefined
      let messageIdStr: string | undefined
      let contentDigest: string
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
        contentDigest = toHex(opened.contentDigest)
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
        if (openFailureIsTerminal(error))
          params.onQuarantinedTimestamp?.(record.timestampMs, digest)
        else incomplete(record.timestampMs)
        continue
      } finally {
        roles.dispose()
      }
      if (authenticatedOnly) {
        // A note to self that copies a sent message (a sealed send leaves no outbox row) reads
        // as that outbound message, as the relay's outbox row of a named send does.
        const copied = isOwnSubject(owner, peerSubjectHex, peer.subject)
          ? items.find(
              (item): item is OutboxMessageItem => item.type === 'outbox-message',
            )
          : undefined
        if (copied?.recipientPublicKey !== undefined) {
          const projected = projectOutboxMessageRecord(
            {
              senderAddress: { raw: owner.identityAddress },
              recipientAddress: { raw: owner.identityAddress },
              items: [copied],
              receivedTime: record.timestampMs,
              payloadDigest: digest,
              stampValueWei: 0n,
              stampPayments: [],
            },
            registry,
          )
          authenticated.push({
            chainIdentifier: directory.network,
            senderPublicKey: fromHex(owner.subject),
            recipientPublicKey: fromHex(copied.recipientPublicKey),
            direction: 'outbound',
            payloadDigest: copied.payloadDigest,
            receivedTime: record.timestampMs,
            items: projected.items,
            ...(projected.conversationId === undefined
              ? {}
              : { conversationId: projected.conversationId }),
            ...(projected.messageId === undefined
              ? {}
              : { messageId: projected.messageId }),
          })
          continue
        }
        authenticated.push({
          chainIdentifier: directory.network,
          senderPublicKey: fromHex(isOutbound ? owner.subject : peer.subject),
          recipientPublicKey: fromHex(
            isOutbound ? peer.subject : owner.subject,
          ),
          direction: isOutbound ? 'outbound' : 'incoming',
          payloadDigest: digest,
          receivedTime: record.timestampMs,
          items,
          ...(conversationIdStr === undefined
            ? {}
            : { conversationId: conversationIdStr }),
          ...(messageIdStr === undefined ? {} : { messageId: messageIdStr }),
        })
        continue
      }
      const paidHere = isOutbound
        ? deliveryTyped.payments
        : paymentsToSelf(
            directory.network,
            self,
            payload.sharedPoint,
            deliveryTyped.payments,
          )
      const stampPayments = paidHere.flatMap(member =>
        member.childIndex === undefined
          ? []
          : [
              {
                childIndex: member.childIndex,
                ...(member.rawTx ? { rawTx: hexlify(member.rawTx) } : {}),
                txHash: hexlify(member.transactionId),
                destinationAddress: getAddress(hexlify(member.address)),
                valueWei:
                  typeof member.value === 'bigint'
                    ? member.value
                    : BigInt(hexlify(member.value)),
              },
            ],
      )
      const paymentTransfers = paidHere
      const peerAddress: ChainAddress = {
        raw: getAddress(computeAddress('0x' + peer.subject)),
      }
      received.push(
        projectOutboxMessageRecord(
          {
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
            contentDigest,
            payloadDigest: digest,
            stampValueWei: stampPayments.reduce(
              (sum, p) => sum + p.valueWei,
              0n,
            ),
            stampPayments,
            stampSharedPoint: toHex(payload.sharedPoint),
            paymentTransfers,
            receivedTime: record.timestampMs,
          },
          registry,
        ),
      )
    }
  }
  const completedTimestamps = pages
    .flatMap(page =>
      [...page.records, ...(page.unreadable ?? [])].map(row => row.timestampMs),
    )
    .filter(timestamp => eligible(timestamp) && timestamp < earliestIncomplete)
  return {
    received,
    records: authenticated.filter(
      record => record.receivedTime < earliestIncomplete,
    ),
    resumeFromInclusive:
      completedTimestamps.length === 0
        ? params.sinceMs
        : Math.max(...completedTimestamps) + 1,
    // Completeness is independent of cursor movement, including an empty mailbox.
    truncated: truncated !== undefined || earliestIncomplete !== Infinity,
  }
}

/** The canonical implementation of the app-facing direct-message operations for one wallet.
 * Nothing here queues: every send does its own work and holds no lock over a network wait. */
export function canonicalDirectMessages(
  owner: CanonicalMessagingOwner,
  resolveDefaultStamp: (minimumStamp?: bigint) => Promise<DefaultStampQuote>,
) {
  return {
    send: (params: Parameters<DirectMessageClient['send']>[0]) =>
      send(owner, params, resolveDefaultStamp),
    deliveryOf: async (
      params: Parameters<NonNullable<DirectMessageClient['deliveryOf']>>[0],
    ): Promise<DirectMessageAttemptStatus | undefined> => {
      if (!/^[0-9a-f]{64}$/.test(params.payloadDigest))
        throw new Error('Expected canonical message payload digest')
      const row = owner.messages.all().find(row => row.digest === params.payloadDigest)
        ?? owner.messages.unpaidByDigest(params.payloadDigest)
      if (!row) return undefined
      return row.exposurePending ? 'live' : row.outcome ?? 'live'
    },
    endOf: async (
      params: Parameters<NonNullable<DirectMessageClient['endOf']>>[0],
    ): Promise<DirectMessageEnd | undefined> => {
      if (!/^[0-9a-f]{64}$/.test(params.payloadDigest))
        throw new Error('Expected canonical message payload digest')
      const row = owner.messages.all().find(row => row.digest === params.payloadDigest)
        ?? owner.messages.unpaidByDigest(params.payloadDigest)
      if (!row || row.exposurePending || row.outcome !== 'dead') return undefined
      // Ended by this wallet before anything of it was signed or handed out (`endUnconstructed`).
      if ('payments' in row && unconstructed(row)) {
        if (row.reason === 'fee_exceeded') return { reason: 'fee-exceeded' }
        if (row.reason === 'discarded') return { reason: 'discarded' }
        if (row.reason === 'funds_tied_up')
          return {
            reason: 'funds-tied-up',
            ...('tiedUpWei' in row && row.tiedUpWei !== undefined ? { tiedUpWei: BigInt(row.tiedUpWei) } : {}),
          }
      }
      if ('payments' in row && row.reason === PAYMENT_TAKEN_REASON) return { reason: 'payment-taken' }
      return { reason: 'relay', ...(row.reason === undefined ? {} : { relayReason: row.reason }) }
    },
    /**
     * The host's tick. Drives every unresolved message of this wallet one step (see `resend`),
     * whichever digests are named, and answers for the named ones. `maxPutAttempts` above 1 is
     * a person asking now: the named messages are acted on at once instead of on their turn.
     */
    reconcileAttempts: async (
      params: Parameters<DirectMessageClient['reconcileAttempts']>[0],
    ) => {
      const messageIds = [...(params.messageIds ?? [])]
      if (
        messageIds.length > 64 ||
        new Set(messageIds).size !== messageIds.length ||
        messageIds.some(
          id =>
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
              id,
            ),
        )
      )
        throw new DirectMessageArgumentError('messageId')
      const digests = new Set(params.payloadDigests)
      for (const id of messageIds) {
        const name = id.replace(/-/g, '')
        const paid = owner.messages.get(consumerOf(fromHex(name)))
        const unpaid = owner.messages.unpaid(name)
        if (paid && unpaid)
          throw new Error('Conflicting original message identity')
        if (paid) digests.add(paid.digest)
        if (unpaid?.hostBound) digests.add(unpaid.digest)
      }
      const directory = requireDirectory(owner)
      await owner.lifetime(async () => {
        // Validate the whole named stable-ID set before any callback, marker clear or handoff.
        for (const id of messageIds) {
          const name = id.replace(/-/g, '')
          const paid = owner.messages.get(consumerOf(fromHex(name)))
          const unpaid = owner.messages.unpaid(name)
          if (paid?.request) {
            const request = restoreCanonicalRequest({
              body: fromHex(paid.request.body),
              contentType: paid.request.contentType,
            })
            await validateOriginalEnvelope(owner, directory, {
              delivery: toHex(request.parts.delivery),
              context: toHex(request.parts.context),
              digest: paid.digest,
              recipientSubject: paid.recipientSubject,
              messageId: name,
            })
          } else if (paid?.exposurePending && !sharedConstructionPending(paid))
            // A message whose stamp stage is not signed yet has no bytes to hold: the resend
            // pass below signs it (or ends it) first.
            throw new Error('Held original message bytes unavailable')
          if (unpaid?.hostBound)
            await validateOriginalEnvelope(owner, directory, {
              ...unpaid,
              messageId: name,
            })
        }
        await resend(owner, directory, {
          digests,
          now: (params.maxPutAttempts ?? 1) > 1,
          onEnvelopeDurable: params.onEnvelopeDurable,
        })
      })
      return Object.fromEntries(
        [...digests].map(digest => [digest, statusOf(owner, digest)]),
      )
    },
    /** One look at the chain for the message that holds a coin another operation is waiting
     * for (a native send waiting for the main account). No relay request. */
    settleHolder: (holder: string) =>
      owner.lifetime(() => settleHolder(owner, holder)),
    /** Whether the chain's node answers, as the wallet's reads last found. No request. */
    chainHealth: () => owner.payer().watcher.health(),
    /** Preview and implicit send share the same host resolver and live adapter floor. */
    defaultStampQuote: async (): Promise<DefaultStampQuote> => {
      let floor: bigint
      try { floor = await owner.lifetime(() => owner.payer().minimumPaymentWei()) }
      catch (error) {
        if (!(error instanceof ChainUnreachableError)) throw error
        return resolveDefaultStamp(undefined)
      }
      return owner.lifetime(() => resolveDefaultStamp(floor))
    },
    /** The smallest paid stamp right now: the payment floor (`payment-floor.ts`), ten
     * transfers' fees at the node's gas price, so its recipient can always move it. */
    minimumStamp: () => owner.lifetime(async () => {
      await owner.transactionSets?.refresh()
      return owner.payer().minimumPaymentWei()
    }),
    /** What the chain has shown of the payments of one sent message. No request is made. */
    paymentsOf: (payloadDigest: string): StoredPayment['state'][] | undefined =>
      owner.messages
        .all()
        .find(row => row.digest === payloadDigest)
        ?.payments.map(payment => payment.state),
    /** Whether the note to self of a sealed message this wallet sent is still owed, or can
     * never be sent (and why). `undefined`: none is owed or failed for that digest. No request. */
    selfCopyOf: (payloadDigest: string): DirectMessageSelfCopyState | undefined => {
      const row = owner.messages.all().find(r => r.digest === payloadDigest)
      const found =
        row ??
        owner.messages.failedSelfCopies().find(e => e.digest === payloadDigest) ??
        owner.messages.owedSelfCopies().find(e => e.digest === payloadDigest)
      if (found?.selfCopyFailed !== undefined)
        return { state: 'failed', reason: found.selfCopyFailed }
      return found?.selfCopyOwed ? { state: 'owed' } : undefined
    },
    paymentSummaryOf: (
      payloadDigest: string,
    ): DirectMessagePaymentSummary | undefined => {
      const row = owner.messages.all().find(r => r.digest === payloadDigest)
      return row && row.payments.length > 0 ? paymentSummary(row) : undefined
    },
    discardAttempt: async (params: { payloadDigest: string }) => {
      const clean = (s?: string) =>
        s ? (s.startsWith('0x') ? s.slice(2).toLowerCase() : s.toLowerCase()) : ''
      const target = clean(params.payloadDigest)
      // Discard is presentation accounting, never cancellation of an exposed payment: an
      // undelivered message stays in the resend queue and its accounts stay claimed.
      await account(owner, row =>
        target === '*' || target === 'all' || clean(row.digest) === target,
      )
      // A message whose stamp stage was never signed was never handed to anyone: discarding it
      // ends it, so it is never signed later, and gives its payment's coins back.
      for (const row of owner.messages.all()) {
        if (!(target === '*' || target === 'all' || clean(row.digest) === target)) continue
        const work = workOf(owner, row.consumerId)
        if (!sharedConstructionPending(row) || work.creating || work.busy) continue
        let ended!: () => void
        work.busy = new Promise<void>(resolve => (ended = resolve))
        try {
          await owner.lifetime(() => endUnconstructed(owner, row, 'discarded'))
        } finally {
          work.busy = undefined
          ended()
        }
      }
    },
    /** What is stored for the message a caller named `messageId`. No request. */
    attemptOf: async (params: {
      messageId: string
    }): Promise<{ payloadDigest: string; paid: boolean } | undefined> => {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          params.messageId,
        )
      )
        throw new DirectMessageArgumentError('messageId')
      const id = fromHex(params.messageId.replace(/-/g, ''))
      const row = owner.messages.get(consumerOf(id))
      if (row) return { payloadDigest: row.digest, paid: true }
      const envelope = owner.messages.unpaid(toHex(id))
      return envelope?.boundary
        ? { payloadDigest: envelope.digest, paid: false }
        : undefined
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
            // Refused for funds tied up before anything of it was signed: it stands for no
            // payment, so it is no attempt anyone must answer for.
            !refusedForTiedUpFunds(row) &&
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
      readMailbox(owner, params).then(result => result.received),
    scanAuthenticatedMailbox: async (
      params: Parameters<
        NonNullable<DirectMessageClient['scanAuthenticatedMailbox']>
      >[0],
    ) => {
      const { records, resumeFromInclusive, truncated } = await readMailbox(
        owner,
        { wallet: params.wallet, sinceMs: params.sinceMs },
        true,
      )
      return { records, resumeFromInclusive, truncated }
    },
    subscribeMailboxStream: (params: {
      wallet: WalletHandle
      onRecord: (record: DirectMessageReceived) => void
      onError?: (error: Error) => void
      onQuarantinedTimestamp?: (timestampMs: number, payloadDigest: string) => void
    }) => {
      const directory = requireDirectory(owner)
      const registry = requireMessageItems(owner)
      const auth = mailboxAuth(owner, directory)
      let active = true
      let streamHandle: { close: () => void } | undefined
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined
      let reconnectAttempts = 0

      const scheduleReconnect = () => {
        if (!active || reconnectTimer !== undefined) return
        const delay =
          reconnectAttempts === 0
            ? 1000
            : reconnectAttempts === 1
            ? 2000
            : 5000
        reconnectAttempts += 1
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined
          if (active) {
            void connect()
          }
        }, delay)
      }

      const connect = async () => {
        try {
          const self = await directory.selfCurrent()
          if (!active) return
          streamHandle?.close()
          streamHandle = undefined

          streamHandle = await connectCanonicalMailboxStream({
            ...auth,
            onReady: () => {
              reconnectAttempts = 0
            },
            onClose: () => {
              if (active) {
                scheduleReconnect()
              }
            },
            onRecord: async (record: CanonicalMailboxRecord) => {
              if (!active) return
              try {
                const delivery = parseFrame(record.delivery)
                if (delivery.kind !== 'parsed' || delivery.typed?.type !== TYPE_DIRECT_MESSAGE_DELIVERY)
                  return
                const deliveryTyped = delivery.typed
                const payload = deliveryTyped.payloadFrame.typed
                if (payload?.type !== TYPE_RECIPIENT_ENCRYPTED_PAYLOAD) return
                const digest = toHex(deliveryTyped.payloadDigest)
                const isOutbound = record.direction === 'out'
                let peerSubjectKeyBytes: Uint8Array
                let sealedSenderT1: Uint8Array | undefined
                if (isOutbound) {
                  peerSubjectKeyBytes = payload.recipient.keyBytes
                } else if (payload.sender !== undefined) {
                  peerSubjectKeyBytes = payload.sender.keyBytes
                } else {
                  const peekRoles = owner.roles.create(directory.network, self)
                  try {
                    const peeked = peekSealedDirectMessageSender({
                      network: directory.network,
                      payload: deliveryTyped.payloadFrame.frame,
                      context: record.context,
                      roles: peekRoles,
                    })
                    peerSubjectKeyBytes = peeked.sender.keyBytes
                    sealedSenderT1 = peeked.senderT1
                  } catch (error) {
                    // As in the polled read: a record that can never be opened is dropped,
                    // reported as quarantined and not as a stream error. The poll, which owns
                    // the read position, passes it the same way.
                    if (!sealedPeekIsTerminal(error)) throw error
                    params.onQuarantinedTimestamp?.(record.timestampMs, digest)
                    return
                  } finally {
                    peekRoles.dispose()
                  }
                }
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
                    sealedSenderT1,
                  )
                const roles = owner.roles.create(directory.network, self)
                let items: MessageItem[]
                let conversationIdStr: string | undefined
                let conversationNameStr: string | undefined
                let messageIdStr: string | undefined
                let contentDigest: string
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
                  contentDigest = toHex(opened.contentDigest)
                  items = receivedItems(
                    registry,
                    opened,
                    params.wallet,
                    isOutbound,
                    record.timestampMs,
                    isOwnSubject(owner, peerSubjectHex, peer.subject),
                  )
                } catch (error) {
                  if (!openFailureIsTerminal(error)) throw error
                  params.onQuarantinedTimestamp?.(record.timestampMs, digest)
                  return
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
                const stampPayments = paidHere.flatMap(member =>
                  member.childIndex === undefined
                    ? []
                    : [
                        {
                          txHash: hexlify(member.transactionId),
                          destinationAddress: getAddress(hexlify(member.address)),
                          valueWei:
                            typeof member.value === 'bigint'
                              ? member.value
                              : BigInt(hexlify(member.value)),
                        },
                      ],
                )
                const paymentTransfers = paidHere
                const own: ChainAddress = {
                  raw: getAddress(owner.identityAddress),
                }
                const peerAddress: ChainAddress = {
                  raw: getAddress(computeAddress('0x' + peer.subject)),
                }
                params.onRecord(
                  projectOutboxMessageRecord(
                    {
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
                      contentDigest,
                      payloadDigest: digest,
                      stampValueWei: stampPayments.reduce(
                        (sum, p) => sum + p.valueWei,
                        0n,
                      ),
                      stampPayments,
                      paymentTransfers,
                      receivedTime: record.timestampMs,
                    },
                    registry,
                  ),
                )
              } catch (err) {
                params.onError?.(
                  err instanceof Error ? err : new Error(String(err)),
                )
              }
            },
            onError: err => {
              if (active) {
                params.onError?.(err)
                scheduleReconnect()
              }
            },
          })
        } catch (err) {
          if (active) {
            params.onError?.(
              err instanceof Error ? err : new Error(String(err)),
            )
            scheduleReconnect()
          }
        }
      }

      void connect()

      return () => {
        active = false
        if (reconnectTimer !== undefined) {
          clearTimeout(reconnectTimer)
          reconnectTimer = undefined
        }
        streamHandle?.close()
        streamHandle = undefined
      }
    },
  }
}
