/**
 * Durable state for the standalone faucet (#316): one record per funded address plus the profile
 * polling cursor, `level`-backed like the other bot state stores.
 *
 * Unlike the other bots' batched `pendingWrites`, every write here is awaited before the caller
 * proceeds: a funding record MUST be on disk before the transaction is broadcast, otherwise a crash
 * between broadcast and persist would fund the same address twice on restart. Records are never
 * deleted; a record in any state blocks re-funding that address (fail-safe against double spends).
 */
import { mkdirSync } from 'fs'
import level, { LevelDB } from 'level'
import { join } from 'path'

import { canonicalMonadEnvelopeAddress } from '@frank/cashweb/relay/monad-message-envelope'

const SINCE_PROFILES_KEY = '__since_profiles__'
const FUND_PREFIX = 'fund:'

/** signed: the exact signed transaction is persisted, broadcast not yet confirmed to have been
 * accepted (a crash or RPC error here leaves the record so the exact bytes can be replayed).
 * submitted: the node accepted it. confirmed: a successful receipt was seen. */
export type FundState = 'signed' | 'submitted' | 'confirmed'

export interface FundRecord {
  state: FundState
  amountWei: string
  /** ms since epoch when the record was created; drives the rolling daily cap. */
  at: number
  txHash: string
  rawTx: string
}

export class FaucetStateStore {
  private readonly dbLocation: string
  private openedDb?: LevelDB
  private sinceProfiles?: number
  private readonly records = new Map<string, FundRecord>()

  constructor(location: string) {
    this.dbLocation = join(location, 'faucet-state')
  }

  private get db(): LevelDB {
    if (!this.openedDb) throw new Error('No db opened')
    return this.openedDb
  }

  async Open(): Promise<void> {
    mkdirSync(this.dbLocation, { recursive: true })
    this.openedDb = level(this.dbLocation)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const [key, value] of this.db.iterator({}) as any) {
      if (key === SINCE_PROFILES_KEY) {
        this.sinceProfiles = JSON.parse(value)
      } else if (key.startsWith(FUND_PREFIX)) {
        this.records.set(
          canonicalMonadEnvelopeAddress(key.slice(FUND_PREFIX.length)),
          JSON.parse(value),
        )
      }
    }
  }

  async Close(): Promise<void> {
    await this.db.close()
  }

  getSinceProfiles(): number | undefined {
    return this.sinceProfiles
  }

  async setSinceProfiles(value: number): Promise<void> {
    await this.db.put(SINCE_PROFILES_KEY, JSON.stringify(value))
    this.sinceProfiles = value
  }

  get(address: string): FundRecord | undefined {
    return this.records.get(canonicalMonadEnvelopeAddress(address))
  }

  async put(address: string, record: FundRecord): Promise<void> {
    const key = canonicalMonadEnvelopeAddress(address)
    await this.db.put(FUND_PREFIX + key, JSON.stringify(record))
    this.records.set(key, record)
  }

  /** Records created at or after `sinceMs` (any state: a signed-but-unconfirmed transfer still
   * spends the budget). */
  countSince(sinceMs: number): number {
    let count = 0
    for (const record of this.records.values()) {
      if (record.at >= sinceMs) count++
    }
    return count
  }

  /** Addresses whose transaction is signed but not yet known-accepted, for replay. */
  signedRecords(): Array<[string, FundRecord]> {
    return [...this.records].filter(([, record]) => record.state === 'signed')
  }
}
