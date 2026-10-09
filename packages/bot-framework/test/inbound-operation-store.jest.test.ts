import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";
import { Wallet, getBytes } from "ethers";
import { LevelBotStateStore } from "../src/state-store";
import {
  InboundOperationStore,
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
