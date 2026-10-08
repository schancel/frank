/**
 * HD sub-account pool + fan-out funding for Monad (ticket #14).
 *
 * Implements `PLAN.md`'s M5/constraint-3 privacy pool: instead of one hot wallet address
 * accumulating a linkable on-chain history across every stamp payment or broadcast, we derive independent
 * `m/44'/60'/0'/0/i` sub-account EOAs (`./monad-hd-keyring.ts`) from a single root secret, fund
 * each one from a main account (`fanOutFundSubAccounts`, below), and hand out each one exactly
 * once (`MonadSubAccountPool.selectForStamp`) — never reusing an address, like a UTXO.
 *
 * **Correction (ticket #34, after #14/#18/#21 shipped):** this pool originally operated over a
 * fixed size fixed once at startup (`ensureSize(N)`), on the (incorrect) assumption that
 * `SubAccountLeaseManager.releaseLease` (#18) would keep cycling accounts back to `'available'`
 * for reuse — see that file's header. Now that a used account is permanently `'spent'`/`'retired'`
 * (never `'available'` again), a fixed-size pool would eventually run out and dead-end every future
 * stamp. Two additions fix that:
 *
 *   - **Indefinite growth**: `nextFreshIndex()`/`topUpPool()` derive indices beyond whatever
 *     `ensureSize()` was first called with, growing the pool for as long as accounts keep getting
 *     spent. `MonadHdKeyring.deriveSubAccount(index)` already supports arbitrary, ever-increasing
 *     indices on demand (it has no fixed range) — nothing there needed to change.
 *   - **Look-ahead funding buffer**: `topUpPool()` tops the pool's count of `'available'`
 *     (funded, unused) records back up to a target buffer size, deriving+funding only the
 *     shortfall. It's exposed as an explicit, separately-callable async method rather than being
 *     invoked automatically from inside `selectForStamp()`, for one concrete reason:
 *     `selectForStamp()` is called synchronously today, from `SubAccountLeaseManager.acquireLease()`
 *     (itself called synchronously by `MonadStampClient.submitStampedMessage`, #13) — funding is
 *     unavoidably async (it submits real transactions via `fanOutFundSubAccounts`), so it can't run
 *     inside that synchronous call chain without restructuring callers this ticket doesn't own.
 *     Ticket #79 wires production DMs through `prepareStampInventory()` only after the user presses
 *     Send. `topUpPool()` remains an explicit API for non-DM callers; neither path moves funds merely
 *     because a wallet was opened.
 *
 *     Buffer size is a caller-supplied `bufferSize` (default `DEFAULT_TOPUP_BUFFER_SIZE = 5`,
 *     below). Tradeoff: a bigger buffer means fewer, larger fan-out batches — cheaper in aggregate
 *     (fewer separate top-up transactions' worth of gas overhead) and less exposed to "just missed
 *     the buffer" stalls — but each fan-out batch is itself the correlation point `PLAN.md`
 *     constraint 3 already flags (funding N sub-accounts from one main account in a short window
 *     visibly links them as a same-origin batch on-chain): a bigger buffer means each such reveal
 *     links a bigger batch together at once. A smaller buffer tops up more often with smaller,
 *     less-linking batches, at the cost of more total top-up transactions and a higher chance of
 *     transient exhaustion under bursty demand. `5` is a reasonable, easily-overridden default for
 *     this hackathon's scale — solving the fan-out-as-correlation-point problem itself is an
 *     explicit non-goal (below), not attempted here beyond not making batches gratuitously large.
 *
 * Explicitly out of scope here (ticket #18's job — see that ticket and `PLAN.md`'s M5 nonce-race
 * section): the `'available' -> 'in-use'` lease acquire/release transition itself, and stuck-nonce
 * detection/retirement (`'in-use'`/`'spent'`/`'retired'` transitions). This module only derives
 * accounts, persists their `{ index, address, status }` records, funds them, and picks the next
 * `'available'` one for a caller to use — it never mutates a record's status to `'in-use'`,
 * `'spent'`, or `'retired'` on its own. The funding paths write `'available'` only after a
 * successful receipt. That keeps the state model (`SubAccountRecord`,
 * `SubAccountPoolStore`) ready for #18's lease logic to build on top of.
 *
 * Also explicitly out of scope, per the ticket's own non-goals and `PLAN.md` constraint 3: solving
 * the fan-out transactions themselves being a correlation point (funding N sub-accounts from one
 * main account is visible on-chain as a fan-out from a single origin) — flagged, not solved, here.
 * Likewise out of scope (ticket #34 non-goal): sweeping/reclaiming any leftover balance sitting on a
 * `'retired'` (failed/stuck) account — not attempted here.
 */
import { Provider, Transaction, getAddress } from "ethers";

import { MonadHdKeyring } from "./monad-hd-keyring";
import {
  MonadAccountTxSigner,
  MonadTxOverrides,
  MonadTxSubmitter,
  SignedMonadTx,
} from "./monad-account-tx";
import {
  InMemorySubAccountPoolStore,
  assertSubAccountStatusTransition,
  SubAccountPoolStore,
  SubAccountRecoveryDisposition,
  SubAccountRecord,
  SubAccountStatus,
  SubAccountTransactionCheckpoint,
  TerminalSubAccountCheckpoint,
} from "./storage/sub-account-pool-storage";
import type { MonadWalletOperationAdmission } from "./storage/monad-wallet-bundle";
import { selectStampAccounts } from "./monad-stamp-account-selection";

export type {
  SubAccountPoolStore,
  SubAccountRecoveryDisposition,
  SubAccountRecord,
  SubAccountStatus,
  TerminalSubAccountCheckpoint,
} from "./storage/sub-account-pool-storage";

/** Default target number of pre-funded, unused (`'available'`) sub-accounts `topUpPool()` tries to
 * maintain ahead of demand when the caller doesn't specify its own `bufferSize` — see this file's
 * header ("Look-ahead funding buffer") for the tradeoff this default balances. */
export const DEFAULT_TOPUP_BUFFER_SIZE = 5;

export const DEFAULT_MIN_AVAILABLE_CAPACITY_COUNT = 2;
export const CAPACITY_CACHE_TTL_MS = 30_000;

export interface SubAccountCapacityCacheEntry {
  capacityWei: bigint;
  checkedAtMs: number;
}

export interface EnsureMinimumCapacityParams {
  mainAccountSigner: MonadAccountTxSigner;
  provider: Provider;
  minCount?: number;
  stampValueWei?: bigint;
  gasReserveWei?: bigint;
  overrides?: MonadTxOverrides;
}

export type StampInventoryPreparationProgress =
  | { stage: "checking" }
  | {
      stage: "funding";
      completed: number;
      total: number;
      feeReserveWei: bigint;
      txHash?: string;
    }
  | { stage: "ready"; fundingTxHashes: string[] };

export interface StampInventoryPreparationResult {
  fundingTxHashes: string[];
  selectedAccountCount: number;
}

export interface BurnAccountPreparationResult {
  /** Pool index of the receipt-confirmed account to lease for the burn. */
  index: number;
  fundingTxHashes: string[];
}

