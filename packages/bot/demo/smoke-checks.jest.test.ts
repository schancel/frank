import { createServer, Server } from 'http'

import type { BotContext, BotMessageContext } from '@frank/bot-framework'
import { MessageItem } from '@frank/cashweb/types/messages'

import { STUB_REPLY_PREFIX } from '../qwen-reply'
import { BlackjackDealerBot } from '../src/bots/blackjack-bot'
import { harness } from '../src/bots/bot-harness.testutil'
import { RpsBot } from '../src/bots/rps-bot'
import { SatoshiDiceBot } from '../src/bots/satoshi-dice-bot'
import { overTheWire } from '../src/bots/wire.testutil'
import { DemoHandle } from './demo'
import { BotReply, checkCors, classifyReply, QWEN_PROMPT, ReplyExpectations, SMOKE_PROMPT_NEED_WEI, smokeUserNeedWei } from './smoke-checks'

/** A free message carrying `items`, as the test user receives it. */
const free = (items: MessageItem[]): BotReply => ({ items, stampValueWei: 0n })
const text = (t: string): BotReply => free([{ type: 'text', text: t }])
const item = (value: Record<string, unknown>) => value as unknown as MessageItem

/** What the real bot answers to `prompt`, read back through the real item codecs as the test
 * user's wallet reads it, with what the bot's message paid. Nothing here is written by hand, so a
 * change to what a bot sends shows up in these tests. */
async function realReply(
  bot: { onMessage(message: BotMessageContext, ctx: BotContext): Promise<void> },
  prompt: string,
  h = harness(),
): Promise<BotReply> {
  await bot.onMessage(h.message([{ type: 'text', text: prompt }]), h.ctx)
  const sent = h.sent[h.sent.length - 1]
  return { items: overTheWire(sent.items), stampValueWei: sent.valueWei }
}

/** `reply` with its first item of `type` changed by `change`, through the codec again where the
 * codec allows the change. */
function altered(reply: BotReply, type: string, change: (item: Record<string, unknown>) => void): BotReply {
  const items = reply.items.map(i => {
    if (i.type !== type) return i
    const copy = { ...(i as unknown as Record<string, unknown>) }
    change(copy)
    return copy as unknown as MessageItem
  })
  return { ...reply, items }
}
const STUB: ReplyExpectations = { qwenMode: 'stub', raffleEntryPriceWei: '20000000000000000', raffleMaxEntries: 5 }
const LIVE: ReplyExpectations = { ...STUB, qwenMode: 'live' }

