import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { getBase58Decoder } from '@solana/codecs-strings'
import { CanonicalSolanaPaymentRpc, createSolanaHttpTransport, type SolanaJsonRpcTransport } from './rpc-adapter'
import { SolanaPaymentState } from './state'
import { ExperimentalSolanaContactPayments } from './engine'
import { MemorySolanaPaymentPersistence } from '../storage/solana-payment-state'
import { associatedAccount } from './transaction-policy'
import { ed25519 } from '@noble/curves/ed25519'
import protocol from '../../../docs/protocol/chains/v1.json'

// Recorded RPC shapes, entirely synthetic bytes/keys; no live requests or owner data.
// Shapes: https://solana.com/docs/rpc/http/gettransaction and /getsignaturestatuses.
const chainIdentifier = 'solana-devnet'
const genesis = protocol.chains.find(row => row.id === chainIdentifier)!.identity_probes.find(probe => probe.kind === 'genesis-hash')!.expected
const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const signer = { publicKey: new PublicKey(ed25519.getPublicKey(seed)) }
const destination = new PublicKey(ed25519.getPublicKey(new Uint8Array(32).fill(77)))
const mint = new PublicKey(ed25519.getPublicKey(new Uint8Array(32).fill(43))).toBase58()
const owner = signer.publicKey.toBase58(), ata = associatedAccount(owner, mint)
const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: destination.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: destination, lamports: 100 }), new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.from(`frank:solana-custody-primary:experimental-v1:${'0'.repeat(64)}`) })] }).compileToV0Message())
tx.addSignature(signer.publicKey, ed25519.sign(tx.message.serialize(), seed))
const original = Uint8Array.from(tx.serialize()), txSignature = getBase58Decoder().decode(tx.signatures[0])
const accountCount = tx.message.staticAccountKeys.length
function evidence() {
  return { slot: 500, version: 0, transaction: [Buffer.from(original).toString('base64'), 'base64'], meta: { err: null, preBalances: [10000, 0, 1, 1], postBalances: [4900, 100, 1, 1], preTokenBalances: [], postTokenBalances: [], loadedAddresses: { writable: [], readonly: [] } } }
}
function fixture(responses: Record<string, unknown>) {
  const calls: { method: string; params: readonly unknown[] }[] = []
  const transport: SolanaJsonRpcTransport = { async request(method, params) { calls.push({ method, params: structuredClone(params) }); if (method === 'getGenesisHash') return Object.hasOwn(responses, method) ? responses[method] : genesis; if (!Object.hasOwn(responses, method)) throw new Error(`Unexpected fixture call ${method}`); if (responses[method] instanceof Error) throw responses[method]; return structuredClone(responses[method]) } }
  return { calls, responses, rpc: new CanonicalSolanaPaymentRpc(chainIdentifier, transport), transport }
}
function tokenAccounts() {
  const account = Buffer.alloc(165), mintData = Buffer.alloc(82)
  Buffer.from(new PublicKey(mint).toBytes()).copy(account, 0); Buffer.from(signer.publicKey.toBytes()).copy(account, 32)
  account.writeBigUInt64LE(1000n, 64); account[108] = 1
  mintData[44] = 6; mintData[45] = 1
  return { context: { slot: 500 }, value: [ { owner: tokenProgram, executable: false, lamports: 2039280, data: [account.toString('base64'), 'base64'] }, { owner: tokenProgram, executable: false, lamports: 1461600, data: [mintData.toString('base64'), 'base64'] } ] }
}
const expected = { owner, mint, program: tokenProgram, decimals: 6 }

