/**
 * The compile-time chain-selection seam (ticket #41 -- see `PLAN.md`'s M9 section, "Design: a
 * compile-time `ActiveChain` seam"). One interface, `ActiveChain`, is satisfied by exactly one real
 * implementation (`./monad-chain.ts`'s `MonadChain`), selected once at compile time via
 * `./index.ts`'s `activeChain` constant. Every store/component that needs address formatting, a
 * unit/denomination, a wallet factory, or direct-message/topic-broadcast operations is meant to
 * import through `activeChain` in follow-on tickets (#42/#43) rather than reaching into
 * chain-specific modules (`../wallet/monad-*`, or the old Lotus `../registry`/`../relay`) directly.
 *
 * Deliberately a compile-time constant, not a runtime multi-chain dispatch -- matches M8's own
 * deferred-cross-chain-schema reasoning (`PLAN.md`): only one chain (Monad) is real right now, and
 * a generic multi-chain abstraction designed from a single example risks guessing its shape wrong
 * and needing a rewrite anyway once a second chain actually exists. `LotusChain` is explicitly not
 * built here (see issue #41's "Non-goals") -- this interface is only proven against Monad's real
 * client signatures.
 *
 * ## Deviations from issue #41's own interface sketch, and why
 *
 * The issue's proposed interface is the starting point, not gospel, once real client signatures
 * (`../wallet/monad-*.ts`) are checked against it -- per the ticket's own instructions. Three real
 * deviations, each forced by an actual signature/type mismatch, not stylistic preference:
 *
 * 1. **`WalletHandle` needed to grow past `{ identity }`.** `directMessages.send`/`topics.post`/
 *    `.vote` all need a *sender-specific* signing/leasing/HTTP bundle to actually build and submit
 *    a stamp transaction (`MonadStampClient`/`MonadTopicPostClient`/`MonadTopicVoteClient` all take
 *    the same `{ pool, leaseManager, provider, httpClient, relayBaseUrl }` shape, formalized as
 *    `EvmWalletHandle` in `../evm-wallet-handle.ts`). The generic `WalletHandle` below
 *    still only *promises* `identity` -- it's `MonadChain`'s own concrete `EvmChainWalletHandle`
 *    (`../evm-wallet-handle.ts`) that adds the rest. This is safe under the compile-time seam: in a
 *    Monad-only build, `MonadChain.createWallet` is the only producer of `WalletHandle` values, so
 *    every handle reaching `MonadChain`'s other methods already carries the extra fields (see
 *    `./monad-chain.ts`'s `asMonadWallet`).
 * 2. **`DirectMessageClient.fetchSince` returns `DirectMessageReceived[]`, not
 *    `ReceivedMessageWrapper[]`** (`../types/user-interface.ts`, the issue's own sketched return
 *    type). That type is UTXO/Lotus-pubkey-shaped (`outpoints: Utxo[]`, `copartyPubKey: PublicKey`
 *    from `bitcore-lib-xpi`, `stampValue: number`) -- and `PLAN.md`'s own M9 notes explicitly flag
 *    this exact situation: "`ChatMessage.outpoints: Utxo[]`/`ForumMessage.satoshis` are UTXO-shaped
 *    fields baked into stored message types -- #42/#43 need an explicit decision on the Monad-side
 *    replacement ..., not a silent type change." Forcing Monad's real fields (`stampValueWei:
 *    bigint`, no UTXOs, no bitcore pubkey) into `ReceivedMessageWrapper` here would be exactly the
 *    silent type change PLAN.md warns against, so this ticket introduces its own minimal, honestly
 *    Monad-shaped type instead and leaves folding it into (or replacing) `ReceivedMessageWrapper`
 *    to #42, which owns `stores/chats.ts` and can make that call with the UI's actual needs in
 *    view.
 * 3. Topic observations use the wallet-specific canonical Forum model. A post's initial
 *    burn is positive; later votes may be positive or negative.
 */
import {
  ForumMessage,
  ForumMessageEntry,
  DiscoveredTopic,
} from "../forum-model";
import {
  MessageItem,
  type ChannelUpdateItem,
  type WalletSyncItem,
  type PaymentTransferItem,
} from "@frank/cashweb/types/messages";
export type {
  MessageItem,
  ChannelUpdateItem,
  WalletSyncItem,
  PaymentTransferItem,
} from "@frank/cashweb/types/messages";
import type { AccountType, BotRole, PaymentTransfer } from "@frank/codec";
export type { AccountType, BotRole, PaymentTransfer } from "@frank/codec";
import type { MonadRootBundle } from "../monad-wallet-material";
export type { MonadRootBundle } from "../monad-wallet-material";
import {
  ChainAddress,
  ChainFamily,
  ChainTransaction,
  FrankIdentityHandle,
  NativeWalletHandle,
  WalletHandle,
  LegacySendStage,
  LegacySendProgress,
  LegacyFeeEstimate,
  LegacySendResult,
  ContactSendProgress,
  ContactSendResult,
  ContactSendParams,
} from "./chain-wallet";

