import { MessageItem } from '@frank/cashweb/types/messages'

import { STUB_REPLY_PREFIX } from '../qwen-reply'
import { createServer, Server } from 'http'

import { classifyReply, checkCors } from './smoke-checks'
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
