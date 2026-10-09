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
  readonly conversationId: string;
  readonly peerAddress: string;
  readonly peerSubject: string;
  readonly timestampMs: number;
  readonly payloadDigest: string;
  readonly items: MessageItem[];
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

/** A reply the host stages durably before it is first sent, with one plugin value the host
 * commits at `commit.key` of `ctx.state`, once, when that same reply is observed delivered.
 * `expectedSha256` is the SHA-256 (lowercase hex) of the value the handler read at the key, or
 * `null` if it was absent; if the key holds anything else when the reply is sent or delivered the
 * invocation is held and nothing is overwritten. The key must be scoped to the conversation, and
 * the handler must not write it itself. A handler that returns one must not also have used
 * `reply()` or `sendMessage()` in that invocation. */
export interface PreparedReply {
  readonly kind: "prepared-reply";
  readonly text: string;
  readonly commit: {
    readonly key: string;
    readonly expectedSha256: string | null;
    readonly value: string;
  };
}

export interface FrankBotDefinition {
  readonly id: string;
  readonly defaultIdentityPath?: string;
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
}
