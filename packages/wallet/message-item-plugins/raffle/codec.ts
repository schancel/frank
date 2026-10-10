import type { RaffleItem } from '@frank/cashweb/types/messages'

import {
  amount,
  cborItemCodec,
  evmAddress,
  hash32,
  int,
  listOf,
  oneOf,
  opt,
  req,
} from '../shared/cbor-fields'
import { MAX_RAFFLE_ENTRIES, id, note, secret } from '../shared/limits'

export const raffleCodec = cborItemCodec<RaffleItem>('raffle', {
  raffleId: req(0, id),
  action: req(1, oneOf('announce', 'enter', 'joined', 'draw', 'error')),
  entryPriceWei: opt(2, amount),
  maxEntries: opt(3, int(1, MAX_RAFFLE_ENTRIES)),
  entryCount: opt(4, int(0, MAX_RAFFLE_ENTRIES)),
  serverSeedHash: opt(5, hash32),
  winnerAddress: opt(6, evmAddress),
  serverSeed: opt(7, secret),
  entrants: opt(8, listOf(evmAddress, MAX_RAFFLE_ENTRIES)),
  // What each entrant's entry is identified by: a 32-byte digest or transaction hash.
  entryTxHashes: opt(9, listOf(hash32, MAX_RAFFLE_ENTRIES)),
  potWei: opt(10, amount),
  message: opt(11, note),
})
