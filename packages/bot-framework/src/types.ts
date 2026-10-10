import {
  getAddress,
  type JsonRpcProvider,
  type TransactionReceipt,
} from "ethers";
import type { MessageItem } from "@frank/cashweb/types/messages";
import type { DirectMessageSendResult } from "@frank/wallet/chain";
import type { StampPaymentInfo } from "@frank/wallet/chain/active-chain";
import type { ForumMessageEntry } from "@frank/wallet/forum-model";

import type { AccountType, BotRole } from "@frank/codec";
export type {
  MessageItem,
  DirectMessageSendResult,
  ForumMessageEntry,
  StampPaymentInfo,
};

/** `messageId` (16 bytes as lowercase `8-4-4-4-12` hex) is the wallet's own repeat rule: it never
 * makes a second attempt, so never pays twice, for an ID it already has one for. */
export interface BotSendOptions {
  stampValueWei?: bigint;
  messageId?: string;
}

export function toChainAddress(raw: string): { raw: string } {
  return { raw: getAddress(raw) };
}

export interface BotProfile {
  name: string;
  /** Unique handle claimed on the relay at startup. Defaults to the bot's id. */
  username?: string;
  bio?: string;
  avatar?: string | Uint8Array;
  avatarPng?: Uint8Array;
  bot?: boolean; // defaults to true
  accountType?: AccountType;
  botRole?: BotRole;
}

export interface DirectoryPeerInfo {
  address: string;
  subject: string;
  pubKey: Uint8Array;
  displayName?: string;
  bio?: string;
  isBot?: boolean;
}

export interface NewUserEvent {
  address: string;
  registeredAtMs: number;
  displayName?: string;
  profile?: Partial<BotProfile>;
}

export interface BotStateStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  batch(
    ops: Array<
      { type: "put"; key: string; value: string } | { type: "del"; key: string }
    >
  ): Promise<void>;
  sublevel(name: string): BotStateStore;
}

export interface BotMessageContext {
  /** Absent: the default thread with this peer. */
  readonly conversationId?: string;
  readonly peerAddress: string;
  readonly peerSubject: string;
  readonly timestampMs: number;
  readonly payloadDigest: string;
  readonly items: MessageItem[];
  /** Wei paid to this bot with the message: the wallet's `DirectMessageReceived.stampValueWei`,
   * read from the stamp payments delivered with it, never a number the message's content states.
   * `0n` when the wallet reported no payment. It is not proof the transfers have confirmed. */
  readonly stampValueWei: bigint;
  /** The transfers `stampValueWei` is the sum of, as the wallet reported them: what a bot looks
   * up on chain before it acts on the money. */
  readonly stampPayments: readonly StampPaymentInfo[];
  reply(
    items: MessageItem[],
    options?: BotSendOptions
  ): Promise<DirectMessageSendResult>;
}

export type InterruptedMessage = Pick<
  BotMessageContext,
  "payloadDigest" | "peerAddress" | "conversationId" | "stampPayments"
>;

export interface BotScheduleDefinition {
  readonly id: string;
  readonly intervalMs?: number;
  readonly cron?: string;
  readonly runOnStartup?: boolean;
  handler(ctx: BotContext): Promise<void>;
}

export interface BotSubscriptionManager {
  subscribe(address: string, topic?: string): Promise<boolean>;
  unsubscribe(address: string, topic?: string): Promise<boolean>;
  isSubscribed(address: string, topic?: string): Promise<boolean>;
  listSubscribers(topic?: string): Promise<string[]>;
  broadcast(
    items: MessageItem[],
    topic?: string
  ): Promise<{ sent: number; failed: number }>;
  handleSubscriptionCommand(
    items: MessageItem[],
    senderAddress: string,
    topic?: string
  ): Promise<MessageItem[] | null>;
}

export interface BotContext {
  readonly botId: string;
  readonly address: string;
  readonly subject: string;
  readonly relayBaseUrl: string;
  readonly networkTag: "MONT" | "MON1" | "MONR";
  readonly provider: JsonRpcProvider;
  readonly state: BotStateStore;
  readonly subscriptions: BotSubscriptionManager;
  /** Aborted when the host starts stopping. A handler passes it to anything slow it waits on
   * (a model call, an HTTP request) so shutdown does not wait for it. */
  readonly stopping: AbortSignal;

  // --- Directory & Peer APIs ---
  lookupPeer(address: string): Promise<DirectoryPeerInfo | undefined>;
  sendMessage(
    recipientAddress: string,
    items: MessageItem[],
    conversationId?: string,
    options?: BotSendOptions
  ): Promise<DirectMessageSendResult>;
  sendDirectMessage(
    recipientAddress: string,
    items: MessageItem[],
    conversationId?: string,
    options?: BotSendOptions
  ): Promise<DirectMessageSendResult>;
  onNewUserRegistered(
    callback: (user: NewUserEvent) => void | Promise<void>
  ): void;