export interface FundingReceiptOptions {
  intervalMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * @deprecated Use `MonadAddressInventory` (`./monad-address-inventory.ts`, Ticket #924), which
 * unifies spend and change addresses under a single dynamic inventory without rigid promotion
 * state machines or separate pool boundaries.
 *
 * Tracks an ever-growing pool of HD-derived sub-accounts, persisted via a `SubAccountPoolStore` so
 * the pool (its records and each account's status) survives app restarts. Private keys are never
 * held or persisted by the pool itself — `getSigner()` re-derives one on demand from the keyring.
 */
export class MonadSubAccountPool {
  private readonly keyring: MonadHdKeyring;
  private readonly store: SubAccountPoolStore;
  /** Absolute sub-account index most recently returned by `selectForStamp()` (or `-1` before the
   * first call), so rotation resumes from where it left off rather than restarting at 0 — see
   * `selectForStamp()`. Intentionally in-memory only/not persisted: losing rotation position
   * across a restart just means the round-robin order restarts, which affects fairness, not
   * correctness (an account is never selected while unavailable). */
  private lastSelectedIndex = -1;
  /** Serializes main-account funding so concurrent Sends cannot sign the same pending nonce. */
  private preparationQueue: Promise<void> = Promise.resolve();
  private readonly requireStampReconciliationPreflight: boolean;
  private stampPreparationAuthorized = false;
  private compactionCursor = -1;
  readonly capacityCache = new Map<number, SubAccountCapacityCacheEntry>();
  private activeWarmingPromise?: Promise<void>;
  private proactiveWarmingConfig?: EnsureMinimumCapacityParams;
  private walletOperationGate?: <T>(
    operation: (admission: MonadWalletOperationAdmission) => Promise<T>,
    admission?: MonadWalletOperationAdmission
  ) => Promise<T>;

  constructor(params: {
    keyring: MonadHdKeyring;
    store?: SubAccountPoolStore;
    requireStampReconciliationPreflight?: boolean;
  }) {
    this.keyring = params.keyring;
    this.store = params.store ?? new InMemorySubAccountPoolStore();
    this.requireStampReconciliationPreflight =
      params.requireStampReconciliationPreflight ?? false;
  }

  /** Bundle-owned lifecycle gate. Persistence factories attach this before exposing the pool. */
  attachWalletOperationGate(
    gate: <T>(
      operation: (admission: MonadWalletOperationAdmission) => Promise<T>,
      admission?: MonadWalletOperationAdmission
    ) => Promise<T>
  ): void {
    if (this.walletOperationGate !== undefined) {
      throw new Error("Sub-account pool already has a wallet operation gate");
    }
    this.walletOperationGate = gate;
  }

  /**
   * Ensures the pool has at least `size` derived sub-accounts recorded in the store, deriving
   * (from the keyring, deterministically) and persisting any missing ones as `'available'`.
   * `prepareStampInventory` treats that legacy marker as untrusted and checks its chain balance
   * before selection; new funding attempts use the explicit `unfunded`/`funding` states.
   * Idempotent and safe to call on every app start with a fixed desired pool size — existing
   * records, and whatever status ticket #18's lease logic has since put them in, are left
   * untouched. Returns every record currently in the pool (not just the newly-added ones).
   */
  ensureSize(size: number): SubAccountRecord[] {
    return this.ensureSizeWithStatus(size, "available");
  }

  /** Production derivation path: records new addresses without claiming they hold funds. */
  ensureUnfundedSize(size: number): SubAccountRecord[] {
    return this.ensureSizeWithStatus(size, "unfunded");
  }

  private ensureSizeWithStatus(
    size: number,
    initialStatus: "available" | "unfunded"
  ): SubAccountRecord[] {
    if (!Number.isInteger(size) || size < 0) {
      throw new Error(`Pool size must be a non-negative integer, got ${size}`);
    }
    for (let index = 0; index < size; index++) {
      if (this.store.getByIndex(index) === undefined) {
        const derived = this.keyring.deriveSubAccount(index);
        this.store.put({
          index: derived.index,
          address: derived.address,
          status: initialStatus,
        });
      }
    }
    return this.store.getAll();
  }

  /** All sub-account records currently tracked by the pool, sorted by index. */
  records(): SubAccountRecord[] {
    return this.store.getAll();
  }

  /** Wallet-recovery boundary: applies a fully prevalidated set in one component-store batch. */
  applyPrevalidatedRecoveryRecords(records: readonly SubAccountRecord[]): void {
    this.store.putMany(records);
  }

  getRecord(index: number): SubAccountRecord | undefined {
    return this.store.getByIndex(index);
  }

  /** Persistent derivation high-water mark; unlike scanning history, this remains O(1) after
   * compaction and for long-lived wallets. */
  nextUnusedIndex(): number {
    return this.store.getNextIndex();
  }

  deriveNextUnfunded(): SubAccountRecord {
    const index = this.nextFreshIndex();
    const derived = this.keyring.deriveSubAccount(index);
    const record: SubAccountRecord = {
      index,
      address: derived.address,
      status: "unfunded",
    };
    this.store.put(record);
    return record;
  }

  /** Reconstructs a locally-missing reservation only from an exact durable attempt whose signed
   * sender has already been validated against this derived index. */
  restoreJournaledInUse(index: number): SubAccountRecord {
    const existing = this.store.getByIndex(index);
    if (existing !== undefined) return existing;
    const derived = this.keyring.deriveSubAccount(index);
    const record: SubAccountRecord = {
      index,
      address: derived.address,
      status: "in-use",
    };
    this.store.put(record);
    return record;
  }

  stageJournaledInUse(index: number): SubAccountRecord {
    const existing = this.store.getByIndex(index);
    if (existing !== undefined) return existing;
    const derived = this.keyring.deriveSubAccount(index);
    return { index, address: derived.address, status: "in-use" };
  }

  restoreTerminalEvidence(record: SubAccountRecord): void {
    if (record.status !== "spent" && record.status !== "retired") {
      throw new Error("Recovered sender evidence must be terminal");
    }
    if (
      getAddress(record.address) !==
      this.keyring.deriveSubAccount(record.index).address
    ) {
      throw new Error("Recovered sender evidence belongs to a different seed");
    }
    this.store.put(record);
  }

  /** Directly persists a status transition for sub-account `index` — the mechanism ticket #18's
   * lease/stuck-nonce logic is expected to call (`'available' -> 'in-use'`, then `-> 'spent'` or
   * `-> 'retired'`, both terminal — see `monad-account-lease.ts`). This ticket does not call it
   * itself (except from `topUpPool()`, to mark a freshly-funded index `'available'`); it exists so
   * #18 has a slot to write through without needing to touch the storage layer directly. Throws if
   * `index` isn't a known sub-account. */
  setStatus(index: number, status: SubAccountStatus): SubAccountRecord {
    const existing = this.store.getByIndex(index);
    if (existing === undefined) {
      throw new Error(`No sub-account at index ${index} in the pool`);
    }
    if (status === "funding") {
      throw new Error("Use a durable funding attempt to enter funding state");
    }
    this.capacityCache.delete(index);
    const { fundingAttempt: _fundingAttempt, ...base } = existing;
    const updated: SubAccountRecord = { ...base, status };
    this.store.put(updated);
    if (status === "spent" || status === "retired") {
      this.triggerProactiveWarming();
    }
    return updated;
  }

  /** Retains confirmed funding bytes/value after the transient funding attempt is resolved. */
  recordFundingTransaction(
    index: number,
    transaction: SubAccountTransactionCheckpoint
  ): void {
    const existing = this.store.getByIndex(index);
    if (existing === undefined) {
      throw new Error(`No sub-account at index ${index} in the pool`);
    }
    this.store.put({
      ...existing,
      lifecycle: { ...existing.lifecycle, funding: { ...transaction } },
    });
  }

  /** Retains the exact signed spend before it can become terminal/recoverable state. */
  recordSpendTransaction(
    index: number,
    transaction: SubAccountTransactionCheckpoint
  ): void {
    const existing = this.store.getByIndex(index);
    if (existing === undefined) {
      throw new Error(`No sub-account at index ${index} in the pool`);
    }
    this.capacityCache.delete(index);
    this.store.put({
      ...existing,
      lifecycle: { ...existing.lifecycle, spend: { ...transaction } },
    });
  }

  /**
   * Ingests a generic transaction sync item (Ticket #1115), recording spends and retiring
   * spent pool sub-accounts immediately to avoid multi-device desync.
   */
  processSyncTransaction(item: {
    direction: "in" | "out";
    txHash?: string;
    rawTx?: string;
    spentInputs?: ReadonlyArray<{
      address: string;
      nonce?: number;
      valueWei?: string | bigint;
    }>;
    timestamp?: number;
  }): { affectedIndices: number[] } {
    const affectedIndices: number[] = [];
    if (
      item.direction !== "out" ||
      !item.spentInputs ||
      item.spentInputs.length === 0
    ) {
      return { affectedIndices };
    }

    const spentMap = new Map<string, { valueWei?: string | bigint }>();
    for (const input of item.spentInputs) {
      spentMap.set(input.address.toLowerCase(), input);
    }

    for (const record of this.store.getAll()) {
      const input = spentMap.get(record.address.toLowerCase());
      if (input !== undefined) {
        let changed = false;
        if (!record.lifecycle?.spend && item.txHash) {
          const valueStr =
            input.valueWei !== undefined ? input.valueWei.toString() : "0";
          this.recordSpendTransaction(record.index, {
            rawTx: item.rawTx ?? "",
            txHash: item.txHash,
            valueWei: valueStr,
          });
          changed = true;
        }
        const currentRecord = this.store.getByIndex(record.index) ?? record;
        if (
          currentRecord.status !== "spent" &&
          currentRecord.status !== "retired"
        ) {
          this.setStatus(record.index, "spent");
          changed = true;
        }
        if (changed) {
          affectedIndices.push(record.index);
        }
      }
    }

    return { affectedIndices };
  }

  recordRecoveryDisposition(
    index: number,
    recovery: SubAccountRecoveryDisposition
  ): void {
    const existing = this.store.getByIndex(index);
    if (existing === undefined) {
      throw new Error(`No sub-account at index ${index} in the pool`);
    }
    this.store.put({
      ...existing,
      lifecycle: { ...existing.lifecycle, recovery: { ...recovery } },
    });
  }

  terminalCheckpoints(): TerminalSubAccountCheckpoint[] {
    return this.store.getCheckpoints();
  }

  /** Bounded compaction. A mutable row is replaced only when its complete recovery checkpoint is
   * available and no live attempt/recovery object still refers to the funding index. */
  async compactTerminalAccounts(params: {
    limit: number;
    referencedIndices?: ReadonlySet<number>;
    isReferenced?: (index: number) => boolean;
    now?: () => number;
  }): Promise<number> {
    if (!Number.isSafeInteger(params.limit) || params.limit < 0) {
      throw new Error(`Compaction limit must be a non-negative safe integer`);
    }
    // Settle all earlier row/high-water writes before issuing atomic row->checkpoint batches;
    // otherwise an older in-flight put could race the deletion and resurrect a terminal row.
    await this.store.flush();
    const referenced = params.referencedIndices ?? new Set<number>();
    let records = this.store.scanRecords(this.compactionCursor, params.limit);
    if (records.length === 0 && this.compactionCursor >= 0) {
      this.compactionCursor = -1;
      records = this.store.scanRecords(this.compactionCursor, params.limit);
    }
    let compacted = 0;
    for (const record of records) {
      this.compactionCursor = record.index;
      if (
        (record.status !== "spent" && record.status !== "retired") ||
        referenced.has(record.index) ||
        params.isReferenced?.(record.index) === true
      ) {
        continue;
      }
      const { funding, spend, recovery } = record.lifecycle ?? {};
      if (
        funding === undefined ||
        spend === undefined ||
        recovery === undefined
      ) {
        continue;
      }
      this.store.replaceWithCheckpoint({
        version: 1,
        index: record.index,
        address: record.address,
        status: record.status,
        denominationWei: spend.valueWei,
        lifecycle: { funding, spend, recovery },
        compactedAt: (params.now ?? Date.now)(),
      });
      this.capacityCache.delete(record.index);
      compacted++;
    }
    await this.store.flush();
    return compacted;
  }

  /** Waits until all pool mutations made so far have reached persistent storage. */
  async flush(): Promise<void> {
    await this.store.flush();
  }

  /**
   * Prepares receipt-confirmed, single-use sender inventory for one stamp payment. The preferred
   * two-account shape is 3/8 + 5/8: deliberately unequal and only created as account inventory,
   * never imposed later as an artificial split of a message payment. One account remains a valid
   * fallback when the value is too small or already-available inventory dictates it.
   */
  async prepareStampInventory(params: {
    mainAccountSigner: MonadAccountTxSigner;
    provider: Provider;
    stampValueWei: bigint;
    gasReserveWei: bigint;
    fundingOverrides?: MonadTxOverrides;
    onProgress?: (progress: StampInventoryPreparationProgress) => void;
    receipt?: FundingReceiptOptions;
  }): Promise<StampInventoryPreparationResult> {
    const run = this.preparationQueue.then(() =>
      this.prepareStampInventoryExclusive(params)
    );
    this.preparationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async prepareStampInventoryExclusive(params: {
    mainAccountSigner: MonadAccountTxSigner;
    provider: Provider;
    stampValueWei: bigint;
    gasReserveWei: bigint;
    fundingOverrides?: MonadTxOverrides;
    onProgress?: (progress: StampInventoryPreparationProgress) => void;
    receipt?: FundingReceiptOptions;
  }): Promise<StampInventoryPreparationResult> {
    const zero = BigInt(0);
    if (params.stampValueWei <= zero) {
      throw new Error(
        `stampValueWei must be positive, got ${params.stampValueWei}`
      );
    }
    if (params.gasReserveWei < zero) {
      throw new Error(
        `gasReserveWei must be non-negative, got ${params.gasReserveWei}`
      );
    }
    params.onProgress?.({ stage: "checking" });

    if (!this.proactiveWarmingConfig) {
      this.proactiveWarmingConfig = {
        mainAccountSigner: params.mainAccountSigner,
        provider: params.provider,
        stampValueWei: params.stampValueWei,
        gasReserveWei: params.gasReserveWei,
        overrides: params.fundingOverrides,
      };
    }

    const fundingTxHashes = await this.reconcileBeforePreparation(params);

    let accounts = await this.fundedCapacities(
      params.provider,
      params.gasReserveWei
    );
    let selection = this.selectFundedCapacity(params.stampValueWei, accounts);
    if (
      selection.length >= 2 ||
      (params.stampValueWei === BigInt(1) && selection.length === 1)
    ) {
      params.onProgress?.({ stage: "ready", fundingTxHashes });
      return {
        fundingTxHashes,
        selectedAccountCount: selection.length,
      };
    }

    const firstCapacity = (params.stampValueWei * BigInt(3)) / BigInt(8);
    const preferredFirstCapacity =
      firstCapacity > zero ? firstCapacity : BigInt(1);
    const existingCapacity = accounts.reduce(
      (total, account) => total + account.capacityWei,
      zero
    );
    let capacities =
      existingCapacity > zero
        ? [
            existingCapacity < params.stampValueWei
              ? params.stampValueWei - existingCapacity
              : preferredFirstCapacity,
          ]
        : [
            preferredFirstCapacity,
            params.stampValueWei - preferredFirstCapacity,
          ].filter((capacity) => capacity > zero);

    const unfunded = this.store
      .getAll()
      .filter((record) => record.status === "unfunded");
    while (unfunded.length < capacities.length) {
      const index = this.nextFreshIndex();
      const derived = this.keyring.deriveSubAccount(index);
      const record: SubAccountRecord = {
        index,
        address: derived.address,
        status: "unfunded",
      };
      this.store.put(record);
      unfunded.push(record);
    }
    await this.store.flush();

    const availableMainBalance = await params.provider.getBalance(
      params.mainAccountSigner.address,
      "pending"
    );
    let requiredMainBalance = await this.requiredFundingBalance({
      capacities,
      targets: unfunded,
      fromAddress: params.mainAccountSigner.address,
      gasReserveWei: params.gasReserveWei,
      provider: params.provider,
      overrides: params.fundingOverrides,
    });
    if (
      requiredMainBalance > availableMainBalance &&
      existingCapacity === zero &&
      capacities.length > 1
    ) {
      // Two unequal payment accounts are preferred, but one remains protocol-valid. If the
      // identity account cannot afford two separate funding fees, try the smallest valid batch
      // before rejecting the Send. This is an inventory fallback, not an equal split.
      const fallbackCapacities = [params.stampValueWei];
      const fallbackRequired = await this.requiredFundingBalance({
        capacities: fallbackCapacities,
        targets: unfunded,
        fromAddress: params.mainAccountSigner.address,
        gasReserveWei: params.gasReserveWei,
        provider: params.provider,
        overrides: params.fundingOverrides,
      });
      if (fallbackRequired <= availableMainBalance) {
        capacities = fallbackCapacities;
        requiredMainBalance = fallbackRequired;
      } else {
        requiredMainBalance = fallbackRequired;
      }
    }
    if (requiredMainBalance > availableMainBalance) {
      throw new Error(
        "Insufficient main account balance to prepare stamp accounts: " +
          `need up to ${requiredMainBalance} wei, have ${availableMainBalance} wei`
      );
    }

    if (capacities.length > 1) {
      let startNonce: number;
      if (params.fundingOverrides?.nonce !== undefined) {
        startNonce = params.fundingOverrides.nonce;
      } else {
        const pendingCount = await params.provider.getTransactionCount(
          params.mainAccountSigner.address,
          "pending"
        );
        startNonce = Number(pendingCount);
      }

      for (const [offset, paymentCapacityWei] of capacities.entries()) {
        const target = unfunded[offset];
        const fundedValue = paymentCapacityWei + params.gasReserveWei;
        const nonce = startNonce + offset;
        const signedTx = await params.mainAccountSigner.buildAndSignTransfer(
          target.address,
          fundedValue,
          { ...params.fundingOverrides, nonce }
        );
        this.store.put({
          ...target,
          status: "funding",
          fundingAttempt: { rawTx: signedTx.rawTx, txHash: signedTx.txHash },
        });
        await this.store.flush();
        params.onProgress?.({
          stage: "funding",
          completed: 0,
          total: capacities.length,
          feeReserveWei: params.gasReserveWei,
          txHash: signedTx.txHash,
        });
        await params.mainAccountSigner.submit(signedTx);
      }

      let completedCount = 0;
      await Promise.all(
        capacities.map(async (paymentCapacityWei, offset) => {
          const target = unfunded[offset];
          const txHash = await this.finishFundingAttempt(
            this.store.getByIndex(target.index) as SubAccountRecord,
            params.mainAccountSigner,
            params.receipt,
            false
          );
          this.capacityCache.set(target.index, {
            capacityWei: paymentCapacityWei,
            checkedAtMs: Date.now(),
          });
          fundingTxHashes.push(txHash);
          completedCount++;
          params.onProgress?.({
            stage: "funding",
            completed: completedCount,
            total: capacities.length,
            feeReserveWei: params.gasReserveWei,
            txHash,
          });
        })
      );
    } else {
      for (const [offset, paymentCapacityWei] of capacities.entries()) {
        const target = unfunded[offset];
        const result = await this.fundAccount({
          target,
          paymentCapacityWei,
          gasReserveWei: params.gasReserveWei,
          mainAccountSigner: params.mainAccountSigner,
          overrides: params.fundingOverrides,
          receipt: params.receipt,
          onSigned: (signedTx) =>
            params.onProgress?.({
              stage: "funding",
              completed: offset,
              total: capacities.length,
              feeReserveWei: params.gasReserveWei,
              txHash: signedTx.txHash,
            }),
        });
        fundingTxHashes.push(result.txHash);
        params.onProgress?.({
          stage: "funding",
          completed: offset + 1,
          total: capacities.length,
          feeReserveWei: params.gasReserveWei,
          txHash: result.txHash,
        });
      }
    }

    accounts = await this.fundedCapacities(
      params.provider,
      params.gasReserveWei
    );
    selection = this.selectFundedCapacity(params.stampValueWei, accounts);
    if (selection.length === 0) {
      throw new Error(
        "Receipt-confirmed stamp accounts do not have enough current fee-adjusted capacity"
      );
    }
    params.onProgress?.({ stage: "ready", fundingTxHashes });
    return { fundingTxHashes, selectedAccountCount: selection.length };
  }

  /**
   * Shared first step of every preparation: finish any durable in-flight funding attempt (resuming
   * the exact signed transaction, never signing a second one for the same child) and retire legacy
   * `available` records that are empty or already used. Returns the hashes of resumed attempts.
   */
  private async reconcileBeforePreparation(params: {
    mainAccountSigner: MonadAccountTxSigner;
    provider: Provider;
    gasReserveWei: bigint;
    receipt?: FundingReceiptOptions;
  }): Promise<string[]> {
    const fundingTxHashes: string[] = [];
    const allRecords = this.store.getAll();
    for (const record of allRecords) {
      if (record.status === "funding") {
        try {
          const txHash = await this.finishFundingAttempt(
            record,
            params.mainAccountSigner,
            params.receipt
          );
          fundingTxHashes.push(txHash);
        } catch (err) {
          console.warn(
            `[MonadSubAccountPool] Skipping unconfirmed/timed out funding attempt for sub-account ${record.index}:`,
            err
          );
        }
      }
    }
    const availableRecords = allRecords.filter(
      (record) => record.status === "available"
    );
    if (availableRecords.length > 0) {
      await Promise.all(
        availableRecords.map(async (record) => {
          const [balance, transactionCount] = await Promise.all([
            params.provider.getBalance(record.address),
            params.provider.getTransactionCount(record.address, "pending"),
          ]);
          if (transactionCount > 0 || balance <= params.gasReserveWei) {
            const { fundingAttempt: _fundingAttempt, ...base } = record;
            this.store.put({ ...base, status: "retired" });
            this.capacityCache.delete(record.index);
          } else {
            this.capacityCache.set(record.index, {
              capacityWei: balance - params.gasReserveWei,
              checkedAtMs: Date.now(),
            });
          }
        })
      );
    }
    await this.store.flush();
    return fundingTxHashes;
  }

  /**
   * Prepares ONE receipt-confirmed sender account able to burn exactly `burnValueWei` in a single
   * transaction (a topic post's initial vote, or a vote). Unlike a stamp payment, a topic burn has
   * no recipient and is never split, so it needs one account whose capacity covers the whole value
   * -- not the 3/8 + 5/8 inventory `prepareStampInventory` builds for direct messages (ticket
   * #273: the topic path leased from a pool nothing had funded, so every post failed with
   * "No available sub-account to lease").
   *
   * An existing `available` account is reused only when its capacity (balance minus the fee
   * reserve) covers the burn without stranding much more than the fee-quote drift: a bigger
   * account is DM inventory, and burning from it would retire the surplus. Otherwise exactly one
   * `unfunded` account is funded with `burnValueWei + gasReserveWei` through the same
   * record-before-broadcast, receipt-confirmed path as every other funding, so a retry after a
   * failure resumes or reuses that account instead of funding a second one. The caller leases the
   * returned index (`SubAccountLeaseManager.acquireForIndex`).
   */
  async prepareBurnAccount(params: {
    mainAccountSigner: MonadAccountTxSigner;
    provider: Provider;
    burnValueWei: bigint;
    gasReserveWei: bigint;
    fundingOverrides?: MonadTxOverrides;
    onProgress?: (progress: StampInventoryPreparationProgress) => void;
    receipt?: FundingReceiptOptions;
  }): Promise<BurnAccountPreparationResult> {
    const run = this.preparationQueue.then(() =>
      this.prepareBurnAccountExclusive(params)
    );
    this.preparationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async prepareBurnAccountExclusive(params: {
    mainAccountSigner: MonadAccountTxSigner;
    provider: Provider;
    burnValueWei: bigint;
    gasReserveWei: bigint;
    fundingOverrides?: MonadTxOverrides;
    onProgress?: (progress: StampInventoryPreparationProgress) => void;
    receipt?: FundingReceiptOptions;
  }): Promise<BurnAccountPreparationResult> {
    const zero = BigInt(0);
    if (params.burnValueWei <= zero) {
      throw new Error(
        `burnValueWei must be positive, got ${params.burnValueWei}`
      );
    }
    if (params.gasReserveWei < zero) {
      throw new Error(
        `gasReserveWei must be non-negative, got ${params.gasReserveWei}`
      );
    }
    params.onProgress?.({ stage: "checking" });
    const fundingTxHashes = await this.reconcileBeforePreparation(params);

    const reusable = (
      await this.fundedCapacities(params.provider, params.gasReserveWei)
    )
      .filter(
        (account) =>
          account.capacityWei >= params.burnValueWei &&
          account.capacityWei <= params.burnValueWei + params.gasReserveWei
      )
      .sort((a, b) =>
        a.capacityWei === b.capacityWei
          ? a.index - b.index
          : a.capacityWei < b.capacityWei
          ? -1
          : 1
      )[0];
    if (reusable !== undefined) {
      params.onProgress?.({ stage: "ready", fundingTxHashes });
      return { index: reusable.index, fundingTxHashes };
    }

    let target = this.store
      .getAll()
      .find((record) => record.status === "unfunded");
    if (target === undefined) {
      const index = this.nextFreshIndex();
      target = {
        index,
        address: this.keyring.deriveSubAccount(index).address,
        status: "unfunded",
      };
      this.store.put(target);
      await this.store.flush();
    }

    const availableMainBalance = await params.provider.getBalance(
      params.mainAccountSigner.address,
      "pending"
    );
    const requiredMainBalance = await this.requiredFundingBalance({
      capacities: [params.burnValueWei],
      targets: [target],
      fromAddress: params.mainAccountSigner.address,
      gasReserveWei: params.gasReserveWei,
      provider: params.provider,
      overrides: params.fundingOverrides,
    });
    if (requiredMainBalance > availableMainBalance) {
      throw new Error(
        "Insufficient main account balance to prepare a burn account: " +
          `need up to ${requiredMainBalance} wei, have ${availableMainBalance} wei`
      );
    }

    const result = await this.fundAccount({
      target,
      paymentCapacityWei: params.burnValueWei,
      gasReserveWei: params.gasReserveWei,
      mainAccountSigner: params.mainAccountSigner,
      overrides: params.fundingOverrides,
      receipt: params.receipt,
      onSigned: (signedTx) =>
        params.onProgress?.({
          stage: "funding",
          completed: 0,
          total: 1,
          feeReserveWei: params.gasReserveWei,
          txHash: signedTx.txHash,
        }),
    });
    fundingTxHashes.push(result.txHash);
    params.onProgress?.({
      stage: "funding",
      completed: 1,
      total: 1,
      feeReserveWei: params.gasReserveWei,
      txHash: result.txHash,
    });
    params.onProgress?.({ stage: "ready", fundingTxHashes });
    return { index: result.index, fundingTxHashes };
  }

  private async requiredFundingBalance(params: {
    capacities: bigint[];
    targets: Array<Pick<SubAccountRecord, "address">>;
    fromAddress: string;
    gasReserveWei: bigint;
    provider: Provider;
    overrides?: MonadTxOverrides;
  }): Promise<bigint> {
    let total = BigInt(0);
    for (const [offset, capacityWei] of params.capacities.entries()) {
      const target = params.targets[offset];
      if (target === undefined) {
        throw new Error("Missing derived target for stamp-account funding");
      }
      const fundedValue = capacityWei + params.gasReserveWei;
      const gasLimit =
        params.overrides?.gasLimit ??
        (await params.provider.estimateGas({
          from: params.fromAddress,
          to: target.address,
          value: fundedValue,
        }));
      let feePerGas =
        params.overrides?.gasPrice ?? params.overrides?.maxFeePerGas;
      if (feePerGas === undefined) {
        const feeData = await params.provider.getFeeData();
        feePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? undefined;
      }
      if (feePerGas === undefined) {
        throw new Error("Unable to quote a fee cap for stamp-account funding");
      }
      total += fundedValue + gasLimit * feePerGas;
    }
    return total;
  }

  async fundedCapacities(
    provider: Provider,
    gasReserveWei: bigint
  ): Promise<Array<{ index: number; address: string; capacityWei: bigint }>> {
    const availableRecords = this.store
      .getAll()
      .filter((record) => record.status === "available");
    if (availableRecords.length === 0) {
      return [];
    }

    const now = Date.now();
    const uncachedRecords: SubAccountRecord[] = [];

    for (const record of availableRecords) {
      const cached = this.capacityCache.get(record.index);
      if (
        cached === undefined ||
        now - cached.checkedAtMs >= CAPACITY_CACHE_TTL_MS
      ) {
        uncachedRecords.push(record);
      }
    }

    const CHUNK_SIZE = 6;
    for (let i = 0; i < uncachedRecords.length; i += CHUNK_SIZE) {
      const chunk = uncachedRecords.slice(i, i + CHUNK_SIZE);
      const balances = await Promise.all(
        chunk.map((record) => provider.getBalance(record.address))
      );
      const checkedAtMs = Date.now();
      for (let j = 0; j < chunk.length; j++) {
        const record = chunk[j];
        const balance = balances[j];
        const capacityWei =
          balance > gasReserveWei ? balance - gasReserveWei : BigInt(0);
        this.capacityCache.set(record.index, { capacityWei, checkedAtMs });
      }
    }

    const accounts: Array<{
      index: number;
      address: string;
      capacityWei: bigint;
    }> = [];
    for (const record of availableRecords) {
      const cached = this.capacityCache.get(record.index);
      accounts.push({
        index: record.index,
        address: record.address,
        capacityWei: cached !== undefined ? cached.capacityWei : BigInt(0),
      });
    }
    return accounts;
  }

  private selectFundedCapacity(
    stampValueWei: bigint,
    accounts: Array<{ index: number; address: string; capacityWei: bigint }>
  ) {
    try {
      return selectStampAccounts({ amountWei: stampValueWei, accounts });
    } catch {
      return [];
    }
  }

  private async finishFundingAttempt(
    record: SubAccountRecord,
    signer: MonadAccountTxSigner,
    options?: FundingReceiptOptions,
    resubmit = true
  ): Promise<string> {
    const attempt = record.fundingAttempt;
    if (record.status !== "funding" || attempt === undefined) {
      throw new Error(
        `Sub-account ${record.index} has no durable funding attempt`
      );
    }
    let status = await signer.getStatus(attempt.txHash);
    if (status === "pending" && resubmit) {
      // An already-known/nonce-too-low response is compatible with a prior successful broadcast;
      // the receipt, never the resend response, decides eligibility.
      await signer
        .submitRaw(attempt.rawTx, attempt.txHash)
        .catch(() => undefined);
    }
    // Monad confirms substantially faster than the two-second cadence inherited from the
    // original EVM bring-up. A Send commonly prepares two accounts, so that cadence added several
    // seconds of avoidable UI latency. Poll four times per second while retaining the same
    // one-minute default timeout budget for congested or unhealthy RPCs.
    const maxAttempts = options?.maxAttempts ?? 240;
    const intervalMs = options?.intervalMs ?? 250;
    const sleep =
      options?.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (
      let attemptNumber = 0;
      status === "pending" && attemptNumber < maxAttempts;
      attemptNumber++
    ) {
      if (attemptNumber > 0 || resubmit) await sleep(intervalMs);
      status = await signer.getStatus(attempt.txHash);
    }
    if (status === "pending") {
      let isSuperceded = false;
      try {
        const parsed = Transaction.from(attempt.rawTx);
        if (parsed.from && typeof signer.getTransactionCount === "function") {
          const currentNonce = await signer.getTransactionCount(parsed.from);
          if (currentNonce > BigInt(parsed.nonce)) {
            isSuperceded = true;
          }
        }
      } catch {}

      let balance = 0n;
      try {
        balance = await signer.getBalance(record.address);
      } catch {}
      const { fundingAttempt: _fundingAttempt, ...base } = record;
      if (balance > 0n) {
        this.store.put({ ...base, status: "available" });
        await this.store.flush();
        return attempt.txHash;
      }
      if (isSuperceded) {
        this.store.put({ ...base, status: "retired" });
        this.capacityCache.delete(record.index);
        await this.store.flush();
        throw new Error(
          `Funding transaction ${attempt.txHash} was superceded by a later nonce and sub-account ${record.index} was retired`
        );
      }
      throw new Error(`Funding transaction ${attempt.txHash} is still pending`);
    }
    if (status === "failed") {
      const { fundingAttempt: _fundingAttempt, ...base } = record;
      this.store.put({ ...base, status: "retired" });
      this.capacityCache.delete(record.index);
      await this.store.flush();
      throw new Error(`Funding transaction ${attempt.txHash} failed`);
    }
    const { fundingAttempt: _fundingAttempt, ...base } = record;
    this.store.put({ ...base, status: "available" });
    await this.store.flush();
    return attempt.txHash;
  }

  private async fundAccount(params: {
    target: Pick<SubAccountRecord, "index" | "address">;
    paymentCapacityWei: bigint;
    gasReserveWei: bigint;
    mainAccountSigner: MonadAccountTxSigner;
    overrides?: MonadTxOverrides;
    receipt?: FundingReceiptOptions;
    onSigned?: (signedTx: SignedMonadTx) => void;
  }): Promise<FanOutFundingResult> {
    const fundedValue = params.paymentCapacityWei + params.gasReserveWei;
    const signedTx = await params.mainAccountSigner.buildAndSignTransfer(
      params.target.address,
      fundedValue,
      params.overrides
    );
    this.store.put({
      ...params.target,
      status: "funding",
      fundingAttempt: { rawTx: signedTx.rawTx, txHash: signedTx.txHash },
    });
    // The exact signed transaction is durable before it can reach the RPC.
    await this.store.flush();
    params.onSigned?.(signedTx);
    await params.mainAccountSigner.submit(signedTx);
    const txHash = await this.finishFundingAttempt(
      this.store.getByIndex(params.target.index) as SubAccountRecord,
      params.mainAccountSigner,
      params.receipt,
      false
    );
    this.capacityCache.set(params.target.index, {
      capacityWei: params.paymentCapacityWei,
      checkedAtMs: Date.now(),
    });
    return {
      index: params.target.index,
      address: params.target.address,
      fundedValue,
      signedTx,
      txHash,
    };
  }

  /** Re-derives the private key for sub-account `index` (deterministically, from the keyring —
   * never read from or written to the store) and wraps it in a `MonadAccountTxSigner` (#11) ready
   * to build/sign/submit/track transactions for it. Throws if `index` isn't a known sub-account,
   * to catch accidentally signing for an index the pool was never sized to include. */
  getSigner(
    index: number,
    params: { provider: Provider; httpClient: MonadTxSubmitter }
  ): MonadAccountTxSigner {
    if (this.store.getByIndex(index) === undefined) {
      throw new Error(`No sub-account at index ${index} in the pool`);
    }
    const derived = this.keyring.deriveSubAccount(index);
    return new MonadAccountTxSigner({
      privateKey: derived.privateKey,
      provider: params.provider,
      httpClient: params.httpClient,
    });
  }

  /**
   * Per-stamp account selection (ticket #14 acceptance criterion): round-robins over sub-accounts
   * currently `'available'`, skipping `'in-use'`, `'spent'`, and `'retired'` ones, and returns the
   * next one — without mutating its status. (The `'available' -> 'in-use'` transition is ticket
   * #18's lease acquire step, called separately, typically right after this.) Returns `undefined`
   * if no sub-account is currently available.
   *
   * Rotation resumes after the last-returned index (wrapping around), rather than filtering to
   * `'available'` records first and indexing into that shrinking/growing list — so the rotation
   * order stays stable as accounts move in and out of `'available'` between calls. Since ticket
   * #34, `'available'` accounts are consumed exactly once (never cycle back — see
   * `monad-account-lease.ts`), so this "round-robin" is really just "pick whichever currently-funded
   * account is next in line"; the pool is kept from running dry by `topUpPool()` (see this file's
   * header) rather than by anything selection itself does.
   */
  selectForStamp(): SubAccountRecord | undefined {
    const all = this.store.getAll();
    if (all.length === 0) return undefined;
    for (let step = 1; step <= all.length; step++) {
      const candidatePosition =
        (((this.lastSelectedIndex + step) % all.length) + all.length) %
        all.length;
      const candidate = all[candidatePosition];
      if (candidate.status === "available") {
        this.lastSelectedIndex = candidatePosition;
        return candidate;
      }
    }
    return undefined;
  }

  /**
   * Convenience wrapper around `fanOutFundSubAccounts` that funds every pool record matching
   * `statuses` (defaults to just `'available'`) from `mainAccountSigner`. See that function for
   * the funding semantics (burn value / gas reserve kept separate).
   */
  async fundAll(params: {
    mainAccountSigner: MonadAccountTxSigner;
    burnValue: bigint;
    gasReserve: bigint;
    overrides?: MonadTxOverrides;
    statuses?: SubAccountStatus[];
  }): Promise<FanOutFundingResult[]> {
    const statuses = params.statuses ?? ["available"];
    const targets = this.store
      .getAll()
      .filter((record) => statuses.includes(record.status));
    return fanOutFundSubAccounts({
      mainAccountSigner: params.mainAccountSigner,
      targets,
      burnValue: params.burnValue,
      gasReserve: params.gasReserve,
      overrides: params.overrides,
    });
  }

  /** The next sub-account index that has never been derived/persisted into this pool yet — i.e.
   * one past the highest index currently in the store, or `0` for an empty pool. Ticket #34's
   * growth mechanism (`topUpPool`) derives from here rather than from any fixed `ensureSize()`
   * bound, so the pool can keep extending indefinitely as accounts get spent. */
  private nextFreshIndex(): number {
    const all = this.store.getAll();
    if (all.length === 0) return 0;
    return Math.max(...all.map((record) => record.index)) + 1;
  }

  /**
   * Look-ahead funding top-up (ticket #34 acceptance criterion): tops the pool's count of
   * currently-`'available'` (funded, unused) sub-accounts back up to `bufferSize` (default
   * `DEFAULT_TOPUP_BUFFER_SIZE`), deriving and funding only the shortfall — fresh indices, one past
   * whatever the pool's highest known index is (`nextFreshIndex()`), never indices already handed
   * out. See this file's header ("Look-ahead funding buffer") for why this is a separate,
   * explicitly-invoked async method rather than something `selectForStamp()` triggers itself.
   *
   * Every exact signed transaction is persisted as `'funding'` before submission, and a target
   * becomes `'available'` only after a successful receipt. A retry resumes the same raw transaction
   * rather than allocating another nonce or funding the same child twice.
   *
   * Returns the funding results for whatever was actually topped up (empty if the buffer was
   * already full).
   */
  async topUpPool(params: {
    mainAccountSigner: MonadAccountTxSigner;
    burnValue: bigint;
    gasReserve: bigint;
    bufferSize?: number;
    overrides?: MonadTxOverrides;
    receipt?: FundingReceiptOptions;
  }): Promise<FanOutFundingResult[]> {
    const bufferSize = params.bufferSize ?? DEFAULT_TOPUP_BUFFER_SIZE;
    if (!Number.isInteger(bufferSize) || bufferSize < 0) {
      throw new Error(
        `bufferSize must be a non-negative integer, got ${bufferSize}`
      );
    }
    if (params.burnValue < BigInt(0)) {
      throw new Error(`burnValue must be >= 0, got ${params.burnValue}`);
    }
    if (params.gasReserve < BigInt(0)) {
      throw new Error(`gasReserve must be >= 0, got ${params.gasReserve}`);
    }
    for (const record of this.store.getAll()) {
      if (record.status === "funding") {
        await this.finishFundingAttempt(
          record,
          params.mainAccountSigner,
          params.receipt
        );
      }
    }

    const currentlyAvailable = this.store
      .getAll()
      .filter((record) => record.status === "available").length;
    const deficit = bufferSize - currentlyAvailable;
    if (deficit <= 0) return [];

    const targets = this.store
      .getAll()
      .filter((record) => record.status === "unfunded")
      .slice(0, deficit);
    while (targets.length < deficit) {
      const index = this.nextFreshIndex();
      const derived = this.keyring.deriveSubAccount(index);
      const target: SubAccountRecord = {
        index,
        address: derived.address,
        status: "unfunded",
      };
      this.store.put(target);
      targets.push(target);
    }
    await this.store.flush();

    const results: FanOutFundingResult[] = [];
    for (const target of targets) {
      results.push(
        await this.fundAccount({
          target,
          paymentCapacityWei: params.burnValue,
          gasReserveWei: params.gasReserve,
          mainAccountSigner: params.mainAccountSigner,
          overrides: params.overrides,
          receipt: params.receipt,
        })
      );
    }
    return results;
  }

  /** Invalidates cached capacity entries for a single sub-account or all sub-accounts. */
  invalidateCapacityCache(index?: number): void {
    if (index !== undefined) {
      this.capacityCache.delete(index);
    } else {
      this.capacityCache.clear();
    }
  }

  /** Updates the in-memory cached capacity for a sub-account. */
  updateCapacityCache(
    index: number,
    capacityWei: bigint,
    checkedAtMs = Date.now()
  ): void {
    this.capacityCache.set(index, { capacityWei, checkedAtMs });
  }

  /** Configures default parameters for background proactive warming. */
  configureProactiveWarming(config?: EnsureMinimumCapacityParams): void {
    this.proactiveWarmingConfig = config;
  }

  getProactiveWarmingConfig(): EnsureMinimumCapacityParams | undefined {
    return this.proactiveWarmingConfig;
  }

  /** Triggers a non-blocking background check of available capacity using configured parameters. */
  triggerProactiveWarming(): void {
    if (this.proactiveWarmingConfig) {
      void this.ensureMinimumAvailableCapacity(
        this.proactiveWarmingConfig
      ).catch(() => undefined);
    }
  }

  /**
   * Called when a lease is released, invalidating its cache entry and asynchronously
   * triggering proactive warming if configured.
   */
  onLeaseReleased(index: number, _outcome?: string): void {
    this.capacityCache.delete(index);
    this.triggerProactiveWarming();
  }

  /**
   * Ensures that the pool has at least `minCount` (default 2) receipt-confirmed,
   * available funded sub-accounts ready for single-use spends. If the available
   * funded capacity falls below `minCount`, schedules a non-blocking background
   * `fanOutFundSubAccounts` call so the pool is always replenished before the user hits Send.
   */
  ensureMinimumAvailableCapacity(
    params?: EnsureMinimumCapacityParams
  ): Promise<void> {
    const config = params ?? this.proactiveWarmingConfig;
    if (!config) {
      return Promise.resolve();
    }
    if (!this.proactiveWarmingConfig && params) {
      this.proactiveWarmingConfig = params;
    }
    if (this.activeWarmingPromise) {
      return this.activeWarmingPromise;
    }

    const warming = (async () => {
      try {
        const minCount =
          config.minCount ?? DEFAULT_MIN_AVAILABLE_CAPACITY_COUNT;
        const stampValueWei = config.stampValueWei ?? BigInt(1_000);
        const gasReserveWei = config.gasReserveWei ?? BigInt(21_000);

        const accounts = await this.fundedCapacities(
          config.provider,
          gasReserveWei
        );
        const fundedAccounts = accounts.filter(
          (a) =>
            a.capacityWei >=
            (config.stampValueWei !== undefined
              ? config.stampValueWei
              : BigInt(1))
        );

        if (fundedAccounts.length >= minCount) {
          return;
        }

        const deficit = minCount - fundedAccounts.length;
        const unfunded = this.store
          .getAll()
          .filter((record) => record.status === "unfunded");
        while (unfunded.length < deficit) {
          const index = this.nextFreshIndex();
          const derived = this.keyring.deriveSubAccount(index);
          const record: SubAccountRecord = {
            index,
            address: derived.address,
            status: "unfunded",
          };
          this.store.put(record);
          unfunded.push(record);
        }
        await this.store.flush();
        const targets = unfunded.slice(0, deficit);

        await fanOutFundSubAccounts({
          mainAccountSigner: config.mainAccountSigner,
          targets,
          burnValue: stampValueWei,
          gasReserve: gasReserveWei,
          overrides: config.overrides,
          onFunded: async (result) => {
            this.store.put({
              index: result.index,
              address: result.address,
              status: "available",
            });
            this.capacityCache.set(result.index, {
              capacityWei: stampValueWei,
              checkedAtMs: Date.now(),
            });
            await this.store.flush();
          },
        });
      } catch {
        // Non-blocking background warming: absorb errors so callers never throw or crash
      } finally {
        this.activeWarmingPromise = undefined;
      }
    })();

    this.activeWarmingPromise = warming;
    return warming;
  }
}

/** Result of funding one sub-account via `fanOutFundSubAccounts`. */
export interface FanOutFundingResult {
  index: number;
  address: string;
  /** `burnValue + gasReserve` for this sub-account. The two figures are combined only here, at the
   * point where `MonadAccountTxSigner.buildAndSignTransfer`'s single `value` parameter requires
   * one number — everywhere else in this module and its callers, `burnValue` and `gasReserve`
   * travel as two separate, explicit parameters (ticket #14's acceptance criterion). */
  fundedValue: bigint;
  signedTx: SignedMonadTx;
  txHash: string;
}

/**
 * Fan-out funding routine (ticket #14 acceptance criterion): given a main funded account's
 * `MonadAccountTxSigner` (#11) and a list of target sub-accounts, sends `burnValue + gasReserve`
 * to each one as a plain native-value transfer. `burnValue` and `gasReserve` are always taken as
 * two separate, explicit parameters — never pre-combined by a caller into one opaque "amount" —
 * so this is the one place, right before the single `value` the underlying tx construction API
 * takes, where they're added together.
 *
 * Sequenced deliberately: each target is fully built, signed, *and submitted* before moving on to
 * the next, rather than building/submitting all N concurrently. `MonadAccountTxSigner` fetches a
 * fresh nonce from the chain (`eth_getTransactionCount(mainAccount, "pending")`) on every build
 * call with no local caching or reuse (see `monad-account-tx.ts`) — firing all N transfers from
 * the same main account concurrently would race every one of them for the same "next" nonce.
 * Awaiting each submit before building the next lets the node's pending-nonce view advance
 * normally between sends. (A future caller wanting throughput could pass explicit, pre-planned
 * `overrides.nonce` values per target and parallelize — out of scope here.)
 *
 * `onFunded`, if given, is awaited right after each individual target's send
 * succeeds (not batched at the end) — added for ticket #34's `MonadSubAccountPool.topUpPool()`, so
 * it can durably persist each freshly-funded index as `'available'` incrementally, rather than
 * losing already-funded targets' bookkeeping if a later target in the same batch throws.
 */
export async function fanOutFundSubAccounts(params: {
  mainAccountSigner: MonadAccountTxSigner;
  targets: Array<Pick<SubAccountRecord, "index" | "address">>;
  burnValue: bigint;
  gasReserve: bigint;
  overrides?: MonadTxOverrides;
  onFunded?: (result: FanOutFundingResult) => void | Promise<void>;
}): Promise<FanOutFundingResult[]> {
  // `BigInt(0)` rather than a `0n` literal: this app's tsconfig targets ES2017, which doesn't
  // support BigInt literal syntax (only the `bigint` type/`BigInt(...)` calls) — the same
  // constraint `monad-account-tx.ts` (#11) works under; see this file's header precedent.
  const zero = BigInt(0);
  if (params.burnValue < zero) {
    throw new Error(`burnValue must be >= 0, got ${params.burnValue}`);
  }
  if (params.gasReserve < zero) {
    throw new Error(`gasReserve must be >= 0, got ${params.gasReserve}`);
  }

  const results: FanOutFundingResult[] = [];
  for (const target of params.targets) {
    const fundedValue = params.burnValue + params.gasReserve;
    const signedTx = await params.mainAccountSigner.buildAndSignTransfer(
      target.address,
      fundedValue,
      params.overrides
    );
    const txHash = await params.mainAccountSigner.submit(signedTx);
    const result: FanOutFundingResult = {
      index: target.index,
      address: target.address,
      fundedValue,
      signedTx,
      txHash,
    };
    results.push(result);
    await params.onFunded?.(result);
  }
  return results;
}
