import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Wallet, getBytes } from "ethers";
import { FrankBotHost } from "../bot-framework/src/bot-host";
import { LevelBotStateStore } from "../bot-framework/src/state-store";
import { QwenBot } from "./src/bots/qwen-bot";
import { LoopGuard } from "../bot-framework/src/loop-guard";
import type { InboundOperationStore } from "../bot-framework/src/inbound-operation-store";
import type {
  DirectMessageReceived,
  DirectMessageSendResult,
  DirectMessageClient,
} from "@frank/wallet/chain/active-chain";

const mockSend = jest.fn();
const mockFetch = jest.fn();
const mockReconcile = jest.fn();
const mockPublish = jest.fn();
const mockCreate = jest.fn();
jest.mock("../bot-framework/src/relay-profile-manager", () => ({
  RelayProfileManager: { registerProfile: jest.fn() },
}));
jest.mock("../bot-framework/src/directory-manager", () => ({
  DirectoryManager: {
    create: () => ({
      network: "monad-testnet",
      publishWithRetry: mockPublish,
      startHeartbeat: jest.fn(),
      rawDirectory: {},
      lookupPeer: jest.fn(),
      close: jest.fn(),
    }),
  },
}));
jest.mock("@frank/wallet/chain/monad-chain", () => {
  const actual = jest.requireActual("@frank/wallet/chain/monad-chain");
  return {
    ...actual,
    createEvmChain: () => ({
      chainIdentifier: "monad-testnet",
      directMessages: {
        send: mockSend,
        fetchSince: mockFetch,
        reconcileAttempts: mockReconcile,
      },
      createWallet: mockCreate,
    }),
    installCanonicalDirectory: () => () => {},
    loadMonadChainConfigFromEnv: () => ({
      networkTag: "MONT",
      relayBaseUrl: "http://localhost.invalid",
      defaultStampValueWei: 1n,
    }),
  };
});

