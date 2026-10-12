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
  const construction = { async feeProbe() { return tx.message.serialize() }, async unsignedTransfer() { return tx.message.serialize() } }
  const engine = new ExperimentalSolanaContactPayments(state, custody, f.rpc, construction)
  const operationId = '00000000-0000-4000-8000-000000000991'
  await engine.quoteReview({ operationId, chainIdentifier, recipientSpendPoint: destination.toBase58(), asset: { kind: 'native' }, amount: '100', allowDestinationAtaCreation: false })
  await engine.prepare(operationId)
  await engine.expose(operationId, { payloadDigest: 'ab'.repeat(32) })
  await expect(engine.submit(operationId)).rejects.toThrow('timeout')
  const reopened = new SolanaPaymentState('rpc-synthetic', chainIdentifier, persistence)
  const resumed = new ExperimentalSolanaContactPayments(reopened, custody, new CanonicalSolanaPaymentRpc(chainIdentifier, f.transport), construction)
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

function nativeAccount(lamports: number | bigint = 10000) {
  return { owner: '11111111111111111111111111111111', executable: false, lamports, data: ['', 'base64'] }
}
function ownedBalancesResponse() {
  const tokens = tokenAccounts()
  return { context: { slot: 600 }, value: [nativeAccount(), ...tokens.value] }
}
const selectedSpl = { kind: 'spl' as const, mint, program: tokenProgram, decimals: 6 }

test('owned balance read binds native gas, classic ATA and mint to one finalized context with exact u64 amounts', async () => {
  const observed = ownedBalancesResponse()
  const token = Buffer.from(String(observed.value[1].data[0]),'base64');token.writeBigUInt64LE(18446744073709551615n,64);observed.value[1].data[0] = token.toString('base64')
  const f = fixture({ getMultipleAccounts: observed })
  expect(await f.rpc.readOwnedBalances({ owner, selectedAsset: selectedSpl })).toEqual({finalizedSlot:600,nativeBalance:'10000',assetBalance:{address:ata,asset:selectedSpl,balance:'18446744073709551615'}})
  expect(f.calls[1]).toEqual({method:'getMultipleAccounts',params:[[owner,ata,mint],{commitment:'finalized',encoding:'base64'}]})
  expect(f.calls.map(call=>call.method)).toEqual(['getGenesisHash','getMultipleAccounts'])
})

test('missing native account is actual zero, missing ATA is null, initialized empty ATA is explicit zero', async () => {
  const f = fixture({getMultipleAccounts:{context:{slot:600},value:[null]}})
  expect(await f.rpc.readOwnedBalances({owner,selectedAsset:{kind:'native'}})).toEqual({finalizedSlot:600,nativeBalance:'0',assetBalance:{address:owner,asset:{kind:'native'},balance:'0'}})
  const absent = ownedBalancesResponse();(absent.value as unknown[])[0]=null;(absent.value as unknown[])[1]=null;f.responses.getMultipleAccounts=absent
  expect(await f.rpc.readOwnedBalances({owner,selectedAsset:selectedSpl})).toEqual({finalizedSlot:600,nativeBalance:'0',assetBalance:null})
  const zero = ownedBalancesResponse(), bytes = Buffer.from(String(zero.value[1].data[0]),'base64');bytes.writeBigUInt64LE(0n,64);zero.value[1].data[0]=bytes.toString('base64');f.responses.getMultipleAccounts=zero
  expect((await f.rpc.readOwnedBalances({owner,selectedAsset:selectedSpl})).assetBalance?.balance).toBe('0')
})

