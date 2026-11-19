import type { TableHtlcRecordItem } from '@frank/cashweb/types/messages'

import {
  MessageItemDecodeError,
  MessageItemEncodeError,
} from '@frank/cashweb/message-items/registry'
import {
  cborItemCodec,
  chainIdentifier,
  listOf,
  matching,
  oneOf,
  req,
  timestampMs,
  transactionId,
  type ItemCodec,
} from '@frank/cashweb/message-items/cbor-fields'

/** The most locks one table distributes (`MAX_TABLE_HTLC_LOCKS` of the wallet's journal). */
const MAX_TABLE_LOCKS = 16

const fields = cborItemCodec<TableHtlcRecordItem>('table-htlc-record', {
  chainIdentifier: req(0, chainIdentifier),
  action: req(1, oneOf('lock', 'refund', 'distribute')),
  game: req(
    2,
    matching(/^[a-z0-9]+(-[a-z0-9]+)*$/, "a table game's plugin item type"),
  ),
  tableId: req(
    3,
    matching(/^[0-9a-f]{32}$/, '16 bytes of lowercase hexadecimal'),
  ),
  lockIds: req(
    4,
    listOf(
      matching(/^0x[0-9a-f]{64}$/, '0x and 32 bytes of lowercase hexadecimal'),
      MAX_TABLE_LOCKS,
      1,
    ),
  ),
  txHash: req(5, transactionId),
  timestamp: req(6, timestampMs),
})

/** The record's own rules beside its fields, as the wallet's journal holds them
 * (`EvmTableHtlcCallRecord`): a lock or a refund acts on exactly one lock, no lock twice, and
 * the game name is at most 64 characters. */
function broken(item: TableHtlcRecordItem): string | undefined {
  if (item.game.length > 64) return 'item.game: at most 64 characters'
  if (item.action !== 'distribute' && item.lockIds.length !== 1)
    return `item.lockIds: a ${item.action} acts on one lock`
  if (new Set(item.lockIds).size !== item.lockIds.length)
    return 'item.lockIds: a lock appears twice'
  return undefined
}

/**
 * The record of one GenericHTLC call for a game table, in the account's note to itself. The same
 * spelling as the wallet's journal record (`EvmTableHtlcCallRecord`): a table id of 32 lowercase
 * hex digits and lock ids of `0x` and 64 lowercase hex digits, so what is decoded is exactly what
 * the sending device journaled.
 */
export const tableHtlcRecordCodec: ItemCodec<TableHtlcRecordItem> = {
  encode(item) {
    const encoded = fields.encode(item)
    const reason = broken(item)
    if (reason) throw new MessageItemEncodeError('table-htlc-record', reason)
    return encoded
  },
  decode(bytes, context) {
    const item = fields.decode(bytes, context)
    const reason = broken(item)
    if (reason) throw new MessageItemDecodeError('table-htlc-record', reason)
    return item
  },
}