export type {
  ChainAddress,
  ChainFamily,
  ChainTransaction,
  FrankIdentityHandle,
  NativeWalletHandle,
  WalletHandle,
  LegacySendStage,
  LegacySendProgress,
  LegacyFeeEstimate,
  LegacySendResult,
  ContactSendProgress,
  ContactSendResult,
  ContactSendParams,
  ContactPaymentInfo,
  PreparedContactPayment,
  ReceivedPayment,
  ReceivedPaymentStatus,
  ReceivedCoinSweep,
  MessagePayment,
} from "./chain-wallet";
export {
  NativeTransactionSubmissionError,
  ContactPaymentPendingError,
  ContactPaymentFailedError,
  ContactPaymentReleasedError,
  ContactPaymentTooLargeError,
  MAX_STEALTH_ITEM_AMOUNT,
} from "./chain-wallet";

/** Canonical string form of an on-chain address, for storage keys, API calls, and equality checks.
 * For `MonadChain`, this is an EIP-55 checksummed `0x...` string (`../wallet/monad-identity.ts`) --
 * there is deliberately no separate "API" vs. "display" encoding the way Lotus's
 * `toAPIAddress`/`toDisplayAddress` (`../../utils/address.ts`) need, since EVM has exactly one
 * canonical address representation. */
/** @deprecated Legacy BIP39 recovery input; normal Monad creation should use MonadRootBundle. */
export interface HDSeed {
  /** BIP-39 mnemonic phrase. */
  mnemonic: string;
  /** Optional BIP-39 25th-word passphrase. Defaults to none. */
  passphrase?: string;
  /** Optional candidate derivation path. Defaults to MONAD_IDENTITY_DERIVATION_PATH. */
  path?: string;
}

/** The generic per-user wallet handle every `ActiveChain` method that needs a sender identity
 * takes. See this file's header, deviation 1: concrete chain implementations (`MonadChain`) attach
 * more than `identity` to the object they actually hand back from `createWallet`; this interface
 * only promises what every chain implementation must have. */
/** A looked-up identity's registered profile/pubkey -- `contacts.ts` (#42) needs this to resolve a
 * coparty's encryption key; the Lotus-side equivalent is `../wallet/lotus-identity.ts`'s
 * `fetchIdentityPubKey`, which Monad had no analog of before this ticket
 * (`../wallet/monad-identity.ts`'s `fetchMonadProfile`). */
export interface ProfileInfo {
  address: ChainAddress;
  /** Raw registered public key bytes (secp256k1), if any -- needed to derive an ECDH shared key
   * for direct-message encryption (`../wallet/monad-message-envelope.ts`). */
  pubKey: Uint8Array;
  /** Optional user-facing profile fields carried by the signed registration. */
  name?: string;
  username?: string;
  bio?: string;
  location?: string;
  links?: Array<{ type: string; url: string; label?: string }>;
  avatar?: string;
  /** Self-declared automated account (#311); see `MonadProfileFields.bot`. */
  bot?: boolean;
  /** Account type (ticket #1120). 0=person, 1=bot, 2=service, 3=org. */
  accountType?: AccountType;
  /** Specialized bot or service role (ticket #1120). */
  botRole?: BotRole;
  spendKeys?: Array<{ keyType: number; keyBytes: Uint8Array }>;
  curveKeys?: {
    secp256k1?: Uint8Array;
    ed25519?: Uint8Array;
  };
}

export interface DirectMessageSendResult {
  payloadDigest: string;
  stampValueWei: bigint;
  stampPayments: StampPaymentInfo[];
  paymentTransfers?: PaymentTransfer[];
  /** Main-account transactions used to prepare sender inventory for this Send, if any. */
  preparationTxHashes: string[];
}

export type DirectMessagePreparationProgress =
  | { stage: "checking" }
  | {
      stage: "funding";
      completed: number;
      total: number;
      feeReserveWei: bigint;
      txHash?: string;
    }
  | { stage: "ready"; fundingTxHashes: string[] };

/** A single decrypted, received direct message. See this file's header, deviation 2, for why this
 * isn't `ReceivedMessageWrapper` (`../types/user-interface.ts`). */
