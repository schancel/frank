import { computeAddress, getAddress } from "ethers";
import type {
  DirectMessageAttemptStatus,
  DirectMessageReceived,
} from "@frank/wallet/chain/active-chain";
import { LevelBotStateStore } from "./state-store";

const PREFIX = "host-inbound:v1:";
const OWNER = PREFIX + "owner";
const ROW = PREFIX + "dispatch:";
const MAX_DISPATCHES = 1024;
const MAX_REPLIES = 64;
export interface InboundOwner {
  chainIdentifier: string;
  botId: string;
  subject: string;
  address: string;
}
export interface InboundIdentity {
  digest: string;
  peerSubject: string;
  peerAddress: string;
  conversationId: string;
  messageId: string;
  receivedTime: number;
}
export interface ReplyCall {
  recipient: string;
  conversationId?: string;
  stampValue: string;
  digest?: string;
  observation?: DirectMessageAttemptStatus;
}
export interface InboundDispatch extends InboundIdentity {
  version: 1;
  phase: "started" | "completed";
  replies: ReplyCall[];
}
const copy = <T>(value: T): T => structuredClone(value);
const hold = (): never => {
  throw new Error(
    "Bot invocation admission held; preserve state and reconcile the original operation"
  );
};
const hash = (s: unknown): s is string =>
  typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const subject = (s: unknown): s is string =>
  typeof s === "string" && /^(02|03)[0-9a-f]{64}$/.test(s);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return hold();
  return value as Record<string, unknown>;
};
const keys = (row: Record<string, unknown>, allowed: string[]) =>
  Object.keys(row).every((k) => allowed.includes(k));
export function conversationIdentity(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/.test(
      value
    )
  )
    return hold();
  const hex = value.replace(/-/g, "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function address(value: unknown): string {
  if (typeof value !== "string") return hold();
  try {
    return getAddress(value).toLowerCase();
  } catch {
    return hold();
  }
}
function keyAddress(key: string): string {
  try {
    return computeAddress("0x" + key).toLowerCase();
  } catch {
    return hold();
  }
}
function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return hold();
  }
}
function validateOwner(owner: InboundOwner): void {
  if (
    !subject(owner.subject) ||
    keyAddress(owner.subject) !== owner.address ||
    !owner.chainIdentifier ||
    !owner.botId ||
    address(owner.address) !== owner.address
  )
    hold();
}
export function inboundIdentity(
  message: DirectMessageReceived,
  owner: InboundOwner
): InboundIdentity {
  const peerSubject =
    message.senderPublicKey &&
    Buffer.from(message.senderPublicKey).toString("hex");
  const recipientSubject =
    message.recipientPublicKey &&
    Buffer.from(message.recipientPublicKey).toString("hex");
  if (
    message.outbound ||
    !subject(peerSubject) ||
    recipientSubject !== owner.subject ||
    address(message.recipientAddress.raw) !== owner.address ||
    keyAddress(peerSubject) !== address(message.senderAddress.raw) ||
    peerSubject === owner.subject ||
    !hash(message.payloadDigest) ||
    !Number.isSafeInteger(message.receivedTime) ||
    message.receivedTime < 0 ||
    message.receivedTime >= Number.MAX_SAFE_INTEGER
  )
    return hold();
  return {
    digest: message.payloadDigest,
    peerSubject,
    peerAddress: address(message.senderAddress.raw),
    conversationId: conversationIdentity(message.conversationId),
    messageId: conversationIdentity(message.messageId),
    receivedTime: message.receivedTime,
  };
}
function validateRow(value: unknown): InboundDispatch {
  const r = object(value);
  if (
    !keys(r, [
      "version",
      "phase",
      "digest",
      "peerSubject",
      "peerAddress",
      "conversationId",
      "messageId",
      "receivedTime",
      "replies",
    ]) ||
    r.version !== 1 ||
    !["started", "completed"].includes(String(r.phase)) ||
    !hash(r.digest) ||
    !subject(r.peerSubject) ||
    address(r.peerAddress) !== r.peerAddress ||
    address(r.peerAddress) !== keyAddress(r.peerSubject) ||
    conversationIdentity(r.conversationId) !== r.conversationId ||
    conversationIdentity(r.messageId) !== r.messageId ||
    !Number.isSafeInteger(r.receivedTime) ||
    Number(r.receivedTime) < 0 ||
    Number(r.receivedTime) >= Number.MAX_SAFE_INTEGER ||
    !Array.isArray(r.replies) ||
    r.replies.length > MAX_REPLIES
  )
    return hold();
  for (const raw of r.replies) {
    const call = object(raw);
    if (
      !keys(call, [
        "recipient",
        "conversationId",
        "stampValue",
        "digest",
        "observation",
      ]) ||
      address(call.recipient) !== call.recipient ||
      typeof call.stampValue !== "string" ||
      !/^(0|[1-9][0-9]{0,77})$/.test(call.stampValue) ||
      (call.conversationId !== undefined &&
        conversationIdentity(call.conversationId) !== call.conversationId) ||
      (call.digest !== undefined && !hash(call.digest)) ||
      (call.observation !== undefined &&
        (!call.digest ||
          !["live", "unknown", "dead", "delivered"].includes(
            String(call.observation)
          ))) ||
      (r.phase === "completed" && call.observation !== "delivered")
    )
      return hold();
  }
  return r as unknown as InboundDispatch;
}

