/**
 * HD sub-account pool + fan-out funding for Monad (ticket #14).
 *
 * Implements `PLAN.md`'s M5/constraint-3 privacy pool: instead of one hot wallet address
 * accumulating a linkable on-chain history across every stamp payment or broadcast, we derive independent
 * `m/44'/60'/0'/0/i` sub-account EOAs (`./evm-hd-keyring.ts`) from a single root secret, fund
 * each one from a main account (`fundAccount`, below: the one recorded funding path), and hand out
 * each one exactly once (`EvmSubAccountPool.selectForStamp`) — never reusing an address, like a UTXO.
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
 *     unavoidably async (it submits real transactions), so it can't run
 *     inside that synchronous call chain without restructuring callers this ticket doesn't own.
 *     Ticket #79 wires production DMs through `prepareStampInventory()` only after the user presses
 *     Send. `topUpPool()` remains an explicit API for non-DM callers; neither path moves funds merely
 *     because a wallet was opened. `fundStampInventoryAhead()` (#1235) is that same preparation
 *     asked for by a host between messages, for the one next message; nothing calls it at open
 *     either. Every one of these funds through `fundAccount`, which stores the signed transfer
 *     before it submits it: there is no other way value reaches a sub-account.
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
import { Provider, Transaction, getAddress, getBytes } from "ethers";

import { MonadHdKeyring } from "./evm-hd-keyring";
import {
  EvmFundingAccounts,
  EvmFundingObservation,
  MonadAccountTxSigner,
  MonadTxOverrides,
  MonadTxSubmitter,
  SignedMonadTx,
} from "./evm-account-tx";
import {
  InMemorySubAccountPoolStore,
  assertSubAccountLifecycleMatrix,
  assertSubAccountStatusTransition,
  sameFundingObservation,
  SubAccountRevisionMismatchError,
  SubAccountTransactionCheckpoint,
} from "./storage/sub-account-pool-storage";
import type { MonadWalletOperationAdmission } from "./storage/evm-wallet-bundle";
import {
  selectStampAccounts,
  type SelectedStampAccount,
} from "./evm-stamp-account-selection";
import { inferChainFamily, type ChainUtxoPool } from "./chain-utxo-pool";

import {
  BurnAccountPreparationResult,
  CAPACITY_CACHE_TTL_MS,
  ClassifiedSubAccountSpend,
  cloneFundingCollection,
  DEFAULT_TOPUP_BUFFER_SIZE,
  FanOutFundingResult,
  FUND_AHEAD_RECEIPT_POLL_MS,
  FUND_AHEAD_RECEIPT_WAIT_MS,
  FundAheadRefusedError,
  FundingReceiptOptions,
  InsufficientStampFundsError,
  INTER_TX_FUNDING_DELAY_MS,
  MAX_SPEND_RAW_TX_LENGTH,
  normalizeFundingObservation,
  STAMP_PAIR_TRANSFERS,
  StampInventoryPreparationProgress,
  StampInventoryPreparationResult,
  SubAccountCapacityCacheEntry,
  SubAccountFundingAccounts,
  SubAccountFundingAttempt,
  SubAccountFundingBlock,
  SubAccountFundingCollection,
  SubAccountFundingHold,
  SubAccountFundingObservation,
  SubAccountPoolStore,
  SubAccountRecoveryDisposition,
  SubAccountRecord,
  SubAccountSpendApplication,
  SubAccountSpendApplier,
  SubAccountSpendOutcome,
  SubAccountSpendRefusedError,
  SubAccountStatus,
  TerminalSubAccountCheckpoint,
} from "./evm-pool-types";

export {
  CAPACITY_CACHE_TTL_MS,
  DEFAULT_TOPUP_BUFFER_SIZE,
  FUND_AHEAD_RECEIPT_POLL_MS,
  FUND_AHEAD_RECEIPT_WAIT_MS,
  FundAheadRefusedError,
  InsufficientStampFundsError,
  INTER_TX_FUNDING_DELAY_MS,
  STAMP_PAIR_TRANSFERS,
  SubAccountSpendRefusedError,
  type BurnAccountPreparationResult,
  type FanOutFundingResult,
  type FundingReceiptOptions,
  type StampInventoryPreparationProgress,
  type StampInventoryPreparationResult,
  type SubAccountCapacityCacheEntry,
  type SubAccountFundingAccounts,
  type SubAccountFundingAttempt,
  type SubAccountFundingBlock,
  type SubAccountFundingCollection,
  type SubAccountFundingHold,
  type SubAccountFundingObservation,
  type SubAccountPoolStore,
  type SubAccountRecoveryDisposition,
  type SubAccountRecord,
  type SubAccountSpendApplication,
  type SubAccountSpendApplier,
  type SubAccountSpendOutcome,
  type SubAccountStatus,
  type TerminalSubAccountCheckpoint,
};

/**
 * @deprecated Use `MonadAddressInventory` (`./monad-address-inventory.ts`, Ticket #924), which
 * unifies spend and change addresses under a single dynamic inventory without rigid promotion
 * state machines or separate pool boundaries.
 *
 * Tracks an ever-growing pool of HD-derived sub-accounts, persisted via a `SubAccountPoolStore` so
 * the pool (its records and each account's status) survives app restarts. Private keys are never
 * held or persisted by the pool itself — `getSigner()` re-derives one on demand from the keyring.
 */
export class EvmSubAccountPool {
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
  private walletOperationGate?: <T>(
    operation: (admission: MonadWalletOperationAdmission) => Promise<T>,
    admission?: MonadWalletOperationAdmission
  ) => Promise<T>;
  private spendReservation?: (index: number) => boolean;
  /** Sub-account index -> the operation holding it. See `claim`. */
  private readonly claims = new Map<number, string>();
  /** Lower-case address of the main or identity account -> the operation holding it. */
  private readonly accountClaims = new Map<string, string>();
  private readonly accountGenerations = new Map<string, number>();
  private readonly accountWaiters = new Map<string, Array<() => void>>();
  private spendApplier?: SubAccountSpendApplier;
  private accountUtxoPool?: ChainUtxoPool;

  private coinViewChainIdentifier?: string

  setAccountUtxoPool(pool: ChainUtxoPool, chainIdentifier: string): void {
    inferChainFamily(chainIdentifier, 'evm')
    if (this.coinViewChainIdentifier !== undefined && this.coinViewChainIdentifier !== chainIdentifier) {
      throw new Error('Cannot rebind attached EVM coin view to another chain')
    }
    this.coinViewChainIdentifier = chainIdentifier
    this.accountUtxoPool = pool;
  }

  private syncUtxo(index: number, status: SubAccountStatus, balanceWei?: bigint): void {
    if (!this.accountUtxoPool) return;
    const derived = this.keyring.deriveSubAccount(index);
    const utxos = this.accountUtxoPool.getCoinsByAddress(derived.address, this.coinViewChainIdentifier!);
    if (utxos.length === 0) {
      this.accountUtxoPool.registerSubAccount({
        chainIdentifier: this.coinViewChainIdentifier!,
        address: derived.address,
        privateKey: derived.privateKey,
        balanceWei: balanceWei ?? 0n,
        derivationPath: this.keyring.subAccountPath(index),
        index,
      });
      const registered = this.accountUtxoPool.getCoinsByAddress(derived.address, this.coinViewChainIdentifier!)[0];
      if (registered) {
        if (status === "spent" || status === "retired") {
          this.accountUtxoPool.markSpent(registered.id);
        } else if (status === "in-use" || status === "funding") {
          this.accountUtxoPool.markPending(registered.id);
        }
      }
      return;
    }
    const coin = utxos[0];
    if (balanceWei !== undefined) {
      coin.balanceWei = balanceWei;
    }
    if (status === "spent" || status === "retired") {
      if (coin.status !== "spent") {
        this.accountUtxoPool.markSpent(coin.id);
      }
    } else if (status === "in-use" || status === "funding") {
      if (coin.status === "clean") {
        this.accountUtxoPool.markPending(coin.id);
      }
    } else if (status === "available") {
      if (coin.status === "pending") {
        this.accountUtxoPool.releasePending(coin.id);
      }
    }
  }

  private mainAccountAddress?: string;
  private expectedChainId?: bigint;

  constructor(params: {
    keyring: MonadHdKeyring;
    store?: SubAccountPoolStore;
    requireStampReconciliationPreflight?: boolean;
    mainAccountAddress?: string;
    expectedChainId?: bigint;
  }) {
    this.keyring = params.keyring;
    this.store = params.store ?? new InMemorySubAccountPoolStore();
    this.requireStampReconciliationPreflight =
      params.requireStampReconciliationPreflight ?? false;
    this.mainAccountAddress = params.mainAccountAddress;
    if (params.expectedChainId !== undefined) {
      this.setExpectedChainId(params.expectedChainId);
    }
  }

  setMainAccountAddress(address: string): void {
    this.mainAccountAddress = address;
  }

  setExpectedChainId(chainId: bigint): void {
    if (typeof chainId !== "bigint" || chainId <= 0n) {
      throw new Error(`Expected chain ID must be a positive bigint, got ${chainId}`);
    }
    if (this.expectedChainId !== undefined && this.expectedChainId !== chainId) {
      throw new Error(
        `Cannot rebind sub-account pool expected chain ID from ${this.expectedChainId} to ${chainId}`
      );
    }
    this.expectedChainId = chainId;
  }

  getExpectedChainId(): bigint | undefined {
    return this.expectedChainId;
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
   * Composition-attached reservation: `isReserved(index)` answers whether an operation outside the
   * pool (today, a native send in the native operation journal) spends from that sub-account. The
   * pool stores nothing: the answer is read from its owner on every selection, so it starts when
   * that owner records the spend, survives restart with it, and is never stale. A reserved row is
   * not offered as funded capacity, not selected for a lease, not chosen as an on-demand funding
   * target, not a canonical stamp candidate and not retired by preparation's reconciliation; it
   * stops mattering once the row is terminal. The predicate is asked only after the cheap status
   * check, so it runs for rows that would otherwise be chosen. A pool with nothing attached
   * reserves nothing. `acquireForIndex` and native source selection do
   * not ask: their callers name a row they already own.
   */
  attachSpendReservation(isReserved: (index: number) => boolean): void {
    if (this.spendReservation !== undefined) {
      throw new Error("Sub-account pool already has a spend reservation");
    }
    this.spendReservation = isReserved;
  }

  private funderSpacing?: (address: string) => Promise<void>;
  /** Composition-attached: resolves when a transfer from `address` is safe under the chain's
   * spacing rule (`EvmChainConfig.spendSpacingBlocks`). Called before each funding transfer. */
  attachFunderSpacing(wait: (address: string) => Promise<void>): void {
    this.funderSpacing = wait;
  }

  /** True while sub-account `index` is not free for a new spender: an operation holds a claim on
   * it (see `claim`), or an attached reservation does (see `attachSpendReservation`). `holder`
   * names a claimant whose own claim does not count against it. */
  isSpendReserved(index: number, holder?: string): boolean {
    const claimant = this.claims.get(index);
    if (claimant !== undefined && claimant !== holder) return true;
    const holdOwner = this.store.getByIndex(index)?.funding?.hold?.operationId;
    if (holdOwner !== undefined && holdOwner !== holder) return true;
    return this.spendReservation?.(index) ?? false;
  }

  /**
   * THE claim. The one place a sub-account passes from "free" to "held by this operation", for
   * every spender of pool accounts (paid messages, topic burns, native sends, funding targets).
   *
   * Synchronous from reading what is free to writing the claim: there is no `await` inside, so
   * two operations started in the same moment, in this wallet or in any other wallet holding
   * this pool, can never both be handed the same account. `pick` is given every row no other
   * holder has (rows this holder already claimed included) and returns the indexes it wants, or
   * `undefined` when what is free does not serve it; then nothing is claimed.
   *
   * `holder` identifies the operation and must not collide between wallets sharing a pool:
   * include the wallet's identity and the message or operation id.
   *
   * A claim is process memory. What makes it survive a restart is the claimant's own durable
   * record (a stored outgoing message with its signed payments, a native journal row, an
   * `in-use` or `funding` row): the claimant restores its claims from that record at open, before
   * the wallet is handed out. A claim whose operation never signed anything is simply gone.
   */
  claim(
    holder: string,
    pick: (free: readonly SubAccountRecord[]) => readonly number[] | undefined
  ): number[] | undefined {
    const free = this.store
      .getAll()
      .filter((record) => !this.isSpendReserved(record.index, holder));
    const wanted = pick(free);
    if (wanted === undefined) return undefined;
    const offered = new Set(free.map((record) => record.index));
    if (wanted.some((index) => !offered.has(index)))
      throw new Error("A claim may only take accounts it was offered");
    for (const index of wanted) this.claims.set(index, holder);
    return [...wanted];
  }

  /** Sets the claims a durable record of `holder` names: at open, for a stored message with a
   * payment the chain has not answered for; and for a native plan over accounts its own journal
   * orders, between the plan and its journal write. Synchronous. Unlike `claim` it does not ask
   * the attached reservation (the caller is that owner), and it throws rather than share. */
  restoreClaim(holder: string, indices: readonly number[]): void {
    for (const index of indices) {
      const claimant = this.claims.get(index);
      if (claimant !== undefined && claimant !== holder)
        throw new Error(
          `Sub-account ${index} is claimed by ${claimant} and by ${holder}`
        );
      this.claims.set(index, holder);
    }
  }

  /** Ends `holder`'s claim on `indices` (default: all of them). The caller has either recorded
   * the account's new state from chain evidence, or never let a signature leave the wallet. */
  releaseClaim(holder: string, indices?: readonly number[]): void {
    for (const [index, claimant] of [...this.claims])
      if (claimant === holder && (indices === undefined || indices.includes(index))) {
        this.claims.delete(index);
        const address = this.store.getByIndex(index)?.address.toLowerCase();
        if (address !== undefined)
          this.accountGenerations.set(address, (this.accountGenerations.get(address) ?? 0) + 1);
      }
    if (indices === undefined)
      for (const [address, claimant] of [...this.accountClaims])
        if (claimant === holder) this.releaseAccountClaim(holder, address);
  }

  /**
   * The same claim for an account that is not a pool row: the wallet's main account or its
   * identity account, by address. Each is one coin at its current nonce, so one operation at a
   * time spends it; the next takes it when the chain has shown what became of the first.
   * Synchronous. `generation` is what `accountGeneration(address)` answered BEFORE the caller
   * read the account's nonce and balance: when another operation held and released the account
   * in between, those reads are stale and the claim is refused, so a nonce is never signed twice.
   */
  claimAccount(holder: string, address: string, generation: number): boolean {
    const key = address.toLowerCase();
    if (
      this.accountClaims.has(key) ||
      (this.accountGenerations.get(key) ?? 0) !== generation
    )
      return false;
    this.accountClaims.set(key, holder);
    return true;
  }

  /** Counts the times `address` has been released. See `claimAccount`. */
  accountGeneration(address: string): number {
    return this.accountGenerations.get(address.toLowerCase()) ?? 0;
  }

  /** The operation holding the main or identity account at `address`, if any. */
  accountClaimedBy(address: string): string | undefined {
    return this.accountClaims.get(address.toLowerCase());
  }

  /** At open: the main or identity account a stored, unsettled payment of `holder` spends. */
  restoreAccountClaim(holder: string, address: string): void {
    const key = address.toLowerCase();
    const claimant = this.accountClaims.get(key);
    if (claimant !== undefined && claimant !== holder)
      throw new Error(`Account ${key} is claimed by ${claimant} and by ${holder}`);
    this.accountClaims.set(key, holder);
  }

  /** Ends `holder`'s claim on the account at `address`. */
  releaseAccountClaim(holder: string, address: string): void {
    const key = address.toLowerCase();
    if (this.accountClaims.get(key) !== holder) return;
    this.accountClaims.delete(key);
    this.accountGenerations.set(key, (this.accountGenerations.get(key) ?? 0) + 1);
    const waiting = this.accountWaiters.get(key);
    this.accountWaiters.delete(key);
    for (const wake of waiting ?? []) wake();
  }

  /** Resolves when the account at `address` is next released (at once if nobody holds it).
   * Operations waiting for the same account are woken in the order they began to wait. */
  accountReleased(address: string): Promise<void> {
    const key = address.toLowerCase();
    if (!this.accountClaims.has(key)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiting = this.accountWaiters.get(key) ?? [];
      waiting.push(resolve);
      this.accountWaiters.set(key, waiting);
    });
  }