export interface DirectMessageReceived {
  senderAddress: ChainAddress;
  /** Compressed signing key of a sender admitted through the installed directory (canonical
   * messages only). When present, no display profile is needed to show the message. */
  senderPublicKey?: Uint8Array;
  recipientAddress: ChainAddress;
  /** Compressed signing key of recipient when admitted through directory. */
  recipientPublicKey?: Uint8Array;
  /** True for outbound/sent messages retrieved from the both-directions mailbox. */
  outbound?: boolean;
  items: MessageItem[];
  conversationId?: string;
  /** The conversation subject this message carries: present on a conversation's first message
   * and on a rename, absent otherwise. Authenticated content of the message's sender. */
  conversationName?: string;
  messageId?: string;
  /** Bare (no `0x`) hex `payload_hash` of the stamped message this was decoded from. */
  payloadDigest: string;
  /** Wei actually paid across the message's stamp transactions (read back from the signed raw
   * transactions, not merely echoing a configured constant -- see `./monad-chain.ts`). */
  stampValueWei: bigint;
  stampPayments: StampPaymentInfo[];
  /** A canonical message: the public shared point its stamp accounts are derived from (hex). */
  stampSharedPoint?: string;
  paymentTransfers?: PaymentTransfer[];
  /** Milliseconds since the Unix epoch, as recorded by the relay. */
  receivedTime: number;
}

export interface StampPaymentInfo {
  txHash: string;
  destinationAddress: string;
  valueWei: bigint;
  /** A received canonical message: which of the message's payments this is. With the message's
   * `stampSharedPoint` it is what the recipient derives the one-time account's key from. */
  childIndex?: number;
  /** The signed transaction the message carried for this payment (hex), when it carried one:
   * what lets the recipient put the payment on the chain itself. */
  rawTx?: string;
}

export interface RecoveredStampPaymentInfo {
  payloadDigest: string;
  childIndex: number;
  txHash: string;
  address: ChainAddress;
  valueWei: bigint;
  status: "discovered" | "sweep-pending" | "swept";
  sweepTxHash?: string;
}

export type RecoveredStampPaymentSweepResult =
  | { swept: true; txHash: string; valueWei: bigint }
  | {
      swept: false;
      reason: "below-dust-threshold" | "pending";
      balanceWei?: bigint;
      dustThresholdWei?: bigint;
      txHash?: string;
    };

/** What the sender's client knows about one earlier outgoing attempt (ticket #269/#270); see
 * `MonadStampAttemptStatus` in `../monad-stamp-client.ts` for the legacy path's meaning. On the
 * canonical path `dead` is final: the relay answered that it ended delivery of that exact payment
 * set, so the message was not delivered and never will be by that attempt. It does not say the
 * signed payments cannot land: the wallet keeps them and their reserved accounts, and other
 * messages send from other accounts. Never pay again for the same message on any status without
 * the user's explicit say-so. */
export type DirectMessagePaymentState =
  | "pending"
  | "spent"
  | "reverted"
  | "failed";
export type DirectMessageAttemptStatus =
  | "live"
  | "delivered"
  | "dead"
  | "unknown";

/** Set by the wallet on the error of a refused `DirectMessageClient.send` call; read it only
 * through {@link isDirectMessageNotAttempted}. */
export const directMessageNotAttempted: unique symbol = Symbol(
  "frank.directMessageNotAttempted"
);

/** The wallet's statement about ONE rejected `DirectMessageClient.send` call: that call created
 * nothing of its own -- no payment intent, link, reservation, funding or submission. The call may
 * still have finished or re-sent EARLIER attempts. It says nothing about them or about any other
 * call for the same message: the wallet does not know which calls carry one message. False means
 * the call may have had an effect and must be reconciled, not repeated.
 *
 * Rules for the caller:
 * - Repeat a message only if no earlier call for that same message, in any process lifetime,
 *   resolved, reported an attempt (`onAttemptCreated`) or was rejected without this label.
 * - Test the rejection object itself, when it is caught: never its `.cause`, a wrapper or a
 *   stored reference. For anything but a rejection of `send` the answer means nothing.
 * - Never persist the answer.
 * - A caller that passed its own `messageId` may call again with that same ID after any
 *   rejection, labelled or not: the wallet never makes a second attempt for an ID it already has
 *   one for, and answers {@link DirectMessageAlreadyAttemptedError} or
 *   {@link DirectMessageAttemptUnlinkedError} instead. Neither of those, nor
 *   {@link DirectMessageArgumentError}, ever carries the label. */
export function isDirectMessageNotAttempted(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, directMessageNotAttempted) === true
  );
}

/** `send` was given a `conversationId` or `messageId` that is neither 16 bytes nor their
 * lowercase `8-4-4-4-12` form. A permanent caller error: the same call can never succeed, so it is
 * never labelled as not attempted (a labelled refusal invites a retry). The call did nothing. */