test('owned reads reject foreign ownership, mint, program, decimals, unsupported authorities and malformed contexts', async () => {
  const mutations: ((row: ReturnType<typeof ownedBalancesResponse>)=>void)[] = [
    row=>{row.value[0].owner=tokenProgram},
    row=>{row.value[0].executable=true},
    row=>{row.value[0].data=['AQ==','base64']},
    row=>{row.value[1].owner=destination.toBase58()},
    row=>{const b=Buffer.from(String(row.value[1].data[0]),'base64');b[0]^=1;row.value[1].data[0]=b.toString('base64')},
    row=>{const b=Buffer.from(String(row.value[1].data[0]),'base64');b[32]^=1;row.value[1].data[0]=b.toString('base64')},
    row=>{const b=Buffer.from(String(row.value[2].data[0]),'base64');b[44]=9;row.value[2].data[0]=b.toString('base64')},
    row=>{const b=Buffer.from(String(row.value[2].data[0]),'base64');b[45]=0;row.value[2].data[0]=b.toString('base64')},
    ...[72,109,129].map(offset=>(row:ReturnType<typeof ownedBalancesResponse>)=>{const b=Buffer.from(String(row.value[1].data[0]),'base64');b.writeUInt32LE(1,offset);row.value[1].data[0]=b.toString('base64')}),
    row=>{const b=Buffer.from(String(row.value[1].data[0]),'base64');b[108]=2;row.value[1].data[0]=b.toString('base64')},
    row=>{row.context.slot=-1},
    row=>{row.context.slot=Number.MAX_SAFE_INTEGER+1},
    row=>{row.value.pop()},
  ]
  for(const mutate of mutations){const observed=ownedBalancesResponse();mutate(observed);await expect(fixture({getMultipleAccounts:observed}).rpc.readOwnedBalances({owner,selectedAsset:selectedSpl})).rejects.toThrow()}
  await expect(fixture({getGenesisHash:'foreign',getMultipleAccounts:ownedBalancesResponse()}).rpc.readOwnedBalances({owner,selectedAsset:selectedSpl})).rejects.toThrow('identity')
  await expect(fixture({getMultipleAccounts:new Error('network offline')}).rpc.readOwnedBalances({owner,selectedAsset:selectedSpl})).rejects.toThrow('offline')
  await expect(fixture({}).rpc.readOwnedBalances({owner,selectedAsset:{...selectedSpl,program:destination.toBase58()}})).rejects.toThrow('Unsupported')
})

function discoveryRow(accountAddress = ata, account = tokenAccounts().value[0]) { return {pubkey:accountAddress,account} }

test('classic discovery emits only verified ATA metadata, re-reads mint decimals and excludes nonATA/unsupported accounts', async () => {
  const unsupported = tokenAccounts().value[0], bytes=Buffer.from(unsupported.data[0],'base64');bytes.writeUInt32LE(1,72);unsupported.data[0]=bytes.toString('base64')
  const f=fixture({getTokenAccountsByOwner:{context:{slot:590},value:[discoveryRow(),discoveryRow(destination.toBase58()),discoveryRow(mint,unsupported)]},getMultipleAccounts:tokenAccounts()})
  // Re-read context must be at least as recent as the initial query.
  const current=tokenAccounts();current.context.slot=600;f.responses.getMultipleAccounts=current
  expect(await f.rpc.discoverClassicAssets(owner)).toEqual({finalizedSlot:600,assets:[selectedSpl]})
  expect(f.calls[1]).toEqual({method:'getTokenAccountsByOwner',params:[owner,{programId:tokenProgram},{commitment:'finalized',encoding:'base64'}]})
  expect(f.calls[3]).toEqual({method:'getMultipleAccounts',params:[[ata,mint],{commitment:'finalized',encoding:'base64',minContextSlot:590}]})
  const frozen=tokenAccounts().value[0], frozenBytes=Buffer.from(frozen.data[0],'base64');frozenBytes[108]=2;frozen.data[0]=frozenBytes.toString('base64')
  const empty=fixture({getTokenAccountsByOwner:{context:{slot:600},value:[discoveryRow(ata,frozen)]}})
  expect(await empty.rpc.discoverClassicAssets(owner)).toEqual({finalizedSlot:600,assets:[]})
  expect(empty.calls).toHaveLength(2)
})

