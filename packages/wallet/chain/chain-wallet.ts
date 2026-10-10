import type { EvmNativeOperation } from "../storage/evm-native-operation-journal";
/** Canonical address value passed across the application/chain boundary. */
export interface ChainAddress {
  readonly raw: string;
}

/** A submitted native-chain transaction, with any prerequisite transactions it depended on. */
export interface ChainTransaction {
  /** The user-facing transaction id for the requested action. */
  readonly txHash: string;
  /** Ordered prerequisite/action ids when one logical action required more than one transaction. */
  readonly relatedTxHashes?: ReadonlyArray<string>;
  /**
   * The exact signed bytes (hex), in broadcast order, for wallets whose transaction can be sent
   * again unchanged (UTXO chains). Recorded before broadcast so a restart rebroadcasts the same
   * transaction instead of leaving the attempt unresolved or paying a second time.
   */
  readonly rawTransactions?: ReadonlyArray<string>;
}

/**
 * Submission reached the network boundary, but the caller cannot safely infer whether the
 * transaction was accepted. `transaction` is derived from the exact signed bytes, so callers can
 * reconcile that id before deciding whether to create a replacement payment.
 */
export class NativeTransactionSubmissionError extends Error {
  readonly transaction: ChainTransaction;
  readonly reason: unknown;

  constructor(params: { transaction: ChainTransaction; reason: unknown }) {
    super(
      `native transaction submission outcome is unknown for ${params.transaction.txHash}`
    );
    this.name = "NativeTransactionSubmissionError";
    this.transaction = params.transaction;
    this.reason = params.reason;
  }
}

/**
 * The network answered and refused the transaction, so it was not broadcast and the same money
 * can be sent again. `reason` is the node's own wording where the relay passed it on.
 */
export class NativeTransactionRefusedError extends Error {
  readonly reason: string;

  constructor(reason?: string) {
    super(
      reason
        ? `The network refused the transaction: ${reason}`
        : "The network refused the transaction; nothing was sent"
    );
    this.name = "NativeTransactionRefusedError";
    this.reason = reason ?? "";
  }
}

/**
 * The fee a send would pay now is higher than the fee the user reviewed. Nothing was signed or
 * sent; `fee` is the current fee, in base units, to show for a fresh review.
 */
export class NativeFeeExceededError extends Error {
  constructor(readonly fee: bigint) {
    super("The network fee rose above the reviewed fee; review the transfer again");
    this.name = "NativeFeeExceededError";
  }
}

/** Durable guard record; signed replay material may remain wallet-specific and in memory. */
export interface NativeTransactionAttemptStore {
  /** Coordination reach of this store. Cross-process stores require a host lock not yet exposed. */
  readonly coordinationScope: "single-realm" | "cross-process";
  get(key: string): ChainTransaction | undefined;
  /** Must not return until the record is durable; throw instead of degrading to volatile state. */
  put(key: string, transaction: ChainTransaction): void;
  delete(key: string): void;
}

/** Isolated store for tests and non-browser hosts that supply their own lifecycle. */
export class InMemoryNativeTransactionAttemptStore
  implements NativeTransactionAttemptStore
{
  readonly coordinationScope = "single-realm" as const;
  private readonly attempts = new Map<string, ChainTransaction>();

  get(key: string): ChainTransaction | undefined {
    return this.attempts.get(key);
  }

  put(key: string, transaction: ChainTransaction): void {
    this.attempts.set(key, transaction);
  }

  delete(key: string): void {
    this.attempts.delete(key);
  }
}

interface NativeAttemptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): NativeAttemptStorage | undefined {
  const host = globalThis as {
    window?: unknown;
    localStorage?: NativeAttemptStorage;
  };
  if (host.window === undefined) return undefined;
  try {
    return host.localStorage;
  } catch {
    // Privacy settings and sandboxed webviews can make localStorage access throw.
    return undefined;
  }
}

function isBrowserContext(): boolean {
  return (globalThis as { window?: unknown }).window !== undefined;
}