export class DirectMessageArgumentError extends Error {
  constructor(readonly argument: "conversationId" | "messageId") {
    super(
      `${argument} must be 16 bytes or their lowercase 8-4-4-4-12 hexadecimal form. Nothing was paid or sent.`
    );
    this.name = "DirectMessageArgumentError";
  }
}

/** `send` was asked, explicitly, for a paid stamp smaller than what the chain charges to move it
 * (`floorWei`: one transfer's fee right now). Nothing was paid or sent. Pay at least the floor,
 * or send the message with no stamp. */
export class DirectMessageStampBelowFeeError extends Error {
  constructor(readonly stampValueWei: bigint, readonly floorWei: bigint) {
    super(
      `A stamp of ${stampValueWei} wei is less than the ${floorWei} wei the chain charges to move it. Nothing was paid or sent: pay at least ${floorWei} wei, or send without a stamp.`
    );
    this.name = "DirectMessageStampBelowFeeError";
  }
}

/** `send` was given a `messageId` this wallet already made an attempt for. This call created and
 * re-sent nothing. Reconcile `payloadDigest` (the ORIGINAL attempt's); never send the message under
 * a new ID. The wallet compares no content: `recipientSubject` is the compressed signing key (hex)
 * the original attempt was sealed to, for the caller to compare with its own record. Never labelled
 * as not attempted. */
export class DirectMessageAlreadyAttemptedError extends Error {
  constructor(
    readonly messageId: string,
    readonly payloadDigest: string,
    readonly recipientSubject: string
  ) {
    super(
      `This wallet already made an attempt for message ${messageId}. Nothing new was paid or sent.`
    );
    this.name = "DirectMessageAlreadyAttemptedError";
  }
}

/** `send` was given a `messageId` for which this wallet's payment journal holds a record that no
 * saved message link accounts for. This call created nothing. The wallet holds every send while
 * that record stands, and no operation clears it yet (restoring the link from the journal record
 * is wallet recovery work of its own): show the wallet as blocked. Calling again never pays; it
 * gives this answer, or the original attempt if a restart finds the link after all. Never labelled
 * as not attempted. */
export class DirectMessageAttemptUnlinkedError extends Error {
  constructor(readonly messageId: string) {
    super(
      `This wallet holds a payment record for message ${messageId} with no saved link. Sending is held so nothing is paid twice.`
    );
    this.name = "DirectMessageAttemptUnlinkedError";
  }
}

/**
 * How many further messages `DirectMessageClient.fundAhead` keeps sender accounts funded for.
 * One: the two single-use accounts the next message spends. It is not a host option, because a
 * larger number does not do what it says today: a send selects greedily over every funded
 * account, so with two pairs funded the first message takes three accounts, strands part of one
 * and leaves the second message short. Raising this needs selection that takes one pair at a time.
 */
export const FUND_AHEAD_MESSAGES = 1;

/** What one `DirectMessageClient.fundAhead` call did. For logs and tests; nothing to act on. */
export interface DirectMessageFundAheadResult {
  /**
   * - `ready`: the next message's accounts were already funded; nothing moved.
   * - `funded`: this call's transfers confirmed (`fundingTxHashes`).
   * - `not-funded`: nothing more could be funded now (`reason`). A transfer this or an earlier
   *   call recorded is finished by a later call or by the next send; never signed again.
   * - `unavailable`: this wallet has no canonical sender accounts to fund.
   */
  outcome: "ready" | "funded" | "not-funded" | "unavailable";
  fundingTxHashes: string[];
  reason?: string;
}

export interface DirectMessageClient {
  /**
   * Funds the single-use sender accounts of the next {@link FUND_AHEAD_MESSAGES} message, at the
   * wallet's default stamp value, before that message exists, so its `send` does not wait for
   * funding. Absent on a chain whose messages need no such accounts.
   *
   * It is the funding a `send` does for itself, through the same recorded path: each transfer's
   * exact signed bytes are durable before they are submitted, and a transfer interrupted at any
   * point is finished from that record, never signed a second time. It takes only accounts no
   * operation holds, pays only from the wallet's main account, and one call signs at most two
   * transfers moving at most the default stamp value plus two fee reserves (a reserve is capped
   * at the stamp value); it moves nothing when a transfer's fee would exceed the value moved or
   * while an earlier funding transfer is unresolved. It funds the pair or nothing: when the main
   * account cannot pay for both accounts it leaves the money for the send, whose own funding may
   * settle for one. While it runs it holds the wallet's queue as a send's own funding does, but
   * waits only a few seconds for each receipt; a transfer still unconfirmed then stays recorded
   * and is finished later.
   *
   * The HOST decides when: after its recovery pass has run, after a message was sent, when the
   * balance grew. Never at wallet open. Calls are single flight and repeatable: with the accounts
   * ready a call makes no request, and after a pass that could fund nothing the wallet waits
   * (seconds, doubling to minutes) before it looks again, answering `not-funded` meanwhile with
   * no request; a send, or a balance read that shows more money, ends that wait. Do not await it
   * in a poll; catch its rejection. It rejects only for a closed or foreign handle or when the
   * wallet's queue refuses the operation; a funding failure resolves as `not-funded`.
   */
  fundAhead?(params: {
    wallet: WalletHandle;
  }): Promise<DirectMessageFundAheadResult>;