test('discovery rejects wrong owner/program, duplicates, malformed data, stale context and network failure without partial output', async () => {
  for(const edit of [(account:ReturnType<typeof tokenAccounts>['value'][0])=>{account.owner=destination.toBase58()},(account:ReturnType<typeof tokenAccounts>['value'][0])=>{const b=Buffer.from(account.data[0],'base64');b[32]^=1;account.data[0]=b.toString('base64')},(account:ReturnType<typeof tokenAccounts>['value'][0])=>{account.data[0]=Buffer.alloc(166).toString('base64')}]){
    const account=tokenAccounts().value[0];edit(account);await expect(fixture({getTokenAccountsByOwner:{context:{slot:500},value:[discoveryRow(ata,account)]}}).rpc.discoverClassicAssets(owner)).rejects.toThrow()
  }
  await expect(fixture({getTokenAccountsByOwner:{context:{slot:500},value:[discoveryRow(),discoveryRow()]}}).rpc.discoverClassicAssets(owner)).rejects.toThrow('Duplicate')
  await expect(fixture({getTokenAccountsByOwner:{context:{slot:600},value:[discoveryRow()]},getMultipleAccounts:tokenAccounts()}).rpc.discoverClassicAssets(owner)).rejects.toThrow('incoherent')
  const changed=tokenAccounts(), changedBytes=Buffer.from(changed.value[0].data[0],'base64');changedBytes[0]^=1;changed.value[0].data[0]=changedBytes.toString('base64')
  await expect(fixture({getTokenAccountsByOwner:{context:{slot:500},value:[discoveryRow()]},getMultipleAccounts:changed}).rpc.discoverClassicAssets(owner)).rejects.toThrow('changed')
  const wrongMint=tokenAccounts();wrongMint.value[1].owner=destination.toBase58()
  await expect(fixture({getTokenAccountsByOwner:{context:{slot:500},value:[discoveryRow()]},getMultipleAccounts:wrongMint}).rpc.discoverClassicAssets(owner)).rejects.toThrow('mint')
  await expect(fixture({getTokenAccountsByOwner:new Error('offline')}).rpc.discoverClassicAssets(owner)).rejects.toThrow('offline')
})

test('discovery honors the RPC100 address cap and requires one coherent finalized slot across every batch', async () => {
  const byAddress = new Map<string,unknown>(), entries: ReturnType<typeof discoveryRow>[]=[]
  for(let index=0;index<51;index++){
    const tokenMint=new PublicKey(ed25519.getPublicKey(new Uint8Array(32).fill(index+20))).toBase58(), accountAddress=associatedAccount(owner,tokenMint)
    const values=tokenAccounts().value, bytes=Buffer.from(values[0].data[0],'base64');Buffer.from(new PublicKey(tokenMint).toBytes()).copy(bytes,0);values[0].data[0]=bytes.toString('base64')
    entries.push(discoveryRow(accountAddress,values[0]));byAddress.set(accountAddress,values[0]);byAddress.set(tokenMint,values[1])
  }
  let batches=0,mismatch=false
  const transport:SolanaJsonRpcTransport={async request(method,params){if(method==='getGenesisHash')return genesis;if(method==='getTokenAccountsByOwner')return{context:{slot:500},value:entries};if(method==='getMultipleAccounts'){const keys=params[0] as string[];expect(keys.length).toBeLessThanOrEqual(100);batches++;return{context:{slot:mismatch&&batches%2===0?601:600},value:keys.map(key=>byAddress.get(key))}}throw new Error('Unexpected RPC') }}
  const rpc=new CanonicalSolanaPaymentRpc(chainIdentifier,transport)
  expect((await rpc.discoverClassicAssets(owner)).assets).toHaveLength(51);expect(batches).toBe(2)
  mismatch=true
  await expect(rpc.discoverClassicAssets(owner)).rejects.toThrow('Incoherent')
})

function rawHttp(resultFor:(method:string)=>string) {
  return createSolanaHttpTransport('https://rpc.invalid', (async (_url,init) => {
    const request=JSON.parse(String(init!.body)),result=request.method==='getGenesisHash'?JSON.stringify(genesis):resultFor(request.method)
    return new Response(`{"jsonrpc":"2.0","id":${request.id},"result":${result}}`)
  }) as typeof fetch)
}
function rawNativeResult(amountToken:string, slotToken='600') {
  return `{"context":{"slot":${slotToken}},"value":[{"owner":"11111111111111111111111111111111","executable":false,"lamports":${amountToken},"data":["","base64"]}]}`
}

