import { VendorBot } from "./vendor-bot";
import type {
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";
import type { VendorCatalogItem } from "../../vendor-catalog";

describe("VendorBot", () => {
  let bot: VendorBot;
  let mockContext: BotContext;
  let sentMessages: Array<{ to: string; items: any[] }>;

  const testCatalog: VendorCatalogItem[] = [
    {
      itemId: "test-art-1",
      description: "Test Art 1",
      priceWei: 10_000_000_000_000_000n,
      image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    },
  ];

  beforeEach(() => {
    bot = new VendorBot({ catalogItems: testCatalog });
    sentMessages = [];

    mockContext = {
      botId: "vendor",
      address: "0x2222222222222222222222222222222222222222",
      subject: "0x2222222222222222222222222222222222222222",
      relayBaseUrl: "http://127.0.0.1:8098",
      networkTag: "MONT",
      provider: {} as any,
      state: {} as any,
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

  test("provides profile metadata", () => {
    const profile = bot.getProfile();
    expect(profile.name).toBe("Picture Shop");
    expect(profile.bot).toBe(true);
    expect(profile.avatarPng).toBeInstanceOf(Buffer);
  });

  test("proactively sends catalog to new user", async () => {
    const user: NewUserEvent = {
      address: "0x3333333333333333333333333333333333333333",
      registeredAtMs: Date.now(),
    };

    await bot.onNewUser(user, mockContext);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].to).toBe(user.address);
    const catalogItem = sentMessages[0].items.find(
      (it) => it.type === "digital-goods" && it.action === "catalog"
    );
    expect(catalogItem).toBeDefined();
  });

  test("replies with catalog when sent plain text", async () => {
    const replies: any[] = [];
    const msgCtx: BotMessageContext = {
      conversationId: "conv-1",
      peerAddress: "0x4444444444444444444444444444444444444444",
      peerSubject: "0x4444444444444444444444444444444444444444",
      timestampMs: Date.now(),
      payloadDigest: "0x" + "11".repeat(32),
      items: [{ type: "text", text: "what do you have?" }],
      reply: jest.fn(async (items) => {
        replies.push(items);
      }),
    };

    await bot.onMessage(msgCtx, mockContext);
    expect(replies.length).toBe(1);
    expect(replies[0][0].action).toBe("catalog");
  });

  test("fulfills purchase request for valid catalog item", async () => {
    const replies: any[] = [];
    const msgCtx: BotMessageContext = {
      conversationId: "conv-1",
      peerAddress: "0x4444444444444444444444444444444444444444",
      peerSubject: "0x4444444444444444444444444444444444444444",
      timestampMs: Date.now(),
      payloadDigest: "0x" + "22".repeat(32),
      items: [{ type: "digital-goods", action: "request", itemId: "test-art-1" }],
      reply: jest.fn(async (items) => {
        replies.push(items);
      }),
    };

    await bot.onMessage(msgCtx, mockContext);
    expect(replies.length).toBe(1);
    const fulfillItem = replies[0].find(
      (it: any) => it.type === "digital-goods" && it.action === "fulfill"
    );
    expect(fulfillItem).toBeDefined();
    expect(fulfillItem.itemId).toBe("test-art-1");
  });
});
