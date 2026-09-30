import { MessageItem } from '@frank/cashweb/types/messages'

import { STUB_REPLY_PREFIX } from '../qwen-reply'
import { createServer, Server } from 'http'

import { buildTopicPostPayload } from '@frank/wallet/monad-topic-post-client'

import {
  checkCors,
  classifyReply,
  judgeRaffleFill,
  POSTED_MESSAGE,
  POSTED_TITLE,
  verifyReadBackPost,
} from './smoke-checks'
import { startFakeRpc } from './fake-rpc'
import { DemoHandle } from './demo'

const text = (t: string): MessageItem[] => [{ type: 'text', text: t }]

describe('classifyReply', () => {
  it('qwen must answer in labelled stub mode', () => {
    expect(classifyReply('qwen', text(`${STUB_REPLY_PREFIX} You said: "hi"`)).ok).toBe(true)
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
      classifyReply('raffle', [{ type: 'raffle', raffleId: 'r', action: 'announce' }]).ok,
    ).toBe(true)
    expect(classifyReply('raffle', [{ type: 'raffle', raffleId: 'r', action: 'draw' }]).ok).toBe(
      false,
    )
  })

  it('blackjack must return the tagged dealer error', () => {
    expect(
      classifyReply('blackjack', text('Blackjack: deal is a dealer-only action [game="g"]')).ok,
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

  it('also fails when only the real responses lack the header (the preflight alone is not enough)', async () => {
    const fake = await startFakeRpc({ port: 0 })
    const server = createServer((req, res) => {
      if (req.method === 'OPTIONS') res.setHeader('access-control-allow-origin', '*')
      res.statusCode = req.method === 'OPTIONS' ? 204 : 400
      res.end()
    })
    servers.push(server)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const relay = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      const result = await checkCors(handleOf(fake.url, relay))
      expect(result.ok).toBe(false)
      expect(result.detail).toMatch(/relay topics: PUT response has no access-control-allow-origin/)
      expect(result.detail).toMatch(/relay topic read: GET response has no access-control/)
    } finally {
      await fake.close()
    }
  })

  it('fails, naming the endpoint, when a request with an Origin gets no allow-origin', async () => {
    const fake = await startFakeRpc({ port: 0 })
    try {
      const noRelayCors = await checkCors(handleOf(fake.url, await relayStub(false)))
      expect(noRelayCors.ok).toBe(false)
      expect(noRelayCors.detail).toMatch(
        /relay topics: preflight got HTTP 204 and no access-control/,
      )
      const noRpcCors = await checkCors(handleOf(await relayStub(false), await relayStub(true)))
      expect(noRpcCors.ok).toBe(false)
      expect(noRpcCors.detail).toMatch(/fake chain RPC/)
    } finally {
      await fake.close()
    }
  })
})

describe('verifyReadBackPost (#364)', () => {
  const payload = (title: string, message: string) =>
    buildTopicPostPayload({ topic: 'news', entries: [{ kind: 'post', title, message }] })

  it('passes only when the title and the message read back are the ones posted', () => {
    expect(verifyReadBackPost(payload(POSTED_TITLE, POSTED_MESSAGE), 'abcdef0123456789').ok).toBe(
      true,
    )
  })

  it('fails on a different title, a different message, no entries, or no post at all', () => {
    expect(verifyReadBackPost(payload('Other', POSTED_MESSAGE), 'ab').detail).toMatch(/different/)
    expect(verifyReadBackPost(payload(POSTED_TITLE, 'other'), 'ab').ok).toBe(false)
    expect(
      verifyReadBackPost(buildTopicPostPayload({ topic: 'news', entries: [] }), 'ab').detail,
    ).toMatch(/no entries/)
    expect(verifyReadBackPost(undefined, 'ab').detail).toMatch(/does not return it/)
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
        txs,
      }).ok,
    ).toBe(false)
  })
  it('fails when an entrant got no draw or the winner is not an entrant', () => {
    const partial = draws()
    partial.delete('0xcc')
    expect(
      judgeRaffleFill({
        entrants: E,
        draws: partial,
        raffleAddress: RAFFLE,
        txs: [pay],
      }).ok,
    ).toBe(false)
    expect(
      judgeRaffleFill({
        entrants: E,
        draws: draws('0xzz'),
        raffleAddress: RAFFLE,
        txs: [{ ...pay, to: '0xzz' }],
      }).ok,
    ).toBe(false)
  })
})