  // --- Financial & Transaction Operations ---
  sendTransfer(params: {
    to: string;
    valueWei: bigint;
  }): Promise<{ txHash: string }>;
  sendTransaction(params: {
    to: string;
    data?: string;
    valueWei?: bigint;
  }): Promise<{ txHash: string }>;
  buildAndSignTransfer(params: {
    to: string;
    valueWei: bigint;
  }): Promise<{ rawTx: string; txHash: string }>;
  waitForReceipt(
    txHash: string,
    timeoutMs?: number
  ): Promise<TransactionReceipt | null>;
  getBalance(address?: string): Promise<bigint>;
  /** What the wallet knows of one of this bot's own outgoing messages, by payload digest:
   * `delivered`, `live` (still being delivered), `dead` (the relay ended it: it never arrives by
   * that attempt) or `unknown`. A message is only known to have arrived on `delivered`. */
  attemptStatus(
    payloadDigest: string
  ): Promise<"live" | "delivered" | "dead" | "unknown">;

  // --- Topic & Forum Broadcasting ---
  publishTopicMessage?(params: {
    topic: string;
    entries: ForumMessageEntry[];
    voteWeightWei?: bigint;
  }): Promise<{ payloadDigest: string }>;
}

/** A text reply the host stores before it is first sent and then delivers itself: it is sent
 * again on later polls, and after a restart, until it is delivered, always as the same message,
 * so it is paid for once. A handler that returns one must not also have used `reply()` or
 * `sendMessage()` in that invocation. */
export interface PreparedReply {
  readonly kind: "prepared-reply";
  readonly text: string;
}

export interface FrankBotDefinition {
  readonly id: string;
  readonly defaultIdentityPath?: string;
  /** Replies this bot sends per hour to one peer that is itself a bot, before the host stops
   * handling that peer's messages (the loop guard: two bots must not answer each other for
   * ever). People are never limited. Unset: `DEFAULT_MAX_REPLIES_PER_PEER`. The operator's
   * `BotHostOptions.maxRepliesPerPeer` overrides it. */
  readonly maxRepliesPerPeer?: number;
  /** The largest single transfer this bot can owe from its own account (a game's biggest
   * payout), in wei. The host warns at registration when its top-up cannot cover it. */
  readonly maxPayoutWei?: bigint;
  readonly schedules?: BotScheduleDefinition[];
  getProfile(): BotProfile;
  onStart?(ctx: BotContext): Promise<void>;
  onStop?(ctx: BotContext): Promise<void>;
  onMessage(
    message: BotMessageContext,
    ctx: BotContext
  ): Promise<MessageItem[] | PreparedReply | void>;
  onNewUser?(user: NewUserEvent, ctx: BotContext): Promise<void>;
  /** A message whose handler was started and never finished (the process died), handed back
   * once after restart with the transfers it came with. The handler is not run again. A bot
   * that takes money with messages uses this to account for what the message paid: it may have
   * died before writing anything down. */
  onInterrupted?(message: InterruptedMessage, ctx: BotContext): Promise<void>;
}

export interface BotHostOptions {
  relayBaseUrl?: string;
  networkTag?: "MONT" | "MON1" | "MONR";
  stateDir?: string;
  rpcUrl?: string;
  fundingPrivateKeyHex?: string;
  /** The stamp of a message a bot sends on its own initiative, and the most it puts on a reply.
   * A reply carries what the sender paid, never more (see `replyStampWei` in the host). */
  stampValueWei?: bigint;
  /** The least the relay accepts for a paid message. Default: `CASHWEB_STAMP_MIN_BURN_VALUE_WEI`,
   * else 1000000000000 wei. A message that paid less is answered at this amount. */
  minStampValueWei?: bigint;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  watchRegistrations?: boolean;
  unrefTimers?: boolean;
  /** Operator override of every bot's replies-per-hour budget for a peer that is a bot, a
   * non-negative integer (0: never reply to a bot). Default: the `FRANK_BOT_MAX_REPLIES_PER_PEER` environment variable when
   * set; otherwise each bot's own `maxRepliesPerPeer`. */
  maxRepliesPerPeer?: number;
  /** How long the host keeps trying to deliver a stored reply before it gives up on it, logs
   * the peer and message at error level and lets that conversation go on. Default: one hour. */
  replyGiveUpMs?: number;
  /** The account a bot pays transfers from is topped up from the shared funding wallet when it
   * holds less than `topUpBelowWei` (default 0.3 MON, or `FRANK_BOT_TOP_UP_BELOW_WEI`), up to
   * `topUpToWei` (default 0.5 MON, or `FRANK_BOT_TOP_UP_TO_WEI`), which must be the greater. Set them so that the threshold
   * is at least the largest payout a bot on this host can owe. One top-up at a time per bot,
   * and none for five minutes after one went out. */
  topUpBelowWei?: bigint;
  topUpToWei?: bigint;
  /** What bot top-ups leave in the shared funding wallet, for the faucet that pays from it.
   * Default: `FAUCET_MIN_RESERVE_WEI`, else 0.1 MON, the faucet's own reserve. */
  fundingReserveWei?: bigint;
  /** The longest one relay or wallet call of a bot's poll, or one send of a stored reply, may
   * take before the host stops waiting for it. Default: 30 seconds. */
  callTimeoutMs?: number;
}
