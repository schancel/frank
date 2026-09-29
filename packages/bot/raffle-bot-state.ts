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

import {
  canonicalMonadEnvelopeAddress,
  sameMonadEnvelopeAddress,
} from '@frank/cashweb/relay/monad-message-envelope'

const PENDING_SEED_KEY = '__pending_server_seed__'
const PENDING_SEED_HASH_KEY = '__pending_server_seed_hash__'
const ROUND_KEY = '__current_round__'
const PROCESSED_PREFIX = 'processed:'
const REFUND_PREFIX = 'pendingrefund:'

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
  /** Canonical addresses that already used their one leave this round (ticket #209: at most one
   * leave per address per round). Optional so rounds persisted before this field existed load
   * unchanged (treated as `[]`). */
  leavers?: string[]
}

/** A refund owed to someone who left a round, journaled durably so a crash can never lose it or
 * double-pay it. See `executeRefund` in `raffle-bot.livecheck.ts` for the exact ordering. */
export interface PendingRefund {
  /** Payload hash of the `leave` message; the idempotency key. */
  payloadHash: string
  recipient: string
  amountWei: string
  raffleId: string
  /** Set (together with `rawTx`) once the refund transfer has been signed and journaled, strictly
   * before it is first submitted. Absent means nothing was ever submitted. */
  txHash?: string
  rawTx?: string
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
  const canonical: RaffleRoundRecord = { ...round, entrants }
  if (round.leavers !== undefined) {
    canonical.leavers = round.leavers.map(a => canonicalMonadEnvelopeAddress(a))
  }
  return canonical
}

export function hasRaffleLeft(
  round: RaffleRoundRecord,
  address: string,
): boolean {
  return (round.leavers ?? []).some(a => sameMonadEnvelopeAddress(a, address))
}

export function hasRaffleEntrant(
  round: RaffleRoundRecord,
  address: string,
): boolean {
  return round.entrants.some(entrant =>
    sameMonadEnvelopeAddress(entrant.address, address),
  )
}

/** Pure removal, no I/O -- the caller (`raffle-bot.livecheck.ts`'s `evaluateLeaveRequest`) is
 * responsible for persisting the result via `setCurrentRound` and for the refund transfer that
 * must accompany a real leave. Preserves the relative order of every remaining entrant (join
 * order matters for `combineEntrantEntropy` -- removing one entrant must never reshuffle the
 * others' contribution to a future draw's entropy). */
export function removeRaffleEntrant(
  round: RaffleRoundRecord,
  address: string,
): RaffleRoundRecord {
  return {
    ...round,
    entrants: round.entrants.filter(
      entrant => !sameMonadEnvelopeAddress(entrant.address, address),
    ),
  }
}

export class RaffleBotStateStore {
  private readonly dbLocation: string
  private openedDb?: LevelDB
  private pendingServerSeed?: string
  private pendingServerSeedHash?: string
  private currentRound?: RaffleRoundRecord
  private processedPayloadHashes = new Set<string>()
  private pendingRefunds = new Map<string, PendingRefund>()
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
      } else if (key.startsWith(REFUND_PREFIX)) {
        const refund = JSON.parse(value) as PendingRefund
        this.pendingRefunds.set(refund.payloadHash, refund)
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

  getPendingRefunds(): PendingRefund[] {
    return [...this.pendingRefunds.values()]
  }

  /** Atomically (one level batch) persists the round without the leaver, the pending-refund
   * record, and the processed marker. Atomicity matters: a crash must never leave the entrant
   * removed without a refund record, nor a refund record while the entrant is still entered. */
  commitLeave(
    round: RaffleRoundRecord,
    refund: PendingRefund,
    payloadHashHex: string,
  ): void {
    const canonicalRound = canonicalizePersistedRound(round)
    this.currentRound = canonicalRound
    this.pendingRefunds.set(refund.payloadHash, refund)
    this.processedPayloadHashes.add(payloadHashHex)
    this.pendingWrites.push(
      this.db.batch([
        {
          type: 'put',
          key: REFUND_PREFIX + refund.payloadHash,
          value: JSON.stringify(refund),
        },
        { type: 'put', key: ROUND_KEY, value: JSON.stringify(canonicalRound) },
        { type: 'put', key: PROCESSED_PREFIX + payloadHashHex, value: '1' },
      ]),
    )
  }

  /** Journals the signed refund tx (hash + raw bytes) before it is first submitted. */
  setPendingRefundTx(payloadHash: string, txHash: string, rawTx: string): void {
    const existing = this.pendingRefunds.get(payloadHash)
    if (!existing) throw new Error(`No pending refund ${payloadHash}`)
    const updated = { ...existing, txHash, rawTx }
    this.pendingRefunds.set(payloadHash, updated)
    this.pendingWrites.push(
      this.db.put(REFUND_PREFIX + payloadHash, JSON.stringify(updated)),
    )
  }

  clearPendingRefund(payloadHash: string): void {
    this.pendingRefunds.delete(payloadHash)
    this.pendingWrites.push(this.db.del(REFUND_PREFIX + payloadHash))
  }
}
