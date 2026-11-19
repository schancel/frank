/**
 * The buy-in escrow fields the table games (poker, liar's dice) share: the arbiter's terms in
 * its table items and the player's lock in its join (`@frank/wallet/table-escrow`). Lock ids and
 * hash locks are written exactly as the wallet computes them (`0x` and 64 lowercase hex
 * digits), so what is decoded is what the arbiter recomputes and compares.
 */
import type {
  TableBuyInLockItem,
  TableEscrowItemTerms,
} from '@frank/cashweb/types/messages'

import {
  MessageItemDecodeError,
  MessageItemEncodeError,
} from '@frank/cashweb/message-items/registry'
import {
  evmAddress,
  int,
  matching,
  req,
  struct,
  type ItemCodec,
} from '@frank/cashweb/message-items/cbor-fields'

const bytes32 = matching(
  /^0x[0-9a-f]{64}$/,
  '0x and 32 bytes of lowercase hexadecimal',
)

export const tableEscrowTerms = struct<TableEscrowItemTerms>({
  arbiter: req(0, evmAddress),
  hashLock: req(1, bytes32),
  // Seconds; GenericHTLC's deadline is a uint64, Frank's are within a day of now.
  expiresAt: req(2, int(1, Number.MAX_SAFE_INTEGER)),
})

export const tableBuyInLock = struct<TableBuyInLockItem>({
  lockId: req(0, bytes32),
  account: req(1, evmAddress),
})

/**
 * `codec`, with the rule both table games add: a buy-in lock is named only by a `join`. An item
 * breaking it is refused on write and on read (malformed, AGENTS.md §4), never seated.
 */
export function withBuyInLockRule<
  T extends { type: string; action: string; buyInLock?: unknown },
>(type: T['type'], codec: ItemCodec<T>): ItemCodec<T> {
  const rule = (item: T): string | undefined =>
    item.buyInLock !== undefined && item.action !== 'join'
      ? 'item.buyInLock: only a join names a buy-in lock'
      : undefined
  return {
    encode(item) {
      const broken = rule(item)
      if (broken) throw new MessageItemEncodeError(type, broken)
      return codec.encode(item)
    },
    decode(bytes, context) {
      const item = codec.decode(bytes, context)
      const broken = rule(item)
      if (broken) throw new MessageItemDecodeError(type, broken)
      return item
    },
  }
}
