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
import {
  DirectMessageAlreadyAttemptedError,
  directMessageNotAttempted,
} from "@frank/wallet/chain/active-chain";
import { FAILED_REPLY_TEXT, FrankBotHost } from "../src/bot-host";
import { replyMessageId } from "../src/inbound-operation-store";
import { GAME_MAX_REPLIES_PER_PEER } from "../src/loop-guard";
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
    options: {
      from?: Wallet;
      stampValueWei?: bigint;
      /** `null`: no conversation ID on the message (the default thread). */
      conversationId?: string | null;
    } = {}
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
      ...(options.conversationId === null
        ? {}
        : {
            conversationId:
              options.conversationId ?? "01010101-0101-0101-0101-010101010101",
          }),
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

  /** The message is finished: its row is gone and its marker is written. */
  const finished = async (
    instance: { state: { get(key: string): Promise<string | undefined> } },
    message: { payloadDigest: string }
  ) => (await instance.state.get("digest:" + message.payloadDigest)) !== undefined;

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

  // The legacy JSON mailbox (`PUT /message/monad`) is read by the same `fetchSince`. A record
  // from it names no sender key, recipient key or conversation, so the host admits none of it:
  // whatever its items say, and whatever stamp it claims, no handler sees it. This held before
  // the wallet began putting legacy items through the canonical receive rule; it is pinned here
  // because a dealer sizes a bet from the stamp of the message it is handed.
  describe("a record from the legacy JSON mailbox", () => {
    const legacy = (items: unknown[]) => {
      const { senderPublicKey, recipientPublicKey, messageId, conversationId, ...record } =
        inbound("placeholder", { stampValueWei: 5_000_000_000_000_000_000n });
      void [senderPublicKey, recipientPublicKey, messageId, conversationId];
      return { ...record, items };
    };

    it.each([
      [
        "blackjack-move",
        { type: "blackjack-move", gameId: "g", action: "bet", amount: 5 },
      ],
      [
        "swap-offer",
        { type: "swap-offer", swapId: "00".repeat(16), status: "accepted" },
      ],
      ["text", { type: "text", text: "deal me in" }],
      [
        "unsupported",
        {
          type: "unsupported",
          reason: "unknown-type",
          itemType: "blackjack-move",
          frame: "",
        },
      ],
    ])("holding a %s item is never dispatched to a handler", async (_type, item) => {
      const seen: BotMessageContext[] = [];
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const { host, instance } = await start(
        bot("legacy-bot", async (message) => {
          seen.push(message);
        })
      );
      await poll(host, [legacy([item]), inbound("canonical control")]);
      await drain(instance);
      expect(seen.map((message) => message.items)).toEqual([
        [{ type: "text", text: "canonical control" }],
      ]);
      expect(mockSend).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported inbound identity")
      );
    });
  });

  // On 16218e9f every reply carried the bot's default stamp (0.01 MON) whatever the sender had
  // paid, so each message, paid or not, drew 0.01 MON out of the bot, refilled from the shared
  // funding wallet.
  describe("the stamp on a reply", () => {
    const MIN = 1_000_000_000_000n;
    const stampsSent = (): bigint[] =>
      mockSend.mock.calls.map(([params]) => params.stampValue);

    it.each([
      ["what the sender paid, when that is less than the bot's own stamp", 4_000_000_000_000_000n, 4_000_000_000_000_000n],
      ["the bot's own stamp at most, however much the sender paid", 5_000_000_000_000_000_000n, STAMP],
      ["the relay's minimum for a message that paid nothing", 0n, MIN],
      ["the relay's minimum for a message whose payment the wallet did not report", undefined, MIN],
      ["the relay's minimum for a message that paid less than a paid message may", MIN - 1n, MIN],
    ])("is %s", async (_label, paid, expected) => {
      jest.spyOn(console, "error").mockImplementation(() => {});
      const { host, instance } = await start(
        bot("stamp-reply-bot", async (message, ctx) => {
          const said = (message.items[0] as { text: string }).text;
          if (said === "return") return [{ type: "text", text: "returned" }];
          if (said === "stored")
            return { kind: "prepared-reply", text: "stored" };
          if (said === "throw") throw new Error("a check failed");
          // Anything sent while answering, to anyone, is covered: not only `reply()`.
          await message.reply([{ type: "text", text: "replied" }]);
          await ctx.sendMessage(otherPeer.address, [
            { type: "text", text: "to a table mate" },
          ]);
        })
      );
      for (const said of ["return", "stored", "throw", "send"]) {
        await poll(host, [inbound(said, { stampValueWei: paid })]);
        await drain(instance);
      }
      expect(textsSent()).toEqual([
        "returned",
        "stored",
        FAILED_REPLY_TEXT,
        "replied",
        "to a table mate",
      ]);
      expect(stampsSent()).toEqual(Array(5).fill(expected));
    });

    it("is the amount a handler names, when it names one: a payout is the handler's", async () => {
      const { host, instance } = await start(
        bot("payout-bot", async (message) => {
          await message.reply([{ type: "text", text: "you won" }], {
            stampValueWei: 70_000_000_000_000_000n,
          });
        })
      );
      await poll(host, [inbound("roll", { stampValueWei: 0n })]);
      await drain(instance);
      expect(stampsSent()).toEqual([70_000_000_000_000_000n]);
    });

    it("is the relay's minimum for the failure reply of a message whose handling was interrupted: what it paid is not kept", async () => {
      jest.spyOn(console, "error").mockImplementation(() => {});
      const { host, instance } = await start(bot("cut-bot", async () => {}));
      // The handler ran and the write that finishes its message was lost.
      const complete = jest
        .spyOn(instance.operations, "complete")
        .mockRejectedValueOnce(new Error("killed"));
      const message = inbound("hello", { stampValueWei: STAMP });
      await poll(host, [message]);
      await drain(instance);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(mockSend).not.toHaveBeenCalled();
      await poll(host, [message]);
      await drain(instance);
      expect(textsSent()).toEqual([FAILED_REPLY_TEXT]);
      expect(stampsSent()).toEqual([MIN]);
    });
  });

  // On 21a868a2 the first refusal fails the handler: the wallet is called once, the row stays
  // started for good and the message is never answered.
  describe("a reply a handler sends itself", () => {
    /** A handler with an effect before its reply and one after, which needs the send result. */
    const paying = (effects: string[]) =>
      bot("refused-bot", async (message, ctx) => {
        effects.push("paid " + message.payloadDigest.slice(0, 2));
        await ctx.state.put("paid:" + message.payloadDigest, "1");
        const sent = await message.reply([{ type: "text", text: "you won" }]);
        effects.push("recorded " + sent.payloadDigest.slice(0, 2));
        await ctx.state.put("recorded:" + message.payloadDigest, "1");
      });

    it("is sent again on a later poll when the wallet refused it without an attempt: one reply, the handler and its effects once, one attempt", async () => {
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
      expect(instance.operations.get(message.payloadDigest)).toBeUndefined();
      expect(await finished(instance, message)).toBe(true);

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
      await until(() => effects.length === 3);
      await until(
        () => instance.operations.get(other.payloadDigest) === undefined
      );

      expect(effects).toEqual([
        "paid 01",
        "paid 02",
        expect.stringMatching(/^recorded/),
      ]);
      expect(await finished(instance, other)).toBe(true);
      expect(instance.operations.get(waiting.payloadDigest).phase).toBe(
        "started"
      );
      // Without a poll nothing is sent again, however long the handler waits.
      await new Promise((r) => setTimeout(r, 50));
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    // On 05c93db0 the fifth refusal held the message for good: nothing was ever sent to the peer.
    it("stops after five refused sends, runs nothing twice, and leaves the peer a failure reply that is delivered once the wallet accepts", async () => {
      const effects: string[] = [];
      const { host, instance } = await start(paying(effects));
      const error = jest.spyOn(console, "error").mockImplementation(() => {});
      let refusing = true;
      mockSend.mockReset().mockImplementation(async (params) => {
        if (refusing) throw notAttempted("one payment is still open");
        return accept(params);
      });
      const message = inbound("roll");

      for (let sends = 1; sends <= 5; sends++) {
        await poll(host, [message]);
        await until(() => mockSend.mock.calls.length === sends);
      }
      await drain(instance);
      expect(effects).toEqual(["paid 01"]);
      expect(
        error.mock.calls.filter(([line]) =>
          String(line).includes("refused 5 times without an attempt")
        )
      ).toHaveLength(1);
      // The handler's own reply is not sent a sixth time; the failure reply is what is owed.
      expect(textsSent().slice(5)).toEqual([FAILED_REPLY_TEXT]);
      expect(await finished(instance, message)).toBe(false);

      refusing = false;
      await poll(host, [message]);
      await drain(instance);
      expect(textsSent().slice(5)).toEqual([
        FAILED_REPLY_TEXT,
        FAILED_REPLY_TEXT,
      ]);
      expect(await finished(instance, message)).toBe(true);
      for (let i = 0; i < 3; i++) await poll(host, [message]);
      await drain(instance);
      expect(mockSend).toHaveBeenCalledTimes(7);
      expect(effects).toEqual(["paid 01"]);
    });

    it.each([
      [
        "a rejection without the label",
        async () => {
          throw new Error("relay timed out");
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
      "is never sent again after %s; the peer gets the failure reply instead",
      async (_label, refuse) => {
        const effects: string[] = [];
        const { host, instance } = await start(paying(effects));
        jest.spyOn(console, "error").mockImplementation(() => {});
        mockSend
          .mockReset()
          .mockImplementationOnce(refuse)
          .mockImplementation(accept);
        const message = inbound("roll");

        for (let i = 0; i < 4; i++) await poll(host, [message]);
        await drain(instance);

        expect(textsSent()).toEqual(["you won", FAILED_REPLY_TEXT]);
        expect(effects).toEqual(["paid 01"]);
        expect(await finished(instance, message)).toBe(true);
      }
    );

    it("is never sent again after a rejection of a send the wallet holds an attempt for, and nothing else is sent: the wallet finishes that attempt", async () => {
      const effects: string[] = [];
      const { host, instance } = await start(paying(effects));
      jest.spyOn(console, "error").mockImplementation(() => {});
      mockSend
        .mockReset()
        .mockImplementationOnce(async (params) => {
          await params.onAttemptCreated?.("ee".repeat(32));
          throw new Error("the relay has not delivered it yet");
        })
        .mockImplementation(accept);
      const message = inbound("roll");

      for (let i = 0; i < 4; i++) await poll(host, [message]);
      await drain(instance);

      expect(textsSent()).toEqual(["you won"]);
      expect(effects).toEqual(["paid 01"]);
      expect(await finished(instance, message)).toBe(true);
      // The wallet is asked to retry everything it holds, on every poll after.
      expect(mockReconcile).toHaveBeenCalledWith(
        expect.objectContaining({ payloadDigests: [] })
      );
    });

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
      expect(await finished(instance, message)).toBe(true);
    });

    // On 05c93db0 one rejected send ended the invocation: every later send of the handler was
    // refused with "no longer active" and the message was held, although the handler had caught
    // the error.
    it("that fails and is caught by the handler does not stop the handler's other sends", async () => {
      const outcomes: string[] = [];
      const { host, instance } = await start(
        bot("catching-bot", async (message, ctx) => {
          try {
            await ctx.sendMessage(otherPeer.address, [
              { type: "text", text: "to a table mate" },
            ]);
          } catch (error) {
            outcomes.push("caught " + (error as Error).message);
          }
          await message.reply([{ type: "text", text: "your turn" }]);
          outcomes.push("replied");
        })
      );
      mockSend
        .mockReset()
        .mockRejectedValueOnce(new Error("recipient has no directory entry"))
        .mockImplementation(accept);
      const message = inbound("move");

      await poll(host, [message]);
      await drain(instance);

      expect(outcomes).toEqual([
        "caught recipient has no directory entry",
        "replied",
      ]);
      expect(textsSent()).toEqual(["to a table mate", "your turn"]);
      expect(await finished(instance, message)).toBe(true);
    });

    // On 05c93db0 a restart left the invocation held: the peer never heard anything.
    it("is not sent again after a restart while it waited, and the handler is not run again: the peer gets the failure reply once", async () => {
      const effects: string[] = [];
      const first = await start(paying(effects));
      jest.spyOn(console, "error").mockImplementation(() => {});
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

      expect(textsSent()).toEqual(["you won", FAILED_REPLY_TEXT]);
      expect(effects).toEqual(["paid 01"]);
      expect(await finished(second.instance, message)).toBe(true);
    });
  });

  // On 05c93db0 a handler that threw left its message "held": never run again, never answered,
  // never released, and counted against the bot's 1,024 rows for good.
  describe("a handler that fails", () => {
    it("having sent nothing: the peer gets one failure reply, the message is finished, and the next message is handled", async () => {
      const error = jest.spyOn(console, "error").mockImplementation(() => {});
      let calls = 0;
      const { host, instance } = await start(
        bot("throwing-bot", async () => {
          if (++calls === 1) throw new Error("a check failed");
          return [{ type: "text", text: "fine now" }];
        })
      );
      const first = inbound("one");
      const second = inbound("two");

      await poll(host, [first]);
      await drain(instance);
      await poll(host, [first, second]);
      await drain(instance);

      expect(calls).toBe(2);
      expect(textsSent()).toEqual([FAILED_REPLY_TEXT, "fine now"]);
      expect(mockSend.mock.calls[0][0].recipient.raw).toBe(peer.address);
      expect(mockSend.mock.calls[0][0].conversationId).toBe(
        first.conversationId
      );
      expect(await finished(instance, first)).toBe(true);
      expect(await finished(instance, second)).toBe(true);
      expect(instance.operations.listStarted()).toEqual([]);
      expect(
        error.mock.calls.some(
          ([line]) =>
            String(line).includes("Handler failed") &&
            String(line).includes(first.messageId) &&
            String(line).includes(peer.address.toLowerCase())
        )
      ).toBe(true);
    });
  });

  // The stored reply: what a handler returns as `{ kind: "prepared-reply", text }`, and the
  // failure reply. On 05c93db0 a send that failed after the wallet's inventory step, or a
  // restart at the wrong moment, held the reply for good.
  describe("a stored reply", () => {
    const answering = (seen: string[] = []) =>
      bot("answer-bot", async (message) => {
        const said = (message.items[0] as { text: string }).text;
        seen.push(said);
        return { kind: "prepared-reply", text: "re:" + said };
      });
    const owner = (instance: any) => instance.operations.owner;

    it("whose send failed is sent again on later polls until delivered: one handler run, one message identity, one reply", async () => {
      const seen: string[] = [];
      const { host, instance } = await start(answering(seen));
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      mockSend
        .mockReset()
        .mockRejectedValueOnce(
          new Error(
            "Insufficient main account balance to prepare stamp accounts"
          )
        )
        .mockRejectedValueOnce(new Error("relay timed out"))
        .mockImplementation(accept);
      const message = inbound("hello");

      await poll(host, [message]);
      await drain(instance);
      expect(await finished(instance, message)).toBe(false);
      await poll(host, [message]);
      await drain(instance);
      await poll(host, [message]);
      await drain(instance);

      expect(seen).toEqual(["hello"]);
      expect(textsSent()).toEqual(["re:hello", "re:hello", "re:hello"]);
      const ids = mockSend.mock.calls.map(([params]) => params.messageId);
      expect(new Set(ids)).toEqual(
        new Set([replyMessageId(owner(instance), message.payloadDigest)])
      );
      expect(await finished(instance, message)).toBe(true);
      // Said once, not on every poll.
      expect(
        warn.mock.calls.filter(([line]) =>
          String(line).includes("was not sent")
        )
      ).toHaveLength(1);
      await poll(host, [message]);
      await drain(instance);
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it("the wallet took and has not delivered is never sent again: the wallet is asked about that attempt until it is delivered", async () => {
      const { host, instance } = await start(answering());
      const attempt = "ee".repeat(32);
      mockSend.mockReset().mockImplementationOnce(async (params) => {
        await params.onAttemptCreated?.(attempt);
        throw new Error("the relay has not delivered it yet");
      });
      mockReconcile.mockResolvedValue({ [attempt]: "live" });
      const message = inbound("hello");

      await poll(host, [message]);
      await drain(instance);
      await poll(host);
      await drain(instance);
      expect(mockReconcile).toHaveBeenLastCalledWith(
        expect.objectContaining({ payloadDigests: [attempt] })
      );
      expect(await finished(instance, message)).toBe(false);

      mockReconcile.mockResolvedValue({ [attempt]: "delivered" });
      await poll(host);
      await drain(instance);
      expect(await finished(instance, message)).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("is delivered once after a restart between storing and sending it, without running the handler again", async () => {
      const seen: string[] = [];
      const first = await start(answering(seen));
      jest.spyOn(console, "warn").mockImplementation(() => {});
      mockSend.mockReset().mockRejectedValue(new Error("process is going"));
      const message = inbound("hello");
      await poll(first.host, [message]);
      await drain(first.instance);
      await first.host.stop();

      // The wallet journalled the payment in the first process and the host never learned of
      // it: the wallet answers the repeat with its original attempt, and no second one is made.
      const attempt = "ee".repeat(32);
      const second = await start(answering(seen));
      const id = replyMessageId(owner(second.instance), message.payloadDigest);
      mockSend
        .mockReset()
        .mockRejectedValue(
          new DirectMessageAlreadyAttemptedError(id, attempt, "02" + "aa".repeat(32))
        );
      mockReconcile.mockResolvedValue({ [attempt]: "delivered" });
      await poll(second.host);
      await drain(second.instance);
      await poll(second.host);
      await drain(second.instance);

      expect(seen).toEqual(["hello"]);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0]).toMatchObject({
        messageId: id,
        items: [{ type: "text", text: "re:hello" }],
      });
      expect(mockReconcile).toHaveBeenCalledWith(
        expect.objectContaining({ payloadDigests: [attempt] })
      );
      expect(await finished(second.instance, message)).toBe(true);
    });

    // On 05c93db0 sixteen unsent answers stopped every new prompt, bot-wide.
    it("that is stuck for one peer does not stop other peers being answered, on the same poll and after", async () => {
      const seen: string[] = [];
      const { host, instance } = await start(answering(seen));
      jest.spyOn(console, "warn").mockImplementation(() => {});
      mockSend.mockReset().mockImplementation(async (params) => {
        if (params.recipient.raw === peer.address)
          throw new Error("recipient has no directory entry");
        return accept(params);
      });
      const stuck = Array.from({ length: 20 }, (_, i) =>
        inbound("stuck" + i, {
          conversationId: `${(i + 16).toString(16).repeat(4)}-0101-0101-0101-010101010101`,
        })
      );
      const fine = [
        inbound("a", { from: otherPeer }),
        inbound("b", { from: otherPeer }),
        inbound("c", { from: otherPeer }),
      ];

      await poll(host, [...stuck, fine[0]]);
      await drain(instance);
      await poll(host, [...stuck, ...fine]);
      await drain(instance);
      await poll(host, [...stuck, ...fine]);
      await drain(instance);
      await poll(host, [...stuck, ...fine]);
      await drain(instance);

      const delivered = mockSend.mock.calls
        .filter(([params]) => params.recipient.raw === otherPeer.address)
        .map(([params]) => params.items[0].text);
      expect(delivered).toEqual(["re:a", "re:b", "re:c"]);
      expect(seen.filter((said) => said.startsWith("stuck"))).toHaveLength(20);
      for (const message of fine)
        expect(await finished(instance, message)).toBe(true);
    });

    it("keeps one conversation's replies in order: its next message waits for the reply before it, and another conversation does not", async () => {
      const seen: string[] = [];
      const { host, instance } = await start(answering(seen));
      jest.spyOn(console, "warn").mockImplementation(() => {});
      let open = false;
      mockSend.mockReset().mockImplementation(async (params) => {
        if (!open && params.items[0].text === "re:one")
          throw new Error("relay timed out");
        return accept(params);
      });
      const one = inbound("one", { conversationId: null });
      const two = inbound("two", { conversationId: null });
      const elsewhere = inbound("three");

      await poll(host, [one, two, elsewhere]);
      await drain(instance);
      await poll(host, [one, two, elsewhere]);
      await drain(instance);
      expect(seen).toEqual(["one", "three"]);

      open = true;
      await poll(host, [one, two, elsewhere]);
      await drain(instance);
      await poll(host, [one, two, elsewhere]);
      await drain(instance);
      expect(seen).toEqual(["one", "three", "two"]);
      const delivered = mockSend.mock.results
        .map((result, i) => ({ result, text: textsSent()[i] }))
        .filter(({ result }) => result.type === "return");
      expect(
        (
          await Promise.all(
            delivered.map(async ({ result, text }) =>
              (await result.value.then(
                () => true,
                () => false
              ))
                ? text
                : undefined
            )
          )
        ).filter(Boolean)
      ).toEqual(["re:three", "re:one", "re:two"]);
      // A reply in the default thread carries no conversation ID either.
      expect(
        mockSend.mock.calls.find(([p]) => p.items[0].text === "re:two")![0]
          .conversationId
      ).toBeUndefined();
    });

    // On 05c93db0 a reply linked and never recorded delivered blocked its conversation for ever.
    it.each([
      ["the relay ended its delivery", "dead", 60 * 60_000],
      ["it stayed undelivered past the bound", "live", 1],
    ] as const)(
      "is given up visibly when %s, and its conversation goes on",
      async (_label, status, replyGiveUpMs) => {
        const seen: string[] = [];
        const { host, instance } = await start(answering(seen));
        const error = jest.spyOn(console, "error").mockImplementation(() => {});
        const attempt = "ee".repeat(32);
        mockSend
          .mockReset()
          .mockImplementationOnce(async (params) => {
            await params.onAttemptCreated?.(attempt);
            throw new Error("the relay has not delivered it yet");
          })
          .mockImplementation(accept);
        mockReconcile.mockResolvedValue({ [attempt]: status });
        const one = inbound("one");
        const two = inbound("two");

        await poll(host, [one, two]);
        await drain(instance);
        await new Promise((r) => setTimeout(r, 5));
        // The bound has passed for the reply that is waiting, and only for it.
        // (The waiting second message is not read in this poll, so it is not started under
        // the shortened bound.)
        (host as any).options.replyGiveUpMs = replyGiveUpMs;
        await poll(host, [one]);
        await drain(instance);
        (host as any).options.replyGiveUpMs = 60 * 60_000;
        await poll(host, [one, two]);
        await drain(instance);

        expect(
          error.mock.calls.filter(
            ([line]) =>
              String(line).includes("Giving up on the reply") &&
              String(line).includes(peer.address.toLowerCase()) &&
              String(line).includes(one.messageId)
          )
        ).toHaveLength(1);
        expect(seen).toEqual(["one", "two"]);
        expect(textsSent()).toEqual(["re:one", "re:two"]);
        expect(await finished(instance, one)).toBe(true);
        expect(await finished(instance, two)).toBe(true);
      }
    );

    // On 16218e9f a failing question skipped the bound: the conversation waited for ever.
    it("is given up visibly after the bound when the wallet cannot be asked about it, poll after poll", async () => {
      const seen: string[] = [];
      const { host, instance } = await start(answering(seen));
      const error = jest.spyOn(console, "error").mockImplementation(() => {});
      jest.spyOn(console, "warn").mockImplementation(() => {});
      mockSend
        .mockReset()
        .mockImplementationOnce(async (params) => {
          await params.onAttemptCreated?.("ee".repeat(32));
          throw new Error("the relay has not delivered it yet");
        })
        .mockImplementation(accept);
      mockReconcile.mockRejectedValue(new Error("wallet journal unreadable"));
      const one = inbound("one");
      const two = inbound("two");

      await poll(host, [one, two]);
      await drain(instance);
      await poll(host, [one]);
      await drain(instance);
      expect(await finished(instance, one)).toBe(false);
      await new Promise((r) => setTimeout(r, 5));
      (host as any).options.replyGiveUpMs = 1;
      await poll(host, [one]);
      await drain(instance);
      (host as any).options.replyGiveUpMs = 60 * 60_000;
      await poll(host, [one, two]);
      await drain(instance);

      expect(
        error.mock.calls.filter(([line]) =>
          String(line).includes("Giving up on the reply")
        )
      ).toHaveLength(1);
      expect(await finished(instance, one)).toBe(true);
      expect(seen).toEqual(["one", "two"]);
    });

    it("that could never be sent is given up visibly after the bound, having paid nothing", async () => {
      const { host, instance } = await start(answering());
      const error = jest.spyOn(console, "error").mockImplementation(() => {});
      jest.spyOn(console, "warn").mockImplementation(() => {});
      mockSend.mockReset().mockRejectedValue(new Error("no directory entry"));
      const message = inbound("hello");

      await poll(host, [message]);
      await drain(instance);
      await new Promise((r) => setTimeout(r, 5));
      (host as any).options.replyGiveUpMs = 1;
      await poll(host, [message]);
      await drain(instance);

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(
        error.mock.calls.filter(([line]) =>
          String(line).includes("nothing was paid for it")
        )
      ).toHaveLength(1);
      expect(await finished(instance, message)).toBe(true);
    });

    it("replaces a reply text the journal cannot store by the failure reply", async () => {
      jest.spyOn(console, "error").mockImplementation(() => {});
      const { host, instance } = await start(
        bot("empty-bot", async () => ({ kind: "prepared-reply", text: "" }))
      );
      const message = inbound("hello");
      await poll(host, [message]);
      await drain(instance);
      expect(textsSent()).toEqual([FAILED_REPLY_TEXT]);
      expect(await finished(instance, message)).toBe(true);
    });
  });

  // On 16218e9f one failed journal write left the bot answering nothing until it was restarted,
  // with warnings only.
  describe("a failed write to the bot's journal", () => {
    const { LevelBotStateStore } = jest.requireActual<
      typeof import("../src/state-store")
    >("../src/state-store");

    it.each([
      ["was lost", false],
      ["landed and only its acknowledgement was lost", true],
    ])(
      "is said loudly and mended on the next poll when the write %s: every message is answered once",
      async (_label, landed) => {
        const error = jest.spyOn(console, "error").mockImplementation(() => {});
        jest.spyOn(console, "warn").mockImplementation(() => {});
        const seen: string[] = [];
        const { host, instance } = await start(
          bot("journal-bot", async (message) => {
            seen.push((message.items[0] as { text: string }).text);
            return { kind: "prepared-reply", text: "answer" };
          })
        );
        const original = LevelBotStateStore.prototype.durableBatch;
        let cut = false;
        jest
          .spyOn(LevelBotStateStore.prototype, "durableBatch")
          .mockImplementation(async function (this: unknown, ops) {
            // The write that finishes the first message.
            if (!cut && ops.some((op) => op.key.startsWith("digest:"))) {
              cut = true;
              if (landed) await original.call(this, ops);
              throw new Error("EIO: i/o error, write");
            }
            return original.call(this, ops);
          });
        // The wallet knows what the journal lost: that reply was delivered.
        mockReconcile.mockImplementation(async ({ payloadDigests }) =>
          Object.fromEntries(
            payloadDigests.map((digest: string) => [digest, "delivered"])
          )
        );
        const one = inbound("one");
        const two = inbound("two", { from: otherPeer });

        await poll(host, [one]);
        await drain(instance);
        expect(instance.operations.isFaulted).toBe(true);
        await poll(host, [one, two]);
        await drain(instance);
        await poll(host, [one, two]);
        await drain(instance);

        expect(instance.operations.isFaulted).toBe(false);
        expect(
          error.mock.calls.some(([line]) =>
            String(line).includes('BOT "journal-bot" IS NOT ANSWERING')
          )
        ).toBe(true);
        expect(seen).toEqual(["one", "two"]);
        expect(await finished(instance, one)).toBe(true);
        expect(await finished(instance, two)).toBe(true);
        // The first reply was delivered before the cut and is not sent a second time.
        expect(textsSent()).toEqual(["answer", "answer"]);
      }
    );

    it("keeps saying so, by name and at error level, while the journal cannot be read back", async () => {
      const error = jest.spyOn(console, "error").mockImplementation(() => {});
      jest.spyOn(console, "warn").mockImplementation(() => {});
      const { host, instance } = await start(bot("dead-disk-bot", async () => {}));
      jest
        .spyOn(LevelBotStateStore.prototype, "durableBatch")
        .mockRejectedValue(new Error("EIO"));
      jest
        .spyOn(LevelBotStateStore.prototype, "readEntries")
        .mockRejectedValue(new Error("EIO"));
      await poll(host, [inbound("one")]);
      await drain(instance);
      await poll(host);
      await poll(host);
      const loud = error.mock.calls.filter(([, detail]) =>
        String(detail).includes(
          'Bot "dead-disk-bot" still cannot read its message journal'
        )
      );
      expect(loud).toHaveLength(2);
      expect(mockFetchSince).toHaveBeenCalledTimes(1);
    });
  });

  // On 05c93db0 a bot was funded once, at registration; when its account ran dry every reply
  // failed and nothing funded it again.
  describe("topping up from the shared funding wallet", () => {
    const funded = async (sendTransaction: jest.Mock) => {
      const balances = { bot: 500_000_000_000_000_000n };
      const host = new FrankBotHost({
        relayBaseUrl: "http://127.0.0.1:8098",
        stateDir,
        watchRegistrations: false,
        fundingPrivateKeyHex: "0x" + "22".repeat(32),
      });
      hosts.push(host);
      (host as any).provider = {
        getBalance: jest.fn(async (address: string) =>
          address === "0x1111111111111111111111111111111111111111"
            ? 5_000_000_000_000_000_000n
            : balances.bot
        ),
      };
      (host as any).fundingWallet = {
        address: "0x1111111111111111111111111111111111111111",
        sendTransaction,
      };
      (host as any).nonceSequencer = {
        withNonce: (run: (nonce: number) => Promise<void>) => run(0),
      };
      await host.register(bot("funded-bot", async () => {}));
      return {
        host,
        balances,
        instance: (host as any).instances.get("funded-bot"),
      };
    };
    const settle = async (instance: { toppingUp: boolean }) => {
      await until(() => !instance.toppingUp);
    };

    it("happens on the poll when the balance has fallen, one at a time, and not again for minutes", async () => {
      let clock = Date.now();
      jest.spyOn(Date, "now").mockImplementation(() => clock);
      let confirm: () => void = () => {};
      const sendTransaction = jest.fn(async () => ({
        wait: () => new Promise<void>((resolve) => (confirm = resolve)),
      }));
      const { host, balances, instance } = await funded(sendTransaction);
      expect(sendTransaction).not.toHaveBeenCalled();

      // Balances are not read on every poll.
      balances.bot = 50_000_000_000_000_000n;
      await poll(host);
      expect(sendTransaction).not.toHaveBeenCalled();

      clock += 31_000;
      await poll(host);
      await until(() => sendTransaction.mock.calls.length === 1);
      expect(sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ value: 500_000_000_000_000_000n })
      );
      // Its receipt is still awaited: later polls start nothing.
      clock += 31_000;
      await poll(host);
      await poll(host);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
      confirm();
      await settle(instance);

      // Nothing more goes out for minutes, whatever the balance reads meanwhile.
      clock += 4 * 60_000;
      await poll(host);
      await settle(instance);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
      clock += 2 * 60_000;
      await poll(host);
      await until(() => sendTransaction.mock.calls.length === 2);
      confirm();
      await settle(instance);
    });

    it("is tried again on a later poll after it failed, as when another bot's top-up took the nonce", async () => {
      let clock = Date.now();
      jest.spyOn(Date, "now").mockImplementation(() => clock);
      jest.spyOn(console, "warn").mockImplementation(() => {});
      const sendTransaction = jest
        .fn()
        .mockRejectedValueOnce(new Error("nonce too low"))
        .mockRejectedValueOnce(new Error("nonce too low"))
        .mockResolvedValue({ wait: async () => undefined });
      const { host, balances, instance } = await funded(sendTransaction);
      balances.bot = 0n;

      clock += 31_000;
      await poll(host);
      await settle(instance);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
      await poll(host);
      await settle(instance);
      expect(sendTransaction).toHaveBeenCalledTimes(1);

      clock += 31_000;
      await poll(host);
      await settle(instance);
      expect(sendTransaction).toHaveBeenCalledTimes(2);
      clock += 31_000;
      await poll(host);
      await settle(instance);
      expect(sendTransaction).toHaveBeenCalledTimes(3);
      // That one went out: nothing more for minutes.
      clock += 31_000;
      await poll(host);
      await settle(instance);
      expect(sendTransaction).toHaveBeenCalledTimes(3);
    });
  });

  // On a9ac2975 the budget is 20 for every bot, nothing configures it, and a peer past it is
  // dropped without a word or a log line.
  describe("the reply limit per peer", () => {
    const answering = (extra: Partial<FrankBotDefinition> = {}) => {
      const handled: string[] = [];
      const definition = bot(
        "limit-bot",
        async (message) => {
          handled.push((message.items[0] as { text: string }).text);
          return [{ type: "text", text: "answer" }];
        },
        extra
      );
      return { handled, definition };
    };
    const limitOf = async (
      extra: Partial<FrankBotDefinition>,
      options: BotHostOptions = {}
    ) =>
      (await start(answering(extra).definition, options)).instance.loopGuard
        .limit;

    it("is twenty for a bot that declares nothing", async () => {
      expect(await limitOf({})).toBe(20);
    });

    it("is what the bot declares, such as the game budget", async () => {
      expect(
        await limitOf({ maxRepliesPerPeer: GAME_MAX_REPLIES_PER_PEER })
      ).toBe(300);
    });

    it("is the operator's FRANK_BOT_MAX_REPLIES_PER_PEER for every bot, whatever the bot declares", async () => {
      process.env.FRANK_BOT_MAX_REPLIES_PER_PEER = "7";
      expect(
        await limitOf({ maxRepliesPerPeer: GAME_MAX_REPLIES_PER_PEER })
      ).toBe(7);
    });

    it("is the host option before the environment and the bot", async () => {
      process.env.FRANK_BOT_MAX_REPLIES_PER_PEER = "7";
      expect(
        await limitOf(
          { maxRepliesPerPeer: GAME_MAX_REPLIES_PER_PEER },
          { maxRepliesPerPeer: 3 }
        )
      ).toBe(3);
    });

    it.each(["-1", "1.5", "many", " "])(
      "refuses to start with FRANK_BOT_MAX_REPLIES_PER_PEER=%p instead of using a default",
      (value) => {
        process.env.FRANK_BOT_MAX_REPLIES_PER_PEER = value;
        expect(
          () =>
            new FrankBotHost({
              relayBaseUrl: "http://127.0.0.1:8098",
              stateDir,
            })
        ).toThrow(
          "FRANK_BOT_MAX_REPLIES_PER_PEER must be a non-negative integer"
        );
      }
    );

    it("refuses to register a bot that declares a budget that is not a non-negative integer", async () => {
      await expect(
        start(answering({ maxRepliesPerPeer: 2.5 }).definition)
      ).rejects.toThrow(
        'Bot "limit-bot" maxRepliesPerPeer must be a non-negative integer'
      );
    });

    /** The peer's published profile says it is a bot; `otherPeer` is a person. */
    const peerIsABot = (instance: any) =>
      instance.directory.lookupPeer.mockImplementation(
        async (address: string) => ({
          isBot: address.toLowerCase() === peer.address.toLowerCase(),
        })
      );

    // The owner's rule: no reply caps. On 05c93db0 a person was cut off after 20 replies an hour.
    it("never limits a person, whatever the budget: every message is answered", async () => {
      const { handled, definition } = answering();
      const { host, instance } = await start(definition, {
        maxRepliesPerPeer: 2,
      });
      const texts = Array.from({ length: 30 }, (_, i) => "m" + i);
      for (const text of texts) {
        await poll(host, [inbound(text)]);
        await drain(instance);
      }
      expect(handled).toEqual(texts);
      expect(textsSent()).toEqual(texts.map(() => "answer"));
      // A profile that cannot be read counts as a person too.
      instance.directory.lookupPeer.mockRejectedValue(new Error("relay down"));
      await poll(host, [inbound("one more")]);
      await drain(instance);
      expect(handled).toHaveLength(31);
    });

    it("stops answering a bot past the limit, and says so once: one log line and one notice", async () => {
      const { handled, definition } = answering();
      const { host, instance } = await start(definition, {
        maxRepliesPerPeer: 2,
      });
      peerIsABot(instance);
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

      for (const text of ["one", "two", "three", "four"]) {
        await poll(host, [inbound(text)]);
        await drain(instance);
      }
      const late = inbound("five");
      await poll(host, [late]);
      await poll(host, [late]);
      await drain(instance);
      await poll(host, [inbound("from someone else", { from: otherPeer })]);
      await drain(instance);

      expect(handled).toEqual(["one", "two", "from someone else"]);
      expect(textsSent()).toEqual([
        "answer",
        "answer",
        expect.stringContaining("Slow down: you have had 2 replies"),
        "answer",
      ]);
      const notice = mockSend.mock.calls[2][0];
      expect(notice.recipient.raw).toBe(peer.address);
      expect(notice.conversationId).toBe(
        "01010101-0101-0101-0101-010101010101"
      );
      expect(
        warn.mock.calls.filter(([line]) =>
          String(line).includes("Reply limit reached for")
        )
      ).toEqual([
        [
          `[bot-host] [limit-bot] Reply limit reached for ${peer.address.toLowerCase()} (2 per hour); its messages are not handled until the hour's window frees`,
        ],
      ]);
      // The unanswered messages were not consumed as handled.
      expect(instance.operations.get(late.payloadDigest)).toBeUndefined();
    });

    it("does not repeat the notice when it could not be sent", async () => {
      const { definition } = answering();
      const { host, instance } = await start(definition, {
        maxRepliesPerPeer: 1,
      });
      peerIsABot(instance);
      jest.spyOn(console, "warn").mockImplementation(() => {});
      mockSend
        .mockReset()
        .mockImplementationOnce(accept)
        .mockRejectedValue(new Error("relay timed out"));

      for (const text of ["one", "two", "three", "four"]) {
        await poll(host, [inbound(text)]);
        await drain(instance);
      }

      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("says nothing to the peer when the budget is zero: never reply means never", async () => {
      const { handled, definition } = answering();
      const { host, instance } = await start(definition, {
        maxRepliesPerPeer: 0,
      });
      peerIsABot(instance);
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

      for (const text of ["one", "two"]) {
        await poll(host, [inbound(text)]);
        await drain(instance);
      }

      expect(handled).toEqual([]);
      expect(mockSend).not.toHaveBeenCalled();
      expect(
        warn.mock.calls.filter(([line]) =>
          String(line).includes("Reply limit reached for")
        )
      ).toHaveLength(1);
    });
  });
});