test('canonical binding checks every financial request and a new adapter after reopen; wrong chain never reaches submission', async () => {
  expect(() => new CanonicalSolanaPaymentRpc('devnet', fixture({}).transport)).toThrow('canonical')
  const f = fixture({ getMinimumBalanceForRentExemption: 2039280, sendTransaction: txSignature })
  expect(await f.rpc.getTokenAccountRentLamports()).toBe('2039280')
  expect(await new CanonicalSolanaPaymentRpc(chainIdentifier, f.transport).sendRawTransaction(original)).toBe(txSignature)
  expect(f.calls.map(row => row.method)).toEqual(['getGenesisHash', 'getMinimumBalanceForRentExemption', 'getGenesisHash', 'sendTransaction'])
  f.responses.getGenesisHash = 'wrong-chain'
  await expect(f.rpc.sendRawTransaction(original)).rejects.toThrow('identity')
  expect(f.calls.filter(row => row.method === 'sendTransaction')).toHaveLength(1)
})

test('finalized transaction projects exact signature, original bytes and safe balance metadata', async () => {
  expect(accountCount).toBe(4)
  const f = fixture({ getTransaction: evidence() })
  const result = await f.rpc.getFinalizedTransaction(txSignature)
  expect(result).toMatchObject({ slot: 500, err: null, preBalances: ['10000', '0', '1', '1'], postBalances: ['4900', '100', '1', '1'] })
  expect(result!.signedTransaction).toEqual(original)
  expect(f.calls[1]).toEqual({ method: 'getTransaction', params: [txSignature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }] })
  f.responses.getTransaction = null
  expect(await f.rpc.getFinalizedTransaction(txSignature)).toBeNull()
})

test('unsafe u64 numbers, malformed finalized tuples and missing metadata never become financial evidence', async () => {
  const mutations = [
    (row: ReturnType<typeof evidence>) => { row.meta.postBalances[0] = Number.MAX_SAFE_INTEGER + 1 },
    (row: ReturnType<typeof evidence>) => { row.meta.postBalances.pop() },
    (row: ReturnType<typeof evidence>) => { row.transaction[1] = 'base58' },
    (row: ReturnType<typeof evidence>) => { row.transaction[0] += '\n' },
    (row: ReturnType<typeof evidence>) => { row.version = 1 },
    (row: ReturnType<typeof evidence>) => { row.slot = -1 },
  ]
  for (const mutate of mutations) { const row = evidence(); mutate(row); await expect(fixture({ getTransaction: row }).rpc.getFinalizedTransaction(txSignature)).rejects.toThrow() }
  await expect(fixture({ getTransaction: { ...evidence(), meta: null } }).rpc.getFinalizedTransaction(txSignature)).rejects.toThrow()
  const other = getBase58Decoder().decode(new Uint8Array(64).fill(3))
  await expect(fixture({ getTransaction: evidence() }).rpc.getFinalizedTransaction(other)).rejects.toThrow('signature mismatch')
})

test('history status remains unknown for partial confirmation and permits only explicit finalized success or failure', async () => {
  const status = { slot: 500, err: null as unknown, confirmations: 3 as number | null, confirmationStatus: 'confirmed' }
  const response = { context: { slot: 505 }, value: [status] }
  const f = fixture({ getSignatureStatuses: response })
  expect(await f.rpc.getFinalizedSignature(txSignature)).toBeNull()
  status.confirmationStatus = 'finalized'; status.confirmations = null
  f.responses.getSignatureStatuses = response
  expect(await f.rpc.getFinalizedSignature(txSignature)).toEqual({ outcome: 'confirmed', slot: 500 })
  status.err = 'AccountNotFound'; f.responses.getSignatureStatuses = response
  expect(await f.rpc.getFinalizedSignature(txSignature)).toEqual({ outcome: 'failed', slot: 500 })
  status.confirmations = 1; f.responses.getSignatureStatuses = response
  await expect(f.rpc.getFinalizedSignature(txSignature)).rejects.toThrow('Inconsistent')
  f.responses.getSignatureStatuses = { context: { slot: 505 }, value: [null] }
  expect(await f.rpc.getFinalizedSignature(txSignature)).toBeNull()
  expect(f.calls[1].params).toEqual([[txSignature], { searchTransactionHistory: true }])
})

