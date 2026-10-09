import { Wallet, getBytes } from "ethers";
import type { MonadRootBundle } from "@frank/wallet/monad-wallet-material";
import { FrankBotHost } from "../src/bot-host";
import type { FrankBotDefinition, BotMessageContext } from "../src/types";

jest.mock("../src/relay-profile-manager", () => ({
  RelayProfileManager: {
    registerProfile: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockDirectMessagesSend = jest.fn();
const mockDirectMessagesFetchSince = jest.fn();
const mockGetReceiveAddress = jest.fn();

let mockLocalAddress = "";
let mockLocalSubject = "";
const mockPeer = new Wallet("0x" + "12".repeat(32));
jest.mock("@frank/wallet/chain/monad-chain", () => {
  const actual = jest.requireActual("@frank/wallet/chain/monad-chain");
  return {
    ...actual,
    createMonadChain: jest.fn(() => ({
      chainIdentifier: "monad-testnet",
      directMessages: {
        fetchSince: mockDirectMessagesFetchSince,
        send: mockDirectMessagesSend,
      },
      topics: {
        post: jest.fn(),
      },
      createWallet: jest
        .fn()
        .mockImplementation(async (roots: MonadRootBundle) => {
          const { MonadIdentity } = jest.requireActual<
            typeof import("@frank/wallet/monad-identity")
          >("@frank/wallet/monad-identity");
          const identity = MonadIdentity.fromDomainRoot(roots.authentication);
          mockLocalAddress = identity.address.raw;
          mockLocalSubject = identity.compressedPubKey.toString("hex");
          return {
            identity,
            getReceiveAddress: mockGetReceiveAddress,
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

describe("FrankBotHost Reliability Features", () => {
  const stateDir =
    "/tmp/test-bot-reliability-" + Math.random().toString(36).slice(2);

  let originalEnvironment: NodeJS.ProcessEnv;
  beforeEach(() => {
    originalEnvironment = process.env;
    process.env = { ...originalEnvironment };
    for (const key of [
      "E2E_DEMO_MAIN_WALLET_PRIVATE_KEY",
      "FRANK_DEMO_FAUCET_WALLET_JSON",
      "E2E_DEMO_MAIN_WALLET_JSON",
    ])
      delete process.env[key];
    jest.clearAllMocks();
    mockDirectMessagesSend.mockImplementation(
      async (params: {
        onAttemptCreated?: (digest: string) => Promise<void>;
      }) => {
        const payloadDigest = mockDirectMessagesSend.mock.calls.length
          .toString(16)
          .padStart(64, "0");
        await params.onAttemptCreated?.(payloadDigest);
        return {
          payloadDigest,
          stampValueWei: 10_000_000_000_000_000n,
          stampPayments: [],
          preparationTxHashes: [],
        };
      }
    );
    mockGetReceiveAddress.mockResolvedValue({
      raw: mockLocalAddress,
    });
  });

  afterEach(() => {
    process.env = originalEnvironment;
  });

  describe("Conversation threading", () => {
    it("threads msg.conversationId through bot reply() and return values", async () => {
      const receivedContexts: BotMessageContext[] = [];
      const substitutedReply = jest.fn();

      const dummyBot: FrankBotDefinition = {
        id: "thread-bot",
        getProfile: () => ({ name: "ThreadBot", bot: true }),
        onMessage: async (msg, ctx) => {
          receivedContexts.push(msg);
          await Promise.resolve();
          for (const [target, key, value] of [
            [msg, "conversationId", "99999999-9999-9999-9999-999999999999"],
            [msg, "peerAddress", new Wallet("0x" + "13".repeat(32)).address],
            [msg, "peerSubject", "aa".repeat(32)],
            [msg, "reply", substitutedReply],
            [ctx, "networkTag", "MON1"],
            [ctx, "subject", "aa".repeat(32)],
            [ctx, "address", new Wallet("0x" + "13".repeat(32)).address],
          ] as const)
            expect(Reflect.set(target, key, value)).toBe(false);
          await msg.reply([
            { type: "text", text: "reply from reply()" } as any,
          ]);
          return [{ type: "text", text: "reply from return" } as any];
        },
      };

      const host = new FrankBotHost({
        relayBaseUrl: "http://127.0.0.1:8098",
        stateDir: `${stateDir}/threading`,
      });

      await host.register(dummyBot);

      mockDirectMessagesFetchSince.mockResolvedValueOnce([
        {
          senderAddress: { raw: mockPeer.address.toLowerCase() },
          senderPublicKey: getBytes(mockPeer.signingKey.compressedPublicKey),
          recipientPublicKey: getBytes("0x" + mockLocalSubject),
          messageId: "02020202-0202-0202-0202-020202020202",
          recipientAddress: {
            raw: mockLocalAddress,
          },
          items: [{ type: "text", text: "Hello bot" }],
          conversationId: "01010101-0101-0101-0101-010101010101",
          payloadDigest:
            "1111111111111111111111111111111111111111111111111111111111111111",
          receivedTime: 1700000000000,
        },
      ]);

      await (host as any).pollAllBots();

      // Allow peerQueue to drain
      const instance = (host as any).instances.get("thread-bot");
      await instance.peerQueue.enqueue(
        mockPeer.address.toLowerCase(),
        async () => {}
      );

      expect(substitutedReply).not.toHaveBeenCalled();
      expect(receivedContexts.length).toBe(1);
      expect(receivedContexts[0].peerSubject).toBe(
        mockPeer.signingKey.compressedPublicKey.slice(2)
      );
      expect(receivedContexts[0].peerSubject).not.toBe(
        receivedContexts[0].payloadDigest
      );
      expect(receivedContexts[0].conversationId).toBe(
        "01010101-0101-0101-0101-010101010101"
      );

      // Verify both replies sent through directMessages.send specified conversationId
      expect(mockDirectMessagesSend).toHaveBeenCalledTimes(2);
      expect(mockDirectMessagesSend).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          conversationId: "01010101-0101-0101-0101-010101010101",
          recipient: expect.objectContaining({ raw: mockPeer.address }),
        })
      );
      expect(mockDirectMessagesSend).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          conversationId: "01010101-0101-0101-0101-010101010101",
          recipient: expect.objectContaining({ raw: mockPeer.address }),
        })
      );

      await host.stop();
    });
  });

  describe("Cursor persistence in LevelDB state", () => {
    it("persists cursor:lastPollTimestamp and restores it on host restart", async () => {
      const dummyBot: FrankBotDefinition = {
        id: "cursor-bot",
        getProfile: () => ({ name: "CursorBot", bot: true }),
        onMessage: async () => [],
      };

      const customStateDir = `${stateDir}/cursor-test`;
      const messageTime = Date.now() + 5000;

      // 1. Initial run
      const host1 = new FrankBotHost({
        relayBaseUrl: "http://127.0.0.1:8098",
        stateDir: customStateDir,
      });

      await host1.register(dummyBot);
      const instance1 = (host1 as any).instances.get("cursor-bot");

      mockDirectMessagesFetchSince.mockResolvedValueOnce([
        {
          senderAddress: { raw: mockPeer.address.toLowerCase() },
          senderPublicKey: getBytes(mockPeer.signingKey.compressedPublicKey),
          recipientPublicKey: getBytes("0x" + mockLocalSubject),
          messageId: "02020202-0202-0202-0202-020202020202",
          recipientAddress: {
            raw: mockLocalAddress,
          },
          items: [{ type: "text", text: "Ping" }],
          conversationId: "01010101-0101-0101-0101-010101010101",
          payloadDigest:
            "2222222222222222222222222222222222222222222222222222222222222222",
          receivedTime: messageTime,
        },
      ]);

      await (host1 as any).pollAllBots();

      // Drain peerQueue
      await instance1.peerQueue.enqueue(
        mockPeer.address.toLowerCase(),
        async () => {}
      );

      const persistedCursor = await instance1.state.get(
        "cursor:lastPollTimestamp"
      );
      expect(persistedCursor).toBe(String(messageTime + 1));

      await host1.stop();

      // 2. Restart bot host with same stateDir
      const host2 = new FrankBotHost({
        relayBaseUrl: "http://127.0.0.1:8098",
        stateDir: customStateDir,
      });

      await host2.register(dummyBot);
      const instance2 = (host2 as any).instances.get("cursor-bot");

      // Verify restored cursor is used as lastPollTimestamp
      expect(instance2.lastPollTimestamp).toBe(messageTime + 1);

      await host2.stop();
    });
  });

  describe("In-flight message deduplication", () => {
    it("tracks in-flight message digests to prevent duplicate processing during overlapping polls", async () => {
      let releaseMessageProcessing!: () => void;
      const pausePromise = new Promise<void>((resolve) => {
        releaseMessageProcessing = resolve;
      });
      let notifyMessageEntered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        notifyMessageEntered = resolve;
      });
      let processCount = 0;

      const dummyBot: FrankBotDefinition = {
        id: "inflight-bot",
        getProfile: () => ({ name: "InflightBot", bot: true }),
        onMessage: async () => {
          processCount++;
          notifyMessageEntered();
          await pausePromise;
          return [];
        },
      };

      const host = new FrankBotHost({
        relayBaseUrl: "http://127.0.0.1:8098",
        stateDir: `${stateDir}/inflight-test`,
      });

      await host.register(dummyBot);
      const instance = (host as any).instances.get("inflight-bot");

      const incomingMsg = {
        senderAddress: { raw: mockPeer.address.toLowerCase() },
        senderPublicKey: getBytes(mockPeer.signingKey.compressedPublicKey),
        recipientPublicKey: getBytes("0x" + mockLocalSubject),
        messageId: "02020202-0202-0202-0202-020202020202",
        recipientAddress: {
          raw: mockLocalAddress,
        },
        items: [{ type: "text", text: "Long-running task" }],
        conversationId: "01010101-0101-0101-0101-010101010101",
        payloadDigest:
          "3333333333333333333333333333333333333333333333333333333333333333",
        receivedTime: Date.now() + 1000,
      };

      // Poll 1: delivers message
      mockDirectMessagesFetchSince.mockResolvedValueOnce([incomingMsg]);
      await (host as any).pollAllBots();

      // Wait until onMessage begins
      await enteredPromise;

      expect(
        instance.inFlightDigests.has(
          "3333333333333333333333333333333333333333333333333333333333333333"
        )
      ).toBe(true);

      // Poll 2: concurrent poll while message is still in-flight
      mockDirectMessagesFetchSince.mockResolvedValueOnce([incomingMsg]);
      await (host as any).pollAllBots();

      // Finish first message processing
      releaseMessageProcessing();
      await instance.peerQueue.enqueue(
        mockPeer.address.toLowerCase(),
        async () => {}
      );

      // Verify onMessage was only dispatched once
      expect(processCount).toBe(1);
      expect(
        instance.inFlightDigests.has(
          "3333333333333333333333333333333333333333333333333333333333333333"
        )
      ).toBe(false);

      // And state store recorded it
      const saved = await instance.state.get(
        "digest:3333333333333333333333333333333333333333333333333333333333333333"
      );
      expect(saved).toBeDefined();

      await host.stop();
    });
  });

  describe("Dual-address funding", () => {
    it("funds both identity address and receive address when they diverge", async () => {
      const dummyBot: FrankBotDefinition = {
        id: "dual-fund-bot",
        getProfile: () => ({ name: "DualFundBot", bot: true }),
        onMessage: async () => [],
      };

      mockGetReceiveAddress.mockResolvedValue({
        raw: "0x9999999999999999999999999999999999999999",
      });

      const mockSendTransaction = jest.fn().mockResolvedValue({
        wait: jest.fn().mockResolvedValue({}),
      });

      const host = new FrankBotHost({
        relayBaseUrl: "http://127.0.0.1:8098",
        stateDir: `${stateDir}/dual-fund-test`,
        fundingPrivateKeyHex: "0x" + "22".repeat(32),
      });

      // Mock provider and funding wallet
      (host as any).provider = {
        getBalance: jest.fn((addr: string) => {
          if (addr.toLowerCase() === mockLocalAddress.toLowerCase()) {
            return Promise.resolve(50_000_000_000_000_000n); // < 0.1 MON
          }
          if (
            addr.toLowerCase() ===
            "0x9999999999999999999999999999999999999999".toLowerCase()
          ) {
            return Promise.resolve(20_000_000_000_000_000n); // < 0.1 MON
          }
          // Main funding wallet balance: 5 MON
          return Promise.resolve(5_000_000_000_000_000_000n);
        }),
      };
      (host as any).fundingWallet = {
        address: "0x1111111111111111111111111111111111111111",
        sendTransaction: mockSendTransaction,
      };

      (host as any).nonceSequencer = {
        withNonce: (run: (nonce: number) => Promise<void>) => run(0),
      };
      await host.register(dummyBot);

      // Should fund both identity address AND receive address
      expect(mockSendTransaction).toHaveBeenCalledTimes(2);
      expect(mockSendTransaction).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          to: mockLocalAddress,
          value: 500_000_000_000_000_000n,
        })
      );
      expect(mockSendTransaction).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          to: "0x9999999999999999999999999999999999999999",
          value: 500_000_000_000_000_000n,
        })
      );

      await host.stop();
    });
  });

  describe("Interrupted handler admission", () => {
    it("holds a failed handler across every subsequent poll without marking it processed", async () => {
      let callCount = 0;
      const dummyBot: FrankBotDefinition = {
        id: "failing-bot",
        getProfile: () => ({ name: "FailingBot", bot: true }),
        onMessage: async () => {
          callCount++;
          throw new Error("Simulated transient RPC failure");
        },
      };

      const host = new FrankBotHost({
        relayBaseUrl: "http://127.0.0.1:8098",
        stateDir: `${stateDir}/poison-loop-test`,
      });

      await host.register(dummyBot);
      const instance = (host as any).instances.get("failing-bot");

      const messageTime = Date.now() + 5000;
      const failingMsg = {
        senderAddress: { raw: mockPeer.address.toLowerCase() },
        senderPublicKey: getBytes(mockPeer.signingKey.compressedPublicKey),
        recipientPublicKey: getBytes("0x" + mockLocalSubject),
        messageId: "02020202-0202-0202-0202-020202020202",
        recipientAddress: { raw: mockLocalAddress },
        items: [{ type: "text", text: "Crash message" }],
        conversationId: "01010101-0101-0101-0101-010101010101",
        payloadDigest:
          "4444444444444444444444444444444444444444444444444444444444444444",
        receivedTime: messageTime,
      };

      for (let i = 0; i < 4; i++) {
        mockDirectMessagesFetchSince.mockResolvedValueOnce([failingMsg]);
        await (host as any).pollAllBots();
        await instance.peerQueue.enqueue(
          mockPeer.address.toLowerCase(),
          async () => {}
        );
        expect(callCount).toBe(1);
        expect(
          await instance.state.get("digest:" + failingMsg.payloadDigest)
        ).toBeUndefined();
        expect(
          await instance.state.get("fail:" + failingMsg.payloadDigest)
        ).toBeUndefined();
        expect(
          await instance.state.get("cursor:lastPollTimestamp")
        ).toBeUndefined();
      }

      await host.stop();
    });
  });
});