const receipt: DirectMessageSendResult = {
  payloadDigest: "aa".repeat(32),
  stampValueWei: 1n,
  stampPayments: [],
  preparationTxHashes: [],
};
const peer = new Wallet("0x" + "12".repeat(32));
let root: string;
let host: FrankBotHost;
let reply: jest.Mock;
let local: { address: { raw: string }; compressedPubKey: Buffer };
let environment: NodeJS.ProcessEnv;
const poll = async (peerAddress = peer.address) => {
  await (host as unknown as { pollAllBots(): Promise<void> }).pollAllBots();
  // Existing poll queues asynchronously. Wait through local Level commits, not a live timer.
  const instances = (
    host as unknown as {
      instances: Map<
        string,
        {
          peerQueue: {
            enqueue<T>(peer: string, f: () => Promise<T>): Promise<T>;
          };
        }
      >;
    }
  ).instances;
  for (const instance of instances.values())
    await instance.peerQueue.enqueue(peerAddress, async () => {});
};
const message = (): DirectMessageReceived => ({
  senderAddress: { raw: peer.address },
  senderPublicKey: getBytes(peer.signingKey.compressedPublicKey),
  recipientAddress: local.address,
  recipientPublicKey: local.compressedPubKey,
  conversationId: "01010101-0101-0101-0101-010101010101",
  messageId: "02020202-0202-0202-0202-020202020202",
  payloadDigest: "bb".repeat(32),
  receivedTime: 1000,
  items: [{ type: "text", text: "Hello" }],
  stampValueWei: 1n,
  stampPayments: [],
});
async function open() {
  host = new FrankBotHost({
    stateDir: root,
    relayBaseUrl: "http://localhost.invalid",
    watchRegistrations: false,
  });
  const bot = new QwenBot({ generator: { reply } });
  Object.defineProperty(bot, "defaultIdentityPath", {
    value: join(root, "new-identity.json"),
  });
  await host.register(bot);
  // The removed fallback is a tripwire, not a production replacement in this fixture.
  const legacy = jest.fn().mockResolvedValue(receipt);
  Object.defineProperty(host, "sendStandardDirectMessage", { value: legacy });
  return legacy;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qwen-host-safety-"));
  environment = process.env;
  process.env = { ...environment };
  for (const key of [
    "E2E_DEMO_MAIN_WALLET_PRIVATE_KEY",
    "FRANK_DEMO_FAUCET_WALLET_JSON",
    "E2E_DEMO_MAIN_WALLET_JSON",
  ])
    delete process.env[key];
  jest.clearAllMocks();
  reply = jest.fn().mockResolvedValue({ content: "Saved once" });
  mockCreate.mockImplementation(
    async (
      roots: Parameters<
        typeof import("@frank/wallet/monad-wallet-material").createMonadWalletMaterial
      >[0]
    ) => {
      const { createMonadWalletMaterial } = await import(
        "@frank/wallet/monad-wallet-material"
      );
      const material = createMonadWalletMaterial(roots);
      local = material.identity;
      return {
        identity: material.identity,
        getReceiveAddress: async () => material.identity.address,
        close: async () => material.dispose(),
      };
    }
  );
  mockFetch.mockImplementation(async () => [message()]);
  mockReconcile.mockResolvedValue({ [receipt.payloadDigest]: "delivered" });
});
afterEach(async () => {
  await host?.stop();
  process.env = environment;
  jest.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it("retains the original reply across pending error, repeated polling and a real Level reopen", async () => {
  mockSend.mockImplementation(
    async (params: Parameters<DirectMessageClient["send"]>[0]) => {
      await params.onAttemptCreated?.(receipt.payloadDigest);
      throw new Error("canonical attempt pending");
    }
  );
  let legacy = await open();
  await poll();
  await poll();
  expect(reply).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(legacy).not.toHaveBeenCalled();
  await host.stop();
  legacy = await open();
  // Recovery must work even when mailbox echo is absent.
  mockFetch.mockResolvedValue([]);
  await poll();
  expect(mockReconcile).toHaveBeenCalledWith(
    expect.objectContaining({ payloadDigests: [receipt.payloadDigest] })
  );
  mockFetch.mockImplementation(async () => [message()]);
  await poll();
  expect(reply).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(legacy).not.toHaveBeenCalled();
  const store = (
    host as unknown as { instances: Map<string, { state: LevelBotStateStore }> }
  ).instances.get("qwen")!.state;
  expect(await store.get(`digest:${message().payloadDigest}`)).toBeUndefined();
});

it("does not regenerate or repay after delivery followed by a failed history write", async () => {
  const counted = jest.spyOn(LoopGuard.prototype, "recordReply");
  mockSend.mockImplementation(
    async (params: Parameters<DirectMessageClient["send"]>[0]) => {
      await params.onAttemptCreated?.(receipt.payloadDigest);
      return receipt;
    }
  );
  const legacy = await open();
  const original = LevelBotStateStore.prototype.put;
  let failedHistory = false;
  jest
    .spyOn(LevelBotStateStore.prototype, "put")
    .mockImplementation(function (key, value) {
      if (key.startsWith("qwen-history:v1:")) {
        failedHistory = true;
        return Promise.reject(new Error("history unavailable"));
      }
      return original.call(this, key, value);
    });
  await poll();
  await poll();
  await host.stop();
  await open();
  await poll();
  expect(failedHistory).toBe(true);
  expect(reply).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(legacy).not.toHaveBeenCalled();
  expect(counted).toHaveBeenCalledTimes(1);
});

it("holds an unversioned existing root before opening a wallet or publishing", async () => {
  const location = join(root, "bots", "qwen");
  mkdirSync(location, { recursive: true });
  const bytes = "13".repeat(32);
  writeFileSync(join(location, "account-root.hex"), bytes);
  await expect(open()).rejects.toThrow(/preserve|unversioned|admission/i);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockPublish).not.toHaveBeenCalled();
  expect(readFileSync(join(location, "account-root.hex"), "utf8")).toBe(bytes);
});

it.each([
  ["begin", false],
  ["reply", false],
  ["link", false],
  ["link", true],
  ["completion", false],
  ["completion", true],
] as const)(
  "holds the real Qwen path at %s write failure (committed=%s)",
  async (cut, committed) => {
    const broadcast = jest.fn();
    mockSend.mockImplementation(
      async (params: Parameters<DirectMessageClient["send"]>[0]) => {
        await params.onAttemptCreated?.(receipt.payloadDigest);
        broadcast();
        return receipt;
      }
    );
    const legacy = await open();
    const original = LevelBotStateStore.prototype.durableBatch;
    let injected = false;
    jest
      .spyOn(LevelBotStateStore.prototype, "durableBatch")
      .mockImplementation(async function (ops) {
        const op = ops.find(
          (value) =>
            value.type === "put" &&
            value.key.startsWith("host-inbound:v1:dispatch:")
        );
        const row =
          op?.type === "put"
            ? (JSON.parse(op.value) as {
                phase: string;
                replies: Array<{ digest?: string; observation?: string }>;
              })
            : undefined;
        const match =
          row &&
          (cut === "begin"
            ? !row.replies.length
            : cut === "reply"
            ? row.replies.length === 1 && !row.replies[0].digest
            : cut === "link"
            ? !!row.replies[0]?.digest && !row.replies[0].observation
            : row.phase === "completed");
        if (!injected && match) {
          injected = true;
          if (committed) await original.call(this, ops);
          throw new Error("lost storage acknowledgement");
        }
        return original.call(this, ops);
      });
    await poll();
    expect(injected).toBe(true);
    expect(reply).toHaveBeenCalledTimes(cut === "begin" ? 0 : 1);
    expect(mockSend).toHaveBeenCalledTimes(
      cut === "begin" || cut === "reply" ? 0 : 1
    );
    expect(broadcast).toHaveBeenCalledTimes(cut === "completion" ? 1 : 0);
    expect(legacy).not.toHaveBeenCalled();
    await host.stop();
    await open();
    // No callback exists for begun-only rows. They must hold without guessing which wallet row is theirs.
    if (cut !== "begin") {
      await poll();
      expect(reply).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledTimes(cut === "reply" ? 0 : 1);
    }
  }
);

it("completes a successful handler once and suppresses duplicate model/payment after reopen", async () => {
  mockSend.mockImplementation(
    async (params: Parameters<DirectMessageClient["send"]>[0]) => {
      await params.onAttemptCreated?.(receipt.payloadDigest);
      return receipt;
    }
  );
  await open();
  await poll();
  await host.stop();
  await open();
  await poll();
  expect(reply).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledWith(
    expect.objectContaining({ conversationId: message().conversationId })
  );
});

it.each([
  { conversationId: undefined },
  { conversationId: "conv-1" },
  { messageId: undefined },
  { messageId: "message-1" },
  { senderAddress: { raw: new Wallet("0x" + "13".repeat(32)).address } },
  { recipientAddress: { raw: peer.address } },
  { senderPublicKey: new Uint8Array(33) },
  { recipientPublicKey: undefined },
  { outbound: true },
])(
  "does not run Qwen for unsupported authenticated context %s",
  async (change) => {
    await open();
    const historyRead = jest.spyOn(LevelBotStateStore.prototype, "get");
    const historyWrite = jest.spyOn(LevelBotStateStore.prototype, "put");
    mockFetch.mockImplementation(async () => [{ ...message(), ...change }]);
    await poll();
    expect(reply).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(
      historyRead.mock.calls.some(([key]) => key.startsWith("qwen-history:"))
    ).toBe(false);
    expect(
      historyWrite.mock.calls.some(([key]) => key.startsWith("qwen-history:"))
    ).toBe(false);
  }
);

it.each(["directory", "database"])(
  "holds a pre-existing empty state %s without creating an identity or owner marker",
  async (kind) => {
    const statePath = join(root, "bots", "qwen", "state");
    mkdirSync(statePath, { recursive: true });
    if (kind === "database") {
      const prior = await LevelBotStateStore.open(statePath);
      await prior.close();
    }

    await expect(open()).rejects.toThrow(/preserve|admission/i);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(existsSync(join(root, "bots", "qwen", "account-root.hex"))).toBe(
      false
    );
    expect(existsSync(join(root, "new-identity.json"))).toBe(false);
    expect(existsSync(statePath)).toBe(true);
    const retained = await LevelBotStateStore.open(statePath);
    try {
      expect(await retained.readEntries()).toEqual([]);
    } finally {
      await retained.close();
    }
  }
);

it("refuses a fresh state directory paired with an existing configured identity file", async () => {
  const bytes = '{"privateKeyHex":"preserved-owner-record"}';
  writeFileSync(join(root, "new-identity.json"), bytes, { mode: 0o600 });
  await expect(open()).rejects.toThrow(/preserve|admission/i);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockPublish).not.toHaveBeenCalled();
  expect(readFileSync(join(root, "new-identity.json"), "utf8")).toBe(bytes);
});

