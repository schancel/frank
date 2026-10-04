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

import {
  encodeFrame,
  defaultContext,
  validateFrame,
  type ParsedFrame,
} from '@frank/codec'
import type { CanonicalBlackjackMoveItem } from '@frank/cashweb/types/messages'
import {
  encodeCanonicalBlackjackItem,
  projectCanonicalBlackjackItem,
  hydrateCanonicalBlackjackItem,
} from './plugin'

const DOUBLE_HASH = `0x${'cd'.repeat(32)}`
const canonicalItems: CanonicalBlackjackMoveItem[] = [
  { type: 'blackjack-move', gameId: 'g', action: 'bet', wagerTxHash: HASH },
  {
    type: 'blackjack-move',
    gameId: 'g',
    action: 'deal',
    serverSeedHash: 'ab'.repeat(32),
    playerCards: [1, 2],
    dealerUpCard: 3,
  },
  { type: 'blackjack-move', gameId: 'g', action: 'hit' },
  {
    type: 'blackjack-move',
    gameId: 'g',
    action: 'hit',
    playerCards: [1, 2, 4],
  },
  { type: 'blackjack-move', gameId: 'g', action: 'stand' },
  {
    type: 'blackjack-move',
    gameId: 'g',
    action: 'double',
    doubleWagerTxHash: DOUBLE_HASH,
  },
  {
    type: 'blackjack-move',
    gameId: 'g',
    action: 'double',
    playerCards: [1, 2, 4],
  },
  {
    type: 'blackjack-move',
    gameId: 'g',
    action: 'reveal',
    dealerCards: [3, 5],
    serverSeed: 'ab'.repeat(32),
    outcome: 'push',
  },
  {
    type: 'blackjack-move',
    gameId: 'welcome',
    action: 'welcome',
    minWagerWei: '1',
    maxWagerWei: '1000000000000000000000000000000000000000',
    feeHintWei: '0',
    rules: '',
  },
]
function parsed(frame: Uint8Array): ParsedFrame {
  const result = validateFrame(frame, defaultContext())
  if (result.kind !== 'parsed') throw new Error('expected parsed item')
  return result
}
async function canonicalHydrate(item: CanonicalBlackjackMoveItem, p: unknown) {
  return hydrateCanonicalBlackjackItem(
    parsed(encodeCanonicalBlackjackItem(item)),
    ctx(p),
  )
}

