import type {
  EvmFundingAccounts,
  EvmFundingObservation,
  SignedMonadTx,
} from "./monad-account-tx";
import type { SelectedStampAccount } from "./monad-stamp-account-selection";
import type {
  SubAccountFundingAccounts,
  SubAccountFundingAttempt,
  SubAccountFundingBlock,
  SubAccountFundingCollection,
  SubAccountFundingHold,
  SubAccountFundingObservation,
  SubAccountPoolStore,
  SubAccountRecoveryDisposition,
  SubAccountRecord,
  SubAccountStatus,
  TerminalSubAccountCheckpoint,
} from "./storage/sub-account-pool-storage";

export type {
  SubAccountFundingAccounts,
  SubAccountFundingAttempt,
  SubAccountFundingBlock,
  SubAccountFundingCollection,
  SubAccountFundingHold,
  SubAccountFundingObservation,
  SubAccountPoolStore,
  SubAccountRecoveryDisposition,
  SubAccountRecord,
  SubAccountStatus,
  TerminalSubAccountCheckpoint,
};

/** Default target number of pre-funded, unused (`'available'`) sub-accounts `topUpPool()` tries to
 * maintain ahead of demand when the caller doesn't specify its own `bufferSize`. */
export const DEFAULT_TOPUP_BUFFER_SIZE = 5;

export const CAPACITY_CACHE_TTL_MS = 30_000;
export const INTER_TX_FUNDING_DELAY_MS =
  process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID !== undefined
    ? 0
    : 2000;

export interface SubAccountCapacityCacheEntry {
  capacityWei: bigint;
  checkedAtMs: number;
  balanceWei?: bigint;
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
  /** With `claimFor`: the accounts now claimed for that operation, and what each pays. */
  claimed?: SelectedStampAccount[];
  fundingTxHashes: string[];
  selectedAccountCount: number;
}

/** How many transfers one message's stamp accounts take: the 3/8 + 5/8 pair. */
export const STAMP_PAIR_TRANSFERS = 2;

/**
 * How long a fund-ahead pass waits for the receipt of a transfer it submitted: 12 looks, 250 ms
 * apart. It holds the wallet's queues while it waits, and nobody asked for it, so it does not
 * take the minute a send gives its own funding. When the wait ends the row stays `funding` with
 * its recorded bytes, and the next pass or the next send finishes that same transfer.
 */
export const FUND_AHEAD_RECEIPT_POLL_MS = 250;
export const FUND_AHEAD_RECEIPT_WAIT_MS = 3_000;

/**
 * Why a fund-ahead pass (`MonadSubAccountPool.fundStampInventoryAhead`) moved nothing more. Thrown
 * before the transfer concerned is written or submitted: a signature made for it is discarded.
 * - `unresolved-funding`: an earlier funding transfer has no observed outcome. Nothing is funded
 *   on top of an unknown; the pass only looked at it once and offered its exact bytes again.
 * - `over-bound`: the planned transfers exceed the pass's count or value limit.
 * - `uneconomic`: a transfer's maximum fee exceeds the value it would move.
 * - `insufficient-funds`: the main account cannot pay for what is missing (the whole pair, or the
 *   rest of one). A pass never settles for one account holding the whole stamp: that is a send's
 *   own last resort, and the money it needs is left where the send can use it.
 */
export class FundAheadRefusedError extends Error {
  constructor(
    readonly code:
      | "unresolved-funding"
      | "over-bound"
      | "uneconomic"
      | "insufficient-funds",
    detail: string
  ) {
    super(`Funding ahead refused (${code}): ${detail}`);
    this.name = "FundAheadRefusedError";
  }
}

/** The wallet cannot pay for this: its funded accounts do not cover the value and its main
 * account cannot fund more. Nothing was signed; nothing stays claimed. */
export class InsufficientStampFundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientStampFundsError";
  }
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

/** The native journal's bound on a signed transaction's hex string: its unsigned bound plus the
 * signature allowance (`storage/evm-native-operation-journal.ts`). */
export const MAX_SPEND_RAW_TX_LENGTH = 64 * 1024 + 256;

/** `committed`: this call wrote the checkpoint and `spent`. `already-applied`: the row already
 * carries exactly this transaction. `no-row`: the pool has no row at that index. */