it("rejects a changed root on a valid format marker before wallet or registration effects", async () => {
  await open();
  await host.stop();
  const rootPath = join(root, "bots", "qwen", "account-root.hex");
  writeFileSync(rootPath, "15".repeat(32));
  mockCreate.mockClear();
  mockPublish.mockClear();
  await expect(open()).rejects.toThrow(/preserve|admission/i);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockPublish).not.toHaveBeenCalled();
  expect(readFileSync(rootPath, "utf8")).toBe("15".repeat(32));
});

it("isolates actual Qwen prompts and exact replies across same-peer threads and Level reopen", async () => {
  mockSend.mockImplementation(
    async (params: Parameters<DirectMessageClient["send"]>[0]) => {
      const payloadDigest = mockSend.mock.calls.length
        .toString(16)
        .padStart(64, "0");
      await params.onAttemptCreated?.(payloadDigest);
      return { ...receipt, payloadDigest };
    }
  );
  await open();
  const threadA = "11111111-1111-1111-1111-111111111111";
  const threadB = "22222222-2222-2222-2222-222222222222";
  const other = new Wallet("0x" + "13".repeat(32));
  const deliver = async (index: number, thread: string, sender = peer) => {
    const item = {
      ...message(),
      conversationId: thread,
      senderAddress: { raw: sender.address },
      senderPublicKey: getBytes(sender.signingKey.compressedPublicKey),
      payloadDigest: index.toString(16).padStart(64, "0"),
      messageId: index.toString(16).padStart(32, "0"),
      receivedTime: 1000 + index,
    };
    mockFetch.mockResolvedValue([item]);
    await poll(sender.address);
  };
  await deliver(101, threadA.replace(/-/g, ""));
  await deliver(102, threadB);
  await deliver(103, threadA);
  expect(reply.mock.calls.map(([prompt]) => prompt)).toEqual([
    [{ role: "user", content: "Hello" }],
    [{ role: "user", content: "Hello" }],
    [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Saved once" },
      { role: "user", content: "Hello" },
    ],
  ]);
  await host.stop();
  await open();
  await deliver(104, threadB);
  await deliver(105, threadA, other);
  await poll(other.address); // completed duplicate does not invoke or pay again
  expect(reply).toHaveBeenCalledTimes(5);
  expect(reply.mock.calls[3][0]).toHaveLength(3);
  expect(reply.mock.calls[4][0]).toEqual([{ role: "user", content: "Hello" }]);
  expect(mockSend.mock.calls.map(([params]) => params.conversationId)).toEqual([
    threadA,
    threadB,
    threadA,
    threadB,
    threadA,
  ]);
  expect(mockSend.mock.calls[4][0].recipient.raw.toLowerCase()).toBe(
    other.address.toLowerCase()
  );
});

