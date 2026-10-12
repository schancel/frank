import { PublicKey, VersionedTransaction, PACKET_DATA_SIZE } from '@solana/web3.js'
import { MAX_PAYMENT_MEMBERS } from '@frank/codec'
import protocol from '../../../docs/protocol/chains/v1.json'
import { associatedAccount, validateOriginal } from './transaction-policy'
import { u64 } from './amount'
import type { SolanaIncomingPayment, SolanaPaymentAsset, SolanaPaymentDestination, SolanaPaymentMemberContext, SolanaPaymentOperation, SolanaSigningReference, SolanaSpendPosition } from './types'

export interface SolanaReceiptClaim {
  chainIdentifier: string
  asset: SolanaPaymentAsset
  amount: string
  destination: SolanaPaymentDestination
  context: SolanaPaymentMemberContext
  signedTransaction: Uint8Array
  signature: string
}
export interface SolanaTokenBalanceEvidence {
  accountIndex: number
  mint: string
  owner: string
  program: string
  decimals: number
  amount: string
}
export interface SolanaReceiptEvidence {
  /** Canonical successful finalized transaction returned by the bound RPC. */
  signedTransaction: Uint8Array
  slot: number
  err: unknown | null
  preBalances: readonly string[]
  postBalances: readonly string[]
  preTokenBalances: readonly SolanaTokenBalanceEvidence[]
  postTokenBalances: readonly SolanaTokenBalanceEvidence[]
}
export interface SolanaReceiptRpc {
  getGenesisHash(): Promise<string>
  getFinalizedTransaction(signature: string): Promise<SolanaReceiptEvidence | null>
}

/** Pure canonical-byte validation runs before any RPC or durable claim.
 * validateOriginal verifies standard Ed25519 and exact transfer/ATA instructions. */