  /** A rejection may carry the wallet's not-attempted label for this one call; see
   * {@link isDirectMessageNotAttempted}. Without it, assume the call may have had an effect. */
  send(params: {
    wallet: WalletHandle;
    recipient: ChainAddress;
    items: MessageItem[];
    /** 16 bytes or their lowercase `8-4-4-4-12` form; anything else supplied rejects with
     * {@link DirectMessageArgumentError}. Only `undefined` means omitted. */
    conversationId?: string | Uint8Array;
    /** The conversation's subject, carried in the message. Supply it only on the first message
     * of a conversation that has one and on a message that renames it; 1 to 512 characters,
     * not only whitespace, no control characters. */
    conversationName?: string;
    /** Sealed message identity chosen by the caller, in the same two forms and as strictly
     * checked. The caller must have stored it durably before this call. A repeat of an ID this
     * wallet already has an attempt for rejects with {@link DirectMessageAlreadyAttemptedError}
     * (or {@link DirectMessageAttemptUnlinkedError}) before anything else is looked at.
     * Omitted: the wallet draws a random one. */
    messageId?: string | Uint8Array;
    /** Raw native-chain value attached as the mandatory stamp payment. */
    stampValue?: bigint;
    onPreparationProgress?: (
      progress: DirectMessagePreparationProgress
    ) => void;
    /** Called once this send's exact payment set is durably journaled, before it is submitted to
     * the relay, with its `payloadDigest` (the eventual `DirectMessageSendResult.payloadDigest`).
     * Lets the caller tie its own pending message to the attempt for `reconcileAttempts`. */
    onAttemptCreated?: (payloadDigest: string) => void | Promise<void>;
    /** Called with the message's `payloadDigest` once it is sealed and BEFORE anything durable is
     * written from which its bytes could be submitted (the payment intent of a paid message) and
     * before any byte is handed to the relay (a free message). Awaited; if it rejects, nothing was
     * recorded or sent. After it resolves the message may leave at any time, also after a restart:
     * a caller that must know "no byte of this ever left the device" records the digest here. */
    onBeforeExposure?: (payloadDigest: string) => void | Promise<void>;
  }): Promise<DirectMessageSendResult>;
  /** Re-sends the SAME exact bytes of every still-live earlier attempt (idempotent and free: the
   * relay answers 200 for an already-delivered set, and 503 while it is pending), then reports
   * what is now known about each requested `payloadDigest`. Never builds or signs a payment. */
  reconcileAttempts(params: {
    wallet: WalletHandle;
    payloadDigests: string[];
    /** Idempotent re-PUT budget per live attempt; defaults to a single try (callers back off). */
    maxPutAttempts?: number;
  }): Promise<Record<string, DirectMessageAttemptStatus>>;
  /** Payload hashes of every attempt the wallet can still account for that is not in
   * `knownDigests`: payments no message points at. Re-sends live attempts first, so a
   * just-resumed one is included. An attempt with no outcome yet is always reported. A delivered
   * one is reported in every session, also after the wallet is reopened, until a message points
   * at it (it was once in `knownDigests`) or `resolveUnattributedAttempts` names it. (The legacy
   * untyped Monad path only remembers delivered attempts for the life of the process.) */
  unattributedAttempts(params: {
    wallet: WalletHandle;
    knownDigests: string[];
  }): Promise<string[]>;
  /** Durably records the user's answer for delivered attempts reported by
   * `unattributedAttempts`: they stop being reported. Call it only after the user explicitly
   * chose what to do about them. Attempts with no outcome yet are left as they are. */
  resolveUnattributedAttempts(params: {
    wallet: WalletHandle;
    payloadDigests: string[];
  }): Promise<void>;
  /** Durably marks an attempt as discarded/dead so it stops blocking subsequent sends.
   * Call when the user explicitly discards or deletes a failed/pending message. */
  /**
   * What the chain has shown, so far, of each stamp payment of a message this wallet sent, in
   * payment order; `undefined` for a digest this wallet has no record of. Reads the wallet's own
   * record and makes no request: `reconcileAttempts` is what looks at the chain.
   * - `pending`: signed, not yet seen in a block. Its account stays claimed.
   * - `spent` / `reverted`: in a block. A reverted payment consumed its account all the same.
   * - `failed`: the account's nonce was consumed by another transaction; this payment can never
   *   land. It is never paid again.
   * Delivery (`DirectMessageAttemptStatus`) and payment are separate facts.
   */
  paymentsOf?(params: {
    wallet: WalletHandle;
    payloadDigest: string;
  }): DirectMessagePaymentState[] | undefined;
  /**
   * The smallest paid stamp this wallet sends right now: what the chain charges for the one
   * transfer that moves it, from the node's current gas price (cached for a few seconds). A
   * default or suggested stamp should be at least this; `send` raises its own default to it and
   * refuses an explicit smaller `stampValue` with {@link DirectMessageStampBelowFeeError}.
   */
  minimumStamp?(params: { wallet: WalletHandle }): Promise<bigint>;
  discardAttempt?(params: {
    wallet: WalletHandle;
    payloadDigest: string;
  }): Promise<void>;
  /** Returns messages at or after `sinceMs`, ordered by time. If a later inbox page could not be
   * fetched, the result is cut back to a prefix ending on a complete timestamp group and
   * `onTruncated` is called: advancing `sinceMs` to `lastReceivedTime + 1` is then safe and the
   * rest arrives on the next poll. If no complete group exists, the call rejects instead.
   * `onIncompleteTimestamp` reports a relay row that could not yet be translated because its
   * sender profile was temporarily unavailable (transport failure). Callers must keep that
   * inclusive timestamp in their replay window even though the incomplete row is absent from the
   * returned array.
   * `onQuarantinedTimestamp` reports a relay row that is terminally undeliverable because the
   * registry authoritatively has no profile for its sender (HTTP 404 -- registered absence, not a
   * transport failure). The row is absent from the returned array and will stay so, so callers
   * durably quarantine the reported receipt and let their cursor pass it; keeping it in the
   * replay window would let one paid envelope from an unregistered sender pin the bounded inbox
   * scan forever. A row this client cannot decode or validate at all is reported the same way;
   * having no readable payload digest, it is identified by the relay's submission identity. */
  fetchSince(params: {
    wallet: WalletHandle;
    sinceMs: number;
    onTruncated?: (reason: Error) => void;
    onIncompleteTimestamp?: (receivedTime: number) => void;
    onQuarantinedTimestamp?: (
      receivedTime: number,
      payloadDigest: string
    ) => void;
  }): Promise<DirectMessageReceived[]>;
  /** Subscribes to real-time both-direction mailbox pushes over WebSocket. */
  subscribeMailboxStream?(params: {
    wallet: WalletHandle;
    onRecord: (record: DirectMessageReceived) => void;
    onError?: (error: Error) => void;
  }): () => void;
  listRecoveredStampPayments(params: {
    wallet: WalletHandle;
  }): Promise<RecoveredStampPaymentInfo[]>;
  sweepRecoveredStampPayment(params: {
    wallet: WalletHandle;
    payloadDigest: string;
    childIndex: number;
    destination: ChainAddress;
  }): Promise<RecoveredStampPaymentSweepResult>;
}

