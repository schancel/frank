/**
 * Persisted state for `blackjack-bot.livecheck.ts`, mirroring `qwen-bot-state.ts`'s established
 * `level`-backed pattern exactly.
 *
 * Three kinds of state, all essential to the fairness/authority scheme
 * (`@frank/wallet/blackjack/deck.ts`'s header):
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
 * - **Global wager claims** (`wagerTxHash -> gameId`): an independently keyed tombstone proving a
 *   verified transaction can never authorize another hand, even if its game row is quarantined.
 */
import { createHash } from 'crypto'
import { mkdirSync } from 'fs'
import { getAddress, isHexString } from 'ethers'
import level, { LevelDB } from 'level'
import { join } from 'path'

const PENDING_SEED_KEY = '__pending_server_seed__'
const PENDING_SEED_HASH_KEY = '__pending_server_seed_hash__'
const GAME_PREFIX = 'game:'
const PROCESSED_PREFIX = 'processed:'
const WAGER_CLAIM_PREFIX = 'wager-claim:'
const QUARANTINED_GAME_PREFIX = 'quarantined-game:'
const QUARANTINED_CLAIM_PREFIX = 'quarantined-wager-claim:'

export const MAX_BLACKJACK_GAME_ID_BYTES = 128

export class InvalidBlackjackGameIdError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidBlackjackGameIdError'
  }
}

export interface ServerSeedCommitment {
  serverSeed: string
  serverSeedHash: string
}

export function normalizeBlackjackGameId(gameId: unknown): string {
  if (typeof gameId !== 'string' || gameId.length === 0) {
    throw new InvalidBlackjackGameIdError(
      'blackjack gameId must be a nonempty string',
    )
  }
  if (Buffer.byteLength(gameId, 'utf8') > MAX_BLACKJACK_GAME_ID_BYTES) {
    throw new InvalidBlackjackGameIdError(
      `blackjack gameId must be at most ${MAX_BLACKJACK_GAME_ID_BYTES} bytes`,
    )
  }
  if (!isWellFormedUnicode(gameId)) {
    throw new InvalidBlackjackGameIdError(
      'blackjack gameId must contain only well-formed Unicode',
    )
  }
  return gameId
}

function isWellFormedUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const codeUnit = value.charCodeAt(i)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(i + 1)
      if (i + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        return false
      }
      i += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false
    }
  }
  return true
}

function hashServerSeed(serverSeed: string): string {
  return createHash('sha256').update(serverSeed).digest('hex')
}

