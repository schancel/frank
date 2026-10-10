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
import { randomBytes } from "crypto";
import { Wallet, computeAddress, getBytes } from "ethers";
import { toHex } from "@frank/codec";
import { deriveDomainRoot } from "@frank/domain-roots";
import {
  restoreCanonicalRequest,
  type CanonicalFetch,
} from "@frank/cashweb/relay/canonical-dm-transport";
import { openNodeDirectoryStore } from "@frank/directory-admission/node";
import { InMemoryNativeTransactionAttemptStore } from "@frank/wallet/chain/chain-wallet";
import { MonadStampPendingAttemptError } from "@frank/wallet/monad-stamp-client";
import type { EvmChainWalletHandle } from "@frank/wallet/evm-wallet-handle";
import type { MonadRootBundle } from "@frank/wallet/monad-wallet-material";
import { FrankBotHost } from "../bot-framework/src/bot-host";
import { LevelBotStateStore } from "../bot-framework/src/state-store";
import { PassThrough } from "stream";
import { MODEL_FAILED_TEXT, QwenBot } from "./src/bots/qwen-bot";
import { FAILED_REPLY_TEXT } from "../bot-framework/src/bot-host";
import {
  replyMessageId,
  type InboundOperationStore,
} from "../bot-framework/src/inbound-operation-store";
import type { BotContext } from "../bot-framework/src/types";
import {
  directMessageNotAttempted,
  isDirectMessageNotAttempted,
  type DirectMessageReceived,
  type DirectMessageSendResult,
  type DirectMessageClient,
} from "@frank/wallet/chain/active-chain";

// The model endpoint. Every other user of axios in the loaded modules gets the real one.
const mockModel = jest.fn();
jest.mock("axios", () => {
  const actual = jest.requireActual("axios");
  const wrapped = Object.assign(
    (...args: unknown[]) =>
      String((args[0] as { url?: string })?.url).startsWith(
        "http://model.invalid"
      )
        ? mockModel(...args)
        : actual(...args),
    actual
  );
  wrapped.default = wrapped;
  return wrapped;
});
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

