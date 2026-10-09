import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { Wallet, getBytes } from "ethers";
import { LevelBotStateStore } from "../src/state-store";
import type { PreparedReply } from "../src/types";
import {
  InboundOperationStore,
  MAX_STAGED_UNSENT,
  inboundIdentity,
  type InboundOwner,
  type InboundIdentity,
} from "../src/inbound-operation-store";

const local = new Wallet("0x" + "11".repeat(32)),
  peer = new Wallet("0x" + "12".repeat(32));
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
const outbound = "bb".repeat(32);
const call = {
  recipient: peer.address.toLowerCase(),
  conversationId: input.conversationId,
  stampValue: "5",
};
let location: string;
let state: LevelBotStateStore;
let store: InboundOperationStore;
async function reopen() {
  await store?.close();
  await state.close();
  state = await LevelBotStateStore.open(location);
  store = await InboundOperationStore.open(state, owner, false);
}
// Admission is two durable steps: retain the identity, then take the one permission to handle it.
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
it("atomically admits one caller and never reenters the handler after reopen", async () => {
  expect(
    await Promise.all([retainThenStart(input), retainThenStart(input)])
  ).toEqual([true, false]);
  await reopen();
  expect(await retainThenStart(input)).toBe(false);
  await expect(
    retainThenStart({
      ...input,
      conversationId: "03030303-0303-0303-0303-030303030303",
    })
  ).rejects.toThrow(/held/);
  // The floor is pinned by a message that is retained and not yet started.
  await store.retain({ ...input, digest: "cc".repeat(32) });
  expect(store.scanFloor(900)).toBe(100);
});
it.each(["live", "unknown", "dead", "delivered"] as const)(
  "keeps a %s wallet observation distinct from handler completion",
  async (status) => {
    await retainThenStart(input);
    await store.beginReply(input.digest, call);
    await store.link(input.digest, 0, outbound);
    await store.observe(input.digest, 0, outbound, status);
    await reopen();
    expect(store.get(input.digest)).toMatchObject({
      phase: "started",
      replies: [{ digest: outbound, observation: status }],
    });
    expect(await state.get("digest:" + input.digest)).toBeUndefined();
    expect(await retainThenStart(input)).toBe(false);
  }
);
it("requires exact callback correlation and delivered replies for atomic handler completion", async () => {
  await retainThenStart(input);
  await store.beginReply(input.digest, call);
  await expect(store.complete(input.digest, 101)).rejects.toThrow(/held/);
  await store.link(input.digest, 0, outbound);
  await expect(store.link(input.digest, 0, "cc".repeat(32))).rejects.toThrow(
    /held/
  );
  await store.observe(input.digest, 0, outbound, "delivered");
  await store.complete(input.digest, 101);
  await reopen();
  expect(store.get(input.digest)?.phase).toBe("completed");
  expect(await state.get("digest:" + input.digest)).toBe("completed");
  expect(await state.get("cursor:lastPollTimestamp")).toBe("101");
  expect(store.listIncomplete()).toEqual([]);
  expect(await retainThenStart(input)).toBe(false);
});
it.each([false, true])(
  "faults after a begin write fails (committed=%s), then recovers only disk truth",
  async (committed) => {
    await store.retain(input);
    const original = state.durableBatch.bind(state);
    jest.spyOn(state, "durableBatch").mockImplementationOnce(async (ops) => {
      if (committed) await original(ops);
      throw new Error("uncertain write");
    });
    await expect(store.start(input)).rejects.toThrow(/held/);
    await expect(
      retainThenStart({ ...input, digest: "cc".repeat(32) })
    ).rejects.toThrow(/held/);
    await reopen();
    expect(await retainThenStart(input)).toBe(!committed);
  }
);
it.each(["link", "complete"] as const)(
  "recovers a committed %s write whose acknowledgement was lost",
  async (step) => {
    await retainThenStart(input);
    await store.beginReply(input.digest, call);
    if (step === "complete") {
      await store.link(input.digest, 0, outbound);
      await store.observe(input.digest, 0, outbound, "delivered");
    }
    const original = state.durableBatch.bind(state);
    jest.spyOn(state, "durableBatch").mockImplementationOnce(async (ops) => {
      await original(ops);
      throw new Error("after commit");
    });
    await expect(
      step === "link"
        ? store.link(input.digest, 0, outbound)
        : store.complete(input.digest, 101)
    ).rejects.toThrow(/held/);
    await reopen();
    expect(store.get(input.digest)).toMatchObject({
      phase: step === "complete" ? "completed" : "started",
      replies: [{ digest: outbound }],
    });
    expect(await retainThenStart(input)).toBe(false);
  }
);
it("keeps distinct reply slots and holds all of them when the handler was interrupted", async () => {
  await retainThenStart(input);
  expect(
    await Promise.all([
      store.beginReply(input.digest, call),
      store.beginReply(input.digest, call),
    ])
  ).toEqual([0, 1]);
  await store.link(input.digest, 0, outbound);
  await store.observe(input.digest, 0, outbound, "delivered");
  await expect(store.link(input.digest, 1, outbound)).rejects.toThrow(/held/);
  await reopen();
  expect(store.get(input.digest)?.replies).toHaveLength(2);
  expect(await retainThenStart(input)).toBe(false);
  await expect(store.complete(input.digest, 101)).rejects.toThrow(/held/);
});
it("rejects wrong network/identity, corrupt rows and unsupported versions without replacing them", async () => {
  await retainThenStart(input);
  await expect(
    InboundOperationStore.open(
      state,
      { ...owner, chainIdentifier: "ethereum-sepolia" },
      false
    )
  ).rejects.toThrow(/held/);
  const other = new Wallet("0x" + "13".repeat(32));
  await expect(
    InboundOperationStore.open(
      state,
      {
        ...owner,
        address: other.address.toLowerCase(),
        subject: other.signingKey.compressedPublicKey.slice(2),
      },
      false
    )
  ).rejects.toThrow(/held/);
  const raw = JSON.stringify({ ...store.get(input.digest), version: 2 });
  await state.put("host-inbound:v1:dispatch:" + input.digest, raw);
  await expect(InboundOperationStore.open(state, owner, false)).rejects.toThrow(
    /held/
  );
  expect(await state.get("host-inbound:v1:dispatch:" + input.digest)).toBe(raw);
});
it("preserves unversioned financial rows and refuses empty state paired with an existing identity", async () => {
  const other = await LevelBotStateStore.open(join(location, "legacy"));
  try {
    await expect(InboundOperationStore.preflight(other, false)).rejects.toThrow(
      /held/
    );
    const evidence =
      '{"phase":"intent-linked","attemptRef":"retained-exact-attempt"}';
    await other.put("coupling:v1:old", evidence);
    await expect(InboundOperationStore.preflight(other, true)).rejects.toThrow(
      /held/
    );
    expect(await other.get("coupling:v1:old")).toBe(evidence);
  } finally {
    await other.close();
  }
});
it("rejects forged/missing identities and outbound echoes before admission", () => {
  const valid = {
    senderAddress: { raw: peer.address },
    senderPublicKey: getBytes(peer.signingKey.compressedPublicKey),
    recipientAddress: { raw: local.address },
    recipientPublicKey: getBytes(local.signingKey.compressedPublicKey),
    conversationId: input.conversationId,
    messageId: input.messageId,
    payloadDigest: input.digest,
    receivedTime: 100,
    items: [],
    stampPayments: [],
    stampValueWei: 0n,
  };
  expect(inboundIdentity(valid, owner)).toEqual(input);
  for (const change of [
    { conversationId: undefined },
    { conversationId: "conv-1" },
    { senderPublicKey: new Uint8Array(33) },
    { recipientPublicKey: undefined },
    { outbound: true },
    { senderAddress: local.address ? { raw: local.address } : undefined },
  ])
    expect(() => inboundIdentity({ ...valid, ...change }, owner)).toThrow();
});
it("refuses writes from a closed owner while its reopened replacement remains intact", async () => {
  await retainThenStart(input);
  await store.beginReply(input.digest, call);
  const old = store;
  await reopen();
  await expect(old.link(input.digest, 0, outbound)).rejects.toThrow(/held/);
  expect(store.get(input.digest)?.replies[0].digest).toBeUndefined();
});

