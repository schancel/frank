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

export class QwenBotStateStore {
  private readonly dbLocation: string
  private openedDb?: LevelDB
  private since?: number
  private sinceProfiles?: number
  private greetedAddresses = new Set<string>()
  private processedPayloadHashes = new Set<string>()
  private conversations = new Map<string, QwenChatMessage[]>()
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
    return history ? [...history] : undefined
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
