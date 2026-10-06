import { BlackjackDealerBot } from "./blackjack-bot";

describe("BlackjackDealerBot", () => {
  let bot: BlackjackDealerBot;

  beforeEach(() => {
    bot = new BlackjackDealerBot();
  });

  it("provides the correct profile metadata", () => {
    const profile = bot.getProfile();
    expect(profile.name).toBe("Blackjack Dealer");
    expect(profile.bio).toContain("blackjack");
    expect(profile.bot).toBe(true);
    expect(profile.avatarPng).toBeDefined();
  });

  it("responds with welcome and instructions on empty/plain text message", async () => {
    const mockReply = jest.fn();
    const ctx = {
      conversationId: "conv-123",
      peerAddress: "0x1234567890123456789012345678901234567890",
      peerSubject: "subject-123",
      timestampMs: Date.now(),
      payloadDigest: "digest-123",
      items: [{ type: "text", text: "hello" }],
      reply: mockReply,
    } as any;

    await bot.onMessage(ctx);
    expect(mockReply).toHaveBeenCalledTimes(1);
    const replyItems = mockReply.mock.calls[0][0];
    expect(replyItems).toHaveLength(2);
    expect(replyItems[0].text).toContain("Welcome to Frank Blackjack");
  });

  it("deals a provably fair hand on valid bet", async () => {
    const mockReply = jest.fn();
    const memoryState = new Map<string, any>();
    const mockState = {
      get: jest.fn(async (key: string) => memoryState.get(key)),
      getJson: jest.fn(async (key: string) => memoryState.get(key)),
      put: jest.fn(async (key: string, val: any) => memoryState.set(key, val)),
      putJson: jest.fn(async (key: string, val: any) =>
        memoryState.set(key, val)
      ),
      del: jest.fn(async (key: string) => memoryState.delete(key)),
    };

    const ctx = {
      conversationId: "game-456",
      peerAddress: "0x1234567890123456789012345678901234567890",
      peerSubject: "subject-456",
      timestampMs: Date.now(),
      payloadDigest: "digest-456",
      items: [
        {
          type: "blackjack_move",
          action: "bet",
          gameId: "game-456",
          wagerWei: "10000000000000000", // 0.01 MON
          wagerTxHash:
            "0x1111222233334444555566667777888899990000111122223333444455556666",
        },
      ],
      reply: mockReply,
      state: mockState,
    } as any;

    await bot.onMessage(ctx);
    expect(mockReply).toHaveBeenCalledTimes(1);
    const replyItems = mockReply.mock.calls[0][0];
    expect(replyItems[0].action).toMatch(/deal|reveal/);
    expect(memoryState.has("game:game-456")).toBe(true);
  });

  it("challenges a newly registered user with blackjack welcome items", async () => {
    const mockSendMessage = jest.fn();
    const botCtx = {
      sendMessage: mockSendMessage,
    } as any;

    const userEvent = {
      address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      registeredAtMs: Date.now(),
    };

    await bot.onNewUser(userEvent, botCtx);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(
      "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      expect.arrayContaining([
        expect.objectContaining({ type: "blackjack-move", action: "welcome" }),
        expect.objectContaining({ type: "text" }),
      ])
    );
  });
});