it("refuses an authenticated self echo before Qwen history/model effects", async () => {
  await open();
  const read = jest.spyOn(LevelBotStateStore.prototype, "get");
  mockFetch.mockResolvedValue([
    {
      ...message(),
      senderAddress: local.address,
      senderPublicKey: local.compressedPubKey,
    },
  ]);
  await poll();
  expect(reply).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
  expect(read.mock.calls.some(([key]) => key.startsWith("qwen-history:"))).toBe(
    false
  );
});

it("keeps both Qwen entrypoints and aggregate target composed with the actual host/plugin", () => {
  for (const path of [
    "qwen-bot.livecheck.ts",
    "targets/qwen.ts",
    "targets/all-bots.ts",
  ]) {
    const source = readFileSync(join(__dirname, path), "utf8");
    expect(source).toContain("new FrankBotHost(");
    expect(source).toContain("host.register(new QwenBot())");
    expect(source).not.toMatch(/new Qwen(?:Inbound|Response)Workflow/);
  }
  const demo = readFileSync(join(__dirname, "demo/demo-config.ts"), "utf8");
  expect(demo).toContain("script: 'qwen-bot.livecheck.ts'");
});

it.each([
  { networkTag: "MON1" },
  { subject: peer.signingKey.compressedPublicKey.slice(2) },
  { address: peer.address },
])(
  "holds changed host owner presentation before invoking Qwen: %s",
  async (change) => {
    await open();
    const context = (
      host as unknown as { instances: Map<string, { context: object }> }
    ).instances.get("qwen")!.context;
    Object.assign(context, change);
    const reads = jest.spyOn(LevelBotStateStore.prototype, "get");
    await poll();
    await poll();
    expect(reply).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(
      reads.mock.calls.some(([key]) => key.startsWith("qwen-history:"))
    ).toBe(false);
  }
);

