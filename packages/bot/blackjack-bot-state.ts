/**
 * Persisted state for `blackjack-bot.livecheck.ts`, mirroring `qwen-bot-state.ts`'s established
 * `level`-backed pattern exactly.
 *
 * Three kinds of state, all essential to the fairness/authority scheme
 * (`@frank/wallet/message-item-plugins/blackjack/deck.ts`'s header):
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

/** A refund of a verified-but-rejected stake. `pending` = nothing was broadcast (safe to retry),
 * `submitting` = a signed transfer may have reached the network (never retried automatically, to
 * make a double refund impossible), `sent` = done. */
export interface RefundRecord {
  status: 'pending' | 'submitting' | 'sent'
  playerAddress: string
  amountWei: bigint
  refundTxHash?: string
}

/** The payout a resolved game owes its player, persisted INSIDE the game record so it is written in
 * the same atomic put that marks the game revealed (see `resolveGameWithPayout`).
 *
 * - `owed`: nothing signed yet; safe to (re)build and sign.
 * - `submitting`: a signed transaction (`rawTx`/`txHash`, journaled BEFORE it was broadcast) may or
 *   may not have reached the network. It is only ever re-broadcast as the same bytes, never
 *   re-signed, so at most one transfer can ever mine for this game.
 * - `submitted`: the node accepted the broadcast; still not paid until a receipt shows success.
 * - `confirmed`: a receipt shows success. Terminal.
 * - `failed`: the transaction mined but reverted (value not moved). Terminal for the bot, left for
 *   an operator (a re-sign would be sound here, but is deliberately not automated). */
export interface PayoutRecord {
  status: 'owed' | 'submitting' | 'submitted' | 'confirmed' | 'failed'
  amountWei: bigint
  rawTx?: string
  txHash?: string
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
   * `@frank/wallet/message-item-plugins/blackjack/plugin.ts`) -- never a self-reported figure. Persisted
   * here (not re-verified at payout time) since the bot already confirmed it once at `bet` time. */
  wagerWei: bigint
  /** Canonical Monad identity address verified as the wager transaction sender. Monad identities
   * are EVM accounts, so this single immutable authority is both the only player allowed to move
   * and the only address eligible to receive this game's payout. */
  playerAddress: string
  /** How many cards have been dealt so far (starts at 4: player's 2 + dealer's 2), per the dealing
   * order convention `@frank/wallet/message-item-plugins/blackjack/game.ts`'s header defines -- the next card dealt is
   * always `deck[dealtCount]`. */
  dealtCount: number
  revealed: boolean
  /** Set once a `double` move is accepted for this game -- mirrors `BlackjackGameState.doubled`
   * (`@frank/wallet/message-item-plugins/blackjack/game.ts`). Drives `resolveAndReveal`'s payout math, which doubles
   * the effective wager whenever this is true. Always present (never omitted) so the exact-keys
   * persisted schema stays a single shape going forward -- see `hydratePersistedGameRecord`'s
   * `PRE_DOUBLE_GAME_KEYS` migration path for rows written before this field existed. */
  doubled: boolean
  /** The on-chain-verified second wager a double-down required (see `hydrate()`'s
   * `verifiedDoubleWager` in `@frank/wallet/message-item-plugins/blackjack/plugin.ts`) -- never a self-reported figure,
   * same trust rule as `wagerWei`. Only ever set together with `doubled: true`, in the same
   * `setGame` transition. */
  doubleWagerWei?: bigint
  /** Set (atomically with `revealed: true`) when the resolved hand owes the player money. Absent
   * on a loss and on every row written before payouts were journaled. */
  payout?: PayoutRecord
}