function parseStoredTransaction(
  serialized: string
): ChainTransaction | undefined {
  try {
    const value = JSON.parse(serialized) as Partial<ChainTransaction>;
    if (typeof value.txHash !== "string") return undefined;
    if (
      value.relatedTxHashes !== undefined &&
      (!Array.isArray(value.relatedTxHashes) ||
        value.relatedTxHashes.some((txHash) => typeof txHash !== "string"))
    ) {
      return undefined;
    }
    if (
      value.rawTransactions !== undefined &&
      (!Array.isArray(value.rawTransactions) ||
        value.rawTransactions.some((raw) => typeof raw !== "string"))
    ) {
      return undefined;
    }
    return {
      txHash: value.txHash,
      ...(value.relatedTxHashes === undefined
        ? {}
        : { relatedTxHashes: value.relatedTxHashes }),
      ...(value.rawTransactions === undefined
        ? {}
        : { rawTransactions: value.rawTransactions }),
    };
  } catch {
    return undefined;
  }
}

/** Browser-durable store. Non-browser senders must inject a durable host-specific implementation. */
export class DefaultNativeTransactionAttemptStore
  implements NativeTransactionAttemptStore
{
  readonly coordinationScope = "single-realm" as const;
  private readonly prefix = "frank:native-attempt:v1:";

  get(key: string): ChainTransaction | undefined {
    const storage = browserStorage();
    if (storage === undefined) {
      if (isBrowserContext()) {
        throw new Error(
          "Native transaction attempt persistence is unavailable"
        );
      }
      return undefined;
    }
    let serialized: string | null;
    try {
      serialized = storage.getItem(`${this.prefix}${key}`);
    } catch {
      throw new Error("Unable to read persisted native transaction attempts");
    }
    if (serialized === null) return undefined;
    const transaction = parseStoredTransaction(serialized);
    if (transaction === undefined) {
      throw new Error(
        `Invalid persisted native transaction attempt for ${key}`
      );
    }
    return transaction;
  }

  put(key: string, transaction: ChainTransaction): void {
    const storage = browserStorage();
    if (storage === undefined) {
      throw new Error("Native transaction attempt persistence is unavailable");
    }
    try {
      storage.setItem(`${this.prefix}${key}`, JSON.stringify(transaction));
    } catch {
      throw new Error("Unable to persist native transaction attempt");
    }
  }

  delete(key: string): void {
    const storage = browserStorage();
    if (storage === undefined) {
      throw new Error("Native transaction attempt persistence is unavailable");
    }
    try {
      storage.removeItem(`${this.prefix}${key}`);
    } catch {
      throw new Error("Unable to remove persisted native transaction attempt");
    }
  }
}

export const defaultNativeTransactionAttemptStore =
  new DefaultNativeTransactionAttemptStore();

export interface FrankIdentityHandle {
  readonly address: ChainAddress;
  readonly displayAddress: string;
}

/**
 * The wallet surface used by chain-neutral UI code. Complex build/sign/retry protocols remain
 * capabilities below this boundary; a simple native transfer is one logical operation here.
 */
export interface NativeWalletHandle {
  /** Runtime discriminator identifying the chain family ("evm" | "bitcoin" | "solana"). */
  readonly family: ChainFamily;
  /** Stable configured chain identifier (e.g. "monad-testnet", "hyperliquid-mainnet", "solana-mainnet", "xec-mainnet"). */
  readonly chainIdentifier: string;
  /** Stable configured network discriminator (for example, mainnet versus testnet). */
  readonly networkId: string;
  readonly identity: FrankIdentityHandle;
  /** Attached chain-agnostic UTXO pool (if configured). */
  readonly chainUtxoPool?: import("../chain-utxo-pool").ChainUtxoPool;
  /** Address to show for a new inbound payment; may rotate independently of wallet identity. */
  getReceiveAddress(): Promise<ChainAddress>;
  getBalance(): Promise<bigint>;
  /** The exact signed attempt whose submission outcome must be resolved before a fresh send. */
  getUnresolvedNativeTransaction?(): ChainTransaction | undefined;
  /** Resubmits the exact unresolved signed bytes; never builds a replacement payment. */
  retryUnresolvedNativeTransaction?(): Promise<ChainTransaction>;
  /** Clears a blocked attempt only after the caller has reconciled its exact id with the chain. */
  resolveUnresolvedNativeTransaction?(params: {
    transaction: ChainTransaction;
    outcome: "submitted" | "not-submitted";
  }): Promise<void>;
  sendNative(params: {
    recipient: ChainAddress;
    value: bigint;
    /** The fee the user reviewed, as a ceiling; wallets that support it throw NativeFeeExceededError. */
    maxFee?: bigint;
    /** Invoked after signing and before broadcast so callers can durably record the exact id. */
    onSigned?: (signed: ChainTransaction) => Promise<void>;
  }): Promise<ChainTransaction>;