test('classic ATA observation binds owner, mint, program, initialized state and decimals; no Token2022 or authority extensions', async () => {
  const f = fixture({ getMultipleAccounts: tokenAccounts() })
  expect(await f.rpc.hasInitializedTokenAccount(ata, expected)).toBe(true)
  const absent = tokenAccounts(); (absent.value as unknown[])[0] = null
  f.responses.getMultipleAccounts = absent
  expect(await f.rpc.hasInitializedTokenAccount(ata, expected)).toBe(false)
  for (const offset of [0, 32, 72, 108, 109, 129]) {
    const row = tokenAccounts(), bytes = Buffer.from(row.value[0].data[0], 'base64'); bytes[offset] ^= 1; row.value[0].data[0] = bytes.toString('base64')
    await expect(fixture({ getMultipleAccounts: row }).rpc.hasInitializedTokenAccount(ata, expected)).rejects.toThrow()
  }
  await expect(f.rpc.hasInitializedTokenAccount(ata, { ...expected, decimals: 9 })).rejects.toThrow('mint')
  await expect(f.rpc.hasInitializedTokenAccount(ata, { ...expected, program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' })).rejects.toThrow('Unsupported')
  const extended = tokenAccounts(); extended.value[0].data[0] = Buffer.alloc(166).toString('base64')
  await expect(fixture({ getMultipleAccounts: extended }).rpc.hasInitializedTokenAccount(ata, expected)).rejects.toThrow()
})

test('token metadata keeps exact u64 strings while rejecting duplicate account indices and unsupported programs', async () => {
  const row = { accountIndex: 1, mint, owner, programId: tokenProgram, uiTokenAmount: { amount: '18446744073709551615', decimals: 6, uiAmount: null } }
  const source = { ...evidence(), meta: { ...evidence().meta, postTokenBalances: [row] } }
  const f = fixture({ getTransaction: source })
  expect((await f.rpc.getFinalizedTransaction(txSignature))!.postTokenBalances[0].amount).toBe('18446744073709551615')
  source.meta.postTokenBalances.push(row); f.responses.getTransaction = source
  await expect(f.rpc.getFinalizedTransaction(txSignature)).rejects.toThrow('token balance')
  source.meta.postTokenBalances = [{ ...row, programId: destination.toBase58() }]; f.responses.getTransaction = source
  await expect(f.rpc.getFinalizedTransaction(txSignature)).rejects.toThrow('token balance')
})

test('fees and rent fail on unsafe numeric money; submit forwards original bytes without replacement and rejects other signatures', async () => {
  const f = fixture({ getFeeForMessage: { context: { slot: 500 }, value: 5000 }, getMinimumBalanceForRentExemption: Number.MAX_SAFE_INTEGER + 1, sendTransaction: txSignature })
  expect(await f.rpc.getFeeForMessage(tx.message.serialize())).toBe('5000')
  await expect(f.rpc.getTokenAccountRentLamports()).rejects.toThrow('Unsafe')
  expect(await f.rpc.sendRawTransaction(original)).toBe(txSignature)
  expect(f.calls.find(row => row.method === 'sendTransaction')!.params).toEqual([Buffer.from(original).toString('base64'), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'finalized', maxRetries: 0 }])
  f.responses.sendTransaction = getBase58Decoder().decode(new Uint8Array(64).fill(4))
  await expect(f.rpc.sendRawTransaction(original)).rejects.toThrow('another')
  const corrupt = Uint8Array.from(original); corrupt[1] ^= 1
  await expect(f.rpc.sendRawTransaction(corrupt)).rejects.toThrow()
})

test('explicit HTTP transport validates JSON-RPC envelope/id/errors and preserves result without defaults', async () => {
  const requests: unknown[] = []
  const fetcher = jest.fn(async (_url: unknown, init: RequestInit | undefined) => { const request = JSON.parse(String(init!.body)); requests.push(request); return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: genesis }), { status: 200 }) })
  const http = createSolanaHttpTransport('https://rpc.invalid/solana', fetcher as typeof fetch)
  expect(await http.request('getGenesisHash', [])).toBe(genesis)
  expect(requests).toEqual([{ jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] }])
  const wrong = createSolanaHttpTransport('https://rpc.invalid', (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 99, result: genesis }))) as typeof fetch)
  await expect(wrong.request('getGenesisHash', [])).rejects.toThrow('response')
  const rejected = createSolanaHttpTransport('https://rpc.invalid', (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Unavailable' } }))) as typeof fetch)
  await expect(rejected.request('getGenesisHash', [])).rejects.toThrow('rejected')
  expect(() => createSolanaHttpTransport('file:///tmp/rpc', fetcher as typeof fetch)).toThrow('endpoint')
})


