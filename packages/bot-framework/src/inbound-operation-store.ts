import { createHash } from "crypto";
import { computeAddress, getAddress } from "ethers";
import type {
  DirectMessageAttemptStatus,
  DirectMessageReceived,
} from "@frank/wallet/chain/active-chain";
import { LevelBotStateStore } from "./state-store";
import type { PreparedReply } from "./types";

const PREFIX = "host-inbound:v1:";
const OWNER = PREFIX + "owner";
const ROW = PREFIX + "dispatch:";
// Staged reply text and commit value: outside the `host-inbound:` open scan and the row map.
const STAGED = "host-prepared:v1:";
const MAX_DISPATCHES = 1024;
const MAX_REPLIES = 64;
// The codec's text-string and direct-message-frame limits (frank-codec constants.ts).
const MAX_PREPARED_TEXT_BYTES = 262_144;
const MAX_PREPARED_VALUE_BYTES = 1_048_576;
/** OD-6: answers staged ahead of a refused send, bot-wide, before further prompts wait deferred. */
export const MAX_STAGED_UNSENT = 16;
// Host-owned key spaces of the root store a plugin commit may not name.
const RESERVED_KEYS = [
  "host-inbound:",
  "host-prepared:",
  "digest:",
  "cursor:",
  "greeted:",
];
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
/** A staged reply: the stamp it was authorised with, and one opaque plugin value to commit at
 * `stateKey` when the reply delivers. The host stores hashes only and never parses the value. */
export interface PreparedCommit {
  stampValue: string;
  textSha256: string;
  valueSha256: string;
  stateKey: string;
  expectedSha256: string | null;
}
export interface InboundDispatch extends InboundIdentity {
  version: 1;
  phase: "deferred" | "started" | "completed";
  replies: ReplyCall[];
  prepared?: PreparedCommit;
}
/** Handling order. The wallet sorts a fetch by time only, so equal times are tied by digest. */
export const inboundOrder = (a: InboundIdentity, b: InboundIdentity): number =>
  a.receivedTime - b.receivedTime ||
  (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0);
// receivedTime is relay metadata: the retained value orders the row and is not compared again.
const MATCHED = [
  "peerSubject",
  "peerAddress",
  "conversationId",
  "messageId",
] as const;
const copy = <T>(value: T): T => structuredClone(value);
const hold = (): never => {
  throw new Error(
    "Bot invocation admission held; preserve state and reconcile the original operation"
  );
};
const hash = (s: unknown): s is string =>
  typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const sha256 = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex");
const stamp = (s: unknown): s is string =>
  typeof s === "string" && /^(0|[1-9][0-9]{0,77})$/.test(s);
// Printable ASCII without `!`, the sublevel separator, so a commit stays in the root namespace.
const stateKey = (s: unknown): s is string =>
  typeof s === "string" &&
  /^[\x20\x22-\x7e]{1,512}$/.test(s) &&
  !RESERVED_KEYS.some((prefix) => s.startsWith(prefix));
/** Well-formed Unicode within a UTF-8 byte bound, so the stored bytes hash back exactly. */
function bounded(value: unknown, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length > maxBytes ||
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
      value
    ) ||
    Buffer.byteLength(value, "utf8") > maxBytes
  )
    return hold();
  return value;
}
const sameConversation = (a: InboundIdentity, b: InboundIdentity): boolean =>
  a.peerSubject === b.peerSubject && a.conversationId === b.conversationId;
/** A prepared reply whose commit is still owed. */
const owed = (row: InboundDispatch): boolean =>
  !!row.prepared && row.phase !== "completed";
/** A slot the wallet never linked. Once no send is in flight it can never link, so the reply can
 * never commit: it is held for good. */
const unlinked = (row: InboundDispatch): boolean =>
  row.replies.length === 1 && row.replies[0].digest === undefined;
/** OD-1 (answered with a gap): an owed reply keeps later prompts of its conversation waiting,
 * except one held on an unlinked slot. Evaluated on the conversation's lane, where no send of
 * that conversation is in flight. */