describe('classifyReply: each bot is judged on what it said', () => {
  it('qwen in stub mode must answer with the labelled stub that echoes the question', () => {
    expect(classifyReply('qwen', text(`${STUB_REPLY_PREFIX} You said: "${QWEN_PROMPT}"`), STUB).ok).toBe(true)
    // A labelled stub about something else, or an unlabelled answer, is not the reply to this question.
    expect(classifyReply('qwen', text(`${STUB_REPLY_PREFIX} You said: "hi"`), STUB).ok).toBe(false)
    expect(classifyReply('qwen', text('Frank is a messaging app.'), STUB).ok).toBe(false)
    expect(classifyReply('qwen', free([]), STUB)).toMatchObject({ ok: false, detail: expect.stringContaining('nothing') })
  })

  it('qwen in live mode must give a real answer about Frank, never a stub or a fragment', () => {
    expect(
      classifyReply('qwen', text('Frank is a wallet and a paid encrypted messenger on Monad.'), LIVE).ok,
    ).toBe(true)
    expect(classifyReply('qwen', text(`${STUB_REPLY_PREFIX} You said: "${QWEN_PROMPT}"`), LIVE)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('configured live but answered with a stub'),
    })
    expect(classifyReply('qwen', text('Slow down'), LIVE).ok).toBe(false)
    expect(classifyReply('qwen', text('Sorry, something went wrong on my side, try again.'), LIVE).ok).toBe(false)
    expect(classifyReply('qwen', text(''), LIVE).ok).toBe(false)
  })

  it('vendor must send a catalog whose items have an id and a price', () => {
    const catalog = (entries: unknown[]) => free([item({ type: 'digital-goods', action: 'catalog', catalog: entries })])
    expect(classifyReply('vendor', catalog([{ itemId: 'a', priceWei: '100' }]), STUB)).toMatchObject({
      ok: true,
      detail: 'catalog with 1 priced item(s)',
    })
    expect(classifyReply('vendor', catalog([]), STUB).ok).toBe(false)
    expect(classifyReply('vendor', catalog([{ itemId: 'a', priceWei: '0' }]), STUB).ok).toBe(false)
    expect(classifyReply('vendor', catalog([{ priceWei: '100' }]), STUB).ok).toBe(false)
    expect(classifyReply('vendor', text('hello'), STUB).ok).toBe(false)
  })

  it('raffle must announce the configured round with its seed committed', () => {
    const round = (over: Record<string, unknown> = {}) =>
      free([
        item({
          type: 'raffle',
          raffleId: 'r1',
          action: 'announce',
          entryPriceWei: '20000000000000000',
          maxEntries: 5,
          serverSeedHash: 'ab'.repeat(32),
          ...over,
        }),
      ])
    expect(classifyReply('raffle', round(), STUB).ok).toBe(true)
    expect(classifyReply('raffle', round({ serverSeedHash: undefined }), STUB)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('without its committed seed hash'),
    })
    expect(classifyReply('raffle', round({ maxEntries: 3 }), STUB).ok).toBe(false)
    expect(classifyReply('raffle', round({ entryPriceWei: '1' }), STUB).ok).toBe(false)
    expect(classifyReply('raffle', round({ action: 'draw' }), STUB).ok).toBe(false)
  })

  it('blackjack: the real dealer\'s answer passes, as a free dealer challenge with its game ID, commitment and table', async () => {
    const reply = await realReply(new BlackjackDealerBot(), 'deal me in')
    expect(reply.items.map(i => i.type)).toEqual(['blackjack-hand', 'text'])
    const challenge = reply.items[0] as unknown as { gameId: string }
    expect(classifyReply('blackjack', reply, STUB)).toEqual({
      name: 'blackjack',
      ok: true,
      // The harness dealer holds 1 MON: 0.02 kept back, a quarter of the rest covered.
      detail: `a free dealer challenge for game ${challenge.gameId.slice(0, 8)}, seed committed, bets from 0.01 MON to 0.245 MON`,
    })
  })

  it('blackjack: anything less than the protocol\'s challenge fails, naming what is missing', async () => {
    const reply = await realReply(new BlackjackDealerBot(), 'deal me in')
    const fails = (changed: BotReply, why: string, expected: ReplyExpectations = STUB) =>
      expect(classifyReply('blackjack', changed, expected)).toMatchObject({ ok: false, detail: expect.stringContaining(why) })
    fails(text('Blackjack: bet between 0.01 MON and 0.245 MON.'), 'expected a blackjack-hand challenge, got text')
    fails(altered(reply, 'blackjack-hand', i => (i.action = 'accept')), 'expected a blackjack-hand challenge, got blackjack-hand:accept,text')
    fails(altered(reply, 'blackjack-hand', i => delete i.gameId), 'no game ID')
    fails(altered(reply, 'blackjack-hand', i => (i.gameId = 'r1')), 'no game ID')
    fails(altered(reply, 'blackjack-hand', i => (i.role = 'player')), 'sent as the player')
    fails(altered(reply, 'blackjack-hand', i => delete i.commitment), 'no commitment')
    fails(altered(reply, 'blackjack-hand', i => (i.maxBetWei = '1')), 'below the table minimum of 0.01 MON')
    fails({ ...reply, items: [reply.items[0]] }, 'does not name the table')
    fails(altered(reply, 'text', i => (i.text = 'Here is a fresh blackjack challenge!')), 'does not name the table')
    // The demo's configured minimum is the one the dealer must name.
    fails(reply, 'does not name the table (bet between 0.05 MON and 0.245 MON)', { ...STUB, blackjackMinWagerWei: 50_000_000_000_000_000n })
    // Offering a hand costs the dealer nothing and pays the player nothing.
    fails({ ...reply, stampValueWei: 10_000_000_000_000_000n }, 'the message paid 0.01 MON')
  })

  it('blackjack: a dealer run with the demo\'s configured minimum passes against that minimum', async () => {
    const minWagerWei = 50_000_000_000_000_000n
    const reply = await realReply(new BlackjackDealerBot({ minWagerWei }), 'deal me in')
    expect(classifyReply('blackjack', reply, { ...STUB, blackjackMinWagerWei: minWagerWei }).ok).toBe(true)
  })

  // The table's limit is what the bank has available: the test bank holds 1 MON, keeps 0.02 for
  // its fees and owes nothing, so a roll pays up to 0.98 MON and a match is played for up to half.
  it('dice: the real bot\'s answer to "help" passes, as a free table with its roll committed and the limit named', async () => {
    const reply = await realReply(new SatoshiDiceBot(), 'help')
    expect(reply.items.map(i => i.type)).toEqual(['dice', 'text'])
    const table = reply.items[0] as unknown as { rollId: string }
    expect(classifyReply('dice', reply, STUB)).toEqual({
      name: 'dice',
      ok: true,
      detail: `a free table for roll ${table.rollId.slice(0, 8)}, secret committed, paying up to 0.98 MON a roll`,
    })
  })

  it('dice: a reply that is not the offered roll, gives the secret away, or hides the limit fails', async () => {
    const h = harness()
    const reply = await realReply(new SatoshiDiceBot(), 'help', h)
    const fails = (changed: BotReply, why: string, expected: ReplyExpectations = STUB) =>
      expect(classifyReply('dice', changed, expected)).toMatchObject({ ok: false, detail: expect.stringContaining(why) })
    fails(text('Satoshi Dice'), 'expected a dice table, got text')
    fails(altered(reply, 'dice', i => (i.action = 'result')), 'expected a dice table, got dice:result,text')
    fails(altered(reply, 'dice', i => delete i.rollId), 'names no roll')
    fails(altered(reply, 'dice', i => delete i.commitment), 'no commitment')
    const rollId = (reply.items[0] as unknown as { rollId: string }).rollId
    const secret = (JSON.parse(h.data.get(`roll:${rollId}`)!) as { secret: string }).secret
    fails(altered(reply, 'dice', i => (i.serverSecret = secret)), 'gives away the secret')
    fails({ ...reply, items: [reply.items[0]] }, 'does not name the table limit and how a stake is paid')
    fails(reply, 'does not name the table limit of 0.5 MON', { ...STUB, diceMaxPayoutWei: 500_000_000_000_000_000n })
    fails({ ...reply, stampValueWei: 1n }, 'an offer to play carries no money')
  })

  it('rps: the real bot\'s answer to "help" passes, as a free match start with its move committed and the limit named', async () => {
    const reply = await realReply(new RpsBot(), 'help')
    expect(reply.items.map(i => i.type)).toEqual(['rps', 'text'])
    const start = reply.items[0] as unknown as { matchId: string }
    expect(classifyReply('rps', reply, STUB)).toEqual({
      name: 'rps',
      ok: true,
      detail: `a free start of match ${start.matchId.slice(0, 8)}, move committed, stakes up to 0.49 MON`,
    })
  })

  it('rps: a reply that is not a match start, gives the move away, or hides the limit fails', async () => {
    const reply = await realReply(new RpsBot(), 'help')
    const fails = (changed: BotReply, why: string, expected: ReplyExpectations = STUB) =>
      expect(classifyReply('rps', changed, expected)).toMatchObject({ ok: false, detail: expect.stringContaining(why) })
    fails(text('Rock-Paper-Scissors'), 'expected a rock-paper-scissors match start, got text')
    fails(altered(reply, 'rps', i => (i.action = 'resolve')), 'got rps:resolve,text')
    fails(altered(reply, 'rps', i => delete i.matchId), 'names no match')
    fails(altered(reply, 'rps', i => delete i.commitHash), 'no commitment')
    fails(altered(reply, 'rps', i => (i.botMove = 'rock')), "gives away the bot's move")
    fails(altered(reply, 'rps', i => (i.secretSalt = 'ab'.repeat(16))), "gives away the bot's move")
    fails({ ...reply, items: [reply.items[0]] }, 'does not name the table limit and how a stake is paid')
    fails(reply, 'does not name the table limit of 0.2 MON', { ...STUB, rpsMaxWagerWei: 200_000_000_000_000_000n })
    fails({ ...reply, stampValueWei: 1n }, 'an offer to play carries no money')
  })

  it('the test user is topped up to what its prompts need: one named amount per prompt', () => {
    expect(smokeUserNeedWei(6)).toBe(SMOKE_PROMPT_NEED_WEI * 6n)
    expect(smokeUserNeedWei(0)).toBe(0n)
  })

  it('an unknown bot fails closed', () => {
    expect(classifyReply('poker', text('hi'), STUB).ok).toBe(false)
  })
})

