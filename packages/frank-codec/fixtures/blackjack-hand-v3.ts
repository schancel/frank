/** The hand corpus with entropy from both sides (type 18, schema 3):
 * `docs/protocol/cbor/vectors/blackjack-hand-v3.json` is exactly `blackjackHandV3Corpus()`.
 * Accepted frames come from the public typed writer; rejected frames are built with the generic
 * frame encoder so that they can be malformed. */
import {
  defaultContext,
  encodeBlackjackHandV3Item,
  encodeFrame,
  FrankCodecError,
  parseFrame,
  toHex,
  type BlackjackHandV3Item,
  type Encodable,
} from '../src'
import { BLACKJACK_HAND_V3_ACTION, BLACKJACK_HAND_V3_ITEM, BLACKJACK_ROLE, TYPE_BLACKJACK_MESSAGE_ITEM } from '../src/constants'

const GAME = '00112233445566778899aabbccddeeff'
const COMMITMENT = 'c0'.repeat(32)
const LINK = '0123456789abcdef'.repeat(4)
const PREV = 'd1'.repeat(32)
const REF = 'ab'.repeat(32)
const base = { type: 'blackjack-hand' as const, gameId: GAME }
const linked = (action: 'deal' | 'hit' | 'stand' | 'double' | 'card' | 'reveal', seq: number) => ({
  id: action,
  item: { ...base, action, seq, prev: PREV, link: LINK } as BlackjackHandV3Item,
})

export const BLACKJACK_HAND_V3_ITEMS: readonly { id: string; item: BlackjackHandV3Item }[] = [
  {
    id: 'challenge-as-dealer',
    item: {
      ...base,
      action: 'challenge',
      seq: 0,
      role: 'dealer',
      maxBetWei: '1000000000000000000',
      commitment: COMMITMENT,
    },
  },
  {
    id: 'challenge-as-player',
    item: { ...base, action: 'challenge', seq: 0, role: 'player', maxBetWei: '1' },
  },
  {
    id: 'accept',
    item: {
      ...base,
      action: 'accept',
      seq: 1,
      prev: PREV,
      maxBetWei: '9999999999999999999999999999999999999999',
      commitment: COMMITMENT,
    },
  },
  { id: 'bet', item: { ...base, action: 'bet', seq: 2, prev: PREV, commitment: COMMITMENT } },
  linked('deal', 3),
  linked('hit', 4),
  linked('stand', 24),
  linked('double', 4),
  linked('card', 5),
  {
    ...linked('reveal', 255),
    item: {
      ...linked('reveal', 255).item,
      gameId: 'ffffffffffffffffffffffffffffffff',
    },
  },
  { id: 'refund', item: { ...base, action: 'refund', seq: 3, prev: PREV, ref: REF } },
]

const bytes32 = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'))
const quantity = (n: bigint) => bytes32(n.toString(16).padStart(64, '0'))
type Fields = [number, Encodable][]
const raw = (fields: Fields, schemaVersion = 3, minReaderVersion = 2) =>
  encodeFrame(
    { typeId: TYPE_BLACKJACK_MESSAGE_ITEM, schemaVersion, minReaderVersion },
    new Map<number, Encodable>(fields),
  )
const K = BLACKJACK_HAND_V3_ITEM
const A = BLACKJACK_HAND_V3_ACTION
const g: [number, Encodable] = [K.gameId, GAME]
const prev: [number, Encodable] = [K.prev, bytes32(PREV)]
const link: [number, Encodable] = [K.link, bytes32(LINK)]
const seq = (n: number): [number, Encodable] => [K.seq, n]

