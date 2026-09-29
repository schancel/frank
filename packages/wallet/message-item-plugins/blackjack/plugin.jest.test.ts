import { getMessageItemPlugin } from '../index'
import '../built-in'
import './plugin'

const HASH = `0x${'ab'.repeat(32)}`
const plugin = () => getMessageItemPlugin('blackjack-move')!
const bet = { type: 'blackjack-move', gameId: 'g', action: 'bet', wagerTxHash: HASH } as never

function provider(over: Partial<Record<string, jest.Mock>> = {}) {
  return {
    getTransaction: jest.fn(async () => ({ from: '0xP', to: '0xD', value: 100n })),
    getTransactionReceipt: jest.fn(async () => ({ status: 1 })),
    ...over,
  }
}
const ctx = (p: unknown) => ({ message: { senderAddress: '0xP' }, index: 0, provider: p }) as never
const hydrate = (p: unknown, raw: unknown = bet) => plugin().hydrate(raw as never, ctx(p)) as Promise<any>

describe('blackjack hydrate verification cache', () => {
  it('a second hydrate makes no RPC calls and returns the same value', async () => {
    const p = provider()
    const first = await hydrate(p)
    expect(first.verifiedWager).toEqual({ fromAddress: '0xP', toAddress: '0xD', valueWei: 100n })
    expect(p.getTransaction).toHaveBeenCalledTimes(1)
    expect(p.getTransactionReceipt).toHaveBeenCalledTimes(1)
    const second = await hydrate(p)
    expect(second.verifiedWager).toEqual(first.verifiedWager)
    expect(p.getTransaction).toHaveBeenCalledTimes(1)
    expect(p.getTransactionReceipt).toHaveBeenCalledTimes(1)
  })

  it('keeps the verified value when a later lookup would fail', async () => {
    const p = provider()
    await hydrate(p)
    p.getTransaction.mockRejectedValue(new Error('rpc down'))
    const again = await hydrate(p)
    expect(again.verifiedWager?.valueWei).toBe(100n)
  })

  it('never caches a failure or an unverified result', async () => {
    const p = provider()
    p.getTransaction.mockRejectedValueOnce(new Error('rpc down'))
    expect((await hydrate(p)).verifiedWager).toBeUndefined()
    p.getTransactionReceipt.mockResolvedValueOnce({ status: 0 } as never)
    expect((await hydrate(p)).verifiedWager).toBeUndefined()
    p.getTransactionReceipt.mockResolvedValueOnce(null as never)
    expect((await hydrate(p)).verifiedWager).toBeUndefined()
    // The next healthy lookup still succeeds and only then is cached.
    expect((await hydrate(p)).verifiedWager?.valueWei).toBe(100n)
    expect(p.getTransaction).toHaveBeenCalledTimes(4)
    await hydrate(p)
    expect(p.getTransaction).toHaveBeenCalledTimes(4)
  })

  it('keys case-insensitively and per provider', async () => {
    const p = provider()
    await hydrate(p)
    await hydrate(p, { ...(bet as object), wagerTxHash: HASH.toUpperCase().replace('0X', '0x') })
    expect(p.getTransaction).toHaveBeenCalledTimes(1)
    const other = provider()
    await hydrate(other)
    expect(other.getTransaction).toHaveBeenCalledTimes(1)
  })

  it('bounds the cache by evicting the oldest entry', async () => {
    const p = provider()
    for (let i = 0; i < 300; i++) {
      await hydrate(p, { ...(bet as object), wagerTxHash: `0x${i.toString(16).padStart(64, '0')}` })
    }
    expect(p.getTransaction).toHaveBeenCalledTimes(300)
    await hydrate(p, { ...(bet as object), wagerTxHash: `0x${'0'.repeat(64)}` }) // evicted
    expect(p.getTransaction).toHaveBeenCalledTimes(301)
    await hydrate(p, { ...(bet as object), wagerTxHash: `0x${(299).toString(16).padStart(64, '0')}` }) // kept
    expect(p.getTransaction).toHaveBeenCalledTimes(301)
  })
})
