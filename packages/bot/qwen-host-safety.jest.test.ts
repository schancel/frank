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
import { QwenBot } from "./src/bots/qwen-bot";
import { LoopGuard } from "../bot-framework/src/loop-guard";
import type { InboundOperationStore } from "../bot-framework/src/inbound-operation-store";
import type { BotContext } from "../bot-framework/src/types";
import {
  directMessageNotAttempted,
  isDirectMessageNotAttempted,
  type DirectMessageReceived,
  type DirectMessageSendResult,
  type DirectMessageClient,
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
        if (request.method === "getGasPrice") return 2n;
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

// T1. Was: ended by asserting that NO completion marker existed after the wallet reported the
// original reply delivered, and never looked at history. That pinned the defect: a reply that
// linked and then reported pending was paid and delivered, and its turn was never recorded.
it("commits the history of a reply that linked and reported pending, once, when that reply is observed delivered", async () => {
  mockSend.mockImplementation(async (params: Send) => {
    await params.onAttemptCreated?.(receipt.payloadDigest);
    throw new Error("canonical attempt pending");
  });
  mockReconcile.mockResolvedValue({ [receipt.payloadDigest]: "live" });
  const marker = () => qwen().state.get(`digest:${message().payloadDigest}`);
  let legacy = await open();
  await poll();
  await poll();
  expect(reply).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(await stagedText(message().payloadDigest)).toBe("Saved once");
  expect(await turns()).toBeUndefined();
  await host.stop();
  legacy = await open();
  // Recovery must work even when mailbox echo is absent.
  mockFetch.mockResolvedValue([]);
  await poll();
  expect(mockReconcile).toHaveBeenCalledWith(
    expect.objectContaining({ payloadDigests: [receipt.payloadDigest] })
  );
  expect(qwen().operations.get(message().payloadDigest)).toMatchObject({
    phase: "started",
    replies: [{ digest: receipt.payloadDigest, observation: "live" }],
  });
  expect(await turns()).toBeUndefined();
  expect(await marker()).toBeUndefined();
  mockReconcile.mockResolvedValue({ [receipt.payloadDigest]: "delivered" });
  await poll();
  await poll();
  const committed = await qwen().state.get(historyKey());
  expect(await turns()).toEqual(["Hello", "Saved once"]);
  expect(await marker()).toBe("completed");
  expect(await qwen().state.readEntries("host-prepared:")).toEqual([]);
  // Stable across further polls, the mailbox echo and another reopen.
  mockFetch.mockImplementation(async () => [message()]);
  await poll();
  await host.stop();
  legacy = await open();
  await poll();
  await poll();
  expect(reply).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(legacy).not.toHaveBeenCalled();
  expect(await qwen().state.get(historyKey())).toBe(committed);
  // The next prompt of the conversation is generated with the committed pair.
  mockFetch.mockImplementation(async () => [
    {
      ...message(),
      payloadDigest: "cc".repeat(32),
      messageId: "03030303-0303-0303-0303-030303030303",
      receivedTime: 2000,
    },
  ]);
  await poll();
  expect(reply).toHaveBeenCalledTimes(2);
  expect(reply.mock.calls[1][0]).toEqual([
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Saved once" },
    { role: "user", content: "Hello" },
  ]);
});

// Was: failed Qwen's own `state.put` of the history key after a delivered reply and accepted
// that the turn was then lost for good. That write no longer exists: history is part of the
// batch that completes the invocation, so a failed write is retried from disk truth and lands.
it("does not regenerate or repay after delivery followed by a failed history commit, and commits it once after reopen", async () => {
  const counted = jest.spyOn(LoopGuard.prototype, "recordReply");
  mockSend.mockImplementation(async (params: Send) => {
    await params.onAttemptCreated?.(receipt.payloadDigest);
    return receipt;
  });
  const legacy = await open();
  const original = LevelBotStateStore.prototype.durableBatch;
  let failedHistory = false;
  const cut = jest
    .spyOn(LevelBotStateStore.prototype, "durableBatch")
    .mockImplementation(function (ops) {
      if (ops.some((op) => op.key.startsWith("qwen-history:v1:"))) {
        failedHistory = true;
        return Promise.reject(new Error("history unavailable"));
      }
      return original.call(this, ops);
    });
  const plainWrite = jest.spyOn(LevelBotStateStore.prototype, "put");
  await poll();
  await poll();
  expect(failedHistory).toBe(true);
  expect(counted).not.toHaveBeenCalled();
  await host.stop();
  cut.mockRestore();
  await open();
  expect(await turns()).toBeUndefined();
  await poll();
  await poll();
  expect(reply).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(legacy).not.toHaveBeenCalled();
  expect(counted).toHaveBeenCalledTimes(1);
  expect(await turns()).toEqual(["Hello", "Saved once"]);
  expect(
    plainWrite.mock.calls.some(([key]) => key.startsWith("qwen-history:"))
  ).toBe(false);
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

// T2, T13. One row per durable write of the prepared path, each cut both ways: the write is
// lost, or it lands and its acknowledgement is lost. Either faults the journal until reopen.
// `sends` counts wallet calls over every lifetime and `intents` the payments they created.
// Was: a "begin" case that matched the first row write with no reply slot, which since
// retention is the retain write, not the start write; both are now named and cut separately.
it.each([
  // Nothing durable: the message is fetched again and handled once.
  {
    cut: "retain",
    committed: false,
    model: [0, 1],
    sends: [0, 1],
    end: "completed",
  },
  {
    cut: "retain",
    committed: true,
    model: [0, 1],
    sends: [0, 1],
    end: "completed",
  },
  {
    cut: "start",
    committed: false,
    model: [0, 1],
    sends: [0, 1],
    end: "completed",
  },
  // Started on disk but the handler never ran: held, never generated.
  {
    cut: "start",
    committed: true,
    model: [0, 0],
    sends: [0, 0],
    end: "started",
  },
  // Generated, not staged: the answer is lost and never generated again.
  {
    cut: "prepare",
    committed: false,
    model: [1, 1],
    sends: [0, 0],
    end: "started",
  },
  // Staged, no slot: the only state a restart sends from.
  {
    cut: "prepare",
    committed: true,
    model: [1, 1],
    sends: [0, 1],
    end: "completed",
  },
  {
    cut: "slot",
    committed: false,
    model: [1, 1],
    sends: [0, 1],
    end: "completed",
  },
  // A slot on disk whose call nobody can account for: held, never sent.
  {
    cut: "slot",
    committed: true,
    model: [1, 1],
    sends: [0, 0],
    end: "unlinked",
  },
  // A labelled refusal whose retraction is lost leaves that slot; one that landed is sent once.
  {
    cut: "retract",
    committed: false,
    model: [1, 1],
    sends: [1, 1],
    end: "unlinked",
  },
  {
    cut: "retract",
    committed: true,
    model: [1, 1],
    sends: [1, 2],
    end: "completed",
  },
  // T13: the wallet has its link and delivers; the host row never learns the digest.
  {
    cut: "link",
    committed: false,
    model: [1, 1],
    sends: [1, 1],
    end: "unlinked",
  },
  {
    cut: "link",
    committed: true,
    model: [1, 1],
    sends: [1, 1],
    end: "completed",
  },
  {
    cut: "observe",
    committed: false,
    model: [1, 1],
    sends: [1, 1],
    end: "completed",
  },
  {
    cut: "observe",
    committed: true,
    model: [1, 1],
    sends: [1, 1],
    end: "completed",
  },
  {
    cut: "completion",
    committed: false,
    model: [1, 1],
    sends: [1, 1],
    end: "completed",
  },
  {
    cut: "completion",
    committed: true,
    model: [1, 1],
    sends: [1, 1],
    end: "completed",
  },
] as const)(
  "recovers the real Qwen path from a cut $cut write (committed=$committed) as $end",
  async ({ cut, committed, model, sends, end }) => {
    let intents = 0;
    mockSend.mockImplementation(async (params: Send) => {
      if (cut === "retract" && mockSend.mock.calls.length === 1)
        throw notAttempted(new Error("earlier attempt pending"));
      intents++; // the wallet's own link is durable before it tells the host
      await params.onAttemptCreated?.(receipt.payloadDigest);
      return receipt;
    });
    const legacy = await open();
    const original = LevelBotStateStore.prototype.durableBatch;
    let injected = false;
    const spy = jest
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
                prepared?: object;
                replies: Array<{ digest?: string; observation?: string }>;
              })
            : undefined;
        const slot = row?.replies[0];
        const written = !row
          ? undefined
          : row.phase === "deferred"
          ? "retain"
          : row.phase === "completed"
          ? "completion"
          : !row.prepared
          ? "start"
          : ops.length === 3
          ? "prepare"
          : !slot
          ? "retract"
          : !slot.digest
          ? "slot"
          : slot.observation === "delivered"
          ? "observe"
          : "link";
        if (!injected && written === cut) {
          injected = true;
          if (committed) await original.call(this, ops);
          throw new Error("lost storage acknowledgement");
        }
        return original.call(this, ops);
      });
    await poll();
    await drain();
    expect(injected).toBe(true);
    expect(reply).toHaveBeenCalledTimes(model[0]);
    expect(mockSend).toHaveBeenCalledTimes(sends[0]);
    // The faulted journal admits nothing more in this process.
    await poll();
    await drain();
    expect(mockSend).toHaveBeenCalledTimes(sends[0]);
    spy.mockRestore();
    for (let lifetime = 0; lifetime < 2; lifetime++) {
      await host.stop();
      await open();
      for (let pass = 0; pass < 3; pass++) {
        await poll();
        await drain();
      }
      expect(reply).toHaveBeenCalledTimes(model[1]);
      expect(mockSend).toHaveBeenCalledTimes(sends[1]);
      // Never more than one payment, and the labelled refusal created none.
      expect(intents).toBe(sends[1] - (cut === "retract" ? 1 : 0));
      expect(intents).toBeLessThanOrEqual(1);
      const row = qwen().operations.get(message().payloadDigest);
      const done = end === "completed";
      expect(row?.phase).toBe(done ? "completed" : "started");
      expect(await turns()).toEqual(done ? ["Hello", "Saved once"] : undefined);
      expect(await qwen().state.get(`digest:${message().payloadDigest}`)).toBe(
        done ? "completed" : undefined
      );
      expect(await stagedText(message().payloadDigest)).toBe(
        end === "unlinked" ? "Saved once" : undefined
      );
      if (end === "started") expect(row).toMatchObject({ replies: [] });
      if (end === "started") expect(row?.prepared).toBeUndefined();
      // Held with a slot the wallet never linked to this row: not reconciled, not sent again.
      // The poll's question to the wallet is about no reply in particular (#1236 Q3).
      if (end === "unlinked") {
        expect(row?.replies).toEqual([
          expect.not.objectContaining({ digest: expect.anything() }),
        ]);
        for (const [asked] of mockReconcile.mock.calls)
          expect(asked.payloadDigests).toEqual([]);
      }
    }
    expect(legacy).not.toHaveBeenCalled();
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
      // One pass: its one question to the wallet, about no reply in particular (#1236 Q3).
      expect(mockReconcile.mock.calls).toEqual([
        [{ wallet: expect.anything(), payloadDigests: [] }],
      ]);
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

  describe("prepared reply and continuation", () => {
    type Attempt = { digest: string; text: string; delivered: boolean };
    /** The stand-in wallet's payment intents, kept across host restarts as a wallet would. */
    let attempts: Attempt[];
    /** How the wallet treats a reply it accepts: deliver it, link it and report pending, or
     * reject it unlabelled before linking (as inventory funding does). */
    let plan: (text: string) => "deliver" | "pending" | "unlabelled";
    /** The canonical wallet refuses, labelled, while an earlier attempt has no outcome. */
    let oneLiveAttempt: boolean;
    const textOf = (params: Send) =>
      (params.items[0] as { type: "text"; text: string }).text;
    const sends = (text: string) =>
      mockSend.mock.calls.filter(([params]) => textOf(params) === text).length;
    const intents = (text: string) =>
      attempts.filter((attempt) => attempt.text === text).length;
    const deliver = (text: string) => {
      for (const attempt of attempts)
        if (attempt.text === text) attempt.delivered = true;
    };
    const pollAllBots = () =>
      (host as unknown as { pollAllBots(): Promise<void> }).pollAllBots();
    const pass = async (count = 1) => {
      for (let index = 0; index < count; index++) {
        await pollAllBots();
        await drain();
      }
    };
    const row = (item: DirectMessageReceived) =>
      qwen().operations.get(item.payloadDigest);
    const staged = () =>
      qwen()
        .operations.listIncomplete()
        .filter((held) => held.prepared && !held.replies.length);
    /** A message sent outside any invocation, as Qwen's greeting is: linked, not yet delivered. */
    const greet = async () => {
      await qwen()
        .context.sendMessage(other.address, [
          { type: "text", text: "greeting" },
        ])
        .catch(() => undefined);
      expect(attempts).toEqual([
        expect.objectContaining({ text: "greeting", delivered: false }),
      ]);
    };
    beforeEach(() => {
      attempts = [];
      plan = () => "deliver";
      oneLiveAttempt = true;
      mockSend.mockImplementation(async (params: Send) => {
        const text = textOf(params);
        if (oneLiveAttempt && attempts.some((attempt) => !attempt.delivered))
          throw notAttempted(new Error("earlier attempt pending"));
        const outcome = text === "greeting" ? "pending" : plan(text);
        if (outcome === "unlabelled")
          throw new Error("inventory funding failed");
        const attempt = {
          digest: (0xf000 + attempts.length).toString(16).padStart(64, "0"),
          text,
          delivered: false,
        };
        attempts.push(attempt);
        await params.onAttemptCreated?.(attempt.digest);
        if (outcome === "pending") throw new Error("canonical attempt pending");
        attempt.delivered = true;
        return { ...receipt, payloadDigest: attempt.digest };
      });
      mockReconcile.mockImplementation(
        async ({ payloadDigests }: { payloadDigests: string[] }) =>
          Object.fromEntries(
            payloadDigests.map((digest) => {
              const attempt = attempts.find((known) => known.digest === digest);
              return [
                digest,
                !attempt ? "unknown" : attempt.delivered ? "delivered" : "live",
              ];
            })
          )
      );
    });

    // T3. Reproduces: A2 was generated at once, against history that did not have A1's turn,
    // and A1's turn was never recorded at all.
    it("answers a conversation's second prompt only after its first reply delivers and commits, while another conversation goes on", async () => {
      oneLiveAttempt = false;
      plan = (text) => (text === "re:A1" ? "pending" : "deliver");
      const a1 = inbound(1, "A1", 1000);
      const a2 = inbound(2, "A2", 2000);
      const b1 = inbound(3, "B1", 3000, other, threadB);
      mailbox = [a1];
      await open();
      await pass();
      expect(row(a1)).toMatchObject({
        phase: "started",
        replies: [{ digest: attempts[0].digest }],
      });
      mailbox = [a1, a2, b1];
      await pass(2);
      expect(prompts()).toEqual(["A1", "B1"]);
      expect(row(a2)?.phase).toBe("deferred");
      expect(await turns(threadB, other)).toEqual(["B1", "re:B1"]);
      expect(await qwen().state.get("cursor:lastPollTimestamp")).toBe(
        String(b1.receivedTime + 1)
      );
      expect(await turns(threadA)).toBeUndefined();
      // A1 delivers and commits while the mailbox returns nothing.
      deliver("re:A1");
      mailbox = [];
      await pass();
      expect(await turns(threadA)).toEqual(["A1", "re:A1"]);
      expect(row(a1)?.phase).toBe("completed");
      expect(prompts()).toEqual(["A1", "B1"]);
      await host.stop();
      await open();
      mockFetch.mockClear();
      mailbox = [a1, a2, b1];
      await pass(2);
      expect(scans()[0]).toBe(a2.receivedTime);
      expect(prompts()).toEqual(["A1", "B1", "A2"]);
      expect(reply.mock.calls[2][0]).toEqual([
        { role: "user", content: "A1" },
        { role: "assistant", content: "re:A1" },
        { role: "user", content: "A2" },
      ]);
      expect(await turns(threadA)).toEqual(["A1", "re:A1", "A2", "re:A2"]);
      expect(await turns(threadB, other)).toEqual(["B1", "re:B1"]);
      expect(attempts.map((attempt) => attempt.text)).toEqual([
        "re:A1",
        "re:B1",
        "re:A2",
      ]);
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    // T3, digest tie. Reproduces: the second prompt of a conversation was started while the
    // first reply was still undelivered.
    it("orders two prompts of equal relay time by digest and holds the second until the first reply delivers", async () => {
      plan = (text) => (text === "re:first" ? "pending" : "deliver");
      const first = inbound(0x10, "first", 1000);
      const second = inbound(0x20, "second", 1000);
      mailbox = [second, first];
      await open();
      await pass(3);
      expect(prompts()).toEqual(["first"]);
      expect(row(second)?.phase).toBe("deferred");
      deliver("re:first");
      await pass(2);
      expect(prompts()).toEqual(["first", "second"]);
      expect(reply.mock.calls[1][0]).toHaveLength(3);
      expect(await turns(threadA)).toEqual([
        "first",
        "re:first",
        "second",
        "re:second",
      ]);
    });

    // The three-call rule. Reproduces: nothing distinguished "refused, nothing attempted" from
    // "may have paid", so no reply could ever be sent again safely.
    it("never calls the wallet again for a reply whose first call linked and was rejected unlabelled, whatever is refused labelled afterwards", async () => {
      plan = (text) => (text === "re:A1" ? "pending" : "deliver");
      const a1 = inbound(1, "A1", 1000);
      const b1 = inbound(3, "B1", 3000, other, threadB);
      mailbox = [a1];
      await open();
      await pass();
      mailbox = [a1, b1];
      await pass(3);
      // B1 is refused, labelled, on every pass while A1 has no outcome: taken back each time.
      expect(sends("re:B1")).toBeGreaterThanOrEqual(2);
      expect(intents("re:B1")).toBe(0);
      expect(row(b1)).toMatchObject({ phase: "started", replies: [] });
      expect(await stagedText(b1.payloadDigest)).toBe("re:B1");
      expect(sends("re:A1")).toBe(1);
      expect(row(a1)?.replies).toEqual([
        expect.objectContaining({ digest: attempts[0].digest }),
      ]);
      await host.stop();
      await open();
      await pass(2);
      expect(sends("re:A1")).toBe(1);
      deliver("re:A1");
      await pass(2);
      expect(sends("re:A1")).toBe(1);
      expect(intents("re:A1")).toBe(1);
      expect(intents("re:B1")).toBe(1);
      expect(await turns(threadA)).toEqual(["A1", "re:A1"]);
      expect(await turns(threadB, other)).toEqual(["B1", "re:B1"]);
      expect(reply).toHaveBeenCalledTimes(2);
    });

    // T4, T12. Reproduces: a send refused behind an earlier live attempt left a slot without a
    // digest, held for ever, and the generated answer was never sent.
    it("takes back the slot of a send the wallet labelled not attempted, keeps the answer, and sends it once the wallet accepts", async () => {
      const a1 = inbound(1, "A1", 1000);
      mailbox = [a1];
      await open();
      await greet();
      const slots: number[] = [];
      const original = LevelBotStateStore.prototype.durableBatch;
      const writes = jest
        .spyOn(LevelBotStateStore.prototype, "durableBatch")
        .mockImplementation(function (ops) {
          const op = ops.find(
            (value) => value.key === rowKey(a1.payloadDigest)
          );
          if (op?.type === "put")
            slots.push(JSON.parse(op.value).replies.length);
          return original.call(this, ops);
        });
      await pass();
      writes.mockRestore();
      // Retained, started, staged; then the slot before the wallet call, and its retraction.
      expect(slots).toEqual([0, 0, 0, 1, 0]);
      expect(sends("re:A1")).toBe(1);
      expect(row(a1)).toMatchObject({ phase: "started", replies: [] });
      expect(await stagedText(a1.payloadDigest)).toBe("re:A1");
      await pass();
      expect(sends("re:A1")).toBe(2);
      await host.stop();
      await open();
      await pass();
      expect(sends("re:A1")).toBe(3);
      expect(intents("re:A1")).toBe(0);
      expect(await turns(threadA)).toBeUndefined();
      deliver("greeting");
      await pass();
      expect(sends("re:A1")).toBe(4);
      expect(intents("re:A1")).toBe(1);
      expect(await turns(threadA)).toEqual(["A1", "re:A1"]);
      expect(row(a1)?.phase).toBe("completed");
      await pass(2);
      await host.stop();
      await open();
      await pass(2);
      expect(sends("re:A1")).toBe(4);
      expect(intents("re:A1")).toBe(1);
      expect(reply).toHaveBeenCalledTimes(1);
      expect(await turns(threadA)).toEqual(["A1", "re:A1"]);
    });

    // T12 (unlabelled) and Revision 5. Reproduces: without the label nothing may be assumed, so
    // the slot is held; and the conversation behind it was then silenced, each later prompt
    // calling the model and losing its answer.
    it("holds a reply the wallet rejected unlabelled before linking, never sends it again, and answers the conversation's next prompt without that turn", async () => {
      plan = (text) => (text === "re:P1" ? "unlabelled" : "deliver");
      const p1 = inbound(1, "P1", 1000);
      const p2 = inbound(2, "P2", 2000);
      mailbox = [p1];
      await open();
      await pass(3);
      expect(sends("re:P1")).toBe(1);
      expect(row(p1)).toMatchObject({
        phase: "started",
        prepared: { stateKey: historyKey(threadA) },
        replies: [{ stampValue: "1" }],
      });
      expect(row(p1)?.replies[0].digest).toBeUndefined();
      const held = await qwen().state.get(rowKey(p1.payloadDigest));
      await host.stop();
      await open();
      await pass(2);
      expect(sends("re:P1")).toBe(1);
      mailbox = [p1, p2];
      await pass(2);
      expect(prompts()).toEqual(["P1", "P2"]);
      expect(reply.mock.calls[1][0]).toEqual([{ role: "user", content: "P2" }]);
      expect(sends("re:P2")).toBe(1);
      expect(row(p2)?.phase).toBe("completed");
      expect(await turns(threadA)).toEqual(["P2", "re:P2"]);
      await host.stop();
      await open();
      await pass(2);
      // P1: never sent again, never committed, its answer kept as evidence.
      expect(sends("re:P1")).toBe(1);
      expect(intents("re:P1")).toBe(0);
      expect(await qwen().state.get(rowKey(p1.payloadDigest))).toBe(held);
      expect(await stagedText(p1.payloadDigest)).toBe("re:P1");
      expect(
        await qwen().state.get("digest:" + p1.payloadDigest)
      ).toBeUndefined();
      expect(await turns(threadA)).toEqual(["P2", "re:P2"]);
      expect(reply).toHaveBeenCalledTimes(2);
    });

    // Pin P1 (#1310 item 3). Guards: re-checking `closing` after the reply-slot write, which would
    // strand an unsent slot (held for ever) on every shutdown that races a first send.
    it("still enters the wallet for a slot whose write was in progress when stop() landed, and persists the outcome", async () => {
      const a1 = inbound(1, "A1", 1000);
      mailbox = [a1];
      await open();
      let entered!: () => void;
      const blocked = new Promise<void>((resolve) => (entered = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const original = LevelBotStateStore.prototype.durableBatch;
      const writes = jest
        .spyOn(LevelBotStateStore.prototype, "durableBatch")
        .mockImplementation(async function (ops) {
          const op = ops.find(
            (value) => value.key === rowKey(a1.payloadDigest)
          );
          if (op?.type === "put" && JSON.parse(op.value).replies.length === 1) {
            entered();
            await gate;
          }
          return original.call(this, ops);
        });
      const polling = pollAllBots();
      await blocked;
      expect(mockSend).not.toHaveBeenCalled();
      // stop() sets `closing` synchronously, while the slot write is still held.
      const stopping = host.stop();
      release();
      await stopping;
      await polling;
      writes.mockRestore();
      expect(sends("re:A1")).toBe(1);
      expect(intents("re:A1")).toBe(1);
      await open();
      expect(row(a1)?.phase).toBe("completed");
      expect(await turns(threadA)).toEqual(["A1", "re:A1"]);
      await pass(2);
      expect(sends("re:A1")).toBe(1);
      expect(reply).toHaveBeenCalledTimes(1);
    });

    // Pin P2 (#1310 item 3). Guards: a retry pass making a second wallet call after a refusal, or
    // always restarting at the first waiting row so later rows never get a turn.
    it("makes one wallet call per retry pass over several staged rows, ending at the first refusal, and rotates the row tried", async () => {
      const crowd = Array.from(
        { length: 4 },
        (_, index) => new Wallet("0x" + (0x40 + index).toString(16).repeat(32))
      );
      mailbox = crowd.map((sender, index) =>
        inbound(0x200 + index, "Q" + index, 1000 + index, sender)
      );
      await open();
      await greet();
      await pass(2);
      expect(staged()).toHaveLength(4);
      expect(intents("re:Q0") + intents("re:Q1")).toBe(0);
      const tried: number[] = [];
      for (let index = 0; index < 9; index++) {
        mockSend.mockClear();
        await pass();
        expect(mockSend).toHaveBeenCalledTimes(1);
        const text = (mockSend.mock.calls[0][0] as Send).items[0] as {
          text: string;
        };
        tried.push(Number(text.text.slice(4)));
      }
      // Handling order, each pass starting after the row the previous pass ended on.
      for (let index = 1; index < tried.length; index++)
        expect(tried[index]).toBe((tried[index - 1] + 1) % 4);
      expect(new Set(tried)).toEqual(new Set([0, 1, 2, 3]));
      // Every refusal was labelled: nothing but the greeting was ever attempted.
      expect(attempts).toHaveLength(1);
      expect(staged()).toHaveLength(4);
    });

    // Pin P3 (#1310 item 3). Guards: retracting a slot on the label alone, when the wallet had
    // already reported an attempt during that call (the reported attempt must stay linked).
    it("keeps the slot of a labelled rejection that also reported an attempt, and does not send that reply again", async () => {
      const a1 = inbound(1, "A1", 1000);
      mailbox = [a1];
      mockSend.mockImplementation(async (params: Send) => {
        const attempt = {
          digest: (0xf000 + attempts.length).toString(16).padStart(64, "0"),
          text: textOf(params),
          delivered: false,
        };
        attempts.push(attempt);
        await params.onAttemptCreated?.(attempt.digest);
        throw notAttempted(new Error("labelled after reporting an attempt"));
      });
      await open();
      // The host must not even ask the store to take the slot back (the store would refuse a
      // linked slot, which hides a host that asks).
      const retract = jest.spyOn(qwen().operations, "retractReply");
      await pass(3);
      expect(retract).not.toHaveBeenCalled();
      expect(sends("re:A1")).toBe(1);
      expect(intents("re:A1")).toBe(1);
      expect(row(a1)).toMatchObject({
        phase: "started",
        replies: [{ digest: attempts[0].digest }],
      });
      expect(await stagedText(a1.payloadDigest)).toBe("re:A1");
      await host.stop();
      await open();
      await pass(2);
      expect(sends("re:A1")).toBe(1);
      expect(intents("re:A1")).toBe(1);
      expect(row(a1)?.replies).toHaveLength(1);
      expect(reply).toHaveBeenCalledTimes(1);
    });

    // Pin P4 (#1310 item 3). Guards: reading the wallet's label from `.cause` or a wrapper, which
    // the label's caller rules forbid; such a rejection must be treated as unlabelled.
    it("holds the slot of an unlabelled rejection whose cause is labelled, and never sends that reply again", async () => {
      const p1 = inbound(1, "P1", 1000);
      mailbox = [p1];
      const inner = notAttempted(new Error("inner refusal"));
      expect(isDirectMessageNotAttempted(inner)).toBe(true);
      const wrapper = Object.assign(new Error("wrapped refusal"), {
        cause: inner,
      });
      expect(isDirectMessageNotAttempted(wrapper)).toBe(false);
      mockSend.mockImplementation(async () => {
        throw wrapper;
      });
      await open();
      const retract = jest.spyOn(qwen().operations, "retractReply");
      await pass(3);
      expect(retract).not.toHaveBeenCalled();
      expect(sends("re:P1")).toBe(1);
      expect(row(p1)).toMatchObject({
        phase: "started",
        replies: [{ stampValue: "1" }],
      });
      expect(row(p1)?.replies[0].digest).toBeUndefined();
      expect(await stagedText(p1.payloadDigest)).toBe("re:P1");
      await host.stop();
      await open();
      await pass(2);
      expect(sends("re:P1")).toBe(1);
      expect(row(p1)?.replies).toHaveLength(1);
      expect(reply).toHaveBeenCalledTimes(1);
    });

    // T7. Reproduces: history was overwritten unconditionally after the reply.
    it("holds a delivered reply whose history key changed meanwhile, overwrites nothing, and keeps its conversation waiting", async () => {
      plan = (text) => (text === "re:A1" ? "pending" : "deliver");
      const a1 = inbound(1, "A1", 1000);
      const a2 = inbound(2, "A2", 2000);
      mailbox = [a1];
      await open();
      await pass();
      await qwen().state.put(historyKey(threadA), "written by someone else");
      deliver("re:A1");
      mailbox = [a1, a2];
      for (let lifetime = 0; lifetime < 2; lifetime++) {
        await pass(3);
        expect(row(a1)).toMatchObject({
          phase: "started",
          replies: [{ observation: "delivered" }],
        });
        expect(await qwen().state.get(historyKey(threadA))).toBe(
          "written by someone else"
        );
        expect(
          await qwen().state.get("digest:" + a1.payloadDigest)
        ).toBeUndefined();
        expect(await stagedText(a1.payloadDigest)).toBe("re:A1");
        expect(row(a2)?.phase).toBe("deferred");
        expect(reply).toHaveBeenCalledTimes(1);
        expect(mockSend).toHaveBeenCalledTimes(1);
        await host.stop();
        await open();
      }
    });

    // T7. Reproduces: a reply was sent whatever had happened to its history meanwhile.
    it("does not send a staged reply whose history key changed before its first send", async () => {
      const a1 = inbound(1, "A1", 1000);
      mailbox = [a1];
      await open();
      await greet();
      await pass();
      expect(staged().map((held) => held.digest)).toEqual([a1.payloadDigest]);
      await qwen().state.put(historyKey(threadA), "written by someone else");
      deliver("greeting");
      await pass(3);
      await host.stop();
      await open();
      await pass(2);
      // Only the refused call was ever made; no slot was persisted for a second one.
      expect(sends("re:A1")).toBe(1);
      expect(intents("re:A1")).toBe(0);
      expect(row(a1)).toMatchObject({ phase: "started", replies: [] });
      expect(await stagedText(a1.payloadDigest)).toBe("re:A1");
      expect(await qwen().state.get(historyKey(threadA))).toBe(
        "written by someone else"
      );
    });

    // T14, OD-6. Reproduces: every prompt called the model and left a slot without a digest
    // while the wallet was refusing sends.
    it("stops generating once sixteen answers are staged behind a refused send, apart from handlers already running, and answers everyone once it clears", async () => {
      const crowd = Array.from(
        { length: 20 },
        (_, index) => new Wallet("0x" + (0x30 + index).toString(16).repeat(32))
      );
      const question = (index: number) =>
        inbound(0x100 + index, "Q" + index, 1000 + index, crowd[index]);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      reply.mockImplementation(async (prompt: { content: string }[]) => {
        const content = prompt[prompt.length - 1].content;
        if (["Q15", "Q16", "Q17"].includes(content)) await gate;
        return { content: "re:" + content };
      });
      await open();
      await greet();
      mailbox = Array.from({ length: 15 }, (_, index) => question(index));
      await pass(2);
      expect(reply).toHaveBeenCalledTimes(15);
      expect(staged()).toHaveLength(15);
      // Three handlers start while fifteen answers are staged: they are already running when
      // the sixteenth is staged, and each stages its own.
      mailbox.push(question(15), question(16), question(17));
      await pollAllBots();
      for (let wait = 0; wait < 20 && reply.mock.calls.length < 18; wait++)
        await settle();
      expect(reply).toHaveBeenCalledTimes(18);
      release();
      await pass();
      expect(staged()).toHaveLength(18);
      // At the bound nothing more is generated: later prompts wait, retained, in order.
      mailbox.push(question(18), question(19));
      await pass(3);
      expect(reply).toHaveBeenCalledTimes(18);
      expect(row(question(18))?.phase).toBe("deferred");
      expect(row(question(19))?.phase).toBe("deferred");
      // Every refusal was labelled, so no slot is left behind and nothing but the greeting
      // was ever attempted.
      expect(
        qwen()
          .operations.listIncomplete()
          .every((held) => !held.replies.length)
      ).toBe(true);
      expect(attempts).toHaveLength(1);
      deliver("greeting");
      await pass(4);
      expect(reply).toHaveBeenCalledTimes(20);
      for (let index = 0; index < 20; index++) {
        expect(await turns(threadA, crowd[index])).toEqual([
          "Q" + index,
          "re:Q" + index,
        ]);
        expect(intents("re:Q" + index)).toBe(1);
      }
      expect(attempts).toHaveLength(21);
      expect(qwen().operations.listIncomplete()).toEqual([]);
    });

    // T5. Reproduces: at the cap a later prompt of a conversation ran with a stale prompt.
    it("stages, sends and commits rows retained before the 1,024-row cap, in order, and deletes nothing", async () => {
      plan = (text) => (text === "re:A1" ? "pending" : "deliver");
      const a1 = inbound(0x9001, "A1", 1000);
      const a2 = inbound(0x9002, "A2", 2000);
      const unretained = inbound(0x9003, "U", 3000, other, threadB);
      await open();
      await host.stop();
      const seeded = await LevelBotStateStore.open(
        join(root, "bots", "qwen", "state")
      );
      await seeded.batch(
        Array.from({ length: 1022 }, (_, index) => ({
          type: "put" as const,
          key: rowKey((index + 1).toString(16).padStart(64, "0")),
          value: JSON.stringify({
            version: 1,
            digest: (index + 1).toString(16).padStart(64, "0"),
            peerSubject: peer.signingKey.compressedPublicKey.slice(2),
            peerAddress: peer.address.toLowerCase(),
            conversationId: threadA,
            messageId:
              "00000000-0000-0000-0000-" +
              (index + 1).toString(16).padStart(12, "0"),
            receivedTime: 1,
            phase: "started",
            replies: [],
          }),
        }))
      );
      await seeded.close();
      mailbox = [a1, a2, unretained];
      await open();
      await pass(3);
      expect(prompts()).toEqual(["A1"]);
      expect(row(a2)?.phase).toBe("deferred");
      expect(row(unretained)).toBeUndefined();
      expect(
        await qwen().state.readEntries("host-inbound:v1:dispatch:")
      ).toHaveLength(1024);
      deliver("re:A1");
      await pass(3);
      expect(prompts()).toEqual(["A1", "A2"]);
      expect(reply.mock.calls[1][0]).toHaveLength(3);
      expect(await turns(threadA)).toEqual(["A1", "re:A1", "A2", "re:A2"]);
      expect(row(a1)?.phase).toBe("completed");
      expect(row(a2)?.phase).toBe("completed");
      expect(row(unretained)).toBeUndefined();
      expect(
        await qwen().state.readEntries("host-inbound:v1:dispatch:")
      ).toHaveLength(1024);
      expect(await qwen().state.readEntries("host-prepared:")).toEqual([]);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    // T19 and Revision 5 item 2. Reproduces: a stop() during admission left a generated answer
    // that was never sent, or a started row whose handler never ran.
    it.each(["start", "prepare"] as const)(
      "stages the answer and sends it exactly once after restart when stop() lands during the %s write",
      async (during) => {
        const a1 = inbound(1, "A1", 1000);
        mailbox = [a1];
        await open();
        const original = LevelBotStateStore.prototype.durableBatch;
        let stopping: Promise<void> | undefined;
        const spy = jest
          .spyOn(LevelBotStateStore.prototype, "durableBatch")
          .mockImplementation(function (ops) {
            const op = ops.find(
              (value) => value.key === rowKey(a1.payloadDigest)
            );
            const written =
              op?.type === "put"
                ? (JSON.parse(op.value) as { phase: string; prepared?: object })
                : undefined;
            const now =
              during === "prepare"
                ? ops.length === 3
                : written?.phase === "started" && !written.prepared;
            if (now && !stopping) stopping = host.stop();
            return original.call(this, ops);
          });
        await pollAllBots();
        for (let wait = 0; wait < 20 && !stopping; wait++) await settle();
        await stopping;
        spy.mockRestore();
        expect(reply).toHaveBeenCalledTimes(1);
        expect(mockSend).not.toHaveBeenCalled();
        await open();
        expect(staged().map((held) => held.digest)).toEqual([a1.payloadDigest]);
        expect(await stagedText(a1.payloadDigest)).toBe("re:A1");
        for (let lifetime = 0; lifetime < 2; lifetime++) {
          await pass(2);
          expect(reply).toHaveBeenCalledTimes(1);
          expect(mockSend).toHaveBeenCalledTimes(1);
          expect(intents("re:A1")).toBe(1);
          expect(await turns(threadA)).toEqual(["A1", "re:A1"]);
          expect(row(a1)?.phase).toBe("completed");
          await host.stop();
          await open();
        }
      }
    );

    // T6. Reproduces: nothing tracked a continuation, so stop() could not wait for one.
    it("drains a retried send that is in flight before stop() resolves, and persists its outcome", async () => {
      const a1 = inbound(1, "A1", 1000);
      mailbox = [a1];
      await open();
      await greet();
      await pass();
      deliver("greeting");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const wallet = mockSend.getMockImplementation()!;
      let entered = false;
      mockSend.mockImplementation(async (params: Send) => {
        entered = true;
        await gate;
        return wallet(params);
      });
      const polling = pollAllBots();
      for (let wait = 0; wait < 20 && !entered; wait++) await settle();
      expect(entered).toBe(true);
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
      await open();
      expect(row(a1)?.phase).toBe("completed");
      expect(await turns(threadA)).toEqual(["A1", "re:A1"]);
      await pass(2);
      expect(intents("re:A1")).toBe(1);
      expect(sends("re:A1")).toBe(2);
      expect(reply).toHaveBeenCalledTimes(1);
    });

    // T8. Pins what must not change: rows written by earlier code have no staged reply, so the
    // continuation never completes, re-sends or regenerates them, whatever the wallet reports.
    it("leaves today's live rows held: no model call, send, completion or history for them, and their conversation is answered", async () => {
      await open();
      await host.stop();
      const call = {
        recipient: peer.address.toLowerCase(),
        conversationId: threadA,
        stampValue: "1",
      };
      const shapes = [
        [{ ...call, digest: "d1".repeat(32), observation: "delivered" }],
        [{ ...call, digest: "d2".repeat(32), observation: "live" }],
        [call],
      ].map((replies, index) => ({
        version: 1,
        digest: (index + 1).toString(16).padStart(64, "0"),
        peerSubject: peer.signingKey.compressedPublicKey.slice(2),
        peerAddress: peer.address.toLowerCase(),
        conversationId: threadA,
        messageId: "00000000-0000-0000-0000-00000000000" + (index + 1),
        receivedTime: t0 + 100 + index,
        phase: "started",
        replies,
      }));
      const seeded = await LevelBotStateStore.open(
        join(root, "bots", "qwen", "state")
      );
      await seeded.batch(
        shapes.map((shape) => ({
          type: "put" as const,
          key: rowKey(shape.digest),
          value: JSON.stringify(shape),
        }))
      );
      await seeded.close();
      const next = inbound(0x50, "N", 5000);
      mailbox = [next];
      await open();
      await pass(3);
      expect(prompts()).toEqual(["N"]);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(await turns(threadA)).toEqual(["N", "re:N"]);
      expect(scans()[scans().length - 1]).toBe(next.receivedTime + 1);
      for (const shape of shapes) {
        expect(
          await qwen().state.get("digest:" + shape.digest)
        ).toBeUndefined();
        expect(qwen().operations.get(shape.digest)).toMatchObject({
          phase: "started",
          replies: [{ stampValue: "1" }],
        });
      }
      // Apart from the wallet's newer observation of the live one, byte for byte unchanged.
      expect(await qwen().state.get(rowKey(shapes[0].digest))).toBe(
        JSON.stringify(shapes[0])
      );
      expect(await qwen().state.get(rowKey(shapes[2].digest))).toBe(
        JSON.stringify(shapes[2])
      );
      expect(qwen().operations.get(shapes[1].digest)?.replies[0]).toEqual({
        ...shapes[1].replies[0],
        observation: "unknown",
      });
    });
  });
});

// The label consumer against the wallet that sets the label. Real typed custody, real wallet
// journals, real directory admission and sealing, the real pending-attempt refusal; the chain
// RPC and the relay's HTTP answer are offline stand-ins, as in the wallet's own canonical suite.
describe("with the real canonical wallet", () => {
  jest.setTimeout(30_000);
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
  afterEach(async () => {
    await host?.stop();
    for (const close of closers.splice(0)) await close().catch(() => undefined);
    mockBalances.clear();
  });

  // Reproduces the live failure's third slot: a second reply sent while the first was linked
  // and undelivered was refused by the wallet before anything existed for it, and the host
  // kept its slot without a digest for ever, the answer unsent and no history written.
  it("retracts a reply the wallet's pending check refused, and sends it once after the earlier reply delivers", async () => {
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
    expect(created).toEqual([botWallet]);
    const user = (await chain.createWallet(roots())) as EvmChainWalletHandle;
    closers.push(() => user.close());
    // Stand-in for confirmed funding: single-use accounts the offline RPC reports as funded.
    for (const record of botWallet.pool.ensureSize(4))
      mockBalances.set(record.address.toLowerCase(), 187_500n + 600n);
    await botWallet.pool.flush();

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
    // The relay answers "retained" (accepted, not delivered) until told otherwise.
    let phase: "retained" | "delivered" = "retained";
    const submitted: string[] = [];
    const fetch: CanonicalFetch = async (url, init) => {
      const request = {
        body: new Uint8Array(init.body!),
        contentType: init.headers["Content-Type"],
      };
      const identity = restoreCanonicalRequest(request).identity;
      submitted.push(identity.payload_hash);
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
    actual.installCanonicalDirectory(botWallet, {
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

    const threads = [
      "0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a",
      "0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b",
    ];
    const prompt = (index: number): DirectMessageReceived => ({
      ...message(),
      senderAddress: user.identity.address,
      senderPublicKey: user.identity.compressedPubKey,
      conversationId: threads[index],
      messageId: (index + 1).toString(16).padStart(32, "0"),
      payloadDigest: (index + 1).toString(16).padStart(64, "0"),
      receivedTime: Date.now() + index,
      items: [{ type: "text", text: "P" + (index + 1) }],
    });
    const prompts = [prompt(0), prompt(1)];
    const history = async (index: number) => {
      const raw = await qwen().state.get(
        "qwen-history:v1:" +
          JSON.stringify([
            "monad-testnet",
            Buffer.from(local.compressedPubKey).toString("hex"),
            peerEntry.subject,
            threads[index],
          ])
      );
      return (
        raw &&
        JSON.parse(raw).messages.map(
          (turn: { content: string }) => turn.content
        )
      );
    };
    const rowOf = (index: number) =>
      qwen().operations.get(prompts[index].payloadDigest)!;
    const pass = async () => {
      await (host as unknown as { pollAllBots(): Promise<void> }).pollAllBots();
      await drain();
    };
    reply.mockImplementation(async (turnsSoFar: { content: string }[]) => ({
      content: "re:" + turnsSoFar[turnsSoFar.length - 1].content,
    }));

    // P1: linked, signed, offered to the relay, not delivered. The wallet reports pending.
    mockFetch.mockImplementation(async () => [prompts[0]]);
    await pass();
    const first = rowOf(0).replies[0].digest;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toBeInstanceOf(MonadStampPendingAttemptError);
    expect(isDirectMessageNotAttempted(rejections[0])).toBe(false);
    expect(submitted).toEqual([first]);

    // P2, another conversation: refused by the wallet's own pending check, with its label.
    mockFetch.mockImplementation(async () => prompts);
    await pass();
    expect(reply).toHaveBeenCalledTimes(2);
    expect(rejections.length).toBeGreaterThanOrEqual(2);
    for (const refusal of rejections.slice(1)) {
      expect(refusal).toBeInstanceOf(MonadStampPendingAttemptError);
      expect(isDirectMessageNotAttempted(refusal)).toBe(true);
    }
    expect(rowOf(1)).toMatchObject({ phase: "started", replies: [] });
    expect(rowOf(1).prepared).toBeDefined();
    expect(await stagedText(prompts[1].payloadDigest)).toBe("re:P2");
    // Only the first reply's own bytes ever reached the relay; nothing exists for the second.
    expect(new Set(submitted)).toEqual(new Set([first]));
    expect(
      await chain.directMessages.unattributedAttempts({
        wallet: botWallet,
        knownDigests: [first!],
      })
    ).toEqual([]);
    expect(await history(0)).toBeUndefined();
    expect(await history(1)).toBeUndefined();
    // Pin (#1310 item 3). Guards: a refused reply leaving an intent or attempt in the wallet's
    // link journal, which payment sets at the relay alone would not show: only the first exists.
    expect(
      await chain.directMessages.unattributedAttempts({
        wallet: botWallet,
        knownDigests: [],
      })
    ).toEqual([first]);

    // The relay delivers the first reply: it commits, and the second is sent, once.
    phase = "delivered";
    await pass();
    await pass();
    expect(await history(0)).toEqual(["P1", "re:P1"]);
    expect(await history(1)).toEqual(["P2", "re:P2"]);
    const second = rowOf(1).replies[0].digest;
    expect(rowOf(0)).toMatchObject({ phase: "completed" });
    expect(rowOf(1)).toMatchObject({
      phase: "completed",
      replies: [{ observation: "delivered" }],
    });
    expect(second).not.toBe(first);
    // Exactly two payment sets over the whole run, one per reply.
    expect(new Set(submitted)).toEqual(new Set([first, second]));
    expect(submitted.filter((hash) => hash === second)).toHaveLength(1);
    expect(reply).toHaveBeenCalledTimes(2);
    await pass();
    expect(new Set(submitted)).toEqual(new Set([first, second]));
    // The wallet's link journal agrees: no intent outside the two replies' own digests.
    expect(
      await chain.directMessages.unattributedAttempts({
        wallet: botWallet,
        knownDigests: [first, second],
      })
    ).toEqual([]);
  });
});
