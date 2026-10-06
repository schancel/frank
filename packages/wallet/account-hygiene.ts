/**
 * Chain-neutral account hygiene and dirty-account sweeping interface.
 *
 * Encapsulation Principle (Ticket #925):
 * Callers, frontends, bots, and protocol services (forum, messaging, game escrows) must NEVER
 * manage nonces, UTXOs, dirty states, or sweeps directly. All rotation, hygiene tracking, and
 * background dust consolidation must remain completely internal to the chain's wallet backend.
 *
 * To the caller, the wallet exposes clean high-level capabilities (spend, burn, getBalance)
 * while maintaining UTXO/account hygiene autonomously behind the scenes.
 */

export type ChainDirtyReason =
  | 'nonce-incremented'   // EVM / account-based: nonce >= 1
  | 'output-spent'        // UTXO-based: output consumed
  | 'transaction-signed'  // Solana / keypair-based: keypair signed/used
  | 'manual-flag';

export interface DirtyAccountRecord<TAddress = string> {
  readonly address: TAddress;
  readonly dirtySinceTimestamp: number;
  readonly reason: ChainDirtyReason;
  readonly metadata?: Record<string, unknown>;
}

export type SweepOutcome =
  | 'swept'
  | 'below-dust'
  | 'in-flight'
  | 'error'
  | 'not-eligible';

export interface SweepResult<TAddress = string> {
  readonly sourceAddress: TAddress;
  readonly destinationAddress?: TAddress;
  readonly amountSwept: bigint;
  readonly txId?: string;
  readonly outcome: SweepOutcome;
  readonly error?: Error;
}

export interface AccountHygieneOptions {
  /** Interval in milliseconds between background sweep checks (default: 45,000ms). */
  readonly sweepIntervalMs?: number;
  /** Maximum randomized jitter in milliseconds added to sweep intervals to defeat timing analysis (default: 15,000ms). */
  readonly jitterMaxMs?: number;
  /** Minimum balance threshold required to trigger a sweep (overriding chain defaults). */
  readonly minSweepBalance?: bigint;
  /** Maximum number of dirty accounts to sweep in a single execution pass (default: 10). */
  readonly maxSweepsPerRun?: number;
  /** Whether the background worker starts automatically upon instantiation (default: false). */
  readonly autoStartWorker?: boolean;
}

export interface HygieneStats {
  readonly trackedDirtyCount: number;
  readonly totalSweptWei: bigint;
  readonly totalSweptCount: number;
  readonly lastSweepTimestamp?: number;
}

/**
 * Universal chain-agnostic interface for account hygiene and dirty account rotation.
 * Encapsulated completely beneath the Wallet API.
 */
export interface AccountHygieneEngine<TAddress = string> {
  /**
   * Internal hook: records that an address has been used/spent and is now dirty.
   * Typically called automatically on transaction submission.
   */
  markDirty(
    address: TAddress,
    reason?: ChainDirtyReason,
    metadata?: Record<string, unknown>,
  ): Promise<void> | void;

  /** Checks if an address is currently flagged as dirty. */
  isDirty(address: TAddress): Promise<boolean> | boolean;

  /** Unmarks an address as dirty (e.g. once fully drained or retired). */
  unmarkDirty(address: TAddress): Promise<void> | void;

  /** Returns all active dirty accounts currently tracked by this engine. */
  getDirtyAccounts(): Promise<ReadonlyArray<DirtyAccountRecord<TAddress>>>;

  /**
   * Executes a sweep pass across eligible dirty accounts, transferring residual balance
   * to fresh derived change addresses.
   */
  sweepDirtyAccounts(options?: {
    maxSweeps?: number;
    force?: boolean;
  }): Promise<ReadonlyArray<SweepResult<TAddress>>>;

  /** Starts the autonomous background sweep timer with randomized jitter. */
  startBackgroundWorker(): void;

  /** Stops the autonomous background sweep timer. */
  stopBackgroundWorker(): void;

  /** Returns whether the background worker is currently active. */
  isBackgroundWorkerActive(): boolean;

  /** Returns lifetime hygiene and sweep statistics. */
  getHygieneStats(): Promise<HygieneStats>;
}

/**
 * Capability interface for wallets that provide encapsulated account hygiene.
 */
export interface WalletWithHygiene<TAddress = string> {
  readonly hygiene?: AccountHygieneEngine<TAddress>;
}
