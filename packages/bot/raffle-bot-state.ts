/**
 * Persisted state for `raffle-bot.livecheck.ts`, mirroring `blackjack-bot-state.ts`'s established
 * `level`-backed pattern (itself mirroring `qwen-bot-state.ts`).
 *
 * Two kinds of state, both essential to the fairness scheme (`@frank/wallet/message-item-plugins/raffle/draw.ts`'s
 * header):
 *
 * - **The pending commitment** (`pendingServerSeed`/`pendingServerSeedHash`): at any moment this is
 *   the *currently open* round's real draw secret and its published hash -- generated before that
 *   round's first entry was ever accepted. Persisting this is what makes the fairness property
 *   survive a restart -- without it, a restart mid-round would force generating a brand new seed
 *   *after* already having seen some of this round's entrants, exactly the ordering violation the
 *   whole scheme exists to prevent. The moment a round draws, a fresh commitment is generated
 *   immediately for the *next* round, before it can have any entrants either.
 * - **The current round record** (`currentRound`): raffleId, the round's fixed config
 *   (`entryPriceWei`/`maxEntries`), its public `serverSeedHash` (== `pendingServerSeedHash` at the
 *   time it opened), and every entrant accepted so far (address + their own entry-payment tx hash,
 *   in join order). Restart-safe: a restart mid-round picks the same round back up with the same
 *   entrants rather than losing track of who already paid.
 */
import { mkdirSync } from 'fs'
import level, { LevelDB } from 'level'
import { join } from 'path'

import { RaffleItem } from '@frank/cashweb/types/messages'
import {
  canonicalMonadEnvelopeAddress,
  sameMonadEnvelopeAddress,
} from '@frank/cashweb/relay/monad-message-envelope'

const PENDING_SEED_KEY = '__pending_server_seed__'
const PENDING_SEED_HASH_KEY = '__pending_server_seed_hash__'
const ROUND_KEY = '__current_round__'
const PROCESSED_PREFIX = 'processed:'
const DRAW_PREFIX = 'draw:'
const TOPUP_LEDGER_KEY = '__topup_ledger__'
const CARRIED_DUST_KEY = '__carried_dust_entrants__'
const DAY_MS = 24 * 60 * 60 * 1000

/** A full round that has been drawn and is being settled (#363). It is written, together with the
 * fresh next round and commitment, BEFORE anything is broadcast or announced, so a crash at any
 * later step resumes from this record and never loses the round.
 *
 * - `awaiting-funds`: no payout tx exists yet (the pot is not yet available, or funding is being
 *   retried). Safe to re-evaluate any number of times.
 * - `signed`: `payout` holds the exact signed bytes, persisted before the first broadcast. Every
 *   retry re-broadcasts THESE bytes (same nonce, same hash), so it can never pay twice.
 * - `paid`: the payout tx is confirmed by hash; the draw may now be announced (the seed revealed).
 *   `announcedTo` records who already received it so a restart does not re-send. */
export interface RaffleDrawRecord {
  seq: number
  raffleId: string
  /** The exact `draw` item that will be announced (carries the seed only in this record; it is
   * revealed to entrants only once `phase` is `paid`). */
  drawItem: RaffleItem & { winnerAddress: string; potWei: string }
  phase: 'awaiting-funds' | 'signed' | 'paid'
  /** The latest signed payout. `previous` are earlier fee-bumped attempts at the SAME nonce (at
   * most one of them can ever mine); all are reconciled by hash, and their bytes stay available to
   * re-broadcast if the newest is rejected. */
  payout?: {
    rawTx: string
    txHash: string
    signedAtMs: number
    /** When the newest replacement was signed (drives the next re-price wait). */
    repricedAtMs?: number
    previous: Array<{ rawTx: string; txHash: string }>
  }
  /** An operator top-up whose signed bytes were persisted before broadcast; checked by hash before
   * any further top-up so a crash cannot cause a second one while the first sits unmined. */
  pendingTopUp?: {
    rawTx: string
    txHash: string
    amountWei: string
    signedAtMs: number
  }
  announcedTo: string[]
  /** Cumulative operator top-up spent on this round (capped per round, persisted so a restart
   * cannot top up again beyond the cap). */
  topUpWei?: string
}

