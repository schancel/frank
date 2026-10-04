/**
 * Direct user feedback (2026-09-28): every piece of `qwen-bot.livecheck.ts`'s working state --
 * both polling cursors (`since`/`sinceProfiles`), the greeted-addresses idempotency set, the
 * processed-message-hash set, and the actual per-user Qwen conversation history -- lived only in
 * plain in-memory JS variables (`Map`/`Set`/numbers). A process restart (crash, or a deliberate
 * dev restart) wiped all of it, with two concrete, user-visible consequences: (1) any address that
 * *re-registers* after a restart (a fresh seed phrase via `/setup`, a wiped wallet, a new browser
 * profile -- all things that happened repeatedly during tonight's own testing) gets greeted again,
 * since there's no persistent memory of "I already greeted this address in a previous run"; (2)
 * Qwen has no memory of a prior conversation with someone across a restart, even though the *chain*
 * still has the full message history -- the bot just never re-reads it back into its own working
 * `conversations` map.
 *
 * `level`-backed, mirroring `packages/wallet/storage/level-change-pool-store.ts`'s established
 * pattern exactly (same "in-memory cache backed by a `level` database on disk" shape) -- this repo
 * already has one Node-side persistence convention, so this reuses it rather than introducing a
 * second one. Deliberately NOT persisting `senderPubKeyCache`: pubkeys are re-fetchable from the
 * relay on demand (`fetchMonadIdentityPubKey`), so there's no data-loss risk in dropping that cache
 * across a restart, only a cheap extra network call the first time each sender is seen again.
 */
import { mkdirSync } from 'fs'
import level, { LevelDB } from 'level'
import { join } from 'path'

import { canonicalMonadEnvelopeAddress } from '@frank/cashweb/relay/monad-message-envelope'
import type { CanonicalPreparedAttempt } from '@frank/wallet/storage/stamp-attempt-journal'

import { QwenChatMessage } from './qwen-client'

const SINCE_KEY = '__since__'
const SINCE_PROFILES_KEY = '__since_profiles__'
const GREETED_PREFIX = 'greeted:'
const PROCESSED_PREFIX = 'processed:'
const CONVERSATION_PREFIX = 'conversation:'
const RESPONSE_PREFIX = 'response:v1:'
const INBOX_PREFIX = 'inbox:v1:'
const SCAN_KEY = 'inbox-scan:v1'
const COUPLING_PREFIX = 'coupling:v1:'

// Ciphertext is bounded; terminal identities deliberately grow with the replayable history.
export const QWEN_INBOX_MAX_COUNT = 1000
export const QWEN_INBOX_MAX_BYTES = 16 * 1024 * 1024
export interface QwenInboxContext {
  botAddress: string
  networkTag: string
  relayBaseUrl: string
}
export interface QwenInboxScan {
  version: 1
  context: QwenInboxContext
  origin: number
  revision: number
  nextOrder: number
  cursor?: string
}
export interface QwenInboxInput {
  payloadHashHex: string
  /** Legacy rows: the encrypted envelope. Canonical rows: the exact type-1 delivery frame. */
  encryptedPayloadHex: string
  timestamp: number
  networkTagHex: string
  /** Present only on canonical rows (#778): the exact authenticated crypto context bytes. */
  contextHex?: string
}
export type QwenInboxRejection = 'wrong-recipient' | 'self' | 'no-text'
export type QwenInboxRow =
  | (QwenInboxInput & { version: 1; phase: 'pending'; order: number })
  | {
      version: 1
      phase: 'rejected'
      payloadHashHex: string
      reason: QwenInboxRejection
    }

function qwenInboxContext(context: QwenInboxContext): QwenInboxContext {
  if (
    !context ||
    typeof context.botAddress !== 'string' ||
    typeof context.networkTag !== 'string' ||
    typeof context.relayBaseUrl !== 'string'
  )
    throw new Error('Invalid Qwen inbox context')
  const url = new URL(context.relayBaseUrl)
  if (url.username || url.password || url.search || url.hash)
    throw new Error('Invalid Qwen inbox context')
  return {
    botAddress: canonicalMonadEnvelopeAddress(context.botAddress),
    networkTag: context.networkTag,
    relayBaseUrl: url.toString().replace(/\/+$/, ''),
  }
}
function sameInboxContext(a: QwenInboxContext, b: QwenInboxContext): boolean {
  return (
    a.botAddress === b.botAddress &&
    a.networkTag === b.networkTag &&
    a.relayBaseUrl === b.relayBaseUrl
  )
}
const natural = (n: unknown): n is number =>
  Number.isSafeInteger(n) && Number(n) >= 0
const hex = (s: unknown): s is string =>
  typeof s === 'string' && /^(?:[0-9a-f]{2})*$/.test(s)
const inboxRowBytes = (row: QwenInboxInput) =>
  (row.encryptedPayloadHex.length + (row.contextHex?.length ?? 0)) / 2
function validInboxInput(row: QwenInboxInput): boolean {
  return (
    /^[0-9a-f]{64}$/.test(row.payloadHashHex) &&
    hex(row.encryptedPayloadHex) &&
    hex(row.networkTagHex) &&
    natural(row.timestamp) &&
    (row.contextHex === undefined ||
      (hex(row.contextHex) &&
        row.contextHex.length >= 2 &&
        row.contextHex.length <= 2 * 4096))
  )
}
const invalidInbox = () =>
  new Error('Invalid Qwen inbox state; preserve state and investigate')
