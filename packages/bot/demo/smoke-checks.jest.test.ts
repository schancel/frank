import { MessageItem } from '@frank/cashweb/types/messages'

import { STUB_REPLY_PREFIX } from '../qwen-reply'
import { createServer, Server } from 'http'

import type { ForumMessage } from '@frank/wallet/forum-model'

import { BlackjackMoveItem } from '@frank/cashweb/types/messages'
import {
  deriveDeck,
  sha256Hex,
} from '@frank/wallet/message-item-plugins/blackjack/deck'
import {
  buildBlackjackWelcomeItem,
  playOutDealer,
} from '@frank/wallet/message-item-plugins/blackjack/game'

import {
  checkCors,
  classifyReply,
  judgeFirstBet,
  judgeRaffleFill,
  judgeWelcome,
  POSTED_MESSAGE,
  POSTED_TITLE,
  verifyReadBackPost,
} from './smoke-checks'
import { startFakeRpc } from './fake-rpc'
import { DemoHandle } from './demo'

const text = (t: string): MessageItem[] => [{ type: 'text', text: t }]

describe('classifyReply', () => {
  it('qwen must answer in labelled stub mode', () => {
    expect(
      classifyReply('qwen', text(`${STUB_REPLY_PREFIX} You said: "hi"`)).ok,
    ).toBe(true)
    expect(classifyReply('qwen', text('Welcome to Frank!')).ok).toBe(false)
    expect(classifyReply('qwen', []).detail).toMatch(/nothing/)
  })

  it('vendor must send a non-empty catalog', () => {
    const catalog = (n: number): MessageItem[] => [
      {
        type: 'digital-goods',
        action: 'catalog',
        catalog: Array.from({ length: n }, (_, i) => ({
          itemId: `i${i}`,
          description: 'd',
          priceWei: '1',
        })),
      },
    ]
    expect(classifyReply('vendor', catalog(2)).ok).toBe(true)
    expect(classifyReply('vendor', catalog(0)).ok).toBe(false)
    expect(classifyReply('vendor', text('hi')).ok).toBe(false)
  })

  it('raffle must announce a round', () => {
    expect(
      classifyReply('raffle', [
        { type: 'raffle', raffleId: 'r', action: 'announce' },
      ]).ok,
    ).toBe(true)
    expect(
      classifyReply('raffle', [
        { type: 'raffle', raffleId: 'r', action: 'draw' },
      ]).ok,
    ).toBe(false)
  })

  it('blackjack must return the tagged dealer error', () => {
    expect(
      classifyReply(
        'blackjack',
        text('Blackjack: deal is a dealer-only action [game="g"]'),
      ).ok,
    ).toBe(true)
    expect(classifyReply('blackjack', text('something else')).ok).toBe(false)
  })

  it('an unknown bot fails closed', () => {
    expect(classifyReply('mystery', text('x')).ok).toBe(false)
  })
})