/** LevelDB write option for records whose loss could lose signed bytes that were already
 * broadcast, or forget a top-up: fsync before the promise resolves. */
const SYNC = { sync: true }

export interface RaffleEntrant {
  address: string
  txHash: string
}

export interface RaffleRoundRecord {
  raffleId: string
  entryPriceWei: string
  maxEntries: number
  serverSeedHash: string
  entrants: RaffleEntrant[]
}

export class RaffleEntrantIdentityCollisionError extends Error {
  constructor(address: string) {
    super(
      `Persisted raffle round contains duplicate EVM identity after canonicalization: ${address}`,
    )
    this.name = 'RaffleEntrantIdentityCollisionError'
  }
}

function canonicalizePersistedRound(
  round: RaffleRoundRecord,
): RaffleRoundRecord {
  const identities = new Set<string>()
  const entrants = round.entrants.map(entrant => {
    const address = canonicalMonadEnvelopeAddress(entrant.address)
    if (identities.has(address)) {
      // Both entries may represent real paid entropy. Silently dropping either would alter the
      // committed draw, so startup must stop before this round can be mutated or drawn.
      throw new RaffleEntrantIdentityCollisionError(address)
    }
    identities.add(address)
    return { ...entrant, address }
  })
  return { ...round, entrants }
}

export function hasRaffleEntrant(
  round: RaffleRoundRecord,
  address: string,
): boolean {
  return round.entrants.some(entrant =>
    sameMonadEnvelopeAddress(entrant.address, address),
  )
}

export class RaffleBotStateStore {
  private readonly dbLocation: string
  private openedDb?: LevelDB
  private pendingServerSeed?: string
  private pendingServerSeedHash?: string
  private currentRound?: RaffleRoundRecord
  private processedPayloadHashes = new Set<string>()
  private draws = new Map<string, RaffleDrawRecord>()
  private topUps: Array<{ atMs: number; wei: string }> = []
  private carriedDustEntrants = 0
  private pendingWrites: Promise<unknown>[] = []

