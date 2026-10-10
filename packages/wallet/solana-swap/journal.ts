/**
 * The Solana wallet's journal of legacy transactions in a browser: one durable list in
 * localStorage, like the wallet's native-send attempt record. See `SolanaLegacyJournal`.
 */
import type {
  SolanaLegacyJournal,
  SolanaLegacyJournalEntry,
  SolanaSwapRecord,
} from './execute'

export const SOLANA_LEGACY_JOURNAL_KEY = 'frank:solana-legacy:v1'

/** The journal exists but cannot be read. A transaction may be pending; none may be started. */
export class SolanaLegacyJournalUnreadableError extends Error {
  constructor() {
    super('The record of a Solana transaction in progress could not be read')
    this.name = 'SolanaLegacyJournalUnreadableError'
  }
}

export class BrowserSolanaLegacyJournal implements SolanaLegacyJournal {
  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly key = SOLANA_LEGACY_JOURNAL_KEY,
  ) {}

  list(): SolanaLegacyJournalEntry[] {
    const raw = this.storage.getItem(this.key)
    if (!raw) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error('not a list')
      return parsed as SolanaLegacyJournalEntry[]
    } catch {
      throw new SolanaLegacyJournalUnreadableError()
    }
  }

  private write(entries: SolanaLegacyJournalEntry[]): void {
    // Throws when the device cannot store it; the caller then sends nothing.
    this.storage.setItem(this.key, JSON.stringify(entries))
  }

  put(record: SolanaSwapRecord): void {
    this.write([
      ...this.list().filter(
        entry => entry.record.transactionId !== record.transactionId,
      ),
      { record },
    ])
  }

  settle(transactionId: string, status: 'confirmed' | 'failed'): void {
    this.write(
      this.list().map(entry =>
        entry.record.transactionId === transactionId
          ? { ...entry, settled: status }
          : entry,
      ),
    )
  }

  remove(transactionId: string): void {
    this.write(
      this.list().filter(entry => entry.record.transactionId !== transactionId),
    )
  }
}
