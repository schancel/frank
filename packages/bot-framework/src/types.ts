import {
  getAddress,
  type JsonRpcProvider,
  type TransactionReceipt,
} from "ethers";
import type { MessageItem } from "@frank/cashweb/types/messages";
import type { DirectMessageSendResult } from "@frank/wallet/chain";
import type { ForumMessageEntry } from "@frank/wallet/forum-model";

import type { AccountType, BotRole } from "@frank/codec";
export type { MessageItem, DirectMessageSendResult, ForumMessageEntry };

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
  reply(
    items: MessageItem[],
    options?: { stampValueWei?: bigint }
  ): Promise<DirectMessageSendResult>;
}

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
  readonly networkTag: "MONT" | "MON1";
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
    options?: { stampValueWei?: bigint }
  ): Promise<DirectMessageSendResult>;
  sendDirectMessage(
    recipientAddress: string,
    items: MessageItem[],
    conversationId?: string,
    options?: { stampValueWei?: bigint }
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
  readonly schedules?: BotScheduleDefinition[];
  getProfile(): BotProfile;
  onStart?(ctx: BotContext): Promise<void>;
  onStop?(ctx: BotContext): Promise<void>;
  onMessage(
    message: BotMessageContext,
    ctx: BotContext
  ): Promise<MessageItem[] | PreparedReply | void>;
  onNewUser?(user: NewUserEvent, ctx: BotContext): Promise<void>;
}

export interface BotHostOptions {
  relayBaseUrl?: string;
  networkTag?: "MONT" | "MON1";
  stateDir?: string;
  rpcUrl?: string;
  fundingPrivateKeyHex?: string;
  stampValueWei?: bigint;
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
}
