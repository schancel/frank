import { createServer, Server } from 'http'

import { MessageItem } from '@frank/cashweb/types/messages'

import { STUB_REPLY_PREFIX } from '../qwen-reply'
import { DemoHandle } from './demo'
import { checkCors, classifyReply, QWEN_PROMPT, ReplyExpectations } from './smoke-checks'

const text = (t: string): MessageItem[] => [{ type: 'text', text: t }]
const item = (value: Record<string, unknown>) => value as unknown as MessageItem
const STUB: ReplyExpectations = { qwenMode: 'stub', raffleEntryPriceWei: '20000000000000000', raffleMaxEntries: 5 }
const LIVE: ReplyExpectations = { ...STUB, qwenMode: 'live' }

describe('classifyReply: each bot is judged on what it said', () => {
  it('qwen in stub mode must answer with the labelled stub that echoes the question', () => {
    expect(classifyReply('qwen', text(`${STUB_REPLY_PREFIX} You said: "${QWEN_PROMPT}"`), STUB).ok).toBe(true)
    // A labelled stub about something else, or an unlabelled answer, is not the reply to this question.
    expect(classifyReply('qwen', text(`${STUB_REPLY_PREFIX} You said: "hi"`), STUB).ok).toBe(false)
    expect(classifyReply('qwen', text('Frank is a messaging app.'), STUB).ok).toBe(false)
    expect(classifyReply('qwen', [], STUB)).toMatchObject({ ok: false, detail: expect.stringContaining('nothing') })
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
    const catalog = (entries: unknown[]) => [item({ type: 'digital-goods', action: 'catalog', catalog: entries })]
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
    const round = (over: Record<string, unknown> = {}) => [
      item({
        type: 'raffle',
        raffleId: 'r1',
        action: 'announce',
        entryPriceWei: '20000000000000000',
        maxEntries: 5,
        serverSeedHash: 'ab'.repeat(32),
        ...over,
      }),
    ]
    expect(classifyReply('raffle', round(), STUB).ok).toBe(true)
    expect(classifyReply('raffle', round({ serverSeedHash: undefined }), STUB)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('without its committed seed hash'),
    })
    expect(classifyReply('raffle', round({ maxEntries: 3 }), STUB).ok).toBe(false)
    expect(classifyReply('raffle', round({ entryPriceWei: '1' }), STUB).ok).toBe(false)
    expect(classifyReply('raffle', round({ action: 'draw' }), STUB).ok).toBe(false)
  })

  it('blackjack must open a hand: a challenge item with a game id, and its text', () => {
    const challenge = [
      item({ type: 'blackjack-hand', action: 'challenge', gameId: 'ab'.repeat(16) }),
      ...text('Here is a fresh blackjack challenge! Enter your bet amount above'),
    ]
    expect(classifyReply('blackjack', challenge, STUB)).toMatchObject({ ok: true, detail: 'dealt a challenge for game abababab' })
    expect(classifyReply('blackjack', text('Here is a fresh blackjack challenge!'), STUB).ok).toBe(false)
    expect(classifyReply('blackjack', [challenge[0]], STUB).ok).toBe(false)
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
