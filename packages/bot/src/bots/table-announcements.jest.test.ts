import {
  formatGameAnnouncementMarkdown,
  buildGameAnnouncementEntry,
  buildLegacyGameAnnouncementEntry,
  announceTableToTopic,
  DEFAULT_GAMES_TOPIC,
  type GameTableDetails,
  type GameAnnouncementPayload,
} from "./table-announcements";
import { PokerBot } from "./poker-bot";
import { LiarsDiceBot } from "./liars-dice-bot";
import { amountsOf } from "./chain-amounts.testutil";
import type { BotContext, BotMessageContext } from "@frank/bot-framework";

describe("Game Table Announcements for Topic Discovery", () => {
  const samplePokerDetails: GameTableDetails = {
    gameName: "Texas Hold'em Poker",
    gameType: "poker",
    tableId: "table1234abcd",
    hostAddress: "0x1111111111111111111111111111111111111111",
    buyInAmount: "1000 chips (Blinds: 10/20)",
    currentPlayers: 1,
    maxPlayers: 6,
    botAddress: "0x2222222222222222222222222222222222222222",
    actionLink: "/chat/0x2222222222222222222222222222222222222222?join=table1234abcd",
    callToAction: "Join Table",
  };

  const sampleLiarsDiceDetails: GameTableDetails = {
    gameName: "Liar's Dice",
    gameType: "liars-dice",
    tableId: "dice9876efgh",
    hostAddress: "0x3333333333333333333333333333333333333333",
    buyInAmount: "0.1 MONT",
    currentPlayers: 1,
    maxPlayers: 6,
    botAddress: "0x4444444444444444444444444444444444444444",
  };

  describe("formatGameAnnouncementMarkdown and buildGameAnnouncementEntry", () => {
    it("formats a human-readable markdown message with embedded structured metadata comment", () => {
      const markdown = formatGameAnnouncementMarkdown(samplePokerDetails);

      expect(markdown).toContain("🎮 **Texas Hold'em Poker Table Created!**");
      expect(markdown).toContain("• **Table ID**: `table1234abcd`");
      expect(markdown).toContain("• **Host**: `0x1111111111111111111111111111111111111111`");
      expect(markdown).toContain("• **Buy-in**: 1000 chips (Blinds: 10/20)");
      expect(markdown).toContain("• **Players**: 1/6");
      expect(markdown).toContain("[Join Table](/chat/0x2222222222222222222222222222222222222222?join=table1234abcd)");
      expect(markdown).toContain("[Message Host](/chat/0x1111111111111111111111111111111111111111)");

      // Verify embedded metadata comment
      const match = markdown.match(/<!--\s*GAME_ANNOUNCEMENT:(.*?)\s*-->/);
      expect(match).not.toBeNull();
      const payload: GameAnnouncementPayload = JSON.parse(match![1]);
      expect(payload.version).toBe(1);
      expect(payload.kind).toBe("game-table-announcement");
      expect(payload.gameName).toBe("Texas Hold'em Poker");
      expect(payload.tableId).toBe("table1234abcd");
      expect(payload.hostAddress).toBe("0x1111111111111111111111111111111111111111");
      expect(payload.buyInAmount).toBe("1000 chips (Blinds: 10/20)");
      expect(payload.currentPlayers).toBe(1);
      expect(payload.maxPlayers).toBe(6);
      expect(payload.actionLink).toBe("/chat/0x2222222222222222222222222222222222222222?join=table1234abcd");
    });

    it("builds a ForumMessageEntry with kind game, table details, and markdown fallback", () => {
      const entry = buildGameAnnouncementEntry(sampleLiarsDiceDetails);

      expect(entry.kind).toBe("game");
      if (entry.kind === "game") {
        expect(entry.gameType).toBe("liars-dice");
        expect(entry.tableId).toBe("dice9876efgh");
        expect(entry.hostAddress).toBe("0x3333333333333333333333333333333333333333");
        expect(entry.buyInAmount).toBe("0.1 MONT");
        expect(entry.currentPlayers).toBe(1);
        expect(entry.maxPlayers).toBe(6);
        expect(entry.botAddress).toBe("0x4444444444444444444444444444444444444444");
        expect(entry.title).toBe("🎮 [Liar's Dice] Table #dice9876efgh (1/6 players)");
        expect(entry.message).toContain("🎮 **Liar's Dice Table Created!**");
      }
    });

    it("builds a legacy ForumMessageEntry with kind post, title, and action url", () => {
      const entry = buildLegacyGameAnnouncementEntry(sampleLiarsDiceDetails);

      expect(entry.kind).toBe("post");
      if (entry.kind === "post") {
        expect(entry.title).toBe("🎮 [Liar's Dice] Table #dice9876efgh (1/6 players)");
        expect(entry.url).toBe("/chat/0x4444444444444444444444444444444444444444?join=dice9876efgh");
        expect(entry.message).toContain("🎮 **Liar's Dice Table Created!**");
      }
    });
  });

  describe("announceTableToTopic", () => {
    it("publishes to topic when ctx.publishTopicMessage is available", async () => {
      const mockPublish = jest.fn(async () => ({ payloadDigest: "0xhash999" }));
      const mockCtx: Partial<BotContext> = {
        address: "0x2222222222222222222222222222222222222222",
        publishTopicMessage: mockPublish,
      };

      const result = await announceTableToTopic(
        mockCtx as BotContext,
        "games",
        samplePokerDetails
      );

      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenCalledWith({
        topic: "games",
        entries: [
          expect.objectContaining({
            kind: "game",
            tableId: samplePokerDetails.tableId,
            gameType: "poker",
            title: expect.stringContaining("Texas Hold'em Poker"),
          }),
        ],
      });
      expect(result.payloadDigest).toBe("0xhash999");
      expect(result.entry.title).toContain("Texas Hold'em Poker");
    });

    it("falls back to ctx.postToTopic if publishTopicMessage is not present", async () => {
      const mockPost = jest.fn(async () => ({ payloadDigest: "0xhashPost" }));
      const mockCtx: any = {
        address: "0x2222222222222222222222222222222222222222",
        postToTopic: mockPost,
      };

      const result = await announceTableToTopic(
        mockCtx,
        "arcade",
        samplePokerDetails
      );

      expect(mockPost).toHaveBeenCalledWith({
        topic: "arcade",
        entries: [expect.objectContaining({ kind: "game" })],
      });
      expect(result.payloadDigest).toBe("0xhashPost");
    });

    it("falls back to subscription broadcast if topic post methods are not present", async () => {
      const mockBroadcast = jest.fn(async () => ({ sent: 2, failed: 0 }));
      const mockCtx: Partial<BotContext> = {
        address: "0x2222222222222222222222222222222222222222",
        subscriptions: {
          broadcast: mockBroadcast,
        } as any,
      };

      const result = await announceTableToTopic(
        mockCtx as BotContext,
        "games",
        samplePokerDetails
      );

      expect(mockBroadcast).toHaveBeenCalledTimes(1);
      expect(mockBroadcast.mock.calls[0][1]).toBe("games");
      expect(result.entry).toBeDefined();
    });

    it("does not throw if topic publishing fails", async () => {
      const mockPublish = jest.fn(async () => {
        throw new Error("Network timeout");
      });
      const mockCtx: Partial<BotContext> = {
        address: "0x2222222222222222222222222222222222222222",
        publishTopicMessage: mockPublish,
      };

      const result = await announceTableToTopic(
        mockCtx as BotContext,
        "games",
        samplePokerDetails
      );

      expect(result.payloadDigest).toBeUndefined();
      expect(result.entry).toBeDefined();
    });
  });

  describe("Integration with PokerBot and LiarsDiceBot table creation", () => {
    it("PokerBot publishes an announcement to 'games' topic upon /poker create", async () => {
      const bot = new PokerBot();
      const mockPublish = jest.fn(async () => ({ payloadDigest: "0xpokerdigest" }));
      const mockBotCtx: Partial<BotContext> = {
        address: "0xPokerBotAddress",
        publishTopicMessage: mockPublish,
        state: { get: jest.fn(), put: jest.fn() } as any,
      };

      const reply = jest.fn();
      await bot.onMessage(
        {
          senderAddress: "0xAlice",
          items: [{ type: "text", text: "/poker create" }],
          reply,
        } as unknown as BotMessageContext,
        mockBotCtx as BotContext
      );

      expect(reply).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenCalledTimes(1);
      const publishArg = mockPublish.mock.calls[0][0];
      expect(publishArg.topic).toBe(DEFAULT_GAMES_TOPIC);
      expect(publishArg.entries[0].title).toContain("Texas Hold'em Poker");
      expect(publishArg.entries[0].message).toContain("Host**: `0xAlice`");
    });

    it("LiarsDiceBot publishes an announcement to 'games' topic upon /table create", async () => {
      const bot = new LiarsDiceBot();
      const mockPublish = jest.fn(async () => ({ payloadDigest: "0xdicedigest" }));
      const mockBotCtx: Partial<BotContext> = {
        address: "0xLiarsDiceBotAddress",
        ...amountsOf("monad-testnet"),
        publishTopicMessage: mockPublish,
        state: { get: jest.fn(), put: jest.fn() } as any,
      };

      const reply = jest.fn();
      await bot.onMessage(
        {
          senderAddress: "0xBob",
          items: [{ type: "text", text: "/table create 0.5" }],
          reply,
        } as unknown as BotMessageContext,
        mockBotCtx as BotContext
      );

      expect(reply).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenCalledTimes(1);
      const publishArg = mockPublish.mock.calls[0][0];
      expect(publishArg.topic).toBe(DEFAULT_GAMES_TOPIC);
      expect(publishArg.entries[0].title).toContain("Liar's Dice");
      expect(publishArg.entries[0].message).toContain("Host**: `0xBob`");
      // The unit of the bot's chain, once (the line used to read "0.5 MON MON").
      expect(publishArg.entries[0].message).toContain("• **Buy-in**: 0.5 MONT\n");
    });
  });
});
