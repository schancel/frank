import { LiarsDiceBot } from './liars-dice-bot'
import { commitSeed, foldLiarsDiceState } from '@frank/wallet/message-item-plugins/liars-dice'
import { amountsOf } from './chain-amounts.testutil'
import type { BotMessageContext, BotContext } from '@frank/bot-framework'
import { harness } from './bot-harness.testutil'
import { seatingEscrowBook } from './table-escrow-book.testutil'

/** Alice sits down: the unit escrow book seats every join (see its file). */
async function aliceJoins(bot: LiarsDiceBot, ctx: BotContext) {
  const reply = jest.fn()
  await bot.onMessage({
    senderAddress: '0xAlice',
    items: [{ type: 'text', text: '/join' }],
    reply,
  } as unknown as BotMessageContext, ctx)
  return reply
}


describe("Liar's Dice Bot Table Coordinator", () => {
  let bot: LiarsDiceBot
  let mockBotCtx: BotContext
  let escrow: ReturnType<typeof seatingEscrowBook>

  beforeEach(() => {
    escrow = seatingEscrowBook('liars-dice')
    bot = new LiarsDiceBot({ escrows: escrow.book })
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
    expect(msg1[1].escrow).toEqual(
      expect.objectContaining({ arbiter: expect.any(String), hashLock: expect.any(String) })
    )
    await aliceJoins(bot, mockBotCtx)

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

    await aliceJoins(bot, mockBotCtx)
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
    const startItem = replyStart.mock.calls[0][0][1]
    expect(startItem.serverCommit).toBeDefined()
    expect(startItem.playerCommits).toBeDefined()
    expect(startItem.myDice).toHaveLength(5)

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
    expect(item.serverSeed).toBeDefined()
    expect(item.playerSeeds).toBeDefined()
  })

  it('the winner is paid the locked pot, through the escrow alone', async () => {
    const h = harness()
    const mockSendTx = jest.fn(async () => ({ txHash: '0xdicetx777' }))
    const ctx = { ...h.ctx, sendTransaction: mockSendTx } as unknown as BotContext

    // 1. Create table
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/create' }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, ctx)

    await aliceJoins(bot, ctx)
    // 2. Bob joins
    await bot.onMessage({
      senderAddress: '0xBob',
      items: [{ type: 'text', text: '/join' }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, ctx)

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
    } as unknown as BotMessageContext, ctx)

    // 4. Alice bids 1 two (Alice acts first)
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/bid 1 2' }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, ctx)

    // 5. Bob calls Liar!
    const replyLiar = jest.fn()
    await bot.onMessage({
      senderAddress: '0xBob',
      items: [{ type: 'text', text: '/liar' }],
      reply: replyLiar,
    } as unknown as BotMessageContext, ctx)

    expect(game.status).toBe('resolved')
    expect(mockSendTx).not.toHaveBeenCalled()
    expect(h.sent).toEqual([])
    expect(escrow.settlements).toEqual([
      {
        tableId,
        shares: [{ player: game.winnerAddress, amountWei: 2n * BigInt(game.buyInWei) }],
      },
    ])

    const msg = replyLiar.mock.calls[0][0][0].text
    expect(msg).toContain('GAME OVER')
    expect(msg).toContain('Paid out on chain')
  })

  it('settles through the escrow before announcing, and verifies multi-party commitments', async () => {
    const events: string[] = []
    const settle = escrow.book.settle
    escrow.book.settle = async (...args) => {
      events.push('settle')
      return settle(...args)
    }

    const replyCreate = jest.fn()
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/create' }],
      reply: replyCreate,
    } as unknown as BotMessageContext, mockBotCtx)
    const replyAliceJoin = await aliceJoins(bot, mockBotCtx)

    const replyJoin = jest.fn()
    await bot.onMessage({
      senderAddress: '0xBob',
      items: [{ type: 'text', text: '/join' }],
      reply: replyJoin,
    } as unknown as BotMessageContext, mockBotCtx)

    const tableId = (bot as any).latestTableId
    const game = (bot as any).tables.get(tableId)
    game.players[0].diceCount = 1
    game.players[1].diceCount = 1

    const replyStart = jest.fn()
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/start' }],
      reply: replyStart,
    } as unknown as BotMessageContext, mockBotCtx)

    // Custom player commit + reveal during round
    const aliceSeed = 'alice-custom-dice-seed'
    const bobSeed = 'bob-custom-dice-seed'
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: `/commit ${commitSeed(aliceSeed)}` }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, mockBotCtx)
    await bot.onMessage({
      senderAddress: '0xBob',
      items: [{ type: 'text', text: `/commit ${commitSeed(bobSeed)}` }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, mockBotCtx)

    // Mismatched seed reveal is rejected
    const replyBadSeed = jest.fn()
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/seed wrong-seed' }],
      reply: replyBadSeed,
    } as unknown as BotMessageContext, mockBotCtx)
    expect(replyBadSeed.mock.calls[0][0][0].text).toContain('does not match')

    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: `/seed ${aliceSeed}` }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, mockBotCtx)
    await bot.onMessage({
      senderAddress: '0xBob',
      items: [{ type: 'text', text: `/seed ${bobSeed}` }],
      reply: jest.fn(),
    } as unknown as BotMessageContext, mockBotCtx)

    const replyBid = jest.fn()
    await bot.onMessage({
      senderAddress: '0xAlice',
      items: [{ type: 'text', text: '/bid 1 2' }],
      reply: replyBid,
    } as unknown as BotMessageContext, mockBotCtx)

    const replyLiar = jest.fn(async () => {
      events.push('reply:resolved')
    })
    await bot.onMessage({
      senderAddress: '0xBob',
      items: [{ type: 'text', text: '/liar' }],
      reply: replyLiar,
    } as unknown as BotMessageContext, mockBotCtx)

    expect(events).toEqual(['settle', 'reply:resolved'])
    expect(escrow.settlements).toHaveLength(1)

    const showdownItem = replyLiar.mock.calls[0][0][1]
    const folded = foldLiarsDiceState([
      replyCreate.mock.calls[0][0][1],
      replyAliceJoin.mock.calls[0][0][1],
      replyJoin.mock.calls[0][0][1],
      {
        ...replyStart.mock.calls[0][0][1],
        playerCommits: {
          '0xAlice': commitSeed(aliceSeed),
          '0xBob': commitSeed(bobSeed),
        },
        cupCommits: game.cupCommits,
      },
      replyBid.mock.calls[0][0][1],
      showdownItem,
    ])
    expect(folded).toBeDefined()
    expect(folded!.verified).toBe(true)
    expect(folded!.status).toBe('resolved')
  })
  /** One message from `from`; the texts the bot replied with. */
  async function say(b: LiarsDiceBot, from: string, items: unknown[], ctx = mockBotCtx): Promise<string> {
    const reply = jest.fn()
    await b.onMessage({ senderAddress: from, items, reply } as unknown as BotMessageContext, ctx)
    return reply.mock.calls.flatMap(c => c[0]).filter((i: any) => i.type === 'text').map((i: any) => i.text).join('\n')
  }

  /** A table with Alice and Bob seated and its first round started. */
  async function startedTable(b: LiarsDiceBot) {
    await say(b, '0xAlice', [{ type: 'text', text: '/create' }])
    await say(b, '0xAlice', [{ type: 'text', text: '/join' }])
    await say(b, '0xBob', [{ type: 'text', text: '/join' }])
    const tableId = (b as any).latestTableId as string
    const game = (b as any).tables.get(tableId)
    return { tableId, game }
  }

  it('a reveal that fails verification returns every buy-in and ends the table: nothing more is played', async () => {
    const { tableId, game } = await startedTable(bot)
    expect(await say(bot, '0xAlice', [{ type: 'text', text: '/start' }])).toContain('Round 1 started')
    // The revealed server seed no longer opens its commitment.
    game.serverSeed = 'not-the-committed-seed'
    await say(bot, '0xAlice', [{ type: 'text', text: '/bid 2 3' }])
    const liar = await say(bot, '0xBob', [{ type: 'text', text: '/liar' }])
    expect(liar).toContain('verification failed')
    expect(liar).toContain('Every buy-in is returned')
    expect(game.status).not.toBe('resolved')
    expect(escrow.settlements).toEqual([
      {
        tableId,
        shares: [
          { player: '0xAlice', amountWei: BigInt(game.buyInWei) },
          { player: '0xBob', amountWei: BigInt(game.buyInWei) },
        ],
      },
    ])
    const round = game.roundNumber
    expect(await say(bot, '0xAlice', [{ type: 'text', text: '/start' }])).toContain('has ended')
    expect(await say(bot, '0xAlice', [{ type: 'text', text: '/bid 3 3' }])).toContain('has ended')
    expect(await say(bot, '0xBob', [{ type: 'text', text: '/liar' }])).toContain('has ended')
    expect(await say(bot, '0xCarol', [{ type: 'text', text: '/join' }])).toContain('has ended')
    expect(
      await say(bot, '0xCarol', [{ type: 'liars-dice', tableId, action: 'join' }])
    ).toContain('has ended')
    expect(
      await say(bot, '0xAlice', [{ type: 'liars-dice', tableId, action: 'bid', currentBid: { quantity: 4, face: 3 } }])
    ).toContain('has ended')
    expect(game.roundNumber).toBe(round)
    expect(game.players).toHaveLength(2)
    expect(escrow.settlements).toHaveLength(1)
  })

  it('a won table stays ended after its escrow record is dropped', async () => {
    escrow = seatingEscrowBook('liars-dice', { forgetOnSettle: true })
    bot = new LiarsDiceBot({ escrows: escrow.book })
    const { tableId, game } = await startedTable(bot)
    for (const p of game.players) p.diceCount = 1
    await say(bot, '0xAlice', [{ type: 'text', text: '/start' }])
    await say(bot, '0xAlice', [{ type: 'text', text: '/bid 1 2' }])
    expect(await say(bot, '0xBob', [{ type: 'text', text: '/liar' }])).toContain('GAME OVER')
    expect(bot.getTableEscrow(tableId)).toBeUndefined()
    expect(await say(bot, '0xAlice', [{ type: 'text', text: '/start' }])).toContain('has ended')
    expect(await say(bot, '0xCarol', [{ type: 'text', text: '/join' }])).toContain('has ended')
    expect(escrow.settlements).toHaveLength(1)
  })

  it('a table whose escrow has a settlement starts no round', async () => {
    const { tableId } = await startedTable(bot)
    ;(escrow.book.get(tableId) as any).settlement = { payouts: [] }
    expect(await say(bot, '0xAlice', [{ type: 'text', text: '/start' }])).toContain('has ended')
  })
})
