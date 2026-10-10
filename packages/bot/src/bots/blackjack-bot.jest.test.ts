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

  it("responds with blackjack-hand challenge on empty/plain text message", async () => {
    const mockReply = jest.fn();
    const memoryState = new Map<string, any>();
    const mockState = {
      get: jest.fn(async (key: string) => memoryState.get(key)),
      getJson: jest.fn(async (key: string) => memoryState.get(key)),
      put: jest.fn(async (key: string, val: any) => memoryState.set(key, val)),
      putJson: jest.fn(async (key: string, val: any) => memoryState.set(key, val)),
      del: jest.fn(async (key: string) => memoryState.delete(key)),
    };
    const ctx = {
      conversationId: "conv-123",
      peerAddress: "0x1234567890123456789012345678901234567890",
      peerSubject: "subject-123",
      timestampMs: Date.now(),
      payloadDigest: "digest-123",
      items: [{ type: "text", text: "How do I challenge?" }],
      reply: mockReply,
      state: mockState,
      address: "0x2222222222222222222222222222222222222222",
      getBalance: jest.fn(async () => 500_000_000_000_000_000n),
    } as any;

    await bot.onMessage(ctx);
    expect(mockReply).toHaveBeenCalledTimes(1);
    const replyItems = mockReply.mock.calls[0][0];
    expect(replyItems).toHaveLength(2);
    expect(replyItems[0].type).toBe("blackjack-hand");
    expect(replyItems[0].action).toBe("challenge");
    expect(replyItems[0].role).toBe("dealer");
    expect(replyItems[1].text).toContain("blackjack challenge");
  });

  it.each([
    [
      "a legacy blackjack-move bet",
      {
        type: "blackjack-move",
        action: "bet",
        gameId: "g",
        wagerWei: "10000000000000000",
        wagerTxHash: "0x" + "11".repeat(32),
      },
    ],
    [
      "a legacy blackjack-move stand",
      { type: "blackjack-move", action: "stand", gameId: "g" },
    ],
    [
      "any other item that has an action",
      { type: "raffle", action: "bet", raffleId: "r" },
    ],
    [
      "an item the reader kept as unsupported",
      {
        type: "unsupported",
        reason: "unknown-type",
        itemType: "blackjack-move",
        frameType: 27,
        frame: "00",
      },
    ],
  ])(
    "has no legacy bet path: %s deals nothing and pays nothing",
    async (_, item) => {
      const mockReply = jest.fn(async () => ({
        payloadDigest: "d",
        stampValueWei: 0n,
      }));
      const sendTransfer = jest.fn();
      const sendTransaction = jest.fn();
      const memoryState = new Map<string, any>();
      const ctx = {
        conversationId: "game-456",
        peerAddress: "0x1234567890123456789012345678901234567890",
        peerSubject: "subject-456",
        timestampMs: Date.now(),
        payloadDigest: "digest-456",
        stampValueWei: 0n,
        items: [item],
        reply: mockReply,
        address: "0x2222222222222222222222222222222222222222",
        getBalance: async () => 10n ** 18n,
        sendTransfer,
        sendTransaction,
        state: {
          get: async (key: string) => memoryState.get(key),
          put: async (key: string, val: any) => void memoryState.set(key, val),
          del: async (key: string) => void memoryState.delete(key),
        },
      } as any;

      await bot.onMessage(ctx);

      // The only answer is a fresh peer-to-peer challenge, as for plain text.
      expect(mockReply).toHaveBeenCalledTimes(1);
      const replied = (mockReply.mock.calls[0] as any[])[0] as any[];
      expect(replied.map((i) => i.type)).toEqual(["blackjack-hand", "text"]);
      expect(replied[0].action).toBe("challenge");
      expect(sendTransfer).not.toHaveBeenCalled();
      expect(sendTransaction).not.toHaveBeenCalled();
      expect([...memoryState.keys()].some((k) => k.startsWith("game:"))).toBe(
        false
      );
    }
  );

  it("challenges a newly registered user with blackjack-hand challenge", async () => {
    const mockSendMessage = jest.fn();
    const memoryState = new Map<string, any>();
    const mockState = {
      get: jest.fn(async (key: string) => memoryState.get(key)),
      getJson: jest.fn(async (key: string) => memoryState.get(key)),
      put: jest.fn(async (key: string, val: any) => memoryState.set(key, val)),
      putJson: jest.fn(async (key: string, val: any) => memoryState.set(key, val)),
      del: jest.fn(async (key: string) => memoryState.delete(key)),
    };
    const botCtx = {
      sendMessage: mockSendMessage,
      state: mockState,
      address: "0x2222222222222222222222222222222222222222",
      getBalance: jest.fn(async () => 500_000_000_000_000_000n),
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
        expect.objectContaining({
          type: "blackjack-hand",
          action: "challenge",
          role: "dealer",
        }),
        expect.objectContaining({ type: "text" }),
      ])
    );
  });

  it("accepts a player-initiated challenge with blackjack-hand accept", async () => {
    const mockReply = jest.fn();
    const memoryState = new Map<string, any>();
    const mockState = {
      get: jest.fn(async (key: string) => memoryState.get(key)),
      getJson: jest.fn(async (key: string) => memoryState.get(key)),
      put: jest.fn(async (key: string, val: any) => memoryState.set(key, val)),
      putJson: jest.fn(async (key: string, val: any) => memoryState.set(key, val)),
      del: jest.fn(async (key: string) => memoryState.delete(key)),
    };
    const gameId = "11112222333344445555666677778888";
    const ctx = {
      conversationId: "conv-player-chal",
      peerAddress: "0x1234567890123456789012345678901234567890",
      peerSubject: "subject-chal",
      timestampMs: Date.now(),
      payloadDigest: "digest-chal-12345678901234567890123456789012345678901234567890123456",
      items: [
        {
          type: "blackjack-hand",
          gameId,
          action: "challenge",
          role: "player",
          maxBetWei: "50000000000000000",
          seq: 0,
        },
      ],
      reply: mockReply,
      state: mockState,
      address: "0x2222222222222222222222222222222222222222",
      getBalance: jest.fn(async () => 500_000_000_000_000_000n),
    } as any;

    await bot.onMessage(ctx);
    expect(mockReply).toHaveBeenCalledTimes(1);
    const replyItems = mockReply.mock.calls[0][0];
    expect(replyItems[0].type).toBe("blackjack-hand");
    expect(replyItems[0].action).toBe("accept");
    expect(replyItems[0].commitment).toBeDefined();
    expect(replyItems[1].text).toContain("Challenge accepted");
  });

  it("handles a full peer-to-peer hand: bet -> deal -> stand -> reveal", async () => {
    const memoryState = new Map<string, any>();
    const mockState = {
      get: jest.fn(async (key: string) => memoryState.get(key)),
      getJson: jest.fn(async (key: string) => memoryState.get(key)),
      put: jest.fn(async (key: string, val: any) => memoryState.set(key, val)),
      putJson: jest.fn(async (key: string, val: any) => memoryState.set(key, val)),
      del: jest.fn(async (key: string) => memoryState.delete(key)),
    };

    // 1. Initial challenge from plain text
    let lastReply: any;
    const mockReply1 = jest.fn(async (items: any[]) => {
      lastReply = items;
      return {
        payloadDigest: "digest-dealer-challenge-1111222233334444555566667777888899990000",
        stampValueWei: 10_000_000_000_000_000n,
      };
    });

    await bot.onMessage({
      conversationId: "conv-p2p-full",
      peerAddress: "0x1234567890123456789012345678901234567890",
      payloadDigest: "digest-text-how-do-i-challenge-11112222333344445555666677778888",
      items: [{ type: "text", text: "How do I challenge?" }],
      reply: mockReply1,
      state: mockState,
      address: "0x2222222222222222222222222222222222222222",
      getBalance: jest.fn(async () => 500_000_000_000_000_000n),
    } as any);

    expect(mockReply1).toHaveBeenCalledTimes(1);
    const challengeItem = lastReply[0];
    expect(challengeItem.action).toBe("challenge");
    const gameId = challengeItem.gameId;

    // 2. Player bets
    const {
      entropyChain,
      CHAIN_LENGTH,
    } = require("@frank/wallet/message-item-plugins/blackjack/entropy");
    const playerSeed = "aa".repeat(32);
    const playerCommitment = entropyChain(playerSeed)[0];

    const mockReply2 = jest.fn(async (items: any[]) => {
      lastReply = items;
      return {
        payloadDigest: "digest-dealer-deal-11112222333344445555666677778888999900001111",
        stampValueWei: 10_000_000_000_000_000n,
      };
    });

    await bot.onMessage({
      conversationId: "conv-p2p-full",
      peerAddress: "0x1234567890123456789012345678901234567890",
      payloadDigest: "digest-player-bet-111122223333444455556666777788889999000011112222",
      stampValueWei: 10_000_000_000_000_000n,
      items: [
        {
          type: "blackjack-hand",
          gameId,
          action: "bet",
          seq: 1,
          prev: "digest-dealer-challenge-1111222233334444555566667777888899990000",
          commitment: playerCommitment,
        },
      ],
      reply: mockReply2,
      state: mockState,
      address: "0x2222222222222222222222222222222222222222",
      getBalance: jest.fn(async () => 500_000_000_000_000_000n),
    } as any);

    expect(mockReply2).toHaveBeenCalledTimes(1);
    const dealItem = lastReply[0];
    expect(dealItem.action).toBe("deal");
    expect(dealItem.link).toBeDefined();

    // 3. Player stands
    const mockReply3 = jest.fn(async (items: any[]) => {
      lastReply = items;
      return {
        payloadDigest: "digest-dealer-reveal-11112222333344445555666677778888999900001111",
        stampValueWei: 10_000_000_000_000_000n,
      };
    });

    await bot.onMessage({
      conversationId: "conv-p2p-full",
      peerAddress: "0x1234567890123456789012345678901234567890",
      payloadDigest: "digest-player-stand-111122223333444455556666777788889999000011112222",
      items: [
        {
          type: "blackjack-hand",
          gameId,
          action: "stand",
          seq: 3,
          prev: "digest-dealer-deal-11112222333344445555666677778888999900001111",
          link: entropyChain(playerSeed)[CHAIN_LENGTH],
        },
      ],
      reply: mockReply3,
      state: mockState,
      address: "0x2222222222222222222222222222222222222222",
      getBalance: jest.fn(async () => 500_000_000_000_000_000n),
    } as any);

    expect(mockReply3).toHaveBeenCalledTimes(1);
    const revealItem = lastReply[0];
    expect(revealItem.action).toBe("reveal");
    expect(revealItem.link).toBeDefined();
  });
});
