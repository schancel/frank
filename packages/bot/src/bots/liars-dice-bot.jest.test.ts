import { LiarsDiceBot } from './liars-dice-bot'
import type { BotMessageContext, BotContext } from '@frank/bot-framework'

describe("Liar's Dice Bot Table Coordinator", () => {
  let bot: LiarsDiceBot
  let mockBotCtx: BotContext

  beforeEach(() => {
    bot = new LiarsDiceBot()
    mockBotCtx = {
      sendMessage: jest.fn(),
      state: {
        get: jest.fn(),
        set: jest.fn(),
      },
    } as unknown as BotContext
  })

  it('exposes a valid bot profile', () => {
    const profile = bot.getProfile()
    expect(profile.name).toBe("Liar's Dice")
    expect(profile.bot).toBe(true)
    expect(profile.avatarPng).toBeDefined()
  })

  it('handles /table create and /table join commands', async () => {
    const reply1 = jest.fn()
    const ctx1: BotMessageContext = {
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/table create 0.1' }],
      reply: reply1,
    } as unknown as BotMessageContext

    await bot.onMessage(ctx1, mockBotCtx)
    expect(reply1).toHaveBeenCalledTimes(1)
    const [msg1] = reply1.mock.calls[0]
    expect(msg1[0].text).toContain('created')
    expect(msg1[1].type).toBe('liars-dice')
    expect(msg1[1].action).toBe('create')

    // Bob joins
    const reply2 = jest.fn()
    const ctx2: BotMessageContext = {
      senderAddress: '0xBob',
      items: [{ type: 'text', text: '/table join' }],
      reply: reply2,
    } as unknown as BotMessageContext

    await bot.onMessage(ctx2, mockBotCtx)
    expect(reply2).toHaveBeenCalledTimes(1)
    const [msg2] = reply2.mock.calls[0]
    expect(msg2[0].text).toContain('joined')
    expect(msg2[1].action).toBe('join')
  })

  it('starts game, accepts bids, and resolves showdown on /liar', async () => {
    // 1. Create table
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/create' }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, mockBotCtx)

    // 2. Bob joins
    await bot.onMessage({
      senderAddress: '0xBob',
      items: [{ type: 'text', text: '/join' }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, mockBotCtx)

    // 3. Start game
    const replyStart = jest.fn()
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/start' }],
      reply: replyStart,
    } as unknown as BotMessageContext, mockBotCtx)

    expect(replyStart).toHaveBeenCalledTimes(1)
    expect(replyStart.mock.calls[0][0][0].text).toContain('Round 1 started')

    // 4. Alice bids 2 threes
    const replyBid = jest.fn()
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/bid 2 3' }],
      reply: replyBid,
    } as unknown as BotMessageContext, mockBotCtx)

    expect(replyBid).toHaveBeenCalledTimes(1)
    expect(replyBid.mock.calls[0][0][0].text).toContain('bid: **2x [3]**')

    // 5. Bob calls Liar!
    const replyLiar = jest.fn()
    await bot.onMessage({
      senderAddress: '0xBob',
      items: [{ type: 'text', text: '/liar' }],
      reply: replyLiar,
    } as unknown as BotMessageContext, mockBotCtx)

    expect(replyLiar).toHaveBeenCalledTimes(1)
    expect(replyLiar.mock.calls[0][0][0].text).toContain('SHOWDOWN')
    const item = replyLiar.mock.calls[0][0][1]
    expect(item.type).toBe('liars-dice')
    expect(item.action).toBe('showdown')
    expect(item.challengeResult).toBeDefined()
  })

  it('broadcasts GenericHTLC.batchDistribute on game resolution when sendTransaction is available', async () => {
    const mockSendTx = jest.fn(async () => ({ txHash: '0xdicetx777' }))
    mockBotCtx.sendTransaction = mockSendTx

    // 1. Create table
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/create' }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, mockBotCtx)

    // 2. Bob joins
    await bot.onMessage({
      senderAddress: '0xBob',
      items: [{ type: 'text', text: '/join' }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, mockBotCtx)

    // Set both players' dice counts to 1 so any challenge eliminates the loser immediately
    const tableId = (bot as any).latestTableId
    const game = (bot as any).tables.get(tableId)
    game.players[0].diceCount = 1
    game.players[1].diceCount = 1

    // 3. Start game
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/start' }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, mockBotCtx)

    // 4. Alice bids 1 two (Alice acts first)
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/bid 1 2' }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, mockBotCtx)

    // 5. Bob calls Liar!
    const replyLiar = jest.fn()
    await bot.onMessage({
      senderAddress: '0xBob',
      items: [{ type: 'text', text: '/liar' }],
      reply: replyLiar,
    } as unknown as BotMessageContext, mockBotCtx)

    expect(game.status).toBe('resolved')
    expect(mockSendTx).toHaveBeenCalledTimes(1)
    expect(mockSendTx.mock.calls[0][0].to).toBe('0x391a080Bd6FF21CB4598adF063Dc94018CD186E5')

    const msg = replyLiar.mock.calls[0][0][0].text
    expect(msg).toContain('GAME OVER')
    expect(msg).toContain('On-Chain Settlement')
    expect(msg).toContain('0xdicetx777')

    const item = replyLiar.mock.calls[0][0][1]
    expect(item.txHash).toBe('0xdicetx777')
  })
})
