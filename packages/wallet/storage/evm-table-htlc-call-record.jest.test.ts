/**
 * The `table-htlc` contract-call record (a game table's buy-in lock, its refund, the arbiter's
 * distribute): its shape is checked when a row is written and kept across a reopen, and
 * `htlcTableCallOf` names the step and the locks a call's calldata is, which the consolidator
 * compares with the record before signing. The same path on a real node, through real wallets, is
 * `packages/bot/src/bots/table-htlc.anvil.jest.test.ts`.
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Transaction, Wallet } from 'ethers'
import {
  EvmNativeJournalError,
  EvmNativeOperationJournal,
  type EvmNativeSource,
  type EvmTableHtlcCallRecord,
} from './evm-native-operation-journal'
import {
  HTLC_NATIVE_TOKEN,
  encodeHtlcLock,
  encodeHtlcRefund,
  encodeHtlcWithdraw,
  htlcLockId,
  htlcTableCallOf,
} from '../swap-escrow'
import { encodeBatchDistributeCall } from '../game-escrow'

const main = new Wallet('0x' + '01'.padStart(64, '0'))
const binding = {
  chainIdentifier: 'monad-testnet',
  nativeChainId: '10143',
  publicTuple: 'table-htlc-call-record-test',
}
const mainSource: EvmNativeSource = {
  kind: 'main',
  address: main.address.toLowerCase(),
}
const HTLC = '0x' + 'ab'.repeat(20)
const TABLE_ID = '0f'.repeat(16)
const terms = {
  recipient: '0x' + '22'.repeat(20),
  refundAddress: main.address,
  token: HTLC_NATIVE_TOKEN,
  amount: 1_000n,
  hashLock: '0x' + '44'.repeat(32),
  expiresAt: 2_000_000_000n,
}
const LOCK_ID = htlcLockId(main.address, terms).toLowerCase()
const OTHER_ID = '0x' + '77'.repeat(32)
const distribute = encodeBatchDistributeCall({
  lockIds: [LOCK_ID, OTHER_ID],
  payouts: [{ recipient: '0x' + '33'.repeat(20), amount: 2_000n }],
  preimage: '0x' + '55'.repeat(32),
})
const record = (
  action: EvmTableHtlcCallRecord['action'],
  lockIds = action === 'distribute' ? [LOCK_ID, OTHER_ID] : [LOCK_ID],
): EvmTableHtlcCallRecord => ({
  kind: 'table-htlc',
  action,
  game: 'poker',
  tableId: TABLE_ID,
  lockIds,
})

describe('the table-htlc contract-call record', () => {
  it('htlcTableCallOf names the step and the locks of a lock, a refund and a distribute', () => {
    expect(htlcTableCallOf(main.address, encodeHtlcLock(HTLC, terms).data)).toEqual({
      action: 'lock',
      lockIds: [LOCK_ID],
    })
    expect(htlcTableCallOf(main.address, encodeHtlcRefund(HTLC, LOCK_ID).data)).toEqual({
      action: 'refund',
      lockIds: [LOCK_ID],
    })
    expect(htlcTableCallOf(main.address, distribute)).toEqual({
      action: 'distribute',
      lockIds: [LOCK_ID, OTHER_ID],
    })
    // Not a table step, or not canonical.
    expect(() =>
      htlcTableCallOf(
        main.address,
        encodeHtlcWithdraw(HTLC, LOCK_ID, '0x' + '55'.repeat(32)).data,
      ),
    ).toThrow('not a table step')
    expect(() => htlcTableCallOf(main.address, distribute + '00')).toThrow()
    expect(() => htlcTableCallOf(main.address, '0x3593564c')).toThrow()
  })

  let location: string
  let journal: EvmNativeOperationJournal
  const open = async () => {
    journal = new EvmNativeOperationJournal({ location, binding })
    await journal.Open()
  }
  beforeEach(async () => {
    location = await mkdtemp(join(tmpdir(), 'frank-table-htlc-record-'))
    await open()
  })
  afterEach(async () => {
    await journal.Close()
    await rm(location, { recursive: true, force: true })
  })
  const plan = (value: unknown, data = distribute) =>
    journal.prepare({
      kind: 'contract',
      recipient: HTLC,
      intendedValueWei: '0',
      record: value as EvmTableHtlcCallRecord,
      members: [
        {
          source: mainSource,
          unsignedTransaction: Transaction.from({
            type: 2,
            to: HTLC,
            chainId: 10143n,
            nonce: 0,
            value: 0n,
            data,
            gasLimit: 100_000n,
            maxFeePerGas: 2n,
            maxPriorityFeePerGas: 1n,
          }).unsignedSerialized,
          dependencies: [],
        },
      ],
    })

  it('is journaled with its row and kept across a reopen', async () => {
    const row = await plan(record('distribute'))
    expect(journal.get(row.operationId).record).toEqual(record('distribute'))
    await journal.Close()
    await open()
    expect(journal.get(row.operationId).record).toEqual(record('distribute'))
  })

  it.each([
    ['an unknown action', { ...record('lock'), action: 'withdraw' }],
    ['a game that is not an item type', { ...record('lock'), game: 'Poker' }],
    ['an empty game', { ...record('lock'), game: '' }],
    ['a 15-byte table id', { ...record('lock'), tableId: TABLE_ID.slice(2) }],
    ['an upper-case table id', { ...record('lock'), tableId: TABLE_ID.toUpperCase() }],
    ['no lock', { ...record('lock'), lockIds: [] }],
    ['two locks on a lock', { ...record('lock'), lockIds: [LOCK_ID, OTHER_ID] }],
    ['two locks on a refund', { ...record('refund'), lockIds: [LOCK_ID, OTHER_ID] }],
    ['the same lock twice', record('distribute', [LOCK_ID, LOCK_ID])],
    ['seventeen locks', record('distribute', Array.from({ length: 17 }, (_, i) => '0x' + i.toString(16).padStart(64, '0')))],
    ['a lock id without 0x', record('refund', [LOCK_ID.slice(2)])],
    ['an extra field', { ...record('lock'), swapId: '5a'.repeat(32) }],
    ['a missing field', { kind: 'table-htlc', action: 'lock', game: 'poker', lockIds: [LOCK_ID] }],
  ])('refuses a record with %s', async (_, value) => {
    await expect(plan(value)).rejects.toBeInstanceOf(EvmNativeJournalError)
    expect(journal.list()).toEqual([])
  })
})
