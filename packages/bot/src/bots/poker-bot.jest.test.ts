import { PokerBot } from './poker-bot'
import type { BotMessageContext, BotContext } from '@frank/bot-framework'

describe("Texas Hold'em Poker Bot Coordinator", () => {
  let bot: PokerBot
  let mockBotCtx: BotContext

  beforeEach(() => {
    bot = new PokerBot()
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
    expect(profile.name).toBe("Texas Hold'em Poker")
    expect(profile.bot).toBe(true)
  })

  it('handles /poker create, join, start, and fold to settle', async () => {
    // 1. Alice creates table
    const replyCreate = jest.fn()
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/poker create' }],
      reply: replyCreate,
    } as unknown as BotMessageContext, mockBotCtx)

    expect(replyCreate).toHaveBeenCalledTimes(1)
    expect(replyCreate.mock.calls[0][0][0].text).toContain('Poker Table')
    expect(replyCreate.mock.calls[0][0][1].type).toBe('poker')

    // 2. Bob joins table
    const replyJoin = jest.fn()
    await bot.onMessage({
      senderAddress: '0xBob',
      items: [{ type: 'text', text: '/poker join' }],
      reply: replyJoin,
    } as unknown as BotMessageContext, mockBotCtx)

    expect(replyJoin).toHaveBeenCalledTimes(1)
    expect(replyJoin.mock.calls[0][0][0].text).toContain('joined table')

    // 3. Start hand
    const replyStart = jest.fn()
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/poker start' }],
      reply: replyStart,
    } as unknown as BotMessageContext, mockBotCtx)

    expect(replyStart).toHaveBeenCalledTimes(1)
    expect(replyStart.mock.calls[0][0][0].text).toContain('Hand #1 dealt')

    const dealItem = replyStart.mock.calls[0][0][1]
    expect(dealItem.pot).toBe(30) // 10 SB + 20 BB
    expect(dealItem.street).toBe('preflop')

    // 4. In heads-up, dealer is SB and acts first preflop
    const firstActAddress = dealItem.activePlayer
    const otherAddress = firstActAddress === '0xAlice' ? '0xBob' : '0xAlice'

    // First player folds
    const replyFold = jest.fn()
    await bot.onMessage({
      senderAddress: firstActAddress,
      items: [{ type: 'text', text: '/fold' }],
      reply: replyFold,
    } as unknown as BotMessageContext, mockBotCtx)

    expect(replyFold).toHaveBeenCalledTimes(1)
    expect(replyFold.mock.calls[0][0][0].text).toContain('HAND SETTLED')
    expect(replyFold.mock.calls[0][0][0].text).toContain(otherAddress.slice(0, 8))
  })

  it('broadcasts GenericHTLC.batchDistribute on settlement when sendTransaction is available', async () => {
    const mockSendTx = jest.fn(async () => ({ txHash: '0xsettletx999' }))
    mockBotCtx.sendTransaction = mockSendTx

    // 1. Create table
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/poker create' }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, mockBotCtx)

    // 2. Bob joins
    await bot.onMessage({
      senderAddress: '0xBob',
      items: [{ type: 'text', text: '/poker join' }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, mockBotCtx)

    // 3. Start hand
    const replyStart = jest.fn()
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/poker start' }],
      reply: replyStart,
    } as unknown as BotMessageContext, mockBotCtx)

    const firstActAddress = replyStart.mock.calls[0][0][1].activePlayer

    // 4. First player folds
    const replyFold = jest.fn()
    await bot.onMessage({
      senderAddress: firstActAddress,
      items: [{ type: 'text', text: '/fold' }],
      reply: replyFold,
    } as unknown as BotMessageContext, mockBotCtx)

    expect(mockSendTx).toHaveBeenCalledTimes(1)
    const callArgs = mockSendTx.mock.calls[0][0]
    expect(callArgs.to).toBe('0x391a080Bd6FF21CB4598adF063Dc94018CD186E5') // Canonical HTLC
    expect(callArgs.data).toMatch(/^0x/)

    const textReply = replyFold.mock.calls[0][0][0].text
    expect(textReply).toContain('On-Chain Settlement')
    expect(textReply).toContain('0xsettletx999')

    const itemReply = replyFold.mock.calls[0][0][1]
    expect(itemReply.txHash).toBe('0xsettletx999')
  })
})
