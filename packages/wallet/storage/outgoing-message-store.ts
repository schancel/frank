import level, { type LevelDB } from 'level'
import { join } from 'path'
import { durableDelete, durablePut, openDurableLevel } from './level-durability'

/** What the wallet knows of one signed stamp payment of a stored message. */
export interface StoredPayment {
  /** The coin it spends: a funded sub-account of the pool (with its index), the main account or
   * the identity account; and that account's address. */
  source: 'pool' | 'main' | 'identity' | 'coin'
  index?: number
  address: string
  /** The exact signed bytes. The same bytes are re-sent; nothing is ever signed again. */
  rawTx: string
  /**
   * - `pending`: signed; the chain has not shown what became of it. Its account stays claimed.
   * - `spent` / `reverted`: the chain shows it in a block (a revert consumes the nonce too).
   * - `failed`: the chain shows the account's nonce consumed by another transaction, so this
   *   payment can never land. It is never paid again.
   * - `unsent`: signed, never exposed, and dropped (`rawTx` is empty): the relay refused the
   *   message's first submission before storing or broadcasting anything, and this wallet had
   *   handed the bytes to nothing else. Its coin is free again.
   */
  state: 'pending' | 'spent' | 'reverted' | 'failed' | 'unsent'
  /**
   * Set on a transfer made to finish a payment of this message that the chain mined and
   * REVERTED (a receipt with status 0; never one merely inferred to have failed): the position
   * in `payments` of the payment it repeats. Same value, same destination, a coin of its own.
   * There is at most one for a payment, and it is written here before it is broadcast, so a
   * payment is never made a third time; a repeat that itself reverts is not repeated.
   */
  repays?: number
  /**
   * Set on the SAME payment signed again (the same account and nonce, the same destination and
   * value, other fee fields): the position in `payments` of the transaction it stands in for,
   * which the node refused to take. Both stay recorded and both are looked for; an account's
   * nonce is consumed once, so at most one of them is ever mined and the other ends `failed`.
   * Written here before it is broadcast.
   */
  replaces?: number
}

/**
 * One paid message this wallet sent, with everything needed to finish it: the complete encrypted
 * message and its signed payments, exactly as they were first handed out. This row is the whole
 * record of the send. It is written, durably, before any byte reaches a relay or a node, and the
 * accounts it pays from are claimed for as long as a payment in it is `pending`.
 */
export interface StoredMessage {
  /** v1 is the legacy stamp-payer record; v2 is bound to the shared transaction-set journal. */
  version: 1 | 2
  /** `frank-dm:<message ID>`: the row's key. A message ID has one row, so one payment, ever. */
  consumerId: string
  digest: string
  /** The compressed signing key (hex) the message was sealed to. */
  recipientSubject: string
  /** The exact relay request. Retained while delivery is unresolved, including after refusal;
   * removed after delivery is durably recorded. */
  request?: { body: string; contentType: string }
  payments: StoredPayment[]
  /** Stable link to the wallet-owned EVM construction journal. Present on shared-set sends. */
  transactionSetOperationId?: string
  /** A stamp stage inside an already prepared same-wallet payment operation. */
  transactionSetStageId?: string
  paymentOperationId?: string
  /** Wallet-owned signed change transactions, never included in recipient message evidence. */
  otherTransactions: StoredPayment[]
  /** Immutable encrypted construction intent, persisted before the shared preparer signs. */
  construction?: {
    network: string
    payload: string
    context: string
    amountWei: string
    minimumPaymentWei?: string
    boundary: string
  }
  /** `delivered`: the relay confirmed storing this exact message. `dead`: the relay refused its
   * first submission before exposing anything (`reason` says why) and every payment is `unsent`.
   * Absent: delivery remains unresolved; any other refusal only updates `reason`, since it does
   * not prove that signed payments cannot land. */
  outcome?: 'delivered' | 'dead'
  /** Latest relay refusal; with no outcome the original request remains unresolved. */
  reason?: string
  /** A host message points at this attempt, or the user answered for it. */
  accounted?: boolean
  /** Complete bytes exist, but the host has not durably bound their financial effects. */
  exposurePending?: true
  /** No byte of this request has left the wallet except in submissions the home relay refused
   * before storing or broadcasting anything. Cleared, durably, before every submission (a crash
   * during one leaves the bytes possibly out), and set again only by such a refusal. Never set
   * for a recipient reached through forwarding. */
  unexposed?: true
  createdAt: number
}