/** Standard native-asset wallet operations, independent of Frank's mandatory message stamps. */
export interface NativeTransferClient {
  getBalance(params: { wallet: NativeWalletHandle }): Promise<bigint>;
  send(params: {
    wallet: NativeWalletHandle;
    recipient: ChainAddress;
    value: bigint;
    /** The fee the user reviewed, as a ceiling, for chains that estimate one before sending. */
    maxFee?: bigint;
    onSigned?: (signed: ChainTransaction) => Promise<void>;
  }): Promise<ChainTransaction>;
  getTransactionStatus(params: {
    wallet: NativeWalletHandle;
    transaction: ChainTransaction;
  }): Promise<"confirmed" | "failed" | "pending" | "unknown">;

  /**
   * Sends funds to an external legacy destination address, automatically aggregating
   * fragmented sub-accounts or UTXOs using the chain's appropriate consolidation strategy.
   */
  sendLegacy?(params: {
    wallet: NativeWalletHandle;
    recipient: ChainAddress;
    value: bigint;
    onProgress?: (progress: LegacySendProgress) => void;
    onSigned?: (signed: ChainTransaction) => Promise<void>;
    priorityFeeMicroLamports?: bigint;
  }): Promise<LegacySendResult>;

  /** Computes the estimated network fee required to deliver `value` to a legacy destination. */
  estimateLegacyFee?(params: {
    wallet: NativeWalletHandle;
    recipient: ChainAddress;
    value: bigint;
  }): Promise<LegacyFeeEstimate>;