const onlyKeys = (row: object, keys: string[]) =>
  Object.keys(row).every(key => keys.includes(key))

// #703 outbound coupling: one saved result owns one sealed envelope and one wallet attempt.
// Sealed bytes are retained only until the wallet's acknowledgement frontier has passed them;
// capacity is backpressure on new envelopes, never eviction of a linked workflow.
export const QWEN_COUPLING_MAX_COUNT = 64
export const QWEN_COUPLING_MAX_PAYLOAD_BYTES = 256 * 1024
export const QWEN_COUPLING_MAX_CONTEXT_BYTES = 4096
const COUPLING_MAX_ECONOMIC_BYTES = 16384

/** The wallet's exact public prepared binding with opaque bytes as lowercase hex. The payload is
 * ciphertext; plaintext, history and model reasoning never enter this record. */
export interface QwenCouplingBinding {
  walletBindingId: string
  accountId: string
  chainId: string
  network: string
  senderSubject: string
  recipientSubject: string
  senderT1: string
  recipientT1: string
  payloadHex: string
  contextHex: string
  economicBindingHex: string
}
/** Bounded public identity of the one sealed reply. */
export interface QwenCouplingEnvelope {
  messageIdHex: string
  t3Hex: string
  contentDigestHex: string
  stampValueWei: string
}
/** Bounded copy of the wallet's durable accepted evidence for the exact signed set. */
export type QwenCouplingTerminal =
  | {
      outcome: 'delivered'
      submissionIdentity: string
      payloadHashHex: string
      txHashes: string[]
      mailboxCommittedAtMs: number
    }
  | {
      outcome: 'dead'
      submissionIdentity: string
      payloadHashHex: string
      txHashes: string[]
      reason: string
    }
interface QwenCouplingBase extends QwenCouplingEnvelope {
  version: 1
  /** Admitted inbound input identity; also the response row key. */
  payloadHashHex: string
  consumerId: string
}
/** envelope-ready: sealed bytes are durable, no wallet effect is known.
 * intent-linked: the wallet's durable attempt reference is durably owned by this turn.
 * terminal: the Qwen final batch consumed the wallet's durable outcome; wallet evidence remains.
 * settled: the wallet frontier passed the attempt; only bounded identity and evidence remain. */
export type QwenCouplingRow =
  | (QwenCouplingBase & {
      phase: 'envelope-ready'
      binding: QwenCouplingBinding
    })
  | (QwenCouplingBase & {
      phase: 'intent-linked'
      binding: QwenCouplingBinding
      attemptRef: string
    })
  | (QwenCouplingBase & {
      phase: 'terminal'
      binding: QwenCouplingBinding
      attemptRef: string
      terminal: QwenCouplingTerminal
    })
  | (QwenCouplingBase & {
      phase: 'settled'
      attemptRef: string
      terminal: QwenCouplingTerminal
    })

const BINDING_KEYS = [
  'walletBindingId',
  'accountId',
  'chainId',
  'network',
  'senderSubject',
  'recipientSubject',
  'senderT1',
  'recipientT1',
  'payloadHex',
  'contextHex',
  'economicBindingHex',
]
const COUPLING_KEYS = [
  'version',
  'phase',
  'payloadHashHex',
  'consumerId',
  'messageIdHex',
  't3Hex',
  'contentDigestHex',
  'stampValueWei',
]
const invalidCoupling = () =>
  new Error('Invalid Qwen coupling record; preserve state and investigate')
const boundedHex = (value: unknown, maxBytes: number): value is string =>
  hex(value) && value.length >= 2 && value.length <= 2 * maxBytes
const name = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value)
const hex32 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const txHash = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value)
const bytesToHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const hexToBytes = (value: string) => new Uint8Array(Buffer.from(value, 'hex'))

export function qwenCouplingConsumerId(payloadHashHex: string): string {
  return `qwen-response-v1:${payloadHashHex}`
}
export function qwenCouplingBinding(
  prepared: CanonicalPreparedAttempt,
): QwenCouplingBinding {
  return {
    walletBindingId: prepared.walletBindingId,
    accountId: prepared.accountId,
    chainId: prepared.chainId,
    network: prepared.network,
    senderSubject: prepared.senderSubject,
    recipientSubject: prepared.recipientSubject,
    senderT1: prepared.senderT1,
    recipientT1: prepared.recipientT1,
    payloadHex: bytesToHex(prepared.payload),
    contextHex: bytesToHex(prepared.context),
    economicBindingHex: bytesToHex(prepared.economicBinding),
  }
}
/** Exact retained bytes; the envelope is never parsed, re-sealed or re-encoded here. */
export function qwenCouplingPrepared(
  binding: QwenCouplingBinding,
): CanonicalPreparedAttempt {
  return {
    walletBindingId: binding.walletBindingId,
    accountId: binding.accountId,
    chainId: binding.chainId,
    network: binding.network,
    senderSubject: binding.senderSubject,
    recipientSubject: binding.recipientSubject,
    senderT1: binding.senderT1,
    recipientT1: binding.recipientT1,
    payload: hexToBytes(binding.payloadHex),
    context: hexToBytes(binding.contextHex),
    economicBinding: hexToBytes(binding.economicBindingHex),
  }
}

