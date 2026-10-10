/**
 * LevelDB-backed Token UTXO Store (tickets #1152, #1153).
 *
 * Tracks received tokens (USDC, USDT, etc.) and native notes locally.
 * Aggregated balance calculation is computed locally from LevelDB:
 *   Balance = \sum unspent notes
 *
 * Zero external RPC calls required to view and aggregate balances.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { type LevelDB } from 'level'
import { join } from 'path'
import { normalizeChainId, normalizeTokenAddress } from './token-registry'

export type TokenUtxoStatus = 'unspent' | 'leased' | 'spent'

export interface TokenUtxoRecord {
  id: string
  chainId: string | number
  tokenAddress: string
  recipientAddress: string
  amount: bigint
  derivationIndex?: number
  status: TokenUtxoStatus
  receivedAt: number
  txHash?: string
}

const UTXO_PREFIX = 'utxo:'

export function serializeTokenUtxo(record: TokenUtxoRecord): string {
  return JSON.stringify({
    ...record,
    amount: record.amount.toString(),
  })
}

export function deserializeTokenUtxo(raw: string): TokenUtxoRecord {
  const parsed = JSON.parse(raw)
  return {
    ...parsed,
    amount: BigInt(parsed.amount),
  }
}

export class TokenUtxoStore {
  private readonly dbLocation?: string
  private openedDb?: LevelDB
  private cache = new Map<string, TokenUtxoRecord>()
  private isOpened = false

  constructor(locationOrDb?: string | LevelDB) {
    if (typeof locationOrDb === 'string') {
      this.dbLocation = join(locationOrDb, 'token-utxos')
    } else if (locationOrDb && typeof locationOrDb === 'object') {
      this.openedDb = locationOrDb
    }
  }

  get db(): LevelDB | undefined {
    return this.openedDb
  }

  async open(): Promise<void> {
    if (this.isOpened) return

    if (!this.openedDb && this.dbLocation) {
      this.openedDb = level(this.dbLocation)
    }

    if (this.openedDb) {
      // Ensure DB is open
      if (typeof (this.openedDb as any).open === 'function') {
        try {
          await this.openedDb.open()
        } catch {
          // Already open or error handled by level
        }
      }
      await this.loadData()
    }

    this.isOpened = true
  }

  async close(): Promise<void> {
    if (this.openedDb) {
      await this.openedDb.close()
    }
    this.isOpened = false
  }

  private async ensureOpen(): Promise<void> {
    if (!this.isOpened) {
      await this.open()
    }
  }

  private async loadData(): Promise<void> {
    if (!this.openedDb) return
    for await (const [key, value] of this.openedDb.iterator({}) as any) {
      if (typeof key === 'string' && key.startsWith(UTXO_PREFIX)) {
        try {
          const record = deserializeTokenUtxo(value)
          this.cache.set(record.id, record)
        } catch {
          // Ignore corrupt/unrecognized rows
        }
      }
    }
  }

  async putUtxo(record: TokenUtxoRecord): Promise<void> {
    await this.ensureOpen()
    const cloned: TokenUtxoRecord = { ...record }
    this.cache.set(cloned.id, cloned)

    if (this.openedDb) {
      await this.openedDb.put(
        `${UTXO_PREFIX}${cloned.id}`,
        serializeTokenUtxo(cloned),
      )
    }
  }

  async getUtxo(id: string): Promise<TokenUtxoRecord | undefined> {
    await this.ensureOpen()
    const cached = this.cache.get(id)
    if (cached) {
      return { ...cached }
    }

    if (this.openedDb) {
      try {
        const raw = await this.openedDb.get(`${UTXO_PREFIX}${id}`)
        if (raw) {
          const record = deserializeTokenUtxo(raw)
          this.cache.set(record.id, record)
          return { ...record }
        }
      } catch {
        return undefined
      }
    }

    return undefined
  }

  async listUnspentByToken(
    chainId: string | number,
    tokenAddress: string,
  ): Promise<TokenUtxoRecord[]> {
    await this.ensureOpen()
    const normChain = normalizeChainId(chainId)
    const normAddr = normalizeTokenAddress(tokenAddress)

    const matches: TokenUtxoRecord[] = []
    for (const record of this.cache.values()) {
      if (
        normalizeChainId(record.chainId) === normChain &&
        normalizeTokenAddress(record.tokenAddress) === normAddr &&
        record.status === 'unspent'
      ) {
        matches.push({ ...record })
      }
    }
    return matches
  }

  async getTotalBalance(
    chainId: string | number,
    tokenAddress: string,
  ): Promise<bigint> {
    const unspent = await this.listUnspentByToken(chainId, tokenAddress)
    return unspent.reduce((acc, u) => acc + u.amount, 0n)
  }

  async markSpent(id: string, txHash?: string): Promise<void> {
    await this.ensureOpen()
    const record = await this.getUtxo(id)
    if (!record) {
      throw new Error(`Token UTXO record with id "${id}" not found`)
    }

    record.status = 'spent'
    if (txHash) {
      record.txHash = txHash
    }

    await this.putUtxo(record)
  }

  async markLeased(id: string): Promise<void> {
    await this.ensureOpen()
    const record = await this.getUtxo(id)
    if (!record) {
      throw new Error(`Token UTXO record with id "${id}" not found`)
    }

    record.status = 'leased'
    await this.putUtxo(record)
  }

  async deleteUtxo(id: string): Promise<void> {
    await this.ensureOpen()
    this.cache.delete(id)
    if (this.openedDb) {
      try {
        await this.openedDb.del(`${UTXO_PREFIX}${id}`)
      } catch {
        // Ignore if key didn't exist
      }
    }
  }

  async listAll(): Promise<TokenUtxoRecord[]> {
    await this.ensureOpen()
    return Array.from(this.cache.values()).map(r => ({ ...r }))
  }
}