/** Malformed frames. The expectation is recorded from this reader and mirrored by Rust. */
const MALFORMED: readonly { id: string; frame: Uint8Array; context?: 'schema2' }[] = [
  { id: 'reject-v3-action-code-in-schema2', frame: raw([g, [K.action, A.hit], seq(4), prev, link], 2, 2) },
  { id: 'reject-v3-action-code-in-schema1', frame: raw([g, [K.action, A.hit], seq(4), prev, link], 1, 1) },
  // raw-cbor-key: action code 42 is deliberately out of range
  { id: 'reject-action-out-of-range', frame: raw([g, [K.action, 42], seq(4), prev, link]) },
  { id: 'reject-missing-game', frame: raw([[K.action, A.hit], seq(4), prev, link]) },
  { id: 'reject-game-uppercase', frame: raw([[K.gameId, GAME.toUpperCase()], [K.action, A.hit], seq(4), prev, link]) },
  { id: 'reject-game-short', frame: raw([[K.gameId, GAME.slice(1)], [K.action, A.hit], seq(4), prev, link]) },
  { id: 'reject-hit-without-seq', frame: raw([g, [K.action, A.hit], prev, link]) },
  { id: 'reject-hit-without-prev', frame: raw([g, [K.action, A.hit], seq(4), link]) },
  { id: 'reject-hit-without-link', frame: raw([g, [K.action, A.hit], seq(4), prev]) },
  { id: 'reject-hit-seq-zero', frame: raw([g, [K.action, A.hit], seq(0), prev, link]) },
  { id: 'reject-hit-seq-256', frame: raw([g, [K.action, A.hit], seq(256), prev, link]) },
  { id: 'reject-hit-short-link', frame: raw([g, [K.action, A.hit], seq(4), prev, [K.link, new Uint8Array(31)]]) },
  { id: 'reject-hit-long-prev', frame: raw([g, [K.action, A.hit], seq(4), [K.prev, new Uint8Array(33)], link]) },
  { id: 'reject-hit-text-link', frame: raw([g, [K.action, A.hit], seq(4), prev, [K.link, LINK]]) },
  // raw-cbor-key: key 5 (cards) is not declared in schema-3 hand items
  { id: 'reject-hit-with-cards', frame: raw([g, [K.action, A.hit], seq(4), prev, link, [5, [1, 2, 3]]]) },
  // raw-cbor-key: keys 5 and 6 (cards) are not declared in schema-3 hand items
  { id: 'reject-deal-with-cards', frame: raw([g, [K.action, A.deal], seq(3), prev, link, [5, [0, 1]], [6, 2]]) },
  {
    id: 'reject-reveal-with-outcome',
    // raw-cbor-key: key 9 (outcome) is not declared in schema-3 hand items
    frame: raw([g, [K.action, A.reveal], seq(9), prev, link, [9, 0]]),
  },
  {
    id: 'reject-reveal-with-seed',
    // raw-cbor-key: key 8 (seed) is not declared in schema-3 hand items
    frame: raw([g, [K.action, A.reveal], seq(9), prev, link, [8, LINK]]),
  },
  {
    id: 'reject-challenge-with-prev',
    frame: raw([g, [K.action, A.challenge], [K.role, BLACKJACK_ROLE.player], [K.maxBetWei, quantity(5n)], seq(0), prev]),
  },
  {
    id: 'reject-challenge-seq-one',
    frame: raw([g, [K.action, A.challenge], [K.role, BLACKJACK_ROLE.player], [K.maxBetWei, quantity(5n)], seq(1)]),
  },
  {
    id: 'reject-challenge-player-with-commitment',
    frame: raw([g, [K.action, A.challenge], [K.role, BLACKJACK_ROLE.player], [K.maxBetWei, quantity(5n)], [K.commitment, bytes32(COMMITMENT)], seq(0)]),
  },
  {
    id: 'reject-challenge-dealer-without-commitment',
    frame: raw([g, [K.action, A.challenge], [K.role, BLACKJACK_ROLE.dealer], [K.maxBetWei, quantity(5n)], seq(0)]),
  },
  // raw-cbor-key: role 2 is deliberately out of range
  { id: 'reject-challenge-role', frame: raw([g, [K.action, A.challenge], [K.role, 2], [K.maxBetWei, quantity(5n)], seq(0)]) },
  { id: 'reject-challenge-zero-max', frame: raw([g, [K.action, A.challenge], [K.role, BLACKJACK_ROLE.player], [K.maxBetWei, quantity(0n)], seq(0)]) },
  {
    id: 'reject-challenge-max-above-limit',
    frame: raw([g, [K.action, A.challenge], [K.role, BLACKJACK_ROLE.player], [K.maxBetWei, quantity(10n ** 40n)], seq(0)]),
  },
  {
    id: 'reject-accept-zero-max',
    frame: raw([g, [K.action, A.accept], [K.maxBetWei, quantity(0n)], [K.commitment, bytes32(COMMITMENT)], seq(1), prev]),
  },
  {
    id: 'reject-accept-without-commitment',
    frame: raw([g, [K.action, A.accept], [K.maxBetWei, quantity(5n)], seq(1), prev]),
  },
  { id: 'reject-bet-without-commitment', frame: raw([g, [K.action, A.bet], seq(2), prev]) },
  {
    id: 'reject-bet-with-amount-field',
    frame: raw([g, [K.action, A.bet], [K.maxBetWei, quantity(5n)], [K.commitment, bytes32(COMMITMENT)], seq(2), prev]),
  },
  { id: 'reject-refund-without-ref', frame: raw([g, [K.action, A.refund], seq(3), prev]) },
  { id: 'reject-refund-short-ref', frame: raw([g, [K.action, A.refund], [K.ref, new Uint8Array(31)], seq(3), prev]) },
  {
    id: 'reader-without-schema3-rejects-a-v3-action-code',
    frame: encodeBlackjackHandV3Item(BLACKJACK_HAND_V3_ITEMS[5].item),
    context: 'schema2',
  },
]

const SCHEMA2_READER = {
  readerVersion: 2,
  supportedSchemas: [{ typeId: TYPE_BLACKJACK_MESSAGE_ITEM, schemaVersion: 2 }],
  opaqueRetentionAllowed: false,
}

export function blackjackHandV3Corpus() {
  return {
    format: 'blackjack-hand-v3',
    allocation: {
      typeId: TYPE_BLACKJACK_MESSAGE_ITEM,
      schemaVersion: 3,
      minReaderVersion: 2,
      maximumFrameBytes: 4096,
      closedPayload: true,
    },
    note: 'All hashes and amounts are public fixtures. No frame carries or proves a payment, a card or an outcome.',
    contexts: { default: {}, schema2: SCHEMA2_READER },
    frames: [
      ...BLACKJACK_HAND_V3_ITEMS.map(({ id, item }) => ({
        id,
        context: 'default',
        frameHex: toHex(encodeBlackjackHandV3Item(item)),
        expected: { result: 'accept' },
        application: item,
      })),
      ...MALFORMED.map(({ id, frame, context }) => {
        let expected = { result: 'accept' } as Record<string, string>
        try {
          parseFrame(frame, defaultContext(context ? SCHEMA2_READER : {}))
        } catch (e) {
          if (!(e instanceof FrankCodecError)) throw e
          expected = { result: 'reject', stage: e.stage, category: e.category }
        }
        return { id, context: context ?? 'default', frameHex: toHex(frame), expected }
      }),
    ],
  }
}
