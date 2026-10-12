import { Interface, SigningKey, Wallet } from 'ethers'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LevelRecordStore, MemoryRecordStore } from '../storage/evm-coin-store'
import {
  PATHUSD,
  TempoPathUsdJournal,
  TempoPathUsdTransfers,
  tempoPathUsdReceivedTransfer,
  type TempoPathUsdOperation,
  type TempoPathUsdRpc,
  type TempoReceipt,
} from './tempo-pathusd-operation'
import { decodeSignedTempoTransaction } from './tempo-transaction'

const KEY = '0x' + '11'.repeat(32)
const SOURCE = new Wallet(KEY).address.toLowerCase()
const RECIPIENT = new Wallet('0x' + '22'.repeat(32)).address.toLowerCase()
const ID = '0x' + '33'.repeat(32)
const BLOCK = '0x' + '44'.repeat(32)
const abi = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)'])
const event = abi.getEvent('Transfer')!

function transferLog(amount = 2_000_000n, recipient = RECIPIENT) {
  const encoded = abi.encodeEventLog(event, [SOURCE, recipient, amount])
  return { address: PATHUSD, topics: encoded.topics, data: encoded.data }
}

function harness(store = new MemoryRecordStore<TempoPathUsdOperation>()) {
  let receipt: TempoReceipt | null = null
  let failBroadcast = false
  let sends = 0
  let signs = 0
  const events: string[] = []
  const rpc: TempoPathUsdRpc = {
    verifyChain: async chain => { events.push('verify:' + chain) },
    getPendingNonce: async () => 7n,
    getPathUsdBalance: async () => 3_000_000n,
    quoteTransfer: async () => ({ gasLimit: 100_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }),
    sendRawTransaction: async raw => {
      sends++
      events.push('send')
      expect(raw.startsWith('0x76')).toBe(true)
      if (failBroadcast) throw new Error('RPC timeout after submission')
      return decodeSignedTempoTransaction(raw, 42431n).transactionHash
    },
    getReceipt: async () => receipt,
  }
  const signer = {
    source: { kind: 'main' as const, address: SOURCE },
    signDigest: async (digest: string) => {
      signs++
      const signature = new SigningKey(KEY).sign(digest)
      return { r: signature.r, s: signature.s, yParity: signature.yParity as 0 | 1 }
    },
  }
  const journal = new TempoPathUsdJournal(store)
  const transfers = new TempoPathUsdTransfers('tempo-testnet', journal, rpc, async (_source, task) => task())
  const included = (row: TempoPathUsdOperation, status = 1, logs = [transferLog()]): TempoReceipt => ({
    transactionHash: row.transactionHash!, blockHash: BLOCK, blockNumber: 100, status,
    gasUsed: 80_000n, effectiveGasPrice: 1_000_000_000n,
    feeToken: PATHUSD, feePayer: SOURCE, logs,
  })
  return {
    store, journal, transfers, signer, events, included,
    setReceipt: (value: TempoReceipt | null) => { receipt = value },
    failBroadcast: () => { failBroadcast = true },
    sends: () => sends, signs: () => signs,
  }
}

