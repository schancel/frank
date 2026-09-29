/**
 * Persisted state for `blackjack-bot.livecheck.ts`, mirroring `qwen-bot-state.ts`'s established
 * `level`-backed pattern exactly.
 *
 * Two kinds of state, both essential to the fairness scheme (`@frank/wallet/message-item-plugins/blackjack/deck.ts`'s
 * header):
 *
 * - **The pending commitment** (`pendingServerSeed`/`pendingServerSeedHash`): the seed the bot will
 *   use for the *next* hand, generated and hashed before that hand's bet exists. Persisting this is
 *   what makes the fairness property survive a restart -- without it, a restart between "commit"
 *   and "deal" would force generating a brand new seed *after* already having seen the bet, exactly
 *   the ordering violation the whole scheme exists to prevent.
 * - **Per-game dealing state** (`gameId -> {serverSeed, wagerTxHash, dealtCount, revealed}`): the
 *   bot's own authoritative record of an in-progress hand, needed to know which card comes next on
 *   a `hit` and to reconstruct the dealer's hand at reveal. `revealed` games are kept (not deleted)
 *   so a restart mid-poll-loop can't accidentally re-process and double-pay a hand it already
 *   resolved.
 */
import { mkdirSync } from 'fs'
import level, { LevelDB } from 'level'
import { join } from 'path'

const PENDING_SEED_KEY = '__pending_server_seed__'
const PENDING_SEED_HASH_KEY = '__pending_server_seed_hash__'
const GAME_PREFIX = 'game:'
const PROCESSED_PREFIX = 'processed:'

export interface BlackjackGameRecord {
  serverSeed: string
  serverSeedHash: string
  wagerTxHash: string
  /** The on-chain-verified wager amount (see `hydrate()` in
   * `@frank/wallet/message-item-plugins/blackjack/plugin.ts`) -- never a self-reported figure. Persisted
   * here (not re-verified at payout time) since the bot already confirmed it once at `bet` time. */
  wagerWei: bigint
  playerAddress: string
  /** How many cards have been dealt so far (starts at 4: player's 2 + dealer's 2), per the dealing
   * order convention `@frank/wallet/message-item-plugins/blackjack/game.ts`'s header defines -- the next card dealt is
   * always `deck[dealtCount]`. */
  dealtCount: number
  revealed: boolean
}

export class BlackjackBotStateStore {
  private readonly dbLocation: string
  private openedDb?: LevelDB
  private pendingServerSeed?: string
  private pendingServerSeedHash?: string
  private games = new Map<string, BlackjackGameRecord>()
  private processedPayloadHashes = new Set<string>()
  private pendingWrites: Promise<unknown>[] = []

  constructor(location: string) {
    this.dbLocation = join(location, 'blackjack-bot-state')
  }

  private get db(): LevelDB {
    if (!this.openedDb) {
      throw new Error('No db opened')
    }
    return this.openedDb
  }

  async Open(): Promise<void> {
    // See qwen-bot-state.ts's identical line for why this is needed on a fresh machine.
    mkdirSync(this.dbLocation, { recursive: true })
    this.openedDb = level(this.dbLocation)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const [key, value] of this.db.iterator({}) as any) {
      if (key === PENDING_SEED_KEY) {
        this.pendingServerSeed = JSON.parse(value)
      } else if (key === PENDING_SEED_HASH_KEY) {
        this.pendingServerSeedHash = JSON.parse(value)
      } else if (key.startsWith(GAME_PREFIX)) {
        const parsed = JSON.parse(value)
        this.games.set(key.slice(GAME_PREFIX.length), {
          ...parsed,
          wagerWei: BigInt(parsed.wagerWei),
        })
      } else if (key.startsWith(PROCESSED_PREFIX)) {
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

  getPendingCommitment(): { serverSeed: string; serverSeedHash: string } | undefined {
    if (!this.pendingServerSeed || !this.pendingServerSeedHash) return undefined
    return {
      serverSeed: this.pendingServerSeed,
      serverSeedHash: this.pendingServerSeedHash,
    }
  }

  setPendingCommitment(serverSeed: string, serverSeedHash: string): void {
    this.pendingServerSeed = serverSeed
    this.pendingServerSeedHash = serverSeedHash
    this.pendingWrites.push(
      this.db.put(PENDING_SEED_KEY, JSON.stringify(serverSeed)),
      this.db.put(PENDING_SEED_HASH_KEY, JSON.stringify(serverSeedHash)),
    )
  }

  getGame(gameId: string): BlackjackGameRecord | undefined {
    return this.games.get(gameId)
  }

  setGame(gameId: string, record: BlackjackGameRecord): void {
    this.games.set(gameId, record)
    // JSON.stringify can't serialize a bigint directly -- stringify wagerWei explicitly rather
    // than letting it throw.
    this.pendingWrites.push(
      this.db.put(
        GAME_PREFIX + gameId,
        JSON.stringify({ ...record, wagerWei: record.wagerWei.toString() }),
      ),
    )
  }

  hasProcessed(payloadHashHex: string): boolean {
    return this.processedPayloadHashes.has(payloadHashHex)
  }

  addProcessed(payloadHashHex: string): void {
    this.processedPayloadHashes.add(payloadHashHex)
    this.pendingWrites.push(
      this.db.put(PROCESSED_PREFIX + payloadHashHex, '1'),
    )
  }
}
