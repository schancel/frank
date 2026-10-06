import {
  getAddress,
  type JsonRpcProvider,
  type TransactionReceipt,
} from "ethers";
import type { MessageItem } from "@frank/cashweb/types/messages";
import type { DirectMessageSendResult } from "@frank/wallet/chain";

export type { MessageItem, DirectMessageSendResult };

export function toChainAddress(raw: string): { raw: string } {
  return { raw: getAddress(raw) };
}

export interface BotProfile {
  name: string;
  bio?: string;
  avatar?: string | Uint8Array;
  avatarPng?: Uint8Array;
  bot?: boolean; // defaults to true
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
  reply(items: MessageItem[]): Promise<void>;
}

export interface BotContext {
  readonly botId: string;
  readonly address: string;
  readonly subject: string;
  readonly relayBaseUrl: string;
  readonly networkTag: "MONT" | "MON1";
  readonly provider: JsonRpcProvider;
  readonly state: BotStateStore;

  // --- Directory & Peer APIs ---
  lookupPeer(address: string): Promise<DirectoryPeerInfo | undefined>;
  sendMessage(
    recipientAddress: string,
    items: MessageItem[]
  ): Promise<DirectMessageSendResult>;
  sendDirectMessage(
    recipientAddress: string,
    items: MessageItem[]
  ): Promise<DirectMessageSendResult>;
  onNewUserRegistered(
    callback: (user: NewUserEvent) => void | Promise<void>
  ): void;

  // --- Financial & Transaction Operations ---
  sendTransfer(params: {
    to: string;
    valueWei: bigint;
  }): Promise<{ txHash: string }>;
  buildAndSignTransfer(params: {
    to: string;
    valueWei: bigint;
  }): Promise<{ rawTx: string; txHash: string }>;
  waitForReceipt(
    txHash: string,
    timeoutMs?: number
  ): Promise<TransactionReceipt | null>;
  getBalance(): Promise<bigint>;
}

export interface FrankBotDefinition {
  readonly id: string;
  getProfile(): BotProfile;
  onStart?(ctx: BotContext): Promise<void>;
  onStop?(ctx: BotContext): Promise<void>;
  onMessage(
    message: BotMessageContext,
    ctx: BotContext
  ): Promise<MessageItem[] | void>;
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
}
