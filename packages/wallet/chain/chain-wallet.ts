import type { EvmNativeOperation } from "../storage/evm-native-operation-journal";
import type { NotedSendStatus } from "../evm-noted-sends";
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

/** A budgeted native transfer would leave less unreserved value than its authorized floor. */
export class NativeReserveExceededError extends Error {
  constructor(readonly available: bigint, readonly required: bigint) {
    super("Native transfer would spend the required reserve");
    this.name = "NativeReserveExceededError";
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
  /**
   * Receive address already derived on this device. Present when that derivation does not
   * need an indexer. It may already have been paid; `getReceiveAddress` is the checked one.
   */
  localReceiveAddress?(): ChainAddress;
  getBalance(): Promise<bigint>;
  /** Display-only last complete observation, with current reservations excluded. Undefined
   * until observed; age and refresh failures must remain visible. Never authorizes spending. */
  /** The last balance read: `balance` (what `getBalance` answered) and, when it was read in
   * this session, the `parts` it is the sum of. A screen that shows the balance and its
   * breakdown shows both from this one read, so they never disagree. */
  getBalanceObservation?():
    | { balance: bigint; observedAt: number; parts?: WalletBalanceParts }
    | undefined;
  /** Optional financial adapter. Message construction and transport remain with the host. */
  readonly stealthPayments?: import("../stealth-payment").StealthPaymentCapability;
  /** Recipient derivation/chain verification, distinct from outgoing wallet synchronization. */
  readonly stealthReceipts?: import("../stealth-payment").StealthPaymentReceiptCapability;
  /**
   * Where the balance is, in the wallet's own words: every coin a send can draw on, and nothing
   * else. `getBalance()` is the sum of the four amounts.
   * - `main`: the main account (the deposit address);
   * - `profile`: the address on the user's profile, when it is another address (else 0);
   * - `received`: payments and stamps received at one-time addresses that the chain shows
   *   funded (`receivedCount` of them);
   * - `sending`: single-use sending accounts the wallet has funded and not yet used.
   * What is left behind in a sending account after its one payment is not in any of them: no
   * send can draw on it.
   *
   * `tooSmall` (`tooSmallCount` coins) is NOT in the balance: received coins below the payment
   * floor right now (`chain/payment-floor.ts`: ten times what moving one costs). They are held,
   * not spendable money. Zero when the gas price is not known yet.
   */
  getBalanceParts?(): Promise<WalletBalanceParts>;
  /** The exact signed attempt whose submission outcome must be resolved before a fresh send. */
  getUnresolvedNativeTransaction?(): ChainTransaction | undefined;
  /** Resubmits the exact unresolved signed bytes; never builds a replacement payment. */
  retryUnresolvedNativeTransaction?(): Promise<ChainTransaction>;
  /** Clears a blocked attempt only after the caller has reconciled its exact id with the chain. */
  resolveUnresolvedNativeTransaction?(params: {
    transaction: ChainTransaction;
    outcome: "submitted" | "not-submitted";
  }): Promise<void>;
  /** A plain native transfer from the family's own wallet (UTXO, Solana). An EVM wallet has
   * none: its one transfer to an address is `sendLegacy`, through the coin list. */
  sendNative?(params: {
    recipient: ChainAddress;
    value: bigint;
    /** The fee the user reviewed, as a ceiling; wallets that support it throw NativeFeeExceededError. */
    maxFee?: bigint;
    /** Minimum unreserved native value left after amount and maximum fee. EVM native-gas
     * owners enforce it before signing; unsupported families reject it explicitly. */
    minimumRemainingBalance?: bigint;
    /** Invoked after signing and before broadcast so callers can durably record the exact id. */
    onSigned?: (signed: ChainTransaction) => Promise<void>;
    /** While an earlier payment from the main account has not been seen on chain this send
     * waits its turn, however long that takes. With this it gives up after so many
     * milliseconds, having signed nothing. Wallets with no such account ignore it. */
    mainAccountWaitMs?: number;
  }): Promise<ChainTransaction>;

  /** Pays a contact at a one-time address. The wallet persists the encrypted message and
   * complete signed transaction set before submitting recipient and owned-change transactions.
   * Chain settlement and relay delivery are reconciled separately under the original operation. */
  sendToContact?(params: ContactSendParams): Promise<ContactSendResult>;
  /** Prepares and reserves a contact payment without broadcasting. A host passes the returned
   * item to `directMessages.send`, which attaches its stamp to the same operation and durably
   * stores the encrypted message before submitting the complete transaction wrapper. */
  prepareContactPayment?(
    params: ContactSendParams
  ): Promise<PreparedContactPayment>;
  /** What a payment to a contact will cost, for review, without taking or signing anything:
   * the payment, the message's stamp and the network fee of both, each apart, and their total.
   * Refuses a payment below the payment floor (`ContactPaymentBelowFloorError`), as
   * `prepareContactPayment` does. */
  quoteContactPayment?(
    params: Pick<ContactSendParams, "recipient" | "value" | "stampValue">
  ): Promise<ContactPaymentQuote>;
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
   * not call it: the payment stays listed until it is finished. It never fails silently: when
   * the message is delivered and the chain does not show the transfer included, it rejects with
   * `ContactPaymentNotSettledError` saying why; any other failure rejects as it happened. */
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
  /** The wallet sync boundary's way in for an outgoing `wallet-sync` note this account wrote to
   * itself (`applyWalletSyncItem`): another device of the account signed `item.rawTx`, spending
   * the coin `[signer, nonce]` of this wallet. That coin leaves selection, and its account is read
   * from the chain again, which lists what it holds after the spend. True when the transaction is
   * one this wallet's keys signed (marked now, or this device's own spend already); false when it
   * is not about this wallet. Applying it twice changes nothing. The spent coin leaves the list
   * durably, so it is never offered again after a restart, and the account is read until a read
   * succeeds. Rejects only when that record could not be written. */
  recordSyncedSpend?(item: WalletSyncItem): Promise<boolean>;
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
    /** Stable caller identity for replaying the same approved EVM funding operation. */
    operationId?: string;
    /** The fee the user reviewed, as a ceiling; wallets that support it throw
     * NativeFeeExceededError instead of paying more. */
    maxFee?: bigint;
    onProgress?: (progress: LegacySendProgress) => void;
    onSigned?: (signed: ChainTransaction) => Promise<void>;
    priorityFeeMicroLamports?: bigint;
    /** While an earlier payment from the main account has not been seen on chain this send
     * waits its turn, however long that takes. With this it gives up after so many
     * milliseconds, having signed nothing. Wallets with no such account ignore it. */
    mainAccountWaitMs?: number;
  }): Promise<LegacySendResult>;

  /** Computes the estimated network fee required to deliver `value` to a legacy destination. */
  estimateLegacyFee?(params: {
    recipient: ChainAddress;
    value: bigint;
  }): Promise<LegacyFeeEstimate>;
  /** The most one transfer to a legacy destination can send now, and its fee. Absent: the
   * wallet cannot say (the host offers no "send everything"). */
  estimateLegacyMax?(params: {
    recipient: ChainAddress;
  }): Promise<LegacyMaxEstimate>;

  /** Recovers or resumes any in-flight staging intent interrupted by an app/browser crash. */
  getUnresolvedLegacySend?(): readonly EvmNativeOperation[];
  resumeLegacySend?(operationId: string): Promise<LegacySendResult>;
  /** Active EVM operation evidence; completed records are available through history. */
  getNativeOperations?(): readonly EvmNativeOperation[];
  readNativeOperation?(operationId: string): Promise<EvmNativeOperation | undefined>;
  getNativeOperationHistory?(options: { after?: string; limit: number }): Promise<{
    operations: EvmNativeOperation[];
    next?: string;
  }>;
  /**
   * When each of these blocks was made (epoch ms), read from the chain, for dating transactions
   * the journal saw included. Keyed by block hash; a block the node does not return, or whose
   * hash at that height is another, is left out. Read only, never rejects for a block it cannot
   * read; rejects only for a closed wallet.
   */
  readBlockTimes?(
    blocks: readonly { blockNumber: number; blockHash: string }[]
  ): Promise<ReadonlyMap<string, number>>;
  /**
   * What the account sent from any of its devices, as its notes to itself report it, with what
   * the chain shows of each transaction. Transfers to the wallet's own accounts are left out.
   * A device restored from the seed has these once it has read the mailbox. Read only.
   */
  getNotedSends?(): Promise<NotedSendStatus[]>;
  /** Whether this session's last attempt to tell the account's other devices about the operation
   * failed. It is tried again on a later send or resume; the payment itself is unaffected. */
  nativeOperationSyncFailed?(operationId: string): boolean;
  /** Retry durable, already signed wallet-sync members without constructing another payment.
   * Returns operation IDs still awaiting delivery so the host can surface partial recovery. */
  flushNativeSync?(): Promise<readonly string[]>;
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
   * Waits for the wallet's next look at the chain (its block watcher), then looks at the
   * transactions of one native operation that are not yet seen in a block. A host showing a
   * transfer that is not final calls this in a loop and reads `getNativeOperations` after each
   * turn. Resolves when the look is done, whatever it found; rejects only for a closed wallet.
   */
  watchNativeOperation?(operationId: string): Promise<void>;
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
    /** While an earlier payment from the main account has not been seen on chain this send
     * waits its turn, however long that takes. With this it gives up after so many
     * milliseconds, having signed nothing. Wallets with no such account ignore it. */
    mainAccountWaitMs?: number;
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
  /** Moves `value` into the main account (before a contract call such as a swap): a Send to the
   * main account over the one coin list that never spends the main account's own coin. One coin
   * that suffices pays it directly; otherwise the coins fan in to one fresh account first. */
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

