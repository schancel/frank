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
 *   - `'available'`: idle, funded, never-before-used, and eligible to be selected for a new
 *     stamp/burn.
 *   - `'in-use'`: currently leased for an in-flight (unconfirmed) transaction. This ticket never
 *     transitions an account *into* this state — that's ticket #18's lease acquire/release logic.
 *     The field exists now purely as the hook #18 needs.
 *   - `'spent'`: the account's one-and-only transaction confirmed successfully. Terminal, like
 *     `'retired'` below — excluded from `selectForStamp()`/future selection forever — but recorded
 *     under a distinct name for bookkeeping/observability: unlike `'retired'`, a `'spent'` account's
 *     funds (minus the burn/gas actually used) were deliberately consumed as intended, not
 *     abandoned mid-flight. **Correction (ticket #34, after #14/#18/#21 shipped):** the original
 *     model routed a successful (`'confirmed'`) outcome back to `'available'` for reuse — that
 *     defeated Stamp's UTXO-style unlinkability goal (`PLAN.md` constraint 3) by letting a small
 *     fixed pool of addresses accumulate a linkable history across many messages. `'spent'` is the
 *     status that closes that hole: every used sub-account, success or failure, is now permanently
 *     excluded from reuse — see `monad-account-lease.ts`'s `releaseLease`.
 *   - `'retired'`: the account's transaction failed or got stuck (never confirmed within a
 *     timeout) — permanently skipped for future selection, same as `'spent'`, but distinguished
 *     because a `'retired'` account may still hold its funded balance un-spent (sweeping/reclaiming
 *     that leftover balance is a separate, currently-unimplemented sub-problem — see
 *     `monad-account-pool.ts`'s header for why it's out of scope here).
 */
export type SubAccountStatus = 'available' | 'in-use' | 'spent' | 'retired'

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
  /** Waits until every preceding mutation is durable. In-memory stores resolve immediately. */
  flush(): Promise<void>
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

  async flush(): Promise<void> {}

  async clear(): Promise<void> {
    this.recordsByIndex.clear()
  }
}
