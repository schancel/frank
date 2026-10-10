import { Wallet, getBytes } from "ethers";
import type { MonadRootBundle } from "@frank/wallet/monad-wallet-material";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { FrankBotHost } from "../src/bot-host";
import { provisionBotProfile } from "../src/bot-profile-admission";
import type {
  FrankBotDefinition,
  BotMessageContext,
  PreparedReply,
} from "../src/types";

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
    createEvmChain: jest.fn(() => ({
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

  describe("Retention before dispatch", () => {
    // Reproduces: handlers ran in the wallet's fetch order (time only, ties arbitrary), and a
    // later message of the batch was not durable until its own handler was about to run.
    it("retains a whole batch durably, then handles it in (receivedTime, digest) order", async () => {
      const handled: string[] = [];
      const retainedAtFirstHandler: (string | undefined)[] = [];
      const base = Date.now();
      const incoming = (digit: string, offset: number) => ({
        senderAddress: { raw: mockPeer.address.toLowerCase() },
        senderPublicKey: getBytes(mockPeer.signingKey.compressedPublicKey),
        recipientPublicKey: getBytes("0x" + mockLocalSubject),
        messageId: digit.repeat(32),
        recipientAddress: { raw: mockLocalAddress },
        items: [{ type: "text", text: digit }],
        conversationId: "01010101-0101-0101-0101-010101010101",
        payloadDigest: digit.repeat(64),
        receivedTime: base + offset,
      });
      const host = new FrankBotHost({
        relayBaseUrl: "http://127.0.0.1:8098",
        stateDir: `${stateDir}/retention-order`,
      });
      const dummyBot: FrankBotDefinition = {
        id: "order-bot",
        getProfile: () => ({ name: "OrderBot", bot: true }),
        onMessage: async (msg) => {
          if (!handled.length)
            for (const digit of ["5", "6", "7", "8"])
              retainedAtFirstHandler.push(
                await instance.state.get(
                  "host-inbound:v1:dispatch:" + digit.repeat(64)
                )
              );
          handled.push(msg.payloadDigest[0]);
          return [];
        },
      };
      await host.register(dummyBot);
      const instance = (host as any).instances.get("order-bot");

      mockDirectMessagesFetchSince.mockResolvedValueOnce([
        incoming("8", 300),
        incoming("7", 200),
        incoming("6", 200),
        incoming("5", 100),
      ]);
      await (host as any).pollAllBots();
      await instance.peerQueue.enqueue(
        mockPeer.address.toLowerCase(),
        async () => {}
      );

      expect(handled).toEqual(["5", "6", "7", "8"]);
      expect(retainedAtFirstHandler.every((row) => row !== undefined)).toBe(
        true
      );
      expect(await instance.state.get("cursor:lastPollTimestamp")).toBe(
        String(base + 301)
      );

      await host.stop();
    });
  });

  describe("Prepared replies", () => {
    const other = new Wallet("0x" + "13".repeat(32));
    const incoming = (
      digit: string,
      sender: Wallet,
      conversationId = "01010101-0101-0101-0101-010101010101"
    ) => ({
      senderAddress: { raw: sender.address.toLowerCase() },
      senderPublicKey: getBytes(sender.signingKey.compressedPublicKey),
      recipientPublicKey: getBytes("0x" + mockLocalSubject),
      messageId: digit.repeat(32),
      recipientAddress: { raw: mockLocalAddress },
      items: [{ type: "text", text: digit }],
      conversationId,
      payloadDigest: digit.repeat(64),
      receivedTime: Date.now() + 1000 + Number(digit),
    });
    const prepared = (text: string, key = "plugin:shared"): PreparedReply => ({
      kind: "prepared-reply",
      text,
      commit: { key, expectedSha256: null, value: "value of " + text },
    });
    const drain = async (instance: { tasks: Set<Promise<unknown>> }) => {
      for (
        let tasks = [...instance.tasks];
        tasks.length;
        tasks = [...instance.tasks]
      )
        await Promise.allSettled(tasks);
    };

    // T17. Pins the rule: a prepared reply is the invocation's only reply. On the base the
    // returned object was not a reply at all and the invocation completed as if nothing was said.
    it("holds a handler that returns a prepared reply after it already replied, staging and sending nothing more", async () => {
      const dummyBot: FrankBotDefinition = {
        id: "both-bot",
        getProfile: () => ({ name: "BothBot", bot: true }),
        onMessage: async (msg) => {
          await msg.reply([{ type: "text", text: "direct" } as any]);
          return prepared("staged");
        },
      };
      const host = new FrankBotHost({
        relayBaseUrl: "http://127.0.0.1:8098",
        stateDir: `${stateDir}/reply-then-prepared`,
      });
      await host.register(dummyBot);
      const instance = (host as any).instances.get("both-bot");
      const message = incoming("6", mockPeer);
      mockDirectMessagesFetchSince.mockResolvedValue([message]);
      for (let pass = 0; pass < 3; pass++) {
        await (host as any).pollAllBots();
        await drain(instance);
      }
      expect(mockDirectMessagesSend).toHaveBeenCalledTimes(1);
      expect(mockDirectMessagesSend.mock.calls[0][0].items).toEqual([
        { type: "text", text: "direct" },
      ]);
      const row = instance.operations.get(message.payloadDigest);
      expect(row).toMatchObject({
        phase: "started",
        replies: [{ observation: "delivered" }],
      });
      expect(row.prepared).toBeUndefined();
      expect(await instance.state.readEntries("host-prepared:")).toEqual([]);
      expect(await instance.state.get("plugin:shared")).toBeUndefined();
      expect(
        await instance.state.get("digest:" + message.payloadDigest)
      ).toBeUndefined();
      await host.stop();
    });

    // T18. Pins the rule: one owed reply per commit key. On the base nothing was staged and no
    // key was committed by the host at all.
    it("refuses the second of two conversations that stage a commit to one key before any send, and completes the first", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const original = mockDirectMessagesSend.getMockImplementation()!;
      mockDirectMessagesSend.mockImplementation(async (params: any) => {
        await gate;
        return original(params);
      });
      let handled = 0;
      const dummyBot: FrankBotDefinition = {
        id: "shared-key-bot",
        getProfile: () => ({ name: "SharedKeyBot", bot: true }),
        onMessage: async (msg) => {
          handled++;
          return prepared("answer " + (msg.items[0] as any).text);
        },
      };
      const host = new FrankBotHost({
        relayBaseUrl: "http://127.0.0.1:8098",
        stateDir: `${stateDir}/shared-key`,
      });
      await host.register(dummyBot);
      const instance = (host as any).instances.get("shared-key-bot");
      const first = incoming("7", mockPeer);
      const second = incoming("8", other);
      mockDirectMessagesFetchSince.mockResolvedValue([first, second]);
      await (host as any).pollAllBots();
      // The first reply's send is in flight, slot persisted and not yet linked.
      for (
        let wait = 0;
        wait < 100 && !mockDirectMessagesSend.mock.calls.length;
        wait++
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      await instance.peerQueue.enqueue(other.address, async () => {});
      expect(handled).toBe(2);
      expect(instance.operations.get(first.payloadDigest)).toMatchObject({
        prepared: { stateKey: "plugin:shared" },
        replies: [{ stampValue: "10000000000000000" }],
      });
      expect(
        instance.operations.get(second.payloadDigest).prepared
      ).toBeUndefined();
      release();
      for (let pass = 0; pass < 3; pass++) {
        await drain(instance);
        await (host as any).pollAllBots();
      }
      await drain(instance);
      expect(handled).toBe(2);
      expect(mockDirectMessagesSend).toHaveBeenCalledTimes(1);
      expect(mockDirectMessagesSend.mock.calls[0][0]).toMatchObject({
        items: [{ type: "text", text: "answer 7" }],
        stampValue: 10_000_000_000_000_000n,
        conversationId: first.conversationId,
      });
      expect(await instance.state.get("plugin:shared")).toBe(
        "value of answer 7"
      );
      expect(instance.operations.get(first.payloadDigest).phase).toBe(
        "completed"
      );
      expect(instance.operations.get(second.payloadDigest)).toMatchObject({
        phase: "started",
        replies: [],
      });
      expect(await instance.state.readEntries("host-prepared:")).toEqual([]);
      await host.stop();
    });

    // #1323. The wallet now answers `dead` for an attempt its relay ended (before, such an
    // attempt read `live` for good and every later reply was refused behind it). Pins what the
    // host does with that answer: the reply keeps its slot, so it is never sent again as a fresh
    // payment and never taken back, its staged answer and commit stay uncommitted, and a later
    // reply is sent.
    it("pin: records a relay-ended reply as dead, never sends it again or takes it back, and sends a later reply", async () => {
      const endedDigest = "ee".repeat(32);
      mockDirectMessagesSend.mockImplementationOnce(
        async (params: {
          onAttemptCreated?: (digest: string) => Promise<void>;
        }) => {
          await params.onAttemptCreated?.(endedDigest);
          // The wallet's rejection for an ended attempt carries no not-attempted label.
          throw new Error("The relay ended this payment set");
        }
      );
      const dummyBot: FrankBotDefinition = {
        id: "ended-reply-bot",
        getProfile: () => ({ name: "EndedReplyBot", bot: true }),
        onMessage: async (msg) => {
          const text = (msg.items[0] as any).text;
          return prepared("answer " + text, "plugin:" + text);
        },
      };
      const host = new FrankBotHost({
        relayBaseUrl: "http://127.0.0.1:8098",
        stateDir: `${stateDir}/ended-reply`,
      });
      await host.register(dummyBot);
      const instance = (host as any).instances.get("ended-reply-bot");
      const reconcile = jest.fn(
        async ({ payloadDigests }: { payloadDigests: string[] }) =>
          Object.fromEntries(
            payloadDigests.map((digest) => [
              digest,
              digest === endedDigest ? "dead" : "delivered",
            ])
          )
      );
      (host as any).chain.directMessages.reconcileAttempts = reconcile;
      const retract = jest.spyOn(instance.operations, "retractReply");
      const first = incoming("7", mockPeer);
      mockDirectMessagesFetchSince.mockResolvedValue([first]);
      for (let pass = 0; pass < 4; pass++) {
        await (host as any).pollAllBots();
        await drain(instance);
      }
      expect(mockDirectMessagesSend).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith(
        expect.objectContaining({ payloadDigests: [endedDigest] })
      );
      expect(instance.operations.get(first.payloadDigest)).toMatchObject({
        phase: "started",
        prepared: { stateKey: "plugin:7" },
        replies: [{ digest: endedDigest, observation: "dead" }],
      });
      expect(await instance.state.get("plugin:7")).toBeUndefined();
      // Its staged text and value are both kept.
      expect(await instance.state.readEntries("host-prepared:")).toHaveLength(
        2
      );

      const second = incoming("8", other);
      mockDirectMessagesFetchSince.mockResolvedValue([first, second]);
      for (let pass = 0; pass < 4; pass++) {
        await (host as any).pollAllBots();
        await drain(instance);
      }
      expect(mockDirectMessagesSend).toHaveBeenCalledTimes(2);
      expect(mockDirectMessagesSend.mock.calls[1][0].items).toEqual([
        { type: "text", text: "answer 8" },
      ]);
      expect(instance.operations.get(second.payloadDigest).phase).toBe(
        "completed"
      );
      expect(await instance.state.get("plugin:8")).toBe("value of answer 8");
      // The ended reply is exactly as it was.
      expect(instance.operations.get(first.payloadDigest)).toMatchObject({
        phase: "started",
        replies: [{ digest: endedDigest, observation: "dead" }],
      });
      expect(await instance.state.get("plugin:7")).toBeUndefined();
      expect(await instance.state.readEntries("host-prepared:")).toHaveLength(
        2
      );
      expect(retract).not.toHaveBeenCalled();
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

  describe("Faucet messaging account funding", () => {
    // The faucet pays grants straight from the funding wallet, but its welcome message is paid
    // like any bot's: from stamp accounts funded by its own receive address.
    it("funds the faucet's receive address so its welcome message can be paid, and nothing else", async () => {
      const faucet: FrankBotDefinition = {
        id: "faucet",
        getProfile: () => ({ name: "Faucet", bot: true }),
        onMessage: async () => [],
      };
      const receive = "0x8888888888888888888888888888888888888888";
      mockGetReceiveAddress.mockResolvedValue({ raw: receive });
      const mockSendTransaction = jest.fn().mockResolvedValue({
        wait: jest.fn().mockResolvedValue({}),
      });
      const host = new FrankBotHost({
        relayBaseUrl: "http://127.0.0.1:8098",
        stateDir: `${stateDir}/faucet-fund-test`,
        fundingPrivateKeyHex: "0x" + "22".repeat(32),
      });
      (host as any).provider = {
        getBalance: jest.fn((addr: string) =>
          Promise.resolve(
            addr === "0x1111111111111111111111111111111111111111"
              ? 5_000_000_000_000_000_000n
              : 0n
          )
        ),
      };
      (host as any).fundingWallet = {
        address: "0x1111111111111111111111111111111111111111",
        sendTransaction: mockSendTransaction,
      };
      (host as any).nonceSequencer = {
        withNonce: (run: (nonce: number) => Promise<void>) => run(0),
      };
      await host.register(faucet);

      expect(mockSendTransaction).toHaveBeenCalledTimes(1);
      expect(mockSendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          to: receive,
          value: 500_000_000_000_000_000n,
        })
      );
      await host.stop();
    });
  });

  describe("A bot's own sent messages in its mailbox", () => {
    // The mailbox scan returns what the bot sent as well as what it received. Its own sends are
    // not inbound work and not an anomaly: every poll used to warn about each of them.
    it("are skipped without a warning and without running a handler", async () => {
      const onMessage = jest.fn();
      const bot: FrankBotDefinition = {
        id: "own-sends-bot",
        getProfile: () => ({ name: "OwnSends", bot: true }),
        onMessage,
      };
      const host = new FrankBotHost({
        relayBaseUrl: "http://127.0.0.1:8098",
        stateDir: `${stateDir}/own-sends-test`,
      });
      await host.register(bot);
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        mockDirectMessagesFetchSince.mockResolvedValueOnce([
          {
            outbound: true,
            senderAddress: { raw: mockLocalAddress },
            senderPublicKey: getBytes("0x" + mockLocalSubject),
            recipientPublicKey: getBytes(
              mockPeer.signingKey.compressedPublicKey
            ),
            recipientAddress: { raw: mockPeer.address.toLowerCase() },
            messageId: "03030303-0303-0303-0303-030303030303",
            conversationId: "01010101-0101-0101-0101-010101010101",
            items: [{ type: "text", text: "welcome" }],
            payloadDigest: "55".repeat(32),
            receivedTime: Date.now(),
          },
        ]);
        await (host as any).pollAllBots();
        expect(onMessage).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
        await host.stop();
      }
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

  // #1235 Stage 3. On main dce4bedf `pollOnce` never calls the wallet's re-observation: the
  // first three tests fail there (the mock is never called). The last is a pin: every other
  // test in this file already polls with a wallet handle that has no such method.
  describe("Native re-observation at the poll", () => {
    const bot: FrankBotDefinition = {
      id: "reobserve-bot",
      getProfile: () => ({ name: "ReobserveBot", bot: true }),
      onMessage: async () => undefined,
    };
    const registered = async (name: string) => {
      const host = new FrankBotHost({
        relayBaseUrl: "http://127.0.0.1:8098",
        stateDir: `${stateDir}/${name}`,
      });
      await host.register(bot);
      const instance = (host as any).instances.get("reobserve-bot");
      mockDirectMessagesFetchSince.mockResolvedValue([]);
      return { host, instance };
    };

    it("calls it once per poll, after the recovery loop and before the mailbox fetch", async () => {
      const { host, instance } = await registered("reobserve-order");
      const order: string[] = [];
      // One incomplete operation with a linked reply, so the recovery loop has work.
      jest.spyOn(instance.operations, "listIncomplete").mockReturnValue([
        {
          digest: "aa".repeat(32),
          replies: [{ digest: "bb".repeat(32), observation: "unknown" }],
        },
      ]);
      jest
        .spyOn(instance.operations, "observe")
        .mockImplementation(async () => void order.push("recovery recorded"));
      (host as any).chain.directMessages.reconcileAttempts = jest.fn(
        async () => {
          order.push("recovery read");
          return {};
        }
      );
      instance.wallet.reobserveNativeOperations = jest.fn(async () => {
        order.push("reobserve");
      });
      mockDirectMessagesFetchSince.mockImplementation(async () => {
        order.push("fetch");
        return [];
      });
      await (host as any).pollAllBots();
      expect(order).toEqual([
        "recovery read",
        "recovery recorded",
        "reobserve",
        "fetch",
      ]);
      await (host as any).pollAllBots();
      expect(instance.wallet.reobserveNativeOperations).toHaveBeenCalledTimes(2);
      expect(instance.wallet.reobserveNativeOperations).toHaveBeenCalledWith();
    });

    it("does not wait for it: a re-observation that never settles does not hold the poll", async () => {
      const { host, instance } = await registered("reobserve-unawaited");
      instance.wallet.reobserveNativeOperations = jest.fn(
        () => new Promise<void>(() => undefined)
      );
      await (host as any).pollAllBots();
      await (host as any).pollAllBots();
      expect(instance.wallet.reobserveNativeOperations).toHaveBeenCalledTimes(2);
      expect(mockDirectMessagesFetchSince).toHaveBeenCalledTimes(2);
    });

    it("survives its failure: a rejection or a synchronous throw neither breaks the poll nor goes unhandled", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => void unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const { host, instance } = await registered("reobserve-failure");
        instance.wallet.reobserveNativeOperations = jest
          .fn()
          .mockRejectedValueOnce(new Error("fixture: node unavailable"))
          .mockImplementationOnce(() => {
            throw new Error("fixture: wallet closed");
          });
        await expect((host as any).pollAllBots()).resolves.toBeUndefined();
        await expect((host as any).pollAllBots()).resolves.toBeUndefined();
        await new Promise((resolve) => setImmediate(resolve));
        expect(instance.wallet.reobserveNativeOperations).toHaveBeenCalledTimes(
          2
        );
        expect(mockDirectMessagesFetchSince).toHaveBeenCalledTimes(2);
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("pin: a wallet handle without the method has nothing to do, and the poll fetches as before", async () => {
      const { host, instance } = await registered("reobserve-absent");
      expect(instance.wallet.reobserveNativeOperations).toBeUndefined();
      await expect((host as any).pollAllBots()).resolves.toBeUndefined();
      expect(mockDirectMessagesFetchSince).toHaveBeenCalledTimes(1);
    });
  });
  // A launcher that must publish a bot's address before the bot runs creates the profile through
  // `provisionBotProfile`. The host admits that profile, and keeps refusing one that something
  // else wrote, which is what the demo launcher used to leave behind.
  describe("Profile provisioning ahead of the host", () => {
    const bot = (
      id: string,
      defaultIdentityPath?: string
    ): FrankBotDefinition => ({
      id,
      defaultIdentityPath,
      getProfile: () => ({ name: id, bot: true }),
      onMessage: async () => [],
    });
    const held = /Bot invocation admission held/;
    let root: string;
    beforeEach(() => {
      root = `${stateDir}/provision-${Math.random().toString(36).slice(2)}`;
    });
    const host = () =>
      new FrankBotHost({
        relayBaseUrl: "http://127.0.0.1:8098",
        stateDir: root,
        watchRegistrations: false,
      });

    it("registers a provisioned profile at the provisioned address, and again after a restart", async () => {
      const identityPath = `${root}/identity.json`;
      const location = {
        stateDir: root,
        botId: "provisioned",
        identityPath,
        networkTag: "MONT",
      };
      const identity = await provisionBotProfile(location);
      // The launcher's exported copy, written after the profile exists.
      writeFileSync(identityPath, "{}");
      expect((await provisionBotProfile(location)).address.raw).toBe(
        identity.address.raw
      );

      for (let start = 0; start < 2; start++) {
        const running = host();
        await running.register(bot("provisioned", identityPath));
        expect(mockLocalAddress).toBe(identity.address.raw);
        await running.stop();
      }
    });

    it("refuses an identity file or an account root that it did not create, from the host and from provisioning alike", async () => {
      const identityPath = `${root}/identity.json`;
      mkdirSync(root, { recursive: true });
      writeFileSync(identityPath, "{}");
      await expect(
        provisionBotProfile({
          stateDir: root,
          botId: "foreign-identity",
          identityPath,
          networkTag: "MONT",
        })
      ).rejects.toThrow(held);
      await expect(
        host().register(bot("foreign-identity-host", identityPath))
      ).rejects.toThrow(held);

      for (const id of ["foreign-root", "foreign-root-host"]) {
        mkdirSync(`${root}/bots/${id}`, { recursive: true });
        writeFileSync(`${root}/bots/${id}/account-root.hex`, "ab".repeat(32));
      }
      await expect(
        provisionBotProfile({
          stateDir: root,
          botId: "foreign-root",
          networkTag: "MONT",
        })
      ).rejects.toThrow(held);
      await expect(
        host().register(bot("foreign-root-host"))
      ).rejects.toThrow(held);
      expect(
        readFileSync(`${root}/bots/foreign-root/account-root.hex`, "utf8")
      ).toBe("ab".repeat(32));
    });

    it("refuses a network it does not know, before creating anything", async () => {
      await expect(
        provisionBotProfile({
          stateDir: root,
          botId: "unknown-network",
          networkTag: "monad",
        })
      ).rejects.toThrow(/Unknown installed Monad network descriptor/);
      expect(existsSync(root)).toBe(false);
    });
  });
});
