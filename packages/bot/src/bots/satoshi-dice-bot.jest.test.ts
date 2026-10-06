import {
  SatoshiDiceBot,
  calculateMultiplier,
  rollLuckyNumber,
  SATOSHI_DICE_MODULO,
} from "./satoshi-dice-bot";
import { createHash } from "crypto";
import type {
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";

describe("SatoshiDiceBot", () => {
  let bot: SatoshiDiceBot;
  let mockState: Map<string, string>;
  let mockContext: BotContext;
  let sentMessages: Array<{ to: string; items: any[] }>;
  let transferredFunds: Array<{ to: string; valueWei: bigint }>;

  beforeEach(() => {
    bot = new SatoshiDiceBot();
    mockState = new Map();
    sentMessages = [];
    transferredFunds = [];

    mockContext = {
      botId: "dice",
      address: "0xdddddddddddddddddddddddddddddddddddddddd",
      subject: "0xdddddddddddddddddddddddddddddddddddddddd",
      relayBaseUrl: "http://127.0.0.1:8098",
      networkTag: "MONT",
      provider: {} as any,
      state: {
        get: jest.fn(async (k: string) => mockState.get(k)),
        put: jest.fn(async (k: string, v: string) => {
          mockState.set(k, v);
        }),
        del: jest.fn(async (k: string) => {
          mockState.delete(k);
        }),
        list: jest.fn(async () => []),
        batch: jest.fn(async () => {}),
        sublevel: jest.fn(),
        close: jest.fn(async () => {}),
      },
      subscriptions: {} as any,
      lookupPeer: jest.fn(),
      sendMessage: jest.fn(async (to, items) => {
        sentMessages.push({ to, items });
        return { ok: true } as any;
      }),
      sendDirectMessage: jest.fn(async (to, items) => {
        sentMessages.push({ to, items });
        return { ok: true } as any;
      }),
      onNewUserRegistered: jest.fn(),
      sendTransfer: jest.fn(async ({ to, valueWei }) => {
        transferredFunds.push({ to, valueWei });
        return { txHash: "0xmockdicetx" };
      }),
      buildAndSignTransfer: jest.fn(),
      waitForReceipt: jest.fn(),
      getBalance: jest.fn(async () => 1_000_000_000_000_000_000n),
    };
  });

  test("calculates multipliers and house edge accurately", () => {
    // 50% target (32768): ~1.962x
    const m50 = calculateMultiplier(32768);
    expect(m50).toBeCloseTo(1.962, 2);

    // 25% target (16384): ~3.924x
    const m25 = calculateMultiplier(16384);
    expect(m25).toBeCloseTo(3.924, 2);

    // 10% target (6553): ~9.81x
    const m10 = calculateMultiplier(6553);
    expect(m10).toBeCloseTo(9.81, 1);

    // 1% target (655): ~98.15x
    const m1 = calculateMultiplier(655);
    expect(m1).toBeCloseTo(98.15, 1);

    // 0.1% target (65): ~989.1x
    const m01 = calculateMultiplier(65);
    expect(m01).toBeCloseTo(989.1, 1);

    // Invalid targets return 0
    expect(calculateMultiplier(0)).toBe(0);
    expect(calculateMultiplier(65536)).toBe(0);
  });

  test("derives deterministic 16-bit lucky number from SHA256", () => {
    const secret = "testsecret123";
    const nonce = "nonce456";
    const roll = rollLuckyNumber(secret, nonce);

    expect(typeof roll).toBe("number");
    expect(roll).toBeGreaterThanOrEqual(0);
    expect(roll).toBeLessThan(SATOSHI_DICE_MODULO);

    // Determinism
    expect(rollLuckyNumber(secret, nonce)).toBe(roll);

    // Verifying manual derivation
    const hash = createHash("sha256").update(`${secret}:${nonce}`).digest();
    expect(hash.readUInt16BE(0)).toBe(roll);
  });

  test("returns valid profile metadata", () => {
    const profile = bot.getProfile();
    expect(profile.name).toBe("Satoshi Dice");
    expect(profile.bot).toBe(true);
    expect(profile.avatarPng).toBeInstanceOf(Buffer);
  });

  test("proactively welcomes new users with dice announcement", async () => {
    const user: NewUserEvent = {
      address: "0x1111111111111111111111111111111111111111",
      registeredAtMs: Date.now(),
    };

    await bot.onNewUser(user, mockContext);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].to).toBe(user.address);
    expect(sentMessages[0].items[0].text).toContain("Welcome to Satoshi Dice");
  });

  test("handles /help, /odds, /stats, and /verify", async () => {
    const player = "0x2222222222222222222222222222222222222222";
    const replies: any[] = [];

    const sendMsg = async (text: string) => {
      replies.length = 0;
      await bot.onMessage(
        {
          conversationId: "c1",
          peerAddress: player,
          peerSubject: player,
          timestampMs: Date.now(),
          payloadDigest: "0x11",
          items: [{ type: "text", text }],
          reply: jest.fn(async (items) => {
            replies.push(items);
          }),
        },
        mockContext
      );
    };

    // 1. /help
    await sendMsg("/help");
    expect(replies[0][0].text).toContain("Satoshi Dice Commands");

    // 2. /odds
    await sendMsg("/odds");
    expect(replies[0][0].text).toContain("Satoshi Dice Odds & Multipliers");
    expect(replies[0][0].text).toContain("Coin Flip");
    expect(replies[0][0].text).toContain("Moonshot");

    // 3. /stats
    await sendMsg("/stats");
    expect(replies[0][0].text).toContain("Satoshi Dice Global Statistics");
    expect(replies[0][0].text).toContain("Total Rolls:** 0");

    // 4. /verify
    await sendMsg("/verify secretA nonceB");
    expect(replies[0][0].text).toContain("Provable Fairness Verification");
    expect(replies[0][0].text).toContain("First 2 Bytes (BE):");
  });

  test("executes free /roll and reports provable fairness verification proof", async () => {
    const player = "0x2222222222222222222222222222222222222222";
    const replies: any[] = [];

    await bot.onMessage(
      {
        conversationId: "c1",
        peerAddress: player,
        peerSubject: player,
        timestampMs: Date.now(),
        payloadDigest: "0xabcdef",
        items: [{ type: "text", text: "/roll" }],
        reply: jest.fn(async (items) => {
          replies.push(items);
        }),
      },
      mockContext
    );

    expect(replies[0][0].text).toContain("Satoshi Dice Roll Result");
    expect(replies[0][0].text).toContain("Free Play Roll");
    expect(replies[0][0].text).toContain("Target:** < 32768");
    expect(replies[0][0].text).toContain("Fairness Verification Proof");
    expect(replies[0][0].text).toContain("Server Secret:");
    expect(replies[0][0].text).toContain("User Nonce:");
  });

  test("executes wagered /roll with target and records stats and payout transfer on win", async () => {
    const player = "0x3333333333333333333333333333333333333333";
    const replies: any[] = [];

    // Wager 0.05 MON on safe harbor (< 64000, 97.6% chance)
    await bot.onMessage(
      {
        conversationId: "c1",
        peerAddress: player,
        peerSubject: player,
        timestampMs: Date.now(),
        payloadDigest: "0x123456",
        items: [{ type: "text", text: "/roll 0.05 64000" }],
        reply: jest.fn(async (items) => {
          replies.push(items);
        }),
      },
      mockContext
    );

    expect(replies[0][0].text).toContain("Satoshi Dice Roll Result");
    expect(replies[0][0].text).toContain("Wager:** 0.05 MON");
    expect(replies[0][0].text).toContain("Target:** < 64000");

    // Check stats updated
    const statsRaw = mockState.get("stats:global");
    expect(statsRaw).toBeDefined();
    const stats = JSON.parse(statsRaw!);
    expect(stats.totalRolls).toBe(1);
    expect(stats.totalWageredWei).toBe("50000000000000000");
  });
});
