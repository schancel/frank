import { readFileSync } from 'fs'
import { join } from 'path'
import {
  defaultContext,
  encodeBlackjackHandItem,
  encodeBlackjackItem,
  FrankCodecError,
  fromHex,
  isBlackjackHandFrame,
  parseFrame,
  projectBlackjackHandItem,
  projectBlackjackItem,
  toHex,
  type BlackjackHandItem,
  type ParsedFrame,
} from '../src'
import { blackjackHandCorpus, BLACKJACK_HAND_ITEMS } from '../fixtures/blackjack-hand'

const corpus = JSON.parse(
  readFileSync(
    join(__dirname, '../../../docs/protocol/cbor/vectors/blackjack-hand.json'),
    'utf8',
  ),
) as ReturnType<typeof blackjackHandCorpus>

function parsed(bytes: Uint8Array, context = defaultContext()): ParsedFrame {
  const result = parseFrame(bytes, context)
  if (result.kind !== 'parsed') throw Error('not parsed')
  return result
}
const outcome = (run: () => unknown) => {
  try {
    run()
    return 'accepted'
  } catch (e) {
    if (!(e instanceof FrankCodecError)) throw e
    return `${e.category}@${e.stage}`
  }
}

describe('peer-to-peer blackjack hand items (type 18, schema 2)', () => {
  it('keeps the shared corpus equal to what the public writer and reader produce', () => {
    expect(corpus).toEqual(JSON.parse(JSON.stringify(blackjackHandCorpus())))
    expect(corpus.frames.filter(f => f.expected.result === 'accept')).toHaveLength(11)
    expect(corpus.frames.every(f => f.expected.result !== 'accept' || 'application' in f)).toBe(
      true,
    )
  })

  it.each(corpus.frames)('$id', f => {
    const bytes = fromHex(f.frameHex)
    const context = defaultContext(
      (corpus.contexts as Record<string, object>)[f.context],
    )
    if (f.expected.result === 'reject') {
      expect(outcome(() => parseFrame(bytes, context))).toBe(
        `${f.expected.category}@${f.expected.stage}`,
      )
      return
    }
    const frame = parsed(bytes, context)
    expect(frame.schemaVersion).toBe(2)
    expect(frame.minReaderVersion).toBe(2)
    expect(isBlackjackHandFrame(frame)).toBe(true)
    const application = (f as { application: BlackjackHandItem }).application
    expect(projectBlackjackHandItem(frame)).toEqual({ frame: bytes, item: application })
    expect(toHex(encodeBlackjackHandItem(application))).toBe(f.frameHex)
    // A hand item is never handed to the schema-1 projection.
    expect(() => projectBlackjackItem(frame)).toThrow('schema-1')
  })

  it('reads a game id only when it is exactly 32 lowercase hex characters', () => {
    const rejected = corpus.frames.filter(f => f.id.startsWith('reject-game-'))
    expect(rejected).toHaveLength(5)
    for (const f of rejected)
      expect(f.expected).toEqual({ result: 'reject', stage: '8.2', category: 'schema' })
  })

  it('does not project a schema-1 item as a hand item', () => {
    const stand = parsed(
      encodeBlackjackItem({ type: 'blackjack-move', gameId: 'g', action: 'stand' }),
    )
    expect(isBlackjackHandFrame(stand)).toBe(false)
    expect(() => projectBlackjackHandItem(stand)).toThrow('schema-2')
  })

  it('copies the frame and the cards it projects', () => {
    const frame = parsed(encodeBlackjackHandItem(BLACKJACK_HAND_ITEMS[4].item))
    const first = projectBlackjackHandItem(frame)
    first.frame[0] ^= 1
    ;(first.item as { playerCards: number[] }).playerCards[0] = 9
    expect(projectBlackjackHandItem(frame).item).toEqual(BLACKJACK_HAND_ITEMS[4].item)
  })

  const base = { type: 'blackjack-hand', gameId: '0'.repeat(32) }
  it.each([
    ['no amount on a bet', { ...base, action: 'bet', wagerWei: '5' }],
    ['no amount on a double', { ...base, action: 'double', amountWei: '5' }],
    ['no payout on a reveal', {
      ...base,
      action: 'reveal',
      dealerCards: [1, 2],
      seed: 'a'.repeat(64),
      outcome: 'push',
      payoutWei: '5',
    }],
    ['unknown action', { ...base, action: 'welcome' }],
    ['unknown role', { ...base, action: 'challenge', role: 'house', maxBetWei: '5' }],
    ['player challenge with a commitment', {
      ...base,
      action: 'challenge',
      role: 'player',
      maxBetWei: '5',
      commitment: 'a'.repeat(64),
    }],
    ['dealer challenge without a commitment', {
      ...base,
      action: 'challenge',
      role: 'dealer',
      maxBetWei: '5',
    }],
    ['numeric max bet', { ...base, action: 'challenge', role: 'player', maxBetWei: 5 }],
    ['signed max bet', { ...base, action: 'challenge', role: 'player', maxBetWei: '-5' }],
    ['zero max bet', { ...base, action: 'challenge', role: 'player', maxBetWei: '0' }],
    ['prefixed commitment', {
      ...base,
      action: 'accept',
      maxBetWei: '5',
      commitment: '0x' + 'a'.repeat(64),
    }],
    ['uppercase ref', { ...base, action: 'refund', ref: 'A'.repeat(64) }],
    ['uppercase seed', {
      ...base,
      action: 'reveal',
      dealerCards: [1, 2],
      seed: 'A'.repeat(64),
      outcome: 'push',
    }],
    ['unknown outcome', {
      ...base,
      action: 'reveal',
      dealerCards: [1, 2],
      seed: 'a'.repeat(64),
      outcome: 'tie',
    }],
    ['game id __proto__', { type: 'blackjack-hand', gameId: '__proto__', action: 'bet' }],
    ['game id of another length', { type: 'blackjack-hand', gameId: 'ab', action: 'bet' }],
    ['uppercase game id', { type: 'blackjack-hand', gameId: 'A'.repeat(32), action: 'bet' }],
    ['schema-1 type name', { type: 'blackjack-move', gameId: '0'.repeat(32), action: 'bet' }],
    ['missing game', { type: 'blackjack-hand', action: 'bet' }],
    ['duplicate cards', { ...base, action: 'card', playerCards: [1, 1, 2] }],
    ['not an object', null],
  ])('the writer refuses: %s', (_name, input) => {
    expect(() => encodeBlackjackHandItem(input as unknown as BlackjackHandItem)).toThrow(
      FrankCodecError,
    )
  })
})
