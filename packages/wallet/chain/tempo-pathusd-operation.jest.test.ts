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

const FEE_ASSET = { chainIdentifier: 'tempo-testnet' as const, kind: 'tip20' as const, contract: PATHUSD, decimals: 6 as const }
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
  const receipts = new Map<string, TempoReceipt>()
  let finalized = false
  let finalizedNonce = 0n
  let quoteMaxFee = 2_000_000_000n
  let failBroadcast = false
  let wrongHash = false
  let sends = 0
  let signs = 0
  const events: string[] = []
  const rpc: TempoPathUsdRpc = {
    verifyChain: async chain => { events.push('verify:' + chain) },
    getPendingNonce: async () => 7n,
    getFinalizedNonce: async () => finalizedNonce,
    getPathUsdBalance: async () => 3_000_000n,
    quoteTransfer: async () => ({ gasLimit: 100_000n, maxFeePerGas: quoteMaxFee, maxPriorityFeePerGas: 1_000_000_000n }),
    sendRawTransaction: async raw => {
      sends++
      events.push('send')
      expect(raw.startsWith('0x76')).toBe(true)
      if (failBroadcast) throw new Error('RPC timeout after submission')
      if (wrongHash) return '0x' + '99'.repeat(32)
      return decodeSignedTempoTransaction(raw, 42431n).transactionHash
    },
    getReceipt: async hash => receipts.get(hash) ?? null,
    isFinalizedReceipt: async () => finalized,
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
  let sourceTail: Promise<unknown> = Promise.resolve()
  const transfers = new TempoPathUsdTransfers('tempo-testnet', journal, rpc, (_source, task) => {
    const run = sourceTail.then(task)
    sourceTail = run.catch(() => undefined)
    return run
  })
  const included = (row: TempoPathUsdOperation, status = 1, logs = [transferLog()]): TempoReceipt => ({
    transactionHash: row.transactionHash!, blockHash: BLOCK, blockNumber: 100, status,
    gasUsed: 80_000n, effectiveGasPrice: 1_000_000_000n,
    feeToken: PATHUSD, feePayer: SOURCE, logs,
  })
  return {
    store, journal, transfers, signer, events, included,
    setReceipt: (value: TempoReceipt | null) => {
      if (value) receipts.set(value.transactionHash, value)
      else receipts.clear()
    },
    setFinalized: (value: boolean) => { finalized = value },
    setFinalizedNonce: (value: bigint) => { finalizedNonce = value },
    raiseFee: () => { quoteMaxFee = 3_000_000_000n },
    failBroadcast: () => { failBroadcast = true },
    wrongHash: () => { wrongHash = true },
    sends: () => sends, signs: () => signs,
  }
}