export type SubAccountSpendOutcome = "committed" | "already-applied" | "no-row";

export interface ClassifiedSubAccountSpend {
  outcome: SubAccountSpendOutcome;
  /** The transaction's own hash, derived from the bytes. */
  txHash: string;
  candidate?: SubAccountRecord;
}

/** Nothing was written. From `commitSpend`: the bytes are not an acceptable signed transaction
 * (`invalid-transaction`), they were not signed by that sub-account (`sender-mismatch`), or the
 * row is held by another owner or another transaction (`held`). From `processSyncTransaction`
 * also: the item carries no signed transaction (`missing-transaction`), this pool has no spend
 * applier to check one (`no-applier`), or the item disagrees with its own transaction
 * (`inconsistent-item`). `index` is the sub-account concerned, when one was identified. */
export class SubAccountSpendRefusedError extends Error {
  constructor(
    readonly code:
      | "invalid-transaction"
      | "sender-mismatch"
      | "held"
      | "missing-transaction"
      | "no-applier"
      | "inconsistent-item",
    readonly index: number | undefined,
    detail: string
  ) {
    super(
      `Sub-account ${index === undefined ? "sync" : index} spend refused (${code}): ${detail}`
    );
    this.name = "SubAccountSpendRefusedError";
  }
}

/** What a composition-attached spend applier reports (see `attachSpendApplier`). */
export type SubAccountSpendApplication =
  | { readonly kind: "committed"; readonly poolIndex: number }
  | { readonly kind: "already-applied"; readonly poolIndex: number }
  | { readonly kind: "no-pool-row" };

export type SubAccountSpendApplier = (
  rawTx: string,
  chainIdentifier: string
) => Promise<SubAccountSpendApplication>;

/** Result of funding one sub-account through the recorded path (`fundAccount`). */
export interface FanOutFundingResult {
  index: number;
  address: string;
  /** Payment capacity plus fee reserve: the one value the funding transfer carries. Everywhere
   * else the two figures travel as separate, explicit parameters. */
  fundedValue: bigint;
  signedTx: SignedMonadTx;
  txHash: string;
}

export function normalizeFundingAccounts(
  accounts: SubAccountFundingAccounts | EvmFundingAccounts
): SubAccountFundingAccounts {
  const senderNonce =
    typeof accounts.senderNonce === "bigint"
      ? accounts.senderNonce.toString()
      : String(accounts.senderNonce);
  const recipientNonce =
    typeof accounts.recipientNonce === "bigint"
      ? accounts.recipientNonce.toString()
      : String(accounts.recipientNonce);
  const recipientBalance =
    typeof accounts.recipientBalance === "bigint"
      ? accounts.recipientBalance.toString()
      : String(accounts.recipientBalance);
  return {
    block: {
      number: accounts.block.number,
      hash: accounts.block.hash.toLowerCase(),
    },
    senderNonce,
    recipientNonce,
    recipientBalance,
  };
}

export function normalizeFundingObservation(
  observation: SubAccountFundingObservation | EvmFundingObservation
): SubAccountFundingObservation {
  if (observation.kind === "unresolved") {
    return { kind: "unresolved", reason: observation.reason };
  }
  if (observation.kind === "superseded") {
    return {
      kind: "superseded",
      accounts: normalizeFundingAccounts(observation.accounts),
    };
  }
  return {
    kind: "included",
    execution: observation.execution,
    receiptBlock: {
      number: observation.receiptBlock.number,
      hash: observation.receiptBlock.hash.toLowerCase(),
    },
    accounts: normalizeFundingAccounts(observation.accounts),
  };
}

export function cloneFundingHold(
  hold: SubAccountFundingHold
): SubAccountFundingHold {
  return {
    ...hold,
    ...(hold.requirements !== undefined
      ? {
          requirements: hold.requirements.map((req) => ({ ...req })),
        }
      : {}),
  };
}

export function cloneFundingCollection(
  funding: SubAccountFundingCollection,
  options?: { preserveHold?: boolean }
): SubAccountFundingCollection {
  return {
    version: funding.version,
    attempts: funding.attempts.map((attempt) => ({ ...attempt })),
    ...(options?.preserveHold === true && funding.hold !== undefined
      ? { hold: cloneFundingHold(funding.hold) }
      : {}),
  };
}