  /** Pays a contact at a one-time address and delivers the message that lets the contact's wallet
   * find the money. Paid from the wallet's spendable funds through the same recorded path as
   * `sendNative`. The signed transfer and its message item are saved, the message (which carries
   * the signed transfer) is delivered, and only when the relay has confirmed it is the transfer
   * broadcast. Rejects with `ContactPaymentPendingError` while the relay has not confirmed. */
  sendToContact?(params: ContactSendParams): Promise<ContactSendResult>;
  /** The same payment for a host that sends the message itself (a chat, with its own outgoing
   * bubble and retry): signs and saves the transfer, holds its source, broadcasts nothing, and
   * returns the item. The host then sends a message carrying that item with
   * `directMessages.send`; when the relay has stored it the wallet broadcasts the transfer. The
   * item may be sent again (a retry, a new message): the transfer is always the same one. */
  prepareContactPayment?(
    params: ContactSendParams
  ): Promise<PreparedContactPayment>;
  /** Finishes every payment to a contact whose message is not delivered yet. A mailbox read does
   * this by itself; it never signs or pays anything new and never rejects. */
  resumeContactPayments?(): Promise<void>;
  /** Sends a payment whose message the relay ended (`ContactPaymentFailedError`) again, in a new
   * message. The transfer is the original one. */
  retryContactPayment?(messageId: string): Promise<void>;
  /** Brings the payment whose message item has this ephemeral key to an end. If no byte of it
   * ever left the device it is RELEASED (its signed transfer cancelled, its funds free) and the
   * answer is `released`. If its bytes went to a relay it is FINISHED, never released: broadcast
   * if its message is stored, otherwise delivered again by the wallet in a new message with the
   * same signed transfer; the answer is its state then. A host calls this to end a held payment
   * (the Wallet page's unfinished payments). Deleting the message that carried a payment does
   * not call it: the payment stays listed until it is finished. */
  settleContactPayment?(
    ephemeralPubKey: string
  ): Promise<ContactPaymentInfo["state"] | "none">;
  /** This wallet's payments to contacts, newest state. */
  getContactPayments?(): ContactPaymentInfo[];
  /** Money received at one-time accounts (stealth payments, stamps), as last read from the chain.
   * No request is made. */
  getReceivedPayments?(): ReceivedPayment[];
  /** Reads the chain for every received payment that may hold money, then returns them. */
  refreshReceivedPayments?(): Promise<ReceivedPayment[]>;
  /** Have the payments this message carried (its stamps, a stealth transfer) landed? From what
   * the wallet last read; no request is made. `received` only when the chain showed each
   * transaction included successfully and its money at its account. */
  getMessagePayment?(payloadDigest: string): MessagePayment;
  /** The same answer after asking the chain about the message's payments that are still pending
   * (it broadcasts the carried transactions too). What a bot calls before it pays out. Makes no
   * request when nothing of the message is pending. */
  checkMessagePayment?(payloadDigest: string): Promise<MessagePayment>;
  /** Moves the unspent received coins of these messages (stamps, stealth payments) to the
   * wallet's seed-derived main account, each in a recorded native operation. An explicit request
   * only: deleting a message does NOT need it and never moves money (the coins stay in the coin
   * list, and their derivation is noted to self). Asking again for a `pending` or `failed`
   * message continues the same operation; it never signs a second sweep of a coin. */
  sweepReceivedCoins?(params: {
    payloadDigests: readonly string[];
  }): Promise<Record<string, ReceivedCoinSweep>>;
  /** The wallet sync boundary's way in for a `received-coin` note this account wrote to itself
   * (`applyWalletSyncItem`): the wallet derives the key from the note's data and records the
   * coin, pending until the chain is read, only if that key opens the note's account. True when
   * it does (recorded now, or known already); recording twice changes nothing. */
  recordReceivedCoin?(note: ReceivedCoinItem): Promise<boolean>;
  /** Writes, in free notes to self, how the key of each received coin not yet noted is derived,
   * so the account's other devices and a restore from the seed find those coins without their
   * messages. A mailbox read does this by itself; it moves no money and never rejects. */
  noteReceivedCoins?(): Promise<void>;

