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
import { directMessageNotAttempted } from "@frank/wallet/chain/active-chain";
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

  /** The wallet's refusal of one send call that created nothing: the label is on the error. */
  const notAttempted = (message: string): Error =>
    Object.defineProperty(new Error(message), directMessageNotAttempted, {
      value: true,
    });

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

  // On 21a868a2 the first refusal fails the handler: the wallet is called once, the row stays
  // started for good and the message is never answered.
  describe("a direct reply the wallet refused without attempting it", () => {
    /** A handler with an effect before its reply and one after, which needs the send result. */
    const paying = (effects: string[]) =>
      bot("refused-bot", async (message, ctx) => {
        effects.push("paid " + message.payloadDigest.slice(0, 2));
        await ctx.state.put("paid:" + message.payloadDigest, "1");
        const sent = await message.reply([{ type: "text", text: "you won" }]);
        effects.push("recorded " + sent.payloadDigest.slice(0, 2));
        await ctx.state.put("recorded:" + message.payloadDigest, "1");
      });

    it("is sent again on a later poll: one reply, the handler and its effects once, one attempt", async () => {
      const effects: string[] = [];
      const { host, instance } = await start(paying(effects));
      const attempts: string[] = [];
      mockSend
        .mockReset()
        .mockRejectedValueOnce(notAttempted("one payment is still open"))
        .mockImplementation(async (params) => {
          const result = await accept(params);
          attempts.push(result.payloadDigest);
          return result;
        });
      const message = inbound("roll");

      await poll(host, [message]);
      await until(() => mockSend.mock.calls.length === 1);
      await poll(host, [message]);
      await drain(instance);

      expect(textsSent()).toEqual(["you won", "you won"]);
      expect(attempts).toHaveLength(1);
      expect(effects).toEqual([
        "paid 01",
        "recorded " + attempts[0].slice(0, 2),
      ]);
      const row = instance.operations.get(message.payloadDigest);
      expect(row.phase).toBe("completed");
      expect(row.replies).toEqual([
        expect.objectContaining({
          digest: attempts[0],
          observation: "delivered",
        }),
      ]);

      // Nothing is left to send: later polls that return the message again do nothing.
      await poll(host, [message]);
      await poll(host, [message]);
      await drain(instance);
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(effects).toHaveLength(2);
    });

    it("waits for a poll: the handler stays suspended, and other peers are answered meanwhile", async () => {
      const effects: string[] = [];
      const { host, instance } = await start(paying(effects));
      mockSend.mockReset().mockImplementation(async (params) => {
        if (params.recipient.raw === peer.address)
          throw notAttempted("one payment is still open");
        return accept(params);
      });
      const waiting = inbound("roll");
      const other = inbound("roll", { from: otherPeer });

      await poll(host, [waiting, other]);
      await until(
        () =>
          instance.operations.get(other.payloadDigest)?.phase === "completed"
      );

      expect(effects).toEqual([
        "paid 01",
        "paid 02",
        expect.stringMatching(/^recorded/),
      ]);
      expect(instance.operations.get(other.payloadDigest).phase).toBe(
        "completed"
      );
      expect(instance.operations.get(waiting.payloadDigest).phase).toBe(
        "started"
      );
      // Without a poll nothing is sent again, however long the handler waits.
      await new Promise((r) => setTimeout(r, 50));
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("stops after five refused sends: the message is held, logged, and never sent again", async () => {
      const effects: string[] = [];
      const { host, instance } = await start(paying(effects));
      const error = jest.spyOn(console, "error").mockImplementation(() => {});
      mockSend.mockReset().mockImplementation(async () => {
        throw notAttempted("one payment is still open");
      });
      const message = inbound("roll");

      for (let sends = 1; sends <= 5; sends++) {
        await poll(host, [message]);
        await until(() => mockSend.mock.calls.length === sends);
      }
      await drain(instance);
      for (let i = 0; i < 3; i++) await poll(host, [message]);
      await drain(instance);

      expect(mockSend).toHaveBeenCalledTimes(5);
      expect(effects).toEqual(["paid 01"]);
      const row = instance.operations.get(message.payloadDigest);
      expect(row.phase).toBe("started");
      expect(row.replies).toEqual([
        expect.not.objectContaining({ digest: expect.anything() }),
      ]);
      expect(
        await instance.state.get("digest:" + message.payloadDigest)
      ).toBeUndefined();
      expect(
        error.mock.calls.filter(([line]) =>
          String(line).includes(
            `Reply to ${message.payloadDigest} refused 5 times without an attempt`
          )
        )
      ).toHaveLength(1);
    });

    it.each([
      [
        "a rejection without the label",
        async () => {
          throw new Error("relay timed out");
        },
      ],
      [
        "a labelled rejection of a send that reported an attempt",
        async (params: { onAttemptCreated?: (d: string) => Promise<void> }) => {
          await params.onAttemptCreated?.("ee".repeat(32));
          throw notAttempted("refused after the attempt was recorded");
        },
      ],
      [
        "a rejection that only wraps a labelled one",
        async () => {
          throw new Error("send failed", {
            cause: notAttempted("one payment is still open"),
          });
        },
      ],
    ])(
      "never sends again after %s: the message is held",
      async (_label, refuse) => {
        const effects: string[] = [];
        const { host, instance } = await start(paying(effects));
        mockSend
          .mockReset()
          .mockImplementationOnce(refuse)
          .mockImplementation(accept);
        const message = inbound("roll");

        for (let i = 0; i < 4; i++) await poll(host, [message]);
        await drain(instance);

        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(effects).toEqual(["paid 01"]);
        expect(instance.operations.get(message.payloadDigest).phase).toBe(
          "started"
        );
      }
    );

    it("retries only the refused reply of a handler that sends several", async () => {
      const { host, instance } = await start(
        bot("several-bot", async (message) => {
          await message.reply([{ type: "text", text: "first" }]);
          await message.reply([{ type: "text", text: "second" }]);
          return [{ type: "text", text: "third" }];
        })
      );
      mockSend
        .mockReset()
        .mockImplementationOnce(accept)
        .mockRejectedValueOnce(notAttempted("one payment is still open"))
        .mockImplementationOnce(accept)
        .mockRejectedValueOnce(notAttempted("one payment is still open"))
        .mockImplementation(accept);
      const message = inbound("go");

      await poll(host, [message]);
      await until(() => mockSend.mock.calls.length === 2);
      await poll(host, [message]);
      await until(() => mockSend.mock.calls.length === 4);
      await poll(host, [message]);
      await drain(instance);

      expect(textsSent()).toEqual([
        "first",
        "second",
        "second",
        "third",
        "third",
      ]);
      const row = instance.operations.get(message.payloadDigest);
      expect(row.phase).toBe("completed");
      expect(
        row.replies.map((call: { observation?: string }) => call.observation)
      ).toEqual(["delivered", "delivered", "delivered"]);
    });

    // What is NOT fixed: the wait is process memory. A restart finds a started invocation with
    // an unlinked slot, which the journal never runs or sends again.
    it("is held by a restart while it waits: stop returns, and no handler or send runs again", async () => {
      const effects: string[] = [];
      const first = await start(paying(effects));
      mockSend
        .mockReset()
        .mockRejectedValueOnce(notAttempted("one payment is still open"))
        .mockImplementation(accept);
      const message = inbound("roll");
      await poll(first.host, [message]);
      await until(() => mockSend.mock.calls.length === 1);

      await first.host.stop();

      const second = await start(paying(effects));
      for (let i = 0; i < 3; i++) await poll(second.host, [message]);
      await drain(second.instance);

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(effects).toEqual(["paid 01"]);
      const row = second.instance.operations.get(message.payloadDigest);
      expect(row.phase).toBe("started");
      expect(row.replies).toHaveLength(1);
      expect(row.replies[0].digest).toBeUndefined();
    });
  });
});