test('actual RPC projection preserves owner originals and reservations across timeout, reopen and finalized reconciliation', async () => {
  const persistence = new MemorySolanaPaymentPersistence()
  let entropy = 0
  const state = new SolanaPaymentState('rpc-synthetic', chainIdentifier, persistence, () => new Uint8Array(32).fill(++entropy))
  await state.observe({ address: owner, owner, asset: { kind: 'native' }, balance: '10000', observedSlot: 1, signingReference: { kind: 'primary' } })
  const f = fixture({ getLatestBlockhash: { context: { slot: 490 }, value: { blockhash: destination.toBase58(), lastValidBlockHeight: 600 } }, getFeeForMessage: { context: { slot: 490 }, value: 5000 }, sendTransaction: new Error('timeout'), getSignatureStatuses: { context: { slot: 501 }, value: [null] }, getTransaction: evidence() })
  const custody = { async deriveDestination() { return { recipientPoint: destination.toBase58(), ephemeralPoint: mint, destinationOwner: destination.toBase58() } }, async validateReceived() {}, async signTransfer() { return original } }
  const engine = new ExperimentalSolanaContactPayments(state, custody, f.rpc)
  const operationId = '00000000-0000-4000-8000-000000000991'
  await engine.quote({ operationId, chainIdentifier, recipientSpendPoint: destination.toBase58(), asset: { kind: 'native' }, amount: '100', maxFeeLamports: '5000', maxNativeDebitLamports: '5100', maxFeePerTransferLamports: '5000', maxRentPerTransferLamports: '0', maxRentLamports: '0', allowDestinationAtaCreation: false })
  await engine.prepare(operationId)
  await engine.expose(operationId, { payloadDigest: 'ab'.repeat(32) })
  await expect(engine.submit(operationId)).rejects.toThrow('timeout')
  const reopened = new SolanaPaymentState('rpc-synthetic', chainIdentifier, persistence)
  const resumed = new ExperimentalSolanaContactPayments(reopened, custody, new CanonicalSolanaPaymentRpc(chainIdentifier, f.transport))
  expect(await resumed.reconcile(operationId)).toBe('pending')
  expect((await reopened.inspect()).positions[owner].reservedBy).toBe(operationId)
  f.responses.sendTransaction = txSignature
  await resumed.submit(operationId)
  const sent = f.calls.filter(row => row.method === 'sendTransaction')
  expect(sent).toHaveLength(2)
  expect(sent[0].params).toEqual(sent[1].params)
  f.responses.getSignatureStatuses = { context: { slot: 501 }, value: [{ slot: 500, err: null, confirmations: null, confirmationStatus: 'finalized' }] }
  expect(await resumed.reconcile(operationId)).toBe('settled')
  expect(await resumed.progress(operationId)).toEqual({ status: 'succeeded', intendedAmount: '100', verifiedReceivedAmount: '100' })
  expect((await reopened.inspect()).positions[owner]).toMatchObject({ balance: '4900', observedSlot: 500, postSpendSignature: txSignature })
  expect((await reopened.inspect()).positions[owner].reservedBy).toBeUndefined()
})