  /**
   * Sends funds to an external legacy destination address, automatically aggregating
   * fragmented sub-accounts or UTXOs using the chain's appropriate consolidation strategy.
   */
  sendLegacy?(params: {
    recipient: ChainAddress;
    value: bigint;
    onProgress?: (progress: LegacySendProgress) => void;
    onSigned?: (signed: ChainTransaction) => Promise<void>;
    priorityFeeMicroLamports?: bigint;
  }): Promise<LegacySendResult>;

  /** Computes the estimated network fee required to deliver `value` to a legacy destination. */
  estimateLegacyFee?(params: {
    recipient: ChainAddress;
    value: bigint;
  }): Promise<LegacyFeeEstimate>;

  /** Recovers or resumes any in-flight staging intent interrupted by an app/browser crash. */
  getUnresolvedLegacySend?(): readonly EvmNativeOperation[];
  resumeLegacySend?(operationId: string): Promise<LegacySendResult>;
  /** EVM operation evidence; delivery and inclusion do not release its input claims. */
  getNativeOperations?(): readonly EvmNativeOperation[];
  /** Whether this session's last attempt to tell the account's other devices about the operation
   * failed. It is tried again on a later send or resume; the payment itself is unaffected. */
  nativeOperationSyncFailed?(operationId: string): boolean;
  resumeNativeOperation?(operationId: string): Promise<EvmNativeOperation>;
  cancelUnsignedNativeOperation?(operationId: string): Promise<void>;
  /**
   * Looks again, within a hard request bound the wallet enforces, for this wallet's own broadcast
   * transfers whose inclusion nothing has observed. Safe to call on every poll tick: it makes no
   * request when nothing is pending, never signs anything, and never rejects. The one thing it
   * may submit is a contract call this wallet already broadcast and the node no longer knows:
   * the same signed bytes again, on a backoff. Absent
   * on a handle with nothing to look up; callers treat absence as nothing to do.
   */
  reobserveNativeOperations?(): Promise<void>;
  /**
   * One call to a contract from the wallet's main account (which holds the tokens such a call
   * moves), recorded before it is signed and re-submitted byte-for-byte by
   * `resumeNativeOperation`. Resolves once the call is handed to the network; the caller watches
   * for inclusion or a revert. Absent where the family has no contract calls.
   */
  sendContractCall?(params: {
    to: ChainAddress;
    data: string;
    value: bigint;
    gasLimit?: bigint;
    /** What the call is (a swap's record): journaled with it and carried by its note to self. */
    record?: import("../storage/evm-native-operation-journal").EvmContractCallRecord;
    onSigned?: (signed: ContractCallHandle) => Promise<void>;
  }): Promise<ContractCallHandle>;
  /** What a contract call can spend: the main account's balance and what could be moved into it. */
  getContractCallFunds?(): Promise<{
    mainAddress: string;
    mainBalance: bigint;
    otherBalance: bigint;
    mainBusy: boolean;
  }>;
  /** Contract calls signed by this wallet and not yet seen in a block; resume each by its id. */
  getUnresolvedContractCalls?(): ContractCallHandle[];
  /** Read-only node access for this handle's own EVM chain. It cannot sign or submit. */
  readonly evmReader?: EvmChainReader;
  /** Consolidates `value` from the wallet's other accounts into the main account. */
  fundMainAccount?(params: {
    value: bigint;
    onProgress?: (progress: LegacySendProgress) => void;
    onSigned?: (signed: ChainTransaction) => Promise<void>;
  }): Promise<LegacySendResult>;
}

/** The reads a contract interaction needs: a call, a gas estimate, a balance, a receipt. */
export interface EvmChainReader {
  call(tx: {
    to: string;
    data: string;
    from?: string;
    value?: bigint;
    blockTag?: number;
  }): Promise<string>;
  estimateGas(tx: {
    to: string;
    data: string;
    value: bigint;
    from: string;
  }): Promise<bigint>;
  getBalance(address: string): Promise<bigint>;
  getFeeData(): Promise<{
    maxFeePerGas: bigint | null;
    gasPrice: bigint | null;
    maxPriorityFeePerGas?: bigint | null;
  }>;
  getBlock(tag: "latest"): Promise<{ baseFeePerGas: bigint | null } | null>;
  getTransactionReceipt(hash: string): Promise<{
    readonly from?: string;
    readonly to?: string | null;
    readonly status: number | null;
    readonly blockNumber: number;
    readonly gasUsed: bigint;
    readonly gasPrice: bigint;
    readonly logs: ReadonlyArray<{
      readonly address: string;
      readonly topics: ReadonlyArray<string>;
      readonly data: string;
    }>;
  } | null>;
  getTransaction(hash: string): Promise<unknown | null>;
}

