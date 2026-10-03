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

import { QwenChatMessage } from './qwen-client'

const SINCE_KEY = '__since__'
const SINCE_PROFILES_KEY = '__since_profiles__'
const GREETED_PREFIX = 'greeted:'
const PROCESSED_PREFIX = 'processed:'
const CONVERSATION_PREFIX = 'conversation:'
const RESPONSE_PREFIX = 'response:v1:'
const INBOX_PREFIX = 'inbox:v1:'
const SCAN_KEY = 'inbox-scan:v1'

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
  encryptedPayloadHex: string
  timestamp: number
  networkTagHex: string
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
function validInboxInput(row: QwenInboxInput): boolean {
  return (
    /^[0-9a-f]{64}$/.test(row.payloadHashHex) &&
    hex(row.encryptedPayloadHex) &&
    hex(row.networkTagHex) &&
    natural(row.timestamp)
  )
}
const invalidInbox = () =>
  new Error('Invalid Qwen inbox state; preserve state and investigate')
const onlyKeys = (row: object, keys: string[]) =>
  Object.keys(row).every(key => keys.includes(key))

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
      const scan: QwenInboxScan = {
        version: 1,
        context: canonical,
        origin: this.since === undefined ? origin : 0,
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
      (total, row) => total + row.encryptedPayloadHex.length / 2,
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
          version: 1,
          phase: 'pending',
          order: nextOrder++,
        })
      }
      if (
        this.pendingInbox().length + rows.size > QWEN_INBOX_MAX_COUNT ||
        this.inboxBytes() +
          [...rows.values()].reduce(
            (n, row) => n + row.encryptedPayloadHex.length / 2,
            0,
          ) >
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
      if (row?.phase !== 'response-ready')
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
