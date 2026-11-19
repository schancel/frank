/** @jest-environment jsdom */
import { setActivePinia, createPinia } from 'pinia'
import type { TableHtlcRecordItem } from '@frank/cashweb/types/messages'
import type { ReceivedMessageWrapper } from '@frank/cashweb/types/user-interface'
import { ownTableHtlcRecords } from './chats-self-notes'
import { TABLE_LOCK_STORAGE_KEY, useTableLockStore } from './table-locks'

const LOCK = '0x' + 'cd'.repeat(32)
const item = (
  over: Partial<TableHtlcRecordItem> = {},
): TableHtlcRecordItem => ({
  type: 'table-htlc-record',
  chainIdentifier: 'monad-testnet',
  action: 'lock',
  game: 'poker',
  tableId: '0f'.repeat(16),
  lockIds: [LOCK],
  txHash: '0x' + 'ab'.repeat(32),
  timestamp: 2_000,
  ...over,
})

describe('the table buy-in lock store', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
  })

  it('folds a lock and its refund into one record per lock, idempotently, and keeps it across a reload', () => {
    const store = useTableLockStore()
    store.handleTableHtlcRecord(item())
    store.handleTableHtlcRecord(item({ timestamp: 3_000 }))
    store.handleTableHtlcRecord(
      item({
        action: 'refund',
        txHash: '0x' + 'ef'.repeat(32),
        timestamp: 9_000,
      }),
    )
    expect(store.locksAt('monad-testnet', 'poker', '0f'.repeat(16))).toEqual([
      {
        chainIdentifier: 'monad-testnet',
        game: 'poker',
        tableId: '0f'.repeat(16),
        lockId: LOCK,
        lockTxHash: '0x' + 'ab'.repeat(32),
        refundTxHash: '0x' + 'ef'.repeat(32),
        timestamp: 2_000,
      },
    ])
    expect(
      store.locksAt('monad-testnet', 'liars-dice', '0f'.repeat(16)),
    ).toEqual([])
    expect(store.locksAt('ethereum-sepolia', 'poker', '0f'.repeat(16))).toEqual(
      [],
    )
    expect(
      JSON.parse(window.localStorage.getItem(TABLE_LOCK_STORAGE_KEY)!),
    ).toHaveLength(1)
    setActivePinia(createPinia())
    expect(useTableLockStore().records).toHaveLength(1)
  })

  it("keeps no arbiter's distribute: it is not a player's lock", () => {
    const store = useTableLockStore()
    store.handleTableHtlcRecord(
      item({ action: 'distribute', lockIds: [LOCK, '0x' + 'ce'.repeat(32)] }),
    )
    expect(store.records).toEqual([])
  })

  it("takes records only from the account's own notes to itself", () => {
    const own = '0x' + 'aa'.repeat(20)
    const row = (sender: string, coparty: string) =>
      ({
        senderAddress: sender,
        copartyAddress: coparty,
        message: { items: [item(), { type: 'text', text: 'hi' }] },
      } as unknown as ReceivedMessageWrapper)
    expect(ownTableHtlcRecords(row(own, own), own)).toEqual([item()])
    expect(ownTableHtlcRecords(row('0x' + 'bb'.repeat(20), own), own)).toEqual(
      [],
    )
    expect(ownTableHtlcRecords(row(own, '0x' + 'bb'.repeat(20)), own)).toEqual(
      [],
    )
    expect(ownTableHtlcRecords(row(own, own), null)).toEqual([])
  })
})
