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
    createMonadChain: () => ({
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
const poll = async () => {
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
    await instance.peerQueue.enqueue(peer.address, async () => {});
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
  jest
    .spyOn(LevelBotStateStore.prototype, "put")
    .mockImplementation(function (key, value) {
      if (key.startsWith("history:"))
        return Promise.reject(new Error("history unavailable"));
      return original.call(this, key, value);
    });
  await poll();
  await poll();
  await host.stop();
  await open();
  await poll();
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
  { senderPublicKey: new Uint8Array(33) },
  { recipientPublicKey: undefined },
  { outbound: true },
])(
  "does not run Qwen for unsupported authenticated context %s",
  async (change) => {
    await open();
    mockFetch.mockImplementation(async () => [{ ...message(), ...change }]);
    await poll();
    expect(reply).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
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