export interface ContractCallHandle {
  readonly operationId: string;
  readonly txHash: string;
}

export type LegacySendStage =
  | { stage: "planning" }
  | { stage: "selecting-inputs"; count: number }
  | { stage: "consolidating"; completed: number; total: number; stagingTxHashes: string[] }
  | { stage: "draining"; stagingAddress: string; drainTxHash?: string }
  | { stage: "broadcasting"; txHash?: string }
  | { stage: "confirmed"; txHash: string };

export interface LegacySendProgress {
  status: LegacySendStage;
  message?: string;
}

export interface LegacyFeeEstimate {
  /** Total estimated network fees in base units (wei / satoshis / lamports). */
  totalFee: bigint;
  /** Number of fragmented accounts or UTXOs consumed. */
  inputCount: number;
  /** Intermediate consolidation fee (EVM staging only; 0n for UTXO/Solana). */
  consolidationFee?: bigint;
  /** Final delivery fee to destination. */
  deliveryFee: bigint;
}

export type {
  MessagePayment,
  ReceivedPayment,
  ReceivedPaymentStatus,
} from "../storage/evm-coin-store";
import type {
  MessagePayment,
  ReceivedPayment,
} from "../storage/evm-coin-store";
import type { ReceivedCoinItem } from "@frank/cashweb/types/messages";

export interface LegacySendResult {
  /** Final transaction hash that paid the recipient. */
  txHash: string;
  /** Staging transaction hashes if intermediate fan-in occurred (EVM). */
  intermediateTxHashes?: string[];
  totalValueSent: bigint;
  totalFeePaid: bigint;
}

export interface ContactSendProgress {
  stage:
    | "resolving-keys"
    | "deriving-stealth"
    | "signing"
    | "delivering"
    | "broadcasting"
    | "confirmed";
  message?: string;
  txHash?: string;
}

export interface ContactSendResult {
  txHash: string;
  stealthAddress: string;
  value: bigint;
  /** The message that carries the payment to the contact. */
  messageId: string;
  payloadDigest: string;
}

/** A payment to a contact that is signed, saved and NOT broadcast, with the message item the host
 * must now deliver to the contact through its ordinary message send. */
export interface PreparedContactPayment {
  item: import("@frank/cashweb/types/messages").StealthItem;
  txHash: string;
  stealthAddress: string;
  value: bigint;
}

/** A payment to a contact: a transfer to a one-time address only the contact can spend from, and
 * the message that tells the contact's wallet where it is. */
export interface ContactSendParams {
  recipient: ChainAddress;
  value: bigint;
  memo?: string;
  /** The conversation the message belongs to; the default thread with the contact when absent. */
  conversationId?: string;
  /** The message's stamp. The payment itself is `value`, never part of the stamp. */
  stampValue?: bigint;
  onProgress?: (progress: ContactSendProgress) => void;
}

/** The payment is signed and saved, and the relay has not confirmed its message yet. NOTHING has
 * been broadcast: the transfer goes out only once the relay has the message. The wallet finishes
 * this same payment by itself (on every mailbox read, also after a restart); calling
 * `sendToContact` again would be a second payment. */
export class ContactPaymentPendingError extends Error {
  constructor(
    readonly messageId: string,
    readonly txHash: string | undefined,
    readonly reason: unknown
  ) {
    super(
      `The payment is saved and its message is not delivered yet (${
        reason instanceof Error ? reason.message : String(reason)
      }). The wallet keeps delivering it; do not send it again.`
    );
    this.name = "ContactPaymentPendingError";
  }
}

/** The relay ended the payment's message for good. This wallet broadcast nothing. The item is
 * kept: `retryContactPayment` sends it to the contact in a new message. Nothing is signed again. */
export class ContactPaymentFailedError extends Error {
  constructor(readonly messageId: string, readonly failure: string) {
    super(
      `The relay will not deliver this payment's message (${failure}). The payment is kept and can be delivered again.`
    );
    this.name = "ContactPaymentFailedError";
  }
}

/** What happened to the received coins of one message when the wallet was asked to sweep them.
 * - `none`: the message has no coin that holds money worth moving (never funded, already spent, or
 *   too small to pay for its own move).
 * - `swept`: its coins were moved to this wallet's seed-derived main account and the chain shows
 *   it.
 * - `pending`: a sweep is signed and broadcast and the chain has not shown it yet. Ask again.
 * - `failed`: nothing could be established or moved (`reason`). The money is still at its
 *   one-time account, in the coin list. */