export class BlackjackBotStateStore {
  private readonly dbLocation: string
  private openedDb?: LevelDB
  private pendingServerSeed?: string
  private pendingServerSeedHash?: string
  private games = new Map<string, BlackjackGameRecord>()
  private wagerClaims = new Map<string, string | null>()
  private refunds = new Map<string, RefundRecord>()
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
            const refund = tryParseRefundClaim(valueBytes)
            if (refund) {
              // A refunded transfer consumed its hash: it can never back a game afterwards.
              this.wagerClaims.set(wagerTxHash, null)
              this.refunds.set(wagerTxHash, refund)
              continue
            }
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
    this.refunds.clear()
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
      if (!samePayout(existing.payout, record.payout)) {
        throw new Error('setGame cannot change a game payout')
      }
      if (
        record.dealtCount < existing.dealtCount ||
        (existing.revealed && !record.revealed) ||
        (existing.doubled && !record.doubled) ||
        (existing.doubleWagerWei !== undefined &&
          existing.doubleWagerWei !== record.doubleWagerWei)
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

  /**
   * Marks a game revealed and, when it owes the player, records the payout as `owed` in the SAME
   * atomic put. There is no durable state in which a hand is resolved but its payout is unrecorded.
   * Idempotent: an already-revealed game is left untouched (returns `already_revealed`).
   */
  async resolveGameWithPayout(params: {
    gameId: string
    dealtCount: number
    payoutWei: bigint
  }): Promise<{ ok: true } | { ok: false; reason: 'already_revealed' | 'no_game' }> {
    const gameId = normalizeBlackjackGameId(params.gameId)
    if (params.payoutWei < 0n || params.payoutWei > MAX_WAGER_WEI) {
      throw new Error('payout amount is out of range')
    }
    return this.serializeMutation(async () => {
      const existing = this.games.get(gameId)
      if (!existing || existing.authority !== 'verified-wager-sender') {
        return { ok: false as const, reason: 'no_game' as const }
      }
      if (existing.revealed) {
        return { ok: false as const, reason: 'already_revealed' as const }
      }
      if (params.dealtCount < existing.dealtCount) {
        throw new Error('cannot move blackjack game state backwards')
      }
      const record: BlackjackGameRecord = {
        ...existing,
        dealtCount: params.dealtCount,
        revealed: true,
        payout:
          params.payoutWei > 0n
            ? { status: 'owed', amountWei: params.payoutWei }
            : undefined,
      }
      validateRuntimeGameRecord(record, gameId)
      await (this.db as any).batch([
        rawPut(GAME_PREFIX + gameId, serializeGameRecord(record)),
      ])
      this.games.set(gameId, freezeGameRecord(record))
      return { ok: true as const }
    })
  }

  getPayout(gameId: string): PayoutRecord | undefined {
    return this.games.get(normalizeBlackjackGameId(gameId))?.payout
  }

  /** Games whose payout is not yet terminal (`confirmed`/`failed`). */
  getOpenPayouts(): Array<[string, PayoutRecord]> {
    const open: Array<[string, PayoutRecord]> = []
    for (const [gameId, game] of this.games) {
      const p = game.payout
      if (p && p.status !== 'confirmed' && p.status !== 'failed') {
        open.push([gameId, p])
      }
    }
    return open
  }

  /** True while a signed payout transaction exists that is not yet confirmed. While true, nothing
   * else may sign on the payer account: an unbroadcast signed payout still owns its nonce, and any
   * other transaction built from the chain's pending count could take it. */
  hasSignedUnconfirmedPayout(): boolean {
    for (const game of this.games.values()) {
      const s = game.payout?.status
      if (s === 'submitting' || s === 'submitted') return true
    }
    return false
  }

  /** Advances a payout along `owed -> submitting -> submitted -> confirmed` (or `failed`). The
   * signed bytes are journaled by the `submitting` transition and never change afterwards. */
  async setPayoutState(
    gameId: string,
    next: { status: PayoutRecord['status']; rawTx?: string; txHash?: string },
  ): Promise<void> {
    const id = normalizeBlackjackGameId(gameId)
    await this.serializeMutation(async () => {
      const existing = this.games.get(id)
      const current = existing?.payout
      if (!existing || !current) throw new Error('no payout is owed for this game')
      const allowed: Record<PayoutRecord['status'], PayoutRecord['status'][]> = {
        owed: ['submitting'],
        submitting: ['submitted', 'confirmed', 'failed'],
        submitted: ['confirmed', 'failed'],
        confirmed: [],
        failed: [],
      }
      if (!allowed[current.status].includes(next.status)) {
        throw new Error(`illegal payout transition ${current.status} -> ${next.status}`)
      }
      let payout: PayoutRecord
      if (next.status === 'submitting') {
        if (!next.rawTx || !next.txHash) {
          throw new Error('the signed payout must be journaled with its raw tx and hash')
        }
        payout = { ...current, status: 'submitting', rawTx: next.rawTx, txHash: next.txHash }
      } else {
        payout = { ...current, status: next.status }
      }
      const record: BlackjackGameRecord = { ...existing, payout }
      await this.db.put(
        encodeUtf8(GAME_PREFIX + id) as never,
        encodeUtf8(serializeGameRecord(record)) as never,
      )
      this.games.set(id, freezeGameRecord(record))
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


  /**
   * Claims a double-down transfer hash in the SAME global keyspace as wager hashes and marks the
   * game doubled in one atomic batch. A hash already claimed by any game (including this game's
   * own original wager), or by a refund, is refused, so one real transfer can back exactly one
   * stake ever.
   */
  async claimDoubleWagerAndUpdateGame(params: {
    gameId: string
    doubleWagerTxHash: string
    record: BlackjackGameRecord
  }): Promise<
    { ok: true } | { ok: false; reason: 'wager_claimed' | 'game_state_changed' }
  > {
    const gameId = normalizeBlackjackGameId(params.gameId)
    const doubleWagerTxHash = normalizeWagerTxHash(params.doubleWagerTxHash)
    validateRuntimeGameRecord(params.record, gameId)
    return this.serializeMutation(async () => {
      const existing = this.games.get(gameId)
      const record = params.record
      if (
        !existing ||
        existing.authority !== 'verified-wager-sender' ||
        existing.revealed ||
        existing.doubled ||
        existing.dealtCount !== MIN_DEALT_COUNT ||
        !record.doubled ||
        record.doubleWagerWei === undefined ||
        existing.serverSeed !== record.serverSeed ||
        existing.wagerTxHash !== record.wagerTxHash ||
        existing.wagerWei !== record.wagerWei ||
        existing.playerAddress !== record.playerAddress ||
        record.dealtCount !== existing.dealtCount + 1
      ) {
        return { ok: false as const, reason: 'game_state_changed' as const }
      }
      if (this.wagerClaims.has(doubleWagerTxHash)) {
        return { ok: false as const, reason: 'wager_claimed' as const }
      }
      await (this.db as any).batch([
        rawPut(
          WAGER_CLAIM_PREFIX + doubleWagerTxHash,
          JSON.stringify({ gameId }),
        ),
        rawPut(GAME_PREFIX + gameId, serializeGameRecord(record)),
      ])
      this.wagerClaims.set(doubleWagerTxHash, gameId)
      this.games.set(gameId, freezeGameRecord(record))
      return { ok: true as const }
    })
  }

  /** Sum of the worst-case payouts owed on unresolved games (2.5x an undoubled stake, 2x a
   * doubled one), optionally excluding one game, plus resolved-but-unconfirmed payouts and pending refunds. Used for the bankroll check. */
  openExposureWei(excludeGameId?: string): bigint {
    let total = 0n
    for (const [gameId, game] of this.games) {
      if (gameId === excludeGameId) continue
      // A resolved game still owes its winner until a receipt shows the payout succeeded.
      if (
        game.authority === 'verified-wager-sender' &&
        game.payout &&
        game.payout.status !== 'confirmed'
      ) {
        total += game.payout.amountWei
        continue
      }
      if (game.authority !== 'verified-wager-sender' || game.revealed) continue
      total += game.doubled
        ? 2n * (game.wagerWei + (game.doubleWagerWei ?? 0n))
        : (2500n * game.wagerWei) / 1000n
    }
    // Queued refunds are debts against the same balance.
    for (const refund of this.refunds.values()) {
      if (refund.status === 'pending') total += refund.amountWei
    }
    return total
  }

  getRefund(txHash: string): RefundRecord | undefined {
    return this.refunds.get(normalizeWagerTxHash(txHash))
  }

  getPendingRefunds(): Array<[string, RefundRecord]> {
    return [...this.refunds].filter(([, r]) => r.status === 'pending')
  }

  /** Consumes `txHash` in the global claim keyspace and records a pending refund, atomically.
   * Fails (no refund owed) if the hash is already claimed by a game or an earlier refund. */
  async claimRefund(params: {
    txHash: string
    playerAddress: string
    amountWei: bigint
  }): Promise<{ ok: true } | { ok: false; reason: 'already_claimed' }> {
    const txHash = normalizeWagerTxHash(params.txHash)
    const playerAddress = normalizePlayerAddress(params.playerAddress)
    if (params.amountWei <= 0n || params.amountWei > MAX_WAGER_WEI) {
      throw new Error('refund amount must be positive')
    }
    return this.serializeMutation(async () => {
      if (this.wagerClaims.has(txHash)) {
        return { ok: false as const, reason: 'already_claimed' as const }
      }
      const record: RefundRecord = {
        status: 'pending',
        playerAddress,
        amountWei: params.amountWei,
      }
      await this.db.put(
        encodeUtf8(WAGER_CLAIM_PREFIX + txHash) as never,
        encodeUtf8(serializeRefund(record)) as never,
      )
      this.wagerClaims.set(txHash, null)
      this.refunds.set(txHash, record)
      return { ok: true as const }
    })
  }

  async setRefundStatus(
    txHash: string,
    status: RefundRecord['status'],
    refundTxHash?: string,
  ): Promise<void> {
    const hash = normalizeWagerTxHash(txHash)
    await this.serializeMutation(async () => {
      const existing = this.refunds.get(hash)
      if (!existing) throw new Error('no refund claim for this transaction')
      if (existing.status === 'sent') return
      const record: RefundRecord = { ...existing, status, refundTxHash }
      await this.db.put(
        encodeUtf8(WAGER_CLAIM_PREFIX + hash) as never,
        encodeUtf8(serializeRefund(record)) as never,
      )
      this.refunds.set(hash, record)
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
  'doubled',
  'doubleWagerWei',
  'payout',
  'playerAddress',
  'revealed',
  'serverSeed',
  'serverSeedHash',
  'wagerTxHash',
  'wagerWei',
] as const

// Rows written before payouts were journaled (but after double-down) have no `payout` key. They
// load unchanged with no payout recorded; the next write upgrades them to the current shape.
const PRE_PAYOUT_GAME_KEYS = CURRENT_GAME_KEYS.filter((key) => key !== 'payout')

// Rows written before double-down existed have every current key except the two new ones. Kept as
// its own named variant (rather than folded into "invalid") so those rows keep loading as
// `doubled: false` instead of getting quarantined the first time this ships.
const PRE_DOUBLE_GAME_KEYS = CURRENT_GAME_KEYS.filter(
  (key) => key !== 'doubled' && key !== 'doubleWagerWei' && key !== 'payout',
)
const LEGACY_GAME_KEYS = PRE_DOUBLE_GAME_KEYS.filter((key) => key !== 'authority')

function hydratePersistedGameRecord(
  parsed: Record<string, unknown>,
  gameId: string,
): BlackjackGameRecord {
  const hasPayoutKey = hasExactKeys(parsed, CURRENT_GAME_KEYS)
  const isCurrent = hasPayoutKey || hasExactKeys(parsed, PRE_PAYOUT_GAME_KEYS)
  const isPreDouble = hasExactKeys(parsed, PRE_DOUBLE_GAME_KEYS)
  const isLegacy = hasExactKeys(parsed, LEGACY_GAME_KEYS)
  if (!isCurrent && !isPreDouble && !isLegacy) {
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
  let doubled = false
  let doubleWagerWei: bigint | undefined
  if (isCurrent) {
    if (typeof parsed.doubled !== 'boolean') {
      throw new Error(`game ${gameId} has invalid doubled flag`)
    }
    doubled = parsed.doubled
    if (parsed.doubleWagerWei !== null) {
      if (
        typeof parsed.doubleWagerWei !== 'string' ||
        parsed.doubleWagerWei.length > MAX_WAGER_WEI.toString().length ||
        !/^(0|[1-9][0-9]*)$/.test(parsed.doubleWagerWei)
      ) {
        throw new Error(`game ${gameId} has invalid double wager amount`)
      }
      doubleWagerWei = BigInt(parsed.doubleWagerWei)
    }
    if (doubleWagerWei !== undefined && !doubled) {
      throw new Error(`game ${gameId} has a double wager without being doubled`)
    }
  }
  const payout = hasPayoutKey ? parsePersistedPayout(parsed.payout, gameId) : undefined
  const record: BlackjackGameRecord = {
    authority,
    serverSeed: parsed.serverSeed,
    serverSeedHash: parsed.serverSeedHash,
    wagerTxHash: parsed.wagerTxHash,
    wagerWei,
    playerAddress: parsed.playerAddress,
    dealtCount: parsed.dealtCount,
    revealed: authority === 'legacy-unverified' ? true : parsed.revealed,
    doubled,
    doubleWagerWei,
    ...(payout ? { payout } : {}),
  }
  validateRuntimeGameRecord(record, gameId)
  return record
}

function validateRuntimeGameRecord(
  record: BlackjackGameRecord,
  gameId: string,
): void {
  if (
    !isPlainObject(record) ||
    !(
      hasExactKeys(record, CURRENT_GAME_KEYS) ||
      hasExactKeys(record, PRE_PAYOUT_GAME_KEYS)
    )
  ) {
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
  if (typeof record.doubled !== 'boolean') {
    throw new Error(`game ${gameId} has invalid doubled flag`)
  }
  if (record.payout !== undefined) {
    const p = record.payout
    if (
      !isPlainObject(p as never) ||
      typeof p.amountWei !== 'bigint' ||
      p.amountWei <= 0n ||
      p.amountWei > MAX_WAGER_WEI ||
      !['owed', 'submitting', 'submitted', 'confirmed', 'failed'].includes(p.status)
    ) {
      throw new Error(`game ${gameId} has an invalid payout`)
    }
    if (record.authority !== 'verified-wager-sender' || !record.revealed) {
      throw new Error(`game ${gameId} has a payout without being a resolved verified game`)
    }
    const signed = p.status !== 'owed'
    if (signed !== (typeof p.rawTx === 'string' && typeof p.txHash === 'string')) {
      throw new Error(`game ${gameId} payout journal does not match its status`)
    }
  }
  if (record.doubleWagerWei !== undefined) {
    if (
      typeof record.doubleWagerWei !== 'bigint' ||
      record.doubleWagerWei < 0n ||
      record.doubleWagerWei > MAX_WAGER_WEI
    ) {
      throw new Error(`game ${gameId} has invalid double wager amount`)
    }
    if (!record.doubled) {
      throw new Error(`game ${gameId} has a double wager without being doubled`)
    }
  }
}

function samePayout(a?: PayoutRecord, b?: PayoutRecord): boolean {
  return JSON.stringify(serializePayout(a)) === JSON.stringify(serializePayout(b))
}

function serializePayout(p?: PayoutRecord): unknown {
  if (!p) return null
  return {
    status: p.status,
    amountWei: p.amountWei.toString(),
    rawTx: p.rawTx ?? null,
    txHash: p.txHash ?? null,
  }
}

function parsePersistedPayout(value: unknown, gameId: string): PayoutRecord | undefined {
  if (value === null) return undefined
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['status', 'amountWei', 'rawTx', 'txHash']) ||
    !['owed', 'submitting', 'submitted', 'confirmed', 'failed'].includes(value.status as string) ||
    typeof value.amountWei !== 'string' ||
    !/^[1-9][0-9]*$/.test(value.amountWei) ||
    value.amountWei.length > MAX_WAGER_WEI.toString().length ||
    (value.rawTx !== null && typeof value.rawTx !== 'string') ||
    (value.txHash !== null && typeof value.txHash !== 'string')
  ) {
    throw new Error(`game ${gameId} has an invalid persisted payout`)
  }
  return {
    status: value.status as PayoutRecord['status'],
    amountWei: BigInt(value.amountWei),
    ...(value.rawTx !== null ? { rawTx: value.rawTx as string } : {}),
    ...(value.txHash !== null ? { txHash: value.txHash as string } : {}),
  }
}

function serializeRefund(record: RefundRecord): string {
  return JSON.stringify({
    refund: {
      status: record.status,
      playerAddress: record.playerAddress,
      amountWei: record.amountWei.toString(),
      refundTxHash: record.refundTxHash ?? null,
    },
  })
}

function tryParseRefundClaim(value: Buffer): RefundRecord | undefined {
  const parsed = parseJsonObject(decodeUtf8Strict(value, 'claim value'), 'claim')
  if (!hasExactKeys(parsed, ['refund'])) return undefined
  const r = parsed.refund
  if (
    !isPlainObject(r) ||
    !hasExactKeys(r, ['status', 'playerAddress', 'amountWei', 'refundTxHash']) ||
    (r.status !== 'pending' && r.status !== 'submitting' && r.status !== 'sent') ||
    typeof r.playerAddress !== 'string' ||
    typeof r.amountWei !== 'string' ||
    !/^[1-9][0-9]*$/.test(r.amountWei) ||
    (r.refundTxHash !== null && typeof r.refundTxHash !== 'string')
  ) {
    throw new Error('refund claim has an invalid schema')
  }
  return {
    status: r.status,
    playerAddress: normalizePlayerAddress(r.playerAddress),
    amountWei: BigInt(r.amountWei),
    refundTxHash: r.refundTxHash ?? undefined,
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
  // JSON.stringify can't serialize a bigint directly -- stringify wagerWei/doubleWagerWei
  // explicitly rather than letting it throw (and let JSON.stringify drop an `undefined` property,
  // which JSON has no representation for -- but `null` is deliberately kept, not dropped, so a
  // round trip through `hydratePersistedGameRecord`'s `isCurrent` branch always sees the key).
  return JSON.stringify({
    ...record,
    wagerWei: record.wagerWei.toString(),
    doubleWagerWei: record.doubleWagerWei !== undefined ? record.doubleWagerWei.toString() : null,
    payout: serializePayout(record.payout),
  })
}

function freezeGameRecord(record: BlackjackGameRecord): BlackjackGameRecord {
  return Object.freeze({ ...record })
}
