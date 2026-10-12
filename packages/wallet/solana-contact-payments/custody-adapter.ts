import { PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import type { ExperimentalCustody, PublicDescriptor, PublicDestination, SenderIntent, TransferAsset } from '../solana-crypto-backend/runtime.mjs'
import type { ExperimentalSolanaPaymentCustody } from './engine'
import type { SolanaPaymentAsset, SolanaPaymentOperation, SolanaSigningReference } from './types'

const bytes = (value: string): number[] => [...new PublicKey(value).toBytes()]
const contextBytes = (value: string): number[] => {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid durable crypto context')
  return [...Buffer.from(value, 'hex')]
}
function asset(value: SolanaPaymentAsset): TransferAsset {
  return value.kind === 'native' ? { kind: 'native' } : { kind: 'spl', mint: bytes(value.mint), tokenProgram: bytes(value.program) }
}
function senderIntent(operation: Readonly<SolanaPaymentOperation>, memberIndex: number): SenderIntent {
  const context = operation.contexts[memberIndex]
  return { chainIdentifier: operation.intent.chainIdentifier, asset: asset(operation.intent.asset), recipient: bytes(operation.intent.recipientSpendPoint), operationId: contextBytes(context.cryptoOperationId32), memberIndex: context.memberIndex, messageContext: contextBytes(context.derivationContext32), recipientAmount: operation.members[memberIndex].amount }
}
function received(reference: Extract<SolanaSigningReference, { kind: 'received' }>): PublicDestination {
  const d = reference.descriptor
  const descriptor: PublicDescriptor = { chainIdentifier: d.chainIdentifier, asset: asset(d.asset), recipient: bytes(d.recipientSpendPoint), ephemeral: bytes(d.ephemeralPoint), operationId: contextBytes(d.cryptoOperationId32), memberIndex: d.memberIndex, messageContext: contextBytes(d.derivationContext32), recipientAmount: d.recipientAmount }
  return { descriptor, publicKey: bytes(d.publicKey) }
}

/** Narrow adapter for the frozen WASM primary and restored-recipient signers. The
 * host owns handle lifetime and closes/revokes it on session disposal. Public
 * descriptors are resolved lazily; no seed, scalar or signing prefix lives in JS. */
export function experimentalSolanaPaymentCustody(handle: ExperimentalCustody): ExperimentalSolanaPaymentCustody {
  return Object.freeze({
    async deriveDestination(operation: Readonly<SolanaPaymentOperation>, memberIndex: number) {
      const result = handle.deriveDestination(senderIntent(operation, memberIndex))
      return { recipientPoint: operation.intent.recipientSpendPoint, ephemeralPoint: new PublicKey(Uint8Array.from(result.descriptor.ephemeral)).toBase58(), destinationOwner: new PublicKey(Uint8Array.from(result.publicKey)).toBase58() }
    },
    async validateReceived(reference: Extract<SolanaSigningReference, { kind: 'received' }>) {
      const key = handle.validateReceivedDescriptor(received(reference))
      if (new PublicKey(key).toBase58() !== reference.descriptor.publicKey) throw new Error('Received descriptor custody mismatch')
    },
    async signTransfer(request: Parameters<ExperimentalSolanaPaymentCustody['signTransfer']>[0]) {
      const { operation, source } = request
      const primary = handle.primaryPublicKey()
      const member = operation.members[request.memberIndex]
      if (!member.destination || (source.signingReference.kind === 'primary' && new PublicKey(primary).toBase58() !== source.owner)) throw new Error('Custody source affinity mismatch')
      const derived = handle.deriveDestination(senderIntent(operation, request.memberIndex))
      if (new PublicKey(Uint8Array.from(derived.publicKey)).toBase58() !== member.destination.destinationOwner || new PublicKey(Uint8Array.from(derived.descriptor.ephemeral)).toBase58() !== member.destination.ephemeralPoint) throw new Error('Persisted sender derivation mismatch')
      const spend = { chainIdentifier: operation.intent.chainIdentifier, asset: asset(operation.intent.asset), owner: bytes(source.owner), destination: bytes(member.destination.destinationOwner), amount: member.amount, recentBlockhash: bytes(request.blockhash), operationId: derived.descriptor.operationId, messageContext: derived.descriptor.messageContext, decimals: operation.intent.asset.kind === 'spl' ? operation.intent.asset.decimals : null }
      const fee = BigInt(operation.intent.maxFeePerTransferLamports), rent = member.createDestinationAta ? BigInt(operation.intent.maxRentPerTransferLamports) : 0n
      const authorization = { feeLamports: request.feeCeilingLamports, maxFeeLamports: operation.intent.maxFeePerTransferLamports, rentLamports: member.rentLamports, maxRentLamports: rent.toString(), maxNativeDebitLamports: (fee + rent + (operation.intent.asset.kind === 'native' ? BigInt(member.amount) : 0n)).toString(), createDestinationAta: member.createDestinationAta }
      const result = source.signingReference.kind === 'primary' ? handle.signPrimaryTransfer(derived.descriptor, spend, authorization) : handle.signReceivedTransfer(received(source.signingReference), derived.descriptor, spend, authorization)
      if (new PublicKey(result.publicKey).toBase58() !== source.owner) throw new Error('Custody signed with another owner')
      const tx = new VersionedTransaction(VersionedMessage.deserialize(result.message))
      tx.addSignature(new PublicKey(result.publicKey), result.signature)
      return tx.serialize()
    },
  })
}
