/**
 * Storage interface for the Monad HD sub-account pool (ticket #14), following the pattern of the
 * existing `UtxoStore` (`./storage.ts`) — a small persistence boundary the pool depends on so its
 * state survives app restarts, with a concrete `level`-backed implementation
 * (`./level-sub-account-pool-store.ts`) mirroring `LevelUtxoStore`.
 *
 * This is deliberately a *new*, separate interface from `UtxoStore` (per ticket #14's acceptance
 * criteria) rather than a reuse of it — the two stores persist unrelated shapes (UTXO
 * outpoints/values vs. sub-account index/address/status) and have no reason to share a contract.
 *
 * What's persisted, and what isn't: only `SubAccountRecord` (`index`, `address`, `status`) is ever
 * written here. Private keys are never persisted by this store or anything in
 * `monad-account-pool.ts` — they're cheaply and deterministically re-derived from the root secret
 * + index on demand via `MonadHdKeyring` (see that file's header). This keeps the on-disk pool
 * state safe to inspect/back up without it also being a wallet-draining secret.
 */

/**
 * A sub-account's lifecycle state within the pool.
 *   - `'available'`: idle, eligible to be selected for a new stamp/burn.
 *   - `'in-use'`: currently leased for an in-flight (unconfirmed) transaction. This ticket never
 *     transitions an account *into* this state — that's ticket #18's lease acquire/release logic.
 *     The field exists now purely as the hook #18 needs.
 *   - `'retired'`: permanently skipped for future selection (e.g. after a stuck-nonce recovery).
 *     Also not populated by this ticket — see ticket #18 — but modeled here per the acceptance
 *     criteria so the data model is ready for it.
 */
export type SubAccountStatus = 'available' | 'in-use' | 'retired'

/** Persisted state for one HD-derived sub-account. Never carries a private key — see file header.
 */
export interface SubAccountRecord {
  /** BIP-44 index (`m/44'/60'/0'/0/{index}`); the durable identity of this sub-account. */
  index: number
  address: string
  status: SubAccountStatus
}

/**
 * Persistence boundary for `MonadSubAccountPool`'s state. Concrete implementations: an in-memory
 * one (`InMemorySubAccountPoolStore`, below — used in tests and as a lightweight default) and a
 * `level`-backed one (`LevelSubAccountPoolStore`, in `./level-sub-account-pool-store.ts`) for real
 * persistence across app restarts, mirroring `UtxoStore`/`LevelUtxoStore`.
 */
export interface SubAccountPoolStore {
  getByIndex(index: number): SubAccountRecord | undefined
  put(record: SubAccountRecord): void
  getAll(): SubAccountRecord[]
  clear(): Promise<void>
}

/** Simple in-memory `SubAccountPoolStore`. Does not survive app restarts on its own — useful for
 * tests, and as a default before a persisted store is wired up. */
export class InMemorySubAccountPoolStore implements SubAccountPoolStore {
  private readonly recordsByIndex = new Map<number, SubAccountRecord>()

  getByIndex(index: number): SubAccountRecord | undefined {
    return this.recordsByIndex.get(index)
  }

  put(record: SubAccountRecord): void {
    this.recordsByIndex.set(record.index, { ...record })
  }

  getAll(): SubAccountRecord[] {
    return Array.from(this.recordsByIndex.values()).sort(
      (a, b) => a.index - b.index,
    )
  }

  async clear(): Promise<void> {
    this.recordsByIndex.clear()
  }
}
