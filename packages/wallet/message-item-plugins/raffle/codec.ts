import type { RaffleItem } from '@frank/cashweb/types/messages'

import {
  cborItemCodec,
  list,
  num,
  oneOf,
  opt,
  req,
  text,
} from '../shared/cbor-fields'

export const raffleCodec = cborItemCodec<RaffleItem>('raffle', {
  raffleId: req(0, text),
  action: req(1, oneOf('announce', 'enter', 'joined', 'draw', 'error')),
  entryPriceWei: opt(2, text),
  maxEntries: opt(3, num),
  entryCount: opt(4, num),
  serverSeedHash: opt(5, text),
  winnerAddress: opt(6, text),
  serverSeed: opt(7, text),
  entrants: opt(8, list(text)),
  entryTxHashes: opt(9, list(text)),
  potWei: opt(10, text),
  message: opt(11, text),
})
