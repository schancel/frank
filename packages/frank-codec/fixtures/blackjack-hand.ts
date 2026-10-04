/** The peer-to-peer hand corpus (type 18, schema 2): `docs/protocol/cbor/vectors/blackjack-hand.json`
 * is exactly `blackjackHandCorpus()`. Accepted frames come from the public typed writer; rejected
 * frames are built with the generic frame encoder so that they can be malformed. */
import {
  defaultContext,
  encodeBlackjackHandItem,
  encodeFrame,
  FrankCodecError,
  parseFrame,
  toHex,
  type BlackjackHandItem,
  type Encodable,
} from '../src'

const GAME = 'hand-1'
const COMMITMENT = 'c0'.repeat(32)
const SEED = '0123456789abcdef'.repeat(4)
const REF = 'ab'.repeat(32)
const base = { type: 'blackjack-hand' as const, gameId: GAME }

export const BLACKJACK_HAND_ITEMS: readonly { id: string; item: BlackjackHandItem }[] = [
  {
    id: 'challenge-as-dealer',
    item: {
      ...base,
      action: 'challenge',
      role: 'dealer',
      maxBetWei: '1000000000000000000',
      commitment: COMMITMENT,
    },
  },
  {
    id: 'challenge-as-player',
    item: { ...base, action: 'challenge', role: 'player', maxBetWei: '1' },
  },
  {
    id: 'accept',
    item: {
      ...base,
      action: 'accept',
      maxBetWei: '9999999999999999999999999999999999999999',
      commitment: COMMITMENT,
    },
  },
  { id: 'bet', item: { ...base, action: 'bet' } },
  {
    id: 'deal',
    item: { ...base, action: 'deal', playerCards: [0, 51], dealerUpCard: 13 },
  },
  { id: 'hit', item: { ...base, action: 'hit' } },
  { id: 'stand', item: { ...base, action: 'stand' } },
  { id: 'double', item: { ...base, action: 'double' } },
  { id: 'card', item: { ...base, action: 'card', playerCards: [0, 51, 7] } },
  {
    id: 'reveal',
    item: {
      ...base,
      gameId: 'hand-🎴-é',
      action: 'reveal',
      dealerCards: [13, 26, 39],
      seed: SEED,
      outcome: 'player_blackjack',
    },
  },
  { id: 'refund', item: { ...base, action: 'refund', ref: REF } },
]

const bytes32 = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'))
const quantity = (n: bigint) => bytes32(n.toString(16).padStart(64, '0'))
type Fields = [number, Encodable][]
const raw = (fields: Fields, schemaVersion = 2, minReaderVersion = 2) =>
  encodeFrame(
    { typeId: 18, schemaVersion, minReaderVersion },
    new Map<number, Encodable>(fields),
  )
const g: [number, Encodable] = [0, GAME]

