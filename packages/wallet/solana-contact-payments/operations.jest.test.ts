import { IDBFactory } from 'fake-indexeddb'
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { ed25519 } from '@noble/curves/ed25519'
import { IndexedDbSolanaPaymentPersistence, MemorySolanaPaymentPersistence } from '../storage/solana-payment-state'
import { SolanaPaymentState } from './state'
import { ExperimentalSolanaContactPayments, type ExperimentalSolanaPaymentRpc } from './engine'
import { associatedAccount } from './transaction-policy'
import { verifyExperimentalSolanaReceipt, type SolanaReceiptEvidence } from './receipt'
import type { SolanaPaymentAsset, SolanaPaymentIntent, SolanaSpendPosition } from './types'

const seeds = [1, 2, 3, 4].map(n => new Uint8Array(32).fill(n))
const owners = seeds.map(seed => new PublicKey(ed25519.getPublicKey(seed)).toBase58())
const chain = 'solana-devnet'
const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
const native: SolanaPaymentAsset = { kind: 'native' }
const spl: SolanaPaymentAsset = { kind: 'spl', mint: owners[3], program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', decimals: 6 }
function input(n = 1, asset: SolanaPaymentAsset = native): SolanaPaymentIntent {
  return { operationId: `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`, chainIdentifier: chain, recipientSpendPoint: owners[2], asset, amount: '20', maxFeeLamports: '5', maxNativeDebitLamports: asset.kind === 'native' ? '25' : '5', maxFeePerTransferLamports: '5', maxRentPerTransferLamports: '0', maxRentLamports: '0', allowDestinationAtaCreation: false }
}
function state(persistence = new MemorySolanaPaymentPersistence()) {
  let random = 0
  return new SolanaPaymentState('synthetic-wallet', chain, persistence, () => new Uint8Array(32).fill(++random))
}
function position(owner = owners[0], asset: SolanaPaymentAsset = native): SolanaSpendPosition {
  return { address: asset.kind === 'native' ? owner : associatedAccount(owner, asset.mint), owner, asset, balance: '100', observedSlot: 1, signingReference: { kind: 'primary' } }
}
function harness(ownerState: SolanaPaymentState, asset: SolanaPaymentAsset = native) {
  let final: Awaited<ReturnType<ExperimentalSolanaPaymentRpc['getFinalizedSignature']>> = null
  const submitted: Uint8Array[] = []
  const evidenceBySignature = new Map<string, SolanaReceiptEvidence>()
  const rpc: ExperimentalSolanaPaymentRpc = {
    getGenesisHash: jest.fn(async () => genesis),
    getLatestBlockhash: jest.fn(async () => ({ blockhash: owners[3], lastValidBlockHeight: 20 })),
    hasInitializedTokenAccount: jest.fn(async () => true),
    getFeeForMessage: jest.fn(async () => '5'),
    getTokenAccountRentLamports: jest.fn(async () => '10'),
    getFinalizedTransaction: jest.fn(async signature => evidenceBySignature.get(signature) ?? null),
    sendRawTransaction: jest.fn(async bytes => { submitted.push(bytes); const { getBase58Decoder } = await import('@solana/codecs-strings'); return getBase58Decoder().decode(VersionedTransaction.deserialize(bytes).signatures[0]) }),
    getFinalizedSignature: jest.fn(async () => final),
  }
  const custody = {
    deriveDestination: jest.fn(async (_operation, memberIndex: number) => ({ recipientPoint: owners[2], ephemeralPoint: owners[1], destinationOwner: owners[2 + memberIndex] })),
    validateReceived: jest.fn(async () => undefined),
    signTransfer: jest.fn(async ({ operation, memberIndex, source, blockhash }: Parameters<import('./engine').ExperimentalSolanaPaymentCustody['signTransfer']>[0]) => {
      // Ordinary synthetic Ed25519 signatures test state/policy, not stealth derivation.
      const member = operation.members[memberIndex]; const amount = BigInt(member.amount)
      let instruction: TransactionInstruction
      if (asset.kind === 'native') {
        const data = Buffer.alloc(12); data.writeUInt32LE(2); data.writeBigUInt64LE(amount, 4)
        instruction = new TransactionInstruction({ programId: new PublicKey('11111111111111111111111111111111'), keys: [{ pubkey: new PublicKey(source.owner), isSigner: true, isWritable: true }, { pubkey: new PublicKey(member.destination!.destinationOwner), isSigner: false, isWritable: true }], data })
      } else {
        const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(amount, 1); data[9] = asset.decimals
        instruction = new TransactionInstruction({ programId: new PublicKey(asset.program), keys: [{ pubkey: new PublicKey(source.address), isSigner: false, isWritable: true }, { pubkey: new PublicKey(asset.mint), isSigner: false, isWritable: false }, { pubkey: new PublicKey(associatedAccount(member.destination!.destinationOwner, asset.mint)), isSigner: false, isWritable: true }, { pubkey: new PublicKey(source.owner), isSigner: true, isWritable: false }], data })
      }
      const memo = new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.from(`frank:solana-custody-primary:experimental-v1:${'0'.repeat(64)}`) })
      const message = new TransactionMessage({ payerKey: new PublicKey(source.owner), recentBlockhash: blockhash, instructions: [instruction, memo] }).compileToV0Message()
      const tx = new VersionedTransaction(message)
      tx.signatures[0] = ed25519.sign(message.serialize(), seeds[owners.indexOf(source.owner)])
      const raw = tx.serialize(); const { getBase58Decoder } = await import('@solana/codecs-strings'); const signature = getBase58Decoder().decode(tx.signatures[0]);
      const keys = message.staticAccountKeys.map(key => key.toBase58()); const address = asset.kind === 'native' ? member.destination!.destinationOwner : associatedAccount(member.destination!.destinationOwner, asset.mint); const index = keys.indexOf(address); const before = keys.map(() => '0'), after = [...before]; before[0]=source.asset.kind==='native'?source.balance:'100';after[0]=(BigInt(before[0])-5n-(asset.kind==='native'?BigInt(member.amount):0n)).toString(); if (asset.kind === 'native') after[index] = member.amount;
      evidenceBySignature.set(signature, { signedTransaction: raw, slot: 10, err: null, preBalances: before, postBalances: after, preTokenBalances: asset.kind === 'spl' ? [{accountIndex:index,mint:asset.mint,program:asset.program,decimals:asset.decimals,owner:member.destination!.destinationOwner,amount:'0'}] : [], postTokenBalances: asset.kind === 'spl' ? [{accountIndex:index,mint:asset.mint,program:asset.program,decimals:asset.decimals,owner:member.destination!.destinationOwner,amount:member.amount}] : [] }); return raw
    }),
  }
  return { engine: new ExperimentalSolanaContactPayments(ownerState, custody, rpc), custody, rpc, submitted, evidenceBySignature, finalize: (outcome: 'confirmed' | 'failed') => { final = { outcome, slot: 10 } } }
}

