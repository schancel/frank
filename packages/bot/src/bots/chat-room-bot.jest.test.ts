import { ChatRoomBot } from "./chat-room-bot";
import type {
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";

describe("ChatRoomBot", () => {
  let bot: ChatRoomBot;
  let mockState: Map<string, string>;
  let mockContext: BotContext;
  let sentDirectMessages: Array<{ to: string; items: any[] }>;
  let topicSubs: Map<string, Set<string>>;

  beforeEach(() => {
    bot = new ChatRoomBot();
    mockState = new Map();
    sentDirectMessages = [];
    topicSubs = new Map();

    mockContext = {
      botId: "lobby",
      address: "0x6666666666666666666666666666666666666666",
      subject: "0x6666666666666666666666666666666666666666",
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
      subscriptions: {
        subscribe: jest.fn(async (addr, topic = "default") => {
          if (!topicSubs.has(topic)) topicSubs.set(topic, new Set());
          topicSubs.get(topic)!.add(addr.toLowerCase());
          return true;
        }),
        unsubscribe: jest.fn(async (addr, topic = "default") => {
          if (!topicSubs.has(topic)) return false;
          return topicSubs.get(topic)!.delete(addr.toLowerCase());
        }),
        isSubscribed: jest.fn(async (addr, topic = "default") => {
          return !!topicSubs.get(topic)?.has(addr.toLowerCase());
        }),
        listSubscribers: jest.fn(async (topic = "default") => {
          return Array.from(topicSubs.get(topic) ?? []);
        }),
        broadcast: jest.fn(async (items, topic = "default") => {
          const subs = Array.from(topicSubs.get(topic) ?? []);
          for (const s of subs) {
            sentDirectMessages.push({ to: s, items });
          }
          return { sent: subs.length, failed: 0 };
        }),
        handleSubscriptionCommand: jest.fn(async () => null),
      },
      lookupPeer: jest.fn(),
      sendMessage: jest.fn(async (to, items) => {
        sentDirectMessages.push({ to, items });
        return { ok: true } as any;
      }),
      sendDirectMessage: jest.fn(async (to, items) => {
        sentDirectMessages.push({ to, items });
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
    expect(profile.name).toBe("Lobby");
    expect(profile.bot).toBe(true);
    expect(profile.avatarPng).toBeInstanceOf(Buffer);
  });

  test("proactively welcomes newly registered users", async () => {
    const user: NewUserEvent = {
      address: "0x7777777777777777777777777777777777777777",
      registeredAtMs: Date.now(),
    };

    await bot.onNewUser(user, mockContext);
    expect(sentDirectMessages.length).toBe(1);
    expect(sentDirectMessages[0].to).toBe(user.address);
    expect(sentDirectMessages[0].items[0].text).toContain("Welcome to Frank! I host community group chat rooms");
  });

  test("handles /help and /nick", async () => {
    const replies: any[] = [];
    const alice = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    // 1. /help
    await bot.onMessage(
      {
        conversationId: "conv-1",
        peerAddress: alice,
        peerSubject: alice,
        timestampMs: Date.now(),
        payloadDigest: "0x11",
        items: [{ type: "text", text: "/help" }],
        reply: jest.fn(async (items) => {
          replies.push(items);
        }),
      },
      mockContext
    );
    expect(replies[0][0].text).toContain("Lobby Group Chat Commands");

    // 2. /nick Alice
    await bot.onMessage(
      {
        conversationId: "conv-1",
        peerAddress: alice,
        peerSubject: alice,
        timestampMs: Date.now(),
        payloadDigest: "0x22",
        items: [{ type: "text", text: "/nick Alice" }],
        reply: jest.fn(async (items) => {
          replies.push(items);
        }),
      },
      mockContext
    );
    expect(replies[1][0].text).toContain("updated to **Alice**");
    expect(mockState.get(`nick:${alice}`)).toBe("Alice");
  });

  test("joins rooms, manages member presence, and relays messages to participants", async () => {
    const alice = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const bob = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    mockState.set(`nick:${alice}`, "Alice");
    mockState.set(`nick:${bob}`, "Bob");

    const aliceReplies: any[] = [];
    const bobReplies: any[] = [];

    // Alice joins #general
    await bot.onMessage(
      {
        conversationId: "c1",
        peerAddress: alice,
        peerSubject: alice,
        timestampMs: Date.now(),
        payloadDigest: "0x01",
        items: [{ type: "text", text: "/join" }],
        reply: jest.fn(async (items) => {
          aliceReplies.push(items);
        }),
      },
      mockContext
    );
    expect(aliceReplies[0][0].text).toContain("You joined **#general**");
    expect(await mockContext.subscriptions.isSubscribed(alice, "room:general")).toBe(true);

    // Bob joins #general
    await bot.onMessage(
      {
        conversationId: "c2",
        peerAddress: bob,
        peerSubject: bob,
        timestampMs: Date.now(),
        payloadDigest: "0x02",
        items: [{ type: "text", text: "/join general" }],
        reply: jest.fn(async (items) => {
          bobReplies.push(items);
        }),
      },
      mockContext
    );
    expect(
      sentDirectMessages.some(
        (m) =>
          m.to === alice &&
          m.items[0].text.includes("Bob") &&
          m.items[0].text.includes("joined the room")
      )
    ).toBe(true);

    // Alice checks /who
    aliceReplies.length = 0;
    await bot.onMessage(
      {
        conversationId: "c1",
        peerAddress: alice,
        peerSubject: alice,
        timestampMs: Date.now(),
        payloadDigest: "0x03",
        items: [{ type: "text", text: "/who" }],
        reply: jest.fn(async (items) => {
          aliceReplies.push(items);
        }),
      },
      mockContext
    );
    expect(aliceReplies[0][0].text).toContain("Members in #general");
    expect(aliceReplies[0][0].text).toContain("Alice");
    expect(aliceReplies[0][0].text).toContain("Bob");

    // Alice sends a message in #general
    sentDirectMessages.length = 0;
    aliceReplies.length = 0;
    await bot.onMessage(
      {
        conversationId: "c1",
        peerAddress: alice,
        peerSubject: alice,
        timestampMs: Date.now(),
        payloadDigest: "0x04",
        items: [{ type: "text", text: "Hey everyone! How is Monad testnet today?" }],
        reply: jest.fn(async (items) => {
          aliceReplies.push(items);
        }),
      },
      mockContext
    );

    // Bob received the broadcast
    expect(sentDirectMessages.length).toBe(1);
    expect(sentDirectMessages[0].to).toBe(bob);
    expect(sentDirectMessages[0].items[0].text).toBe("[**#general**] **Alice**: Hey everyone! How is Monad testnet today?");
    // Alice didn't receive an echo in sentDirectMessages
    expect(sentDirectMessages.some((m) => m.to === alice)).toBe(false);

    // Bob leaves #general
    bobReplies.length = 0;
    sentDirectMessages.length = 0;
    await bot.onMessage(
      {
        conversationId: "c2",
        peerAddress: bob,
        peerSubject: bob,
        timestampMs: Date.now(),
        payloadDigest: "0x05",
        items: [{ type: "text", text: "/leave" }],
        reply: jest.fn(async (items) => {
          bobReplies.push(items);
        }),
      },
      mockContext
    );
    expect(bobReplies[0][0].text).toContain("You left **#general**");
    expect(await mockContext.subscriptions.isSubscribed(bob, "room:general")).toBe(false);
    expect(
      sentDirectMessages.some(
        (m) =>
          m.to === alice &&
          m.items[0].text.includes("Bob") &&
          m.items[0].text.includes("left the room")
      )
    ).toBe(true);
  });
});