// Offline chain for the one test that runs the real canonical wallet: the RPC reports only
// these balances, and a submitted transfer is mined at once. No other test reaches either.
const mockBalances = new Map<string, bigint>();
jest.mock("@frank/wallet/monad-provider", () => {
  const actual = jest.requireActual("@frank/wallet/monad-provider");
  const ethers = jest.requireActual("ethers");
  return {
    ...actual,
    createMonadJsonRpcProvider: () => {
      const provider = new ethers.JsonRpcProvider(
        "http://127.0.0.1:1",
        10143n,
        { staticNetwork: true, cacheTimeout: -1 }
      );
      provider._perform = async (request: {
        method: string;
        address?: string;
      }) => {
        if (request.method === "getBalance")
          return mockBalances.get(request.address!.toLowerCase()) ?? 0n;
        if (request.method === "getTransactionCount") return 0;
        if (request.method === "estimateGas") return 50_000n;
        // Zero: this offline chain charges nothing per gas, so the 1-wei reply stamp these tests
        // use is not below the fee floor (the floor has its own tests in the wallet).
        if (request.method === "getGasPrice") return 0n;
        if (request.method === "getPriorityFee") return 1n;
        if (request.method === "getBlock")
          return {
            hash: "0x" + "11".repeat(32),
            parentHash: "0x" + "22".repeat(32),
            number: "0x1",
            timestamp: "0x64",
            nonce: "0x0000000000000000",
            difficulty: "0x0",
            gasLimit: "0x1c9c380",
            gasUsed: "0x0",
            miner: "0x" + "00".repeat(20),
            extraData: "0x",
            baseFeePerGas: "0x1",
            transactions: [],
          };
        throw new Error(`unexpected provider call ${request.method}`);
      };
      return provider;
    },
  };
});
jest.mock("@frank/wallet/monad-http", () => {
  const ethers = jest.requireActual("ethers");
  const mined = new Set<string>();
  return {
    ...jest.requireActual("@frank/wallet/monad-http"),
    MonadHttpClient: class {
      async submitRawTransaction(raw: string) {
        const tx = ethers.Transaction.from(raw);
        const to = tx.to.toLowerCase();
        mockBalances.set(to, (mockBalances.get(to) ?? 0n) + tx.value);
        mined.add(tx.hash);
        return tx.hash;
      }
      async getTransactionReceipt(hash: string) {
        return mined.has(hash) ? { status: "success" } : undefined;
      }
      destroy() {
        return undefined;
      }
    },
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
type Send = Parameters<DirectMessageClient["send"]>[0];
/** What the wallet does to the rejection of a send it refused before creating anything: an own,
 * non-enumerable accessor that answers only for that object. Only a wallet stand-in may do it. */
const notAttempted = <E extends Error>(error: E): E =>
  Object.defineProperty(error, directMessageNotAttempted, {
    get(this: unknown) {
      return this === error;
    },
  });
const qwen = () =>
  (
    host as unknown as {
      instances: Map<
        string,
        {
          state: LevelBotStateStore;
          operations: InboundOperationStore;
          tasks: Set<Promise<unknown>>;
          context: BotContext;
          wallet: EvmChainWalletHandle;
        }
      >;
    }
  ).instances.get("qwen")!;
/** Waits for every tracked task, including retry passes that are not on a peer lane. */
const drain = async () => {
  for (let tasks = [...qwen().tasks]; tasks.length; tasks = [...qwen().tasks])
    await Promise.allSettled(tasks);
};
const historyKey = (conversationId = message().conversationId, sender = peer) =>
  "qwen-history:v1:" +
  JSON.stringify([
    "monad-testnet",
    local.compressedPubKey.toString("hex"),
    sender.signingKey.compressedPublicKey.slice(2),
    conversationId,
  ]);
/** The committed turns of a conversation, or undefined when no history row exists. */
const turns = async (
  conversationId?: string,
  sender?: Wallet
): Promise<string[] | undefined> => {
  const raw = await qwen().state.get(historyKey(conversationId, sender));
  return raw === undefined
    ? undefined
    : (JSON.parse(raw) as { messages: { content: string }[] }).messages.map(
        (turn) => turn.content
      );
};
const stagedText = (digest: string) =>
  qwen().state.get(`host-prepared:v1:${digest}:text`);
async function open(
  bot: QwenBot = new QwenBot({
    generator: { mode: "stub", describe: () => "fixture", reply },
    retryDelayMs: 1,
  })
) {
  host = new FrankBotHost({
    stateDir: root,
    relayBaseUrl: "http://localhost.invalid",
    watchRegistrations: false,
  });
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
    expect(source).toMatch(/new QwenBot\(\)/);
    expect(source).toMatch(/host\.register(All)?\(/);
  }
  const demo = readFileSync(join(__dirname, "demo/demo-config.ts"), "utf8");
  // The launcher starts one bot process, and it is the aggregate target checked above.
  expect(demo).toContain("script: 'targets/all-bots.ts'");
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
    // One poll, then the process ends: a second poll would mend the journal and handle A1.
    await poll();
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
    expect(bot().operations.get(a1.payloadDigest)).toBeUndefined();
    expect(await bot().state.get("digest:" + a1.payloadDigest)).toBe(
      "completed"
    );
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
      // One pass: its one question to the wallet, about no reply in particular (#1236 Q3).
      expect(mockReconcile.mock.calls).toEqual([
        [{ wallet: expect.anything(), payloadDigests: [] }],
      ]);
      expect(reply).toHaveBeenCalledTimes(blocked === "fetch" ? 0 : 1);
      await open();
      // Finished work leaves no row.
      expect(bot().operations.get(a1.payloadDigest)?.phase).toBe(
        blocked === "fetch" ? "deferred" : undefined
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
    // The first poll asked the wallet once already, about no reply in particular (#1236 Q3).
    mockReconcile.mockClear();
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

// What the owner asked for: a message to Qwen always ends in the model's answer or a short
// plain failure reply, delivered. On 05c93db0 each of these left the message held for good, with
// nothing sent: a model error, a failed send, a restart, a wallet with no funds.
describe("Qwen answers every message", () => {
  /** A wallet stand-in that keeps the wallet's rule: one payment intent per message identity,
   * across host restarts. `relay` says what becomes of a send. */
  type Intent = { digest: string; text: string; delivered: boolean };
  let intents: Map<string, Intent>;
  let relay: (text: string) => "deliver" | "pending" | Error;
  const pollAllBots = () =>
    (host as unknown as { pollAllBots(): Promise<void> }).pollAllBots();
  const pass = async (count = 1) => {
    for (let i = 0; i < count; i++) {
      await pollAllBots();
      await drain();
    }
  };
  const texts = () =>
    mockSend.mock.calls.map(
      ([params]) => (params.items[0] as { text: string }).text
    );
  const delivered = () =>
    [...intents.values()].filter((i) => i.delivered).map((i) => i.text);
  const prompt = (
    index: number,
    text: string,
    change: Partial<DirectMessageReceived> = {}
  ): DirectMessageReceived => ({
    ...message(),
    messageId: index.toString(16).padStart(32, "0"),
    payloadDigest: index.toString(16).padStart(64, "0"),
    receivedTime: 1000 + index,
    items: [{ type: "text", text }],
    ...change,
  });
  beforeEach(() => {
    intents = new Map();
    relay = () => "deliver";
    mockSend.mockImplementation(async (params: Send) => {
      const text = (params.items[0] as { text: string }).text;
      const id = String(params.messageId ?? `none-${mockSend.mock.calls.length}`);
      const original = intents.get(id);
      if (original) {
        const { DirectMessageAlreadyAttemptedError } = jest.requireActual<
          typeof import("@frank/wallet/chain/active-chain")
        >("@frank/wallet/chain/active-chain");
        throw new DirectMessageAlreadyAttemptedError(
          id,
          original.digest,
          "02" + "aa".repeat(32)
        );
      }
      const outcome = relay(text);
      // Refused before the wallet journalled anything: no intent exists.
      if (outcome instanceof Error) throw outcome;
      const intent = {
        digest: (intents.size + 0xd0).toString(16).repeat(32),
        text,
        delivered: outcome === "deliver",
      };
      intents.set(id, intent);
      await params.onAttemptCreated?.(intent.digest);
      if (!intent.delivered) throw new Error("canonical attempt pending");
      return { ...receipt, payloadDigest: intent.digest };
    });
    mockReconcile.mockImplementation(
      async ({ payloadDigests }: { payloadDigests: string[] }) => {
        for (const intent of intents.values())
          if (!intent.delivered && relay(intent.text) === "deliver")
            intent.delivered = true;
        return Object.fromEntries(
          payloadDigests.map((digest) => {
            const intent = [...intents.values()].find(
              (i) => i.digest === digest
            );
            return [
              digest,
              intent ? (intent.delivered ? "delivered" : "live") : "unknown",
            ];
          })
        );
      }
    );
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  it("when the model fails once and then answers: one answer is delivered", async () => {
    reply
      .mockRejectedValueOnce(new Error("Request failed with status code 500"))
      .mockResolvedValue({ content: "the answer" });
    await open();
    await pass(3);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(texts()).toEqual(["the answer"]);
    expect(delivered()).toEqual(["the answer"]);
    expect(await turns()).toEqual(["Hello", "the answer"]);
    expect(qwen().operations.listStarted()).toEqual([]);
  });

  it("when the model fails every time: one failure reply is delivered, nothing is left held, and the next message is answered", async () => {
    reply.mockRejectedValue(new Error("Request failed with status code 503"));
    await open();
    await pass(3);
    // Three bounded tries, then the user is told.
    expect(reply).toHaveBeenCalledTimes(3);
    expect(delivered()).toEqual([MODEL_FAILED_TEXT]);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(qwen().operations.listStarted()).toEqual([]);
    expect(qwen().operations.listDeferred()).toEqual([]);
    expect(await qwen().state.get(`digest:${message().payloadDigest}`)).toBe(
      "completed"
    );
    // Nothing is remembered of a turn that was never answered.
    expect(await turns()).toBeUndefined();

    reply.mockReset().mockResolvedValue({ content: "better now" });
    mockFetch.mockImplementation(async () => [prompt(7, "Hello again")]);
    await pass(2);
    expect(delivered()).toEqual([MODEL_FAILED_TEXT, "better now"]);
    expect(await turns()).toEqual(["Hello again", "better now"]);
  });

  it("when the model hangs: each call is ended at the time limit and the failure reply is delivered", async () => {
    Object.assign(process.env, {
      QWEN_API_KEY: "dummy-key",
      QWEN_OPENAI_COMPATIBLE_ENDPOINT: "http://model.invalid/v1",
      QWEN_MODEL_TIMEOUT_MS: "60",
      QWEN_MODEL_TRIES: "2",
    });
    const signals: AbortSignal[] = [];
    const streams: PassThrough[] = [];
    mockModel
      // Never answers at all.
      .mockImplementationOnce((request: { signal: AbortSignal }) => {
        signals.push(request.signal);
        return new Promise(() => undefined);
      })
      // Starts an answer and stalls mid-stream.
      .mockImplementationOnce(async (request: { signal: AbortSignal }) => {
        signals.push(request.signal);
        const stream = new PassThrough();
        streams.push(stream);
        stream.write('data: {"choices":[{"delta":{"content":"The ans"}}]}\n');
        return { data: stream };
      });
    jest.spyOn(console, "log").mockImplementation(() => {});
    const started = Date.now();
    await open(new QwenBot({ retryDelayMs: 1 }));
    await pass(2);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(mockModel).toHaveBeenCalledTimes(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(streams[0].destroyed).toBe(true);
    expect(delivered()).toEqual([MODEL_FAILED_TEXT]);
    expect(qwen().operations.listStarted()).toEqual([]);
    // Thinking is off unless asked for, and the model is told where it is.
    const request = mockModel.mock.calls[0][0].data;
    expect(request.enable_thinking).toBe(false);
    expect(request.messages[0].role).toBe("system");
    expect(request.messages[0].content).toMatch(
      /Qwen, the resident chatbot inside Frank/
    );
    expect(request.messages[0].content).toMatch(/never a human/);
    expect(request.messages[0].content).toMatch(/cannot move money/);
    expect(request.messages.slice(1)).toEqual([
      { role: "user", content: "Hello" },
    ]);
  });

  it("when the send fails and then works on a later poll: the same reply is delivered once, for one payment", async () => {
    let attempts = 0;
    relay = () =>
      ++attempts === 1
        ? new Error("relay timed out")
        : attempts < 4
        ? "pending"
        : "deliver";
    await open();
    await pass();
    // Refused before any payment existed: nothing to reconcile, the reply waits.
    expect(intents.size).toBe(0);
    expect(await stagedText(message().payloadDigest)).toBe("Saved once");
    await pass(6);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(delivered()).toEqual(["Saved once"]);
    // One payment intent for the reply, however many polls it took.
    expect(intents.size).toBe(1);
    expect(new Set(mockSend.mock.calls.map(([p]) => p.messageId))).toEqual(
      new Set([
        replyMessageId(qwen().operations.owner, message().payloadDigest),
      ])
    );
    // Once the wallet holds the attempt the host only asks about it; it does not send again.
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(qwen().operations.listStarted()).toEqual([]);
    expect(await stagedText(message().payloadDigest)).toBeUndefined();
  });

  it("after a restart between generating the answer and sending it: that answer is delivered once, without asking the model again", async () => {
    relay = () => new Error("the process is going down");
    await open();
    await pass();
    expect(await stagedText(message().payloadDigest)).toBe("Saved once");
    await host.stop();

    // Second lifetime: the wallet takes the payment, and the process dies before the host
    // records it. Third lifetime: the wallet answers with that payment; no second one is made.
    relay = () => "pending";
    await open();
    mockFetch.mockImplementation(async () => []);
    const link = jest
      .spyOn(qwen().operations, "linkReply")
      .mockRejectedValue(new Error("killed"));
    await pass();
    link.mockRestore();
    await host.stop();
    expect(intents.size).toBe(1);

    relay = () => "deliver";
    await open();
    await pass(3);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(intents.size).toBe(1);
    expect(delivered()).toEqual(["Saved once"]);
    expect(qwen().operations.listStarted()).toEqual([]);
    expect(await turns()).toEqual(["Hello", "Saved once"]);
  });

  it("when one user's reply is stuck: other users are still answered", async () => {
    const other = new Wallet("0x" + "13".repeat(32));
    const from = (index: number, text: string) =>
      prompt(index, text, {
        senderAddress: { raw: other.address },
        senderPublicKey: getBytes(other.signingKey.compressedPublicKey),
      });
    reply.mockImplementation(async (history: { content: string }[]) => ({
      content: "re:" + history[history.length - 1].content,
    }));
    relay = (text) =>
      text === "re:stuck" ? new Error("no directory entry") : "deliver";
    await open();
    mockFetch.mockImplementation(async () => [
      prompt(1, "stuck"),
      from(2, "one"),
    ]);
    await pass(2);
    mockFetch.mockImplementation(async () => [
      prompt(1, "stuck"),
      from(2, "one"),
      from(3, "two"),
    ]);
    await pass(3);
    expect(delivered()).toEqual(["re:one", "re:two"]);
    expect(
      qwen()
        .operations.listStarted()
        .map((row) => row.digest)
    ).toEqual([prompt(1, "stuck").payloadDigest]);
  });

  it("remembers the conversation between messages that carry no conversation ID, and keeps an explicit conversation apart", async () => {
    reply.mockImplementation(async (history: { content: string }[]) => ({
      content: "re:" + history[history.length - 1].content,
    }));
    const bare = (index: number, text: string) => {
      const { conversationId: _none, ...rest } = prompt(index, text);
      return rest as DirectMessageReceived;
    };
    await open();
    mockFetch.mockImplementation(async () => [bare(1, "my name is Ada")]);
    await pass(2);
    mockFetch.mockImplementation(async () => [
      bare(2, "what is my name?"),
      prompt(3, "a separate thread"),
    ]);
    await pass(2);
    await host.stop();
    await open();
    mockFetch.mockImplementation(async () => [bare(4, "and again?")]);
    await pass(2);

    const history = (text: string) =>
      reply.mock.calls
        .map(([sent]) => sent as { content: string }[])
        .find((sent) => sent[sent.length - 1].content === text)!
        .map((turn) => turn.content);
    expect(history("what is my name?")).toEqual([
      "my name is Ada",
      "re:my name is Ada",
      "what is my name?",
    ]);
    expect(history("a separate thread")).toEqual(["a separate thread"]);
    // Also after a restart: the history is stored, not held in memory.
    expect(history("and again?")).toHaveLength(5);
    // A reply in the default thread carries no conversation ID either.
    expect(
      mockSend.mock.calls.map(([params]) => params.conversationId)
    ).toEqual([
      undefined,
      undefined,
      message().conversationId,
      undefined,
    ]);
    const defaultKey =
      "qwen-history:v1:" +
      JSON.stringify([
        "monad-testnet",
        local.compressedPubKey.toString("hex"),
        peer.signingKey.compressedPublicKey.slice(2),
        "default",
      ]);
    expect(
      JSON.parse((await qwen().state.get(defaultKey))!).messages
    ).toHaveLength(6);
  });

  // The owner's rule: no reply cap. On 05c93db0 the 21st message within an hour was dropped.
  it("has no reply limit for a person: forty messages in a row are all answered", async () => {
    await open();
    for (let index = 1; index <= 40; index++) {
      mockFetch.mockImplementation(async () => [prompt(index, "m" + index)]);
      await pass();
    }
    expect(reply).toHaveBeenCalledTimes(40);
    expect(delivered()).toHaveLength(40);
    expect(texts().some((text) => /^Slow down/.test(text))).toBe(false);
  });

  it("tells the model the person's display name when their profile has one", async () => {
    await open();
    qwen().context.lookupPeer = jest.fn(async () => ({
      address: peer.address,
      subject: "",
      pubKey: new Uint8Array(),
      displayName: "  Ada\nLovelace ",
    }));
    await pass();
    expect(reply.mock.calls[0][1]).toMatchObject({ userName: "Ada Lovelace" });
    // Not remembered: the stored turn is what the person wrote.
    expect(await turns()).toEqual(["Hello", "Saved once"]);
  });

  it("stops at once when the model call is still running: the call is aborted and the user gets the failure reply after the restart", async () => {
    // The poll pass ends before the handler it started reaches the model: the journal writes
    // and history reads in between take as long as the disk takes. Wait for the call itself.
    let called!: () => void;
    const modelCalled = new Promise<void>((resolve) => (called = resolve));
    reply.mockImplementation(
      (_history: unknown, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          called();
          options.signal.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        })
    );
    await open();
    await pollAllBots();
    await modelCalled;
    expect(reply).toHaveBeenCalledTimes(1);
    const started = Date.now();
    await host.stop();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(mockSend).not.toHaveBeenCalled();

    await open();
    mockFetch.mockImplementation(async () => []);
    await pass(2);
    // The interrupted handler is not run again: the model is not asked a second time.
    expect(reply).toHaveBeenCalledTimes(1);
    expect(delivered()).toEqual([MODEL_FAILED_TEXT]);
  });

  it("when the stored history cannot be read: the user gets a failure reply and the stored bytes are untouched", async () => {
    await open();
    const key = historyKey();
    await qwen().state.put(key, "not json");
    await pass(2);
    expect(reply).not.toHaveBeenCalled();
    expect(delivered()).toEqual([FAILED_REPLY_TEXT]);
    expect(await qwen().state.get(key)).toBe("not json");
    expect(qwen().operations.listStarted()).toEqual([]);
  });
});

// The host against the wallet it runs on. Real typed custody, real wallet journals, real
// directory admission and sealing; the chain RPC and the relay's HTTP answer are offline
// stand-ins, as in the wallet's own canonical suite. Payments are counted where they exist:
// payment sets handed to the relay, and intents in the wallet's journal.
describe("with the real canonical wallet", () => {
  jest.setTimeout(60_000);
  const RELAY = "https://relay-a.example";
  const NOW = { seconds: 100n, nanoseconds: 0 };
  const actual = jest.requireActual<
    typeof import("@frank/wallet/chain/monad-chain")
  >("@frank/wallet/chain/monad-chain");
  const roots = (): MonadRootBundle => {
    const account = randomBytes(32);
    return {
      evm: deriveDomainRoot(account, "evm-wallet"),
      authentication: deriveDomainRoot(account, "identity-authentication"),
      messaging: deriveDomainRoot(account, "messaging-encryption"),
    };
  };
  const closers: (() => Promise<unknown>)[] = [];
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    await host?.stop();
    for (const close of closers.splice(0)) await close().catch(() => undefined);
    mockBalances.clear();
  });
  /** Stand-in for confirmed funding: single-use accounts the offline RPC reports as funded. */
  const fund = async (wallet: EvmChainWalletHandle) => {
    for (const record of wallet.pool.ensureSize(4))
      mockBalances.set(record.address.toLowerCase(), 187_500n + 600n);
    await wallet.pool.flush();
  };
  const setUp = async (funded: boolean) => {
    const chain = actual.createEvmChain({
      networkId: "monad-testnet",
      rpcChain: "monad-testnet",
      chainId: 10143,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
      relayBaseUrl: RELAY,
      networkTag: "MONT",
      stampBurnAddress: "0x000000000000000000000000000000000000dEaD",
      defaultStampValueWei: 1_000n,
      defaultTopicVoteValueWei: 1_000n,
      subAccountPoolSize: 0,
      walletStorageLocation: join(root, "real-wallet"),
    });
    const created: EvmChainWalletHandle[] = [];
    mockCreate.mockImplementation(async (bundle: MonadRootBundle) => {
      const wallet = (await chain.createWallet(bundle)) as EvmChainWalletHandle;
      created.push(wallet);
      local = wallet.identity;
      return wallet;
    });
    await open();
    const botWallet = qwen().wallet;
    const user = (await chain.createWallet(roots())) as EvmChainWalletHandle;
    closers.push(() => user.close());
    if (funded) await fund(botWallet);

    // The bot's own verified directory: both subjects admitted through a real public store.
    const tuple = {
      relayId: new Uint8Array(16).fill(1),
      endpoint: RELAY + "/",
      identity: {
        keyType: 1,
        keyBytes: new Uint8Array(botWallet.identity.compressedPubKey),
      },
      expiry: { seconds: 3700n, nanoseconds: 0 },
      unknownFields: new Map(),
    };
    const admit = async (wallet: EvmChainWalletHandle) => {
      const exported = actual.prepareMonadRevisionZeroExport(wallet, {
        networkTag: "MONT",
        network: "monad-testnet",
        chainId: 10143n,
        issuedAt: NOW,
        expiresAt: { seconds: 3700n, nanoseconds: 0 },
        now: NOW,
        relay: tuple,
      });
      const store = await openNodeDirectoryStore({
        location: join(root, `directory-${toHex(exported.t1)}`),
        anchor: {
          network: "monad-testnet",
          subject: { keyType: 1, keyBytes: exported.auth.compressedPoint },
          revisionZero: exported.t1,
        },
        mode: { kind: "new" },
      });
      closers.push(() => store.close());
      await store.enroll(
        [{ statement: exported.statement, attestation: exported.attestation }],
        { now: NOW, relay: tuple }
      );
      return {
        subject: toHex(exported.auth.compressedPoint),
        current: () => store.current({ now: NOW, relay: tuple }),
      };
    };
    // What the relay does with a payment set it is handed: unreachable, accepted and not yet
    // delivered ("retained"), or delivered.
    const relayState: { phase: "down" | "retained" | "delivered" } = {
      phase: "delivered",
    };
    const submitted: string[] = [];
    const fetch: CanonicalFetch = async (url, init) => {
      const request = {
        body: new Uint8Array(init.body!),
        contentType: init.headers["Content-Type"],
      };
      const identity = restoreCanonicalRequest(request).identity;
      submitted.push(identity.payload_hash);
      const phase = relayState.phase;
      if (phase === "down") throw new Error("connect ECONNREFUSED");
      const answer = new TextEncoder().encode(
        JSON.stringify(
          phase === "delivered"
            ? { version: 1, phase, identity, mailbox_committed_at_ms: 1234 }
            : { version: 1, phase, identity }
        )
      );
      let read = false;
      return {
        status: phase === "retained" ? 202 : 200,
        url,
        headers: {
          get: (name) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        body: {
          getReader: () => ({
            read: async () =>
              read
                ? { done: true }
                : ((read = true), { done: false, value: answer }),
            cancel: async () => undefined,
            releaseLock: () => undefined,
          }),
        },
      };
    };
    const own = await admit(botWallet);
    const peerEntry = await admit(user);
    const install = (wallet: EvmChainWalletHandle) =>
      actual.installCanonicalDirectory(wallet, {
      network: "monad-testnet",
      homeEndpoint: RELAY + "/",
      selfCurrent: own.current,
      peerCurrent: async (wanted) => {
        const subject =
          "subject" in wanted
            ? wanted.subject
            : computeAddress("0x" + peerEntry.subject).toLowerCase() ===
              wanted.address.toLowerCase()
            ? peerEntry.subject
            : undefined;
        return subject === peerEntry.subject
          ? {
              subject,
              endpoint: RELAY + "/",
              current: await peerEntry.current(),
            }
          : undefined;
      },
      fetch,
    });
    install(botWallet);
    /** The host's chain reports every payment it is asked about as confirmed. */
    const confirmPayments = () => {
      (
        host as unknown as { chain: { nativeTransfers?: unknown } }
      ).chain.nativeTransfers = {
        getTransactionStatus: async () => "confirmed",
      };
      (
        host as unknown as { provider: { getTransaction: unknown } }
      ).provider.getTransaction = async () => ({
        to: "0x" + "5e".repeat(20),
        value: 2_000_000_000_000n,
      });
    };
    /** The process ends and starts again: a new host, and the wallet reopened from its disk. */
    const restart = async () => {
      await host.stop();
      await open();
      confirmPayments();
      install(qwen().wallet);
      return qwen().wallet;
    };
    const rejections: unknown[] = [];
    mockSend.mockImplementation((params: Send) =>
      chain.directMessages.send(params).catch((error: unknown) => {
        rejections.push(error);
        throw error;
      })
    );
    mockReconcile.mockImplementation(
      (params: Parameters<DirectMessageClient["reconcileAttempts"]>[0]) =>
        chain.directMessages.reconcileAttempts(params)
    );

    // A PAID prompt, its payment confirmed: the reply to it is a paid message, which is what
    // these tests are about. (A reply to unpaid mail goes out unpaid and has no payment set.)
    const prompt: DirectMessageReceived = {
      ...message(),
      senderAddress: user.identity.address,
      senderPublicKey: user.identity.compressedPubKey,
      receivedTime: Date.now(),
      items: [{ type: "text", text: "P1" }],
      stampValueWei: 2_000_000_000_000n,
      stampPayments: [
        {
          txHash: "0x" + "ab".repeat(32),
          destinationAddress: "0x" + "5e".repeat(20),
          valueWei: 2_000_000_000_000n,
        },
      ],
    };
    confirmPayments();
    mockFetch.mockImplementation(async () => [prompt]);
    reply.mockImplementation(async (turnsSoFar: { content: string }[]) => ({
      content: "re:" + turnsSoFar[turnsSoFar.length - 1].content,
    }));
    const pass = async () => {
      await (host as unknown as { pollAllBots(): Promise<void> }).pollAllBots();
      await drain();
    };
    /** Every payment the wallet's journal holds an intent for. */
    const intents = () =>
      chain.directMessages.unattributedAttempts({
        wallet: qwen().wallet,
        knownDigests: [],
      });
    return {
      chain,
      botWallet,
      relayState,
      submitted,
      rejections,
      prompt,
      pass,
      intents,
      restart,
    };
  };
  const done = async (prompt: DirectMessageReceived) =>
    (await qwen().state.get("digest:" + prompt.payloadDigest)) !== undefined;

  // On 05c93db0 the first failure left the reply linked and waiting, and any second reply
  // behind it held for good; here the one reply is finished by polls alone.
  it("delivers a reply whose send failed, on later polls, as one payment: the relay is down, then holds it, then delivers it", async () => {
    const { relayState, submitted, rejections, prompt, pass, intents } =
      await setUp(true);
    relayState.phase = "down";
    await pass();
    expect(rejections).toHaveLength(1);
    expect(await done(prompt)).toBe(false);
    const [first] = await intents();
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    await pass();
    relayState.phase = "retained";
    await pass();
    await pass();
    expect(await done(prompt)).toBe(false);

    relayState.phase = "delivered";
    await pass();
    await pass();
    expect(await done(prompt)).toBe(true);
    expect(reply).toHaveBeenCalledTimes(1);
    // One payment: every hand-over to the relay was the same payment set, and the wallet's
    // journal holds one intent. The host called `send` once; the rest was the wallet resending.
    expect(submitted.length).toBeGreaterThan(1);
    expect(new Set(submitted)).toEqual(new Set([first]));
    expect(await intents()).toEqual([first]);
    expect(mockSend).toHaveBeenCalledTimes(1);
    await pass();
    expect(new Set(submitted)).toEqual(new Set([first]));
  });

  // The dry wallet. On 05c93db0 this throw came after the wallet withdrew its not-attempted
  // label, so the host held the generated answer for good, also after the wallet was funded.
  it("pays nothing while the wallet has no funds, and delivers the reply once, for one payment, after funds arrive", async () => {
    const { botWallet, submitted, rejections, prompt, pass, intents } =
      await setUp(false);
    await pass();
    await pass();
    await pass();
    // What the throw leaves behind in the wallet: no intent, no link, nothing at the relay.
    expect(rejections.length).toBeGreaterThanOrEqual(2);
    for (const refusal of rejections) {
      expect(String(refusal)).toMatch(/No funds cover a stamp/);
      // The wallet does not label it "not attempted", although it created nothing.
      expect(isDirectMessageNotAttempted(refusal)).toBe(false);
    }
    expect(submitted).toEqual([]);
    expect(await intents()).toEqual([]);
    expect(await done(prompt)).toBe(false);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(await stagedText(prompt.payloadDigest)).toBe("re:P1");

    await fund(botWallet);
    await pass();
    await pass();
    expect(await done(prompt)).toBe(true);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(new Set(submitted).size).toBe(1);
    expect(await intents()).toEqual([submitted[0]]);
    await pass();
    expect(new Set(submitted).size).toBe(1);
  });

  // Restart recovery of a PAID reply on the real wallet (stubbed RPC and relay HTTP; no real
  // chain or relay harness exists in the tree yet). The process dies after the wallet has
  // journalled and linked the payment and before the host has recorded it.
  it("after a crash once the wallet holds the payment: the restarted bot delivers that reply once, as the one payment set", async () => {
    const { relayState, submitted, rejections, prompt, pass, intents, restart } =
      await setUp(true);
    relayState.phase = "down";
    // The host's own record of the attempt is lost with the process.
    const link = jest
      .spyOn(qwen().operations, "linkReply")
      .mockRejectedValue(new Error("killed"));
    await pass();
    link.mockRestore();
    const [first] = await intents();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(qwen().operations.get(prompt.payloadDigest)?.reply?.digest).toBe(
      undefined
    );
    expect(await stagedText(prompt.payloadDigest)).toBe("re:P1");

    await restart();
    mockFetch.mockImplementation(async () => []);
    relayState.phase = "delivered";
    await pass();
    await pass();
    await pass();

    expect(await done(prompt)).toBe(true);
    // The model was asked once, in the first lifetime.
    expect(reply).toHaveBeenCalledTimes(1);
    // One payment set ever reached the relay, and the reopened journal holds one intent.
    expect(new Set(submitted)).toEqual(new Set([first]));
    expect(await intents()).toEqual([first]);
    // How it got there: the restarted host sent under the same identity once, and the wallet
    // answered with the payment it already held instead of making another.
    expect(
      rejections.filter(
        (error) =>
          (error as Error).name === "DirectMessageAlreadyAttemptedError" &&
          (error as { payloadDigest?: string }).payloadDigest === first
      )
    ).toHaveLength(1);
    await pass();
    expect(new Set(submitted)).toEqual(new Set([first]));
  });
});
