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
import { TextDecoder } from 'util'

const PENDING_SEED_KEY = '__pending_server_seed__'
const PENDING_SEED_HASH_KEY = '__pending_server_seed_hash__'
const GAME_PREFIX = 'game:'
const PROCESSED_PREFIX = 'processed:'
const WAGER_CLAIM_PREFIX = 'wager-claim:'
const QUARANTINED_GAME_PREFIX = 'quarantined-game:'
const QUARANTINED_CLAIM_PREFIX = 'quarantined-wager-claim:'

export const MAX_BLACKJACK_GAME_ID_BYTES = 128
const MAX_WAGER_WEI = (1n << 256n) - 1n
const MIN_DEALT_COUNT = 4
const MAX_DEALT_COUNT = 52

type RawBatchOperation =
  | { type: 'put'; key: Buffer; value: Buffer }
  | { type: 'del'; key: Buffer }

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
    commitment.serverSeed.length === 0 ||
    typeof commitment.serverSeedHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(commitment.serverSeedHash) ||
    hashServerSeed(commitment.serverSeed) !== commitment.serverSeedHash
  ) {
    throw new Error(`${label} hash mismatch`)
  }
}

export function normalizeWagerTxHash(wagerTxHash: string): string {
  if (typeof wagerTxHash !== 'string' || !isHexString(wagerTxHash, 32)) {
    throw new Error('wager transaction hash must be 32 bytes')
  }
  return wagerTxHash.toLowerCase()
}