test('read-only IndexedDB hydration neither creates a database nor writes defaults; distinct handles reserve atomically', async () => {
  const factory = new IDBFactory()
  const persistent = () => new IndexedDbSolanaPaymentPersistence('synthetic', factory)
  const a = new SolanaPaymentState('synthetic-wallet', chain, persistent(), (() => { let n = 0; return () => new Uint8Array(32).fill(++n) })())
  expect((await a.inspect()).operations).toEqual({})
  expect(await factory.databases()).toEqual([])
  await a.observe(position())
  const b = new SolanaPaymentState('synthetic-wallet', chain, persistent(), (() => { let n = 8; return () => new Uint8Array(32).fill(++n) })())
  await Promise.all([a.quote(input(1)), b.quote(input(2))])
  const results = await Promise.allSettled([a.reserve(input(1).operationId, p => [[p[0].address]]), b.reserve(input(2).operationId, p => [[p[0]?.address ?? owners[0]]])])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(Object.values((await b.inspect()).positions).filter(p => p.reservedBy)).toHaveLength(1)
})

test('unsigned context survives reopen, repeated operation IDs cannot change intent, failed transaction rolls back reservations', async () => {
  const factory = new IDBFactory(), store = () => new IndexedDbSolanaPaymentPersistence('restart', factory)
  let n = 0
  const a = new SolanaPaymentState('synthetic-wallet', chain, store(), () => new Uint8Array(32).fill(++n))
  const quote = await a.quote(input())
  const reopened = new SolanaPaymentState('synthetic-wallet', chain, store(), () => { throw new Error('Must reuse persisted randomness') })
  expect(await reopened.quote(input())).toEqual(quote)
  await expect(reopened.quote({ ...input(), amount: '21' })).rejects.toThrow('another intent')
  await a.observe(position())
  await expect(a.reserve(input().operationId, () => [[owners[0], owners[1]]])).rejects.toThrow('unavailable')
  expect((await reopened.inspect()).positions[owners[0]].reservedBy).toBeUndefined()
  await expect(new SolanaPaymentState('other-wallet', chain, store()).inspect()).rejects.toThrow('foreign')
})