function validCouplingTerminal(terminal: QwenCouplingTerminal): boolean {
  return (
    !!terminal &&
    typeof terminal === 'object' &&
    hex32(terminal.submissionIdentity) &&
    hex32(terminal.payloadHashHex) &&
    Array.isArray(terminal.txHashes) &&
    terminal.txHashes.length >= 1 &&
    terminal.txHashes.length <= 64 &&
    terminal.txHashes.every(txHash) &&
    (terminal.outcome === 'delivered'
      ? natural(terminal.mailboxCommittedAtMs) &&
        onlyKeys(terminal, [
          'outcome',
          'submissionIdentity',
          'payloadHashHex',
          'txHashes',
          'mailboxCommittedAtMs',
        ])
      : terminal.outcome === 'dead' &&
        typeof terminal.reason === 'string' &&
        /^[a-z_]{1,64}$/.test(terminal.reason) &&
        onlyKeys(terminal, [
          'outcome',
          'submissionIdentity',
          'payloadHashHex',
          'txHashes',
          'reason',
        ]))
  )
}

function validateCouplingRow(row: QwenCouplingRow): QwenCouplingRow {
  const hasBinding = row?.phase !== 'settled'
  const hasRef = row?.phase !== 'envelope-ready'
  const hasTerminal = row?.phase === 'terminal' || row?.phase === 'settled'
  if (
    !row ||
    typeof row !== 'object' ||
    row.version !== 1 ||
    !['envelope-ready', 'intent-linked', 'terminal', 'settled'].includes(
      row.phase,
    ) ||
    !onlyKeys(row, [
      ...COUPLING_KEYS,
      ...(hasBinding ? ['binding'] : []),
      ...(hasRef ? ['attemptRef'] : []),
      ...(hasTerminal ? ['terminal'] : []),
    ]) ||
    !hex32(row.payloadHashHex) ||
    row.consumerId !== qwenCouplingConsumerId(row.payloadHashHex) ||
    !boundedHex(row.messageIdHex, 16) ||
    row.messageIdHex.length !== 32 ||
    !hex32(row.t3Hex) ||
    !hex32(row.contentDigestHex) ||
    typeof row.stampValueWei !== 'string' ||
    !/^[1-9][0-9]{0,77}$/.test(row.stampValueWei) ||
    (hasRef &&
      !/^canonical-v1:[0-9]{16}$/.test(
        (row as { attemptRef: string }).attemptRef,
      )) ||
    (hasTerminal &&
      !validCouplingTerminal(
        (row as { terminal: QwenCouplingTerminal }).terminal,
      ))
  )
    throw invalidCoupling()
  if (hasBinding) {
    const binding = (row as { binding: QwenCouplingBinding }).binding
    if (
      !binding ||
      typeof binding !== 'object' ||
      !onlyKeys(binding, BINDING_KEYS) ||
      !name(binding.walletBindingId) ||
      !name(binding.accountId) ||
      !name(binding.chainId) ||
      !name(binding.network) ||
      !boundedHex(binding.senderSubject, 65) ||
      !boundedHex(binding.recipientSubject, 65) ||
      !hex32(binding.senderT1) ||
      !hex32(binding.recipientT1) ||
      !boundedHex(binding.payloadHex, QWEN_COUPLING_MAX_PAYLOAD_BYTES) ||
      !boundedHex(binding.contextHex, QWEN_COUPLING_MAX_CONTEXT_BYTES) ||
      !boundedHex(binding.economicBindingHex, COUPLING_MAX_ECONOMIC_BYTES)
    )
      throw invalidCoupling()
  }
  return row
}

/** Context must match on restart before a saved response may spend from a wallet. */
export interface QwenResponseContext {
  botAddress: string
  fundingAddress: string
  networkTag: string
  relayBaseUrl: string
  stampValueWei: string
}

export interface QwenResponseInput {
  payloadHashHex: string
  senderAddress: string
  senderPubKeyHex: string
  context: QwenResponseContext
}

interface QwenResponseBase extends QwenResponseInput {
  version: 1
}
export interface QwenSavedResponse extends QwenResponseBase {
  response: string
  proposedHistory: QwenChatMessage[]
}
export interface QwenResponseReceipt {
  payloadHashHex: string
  txHashes: string[]
}

/** send-started is deliberately held, not retryable: #703 owns exact-envelope reconciliation. */
export type QwenResponseRow =
  | (QwenResponseBase & { phase: 'model-started' })
  | (QwenSavedResponse & { phase: 'response-ready' | 'send-started' })
  | (QwenResponseBase & { phase: 'confirmed'; receipt: QwenResponseReceipt })

