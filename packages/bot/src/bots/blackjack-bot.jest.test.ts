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
          type: "blackjack-move",
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
    expect(mockReply.mock.calls.length).toBeGreaterThanOrEqual(1);
    const replyItems = mockReply.mock.calls[0][0];
    expect(replyItems[0].action).toMatch(/deal|reveal/);
    expect(memoryState.has("game:game-456")).toBe(true);
  });

  it("broadcasts StateChannel.closeCooperative when channelId is present and sendTransaction is available", async () => {
    const mockReply = jest.fn();
    const mockSendTx = jest.fn(async () => ({ txHash: "0xchannelsettle999" }));
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

    const channelId = "0x" + "11".repeat(32);
    const ctx = {
      conversationId: "game-channel-1",
      peerAddress: "0x1234567890123456789012345678901234567890",
      peerSubject: "subject-456",
      timestampMs: Date.now(),
      payloadDigest: "digest-456",
      items: [
        {
          type: "blackjack-move",
          action: "bet",
          gameId: "game-channel-1",
          wagerWei: "10000000000000000",
          channelId,
          seq: 1,
        },
      ],
      reply: mockReply,
      state: mockState,
      sendTransaction: mockSendTx,
      address: "0x2222222222222222222222222222222222222222",
    } as any;

    await bot.onMessage(ctx);

    // If natural blackjack, sendTransaction is called immediately
    // If not natural blackjack, simulate stand to trigger settlement
    if (mockSendTx.mock.calls.length === 0) {
      const standCtx = {
        conversationId: "game-channel-1",
        peerAddress: "0x1234567890123456789012345678901234567890",
        items: [
          {
            type: "blackjack-move",
            action: "stand",
            gameId: "game-channel-1",
          },
        ],
        reply: mockReply,
        state: mockState,
        sendTransaction: mockSendTx,
        address: "0x2222222222222222222222222222222222222222",
      } as any;
      await bot.onMessage(standCtx);
    }

    expect(mockSendTx).toHaveBeenCalledTimes(1);
    expect(mockSendTx.mock.calls[0][0].to).toBe("0x18E98e3B789F0b84c7060Bb28bF4385809F3aF57");
    expect(mockSendTx.mock.calls[0][0].data).toMatch(/^0x/);

    const lastReply = mockReply.mock.calls[mockReply.mock.calls.length - 1][0];
    const revealItem = lastReply.find((i: any) => i.action === "reveal");
    expect(revealItem).toBeDefined();
    expect(revealItem.payoutTxHash).toBe("0xchannelsettle999");
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