test('actual HTTP text preserves native >2^53 and full u64; exact positive exponents stay exact while rounded fractions reject', async () => {
  for(const [literal,expectedAmount] of [['9007199254740993','9007199254740993'],['18446744073709551615','18446744073709551615'],['1e3','1000']]){
    const rpc=new CanonicalSolanaPaymentRpc(chainIdentifier,rawHttp(()=>rawNativeResult(literal)))
    expect((await rpc.readOwnedBalances({owner,selectedAsset:{kind:'native'}})).nativeBalance).toBe(expectedAmount)
  }
  for(const literal of ['18446744073709551616','-1','1.00000000000000000001','1e-1','1.0','9007199254740993.0']){
    const rpc=new CanonicalSolanaPaymentRpc(chainIdentifier,rawHttp(()=>rawNativeResult(literal)))
    await expect(rpc.readOwnedBalances({owner,selectedAsset:{kind:'native'}})).rejects.toThrow()
  }
  const unsafeSlot=new CanonicalSolanaPaymentRpc(chainIdentifier,rawHttp(()=>rawNativeResult('1','9007199254740993')))
  await expect(unsafeSlot.readOwnedBalances({owner,selectedAsset:{kind:'native'}})).rejects.toThrow('Unsafe')
})

test('lossless HTTP rejects nested/escaped reserved markers and wrong IDs, while ignored fractional uiAmount cannot become atomic balance', async () => {
  for(const marker of ['{"$n":"123"}','{"\\u0024n":"123"}']){
    const rpc=new CanonicalSolanaPaymentRpc(chainIdentifier,rawHttp(()=>rawNativeResult(marker)))
    await expect(rpc.readOwnedBalances({owner,selectedAsset:{kind:'native'}})).rejects.toThrow('Reserved')
  }
  const nested=rawHttp(()=>'{"nested":{"deep":{"$n":"123"}}}')
  await expect(nested.request('getMultipleAccounts',[])).rejects.toThrow('Reserved')
  const current={...evidence(),meta:{...evidence().meta,postTokenBalances:[{accountIndex:1,mint,owner,programId:tokenProgram,uiTokenAmount:{amount:'1234567',decimals:6,uiAmount:1.234567}}]}}
  const rpc=new CanonicalSolanaPaymentRpc(chainIdentifier,rawHttp(()=>JSON.stringify(current)))
  expect((await rpc.getFinalizedTransaction(txSignature))!.postTokenBalances[0].amount).toBe('1234567')
  const wrongId=createSolanaHttpTransport('https://rpc.invalid',(async()=>new Response('{"jsonrpc":"2.0","id":1.00000000000000000001,"result":0}')) as typeof fetch)
  await expect(wrongId.request('getMinimumBalanceForRentExemption',[])).rejects.toThrow('exact')
})

test('actual HTTP text reads classic binary balances/decimals and rejects fractional account rent metadata', async () => {
  const raw = JSON.stringify(ownedBalancesResponse())
  const rpc = new CanonicalSolanaPaymentRpc(chainIdentifier,rawHttp(()=>raw))
  expect(await rpc.readOwnedBalances({owner,selectedAsset:selectedSpl})).toEqual({finalizedSlot:600,nativeBalance:'10000',assetBalance:{address:ata,asset:selectedSpl,balance:'1000'}})
  const fractional = new CanonicalSolanaPaymentRpc(chainIdentifier,rawHttp(()=>raw.replace('"lamports":2039280','"lamports":2039280.00000000000000000001')))
  await expect(fractional.readOwnedBalances({owner,selectedAsset:selectedSpl})).rejects.toThrow('exact')
})


