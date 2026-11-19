/**
 * Browser qualification of BrowserHtlcSwapRecordStore in real Chrome (htlc-swap-browser-test.mjs):
 * revision CAS, write contention across pages, and records surviving a browser restart.
 */
import { BrowserHtlcSwapRecordStore } from './htlc-swap-browser'
import {
  parseHtlcSwapRecord,
  serializeHtlcSwapRecord,
  type HtlcSwapRecord,
} from '../htlc-swap'

const NAMESPACE = 'htlc_browser_qualification'
const SWAP_ID = 'ab'.repeat(32)
const record: HtlcSwapRecord = {
  version: 1,
  swapId: SWAP_ID,
  conversationId: '11'.repeat(16),
  owner: {
    accountIncarnation: 'acc-1:1',
    localPublicKey: '02' + '11'.repeat(32),
  },
  role: 'B',
  termsHash: '22'.repeat(32),
  fundingAuthorizedAt: 1_800_000_000,
}
const withSpend = (txid: string): HtlcSwapRecord => ({
  ...record,
  xecSpends: [
    {
      funding: { txid: 'cd'.repeat(32), vout: 0 },
      branch: 'claim',
      rawTx: '0200' + txid,
      txid,
    },
  ],
})

export async function runHtlcSwapBrowserPhase(
  phase: string,
  arg?: string,
): Promise<unknown> {
  const store = new BrowserHtlcSwapRecordStore(NAMESPACE)
  try {
    if (phase === 'create') {
      const raw = serializeHtlcSwapRecord(record)
      const first = await store.compareAndSwap(SWAP_ID, 0, raw)
      const again = await store.compareAndSwap(SWAP_ID, 0, raw)
      const row = await store.getRecord(SWAP_ID)
      return { first, again, revision: row?.revision }
    }
    if (phase === 'race') {
      // Every page writes its own spend at revision 1; exactly one may win.
      const won = await store.compareAndSwap(
        SWAP_ID,
        1,
        serializeHtlcSwapRecord(withSpend(arg!)),
      )
      return { won }
    }
    if (phase === 'reopen') {
      const row = await store.getRecord(SWAP_ID)
      const parsed = row ? parseHtlcSwapRecord(row.raw) : undefined
      const listed = await store.listRecords()
      const other = new BrowserHtlcSwapRecordStore(`${NAMESPACE}_other`)
      const otherRows = await other.listRecords()
      await other.close()
      const stale = await store.compareAndSwap(
        SWAP_ID,
        1,
        serializeHtlcSwapRecord(record),
      )
      let invalid = ''
      try {
        new BrowserHtlcSwapRecordStore('bad namespace!')
      } catch (error) {
        invalid = (error as Error).message
      }
      return {
        revision: row?.revision,
        record: parsed,
        listed: listed.map(r => r.key),
        otherRows: otherRows.length,
        stale,
        invalid,
        databases: (await indexedDB.databases()).map(d => d.name).sort(),
      }
    }
    throw new Error(`Unknown phase ${phase}`)
  } finally {
    await store.close()
  }
}

;(globalThis as { runHtlcSwapBrowserPhase?: unknown }).runHtlcSwapBrowserPhase =
  runHtlcSwapBrowserPhase