  /**
   * Pays a Frank contact at a one-time address only the contact can spend from, and delivers the
   * message that tells the contact's wallet where the money is. See
   * `NativeWalletHandle.sendToContact`.
   */
  sendToContact?(
    params: ContactSendParams & { wallet: NativeWalletHandle }
  ): Promise<ContactSendResult>;
}

/** Native-transfer guarantees required by the currently selected full application chain. */
export interface ActiveNativeTransferClient extends NativeTransferClient {
  send(params: {
    wallet: NativeWalletHandle;
    recipient: ChainAddress;
    value: bigint;
    /** Called with the transaction hash after signing and BEFORE any byte is broadcast. It is
     * awaited; if it rejects, nothing is broadcast and `send` rejects with that error. Lets a
     * caller persist "this hash may be paid" durably first, so a lost broadcast response or a
     * killed app can never leave a paid transfer with no record. */
    onSigned?: (signed: ChainTransaction) => Promise<void>;
  }): Promise<ChainTransaction>;
  /** What the node says about a transaction hash: mined ok (`confirmed`), mined but reverted
   * (`failed`), known but not mined (`pending`), or not known to the node (`unknown`; only
   * meaningful as "not paid" after enough time has passed and the caller says so). */
  getTransactionStatus(params: {
    wallet: NativeWalletHandle;
    transaction: ChainTransaction;
  }): Promise<"confirmed" | "failed" | "pending" | "unknown">;

  sendLegacy?(params: {
    wallet: NativeWalletHandle;
    recipient: ChainAddress;
    value: bigint;
    onProgress?: (progress: LegacySendProgress) => void;
    onSigned?: (signed: ChainTransaction) => Promise<void>;
    priorityFeeMicroLamports?: bigint;
  }): Promise<LegacySendResult>;

  estimateLegacyFee?(params: {
    wallet: NativeWalletHandle;
    recipient: ChainAddress;
    value: bigint;
  }): Promise<LegacyFeeEstimate>;

  sendToContact?(
    params: ContactSendParams & { wallet: NativeWalletHandle }
  ): Promise<ContactSendResult>;
}

/** A paid topic post may have reached the relay, but the chain adapter could not prove whether
 * it landed. Callers must not treat this as a definitive failure or offer an automatic retry:
 * doing so could pay for the same logical submission twice. The chain-specific error is retained
 * as `cause` for diagnostics without leaking that implementation into app-level policy. */
export class TopicPostOutcomeUnknownError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "TopicPostOutcomeUnknownError";
    this.cause = cause;
  }
}

export interface TopicBroadcastClient {
  reconcileOperations(params: { wallet: WalletHandle }): Promise<void>;
  post(params: {
    wallet: WalletHandle;
    topic: string;
    entries: ForumMessageEntry[];
    /** Canonical posts require an up vote; negative votes are separate operations. */
    direction: "up" | "down";
    voteWeightWei: bigint;
    parentDigest?: string;
    /** Progress of preparing the burn account (same stages as a direct message's stamp-account
     * preparation, always a single funding transaction here). */
    onPreparationProgress?: (
      progress: DirectMessagePreparationProgress
    ) => void;
  }): Promise<{ payloadDigest: string }>;
  vote(params: {
    wallet: WalletHandle;
    payloadDigest: string;
    voteWeightWei: bigint;
    direction: "up" | "down";
    onPreparationProgress?: (
      progress: DirectMessagePreparationProgress
    ) => void;
  }): Promise<void>;
  fetchByTopic(params: {
    wallet?: WalletHandle;
    topic: string;
    sinceMs?: number;
  }): Promise<ForumMessage[]>;
  fetchOne(payloadDigest: string): Promise<ForumMessage | undefined>;
  discoverTopics(): Promise<DiscoveredTopic[]>;
}

export interface ChainCapabilities {
  readonly profiles: boolean;
  readonly directMessages: boolean;
  readonly topics: boolean;
  readonly stealthPayments: boolean;
  /** Explicit consolidation architecture supported by this chain adapter. */
  readonly legacyConsolidation?: "evm-staging" | "utxo-atomic" | "solana-bundle";
}