describe('checkCors (#361)', () => {
  const servers: Server[] = []
  afterEach(() => {
    for (const s of servers.splice(0)) s.close()
  })
  async function relayStub(cors: boolean): Promise<string> {
    const server = createServer((req, res) => {
      if (cors) res.setHeader('access-control-allow-origin', '*')
      res.statusCode = req.method === 'OPTIONS' ? 204 : 200
      res.end()
    })
    servers.push(server)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }
  const handleOf = (rpcUrl: string, relayUrl: string) =>
    ({ config: { fakeChain: true, rpcUrl }, relayUrl } as unknown as DemoHandle)

  it('passes when the fake chain and the relay both answer cross-origin requests', async () => {
    const fake = await startFakeRpc({ port: 0 })
    try {
      const result = await checkCors(handleOf(fake.url, await relayStub(true)))
      expect(result).toMatchObject({ name: 'cors', ok: true })
    } finally {
      await fake.close()
    }
  })

  it('sends exact CBOR Accept/Content-Type and preflights every normal Forum route', async () => {
    const seen: Array<{
      method?: string
      url?: string
      headers: Record<string, unknown>
    }> = []
    const server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers })
      res.setHeader('access-control-allow-origin', '*')
      res.statusCode = req.method === 'OPTIONS' ? 204 : 400
      res.end()
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const relay = `http://127.0.0.1:${
      (server.address() as { port: number }).port
    }`
    expect(
      (
        await checkCors({
          config: { fakeChain: false },
          relayUrl: relay,
        } as DemoHandle)
      ).ok,
    ).toBe(true)
    const actual = seen.filter(row => row.method !== 'OPTIONS')
    expect(actual.map(row => [row.method, row.url])).toEqual([
      ['PUT', '/message/monad/topics'],
      ['PUT', '/message/monad/topics/vote'],
      ['POST', '/message/monad/topics/status'],
      ['GET', '/message/monad/topics?topic=news'],
      ['GET', '/message/monad/topics/discover'],
      ['GET', `/message/monad/topics/${'00'.repeat(32)}`],
    ])
    for (const row of actual)
      expect(row.headers.accept).toBe('application/cbor')
    for (const row of actual.filter(row => row.method !== 'GET'))
      expect(row.headers['content-type']).toBe('application/cbor')
    for (const row of seen.filter(row => row.method === 'OPTIONS'))
      expect(row.headers['access-control-request-headers']).toBe(
        'content-type,accept',
      )
  })

  it('also fails when only the real responses lack the header (the preflight alone is not enough)', async () => {
    const fake = await startFakeRpc({ port: 0 })
    const server = createServer((req, res) => {
      if (req.method === 'OPTIONS')
        res.setHeader('access-control-allow-origin', '*')
      res.statusCode = req.method === 'OPTIONS' ? 204 : 400
      res.end()
    })
    servers.push(server)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const relay = `http://127.0.0.1:${
      (server.address() as { port: number }).port
    }`
    try {
      const result = await checkCors(handleOf(fake.url, relay))
      expect(result.ok).toBe(false)
      expect(result.detail).toMatch(
        /relay topics: PUT response has no access-control-allow-origin/,
      )
      expect(result.detail).toMatch(
        /relay topic read: GET response has no access-control/,
      )
    } finally {
      await fake.close()
    }
  })

  it('fails, naming the endpoint, when a request with an Origin gets no allow-origin', async () => {
    const fake = await startFakeRpc({ port: 0 })
    try {
      const noRelayCors = await checkCors(
        handleOf(fake.url, await relayStub(false)),
      )
      expect(noRelayCors.ok).toBe(false)
      expect(noRelayCors.detail).toMatch(
        /relay topics: preflight got HTTP 204 and no access-control/,
      )
      const noRpcCors = await checkCors(
        handleOf(await relayStub(false), await relayStub(true)),
      )
      expect(noRpcCors.ok).toBe(false)
      expect(noRpcCors.detail).toMatch(/fake chain RPC/)
    } finally {
      await fake.close()
    }
  })
})

describe('verifyReadBackPost (canonical Forum)', () => {
  const digest = 'ab'.repeat(32)
  const payload = (
    title = POSTED_TITLE,
    message = POSTED_MESSAGE,
  ): ForumMessage => ({
    topic: 'news',
    entries: [{ kind: 'post', title, message }],
    payloadDigest: digest,
    poster: '0x' + '11'.repeat(20),
    voteWeightWei: '9223372036854775807',
    visibleTimestamp: { seconds: '1', nanoseconds: 0 },
    timestamp: new Date(1000),
    epoch: '12'.repeat(16),
    revision: '18446744073709551615',
    transactionHash: '34'.repeat(32),
    authorBurnTx: '0x01',
    blockNumber: '0',
    transactionIndex: '0',
  })
  it('requires exact title/body/topic/parent/T1 from the normal client model', () => {
    expect(verifyReadBackPost(payload(), digest).ok).toBe(true)
    expect(
      verifyReadBackPost({ ...payload(), parentDigest: digest }, digest).ok,
    ).toBe(false)
    expect(
      verifyReadBackPost({ ...payload(), parentDigest: digest }, digest, {
        title: POSTED_TITLE,
        message: POSTED_MESSAGE,
        parentDigest: digest,
      }).ok,
    ).toBe(true)
    for (const changed of [
      payload('Other'),
      payload(POSTED_TITLE, 'other'),
      { ...payload(), payloadDigest: '00'.repeat(32) },
      { ...payload(), topic: 'other' },
      { ...payload(), entries: [...payload().entries, ...payload().entries] },
    ])
      expect(verifyReadBackPost(changed, digest).ok).toBe(false)
    expect(
      verifyReadBackPost({ ...payload(), entries: [] }, digest).detail,
    ).toMatch(/no entries/)
    expect(verifyReadBackPost(undefined, digest).detail).toMatch(
      /does not return it/,
    )
  })
  it('accepts wide observations without Number coercion or BigInt persistence', () => {
    const exact = { ...payload(), voteWeightWei: (-(1n << 255n)).toString() }
    const restored = JSON.parse(JSON.stringify(exact))
    expect(restored.voteWeightWei).toBe(exact.voteWeightWei)
    expect(restored.revision).toBe('18446744073709551615')
    expect(verifyReadBackPost(restored, digest).ok).toBe(true)
  })
})

