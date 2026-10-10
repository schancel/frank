import type { PokerItem, PokerPlayerView } from '@frank/cashweb/types/messages'

import {
  amount,
  bool,
  cborItemCodec,
  evmAddress,
  hash32,
  listOf,
  oneOf,
  opt,
  req,
  str,
  struct,
} from '../shared/cbor-fields'
import { card, cardOrHidden, chips, id, players } from '../shared/limits'

const player = struct<PokerPlayerView>({
  address: req(0, evmAddress),
  chips: req(1, chips),
  currentStreetBet: req(2, chips),
  totalHandBet: req(3, chips),
  folded: req(4, bool),
  isAllIn: req(5, bool),
  isDealerButton: req(6, bool),
  isSmallBlind: req(7, bool),
  isBigBlind: req(8, bool),
  // Two cards; the bot writes -1 for a card that is not dealt or not shown.
  holeCards: opt(9, listOf(cardOrHidden, 2)),
})

export const pokerCodec = cborItemCodec<PokerItem>('poker', {
  tableId: req(0, id),
  action: req(
    1,
    oneOf('create', 'join', 'deal', 'action', 'showdown', 'settle'),
  ),
  buyInWei: opt(2, amount),
  smallBlind: req(3, chips),
  bigBlind: req(4, chips),
  street: opt(
    5,
    oneOf('preflop', 'flop', 'turn', 'river', 'showdown', 'settled'),
  ),
  pot: req(6, chips),
  sidePots: opt(
    7,
    players(
      struct<NonNullable<PokerItem['sidePots']>[number]>({
        amount: req(0, chips),
        eligiblePlayers: req(1, players(evmAddress)),
      }),
    ),
  ),
  currentBet: opt(8, chips),
  minRaise: opt(9, chips),
  activePlayer: opt(10, evmAddress),
  boardCards: opt(11, listOf(card, 5)),
  players: opt(12, players(player)),
  myHoleCards: opt(13, listOf(cardOrHidden, 2)),
  lastAction: opt(
    14,
    struct<NonNullable<PokerItem['lastAction']>>({
      player: req(0, evmAddress),
      action: req(1, oneOf('check', 'call', 'bet', 'raise', 'fold', 'all_in')),
      amount: opt(2, chips),
    }),
  ),
  winners: opt(
    15,
    players(
      struct<NonNullable<PokerItem['winners']>[number]>({
        address: req(0, evmAddress),
        amount: req(1, chips),
        handDescription: opt(2, str(128)),
        best5Cards: opt(3, listOf(card, 5)),
      }),
    ),
  ),
  winnerAddress: opt(16, evmAddress),
  txHash: opt(17, hash32),
  stealthAddress: opt(18, evmAddress),
})