it.each([0, 1, 2, 3, 4])(
  "survives an abrupt child-process death at durable cut %s",
  async (cut) => {
    // Each cut is a real fsynced Level transition followed by SIGKILL, not a mocked reopen.
    await store.close();
    await state.close();
    const childLocation = join(location, "child");
    const bootstrap = `
    const fs = require('fs'), ts = require('typescript');
    require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, filename);
    const { LevelBotStateStore } = require(${JSON.stringify(
      resolve(__dirname, "../src/state-store.ts")
    )});
    const { InboundOperationStore } = require(${JSON.stringify(
      resolve(__dirname, "../src/inbound-operation-store.ts")
    )});
    (async () => {
      const state = await LevelBotStateStore.open(${JSON.stringify(
        childLocation
      )});
      const store = await InboundOperationStore.open(state, ${JSON.stringify(
        owner
      )}, true);
      await store.retain(${JSON.stringify(input)});
      await store.start(${JSON.stringify(input)});
      if (${cut} >= 1) await store.beginReply(${JSON.stringify(
      input.digest
    )}, ${JSON.stringify(call)});
      if (${cut} >= 2) await store.link(${JSON.stringify(
      input.digest
    )}, 0, ${JSON.stringify(outbound)});
      if (${cut} >= 3) await store.observe(${JSON.stringify(
      input.digest
    )}, 0, ${JSON.stringify(outbound)}, 'delivered');
      if (${cut} >= 4) await store.complete(${JSON.stringify(
      input.digest
    )}, 101);
      process.kill(process.pid, 'SIGKILL');
    })().catch(() => process.exit(7));`;
    const child = spawnSync(process.execPath, ["-e", bootstrap], {
      env: {
        PATH: process.env.PATH,
        NODE_PATH: resolve(__dirname, "../../../node_modules"),
      },
      timeout: 10000,
    });
    expect(child.signal).toBe("SIGKILL");
    state = await LevelBotStateStore.open(childLocation);
    store = await InboundOperationStore.open(state, owner, false);
    expect(await retainThenStart(input)).toBe(false);
    expect(store.get(input.digest)).toMatchObject({
      phase: cut === 4 ? "completed" : "started",
    });
    expect(store.get(input.digest)?.replies).toHaveLength(cut === 0 ? 0 : 1);
    if (cut >= 2)
      expect(store.get(input.digest)?.replies[0].digest).toBe(outbound);
  }
);

// Was: a started row pins the floor. That made one held invocation re-read its mailbox window
// forever; nothing re-reads a started row's inbound message, so only deferred rows pin.
it("does not pin the scan on started work behind later completed peers and never moves the saved cursor backwards", async () => {
  await retainThenStart(input);
  const later = { ...input, digest: "cc".repeat(32), receivedTime: 200 };
  const middle = { ...input, digest: "dd".repeat(32), receivedTime: 150 };
  await retainThenStart(later);
  await retainThenStart(middle);
  await store.complete(later.digest, 201);
  await store.complete(middle.digest, 151);
  expect(await state.get("cursor:lastPollTimestamp")).toBe("201");
  await reopen();
  expect(store.scanFloor(201)).toBe(201);
  expect(await retainThenStart(input)).toBe(false);
});