describe('explicit canonical blackjack boundary', () => {
  test.each(canonicalItems.map((item, i) => [i, item] as const))(
    'type18 closed shape %i projects and hydrates through public codec',
    async (_, item) => {
      const p = provider()
      const result = await canonicalHydrate(item, p)
      expect(result.item).toEqual(item)
      expect(result.frame).toEqual(encodeCanonicalBlackjackItem(item))
      expect(result.hydrated.action).toBe(item.action)
      expect(result.hydrated.gameId).toBe(item.gameId)
      expect(result.hydrated.senderAddress).toBe('0xP')
      const isWager =
        item.action === 'bet' ||
        (item.action === 'double' && 'doubleWagerTxHash' in item)
      expect(p.getTransaction).toHaveBeenCalledTimes(isWager ? 1 : 0)
      expect(p.getTransactionReceipt).toHaveBeenCalledTimes(isWager ? 1 : 0)
      if (item.action === 'welcome') {
        expect(result.hydrated.welcome).toEqual({
          minWagerWei: 1n,
          maxWagerWei: BigInt(item.maxWagerWei),
          feeHintWei: 0n,
          rules: undefined,
        })
      }
      if (item.action === 'reveal')
        expect(result.hydrated.serverSeed).toBe(item.serverSeed)
    },
  )

  test('projection preserves exact frame and owns frame/cards independently', async () => {
    const original = encodeCanonicalBlackjackItem(canonicalItems[1])
    const child = parsed(original)
    const first = projectCanonicalBlackjackItem(child)
    const hydrated = await hydrateCanonicalBlackjackItem(child, ctx(provider()))
    expect(first.frame).toEqual(original)
    first.frame.fill(0)
    if (first.item.action !== 'deal') throw new Error('expected deal')
    ;(first.item.playerCards as number[])[0] = 50
    expect(projectCanonicalBlackjackItem(child).frame).toEqual(original)
    expect(hydrated.hydrated.playerCards).toEqual([1, 2])
    expect(hydrated.item).toEqual(canonicalItems[1])
    hydrated.hydrated.playerCards![0] = 40
    expect(hydrated.item).toEqual(canonicalItems[1])
  })

  test('compatible future projection retains exact original frame without reencoding', () => {
    const future = encodeFrame(
      { typeId: 18, schemaVersion: 2, minReaderVersion: 1 },
      new Map<number, unknown>([
        [0, 'g'],
        [1, 3],
      ]) as never,
    )
    const result = projectCanonicalBlackjackItem(parsed(future))
    expect(result.item).toEqual(canonicalItems[4])
    expect(result.frame).toEqual(future)
    expect(result.frame).not.toEqual(encodeCanonicalBlackjackItem(result.item))
  })

  test('opaque/unrelated parsed children are refused before wager lookup', async () => {
    const p = provider()
    const text = parsed(
      encodeFrame(
        { typeId: 17, schemaVersion: 1, minReaderVersion: 1 },
        new Map([[0, 'hi']]),
      ),
    )
    await expect(hydrateCanonicalBlackjackItem(text, ctx(p))).rejects.toThrow()
    const opaque = validateFrame(
      encodeFrame(
        { typeId: 60000, schemaVersion: 1, minReaderVersion: 1 },
        new Map(),
      ),
      { ...defaultContext(), opaqueRetentionAllowed: true },
    )
    await expect(
      hydrateCanonicalBlackjackItem(opaque as never, ctx(p)),
    ).rejects.toThrow()
    expect(p.getTransaction).not.toHaveBeenCalled()
    expect(p.getTransactionReceipt).not.toHaveBeenCalled()
  })

  test.each([
    null,
    { ...canonicalItems[0], action: 'surrender' },
    { ...canonicalItems[0], amount: '100' },
    { ...canonicalItems[0], wagerTxHash: null },
    { ...canonicalItems[0], wagerTxHash: undefined },
    { type: 'blackjack-move', gameId: 'g', action: 'bet' },
    { ...canonicalItems[2], playerCards: undefined },
    { ...canonicalItems[5], playerCards: [1, 2, 3] },
    { ...canonicalItems[4], dealerCards: [1, 2] },
    { ...canonicalItems[0], wagerTxHash: HASH + '\n' },
    { ...canonicalItems[1], serverSeedHash: 'AB'.repeat(32) },
    { ...canonicalItems[1], playerCards: [1, 1] },
    { ...canonicalItems[7], serverSeed: 'AB'.repeat(32) },
    { ...canonicalItems[8], minWagerWei: '0' },
    { ...canonicalItems[8], maxWagerWei: '1e2' },
  ])('malformed writer input %j never reaches provider', async (item) => {
    const p = provider()
    await expect(
      canonicalHydrate(item as CanonicalBlackjackMoveItem, p),
    ).rejects.toThrow()
    expect(p.getTransaction).not.toHaveBeenCalled()
    expect(p.getTransactionReceipt).not.toHaveBeenCalled()
  })

  test('validated nested welcome/text children preserve parent order and bytes', () => {
    const welcome = encodeCanonicalBlackjackItem(canonicalItems[8])
    const text = encodeFrame({ typeId: 17, schemaVersion: 1, minReaderVersion: 1 }, new Map([[0, 'hi']]))
    const container = parsed(encodeFrame({ typeId: 16, schemaVersion: 1, minReaderVersion: 1 }, new Map([[0, [welcome, text]]])))
    if (container.typed?.type !== 16) throw new Error('expected container')
    const [first, second] = container.typed.items
    if (first.kind !== 'parsed') throw new Error('expected parsed welcome')
    expect(projectCanonicalBlackjackItem(first).frame).toEqual(welcome)
    expect(second.frame).toEqual(text)
  })

  test('canonical hash/wei presentation normalizes without changing seed text or missing rules', async () => {
    const mixed = {
      ...canonicalItems[0],
      wagerTxHash: HASH.toUpperCase().replace('0X', '0x'),
    } as CanonicalBlackjackMoveItem
    expect((await canonicalHydrate(mixed, provider())).item).toEqual(
      canonicalItems[0],
    )
    const welcome: CanonicalBlackjackMoveItem = {
      type: 'blackjack-move',
      gameId: 'welcome',
      action: 'welcome',
      minWagerWei: '0001',
      maxWagerWei: '0002',
    }
    const result = await canonicalHydrate(welcome, provider())
    expect(result.item).toEqual({
      ...welcome,
      minWagerWei: '1',
      maxWagerWei: '2',
    })
    expect(Object.prototype.hasOwnProperty.call(result.item, 'rules')).toBe(
      false,
    )
  })

  test('canonical history uses the unchanged reducer for double request and response', async () => {
    const p = provider()
    let canonicalState: unknown, legacyState: unknown
    for (const item of [canonicalItems[0], canonicalItems[1], canonicalItems[5], canonicalItems[6], canonicalItems[7]]) {
      const result = await canonicalHydrate(item, p)
      canonicalState = plugin().reduceState!(canonicalState, result.hydrated, ctx(p))
      const legacyMove = await hydrate(p, item)
      legacyState = plugin().reduceState!(legacyState, legacyMove, ctx(p))
      expect(canonicalState).toEqual(legacyState)
    }
  })

  test.each([0, 5])(
    'wager/double shape %i preserves independent receipt verification failures',
    async (i) => {
      const p = provider()
      p.getTransaction.mockRejectedValueOnce(new Error('unavailable'))
      let result = await canonicalHydrate(canonicalItems[i], p)
      expect(result.hydrated.verifiedWager).toBeUndefined()
      expect(result.hydrated.verifiedDoubleWager).toBeUndefined()
      p.getTransaction.mockResolvedValueOnce(null as never)
      result = await canonicalHydrate(canonicalItems[i], p)
      expect(result.hydrated.verifiedWager).toBeUndefined()
      expect(result.hydrated.verifiedDoubleWager).toBeUndefined()
      p.getTransactionReceipt.mockResolvedValueOnce({ status: 0 } as never)
      result = await canonicalHydrate(canonicalItems[i], p)
      expect(result.hydrated.verifiedWager).toBeUndefined()
      expect(result.hydrated.verifiedDoubleWager).toBeUndefined()
      result = await canonicalHydrate(canonicalItems[i], p)
      const verified =
        i === 0
          ? result.hydrated.verifiedWager
          : result.hydrated.verifiedDoubleWager
      expect(verified).toEqual({
        fromAddress: '0xP',
        toAddress: '0xD',
        valueWei: 100n,
      })
      expect(
        i === 0
          ? result.hydrated.verifiedDoubleWager
          : result.hydrated.verifiedWager,
      ).toBeUndefined()
    },
  )
})
