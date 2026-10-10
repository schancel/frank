import type { PokerItem, PokerPlayerView } from '@frank/cashweb/types/messages'

import {
  bool,
  cborItemCodec,
  list,
  num,
  oneOf,
  opt,
  req,
  struct,
  text,
} from '../shared/cbor-fields'

const player = struct<PokerPlayerView>({
  address: req(0, text),
  chips: req(1, num),
  currentStreetBet: req(2, num),
  totalHandBet: req(3, num),
  folded: req(4, bool),
  isAllIn: req(5, bool),
  isDealerButton: req(6, bool),
  isSmallBlind: req(7, bool),
  isBigBlind: req(8, bool),
  holeCards: opt(9, list(num)),
})

export const pokerCodec = cborItemCodec<PokerItem>('poker', {
  tableId: req(0, text),
  action: req(
    1,
    oneOf('create', 'join', 'deal', 'action', 'showdown', 'settle'),
  ),
  buyInWei: opt(2, text),
  smallBlind: req(3, num),
  bigBlind: req(4, num),
  street: opt(
    5,
    oneOf('preflop', 'flop', 'turn', 'river', 'showdown', 'settled'),
  ),
  pot: req(6, num),
  sidePots: opt(
    7,
    list(
      struct<NonNullable<PokerItem['sidePots']>[number]>({
        amount: req(0, num),
        eligiblePlayers: req(1, list(text)),
      }),
    ),
  ),
  currentBet: opt(8, num),
  minRaise: opt(9, num),
  activePlayer: opt(10, text),
  boardCards: opt(11, list(num)),
  players: opt(12, list(player)),
  myHoleCards: opt(13, list(num)),
  lastAction: opt(
    14,
    struct<NonNullable<PokerItem['lastAction']>>({
      player: req(0, text),
      action: req(1, oneOf('check', 'call', 'bet', 'raise', 'fold', 'all_in')),
      amount: opt(2, num),
    }),
  ),
  winners: opt(
    15,
    list(
      struct<NonNullable<PokerItem['winners']>[number]>({
        address: req(0, text),
        amount: req(1, num),
        handDescription: opt(2, text),
        best5Cards: opt(3, list(num)),
      }),
    ),
  ),
  winnerAddress: opt(16, text),
  txHash: opt(17, text),
  stealthAddress: opt(18, text),
})
