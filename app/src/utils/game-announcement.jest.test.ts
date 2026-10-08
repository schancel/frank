import {
  parseGameAnnouncement,
  getJoinRoute,
  getHostRoute,
  type ParsedGameAnnouncement,
} from './game-announcement'
import type { ForumMessage, ForumMessageEntry } from '@frank/wallet/forum-model'

describe('Game Announcement Parser and Route Resolver', () => {
  const dummyMessage: ForumMessage = {
    poster: '0xBotAddress111111111111111111111111111111',
    topic: 'games',
    voteWeightWei: '1000000',
    entries: [],
    payloadDigest: '0xdigest123',
    timestamp: new Date(),
    visibleTimestamp: { seconds: '1', nanoseconds: 0 },
    epoch: '0',
    revision: '1',
    transactionHash: '0xtx',
    authorBurnTx: '0xburn',
    blockNumber: '1',
    transactionIndex: '0',
  }

  describe('parseGameAnnouncement with native CBOR Kind 2 entry', () => {
    it('parses native Kind 2 game entry accurately', () => {
      const entry: ForumMessageEntry = {
        kind: 'game',
        gameType: 'poker',
        tableId: 'pokerCBOR42',
        hostAddress: '0xAlice111111111111111111111111111111111111',
        buyInAmount: '500 chips',
        currentPlayers: 3,
        maxPlayers: 8,
        botAddress: '0xBotAddress111111111111111111111111111111',
        title: "🎮 [Texas Hold'em Poker] Table #pokerCBOR42 (3/8 players)",
        message: 'Join the table now!',
      }

      const parsed = parseGameAnnouncement(entry, dummyMessage)

      expect(parsed).not.toBeNull()
      expect(parsed?.gameName).toBe("Texas Hold'em Poker")
      expect(parsed?.gameType).toBe('poker')
      expect(parsed?.tableId).toBe('pokerCBOR42')
      expect(parsed?.hostAddress).toBe(
        '0xAlice111111111111111111111111111111111111',
      )
      expect(parsed?.buyInAmount).toBe('500 chips')
      expect(parsed?.currentPlayers).toBe(3)
      expect(parsed?.maxPlayers).toBe(8)
      expect(parsed?.botAddress).toBe(
        '0xBotAddress111111111111111111111111111111',
      )
      expect(parsed?.actionLink).toBe(
        '/chat/0xBotAddress111111111111111111111111111111?join=pokerCBOR42',
      )
      expect(parsed?.callToAction).toBe('Join Table')
    })
  })

  describe('parseGameAnnouncement with embedded JSON comment', () => {
    it('parses structured JSON metadata comment accurately', () => {
      const payload = {
        version: 1,
        kind: 'game-table-announcement',
        gameName: "Texas Hold'em Poker",
        gameType: 'poker',
        tableId: 'poker9999',
        hostAddress: '0xAlice111111111111111111111111111111111111',
        buyInAmount: '1000 chips (Blinds: 10/20)',
        currentPlayers: 1,
        maxPlayers: 6,
        botAddress: '0xBotAddress111111111111111111111111111111',
        actionLink:
          '/chat/0xBotAddress111111111111111111111111111111?join=poker9999',
        callToAction: 'Sit at Table',
      }

      const entry: ForumMessageEntry = {
        kind: 'post',
        title: "🎮 [Texas Hold'em Poker] Table #poker9999 (1/6 players)",
        url: payload.actionLink,
        message: `🎮 **Texas Hold'em Poker Table Created!**\n\n• **Table ID**: \`poker9999\`\n\n<!-- GAME_ANNOUNCEMENT:${JSON.stringify(
          payload,
        )} -->`,
      }

      const parsed = parseGameAnnouncement(entry, dummyMessage)

      expect(parsed).not.toBeNull()
      expect(parsed?.gameName).toBe("Texas Hold'em Poker")
      expect(parsed?.gameType).toBe('poker')
      expect(parsed?.tableId).toBe('poker9999')
      expect(parsed?.hostAddress).toBe(
        '0xAlice111111111111111111111111111111111111',
      )
      expect(parsed?.buyInAmount).toBe('1000 chips (Blinds: 10/20)')
      expect(parsed?.currentPlayers).toBe(1)
      expect(parsed?.maxPlayers).toBe(6)
      expect(parsed?.botAddress).toBe(
        '0xBotAddress111111111111111111111111111111',
      )
      expect(parsed?.actionLink).toBe(
        '/chat/0xBotAddress111111111111111111111111111111?join=poker9999',
      )
      expect(parsed?.callToAction).toBe('Sit at Table')
    })
  })

  describe('parseGameAnnouncement fallback text patterns', () => {
    it('heuristically parses Liar Dice announcement without JSON comment', () => {
      const entry: ForumMessageEntry = {
        kind: 'post',
        title: "🎲 Liar's Dice Table #table5555",
        url: '/chat/0xBotDice?join=table5555',
        message:
          '🎲 Table Created!\n• Table ID: table5555\n• Host: 0xBob222222222222222222222222222222222222\n• Buy-in: 0.1 MON\n• Players: 2/6\n[Join Table](/chat/0xBotDice?join=table5555)',
      }

      const parsed = parseGameAnnouncement(entry, dummyMessage)

      expect(parsed).not.toBeNull()
      expect(parsed?.gameName).toBe("Liar's Dice")
      expect(parsed?.tableId).toBe('table5555')
      expect(parsed?.hostAddress).toBe(
        '0xBob222222222222222222222222222222222222',
      )
      expect(parsed?.buyInAmount).toBe('0.1 MON')
      expect(parsed?.currentPlayers).toBe(2)
      expect(parsed?.maxPlayers).toBe(6)
      expect(parsed?.actionLink).toBe('/chat/0xBotDice?join=table5555')
    })

    it('returns null for non-game topic messages', () => {
      const entry: ForumMessageEntry = {
        kind: 'post',
        title: 'Weekly Tech Discussion',
        url: 'https://example.com/blog',
        message: 'Let us discuss the latest updates in decentralized tech!',
      }

      const parsed = parseGameAnnouncement(entry, dummyMessage)
      expect(parsed).toBeNull()
    })
  })

  describe('route resolvers: getJoinRoute & getHostRoute', () => {
    it('getJoinRoute returns actionLink when provided', () => {
      const announcement: ParsedGameAnnouncement = {
        gameName: 'Poker',
        tableId: 'tab1',
        hostAddress: '0xHost',
        actionLink: '/chat/0xBot?join=tab1',
      }
      expect(getJoinRoute(announcement)).toBe('/chat/0xBot?join=tab1')
    })

    it('getJoinRoute falls back to bot address with query param', () => {
      const announcement: ParsedGameAnnouncement = {
        gameName: 'Poker',
        tableId: 'tab1',
        hostAddress: '0xHost',
        botAddress: '0xBotAddress',
      }
      expect(getJoinRoute(announcement)).toBe('/chat/0xBotAddress?join=tab1')
    })

    it('getHostRoute returns chat route with host address', () => {
      const announcement: ParsedGameAnnouncement = {
        gameName: 'Poker',
        tableId: 'tab1',
        hostAddress: '0x1234567890123456789012345678901234567890',
      }
      expect(getHostRoute(announcement)).toBe(
        '/chat/0x1234567890123456789012345678901234567890',
      )
    })

    it('getHostRoute returns undefined if host address is not a valid 0x address', () => {
      const announcement: ParsedGameAnnouncement = {
        gameName: 'Poker',
        tableId: 'tab1',
        hostAddress: '',
      }
      expect(getHostRoute(announcement)).toBeUndefined()
    })
  })
})
