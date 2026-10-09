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
  expect(await Promise.all([store.admit(input), store.admit(input)])).toEqual([
    true,
    false,
  ]);
  await reopen();
  expect(await store.admit(input)).toBe(false);
  await expect(
    store.admit({
      ...input,
      conversationId: "03030303-0303-0303-0303-030303030303",
    })
  ).rejects.toThrow(/held/);
  expect(store.scanFloor(900)).toBe(100);
});
it.each(["live", "unknown", "dead", "delivered"] as const)(
  "keeps a %s wallet observation distinct from handler completion",
  async (status) => {
    await store.admit(input);
    await store.beginReply(input.digest, call);
    await store.link(input.digest, 0, outbound);
    await store.observe(input.digest, 0, outbound, status);
    await reopen();
    expect(store.get(input.digest)).toMatchObject({
      phase: "started",
      replies: [{ digest: outbound, observation: status }],
    });
    expect(await state.get("digest:" + input.digest)).toBeUndefined();
    expect(await store.admit(input)).toBe(false);
  }
);
it("requires exact callback correlation and delivered replies for atomic handler completion", async () => {
  await store.admit(input);
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
  expect(await store.admit(input)).toBe(false);
});
it.each([false, true])(
  "faults after a begin write fails (committed=%s), then recovers only disk truth",
  async (committed) => {
    const original = state.durableBatch.bind(state);
    jest.spyOn(state, "durableBatch").mockImplementationOnce(async (ops) => {
      if (committed) await original(ops);
      throw new Error("uncertain write");
    });
    await expect(store.admit(input)).rejects.toThrow(/held/);
    await expect(
      store.admit({ ...input, digest: "cc".repeat(32) })
    ).rejects.toThrow(/held/);
    await reopen();
    expect(await store.admit(input)).toBe(!committed);
  }
);
it.each(["link", "complete"] as const)(
  "recovers a committed %s write whose acknowledgement was lost",
  async (step) => {
    await store.admit(input);
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
    expect(await store.admit(input)).toBe(false);
  }
);
it("keeps distinct reply slots and holds all of them when the handler was interrupted", async () => {
  await store.admit(input);
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
  expect(await store.admit(input)).toBe(false);
  await expect(store.complete(input.digest, 101)).rejects.toThrow(/held/);
});
it("rejects wrong network/identity, corrupt rows and unsupported versions without replacing them", async () => {
  await store.admit(input);
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
  await store.admit(input);
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
      await store.admit(${JSON.stringify(input)});
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
    expect(await store.admit(input)).toBe(false);
    expect(store.get(input.digest)).toMatchObject({
      phase: cut === 4 ? "completed" : "started",
    });
    expect(store.get(input.digest)?.replies).toHaveLength(cut === 0 ? 0 : 1);
    if (cut >= 2)
      expect(store.get(input.digest)?.replies[0].digest).toBe(outbound);
  }
);

it("pins admitted work behind later completed peers and never moves the saved cursor backwards", async () => {
  await store.admit(input);
  const later = { ...input, digest: "cc".repeat(32), receivedTime: 200 };
  const middle = { ...input, digest: "dd".repeat(32), receivedTime: 150 };
  await store.admit(later);
  await store.admit(middle);
  await store.complete(later.digest, 201);
  await store.complete(middle.digest, 151);
  expect(await state.get("cursor:lastPollTimestamp")).toBe("201");
  await reopen();
  expect(store.scanFloor(201)).toBe(100);
  expect(await store.admit(input)).toBe(false);
});

it("backpressures extra reply slots without erasing the original unresolved calls", async () => {
  await store.admit(input);
  for (let i = 0; i < 64; i++) await store.beginReply(input.digest, call);
  await expect(store.beginReply(input.digest, call)).rejects.toThrow(/held/);
  await reopen();
  expect(store.get(input.digest)?.replies).toHaveLength(64);
  expect(store.get(input.digest)?.phase).toBe("started");
});

it("holds a corrupt completion cursor without rewriting the record or inventing a fresh scan", async () => {
  await store.admit(input);
  await store.complete(input.digest, 101);
  await state.put("cursor:lastPollTimestamp", "invalid");
  await expect(InboundOperationStore.open(state, owner, false)).rejects.toThrow(
    /held/
  );
  expect(await state.get("cursor:lastPollTimestamp")).toBe("invalid");
  expect(await state.get("digest:" + input.digest)).toBe("completed");
});
