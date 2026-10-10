import { createHash } from "crypto";
import { computeAddress, getAddress } from "ethers";
import type { DirectMessageReceived } from "@frank/wallet/chain/active-chain";
import { LevelBotStateStore } from "./state-store";

const PREFIX = "host-inbound:v1:";
const OWNER = PREFIX + "owner";
const ROW = PREFIX + "dispatch:";
// The text of a staged reply: outside the `host-inbound:` open scan and the in-memory row map.
const STAGED = "host-prepared:v1:";
// The codec's text-string limit (frank-codec constants.ts).
const MAX_REPLY_TEXT_BYTES = 262_144;

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
  /** Absent: the default thread with this peer. */
  conversationId?: string;
  messageId: string;
  receivedTime: number;
}
/** The one text reply the host owes for a message. Its text is stored beside the row. The
 * wallet owns the payment; `digest` is the wallet's attempt for it once the host knows it. */
export interface StagedReply {
  stampValue: string;
  /** When it was staged, in milliseconds: a reply is not retried for ever. */
  since: number;
  digest?: string;
}
/** An inbound message the bot has not finished with. `deferred`: retained, handler not run.
 * `started`: the handler was given the message, once. A finished message has no row, only its
 * `digest:` marker. */
export interface InboundDispatch extends InboundIdentity {
  version: 2;
  phase: "deferred" | "started";
  /** A reply the handler sent itself reached the wallet's journal. */
  replied?: true;
  /** Wei the message paid, as far as the host could confirm when it started the handler: what
   * a reply to it may carry. Absent: nothing, or not confirmed. */
  paid?: string;
  /** The transfers the message came with, as the wallet reported them (wei as decimal text).
   * Kept from the moment the handler is started so that a message whose handler was
   * interrupted can be handed back to its bot with them. */
  payments?: { txHash: string; destinationAddress: string; valueWei: string }[];
  reply?: StagedReply;
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
const stamp = (s: unknown): s is string =>
  typeof s === "string" && /^(0|[1-9][0-9]{0,77})$/.test(s);
const sameConversation = (a: InboundIdentity, b: InboundIdentity): boolean =>
  a.peerSubject === b.peerSubject && a.conversationId === b.conversationId;
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
/** The sealed message identity of the staged reply to one inbound message, the same in every
 * process lifetime. The wallet makes at most one payment for one identity, so sending the reply
 * again under it can only finish the first attempt, never pay a second time. */
export function replyMessageId(owner: InboundOwner, inbound: string): string {
  return conversationIdentity(
    createHash("sha256")
      .update(`frank-bot-reply:v1:${owner.subject}:${inbound}`, "utf8")
      .digest("hex")
      .slice(0, 32)
  );
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
  const identity: InboundIdentity = {
    digest: message.payloadDigest,
    peerSubject,
    peerAddress: address(message.senderAddress.raw),
    messageId: conversationIdentity(message.messageId),
    receivedTime: message.receivedTime,
  };
  // No conversation ID on the wire is the default thread with the peer, not a malformed message.
  if (message.conversationId !== undefined)
    identity.conversationId = conversationIdentity(message.conversationId);
  return identity;
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
      "replied",
      "paid",
      "payments",
      "reply",
    ]) ||
    r.version !== 2 ||
    !["deferred", "started"].includes(String(r.phase)) ||
    !hash(r.digest) ||
    !subject(r.peerSubject) ||
    address(r.peerAddress) !== r.peerAddress ||
    address(r.peerAddress) !== keyAddress(r.peerSubject) ||
    (r.conversationId !== undefined &&
      conversationIdentity(r.conversationId) !== r.conversationId) ||
    conversationIdentity(r.messageId) !== r.messageId ||
    !Number.isSafeInteger(r.receivedTime) ||
    Number(r.receivedTime) < 0 ||
    Number(r.receivedTime) >= Number.MAX_SAFE_INTEGER ||
    (r.replied !== undefined && r.replied !== true) ||
    (r.paid !== undefined && !stamp(r.paid)) ||
    (r.payments !== undefined &&
      !(
        Array.isArray(r.payments) &&
        r.payments.length <= 256 &&
        r.payments.every((payment) => {
          const p = payment as Record<string, unknown> | null;
          return (
            typeof p === "object" &&
            p !== null &&
            keys(p, ["txHash", "destinationAddress", "valueWei"]) &&
            typeof p.txHash === "string" &&
            /^0x[0-9a-fA-F]{64}$/.test(p.txHash) &&
            typeof p.destinationAddress === "string" &&
            /^0x[0-9a-fA-F]{40}$/.test(p.destinationAddress) &&
            typeof p.valueWei === "string" &&
            /^(0|[1-9][0-9]{0,77})$/.test(p.valueWei)
          );
        })
      )) ||
    (r.phase === "deferred" &&
      (r.replied ||
        r.reply !== undefined ||
        r.paid !== undefined ||
        r.payments !== undefined))
  )
    return hold();
  if (r.reply !== undefined) {
    const reply = object(r.reply);
    if (
      !keys(reply, ["stampValue", "since", "digest"]) ||
      !stamp(reply.stampValue) ||
      !Number.isSafeInteger(reply.since) ||
      (reply.digest !== undefined && !hash(reply.digest))
    )
      return hold();
  }
  return r as unknown as InboundDispatch;
}

