import { PokerBot } from './poker-bot'
import { commitSeed, foldPokerState } from '@frank/wallet/message-item-plugins/poker'
import type { BotMessageContext, BotContext } from '@frank/bot-framework'
import { harness } from './bot-harness.testutil'


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

  it('settling a table moves no value, on a real-shaped state store (get/put/batch)', async () => {
    // The unit harness's in-memory store has `get` and `batch`, as the host's does: an outbox
    // payout would be owed into it and sent from the bot's wallet.
    const h = harness()
    const mockSendTx = jest.fn(async () => ({ txHash: '0xsettletx999' }))
    const ctx = { ...h.ctx, sendTransaction: mockSendTx } as unknown as BotContext

    // 1. Create table
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/poker create' }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, ctx)

    // 2. Bob joins
    await bot.onMessage({
      senderAddress: '0xBob',
      items: [{ type: 'text', text: '/poker join' }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, ctx)

    // 3. Start hand
    const replyStart = jest.fn()
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/poker start' }],
      reply: replyStart,
    } as unknown as BotMessageContext, ctx)

    const firstActAddress = replyStart.mock.calls[0][0][1].activePlayer

    // 4. First player folds
    const replyFold = jest.fn()
    await bot.onMessage({
      senderAddress: firstActAddress,
      items: [{ type: 'text', text: '/fold' }],
      reply: replyFold,
    } as unknown as BotMessageContext, ctx)

    // Table escrow is not wired to GenericHTLC: no transaction, no message, nothing owed.
    expect(mockSendTx).not.toHaveBeenCalled()
    expect(h.sent).toEqual([])
    expect(bot.schedules).toBeUndefined()
    expect(bot.getPendingPayouts().size).toBeGreaterThan(0)
    const keys = [...h.data.keys()]
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) expect(key).toMatch(/^payout:pending:/)

    const textReply = replyFold.mock.calls[0][0][0].text
    expect(textReply).toContain('HAND SETTLED')
    expect(textReply).not.toContain('On-Chain Settlement')
    expect(textReply).toContain('Not settled on chain')
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
