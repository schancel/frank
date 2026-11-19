import { PokerBot } from './poker-bot'
import { commitSeed, foldPokerState } from '@frank/wallet/message-item-plugins/poker'
import type { BotMessageContext, BotContext } from '@frank/bot-framework'
import { harness } from './bot-harness.testutil'
import { amountsOf } from './chain-amounts.testutil'
import { seatingEscrowBook } from './table-escrow-book.testutil'

/** Alice sits down: the unit escrow book seats every join (see its file). */
async function aliceJoins(bot: PokerBot, ctx: BotContext) {
  const reply = jest.fn()
  await bot.onMessage({
    senderAddress: '0xAlice',
    items: [{ type: 'text', text: '/poker join' }],
    reply,
  } as unknown as BotMessageContext, ctx)
  return reply
}


describe("Texas Hold'em Poker Bot Coordinator", () => {
  let bot: PokerBot
  let mockBotCtx: BotContext
  let escrow: ReturnType<typeof seatingEscrowBook>

  beforeEach(() => {
    escrow = seatingEscrowBook('poker')
    bot = new PokerBot({ escrows: escrow.book })
    mockBotCtx = {
      ...amountsOf('monad-testnet'),
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

    expect(replyCreate.mock.calls[0][0][1].escrow).toEqual(
      expect.objectContaining({ arbiter: expect.any(String), hashLock: expect.any(String) })
    )
    await aliceJoins(bot, mockBotCtx)

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

  it('a settled hand pays the locked pot out by chip stack, through the escrow alone', async () => {
    const h = harness()
    const mockSendTx = jest.fn(async () => ({ txHash: '0xsettletx999' }))
    const ctx = { ...h.ctx, sendTransaction: mockSendTx } as unknown as BotContext

    // 1. Create table
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/poker create' }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, ctx)

    await aliceJoins(bot, ctx)
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

    // The pot of two buy-ins, split by the stacks after the hand: the escrow pays it, nothing else.
    expect(mockSendTx).not.toHaveBeenCalled()
    expect(h.sent).toEqual([])
    expect(escrow.settlements).toHaveLength(1)
    const { shares } = escrow.settlements[0]!
    expect(shares.reduce((sum, s) => sum + s.amountWei, 0n)).toBe(2n * 10n ** 17n)
    const winner = shares.find(s => s.player !== firstActAddress)!
    const folder = shares.find(s => s.player === firstActAddress)!
    expect(winner.amountWei).toBeGreaterThan(folder.amountWei)

    const textReply = replyFold.mock.calls[0][0][0].text
    expect(textReply).toContain('HAND SETTLED')
    expect(textReply).toContain('Paid out on chain')

    // The table is closed: one escrowed hand.
    const replyAgain = jest.fn()
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/poker start' }],
      reply: replyAgain,
    } as unknown as BotMessageContext, ctx)
    expect(replyAgain.mock.calls[0][0][0].text).toContain('settled')
  })

  it('settles through the escrow before announcing, and verifies multi-party commitments', async () => {
    const events: string[] = []
    const settle = escrow.book.settle
    escrow.book.settle = async (...args) => {
      events.push('settle')
      return settle(...args)
    }

    // 1. Create & join
    const replyCreate = jest.fn()
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/poker create' }],
      reply: replyCreate,
    } as unknown as BotMessageContext, mockBotCtx)
    const replyAliceJoin = await aliceJoins(bot, mockBotCtx)

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

    expect(events).toEqual(['settle', 'reply:settled'])
    expect(escrow.settlements).toHaveLength(1)

    // Fold state from the emitted messages and verify showdown
    const settleItem = replyCall.mock.calls[0][0][1]
    const folded = foldPokerState([
      replyCreate.mock.calls[0][0][1],
      replyAliceJoin.mock.calls[0][0][1],
      replyJoin.mock.calls[0][0][1],
      { ...dealItem, action: 'deal' },
      settleItem,
    ])
    expect(folded).toBeDefined()
    expect(folded!.verified).toBe(true)
  })
})