/** The most one transfer to a legacy destination can send now, and the fee it pays. */
export interface LegacyMaxEstimate extends LegacyFeeEstimate {
  /** What the recipient receives: everything spendable now, less `totalFee`. */
  value: bigint;
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
import type { ReceivedCoinItem, WalletSyncItem } from "@frank/cashweb/types/messages";

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
  /** Captured before signing; use this exact amount for the host message and any retry. */
  stampValue: bigint;
  item: import("@frank/cashweb/types/messages").StealthItem;
  txHash: string;
  stealthAddress: string;
  value: bigint;
}

/** What a payment to a contact costs its sender, each part apart (`quoteContactPayment`). */
export interface ContactPaymentQuote {
  /** What the contact receives. */
  valueWei: bigint;
  /** The message's stamp, paid to the contact apart from the payment. */
  stampWei: bigint;
  /** The network fee of the payment's transfers and of the stamp's. */
  networkFeeWei: bigint;
  /** Everything taken from the wallet: payment, stamp and network fee. */
  totalWei: bigint;
  /** The smallest payment the wallet makes right now (the payment floor). */
  floorWei: bigint;
}

/** Where a wallet's balance is (`getBalanceParts`). The balance is `balanceOfParts` of it. */
export interface WalletBalanceParts {
  main: bigint;
  profile: bigint;
  received: bigint;
  receivedCount: number;
  sending: bigint;
  tooSmall: bigint;
  tooSmallCount: number;
}

