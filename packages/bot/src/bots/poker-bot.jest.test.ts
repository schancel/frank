import { PokerBot } from './poker-bot'
import { commitSeed, foldPokerState } from '@frank/wallet/message-item-plugins/poker'
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
        put: jest.fn(),
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
    expect(dealItem.serverCommit).toBeDefined()
    expect(dealItem.playerCommits).toBeDefined()
    expect(dealItem.holeCardCommits).toBeDefined()

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

  it('durably records pending payouts before sending settlement announcement and verifies multi-party commitments', async () => {
    const events: string[] = []
    ;(mockBotCtx.state as any).put = jest.fn(async (key: string) => {
      if (key.startsWith('payout:pending:')) {
        events.push(`record:${key}`)
      }
    })

    // 1. Create & join
    const replyCreate = jest.fn()
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/poker create' }],
      reply: replyCreate,
    } as unknown as BotMessageContext, mockBotCtx)

    const replyJoin = jest.fn()
    await bot.onMessage({
      senderAddress: '0xBob',
      items: [{ type: 'text', text: '/poker join' }],
      reply: replyJoin,
    } as unknown as BotMessageContext, mockBotCtx)

    // 2. Both players commit and reveal seeds before starting hand
    const aliceSeed = 'alice-custom-poker-seed'
    const bobSeed = 'bob-custom-poker-seed'
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: `/poker commit ${commitSeed(aliceSeed)}` }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, mockBotCtx)
    await bot.onMessage({
      senderAddress: '0xBob',
      items: [{ type: 'text', text: `/poker commit ${commitSeed(bobSeed)}` }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, mockBotCtx)

    // Mismatched seed reveal is rejected
    const replyBadSeed = jest.fn()
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: `/poker seed wrong-seed` }],
      reply: replyBadSeed,
    } as unknown as BotMessageContext, mockBotCtx)
    expect(replyBadSeed.mock.calls[0][0][0].text).toContain('does not match')

    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: `/poker seed ${aliceSeed}` }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, mockBotCtx)
    await bot.onMessage({
      senderAddress: '0xBob',
      items: [{ type: 'text', text: `/poker seed ${bobSeed}` }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, mockBotCtx)

    // 3. Start hand and play to showdown via /allin and /call
    const replyStart = jest.fn()
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/poker start' }],
      reply: replyStart,
    } as unknown as BotMessageContext, mockBotCtx)

    const dealItem = replyStart.mock.calls[0][0][1]
    const firstActor = dealItem.activePlayer
    const secondActor = firstActor === '0xAlice' ? '0xBob' : '0xAlice'

    const replyAllIn = jest.fn()
    await bot.onMessage({
      senderAddress: firstActor,
      items: [{ type: 'text', text: '/allin' }],
      reply: replyAllIn,
    } as unknown as BotMessageContext, mockBotCtx)

    const replyCall = jest.fn(async () => {
      events.push('reply:settled')
    })
    await bot.onMessage({
      senderAddress: secondActor,
      items: [{ type: 'text', text: '/call' }],
      reply: replyCall,
    } as unknown as BotMessageContext, mockBotCtx)

    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events[0]).toMatch(/^record:payout:pending:/)
    expect(events[events.length - 1]).toBe('reply:settled')
    expect(bot.getPendingPayouts().size).toBeGreaterThanOrEqual(1)

    // Fold state from the emitted messages and verify showdown
    const settleItem = replyCall.mock.calls[0][0][1]
    const folded = foldPokerState([
      replyCreate.mock.calls[0][0][1],
      replyJoin.mock.calls[0][0][1],
      { ...dealItem, action: 'deal' },
      settleItem,
    ])
    expect(folded).toBeDefined()
    expect(folded!.verified).toBe(true)
  })
})
