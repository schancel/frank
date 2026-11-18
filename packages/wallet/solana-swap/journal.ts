/**
 * The Solana wallet's journal of legacy transactions in a browser: one durable list in
 * localStorage per account and network, like the wallet's native-send attempt record. See
 * `SolanaLegacyJournal`.
 *
 * A journal belongs to one account on one network and is stored under a key that names both,
 * so an account never sees, settles or clears another account's entries.
 */
import { runNativeTransactionExclusive } from '../chain/chain-wallet'
import type {
  SolanaLegacyJournal,
  SolanaLegacyJournalEntry,
  SolanaSwapRecord,
} from './execute'
import { SolanaSwapError } from './swap'

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

  /**
   * One read-check-write of the stored entries. Every instance over this account's journal
   * takes its turn (other tabs included: browsers coordinate them through Web Locks, the same
   * coordination the wallet's native-send record uses), and each reads the entries as the
   * previous one left them. Nothing in here waits for the network or a key.
   */
  private change<T>(
    edit: (entries: SolanaLegacyJournalEntry[]) => {
      entries?: SolanaLegacyJournalEntry[]
      result: T
    },
  ): Promise<T> {
    return runNativeTransactionExclusive(
      `solana-legacy-journal:${this.key}`,
      'single-realm',
      async () => {
        const { entries, result } = edit(this.list())
        // Throws when the device cannot store it; the caller then sends nothing.
        if (entries) this.storage.setItem(this.key, JSON.stringify(entries))
        return result
      },
    )
  }

  async put(record: SolanaSwapRecord): Promise<void> {
    if (
      record.account !== this.scope.account ||
      record.chainIdentifier !== this.scope.chainIdentifier
    ) {
      throw new Error(
        'This transaction belongs to another account or network than this journal',
      )
    }
    await this.change(entries => {
      const others = entries.filter(
        entry => entry.record.transactionId !== record.transactionId,
      )
      if (others.some(entry => !entry.settled)) {
        // Another swap of this account was recorded first (by this or another instance) and
        // may still land.
        throw new SolanaSwapError('swap-pending', 'a swap is still pending')
      }
      return { entries: [...others, { record }], result: undefined }
    })
  }

  settle(
    transactionId: string,
    status: 'confirmed' | 'failed',
  ): Promise<boolean> {
    return this.change(entries => {
      const entry = entries.find(
        candidate => candidate.record.transactionId === transactionId,
      )
      if (!entry || entry.settled) return { result: false }
      return {
        entries: entries.map(candidate =>
          candidate === entry ? { ...candidate, settled: status } : candidate,
        ),
        result: true,
      }
    })
  }

  async remove(transactionId: string): Promise<void> {
    await this.change(entries => ({
      entries: entries.filter(
        entry => entry.record.transactionId !== transactionId,
      ),
      result: undefined,
    }))
  }
}
