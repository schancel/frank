// Actual browser/WASM custody and durable owner proof. Synthetic keys, simulated RPC.
import { Buffer } from 'buffer'
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { getBase58Decoder } from '@solana/codecs-strings'
import { openExperimentalRecipientCustody } from '../solana-crypto-backend/runtime.mjs'
import { IndexedDbSolanaPaymentPersistence } from '../storage/solana-payment-state'
import { SolanaPaymentState } from './state'
import { experimentalSolanaPaymentCustody } from './custody-adapter'
import { ExperimentalSolanaContactPayments, type ExperimentalSolanaPaymentRpc } from './engine'
import { associatedAccount } from './transaction-policy'
import type { SolanaPaymentIntent, SolanaPaymentOperation } from './types'
import type { SolanaReceiptClaim, SolanaReceiptEvidence } from './receipt'
Object.assign(globalThis, { Buffer })
function check(value: unknown, why: string): asserts value { if (!value) throw new Error(why) }
export async function runBrowserPaymentProof() {
  const chain = 'solana-devnet', genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
  const evidence = new Map<string, SolanaReceiptEvidence>(), finalized = new Map<string, { outcome: 'confirmed'; slot: number }>()
  const submitted: string[] = []
  const open = async (n: number) => {
    const seed = new Uint8Array(32).fill(n)
    const handle = await openExperimentalRecipientCustody({ accountId: new Uint8Array(32).fill(n), chainIdentifier: chain, seed, wasm: new URL('/backend_bg.wasm', location.href).href })
    check(seed.every(n => n === 0), 'Host seed survived handoff')
    return handle
  }
  const a = await open(1), b = await open(3), c = await open(4)
  const aOwner = new PublicKey(a.primaryPublicKey()).toBase58(), bPoint = new PublicKey(b.primaryPublicKey()).toBase58(), cPoint = new PublicKey(c.primaryPublicKey()).toBase58()
  c.close()
  const ownerState = (wallet: string) => new SolanaPaymentState(wallet, chain, new IndexedDbSolanaPaymentPersistence(`synthetic-owner-${wallet}`))
  const rpc = (fee: string): ExperimentalSolanaPaymentRpc => ({
    getGenesisHash: async () => genesis,
    getLatestBlockhash: async () => ({ blockhash: cPoint, lastValidBlockHeight: 200 }),
    hasInitializedTokenAccount: async () => true,
    getTokenAccountRentLamports: async () => '10',
    getFeeForMessage: async () => fee,
    getFinalizedTransaction: async signature => evidence.get(signature) ?? null,
    sendRawTransaction: async bytes => { submitted.push(Buffer.from(bytes).toString('base64')); return getBase58Decoder().decode(VersionedTransaction.deserialize(bytes).signatures[0]) },
    getFinalizedSignature: async signature => finalized.get(signature) ?? null,
  })
  const claimFor = (operation: SolanaPaymentOperation, index: number): SolanaReceiptClaim => {
    const original = operation.signed[index]
    return { chainIdentifier: chain, asset: operation.intent.asset, amount: original.amount, destination: original.destination, context: operation.contexts[index], signature: original.signature, signedTransaction: Uint8Array.from(Buffer.from(original.transaction, 'base64')) }
  }
  const observeEvidence = (operation: SolanaPaymentOperation, index: number, slot: number, sourceBalance = '20', nativeBalance = '50') => {
    const claim = claimFor(operation, index), tx = VersionedTransaction.deserialize(claim.signedTransaction), keys = tx.message.staticAccountKeys.map(key => String(key.toBase58()))
    const asset = operation.intent.asset, destination = asset.kind === 'native' ? claim.destination.destinationOwner : associatedAccount(claim.destination.destinationOwner, asset.mint)
    const at = keys.indexOf(destination), before = keys.map(() => '0'), after = [...before]
    before[0]=asset.kind==='native'?sourceBalance:nativeBalance;after[0]=(BigInt(before[0])-BigInt(operation.intent.maxFeePerTransferLamports)-(asset.kind==='native'?BigInt(claim.amount):BigInt(operation.members[index].rentLamports))).toString();if (asset.kind === 'native') after[at] = claim.amount
    const token = asset.kind === 'spl' ? { accountIndex: at, mint: asset.mint, program: asset.program, decimals: asset.decimals, owner: claim.destination.destinationOwner } : undefined
    evidence.set(claim.signature, { signedTransaction: claim.signedTransaction, slot, err: null, preBalances: before, postBalances: after, preTokenBalances: token ? [{...token,amount:'0'}] : [], postTokenBalances: token ? [{...token,amount:claim.amount}] : [] })
  }
  const intent = (id: number, recipientSpendPoint: string, amount = '20', fee = '5'): SolanaPaymentIntent => ({ operationId: `00000000-0000-4000-8000-${String(id).padStart(12,'0')}`, chainIdentifier: chain, recipientSpendPoint, asset: {kind:'native'}, amount, maxFeeLamports:fee, maxFeePerTransferLamports:fee, maxNativeDebitLamports:(BigInt(amount)+BigInt(fee)).toString(), maxRentPerTransferLamports:'0', maxRentLamports:'0', allowDestinationAtaCreation:false })
  const stateA = ownerState('A'), stateB = ownerState('B')
  await stateA.inspect()
  check(!(await indexedDB.databases()).some(db => db.name === 'synthetic-owner-A'), 'Read-only hydration created database')
  const engineA = new ExperimentalSolanaContactPayments(stateA, experimentalSolanaPaymentCustody(a), rpc('5'))
  const offlineRpcB = rpc('1'); offlineRpcB.getGenesisHash = async () => { throw new Error('recipient RPC offline') }
  const engineB = new ExperimentalSolanaContactPayments(stateB, experimentalSolanaPaymentCustody(b), offlineRpcB)
  const received: SolanaReceiptClaim[] = []
  for (let n = 1; n <= 2; n++) {
    await stateA.observe({ address:aOwner, owner:aOwner, asset:{kind:'native'}, balance:String(125-25*n), observedSlot:n === 1 ? 1 : 12, signingReference:{kind:'primary'} })
    const payment = intent(n,bPoint)
    await engineA.quote(payment); const prepared = await engineA.prepare(payment.operationId)
    observeEvidence(prepared,0,n*10,String(125-25*n))
    await engineA.expose(payment.operationId,{payloadDigest:String(n).repeat(64)})
    await engineA.submit(payment.operationId)
    finalized.set(prepared.signed[0].signature,{outcome:'confirmed',slot:n*10})
    check(await engineA.reconcile(payment.operationId)==='settled','A original not settled')
    const claim=claimFor(prepared,0); received.push(claim)
    if(n===1){
      const alteredContext={...claim.context,cryptoOperationId32:(claim.context.cryptoOperationId32[0]==='a'?'b':'a')+claim.context.cryptoOperationId32.slice(1)}
      const badSignature=Uint8Array.from(claim.signedTransaction);badSignature[1]^=1
      for(const forged of [{...claim,context:alteredContext},{...claim,destination:{...claim.destination,recipientPoint:aOwner}},{...claim,signedTransaction:badSignature},{...claim,chainIdentifier:'solana-mainnet'}]){
        let rejected=false;try{await engineB.recordIncomingClaim(forged,{payloadDigest:'b'.repeat(64)})}catch{rejected=true}
        check(rejected && !Object.keys((await stateB.inspect()).incoming).length,'Forged incoming claim reached durable authority')
      }
      check(!(await indexedDB.databases()).some(db=>db.name==='synthetic-owner-B'),'Rejected claims initialized recipient authority')
    }
    check((await engineB.recordIncomingClaim(claim,{payloadDigest:'b'.repeat(64)})).status==='pending','Offline original claim was not durable')
    check((await engineB.recordIncomingClaim(claim,{payloadDigest:'b'.repeat(64)})).status==='pending','Repeated pending claim changed state')
    check(!Object.keys((await stateB.inspect()).positions).length,'Pending evidence credited inventory')
  }
  b.close()
  const reopenedB = await open(3), reopenedStateB = ownerState('B')
  check(Object.keys((await reopenedStateB.inspect()).incoming).length===2 && !Object.keys((await reopenedStateB.inspect()).positions).length,'Offline claims did not survive reopen without credit')
  const reopenedEngineB = new ExperimentalSolanaContactPayments(reopenedStateB,experimentalSolanaPaymentCustody(reopenedB),rpc('1'))
  for(const claim of received){await reopenedEngineB.rebroadcastIncoming(claim.signature);check(submitted.at(-1)===Buffer.from(claim.signedTransaction).toString('base64'),'Recipient retry replaced original');check((await reopenedEngineB.reconcileIncoming(claim.signature)).credit==='imported','Finalized incoming evidence did not credit inventory')}
  check(Object.values((await reopenedStateB.inspect()).positions).every(position=>position.signingReference.kind==='received'),'Received descriptors did not survive reopen')
  const outgoing={...intent(3,cPoint,'35','1'),maxFeeLamports:'2',maxNativeDebitLamports:'37'}
  await reopenedEngineB.quote(outgoing)
  const gathered=await reopenedEngineB.prepare(outgoing.operationId)
  check(gathered.signed.length===2 && gathered.signed.reduce((n,m)=>n+BigInt(m.amount),0n)===35n,'Received account gathering failed')
  gathered.signed.forEach((_,index)=>observeEvidence(gathered,index,100+index))
  await reopenedEngineB.expose(outgoing.operationId,{payloadDigest:'a'.repeat(64)})
  await reopenedEngineB.submit(outgoing.operationId)
  finalized.set(gathered.signed[0].signature,{outcome:'confirmed',slot:100})
  check(await reopenedEngineB.reconcile(outgoing.operationId)==='pending','Partial original set incorrectly settled')
  check((await reopenedEngineB.progress(outgoing.operationId)).verifiedReceivedAmount===gathered.signed[0].amount,'Partial receipt sum invented funds')
  const pending=(await reopenedStateB.inspect()).positions
  check(Object.values(pending).filter(position=>position.reservedBy===outgoing.operationId).length===1,'Partial settlement released another source')
  const consumed=received.find(claim=>claim.destination.destinationOwner===gathered.signed[0].sourceAddresses[0])!
  const beforeReplay=JSON.stringify((await reopenedStateB.inspect()).positions)
  await reopenedEngineB.recordIncomingClaim(consumed,{payloadDigest:'b'.repeat(64)});await reopenedEngineB.reconcileIncoming(consumed.signature)
  check(JSON.stringify((await reopenedStateB.inspect()).positions)===beforeReplay,'Old claim resurrected a spent source')
  await reopenedEngineB.submit(outgoing.operationId)
  check(submitted.at(-1)===gathered.signed[1].transaction,'Restart retry replaced pending original')
  finalized.set(gathered.signed[1].signature,{outcome:'confirmed',slot:101})
  check(await reopenedEngineB.reconcile(outgoing.operationId)==='settled','Gathered set not finalized')
  check((await reopenedEngineB.progress(outgoing.operationId)).verifiedReceivedAmount==='35','Final received sum wrong');check(Object.values((await reopenedStateB.inspect()).positions).some(position=>position.balance==='3'&&position.postSpendSignature),'Finalized residual balance not retained')
  // Actual classic SPL primary signing remains covered under the same owner adapter.
  await stateA.observe({address:aOwner,owner:aOwner,asset:{kind:'native'},balance:'50',observedSlot:21,signingReference:{kind:'primary'}})
  const mint='BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k', spl={kind:'spl' as const,mint,program:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',decimals:6}
  await stateA.observe({address:associatedAccount(aOwner,mint),owner:aOwner,asset:spl,balance:'100',observedSlot:21,signingReference:{kind:'primary'}})
  const tokenIntent={...intent(4,bPoint),asset:spl,maxNativeDebitLamports:'15',maxRentLamports:'10',maxRentPerTransferLamports:'10',allowDestinationAtaCreation:true}
  const tokenRpc=rpc('5');tokenRpc.hasInitializedTokenAccount=async()=>false;const tokenEngineA=new ExperimentalSolanaContactPayments(stateA,experimentalSolanaPaymentCustody(a),tokenRpc);
  await tokenEngineA.quote(tokenIntent); const tokenPrepared=await tokenEngineA.prepare(tokenIntent.operationId)
  check(VersionedTransaction.deserialize(Buffer.from(tokenPrepared.signed[0].transaction,'base64')).message.compiledInstructions.length===3,'Fixed ATA construction missing');
  observeEvidence(tokenPrepared,0,150);const tokenClaim=claimFor(tokenPrepared,0);finalized.set(tokenClaim.signature,{outcome:'confirmed',slot:150});await reopenedEngineB.recordIncomingClaim(tokenClaim,{payloadDigest:'b'.repeat(64)});check((await reopenedEngineB.reconcileIncoming(tokenClaim.signature)).credit==='imported','SPL receipt not imported');
  const receivedToken=(await reopenedStateB.inspect()).positions[associatedAccount(tokenClaim.destination.destinationOwner,mint)];
  const respendIntent={...intent(5,cPoint,'15','1'),asset:spl,maxNativeDebitLamports:'11',maxRentLamports:'10',maxRentPerTransferLamports:'10',allowDestinationAtaCreation:true};
  const tokenRpcB=rpc('1');tokenRpcB.hasInitializedTokenAccount=async()=>false;const tokenEngineB=new ExperimentalSolanaContactPayments(ownerState('B'),experimentalSolanaPaymentCustody(reopenedB),tokenRpcB);
  let needsGas=false;try{await tokenEngineB.quote(respendIntent)}catch(error){needsGas=String(error).includes('needs-native-gas')}check(needsGas,'Token receipt invented native gas');
  await reopenedStateB.observe({address:receivedToken.owner,owner:receivedToken.owner,asset:{kind:'native'},balance:'20',observedSlot:151,signingReference:receivedToken.signingReference});
  await tokenEngineB.quote(respendIntent);const respentToken=await tokenEngineB.prepare(respendIntent.operationId);check(respentToken.signed.length===1&&VersionedTransaction.deserialize(Buffer.from(respentToken.signed[0].transaction,'base64')).message.compiledInstructions.length===3,'Received SPL/ATA respend failed')
  reopenedB.close(); a.close()
  let revoked=false
  try{await experimentalSolanaPaymentCustody(reopenedB).deriveDestination(gathered,0)}catch{revoked=true}
  check(revoked,'Revoked custody remained usable')
  return {incomingForgeryRejected:true,incomingDurableOffline:true,incomingOriginalRetry:true,nativeSigned:true,splSigned:true,receivedDescriptors:3,gatheredMembers:2,splReceivedRespend:true,explicitAtaRent:true,needsNativeGas:true,verifiedReceivedAmount:'35',partialSafe:true,strictIndexedDb:true,revoked,wireProofMembers:[gathered,tokenPrepared,respentToken].flatMap(operation=>operation.signed.map(original=>({chainIdentifier:chain,asset:operation.intent.asset,context:operation.contexts[original.memberIndex],original})))}
}