it("preserves malformed scoped history and holds the invocation across real Level reopen", async () => {
  await open();
  const store = (
    host as unknown as { instances: Map<string, { state: LevelBotStateStore }> }
  ).instances.get("qwen")!.state;
  const key =
    "qwen-history:v1:" +
    JSON.stringify([
      "monad-testnet",
      local.compressedPubKey.toString("hex"),
      peer.signingKey.compressedPublicKey.slice(2),
      message().conversationId,
    ]);
  await store.put(key, "malformed scoped history preserved");
  await poll();
  await host.stop();
  await open();
  await poll();
  expect(reply).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
  const reopened = (
    host as unknown as { instances: Map<string, { state: LevelBotStateStore }> }
  ).instances.get("qwen")!.state;
  expect(await reopened.get(key)).toBe("malformed scoped history preserved");
  expect(
    await reopened.get(`digest:${message().payloadDigest}`)
  ).toBeUndefined();
});

describe("durable retention before dispatch", () => {
  const other = new Wallet("0x" + "13".repeat(32));
  const threadA = "0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a";
  const threadB = "0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b";
  const rowKey = (digest: string) => "host-inbound:v1:dispatch:" + digest;
  // Mailbox times must lie after the host's first scan floor (now minus one day).
  const t0 = Date.now();
  let mailbox: DirectMessageReceived[];
  const inbound = (
    index: number,
    text: string,
    offset: number,
    sender = peer,
    conversationId = threadA
  ): DirectMessageReceived => ({
    senderAddress: { raw: sender.address },
    senderPublicKey: getBytes(sender.signingKey.compressedPublicKey),
    // The bot's identity exists only once the host is open; `listed` fills it in.
    recipientAddress: { raw: "" },
    conversationId,
    messageId: index.toString(16).padStart(32, "0"),
    payloadDigest: index.toString(16).padStart(64, "0"),
    receivedTime: t0 + offset,
    items: [{ type: "text", text }],
    stampValueWei: 1n,
    stampPayments: [],
  });
  /** What a relay lists from `sinceMs`: inclusive, ascending by time. */
  const listed = (sinceMs: number): DirectMessageReceived[] =>
    mailbox
      .filter((item) => item.receivedTime >= sinceMs)
      .sort((a, b) => a.receivedTime - b.receivedTime)
      .map((item) => ({
        ...item,
        recipientAddress: local.address,
        recipientPublicKey: local.compressedPubKey,
      }));
  const bot = () =>
    (
      host as unknown as {
        instances: Map<
          string,
          { state: LevelBotStateStore; operations: InboundOperationStore }
        >;
      }
    ).instances.get("qwen")!;
  const pollBoth = async () => {
    await poll();
    await poll(other.address);
  };
  const prompts = () =>
    reply.mock.calls.map(([prompt]) => prompt[prompt.length - 1].content);
  const scans = () => mockFetch.mock.calls.map(([params]) => params.sinceMs);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
  /** Loses the write that starts `digest` (nothing written), which faults the journal until reopen. */
  const cutStart = (digest: string) => {
    const original = LevelBotStateStore.prototype.durableBatch;
    let cut = false;
    return jest
      .spyOn(LevelBotStateStore.prototype, "durableBatch")
      .mockImplementation(async function (ops) {
        const op = ops.find((value) => value.key === rowKey(digest));
        if (
          !cut &&
          op?.type === "put" &&
          JSON.parse(op.value).phase === "started"
        ) {
          cut = true;
          throw new Error("start write lost");
        }
        return original.call(this, ops);
      });
  };
  /** Leaves A1 retained and never started, as a crash between the two writes does. */
  const reopenWithDeferredA1 = async () => {
    const a1 = inbound(1, "A1", 1000);
    mailbox = [a1];
    await open();
    const spy = cutStart(a1.payloadDigest);
    await pollBoth();
    spy.mockRestore();
    await host.stop();
    await open();
    return a1;
  };
  beforeEach(() => {
    mailbox = [];
    mockFetch.mockImplementation(async ({ sinceMs }: { sinceMs: number }) =>
      listed(sinceMs)
    );
    reply.mockImplementation(async (prompt: { content: string }[]) => ({
      content: "re:" + prompt[prompt.length - 1].content,
    }));
    mockSend.mockImplementation(
      async (params: Parameters<DirectMessageClient["send"]>[0]) => {
        const payloadDigest = (0xf000 + mockSend.mock.calls.length)
          .toString(16)
          .padStart(64, "0");
        await params.onAttemptCreated?.(payloadDigest);
        return { ...receipt, payloadDigest };
      }
    );
  });

  // T11. Reproduces: nothing was durable for A2 before its handler started, so once B moved the
  // cursor past it a lost start write lost the message for good.
  it("re-reads and handles once a retained message whose start write was lost after another conversation moved the cursor", async () => {
    const a1 = inbound(1, "A1", 1000);
    const a2 = inbound(2, "A2", 2000);
    const b = inbound(3, "B", 3000, other, threadB);
    mailbox = [a1, a2, b];
    let releaseA1!: () => void;
    const gate = new Promise<void>((resolve) => (releaseA1 = resolve));
    reply.mockImplementation(async (prompt: { content: string }[]) => {
      const content = prompt[prompt.length - 1].content;
      if (content === "A1") await gate;
      return { content: "re:" + content };
    });
    await open();
    await poll(other.address);
    expect(await bot().state.get("cursor:lastPollTimestamp")).toBe(
      String(b.receivedTime + 1)
    );
    const spy = cutStart(a2.payloadDigest);
    releaseA1();
    await poll();
    spy.mockRestore();
    expect(prompts()).toEqual(["A1", "B"]);
    await host.stop();
    await open();
    expect(bot().operations.get(a2.payloadDigest)?.phase).toBe("deferred");
    mockFetch.mockClear();
    await pollBoth();
    await pollBoth();
    expect(scans()[0]).toBe(a2.receivedTime);
    expect(prompts()).toEqual(["A1", "B", "A2"]);
    expect(reply.mock.calls[2][0]).toEqual([
      { role: "user", content: "A1" },
      { role: "assistant", content: "re:A1" },
      { role: "user", content: "A2" },
    ]);
    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(await bot().state.get("digest:" + a2.payloadDigest)).toBe(
      "completed"
    );
  });

  // T15 (Revision 4). Reproduces: a message the host knew about and could not re-read was simply
  // forgotten once the cursor passed it, and later prompts of its conversation ran without it.
  it("never starts, completes or drops a retained message that fetches stop returning, while other conversations progress", async () => {
    const a1 = await reopenWithDeferredA1();
    const a2 = inbound(2, "A2", 2000);
    const b = inbound(3, "B", 3000, other, threadB);
    const retained = await bot().state.get(rowKey(a1.payloadDigest));
    mailbox = [a2, b];
    mockFetch.mockClear();
    for (let pass = 0; pass < 4; pass++) await pollBoth();
    await host.stop();
    await open();
    for (let pass = 0; pass < 2; pass++) await pollBoth();
    expect(prompts()).toEqual(["B"]);
    expect(await bot().state.get("cursor:lastPollTimestamp")).toBe(
      String(b.receivedTime + 1)
    );
    expect(scans()).toHaveLength(12);
    // Before B completes there is no cursor yet; afterwards A1 alone holds the floor down.
    expect(Math.max(...scans())).toBe(a1.receivedTime);
    expect(scans().slice(-6)).toEqual(Array(6).fill(a1.receivedTime));
    expect(await bot().state.get(rowKey(a1.payloadDigest))).toBe(retained);
    expect(bot().operations.get(a2.payloadDigest)?.phase).toBe("deferred");
    for (const item of [a1, a2])
      expect(
        await bot().state.get("digest:" + item.payloadDigest)
      ).toBeUndefined();

    // Same digest under another conversation is not the retained message: held, row untouched.
    mailbox = [{ ...a1, conversationId: threadB }, a2, b];
    await pollBoth();
    expect(prompts()).toEqual(["B"]);
    expect(await bot().state.get(rowKey(a1.payloadDigest))).toBe(retained);

    // Relay time is not identity: the same message at another time starts, in retained order.
    mailbox = [{ ...a1, receivedTime: a1.receivedTime + 500 }, a2, b];
    await pollBoth();
    await pollBoth();
    expect(prompts()).toEqual(["B", "A1", "A2"]);
    expect(bot().operations.get(a1.payloadDigest)).toMatchObject({
      phase: "completed",
      receivedTime: a1.receivedTime,
    });
  });

  // Revision 4. Reproduces: a retained message that is gone waits forever, and did so silently.
  it("warns once per interval about a deferred message no fetch returns, and changes nothing else", async () => {
    const a1 = await reopenWithDeferredA1();
    const retained = await bot().state.get(rowKey(a1.payloadDigest));
    mailbox = [];
    const clock = jest.spyOn(Date, "now");
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const warnings = () =>
      warn.mock.calls.filter(([text]) =>
        String(text).includes(a1.payloadDigest)
      );
    const writes = jest.spyOn(LevelBotStateStore.prototype, "durableBatch");
    const at = async (elapsed: number) => {
      clock.mockReturnValue(t0 + 5000 + elapsed);
      await pollBoth();
    };
    await at(0);
    await at(59_999);
    expect(warnings()).toHaveLength(0);
    await at(60_000);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0][0]).toContain("for 60s");
    await at(60_001);
    await at(119_999);
    expect(warnings()).toHaveLength(1);
    await at(120_000);
    expect(warnings()).toHaveLength(2);
    expect(warnings()[1][0]).toContain("for 120s");
    expect(writes).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(await bot().state.get(rowKey(a1.payloadDigest))).toBe(retained);
    expect(bot().operations.scanFloor(Number.MAX_SAFE_INTEGER - 1)).toBe(
      a1.receivedTime
    );
    // Once a fetch returns it again it is handled as if nothing had happened.
    mailbox = [a1];
    await at(120_001);
    expect(prompts()).toEqual(["A1"]);
    await at(240_000);
    expect(warnings()).toHaveLength(2);
  });

  // T16. Reproduces: one held started row pinned the scan floor forever, so with a fetch that
  // only ever reads eight records from the floor, anything past them was never seen.
  it("reads past a held started row to a message beyond the fetch window", async () => {
    const held = inbound(1, "H", 100);
    const fillers = Array.from({ length: 8 }, (_, index) =>
      inbound(2 + index, "F" + index, 200 + index * 100)
    );
    const target = inbound(20, "T", 10_000);
    mailbox = [held, ...fillers, target];
    mockFetch.mockImplementation(async ({ sinceMs }: { sinceMs: number }) =>
      listed(sinceMs).slice(0, 8)
    );
    const sent = mockSend.getMockImplementation()!;
    // The held row is today's live shape: a reply slot the wallet never linked.
    mockSend.mockImplementation(
      async (params: Parameters<DirectMessageClient["send"]>[0]) => {
        if (JSON.stringify(params.items).includes("re:H"))
          throw new Error("refused");
        return sent(params);
      }
    );
    await open();
    for (let pass = 0; pass < 4; pass++) await poll();
    expect(bot().operations.get(held.payloadDigest)).toMatchObject({
      phase: "started",
      replies: [{ stampValue: "1" }],
    });
    expect(bot().operations.get(held.payloadDigest)?.replies[0].digest).toBe(
      undefined
    );
    expect(prompts()).toEqual(["H", ...fillers.map((_, i) => "F" + i), "T"]);
    await host.stop();
    await open();
    await poll();
    expect(reply).toHaveBeenCalledTimes(10);
    expect(scans()[scans().length - 1]).toBe(target.receivedTime + 1);
  });

  // Section 10. Reproduces: at the row cap every new message threw, so nothing retained earlier
  // was told apart from what could not be retained at all.
  it("stops retaining at the row cap in order, and still handles what it retained earlier", async () => {
    const fresh = inbound(0x9001, "N1", 1000, other, threadB);
    const unretained = inbound(0x9002, "N2", 1500, other, threadB);
    const earlier = inbound(0x9003, "D", 2000);
    await open();
    await host.stop();
    const row = (item: DirectMessageReceived, phase: string) => ({
      type: "put" as const,
      key: rowKey(item.payloadDigest),
      value: JSON.stringify({
        version: 1,
        digest: item.payloadDigest,
        peerSubject: peer.signingKey.compressedPublicKey.slice(2),
        peerAddress: peer.address.toLowerCase(),
        conversationId: item.conversationId,
        messageId: item.messageId!.replace(
          /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
          "$1-$2-$3-$4-$5"
        ),
        receivedTime: item.receivedTime,
        phase,
        replies: [],
      }),
    });
    const seeded = await LevelBotStateStore.open(
      join(root, "bots", "qwen", "state")
    );
    await seeded.batch([
      ...Array.from({ length: 1022 }, (_, index) =>
        row(inbound(index + 1, "held", 1), "started")
      ),
      row(earlier, "deferred"),
    ]);
    await seeded.close();
    mailbox = [fresh, unretained, earlier];
    await open();
    for (let pass = 0; pass < 2; pass++) await pollBoth();
    expect(prompts()).toEqual(["N1", "D"]);
    expect(bot().operations.get(unretained.payloadDigest)).toBeUndefined();
    expect(
      await bot().state.readEntries("host-inbound:v1:dispatch:")
    ).toHaveLength(1024);
    // The stated behaviour change: the cursor passes the message that was never retained.
    expect(await bot().state.get("cursor:lastPollTimestamp")).toBe(
      String(earlier.receivedTime + 1)
    );
    await host.stop();
    await open();
    await pollBoth();
    expect(reply).toHaveBeenCalledTimes(2);
  });

  // T6. Reproduces: the poll was detached, so stop() closed the stores under a running fetch and
  // whatever that fetch returned was processed against a closed journal.
  it.each(["fetch", "send"] as const)(
    "drains a blocked %s before stop() resolves and persists its outcome",
    async (blocked) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const a1 = inbound(1, "A1", 1000);
      mailbox = [a1];
      if (blocked === "fetch")
        mockFetch.mockImplementation(
          async ({ sinceMs }: { sinceMs: number }) => {
            await gate;
            return listed(sinceMs);
          }
        );
      else
        mockSend.mockImplementation(
          async (params: Parameters<DirectMessageClient["send"]>[0]) => {
            await params.onAttemptCreated?.("ee".repeat(32));
            await gate;
            return { ...receipt, payloadDigest: "ee".repeat(32) };
          }
        );
      await open();
      const entered = blocked === "fetch" ? mockFetch : mockSend;
      const polling = (
        host as unknown as { pollAllBots(): Promise<void> }
      ).pollAllBots();
      for (let wait = 0; wait < 20 && !entered.mock.calls.length; wait++)
        await settle();
      let stopped = false;
      const stopping = host.stop().then(() => (stopped = true));
      await settle();
      expect(stopped).toBe(false);
      release();
      await stopping;
      await polling;
      const writes = jest.spyOn(LevelBotStateStore.prototype, "durableBatch");
      await settle();
      expect(writes).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockReconcile).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledTimes(blocked === "fetch" ? 0 : 1);
      await open();
      expect(bot().operations.get(a1.payloadDigest)?.phase).toBe(
        blocked === "fetch" ? "deferred" : "completed"
      );
      await poll();
      await poll();
      expect(reply).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledTimes(1);
    }
  );

  // T6. Reproduces: every timer tick re-entered the poll, so one slow pass was reconciled and
  // fetched again by each overlapping tick.
  it("joins an overlapping poll instead of running a second pass", async () => {
    mockSend.mockImplementation(
      async (params: Parameters<DirectMessageClient["send"]>[0]) => {
        await params.onAttemptCreated?.(receipt.payloadDigest);
        throw new Error("canonical attempt pending");
      }
    );
    mailbox = [inbound(1, "A1", 1000)];
    await open();
    await poll();
    let release!: (value: Record<string, "live">) => void;
    mockReconcile.mockImplementation(
      () => new Promise((resolve) => (release = resolve))
    );
    mockFetch.mockClear();
    const pollAllBots = () =>
      (host as unknown as { pollAllBots(): Promise<void> }).pollAllBots();
    const passes = [pollAllBots(), pollAllBots()];
    await settle();
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    release({ [receipt.payloadDigest]: "live" });
    await Promise.all(passes);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    mockReconcile.mockResolvedValue({});
    await pollAllBots();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