test('signed original is durable before exposure; interruption/reopen resubmits exact bytes and keeps claims through timeout', async () => {
  const persistent = new MemorySolanaPaymentPersistence(), a = state(persistent), first = harness(a)
  await a.observe(position()); const quote = await first.engine.quote(input())
  const prepared = await first.engine.prepare(quote.intent.operationId)
  expect(prepared.phase).toBe('signed')
  await expect(first.engine.submit(input().operationId)).rejects.toThrow('envelope')
  await expect(a.releaseUnsigned(input().operationId)).rejects.toThrow('reconciliation')
  const reopen = harness(state(persistent)); for (const [key, value] of first.evidenceBySignature) reopen.evidenceBySignature.set(key, value)
  await reopen.engine.expose(input().operationId, { payloadDigest: 'a'.repeat(64) })
  await expect(reopen.engine.expose(input().operationId, { payloadDigest: 'b'.repeat(64) })).rejects.toThrow('another envelope')
  ;(reopen.rpc.sendRawTransaction as jest.Mock).mockRejectedValueOnce(new Error('ambiguous timeout'))
  await expect(reopen.engine.submit(input().operationId)).rejects.toThrow('timeout')
  expect(await reopen.engine.reconcile(input().operationId)).toBe('pending')
  expect((await a.inspect()).positions[owners[0]].reservedBy).toBe(input().operationId)
  await reopen.engine.submit(input().operationId)
  expect(Buffer.from(reopen.submitted[0]).toString('base64')).toBe(prepared.signed[0].transaction)
  expect(reopen.custody.signTransfer).not.toHaveBeenCalled()
  reopen.finalize('confirmed'); expect(await reopen.engine.reconcile(input().operationId)).toBe('settled')
  await expect(a.observe(position())).rejects.toThrow('retirement')
  await a.observe({ ...position(), observedSlot: 11, balance: '75' })
  await a.settle(input().operationId, prepared.signed[0].signature, 'confirmed', 10)
  expect((await a.inspect()).positions[owners[0]].balance).toBe('75')
})

test('pending operation does not block another account; actual fee and RPC identity fail closed', async () => {
  const a = state(), h = harness(a)
  await a.observe(position()); await a.observe(position(owners[1]))
  await Promise.all([h.engine.quote(input(1)), h.engine.quote(input(2))])
  const [one, two] = await Promise.all([h.engine.prepare(input(1).operationId), h.engine.prepare(input(2).operationId)])
  expect(one.sourceAddresses).not.toEqual(two.sourceAddresses)
  const isolated = state(), wrong = harness(isolated)
  await isolated.observe(position()); await wrong.engine.quote(input())
  ;(wrong.rpc.getGenesisHash as jest.Mock).mockResolvedValue('other')
  await expect(wrong.engine.prepare(input().operationId)).rejects.toThrow('identity')
  expect((await isolated.inspect()).operations[input().operationId].phase).toBe('quoted')
  ;(wrong.rpc.getGenesisHash as jest.Mock).mockResolvedValue(genesis)
  ;(wrong.rpc.getFeeForMessage as jest.Mock).mockResolvedValue('6')
  await expect(wrong.engine.prepare(input().operationId)).rejects.toThrow('fee')
  expect((await isolated.inspect()).operations[input().operationId].signed).toEqual([])
})

test('SPL existing ATA and native gas prerequisites are explicit, with no sender gas subsidy', async () => {
  const a = state(), h = harness(a, spl)
  await a.observe(position(owners[0], spl)); await expect(h.engine.quote(input(1, spl))).rejects.toMatchObject({requirement:'needs-native-gas'}); await a.observe(position()); await h.engine.quote(input(1,spl))
  ;(h.rpc.hasInitializedTokenAccount as jest.Mock).mockResolvedValue(false)
  await expect(h.engine.prepare(input(1, spl).operationId)).rejects.toMatchObject({ requirement: 'needs-account-and-rent-policy' })
  ;(h.rpc.hasInitializedTokenAccount as jest.Mock).mockResolvedValue(true)
  const prepared = await h.engine.prepare(input(1, spl).operationId)
  expect(prepared.sourceAddresses).toEqual([associatedAccount(owners[0], spl.kind === 'spl' ? spl.mint : ''), owners[0]])
  const tx = VersionedTransaction.deserialize(Buffer.from(prepared.signed[0].transaction, 'base64'))
  expect(tx.message.compiledInstructions).toHaveLength(2)
  expect(h.custody.signTransfer.mock.calls[0][0]).toMatchObject({ createDestinationAta: false, rentLamports: '0' })
})

