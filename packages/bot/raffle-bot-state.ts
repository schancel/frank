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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const [key, value] of this.db.iterator({}) as any) {
      if (key === PENDING_SEED_KEY) {
        this.pendingServerSeed = JSON.parse(value)
      } else if (key === PENDING_SEED_HASH_KEY) {
        this.pendingServerSeedHash = JSON.parse(value)
      } else if (key === ROUND_KEY) {
        const round = JSON.parse(value) as RaffleRoundRecord
        this.currentRound = {
          ...round,
          entrants: round.entrants.map(entrant => ({
            ...entrant,
            address: canonicalMonadEnvelopeAddress(entrant.address),
          })),
        }
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
    const canonicalRound = {
      ...round,
      entrants: round.entrants.map(entrant => ({
        ...entrant,
        address: canonicalMonadEnvelopeAddress(entrant.address),
      })),
    }
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
}
