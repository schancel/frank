// PARKED (#1377): the poker code is kept for the rebuild and is not registered anywhere. These
// tests describe its pre-rebuild behaviour (no commitment, no buy-in, a malformed emit from the
// card); they keep it compiling and are not a statement that it is fair or playable.
import { PokerBot } from './poker-bot'
import type { BotMessageContext, BotContext } from '@frank/bot-framework'

// No deployment record: the registry has no GenericHTLC address for any network.
jest.mock('../../../contracts/deployments', () => ({ DEPLOYMENTS: {} }))

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

  it('sends no settlement transaction while GenericHTLC is not deployed on the bot\'s network', async () => {
    const mockSendTx = jest.fn(async () => ({ txHash: '0xsettletx999' }))
    mockBotCtx.sendTransaction = mockSendTx
    ;(mockBotCtx as { networkTag: string }).networkTag = 'MONT'

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

    // The registry has no GenericHTLC address for this network, so nothing is sent: a call
    // to an address without code would be mined and shown as a settlement that moved nothing.
    expect(mockSendTx).not.toHaveBeenCalled()

    const textReply = replyFold.mock.calls[0][0][0].text
    expect(textReply).toContain('HAND SETTLED')
    expect(textReply).not.toContain('On-Chain Settlement')
    expect(replyFold.mock.calls[0][0][1].txHash).toBeUndefined()
  })
})
