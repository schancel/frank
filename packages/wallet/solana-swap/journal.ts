/**
 * The Solana wallet's journal of legacy transactions in a browser: one durable list in
 * localStorage per account and network, like the wallet's native-send attempt record. See
 * `SolanaLegacyJournal`.
 *
 * A journal belongs to one account on one network and is stored under a key that names both,
 * so an account never sees, settles or clears another account's entries.
 */
import type {
  SolanaLegacyJournal,
  SolanaLegacyJournalEntry,
  SolanaSwapRecord,
} from './execute'

/** Storage key prefix; the network and the account's address follow it. */
export const SOLANA_LEGACY_JOURNAL_KEY = 'frank:solana-legacy:v2'

/** The journal exists but cannot be read. A transaction may be pending; none may be started. */
export class SolanaLegacyJournalUnreadableError extends Error {
  constructor() {
    super('The record of a Solana transaction in progress could not be read')
    this.name = 'SolanaLegacyJournalUnreadableError'
  }
}

export class BrowserSolanaLegacyJournal implements SolanaLegacyJournal {
  private readonly key: string

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    /** Whose transactions these are: the account's address, and the network. */
    private readonly scope: { account: string; chainIdentifier: string },
  ) {
    this.key = `${SOLANA_LEGACY_JOURNAL_KEY}:${scope.chainIdentifier}:${scope.account}`
  }

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
    if (
      record.account !== this.scope.account ||
      record.chainIdentifier !== this.scope.chainIdentifier
    ) {
      throw new Error(
        'This transaction belongs to another account or network than this journal',
      )
    }
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