export function validateExperimentalSolanaClaim(claim: SolanaReceiptClaim): void {
  if (!claim || Object.keys(claim).sort().join() !== 'amount,asset,chainIdentifier,context,destination,signature,signedTransaction' || !protocol.chains.some(row => row.id === claim.chainIdentifier && row.family === 'solana')) throw new Error('Malformed or foreign Solana claim')
  const key = (value: string) => { if (typeof value !== 'string' || value.length > 44 || new PublicKey(value).toBase58() !== value) throw new Error('Malformed claim public key') }
  if (!claim.destination || Object.keys(claim.destination).sort().join() !== 'destinationOwner,ephemeralPoint,recipientPoint') throw new Error('Malformed claim destination')
  key(claim.destination.recipientPoint); key(claim.destination.ephemeralPoint); key(claim.destination.destinationOwner)
  const context = claim.context
  if (!context || Object.keys(context).sort().join() !== 'cryptoOperationId32,derivationContext32,memberIndex' || typeof context.cryptoOperationId32 !== 'string' || typeof context.derivationContext32 !== 'string' || !/^[a-f0-9]{64}$/.test(context.cryptoOperationId32) || !/^[a-f0-9]{64}$/.test(context.derivationContext32) || context.cryptoOperationId32 === context.derivationContext32 || !Number.isInteger(context.memberIndex) || context.memberIndex < 0 || context.memberIndex >= MAX_PAYMENT_MEMBERS) throw new Error('Malformed claim context')
  const asset = claim.asset
  if (!asset || (asset.kind === 'native' ? Object.keys(asset).join() !== 'kind' : asset.kind !== 'spl' || Object.keys(asset).sort().join() !== 'decimals,kind,mint,program' || asset.program !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' || !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 255)) throw new Error('Unsupported claim asset')
  if (asset.kind === 'spl') key(asset.mint)
  if (!(claim.signedTransaction instanceof Uint8Array) || claim.signedTransaction.length > PACKET_DATA_SIZE || typeof claim.signature !== 'string' || claim.signature.length > 88 || u64(claim.amount) === 0n) throw new Error('Malformed claim original')
  const tx = VersionedTransaction.deserialize(claim.signedTransaction)
  if (!Buffer.from(tx.serialize()).equals(Buffer.from(claim.signedTransaction))) throw new Error('Noncanonical claim original bytes')
  const keys: string[] = tx.message.staticAccountKeys.map(key => key.toBase58())
  const source: SolanaSpendPosition = { address: claim.asset.kind === 'native' ? keys[0] : associatedAccount(keys[0], claim.asset.mint), owner: keys[0], asset: claim.asset, balance: claim.amount, observedSlot: 0, signingReference: { kind: 'primary' } }
  const createDestinationAta = tx.message.compiledInstructions.length === 3
  const operation: SolanaPaymentOperation = {
    intent: { operationId: '00000000-0000-0000-0000-000000000000', chainIdentifier: claim.chainIdentifier, recipientSpendPoint: claim.destination.recipientPoint, asset: claim.asset, amount: claim.amount, maxFeeLamports: '0', maxNativeDebitLamports: '0', maxFeePerTransferLamports: '0', maxRentPerTransferLamports: '0', maxRentLamports: '0', allowDestinationAtaCreation: createDestinationAta },
    contexts: [claim.context], members: [{ amount: claim.amount, destination: claim.destination, sourceAddresses: [source.address], rentLamports: '0', createDestinationAta }], phase: 'quoted', sourceAddresses: [source.address], signed: [], outcomes: {},
  }
  const validated = validateOriginal(claim.signedTransaction, operation, source, { blockhash: tx.message.recentBlockhash, lastValidBlockHeight: 0 })
  if (validated.signature !== claim.signature || source.owner === claim.destination.destinationOwner || u64(claim.amount) === 0n) throw new Error('Receipt original does not match claim')
}

/** Read-only chain verifier. A message or a sender assertion is not receipt evidence.
 * It neither imports a coin nor rebroadcasts. Host composes the verified result with
 * custody descriptor affinity and the state owner's observe operation. */
export async function verifyExperimentalSolanaReceipt(claim: SolanaReceiptClaim, rpc: SolanaReceiptRpc): Promise<{ position: Omit<SolanaSpendPosition, 'signingReference'>; nativeGas: 'not-required' | 'must-observe-owned-native-balance' }> {
  const expected = protocol.chains.find(row => row.id === claim.chainIdentifier && row.family === 'solana')?.identity_probes.find(probe => probe.kind === 'genesis-hash')?.expected
  if (!expected || await rpc.getGenesisHash() !== expected) throw new Error('Receipt RPC chain identity mismatch')
  const evidence = await rpc.getFinalizedTransaction(claim.signature)
  if (!evidence || evidence.err !== null || !Number.isSafeInteger(evidence.slot) || evidence.slot < 0 || !Buffer.from(evidence.signedTransaction).equals(Buffer.from(claim.signedTransaction))) throw new Error('Missing successful finalized original transaction')
  validateExperimentalSolanaClaim(claim)
  const tx = VersionedTransaction.deserialize(claim.signedTransaction)
  const keys: string[] = tx.message.staticAccountKeys.map(key => key.toBase58())
  const createDestinationAta = tx.message.compiledInstructions.length === 3
  const destinationAddress = claim.asset.kind === 'native' ? claim.destination.destinationOwner : associatedAccount(claim.destination.destinationOwner, claim.asset.mint)
  const index = keys.indexOf(destinationAddress)
  if (index < 0 || evidence.preBalances.length !== keys.length || evidence.postBalances.length !== keys.length) throw new Error('Incomplete receipt account evidence')
  let balance: string
  if (claim.asset.kind === 'native') {
    const before = u64(evidence.preBalances[index]), after = u64(evidence.postBalances[index])
    if (after - before !== u64(claim.amount)) throw new Error('Native recipient delta does not match payment')
    balance = after.toString()
  } else {
    const asset = claim.asset
    const get = (rows: readonly SolanaTokenBalanceEvidence[], absentAllowed = false) => {
      const entries = rows.filter(row => row.accountIndex === index)
      if (absentAllowed && !entries.length) return 0n
      if (entries.length !== 1) throw new Error('Missing or duplicate token account evidence')
      const row = entries[0]
      if (row.mint !== asset.mint || row.program !== asset.program || row.decimals !== asset.decimals || row.owner !== claim.destination.destinationOwner) throw new Error('Token receipt asset/owner mismatch')
      return u64(row.amount)
    }
    const before = get(evidence.preTokenBalances, createDestinationAta), after = get(evidence.postTokenBalances)
    if (after - before !== u64(claim.amount)) throw new Error('Token recipient delta does not match payment')
    balance = after.toString()
  }
  return { position: { address: destinationAddress, owner: claim.destination.destinationOwner, asset: structuredClone(claim.asset), balance, observedSlot: evidence.slot }, nativeGas: claim.asset.kind === 'native' ? 'not-required' : 'must-observe-owned-native-balance' }
}

export function receivedSolanaSigningReference(claim: SolanaReceiptClaim): Extract<SolanaSigningReference, { kind: 'received' }> {
  return { kind: 'received', descriptor: { chainIdentifier: claim.chainIdentifier, asset: structuredClone(claim.asset), recipientSpendPoint: claim.destination.recipientPoint, ephemeralPoint: claim.destination.ephemeralPoint, cryptoOperationId32: claim.context.cryptoOperationId32, derivationContext32: claim.context.derivationContext32, memberIndex: claim.context.memberIndex, recipientAmount: claim.amount, publicKey: claim.destination.destinationOwner } }
}

/** Public reconstruction of the sole durable original; never signs or substitutes. */
export function incomingSolanaReceiptClaim(payment: SolanaIncomingPayment): SolanaReceiptClaim {
  return { signature: payment.signature, chainIdentifier: payment.chainIdentifier, asset: structuredClone(payment.asset), amount: payment.amount, destination: structuredClone(payment.destination), context: structuredClone(payment.context), signedTransaction: Uint8Array.from(Buffer.from(payment.transaction, 'base64')) }
}
