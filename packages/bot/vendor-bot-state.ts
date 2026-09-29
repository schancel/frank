/**
 * Persisted state for `vendor-bot.livecheck.ts`, mirroring `qwen-bot-state.ts`/
 * `blackjack-bot-state.ts`'s established `level`-backed pattern. Much smaller than either: a
 * purchase is a single stateless request/response exchange (unlike a blackjack hand's multi-message
 * game state), so the only thing worth surviving a restart is the processed-payload-hash
 * idempotency set -- without it, a restart mid-poll-cycle could reprocess (and re-fulfill, for
 * free) a purchase it already delivered.
 */
import { mkdirSync } from 'fs'
import level, { LevelDB } from 'level'
import { join } from 'path'

const PROCESSED_PREFIX = 'processed:'

export class VendorBotStateStore {
  private readonly dbLocation: string
  private openedDb?: LevelDB
  private processedPayloadHashes = new Set<string>()
  private pendingWrites: Promise<unknown>[] = []

  constructor(location: string) {
    this.dbLocation = join(location, 'vendor-bot-state')
  }

  private get db(): LevelDB {
    if (!this.openedDb) {
      throw new Error('No db opened')
    }
    return this.openedDb
  }

  async Open(): Promise<void> {
    mkdirSync(this.dbLocation, { recursive: true })
    this.openedDb = level(this.dbLocation)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const [key] of this.db.iterator({}) as any) {
      if (key.startsWith(PROCESSED_PREFIX)) {
        this.processedPayloadHashes.add(key.slice(PROCESSED_PREFIX.length))
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

  hasProcessed(payloadHashHex: string): boolean {
    return this.processedPayloadHashes.has(payloadHashHex)
  }

  addProcessed(payloadHashHex: string): void {
    this.processedPayloadHashes.add(payloadHashHex)
    this.pendingWrites.push(this.db.put(PROCESSED_PREFIX + payloadHashHex, '1'))
  }
}
