import type { TableHtlcRecordItem } from '@frank/cashweb/types/messages'

import { MessageItemEncodeError } from '@frank/cashweb/message-items/registry'
import { describePluginContract } from '../shared/plugin-contract.testutil'
import { tableHtlcRecordCodec } from './codec'
import { initTableHtlcRecordPlugin } from './plugin'

const LOCK = '0x' + 'cd'.repeat(32)
const OTHER = '0x' + 'ce'.repeat(32)
const sample = (
  over: Partial<TableHtlcRecordItem> = {},
): TableHtlcRecordItem => ({
  type: 'table-htlc-record',
  chainIdentifier: 'monad-testnet',
  action: 'lock',
  game: 'poker',
  tableId: '0f'.repeat(16),
  lockIds: [LOCK],
  txHash: '0x' + 'ab'.repeat(32),
  timestamp: 1760000000000,
  ...over,
})

describePluginContract({
  type: 'table-htlc-record',
  init: initTableHtlcRecordPlugin,
  samples: [
    {
      item: sample(),
      preview: 'Table buy-in lock (poker) on monad-testnet',
    },
    {
      item: sample({ action: 'refund', game: 'liars-dice' }),
      preview: 'Table buy-in refund (liars-dice) on monad-testnet',
    },
    {
      item: sample({ action: 'distribute', lockIds: [LOCK, OTHER] }),
      preview: 'Table buy-in distribute (poker) on monad-testnet',
    },
  ],
})

describe('table-htlc-record rules beside its fields', () => {
  const broken: Array<[string, TableHtlcRecordItem]> = [
    ['a lock of two locks', sample({ lockIds: [LOCK, OTHER] })],
    ['a refund of two locks', sample({ action: 'refund', lockIds: [LOCK, OTHER] })],
    ['a lock named twice', sample({ action: 'distribute', lockIds: [LOCK, LOCK] })],
    ['no lock', sample({ lockIds: [] })],
    ['an uppercase table id', sample({ tableId: '0F'.repeat(16) })],
    ['a lock id without 0x', sample({ lockIds: ['cd'.repeat(32)] })],
    ['a game that is not an item type', sample({ game: 'Poker' })],
    ['a long game name', sample({ game: 'a'.repeat(65) })],
  ]
  it.each(broken)('refuses to write %s', (_name, item) => {
    expect(() => tableHtlcRecordCodec.encode(item)).toThrow(
      MessageItemEncodeError,
    )
  })
})