describe('Tempo PathUSD transfer ownership', () => {
  test('holds token amount plus PathUSD fee and signs type 0x76 for exact authorization', async () => {
    const h = harness()
    const row = await h.transfers.prepare({ operationId: ID, signer: h.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })
    expect(row.maximumFeeAtomic).toBe('200')
    expect(row.nonce).toBe('7')
    expect(row.chainIdentifier).toBe('tempo-testnet')
    expect(row.exposed).toBe(false)
    const sent = await h.transfers.submit(ID, h.signer)
    expect(sent.observation.state).toBe('pending')
    expect(h.signs()).toBe(1)
    expect(h.sends()).toBe(1)
    const decoded = decodeSignedTempoTransaction(sent.signedRaw!, 42431n)
    expect(decoded.sender.toLowerCase()).toBe(SOURCE)
    expect(decoded.transaction.feeToken.toLowerCase()).toBe(PATHUSD)
    expect(decoded.transaction.calls).toHaveLength(1)
    expect(decoded.transaction.calls[0]!.to.toLowerCase()).toBe(PATHUSD)
  })

  test('ambiguous broadcast replays original signed bytes after reopen, without resigning', async () => {
    const h = harness()
    h.failBroadcast()
    await h.transfers.prepare({ operationId: ID, signer: h.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })
    const first = await h.transfers.submit(ID, h.signer)
    expect(first.observation.state).toBe('pending')
    expect(first.exposed).toBe(true)
    const reopened = harness(h.store)
    const second = await reopened.transfers.submit(ID, reopened.signer)
    expect(second.signedRaw).toBe(first.signedRaw)
    expect(second.transactionHash).toBe(first.transactionHash)
    expect(reopened.signs()).toBe(0)
    expect(reopened.sends()).toBe(1)
    expect(await reopened.transfers.prepare({ operationId: ID, signer: reopened.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })).toEqual(second)
    await expect(reopened.transfers.prepare({ operationId: ID, signer: reopened.signer, recipient: RECIPIENT, amountAtomic: 3_000_000n })).rejects.toThrow('different authorization')
  })

  test('durable LevelDB reopen preserves exposed raw transaction and source nonce claim', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'frank-tempo-journal-'))
    try {
      const firstStore = await LevelRecordStore.open<TempoPathUsdOperation>(directory, 'tempo-pathusd')
      const first = harness(firstStore)
      await first.transfers.prepare({ operationId: ID, signer: first.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })
      first.failBroadcast()
      const pending = await first.transfers.submit(ID, first.signer)
      await first.journal.close()
      const reopenedStore = await LevelRecordStore.open<TempoPathUsdOperation>(directory, 'tempo-pathusd')
      const second = harness(reopenedStore)
      expect(second.journal.get(ID)).toEqual(pending)
      await expect(second.journal.prepare({ ...pending, operationId: '0x' + '55'.repeat(32) })).rejects.toThrow('nonce is reserved')
      const replayed = await second.transfers.submit(ID, second.signer)
      expect(replayed.signedRaw).toBe(pending.signedRaw)
      expect(second.signs()).toBe(0)
      await second.journal.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('receipt confirms exact token transfer, and reorg to unknown retains nonce claim', async () => {
    const h = harness()
    await h.transfers.prepare({ operationId: ID, signer: h.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })
    const row = await h.transfers.submit(ID, h.signer)
    h.setReceipt(h.included(row))
    expect((await h.transfers.reconcile(ID)).observation).toEqual({ state: 'included-success', blockHash: BLOCK, blockNumber: 100, feeAtomic: '80' })
    h.setReceipt(null)
    expect((await h.transfers.reconcile(ID)).observation.state).toBe('pending')
    await expect(h.journal.prepare({ ...row, operationId: '0x' + '55'.repeat(32) })).rejects.toThrow('nonce is reserved')
  })

  test('revert and wrong transfer cannot be reported as payment', async () => {
    const h = harness()
    await h.transfers.prepare({ operationId: ID, signer: h.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })
    const row = await h.transfers.submit(ID, h.signer)
    h.setReceipt(h.included(row, 0))
    expect((await h.transfers.reconcile(ID)).observation.state).toBe('included-revert')
    h.setReceipt(h.included(row, 1, [transferLog(1_000_000n)]))
    expect((await h.transfers.reconcile(ID)).observation.state).toBe('included-mismatch')
    h.setReceipt({ ...h.included(row), feeToken: RECIPIENT })
    await expect(h.transfers.reconcile(ID)).rejects.toThrow('receipt identity')
    expect((h.journal.get(ID)!.observation.state)).toBe('included-mismatch')
  })

  test('incoming transfer accepts only PathUSD event addressed to us', () => {
    expect(tempoPathUsdReceivedTransfer(transferLog(), RECIPIENT)).toEqual({ sender: SOURCE, recipient: RECIPIENT, amountAtomic: 2_000_000n })
    expect(tempoPathUsdReceivedTransfer(transferLog(2_000_000n, SOURCE), RECIPIENT)).toBeNull()
    expect(tempoPathUsdReceivedTransfer({ ...transferLog(), address: SOURCE }, RECIPIENT)).toBeNull()
  })
})