test('receipt requires successful finalized exact bytes and actual native balance delta; verification stays read only', async () => {
  const a = state(), h = harness(a); await a.observe(position()); await h.engine.quote(input())
  const operation = await h.engine.prepare(input().operationId), original = operation.signed[0]
  const raw = Uint8Array.from(Buffer.from(original.transaction, 'base64'))
  const tx = VersionedTransaction.deserialize(raw), index = tx.message.staticAccountKeys.findIndex(key => key.toBase58() === owners[2])
  const pre = tx.message.staticAccountKeys.map(() => '0'), post = [...pre]; post[index] = '20'
  const evidence: SolanaReceiptEvidence = { signedTransaction: raw, slot: 10, err: null, preBalances: pre, postBalances: post, preTokenBalances: [], postTokenBalances: [] }
  const rpc = { getGenesisHash: async () => genesis, getFinalizedTransaction: async () => evidence }
  const claim = { chainIdentifier: chain, asset: native, amount: '20', destination: original.destination, context: operation.contexts[0], signedTransaction: raw, signature: original.signature }
  const before = await a.inspect()
  expect((await verifyExperimentalSolanaReceipt(claim, rpc)).position.balance).toBe('20')
  expect(await a.inspect()).toEqual(before)
  evidence.postBalances = pre
  await expect(verifyExperimentalSolanaReceipt(claim, rpc)).rejects.toThrow('delta')
  evidence.err = { InstructionError: [0, 'failed'] }
  await expect(verifyExperimentalSolanaReceipt(claim, rpc)).rejects.toThrow('successful finalized')
})

test('unsigned interruption releases only its own claims and preserves derivation contexts', async () => {
  const a = state(); await a.observe(position()); const before = await a.quote(input())
  await a.reserve(input().operationId, p => [[p[0].address]])
  await a.releaseUnsigned(input().operationId)
  const after = await a.quote(input())
  expect(after.contexts).toEqual(before.contexts)
  expect(after.sourceAddresses).toEqual([])
  expect((await a.inspect()).positions[owners[0]].reservedBy).toBeUndefined()
})

test('corrupt persisted signed bytes fail restoration observably without resetting authority', async () => {
  const persistence = new MemorySolanaPaymentPersistence(), a = state(persistence), h = harness(a)
  await a.observe(position()); await h.engine.quote(input()); const prepared = await h.engine.prepare(input().operationId)
  await expect(a.persistSigned(input().operationId, [{ ...prepared.signed[0], blockhash: owners[1] }])).rejects.toThrow('immutable')
  const original = await a.inspect(), corrupt = structuredClone(original)
  corrupt.operations[input().operationId].signed[0].signature = 'forged'
  const read = jest.spyOn(persistence, 'read').mockResolvedValue(corrupt)
  await expect(a.inspect()).rejects.toThrow('Corrupt persisted')
  read.mockRestore()
  expect(await a.inspect()).toEqual(original)
})

