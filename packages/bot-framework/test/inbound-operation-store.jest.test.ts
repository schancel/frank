/**
 * The host's record of unfinished inbound messages, on a real Level store: which message a
 * handler may be given (once), the order within a conversation, the reply the host owes, and
 * that a finished message leaves a marker and no row.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Wallet, getBytes } from "ethers";
import { LevelBotStateStore } from "../src/state-store";
import {
  InboundOperationStore,
  inboundIdentity,
  replyMessageId,
  type InboundOwner,
  type InboundIdentity,
} from "../src/inbound-operation-store";

const local = new Wallet("0x" + "11".repeat(32)),
  peer = new Wallet("0x" + "12".repeat(32)),
  other = new Wallet("0x" + "13".repeat(32));
const owner: InboundOwner = {
  chainIdentifier: "monad-testnet",
  botId: "qwen",
  address: local.address.toLowerCase(),
  subject: local.signingKey.compressedPublicKey.slice(2),
};
const input: InboundIdentity = {
  digest: "aa".repeat(32),
  peerAddress: peer.address.toLowerCase(),
  peerSubject: peer.signingKey.compressedPublicKey.slice(2),
  conversationId: "01010101-0101-0101-0101-010101010101",
  messageId: "02020202-0202-0202-0202-020202020202",
  receivedTime: 100,
};
const numbered = (n: number, extra: Partial<InboundIdentity> = {}) => ({
  ...input,
  digest: n.toString(16).padStart(64, "0"),
  receivedTime: 100 + n,
  ...extra,
});
const outbound = "bb".repeat(32);
let location: string;
let state: LevelBotStateStore;
let store: InboundOperationStore;
async function reopen() {
  await store?.close();
  await state.close();
  state = await LevelBotStateStore.open(location);
  store = await InboundOperationStore.open(state, owner, false);
}
async function retainThenStart(identity: InboundIdentity): Promise<boolean> {
  await store.retain(identity);
  return store.start(identity);
}
beforeEach(async () => {
  location = mkdtempSync(join(tmpdir(), "bot-inbound-owner-"));
  state = await LevelBotStateStore.open(location);
  store = await InboundOperationStore.open(state, owner, true);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await store?.close();
  await state.close();
  rmSync(location, { recursive: true, force: true });
});

it("hands a message to one caller, once, also after a reopen", async () => {
  expect(
    await Promise.all([retainThenStart(input), retainThenStart(input)])
  ).toEqual([true, false]);
  await reopen();
  expect(await retainThenStart(input)).toBe(false);
  // The same digest under another conversation is not the retained message.
  await expect(
    store.retain({
      ...input,
      conversationId: "03030303-0303-0303-0303-030303030303",
    })
  ).rejects.toThrow(/held/);
});

it("finishes a message by deleting its row and leaving a marker, and never admits it again", async () => {
  await retainThenStart(input);
  await store.stageReply(input.digest, "the answer", "5", 1_000);
  expect(await state.get(`host-prepared:v1:${input.digest}:text`)).toBe(
    "the answer"
  );
  expect(await store.complete(input.digest, 101)).toBe(101);
  await reopen();
  expect(store.get(input.digest)).toBeUndefined();
  expect(store.listStarted()).toEqual([]);
  expect(await state.readEntries("host-inbound:v1:dispatch:")).toEqual([]);
  expect(await state.readEntries("host-prepared:")).toEqual([]);
  expect(await state.get("digest:" + input.digest)).toBe("completed");
  expect(await state.get("cursor:lastPollTimestamp")).toBe("101");
  expect(await store.finished(input.digest)).toBe(true);
  expect(await store.retain(input)).toBe("finished");
  // The cursor never moves backwards.
  await retainThenStart(numbered(1, { receivedTime: 5 }));
  expect(await store.complete(numbered(1).digest, 6)).toBe(101);
});

// The owner's rule: nothing may make a bot stop accepting messages. On 05c93db0 rows were never
// deleted and the 1,025th message of a bot's life got "full".
it("goes on accepting after 1,100 finished messages and with 1,100 unfinished ones", async () => {
  for (let n = 1; n <= 1100; n++) {
    const message = numbered(n);
    expect(await store.retain(message)).toBe("retained");
    expect(await store.start(message)).toBe(true);
    await store.complete(message.digest, message.receivedTime + 1);
  }
  expect(await state.readEntries("host-inbound:v1:dispatch:")).toEqual([]);
  for (let n = 0; n < 1100; n++)
    expect(
      await store.retain(
        numbered(5000 + n, {
          conversationId: undefined,
          peerAddress: other.address.toLowerCase(),
          peerSubject: other.signingKey.compressedPublicKey.slice(2),
        })
      )
    ).toBe("retained");
  await reopen();
  expect(store.listDeferred()).toHaveLength(1100);
  expect(await store.retain(numbered(9000))).toBe("retained");
}, 60_000);

it("starts a conversation's messages in order, one unfinished at a time, and never waits for another conversation", async () => {
  const first = numbered(1),
    second = numbered(2);
  const elsewhere = numbered(3, {
    conversationId: "09090909-0909-0909-0909-090909090909",
  });
  const otherPeer = numbered(4, {
    peerAddress: other.address.toLowerCase(),
    peerSubject: other.signingKey.compressedPublicKey.slice(2),
  });
  for (const message of [second, first, elsewhere, otherPeer])
    await store.retain(message);
  // Not before the earlier message of its conversation has started...
  expect(await store.start(second)).toBe(false);
  expect(await store.start(first)).toBe(true);
  // ...nor while that one's reply is still owed, however long that takes.
  await store.stageReply(first.digest, "one", "5", 1_000);
  await store.linkReply(first.digest, outbound);
  expect(await store.start(second)).toBe(false);
  // Other conversations, with the same peer or another, are not held up by it.
  expect(await store.start(elsewhere)).toBe(true);
  expect(await store.start(otherPeer)).toBe(true);
  await store.complete(first.digest, 1);
  expect(await store.start(second)).toBe(true);
  expect(store.scanFloor(900)).toBe(900);
});

it("admits a message with no conversation ID as the default thread with its peer", async () => {
  const message = {
    senderAddress: { raw: peer.address },
    senderPublicKey: getBytes(peer.signingKey.compressedPublicKey),
    recipientAddress: { raw: local.address },
    recipientPublicKey: getBytes(local.signingKey.compressedPublicKey),
    messageId: input.messageId,
    payloadDigest: input.digest,
    receivedTime: 100,
    items: [],
    stampValueWei: 1n,
    stampPayments: [],
  };
  const identity = inboundIdentity(message, owner);
  expect("conversationId" in identity).toBe(false);
  expect(await retainThenStart(identity)).toBe(true);
  // The default thread is one conversation: its next message waits for this one.
  const next = { ...identity, digest: "ab".repeat(32), receivedTime: 101 };
  expect(await retainThenStart(next)).toBe(false);
  await reopen();
  expect(store.get(identity.digest)).toMatchObject({ phase: "started" });
  expect(() =>
    inboundIdentity({ ...message, conversationId: "not-an-id" }, owner)
  ).toThrow(/held/);
  expect(() => inboundIdentity({ ...message, outbound: true }, owner)).toThrow(
    /held/
  );
});

it("keeps the staged reply, its wallet attempt and a handler's own reply across a reopen", async () => {
  await retainThenStart(input);
  await retainThenStart(numbered(7, { conversationId: undefined }));
  await store.markReplied(numbered(7).digest);
  for (const refused of ["", "\ud800", "x".repeat(262_145), 5])
    await expect(
      store.stageReply(input.digest, refused, "5", 1_000)
    ).rejects.toThrow(/held/);
  await store.stageReply(input.digest, "the answer", "5", 1_000);
  await expect(
    store.stageReply(input.digest, "another", "5", 1_000)
  ).rejects.toThrow(/held/);
  await reopen();
  expect(await store.replyText(input.digest)).toBe("the answer");
  expect(store.get(input.digest)?.reply).toEqual({
    stampValue: "5",
    since: 1_000,
  });
  await store.linkReply(input.digest, outbound);
  await store.linkReply(input.digest, outbound);
  // The wallet's attempt for a reply never changes.
  await expect(store.linkReply(input.digest, "cc".repeat(32))).rejects.toThrow(
    /held/
  );
  await reopen();
  expect(store.get(input.digest)?.reply?.digest).toBe(outbound);
  expect(store.get(numbered(7).digest)).toMatchObject({ replied: true });
});

it("gives a message's reply one message identity, the same in every process", () => {
  const id = replyMessageId(owner, input.digest);
  expect(id).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  expect(replyMessageId({ ...owner }, input.digest)).toBe(id);
  expect(replyMessageId(owner, "ab".repeat(32))).not.toBe(id);
  expect(
    replyMessageId({ ...owner, subject: "02" + "77".repeat(32) }, input.digest)
  ).not.toBe(id);
});

it("refuses another owner and rows it cannot read, changing nothing", async () => {
  await retainThenStart(input);
  await store.close();
  await expect(
    InboundOperationStore.open(state, { ...owner, botId: "other" }, false)
  ).rejects.toThrow(/held/);
  const key = "host-inbound:v1:dispatch:" + input.digest;
  const stored = (await state.get(key))!;
  await state.put(key, JSON.stringify({ ...JSON.parse(stored), extra: 1 }));
  await expect(
    InboundOperationStore.open(state, owner, false)
  ).rejects.toThrow(/held/);
  await state.put(key, stored);
  store = await InboundOperationStore.open(state, owner, false);
  expect(store.get(input.digest)).toMatchObject({ phase: "started" });
});

// Development reset of the journal an earlier version wrote (see `dropEarlierFormat`).
it("opens a journal of the earlier format: finished rows go, an unhandled message is kept, an unfinished one is dropped and said so", async () => {
  await store.close();
  const v1 = (n: number, phase: string, extra: object = {}) => ({
    ...numbered(n),
    version: 1,
    phase,
    replies: [],
    ...extra,
  });
  const reply = {
    recipient: input.peerAddress,
    conversationId: input.conversationId,
    stampValue: "5",
  };
  const rows = [
    v1(1, "completed", {
      replies: [{ ...reply, digest: outbound, observation: "delivered" }],
    }),
    v1(2, "started", { replies: [reply] }),
    v1(3, "deferred"),
  ];
  for (const row of rows)
    await state.put(
      "host-inbound:v1:dispatch:" + row.digest,
      JSON.stringify(row)
    );
  await state.put("digest:" + rows[0].digest, "completed");
  await state.put("cursor:lastPollTimestamp", "102");
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  store = await InboundOperationStore.open(state, owner, false);
  expect(store.listStarted()).toEqual([]);
  expect(store.listDeferred().map((row) => row.digest)).toEqual([
    rows[2].digest,
  ]);
  expect(store.get(rows[2].digest)).toMatchObject({ version: 2 });
  expect(await store.finished(rows[0].digest)).toBe(true);
  expect(await store.finished(rows[1].digest)).toBe(true);
  expect(error).toHaveBeenCalledTimes(1);
  expect(error.mock.calls[0][0]).toContain(input.peerAddress);
  expect(error.mock.calls[0][0]).toContain(input.messageId);
  expect(await store.start(numbered(3))).toBe(true);
  await reopen();
  expect(error).toHaveBeenCalledTimes(1);
  expect(await state.get("cursor:lastPollTimestamp")).toBe("102");
});
