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
  decodeDirectMessageCryptoContext,
  encodeBlackjackHandV3Item,
  encodeChannelUpdateItem,
  encodeEmailMessageItem,
  encodeStealthMessageItem,
  fromHex,
  isBlackjackHandV3Frame,
  isChannelUpdateItemFrame,
  isEmailMessageItemFrame,
  isStealthMessageItemFrame,
  parseFrame,
  paymentTransferFromMember,
  paymentTransferFromStealthItem,
  paymentTransferToMember,
  paymentTransferToStealthItem,
  projectBlackjackHandV3Item,
  projectChannelUpdateItem,
  projectEmailMessageItem,
  projectStealthMessageItem,
  recipientPayloadDigest,
  toHex,
  type CanonicalChannelUpdateItem,
  type CanonicalStealthItem,
  type EmailMessageItem,
  type PaymentMember,
  type PaymentTransfer,
} from '@frank/codec'
import { randomBytes } from '@frank/crypto-box'
import type { Current, HistoricalEvidence } from '../../directory-admission/src'
import {
  directMessageText,
  openDirectMessage,
  openOwnDirectMessage,
  prepareDirectMessage,
} from '@frank/cashweb/relay/canonical-dm'
import {
  installedCanonicalOrigin,
  type CanonicalFetch,
} from '@frank/cashweb/relay/canonical-dm-transport'
import {
  connectCanonicalMailboxStream,
  fetchCanonicalInboxPage,
  fetchCanonicalMailboxPage,
  MonadMailboxChallengeCapacityError,
  type CanonicalMailboxAuthParams,
  type CanonicalMailboxRecord,
} from '@frank/cashweb/relay/monad-mailbox-client'
import type {
  ChannelUpdateItem,
  EmailItem,
  MessageItem,
  StealthItem,
  WalletSyncItem,
} from '@frank/cashweb/types/messages'
import { applyWalletSyncItem } from '../sync-dispatcher'
export { applyWalletSyncItem } from '../sync-dispatcher'
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
import { deriveEvmStealthPrivateKey } from '../monad-stealth'
import type { MonadChainWalletHandle } from './monad-chain'
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
 * the recipient's relay. It broadcast no payment. This attempt is over; later sends are free. */
