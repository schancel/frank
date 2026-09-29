/**
 * Persisted state for `blackjack-bot.livecheck.ts`, mirroring `qwen-bot-state.ts`'s established
 * `level`-backed pattern exactly.
 *
 * Two kinds of state, both essential to the fairness scheme (`@frank/wallet/blackjack/deck.ts`'s
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
import { getAddress, isHexString } from 'ethers'
import level, { LevelDB } from 'level'
import { join } from 'path'

const PENDING_SEED_KEY = '__pending_server_seed__'
const PENDING_SEED_HASH_KEY = '__pending_server_seed_hash__'
const GAME_PREFIX = 'game:'
const PROCESSED_PREFIX = 'processed:'
const WAGER_CLAIM_PREFIX = 'wager-claim:'

export interface ServerSeedCommitment {
  serverSeed: string
  serverSeedHash: string
}

export function normalizeWagerTxHash(wagerTxHash: string): string {
  if (!isHexString(wagerTxHash, 32)) {
    throw new Error('wager transaction hash must be 32 bytes')
  }
  return wagerTxHash.toLowerCase()
}

export function normalizePlayerAddress(address: string): string {
  try {
    return getAddress(address)
  } catch {
    throw new Error('player address must be a valid Monad address')
  }
}

export interface BlackjackGameRecord {
  /** Distinguishes games whose authority was bound to a verified wager sender from legacy records
   * that predate that check. Legacy records are tombstoned during Open and can never pay out. */
  authority: 'verified-wager-sender' | 'legacy-unverified'
  serverSeed: string
  serverSeedHash: string
  wagerTxHash: string
  /** The on-chain-verified wager amount (see `hydrate()` in
   * `@frank/wallet/message-item-plugins/blackjack.ts`) -- never a self-reported figure. Persisted
   * here (not re-verified at payout time) since the bot already confirmed it once at `bet` time. */
  wagerWei: bigint
  /** Canonical Monad identity address verified as the wager transaction sender. Monad identities
   * are EVM accounts, so this single immutable authority is both the only player allowed to move
   * and the only address eligible to receive this game's payout. */
  playerAddress: string
  /** How many cards have been dealt so far (starts at 4: player's 2 + dealer's 2), per the dealing
   * order convention `@frank/wallet/blackjack/game.ts`'s header defines -- the next card dealt is
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
  private wagerClaims = new Map<string, string>()
  private processedPayloadHashes = new Set<string>()
  private pendingWrites: Promise<unknown>[] = []
  private mutationQueue: Promise<void> = Promise.resolve()

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
    const missingClaimWrites: Array<{
      type: 'put'
      key: string
      value: string
    }> = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const [key, value] of this.db.iterator({}) as any) {
      if (key === PENDING_SEED_KEY) {
        this.pendingServerSeed = JSON.parse(value)
      } else if (key === PENDING_SEED_HASH_KEY) {
        this.pendingServerSeedHash = JSON.parse(value)
      } else if (key.startsWith(GAME_PREFIX)) {
        const parsed = JSON.parse(value)
        const gameId = key.slice(GAME_PREFIX.length)
        const authority =
          parsed.authority === 'verified-wager-sender'
            ? 'verified-wager-sender'
            : 'legacy-unverified'
        const record: BlackjackGameRecord = {
          ...parsed,
          authority,
          wagerTxHash: normalizeWagerTxHash(parsed.wagerTxHash),
          wagerWei: BigInt(parsed.wagerWei),
          playerAddress: normalizePlayerAddress(parsed.playerAddress),
          // An old record captured the envelope sender without proving that address funded the
          // wager. Preserve the wager as consumed, but never let that unproven authority move or
          // receive a payout after upgrade.
          revealed:
            authority === 'verified-wager-sender' ? parsed.revealed : true,
        }
        this.games.set(gameId, freezeGameRecord(record))
        if (authority === 'legacy-unverified' && !parsed.revealed) {
          missingClaimWrites.push({
            type: 'put',
            key: GAME_PREFIX + gameId,
            value: serializeGameRecord(record),
          })
        }
      } else if (key.startsWith(PROCESSED_PREFIX)) {
        this.processedPayloadHashes.add(key.slice(PROCESSED_PREFIX.length))
      } else if (key.startsWith(WAGER_CLAIM_PREFIX)) {
        const wagerTxHash = key.slice(WAGER_CLAIM_PREFIX.length)
        if (normalizeWagerTxHash(wagerTxHash) !== wagerTxHash) {
          throw new Error(`non-canonical wager claim key: ${key}`)
        }
        this.wagerClaims.set(wagerTxHash, JSON.parse(value).gameId)
      }
    }

    // Pre-authority-fix game records did not have separate global claim keys. Backfill the claim
    // from their immutable wager hash so a restart cannot make an already-consumed wager reusable.
    // If historical state already contains two games for one wager, fail closed rather than pick
    // an arbitrary payout authority.
    for (const [gameId, record] of this.games) {
      const claimedGameId = this.wagerClaims.get(record.wagerTxHash)
      if (claimedGameId && claimedGameId !== gameId) {
        throw new Error(
          `wager ${record.wagerTxHash} is claimed by both ${claimedGameId} and ${gameId}`,
        )
      }
      if (!claimedGameId) {
        this.wagerClaims.set(record.wagerTxHash, gameId)
        missingClaimWrites.push({
          type: 'put',
          key: WAGER_CLAIM_PREFIX + record.wagerTxHash,
          value: JSON.stringify({ gameId }),
        })
      }
    }
    if (missingClaimWrites.length > 0) {
      // level@7 has atomic batch at runtime, but its legacy LevelDB type alias omits it.
      await (this.db as any).batch(missingClaimWrites)
    }
  }

  async Close(): Promise<void> {
    await this.flush()
    await this.db.close()
  }

  async flush(): Promise<void> {
    const writes = this.pendingWrites
    this.pendingWrites = []
    await Promise.all(writes)
  }

  private serializeMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(mutation)
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    )
    this.pendingWrites.push(result)
    return result
  }

  getPendingCommitment(): ServerSeedCommitment | undefined {
    if (!this.pendingServerSeed || !this.pendingServerSeedHash) return undefined
    return {
      serverSeed: this.pendingServerSeed,
      serverSeedHash: this.pendingServerSeedHash,
    }
  }

  async setPendingCommitment(
    serverSeed: string,
    serverSeedHash: string,
  ): Promise<void> {
    await this.serializeMutation(async () => {
      await (this.db as any).batch([
        {
          type: 'put',
          key: PENDING_SEED_KEY,
          value: JSON.stringify(serverSeed),
        },
        {
          type: 'put',
          key: PENDING_SEED_HASH_KEY,
          value: JSON.stringify(serverSeedHash),
        },
      ])
      this.pendingServerSeed = serverSeed
      this.pendingServerSeedHash = serverSeedHash
    })
  }

  getGame(gameId: string): BlackjackGameRecord | undefined {
    return this.games.get(gameId)
  }

  async setGame(gameId: string, record: BlackjackGameRecord): Promise<void> {
    await this.serializeMutation(async () => {
      const existing = this.games.get(gameId)
      if (!existing) {
        throw new Error('a blackjack game must be created with its wager claim')
      }
      if (
        existing.serverSeed !== record.serverSeed ||
        existing.serverSeedHash !== record.serverSeedHash ||
        existing.authority !== record.authority ||
        existing.wagerTxHash !== record.wagerTxHash ||
        existing.wagerWei !== record.wagerWei ||
        existing.playerAddress !== record.playerAddress
      ) {
        throw new Error('cannot change immutable blackjack game authority')
      }
      if (
        record.dealtCount < existing.dealtCount ||
        (existing.revealed && !record.revealed)
      ) {
        throw new Error('cannot move blackjack game state backwards')
      }
      await this.db.put(GAME_PREFIX + gameId, serializeGameRecord(record))
      this.games.set(gameId, freezeGameRecord(record))
    })
  }

  async claimWagerAndCreateGame(params: {
    gameId: string
    wagerTxHash: string
    record: BlackjackGameRecord
    expectedCommitment: ServerSeedCommitment
    nextCommitment: ServerSeedCommitment
  }): Promise<
    | { ok: true }
    | {
        ok: false
        reason: 'game_exists' | 'wager_claimed' | 'commitment_changed'
      }
  > {
    const wagerTxHash = normalizeWagerTxHash(params.wagerTxHash)
    if (params.record.wagerTxHash !== wagerTxHash) {
      throw new Error('game wager hash does not match its wager claim')
    }
    if (params.record.authority !== 'verified-wager-sender') {
      throw new Error('a new game requires verified wager authority')
    }
    if (
      normalizePlayerAddress(params.record.playerAddress) !==
      params.record.playerAddress
    ) {
      throw new Error('game player address must be canonical')
    }

    return this.serializeMutation(async () => {
      if (this.games.has(params.gameId)) {
        return { ok: false as const, reason: 'game_exists' as const }
      }
      if (this.wagerClaims.has(wagerTxHash)) {
        return { ok: false as const, reason: 'wager_claimed' as const }
      }
      if (
        this.pendingServerSeed !== params.expectedCommitment.serverSeed ||
        this.pendingServerSeedHash !== params.expectedCommitment.serverSeedHash
      ) {
        return { ok: false as const, reason: 'commitment_changed' as const }
      }

      // Claim, game authority, and seed rotation are one durable transition. Memory changes only
      // after Level acknowledges the batch, so a rejected/failed batch leaves no partial claim or
      // consumed commitment in this process either.
      await (this.db as any).batch([
        {
          type: 'put',
          key: WAGER_CLAIM_PREFIX + wagerTxHash,
          value: JSON.stringify({ gameId: params.gameId }),
        },
        {
          type: 'put',
          key: GAME_PREFIX + params.gameId,
          value: serializeGameRecord(params.record),
        },
        {
          type: 'put',
          key: PENDING_SEED_KEY,
          value: JSON.stringify(params.nextCommitment.serverSeed),
        },
        {
          type: 'put',
          key: PENDING_SEED_HASH_KEY,
          value: JSON.stringify(params.nextCommitment.serverSeedHash),
        },
      ])
      this.wagerClaims.set(wagerTxHash, params.gameId)
      this.games.set(params.gameId, freezeGameRecord(params.record))
      this.pendingServerSeed = params.nextCommitment.serverSeed
      this.pendingServerSeedHash = params.nextCommitment.serverSeedHash
      return { ok: true as const }
    })
  }

  hasProcessed(payloadHashHex: string): boolean {
    return this.processedPayloadHashes.has(payloadHashHex)
  }

  addProcessed(payloadHashHex: string): void {
    this.processedPayloadHashes.add(payloadHashHex)
    void this.serializeMutation(() =>
      this.db.put(PROCESSED_PREFIX + payloadHashHex, '1'),
    )
  }
}

function serializeGameRecord(record: BlackjackGameRecord): string {
  // JSON.stringify can't serialize a bigint directly -- stringify wagerWei explicitly rather
  // than letting it throw.
  return JSON.stringify({ ...record, wagerWei: record.wagerWei.toString() })
}

function freezeGameRecord(record: BlackjackGameRecord): BlackjackGameRecord {
  return Object.freeze({ ...record })
}
