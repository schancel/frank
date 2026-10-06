import { RaffleBot } from "./raffle-bot";
import type {
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";

describe("RaffleBot", () => {
  let bot: RaffleBot;
  let mockState: Map<string, string>;
  let mockContext: BotContext;
  let sentMessages: Array<{ to: string; items: any[] }>;
  let transfers: Array<{ to: string; valueWei: bigint }>;

  beforeEach(() => {
    bot = new RaffleBot({ maxEntries: 2, entryPriceWei: 20_000_000_000_000_000n });
    mockState = new Map();
    sentMessages = [];
    transfers = [];

    mockContext = {
      botId: "raffle",
      address: "0x1111111111111111111111111111111111111111",
      subject: "0x1111111111111111111111111111111111111111",
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
      sendTransfer: jest.fn(async ({ to, valueWei }) => {
        transfers.push({ to, valueWei });
        return { txHash: "0x" + "aa".repeat(32) };
      }),
      buildAndSignTransfer: jest.fn(),
      waitForReceipt: jest.fn(),
      getBalance: jest.fn(async () => 1_000_000_000_000_000_000n),
    };
  });

  test("returns valid profile with avatar and bot flag", () => {
    const profile = bot.getProfile();
    expect(profile.name).toBe("Raffle");
    expect(profile.bot).toBe(true);
    expect(profile.avatarPng).toBeInstanceOf(Buffer);
  });

  test("proactively welcomes new user with announce item", async () => {
    const user: NewUserEvent = {
      address: "0x2222222222222222222222222222222222222222",
      registeredAtMs: Date.now(),
    };

    await bot.onNewUser(user, mockContext);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].to).toBe(user.address);
    const announceItem = sentMessages[0].items.find(
      (it) => it.type === "raffle" && it.action === "announce"
    );
    expect(announceItem).toBeDefined();
    expect(announceItem.maxEntries).toBe(2);
  });

  test("replies with status when user sends non-enter message", async () => {
    const replies: any[] = [];
    const msgCtx: BotMessageContext = {
      conversationId: "conv-1",
      peerAddress: "0x3333333333333333333333333333333333333333",
      peerSubject: "0x3333333333333333333333333333333333333333",
      timestampMs: Date.now(),
      payloadDigest: "0x" + "11".repeat(32),
      items: [{ type: "text", text: "how does this work?" }],
      reply: jest.fn(async (items) => {
        replies.push(items);
      }),
    };

    await bot.onMessage(msgCtx, mockContext);
    expect(replies.length).toBe(1);
    expect(replies[0][0].action).toBe("announce");
  });

  test("handles entries and executes draw when maxEntries is reached", async () => {
    // Player 1 enters
    const p1Replies: any[] = [];
    const msg1: BotMessageContext = {
      conversationId: "conv-1",
      peerAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      peerSubject: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      timestampMs: Date.now(),
      payloadDigest: "0x" + "11".repeat(32),
      items: [{ type: "raffle", action: "enter" }],
      reply: jest.fn(async (items) => {
        p1Replies.push(items);
      }),
    };
    await bot.onMessage(msg1, mockContext);
    expect(p1Replies.length).toBe(1);
    expect(p1Replies[0][0].action).toBe("announce");
    expect(transfers.length).toBe(0);

    // Player 2 enters -> triggers draw
    const p2Replies: any[] = [];
    const msg2: BotMessageContext = {
      conversationId: "conv-2",
      peerAddress: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      peerSubject: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      timestampMs: Date.now(),
      payloadDigest: "0x" + "22".repeat(32),
      items: [{ type: "raffle", action: "enter" }],
      reply: jest.fn(async (items) => {
        p2Replies.push(items);
      }),
    };
    await bot.onMessage(msg2, mockContext);

    // Winner was drawn and transfer sent!
    expect(transfers.length).toBe(1);
    expect(transfers[0].valueWei).toBe(40_000_000_000_000_000n); // 0.02 * 2
    expect(
      [
        "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      ].includes(transfers[0].to)
    ).toBe(true);
  });
});