type QwenResponseWrite =
  | { row: Exclude<QwenResponseRow, { phase: 'confirmed' }> }
  | {
      row: Extract<QwenResponseRow, { phase: 'confirmed' }>
      conversation: QwenChatMessage[]
      /** #703: the terminal linkage commits in the same batch as receipt/history/processed. */
      coupling?: QwenCouplingRow
    }

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function parseResponseRow(raw: string): QwenResponseRow {
  const row = JSON.parse(raw) as QwenResponseRow
  const historyValid = (history: QwenChatMessage[]) =>
    Array.isArray(history) &&
    history.every(
      turn =>
        turn &&
        ['system', 'user', 'assistant'].includes(turn.role) &&
        typeof turn.content === 'string',
    )
  if (
    !row ||
    row.version !== 1 ||
    typeof row.payloadHashHex !== 'string' ||
    typeof row.senderAddress !== 'string' ||
    typeof row.senderPubKeyHex !== 'string' ||
    !row.context ||
    ![
      'botAddress',
      'fundingAddress',
      'networkTag',
      'relayBaseUrl',
      'stampValueWei',
    ].every(
      key => typeof row.context[key as keyof QwenResponseContext] === 'string',
    ) ||
    !['model-started', 'response-ready', 'send-started', 'confirmed'].includes(
      row.phase,
    ) ||
    ((row.phase === 'response-ready' || row.phase === 'send-started') &&
      (typeof row.response !== 'string' ||
        !historyValid(row.proposedHistory))) ||
    (row.phase === 'confirmed' &&
      (!row.receipt ||
        typeof row.receipt.payloadHashHex !== 'string' ||
        !Array.isArray(row.receipt.txHashes) ||
        !row.receipt.txHashes.every(hash => typeof hash === 'string')))
  ) {
    throw new Error(
      'Invalid Qwen response record; preserve state and investigate',
    )
  }
  return row
}

export class QwenBotStateStore {
  private readonly dbLocation: string
  private openedDb?: LevelDB
  private since?: number
  private sinceProfiles?: number
  private greetedAddresses = new Set<string>()
  private processedPayloadHashes = new Set<string>()
  private conversations = new Map<string, QwenChatMessage[]>()
  private responses = new Map<string, QwenResponseRow>()
  private inbox = new Map<string, QwenInboxRow>()
  private couplings = new Map<string, QwenCouplingRow>()
  private scan?: QwenInboxScan
  private mutations: Promise<unknown> = Promise.resolve()
  private drains: Promise<unknown> = Promise.resolve()
  // After an uncertain write, no further effects are safe until the database is reopened.
  private responseWriteFailed = false
  private pendingWrites: Promise<unknown>[] = []

  constructor(location: string) {
    this.dbLocation = join(location, 'qwen-bot-state')
  }

  private get db(): LevelDB {
    if (!this.openedDb) {
      throw new Error('No db opened')
    }
    return this.openedDb
  }

