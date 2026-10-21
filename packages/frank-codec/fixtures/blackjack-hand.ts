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
import { BLACKJACK_HAND_ACTION, BLACKJACK_HAND_ITEM, BLACKJACK_OUTCOME, BLACKJACK_ROLE, TYPE_BLACKJACK_MESSAGE_ITEM } from '../src/constants'

/** A game id is exactly 32 lowercase hex characters. */
const GAME = '00112233445566778899aabbccddeeff'
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
    // raw-cbor-key: card list, not a map entry
    item: { ...base, action: 'deal', playerCards: [0, 51], dealerUpCard: 13 },
  },
  { id: 'hit', item: { ...base, action: 'hit' } },
  { id: 'stand', item: { ...base, action: 'stand' } },
  { id: 'double', item: { ...base, action: 'double' } },
  // raw-cbor-key: card list, not a map entry
  { id: 'card', item: { ...base, action: 'card', playerCards: [0, 51, 7] } },
  {
    id: 'reveal',
    item: {
      ...base,
      gameId: 'ffffffffffffffffffffffffffffffff',
      action: 'reveal',
      // raw-cbor-key: card list, not a map entry
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
    { typeId: TYPE_BLACKJACK_MESSAGE_ITEM, schemaVersion, minReaderVersion },
    new Map<number, Encodable>(fields),
  )
const K = BLACKJACK_HAND_ITEM
const A = BLACKJACK_HAND_ACTION
const g: [number, Encodable] = [K.gameId, GAME]

/** Malformed frames. The expectation is recorded from this reader and mirrored by Rust. */
const MALFORMED: readonly { id: string; frame: Uint8Array; context?: 'schema1' }[] = [
  { id: 'reject-hand-action-code-readable-by-reader1', frame: raw([g, [K.action, A.bet]], 2, 1) },
  { id: 'reject-hand-action-code-in-schema1', frame: raw([g, [K.action, A.bet]], 1, 1) },
  // raw-cbor-key: action code 26 is deliberately out of range
  { id: 'reject-action-out-of-range', frame: raw([g, [K.action, 26]]) },
  { id: 'reject-missing-game', frame: raw([[K.action, A.bet]]) },
  { id: 'reject-empty-game', frame: raw([[K.gameId, ''], [K.action, A.bet]]) },
  { id: 'reject-game-proto', frame: raw([[K.gameId, '__proto__'], [K.action, A.bet]]) },
  { id: 'reject-game-short', frame: raw([[K.gameId, GAME.slice(1)], [K.action, A.bet]]) },
  { id: 'reject-game-long', frame: raw([[K.gameId, GAME + '0'], [K.action, A.bet]]) },
  { id: 'reject-game-uppercase', frame: raw([[K.gameId, GAME.toUpperCase()], [K.action, A.bet]]) },
  { id: 'reject-game-not-hex', frame: raw([[K.gameId, 'g'.repeat(32)], [K.action, A.bet]]) },
  { id: 'reject-bet-with-amount-field', frame: raw([g, [K.action, A.bet], [K.maxBetWei, quantity(5n)]]) },
  {
    id: 'reject-challenge-player-with-commitment',
    frame: raw([g, [K.action, A.challenge], [K.role, BLACKJACK_ROLE.player], [K.maxBetWei, quantity(5n)], [K.commitment, bytes32(COMMITMENT)]]),
  },
  {
    id: 'reject-challenge-dealer-without-commitment',
    frame: raw([g, [K.action, A.challenge], [K.role, BLACKJACK_ROLE.dealer], [K.maxBetWei, quantity(5n)]]),
  },
  // raw-cbor-key: role 2 is deliberately out of range
  { id: 'reject-challenge-role', frame: raw([g, [K.action, A.challenge], [K.role, 2], [K.maxBetWei, quantity(5n)]]) },
  { id: 'reject-challenge-zero-max', frame: raw([g, [K.action, A.challenge], [K.role, BLACKJACK_ROLE.player], [K.maxBetWei, quantity(0n)]]) },
  {
    id: 'reject-challenge-max-above-limit',
    frame: raw([g, [K.action, A.challenge], [K.role, BLACKJACK_ROLE.player], [K.maxBetWei, quantity(10n ** 40n)]]),
  },
  {
    id: 'reject-challenge-short-quantity',
    frame: raw([g, [K.action, A.challenge], [K.role, BLACKJACK_ROLE.player], [K.maxBetWei, new Uint8Array(31)]]),
  },
  {
    id: 'reject-accept-zero-max',
    frame: raw([g, [K.action, A.accept], [K.maxBetWei, quantity(0n)], [K.commitment, bytes32(COMMITMENT)]]),
  },
  { id: 'reject-accept-without-commitment', frame: raw([g, [K.action, A.accept], [K.maxBetWei, quantity(5n)]]) },
  { id: 'reject-deal-one-card', frame: raw([g, [K.action, A.deal], [K.playerCards, [0]], [K.dealerUpCard, 1]]) },
  // raw-cbor-key: card list, not a map entry
  { id: 'reject-deal-duplicate-cards', frame: raw([g, [K.action, A.deal], [K.playerCards, [4, 4]], [K.dealerUpCard, 1]]) },
  // raw-cbor-key: card list, not a map entry
  { id: 'reject-deal-up-card-in-hand', frame: raw([g, [K.action, A.deal], [K.playerCards, [4, 5]], [K.dealerUpCard, 4]]) },
  // raw-cbor-key: card list, not a map entry
  { id: 'reject-deal-card-52', frame: raw([g, [K.action, A.deal], [K.playerCards, [4, 52]], [K.dealerUpCard, 1]]) },
  // raw-cbor-key: card list, not a map entry
  { id: 'reject-card-two-cards', frame: raw([g, [K.action, A.card], [K.playerCards, [1, 2]]]) },
  // raw-cbor-key: card list, not a map entry
  { id: 'reject-card-duplicate', frame: raw([g, [K.action, A.card], [K.playerCards, [1, 2, 1]]]) },
  {
    id: 'reject-reveal-uppercase-seed',
    // raw-cbor-key: card list, not a map entry
    frame: raw([g, [K.action, A.reveal], [K.dealerCards, [1, 2]], [K.seed, SEED.toUpperCase()], [K.outcome, BLACKJACK_OUTCOME.playerWin]]),
  },
  {
    id: 'reject-reveal-outcome',
    // raw-cbor-key: card list, not a map entry; outcome 4 is deliberately out of range
    frame: raw([g, [K.action, A.reveal], [K.dealerCards, [1, 2]], [K.seed, SEED], [K.outcome, 4]]),
  },
  {
    id: 'reject-reveal-duplicate-cards',
    // raw-cbor-key: card list, not a map entry
    frame: raw([g, [K.action, A.reveal], [K.dealerCards, [2, 2]], [K.seed, SEED], [K.outcome, BLACKJACK_OUTCOME.playerWin]]),
  },
  { id: 'reject-refund-short-ref', frame: raw([g, [K.action, A.refund], [K.ref, new Uint8Array(31)]]) },
  { id: 'reject-refund-without-ref', frame: raw([g, [K.action, A.refund]]) },
  // raw-cbor-key: card list, not a map entry
  { id: 'reject-hit-with-cards', frame: raw([g, [K.action, A.hit], [K.playerCards, [1, 2, 3]]]) },
  {
    id: 'reader-without-schema2-rejects-a-hand-action-code',
    frame: encodeBlackjackHandItem({ ...base, action: 'bet' }),
    context: 'schema1',
  },
]

const SCHEMA1_READER = {
  readerVersion: 2,
  supportedSchemas: [{ typeId: TYPE_BLACKJACK_MESSAGE_ITEM, schemaVersion: 1 }],
  opaqueRetentionAllowed: false,
}

export function blackjackHandCorpus() {
  return {
    format: 'blackjack-hand-v2',
    allocation: {
      typeId: TYPE_BLACKJACK_MESSAGE_ITEM,
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
