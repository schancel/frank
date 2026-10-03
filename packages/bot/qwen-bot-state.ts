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
  | (QwenSavedResponse & { phase: 'confirmed'; receipt: QwenResponseReceipt })

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
    (row.phase !== 'model-started' &&
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
  }

  async Close(): Promise<void> {
    await this.flush()
    await this.db.close()
  }

  async flush(): Promise<void> {
    await Promise.all(this.pendingWrites)
    this.pendingWrites = []
  }

  getSince(): number | undefined {
    return this.since
  }

  setSince(value: number): void {
    this.since = value
    this.pendingWrites.push(this.db.put(SINCE_KEY, JSON.stringify(value)))
  }

  getSinceProfiles(): number | undefined {
    return this.sinceProfiles
  }

  setSinceProfiles(value: number): void {
    this.sinceProfiles = value
    this.pendingWrites.push(
      this.db.put(SINCE_PROFILES_KEY, JSON.stringify(value)),
    )
  }

  hasGreeted(address: string): boolean {
    return this.greetedAddresses.has(canonicalMonadEnvelopeAddress(address))
  }

  addGreeted(address: string): void {
    const canonicalAddress = canonicalMonadEnvelopeAddress(address)
    this.greetedAddresses.add(canonicalAddress)
    this.pendingWrites.push(this.db.put(GREETED_PREFIX + canonicalAddress, '1'))
  }

  hasProcessed(payloadHashHex: string): boolean {
    return this.processedPayloadHashes.has(payloadHashHex)
  }

  addProcessed(payloadHashHex: string): void {
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

  private async writeResponse(row: QwenResponseRow): Promise<void> {
    if (this.responseWriteFailed)
      throw new Error('Qwen response storage unavailable; restart required')
    const operations = [
      {
        type: 'put',
        key: RESPONSE_PREFIX + row.payloadHashHex,
        value: JSON.stringify(row),
      },
    ]
    if (row.phase === 'confirmed') {
      operations.push(
        {
          type: 'put',
          key: CONVERSATION_PREFIX + row.senderAddress,
          value: JSON.stringify(row.proposedHistory),
        },
        { type: 'put', key: PROCESSED_PREFIX + row.payloadHashHex, value: '1' },
      )
    }
    try {
      // One atomic, fsynced batch: never publish an uncommitted conversation or terminal marker.
      await this.db.batch(operations, { sync: true })
    } catch {
      this.responseWriteFailed = true
      throw new Error(
        'Qwen response persistence failed; preserve state and restart',
      )
    }
    this.responses.set(row.payloadHashHex, copy(row))
    if (row.phase === 'confirmed') {
      this.conversations.set(row.senderAddress, copy(row.proposedHistory))
      this.processedPayloadHashes.add(row.payloadHashHex)
    }
  }

  async beginResponse(input: QwenResponseInput): Promise<void> {
    if (
      this.hasProcessed(input.payloadHashHex) ||
      this.responses.has(input.payloadHashHex) ||
      this.pendingResponseForPeer(input.senderAddress)
    )
      throw new Error('Qwen turn already owned')
    await this.writeResponse({
      ...copy(input),
      senderAddress: canonicalMonadEnvelopeAddress(input.senderAddress),
      version: 1,
      phase: 'model-started',
    })
  }

  async saveResponse(
    payloadHashHex: string,
    response: string,
    proposedHistory: QwenChatMessage[],
  ): Promise<void> {
    const row = this.responses.get(payloadHashHex)
    if (row?.phase !== 'model-started')
      throw new Error('Invalid Qwen response transition')
    await this.writeResponse({
      ...row,
      phase: 'response-ready',
      response,
      proposedHistory: copy(proposedHistory),
    })
  }

  async startResponseSend(payloadHashHex: string): Promise<void> {
    const row = this.responses.get(payloadHashHex)
    if (row?.phase !== 'response-ready')
      throw new Error('Invalid Qwen response transition')
    await this.writeResponse({ ...row, phase: 'send-started' })
  }

  async confirmResponse(
    payloadHashHex: string,
    receipt: QwenResponseReceipt,
  ): Promise<void> {
    const row = this.responses.get(payloadHashHex)
    if (row?.phase !== 'send-started')
      throw new Error('Invalid Qwen response transition')
    await this.writeResponse({
      ...row,
      phase: 'confirmed',
      receipt: copy(receipt),
    })
  }

  setConversation(address: string, history: QwenChatMessage[]): void {
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