  /** Opens the underlying `level` database and populates the in-memory caches from it. Must be
   * called (and awaited) before using any getter/setter below -- same lifecycle as
   * `LevelChangePoolStore.Open`. A brand-new (never-before-run) location just yields empty
   * caches, which callers treat as "no persisted state yet" via the `?? <default>` fallbacks
   * already present at each of `qwen-bot.livecheck.ts`'s existing cursor/state initializations. */
  async Open(): Promise<void> {
    // `level` only creates the innermost missing directory, not any missing parents (e.g. a
    // fresh `/tmp` on a machine that has never run this bot before needs two new levels created
    // for the default `QWEN_BOT_STATE_DIR`/`qwen-bot-state` path) -- ensure the whole path exists
    // first rather than relying on it.
    mkdirSync(this.dbLocation, { recursive: true })
    this.openedDb = level(this.dbLocation)
    try {
      // Same stale-ambient-type workaround `LevelChangePoolStore.loadData` uses.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const [key, value] of this.db.iterator({}) as any) {
        if (key === SINCE_KEY) {
          this.since = JSON.parse(value)
        } else if (key === SINCE_PROFILES_KEY) {
          this.sinceProfiles = JSON.parse(value)
        } else if (key.startsWith(GREETED_PREFIX)) {
          this.greetedAddresses.add(
            canonicalMonadEnvelopeAddress(key.slice(GREETED_PREFIX.length)),
          )
        } else if (key.startsWith(PROCESSED_PREFIX)) {
          this.processedPayloadHashes.add(key.slice(PROCESSED_PREFIX.length))
        } else if (key === SCAN_KEY || key.startsWith(INBOX_PREFIX)) {
          try {
            const row = JSON.parse(value)
            if (key === SCAN_KEY) {
              if (
                !onlyKeys(row, [
                  'version',
                  'context',
                  'origin',
                  'revision',
                  'nextOrder',
                  'cursor',
                ]) ||
                !onlyKeys(row.context, [
                  'botAddress',
                  'networkTag',
                  'relayBaseUrl',
                ]) ||
                row.version !== 1 ||
                !natural(row.origin) ||
                !natural(row.revision) ||
                !natural(row.nextOrder) ||
                (row.cursor !== undefined &&
                  (typeof row.cursor !== 'string' || !row.cursor)) ||
                !sameInboxContext(row.context, qwenInboxContext(row.context))
              )
                throw invalidInbox()
              this.scan = row
            } else {
              if (
                row.version !== 1 ||
                key !== INBOX_PREFIX + row.payloadHashHex ||
                !/^[0-9a-f]{64}$/.test(row.payloadHashHex) ||
                (row.phase === 'pending'
                  ? !validInboxInput(row) ||
                    !natural(row.order) ||
                    !onlyKeys(row, [
                      'version',
                      'phase',
                      'payloadHashHex',
                      'encryptedPayloadHex',
                      'timestamp',
                      'networkTagHex',
                      'order',
                      'contextHex',
                    ])
                  : row.phase !== 'rejected' ||
                    !['wrong-recipient', 'self', 'no-text'].includes(
                      row.reason,
                    ) ||
                    !onlyKeys(row, [
                      'version',
                      'phase',
                      'payloadHashHex',
                      'reason',
                    ]))
              )
                throw invalidInbox()
              this.inbox.set(row.payloadHashHex, row)
            }
          } catch {
            throw invalidInbox()
          }
        } else if (key.startsWith(COUPLING_PREFIX)) {
          let row: QwenCouplingRow
          try {
            row = validateCouplingRow(JSON.parse(value))
          } catch {
            throw invalidCoupling()
          }
          if (key !== COUPLING_PREFIX + row.payloadHashHex)
            throw invalidCoupling()
          this.couplings.set(row.payloadHashHex, row)
        } else if (key.startsWith(RESPONSE_PREFIX)) {
          const row = parseResponseRow(value)
          if (key !== RESPONSE_PREFIX + row.payloadHashHex)
            throw new Error('Invalid Qwen response key')
          this.responses.set(row.payloadHashHex, row)
        } else if (key.startsWith(CONVERSATION_PREFIX)) {
          const address = canonicalMonadEnvelopeAddress(
            key.slice(CONVERSATION_PREFIX.length),
          )
          // Prefer an already-canonical durable record if a legacy database contains multiple
          // casing variants. They are one EVM identity, but concatenating histories could replay
          // turns; a later write replaces the selected history under the canonical key.
          const canonicalKey = CONVERSATION_PREFIX + address
          if (!this.conversations.has(address) || key === canonicalKey) {
            this.conversations.set(address, JSON.parse(value))
          }
        }
      }
      const pending = this.pendingInbox()
      if (
        (!this.scan && this.inbox.size) ||
        pending.some(row => row.order >= this.scan!.nextOrder) ||
        new Set(pending.map(row => row.order)).size !== pending.length ||
        pending.length > QWEN_INBOX_MAX_COUNT ||
        this.inboxBytes() > QWEN_INBOX_MAX_BYTES ||
        pending.some(
          row =>
            this.responses.has(row.payloadHashHex) ||
            this.hasProcessed(row.payloadHashHex),
        )
      )
        throw invalidInbox()
      this.assertCouplingsCoherent()
    } catch (error) {
      await this.db.close()
      this.openedDb = undefined
      throw error
    }
  }

  async Close(): Promise<void> {
    await this.flush()
    await this.db.close()
  }

  async flush(): Promise<void> {
    await this.mutations
    await Promise.all(this.pendingWrites)
    this.pendingWrites = []
  }

  private assertWritable(): void {
    if (this.responseWriteFailed)
      throw new Error('Qwen response storage unavailable; restart required')
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(() => {
      this.assertWritable()
      return operation()
    })
    this.mutations = next.catch(() => undefined)
    return next
  }

  /** One drain per store, even when callers overlap. Imports may continue between transitions. */
  withInboxDrain<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.drains.then(() => {
      this.assertWritable()
      return operation()
    })
    this.drains = next.catch(() => undefined)
    return next
  }

  private async synced(
    operations: Array<{ type: string; key: string; value?: string }>,
  ): Promise<void> {
    this.assertWritable()
    try {
      await this.db.batch(operations, { sync: true })
    } catch {
      this.responseWriteFailed = true
      throw new Error(
        'Qwen response persistence failed; preserve state and restart',
      )
    }
  }

  assertInboxContext(context: QwenInboxContext): void {
    this.assertWritable()
    const expected = qwenInboxContext(context)
    if (
      !this.scan ||
      !sameInboxContext(this.scan.context, expected) ||
      [...this.responses.values()].some(
        row => !sameInboxContext(qwenInboxContext(row.context), expected),
      )
    )
      throw new Error(
        'Qwen inbox context mismatch; preserve state and restart with the original context',
      )
  }

  async initializeInbox(
    context: QwenInboxContext,
    origin: number,
  ): Promise<void> {
    await this.mutate(async () => {
      if (!natural(origin)) throw new Error('Invalid Qwen inbox origin')
      const canonical = qwenInboxContext(context)
      if (this.scan) {
        this.assertInboxContext(canonical)
        return
      }
      if (
        [...this.responses.values()].some(
          row => !sameInboxContext(qwenInboxContext(row.context), canonical),
        )
      )
        throw new Error(
          'Qwen inbox context mismatch; preserve state and restart with the original context',
        )
      // Legacy response commits can precede the first timestamp checkpoint. Absence of
      // __since__ is not evidence of a new root when durable input/history ownership exists.
      const hasLegacyInputState =
        this.since !== undefined ||
        this.responses.size > 0 ||
        this.processedPayloadHashes.size > 0 ||
        this.conversations.size > 0
      const scan: QwenInboxScan = {
        version: 1,
        context: canonical,
        origin: hasLegacyInputState ? 0 : origin,
        revision: 0,
        nextOrder: 0,
      }
      await this.synced([
        { type: 'put', key: SCAN_KEY, value: JSON.stringify(scan) },
      ])
      this.scan = scan
    })
  }

  getInboxScan(): QwenInboxScan {
    if (!this.scan) throw invalidInbox()
    return copy(this.scan)
  }

  pendingInbox(): Array<Extract<QwenInboxRow, { phase: 'pending' }>> {
    return [...this.inbox.values()]
      .filter(
        (row): row is Extract<QwenInboxRow, { phase: 'pending' }> =>
          row.phase === 'pending',
      )
      .sort((a, b) => a.order - b.order)
      .map(copy)
  }

  private inboxBytes(): number {
    return this.pendingInbox().reduce(
      (total, row) => total + inboxRowBytes(row),
      0,
    )
  }

  async importInboxPage(
    context: QwenInboxContext,
    revision: number,
    inputs: QwenInboxInput[],
    cursor?: string,
  ): Promise<'committed' | 'stale' | 'capacity'> {
    return this.mutate(async () => {
      this.assertInboxContext(context)
      if (this.scan!.revision !== revision) return 'stale'
      if (
        cursor !== undefined &&
        (typeof cursor !== 'string' || !cursor || cursor === this.scan!.cursor)
      )
        throw new Error('Invalid Qwen inbox continuation')
      const rows = new Map<
        string,
        Extract<QwenInboxRow, { phase: 'pending' }>
      >()
      let nextOrder = this.scan!.nextOrder
      for (const input of inputs) {
        if (!validInboxInput(input)) throw new Error('Invalid Qwen inbox page')
        if (
          this.inbox.has(input.payloadHashHex) ||
          this.responses.has(input.payloadHashHex) ||
          this.hasProcessed(input.payloadHashHex) ||
          rows.has(input.payloadHashHex)
        )
          continue
        rows.set(input.payloadHashHex, {
          payloadHashHex: input.payloadHashHex,
          encryptedPayloadHex: input.encryptedPayloadHex,
          timestamp: input.timestamp,
          networkTagHex: input.networkTagHex,
          ...(input.contextHex === undefined
            ? {}
            : { contextHex: input.contextHex }),
          version: 1,
          phase: 'pending',
          order: nextOrder++,
        })
      }
      if (
        this.pendingInbox().length + rows.size > QWEN_INBOX_MAX_COUNT ||
        this.inboxBytes() +
          [...rows.values()].reduce((n, row) => n + inboxRowBytes(row), 0) >
          QWEN_INBOX_MAX_BYTES
      )
        return 'capacity'
      const scan = { ...this.scan!, revision: revision + 1, nextOrder, cursor }
      await this.synced([
        ...[...rows.values()].map(row => ({
          type: 'put',
          key: INBOX_PREFIX + row.payloadHashHex,
          value: JSON.stringify(row),
        })),
        { type: 'put', key: SCAN_KEY, value: JSON.stringify(scan) },
      ])
      rows.forEach((row, hash) => this.inbox.set(hash, row))
      this.scan = scan
      return 'committed'
    })
  }

  async resetInboxCursor(
    context: QwenInboxContext,
    revision: number,
  ): Promise<void> {
    await this.mutate(async () => {
      this.assertInboxContext(context)
      if (this.scan!.revision !== revision) return
      const scan = { ...this.scan!, cursor: undefined, revision: revision + 1 }
      await this.synced([
        { type: 'put', key: SCAN_KEY, value: JSON.stringify(scan) },
      ])
      this.scan = scan
    })
  }

  async rejectInbox(
    context: QwenInboxContext,
    hash: string,
    reason: QwenInboxRejection,
  ): Promise<void> {
    await this.mutate(async () => {
      this.assertInboxContext(context)
      if (this.inbox.get(hash)?.phase !== 'pending') return
      const row: QwenInboxRow = {
        version: 1,
        phase: 'rejected',
        payloadHashHex: hash,
        reason,
      }
      await this.synced([
        { type: 'put', key: INBOX_PREFIX + hash, value: JSON.stringify(row) },
      ])
      this.inbox.set(hash, row)
    })
  }

  getSince(): number | undefined {
    return this.since
  }

  setSince(value: number): void {
    this.assertWritable()
    this.since = value
    this.pendingWrites.push(this.db.put(SINCE_KEY, JSON.stringify(value)))
  }

  getSinceProfiles(): number | undefined {
    return this.sinceProfiles
  }

  setSinceProfiles(value: number): void {
    this.assertWritable()
    this.sinceProfiles = value
    this.pendingWrites.push(
      this.db.put(SINCE_PROFILES_KEY, JSON.stringify(value)),
    )
  }

  hasGreeted(address: string): boolean {
    return this.greetedAddresses.has(canonicalMonadEnvelopeAddress(address))
  }

  addGreeted(address: string): void {
    this.assertWritable()
    const canonicalAddress = canonicalMonadEnvelopeAddress(address)
    this.greetedAddresses.add(canonicalAddress)
    this.pendingWrites.push(this.db.put(GREETED_PREFIX + canonicalAddress, '1'))
  }

  hasProcessed(payloadHashHex: string): boolean {
    return this.processedPayloadHashes.has(payloadHashHex)
  }

  addProcessed(payloadHashHex: string): void {
    this.assertWritable()
    this.processedPayloadHashes.add(payloadHashHex)
    this.pendingWrites.push(this.db.put(PROCESSED_PREFIX + payloadHashHex, '1'))
  }

  getConversation(address: string): QwenChatMessage[] | undefined {
    const history = this.conversations.get(
      canonicalMonadEnvelopeAddress(address),
    )
    return history ? copy(history) : undefined
  }

  getResponse(payloadHashHex: string): QwenResponseRow | undefined {
    const row = this.responses.get(payloadHashHex)
    return row ? copy(row) : undefined
  }

  pendingResponses(): QwenResponseRow[] {
    return [...this.responses.values()]
      .filter(row => row.phase !== 'confirmed')
      .map(copy)
  }

  pendingResponseForPeer(address: string): QwenResponseRow | undefined {
    const sender = canonicalMonadEnvelopeAddress(address)
    return this.pendingResponses().find(row => row.senderAddress === sender)
  }

  private async writeResponse(update: QwenResponseWrite): Promise<void> {
    const { row } = update
    if (this.responseWriteFailed)
      throw new Error('Qwen response storage unavailable; restart required')
    const operations: Array<{ type: string; key: string; value?: string }> = [
      {
        type: 'put',
        key: RESPONSE_PREFIX + row.payloadHashHex,
        value: JSON.stringify(row),
      },
    ]
    if ('conversation' in update) {
      operations.push(
        {
          type: 'put',
          key: CONVERSATION_PREFIX + row.senderAddress,
          value: JSON.stringify(update.conversation),
        },
        { type: 'put', key: PROCESSED_PREFIX + row.payloadHashHex, value: '1' },
      )
      if (update.coupling)
        operations.push({
          type: 'put',
          key: COUPLING_PREFIX + row.payloadHashHex,
          value: JSON.stringify(update.coupling),
        })
    }
    // Ownership transfer removes ciphertext in the same commit that holds model completion.
    if (row.phase === 'model-started' && this.inbox.has(row.payloadHashHex))
      operations.push({ type: 'del', key: INBOX_PREFIX + row.payloadHashHex })
    await this.synced(operations)
    if (row.phase === 'model-started') this.inbox.delete(row.payloadHashHex)
    this.responses.set(row.payloadHashHex, copy(row))
    if ('conversation' in update) {
      this.conversations.set(row.senderAddress, copy(update.conversation))
      this.processedPayloadHashes.add(row.payloadHashHex)
      if (update.coupling)
        this.couplings.set(row.payloadHashHex, copy(update.coupling))
    }
  }

  async beginResponse(input: QwenResponseInput): Promise<void> {
    return this.mutate(async () => {
      if (this.scan) {
        this.assertInboxContext(input.context)
        if (this.inbox.get(input.payloadHashHex)?.phase !== 'pending')
          throw new Error('Qwen inbox turn not pending')
      }
      if (
        this.hasProcessed(input.payloadHashHex) ||
        this.responses.has(input.payloadHashHex) ||
        this.pendingResponseForPeer(input.senderAddress)
      )
        throw new Error('Qwen turn already owned')
      await this.writeResponse({
        row: {
          ...copy(input),
          senderAddress: canonicalMonadEnvelopeAddress(input.senderAddress),
          version: 1,
          phase: 'model-started',
        },
      })
    })
  }

  async saveResponse(
    payloadHashHex: string,
    response: string,
    proposedHistory: QwenChatMessage[],
  ): Promise<void> {
    return this.mutate(async () => {
      const row = this.responses.get(payloadHashHex)
      if (row?.phase !== 'model-started')
        throw new Error('Invalid Qwen response transition')
      await this.writeResponse({
        row: {
          ...row,
          phase: 'response-ready',
          response,
          proposedHistory: copy(proposedHistory),
        },
      })
    })
  }

  async startResponseSend(payloadHashHex: string): Promise<void> {
    return this.mutate(async () => {
      const row = this.responses.get(payloadHashHex)
      // A coupled turn already owns exact outbound bytes; the legacy boundary cannot claim it.
      if (row?.phase !== 'response-ready' || this.couplings.has(payloadHashHex))
        throw new Error('Invalid Qwen response transition')
      await this.writeResponse({ row: { ...row, phase: 'send-started' } })
    })
  }

  async confirmResponse(
    payloadHashHex: string,
    receipt: QwenResponseReceipt,
  ): Promise<void> {
    return this.mutate(async () => {
      const row = this.responses.get(payloadHashHex)
      if (row?.phase !== 'send-started')
        throw new Error('Invalid Qwen response transition')
      // Terminal rows retain only bounded identity/context and delivery proof. The cumulative
      // conversation has one durable home; retaining every old snapshot would grow quadratically.
      await this.writeResponse({
        row: {
          version: row.version,
          payloadHashHex: row.payloadHashHex,
          senderAddress: row.senderAddress,
          senderPubKeyHex: row.senderPubKeyHex,
          context: row.context,
          phase: 'confirmed',
          receipt: copy(receipt),
        },
        conversation: row.proposedHistory,
      })
    })
  }

  /** A coupling always belongs to exactly one response row in the matching phase. */
  private assertCouplingsCoherent(): void {
    const refs = new Set<string>()
    const payloads = new Set<string>()
    let retained = 0
    for (const row of this.couplings.values()) {
      const response = this.responses.get(row.payloadHashHex)
      const delivered =
        'terminal' in row && row.terminal.outcome === 'delivered'
      if (
        !response ||
        // The envelope was sealed and bound for exactly this turn's stamp policy.
        row.stampValueWei !== response.context.stampValueWei ||
        (delivered
          ? response.phase !== 'confirmed' ||
            !this.hasProcessed(row.payloadHashHex)
          : response.phase !== 'response-ready')
      )
        throw invalidCoupling()
      if ('attemptRef' in row) {
        if (refs.has(row.attemptRef)) throw invalidCoupling()
        refs.add(row.attemptRef)
      }
      if ('binding' in row) {
        if (payloads.has(row.binding.payloadHex)) throw invalidCoupling()
        payloads.add(row.binding.payloadHex)
        retained++
      }
    }
    if (retained > QWEN_COUPLING_MAX_COUNT) throw invalidCoupling()
  }

  getCoupling(payloadHashHex: string): QwenCouplingRow | undefined {
    const row = this.couplings.get(payloadHashHex)
    return row ? copy(row) : undefined
  }

  /** Every coupling, in durable key order. */
  allCouplings(): QwenCouplingRow[] {
    return [...this.couplings.values()].map(copy)
  }

  private async writeCoupling(row: QwenCouplingRow): Promise<void> {
    validateCouplingRow(row)
    await this.synced([
      {
        type: 'put',
        key: COUPLING_PREFIX + row.payloadHashHex,
        value: JSON.stringify(row),
      },
    ])
    this.couplings.set(row.payloadHashHex, copy(row))
  }

  /** Synced before the first wallet call. A turn can own at most one sealed envelope, ever. */
  async saveCoupling(
    payloadHashHex: string,
    envelope: QwenCouplingEnvelope,
    binding: QwenCouplingBinding,
  ): Promise<'saved' | 'capacity'> {
    return this.mutate(async () => {
      if (
        this.responses.get(payloadHashHex)?.phase !== 'response-ready' ||
        this.couplings.has(payloadHashHex)
      )
        throw new Error('Invalid Qwen coupling transition')
      const row = validateCouplingRow({
        version: 1,
        phase: 'envelope-ready',
        payloadHashHex,
        consumerId: qwenCouplingConsumerId(payloadHashHex),
        messageIdHex: envelope.messageIdHex,
        t3Hex: envelope.t3Hex,
        contentDigestHex: envelope.contentDigestHex,
        stampValueWei: envelope.stampValueWei,
        binding: copy(binding),
      })
      const retained = [...this.couplings.values()].filter(
        other => 'binding' in other,
      )
      if (
        retained.some(
          other =>
            'binding' in other &&
            other.binding.payloadHex === binding.payloadHex,
        )
      )
        throw new Error('Invalid Qwen coupling transition')
      if (retained.length >= QWEN_COUPLING_MAX_COUNT) return 'capacity'
      await this.writeCoupling(row)
      return 'saved'
    })
  }

  /** Records the wallet's durable attempt reference. Repeating the same link is a no-op; a
   * different reference for an owned envelope is never accepted. */
  async linkCoupling(
    payloadHashHex: string,
    attemptRef: string,
  ): Promise<void> {
    return this.mutate(async () => {
      const row = this.couplings.get(payloadHashHex)
      if (row && 'attemptRef' in row && row.attemptRef === attemptRef) return
      if (
        row?.phase !== 'envelope-ready' ||
        [...this.couplings.values()].some(
          other => 'attemptRef' in other && other.attemptRef === attemptRef,
        )
      )
        throw new Error('Invalid Qwen coupling transition')
      await this.writeCoupling({ ...row, phase: 'intent-linked', attemptRef })
    })
  }

  /** The one Qwen terminal batch. Delivered commits receipt, conversation, processed marker and
   * terminal linkage together; dead records only the held outcome and leaves the turn unsent. */
  async commitCouplingTerminal(
    payloadHashHex: string,
    terminal: QwenCouplingTerminal,
  ): Promise<void> {
    return this.mutate(async () => {
      const coupling = this.couplings.get(payloadHashHex)
      const row = this.responses.get(payloadHashHex)
      if (
        coupling?.phase !== 'intent-linked' ||
        row?.phase !== 'response-ready'
      )
        throw new Error('Invalid Qwen coupling transition')
      const next = validateCouplingRow({
        ...coupling,
        phase: 'terminal',
        terminal: copy(terminal),
      })
      if (terminal.outcome === 'dead') return this.writeCoupling(next)
      await this.writeResponse({
        row: {
          version: row.version,
          payloadHashHex: row.payloadHashHex,
          senderAddress: row.senderAddress,
          senderPubKeyHex: row.senderPubKeyHex,
          context: row.context,
          phase: 'confirmed',
          receipt: {
            payloadHashHex: terminal.payloadHashHex,
            txHashes: [...terminal.txHashes],
          },
        },
        conversation: row.proposedHistory,
        coupling: next,
      })
    })
  }

  /** Drops the sealed bytes once the wallet no longer retains the attempt. */
  async settleCoupling(payloadHashHex: string): Promise<void> {
    return this.mutate(async () => {
      const row = this.couplings.get(payloadHashHex)
      if (row?.phase === 'settled') return
      if (row?.phase !== 'terminal')
        throw new Error('Invalid Qwen coupling transition')
      const { binding: _discarded, ...rest } = row
      await this.writeCoupling({ ...rest, phase: 'settled' })
    })
  }

  setConversation(address: string, history: QwenChatMessage[]): void {
    this.assertWritable()
    const canonicalAddress = canonicalMonadEnvelopeAddress(address)
    this.conversations.set(canonicalAddress, [...history])
    this.pendingWrites.push(
      this.db.put(
        CONVERSATION_PREFIX + canonicalAddress,
        JSON.stringify(history),
      ),
    )
  }
}