export interface ReceivedCoinSweep {
  outcome: "none" | "swept" | "pending" | "failed";
  reason?: string;
}

/** The payment was released before a byte of it left this device: its signed transfer is
 * cancelled and can never land, and the funds it held are free. Nothing was sent. Make the
 * payment again; the item of a released payment is never accepted in a message. */
export class ContactPaymentReleasedError extends Error {
  constructor() {
    super(
      "This payment was cancelled before anything was sent. Nothing was paid; make the payment again."
    );
    this.name = "ContactPaymentReleasedError";
  }
}

/** The largest amount a stealth message item can state (its wire field is an unsigned 64-bit
 * integer): about 18.4 units of an 18-decimal coin. A host checks an amount against it before
 * review. */
export const MAX_STEALTH_ITEM_AMOUNT = 2n ** 64n - 1n;

/** Refused before anything is signed: the amount is more than one contact payment can carry. */
export class ContactPaymentTooLargeError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "ContactPaymentTooLargeError";
  }
}

/** A payment to a contact as a host may show it. */
export interface ContactPaymentInfo {
  messageId: string;
  /** The ephemeral key of the payment's message item: what a host finds the payment by. */
  ephemeralPubKey: string;
  /** Its signed transfer is not on the chain and its source account is held for it. */
  holdsFunds: boolean;
  recipientAddress: string;
  valueWei: bigint;
  /** `prepared`: signed, nothing broadcast, its message is being delivered. `delivered`: the
   * relay has the message and the transfer is being broadcast. `paid`: the chain shows the
   * transfer. `failed`: the relay ended the message; `retryContactPayment` sends it again.
   * `released`: nothing of it was ever sent and its transfer was cancelled. */
  state: "planned" | "prepared" | "delivered" | "paid" | "failed" | "released";
  txHash?: string;
  failure?: string;
}

/** Minimum identity surface accepted by profile, message, and topic capabilities. */
export interface WalletHandle {
  readonly identity: FrankIdentityHandle;
}
export type ChainFamily = "evm" | "bitcoin" | "solana";

/** Stable namespace for safety records shared by multiple configured settlement networks. */
export function nativeTransactionAttemptKey(params: {
  family: ChainFamily;
  chainIdentifier: string;
  address: string;
}): string {
  if (params.chainIdentifier.trim().length === 0) {
    throw new Error("Native transaction chain identifier must not be empty");
  }
  return `${params.family}:${encodeURIComponent(params.chainIdentifier)}:${
    params.address
  }`;
}

const nativeOperationQueues = new Map<string, Promise<void>>();

/**
 * Serializes one wallet's durable-attempt transition across instances. Browser hosts require the
 * Web Locks API so separate tabs cannot overwrite or clear each other's in-flight payment.
 */
export async function runNativeTransactionExclusive<T>(
  key: string,
  coordinationScope: NativeTransactionAttemptStore["coordinationScope"],
  operation: () => Promise<T>
): Promise<T> {
  const host = globalThis as {
    window?: unknown;
    navigator?: {
      locks?: {
        request<T>(name: string, callback: () => Promise<T>): Promise<T>;
      };
    };
  };
  if (coordinationScope !== "single-realm") {
    throw new Error(
      "Cross-process native transaction stores require an external coordinator"
    );
  }
  if (host.window !== undefined) {
    if (host.navigator?.locks === undefined) {
      throw new Error(
        "Cross-context native transaction locking is unavailable"
      );
    }
    return host.navigator.locks.request(
      `frank:native-transaction:${key}`,
      operation
    );
  }

  const previous = nativeOperationQueues.get(key) ?? Promise.resolve();
  const run = previous.then(operation);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  nativeOperationQueues.set(key, tail);
  try {
    return await run;
  } finally {
    if (nativeOperationQueues.get(key) === tail) {
      nativeOperationQueues.delete(key);
    }
  }
}

export function sameChainTransaction(
  left: ChainTransaction,
  right: ChainTransaction
): boolean {
  return (
    left.txHash === right.txHash &&
    JSON.stringify(left.relatedTxHashes ?? []) ===
      JSON.stringify(right.relatedTxHashes ?? [])
  );
}
