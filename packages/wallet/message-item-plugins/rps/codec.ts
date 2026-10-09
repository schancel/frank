import type { RpsItem } from '@frank/cashweb/types/messages'

import { cborItemCodec, oneOf, opt, req, text } from '../shared/cbor-fields'

const move = oneOf('rock', 'paper', 'scissors')

export const rpsCodec = cborItemCodec<RpsItem>('rps', {
  action: req(0, oneOf('challenge', 'start', 'move', 'resolve')),
  matchId: opt(1, text),
  commitHash: opt(2, text),
  playerMove: opt(3, move),
  botMove: opt(4, move),
  secretSalt: opt(5, text),
  wagerWei: opt(6, text),
  outcome: opt(7, oneOf('win', 'lose', 'tie')),
  txHash: opt(8, text),
  opponentAddress: opt(9, text),
})