function validateCommitment(
  commitment: ServerSeedCommitment,
  label: string,
): void {
  if (
    typeof commitment.serverSeed !== 'string' ||
    typeof commitment.serverSeedHash !== 'string' ||
    hashServerSeed(commitment.serverSeed) !== commitment.serverSeedHash
  ) {
    throw new Error(`${label} hash mismatch`)
  }
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
  private wagerClaims = new Map<string, string | null>()
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
    this.resetLoadedState()
    try {
      const repairWrites: Array<Record<string, unknown>> = []
      const quarantinedGames: Array<{
        key: string
        value: string
        wagerTxHash: string
      }> = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const [key, value] of this.db.iterator({}) as any) {
        if (key === PENDING_SEED_KEY) {
          this.pendingServerSeed = JSON.parse(value)
        } else if (key === PENDING_SEED_HASH_KEY) {
          this.pendingServerSeedHash = JSON.parse(value)
        } else if (key.startsWith(GAME_PREFIX)) {
          const gameIdRaw = key.slice(GAME_PREFIX.length)
          let parsed: Record<string, unknown>
          let wagerTxHash: string | undefined
          try {
            parsed = JSON.parse(value)
            wagerTxHash = normalizeWagerTxHash(String(parsed.wagerTxHash))
            const gameId = normalizeBlackjackGameId(gameIdRaw)
            const authority =
              parsed.authority === 'verified-wager-sender'
                ? 'verified-wager-sender'
                : 'legacy-unverified'
            const record: BlackjackGameRecord = {
              ...parsed,
              authority,
              serverSeed: String(parsed.serverSeed),
              serverSeedHash: String(parsed.serverSeedHash),
              wagerTxHash,
              wagerWei: BigInt(String(parsed.wagerWei)),
              playerAddress: normalizePlayerAddress(String(parsed.playerAddress)),
              dealtCount: Number(parsed.dealtCount),
              // An old record captured the envelope sender without proving that address funded
              // the wager. Preserve it as consumed, but never allow that authority to act or pay.
              revealed:
                authority === 'verified-wager-sender'
                  ? parsed.revealed === true
                  : true,
            }
            validateCommitment(record, `game ${gameId} server seed commitment`)
            this.games.set(gameId, freezeGameRecord(record))
            if (authority === 'legacy-unverified' && parsed.revealed !== true) {
              repairWrites.push({
                type: 'put',
                key: GAME_PREFIX + gameId,
                value: serializeGameRecord(record),
              })
            }
          } catch {
            if (!wagerTxHash) {
              throw new Error(
                'cannot safely quarantine malformed blackjack game row without a canonical wager hash; raw row preserved',
              )
            }
            quarantinedGames.push({ key, value, wagerTxHash })
          }
        } else if (key.startsWith(PROCESSED_PREFIX)) {
          this.processedPayloadHashes.add(key.slice(PROCESSED_PREFIX.length))
        } else if (key.startsWith(WAGER_CLAIM_PREFIX)) {
          const wagerTxHashRaw = key.slice(WAGER_CLAIM_PREFIX.length)
          let wagerTxHash: string
          try {
            wagerTxHash = normalizeWagerTxHash(wagerTxHashRaw)
            if (wagerTxHash !== wagerTxHashRaw) throw new Error()
          } catch {
            throw new Error(
              'cannot safely quarantine malformed blackjack wager claim without a canonical wager hash; raw row preserved',
            )
          }
          try {
            const parsed = JSON.parse(value)
            this.wagerClaims.set(
              wagerTxHash,
              normalizeBlackjackGameId(parsed.gameId),
            )
          } catch {
            this.wagerClaims.set(wagerTxHash, null)
            repairWrites.push(
              {
                type: 'put',
                key:
                  QUARANTINED_CLAIM_PREFIX +
                  createHash('sha256').update(key).digest('hex'),
                value,
              },
              {
                type: 'put',
                key,
                value: JSON.stringify({ quarantined: true }),
              },
            )
          }
        }
      }

      const hasPendingSeed = this.pendingServerSeed !== undefined
      const hasPendingHash = this.pendingServerSeedHash !== undefined
      if (hasPendingSeed !== hasPendingHash) {
        throw new Error('pending server seed commitment is incomplete')
      }
      if (hasPendingSeed && hasPendingHash) {
        validateCommitment(
          {
            serverSeed: this.pendingServerSeed as string,
            serverSeedHash: this.pendingServerSeedHash as string,
          },
          'pending server seed commitment',
        )
      }

      for (const quarantined of quarantinedGames) {
        repairWrites.push(
          { type: 'del', key: quarantined.key },
          {
            type: 'put',
            key:
              QUARANTINED_GAME_PREFIX +
              createHash('sha256').update(quarantined.key).digest('hex'),
            value: quarantined.value,
          },
        )
        if (!this.wagerClaims.has(quarantined.wagerTxHash)) {
          this.wagerClaims.set(quarantined.wagerTxHash, null)
          repairWrites.push({
            type: 'put',
            key: WAGER_CLAIM_PREFIX + quarantined.wagerTxHash,
            value: JSON.stringify({ quarantined: true }),
          })
        }
      }

      // Pre-authority-fix game records did not have separate global claim keys. Backfill the claim
      // so a restart cannot make an already-consumed wager reusable. A quarantined claim also
      // tombstones any related game rather than trusting ambiguous authority.
      for (const [gameId, loadedRecord] of this.games) {
        const hasClaim = this.wagerClaims.has(loadedRecord.wagerTxHash)
        const claimedGameId = this.wagerClaims.get(loadedRecord.wagerTxHash)
        if (hasClaim && claimedGameId === null) {
          const record = freezeGameRecord({
            ...loadedRecord,
            authority: 'legacy-unverified',
            revealed: true,
          })
          this.games.set(gameId, record)
          repairWrites.push({
            type: 'put',
            key: GAME_PREFIX + gameId,
            value: serializeGameRecord(record),
          })
        } else if (claimedGameId && claimedGameId !== gameId) {
          throw new Error(
            `wager ${loadedRecord.wagerTxHash} is claimed by both ${claimedGameId} and ${gameId}`,
          )
        } else if (!hasClaim) {
          this.wagerClaims.set(loadedRecord.wagerTxHash, gameId)
          repairWrites.push({
            type: 'put',
            key: WAGER_CLAIM_PREFIX + loadedRecord.wagerTxHash,
            value: JSON.stringify({ gameId }),
          })
        }
      }
      if (repairWrites.length > 0) {
        // level@7 has atomic batch at runtime, but its legacy LevelDB type alias omits it.
        await (this.db as any).batch(repairWrites)
      }
    } catch (error) {
      const openedDb = this.openedDb
      this.openedDb = undefined
      this.resetLoadedState()
      await openedDb?.close()
      throw error
    }
  }

  private resetLoadedState(): void {
    this.pendingServerSeed = undefined
    this.pendingServerSeedHash = undefined
    this.games.clear()
    this.wagerClaims.clear()
    this.processedPayloadHashes.clear()
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
    if (
      this.pendingServerSeed === undefined ||
      this.pendingServerSeedHash === undefined
    ) {
      return undefined
    }
    return {
      serverSeed: this.pendingServerSeed,
      serverSeedHash: this.pendingServerSeedHash,
    }
  }

  async setPendingCommitment(
    serverSeed: string,
    serverSeedHash: string,
  ): Promise<void> {
    validateCommitment(
      { serverSeed, serverSeedHash },
      'pending server seed commitment',
    )
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
    return this.games.get(normalizeBlackjackGameId(gameId))
  }

  async setGame(gameId: string, record: BlackjackGameRecord): Promise<void> {
    const normalizedGameId = normalizeBlackjackGameId(gameId)
    validateCommitment(record, `game ${normalizedGameId} server seed commitment`)
    await this.serializeMutation(async () => {
      const existing = this.games.get(normalizedGameId)
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
      await this.db.put(
        GAME_PREFIX + normalizedGameId,
        serializeGameRecord(record),
      )
      this.games.set(normalizedGameId, freezeGameRecord(record))
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
    const gameId = normalizeBlackjackGameId(params.gameId)
    void this.db
    const wagerTxHash = normalizeWagerTxHash(params.wagerTxHash)
    validateCommitment(params.expectedCommitment, 'expected server seed commitment')
    validateCommitment(params.nextCommitment, 'next server seed commitment')
    validateCommitment(params.record, `game ${gameId} server seed commitment`)
    if (
      params.record.serverSeed !== params.expectedCommitment.serverSeed ||
      params.record.serverSeedHash !== params.expectedCommitment.serverSeedHash
    ) {
      throw new Error('game commitment does not match the expected commitment')
    }
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
      if (
        this.pendingServerSeed !== undefined &&
        this.pendingServerSeedHash !== undefined
      ) {
        validateCommitment(
          {
            serverSeed: this.pendingServerSeed,
            serverSeedHash: this.pendingServerSeedHash,
          },
          'pending server seed commitment',
        )
      }
      if (this.games.has(gameId)) {
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
          value: JSON.stringify({ gameId }),
        },
        {
          type: 'put',
          key: GAME_PREFIX + gameId,
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
      this.wagerClaims.set(wagerTxHash, gameId)
      this.games.set(gameId, freezeGameRecord(params.record))
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
