import type { PokerItem, PokerPlayerView } from '@frank/cashweb/types/messages'

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
  str,
  struct,
} from '@frank/cashweb/message-items/cbor-fields'
import {
  MAX_PLAYERS,
  card,
  cardOrHidden,
  chips,
  id,
  players,
  secret,
} from '../shared/limits'
import {
  tableBuyInLock,
  tableEscrowTerms,
  withBuyInLockRule,
} from '../shared/table-escrow-fields'

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

export const pokerCodec = withBuyInLockRule<PokerItem>(
  'poker',
  cborItemCodec<PokerItem>('poker', {
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
  // Key 17 was the settlement tx hash; removed with fake settlement, never reuse it.
  stealthAddress: opt(18, evmAddress),
  escrow: opt(19, tableEscrowTerms),
  buyInLock: opt(20, tableBuyInLock),
  // The dealer's commit-reveal fairness proof: what `foldPokerState` and `verifyPokerReveal` check.
  serverCommit: opt(21, hash32),
  serverSeed: opt(22, secret),
  playerCommits: opt(23, recordOf(evmAddress, hash32, MAX_PLAYERS)),
  playerSeeds: opt(24, recordOf(evmAddress, secret, MAX_PLAYERS)),
  holeCardCommits: opt(25, recordOf(evmAddress, hash32, MAX_PLAYERS)),
  holeCardSalts: opt(26, recordOf(evmAddress, secret, MAX_PLAYERS)),
  handNumber: opt(27, int(0, 1_000_000)),
  }),
)