test('whole-set reservation excludes competitors while unrelated accounts prepare during a signing wait', async () => {
  const a = state(), h = harness(a)
  await a.observe({ ...position(), balance: '80' }); await a.observe({ ...position(owners[1]), balance: '80' }); await a.observe(position(owners[3]))
  const many = { ...input(1), amount: '150', maxFeeLamports: '10', maxNativeDebitLamports: '160' }
  expect((await h.engine.quote(many)).members.map(member => member.amount)).toEqual(['75', '75'])
  let unblock!: () => void, entered!: () => void
  const waiting = new Promise<void>(resolve => { unblock = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const original = h.custody.signTransfer.getMockImplementation()!
  h.custody.signTransfer.mockImplementationOnce(async request => { entered(); await waiting; return original(request) })
  const preparing = h.engine.prepare(many.operationId)
  await started
  const other = input(2); await h.engine.quote(other)
  const independent = await h.engine.prepare(other.operationId)
  expect(independent.sourceAddresses).toEqual([owners[3]])
  expect(Object.values((await a.inspect()).positions).filter(p => p.reservedBy === many.operationId)).toHaveLength(2)
  unblock(); const prepared = await preparing
  expect(prepared.signed).toHaveLength(2)
  expect(prepared.signed.reduce((sum, member) => sum + BigInt(member.amount), 0n)).toBe(150n)
})

test('member limits and total fee ceilings reject complete quotes rather than silently paying a partial amount', async () => {
  const a = state(), h = harness(a)
  await a.observe({ ...position(), balance: '80' }); await a.observe({ ...position(owners[1]), balance: '80' })
  const many = { ...input(1), amount: '150', maxFeeLamports: '10', maxNativeDebitLamports: '160' }
  const bounded = new ExperimentalSolanaContactPayments(a, h.custody, h.rpc, 1)
  await expect(bounded.quote(many)).rejects.toMatchObject({ requirement: 'member-limit' })
  await expect(h.engine.quote({ ...many, maxFeeLamports: '5' })).rejects.toMatchObject({ requirement: 'fee-rent-budget' })
  expect((await a.inspect()).operations).toEqual({})
})

test('partial finalized success and failure retire only their sources and never report the intended total as received', async () => {
  const persistent = new MemorySolanaPaymentPersistence(), a = state(persistent), h = harness(a)
  await a.observe({ ...position(), balance: '80' }); await a.observe({ ...position(owners[1]), balance: '80' })
  const many = { ...input(1), amount: '150', maxFeeLamports: '10', maxNativeDebitLamports: '160' }
  await h.engine.quote(many); const prepared = await h.engine.prepare(many.operationId)
  const first = prepared.signed[0], second = prepared.signed[1]
  ;(h.rpc.getFinalizedSignature as jest.Mock).mockImplementation(async (signature: string) => signature === first.signature ? { outcome: 'confirmed', slot: 10 } : null)
  expect(await h.engine.reconcile(many.operationId)).toBe('pending')
  expect(await h.engine.progress(many.operationId)).toMatchObject({ status: 'partial', verifiedReceivedAmount: '75', intendedAmount: '150' })
  const snapshot = await a.inspect()
  expect(snapshot.positions[second.sourceAddresses[0]].reservedBy).toBe(many.operationId)
  const reopened = harness(state(persistent))
  for (const [key, value] of h.evidenceBySignature) reopened.evidenceBySignature.set(key, value)
  const failed = reopened.evidenceBySignature.get(second.signature)!
  failed.err = { InstructionError: [0, 'failed'] }
  failed.postBalances = failed.preBalances.map((amount, index) => index === 0 ? (BigInt(amount) - 5n).toString() : amount)
  ;(reopened.rpc.getFinalizedSignature as jest.Mock).mockResolvedValue({ outcome: 'failed', slot: 10 })
  expect(await reopened.engine.reconcile(many.operationId)).toBe('settled')
  expect(await reopened.engine.progress(many.operationId)).toMatchObject({ status: 'partial', verifiedReceivedAmount: '75' })
  expect((await a.inspect()).positions[second.sourceAddresses[0]]).toMatchObject({ balance: '75', observedSlot: 10, postSpendSignature: second.signature })
  expect((await a.inspect()).positions[second.sourceAddresses[0]].reservedBy).toBeUndefined()
  await expect(a.observe({ ...position(second.sourceOwner), observedSlot: 1 })).rejects.toThrow('retirement')
})

test('failure to sign a later member persists no partial original set and exposes nothing', async () => {
  const a = state(), h = harness(a)
  await a.observe({ ...position(), balance: '80' }); await a.observe({ ...position(owners[1]), balance: '80' })
  const many = { ...input(1), amount: '150', maxFeeLamports: '10', maxNativeDebitLamports: '160' }
  await h.engine.quote(many)
  const original = h.custody.signTransfer.getMockImplementation()!
  h.custody.signTransfer.mockImplementationOnce(original).mockRejectedValueOnce(new Error('custody revoked'))
  await expect(h.engine.prepare(many.operationId)).rejects.toThrow('revoked')
  expect((await a.inspect()).operations[many.operationId].signed).toEqual([])
  await expect(h.engine.expose(many.operationId, { payloadDigest: 'f'.repeat(64) })).rejects.toThrow('Signed original')
  await a.releaseUnsigned(many.operationId)
  expect(Object.values((await a.inspect()).positions).every(position => !position.reservedBy)).toBe(true)
})

test('classic SPL receipt checks actual mint, owner, program and decimals before credit', async () => {
  const a = state(), h = harness(a, spl)
  await a.observe(position()); await a.observe(position(owners[0], spl)); await h.engine.quote(input(1, spl))
  const operation = await h.engine.prepare(input(1, spl).operationId), original = operation.signed[0]
  const claim = { chainIdentifier: chain, asset: spl, amount: original.amount, destination: original.destination, context: operation.contexts[0], signedTransaction: Uint8Array.from(Buffer.from(original.transaction, 'base64')), signature: original.signature }
  expect((await verifyExperimentalSolanaReceipt(claim, h.rpc)).nativeGas).toBe('must-observe-owned-native-balance')
  const evidence = h.evidenceBySignature.get(original.signature)!, originalRow = { ...evidence.postTokenBalances[0] }
  for (const mutation of [{ mint: owners[0] }, { owner: owners[0] }, { program: 'TokenzQdBNbLqP5VEhdkAS6EPFzsd5MDdVyJZWX8FhJ' }, { decimals: 9 }, { amount: '19' }]) {
    evidence.postTokenBalances = [{ ...originalRow, ...mutation }]
    await expect(verifyExperimentalSolanaReceipt(claim, h.rpc)).rejects.toThrow()
  }
  expect(Object.keys((await a.inspect()).positions)).toHaveLength(2)
})

test('a finalized status without matching successful execution evidence keeps its original source reserved', async () => {
  const a = state(), h = harness(a); await a.observe(position()); await h.engine.quote(input())
  const operation = await h.engine.prepare(input().operationId), original = operation.signed[0]
  h.finalize('confirmed')
  h.evidenceBySignature.get(original.signature)!.err = { InstructionError: [0, 'failed'] }
  await expect(h.engine.reconcile(input().operationId)).rejects.toThrow('successful finalized')
  expect((await a.inspect()).positions[owners[0]].reservedBy).toBe(input().operationId)
  expect(await h.engine.progress(input().operationId)).toMatchObject({ status: 'pending', verifiedReceivedAmount: '0' })
})

async function incomingFixture(persistence = new MemorySolanaPaymentPersistence()) {
  const sender = state(), h = harness(sender)
  await sender.observe(position())
  const firstIntent = input(601)
  await h.engine.quote(firstIntent)
  const prepared = await h.engine.prepare(firstIntent.operationId)
  const original = prepared.signed[0]
  const claim = { chainIdentifier: chain, asset: firstIntent.asset, amount: original.amount, destination: original.destination, context: prepared.contexts[0], signature: original.signature, signedTransaction: Uint8Array.from(Buffer.from(original.transaction, 'base64')) }
  const recipient = state(persistence)
  const engine = new ExperimentalSolanaContactPayments(recipient, h.custody, h.rpc)
  return { ...h, sender, recipient, engine, claim, persistence }
}

test('authenticated incoming original persists offline before credit, survives strict IDB reopen and retries only retained bytes', async () => {
  const factory = new IDBFactory(), persistent = () => new IndexedDbSolanaPaymentPersistence('incoming-offline', factory)
  const f = await incomingFixture(persistent())
  f.rpc.getGenesisHash = jest.fn(async () => { throw new Error('offline') })
  const proof = { payloadDigest: 'ac'.repeat(32) }
  expect((await f.engine.recordIncomingClaim(f.claim, proof)).status).toBe('pending')
  expect(f.rpc.getGenesisHash).not.toHaveBeenCalled()
  expect((await f.recipient.inspect()).positions).toEqual({})
  await expect(f.engine.reconcileIncoming(f.claim.signature)).rejects.toThrow('offline')
  const reopened = state(persistent()), resumed = new ExperimentalSolanaContactPayments(reopened, f.custody, f.rpc)
  expect((await reopened.inspect()).incoming[f.claim.signature]).toMatchObject({ status: 'pending', payloadDigest: proof.payloadDigest, transaction: Buffer.from(f.claim.signedTransaction).toString('base64') })
  f.rpc.getGenesisHash = jest.fn(async () => genesis)
  await resumed.rebroadcastIncoming(f.claim.signature)
  expect(f.submitted).toEqual([f.claim.signedTransaction])
  expect((await resumed.reconcileIncoming(f.claim.signature)).status).toBe('pending')
  f.finalize('confirmed')
  expect((await resumed.reconcileIncoming(f.claim.signature)).credit).toBe('imported')
  expect((await reopened.inspect()).positions[f.claim.destination.destinationOwner]).toMatchObject({ balance: '20', signingReference: { kind: 'received' } })
  expect(await resumed.incomingProgress([f.claim.signature])).toEqual({ status: 'succeeded', intendedAmount: '20', verifiedReceivedAmount: '20' })
})

test('bad original signature, asset/destination/context, foreign chain, digest or recipient custody rejects before any incoming row', async () => {
  const f = await incomingFixture(), proof = { payloadDigest: 'ad'.repeat(32) }
  const corrupt = Uint8Array.from(f.claim.signedTransaction); corrupt[1] ^= 1
  const claims = [
    { ...f.claim, signedTransaction: corrupt },
    { ...f.claim, amount: '21' },
    { ...f.claim, destination: { ...f.claim.destination, destinationOwner: owners[3] } },
    { ...f.claim, context: { ...f.claim.context, memberIndex: 64 } },
    { ...f.claim, asset: { kind: 'spl' as const, mint: owners[3], program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', decimals: 6 } },
    { ...f.claim, chainIdentifier: 'solana-mainnet' },
  ]
  for (const claim of claims) await expect(f.engine.recordIncomingClaim(claim, proof)).rejects.toThrow()
  await expect(f.engine.recordIncomingClaim(f.claim, { payloadDigest: 'malformed' })).rejects.toThrow()
  f.custody.validateReceived.mockRejectedValueOnce(new Error('foreign recipient seed'))
  await expect(f.engine.recordIncomingClaim(f.claim, proof)).rejects.toThrow('recipient')
  expect((await f.recipient.inspect()).incoming).toEqual({})
  expect((await f.recipient.inspect()).positions).toEqual({})
})

test('incoming original is immutable across concurrent handles, repeated authenticated observation and reopen', async () => {
  const factory = new IDBFactory(), persistent = () => new IndexedDbSolanaPaymentPersistence('incoming-concurrent', factory)
  const f = await incomingFixture(persistent()), other = new ExperimentalSolanaContactPayments(state(persistent()), f.custody, f.rpc)
  const proof = { payloadDigest: 'ae'.repeat(32) }
  const records = await Promise.all([f.engine.recordIncomingClaim(f.claim, proof), other.recordIncomingClaim(f.claim, proof)])
  expect(records[0]).toEqual(records[1])
  await expect(other.recordIncomingClaim(f.claim, { payloadDigest: 'af'.repeat(32) })).rejects.toThrow('immutable')
  expect(Object.keys((await f.recipient.inspect()).incoming)).toEqual([f.claim.signature])
  f.finalize('confirmed');await f.engine.reconcileIncoming(f.claim.signature)
  const before = await f.recipient.inspect()
  expect((await other.recordIncomingClaim(f.claim, proof)).status).toBe('confirmed')
  expect(await f.recipient.inspect()).toEqual(before)
})

test('incoming finality and inventory credit commit atomically; interrupted commit remains pending and retryable', async () => {
  const backing = new MemorySolanaPaymentPersistence();let interrupt = false
  const persistence: import('./types').SolanaPaymentPersistence = { read: () => backing.read(), update: mutate => backing.update(previous => { const next = mutate(previous); if (interrupt) throw new Error('interrupted commit'); return next }) }
  const f = await incomingFixture(persistence)
  await f.engine.recordIncomingClaim(f.claim, { payloadDigest: 'b0'.repeat(32) })
  f.finalize('confirmed');interrupt = true
  await expect(f.engine.reconcileIncoming(f.claim.signature)).rejects.toThrow('interrupted')
  expect((await f.recipient.inspect()).incoming[f.claim.signature].status).toBe('pending')
  expect((await f.recipient.inspect()).positions).toEqual({})
  interrupt = false
  expect((await f.engine.reconcileIncoming(f.claim.signature)).status).toBe('confirmed')
  expect(Object.keys((await f.recipient.inspect()).positions)).toEqual([f.claim.destination.destinationOwner])
})

test('failed incoming execution retains complete recovery evidence and never credits; inconsistent finality remains pending', async () => {
  const f = await incomingFixture()
  await f.engine.recordIncomingClaim(f.claim, { payloadDigest: 'b1'.repeat(32) })
  f.finalize('failed')
  await expect(f.engine.reconcileIncoming(f.claim.signature)).rejects.toThrow('Inconsistent')
  expect((await f.recipient.inspect()).incoming[f.claim.signature].status).toBe('pending')
  const evidence = f.evidenceBySignature.get(f.claim.signature)!
  evidence.err = { InstructionError: [0, 'InsufficientFunds'] }
  expect((await f.engine.reconcileIncoming(f.claim.signature)).status).toBe('failed')
  expect((await f.recipient.inspect()).positions).toEqual({})
  expect((await f.recipient.inspect()).incoming[f.claim.signature].transaction).toBe(Buffer.from(f.claim.signedTransaction).toString('base64'))
  await f.engine.rebroadcastIncoming(f.claim.signature)
  expect(f.submitted).toEqual([])
  expect(await f.engine.incomingProgress([f.claim.signature])).toEqual({ status: 'failed', intendedAmount: '20', verifiedReceivedAmount: '0' })
})

test('retained incoming claim replay cannot resurrect its recipient position after finalized outgoing spend', async () => {
  const f = await incomingFixture(), proof = { payloadDigest: 'b2'.repeat(32) }
  await f.engine.recordIncomingClaim(f.claim, proof);f.finalize('confirmed');await f.engine.reconcileIncoming(f.claim.signature)
  const spend = { ...input(602), recipientSpendPoint: owners[3], amount: '10', maxNativeDebitLamports: '15' }
  await f.recipient.quote(spend)
  await f.recipient.bindDestination(spend.operationId, 0, { recipientPoint: owners[3], ephemeralPoint: owners[1], destinationOwner: owners[3] })
  await f.recipient.reserve(spend.operationId, () => [[f.claim.destination.destinationOwner]])
  // Construct a valid ordinary test signature for the received public account; these
  // synthetic keys deliberately model state retirement, not stealth custody math.
  const op = (await f.recipient.inspect()).operations[spend.operationId]
  const data = Buffer.alloc(12);data.writeUInt32LE(2);data.writeBigUInt64LE(10n,4)
  const instruction = new TransactionInstruction({programId:new PublicKey('11111111111111111111111111111111'),keys:[{pubkey:new PublicKey(owners[2]),isSigner:true,isWritable:true},{pubkey:new PublicKey(owners[3]),isSigner:false,isWritable:true}],data})
  const memo = new TransactionInstruction({programId:new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),keys:[],data:Buffer.from(`frank:solana-custody-primary:experimental-v1:${'0'.repeat(64)}`)})
  const tx = new VersionedTransaction(new TransactionMessage({payerKey:new PublicKey(owners[2]),recentBlockhash:owners[1],instructions:[instruction,memo]}).compileToV0Message());tx.addSignature(new PublicKey(owners[2]),ed25519.sign(tx.message.serialize(),seeds[2]))
  const { validateOriginal } = await import('./transaction-policy')
  const original = validateOriginal(tx.serialize(),op,(await f.recipient.inspect()).positions[owners[2]],{blockhash:owners[1],lastValidBlockHeight:30})
  await f.recipient.persistSigned(spend.operationId,[original]);await f.recipient.settle(spend.operationId,original.signature,'confirmed',20,{[owners[2]]:'5'})
  const before = await f.recipient.inspect()
  await f.engine.recordIncomingClaim(f.claim,proof);await f.engine.reconcileIncoming(f.claim.signature)
  expect(await f.recipient.inspect()).toEqual(before)
  expect((await f.recipient.inspect()).positions[owners[2]].balance).toBe('5')
  expect((await f.recipient.inspect()).retiredThrough[owners[2]]).toBe(20)
})

test('incoming partial totals count only verified members while pending or failed originals remain retained', async () => {
  const f = await incomingFixture()
  await f.sender.observe(position(owners[1]))
  const nextIntent = { ...input(604), amount: '10', maxNativeDebitLamports: '15' }
  const senderEngine = new ExperimentalSolanaContactPayments(f.sender, f.custody, f.rpc)
  await senderEngine.quote(nextIntent);const next = await senderEngine.prepare(nextIntent.operationId), second = next.signed[0]
  const secondClaim = { ...f.claim, amount: second.amount, destination: second.destination, context: next.contexts[0], signature: second.signature, signedTransaction: Uint8Array.from(Buffer.from(second.transaction,'base64')) }
  const proof = { payloadDigest: 'b3'.repeat(32) }
  await f.engine.recordIncomingClaim(f.claim,proof);await f.engine.recordIncomingClaim(secondClaim,proof)
  f.rpc.getFinalizedSignature = jest.fn(async signature => signature === f.claim.signature ? { outcome: 'confirmed' as const, slot: 10 } : null)
  await f.engine.reconcileIncoming(f.claim.signature);await f.engine.reconcileIncoming(second.signature)
  const signatures = [f.claim.signature,second.signature]
  expect(await f.engine.incomingProgress(signatures)).toEqual({status:'partial',intendedAmount:'30',verifiedReceivedAmount:'20'})
  f.evidenceBySignature.get(second.signature)!.err = { InstructionError: [0,'InsufficientFunds'] }
  f.rpc.getFinalizedSignature = jest.fn(async signature => ({ outcome: signature === second.signature ? 'failed' as const : 'confirmed' as const, slot:10 }))
  await f.engine.reconcileIncoming(second.signature)
  expect(await f.engine.incomingProgress(signatures)).toEqual({status:'partial',intendedAmount:'30',verifiedReceivedAmount:'20'})
  expect((await f.recipient.inspect()).incoming[second.signature].status).toBe('failed')
  await expect(f.engine.incomingProgress([f.claim.signature,f.claim.signature])).rejects.toThrow('member set')
})

test('corrupt incoming original rejects read-only restoration without resetting retained authority or accepting old format', async () => {
  const f = await incomingFixture(), proof = {payloadDigest:'b4'.repeat(32)}
  await f.engine.recordIncomingClaim(f.claim,proof)
  await f.persistence.update(previous => {
    const value = structuredClone(previous) as import('./types').SolanaPaymentSnapshot
    const original = value.incoming[f.claim.signature]
    const bytes = Buffer.from(original.transaction,'base64');bytes[1] ^= 1;original.transaction = bytes.toString('base64')
    return {value,result:undefined}
  })
  const corrupt = await f.persistence.read()
  await expect(state(f.persistence).inspect()).rejects.toThrow()
  expect(await f.persistence.read()).toEqual(corrupt)
  const old = new MemorySolanaPaymentPersistence()
  await old.update(() => ({value:{format:2,walletId:'synthetic-wallet',chainIdentifier:chain,positions:{},retiredThrough:{},operations:{}} as unknown as import('./types').SolanaPaymentSnapshot,result:undefined}))
  await expect(state(old).inspect()).rejects.toThrow('Unsupported')
  expect(await old.read()).toMatchObject({format:2})
})