  constructor(location: string) {
    this.dbLocation = join(location, 'raffle-bot-state')
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
    let migratedRound: RaffleRoundRecord | undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const [key, value] of this.db.iterator({}) as any) {
      if (key === PENDING_SEED_KEY) {
        this.pendingServerSeed = JSON.parse(value)
      } else if (key === PENDING_SEED_HASH_KEY) {
        this.pendingServerSeedHash = JSON.parse(value)
      } else if (key === ROUND_KEY) {
        const round = JSON.parse(value) as RaffleRoundRecord
        migratedRound = canonicalizePersistedRound(round)
        this.currentRound = migratedRound
      } else if (key === CARRIED_DUST_KEY) {
        this.carriedDustEntrants = JSON.parse(value)
      } else if (key === TOPUP_LEDGER_KEY) {
        this.topUps = JSON.parse(value)
      } else if (key.startsWith(DRAW_PREFIX)) {
        const draw = JSON.parse(value) as RaffleDrawRecord
        this.draws.set(draw.raffleId, draw)
      } else if (key.startsWith(PROCESSED_PREFIX)) {
        this.processedPayloadHashes.add(key.slice(PROCESSED_PREFIX.length))
      }
    }
    if (migratedRound !== undefined) {
      // Persist the canonical representation only after the whole raw record passed collision
      // validation. Repeating this on later opens writes the same bytes, making migration
      // idempotent without changing entrant order or entropy.
      await this.db.put(ROUND_KEY, JSON.stringify(migratedRound))
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

  getPendingCommitment():
    | { serverSeed: string; serverSeedHash: string }
    | undefined {
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

  getCurrentRound(): RaffleRoundRecord | undefined {
    return this.currentRound
  }

  setCurrentRound(round: RaffleRoundRecord): void {
    const canonicalRound = canonicalizePersistedRound(round)
    this.currentRound = canonicalRound
    this.pendingWrites.push(
      this.db.put(ROUND_KEY, JSON.stringify(canonicalRound)),
    )
  }

  hasProcessed(payloadHashHex: string): boolean {
    return this.processedPayloadHashes.has(payloadHashHex)
  }

  addProcessed(payloadHashHex: string): void {
    this.processedPayloadHashes.add(payloadHashHex)
    this.pendingWrites.push(this.db.put(PROCESSED_PREFIX + payloadHashHex, '1'))
  }

  /** Unsettled draws, oldest first. Settled in this order so payouts from the identity keep a
   * single, sequential nonce. */
  getDraws(): RaffleDrawRecord[] {
    return [...this.draws.values()].sort((a, b) => a.seq - b.seq)
  }

  /** Atomically (one batch, awaited): records the draw, rotates to `nextRound`, and installs the
   * fresh commitment. After this resolves the full round can never be lost or drawn again, and new
   * entries go to a round with a new commitment made before it had any entrants. */
  async beginDraw(params: {
    draw: Omit<RaffleDrawRecord, 'seq'>
    nextRound: RaffleRoundRecord
    nextCommitment: { serverSeed: string; serverSeedHash: string }
  }): Promise<RaffleDrawRecord> {
    await this.flush()
    const seq = Math.max(0, ...[...this.draws.values()].map(d => d.seq)) + 1
    const draw: RaffleDrawRecord = { ...params.draw, seq }
    await this.db
      .batch()
      .put(DRAW_PREFIX + draw.raffleId, JSON.stringify(draw))
      .put(ROUND_KEY, JSON.stringify(params.nextRound))
      .put(PENDING_SEED_KEY, JSON.stringify(params.nextCommitment.serverSeed))
      .put(
        PENDING_SEED_HASH_KEY,
        JSON.stringify(params.nextCommitment.serverSeedHash),
      )
      .write(SYNC)
    this.draws.set(draw.raffleId, draw)
    this.currentRound = params.nextRound
    this.pendingServerSeed = params.nextCommitment.serverSeed
    this.pendingServerSeedHash = params.nextCommitment.serverSeedHash
    return draw
  }

  /** Durably replaces a draw record (awaited, so callers can rely on it before their next step). */
  async putDraw(draw: RaffleDrawRecord): Promise<void> {
    await this.db.put(DRAW_PREFIX + draw.raffleId, JSON.stringify(draw), SYNC)
    this.draws.set(draw.raffleId, draw)
  }

  async removeDraw(raffleId: string): Promise<void> {
    await this.db.del(DRAW_PREFIX + raffleId, SYNC)
    this.draws.delete(raffleId)
  }

  /** Operator top-ups made in the trailing 24 hours (persisted; drives the per-day ceiling). */
  topUpTotalSince(nowMs: number): bigint {
    return this.topUps
      .filter(t => t.atMs > nowMs - DAY_MS)
      .reduce((sum, t) => sum + BigInt(t.wei), 0n)
  }

  async recordTopUp(nowMs: number, wei: bigint): Promise<void> {
    const kept = this.topUps.filter(t => t.atMs > nowMs - 2 * DAY_MS)
    kept.push({ atMs: nowMs, wei: wei.toString() })
    await this.db.put(TOPUP_LEDGER_KEY, JSON.stringify(kept), SYNC)
    this.topUps = kept
  }

  /** Entrants of already-paid rounds whose sweep-gas deficit was absorbed by the identity's other
   * funds instead of an operator top-up: a later round's shortfall legitimately includes it. */
  getCarriedDustEntrants(): number {
    return this.carriedDustEntrants
  }

  async setCarriedDustEntrants(n: number): Promise<void> {
    await this.db.put(CARRIED_DUST_KEY, JSON.stringify(n), SYNC)
    this.carriedDustEntrants = n
  }
}
