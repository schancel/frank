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

describe('blackjack welcome action (#395)', () => {
  const welcomeItem = {
    type: 'blackjack-move',
    gameId: 'welcome',
    action: 'welcome',
    minWagerWei: '20000000000000000',
    maxWagerWei: '500000000000000000',
    feeHintWei: '60000000000000000',
    rules: 'A natural pays 3:2.',
  }

  it('round-trips through the item serialization, hydrate and the preview', async () => {
    const { deserializeMessageItems, serializeMessageItems } = await import(
      '../../chain/monad-chain'
    )
    const items = deserializeMessageItems(
      serializeMessageItems([welcomeItem as never, { type: 'text', text: 'hi' }]),
    )
    expect(items[0]).toEqual(welcomeItem)
    const hydrated = await hydrate(provider(), items[0])
    expect(hydrated.action).toBe('welcome')
    expect(hydrated.welcome).toEqual({
      minWagerWei: 20000000000000000n,
      maxWagerWei: 500000000000000000n,
      feeHintWei: 60000000000000000n,
      rules: 'A natural pays 3:2.',
    })
    // A welcome never looks up a wager on chain.
    expect(hydrated.verifiedWager).toBeUndefined()
    expect(plugin().previewText(items[0] as never)).toBe('Blackjack table open')
  })

  it('tolerates an action it does not know: a string preview and no state', async () => {
    const future = { type: 'blackjack-move', gameId: 'g', action: 'surrender' } as never
    expect(plugin().previewText(future)).toBe('Blackjack')
    const hydrated = await hydrate(provider(), future)
    const state = plugin().reduceState!(undefined, hydrated, ctx(provider()))
    expect(state.playerCards).toEqual([])
    expect(state.availableActions).toEqual([])
    // ...and never disturbs a hand in progress.
    const inProgress = { ...state, phase: 'player_turn', availableActions: ['hit'] }
    expect(plugin().reduceState!(inProgress, hydrated, ctx(provider()))).toBe(inProgress)
  })

  it('a welcome never creates or changes a hand', async () => {
    const hydrated = await hydrate(provider(), welcomeItem)
    const fresh = plugin().reduceState!(undefined, hydrated, ctx(provider()))
    expect(fresh.availableActions).toEqual([])
    expect(fresh.wagerTxHash).toBeUndefined()
  })
})