describe('Tempo PathUSD transfer ownership', () => {
  test('quotes PathUSD fees before authorization and refuses fee or nonce drift before signing', async () => {
    const h = harness()
    const quote = await h.transfers.quote({ signer: h.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })
    expect(quote.feeAsset).toEqual(FEE_ASSET)
    expect(quote.maximumFeeAtomic).toBe(200n)
    expect(quote.nonce).toBe(7n)
    h.raiseFee()
    await expect(h.transfers.prepare({
      operationId: ID, signer: h.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n,
      authorizedFeeAsset: quote.feeAsset, authorizedFeeCeilingAtomic: quote.maximumFeeAtomic,
      quotedNonce: quote.nonce,
    })).rejects.toThrow('exceeds authorized')
    expect(h.journal.get(ID)).toBeUndefined()
    expect(h.signs()).toBe(0)
    expect(h.sends()).toBe(0)
    await expect(h.transfers.prepare({
      operationId: ID, signer: h.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n,
      authorizedFeeAsset: { ...quote.feeAsset, contract: RECIPIENT },
      authorizedFeeCeilingAtomic: 1_000n, quotedNonce: quote.nonce,
    })).rejects.toThrow('Invalid Tempo PathUSD fee authorization')
  })
  test('holds token amount plus PathUSD fee and signs type 0x76 for exact authorization', async () => {
    const h = harness()
    const row = await h.transfers.prepare({ authorizedFeeAsset: FEE_ASSET, authorizedFeeCeilingAtomic: 1000n, quotedNonce: 7n, operationId: ID, signer: h.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })
    expect(row.maximumFeeAtomic).toBe('200')
    expect(row.nonce).toBe('7')
    expect(row.chainIdentifier).toBe('tempo-testnet')
    expect(row.exposed).toBe(false)
    const sent = await h.transfers.submit(ID, h.signer)
    expect(sent.observation.state).toBe('pending')
    expect(sent.submission.state).toBe('accepted')
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
    await h.transfers.prepare({ authorizedFeeAsset: FEE_ASSET, authorizedFeeCeilingAtomic: 1000n, quotedNonce: 7n, operationId: ID, signer: h.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })
    const first = await h.transfers.submit(ID, h.signer)
    expect(first.observation.state).toBe('pending')
    expect(first.submission.state).toBe('ambiguous')
    expect(first.exposed).toBe(true)
    const reopened = harness(h.store)
    const second = await reopened.transfers.submit(ID, reopened.signer)
    expect(second.signedRaw).toBe(first.signedRaw)
    expect(second.transactionHash).toBe(first.transactionHash)
    expect(reopened.signs()).toBe(0)
    expect(reopened.sends()).toBe(1)
    expect(await reopened.transfers.prepare({ authorizedFeeAsset: FEE_ASSET, authorizedFeeCeilingAtomic: 1000n, quotedNonce: 7n, operationId: ID, signer: reopened.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })).toEqual(second)
    await expect(reopened.transfers.prepare({ authorizedFeeAsset: FEE_ASSET, authorizedFeeCeilingAtomic: 1000n, quotedNonce: 7n, operationId: ID, signer: reopened.signer, recipient: RECIPIENT, amountAtomic: 3_000_000n })).rejects.toThrow('different authorization')
  })

  test('durable LevelDB reopen preserves exposed raw transaction and source nonce claim', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'frank-tempo-journal-'))
    try {
      const firstStore = await LevelRecordStore.open<TempoPathUsdOperation>(directory, 'tempo-pathusd')
      const first = harness(firstStore)
      await first.transfers.prepare({ authorizedFeeAsset: FEE_ASSET, authorizedFeeCeilingAtomic: 1000n, quotedNonce: 7n, operationId: ID, signer: first.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })
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
      second.raiseFee()
      const replacement = await second.transfers.replaceFee(ID, second.signer, 300n)
      await second.journal.close()
      const thirdStore = await LevelRecordStore.open<TempoPathUsdOperation>(directory, 'tempo-pathusd')
      const third = harness(thirdStore)
      expect(third.journal.get(ID)).toEqual(replacement)
      expect(third.journal.get(ID)!.priorAttempts[0]!.signedRaw).toBe(pending.signedRaw)
      await third.journal.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('prepared or ambiguous spend holds PathUSD source balance across concurrent operations and restart', async () => {
    const h = harness()
    const first = h.transfers.prepare({ authorizedFeeAsset: FEE_ASSET, authorizedFeeCeilingAtomic: 1000n, quotedNonce: 7n, operationId: ID, signer: h.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })
    const second = h.transfers.prepare({ authorizedFeeAsset: FEE_ASSET, authorizedFeeCeilingAtomic: 1000n, quotedNonce: 7n, operationId: '0x' + '66'.repeat(32), signer: h.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })
    const results = await Promise.allSettled([first, second])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const reopened = harness(h.store)
    await expect(reopened.transfers.prepare({ authorizedFeeAsset: FEE_ASSET, authorizedFeeCeilingAtomic: 1000n, quotedNonce: 7n,
      operationId: '0x' + '77'.repeat(32), signer: reopened.signer,
      recipient: RECIPIENT, amountAtomic: 2_000_000n,
    })).rejects.toThrow('unresolved PathUSD operation')
  })

  test('unexposed plan can release source; exposed signed payment cannot', async () => {
    const h = harness()
    await h.transfers.prepare({ authorizedFeeAsset: FEE_ASSET, authorizedFeeCeilingAtomic: 1000n, quotedNonce: 7n, operationId: ID, signer: h.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })
    expect(h.journal.hasActiveSource('tempo-testnet', SOURCE)).toBe(true)
    await h.transfers.abandonUnexposed(ID)
    expect(h.journal.hasActiveSource('tempo-testnet', SOURCE)).toBe(false)
    await h.transfers.prepare({ authorizedFeeAsset: FEE_ASSET, authorizedFeeCeilingAtomic: 1000n, quotedNonce: 7n, operationId: ID, signer: h.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })
    await h.transfers.submit(ID, h.signer)
    await expect(h.transfers.abandonUnexposed(ID)).rejects.toThrow('cannot be abandoned')
    expect(h.journal.hasActiveSource('tempo-testnet', SOURCE)).toBe(true)
  })

  test('inconsistent RPC hash is visible while exact signed payment remains claimed', async () => {
    const h = harness()
    h.wrongHash()
    await h.transfers.prepare({ authorizedFeeAsset: FEE_ASSET, authorizedFeeCeilingAtomic: 1000n, quotedNonce: 7n, operationId: ID, signer: h.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })
    const row = await h.transfers.submit(ID, h.signer)
    expect(row.submission.state).toBe('inconsistent-rpc')
    expect(row.observation.state).toBe('pending')
    expect(row.signedRaw).toMatch(/^0x76/)
    await expect(h.transfers.prepare({ authorizedFeeAsset: FEE_ASSET, authorizedFeeCeilingAtomic: 1000n, quotedNonce: 7n,
      operationId: '0x' + '88'.repeat(32), signer: h.signer, recipient: RECIPIENT, amountAtomic: 1n,
    })).rejects.toThrow('unresolved PathUSD operation')
  })

  test('fee replacement keeps both signed candidates and reconciles the old one after restart', async () => {
    const h = harness()
    h.failBroadcast()
    await h.transfers.prepare({ authorizedFeeAsset: FEE_ASSET, authorizedFeeCeilingAtomic: 1000n, quotedNonce: 7n, operationId: ID, signer: h.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })
    const first = await h.transfers.submit(ID, h.signer)
    h.raiseFee()
    await expect(h.transfers.replaceFee(ID, h.signer, 100n)).rejects.toThrow('authorized fee ceiling')
    const replacement = await h.transfers.replaceFee(ID, h.signer, 300n)
    expect(replacement.priorAttempts).toHaveLength(1)
    expect(replacement.priorAttempts[0]!.signedRaw).toBe(first.signedRaw)
    expect(replacement.transactionHash).not.toBe(first.transactionHash)
    expect(decodeSignedTempoTransaction(replacement.signedRaw!, 42431n).transaction.nonce).toBe(7n)
    expect(decodeSignedTempoTransaction(first.signedRaw!, 42431n).transaction.nonce).toBe(7n)
    const reopened = harness(h.store)
    h.setReceipt(h.included(first))
    reopened.setReceipt(reopened.included(first))
    const included = await reopened.transfers.reconcile(ID)
    expect(included.observation.state).toBe('included-success')
    expect('transactionHash' in included.observation && included.observation.transactionHash).toBe(first.transactionHash)
    expect(reopened.signs()).toBe(0)
  })

  test('unfinalized inclusion retains source claim across reorg and restart', async () => {
    const h = harness()
    await h.transfers.prepare({ authorizedFeeAsset: FEE_ASSET, authorizedFeeCeilingAtomic: 1000n, quotedNonce: 7n, operationId: ID, signer: h.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })
    const row = await h.transfers.submit(ID, h.signer)
    h.setReceipt(h.included(row))
    await h.transfers.reconcile(ID)
    const reopened = harness(h.store)
    await expect(reopened.transfers.prepare({ authorizedFeeAsset: FEE_ASSET, authorizedFeeCeilingAtomic: 1000n, quotedNonce: 7n,
      operationId: '0x' + '99'.repeat(32), signer: reopened.signer, recipient: RECIPIENT, amountAtomic: 1n,
    })).rejects.toThrow('unresolved PathUSD operation')
    reopened.setReceipt(null)
    expect((await reopened.transfers.reconcile(ID)).observation.state).toBe('pending')
    expect(reopened.journal.hasActiveSource('tempo-testnet', SOURCE)).toBe(true)
    reopened.setReceipt(reopened.included(row))
    reopened.setFinalized(true)
    const final = await reopened.transfers.reconcile(ID)
    expect('finalized' in final.observation && final.observation.finalized).toBe(true)
    expect(reopened.journal.hasActiveSource('tempo-testnet', SOURCE)).toBe(false)
  })

  test('finalized consumed nonce without receipt reports unknown outcome, never retries payment', async () => {
    const h = harness()
    await h.transfers.prepare({ authorizedFeeAsset: FEE_ASSET, authorizedFeeCeilingAtomic: 1000n, quotedNonce: 7n, operationId: ID, signer: h.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })
    const pending = await h.transfers.submit(ID, h.signer)
    h.setFinalizedNonce(8n)
    const consumed = await h.transfers.reconcile(ID)
    expect(consumed.observation).toEqual({ state: 'nonce-consumed-unknown', finalizedNonce: '8' })
    expect(consumed.signedRaw).toBe(pending.signedRaw)
    const sendsBefore = h.sends()
    const signsBefore = h.signs()
    await h.transfers.submit(ID, h.signer)
    expect(h.sends()).toBe(sendsBefore)
    expect(h.signs()).toBe(signsBefore)
    expect(h.journal.hasActiveSource('tempo-testnet', SOURCE)).toBe(false)
    await expect(h.transfers.replaceFee(ID, h.signer, 500n)).rejects.toThrow('included candidate')
  })

  test('receipt confirms exact token transfer, and reorg to unknown retains nonce claim', async () => {
    const h = harness()
    await h.transfers.prepare({ authorizedFeeAsset: FEE_ASSET, authorizedFeeCeilingAtomic: 1000n, quotedNonce: 7n, operationId: ID, signer: h.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })
    const row = await h.transfers.submit(ID, h.signer)
    h.setReceipt(h.included(row))
    expect((await h.transfers.reconcile(ID)).observation).toEqual({ state: 'included-success', transactionHash: row.transactionHash, finalized: false, blockHash: BLOCK, blockNumber: 100, feeAtomic: '80' })
    h.setReceipt(null)
    expect((await h.transfers.reconcile(ID)).observation.state).toBe('pending')
    await expect(h.journal.prepare({ ...row, operationId: '0x' + '55'.repeat(32) })).rejects.toThrow('nonce is reserved')
  })

  test('revert and wrong transfer cannot be reported as payment', async () => {
    const h = harness()
    await h.transfers.prepare({ authorizedFeeAsset: FEE_ASSET, authorizedFeeCeilingAtomic: 1000n, quotedNonce: 7n, operationId: ID, signer: h.signer, recipient: RECIPIENT, amountAtomic: 2_000_000n })
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