test('first classic mint metadata is finalized and canonical without recipient inventory or ATA discovery',async()=>{
  const f=fixture({getMultipleAccounts:{context:{slot:700},value:[tokenAccounts().value[1]]}})
  expect(await f.rpc.readClassicMint({mint,program:tokenProgram})).toEqual({mint,program:tokenProgram,decimals:6,finalizedSlot:700})
  expect(f.calls).toEqual([{method:'getGenesisHash',params:[]},{method:'getMultipleAccounts',params:[[mint],{commitment:'finalized',encoding:'base64'}]}])
  const freshMint=destination.toBase58()
  expect(await f.rpc.readClassicMint({mint:freshMint,program:tokenProgram})).toMatchObject({mint:freshMint,decimals:6})
  expect(f.calls.at(-1)?.params[0]).toEqual([freshMint])
  const configured=tokenAccounts().value[1],bytes=Buffer.from(configured.data[0],'base64');bytes.writeUInt32LE(1,46);Buffer.from(destination.toBytes()).copy(bytes,50);bytes[44]=255;configured.data[0]=bytes.toString('base64')
  f.responses.getMultipleAccounts={context:{slot:701},value:[configured]}
  expect(await f.rpc.readClassicMint({mint,program:tokenProgram})).toEqual({mint,program:tokenProgram,decimals:255,finalizedSlot:701})
})

test('first mint metadata rejects absence, nonclassic programs, invalid layout/authorities, wrong chain and unavailable RPC',async()=>{
  const invalid:unknown[]=[null,undefined]
  for(const mutate of [
    (row:ReturnType<typeof tokenAccounts>['value'][1])=>{row.owner=destination.toBase58()},
    (row:ReturnType<typeof tokenAccounts>['value'][1])=>{row.executable=true},
    (row:ReturnType<typeof tokenAccounts>['value'][1])=>{row.data[0]=Buffer.alloc(83).toString('base64')},
    ...[0,46].map(offset=>(row:ReturnType<typeof tokenAccounts>['value'][1])=>{const bytes=Buffer.from(row.data[0],'base64');bytes.writeUInt32LE(2,offset);row.data[0]=bytes.toString('base64')}),
    (row:ReturnType<typeof tokenAccounts>['value'][1])=>{const bytes=Buffer.from(row.data[0],'base64');bytes[45]=0;row.data[0]=bytes.toString('base64')},
  ]){const row=tokenAccounts().value[1];mutate(row);invalid.push(row)}
  for(const value of invalid)await expect(fixture({getMultipleAccounts:{context:{slot:700},value:[value]}}).rpc.readClassicMint({mint,program:tokenProgram})).rejects.toThrow()
  const unsupported=fixture({})
  await expect(unsupported.rpc.readClassicMint({mint,program:'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'})).rejects.toThrow('classic')
  await expect(unsupported.rpc.readClassicMint({mint:'bad',program:tokenProgram})).rejects.toThrow()
  expect(unsupported.calls).toEqual([])
  await expect(fixture({getGenesisHash:'foreign'}).rpc.readClassicMint({mint,program:tokenProgram})).rejects.toThrow('identity')
  await expect(fixture({getMultipleAccounts:new Error('offline')}).rpc.readClassicMint({mint,program:tokenProgram})).rejects.toThrow('offline')
})

test('mint lookup uses actual lossless HTTP text and rejects fractional/unsafe context and mint lamports',async()=>{
  const row=tokenAccounts().value[1]
  for(const literal of ['9007199254740993','18446744073709551615']){
    const text=JSON.stringify(row).replace(/"lamports":[0-9]+/,`"lamports":${literal}`)
    const rpc=new CanonicalSolanaPaymentRpc(chainIdentifier,rawHttp(()=>`{"context":{"slot":700},"value":[${text}]}`))
    expect(await rpc.readClassicMint({mint,program:tokenProgram})).toEqual({mint,program:tokenProgram,decimals:6,finalizedSlot:700})
  }
  for(const literal of ['1.00000000000000000001','1.0','1e-1','18446744073709551616','-1']){
    const text=JSON.stringify(row).replace(/"lamports":[0-9]+/,`"lamports":${literal}`)
    const rpc=new CanonicalSolanaPaymentRpc(chainIdentifier,rawHttp(()=>`{"context":{"slot":700},"value":[${text}]}`))
    await expect(rpc.readClassicMint({mint,program:tokenProgram})).rejects.toThrow()
  }
  for(const slot of ['null','1.00000000000000000001','9007199254740993']){
    const rpc=new CanonicalSolanaPaymentRpc(chainIdentifier,rawHttp(()=>`{"context":{"slot":${slot}},"value":[${JSON.stringify(row)}]}`))
    await expect(rpc.readClassicMint({mint,program:tokenProgram})).rejects.toThrow()
  }
})