describe('judgeRaffleFill (#363)', () => {
  const E = ['0xaa', '0xbb', '0xcc']
  const RAFFLE = '0xraffle'
  const draw = (winner: string): MessageItem =>
    ({
      type: 'raffle',
      raffleId: 'r',
      action: 'draw',
      winnerAddress: winner,
      potWei: '60',
    } as MessageItem)
  const draws = (winner = '0xbb') =>
    new Map(E.map(e => [e, draw(winner) as never]))
  const pay = { from: RAFFLE, to: '0xbb', valueWei: '60' }
  it('passes when everyone got the draw and the winner was paid exactly the pot once', () => {
    expect(
      judgeRaffleFill({
        entrants: E,
        draws: draws(),
        raffleAddress: RAFFLE,
        entryPriceWei: 20n,
        maxEntries: 3,
        txs: [pay],
      }).ok,
    ).toBe(true)
  })
  it.each([
    ['no payout', []],
    ['a short payout', [{ ...pay, valueWei: '59' }]],
    ['a double payout', [pay, pay]],
    ['a payout to someone else', [{ ...pay, to: '0xcc' }]],
  ])('fails on %s', (_n, txs) => {
    expect(
      judgeRaffleFill({
        entrants: E,
        draws: draws(),
        raffleAddress: RAFFLE,
        entryPriceWei: 20n,
        maxEntries: 3,
        txs,
      }).ok,
    ).toBe(false)
  })
  it('fails on a wrong pot, a wrong round size, or a payment to a non-winner entrant', () => {
    const base = {
      entrants: E,
      raffleAddress: RAFFLE,
      entryPriceWei: 20n,
      maxEntries: 3,
    }
    expect(
      judgeRaffleFill({
        ...base,
        draws: draws(),
        txs: [pay],
        entryPriceWei: 25n,
      }).ok,
    ).toBe(false) // pot 60 != 75
    expect(
      judgeRaffleFill({ ...base, draws: draws(), txs: [pay], maxEntries: 4 })
        .ok,
    ).toBe(false)
    const extra = { from: RAFFLE, to: '0xcc', valueWei: '1' }
    expect(
      judgeRaffleFill({ ...base, draws: draws(), txs: [pay, extra] }).ok,
    ).toBe(false)
    // Payments to non-entrants (e.g. a top-up recipient) are not this check's business.
    expect(
      judgeRaffleFill({
        ...base,
        draws: draws(),
        txs: [pay, { from: RAFFLE, to: '0xdd', valueWei: '9' }],
      }).ok,
    ).toBe(true)
  })
  it('fails when an entrant got no draw or the winner is not an entrant', () => {
    const partial = draws()
    partial.delete('0xcc')
    expect(
      judgeRaffleFill({
        entrants: E,
        draws: partial,
        raffleAddress: RAFFLE,
        entryPriceWei: 20n,
        maxEntries: 3,
        txs: [pay],
      }).ok,
    ).toBe(false)
    expect(
      judgeRaffleFill({
        entrants: E,
        draws: draws('0xzz'),
        raffleAddress: RAFFLE,
        entryPriceWei: 20n,
        maxEntries: 3,
        txs: [{ ...pay, to: '0xzz' }],
      }).ok,
    ).toBe(false)
  })
})