const blocksConversation = (row: InboundDispatch): boolean =>
  owed(row) && !unlinked(row);
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
      "prepared",
    ]) ||
    r.version !== 1 ||
    !["deferred", "started", "completed"].includes(String(r.phase)) ||
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
    r.replies.length > MAX_REPLIES ||
    (r.phase === "deferred" && r.replies.length > 0)
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
      !stamp(call.stampValue) ||
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
  if (r.prepared !== undefined) {
    const p = object(r.prepared);
    const call = r.replies.length ? object(r.replies[0]) : undefined;
    if (
      !keys(p, [
        "stampValue",
        "textSha256",
        "valueSha256",
        "stateKey",
        "expectedSha256",
      ]) ||
      !stamp(p.stampValue) ||
      !hash(p.textSha256) ||
      !hash(p.valueSha256) ||
      !stateKey(p.stateKey) ||
      (p.expectedSha256 !== null && !hash(p.expectedSha256)) ||
      r.phase === "deferred" ||
      r.replies.length > 1 ||
      (r.phase === "completed" && !call) ||
      (call &&
        (call.recipient !== r.peerAddress ||
          call.conversationId !== r.conversationId ||
          call.stampValue !== p.stampValue))
    )
      return hold();
  }
  return r as unknown as InboundDispatch;
}

/** Invocation/correlation owner only. Wallet owns exact requests, reservations and settlement.
 * A fetched message is retained as `deferred` before any handler runs; `start` is the single
 * permission to invoke the handler. A started invocation is never executed again, even if every
 * recorded reply later delivers.
 *
 * A handler may instead stage one prepared reply: its text and one plugin value are durable
 * before the reply is first sent, and the value is committed, once, in the batch that completes
 * the row when that same reply is observed delivered. A send is only ever begun from "prepared,
 * no slot". The compare-and-set on the plugin key is atomic against this store's operations
 * only: the plugin holds the same root store and can write the key directly, which yields a
 * held conflict, never an overwrite. */