it("backpressures extra reply slots without erasing the original unresolved calls", async () => {
  await retainThenStart(input);
  for (let i = 0; i < 64; i++) await store.beginReply(input.digest, call);
  await expect(store.beginReply(input.digest, call)).rejects.toThrow(/held/);
  await reopen();
  expect(store.get(input.digest)?.replies).toHaveLength(64);
  expect(store.get(input.digest)?.phase).toBe("started");
});

it("holds a corrupt completion cursor without rewriting the record or inventing a fresh scan", async () => {
  await retainThenStart(input);
  await store.complete(input.digest, 101);
  await state.put("cursor:lastPollTimestamp", "invalid");
  await expect(InboundOperationStore.open(state, owner, false)).rejects.toThrow(
    /held/
  );
  expect(await state.get("cursor:lastPollTimestamp")).toBe("invalid");
  expect(await state.get("digest:" + input.digest)).toBe("completed");
});

describe("retained, deferred rows", () => {
  const rowKey = (digest: string) => "host-inbound:v1:dispatch:" + digest;
  const other = new Wallet("0x" + "13".repeat(32));
  const numbered = (index: number, change: Partial<InboundIdentity> = {}) => ({
    ...input,
    digest: index.toString(16).padStart(64, "0"),
    ...change,
  });

  // Reproduces: nothing was durable between fetch and handler start, so a message whose start
  // never happened could be passed by the cursor and lost.
  it.each([false, true])(
    "keeps a retained message deferred across a failed retain write (committed=%s) and reopen, and starts it once",
    async (committed) => {
      const original = state.durableBatch.bind(state);
      jest.spyOn(state, "durableBatch").mockImplementationOnce(async (ops) => {
        expect(ops.map((op) => op.key)).toEqual([rowKey(input.digest)]);
        if (committed) await original(ops);
        throw new Error("uncertain write");
      });
      await expect(store.retain(input)).rejects.toThrow(/held/);
      await reopen();
      expect(await store.retain(input)).toBe(committed ? "known" : "retained");
      await reopen();
      expect(store.get(input.digest)).toEqual({
        version: 1,
        ...input,
        phase: "deferred",
        replies: [],
      });
      expect(await state.get("digest:" + input.digest)).toBeUndefined();
      expect(store.scanFloor(900)).toBe(100);
      expect(
        await Promise.all([store.start(input), store.start(input)])
      ).toEqual([true, false]);
      await reopen();
      expect(await store.start(input)).toBe(false);
      expect(store.get(input.digest)?.phase).toBe("started");
    }
  );

  // Reproduces: a held started row pinned the scan floor forever (and completed rows never did).
  it("takes the scan floor from deferred rows only", async () => {
    const held = numbered(1, { receivedTime: 100 });
    const done = numbered(2, { receivedTime: 150 });
    const waiting = numbered(3, {
      receivedTime: 300,
      conversationId: "03030303-0303-0303-0303-030303030303",
    });
    await retainThenStart(held);
    await retainThenStart(done);
    await store.complete(done.digest, 151);
    expect(store.scanFloor(151)).toBe(151);
    await store.retain(waiting);
    await store.retain(numbered(4, { receivedTime: 500 }));
    await reopen();
    expect(store.scanFloor(151)).toBe(151);
    expect(store.scanFloor(900)).toBe(300);
    expect(store.listIncomplete().map((row) => row.digest)).toEqual([
      held.digest,
    ]);
    await store.start(waiting);
    expect(store.scanFloor(900)).toBe(500);
  });

  // Reproduces: a later prompt of a conversation could be handled before an earlier one.
  it("starts a conversation's rows only in (receivedTime, digest) order and leaves other conversations independent", async () => {
    const a1 = numbered(0xa1, { receivedTime: 100 });
    const tie = numbered(0xa2, { receivedTime: 100 });
    const a3 = numbered(0xa3, { receivedTime: 200 });
    const sameThreadOtherPeer = numbered(0xb1, {
      receivedTime: 150,
      peerAddress: other.address.toLowerCase(),
      peerSubject: other.signingKey.compressedPublicKey.slice(2),
    });
    const otherThread = numbered(0xc1, {
      receivedTime: 150,
      conversationId: "03030303-0303-0303-0303-030303030303",
    });
    for (const row of [a3, otherThread, tie, sameThreadOtherPeer, a1])
      await store.retain(row);
    expect(store.listDeferred().map((row) => row.digest)).toEqual(
      [a1, tie, sameThreadOtherPeer, otherThread, a3].map((row) => row.digest)
    );
    await reopen();
    expect(await store.start(a3)).toBe(false);
    expect(await store.start(tie)).toBe(false);
    expect(await store.start(sameThreadOtherPeer)).toBe(true);
    expect(await store.start(otherThread)).toBe(true);
    expect(await store.start(a1)).toBe(true);
    // A started row that never completes is held, and does not block its conversation.
    expect(await store.start(a3)).toBe(false);
    expect(await store.start(tie)).toBe(true);
    expect(await store.start(a3)).toBe(true);
    expect(store.listDeferred()).toEqual([]);
  });

  // Reproduces: admission compared relay time, and a re-fetch could be matched to a row by digest alone.
  it("matches a re-fetched message on every identity field except relay time", async () => {
    await store.retain(input);
    for (const change of [
      { conversationId: "03030303-0303-0303-0303-030303030303" },
      { messageId: "04040404-0404-0404-0404-040404040404" },
      {
        peerAddress: other.address.toLowerCase(),
        peerSubject: other.signingKey.compressedPublicKey.slice(2),
      },
    ]) {
      await expect(store.retain({ ...input, ...change })).rejects.toThrow(
        /held/
      );
      await expect(store.start({ ...input, ...change })).rejects.toThrow(
        /held/
      );
    }
    await expect(
      store.start({ ...input, digest: "cc".repeat(32) })
    ).rejects.toThrow(/held/);
    expect(store.get(input.digest)?.phase).toBe("deferred");
    expect(await store.retain({ ...input, receivedTime: 999 })).toBe("known");
    expect(await store.start({ ...input, receivedTime: 999 })).toBe(true);
    await reopen();
    expect(store.get(input.digest)).toMatchObject({
      phase: "started",
      receivedTime: 100,
    });
  });

  // Reproduces: the row format had no state in which a handler was known not to have run.
  it("refuses every reply transition on a deferred row and rejects impossible stored shapes without rewriting them", async () => {
    await store.retain(input);
    await expect(store.beginReply(input.digest, call)).rejects.toThrow(/held/);
    await expect(store.link(input.digest, 0, outbound)).rejects.toThrow(/held/);
    await expect(
      store.observe(input.digest, 0, outbound, "delivered")
    ).rejects.toThrow(/held/);
    await expect(store.complete(input.digest, 101)).rejects.toThrow(/held/);
    await reopen();
    const deferred = store.get(input.digest);
    expect(deferred).toMatchObject({ phase: "deferred", replies: [] });
    for (const [raw, marker] of [
      [JSON.stringify({ ...deferred, replies: [call] }), undefined],
      [JSON.stringify({ ...deferred, phase: "stranded" }), undefined],
      [JSON.stringify({ ...deferred, prepared: {} }), undefined],
      [JSON.stringify(deferred), "completed"],
    ] as const) {
      await state.put(rowKey(input.digest), raw);
      if (marker) await state.put("digest:" + input.digest, marker);
      await expect(
        InboundOperationStore.open(state, owner, false)
      ).rejects.toThrow(/held/);
      expect(await state.get(rowKey(input.digest))).toBe(raw);
    }
  });

  // Reproduces: at the cap every new message threw, so nothing retained could be told from a fault.
  it("reports full at 1,024 rows without faulting, and still starts and completes rows retained earlier", async () => {
    const seeded = Array.from({ length: 1022 }, (_, index) => {
      const row = numbered(index + 1, { receivedTime: 10 });
      return {
        type: "put" as const,
        key: rowKey(row.digest),
        value: JSON.stringify({
          version: 1,
          ...row,
          phase: "started",
          replies: [],
        }),
      };
    });
    await state.batch(seeded);
    await reopen();
    const first = numbered(0xf001, { receivedTime: 100 });
    const second = numbered(0xf002, { receivedTime: 200 });
    const unretained = numbered(0xf003, { receivedTime: 300 });
    expect(await store.retain(first)).toBe("retained");
    expect(await store.retain(second)).toBe("retained");
    expect(await store.retain(unretained)).toBe("full");
    expect(await store.retain(first)).toBe("known");
    expect(store.get(unretained.digest)).toBeUndefined();
    await expect(store.start(unretained)).rejects.toThrow(/held/);
    expect(await store.start(first)).toBe(true);
    expect(await store.complete(first.digest, 101)).toBe(101);
    expect(await store.start(second)).toBe(true);
    await store.beginReply(second.digest, call);
    await store.link(second.digest, 0, outbound);
    await store.observe(second.digest, 0, outbound, "delivered");
    // The behaviour change: the cursor passes a message that was never retained.
    expect(await store.complete(second.digest, 201)).toBe(201);
    await reopen();
    expect(await store.retain(unretained)).toBe("full");
    expect((await state.readEntries("host-inbound:v1:dispatch:")).length).toBe(
      1024
    );
    expect(store.scanFloor(201)).toBe(201);
  });

  // Reproduces the upgrade risk: rows written before this change must load unchanged and stay held.
  it("opens rows in the shape written before retention existed and holds them exactly", async () => {
    const shape = (
      index: number,
      phase: "started" | "completed",
      replies: object[]
    ) => {
      const row = numbered(index, { receivedTime: 100 + index });
      return [
        row,
        JSON.stringify({ version: 1, ...row, phase, replies }),
      ] as const;
    };
    const linked = (digit: string, observation?: string) => ({
      ...call,
      digest: digit.repeat(64),
      ...(observation ? { observation } : {}),
    });
    const rows = [
      shape(1, "started", []),
      shape(2, "started", [call]),
      shape(3, "started", [linked("3")]),
      shape(4, "started", [linked("4", "live")]),
      shape(5, "started", [linked("5", "delivered")]),
      shape(6, "completed", [linked("6", "delivered")]),
    ];
    await state.batch([
      ...rows.map(([row, value]) => ({
        type: "put" as const,
        key: rowKey(row.digest),
        value,
      })),
      { type: "put", key: "digest:" + rows[5][0].digest, value: "completed" },
      { type: "put", key: "cursor:lastPollTimestamp", value: "107" },
    ]);
    await reopen();
    for (const [row] of rows) {
      expect(await store.retain(row)).toBe("known");
      expect(await store.start(row)).toBe(false);
    }
    await expect(store.complete(rows[1][0].digest, 500)).rejects.toThrow(
      /held/
    );
    await expect(store.complete(rows[3][0].digest, 500)).rejects.toThrow(
      /held/
    );
    expect(store.listDeferred()).toEqual([]);
    expect(store.scanFloor(107)).toBe(107);
    expect(store.listIncomplete()).toHaveLength(5);
    await reopen();
    for (const [row, value] of rows)
      expect(await state.get(rowKey(row.digest))).toBe(value);
    expect(await state.get("cursor:lastPollTimestamp")).toBe("107");
  });
});

