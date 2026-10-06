import { RpsBot, evaluateRps } from "./rps-bot";
import { createHash } from "crypto";
import type {
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";

describe("RpsBot", () => {
  let bot: RpsBot;
  let mockState: Map<string, string>;
  let mockContext: BotContext;
  let sentMessages: Array<{ to: string; items: any[] }>;
  let transferredFunds: Array<{ to: string; valueWei: bigint }>;

  beforeEach(() => {
    bot = new RpsBot();
    mockState = new Map();
    sentMessages = [];
    transferredFunds = [];

    mockContext = {
      botId: "rps",
      address: "0x8888888888888888888888888888888888888888",
      subject: "0x8888888888888888888888888888888888888888",
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
        return { txHash: "0xmocktxhash" };
      }),
      buildAndSignTransfer: jest.fn(),
      waitForReceipt: jest.fn(),
      getBalance: jest.fn(async () => 1_000_000_000_000_000_000n),
    };
  });

  test("evaluates game outcomes accurately", () => {
    expect(evaluateRps("rock", "scissors")).toBe("win");
    expect(evaluateRps("paper", "rock")).toBe("win");
    expect(evaluateRps("scissors", "paper")).toBe("win");

    expect(evaluateRps("scissors", "rock")).toBe("lose");
    expect(evaluateRps("rock", "paper")).toBe("lose");
    expect(evaluateRps("paper", "scissors")).toBe("lose");

    expect(evaluateRps("rock", "rock")).toBe("tie");
    expect(evaluateRps("paper", "paper")).toBe("tie");
    expect(evaluateRps("scissors", "scissors")).toBe("tie");
  });

  test("returns valid profile metadata", () => {
    const profile = bot.getProfile();
    expect(profile.name).toBe("RPS Arena");
    expect(profile.bot).toBe(true);
    expect(profile.avatarPng).toBeInstanceOf(Buffer);
  });

  test("proactively welcomes new users with game invitation", async () => {
    const user: NewUserEvent = {
      address: "0x9999999999999999999999999999999999999999",
      registeredAtMs: Date.now(),
    };

    await bot.onNewUser(user, mockContext);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].to).toBe(user.address);
    expect(sentMessages[0].items[0].text).toContain("Welcome to Frank! I am the RPS Arena bot");
  });

  test("starts provably fair match with cryptographic commitment and resolves player move", async () => {
    const player = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const startReplies: any[] = [];

    // 1. /rps
    await bot.onMessage(
      {
        conversationId: "c1",
        peerAddress: player,
        peerSubject: player,
        timestampMs: Date.now(),
        payloadDigest: "0x11",
        items: [{ type: "text", text: "/rps" }],
        reply: jest.fn(async (items) => {
          startReplies.push(items);
        }),
      },
      mockContext
    );

    const startText = startReplies[0].find((i: any) => i.type === "text")?.text;
    const startItem = startReplies[0].find((i: any) => i.type === "rps");
    expect(startItem).toBeDefined();
    expect(startItem?.action).toBe("start");
    expect(startText).toContain("Rock-Paper-Scissors Match Started!");
    expect(startText).toContain("Cryptographic Commitment");

    // Verify commitment was saved in state
    const rawMatch = mockState.get(`rps:match:${player}`);
    expect(rawMatch).toBeDefined();
    const match = JSON.parse(rawMatch!);
    expect(match.commitHash).toBeDefined();
    expect(match.botMove).toBeDefined();
    expect(match.salt).toBeDefined();

    // Verify hash integrity: SHA256(botMove:salt) === commitHash
    const expectedHash = createHash("sha256").update(`${match.botMove}:${match.salt}`).digest("hex");
    expect(match.commitHash).toBe(expectedHash);

    // 2. Player chooses /rock
    const playReplies: any[] = [];
    await bot.onMessage(
      {
        conversationId: "c1",
        peerAddress: player,
        peerSubject: player,
        timestampMs: Date.now(),
        payloadDigest: "0x22",
        items: [{ type: "text", text: "/rock" }],
        reply: jest.fn(async (items) => {
          playReplies.push(items);
        }),
      },
      mockContext
    );

    const playText = playReplies[0].find((i: any) => i.type === "text")?.text;
    const playItem = playReplies[0].find((i: any) => i.type === "rps");
    expect(playItem).toBeDefined();
    expect(playItem?.action).toBe("resolve");
    expect(playText).toContain("You chose: 🪨 Rock");
    expect(playText).toContain(`I chose:`);
    expect(playText).toContain("Fairness Verification");
    expect(playText).toContain(match.commitHash);
    expect(playText).toContain(match.salt);

    // Match record removed from state to prevent replay
    expect(mockState.has(`rps:match:${player}`)).toBe(false);
  });

  test("handles wager payouts when player wins against bot", async () => {
    const player = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    // Manually set an active match where bot chose scissors and wager is 0.05 MON (50_000_000_000_000_000 wei)
    const wagerWei = "50000000000000000";
    const salt = "deadbeef";
    const commitHash = createHash("sha256").update(`scissors:${salt}`).digest("hex");

    mockState.set(
      `rps:match:${player}`,
      JSON.stringify({
        commitHash,
        botMove: "scissors",
        salt,
        wagerWei,
        timestampMs: Date.now(),
      })
    );

    const playReplies: any[] = [];
    // Player sends /rock -> beats scissors!
    await bot.onMessage(
      {
        conversationId: "c1",
        peerAddress: player,
        peerSubject: player,
        timestampMs: Date.now(),
        payloadDigest: "0x33",
        items: [{ type: "text", text: "/rock" }],
        reply: jest.fn(async (items) => {
          playReplies.push(items);
        }),
      },
      mockContext
    );

    const winText = playReplies[0].find((i: any) => i.type === "text")?.text;
    expect(winText).toContain("YOU WIN!");
    expect(winText).toContain("Payout Sent!");
    expect(transferredFunds.length).toBe(1);
    expect(transferredFunds[0].to).toBe(player);
    // Double payout (0.1 MON)
    expect(transferredFunds[0].valueWei).toBe(100_000_000_000_000_000n);
  });

  test("handles P2P challenges and resolves game between two players", async () => {
    const alice = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const bob = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    // 1. Alice challenges Bob
    const aliceReplies: any[] = [];
    await bot.onMessage(
      {
        conversationId: "c1",
        peerAddress: alice,
        peerSubject: alice,
        timestampMs: Date.now(),
        payloadDigest: "0x01",
        items: [{ type: "text", text: `/challenge ${bob} 0.02` }],
        reply: jest.fn(async (items) => {
          aliceReplies.push(items);
        }),
      },
      mockContext
    );

    expect(aliceReplies[0][0].text).toContain("Challenge created!");
    expect(sentMessages.some((m) => m.to === bob && m.items[0].text.includes("New RPS Challenge!"))).toBe(true);

    // Extract challengeId from state
    const challengeKey = Array.from(mockState.keys()).find((k) => k.startsWith("rps:challenge:"))!;
    const challengeId = challengeKey.replace("rps:challenge:", "");

    // 2. Bob accepts challenge
    const bobReplies: any[] = [];
    await bot.onMessage(
      {
        conversationId: "c2",
        peerAddress: bob,
        peerSubject: bob,
        timestampMs: Date.now(),
        payloadDigest: "0x02",
        items: [{ type: "text", text: `/accept ${challengeId}` }],
        reply: jest.fn(async (items) => {
          bobReplies.push(items);
        }),
      },
      mockContext
    );

    expect(bobReplies[0][0].text).toContain("Accepted!");
    expect(sentMessages.some((m) => m.to === alice && m.items[0].text.includes("Accepted!"))).toBe(true);

    // 3. Alice submits move: rock
    aliceReplies.length = 0;
    await bot.onMessage(
      {
        conversationId: "c1",
        peerAddress: alice,
        peerSubject: alice,
        timestampMs: Date.now(),
        payloadDigest: "0x03",
        items: [{ type: "text", text: `/move ${challengeId} rock` }],
        reply: jest.fn(async (items) => {
          aliceReplies.push(items);
        }),
      },
      mockContext
    );
    expect(aliceReplies[0][0].text).toContain("Move locked in!");

    // 4. Bob submits move: scissors -> Alice wins!
    sentMessages.length = 0;
    await bot.onMessage(
      {
        conversationId: "c2",
        peerAddress: bob,
        peerSubject: bob,
        timestampMs: Date.now(),
        payloadDigest: "0x04",
        items: [{ type: "text", text: `/move ${challengeId} scissors` }],
        reply: jest.fn(),
      },
      mockContext
    );

    // Both players notified of final resolution
    expect(sentMessages.length).toBe(2);
    expect(sentMessages[0].items[0].text).toContain("P2P Match Resolved!");
    expect(sentMessages[0].items[0].text).toContain("WINNER: 0xaaaa");
    expect(sentMessages[1].items[0].text).toContain("WINNER: 0xaaaa");
  });
});