  /** The operation holding sub-account `index`, if any. */
  claimedBy(index: number): string | undefined {
    return this.claims.get(index);
  }

  /** The accounts `holder` holds. */
  claimsOf(holder: string): number[] {
    return [...this.claims]
      .filter(([, claimant]) => claimant === holder)
      .map(([index]) => index);
  }

  /**
   * Claims, for `holder`, funded accounts that pay a stamp of `stampValueWei`, each keeping
   * `feeReserveWei` for its own fee: `selectStampAccounts` over the accounts that are `available`
   * and free, at the balances this pool remembers. Synchronous (it is one `claim`), so it never
   * reads the chain: call `fundedCapacities` first when balances may not be remembered yet.
   * Returns `undefined`, claiming nothing, when the free accounts do not cover the stamp.
   */
  claimStampAccounts(
    holder: string,
    stampValueWei: bigint,
    feeReserveWei: bigint,
    /** Current-chain eligibility captured before this atomic claim, rechecked for stale reads. */
    eligible?: (index: number, address: string) => boolean
  ): SelectedStampAccount[] | undefined {
    let selected: SelectedStampAccount[] | undefined;
    this.claim(holder, (free) => {
      const accounts = free.flatMap((record) => {
        const balanceWei = this.capacityCache.get(record.index)?.balanceWei;
        return record.status === "available" &&
          eligible?.(record.index, record.address) !== false &&
          balanceWei !== undefined &&
          balanceWei > feeReserveWei
          ? [
              {
                index: record.index,
                address: record.address,
                capacityWei: balanceWei - feeReserveWei,
              },
            ]
          : [];
      });
      try {
        selected = selectStampAccounts({
          amountWei: stampValueWei,
          accounts,
          maxTransactions: 64,
        });
      } catch {
        return undefined;
      }
      return selected.map((account) => account.index);
    });
    return selected;
  }

