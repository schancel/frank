import { QwenBot } from "./qwen-bot";
import type {
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";

describe("QwenBot", () => {
  let bot: QwenBot;
  let mockState: Map<string, string>;
  let mockContext: BotContext;
  let sentMessages: Array<{ to: string; items: any[] }>;

  beforeEach(() => {
    bot = new QwenBot({
      config: { mode: "stub" },
    });
    mockState = new Map();
    sentMessages = [];

    mockContext = {
      botId: "qwen",
      address: "0x3333333333333333333333333333333333333333",
      subject: "0x3333333333333333333333333333333333333333",
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
      sendTransfer: jest.fn(),
      buildAndSignTransfer: jest.fn(),
      waitForReceipt: jest.fn(),
      getBalance: jest.fn(async () => 1_000_000_000_000_000_000n),
    };
  });

  test("returns valid profile metadata", () => {
    const profile = bot.getProfile();
    expect(profile.name).toBe("Qwen");
    expect(profile.bot).toBe(true);
    expect(profile.avatarPng).toBeInstanceOf(Buffer);
  });

  test("proactively welcomes newly registered users", async () => {
    const user: NewUserEvent = {
      address: "0x4444444444444444444444444444444444444444",
      registeredAtMs: Date.now(),
    };

    await bot.onNewUser(user, mockContext);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].to).toBe(user.address);
    expect(sentMessages[0].items[0].text).toContain("Hello! I am Qwen");
  });

  test("replies to user query with stub response and saves history", async () => {
    const replies: any[] = [];
    const msgCtx: BotMessageContext = {
      conversationId: "conv-1",
      peerAddress: "0x5555555555555555555555555555555555555555",
      peerSubject: "0x5555555555555555555555555555555555555555",
      timestampMs: Date.now(),
      payloadDigest: "0x" + "11".repeat(32),
      items: [{ type: "text", text: "What is the capital of France?" }],
      reply: jest.fn(async (items) => {
        replies.push(items);
      }),
    };

    await bot.onMessage(msgCtx, mockContext);
    expect(replies.length).toBe(1);
    expect(replies[0][0].text).toContain("STUB");
    expect(mockState.has("history:0x5555555555555555555555555555555555555555")).toBe(true);
  });
});
