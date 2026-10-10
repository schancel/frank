import type { LiarsDiceItem } from '@frank/cashweb/types/messages'

import {
  amount,
  bool,
  cborItemCodec,
  evmAddress,
  hash32,
  int,
  listOf,
  oneOf,
  opt,
  recordOf,
  req,
  struct,
} from '../shared/cbor-fields'
import {
  MAX_DICE_PER_PLAYER,
  MAX_PLAYERS,
  MAX_TABLE_DICE,
  dieFace,
  id,
  players,
  secret,
} from '../shared/limits'

const cup = listOf(dieFace, MAX_DICE_PER_PLAYER)
const quantity = int(1, MAX_TABLE_DICE)
const count = int(0, MAX_TABLE_DICE)

export const liarsDiceCodec = cborItemCodec<LiarsDiceItem>('liars-dice', {
  tableId: req(0, id),
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
  buyInWei: opt(2, amount),
  maxPlayers: opt(3, int(1, MAX_PLAYERS)),
  dicePerPlayer: opt(4, int(1, MAX_DICE_PER_PLAYER)),
  players: opt(5, players(evmAddress)),
  diceCounts: opt(6, players(int(0, MAX_DICE_PER_PLAYER))),
  roundNumber: opt(7, int(0, 1_000_000)),
  activePlayer: opt(8, evmAddress),
  // At most one day; the bot uses 45 seconds.
  turnTimeoutSeconds: opt(9, int(0, 86_400)),
  currentBid: opt(
    10,
    struct<NonNullable<LiarsDiceItem['currentBid']>>({
      bidder: req(0, evmAddress),
      quantity: req(1, quantity),
      face: req(2, dieFace),
    }),
  ),
  challenger: opt(11, evmAddress),
  serverCommit: opt(12, hash32),
  serverSeed: opt(13, secret),
  playerCommits: opt(14, recordOf(evmAddress, hash32, MAX_PLAYERS)),
  playerSeeds: opt(15, recordOf(evmAddress, secret, MAX_PLAYERS)),
  myDice: opt(16, cup),
  revealedCups: opt(17, recordOf(evmAddress, cup, MAX_PLAYERS)),
  challengeResult: opt(
    18,
    struct<NonNullable<LiarsDiceItem['challengeResult']>>({
      bidQuantity: req(0, quantity),
      bidFace: req(1, dieFace),
      actualCount: req(2, count),
      wildAcesCount: req(3, count),
      challengerWon: req(4, bool),
      loserAddress: req(5, evmAddress),
      eliminated: req(6, bool),
    }),
  ),
  winnerAddress: opt(19, evmAddress),
  potWei: opt(20, amount),
  txHash: opt(21, hash32),
  stealthAddress: opt(22, evmAddress),
})