/** Malformed frames. The expectation is recorded from this reader and mirrored by Rust. */
const MALFORMED: readonly { id: string; frame: Uint8Array; context?: 'schema1' }[] = [
  { id: 'reject-hand-action-code-readable-by-reader1', frame: raw([g, [1, 18]], 2, 1) },
  { id: 'reject-hand-action-code-in-schema1', frame: raw([g, [1, 18]], 1, 1) },
  { id: 'reject-action-out-of-range', frame: raw([g, [1, 26]]) },
  { id: 'reject-missing-game', frame: raw([[1, 18]]) },
  { id: 'reject-empty-game', frame: raw([[0, ''], [1, 18]]) },
  { id: 'reject-bet-with-amount-field', frame: raw([g, [1, 18], [3, quantity(5n)]]) },
  {
    id: 'reject-challenge-player-with-commitment',
    frame: raw([g, [1, 16], [2, 1], [3, quantity(5n)], [4, bytes32(COMMITMENT)]]),
  },
  {
    id: 'reject-challenge-dealer-without-commitment',
    frame: raw([g, [1, 16], [2, 0], [3, quantity(5n)]]),
  },
  { id: 'reject-challenge-role', frame: raw([g, [1, 16], [2, 2], [3, quantity(5n)]]) },
  { id: 'reject-challenge-zero-max', frame: raw([g, [1, 16], [2, 1], [3, quantity(0n)]]) },
  {
    id: 'reject-challenge-max-above-limit',
    frame: raw([g, [1, 16], [2, 1], [3, quantity(10n ** 40n)]]),
  },
  {
    id: 'reject-challenge-short-quantity',
    frame: raw([g, [1, 16], [2, 1], [3, new Uint8Array(31)]]),
  },
  {
    id: 'reject-accept-zero-max',
    frame: raw([g, [1, 17], [3, quantity(0n)], [4, bytes32(COMMITMENT)]]),
  },
  { id: 'reject-accept-without-commitment', frame: raw([g, [1, 17], [3, quantity(5n)]]) },
  { id: 'reject-deal-one-card', frame: raw([g, [1, 19], [5, [0]], [6, 1]]) },
  { id: 'reject-deal-duplicate-cards', frame: raw([g, [1, 19], [5, [4, 4]], [6, 1]]) },
  { id: 'reject-deal-up-card-in-hand', frame: raw([g, [1, 19], [5, [4, 5]], [6, 4]]) },
  { id: 'reject-deal-card-52', frame: raw([g, [1, 19], [5, [4, 52]], [6, 1]]) },
  { id: 'reject-card-two-cards', frame: raw([g, [1, 23], [5, [1, 2]]]) },
  { id: 'reject-card-duplicate', frame: raw([g, [1, 23], [5, [1, 2, 1]]]) },
  {
    id: 'reject-reveal-uppercase-seed',
    frame: raw([g, [1, 24], [7, [1, 2]], [8, SEED.toUpperCase()], [9, 0]]),
  },
  {
    id: 'reject-reveal-outcome',
    frame: raw([g, [1, 24], [7, [1, 2]], [8, SEED], [9, 4]]),
  },
  {
    id: 'reject-reveal-duplicate-cards',
    frame: raw([g, [1, 24], [7, [2, 2]], [8, SEED], [9, 0]]),
  },
  { id: 'reject-refund-short-ref', frame: raw([g, [1, 25], [10, new Uint8Array(31)]]) },
  { id: 'reject-refund-without-ref', frame: raw([g, [1, 25]]) },
  { id: 'reject-hit-with-cards', frame: raw([g, [1, 20], [5, [1, 2, 3]]]) },
  {
    id: 'reader-without-schema2-rejects-a-hand-action-code',
    frame: encodeBlackjackHandItem({ ...base, action: 'bet' }),
    context: 'schema1',
  },
]

const SCHEMA1_READER = {
  readerVersion: 2,
  supportedSchemas: [{ typeId: 18, schemaVersion: 1 }],
  opaqueRetentionAllowed: false,
}

export function blackjackHandCorpus() {
  return {
    format: 'blackjack-hand-v2',
    allocation: {
      typeId: 18,
      schemaVersion: 2,
      minReaderVersion: 2,
      maximumFrameBytes: 4096,
      closedPayload: true,
    },
    note: 'All hashes, seeds and amounts are public fixtures. No frame carries or proves a payment.',
    contexts: { default: {}, schema1: SCHEMA1_READER },
    frames: [
      ...BLACKJACK_HAND_ITEMS.map(({ id, item }) => ({
        id,
        context: 'default',
        frameHex: toHex(encodeBlackjackHandItem(item)),
        expected: { result: 'accept' },
        application: item,
      })),
      ...MALFORMED.map(({ id, frame, context }) => {
        let expected = { result: 'accept' } as Record<string, string>
        try {
          parseFrame(frame, defaultContext(context ? SCHEMA1_READER : {}))
        } catch (e) {
          if (!(e instanceof FrankCodecError)) throw e
          expected = { result: 'reject', stage: e.stage, category: e.category }
        }
        return { id, context: context ?? 'default', frameHex: toHex(frame), expected }
      }),
    ],
  }
}
