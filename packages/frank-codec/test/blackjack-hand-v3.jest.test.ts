import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  defaultContext,
  encodeBlackjackHandItem,
  encodeBlackjackHandV3Item,
  FrankCodecError,
  fromHex,
  isBlackjackHandFrame,
  isBlackjackHandV3Frame,
  parseFrame,
  projectBlackjackHandItem,
  projectBlackjackHandV3Item,
  projectBlackjackItem,
  toHex,
  type BlackjackHandV3Item,
  type ParsedFrame,
} from '../src'
import {
  blackjackHandV3Corpus,
  BLACKJACK_HAND_V3_ITEMS,
} from '../fixtures/blackjack-hand-v3'

const PATH = join(__dirname, '../../../docs/protocol/cbor/vectors/blackjack-hand-v3.json')
// `WRITE_VECTORS=1` regenerates the shared corpus from the fixture.
if (process.env.WRITE_VECTORS)
  writeFileSync(PATH, JSON.stringify(blackjackHandV3Corpus(), null, 2) + '\n')
const corpus = JSON.parse(readFileSync(PATH, 'utf8')) as ReturnType<
  typeof blackjackHandV3Corpus
>

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

describe('blackjack hand items with entropy from both sides (type 18, schema 3)', () => {
  it('keeps the shared corpus equal to what the public writer and reader produce', () => {
    expect(corpus).toEqual(JSON.parse(JSON.stringify(blackjackHandV3Corpus())))
    expect(corpus.frames.filter(f => f.expected.result === 'accept')).toHaveLength(11)
    // Every malformed frame is in fact rejected.
    expect(
      corpus.frames.filter(f => !('application' in f) && f.expected.result !== 'reject'),
    ).toEqual([])
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
    expect(frame.schemaVersion).toBe(3)
    expect(frame.minReaderVersion).toBe(2)
    expect(isBlackjackHandV3Frame(frame)).toBe(true)
    const application = (f as { application: BlackjackHandV3Item }).application
    expect(projectBlackjackHandV3Item(frame)).toEqual({ frame: bytes, item: application })
    expect(toHex(encodeBlackjackHandV3Item(application))).toBe(f.frameHex)
    // Never handed to the schema-1 or schema-2 projection.
    expect(isBlackjackHandFrame(frame)).toBe(false)
    expect(() => projectBlackjackHandItem(frame)).toThrow('schema-2')
    expect(() => projectBlackjackItem(frame)).toThrow('schema-1')
  })

  it('does not project a schema-2 hand item as a schema-3 one', () => {
    const hit = parsed(
      encodeBlackjackHandItem({ type: 'blackjack-hand', gameId: '0'.repeat(32), action: 'hit' }),
    )
    expect(isBlackjackHandV3Frame(hit)).toBe(false)
    expect(() => projectBlackjackHandV3Item(hit)).toThrow('schema-3')
  })

  it('copies the frame it projects', () => {
    const frame = parsed(encodeBlackjackHandV3Item(BLACKJACK_HAND_V3_ITEMS[4].item))
    const first = projectBlackjackHandV3Item(frame)
    first.frame[0] ^= 1
    expect(projectBlackjackHandV3Item(frame).frame).toEqual(frame.frame)
  })

  const base = { type: 'blackjack-hand', gameId: '0'.repeat(32) }
  const h = 'a'.repeat(64)
  it.each([
    ['a card on a deal', { ...base, action: 'deal', seq: 3, prev: h, link: h, playerCards: [1, 2] }],
    ['an outcome on a reveal', { ...base, action: 'reveal', seq: 9, prev: h, link: h, outcome: 'push' }],
    ['an amount on a bet', { ...base, action: 'bet', seq: 2, prev: h, commitment: h, wagerWei: '5' }],
    ['a bet without a commitment', { ...base, action: 'bet', seq: 2, prev: h }],
    ['a move without a link', { ...base, action: 'hit', seq: 4, prev: h }],
    ['a move without prev', { ...base, action: 'hit', seq: 4, link: h }],
    ['a move without seq', { ...base, action: 'hit', prev: h, link: h }],
    ['a move at seq 0', { ...base, action: 'hit', seq: 0, prev: h, link: h }],
    ['a fractional seq', { ...base, action: 'hit', seq: 1.5, prev: h, link: h }],
    ['a text seq', { ...base, action: 'hit', seq: '4', prev: h, link: h }],
    ['an uppercase link', { ...base, action: 'hit', seq: 4, prev: h, link: 'A'.repeat(64) }],
    ['a prefixed prev', { ...base, action: 'hit', seq: 4, prev: '0x' + h, link: h }],
    ['a challenge with prev', { ...base, action: 'challenge', seq: 0, role: 'player', maxBetWei: '5', prev: h }],
    ['a challenge at seq 1', { ...base, action: 'challenge', seq: 1, role: 'player', maxBetWei: '5' }],
    ['a dealer challenge without a commitment', { ...base, action: 'challenge', seq: 0, role: 'dealer', maxBetWei: '5' }],
    ['a zero max bet', { ...base, action: 'challenge', seq: 0, role: 'player', maxBetWei: '0' }],
    ['an unknown action', { ...base, action: 'settle', seq: 4, prev: h, link: h }],
    ['a malformed game id', { ...base, gameId: 'g', action: 'hit', seq: 4, prev: h, link: h }],
  ])('the writer refuses %s', (_name, item) => {
    expect(() => encodeBlackjackHandV3Item(item as unknown as BlackjackHandV3Item)).toThrow(
      FrankCodecError,
    )
  })
})
