import type { LiarsDiceItem } from '@frank/cashweb/types/messages'

import {
  bool,
  cborItemCodec,
  list,
  num,
  oneOf,
  opt,
  record,
  req,
  struct,
  text,
} from '../shared/cbor-fields'

export const liarsDiceCodec = cborItemCodec<LiarsDiceItem>('liars-dice', {
  tableId: req(0, text),
  action: req(
    1,
    oneOf(
      'create',
      'join',
      'round_start',
      'bid',
      'challenge',
      'showdown',
      'settle',
    ),
  ),
  buyInWei: opt(2, text),
  maxPlayers: opt(3, num),
  dicePerPlayer: opt(4, num),
  players: opt(5, list(text)),
  diceCounts: opt(6, list(num)),
  roundNumber: opt(7, num),
  activePlayer: opt(8, text),
  turnTimeoutSeconds: opt(9, num),
  currentBid: opt(
    10,
    struct<NonNullable<LiarsDiceItem['currentBid']>>({
      bidder: req(0, text),
      quantity: req(1, num),
      face: req(2, num),
    }),
  ),
  challenger: opt(11, text),
  serverCommit: opt(12, text),
  serverSeed: opt(13, text),
  playerCommits: opt(14, record(text)),
  playerSeeds: opt(15, record(text)),
  myDice: opt(16, list(num)),
  revealedCups: opt(17, record(list(num))),
  challengeResult: opt(
    18,
    struct<NonNullable<LiarsDiceItem['challengeResult']>>({
      bidQuantity: req(0, num),
      bidFace: req(1, num),
      actualCount: req(2, num),
      wildAcesCount: req(3, num),
      challengerWon: req(4, bool),
      loserAddress: req(5, text),
      eliminated: req(6, bool),
    }),
  ),
  winnerAddress: opt(19, text),
  potWei: opt(20, text),
  txHash: opt(21, text),
  stealthAddress: opt(22, text),
})