/** Native-asset surface implemented by every chain returned from the factory. */
export interface NativeAssetChain {
  readonly family: ChainFamily;
  readonly chainIdentifier: string;
  readonly name: string;
  /** Display denomination, e.g. `'MON'`. */
  readonly unit: string;
  readonly networkId?: string;
  readonly network?: "mainnet" | "testnet" | "regtest";
  readonly isTestnet?: boolean;
  readonly capabilities: ChainCapabilities;
  toDisplayAmount(raw: bigint): string;
  fromDisplayAmount(display: string): bigint;
  addressToString(addr: ChainAddress): string;
  transactionToString(transaction: ChainTransaction): string;
  /** @deprecated Use addressToString. */
  formatAddress(addr: ChainAddress): string;
  parseAddress(input: string): ChainAddress | undefined;
  createWallet(seed: HDSeed): Promise<NativeWalletHandle>;
  nativeTransfers: NativeTransferClient;
  /** Returns the address of the StateChannel contract on this chain's network, or throws if it is not deployed there. */
  getStateChannelAddress?(): string;
  /** Returns the address of the GenericHTLC contract on this chain's network, or throws if it is not deployed there. */
  getHtlcAddress?(): string;
}

/** Full Frank application capability set. The selected implementation remains Monad. */
export interface ActiveChain extends NativeAssetChain {
  readonly capabilities: ChainCapabilities & {
    readonly profiles: true;
    readonly directMessages: true;
    readonly topics: true;
  };
  /** Default raw native-chain value for a direct-message stamp payment. */
  readonly defaultStampValue: bigint;
  /** Default raw native-chain value burned for a topic post or vote. */
  readonly defaultTopicVoteValue: bigint;
  createWallet(
    roots: MonadRootBundle
  ): Promise<NativeWalletHandle & WalletHandle & { close(): Promise<void> }>;
  /** @deprecated Legacy recovery compatibility. #699 owns the app switch and deletion. */
  createWallet(seed: HDSeed): Promise<NativeWalletHandle & WalletHandle>;
  nativeTransfers: ActiveNativeTransferClient;
  /** Look up an identity's registered profile/pubkey. Returns `undefined` if nothing is
   * registered under `addr` yet. `opts.relayBaseUrl`, when given, looks the address up against
   * that relay instead of this chain's own configured default (ticket #78 -- a client-initiated,
   * one-off "finger this specific relay" lookup, not a change to which relay the chain otherwise
   * talks to). */
  fetchProfile(
    addr: ChainAddress,
    opts?: { relayBaseUrl?: string }
  ): Promise<ProfileInfo | undefined>;
  directMessages: DirectMessageClient;
  topics: TopicBroadcastClient;
  /** Returns the address of the StateChannel contract on this chain's network, or throws if it is not deployed there. */
  getStateChannelAddress(): string;
  /** Returns the address of the GenericHTLC contract on this chain's network, or throws if it is not deployed there. */
  getHtlcAddress(): string;
}

/** Parsed result of {@link parseAddressWithOptionalRelay}. */
export interface AddressWithOptionalRelay {
  /** Everything before the last `@`, or the whole input if there's no `@`. */
  address: string;
  /** Everything after the last `@`, normalized to an `http(s)://` base URL, or `undefined` if
   * the input had no `@`. */
  relayBaseUrl?: string;
}

/** Parses a "finger"-style `address@relayHost` input (ticket #78): splits on the *last* `@` (an
 * address itself never contains one, so this is unambiguous), and normalizes the right-hand side
 * into a base URL `fetchProfile`'s `opts.relayBaseUrl` can use directly.
 *
 * - No `@` present: returns `{ address: input }` -- today's existing single-field behavior,
 *   completely unchanged (this is the common case; a future UI built on this can use one input
 *   field for both, not two).
 * - `@relayHost` present: `relayHost` is used as-is if it already has an `http://`/`https://`
 *   scheme, otherwise `https://` is prepended (the common case -- typing a bare hostname should
 *   mean "the usual secure default", not force the user to type a scheme every time).
 *
 * Pure parsing only -- does not validate that `address` is a real chain address (that's
 * `ActiveChain.parseAddress`'s job) or that `relayBaseUrl` points at a reachable relay (that's
 * whatever calls `fetchProfile` with it). Deliberately not wired into any UI component yet -- see
 * issue #78's own comment thread for why the actual entry point (`AddContact.vue` or a new
 * dialog) is a separate, not-yet-decided UX question. */
export function parseAddressWithOptionalRelay(
  input: string
): AddressWithOptionalRelay {
  const at = input.lastIndexOf("@");
  if (at === -1) {
    return { address: input };
  }
  const address = input.slice(0, at);
  const host = input.slice(at + 1);
  const relayBaseUrl = /^https?:\/\//i.test(host) ? host : `https://${host}`;
  return { address, relayBaseUrl };
}