export function normalizePlayerAddress(address: string): string {
  if (typeof address !== 'string') {
    throw new Error('player address must be a valid Monad address')
  }
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
    // Level's default UTF-8 decoder replaces invalid bytes. Open as binary and decode strictly so
    // distinct persisted keys can never alias through U+FFFD and quarantine evidence stays exact.
    this.openedDb = level(this.dbLocation, {
      keyEncoding: 'binary',
      valueEncoding: 'binary',
    } as never)
    this.resetLoadedState()
    try {
      const repairWrites: RawBatchOperation[] = []
      const quarantinedGames: Array<{
        key: Buffer
        value: Buffer
        wagerTxHash: string
      }> = []
      const malformedClaims: Array<{
        key: Buffer
        value: Buffer
        wagerTxHash: string
      }> = []
      const noncanonicalClaims: Array<{
        key: Buffer
        value: Buffer
        wagerTxHash: string
        claimedGameId?: string | null
      }> = []
      const persistedValues = new Map<string, Buffer>()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const [rawKey, rawValue] of this.db.iterator({}) as any) {
        const keyBytes = asBuffer(rawKey)
        const valueBytes = asBuffer(rawValue)
        const key = decodeUtf8Strict(keyBytes, 'blackjack state key')
        persistedValues.set(key, Buffer.from(valueBytes))
        if (key === PENDING_SEED_KEY) {
          const parsed = JSON.parse(
            decodeUtf8Strict(valueBytes, 'pending server seed'),
          )
          if (typeof parsed !== 'string') {
            throw new Error('pending server seed must be a string')
          }
          this.pendingServerSeed = parsed
        } else if (key === PENDING_SEED_HASH_KEY) {
          const parsed = JSON.parse(
            decodeUtf8Strict(valueBytes, 'pending server seed hash'),
          )
          if (typeof parsed !== 'string') {
            throw new Error('pending server seed hash must be a string')
          }
          this.pendingServerSeedHash = parsed
        } else if (key.startsWith(GAME_PREFIX)) {
          const gameIdRaw = key.slice(GAME_PREFIX.length)
          let wagerTxHash: string | undefined
          try {
            const parsed = parseJsonObject(
              decodeUtf8Strict(valueBytes, `game ${gameIdRaw} value`),
              `game ${gameIdRaw}`,
            )
            wagerTxHash = extractCanonicalWagerHash(parsed.wagerTxHash)
            const gameId = normalizeBlackjackGameId(gameIdRaw)
            const record = hydratePersistedGameRecord(parsed, gameId)
            this.games.set(gameId, freezeGameRecord(record))
            if (
              record.authority === 'legacy-unverified' &&
              parsed.revealed !== true
            ) {
              repairWrites.push(
                rawPut(GAME_PREFIX + gameId, serializeGameRecord(record)),
              )
            }
          } catch {
            if (!wagerTxHash) {
              throw new Error(
                'cannot safely quarantine malformed blackjack game row without a canonical wager hash; raw row preserved',
              )
            }
            quarantinedGames.push({
              key: keyBytes,
              value: valueBytes,
              wagerTxHash,
            })
          }
        } else if (key.startsWith(PROCESSED_PREFIX)) {
          this.processedPayloadHashes.add(key.slice(PROCESSED_PREFIX.length))
        } else if (key.startsWith(WAGER_CLAIM_PREFIX)) {
          const wagerTxHashRaw = key.slice(WAGER_CLAIM_PREFIX.length)
          let wagerTxHash: string
          try {
            wagerTxHash = normalizeWagerTxHash(wagerTxHashRaw)
          } catch {
            throw new Error(
              'cannot safely quarantine malformed blackjack wager claim without a canonical wager hash; raw row preserved',
            )
          }
          if (wagerTxHash !== wagerTxHashRaw) {
            let claimedGameId: string | null | undefined
            try {
              claimedGameId = hydratePersistedClaim(
                valueBytes,
                `noncanonical wager claim ${wagerTxHashRaw}`,
              )
            } catch {
              // The raw value is retained as evidence below. Its key is sufficient to consume the
              // canonical wager hash, but malformed metadata must never become game authority.
            }
            noncanonicalClaims.push({
              key: keyBytes,
              value: valueBytes,
              wagerTxHash,
              claimedGameId,
            })
            continue
          }
          try {
            this.wagerClaims.set(
              wagerTxHash,
              hydratePersistedClaim(valueBytes, `wager claim ${wagerTxHash}`),
            )
          } catch {
            this.wagerClaims.set(wagerTxHash, null)
            malformedClaims.push({
              key: keyBytes,
              value: valueBytes,
              wagerTxHash,
            })
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
        const evidenceKey =
          QUARANTINED_GAME_PREFIX + sha256Bytes(quarantined.key)
        retainExactEvidence(
          evidenceKey,
          quarantined.value,
          persistedValues,
          repairWrites,
          'blackjack game',
        )
        repairWrites.push(rawDel(quarantined.key))
        if (!this.wagerClaims.has(quarantined.wagerTxHash)) {
          this.wagerClaims.set(quarantined.wagerTxHash, null)
          repairWrites.push(
            rawPut(
              WAGER_CLAIM_PREFIX + quarantined.wagerTxHash,
              JSON.stringify({ quarantined: true }),
            ),
          )
        }
      }

      for (const malformed of malformedClaims) {
        const evidenceKey =
          QUARANTINED_CLAIM_PREFIX + sha256Bytes(malformed.key)
        retainExactEvidence(
          evidenceKey,
          malformed.value,
          persistedValues,
          repairWrites,
          'blackjack wager claim',
        )
        repairWrites.push(
          rawPut(malformed.key, JSON.stringify({ quarantined: true })),
        )
      }

      for (const noncanonical of noncanonicalClaims) {
        const existingClaim = this.wagerClaims.get(noncanonical.wagerTxHash)
        if (
          typeof existingClaim === 'string' &&
          typeof noncanonical.claimedGameId === 'string' &&
          existingClaim !== noncanonical.claimedGameId
        ) {
          throw new Error(
            `wager ${noncanonical.wagerTxHash} is claimed by both ${existingClaim} and ${noncanonical.claimedGameId}`,
          )
        }
        const evidenceKey =
          QUARANTINED_CLAIM_PREFIX + sha256Bytes(noncanonical.key)
        retainExactEvidence(
          evidenceKey,
          noncanonical.value,
          persistedValues,
          repairWrites,
          'noncanonical blackjack wager claim',
        )
        repairWrites.push(rawDel(noncanonical.key))
        if (!this.wagerClaims.has(noncanonical.wagerTxHash)) {
          this.wagerClaims.set(noncanonical.wagerTxHash, null)
          repairWrites.push(
            rawPut(
              WAGER_CLAIM_PREFIX + noncanonical.wagerTxHash,
              JSON.stringify({ quarantined: true }),
            ),
          )
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
          repairWrites.push(
            rawPut(GAME_PREFIX + gameId, serializeGameRecord(record)),
          )
        } else if (claimedGameId && claimedGameId !== gameId) {
          throw new Error(
            `wager ${loadedRecord.wagerTxHash} is claimed by both ${claimedGameId} and ${gameId}`,
          )
        } else if (!hasClaim) {
          this.wagerClaims.set(loadedRecord.wagerTxHash, gameId)
          repairWrites.push(
            rawPut(
              WAGER_CLAIM_PREFIX + loadedRecord.wagerTxHash,
              JSON.stringify({ gameId }),
            ),
          )
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
        rawPut(PENDING_SEED_KEY, JSON.stringify(serverSeed)),
        rawPut(PENDING_SEED_HASH_KEY, JSON.stringify(serverSeedHash)),
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
    validateRuntimeGameRecord(record, normalizedGameId)
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
        encodeUtf8(GAME_PREFIX + normalizedGameId) as never,
        encodeUtf8(serializeGameRecord(record)) as never,
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
    validateCommitment(
      params.expectedCommitment,
      'expected server seed commitment',
    )
    validateCommitment(params.nextCommitment, 'next server seed commitment')
    validateRuntimeGameRecord(params.record, gameId)
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
        rawPut(WAGER_CLAIM_PREFIX + wagerTxHash, JSON.stringify({ gameId })),
        rawPut(GAME_PREFIX + gameId, serializeGameRecord(params.record)),
        rawPut(
          PENDING_SEED_KEY,
          JSON.stringify(params.nextCommitment.serverSeed),
        ),
        rawPut(
          PENDING_SEED_HASH_KEY,
          JSON.stringify(params.nextCommitment.serverSeedHash),
        ),
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
      this.db.put(
        encodeUtf8(PROCESSED_PREFIX + payloadHashHex) as never,
        encodeUtf8('1') as never,
      ),
    )
  }
}

const CURRENT_GAME_KEYS = [
  'authority',
  'dealtCount',
  'playerAddress',
  'revealed',
  'serverSeed',
  'serverSeedHash',
  'wagerTxHash',
  'wagerWei',
] as const

const LEGACY_GAME_KEYS = CURRENT_GAME_KEYS.filter((key) => key !== 'authority')

function hydratePersistedGameRecord(
  parsed: Record<string, unknown>,
  gameId: string,
): BlackjackGameRecord {
  const isCurrent = hasExactKeys(parsed, CURRENT_GAME_KEYS)
  const isLegacy = hasExactKeys(parsed, LEGACY_GAME_KEYS)
  if (!isCurrent && !isLegacy) {
    throw new Error(`game ${gameId} has an invalid persisted schema`)
  }
  const authority = isLegacy ? 'legacy-unverified' : parsed.authority
  if (
    authority !== 'verified-wager-sender' &&
    authority !== 'legacy-unverified'
  ) {
    throw new Error(`game ${gameId} has invalid authority`)
  }
  if (
    typeof parsed.serverSeed !== 'string' ||
    typeof parsed.serverSeedHash !== 'string' ||
    typeof parsed.wagerTxHash !== 'string' ||
    typeof parsed.wagerWei !== 'string' ||
    typeof parsed.playerAddress !== 'string' ||
    typeof parsed.dealtCount !== 'number' ||
    typeof parsed.revealed !== 'boolean'
  ) {
    throw new Error(`game ${gameId} has invalid field types`)
  }
  if (
    parsed.wagerWei.length > MAX_WAGER_WEI.toString().length ||
    !/^(0|[1-9][0-9]*)$/.test(parsed.wagerWei)
  ) {
    throw new Error(`game ${gameId} has invalid wager amount`)
  }
  const wagerWei = BigInt(parsed.wagerWei)
  const record: BlackjackGameRecord = {
    authority,
    serverSeed: parsed.serverSeed,
    serverSeedHash: parsed.serverSeedHash,
    wagerTxHash: parsed.wagerTxHash,
    wagerWei,
    playerAddress: parsed.playerAddress,
    dealtCount: parsed.dealtCount,
    revealed: authority === 'legacy-unverified' ? true : parsed.revealed,
  }
  validateRuntimeGameRecord(record, gameId)
  return record
}

function validateRuntimeGameRecord(
  record: BlackjackGameRecord,
  gameId: string,
): void {
  if (!isPlainObject(record) || !hasExactKeys(record, CURRENT_GAME_KEYS)) {
    throw new Error(`game ${gameId} has an invalid schema`)
  }
  if (
    record.authority !== 'verified-wager-sender' &&
    record.authority !== 'legacy-unverified'
  ) {
    throw new Error(`game ${gameId} has invalid authority`)
  }
  validateCommitment(record, `game ${gameId} server seed commitment`)
  if (normalizeWagerTxHash(record.wagerTxHash) !== record.wagerTxHash) {
    throw new Error(`game ${gameId} wager hash must be canonical`)
  }
  if (
    typeof record.wagerWei !== 'bigint' ||
    record.wagerWei < 0n ||
    record.wagerWei > MAX_WAGER_WEI
  ) {
    throw new Error(`game ${gameId} has invalid wager amount`)
  }
  if (
    typeof record.playerAddress !== 'string' ||
    normalizePlayerAddress(record.playerAddress) !== record.playerAddress
  ) {
    throw new Error(`game ${gameId} player address must be canonical`)
  }
  if (
    typeof record.dealtCount !== 'number' ||
    !Number.isFinite(record.dealtCount) ||
    !Number.isInteger(record.dealtCount) ||
    record.dealtCount < MIN_DEALT_COUNT ||
    record.dealtCount > MAX_DEALT_COUNT
  ) {
    throw new Error(`game ${gameId} has invalid dealt count`)
  }
  if (typeof record.revealed !== 'boolean') {
    throw new Error(`game ${gameId} has invalid revealed state`)
  }
  if (record.authority === 'legacy-unverified' && !record.revealed) {
    throw new Error(`game ${gameId} legacy authority must remain revealed`)
  }
}

function hydratePersistedClaim(value: Buffer, label: string): string | null {
  const parsed = parseJsonObject(
    decodeUtf8Strict(value, `${label} value`),
    label,
  )
  if (hasExactKeys(parsed, ['quarantined'])) {
    if (parsed.quarantined !== true) throw new Error(`${label} is invalid`)
    return null
  }
  if (!hasExactKeys(parsed, ['gameId'])) {
    throw new Error(`${label} has an invalid schema`)
  }
  return normalizeBlackjackGameId(parsed.gameId)
}

function parseJsonObject(
  value: string,
  label: string,
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (!isPlainObject(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return parsed
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  )
}

function extractCanonicalWagerHash(value: unknown): string {
  if (typeof value !== 'string') throw new Error('missing wager hash')
  return normalizeWagerTxHash(value)
}

function encodeUtf8(value: string): Buffer {
  return Buffer.from(value, 'utf8')
}

function asBuffer(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
}

function decodeUtf8Strict(value: Buffer, label: string): string {
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    throw new Error(`${label} is not valid UTF-8`)
  }
  if (!encodeUtf8(decoded).equals(value)) {
    throw new Error(`${label} is not lossless UTF-8`)
  }
  return decoded
}

function rawPut(
  key: string | Buffer,
  value: string | Buffer,
): RawBatchOperation {
  return {
    type: 'put',
    key: typeof key === 'string' ? encodeUtf8(key) : key,
    value: typeof value === 'string' ? encodeUtf8(value) : value,
  }
}

function rawDel(key: string | Buffer): RawBatchOperation {
  return { type: 'del', key: typeof key === 'string' ? encodeUtf8(key) : key }
}

function retainExactEvidence(
  evidenceKey: string,
  sourceValue: Buffer,
  persistedValues: Map<string, Buffer>,
  repairWrites: RawBatchOperation[],
  label: string,
): void {
  const existingEvidence = persistedValues.get(evidenceKey)
  if (existingEvidence) {
    if (!existingEvidence.equals(sourceValue)) {
      throw new Error(
        `${label} evidence collision; source and existing evidence preserved`,
      )
    }
    return
  }
  repairWrites.push(rawPut(evidenceKey, sourceValue))
  persistedValues.set(evidenceKey, Buffer.from(sourceValue))
}

function sha256Bytes(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function serializeGameRecord(record: BlackjackGameRecord): string {
  // JSON.stringify can't serialize a bigint directly -- stringify wagerWei explicitly rather
  // than letting it throw.
  return JSON.stringify({ ...record, wagerWei: record.wagerWei.toString() })
}

function freezeGameRecord(record: BlackjackGameRecord): BlackjackGameRecord {
  return Object.freeze({ ...record })
}