/** The balance the parts make: everything a send can draw on, never `tooSmall`. */
export function balanceOfParts(parts: WalletBalanceParts): bigint {
  return parts.main + parts.profile + parts.received + parts.sending;
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
  /** The network fee the user approved (`quoteContactPayment`'s `networkFeeWei`). The payment
   * and its stamp together never pay more; a set that would is refused before it is signed.
   * Absent, the fee a quote gives now bounds them. */
  maxFeeWei?: bigint;
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

/** Why a delivered payment is not paid yet, as the chain answered:
 * - `not-in-block`: its transfer is with the chain node and not in a block yet.
 * - `chain-unreadable`: the chain could not be read, so whether it landed is not known.
 * - `not-taken`: the chain node did not take the transfer; the same signed bytes are offered again.
 * - `not-shown`: the chain does not show the transfer yet.
 * - `reverted`: the chain included the transfer and it failed.
 * - `no-record`: the wallet has no record of the signed transfer. */
export type ContactPaymentUnsettledReason =
  | "not-in-block"
  | "chain-unreadable"
  | "not-taken"
  | "not-shown"
  | "reverted"
  | "no-record";

const UNSETTLED_TEXT: Record<ContactPaymentUnsettledReason, string> = {
  "not-in-block": "its transfer is with the chain node and not in a block yet; the wallet keeps checking.",
  "chain-unreadable": "the chain could not be read, so the wallet cannot tell whether its transfer landed; it keeps checking.",
  "not-taken": "the chain node did not take its transfer; the wallet keeps offering the same signed transfer.",
  "not-shown": "the chain does not show its transfer yet; the wallet keeps checking.",
  reverted: "the chain included its transfer and the transfer failed.",
  "no-record": "the wallet has no record of its signed transfer.",
};

/** Asked to finish a payment whose message is delivered, the wallet could not show it paid:
 * `reason` says what the chain answered. Nothing was signed or paid again; the wallet keeps
 * reconciling the original transfer. */
export class ContactPaymentNotSettledError extends Error {
  constructor(
    readonly messageId: string,
    readonly reason: ContactPaymentUnsettledReason
  ) {
    super(`This payment is not finished yet: ${UNSETTLED_TEXT[reason]} Nothing was paid again.`);
    this.name = "ContactPaymentNotSettledError";
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

/** Refused before anything is signed: the amount is below the payment floor
 * (`chain/payment-floor.ts`), so the recipient could not move the coin it makes for less than a
 * tenth of its value. The wallet never creates such a payment to another Frank account. */
export class ContactPaymentBelowFloorError extends RangeError {
  constructor(readonly valueWei: bigint, readonly floorWei: bigint) {
    super(
      `A payment of ${valueWei} wei is below the payment floor of ${floorWei} wei (ten times what the chain charges its recipient to move it). Nothing was signed or sent: pay at least ${floorWei} wei.`
    );
    this.name = "ContactPaymentBelowFloorError";
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
  readonly chainIdentifier: string;
  constructTransactionSet?: import("../transaction-set").TransactionSetCapability["constructTransactionSet"];
  /** Submit the complete prepared wrapper, including wallet-owned change transactions. */
  sendTransaction?: import("../transaction-set").TransactionSetCapability["sendTransaction"];
  releaseTransactionSet?: import("../transaction-set").TransactionSetCapability["releaseTransactionSet"];
  observeTransactionSet?: import("../transaction-set").TransactionSetCapability["observeTransactionSet"];
  readonly topicOperations?: import("../topic-operations").TopicOperationCapability;
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
