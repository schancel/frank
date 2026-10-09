/**
 * What a handler is told about the message it answers, and what happens to its reply, through
 * the real host: poll, retention, dispatch and the journal are the host's own. Only the chain's
 * direct-message client, the directory and the relay profile call are replaced.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Wallet, getBytes } from "ethers";
import type { MonadRootBundle } from "@frank/wallet/monad-wallet-material";
import { FrankBotHost } from "../src/bot-host";
import type {
  BotHostOptions,
  BotMessageContext,
  FrankBotDefinition,
} from "../src/types";

jest.mock("../src/relay-profile-manager", () => ({
  RelayProfileManager: {
    registerProfile: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock("../src/directory-manager", () => ({
  DirectoryManager: {
    create: jest.fn(() => ({
      network: "monad-testnet",
      publish: jest.fn().mockResolvedValue(undefined),
      publishWithRetry: jest.fn().mockResolvedValue(undefined),
      startHeartbeat: jest.fn(),
      rawDirectory: {},
      lookupPeer: jest.fn(),
      close: jest.fn(),
    })),
  },
}));

const mockSend = jest.fn();
const mockFetchSince = jest.fn();
const mockReconcile = jest.fn();
let mockLocalAddress = "";
let mockLocalSubject = "";
jest.mock("@frank/wallet/chain/monad-chain", () => {
  const actual = jest.requireActual("@frank/wallet/chain/monad-chain");
  return {
    ...actual,
    createEvmChain: jest.fn(() => ({
      chainIdentifier: "monad-testnet",
      directMessages: {
        fetchSince: mockFetchSince,
        send: mockSend,
        reconcileAttempts: mockReconcile,
      },
      topics: { post: jest.fn() },
      createWallet: jest.fn(async (roots: MonadRootBundle) => {
        const { MonadIdentity } = jest.requireActual<
          typeof import("@frank/wallet/monad-identity")
        >("@frank/wallet/monad-identity");
        const identity = MonadIdentity.fromDomainRoot(roots.authentication);
        mockLocalAddress = identity.address.raw;
        mockLocalSubject = identity.compressedPubKey.toString("hex");
        return {
          identity,
          getReceiveAddress: jest.fn(async () => ({ raw: mockLocalAddress })),
          close: jest.fn().mockResolvedValue(undefined),
        };
      }),
    })),
    installCanonicalDirectory: jest.fn(() => () => {}),
    loadMonadChainConfigFromEnv: jest.fn(() => ({
      networkTag: "MONT",
      relayBaseUrl: "http://127.0.0.1:8098",
      defaultStampValueWei: 10_000_000_000_000_000n,
    })),
  };
});

const STAMP = 10_000_000_000_000_000n;
const peer = new Wallet("0x" + "12".repeat(32));
const otherPeer = new Wallet("0x" + "13".repeat(32));

describe("FrankBotHost replies", () => {
  let stateDir: string;
  let originalEnvironment: NodeJS.ProcessEnv;
  let sequence = 0;
  const hosts: FrankBotHost[] = [];

  /** The wallet accepts the send: it reports the attempt, then resolves with its digest. */
  const accept = async (params: {
    stampValue?: bigint;
    onAttemptCreated?: (digest: string) => Promise<void>;
  }) => {
    const payloadDigest = (0xd0 + mockSend.mock.calls.length)
      .toString(16)
      .repeat(32);
    await params.onAttemptCreated?.(payloadDigest);
    return {
      payloadDigest,
      stampValueWei: params.stampValue ?? STAMP,
      stampPayments: [],
      preparationTxHashes: [],
    };
  };

  const inbound = (
    text: string,
    options: { from?: Wallet; stampValueWei?: bigint } = {}
  ) => {
    sequence += 1;
    const byte = sequence.toString(16).padStart(2, "0");
    const from = options.from ?? peer;
    return {
      senderAddress: { raw: from.address.toLowerCase() },
      senderPublicKey: getBytes(from.signingKey.compressedPublicKey),
      recipientPublicKey: getBytes("0x" + mockLocalSubject),
      recipientAddress: { raw: mockLocalAddress },
      messageId: `${byte.repeat(4)}-0202-0202-0202-020202020202`,
      conversationId: "01010101-0101-0101-0101-010101010101",
      items: [{ type: "text", text }],
      payloadDigest: byte.repeat(32),
      stampValueWei: options.stampValueWei,
      stampPayments: [],
      receivedTime: 1_700_000_000_000 + sequence,
    };
  };

  const start = async (
    bot: FrankBotDefinition,
    options: BotHostOptions = {}
  ) => {
    const host = new FrankBotHost({
      relayBaseUrl: "http://127.0.0.1:8098",
      rpcUrl: "http://127.0.0.1:1",
      stateDir,
      watchRegistrations: false,
      ...options,
    });
    hosts.push(host);
    await host.register(bot);
    return { host, instance: (host as any).instances.get(bot.id) };
  };

  /** One poll returning `messages`; resolves once the poll pass itself has finished. */
  const poll = async (host: FrankBotHost, messages: unknown[] = []) => {
    mockFetchSince.mockResolvedValueOnce(messages);
    await (host as any).pollAllBots();
  };

  /** Every handler task the host has started has finished. */
  const drain = async (instance: { tasks: Set<Promise<unknown>> }) => {
    while (instance.tasks.size) await Promise.allSettled([...instance.tasks]);
  };

  /** Waits for something a still-running handler is about to do. */
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 2000 && !condition(); i++)
      await new Promise((r) => setImmediate(r));
    if (!condition()) throw new Error("condition was never met");
  };

  const textsSent = (): string[] =>
    mockSend.mock.calls.map(([params]) => params.items[0].text);

  const bot = (
    id: string,
    onMessage: FrankBotDefinition["onMessage"],
    extra: Partial<FrankBotDefinition> = {}
  ): FrankBotDefinition => ({
    id,
    getProfile: () => ({ name: id, bot: true }),
    onMessage,
    ...extra,
  });

  beforeEach(() => {
    originalEnvironment = process.env;
    process.env = { ...originalEnvironment };
    for (const key of [
      "E2E_DEMO_MAIN_WALLET_PRIVATE_KEY",
      "FRANK_DEMO_FAUCET_WALLET_JSON",
      "E2E_DEMO_MAIN_WALLET_JSON",
      "FRANK_BOT_MAX_REPLIES_PER_PEER",
    ])
      delete process.env[key];
    jest.clearAllMocks();
    sequence = 0;
    mockSend.mockReset().mockImplementation(accept);
    mockFetchSince.mockReset().mockResolvedValue([]);
    mockReconcile.mockReset().mockResolvedValue({});
    stateDir = mkdtempSync(join(tmpdir(), "bot-host-replies-"));
  });

  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.stop();
    rmSync(stateDir, { recursive: true, force: true });
    process.env = originalEnvironment;
    jest.restoreAllMocks();
  });

  describe("the stamp value of the received message", () => {
    // On 46dde097 the handler's context has no such field: every value below is undefined.
    it("reaches the handler as the wallet reported it, and as zero when the wallet reported none", async () => {
      const seen: BotMessageContext[] = [];
      const { host, instance } = await start(
        bot("stamp-bot", async (message) => {
          seen.push(message);
        })
      );

      await poll(host, [
        inbound("paid", { stampValueWei: 25_000_000_000_000_000n }),
        inbound("zero", { stampValueWei: 0n }),
        inbound("absent"),
        inbound("negative", { stampValueWei: -5n }),
        { ...inbound("not a bigint"), stampValueWei: 7 },
      ]);
      await drain(instance);

      expect(seen.map((message) => message.stampValueWei)).toEqual([
        25_000_000_000_000_000n,
        0n,
        0n,
        0n,
        0n,
      ]);
      expect(Reflect.set(seen[0], "stampValueWei", 1n)).toBe(false);
    });
  });
});