describe('judgeWelcome (#395)', () => {
  const expected = { minWei: 10n ** 16n, maxWei: 10n ** 18n }
  const welcome = (over: Partial<BlackjackMoveItem> = {}): MessageItem[] => [
    {
      ...buildBlackjackWelcomeItem({
        minWagerWei: 10n ** 16n,
        maxWagerWei: 10n ** 18n,
      }),
      ...over,
    },
    { type: 'text', text: 'Welcome to the blackjack table.' },
  ]

  it('accepts a valid welcome with the dealer limits, then a text line', () => {
    expect(judgeWelcome(welcome(), expected).ok).toBe(true)
  })

  it('fails without a welcome item', () => {
    expect(judgeWelcome(text('hi'), expected)).toMatchObject({ ok: false })
  })

  it('fails when the advertised limits differ from the dealer configuration', () => {
    const verdict = judgeWelcome(
      welcome({ maxWagerWei: '20000000000000000' }),
      expected,
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.detail).toMatch(/configured for/)
  })

  it('fails a malformed welcome', () => {
    expect(
      judgeWelcome(welcome({ minWagerWei: 'x' }), expected).detail,
    ).toMatch(/malformed/)
  })

  it('fails when the text line is not last (an older client preview would break)', () => {
    const [w, t] = welcome()
    expect(judgeWelcome([t, w], expected).ok).toBe(false)
  })
})

describe('judgeFirstBet (#395)', () => {
  const HASH = `0x${'ab'.repeat(32)}`
  const PLAYER = `0x${'aa'.repeat(20)}`
  const SEED = 'smoke-seed'
  const deck = deriveDeck(SEED, HASH, 0)
  const playerCards = [deck[0], deck[2]]
  const played = playOutDealer(deck, playerCards, 4)
  const bet: BlackjackMoveItem = {
    type: 'blackjack-move',
    gameId: 'g',
    action: 'bet',
    wagerTxHash: HASH,
  }
  const deal: BlackjackMoveItem = {
    type: 'blackjack-move',
    gameId: 'g',
    action: 'deal',
    serverSeedHash: sha256Hex(SEED),
    playerCards,
    dealerUpCard: deck[1],
  }
  const stand: BlackjackMoveItem = {
    type: 'blackjack-move',
    gameId: 'g',
    action: 'stand',
  }
  const reveal = (
    over: Partial<BlackjackMoveItem> = {},
  ): BlackjackMoveItem => ({
    type: 'blackjack-move',
    gameId: 'g',
    action: 'reveal',
    dealerCards: played.dealerCards,
    serverSeed: SEED,
    outcome: played.outcome,
    ...over,
  })
  const judge = (moves: BlackjackMoveItem[]) =>
    judgeFirstBet({
      gameId: 'g',
      wagerTxHash: HASH,
      wagerWei: 10n ** 16n,
      playerAddress: PLAYER,
      moves,
    })

  it('accepts a resolved, fair hand', () => {
    expect(judge([bet, deal, stand, reveal()])).toMatchObject({ ok: true })
  })

  it('fails when the hand never resolves', () => {
    expect(judge([bet, deal, stand])).toMatchObject({ ok: false })
    expect(judge([bet, deal, stand]).detail).toMatch(/did not resolve/)
  })

  it('fails a reveal whose seed does not match the commitment', () => {
    const verdict = judge([bet, deal, stand, reveal({ serverSeed: 'other' })])
    expect(verdict.ok).toBe(false)
    expect(verdict.detail).toMatch(/fairness/)
  })

  it('fails a reveal with a tampered outcome', () => {
    const wrong = played.outcome === 'dealer_win' ? 'player_win' : 'dealer_win'
    expect(judge([bet, deal, stand, reveal({ outcome: wrong })]).ok).toBe(false)
  })
})