/** The wallet's sent messages. Per wallet: never shared with another wallet on the same coins. */
export interface OutgoingMessageStore {
  all(): StoredMessage[]
  get(consumerId: string): StoredMessage | undefined
  put(row: StoredMessage): Promise<void>
  close(): Promise<void>
  /** The sealed envelope of an unpaid message that was handed to the relay and is not known to
   * have been delivered, by message ID. Host-bound envelopes also retain terminal receipts.
   * Kept so that sending the same message again sends the
   * same bytes: one digest, however many copies the relay ends up holding. Not a link and not
   * in `all()`: it stands for no payment. */
  unpaid(messageId: string): UnpaidEnvelope | undefined
  /** Read-only linear lookup of host-bound free envelopes; no second recovery index. */
  unpaidByDigest(payloadDigest: string): (UnpaidEnvelope & { messageId: string }) | undefined
  /** `undefined` drops the record. */
  setUnpaid(messageId: string, envelope: UnpaidEnvelope | undefined): Promise<void>
}
/** Hex throughout. `recipientSubject`: whom the envelope is sealed to. */
export interface UnpaidEnvelope {
  exposurePending?: true
  /** A host effect is bound to these immutable bytes; retain its delivery receipt on success. */
  hostBound?: true
  outcome?: 'delivered' | 'dead'
  reason?: string
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
  unpaidByDigest(payloadDigest: string): (UnpaidEnvelope & { messageId: string }) | undefined {
    const found = [...this.envelopes.entries()].find(([, envelope]) =>
      envelope.hostBound && envelope.digest === payloadDigest)
    return found ? { ...found[1], messageId: found[0] } : undefined
  }
  async setUnpaid(messageId: string, envelope: UnpaidEnvelope | undefined) {
    if (envelope) this.envelopes.set(messageId, { ...envelope })
    else this.envelopes.delete(messageId)
  }
}
const UNPAID_PREFIX = 'unpaid-envelope:'
/** Development reset: this directory holds only sent-message records, never a key. Deleting it
 * (with the wallet closed) forgets unfinished sends; funded accounts stay derivable from the
 * seed. The earlier `canonical-dm-workflow-links` directory is no longer read; a wallet that
 * still has one says so at open ({@link noticeOldLinkState}). */
export const OUTGOING_MESSAGE_NAMESPACE = 'outgoing-messages-v1'
/** Where the earlier send code kept its payment links. Nothing reads it any more. */
export const OLD_LINK_NAMESPACE = 'canonical-dm-workflow-links'
const oldLinkStateNoticed = new Set<string>()

/** Whether the earlier link store exists beside this wallet's stores. It is looked for, never
 * opened: a Node wallet has it as a directory, a browser wallet as an IndexedDB database. */
async function oldLinkStateExists(location: string): Promise<boolean> {
  const name = join(location, OLD_LINK_NAMESPACE)
  const globals = globalThis as {
    window?: unknown
    indexedDB?: { databases?: () => Promise<{ name?: string }[]> }
  }
  try {
    if (globals.window !== undefined && globals.indexedDB !== undefined)
      return ((await globals.indexedDB.databases?.()) ?? []).some(
        database => database.name === `level-js-${name}`,
      )
    // Keep Node's filesystem module outside browser bundles.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('fs') as typeof import('fs')).existsSync(name)
  } catch {
    return false
  }
}

/**
 * Wallet open: says, once per location in this process, that state of the earlier send code is
 * still on disk and is not read. That state held the links between payment intents and
 * messages for sends that had not finished; whatever such a send left unfinished is no longer
 * resent or reconciled by this wallet. Nothing is migrated and nothing is deleted here. Returns
 * whether the notice was given.
 */
export async function noticeOldLinkState(location: string): Promise<boolean> {
  if (oldLinkStateNoticed.has(location) || !(await oldLinkStateExists(location)))
    return false
  oldLinkStateNoticed.add(location)
  console.warn(
    `[monad-canonical-dm] This wallet still has the old sent-message state "${OLD_LINK_NAMESPACE}" in ${location}. ` +
      `It is no longer read: sent messages are now kept in "${OUTGOING_MESSAGE_NAMESPACE}", and a send the old code left unfinished is not resent or reconciled. ` +
      `Development reset: close the wallet and delete the "${OLD_LINK_NAMESPACE}" store (that directory, or the IndexedDB database "level-js-${join(
        location,
        OLD_LINK_NAMESPACE,
      )}"). It holds no keys; the wallet's keys, roots and funded accounts are untouched and stay derivable from the seed.`,
  )
  return true
}