describe("prepared replies", () => {
  const rowKey = (digest: string) => "host-inbound:v1:dispatch:" + digest;
  const staged = (digest: string, part: "text" | "value") =>
    `host-prepared:v1:${digest}:${part}`;
  const sha = (value: string) =>
    createHash("sha256").update(value, "utf8").digest("hex");
  const other = new Wallet("0x" + "13".repeat(32));
  const numbered = (index: number, change: Partial<InboundIdentity> = {}) => ({
    ...input,
    digest: index.toString(16).padStart(64, "0"),
    receivedTime: 100 + index,
    ...change,
  });
  const threadB = "03030303-0303-0303-0303-030303030303";
  const reply = (
    change: Partial<PreparedReply["commit"]> = {},
    text = "the answer"
  ): PreparedReply => ({
    kind: "prepared-reply",
    text,
    commit: { key: "plugin:a", expectedSha256: null, value: "next", ...change },
  });
  const slot = {
    recipient: input.peerAddress,
    conversationId: input.conversationId,
    stampValue: "5",
  };
  /** Starts `identity` and stages a reply for it. */
  async function prepared(identity: InboundIdentity, staging = reply()) {
    expect(await retainThenStart(identity)).toBe(true);
    await store.prepare(identity.digest, staging, "5");
  }
  /** Stages, sends, links and records delivery: everything but the completion. */
  async function delivered(identity: InboundIdentity, staging = reply()) {
    await prepared(identity, staging);
    await store.beginPreparedReply(identity.digest);
    await store.link(identity.digest, 0, identity.digest.replace(/^0/, "f"));
    await store.observe(
      identity.digest,
      0,
      identity.digest.replace(/^0/, "f"),
      "delivered"
    );
  }

  // T10. Reproduces: nothing recorded a generated answer before it was sent.
  it("stages the answer and commit value in one batch with the row, and keeps content out of the row", async () => {
    await retainThenStart(input);
    const writes = jest.spyOn(state, "durableBatch");
    await store.prepare(
      input.digest,
      reply({ expectedSha256: sha("old") }),
      "5"
    );
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0][0].map((op) => op.key)).toEqual([
      rowKey(input.digest),
      staged(input.digest, "text"),
      staged(input.digest, "value"),
    ]);
    await reopen();
    expect(store.get(input.digest)).toEqual({
      version: 1,
      ...input,
      phase: "started",
      replies: [],
      prepared: {
        stampValue: "5",
        textSha256: sha("the answer"),
        valueSha256: sha("next"),
        stateKey: "plugin:a",
        expectedSha256: sha("old"),
      },
    });
    expect(await state.get(staged(input.digest, "text"))).toBe("the answer");
    expect(await state.get(staged(input.digest, "value"))).toBe("next");
    expect(await state.get(rowKey(input.digest))).not.toContain("the answer");
    // Once per invocation, and never beside a direct reply slot.
    await expect(store.prepare(input.digest, reply(), "5")).rejects.toThrow(
      /held/
    );
    const direct = numbered(2, { conversationId: threadB });
    await retainThenStart(direct);
    await store.beginReply(direct.digest, { ...call, conversationId: threadB });
    await expect(
      store.prepare(direct.digest, reply({ key: "plugin:b" }), "5")
    ).rejects.toThrow(/held/);
    expect(store.get(direct.digest)?.prepared).toBeUndefined();
    await expect(store.beginReply(input.digest, call)).rejects.toThrow(/held/);
  });

  // T10. Reproduces: a plugin value had no structural, key or size bound at the host.
  it("refuses a malformed, mis-keyed or oversized reply without writing or faulting", async () => {
    await retainThenStart(input);
    const writes = jest.spyOn(state, "durableBatch");
    const text = "a".repeat(262_144);
    const value = "b".repeat(1_048_576);
    const refused: unknown[] = [
      { ...reply(), kind: "reply" },
      { ...reply(), extra: 1 },
      { ...reply(), commit: { ...reply().commit, extra: 1 } },
      { kind: "prepared-reply", text: "x" },
      reply({}, 42 as unknown as string),
      reply({}, text + "a"),
      reply({}, "é".repeat(131_072) + "a"),
      reply({}, "\ud800"),
      reply({ value: value + "b" }),
      reply({ value: "\udc00x" }),
      reply({ value: undefined as unknown as string }),
      reply({ expectedSha256: "AA".repeat(32) }),
      reply({ expectedSha256: undefined as unknown as null }),
      reply({ key: "" }),
      reply({ key: "a".repeat(513) }),
      reply({ key: "sub!key" }),
      reply({ key: "line\nbreak" }),
      reply({ key: "café" }),
      ...[
        "host-inbound:",
        "host-prepared:",
        "digest:",
        "cursor:",
        "greeted:",
      ].map((prefix) => reply({ key: prefix + "x" })),
    ];
    for (const bad of refused)
      await expect(
        store.prepare(input.digest, bad as PreparedReply, "5")
      ).rejects.toThrow(/held/);
    await expect(store.prepare(input.digest, reply(), "05")).rejects.toThrow(
      /held/
    );
    expect(writes).not.toHaveBeenCalled();
    expect(store.get(input.digest)?.prepared).toBeUndefined();
    expect(await state.readEntries("host-prepared:")).toEqual([]);
    // Exactly at each limit is accepted, and the journal was never faulted.
    await store.prepare(
      input.digest,
      reply({ key: "k".repeat(512), value }, text),
      "5"
    );
    await reopen();
    expect(await state.get(staged(input.digest, "text"))).toBe(text);
    expect(await state.get(staged(input.digest, "value"))).toBe(value);
    expect(await store.beginPreparedReply(input.digest)).toBe(text);
  });

  // T10/T7. Reproduces: a reply was sent whatever the plugin key held by then.
  it("begins a send only from prepared-no-slot, with the plugin key and staged text unchanged", async () => {
    await prepared(input, reply({ expectedSha256: sha("old") }));
    await expect(store.beginPreparedReply(input.digest)).rejects.toThrow(
      /held/
    );
    await state.put("plugin:a", "other");
    await expect(store.beginPreparedReply(input.digest)).rejects.toThrow(
      /held/
    );
    await state.put("plugin:a", "old");
    await state.put(staged(input.digest, "text"), "tampered");
    await expect(store.beginPreparedReply(input.digest)).rejects.toThrow(
      /held/
    );
    await state.del(staged(input.digest, "text"));
    await expect(store.beginPreparedReply(input.digest)).rejects.toThrow(
      /held/
    );
    expect(store.get(input.digest)?.replies).toEqual([]);
    await state.put(staged(input.digest, "text"), "the answer");
    expect(await store.beginPreparedReply(input.digest)).toBe("the answer");
    expect(store.get(input.digest)?.replies).toEqual([slot]);
    await expect(store.beginPreparedReply(input.digest)).rejects.toThrow(
      /held/
    );
    // A row without a staged reply has no such transition.
    const plain = numbered(2);
    await retainThenStart(plain);
    await expect(store.beginPreparedReply(plain.digest)).rejects.toThrow(
      /held/
    );
  });

  // T10. Reproduces: a slot without a digest was held forever, even when nothing was attempted.
  it("retracts only an unlinked slot it persisted itself, never one found at open", async () => {
    await prepared(input);
    await expect(store.retractReply(input.digest)).rejects.toThrow(/held/);
    await store.beginPreparedReply(input.digest);
    await store.retractReply(input.digest);
    expect(store.get(input.digest)?.replies).toEqual([]);
    await expect(store.retractReply(input.digest)).rejects.toThrow(/held/);
    expect(await state.get(staged(input.digest, "text"))).toBe("the answer");
    // Sent again, and this time the wallet reported an attempt: the slot stays for good.
    await store.beginPreparedReply(input.digest);
    await store.link(input.digest, 0, outbound);
    await expect(store.retractReply(input.digest)).rejects.toThrow(/held/);
    // An unlinked slot that survives a restart is evidence of a call nobody can account for.
    const second = numbered(2, { conversationId: threadB });
    await prepared(second, reply({ key: "plugin:b" }));
    await store.beginPreparedReply(second.digest);
    await reopen();
    await expect(store.retractReply(second.digest)).rejects.toThrow(/held/);
    await expect(store.beginPreparedReply(second.digest)).rejects.toThrow(
      /held/
    );
    expect(store.get(second.digest)?.replies).toEqual([
      { ...slot, conversationId: threadB },
    ]);
    // A direct reply slot is never retracted either.
    const direct = numbered(3, { conversationId: threadB });
    await retainThenStart(direct);
    await store.beginReply(direct.digest, call);
    await expect(store.retractReply(direct.digest)).rejects.toThrow(/held/);
  });

  // T10. Reproduces: history was a separate, later, unconditional plugin write.
  it("commits the value, completes the row and deletes the staged content in one batch, only once delivered and unchanged", async () => {
    await state.put("plugin:a", "old");
    await prepared(input, reply({ expectedSha256: sha("old") }));
    await expect(store.complete(input.digest, 201)).rejects.toThrow(/held/);
    await store.beginPreparedReply(input.digest);
    await expect(store.complete(input.digest, 201)).rejects.toThrow(/held/);
    await store.link(input.digest, 0, outbound);
    await store.observe(input.digest, 0, outbound, "live");
    await expect(store.complete(input.digest, 201)).rejects.toThrow(/held/);
    await store.observe(input.digest, 0, outbound, "delivered");
    // Conflict, tampered value: nothing is written and the journal is not faulted.
    const writes = jest.spyOn(state, "durableBatch");
    await state.put("plugin:a", "written by the plugin");
    await expect(store.complete(input.digest, 201)).rejects.toThrow(/held/);
    await state.put("plugin:a", "old");
    await state.put(staged(input.digest, "value"), "tampered");
    await expect(store.complete(input.digest, 201)).rejects.toThrow(/held/);
    expect(writes).not.toHaveBeenCalled();
    expect(await state.get("plugin:a")).toBe("old");
    expect(await state.get("digest:" + input.digest)).toBeUndefined();
    await state.put(staged(input.digest, "value"), "next");
    expect(await store.complete(input.digest, 201)).toBe(201);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0][0]).toEqual([
      { type: "put", key: "plugin:a", value: "next" },
      expect.objectContaining({ type: "put", key: rowKey(input.digest) }),
      { type: "put", key: "digest:" + input.digest, value: "completed" },
      { type: "put", key: "cursor:lastPollTimestamp", value: "201" },
      { type: "del", key: staged(input.digest, "text") },
      { type: "del", key: staged(input.digest, "value") },
    ]);
    await reopen();
    expect(store.get(input.digest)).toMatchObject({
      phase: "completed",
      prepared: { stateKey: "plugin:a" },
      replies: [{ digest: outbound, observation: "delivered" }],
    });
    expect(await state.get("plugin:a")).toBe("next");
    expect(await state.readEntries("host-prepared:")).toEqual([]);
    await expect(store.complete(input.digest, 301)).rejects.toThrow(/held/);
    expect(await state.get("plugin:a")).toBe("next");
  });

  // T2 at the store. Reproduces: no transition existed between "generated" and "history written".
  it.each([
    ["prepare", false],
    ["prepare", true],
    ["slot", false],
    ["slot", true],
    ["retract", false],
    ["retract", true],
    ["complete", false],
    ["complete", true],
  ] as const)(
    "recovers disk truth after a cut %s write (committed=%s)",
    async (step, committed) => {
      await retainThenStart(input);
      if (step !== "prepare") await store.prepare(input.digest, reply(), "5");
      if (step === "retract" || step === "complete")
        await store.beginPreparedReply(input.digest);
      if (step === "complete") {
        await store.link(input.digest, 0, outbound);
        await store.observe(input.digest, 0, outbound, "delivered");
      }
      const original = state.durableBatch.bind(state);
      jest.spyOn(state, "durableBatch").mockImplementationOnce(async (ops) => {
        if (committed) await original(ops);
        throw new Error("uncertain write");
      });
      await expect(
        step === "prepare"
          ? store.prepare(input.digest, reply(), "5")
          : step === "slot"
          ? store.beginPreparedReply(input.digest)
          : step === "retract"
          ? store.retractReply(input.digest)
          : store.complete(input.digest, 201)
      ).rejects.toThrow(/held/);
      // Faulted until reopen: nothing more can be staged, sent or committed by this process.
      await expect(store.beginPreparedReply(input.digest)).rejects.toThrow(
        /held/
      );
      await reopen();
      const row = store.get(input.digest);
      const after = step === "retract" ? !committed : committed;
      if (step === "prepare") {
        expect(row?.prepared === undefined).toBe(!committed);
        expect(await state.readEntries("host-prepared:")).toHaveLength(
          committed ? 2 : 0
        );
      } else if (step === "complete") {
        expect(row?.phase).toBe(committed ? "completed" : "started");
        expect(await state.get("plugin:a")).toBe(
          committed ? "next" : undefined
        );
        expect(await state.readEntries("host-prepared:")).toHaveLength(
          committed ? 0 : 2
        );
        if (!committed)
          expect(await store.complete(input.digest, 201)).toBe(201);
        expect(await state.get("plugin:a")).toBe("next");
      } else {
        // A slot on disk after a restart is held; without one the reply is sent, once.
        expect(row?.replies).toEqual(after ? [slot] : []);
        if (after)
          await expect(store.retractReply(input.digest)).rejects.toThrow(
            /held/
          );
        await (after
          ? expect(store.beginPreparedReply(input.digest)).rejects.toThrow(
              /held/
            )
          : expect(store.beginPreparedReply(input.digest)).resolves.toBe(
              "the answer"
            ));
      }
    }
  );

  // T10 (b). Reproduces: a later prompt was answered against history still waiting to land.
  it("keeps a conversation's later prompt deferred while an earlier reply's commit is owed", async () => {
    const first = numbered(1);
    const second = numbered(2);
    const elsewhere = numbered(3, { conversationId: threadB });
    const stranger = numbered(4, {
      peerAddress: other.address.toLowerCase(),
      peerSubject: other.signingKey.compressedPublicKey.slice(2),
    });
    for (const row of [second, elsewhere, stranger]) await store.retain(row);
    await prepared(first);
    expect(await store.start(second)).toBe(false);
    expect(await store.start(elsewhere)).toBe(true);
    expect(await store.start(stranger)).toBe(true);
    const sent = first.digest.replace(/^0/, "f");
    await store.beginPreparedReply(first.digest);
    await store.link(first.digest, 0, sent);
    await reopen();
    expect(await store.start(second)).toBe(false);
    await store.observe(first.digest, 0, sent, "delivered");
    expect(await store.start(second)).toBe(false);
    expect(store.scanFloor(900)).toBe(second.receivedTime);
    await store.complete(first.digest, 102);
    expect(await store.start(second)).toBe(true);
  });

  // Revision 5 / OD-1. Reproduces the contract defect: the conversation behind a reply held on
  // an unlinked slot was started, generated, and then had its own reply refused, for ever.
  it("lets a conversation go on past a reply held on an unlinked slot, and stage its next reply on the same key", async () => {
    const first = numbered(1);
    const second = numbered(2);
    const third = numbered(3);
    await prepared(first);
    await store.beginPreparedReply(first.digest);
    await store.retain(second);
    await store.retain(third);
    expect(await store.start(second)).toBe(true);
    await store.prepare(second.digest, reply(), "5");
    // The second reply can still commit, so the third prompt waits for it.
    expect(await store.start(third)).toBe(false);
    await reopen();
    expect(store.get(first.digest)).toMatchObject({
      phase: "started",
      replies: [slot],
    });
    expect(store.get(second.digest)?.prepared?.stateKey).toBe("plugin:a");
    await expect(store.beginPreparedReply(first.digest)).rejects.toThrow(
      /held/
    );
    const sent = second.digest.replace(/^0/, "f");
    await store.beginPreparedReply(second.digest);
    await store.link(second.digest, 0, sent);
    await store.observe(second.digest, 0, sent, "delivered");
    await store.complete(second.digest, 103);
    expect(await state.get("plugin:a")).toBe("next");
    expect(await store.start(third)).toBe(true);
  });

  // T18 at the store. Reproduces: two conversations could stage commits to one key.
  it("refuses a second owed reply on one key from another conversation, whatever state the first is in", async () => {
    const first = numbered(1);
    const elsewhere = numbered(2, { conversationId: threadB });
    await prepared(first);
    await retainThenStart(elsewhere);
    await expect(store.prepare(elsewhere.digest, reply(), "5")).rejects.toThrow(
      /held/
    );
    // Even an unlinked slot: across peers nothing says its send is not still in flight.
    await store.beginPreparedReply(first.digest);
    await expect(store.prepare(elsewhere.digest, reply(), "5")).rejects.toThrow(
      /held/
    );
    expect(store.get(elsewhere.digest)?.prepared).toBeUndefined();
    await store.prepare(elsewhere.digest, reply({ key: "plugin:b" }), "5");
    // Once the first has committed the key is free again.
    const later = numbered(3, { conversationId: threadB });
    await store.link(first.digest, 0, outbound);
    await store.observe(first.digest, 0, outbound, "delivered");
    await store.complete(first.digest, 102);
    const third = numbered(4, {
      conversationId: "04040404-0404-0404-0404-040404040404",
    });
    await retainThenStart(third);
    await store.prepare(
      third.digest,
      reply({ expectedSha256: sha("next"), value: "after" }),
      "5"
    );
    await store.retain(later);
    expect(await store.start(later)).toBe(false);
  });

  // T10 (d), OD-6. Reproduces: every prompt called the model while sends were being refused.
  it("stops starting handlers bot-wide at the bound of answers staged with no slot", async () => {
    const conversation = (index: number) =>
      index.toString(16).padStart(8, "0") + "-0000-0000-0000-000000000000";
    const rows = Array.from({ length: MAX_STAGED_UNSENT + 2 }, (_, index) =>
      numbered(index + 1, { conversationId: conversation(index + 1) })
    );
    expect(MAX_STAGED_UNSENT).toBe(16);
    for (const row of rows.slice(0, MAX_STAGED_UNSENT))
      await prepared(row, reply({ key: "plugin:" + row.digest }));
    const [waiting, running] = rows.slice(MAX_STAGED_UNSENT);
    await store.retain(waiting);
    await store.retain(running);
    expect(await store.start(waiting)).toBe(false);
    await reopen();
    expect(await store.start(waiting)).toBe(false);
    expect(store.listDeferred().map((row) => row.digest)).toEqual([
      waiting.digest,
      running.digest,
    ]);
    // A slot, linked or not, is no longer "staged ahead of a send".
    await store.beginPreparedReply(rows[0].digest);
    expect(await store.start(waiting)).toBe(true);
    // The handler now running is not counted until it stages: the bound is of staged answers.
    expect(await store.start(running)).toBe(true);
    await store.prepare(waiting.digest, reply({ key: "plugin:w" }), "5");
    await store.prepare(running.digest, reply({ key: "plugin:r" }), "5");
    await store.retractReply(rows[0].digest);
    const late = numbered(99, { conversationId: conversation(99) });
    await store.retain(late);
    expect(await store.start(late)).toBe(false);
  });

  // T10. Reproduces the upgrade and corruption risk: impossible prepared shapes must not load.
  it("rejects impossible prepared rows at open without rewriting them", async () => {
    await delivered(input);
    const good = store.get(input.digest)!;
    const twin = numbered(2, { conversationId: threadB });
    const shapes: object[] = [
      { ...good, prepared: { ...good.prepared, extra: 1 } },
      { ...good, prepared: { ...good.prepared, stateKey: "a!b" } },
      { ...good, prepared: { ...good.prepared, stateKey: "digest:x" } },
      { ...good, prepared: { ...good.prepared, textSha256: "zz" } },
      { ...good, prepared: { ...good.prepared, stampValue: "6" } },
      { ...good, prepared: { ...good.prepared, expectedSha256: undefined } },
      { ...good, replies: [good.replies[0], good.replies[0]] },
      { ...good, replies: [{ ...good.replies[0], recipient: owner.address }] },
      { ...good, replies: [{ ...good.replies[0], conversationId: threadB }] },
      { ...good, phase: "deferred", replies: [] },
    ];
    for (const shape of shapes) {
      const raw = JSON.stringify(shape);
      await state.put(rowKey(input.digest), raw);
      await expect(
        InboundOperationStore.open(state, owner, false)
      ).rejects.toThrow(/held/);
      expect(await state.get(rowKey(input.digest))).toBe(raw);
    }
    // Two replies that can both still commit to one key.
    await state.put(rowKey(input.digest), JSON.stringify(good));
    const raw = JSON.stringify({
      ...good,
      ...twin,
      replies: [],
    });
    await state.put(rowKey(twin.digest), raw);
    await expect(
      InboundOperationStore.open(state, owner, false)
    ).rejects.toThrow(/held/);
    // One of them held on an unlinked slot is the state Revision 5 allows.
    await state.put(
      rowKey(twin.digest),
      JSON.stringify({
        ...good,
        ...twin,
        replies: [{ ...slot, conversationId: threadB }],
      })
    );
    await reopen();
    expect(store.listIncomplete()).toHaveLength(2);
    // A completed prepared row must carry its one delivered slot.
    await store.complete(input.digest, 201);
    const done = JSON.stringify({ ...store.get(input.digest), replies: [] });
    await state.put(rowKey(input.digest), done);
    await expect(
      InboundOperationStore.open(state, owner, false)
    ).rejects.toThrow(/held/);
    expect(await state.get(rowKey(input.digest))).toBe(done);
  });
});
