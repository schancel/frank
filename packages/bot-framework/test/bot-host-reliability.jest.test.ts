import { FrankBotHost } from "../src/bot-host";
import { RelayProfileManager } from "../src/relay-profile-manager";
import type {
  FrankBotDefinition,
  BotMessageContext,
  BotContext,
} from "../src/types";

jest.mock("../src/relay-profile-manager", () => ({
  RelayProfileManager: {
    registerProfile: jest.fn().mockResolvedValue(undefined),
  },
}));

let mockDirectMessagesSend = jest.fn();
let mockDirectMessagesFetchSince = jest.fn();
let mockGetReceiveAddress = jest.fn().mockResolvedValue({
  raw: "0x538910cdeadf7e47a6826700ebc860f1a6b3b4d5",
});

jest.mock("@frank/wallet/chain/monad-chain", () => {
  const actual = jest.requireActual("@frank/wallet/chain/monad-chain");
  return {
    ...actual,
    createMonadChain: jest.fn(() => ({
      directMessages: {
        fetchSince: mockDirectMessagesFetchSince,
        send: mockDirectMessagesSend,
      },
      topics: {
        post: jest.fn(),
      },
      createWallet: jest.fn().mockResolvedValue({
        identity: {
          address: { raw: "0x538910cdeadf7e47a6826700ebc860f1a6b3b4d5" },
          compressedPubKey: new Uint8Array(33),
          toPrivateKeyHex: () => "0x" + "11".repeat(32),
        },
        getReceiveAddress: mockGetReceiveAddress,
        close: jest.fn().mockResolvedValue(undefined),
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

  beforeEach(() => {
    jest.clearAllMocks();
    mockDirectMessagesSend.mockResolvedValue({
      payloadDigest: "reply-digest-abc12345",
      stampValueWei: 10_000_000_000_000_000n,
      stampPayments: [],
      preparationTxHashes: [],
    });
    mockGetReceiveAddress.mockResolvedValue({
      raw: "0x538910cdeadf7e47a6826700ebc860f1a6b3b4d5",
    });
  });

  describe("Conversation threading", () => {
    it("threads msg.conversationId through bot reply() and return values", async () => {
      const receivedContexts: BotMessageContext[] = [];

      const dummyBot: FrankBotDefinition = {
        id: "thread-bot",
        getProfile: () => ({ name: "ThreadBot", bot: true }),
        onMessage: async (msg, ctx) => {
          receivedContexts.push(msg);
          await msg.reply([{ type: "text", text: "reply from reply()" } as any]);
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
          senderAddress: { raw: "0x2222222222222222222222222222222222222222" },
          recipientAddress: {
            raw: "0x538910cdeadf7e47a6826700ebc860f1a6b3b4d5",
          },
          items: [{ type: "text", text: "Hello bot" }],
          conversationId: "conv-thread-uuid-9999",
          payloadDigest: "msg-digest-1",
          receivedTime: 1700000000000,
        },
      ]);

      await (host as any).pollAllBots();

      // Allow peerQueue to drain
      const instance = (host as any).instances.get("thread-bot");
      await instance.peerQueue.enqueue("0x2222222222222222222222222222222222222222", async () => {});

      expect(receivedContexts.length).toBe(1);
      expect(receivedContexts[0].conversationId).toBe("conv-thread-uuid-9999");

      // Verify both replies sent through directMessages.send specified conversationId
      expect(mockDirectMessagesSend).toHaveBeenCalledTimes(2);
      expect(mockDirectMessagesSend).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          conversationId: "conv-thread-uuid-9999",
        })
      );
      expect(mockDirectMessagesSend).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          conversationId: "conv-thread-uuid-9999",
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
          senderAddress: { raw: "0x3333333333333333333333333333333333333333" },
          recipientAddress: {
            raw: "0x538910cdeadf7e47a6826700ebc860f1a6b3b4d5",
          },
          items: [{ type: "text", text: "Ping" }],
          conversationId: "conv-1",
          payloadDigest: "cursor-digest-1",
          receivedTime: messageTime,
        },
      ]);

      await (host1 as any).pollAllBots();

      // Drain peerQueue
      await instance1.peerQueue.enqueue("0x3333333333333333333333333333333333333333", async () => {});

      const persistedCursor = await instance1.state.get("cursor:lastPollTimestamp");
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
        senderAddress: { raw: "0x4444444444444444444444444444444444444444" },
        recipientAddress: {
          raw: "0x538910cdeadf7e47a6826700ebc860f1a6b3b4d5",
        },
        items: [{ type: "text", text: "Long-running task" }],
        payloadDigest: "inflight-digest-xyz",
        receivedTime: Date.now() + 1000,
      };

      // Poll 1: delivers message
      mockDirectMessagesFetchSince.mockResolvedValueOnce([incomingMsg]);
      await (host as any).pollAllBots();

      // Wait until onMessage begins
      await enteredPromise;

      expect(instance.inFlightDigests.has("inflight-digest-xyz")).toBe(true);

      // Poll 2: concurrent poll while message is still in-flight
      mockDirectMessagesFetchSince.mockResolvedValueOnce([incomingMsg]);
      await (host as any).pollAllBots();

      // Finish first message processing
      releaseMessageProcessing();
      await instance.peerQueue.enqueue("0x4444444444444444444444444444444444444444", async () => {});

      // Verify onMessage was only dispatched once
      expect(processCount).toBe(1);
      expect(instance.inFlightDigests.has("inflight-digest-xyz")).toBe(false);

      // And state store recorded it
      const saved = await instance.state.get("digest:inflight-digest-xyz");
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
          if (addr.toLowerCase() === "0x538910cdeadf7e47a6826700ebc860f1a6b3b4d5".toLowerCase()) {
            return Promise.resolve(50_000_000_000_000_000n); // < 0.1 MON
          }
          if (addr.toLowerCase() === "0x9999999999999999999999999999999999999999".toLowerCase()) {
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

      await host.register(dummyBot);

      // Should fund both identity address AND receive address
      expect(mockSendTransaction).toHaveBeenCalledTimes(2);
      expect(mockSendTransaction).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          to: "0x538910cdeadf7e47a6826700ebc860f1a6b3b4d5",
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
});