export function validateSharedStoredMessage(row: StoredMessage): void {
  const intent = row.construction
  if (
    row.version !== 2 ||
    typeof row.transactionSetOperationId !== 'string' ||
    (row.transactionSetStageId === undefined
      ? row.transactionSetOperationId !== `stamp-${row.consumerId.slice('frank-dm:'.length)}` || row.paymentOperationId !== undefined
      : row.transactionSetStageId !== `stamp-${row.consumerId.slice('frank-dm:'.length)}` ||
        typeof row.paymentOperationId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.paymentOperationId)) ||
    !/^[0-9a-f]{64}$/i.test(row.digest) ||
    !/^[0-9a-f]{66}$/i.test(row.recipientSubject) ||
    !Array.isArray(row.payments) ||
    !Array.isArray(row.otherTransactions) ||
    !intent ||
    typeof intent.network !== 'string' ||
    typeof intent.payload !== 'string' ||
    !/^(?:[0-9a-f]{2})+$/i.test(intent.payload) ||
    typeof intent.context !== 'string' ||
    !/^(?:[0-9a-f]{2})+$/i.test(intent.context) ||
    typeof intent.amountWei !== 'string' ||
    !/^[1-9][0-9]*$/.test(intent.amountWei) ||
    (intent.minimumPaymentWei !== undefined && (typeof intent.minimumPaymentWei !== 'string' ||
      !/^[0-9]+$/.test(intent.minimumPaymentWei) || BigInt(intent.minimumPaymentWei) > BigInt(intent.amountWei))) ||
    typeof intent.boundary !== 'string' ||
    !/^frank-[0-9a-f]{48}$/i.test(intent.boundary)
  )
    throw new Error('Invalid shared transaction-set sent-message record')
  for (const payment of [...row.payments, ...row.otherTransactions])
    if (
      typeof payment.rawTx !== 'string' ||
      !/^0x[0-9a-f]+$/i.test(payment.rawTx) ||
      typeof payment.address !== 'string' ||
      !['coin', 'pool', 'main', 'identity'].includes(payment.source) ||
      !['pending', 'spent', 'reverted', 'failed', 'unsent'].includes(payment.state)
    )
      throw new Error('Invalid shared transaction-set sent-message payment')
  if (row.request &&
      (typeof row.request.body !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(row.request.body) ||
       typeof row.request.contentType !== 'string'))
    throw new Error('Invalid shared transaction-set sent-message request')
  if (
    (row.request === undefined && row.outcome !== 'delivered' &&
      (row.payments.length !== 0 || row.otherTransactions.length !== 0)) ||
    (row.outcome === 'delivered' && row.payments.length === 0) ||
    (row.request !== undefined && row.payments.length === 0) ||
    !Number.isSafeInteger(row.createdAt) || row.createdAt < 0
  )
    throw new Error('Inconsistent shared transaction-set sent-message state')
}

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
        const parsed = JSON.parse(value) as StoredMessage
        // Older v1 records carried only recipient payments. Hydration supplies the
        // derived empty change list in memory without rewriting durable state. New v2
        // rows are validated as written so a missing field cannot masquerade as no change.
        const row = parsed.version === 1
          ? { ...parsed, otherTransactions: parsed.otherTransactions ?? [] }
          : parsed
        if (![1, 2].includes(row.version) || row.consumerId !== key)
          throw new Error(
            `Unsupported sent-message record in ${OUTGOING_MESSAGE_NAMESPACE}. Development reset: close the wallet and delete that directory (it holds no keys).`,
          )
        if (row.version === 2) validateSharedStoredMessage(row)
        // v1's missing change list means the old payer stored only recipient payments;
        // v2 requires the list and validates it against its signed journal during restore.
        store.rows.set(row.consumerId, {
          ...row,
          otherTransactions: row.version === 1 ? [] : row.otherTransactions,
        })
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
    if (row.version === 2) validateSharedStoredMessage(row)
    await durablePut(this.db, row.consumerId, JSON.stringify(row))
    this.rows.set(row.consumerId, { ...row })
  }
  private readonly envelopes = new Map<string, UnpaidEnvelope>()
  unpaid(messageId: string): UnpaidEnvelope | undefined {
    return this.envelopes.get(messageId)
  }
  unpaidByDigest(payloadDigest: string): (UnpaidEnvelope & { messageId: string }) | undefined {
    const found = [...this.envelopes.entries()].find(([, envelope]) =>
      envelope.hostBound && envelope.digest === payloadDigest)
    return found ? { ...found[1], messageId: found[0] } : undefined
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