  /**
   * Composition-attached applier: the only way a wallet sync item can record a spend on this pool.
   * `processSyncTransaction` hands it the item's signed transaction and chain identifier once the
   * item is consistent with those bytes; the applier owns everything the pool cannot check by
   * itself (that the transaction is for this wallet's chain, that no other owner claims the
   * account) and the commit and its flush. A pool with nothing attached REFUSES every item that
   * carries a transaction, so a pool opened without composition has no route from an item to a
   * spend record. The applier may enter the wallet's operation queue: never dispatch a sync item
   * from inside that queue.
   */
  attachSpendApplier(apply: SubAccountSpendApplier): void {
    if (this.spendApplier !== undefined) {
      throw new Error("Sub-account pool already has a spend applier");
    }
    this.spendApplier = apply;
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
  async ensureSize(size: number): Promise<SubAccountRecord[]> {
    return this.ensureSizeWithStatus(size, "available");
  }

  /** Production derivation path: records new addresses without claiming they hold funds. */
  async ensureUnfundedSize(size: number): Promise<SubAccountRecord[]> {
    return this.ensureSizeWithStatus(size, "unfunded");
  }

  private async ensureSizeWithStatus(
    size: number,
    initialStatus: "available" | "unfunded"
  ): Promise<SubAccountRecord[]> {
    if (!Number.isInteger(size) || size < 0) {
      throw new Error(`Pool size must be a non-negative integer, got ${size}`);
    }
    for (let index = 0; index < size; index++) {
      if (this.store.getByIndex(index) === undefined && index >= this.store.getNextIndex()) {
        const derived = this.keyring.deriveSubAccount(index);
        await this.persistRecord({
          index: derived.index,
          address: derived.address,
          status: initialStatus,
        });
      }
    }
    return this.store.getAll();
  }

  private async persistRecords(records: readonly SubAccountRecord[]): Promise<void> {
    await this.store.mutate(() => ({
      records: records.map(record => ({ record, expectedRevision: record.revision ?? 0 })),
      result: undefined,
    }));
  }

  private async persistRecord(record: SubAccountRecord): Promise<void> {
    await this.persistRecords([record]);
  }

  /** All sub-account records currently tracked by the pool, sorted by index. */
  records(): SubAccountRecord[] {
    return this.store.getAll();
  }

  /** Wallet-recovery boundary: applies a fully prevalidated set in one component-store batch. */
  async applyPrevalidatedRecoveryRecords(records: readonly SubAccountRecord[]): Promise<void> {
    await this.persistRecords(records);
  }

  getRecord(index: number): SubAccountRecord | undefined {
    return this.store.getByIndex(index);
  }

  /** Persistent derivation high-water mark; unlike scanning history, this remains O(1) after
   * compaction and for long-lived wallets. */
  nextUnusedIndex(): number {
    return this.store.getNextIndex();
  }

  async deriveNextUnfunded(): Promise<SubAccountRecord> {
    const index = this.nextFreshIndex();
    const derived = this.keyring.deriveSubAccount(index);
    const record: SubAccountRecord = {
      index,
      address: derived.address,
      status: "unfunded",
    };
    await this.persistRecord(record);
    return this.store.getByIndex(record.index)!;
  }

  /** Reconstructs a locally-missing reservation only from an exact durable attempt whose signed
   * sender has already been validated against this derived index. */
  async restoreJournaledInUse(index: number): Promise<SubAccountRecord> {
    const existing = this.store.getByIndex(index);
    if (existing !== undefined) return existing;
    const derived = this.keyring.deriveSubAccount(index);
    const record: SubAccountRecord = {
      index,
      address: derived.address,
      status: "in-use",
    };
    await this.persistRecord(record);
    return this.store.getByIndex(record.index)!;
  }

  stageJournaledInUse(index: number): SubAccountRecord {
    const existing = this.store.getByIndex(index);
    if (existing !== undefined) return existing;
    const derived = this.keyring.deriveSubAccount(index);
    return { index, address: derived.address, status: "in-use" };
  }

  async restoreTerminalEvidence(record: SubAccountRecord): Promise<void> {
    if (record.status !== "spent" && record.status !== "retired") {
      throw new Error("Recovered sender evidence must be terminal");
    }
    if (
      getAddress(record.address) !==
      this.keyring.deriveSubAccount(record.index).address
    ) {
      throw new Error("Recovered sender evidence belongs to a different seed");
    }
    await this.persistRecord(record);
  }

  /** Directly persists a status transition for sub-account `index` — the mechanism ticket #18's
   * lease/stuck-nonce logic is expected to call (`'available' -> 'in-use'`, then `-> 'spent'` or
   * `-> 'retired'`, both terminal — see `evm-account-lease.ts`). This ticket does not call it
   * itself (except from `topUpPool()`, to mark a freshly-funded index `'available'`); it exists so
   * #18 has a slot to write through without needing to touch the storage layer directly. Throws if
   * `index` isn't a known sub-account. */
  async setStatus(
    index: number,
    status: SubAccountStatus,
    options?: { clearHold?: boolean }
  ): Promise<SubAccountRecord> {
    const existing = this.store.getByIndex(index);
    if (existing === undefined) {
      throw new Error(`No sub-account at index ${index} in the pool`);
    }
    if (status === "funding") {
      throw new Error("Use a durable funding attempt to enter funding state");
    }
    this.capacityCache.delete(index);
    const { funding: existingFunding, ...base } = existing;
    const preserveHold =
      options?.clearHold !== true &&
      (status === "available" || status === "in-use") &&
      existing.lifecycle?.spend === undefined &&
      existingFunding?.hold !== undefined;
    const updated: SubAccountRecord =
      status === "unfunded"
        ? { ...base, status: "unfunded" }
        : {
            ...base,
            status,
            ...(existingFunding === undefined
              ? {}
              : {
                  funding: cloneFundingCollection(existingFunding, {
                    preserveHold,
                  }),
                }),
          };
    await this.persistRecord(updated);
    this.syncUtxo(index, status);
    return this.store.getByIndex(index)!;
  }

  /**
   * Registers a signed funding transfer on sub-account `index` before broadcast.
   * Validates canonical signed bytes, sender, recipient, positive value, empty calldata,
   * empty accessList, gasLimit, nonce, and expectedChainId (when configured).
   * Exact replay of an already-registered `rawTx` is idempotent and does not increment
   * generation or row revision. Conflicting `txHash` or `(sender, nonce)` is refused.
   */
  async registerFundingAttempt(params: {
    index: number;
    rawTx: string;
    txHash: string;
    funder?: string;
    hold?: SubAccountFundingHold;
    expectedRevision?: number;
  }): Promise<SubAccountRecord> {
    if (!Number.isSafeInteger(params.index) || params.index < 0) {
      throw new Error(`Invalid sub-account index: ${params.index}`);
    }
    if (
      typeof params.rawTx !== "string" ||
      params.rawTx.length > MAX_SPEND_RAW_TX_LENGTH ||
      !/^0x[0-9a-f]+$/.test(params.rawTx)
    ) {
      throw new Error(
        `Funding attempt rawTx for sub-account ${params.index} is not canonical lowercase hex`
      );
    }
    if (
      typeof params.txHash !== "string" ||
      !/^0x[0-9a-f]{64}$/.test(params.txHash)
    ) {
      throw new Error(
        `Funding attempt txHash for sub-account ${params.index} is not canonical 32-byte lowercase hex`
      );
    }
    let tx: Transaction;
    try {
      tx = Transaction.from(params.rawTx);
    } catch (error) {
      throw new Error(
        `Funding attempt rawTx for sub-account ${params.index} failed to parse: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    let hash: string | null;
    let from: string | null;
    try {
      ({ hash, from } = tx);
    } catch (error) {
      throw new Error(
        `Funding attempt signature recovery failed for sub-account ${params.index}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    if (!hash || !from) {
      throw new Error(`Funding attempt for sub-account ${params.index} must be signed`);
    }
    if (tx.serialized.toLowerCase() !== params.rawTx) {
      throw new Error(
        `Funding attempt rawTx for sub-account ${params.index} is not canonical serialized bytes`
      );
    }
    if (hash.toLowerCase() !== params.txHash) {
      throw new Error(
        `Funding attempt txHash mismatch for sub-account ${params.index}: expected ${hash.toLowerCase()}, got ${params.txHash}`
      );
    }
    if (params.funder !== undefined) {
      let normalizedFunder: string;
      try {
        normalizedFunder = getAddress(params.funder);
      } catch {
        throw new Error(
          `Invalid funder address for sub-account ${params.index}: ${params.funder}`
        );
      }
      if (getAddress(from) !== normalizedFunder) {
        throw new Error(
          `Funding attempt sender mismatch for sub-account ${params.index}: expected ${normalizedFunder}, got ${getAddress(from)}`
        );
      }
    }
    const derivedAddress = this.keyring.deriveSubAccount(params.index).address;
    if (!tx.to || getAddress(tx.to) !== getAddress(derivedAddress)) {
      throw new Error(
        `Funding attempt recipient mismatch for sub-account ${params.index}: expected ${derivedAddress}, got ${tx.to ?? "null"}`
      );
    }
    if (tx.value <= 0n) {
      throw new Error(
        `Funding attempt for sub-account ${params.index} must transfer a positive value`
      );
    }
    if (getBytes(tx.data).length > 0) {
      throw new Error(
        `Funding attempt for sub-account ${params.index} must have empty calldata`
      );
    }
    if (tx.type !== 0 && tx.type !== 1 && tx.type !== 2) {
      throw new Error(
        `Funding attempt for sub-account ${params.index} has unsupported transaction type ${tx.type}`
      );
    }
    if (tx.accessList && tx.accessList.length > 0) {
      throw new Error(
        `Funding attempt for sub-account ${params.index} must have an empty accessList`
      );
    }
    if (tx.gasLimit <= 0n) {
      throw new Error(
        `Funding attempt for sub-account ${params.index} must have a positive gasLimit`
      );
    }
    if (tx.chainId <= 0n) {
      throw new Error(
        `Funding attempt for sub-account ${params.index} must have a positive chainId`
      );
    }
    if (this.expectedChainId !== undefined && tx.chainId !== this.expectedChainId) {
      throw new Error(
        `Funding attempt chainId mismatch for sub-account ${params.index}: expected ${this.expectedChainId}, got ${tx.chainId}`
      );
    }
    if (!Number.isSafeInteger(tx.nonce) || tx.nonce < 0) {
      throw new Error(
        `Funding attempt for sub-account ${params.index} has invalid nonce ${tx.nonce}`
      );
    }

    const normalizedSender = getAddress(from).toLowerCase();
    const valueWei = tx.value.toString();

    const updated = await this.store.mutate((snapshot) => {
      const current = snapshot.records.find((row) => row.index === params.index);
      if (current === undefined) {
        throw new Error(`No sub-account at index ${params.index} in the pool`);
      }
      if (getAddress(current.address) !== getAddress(derivedAddress)) {
        throw new Error(`Stored address mismatch for sub-account ${params.index}`);
      }
      if (
        params.expectedRevision !== undefined &&
        (current.revision ?? 0) !== params.expectedRevision
      ) {
        throw new SubAccountRevisionMismatchError(params.index);
      }
      if (
        current.status !== "unfunded" &&
        current.status !== "funding" &&
        current.status !== "available"
      ) {
        throw new Error(
          `Cannot register funding attempt on sub-account ${params.index} in status ${current.status}`
        );
      }
      const existingAttempts = current.funding?.attempts ?? [];
      for (const existing of existingAttempts) {
        if (existing.rawTx === params.rawTx) {
          return { records: [], result: current };
        }
        if (existing.txHash === params.txHash) {
          throw new Error(
            `Conflicting funding attempt txHash ${params.txHash} on sub-account ${params.index}`
          );
        }
        const existingTx = Transaction.from(existing.rawTx);
        if (
          existingTx.from &&
          getAddress(existingTx.from).toLowerCase() === normalizedSender &&
          existingTx.nonce === tx.nonce
        ) {
          throw new Error(
            `Conflicting funding attempt for sender ${normalizedSender} nonce ${tx.nonce} on sub-account ${params.index}`
          );
        }
      }
      const nextAttempt: SubAccountFundingAttempt = {
        rawTx: params.rawTx,
        txHash: params.txHash,
        valueWei,
        generation: 1,
        observation: { kind: "unresolved", reason: "pending" },
      };
      const nextHold = params.hold ?? current.funding?.hold;
      const nextFunding: SubAccountFundingCollection = {
        version: 1,
        attempts: [...existingAttempts, nextAttempt],
        ...(nextHold === undefined ? {} : { hold: nextHold }),
      };
      const nextRecord: SubAccountRecord = {
        ...current,
        status: "funding",
        funding: nextFunding,
      };
      assertSubAccountLifecycleMatrix(nextRecord);
      return {
        records: [
          {
            record: nextRecord,
            expectedRevision: current.revision ?? 0,
          },
        ],
        result: nextRecord,
      };
    });
    this.capacityCache.delete(params.index);
    this.syncUtxo(params.index, "funding");
    return this.store.getByIndex(params.index) ?? updated;
  }

  /**
   * Records an anchored chain observation for a registered funding attempt.
   * Compare-and-sets against `(txHash, rawTx, expectedGeneration)` inside `this.store.mutate`,
   * preserving concurrent later contributors and lifecycle facts on the latest row.
   * Refuses stale completions, A->B->A generation mismatches, generation overflow, and
   * overwriting resolved observations with conflicting evidence.
   */
  async recordFundingObservation(params: {
    index: number;
    txHash: string;
    rawTx: string;
    expectedGeneration: number;
    observation: SubAccountFundingObservation | EvmFundingObservation;
  }): Promise<SubAccountRecord> {
    if (
      !Number.isSafeInteger(params.expectedGeneration) ||
      params.expectedGeneration < 1
    ) {
      throw new Error(`Invalid expectedGeneration: ${params.expectedGeneration}`);
    }
    const normalizedObservation = normalizeFundingObservation(params.observation);
    const updated = await this.store.mutate((snapshot) => {
      const current = snapshot.records.find((row) => row.index === params.index);
      if (current === undefined || current.funding === undefined) {
        throw new Error(`Sub-account ${params.index} has no funding collection`);
      }
      const attemptIndex = current.funding.attempts.findIndex(
        (entry) => entry.txHash === params.txHash
      );
      if (attemptIndex < 0) {
        throw new Error(
          `Sub-account ${params.index} has no funding attempt ${params.txHash}`
        );
      }
      const currentAttempt = current.funding.attempts[attemptIndex]!;
      if (currentAttempt.rawTx !== params.rawTx) {
        throw new Error(
          `Funding attempt ${params.txHash} on sub-account ${params.index} rawTx mismatch`
        );
      }
      if (currentAttempt.generation !== params.expectedGeneration) {
        throw new Error(
          `Stale funding attempt generation for ${params.txHash} on sub-account ${params.index} (Stale pool revision: expected generation ${params.expectedGeneration}, got ${currentAttempt.generation})`
        );
      }
      if (sameFundingObservation(currentAttempt.observation, normalizedObservation)) {
        return { records: [], result: current };
      }
      if (currentAttempt.observation.kind !== "unresolved") {
        throw new Error(
          `Cannot overwrite resolved funding observation (${currentAttempt.observation.kind}) for ${params.txHash} on sub-account ${params.index}`
        );
      }
      if (currentAttempt.generation >= Number.MAX_SAFE_INTEGER) {
        throw new Error(
          `Funding attempt generation overflow for ${params.txHash} on sub-account ${params.index}`
        );
      }

      const updatedAttempt: SubAccountFundingAttempt = {
        ...currentAttempt,
        generation: currentAttempt.generation + 1,
        observation: normalizedObservation,
      };
      const nextAttempts = current.funding.attempts.map((entry, idx) =>
        idx === attemptIndex ? updatedAttempt : entry
      );

      let nextStatus = current.status;
      let nextHold = current.funding.hold;
      if (current.status === "funding") {
        if (
          normalizedObservation.kind === "superseded" ||
          (normalizedObservation.kind === "included" &&
            normalizedObservation.execution === "failure")
        ) {
          nextStatus = "retired";
          nextHold = undefined;
        } else if (
          normalizedObservation.kind === "included" &&
          normalizedObservation.execution === "success"
        ) {
          const allResolved = nextAttempts.every(
            (entry) => entry.observation.kind !== "unresolved"
          );
          const anyFailedOrSuperseded = nextAttempts.some(
            (entry) =>
              entry.observation.kind === "superseded" ||
              (entry.observation.kind === "included" &&
                entry.observation.execution === "failure")
          );
          if (anyFailedOrSuperseded) {
            nextStatus = "retired";
            nextHold = undefined;
          } else if (nextHold === undefined && allResolved) {
            nextStatus = "available";
          }
        }
      }

      const nextFunding: SubAccountFundingCollection = {
        version: 1,
        attempts: nextAttempts,
        ...(nextHold === undefined ? {} : { hold: nextHold }),
      };
      const nextRecord: SubAccountRecord = {
        ...current,
        status: nextStatus,
        funding: nextFunding,
      };
      assertSubAccountLifecycleMatrix(nextRecord);
      return {
        records: [
          {
            record: nextRecord,
            expectedRevision: current.revision ?? 0,
          },
        ],
        result: nextRecord,
      };
    });
    if (updated.status === "retired") {
      this.capacityCache.delete(params.index);
    }
    this.syncUtxo(params.index, updated.status);
    return this.store.getByIndex(params.index) ?? updated;
  }

  /** Retains the exact signed spend before it can become terminal/recoverable state. */
  async recordSpendTransaction(
    index: number,
    transaction: SubAccountTransactionCheckpoint
  ): Promise<void> {
    const existing = this.store.getByIndex(index);
    if (existing === undefined) {
      throw new Error(`No sub-account at index ${index} in the pool`);
    }
    this.capacityCache.delete(index);
    await this.persistRecord({
      ...existing,
      lifecycle: { ...existing.lifecycle, spend: { ...transaction } },
    });
  }

  /**
   * Captures the pool row's revision and preparation identity before async Forum signing yields,
   * so handoff to `TopicOperationJournal` can verify the sub-account was not mutated or reclaimed.
   */
  capturePreparationFence(
    index: number,
    holder?: string
  ): { index: number; revision: number; preparationId?: string } {
    const existing = this.store.getByIndex(index);
    if (existing === undefined) {
      throw new Error(`No sub-account at index ${index} in the pool`);
    }
    if (this.isSpendReserved(index, holder)) {
      throw new Error(
        `Sub-account ${index} is reserved by another operation and cannot be fenced`
      );
    }
    return {
      index,
      revision: existing.revision ?? 0,
      ...(existing.funding?.hold?.operationId !== undefined
        ? { preparationId: existing.funding.hold.operationId }
        : {}),
    };
  }

  /**
   * Atomically records the signed Forum burn checkpoint and clears any preparation `funding.hold`
   * once `TopicOperationJournal.put(operation)` has durably persisted the outgoing Forum operation.
   */
  async acknowledgePreparationHandoff(params: {
    index: number;
    spend: SubAccountTransactionCheckpoint;
    expectedRevision?: number;
    preparationId?: string;
  }): Promise<SubAccountRecord> {
    this.capacityCache.delete(params.index);
    const updated = await this.store.mutate((snapshot) => {
      const current = snapshot.records.find((row) => row.index === params.index);
      if (current === undefined) {
        throw new Error(`No sub-account at index ${params.index} in the pool`);
      }
      if (
        params.preparationId !== undefined &&
        current.funding?.hold !== undefined &&
        current.funding.hold.operationId !== params.preparationId
      ) {
        throw new Error(
          `Sub-account ${params.index} preparation hold mismatch: expected ${params.preparationId}, got ${current.funding.hold.operationId}`
        );
      }
      const existingSpend = current.lifecycle?.spend;
      if (existingSpend !== undefined) {
        if (
          existingSpend.rawTx.toLowerCase() !== params.spend.rawTx.toLowerCase() ||
          existingSpend.txHash.toLowerCase() !== params.spend.txHash.toLowerCase() ||
          existingSpend.valueWei !== params.spend.valueWei
        ) {
          throw new Error(
            `Conflicting spend checkpoint on sub-account ${params.index}`
          );
        }
        if (
          current.funding?.hold === undefined &&
          (current.status === "in-use" || current.status === "spent")
        ) {
          return { records: [], result: current };
        }
      } else if (
        params.expectedRevision !== undefined &&
        (current.revision ?? 0) !== params.expectedRevision
      ) {
        throw new SubAccountRevisionMismatchError(params.index);
      }
      if (
        current.status !== "in-use" &&
        current.status !== "available" &&
        current.status !== "spent"
      ) {
        throw new Error(
          `Cannot hand off Forum preparation for sub-account ${params.index} in status ${current.status}`
        );
      }
      const nextStatus: SubAccountStatus =
        current.status === "spent" ? "spent" : "in-use";
      const nextRecord: SubAccountRecord = {
        ...current,
        status: nextStatus,
        ...(current.funding === undefined
          ? {}
          : {
              funding: cloneFundingCollection(current.funding),
            }),
        lifecycle: {
          ...current.lifecycle,
          spend: { ...params.spend },
        },
      };
      assertSubAccountLifecycleMatrix(nextRecord);
      return {
        records: [
          {
            record: nextRecord,
            expectedRevision: current.revision ?? 0,
          },
        ],
        result: nextRecord,
      };
    });
    this.syncUtxo(params.index, updated.status);
    return this.store.getByIndex(params.index) ?? updated;
  }

  /** Lists all pool sub-accounts currently held by a pre-handoff preparation. */
  listHeldPreparations(): SubAccountRecord[] {
    return this.store
      .getAll()
      .filter(
        (record) =>
          record.funding?.hold !== undefined &&
          record.lifecycle?.spend === undefined
      );
  }

  /** Returns the pool sub-account held for `operationId`, if any. */
  getHeldPreparation(operationId: string): SubAccountRecord | undefined {
    return this.listHeldPreparations().find(
      (record) => record.funding?.hold?.operationId === operationId
    );
  }

  /**
   * Explicitly cancels a held pre-handoff preparation and releases its funded sub-account back to
   * normal pool availability (`status: "available"`, `funding.hold: undefined`), after verifying
   * no `TopicOperationJournal` entry or spend checkpoint owns the sub-account.
   */
  async cancelHeldPreparation(
    operationId: string,
    options?: {
      topicJournal?: {
        reload?(): Promise<void>;
        referencesLeaseIndex(index: number): boolean;
      };
      leaseManager?: { isLeased(index: number): boolean };
      mainAccountSigner?: MonadAccountTxSigner;
      receipt?: FundingReceiptOptions;
    }
  ): Promise<SubAccountRecord> {
    await options?.topicJournal?.reload?.();
    const initial = this.getHeldPreparation(operationId);
    if (initial === undefined) {
      throw new Error(`No held preparation found for operation ${operationId}`);
    }
    if (options?.topicJournal?.referencesLeaseIndex(initial.index)) {
      throw new Error(
        `Cannot cancel preparation ${operationId}: TopicOperationJournal already owns sub-account ${initial.index}`
      );
    }
    if (
      options?.leaseManager?.isLeased(initial.index) ||
      this.claims.get(initial.index) !== undefined
    ) {
      throw new Error(
        `Cannot cancel preparation ${operationId}: sub-account ${initial.index} has an active lease or claim`
      );
    }
    if (
      initial.status === "funding" &&
      initial.funding?.attempts.some(
        (entry) => entry.observation.kind === "unresolved"
      )
    ) {
      if (!options?.mainAccountSigner) {
        throw new Error(
          `Cannot cancel preparation ${operationId} while funding attempts remain unresolved without mainAccountSigner`
        );
      }
      await this.finishFundingAttempt(
        initial,
        options.mainAccountSigner,
        options.receipt
      );
    }
    await options?.topicJournal?.reload?.();
    const updated = await this.store.mutate((snapshot) => {
      const current = snapshot.records.find((row) => row.index === initial.index);
      if (
        current === undefined ||
        current.funding?.hold?.operationId !== operationId
      ) {
        throw new Error(
          `Held preparation ${operationId} on sub-account ${initial.index} changed during cancellation`
        );
      }
      if (
        current.lifecycle?.spend !== undefined ||
        options?.topicJournal?.referencesLeaseIndex(current.index)
      ) {
        throw new Error(
          `Cannot cancel preparation ${operationId}: sub-account ${current.index} already handed off to Forum spend`
        );
      }
      if (
        current.funding.attempts.some(
          (entry) => entry.observation.kind === "unresolved"
        )
      ) {
        throw new Error(
          `Cannot cancel preparation ${operationId}: funding attempt on sub-account ${current.index} is still unresolved`
        );
      }
      const allSucceeded =
        current.funding.attempts.length > 0 &&
        current.funding.attempts.every(
          (entry) =>
            entry.observation.kind === "included" &&
            entry.observation.execution === "success"
        );
      const nextStatus: SubAccountStatus = allSucceeded ? "available" : "retired";
      const nextRecord: SubAccountRecord = {
        ...current,
        status: nextStatus,
        funding: cloneFundingCollection(current.funding),
      };
      assertSubAccountLifecycleMatrix(nextRecord);
      return {
        records: [
          {
            record: nextRecord,
            expectedRevision: current.revision ?? 0,
          },
        ],
        result: nextRecord,
      };
    });
    await this.store.flush();
    this.capacityCache.delete(initial.index);
    this.syncUtxo(initial.index, updated.status);
    return this.store.getByIndex(initial.index) ?? updated;
  }

  /**
   * The one place that records "sub-account `index` was spent by this transaction" from evidence
   * that is not a lease outcome. It trusts nothing but the signed bytes: the sender must be the
   * keyring's address for `index`, and the stored hash and value are the transaction's own, so the
   * row it writes is what `validateMonadWalletState` recomputes. Checkpoint and terminal status go
   * down in a single put. It does not flush and never creates a row.
   * Throws `SubAccountSpendRefusedError` (nothing written) for unacceptable bytes or a row that
   * another owner or another transaction already holds.
   *
   * What the caller owes, because the pool cannot check it:
   * - Inclusion. The signature proves this wallet's seed authorized the transaction, not that it
   *   was mined. A row committed for a transaction that never lands is terminal all the same.
   * - The chain. The pool does not know the wallet's native chain ID.
   * - Other owners. A lease, a canonical or topic attempt, a funding attempt or another native
   *   member that claims the account is visible only to the input admission.
   * - Durability. The caller flushes, in the same turn as this call.
   * `poolSpendAdmission` (`evm-input-admission.ts`) is the only production caller and owns the
   * last three. Inclusion it takes from the native journal for this device's own sends; for a
   * transaction that arrives in a sync item with no journal member it has only the signature.
   *
   * A partial spend leaves the account's remaining balance in a `spent` row. Nothing in the pool
   * accounts for that residual: it is reachable only as a native source at the next nonce.
   */
  async commitSpend(index: number, rawTx: string): Promise<SubAccountSpendOutcome> {
    return this.applyClassifiedSpend(index, this.classifySpend(index, rawTx));
  }

  /** What `commitSpend(index, rawTx)` would do, without doing it: the same outcome, or the same
   * `SubAccountSpendRefusedError`. Read-only; it grants nothing, and `commitSpend` decides again. */
  classifySpendOutcome(index: number, rawTx: string): SubAccountSpendOutcome {
    return this.classifySpend(index, rawTx).outcome;
  }

  private async applyClassifiedSpend(
    index: number,
    classified: ClassifiedSubAccountSpend
  ): Promise<SubAccountSpendOutcome> {
    if (classified.candidate !== undefined) {
      await this.persistRecord(classified.candidate);
      this.capacityCache.delete(index);
    }
    if (classified.outcome !== "no-row") this.syncUtxo(index, "spent");
    return classified.outcome;
  }

  /** Decides what `commitSpend` does with these bytes, without writing. `candidate` is the one
   * row to put when the outcome is `committed`. */
  private classifySpend(index: number, rawTx: string): ClassifiedSubAccountSpend {
    const refuse = (
      code: SubAccountSpendRefusedError["code"],
      detail: string
    ): never => {
      throw new SubAccountSpendRefusedError(code, index, detail);
    };
    if (!Number.isSafeInteger(index) || index < 0) {
      return refuse("invalid-transaction", "index is not a sub-account index");
    }
    // Same acceptance as the wallet-state validator's signed-transaction parse, plus the native
    // journal's size and envelope bounds, so nothing accepted here is rejected there.
    if (
      typeof rawTx !== "string" ||
      rawTx.length > MAX_SPEND_RAW_TX_LENGTH ||
      !/^0x[0-9a-f]+$/.test(rawTx)
    ) {
      return refuse("invalid-transaction", "raw transaction is not bounded hex");
    }
    let transaction: Transaction;
    try {
      transaction = Transaction.from(rawTx);
    } catch {
      return refuse("invalid-transaction", "raw transaction does not parse");
    }
    // Reading the sender recovers the public key, which throws for a signature that recovers to
    // nothing: a refusal like any other unacceptable bytes, not an untyped failure.
    let hash: string | null;
    let from: string | null;
    try {
      ({ hash, from } = transaction);
    } catch {
      return refuse("invalid-transaction", "transaction signature does not recover");
    }
    if (hash === null || from === null) {
      return refuse("invalid-transaction", "transaction is unsigned");
    }
    if (
      transaction.serialized !== rawTx ||
      (transaction.type !== 0 &&
        transaction.type !== 1 &&
        transaction.type !== 2)
    ) {
      return refuse(
        "invalid-transaction",
        "transaction is not a canonical legacy, access-list or fee-market encoding"
      );
    }
    const derivedAddress = this.keyring.deriveSubAccount(index).address;
    if (getAddress(from) !== getAddress(derivedAddress)) {
      return refuse("sender-mismatch", "transaction was not signed by it");
    }

    const row = this.store.getByIndex(index);
    if (row === undefined) {
      if (this.store.getCheckpoints().some((entry) => entry.index === index)) {
        return refuse("held", "only a compacted terminal checkpoint remains");
      }
      return { outcome: "no-row", txHash: hash };
    }
    if (getAddress(row.address) !== getAddress(derivedAddress)) {
      return refuse("sender-mismatch", "stored address is not its derivation");
    }
    const spend: SubAccountTransactionCheckpoint = {
      rawTx,
      txHash: hash,
      valueWei: transaction.value.toString(),
    };
    const existing = row.lifecycle?.spend;
    if (
      (row.status === "unfunded" || row.status === "available") &&
      existing === undefined
    ) {
      const candidate: SubAccountRecord = {
        ...row,
        status: "spent",
        lifecycle: { ...row.lifecycle, spend },
      };
      try {
        assertSubAccountLifecycleMatrix(candidate);
      } catch {
        return refuse("held", "its lifecycle cannot take a spend checkpoint");
      }
      return { outcome: "committed", txHash: hash, candidate };
    }
    if (
      row.status === "spent" &&
      existing !== undefined &&
      row.lifecycle?.legacyTerminal === undefined &&
      existing.rawTx === spend.rawTx &&
      existing.txHash === spend.txHash &&
      existing.valueWei === spend.valueWei
    ) {
      return { outcome: "already-applied", txHash: hash };
    }
    return refuse(
      "held",
      `row is ${row.status}${
        existing === undefined ? "" : " with another spend checkpoint"
      }`
    );
  }

  /**
   * Pool entry for a wallet sync item (Ticket #1115, #1235). It never writes: a spend is recorded
   * only by the attached applier (`attachSpendApplier`), which is handed the item's complete
   * signed transaction after the item has been checked against it. The item's own `valueWei` is
   * never stored.
   *
   * Resolves with no affected index, having changed nothing, for an item that does not concern
   * this pool: one that is not an outgoing `wallet-sync` (an incoming item or a `payment-transfer`
   * never spends a pool account), one with no transaction whose spent inputs name no row here,
   * and a transaction not signed by a live row whose item names no row here either. Every other
   * item that does not commit is REJECTED
   * with `SubAccountSpendRefusedError`, nothing written: a spent input naming a row with no
   * transaction to prove it or with a transaction some other key signed, any transaction while
   * no applier is attached, a transaction that
   * does not parse or whose hash is not the item's, an item whose spent input, nonce, debit or
   * created output disagree with the transaction, and whatever the applier refuses. A matched row's capacity-cache entry is dropped before any rejection, so a drained
   * account is re-read before it is offered again. Repeating an applied item resolves with no
   * affected index.
   */
  async processSyncTransaction(item: {
    type?: string;
    direction: "in" | "out";
    chainIdentifier?: string;
    txHash?: string;
    rawTx?: string;
    spentInputs?: ReadonlyArray<{
      address: string;
      nonce?: number;
      valueWei?: string | bigint;
    }>;
    createdOutputs?: ReadonlyArray<{
      address: string;
      valueWei?: string | bigint;
    }>;
    timestamp?: number;
  }): Promise<{ affectedIndices: number[] }> {
    // Check 1: only an outgoing wallet-sync item can spend a pool account.
    if (item.type !== "wallet-sync" || item.direction !== "out") {
      return { affectedIndices: [] };
    }
    const sameAddress = (left: unknown, right: string) =>
      typeof left === "string" && left.toLowerCase() === right.toLowerCase();
    const spentInputs: ReadonlyArray<unknown> = Array.isArray(item.spentInputs)
      ? item.spentInputs
      : [];
    const named = this.store
      .getAll()
      .filter((record) =>
        spentInputs.some((input) =>
          sameAddress(
            (input as { address?: unknown } | null)?.address,
            record.address
          )
        )
      );
    // Before any rejection: whatever the item turns out to be, an account it names is re-read.
    for (const record of named) this.capacityCache.delete(record.index);
    const refuse = (
      code: SubAccountSpendRefusedError["code"],
      detail: string,
      index: number | undefined = named.length === 1 ? named[0]!.index : undefined
    ): never => {
      throw new SubAccountSpendRefusedError(code, index, detail);
    };

    // Check 3 (presence): without the complete signed transaction there is nothing to record. An
    // item that carries none and names no row of this pool is not about the pool at all (a native
    // send from the main account, say): nothing to refuse, nothing to write.
    const { rawTx, txHash } = item;
    if (rawTx === undefined || rawTx === null) {
      if (named.length === 0) return { affectedIndices: [] };
      return refuse(
        "missing-transaction",
        "the sync item carries no signed transaction (rawTx)"
      );
    }
    // No applier, no bytes: this pool cannot check the transaction's chain, so it commits nothing.
    const apply = this.spendApplier;
    if (apply === undefined) {
      return refuse(
        "no-applier",
        "this pool has no spend applier to check a signed transaction"
      );
    }
    if (
      typeof item.chainIdentifier !== "string" ||
      item.chainIdentifier.length === 0
    ) {
      return refuse("inconsistent-item", "the sync item names no chain");
    }
    if (
      typeof rawTx !== "string" ||
      rawTx.length > MAX_SPEND_RAW_TX_LENGTH ||
      !/^0x[0-9a-f]+$/.test(rawTx)
    ) {
      return refuse("invalid-transaction", "raw transaction is not bounded hex");
    }
    let transaction: Transaction;
    let hash: string | null;
    let from: string | null;
    try {
      transaction = Transaction.from(rawTx);
      ({ hash, from } = transaction);
    } catch {
      return refuse(
        "invalid-transaction",
        "raw transaction does not parse or its signature does not recover"
      );
    }
    if (hash === null || from === null) {
      return refuse("invalid-transaction", "transaction is unsigned");
    }
    const signer = from;
    // Check 5: the bytes are the transaction the item names.
    const hashOf = (value: string) => value.toLowerCase().replace(/^0x/, "");
    if (typeof txHash !== "string" || hashOf(txHash) !== hashOf(hash)) {
      return refuse(
        "inconsistent-item",
        "the signed transaction's hash is not the item's txHash"
      );
    }
    // Check 6: a transaction no live row signed spends no pool account. An item that names a row
    // of this pool as its spent input while carrying some other key's transaction contradicts
    // itself, exactly as it would without bytes: refused, not skipped.
    const row = this.store
      .getAll()
      .find((record) => sameAddress(record.address, signer));
    if (row === undefined) {
      if (named.length === 0) return { affectedIndices: [] };
      return refuse(
        "inconsistent-item",
        "the item names a pool row its transaction was not signed by"
      );
    }
    this.capacityCache.delete(row.index);
    // Check 7: the item's own account of the spend agrees with the transaction.
    const amount = (value: unknown): bigint | undefined =>
      typeof value === "bigint" && value >= 0n
        ? value
        : typeof value === "string" && /^[0-9]{1,78}$/.test(value)
        ? BigInt(value)
        : undefined;
    const inconsistent = (detail: string) =>
      refuse("inconsistent-item", detail, row.index);
    const input = spentInputs[0] as
      | { address?: unknown; nonce?: unknown; valueWei?: unknown }
      | null
      | undefined;
    if (spentInputs.length !== 1 || !sameAddress(input?.address, signer)) {
      return inconsistent(
        "spentInputs is not exactly one entry for the transaction's signer"
      );
    }
    if (input!.nonce !== undefined && input!.nonce !== transaction.nonce) {
      return inconsistent("the spent input's nonce is not the transaction's");
    }
    if (input!.valueWei !== undefined) {
      const debit = amount(input!.valueWei);
      const maximumFee =
        transaction.gasLimit *
        (transaction.maxFeePerGas ?? transaction.gasPrice ?? 0n);
      if (
        debit === undefined ||
        debit < transaction.value ||
        debit > transaction.value + maximumFee
      ) {
        return inconsistent(
          "the spent input's valueWei is not the transaction's value plus a fee it could have paid"
        );
      }
    }
    if (item.createdOutputs !== undefined) {
      const outputs: ReadonlyArray<unknown> = Array.isArray(item.createdOutputs)
        ? item.createdOutputs
        : [];
      const output = outputs[0] as
        | { address?: unknown; valueWei?: unknown }
        | null
        | undefined;
      if (
        outputs.length !== 1 ||
        transaction.to === null ||
        !sameAddress(output?.address, transaction.to) ||
        amount(output?.valueWei) !== transaction.value
      ) {
        return inconsistent(
          "createdOutputs is not exactly one entry to the transaction's recipient for its value"
        );
      }
    }

    const applied = await apply(rawTx, item.chainIdentifier);
    return {
      affectedIndices: applied.kind === "committed" ? [applied.poolIndex] : [],
    };
  }

  async recordRecoveryDisposition(
    index: number,
    recovery: SubAccountRecoveryDisposition
  ): Promise<void> {
    const existing = this.store.getByIndex(index);
    if (existing === undefined) {
      throw new Error(`No sub-account at index ${index} in the pool`);
    }
    await this.persistRecord({
      ...existing,
      lifecycle: { ...existing.lifecycle, recovery: { ...recovery } },
    });
  }

  terminalCheckpoints(): TerminalSubAccountCheckpoint[] {
    return this.store.getCheckpoints();
  }

  /**
   * Transitions a `funding` or `available` sub-account back to `status: "funding"` when a reorg
   * disconnects one or more previously included funding attempts.
   */
  async reconcileDisconnectedFunding(
    index: number,
    updatedAttempts: readonly SubAccountFundingAttempt[]
  ): Promise<boolean> {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new Error(`Invalid sub-account index: ${index}`);
    }
    const updated = await this.store.mutate<boolean>((snapshot) => {
      const current = snapshot.records.find((row) => row.index === index);
      if (
        !current ||
        !current.funding ||
        (current.status !== "funding" && current.status !== "available") ||
        current.lifecycle?.spend !== undefined
      ) {
        return { records: [], result: false };
      }
      const nextRecord: SubAccountRecord = {
        index: current.index,
        address: current.address,
        status: "funding",
        funding: {
          version: 1,
          attempts: updatedAttempts.map((entry) => ({
            ...entry,
            generation: (entry.generation ?? 1) + 1,
          })),
          ...(current.funding.hold !== undefined
            ? { hold: { ...current.funding.hold } }
            : {}),
        },
        ...(current.lifecycle !== undefined
          ? { lifecycle: current.lifecycle }
          : {}),
      };
      assertSubAccountLifecycleMatrix(nextRecord);
      return {
        records: [
          {
            record: nextRecord,
            expectedRevision: current.revision ?? 0,
          },
        ],
        result: true,
      };
    });
    if (updated) {
      this.capacityCache.delete(index);
      await this.store.flush();
    }
    return updated;
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
      const funding = record.funding;
      const { spend, recovery } = record.lifecycle ?? {};
      if (
        funding === undefined ||
        funding.hold !== undefined ||
        funding.attempts.some((entry) => entry.observation.kind === "unresolved") ||
        spend === undefined ||
        recovery === undefined
      ) {
        continue;
      }
      await this.store.mutate(() => ({
        checkpoints: [
          {
            expectedRevision: record.revision!,
            checkpoint: {
              version: 1,
              index: record.index,
              address: record.address,
              status: record.status as "spent" | "retired",
              denominationWei: spend.valueWei,
              funding,
              lifecycle: { spend, recovery },
              compactedAt: (params.now ?? Date.now)(),
            },
          },
        ],
        result: undefined,
      }));
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
    /** The smallest payment a message will make (the chain's fee for one transfer). When the
     * smaller account of a pair would hold less than this, a message could never pay from the
     * pair (it refuses a payment below its own fee), so ONE account is funded with the whole
     * stamp instead. The split exists to hide amounts, which a floor-sized stamp cannot. */
    minimumPaymentWei?: () => Promise<bigint>;
    /** The operation this inventory is for. The accounts that pay its stamp are claimed for it
     * (`claim`) the moment they are chosen, the ones being funded included, and are returned as
     * `claimed`: no other operation can take them between their funding and their use. On a
     * rejection nothing stays claimed. Without it the inventory is left free for any message. */
    claimFor?: string;
  }): Promise<StampInventoryPreparationResult> {
    const run = this.preparationQueue.then(async () => {
      try {
        return await this.prepareStampInventoryExclusive(params);
      } catch (error) {
        if (params.claimFor !== undefined) this.releaseClaim(params.claimFor);
        throw error;
      }
    });
    this.preparationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * The same preparation as `prepareStampInventory`, run AHEAD of a message instead of inside its
   * send, so the send finds its accounts ready. It is the same code and the same recorded path
   * (`fundAccount`: sign, write the `funding` row with the exact bytes, flush, submit, wait for
   * the receipt), on the same queue, with four differences:
   *
   * - An earlier `funding` row is looked at ONCE (its recorded bytes are offered again, never
   *   re-signed) instead of polled for a minute, and while any row is still `funding` afterwards
   *   the pass funds nothing (`unresolved-funding`). That look comes first: the fee reserve is
   *   not even quoted (`gasReserveWei` may be a function) until it has passed.
   * - It waits `FUND_AHEAD_RECEIPT_WAIT_MS` for each receipt of its own, not a minute.
   * - It funds the pair or the rest of a pair, never one account holding the whole stamp: when
   *   the main account cannot pay for that, it funds nothing (`insufficient-funds`).
   * - Bounded: at most `STAMP_PAIR_TRANSFERS` transfers, moving at most `maxValueWei` in total.
   *   A plan over either limit is refused before anything is signed (`over-bound`).
   * - A transfer whose maximum fee exceeds the value it moves is refused after signing and before
   *   it is written or submitted (`uneconomic`).
   * - Nothing is reported as progress: no message is waiting on it.
   *
   * One message only. The send selects greedily over every available account
   * (`selectStampAccounts`), so a second pre-funded pair is not kept for a second message: the
   * first message takes three accounts and strands part of one. Funding further ahead needs
   * selection that takes a pair at a time.
   *
   * Resolves with the hashes of transfers it confirmed (empty when inventory already sufficed).
   * Safe to repeat and to run beside a send: calls are serialized on the pool queue and each one
   * re-reads the rows, so a second call finds the first one's accounts and funds nothing.
   */
  async fundStampInventoryAhead(params: {
    mainAccountSigner: MonadAccountTxSigner;
    provider: Provider;
    stampValueWei: bigint;
    /** The reserve, or how to quote it once the pass knows it has something to fund. */
    gasReserveWei: bigint | (() => Promise<bigint>);
    /** Upper limit on the combined value of this pass's transfers (fees excluded). */
    maxValueWei: bigint;
    /** The smallest payment a message will make (the chain's fee for one transfer). When the
     * smaller account of a pair would hold less than this, a message could never pay from the
     * pair (it refuses a payment below its own fee), so ONE account is funded with the whole
     * stamp instead. The split exists to hide amounts, which a floor-sized stamp cannot. */
    minimumPaymentWei?: () => Promise<bigint>;
    fundingOverrides?: MonadTxOverrides;
    /** The wait for this pass's own receipts. Default: `FUND_AHEAD_RECEIPT_WAIT_MS`. */
    receipt?: FundingReceiptOptions;
  }): Promise<StampInventoryPreparationResult> {
    const { maxValueWei, gasReserveWei, ...rest } = params;
    const run = this.preparationQueue.then(async () => {
      const resumedTxHashes = await this.resumeFundingAttempts({
        mainAccountSigner: params.mainAccountSigner,
        receipt: { ...params.receipt, maxAttempts: 0 },
        quiet: true,
      });
      const unresolved = this.store
        .getAll()
        .filter((record) => record.status === "funding");
      if (unresolved.length > 0) {
        throw new FundAheadRefusedError(
          "unresolved-funding",
          `sub-account ${unresolved
            .map((record) => record.index)
            .join(", ")} has a funding transfer with no observed outcome`
        );
      }
      return this.prepareStampInventoryExclusive(
        {
          ...rest,
          gasReserveWei:
            typeof gasReserveWei === "function"
              ? await gasReserveWei()
              : gasReserveWei,
          receipt: params.receipt ?? {
            intervalMs: FUND_AHEAD_RECEIPT_POLL_MS,
            maxAttempts: FUND_AHEAD_RECEIPT_WAIT_MS / FUND_AHEAD_RECEIPT_POLL_MS,
          },
        },
        { maxValueWei, resumedTxHashes }
      );
    });
    this.preparationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async prepareStampInventoryExclusive(
    params: {
      mainAccountSigner: MonadAccountTxSigner;
      provider: Provider;
      stampValueWei: bigint;
      gasReserveWei: bigint;
      minimumPaymentWei?: () => Promise<bigint>;
      fundingOverrides?: MonadTxOverrides;
      onProgress?: (progress: StampInventoryPreparationProgress) => void;
      receipt?: FundingReceiptOptions;
      claimFor?: string;
    },
    /** Set for a pass that runs ahead of any message: see `fundStampInventoryAhead`, which has
     * already looked at every `funding` row and found none unresolved. */
    ahead?: { maxValueWei: bigint; resumedTxHashes: string[] }
  ): Promise<StampInventoryPreparationResult> {
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

    const fundingTxHashes =
      ahead === undefined
        ? await this.reconcileBeforePreparation(params)
        : [
            ...ahead.resumedTxHashes,
            ...(await this.reconcileBeforePreparation({
              ...params,
              resumed: true,
            })),
          ];

    const holder = params.claimFor;
    // With a holder, "ready" IS the claim: the same synchronous step decides and takes.
    const claimed = () =>
      holder === undefined
        ? undefined
        : this.claimStampAccounts(
            holder,
            params.stampValueWei,
            params.gasReserveWei
          );
    let accounts = await this.fundedCapacities(
      params.provider,
      params.gasReserveWei,
      { holder, fromBalance: holder !== undefined }
    );
    for (const account of accounts) {
      this.syncUtxo(
        account.index,
        "available",
        account.capacityWei + params.gasReserveWei
      );
    }
    let taken = claimed();
    let selection =
      holder !== undefined
        ? taken ?? []
        : this.selectFundedCapacity(params.stampValueWei, accounts);
    // Ready is what the payment intent accepts: any accounts that cover the value, one included.
    // Asking for a second account here when one already covers the stamp sent a wallet with
    // nothing left in its main account to fund a top-up it could not pay for.
    if (selection.length >= 1) {
      params.onProgress?.({ stage: "ready", fundingTxHashes });
      return {
        fundingTxHashes,
        selectedAccountCount: selection.length,
        ...(taken === undefined ? {} : { claimed: taken }),
      };
    }
    // What exists is part of this operation's payment from here on, with what is funded below.
    if (holder !== undefined)
      this.claim(holder, (free) => {
        const offered = new Set(free.map((record) => record.index));
        return accounts
          .filter((a) => a.capacityWei > zero && offered.has(a.index))
          .map((a) => a.index);
      });

    const firstCapacity = (params.stampValueWei * BigInt(3)) / BigInt(8);
    const preferredFirstCapacity =
      firstCapacity > zero ? firstCapacity : BigInt(1);
    const existingCapacity = accounts.reduce(
      (total, account) => total + account.capacityWei,
      zero
    );
    // Not ready, so what exists covers less than the value: fund the rest, or the whole pair.
    let capacities =
      existingCapacity > zero
        ? [params.stampValueWei - existingCapacity]
        : // A pair whose smaller account could not make a payment worth its fee is never
        // paid from: one account with the whole stamp instead.
        preferredFirstCapacity <
          ((await params.minimumPaymentWei?.()) ?? zero)
        ? [params.stampValueWei]
        : [
            preferredFirstCapacity,
            params.stampValueWei - preferredFirstCapacity,
          ].filter((capacity) => capacity > zero);

    if (ahead !== undefined) {
      const plannedValueWei = capacities.reduce(
        (total, capacity) => total + capacity + params.gasReserveWei,
        zero
      );
      if (
        capacities.length > STAMP_PAIR_TRANSFERS ||
        plannedValueWei > ahead.maxValueWei
      ) {
        throw new FundAheadRefusedError(
          "over-bound",
          `${capacities.length} transfers moving ${plannedValueWei} wei exceed ` +
            `${STAMP_PAIR_TRANSFERS} transfers or ${ahead.maxValueWei} wei`
        );
      }
    }

    const unfunded = this.store
      .getAll()
      .filter(
        (record) =>
          record.status === "unfunded" &&
          !this.isSpendReserved(record.index, holder)
      );
    while (unfunded.length < capacities.length) {
      const index = this.nextFreshIndex();
      const derived = this.keyring.deriveSubAccount(index);
      const record: SubAccountRecord = {
        index,
        address: derived.address,
        status: "unfunded",
      };
      await this.persistRecord(record);
      unfunded.push(record);
    }
    if (holder !== undefined) {
      const targets = unfunded.slice(0, capacities.length).map((r) => r.index);
      if (this.claim(holder, () => targets) === undefined)
        throw new Error("Funding targets could not be claimed");
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
    if (ahead !== undefined && requiredMainBalance > availableMainBalance) {
      throw new FundAheadRefusedError(
        "insufficient-funds",
        `need up to ${requiredMainBalance} wei, have ${availableMainBalance} wei`
      );
    }
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
      throw new InsufficientStampFundsError(
        "Insufficient main account balance to prepare stamp accounts: " +
          `need up to ${requiredMainBalance} wei, have ${availableMainBalance} wei`
      );
    }

    for (const [offset, paymentCapacityWei] of capacities.entries()) {
      if (offset > 0 && INTER_TX_FUNDING_DELAY_MS > 0) {
        // Monad testnet pipelined execution requires a brief delay between consecutive
        // funding transactions from the same account to avoid MIP-4 reserve balance violations.
        await new Promise((resolve) => setTimeout(resolve, INTER_TX_FUNDING_DELAY_MS));
      }
      const target = unfunded[offset];
      const result = await this.fundAccount({
        target,
        paymentCapacityWei,
        gasReserveWei: params.gasReserveWei,
        mainAccountSigner: params.mainAccountSigner,
        overrides: params.fundingOverrides,
        receipt: params.receipt,
        refuseUneconomic: ahead !== undefined,
        onSigned: (signedTx) =>
          params.onProgress?.({
            stage: "funding",
            completed: offset,
            total: capacities.length,
            feeReserveWei: params.gasReserveWei,
            txHash: signedTx.txHash,
          }),
      });
      this.syncUtxo(
        target.index,
        "available",
        paymentCapacityWei + params.gasReserveWei
      );
      fundingTxHashes.push(result.txHash);
      params.onProgress?.({
        stage: "funding",
        completed: offset + 1,
        total: capacities.length,
        feeReserveWei: params.gasReserveWei,
        txHash: result.txHash,
      });
    }

    accounts = await this.fundedCapacities(
      params.provider,
      params.gasReserveWei,
      { holder, fromBalance: holder !== undefined }
    );
    taken = claimed();
    selection =
      holder !== undefined
        ? taken ?? []
        : this.selectFundedCapacity(params.stampValueWei, accounts);
    if (selection.length === 0) {
      throw new Error(
        "Receipt-confirmed stamp accounts do not have enough current fee-adjusted capacity"
      );
    }
    if (holder !== undefined && taken !== undefined) {
      // Only what pays stays claimed; anything else this pass held goes back to being free.
      const paying = new Set(taken.map((account) => account.index));
      this.releaseClaim(
        holder,
        this.claimsOf(holder).filter((index) => !paying.has(index))
      );
    }
    params.onProgress?.({ stage: "ready", fundingTxHashes });
    return {
      fundingTxHashes,
      selectedAccountCount: selection.length,
      ...(taken === undefined ? {} : { claimed: taken }),
    };
  }

  private async promoteCompletedHeldFunding(index: number): Promise<void> {
    const record = this.store.getByIndex(index);
    if (
      record === undefined ||
      record.status !== "funding" ||
      record.funding?.hold === undefined ||
      record.funding.attempts.length !==
        record.funding.hold.expectedContributors ||
      !record.funding.attempts.every(
        (entry) =>
          entry.observation.kind === "included" &&
          entry.observation.execution === "success"
      )
    ) {
      return;
    }
    await this.store.mutate((snapshot) => {
      const current = snapshot.records.find((row) => row.index === index);
      if (
        current === undefined ||
        current.status !== "funding" ||
        current.funding?.hold === undefined ||
        current.funding.attempts.length !==
          current.funding.hold.expectedContributors ||
        !current.funding.attempts.every(
          (entry) =>
            entry.observation.kind === "included" &&
            entry.observation.execution === "success"
        )
      ) {
        return { records: [], result: current };
      }
      const nextRecord: SubAccountRecord = {
        ...current,
        status: "available",
        funding: cloneFundingCollection(current.funding, {
          preserveHold: true,
        }),
      };
      assertSubAccountLifecycleMatrix(nextRecord);
      return {
        records: [
          {
            record: nextRecord,
            expectedRevision: current.revision ?? 0,
          },
        ],
        result: nextRecord,
      };
    });
    await this.store.flush();
    this.syncUtxo(index, "available");
  }

  /**
   * Finishes every durable in-flight funding attempt it can: the exact recorded transaction is
   * offered again and its receipt read, never a second one signed for the same child. Returns the
   * hashes of the attempts that are now resolved; one that is not stays `funding`.
   */
  private async resumeFundingAttempts(params: {
    mainAccountSigner: MonadAccountTxSigner;
    receipt?: FundingReceiptOptions;
    /** A pass no message waits on repeats; it does not log each look at a pending transfer. */
    quiet?: boolean;
  }): Promise<string[]> {
    const fundingTxHashes: string[] = [];
    for (const record of this.store.getAll()) {
      if (record.status === "funding") {
        const unresolvedAttempts =
          record.funding?.attempts.filter(
            (entry) => entry.observation.kind === "unresolved"
          ) ?? [];
        if (
          record.funding !== undefined &&
          record.funding.attempts.length > 0 &&
          unresolvedAttempts.length === 0
        ) {
          await this.promoteCompletedHeldFunding(record.index);
          continue;
        }
        try {
          const txHash = await this.finishFundingAttempt(
            record,
            params.mainAccountSigner,
            params.receipt
          );
          fundingTxHashes.push(txHash);
          await this.promoteCompletedHeldFunding(record.index);
        } catch (err) {
          if (params.quiet !== true) {
            console.warn(
              `[EvmSubAccountPool] Skipping unconfirmed/timed out funding attempt for sub-account ${record.index}:`,
              err
            );
          }
        }
      }
    }
    return fundingTxHashes;
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
    /** The caller already ran `resumeFundingAttempts`; only the `available` rows are checked. */
    resumed?: boolean;
  }): Promise<string[]> {
    const fundingTxHashes =
      params.resumed === true ? [] : await this.resumeFundingAttempts(params);
    const allRecords = this.store.getAll();
    // A reserved row belongs to the native operation that spends from it until that resolves.
    // Retiring it here (a status with no checkpoint) would be a second writer of the same
    // account's state: the input admission then holds the address for the pool against the
    // native claim and reports `conflicting-authorization` for the whole wallet, across reopen.
    const availableRecords = allRecords.filter(
      (record) =>
        record.status === "available" && !this.isSpendReserved(record.index)
    );
    if (availableRecords.length > 0) {
      await Promise.all(
        availableRecords.map(async (record) => {
          const [balance, transactionCount] = await Promise.all([
            params.provider.getBalance(record.address),
            params.provider.getTransactionCount(record.address, "pending"),
          ]);
          // Claimed, leased or changed while the chain was being read: its holder owns it now.
          if (
            this.isSpendReserved(record.index) ||
            this.store.getByIndex(record.index)?.status !== "available"
          )
            return;
          if (transactionCount > 0 || balance <= params.gasReserveWei) {
            const { funding: existingFunding, ...base } = record;
            await this.persistRecord({
              ...base,
              status: "retired",
              ...(existingFunding === undefined
                ? {}
                : {
                    funding: cloneFundingCollection(existingFunding),
                  }),
            });
            this.capacityCache.delete(record.index);
          } else {
            this.capacityCache.set(record.index, {
              capacityWei: balance - params.gasReserveWei,
              checkedAtMs: Date.now(),
              balanceWei: balance,
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
    mainAccountAddress?: string;
    funders?: Array<{
      signer: MonadAccountTxSigner;
      amountWei: bigint;
      source?: "main" | "identity" | "coin";
    }>;
    provider: Provider;
    burnValueWei: bigint;
    gasReserveWei: bigint;
    fundingOverrides?: MonadTxOverrides;
    onProgress?: (progress: StampInventoryPreparationProgress) => void;
    receipt?: FundingReceiptOptions;
    /** The operation the burn account is for: the account is claimed for it (`claim`) when it is
     * chosen, before any funding, so nothing else takes it before the caller leases it. */
    claimFor?: string;
    /** Explicit durable operation id for resuming or holding a Forum preparation across restarts. */
    operationId?: string;
    /** Retain `funding.hold` on the prepared `available` row until Forum journal handoff completes. */
    retainPreparationHold?: boolean;
  }): Promise<BurnAccountPreparationResult> {
    const run = this.preparationQueue.then(async () => {
      try {
        return await this.prepareBurnAccountExclusive(params);
      } catch (error) {
        if (params.claimFor !== undefined) this.releaseClaim(params.claimFor);
        throw error;
      }
    });
    this.preparationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async prepareBurnAccountExclusive(params: {
    mainAccountSigner: MonadAccountTxSigner;
    mainAccountAddress?: string;
    funders?: Array<{
      signer: MonadAccountTxSigner;
      amountWei: bigint;
      source?: "main" | "identity" | "coin";
    }>;
    provider: Provider;
    burnValueWei: bigint;
    gasReserveWei: bigint;
    fundingOverrides?: MonadTxOverrides;
    onProgress?: (progress: StampInventoryPreparationProgress) => void;
    receipt?: FundingReceiptOptions;
    claimFor?: string;
    operationId?: string;
    retainPreparationHold?: boolean;
  }): Promise<BurnAccountPreparationResult> {
    const holder = params.claimFor ?? params.operationId;
    const explicitOperationId = params.operationId ?? params.claimFor;
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

    const existingHeld =
      explicitOperationId !== undefined
        ? this.getHeldPreparation(explicitOperationId)
        : undefined;
    if (existingHeld !== undefined && existingHeld.status === "available") {
      if (holder !== undefined) {
        this.claim(holder, () => [existingHeld.index]);
      }
      if (params.retainPreparationHold !== true) {
        await this.setStatus(existingHeld.index, "available", {
          clearHold: true,
        });
        await this.store.flush();
      }
      const combinedHashes = [
        ...new Set([
          ...fundingTxHashes,
          ...(existingHeld.funding?.attempts.map((a) => a.txHash) ?? []),
        ]),
      ];
      params.onProgress?.({ stage: "ready", fundingTxHashes: combinedHashes });
      return { index: existingHeld.index, fundingTxHashes: combinedHashes };
    }

    const funded =
      existingHeld !== undefined
        ? []
        : await this.fundedCapacities(params.provider, params.gasReserveWei, {
            holder,
          });
    // Chosen and claimed in one synchronous step.
    let reusable: { index: number } | undefined;
    const choose = (free?: readonly SubAccountRecord[]) => {
      const offered = free && new Set(free.map((record) => record.index));
      return funded
        .filter((account) => offered?.has(account.index) !== false)
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
    };
    if (existingHeld === undefined) {
      if (holder === undefined) reusable = choose();
      else
        this.claim(holder, (free) => {
          reusable = choose(free);
          return reusable === undefined ? undefined : [reusable.index];
        });
    }
    if (reusable !== undefined) {
      if (
        params.retainPreparationHold === true &&
        explicitOperationId !== undefined
      ) {
        const reusableRecord = this.store.getByIndex(reusable.index);
        if (
          reusableRecord?.funding !== undefined &&
          reusableRecord.funding.attempts.length > 0 &&
          reusableRecord.funding.attempts.every(
            (a) =>
              a.observation.kind === "included" &&
              a.observation.execution === "success"
          )
        ) {
          await this.store.mutate<SubAccountRecord | undefined>((snapshot) => {
            const current = snapshot.records.find(
              (row) => row.index === reusable!.index
            );
            if (!current || !current.funding) {
              return { records: [], result: current };
            }
            const nextRecord: SubAccountRecord = {
              ...current,
              funding: {
                version: 1,
                attempts: current.funding.attempts.map((entry) => ({
                  ...entry,
                })),
                hold: {
                  operationId: explicitOperationId,
                  expectedContributors: current.funding.attempts.length,
                  targetWei: String(
                    params.burnValueWei + params.gasReserveWei
                  ),
                  ...(this.expectedChainId !== undefined
                    ? { chainId: String(this.expectedChainId) }
                    : {}),
                },
              },
            };
            assertSubAccountLifecycleMatrix(nextRecord);
            return {
              records: [
                {
                  record: nextRecord,
                  expectedRevision: current.revision ?? 0,
                },
              ],
              result: nextRecord,
            };
          });
          await this.store.flush();
        }
      }
      params.onProgress?.({ stage: "ready", fundingTxHashes });
      return { index: reusable.index, fundingTxHashes };
    }

    let target: SubAccountRecord | undefined = existingHeld;
    if (target === undefined) {
      target = this.store
        .getAll()
        .find(
          (record) =>
            record.status === "unfunded" &&
            !this.isSpendReserved(record.index, holder)
        );
    }
    if (holder !== undefined && target !== undefined) {
      const index = target.index;
      this.claim(holder, () => [index]);
    }
    if (target === undefined) {
      const index = this.nextFreshIndex();
      target = {
        index,
        address: this.keyring.deriveSubAccount(index).address,
        status: "unfunded",
      };
      await this.persistRecord(target);
      if (holder !== undefined) this.claim(holder, () => [index]);
      await this.store.flush();
    }

    if (params.funders && params.funders.length > 1) {
      const startOffset =
        existingHeld !== undefined &&
        existingHeld.status === "funding" &&
        existingHeld.funding?.hold?.operationId ===
          (explicitOperationId ?? `burn-multi:${target.index}`) &&
        existingHeld.funding.hold.expectedContributors === params.funders.length
          ? existingHeld.funding.attempts.length
          : 0;
      for (const funder of params.funders.slice(startOffset)) {
        const available = await params.provider.getBalance(
          funder.signer.address,
          "pending"
        );
        const required = await this.requiredFundingBalance({
          capacities: [funder.amountWei],
          targets: [target],
          fromAddress: funder.signer.address,
          gasReserveWei: 0n,
          provider: params.provider,
          overrides: params.fundingOverrides,
        });
        if (required > available) {
          const isMain =
            (params.mainAccountAddress ?? this.mainAccountAddress) === undefined ||
            (params.mainAccountAddress ?? this.mainAccountAddress)!.toLowerCase() ===
              funder.signer.address.toLowerCase();
          const prefix = isMain
            ? "Insufficient main account balance to prepare a burn account: "
            : "Insufficient balance to prepare a burn account: ";
          throw new InsufficientStampFundsError(
            `${prefix}need up to ${required} wei, have ${available} wei`
          );
        }
      }

      const operationId = explicitOperationId ?? `burn-multi:${target.index}`;
      const hold: SubAccountFundingHold = {
        operationId,
        expectedContributors: params.funders.length,
        ...(params.retainPreparationHold === true
          ? {
              targetWei: String(params.burnValueWei + params.gasReserveWei),
              ...(this.expectedChainId !== undefined
                ? { chainId: String(this.expectedChainId) }
                : {}),
              requirements: params.funders.map((f) => ({
                funder: getAddress(f.signer.address),
                valueWei: String(f.amountWei),
              })),
            }
          : {}),
      };
      for (let offset = startOffset; offset < params.funders.length; offset++) {
        const funder = params.funders[offset]!;
        // Capture before spacing/signing can yield. Completion must compare this exact row,
        // rather than adopting a lease or lifecycle transition that won while signing waited.
        const currentTarget = this.store.getByIndex(target.index);
        if (
          currentTarget === undefined ||
          currentTarget.status !== (offset === 0 ? "unfunded" : "funding") ||
          this.isSpendReserved(target.index, holder) ||
          (offset > 0 &&
            (currentTarget.funding?.hold?.operationId !== operationId ||
              currentTarget.funding?.hold?.expectedContributors !==
                params.funders.length ||
              currentTarget.funding.attempts.length !== offset ||
              !currentTarget.funding.attempts.every(
                (entry) =>
                  entry.observation.kind === "included" &&
                  entry.observation.execution === "success"
              )))
        ) {
          throw new Error(`Funding target ${target.index} is no longer available to this preparation`);
        }
        if (offset > 0 && INTER_TX_FUNDING_DELAY_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, INTER_TX_FUNDING_DELAY_MS));
        }
        await this.funderSpacing?.(funder.signer.address);
        const signedTx = await funder.signer.buildAndSignTransfer(
          target.address,
          funder.amountWei,
          params.fundingOverrides
        );
        await this.registerFundingAttempt({
          index: target.index,
          rawTx: signedTx.rawTx,
          txHash: signedTx.txHash,
          funder: funder.signer.address,
          hold,
          expectedRevision: currentTarget.revision ?? 0,
        });
        await this.store.flush();
        params.onProgress?.({
          stage: "funding",
          completed: offset,
          total: params.funders.length,
          feeReserveWei: params.gasReserveWei,
          txHash: signedTx.txHash,
        });
        await funder.signer.submit(signedTx);
        const txHash = await this.finishFundingAttempt(
          this.store.getByIndex(target.index) as SubAccountRecord,
          funder.signer,
          params.receipt,
          false,
          signedTx.txHash
        );
        fundingTxHashes.push(txHash);
        params.onProgress?.({
          stage: "funding",
          completed: offset + 1,
          total: params.funders.length,
          feeReserveWei: params.gasReserveWei,
          txHash,
        });
      }

      const expectedContributors = params.funders.length;
      await this.store.mutate((snapshot) => {
        const current = snapshot.records.find((row) => row.index === target!.index);
        if (
          current === undefined ||
          (current.status !== "funding" && current.status !== "available") ||
          current.funding === undefined ||
          current.funding.hold?.operationId !== operationId ||
          current.funding.hold.expectedContributors !== expectedContributors ||
          current.funding.attempts.length !== expectedContributors ||
          !current.funding.attempts.every(
            (entry) =>
              entry.observation.kind === "included" &&
              entry.observation.execution === "success"
          )
        ) {
          throw new Error(
            `Multi-funder preparation for sub-account ${target!.index} cannot complete without all verified contributors`
          );
        }
        const completedRecord: SubAccountRecord = {
          ...current,
          status: "available",
          funding: {
            version: 1,
            attempts: current.funding.attempts.map((entry) => ({ ...entry })),
            ...(params.retainPreparationHold === true &&
            current.funding.hold !== undefined
              ? {
                  hold: {
                    ...current.funding.hold,
                    ...(current.funding.hold.requirements !== undefined
                      ? {
                          requirements: current.funding.hold.requirements.map(
                            (req) => ({ ...req })
                          ),
                        }
                      : {}),
                  },
                }
              : {}),
          },
        };
        assertSubAccountLifecycleMatrix(completedRecord);
        return {
          records: [
            {
              record: completedRecord,
              expectedRevision: current.revision ?? 0,
            },
          ],
          result: completedRecord,
        };
      });
      await this.store.flush();

      const totalFunded = params.burnValueWei + params.gasReserveWei;
      this.capacityCache.set(target.index, {
        capacityWei: params.burnValueWei,
        checkedAtMs: Date.now(),
        balanceWei: totalFunded,
      });
      this.syncUtxo(target.index, "available", totalFunded);
      params.onProgress?.({ stage: "ready", fundingTxHashes });
      return { index: target.index, fundingTxHashes };
    }

    const funderSigner = params.funders?.[0]?.signer ?? params.mainAccountSigner;
    const availableMainBalance = await params.provider.getBalance(
      funderSigner.address,
      "pending"
    );
    const requiredMainBalance = await this.requiredFundingBalance({
      capacities: [params.burnValueWei],
      targets: [target],
      fromAddress: funderSigner.address,
      gasReserveWei: params.gasReserveWei,
      provider: params.provider,
      overrides: params.fundingOverrides,
    });
    if (requiredMainBalance > availableMainBalance) {
      const isMain =
        (params.mainAccountAddress ?? this.mainAccountAddress) === undefined ||
        (params.mainAccountAddress ?? this.mainAccountAddress)!.toLowerCase() ===
          funderSigner.address.toLowerCase();
      const prefix = isMain
        ? "Insufficient main account balance to prepare a burn account: "
        : "Insufficient balance to prepare a burn account: ";
      throw new InsufficientStampFundsError(
        `${prefix}need up to ${requiredMainBalance} wei, have ${availableMainBalance} wei`
      );
    }

    const singleHold: SubAccountFundingHold | undefined =
      params.retainPreparationHold === true
        ? {
            operationId: explicitOperationId ?? `burn-single:${target.index}`,
            expectedContributors: 1,
            targetWei: String(params.burnValueWei + params.gasReserveWei),
            ...(this.expectedChainId !== undefined
              ? { chainId: String(this.expectedChainId) }
              : {}),
            requirements: [
              {
                funder: getAddress(funderSigner.address),
                valueWei: String(params.burnValueWei + params.gasReserveWei),
              },
            ],
          }
        : undefined;

    const result = await this.fundAccount({
      target,
      paymentCapacityWei: params.burnValueWei,
      gasReserveWei: params.gasReserveWei,
      mainAccountSigner: funderSigner,
      overrides: params.fundingOverrides,
      receipt: params.receipt,
      hold: singleHold,
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
        (await params.provider
          .estimateGas({
            from: params.fromAddress,
            to: target.address,
            value: fundedValue,
          })
          .catch(() => BigInt(21_000)));
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

  /**
   * What each `available`, unreserved account could pay after keeping `gasReserveWei` for its own
   * fee. Balances are read once and remembered for `CAPACITY_CACHE_TTL_MS`.
   *
   * `options.fromBalance` answers for THIS reserve from the remembered balance. Without it a
   * remembered answer is returned as it was computed, which may have been for another reserve
   * (funding records the capacity it intended, at the fee quoted then).
   * `options.maxCacheAgeMs` replaces the remembered balance's lifetime: `Infinity` re-reads only
   * accounts this process has never read.
   */
  async fundedCapacities(
    provider: Provider,
    gasReserveWei: bigint,
    options: {
      fromBalance?: boolean;
      maxCacheAgeMs?: number;
      /** Also count the accounts this operation has claimed. */
      holder?: string;
    } = {}
  ): Promise<Array<{ index: number; address: string; capacityWei: bigint }>> {
    const maxCacheAgeMs = options.maxCacheAgeMs ?? CAPACITY_CACHE_TTL_MS;
    const availableRecords = this.store
      .getAll()
      .filter(
        (record) =>
          record.status === "available" &&
          !this.isSpendReserved(record.index, options.holder)
      );
    if (availableRecords.length === 0) {
      return [];
    }

    const now = Date.now();
    const uncachedRecords: SubAccountRecord[] = [];

    for (const record of availableRecords) {
      const cached = this.capacityCache.get(record.index);
      if (
        cached === undefined ||
        now - cached.checkedAtMs >= maxCacheAgeMs ||
        (options.fromBalance === true && cached.balanceWei === undefined)
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
        this.capacityCache.set(record.index, {
          capacityWei,
          checkedAtMs,
          balanceWei: balance,
        });
      }
    }

    const accounts: Array<{
      index: number;
      address: string;
      capacityWei: bigint;
    }> = [];
    for (const record of availableRecords) {
      const cached = this.capacityCache.get(record.index);
      const balanceWei =
        options.fromBalance === true ? cached?.balanceWei : undefined;
      accounts.push({
        index: record.index,
        address: record.address,
        capacityWei:
          balanceWei !== undefined
            ? balanceWei > gasReserveWei
              ? balanceWei - gasReserveWei
              : BigInt(0)
            : cached !== undefined
            ? cached.capacityWei
            : BigInt(0),
      });
    }
    return accounts;
  }

  /**
   * What the `available`, unreserved accounts hold between them: the funded sending accounts'
   * part of the wallet's balance. For display. A balance read within `maxCacheAgeMs` is used
   * as remembered; another is read and NOT remembered (the remembered capacities belong to the
   * payment path and its own fee reserve).
   */
  async availableBalanceTotal(
    provider: Provider,
    maxCacheAgeMs: number
  ): Promise<bigint> {
    const now = Date.now();
    const balances = await Promise.all(
      this.store
        .getAll()
        .filter(
          (record) =>
            record.status === "available" && !this.isSpendReserved(record.index)
        )
        .map((record) => {
          const cached = this.capacityCache.get(record.index);
          return cached?.balanceWei !== undefined &&
            now - cached.checkedAtMs < maxCacheAgeMs
            ? cached.balanceWei
            : provider.getBalance(record.address);
        })
    );
    return balances.reduce((sum, balance) => sum + balance, BigInt(0));
  }

  /**
   * Whether a stamp of `stampValueWei` can be paid now without funding anything: the accounts that
   * are `available`, unreserved and not in `heldIndices` cover it between them, each keeping
   * `feeReserveWei` for its own fee. That is exactly what the payment intent accepts, whether it
   * takes one account or several, so a send this passes is never sent to fund a top-up.
   * Makes no request for an account whose balance is remembered (see `fundedCapacities`).
   */
  async hasStampInventory(params: {
    provider: Provider;
    stampValueWei: bigint;
    feeReserveWei: bigint;
    /** Accounts another operation holds although their row still reads `available`. */
    heldIndices?: ReadonlySet<number>;
    maxCacheAgeMs?: number;
  }): Promise<boolean> {
    const accounts = (
      await this.fundedCapacities(params.provider, params.feeReserveWei, {
        fromBalance: true,
        maxCacheAgeMs: params.maxCacheAgeMs,
      })
    ).filter((account) => params.heldIndices?.has(account.index) !== true);
    return (
      accounts.reduce((sum, account) => sum + account.capacityWei, BigInt(0)) >=
      params.stampValueWei
    );
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

  /** Confirms that the authoritative committed row still owns these exact bytes before a
   * rebroadcast. Identical replay preserves its revision; an uncertain store refuses access. */
  private async persistFundingAttemptBeforeResubmit(
    index: number,
    attempt: SubAccountFundingAttempt
  ): Promise<void> {
    const current = this.store.getByIndex(index);
    const currentAttempt = current?.funding?.attempts.find(
      (entry) => entry.txHash === attempt.txHash
    );
    if (
      current?.status !== "funding" ||
      currentAttempt === undefined ||
      currentAttempt.rawTx !== attempt.rawTx
    ) {
      throw new Error(
        `Sub-account ${index} no longer records funding transaction ${attempt.txHash}`
      );
    }
    await this.persistRecord(current);
    await this.store.flush();
  }

  private async finishFundingAttempt(
    record: SubAccountRecord,
    signer: MonadAccountTxSigner,
    options?: FundingReceiptOptions,
    resubmit = true,
    targetTxHash?: string
  ): Promise<string> {
    const currentRecord = this.store.getByIndex(record.index) ?? record;
    const attempts = currentRecord.funding?.attempts ?? [];
    const attempt =
      targetTxHash !== undefined
        ? attempts.find((entry) => entry.txHash === targetTxHash)
        : attempts.find((entry) => entry.observation.kind === "unresolved") ??
          attempts[attempts.length - 1];
    if (currentRecord.status !== "funding" || attempt === undefined) {
      throw new Error(
        `Sub-account ${record.index} has no durable funding attempt`
      );
    }

    const parsedTx = Transaction.from(attempt.rawTx);
    if (!parsedTx.from) {
      throw new Error(`Funding transaction ${attempt.txHash} is unsigned`);
    }
    const funder = parsedTx.from;
    const chainId = this.expectedChainId ?? parsedTx.chainId;

    const captureGeneration = (): number => {
      const beforeRow = this.store.getByIndex(record.index);
      const beforeAttempt = beforeRow?.funding?.attempts.find(
        (entry) => entry.txHash === attempt.txHash
      );
      if (
        beforeRow === undefined ||
        beforeAttempt === undefined ||
        beforeAttempt.rawTx !== attempt.rawTx
      ) {
        throw new Error(
          `Sub-account ${record.index} no longer records funding transaction ${attempt.txHash}`
        );
      }
      return beforeAttempt.generation;
    };

    const recordCapturedObservation = async (
      capturedGeneration: number,
      rawObserved: EvmFundingObservation
    ): Promise<SubAccountFundingObservation> => {
      const observation = normalizeFundingObservation(rawObserved);
      await this.recordFundingObservation({
        index: record.index,
        txHash: attempt.txHash,
        rawTx: attempt.rawTx,
        expectedGeneration: capturedGeneration,
        observation,
      });
      await this.store.flush();
      return observation;
    };

    const observeAndRecord = async (): Promise<SubAccountFundingObservation> => {
      const capturedGeneration = captureGeneration();
      const rawObserved = await signer.observeFunding({
        rawTx: attempt.rawTx,
        txHash: attempt.txHash,
        funder,
        recipient: record.address,
        chainId,
      });
      return recordCapturedObservation(capturedGeneration, rawObserved);
    };

    // Monad confirms substantially faster than the two-second cadence inherited from the
    // original EVM bring-up. A Send commonly prepares two accounts, so that cadence added several
    // seconds of avoidable UI latency. Poll four times per second while retaining the same
    // one-minute default timeout budget for congested or unhealthy RPCs.
    const maxAttempts = options?.maxAttempts ?? 240;
    const intervalMs = options?.intervalMs ?? 250;
    const sleep =
      options?.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    let observed: SubAccountFundingObservation;
    if (resubmit) {
      const capturedGeneration = captureGeneration();
      const rawObserved = await signer.observeFunding({
        rawTx: attempt.rawTx,
        txHash: attempt.txHash,
        funder,
        recipient: record.address,
        chainId,
      });
      if (
        rawObserved.kind === "included" ||
        (rawObserved.kind === "unresolved" && rawObserved.reason === "unavailable")
      ) {
        observed = await recordCapturedObservation(capturedGeneration, rawObserved);
      } else {
        await this.persistFundingAttemptBeforeResubmit(record.index, attempt);
        // An already-known/nonce-too-low response is compatible with a prior successful broadcast;
        // the receipt, never the resend response, decides eligibility.
        await signer
          .submitRaw(attempt.rawTx, attempt.txHash)
          .catch(() => undefined);
        observed =
          maxAttempts === 0
            ? await observeAndRecord()
            : { kind: "unresolved", reason: "pending" };
      }
    } else {
      observed = await observeAndRecord();
    }

    for (
      let attemptNumber = 0;
      observed.kind === "unresolved" &&
        observed.reason !== "unavailable" &&
        attemptNumber < maxAttempts;
      attemptNumber++
    ) {
      if (attemptNumber > 0 || resubmit) await sleep(intervalMs);
      observed = await observeAndRecord();
    }

    if (observed.kind === "unresolved") {
      throw new Error(
        `Funding transaction ${attempt.txHash} is still pending (${observed.reason})`
      );
    }
    if (observed.kind === "superseded") {
      throw new Error(
        `Funding transaction ${attempt.txHash} was superceded by a later nonce and sub-account ${record.index} was retired`
      );
    }
    if (observed.execution === "failure") {
      throw new Error(`Funding transaction ${attempt.txHash} failed`);
    }
    return attempt.txHash;
  }

  private async fundAccount(params: {
    target: Pick<SubAccountRecord, "index" | "address">;
    paymentCapacityWei: bigint;
    gasReserveWei: bigint;
    mainAccountSigner: MonadAccountTxSigner;
    overrides?: MonadTxOverrides;
    receipt?: FundingReceiptOptions;
    hold?: SubAccountFundingHold;
    /** Refuse, before anything is written or submitted, a transfer whose maximum fee exceeds the
     * value it moves. The signature is discarded. */
    refuseUneconomic?: boolean;
    onSigned?: (signedTx: SignedMonadTx) => void;
  }): Promise<FanOutFundingResult> {
    const fundingTarget = this.store.getByIndex(params.target.index);
    if (!fundingTarget) throw new Error("Funding target disappeared");
    const fundedValue = params.paymentCapacityWei + params.gasReserveWei;
    // Two funding transfers in a row come from one account: the chain's spacing rule between
    // them (Monad reverts the second otherwise) is waited out before each is signed.
    await this.funderSpacing?.(params.mainAccountSigner.address);
    const signedTx = await params.mainAccountSigner.buildAndSignTransfer(
      params.target.address,
      fundedValue,
      params.overrides
    );
    if (params.refuseUneconomic === true) {
      const feePerGas = signedTx.maxFeePerGas ?? signedTx.gasPrice;
      if (
        feePerGas === undefined ||
        signedTx.gasLimit * feePerGas > signedTx.value
      ) {
        throw new FundAheadRefusedError(
          "uneconomic",
          `funding sub-account ${params.target.index} could cost ${
            feePerGas === undefined ? "an unknown fee" : signedTx.gasLimit * feePerGas
          } wei to move ${signedTx.value} wei`
        );
      }
    }
    await this.registerFundingAttempt({
      index: params.target.index,
      rawTx: signedTx.rawTx,
      txHash: signedTx.txHash,
      funder: params.mainAccountSigner.address,
      hold: params.hold,
      expectedRevision: fundingTarget.revision ?? 0,
    });
    // The exact signed transaction is durable before it can reach the RPC.
    await this.store.flush();
    params.onSigned?.(signedTx);
    await params.mainAccountSigner.submit(signedTx);
    const txHash = await this.finishFundingAttempt(
      this.store.getByIndex(params.target.index) as SubAccountRecord,
      params.mainAccountSigner,
      params.receipt,
      false,
      signedTx.txHash
    );
    if (params.hold !== undefined) {
      await this.promoteCompletedHeldFunding(params.target.index);
    }
    this.capacityCache.set(params.target.index, {
      capacityWei: params.paymentCapacityWei,
      checkedAtMs: Date.now(),
      balanceWei: fundedValue,
    });
    this.syncUtxo(params.target.index, "available", fundedValue);
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
   * `evm-account-lease.ts`), so this "round-robin" is really just "pick whichever currently-funded
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
      if (
        candidate.status === "available" &&
        !this.isSpendReserved(candidate.index)
      ) {
        this.lastSelectedIndex = candidatePosition;
        return candidate;
      }
    }
    return undefined;
  }

  /** The next sub-account index that has never been derived/persisted into this pool yet — i.e.
   * one past the highest index currently in the store, or `0` for an empty pool. Ticket #34's
   * growth mechanism (`topUpPool`) derives from here rather than from any fixed `ensureSize()`
   * bound, so the pool can keep extending indefinitely as accounts get spent. */
  private nextFreshIndex(): number { return this.store.getNextIndex(); }

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
        const unresolvedAttempts =
          record.funding?.attempts.filter(
            (entry) => entry.observation.kind === "unresolved"
          ) ?? [];
        if (
          record.funding !== undefined &&
          record.funding.attempts.length > 0 &&
          unresolvedAttempts.length === 0
        ) {
          await this.promoteCompletedHeldFunding(record.index);
          continue;
        }
        await this.finishFundingAttempt(
          record,
          params.mainAccountSigner,
          params.receipt
        );
        await this.promoteCompletedHeldFunding(record.index);
      }
    }

    const currentlyAvailable = this.store
      .getAll()
      .filter(
        (record) =>
          record.status === "available" && record.funding?.hold === undefined
      ).length;
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
      await this.persistRecord(target);
      targets.push(target);
    }
    await this.store.flush();

    const results: FanOutFundingResult[] = [];
    for (const [offset, target] of targets.entries()) {
      if (offset > 0 && INTER_TX_FUNDING_DELAY_MS > 0) {
        // Monad testnet pipelined execution requires a brief delay between consecutive
        // funding transactions from the same account to avoid MIP-4 reserve balance violations.
        await new Promise((resolve) => setTimeout(resolve, INTER_TX_FUNDING_DELAY_MS));
      }
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
    checkedAtMs = Date.now(),
    balanceWei?: bigint
  ): void {
    this.capacityCache.set(index, { capacityWei, checkedAtMs, balanceWei });
  }
}

export { EvmSubAccountPool as MonadSubAccountPool };