/** The host's record of inbound messages it has not finished with. The wallet owns payments,
 * reservations and delivery; this store owns only which messages were handed to a handler and
 * which text reply the host still owes.
 *
 * A fetched message is retained as `deferred` before any handler runs; `start` is the single
 * permission to invoke the handler, so a handler never runs twice for one message. A message is
 * finished by `complete`, which deletes its row and leaves a `digest:` marker so a later fetch of
 * the same message is recognised and not handled again. */
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
    // Every row: there is no limit on how many messages a bot may have unfinished.
    const entries = await state.readEntries(
      "host-inbound:",
      Number.MAX_SAFE_INTEGER
    );
    for (const [key, value] of entries) {
      if (key === OWNER) continue;
      const raw = object(parse(value));
      if (raw.version === 1) {
        await instance.dropEarlierFormat(key, raw);
        continue;
      }
      const row = validateRow(raw);
      if (key !== ROW + row.digest) return hold();
      instance.rows.set(row.digest, row);
    }
    const cursor = await state.get("cursor:lastPollTimestamp");
    if (
      cursor !== undefined &&
      (!/^[0-9]+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
    )
      return hold();
    return instance;
  }
  /** Development reset of rows written before finished rows were deleted (format 1). The host
   * journal only: no key, wallet record or plugin state is touched. A completed row is history
   * and goes, keeping its marker. A message whose handler never ran is kept and handled. One
   * whose handler had started cannot be finished in this format: whether its reply was paid for
   * is not recorded in a form this version may act on, so it is dropped and said so. */
  private async dropEarlierFormat(
    key: string,
    raw: Record<string, unknown>
  ): Promise<void> {
    if (raw.phase === "deferred") {
      const { replies: _replies, ...identity } = raw;
      const row = validateRow({ ...identity, version: 2 });
      if (key !== ROW + row.digest) return hold();
      await this.save(row);
      return;
    }
    if (raw.phase !== "completed")
      console.error(
        `[bot-host] [${this.owner.botId}] Message ${String(
          raw.messageId
        )} from ${String(
          raw.peerAddress
        )} was left unfinished by an earlier version and is dropped unanswered`
      );
    const ops: Parameters<LevelBotStateStore["durableBatch"]>[0] = [
      { type: "del", key },
    ];
    if (hash(raw.digest))
      ops.push(
        { type: "put", key: "digest:" + raw.digest, value: "completed" },
        { type: "del", key: `${STAGED}${raw.digest}:text` },
        { type: "del", key: `${STAGED}${raw.digest}:value` }
      );
    await this.persist(ops);
  }
  /** A journal write failed: nothing is admitted or changed until `recover` succeeds. */
  get isFaulted(): boolean {
    return this.faulted && !this.closed;
  }
  /** After a failed write, what is in memory may not be what is on disk (the write may have
   * landed). Reads the rows back from disk and, if they read cleanly and the disk takes a write
   * again, serves from them. Rejects, still faulted, when it cannot be read or written. */
  recover(): Promise<void> {
    const task = this.tail.then(async () => {
      if (this.closed || !this.faulted) return;
      const rows = new Map<string, InboundDispatch>();
      const entries = await this.state.readEntries(
        "host-inbound:",
        Number.MAX_SAFE_INTEGER
      );
      for (const [key, value] of entries) {
        if (key === OWNER) continue;
        const row = validateRow(parse(value));
        if (key !== ROW + row.digest) return hold();
        rows.set(row.digest, row);
      }
      // Reading is not enough: the disk must take a write again before the bot is said to be
      // answering. The owner marker is rewritten with what it already holds.
      const marker = await this.state.get(OWNER);
      if (marker === undefined) return hold();
      await this.state.durableBatch([{ type: "put", key: OWNER, value: marker }]);
      this.rows.clear();
      for (const [digest, row] of rows) this.rows.set(digest, row);
      this.faulted = false;
    });
    this.tail = task.catch(() => undefined);
    return task;
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
  /** Messages whose handler was started and which are not finished. */
  listStarted(): InboundDispatch[] {
    this.assertOpen();
    return [...this.rows.values()]
      .filter((r) => r.phase === "started")
      .sort(inboundOrder)
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
  /** Whether this message was finished earlier: it has a marker and no row. */
  async finished(digest: string): Promise<boolean> {
    this.assertOpen();
    return (
      !this.rows.has(digest) &&
      (await this.state.get("digest:" + digest)) !== undefined
    );
  }
  private known(input: InboundIdentity): InboundDispatch | undefined {
    const existing = this.rows.get(input.digest);
    if (existing && MATCHED.some((key) => existing[key] !== input[key]))
      return hold();
    return existing;
  }
  /** "finished": this message was completed earlier and is not handled again. Nothing limits
   * how many messages are retained: a backlog never stops a bot taking new ones. */
  retain(input: InboundIdentity): Promise<"retained" | "known" | "finished"> {
    return this.mutate(async () => {
      const row = validateRow({
        version: 2,
        ...copy(input),
        phase: "deferred",
      });
      if (this.known(input)) return "known";
      if ((await this.state.get("digest:" + input.digest)) !== undefined)
        return "finished";
      await this.save(row);
      return "retained";
    });
  }
  /** True only for the one call that moves the row from deferred to started. `paidWei` is kept
   * with the row, in the same write. Replies to one
   * conversation go out in order: a row waits for every earlier unfinished message of its own
   * conversation, and for nothing else. */
  start(
    input: InboundIdentity,
    paidWei = 0n,
    payments: NonNullable<InboundDispatch["payments"]> = []
  ): Promise<boolean> {
    return this.mutate(async () => {
      const existing = this.known(input);
      if (!existing) return hold();
      if (existing.phase !== "deferred") return false;
      for (const other of this.rows.values())
        if (
          other.digest !== existing.digest &&
          sameConversation(other, existing) &&
          (other.phase === "started" || inboundOrder(other, existing) < 0)
        )
          return false;
      const row = copy(existing);
      row.phase = "started";
      if (paidWei > 0n) row.paid = paidWei.toString();
      if (payments.length) row.payments = payments;
      await this.save(row);
      return true;
    });
  }
  private started(digest: string): InboundDispatch {
    const row = this.get(digest);
    if (!row || row.phase !== "started") return hold();
    return row;
  }
  /** Records that a reply the handler sent itself reached the wallet's journal. */
  markReplied(digest: string): Promise<void> {
    return this.mutate(async () => {
      const row = this.started(digest);
      if (row.replied) return;
      row.replied = true;
      await this.save(row);
    });
  }
  /** Stages the one text reply the host owes for this message, with the row, in one batch. */
  stageReply(
    digest: string,
    text: unknown,
    stampValue: string,
    since: number
  ): Promise<void> {
    return this.mutate(async () => {
      const row = this.started(digest);
      if (
        row.reply ||
        typeof text !== "string" ||
        !text ||
        text.length > MAX_REPLY_TEXT_BYTES ||
        // Well-formed Unicode only, so the stored bytes are the text that is sent.
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
          text
        ) ||
        Buffer.byteLength(text, "utf8") > MAX_REPLY_TEXT_BYTES
      )
        return hold();
      row.reply = { stampValue, since };
      validateRow(row);
      await this.persist([
        { type: "put", key: ROW + digest, value: JSON.stringify(row) },
        { type: "put", key: `${STAGED}${digest}:text`, value: text },
      ]);
      this.rows.set(digest, row);
    });
  }
  /** The text of a staged reply, exactly as staged. */
  async replyText(digest: string): Promise<string> {
    if (!this.started(digest).reply) return hold();
    const text = await this.state.get(`${STAGED}${digest}:text`);
    return text === undefined ? hold() : text;
  }
  /** Records the wallet's attempt for the staged reply. It never changes once known. */
  linkReply(digest: string, outbound: string): Promise<void> {
    return this.mutate(async () => {
      const row = this.started(digest);
      if (
        !hash(outbound) ||
        !row.reply ||
        (row.reply.digest !== undefined && row.reply.digest !== outbound)
      )
        return hold();
      if (row.reply.digest === outbound) return;
      row.reply.digest = outbound;
      await this.save(row);
    });
  }
  /** Finishes a started message: its row and staged text are deleted, its marker is written and
   * the scan cursor moves, in one batch. Returns the cursor now stored. */
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
      this.started(digest);
      await this.persist([
        { type: "del", key: ROW + digest },
        { type: "del", key: `${STAGED}${digest}:text` },
        { type: "put", key: "digest:" + digest, value: "completed" },
        { type: "put", key: "cursor:lastPollTimestamp", value: String(cursor) },
      ]);
      this.rows.delete(digest);
      return cursor;
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }
}
