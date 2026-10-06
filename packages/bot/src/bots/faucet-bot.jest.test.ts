import { FaucetBot } from "./faucet-bot";
import type {
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";

describe("FaucetBot", () => {
  let bot: FaucetBot;
  let mockState: Map<string, string>;
  let mockContext: BotContext;
  let sentTransfers: Array<{ to: string; valueWei: bigint }>;
  let sentMessages: Array<{ to: string; items: any[] }>;

  beforeEach(() => {
    bot = new FaucetBot({
      amountWei: 50_000_000_000_000_000n, // 0.05 MON
      minReserveWei: 100_000_000_000_000_000n, // 0.1 MON
    });
    mockState = new Map();
    sentTransfers = [];
    sentMessages = [];

    mockContext = {
      botId: "faucet",
      address: "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
      subject: "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
      relayBaseUrl: "http://127.0.0.1:8098",
      networkTag: "MONT",
      provider: {
        getBalance: jest.fn(async () => 0n), // New user has 0 balance
      } as any,
      state: {
        get: jest.fn(async (k: string) => mockState.get(k)),
        put: jest.fn(async (k: string, v: string) => {
          mockState.set(k, v);
        }),
        del: jest.fn(async (k: string) => {
          mockState.delete(k);
        }),
        batch: jest.fn(async () => {}),
        sublevel: jest.fn(),
      },
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
        sentTransfers.push({ to, valueWei });
        return { txHash: "0x" + "ff".repeat(32) };
      }),
      buildAndSignTransfer: jest.fn(),
      waitForReceipt: jest.fn(),
      getBalance: jest.fn(async () => 1_000_000_000_000_000_000n), // 1 MON faucet balance
    };
  });

  test("provides profile metadata", () => {
    const profile = bot.getProfile();
    expect(profile.name).toBe("Monad Faucet");
    expect(profile.bot).toBe(true);
    expect(profile.avatarPng).toBeInstanceOf(Buffer);
  });

  test("funds new user on registration and sends confirmation DM", async () => {
    const user: NewUserEvent = {
      address: "0x1234567890123456789012345678901234567890",
      registeredAtMs: Date.now(),
    };

    await bot.onNewUser(user, mockContext);
    expect(sentTransfers.length).toBe(1);
    expect(sentTransfers[0].to).toBe(user.address);
    expect(sentTransfers[0].valueWei).toBe(50_000_000_000_000_000n);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].to).toBe(user.address);

    // Second call for the same user should be a no-op
    await bot.onNewUser(user, mockContext);
    expect(sentTransfers.length).toBe(1);
  });

  test("handles DM request from user eligible for funds", async () => {
    const replies: any[] = [];
    const msgCtx: BotMessageContext = {
      conversationId: "conv-1",
      peerAddress: "0x9876543210987654321098765432109876543210",
      peerSubject: "0x9876543210987654321098765432109876543210",
      timestampMs: Date.now(),
      payloadDigest: "0x" + "aa".repeat(32),
      items: [{ type: "text", text: "faucet please" }],
      reply: jest.fn(async (items) => {
        replies.push(items);
      }),
    };

    await bot.onMessage(msgCtx, mockContext);
    expect(sentTransfers.length).toBe(1);
    expect(replies.length).toBe(1);
    expect(replies[0][0].text).toContain("Sent 0.05 MON");
  });
});