export class CanonicalRecipientUndeliverableError extends MonadStampTerminalError {
  constructor() {
    super(
      'Your relay could not deliver to the relay this address lives on. This message was not sent and its payment was not broadcast.',
      422,
      'mailbox_terminal',
      false,
      'undeliverable',
    )
    this.name = 'CanonicalRecipientUndeliverableError'
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
  outcome?: 'delivered' | 'dead'
  /** The relay's reason when the outcome is `dead`. */
  reason?: string
  acknowledged?: boolean
  /** Saved once a message pointed at this delivered attempt, or the user answered for it. Until
   * then a delivered attempt is reported as unattributed in every session. */
  accounted?: boolean
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
}
export class LevelCanonicalLinkStore implements CanonicalLinkStore {
  private readonly rows = new Map<string, StoredLink>()
  private constructor(private readonly db: LevelDB) {}
  static async open(location: string): Promise<LevelCanonicalLinkStore> {
    const store = new LevelCanonicalLinkStore(
      level(join(location, 'canonical-dm-workflow-links')),
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const [, value] of store.db.iterator({}) as any) {
      const row = JSON.parse(value) as StoredLink
      store.rows.set(row.attemptRef, row)
    }
    return store
  }
  all(): StoredLink[] {
    return [...this.rows.values()]
  }
  async put(row: StoredLink): Promise<void> {
    await this.db.put(row.attemptRef, JSON.stringify(row))
    this.rows.set(row.attemptRef, { ...row })
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

function textItems(items: readonly MessageItem[]): Uint8Array[] {
  if (items.length === 0) throw new Error('A direct message needs content')
  return items.map(item => {
    if (item.type === 'blackjack-hand') return encodeBlackjackHandV3Item(item)
    if (item.type === 'channel-update') {
      return encodeChannelUpdateItem(item as ChannelUpdateItem)
    }
    if (item.type === 'email') {
      return encodeEmailMessageItem({
        messageId: item.messageId,
        from: item.from,
        to: item.to,
        cc: item.cc,
        subject: item.subject,
        textBody: item.textBody,
        htmlBody: item.htmlBody,
        inReplyTo: item.inReplyTo,
        references: item.references,
        attachments: item.attachments,
        replyTo: item.replyTo,
      })
    }
    if (item.type === 'stealth') {
      const networkTag = item.networkTag ?? item.chainId
      if (!networkTag) {
        throw new Error('Stealth item must have networkTag or chainId')
      }
      const ephemeralPubKey = item.ephemeralPubKey
      if (!ephemeralPubKey) {
        throw new Error('Stealth item must have ephemeralPubKey')
      }
      const rawTxs =
        item.transactions ??
        (item.rawTx ? [item.rawTx] : item.solanaTx ? [item.solanaTx] : [])
      if (rawTxs.length === 0) {
        throw new Error('Stealth item must have at least one transaction')
      }
      return encodeStealthMessageItem({
        type: 'stealth',
        networkTag,
        keyType: item.keyType ?? 1,
        ephemeralPubKey,
        transactions: rawTxs,
        amount: item.amount,
        memo: item.memo,
      })
    }
    if (item.type === 'digital-goods') {
      return directMessageText(JSON.stringify(item))
    }
    if (item.type !== 'text')
      throw new Error(
        `Canonical direct messages cannot carry '${item.type}' items yet; nothing was paid or sent.`,
      )
    return directMessageText(item.text)
  })
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
 * Correlate every durable wallet record with a saved link, finish frozen intents, re-send the same
 * bytes of live attempts and retire terminal ones. Never builds or signs a new payment.
 */
async function settle(
  owner: CanonicalMessagingOwner,
  fetch: CanonicalFetch | undefined,
  submitBudget: number,
): Promise<void> {
  const client = owner.client()
  const submitted = new Map<string, number>()
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
        // Orphaned link: not in journal or cannot be reconciled. Mark acknowledged and dead.
        await owner.links.put({
          ...row,
          acknowledged: true,
          outcome: row.outcome ?? 'dead',
          ...(row.outcome ? {} : { reason: 'orphaned' }),
        })
      }
    }
    const rows = owner.links.all().filter(row => !row.acknowledged)
    if (rows.length === 0) return
    const states = client.reconcileWorkflowLinks(rows.map(restoreLink))
    const held = states.filter(state => state.state === 'hold')
    if (held.length > 0) {
      for (const h of held) {
        const row = rows.find(r => r.attemptRef === h.attemptRef)
        if (row) {
          await owner.links.put({
            ...row,
            acknowledged: true,
            outcome: row.outcome ?? 'dead',
            ...(row.outcome ? {} : { reason: 'unreconciled' }),
          })
        }
      }
      continue
    }
    const terminal = states.find(state => state.state === 'terminal')
    if (terminal) {
      const row = rows.find(r => r.attemptRef === terminal.attemptRef)!
      const attempt = client
        .terminalOutcomes()
        .find(a => a.attemptRef === terminal.attemptRef)
      if (!attempt?.terminal) {
        await owner.links.put({
          ...row,
          acknowledged: true,
          outcome: row.outcome ?? 'dead',
          reason: 'terminal-outcome-missing',
        })
        continue
      }
      // The outcome is saved before the wallet forgets the attempt, so it is never lost.
      await owner.links.put({
        ...row,
        outcome: attempt.terminal.phase === 'delivered' ? 'delivered' : 'dead',
        ...(attempt.terminal.phase === 'dead'
          ? { reason: attempt.terminal.reason }
          : {}),
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
    try {
      await client.submit(ready.eligibility, { fetch })
    } catch {
      // Outcome unknown: the exact bytes stay journaled and are re-sent on a later pass.
    }
  }
}

/** Durably marks delivered attempts as accounted for. An attempt with no outcome is never marked:
 * it may still be delivered, so it has to stay reported. */
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

async function send(
  owner: CanonicalMessagingOwner,
  params: Parameters<DirectMessageClient['send']>[0],
  defaultStampValueWei: bigint,
): Promise<DirectMessageSendResult> {
  const directory = requireDirectory(owner)
  const items = textItems(params.items)
  const stampValueWei = params.stampValue ?? defaultStampValueWei
  const peer = await directory.peerCurrent({ address: params.recipient.raw })
  if (!peer) throw new CanonicalRecipientNotPublishedError(params.recipient.raw)
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
  // Earlier attempts first: a live one is re-sent as-is, and an unmatched record holds everything.
  await settle(owner, directory.fetch, 1)
  const live = owner.links.all().filter(row => !row.outcome)
  if (live.length > 0)
    throw new MonadStampPendingAttemptError(live.map(row => row.digest))
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
  const messageId = randomBytes(16)
  let conversationIdBytes: Uint8Array | undefined
  if (params.conversationId) {
    if (typeof params.conversationId === 'string') {
      const clean = params.conversationId.replace(/-/g, '')
      if (clean.length === 32) {
        conversationIdBytes = Uint8Array.from(Buffer.from(clean, 'hex'))
      }
    } else if (params.conversationId.length === 16) {
      conversationIdBytes = params.conversationId
    }
  }
  const roles = owner.roles.create(directory.network, senderCurrent)
  let sealed
  try {
    sealed = prepareDirectMessage({
      network: directory.network,
      senderCurrent,
      recipientCurrent: recipient.current,
      messageId,
      conversationId: conversationIdBytes,
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
        owner.links
          .all()
          .filter(row => !row.acknowledged)
          .map(restoreLink),
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
  if (
    status === 'dead' &&
    owner.links.all().find(row => row.digest === digest)?.reason ===
      'undeliverable'
  )
    throw new CanonicalRecipientUndeliverableError()
  if (status === 'dead')
    throw new MonadStampTerminalError(
      'The relay ended this payment set; it can never be delivered.',
      422,
      'mailbox_terminal',
      undefined,
      undefined,
    )
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

function indexStealthItemIfRecipient(
  wallet: WalletHandle,
  isOutbound: boolean,
  projected: ReturnType<typeof projectStealthMessageItem>,
  timestampMs: number,
) {
  if (!isOutbound && projected.keyType === 1) {
    const liveWallet = wallet as MonadChainWalletHandle
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

function processSyncItemIfPresent(
  wallet: WalletHandle,
  item: unknown,
) {
  try {
    const syncItem = item as WalletSyncItem
    if (
      syncItem &&
      (syncItem.type === 'wallet-sync' || syncItem.type === 'payment-transfer')
    ) {
      applyWalletSyncItem(wallet, syncItem)
    }
  } catch {
    // ignore
  }
}

async function fetchSince(
  owner: CanonicalMessagingOwner,
  params: Parameters<DirectMessageClient['fetchSince']>[0],
): Promise<DirectMessageReceived[]> {
  const directory = requireDirectory(owner)
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
        if (opened.messageId) {
          messageIdStr = formatUuid(opened.messageId)
        }
        items = opened.items.map(item =>
          item.kind === 'parsed' && item.typed?.type === 17
            ? (() => {
                try {
                  const text = item.typed.text
                  if (text.startsWith('{') || text.startsWith('[')) {
                    const parsed = JSON.parse(text)
                    const syncItems = Array.isArray(parsed) ? parsed : [parsed]
                    for (const s of syncItems) {
                      if (s && (s.type === 'wallet-sync' || s.type === 'payment-transfer')) {
                        processSyncItemIfPresent(params.wallet, s)
                      }
                    }
                    if (
                      parsed &&
                      typeof parsed === 'object' &&
                      !Array.isArray(parsed) &&
                      parsed.type === 'digital-goods'
                    ) {
                      return parsed as MessageItem
                    }
                  }
                } catch {}
                return { type: 'text' as const, text: item.typed.text }
              })()
            : item.kind === 'parsed' && isBlackjackHandV3Frame(item)
            ? projectBlackjackHandV3Item(item).item
            : item.kind === 'parsed' && isStealthMessageItemFrame(item)
            ? (() => {
                const projected = projectStealthMessageItem(item)
                indexStealthItemIfRecipient(
                  params.wallet,
                  isOutbound,
                  projected,
                  record.timestampMs,
                )
                return {
                  ...projected,
                  amount: Number(projected.amount),
                }
              })()
            : item.kind === 'parsed' && isChannelUpdateItemFrame(item)
            ? projectChannelUpdateItem(item)
            : item.kind === 'parsed' && isEmailMessageItemFrame(item)
            ? {
                ...projectEmailMessageItem(item),
                type: 'email' as const,
              }
            : {
                type: 'text' as const,
                text: '[This message item is not supported yet]',
              },
        )
      } catch {
        // Tampered, stale-keyed or foreign ciphertext never reaches display or payment import.
        continue
      } finally {
        roles.dispose()
      }
      const stampPayments = deliveryTyped.payments.map(member => ({
        txHash: hexlify(member.transactionId),
        destinationAddress: getAddress(hexlify(member.address)),
        valueWei:
          typeof member.value === 'bigint'
            ? member.value
            : BigInt(hexlify(member.value)),
      }))
      const paymentTransfers = deliveryTyped.payments.map(member =>
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
    reconcileAttempts: (
      params: Parameters<DirectMessageClient['reconcileAttempts']>[0],
    ) =>
      serial(owner.links, async () => {
        const directory = requireDirectory(owner)
        await settle(owner, directory.fetch, params.maxPutAttempts ?? 1)
        return Object.fromEntries(
          params.payloadDigests.map(digest => [
            digest,
            statusOf(owner, digest),
          ]),
        )
      }),
    discardAttempt: (params: { payloadDigest: string }) =>
      serial(owner.links, async () => {
        const row = owner.links
          .all()
          .find(
            r =>
              r.digest === params.payloadDigest ||
              r.attemptRef === params.payloadDigest,
          )
        if (row && !row.outcome) {
          await owner.links.put({
            ...row,
            acknowledged: true,
            outcome: 'dead',
            reason: 'discarded',
          })
        }
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
              (!row.outcome || (row.outcome === 'delivered' && !row.accounted)),
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
                  if (opened.messageId) {
                    messageIdStr = formatUuid(opened.messageId)
                  }
                  items = opened.items.map(item =>
                    item.kind === 'parsed' && item.typed?.type === 17
                      ? (() => {
                          try {
                            const text = item.typed.text
                            if (text.startsWith('{') || text.startsWith('[')) {
                              const parsed = JSON.parse(text)
                              const syncItems = Array.isArray(parsed) ? parsed : [parsed]
                              for (const s of syncItems) {
                                if (s && (s.type === 'wallet-sync' || s.type === 'payment-transfer')) {
                                  processSyncItemIfPresent(params.wallet, s)
                                }
                              }
                              if (
                                parsed &&
                                typeof parsed === 'object' &&
                                !Array.isArray(parsed) &&
                                parsed.type === 'digital-goods'
                              ) {
                                return parsed as MessageItem
                              }
                            }
                          } catch {}
                          return { type: 'text' as const, text: item.typed.text }
                        })()
                      : item.kind === 'parsed' && isBlackjackHandV3Frame(item)
                      ? projectBlackjackHandV3Item(item).item
                      : item.kind === 'parsed' &&
                        isStealthMessageItemFrame(item)
                      ? (() => {
                          const projected = projectStealthMessageItem(item)
                          indexStealthItemIfRecipient(
                            params.wallet,
                            isOutbound,
                            projected,
                            record.timestampMs,
                          )
                          return {
                            ...projected,
                            amount: Number(projected.amount),
                          }
                        })()
                      : item.kind === 'parsed' && isChannelUpdateItemFrame(item)
                      ? projectChannelUpdateItem(item)
                      : item.kind === 'parsed' && isEmailMessageItemFrame(item)
                      ? {
                          ...projectEmailMessageItem(item),
                          type: 'email' as const,
                        }
                      : {
                          type: 'text' as const,
                          text: '[This message item is not supported yet]',
                        },
                  )
                } finally {
                  roles.dispose()
                }
                const stampPayments = deliveryTyped.payments.map(member => ({
                  txHash: hexlify(member.transactionId),
                  destinationAddress: getAddress(hexlify(member.address)),
                  valueWei:
                    typeof member.value === 'bigint'
                      ? member.value
                      : BigInt(hexlify(member.value)),
                }))
                const paymentTransfers = deliveryTyped.payments.map(member =>
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