export class InboundOperationStore {
  private readonly rows = new Map<string, InboundDispatch>();
  /** Prepared slots persisted by this instance. Process memory only, so an unlinked slot found
   * at open can never be retracted. */
  private readonly begun = new Set<string>();
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
    const stateKeys = new Set<string>();
    for (const [key, value] of entries) {
      if (key === OWNER) continue;
      const row = validateRow(parse(value));
      if (key !== ROW + row.digest) return hold();
      // No send is in flight at open, so only replies that can still commit share-check a key.
      if (row.prepared && blocksConversation(row)) {
        if (stateKeys.has(row.prepared.stateKey)) return hold();
        stateKeys.add(row.prepared.stateKey);
      }
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
  listDeferred(): InboundDispatch[] {
    this.assertOpen();
    return [...this.rows.values()]
      .filter((r) => r.phase === "deferred")
      .sort(inboundOrder)
      .map(copy);
  }
  /** Only a deferred row needs its inbound message read again, so only it pins the scan. */
  scanFloor(cursor: number): number {
    return this.listDeferred().reduce(
      (floor, row) => Math.min(floor, row.receivedTime),
      cursor
    );
  }
  get(digest: string): InboundDispatch | undefined {
    this.assertOpen();
    const row = this.rows.get(digest);
    return row && copy(row);
  }
  private known(input: InboundIdentity): InboundDispatch | undefined {
    const existing = this.rows.get(input.digest);
    if (existing && MATCHED.some((key) => existing[key] !== input[key]))
      return hold();
    return existing;
  }
  /** Capacity is not a fault: "full" leaves the message unretained and the journal usable. */
  retain(input: InboundIdentity): Promise<"retained" | "known" | "full"> {
    return this.mutate(async () => {
      const row = validateRow({
        version: 1,
        ...copy(input),
        phase: "deferred",
        replies: [],
      });
      if (this.known(input)) return "known";
      if ((await this.state.get("digest:" + input.digest)) !== undefined)
        return hold();
      if (this.rows.size >= MAX_DISPATCHES) return "full";
      await this.save(row);
      return "retained";
    });
  }
  /** True only for the one call that moves the row from deferred to started. A conversation is
   * one peer lane, so the rules read durable rows only: a row waits for (a) an earlier deferred
   * row of its conversation, (b) a reply of its conversation whose commit is still owed, and
   * (d) room among the answers staged bot-wide ahead of a send. */
  start(input: InboundIdentity): Promise<boolean> {
    return this.mutate(async () => {
      const existing = this.known(input);
      if (!existing) return hold();
      if (existing.phase !== "deferred") return false;
      let unsent = 0;
      for (const other of this.rows.values()) {
        if (owed(other) && !other.replies.length) unsent++;
        if (
          sameConversation(other, existing) &&
          ((other.phase === "deferred" && inboundOrder(other, existing) < 0) ||
            blocksConversation(other))
        )
          return false;
      }
      if (unsent >= MAX_STAGED_UNSENT) return false;
      const row = copy(existing);
      row.phase = "started";
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
      if (row.prepared || row.replies.length >= MAX_REPLIES) return hold();
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
  /** Staged content is read one value at a time and must hash to what the row recorded. */
  private async staged(
    digest: string,
    part: "text" | "value",
    expected: string
  ): Promise<string> {
    const content = await this.state.get(`${STAGED}${digest}:${part}`);
    if (content === undefined || sha256(content) !== expected) return hold();
    return content;
  }
  /** Compare-and-set: the plugin key still holds exactly what the handler read. */
  private async unchanged(prepared: PreparedCommit): Promise<void> {
    const current = await this.state.get(prepared.stateKey);
    if (
      (current === undefined ? null : sha256(current)) !==
      prepared.expectedSha256
    )
      hold();
  }
  /** Stages the handler's reply and commit value with the row, in one batch. A refusal writes
   * nothing and does not fault the journal; the row stays started and the answer is lost. */
  prepare(
    digest: string,
    reply: PreparedReply,
    stampValue: string
  ): Promise<void> {
    return this.mutate(async () => {
      const row = this.started(digest);
      if (row.prepared || row.replies.length) return hold();
      const input = object(reply);
      const commit = object(input.commit);
      if (
        !keys(input, ["kind", "text", "commit"]) ||
        input.kind !== "prepared-reply" ||
        !keys(commit, ["key", "expectedSha256", "value"])
      )
        return hold();
      const text = bounded(input.text, MAX_PREPARED_TEXT_BYTES);
      const value = bounded(commit.value, MAX_PREPARED_VALUE_BYTES);
      if (!stateKey(commit.key)) return hold();
      const expectedSha256 = hash(commit.expectedSha256)
        ? commit.expectedSha256
        : commit.expectedSha256 === null
        ? null
        : hold();
      // One owed reply per key, so two conversations cannot commit over each other. A reply of
      // this same conversation held on an unlinked slot can never commit and is not counted.
      for (const other of this.rows.values())
        if (
          owed(other) &&
          other.prepared?.stateKey === commit.key &&
          !(sameConversation(other, row) && unlinked(other))
        )
          return hold();
      row.prepared = {
        stampValue,
        textSha256: sha256(text),
        valueSha256: sha256(value),
        stateKey: commit.key,
        expectedSha256,
      };
      validateRow(row);
      await this.persist([
        { type: "put", key: ROW + digest, value: JSON.stringify(row) },
        { type: "put", key: `${STAGED}${digest}:text`, value: text },
        { type: "put", key: `${STAGED}${digest}:value`, value },
      ]);
      this.rows.set(digest, row);
    });
  }
  /** Persists the one reply slot of a prepared row and returns the verified text to send. The
   * only way a send of a prepared reply begins: from "prepared, no slot", with the plugin key
   * unchanged. */
  beginPreparedReply(digest: string): Promise<string> {
    return this.mutate(async () => {
      const row = this.started(digest);
      if (!row.prepared || row.replies.length) return hold();
      await this.unchanged(row.prepared);
      const text = await this.staged(digest, "text", row.prepared.textSha256);
      row.replies.push({
        recipient: row.peerAddress,
        conversationId: row.conversationId,
        stampValue: row.prepared.stampValue,
      });
      await this.save(row);
      this.begun.add(digest);
      return text;
    });
  }
  /** Back to "prepared, no slot". The caller vouches that the send it made for this slot was
   * rejected with the wallet's not-attempted label and reported no attempt; the store can only
   * check that the slot is unlinked and was persisted by this instance. */
  retractReply(digest: string): Promise<void> {
    return this.mutate(async () => {
      const row = this.started(digest);
      if (!row.prepared || !unlinked(row) || !this.begun.has(digest))
        return hold();
      row.replies = [];
      await this.save(row);
      this.begun.delete(digest);
    });
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
      const ops: Parameters<LevelBotStateStore["durableBatch"]>[0] = [
        { type: "put", key: ROW + digest, value: JSON.stringify(row) },
        { type: "put", key: "digest:" + digest, value: "completed" },
        { type: "put", key: "cursor:lastPollTimestamp", value: String(cursor) },
      ];
      if (row.prepared) {
        // The plugin value is committed in the batch that completes the row, or not at all.
        const value = await this.staged(
          digest,
          "value",
          row.prepared.valueSha256
        );
        await this.unchanged(row.prepared);
        ops.unshift({ type: "put", key: row.prepared.stateKey, value });
        ops.push(
          { type: "del", key: `${STAGED}${digest}:text` },
          { type: "del", key: `${STAGED}${digest}:value` }
        );
      }
      await this.persist(ops);
      this.rows.set(digest, row);
      return cursor;
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }
}