describe('checkCors (#361)', () => {
  const servers: Server[] = []
  afterEach(() => {
    for (const s of servers.splice(0)) s.close()
  })
  async function serve(handler: (method: string, res: import('http').ServerResponse) => void, seen?: Array<{ method?: string; url?: string; headers: Record<string, unknown> }>): Promise<DemoHandle> {
    const server = createServer((req, res) => {
      seen?.push({ method: req.method, url: req.url, headers: req.headers })
      handler(req.method ?? '', res)
      res.end()
    })
    servers.push(server)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    return { relayUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` } as unknown as DemoHandle
  }

  it('sends exact CBOR Accept/Content-Type and preflights the chain proxy and every Forum route', async () => {
    const seen: Array<{ method?: string; url?: string; headers: Record<string, unknown> }> = []
    const handle = await serve((method, res) => {
      res.setHeader('access-control-allow-origin', '*')
      res.statusCode = method === 'OPTIONS' ? 204 : 400
    }, seen)
    expect((await checkCors(handle)).ok).toBe(true)
    const actual = seen.filter(row => row.method !== 'OPTIONS')
    expect(actual.map(row => [row.method, row.url])).toEqual([
      ['POST', '/chain-rpc/monad-testnet/rpc'],
      ['PUT', '/message/monad/topics'],
      ['PUT', '/message/monad/topics/vote'],
      ['POST', '/message/monad/topics/status'],
      ['GET', '/message/monad/topics?topic=news'],
      ['GET', '/message/monad/topics/discover'],
      ['GET', `/message/monad/topics/${'00'.repeat(32)}`],
    ])
    const forum = actual.filter(row => row.url?.startsWith('/message/'))
    for (const row of forum) expect(row.headers.accept).toBe('application/cbor')
    for (const row of forum.filter(row => row.method !== 'GET')) {
      expect(row.headers['content-type']).toBe('application/cbor')
    }
    for (const row of seen.filter(row => row.method === 'OPTIONS')) {
      expect(row.headers['access-control-request-headers']).toBe('content-type,accept')
    }
  })

  it('fails when only the real responses lack the header (the preflight alone is not enough)', async () => {
    const handle = await serve((method, res) => {
      if (method === 'OPTIONS') res.setHeader('access-control-allow-origin', '*')
      res.statusCode = method === 'OPTIONS' ? 204 : 400
    })
    const result = await checkCors(handle)
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/relay chain RPC: POST response has no access-control-allow-origin/)
    expect(result.detail).toMatch(/relay topics: PUT response has no access-control-allow-origin/)
    expect(result.detail).toMatch(/relay topic read: GET response has no access-control/)
  })

  it('fails, naming the endpoint, when a preflight gets no allow-origin', async () => {
    const handle = await serve((method, res) => {
      res.statusCode = method === 'OPTIONS' ? 204 : 200
    })
    const result = await checkCors(handle)
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/relay topics: preflight got HTTP 204 and no access-control/)
  })
})