/** Invocation/correlation owner only. Wallet owns exact requests, reservations and settlement.
 * A started invocation is never executed again, even if every recorded reply later delivers. */
export class InboundOperationStore {
  private readonly rows = new Map<string, InboundDispatch>();
  private tail: Promise<unknown> = Promise.resolve();
  private faulted = false;
  private closed = false;
  private constructor(
    private readonly state: LevelBotStateStore,
    readonly owner: Readonly<InboundOwner>
  ) {}

  static async preflight(
    state: LevelBotStateStore,
    freshIdentity: boolean
  ): Promise<boolean> {
    const marker = await state.get(OWNER);
    if (marker !== undefined) return false;
    if (!freshIdentity || (await state.readEntries("", 1)).length)
      return hold();
    return true;
  }
  static async open(
    state: LevelBotStateStore,
    owner: InboundOwner,
    fresh: boolean
  ): Promise<InboundOperationStore> {
    validateOwner(owner);
    const instance = new InboundOperationStore(
      state,
      Object.freeze(copy(owner))
    );
    const marker = await state.get(OWNER);
    if (marker === undefined) {
      if (!fresh || (await state.readEntries("", 1)).length) return hold();
      await instance.persist([
        {
          type: "put",
          key: OWNER,
          value: JSON.stringify({ version: 1, ...owner }),
        },
      ]);
    } else {
      const m = object(parse(marker));
      if (
        !keys(m, [
          "version",
          "chainIdentifier",
          "botId",
          "subject",
          "address",
        ]) ||
        m.version !== 1 ||
        Object.entries(owner).some(([key, value]) => m[key] !== value)
      )
        return hold();
    }
    const entries = await state.readEntries(
      "host-inbound:",
      MAX_DISPATCHES + 2
    );
    if (entries.length > MAX_DISPATCHES + 1) return hold();
    const digests = new Set<string>();
    for (const [key, value] of entries) {
      if (key === OWNER) continue;
      const row = validateRow(parse(value));
      if (key !== ROW + row.digest) return hold();
      for (const call of row.replies)
        if (call.digest) {
          if (digests.has(call.digest)) return hold();
          digests.add(call.digest);
        }
      const completed = await state.get("digest:" + row.digest);
      if ((row.phase === "completed") !== (completed !== undefined))
        return hold();
      instance.rows.set(row.digest, row);
    }
    const cursor = await state.get("cursor:lastPollTimestamp");
    if (
      cursor !== undefined &&
      (!/^[0-9]+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
    )
      return hold();
    for (const row of instance.rows.values())
      if (
        row.phase === "completed" &&
        (cursor === undefined || Number(cursor) <= row.receivedTime)
      )
        return hold();
    return instance;
  }
  assertOpen(): void {
    if (this.faulted || this.closed) hold();
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(() => {
      this.assertOpen();
      return operation();
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
  private async persist(
    ops: Parameters<LevelBotStateStore["durableBatch"]>[0]
  ): Promise<void> {
    this.assertOpen();
    try {
      await this.state.durableBatch(ops);
    } catch {
      this.faulted = true;
      hold();
    }
  }
  private async save(row: InboundDispatch): Promise<void> {
    validateRow(row);
    await this.persist([
      { type: "put", key: ROW + row.digest, value: JSON.stringify(row) },
    ]);
    this.rows.set(row.digest, row);
  }
  listIncomplete(): InboundDispatch[] {
    this.assertOpen();
    return [...this.rows.values()]
      .filter((r) => r.phase === "started")
      .map(copy);
  }
  scanFloor(cursor: number): number {
    return this.listIncomplete().reduce(
      (floor, row) => Math.min(floor, row.receivedTime),
      cursor
    );
  }
  get(digest: string): InboundDispatch | undefined {
    this.assertOpen();
    const row = this.rows.get(digest);
    return row && copy(row);
  }
  admit(input: InboundIdentity): Promise<boolean> {
    return this.mutate(async () => {
      const row = validateRow({
        version: 1,
        ...copy(input),
        phase: "started",
        replies: [],
      });
      const existing = this.rows.get(input.digest);
      if (existing) {
        if (
          Object.entries(input).some(
            ([key, value]) => existing[key as keyof InboundIdentity] !== value
          )
        )
          return hold();
        return false;
      }
      if (
        this.rows.size >= MAX_DISPATCHES ||
        (await this.state.get("digest:" + input.digest)) !== undefined
      )
        return hold();
      await this.save(row);
      return true;
    });
  }
  beginReply(
    digest: string,
    input: Omit<ReplyCall, "digest" | "observation">
  ): Promise<number> {
    return this.mutate(async () => {
      const row = this.started(digest);
      if (row.replies.length >= MAX_REPLIES) return hold();
      const index = row.replies.length;
      row.replies.push(copy(input));
      await this.save(row);
      return index;
    });
  }
  private started(digest: string): InboundDispatch {
    const row = this.get(digest);
    if (!row || row.phase !== "started") return hold();
    return row;
  }
  link(digest: string, index: number, outbound: string): Promise<void> {
    return this.mutate(async () => {
      if (!hash(outbound)) return hold();
      const row = this.started(digest),
        call = row.replies[index];
      if (!call || (call.digest !== undefined && call.digest !== outbound))
        return hold();
      for (const other of this.rows.values())
        for (let i = 0; i < other.replies.length; i++)
          if (
            (other.digest !== digest || i !== index) &&
            other.replies[i].digest === outbound
          )
            return hold();
      call.digest = outbound;
      await this.save(row);
    });
  }
  observe(
    digest: string,
    index: number,
    outbound: string,
    observation: DirectMessageAttemptStatus
  ): Promise<void> {
    return this.mutate(async () => {
      const row = this.started(digest),
        call = row.replies[index];
      if (!call || call.digest !== outbound) return hold();
      if (call.observation === "delivered") return; // preserve authenticated delivery knowledge
      call.observation = observation;
      await this.save(row);
    });
  }
  complete(digest: string, cursor: number): Promise<number> {
    return this.mutate(async () => {
      if (!Number.isSafeInteger(cursor) || cursor < 0) return hold();
      const previous = await this.state.get("cursor:lastPollTimestamp");
      if (
        previous !== undefined &&
        (!/^[0-9]+$/.test(previous) || !Number.isSafeInteger(Number(previous)))
      )
        return hold();
      cursor = Math.max(cursor, Number(previous ?? 0));
      const row = this.started(digest);
      row.phase = "completed";
      validateRow(row);
      await this.persist([
        { type: "put", key: ROW + digest, value: JSON.stringify(row) },
        { type: "put", key: "digest:" + digest, value: "completed" },
        { type: "put", key: "cursor:lastPollTimestamp", value: String(cursor) },
      ]);
      this.rows.set(digest, row);
      return cursor;
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }
}
