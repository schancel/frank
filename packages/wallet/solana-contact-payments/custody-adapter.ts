import { PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { feeProbeMessage, unsignedTransferMessage } from '../solana-crypto-backend/runtime.mjs'
import { ed25519 } from '@noble/curves/ed25519'
import type { ExperimentalCustody, PublicBuilderWasm, PublicDescriptor, PublicDestination, SenderIntent, TransferAsset, UnsignedTransferRequest } from '../solana-crypto-backend/runtime.mjs'
import type { ExperimentalSolanaPaymentConstruction, ExperimentalSolanaPaymentCustody } from './engine'
import type { SolanaPaymentAsset, SolanaPaymentPlan, SolanaPaymentOperation, SolanaSpendPosition, SolanaSigningReference } from './types'

const bytes = (value: string): number[] => [...new PublicKey(value).toBytes()]
const contextBytes = (value: string): number[] => {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid durable crypto context')
  return [...Buffer.from(value, 'hex')]
}
function asset(value: SolanaPaymentAsset): TransferAsset {
  return value.kind === 'native' ? { kind: 'native' } : { kind: 'spl', mint: bytes(value.mint), tokenProgram: bytes(value.program) }
}
function senderIntent(operation: Readonly<SolanaPaymentPlan>, memberIndex: number): SenderIntent {
  const context = operation.contexts[memberIndex]
  return { chainIdentifier: operation.intent.chainIdentifier, asset: asset(operation.intent.asset), recipient: bytes(operation.intent.recipientSpendPoint), operationId: contextBytes(context.cryptoOperationId32), memberIndex: context.memberIndex, messageContext: contextBytes(context.derivationContext32), recipientAmount: operation.members[memberIndex].amount }
}
function received(reference: Extract<SolanaSigningReference, { kind: 'received' }>): PublicDestination {
  const d = reference.descriptor
  const descriptor: PublicDescriptor = { chainIdentifier: d.chainIdentifier, asset: asset(d.asset), recipient: bytes(d.recipientSpendPoint), ephemeral: bytes(d.ephemeralPoint), operationId: contextBytes(d.cryptoOperationId32), memberIndex: d.memberIndex, messageContext: contextBytes(d.derivationContext32), recipientAmount: d.recipientAmount }
  return { descriptor, publicKey: bytes(d.publicKey) }
}

function transferRequest(operation: SolanaPaymentOperation, memberIndex: number, source: SolanaSpendPosition, blockhash: string): UnsignedTransferRequest {
  const member = operation.members[memberIndex]
  if (!member.destination) throw new Error('Durable destination required')
  const descriptor: PublicDescriptor = { ...senderIntent(operation, memberIndex), ephemeral: bytes(member.destination.ephemeralPoint) }
  const spend = { chainIdentifier: operation.intent.chainIdentifier, asset: asset(operation.intent.asset), owner: bytes(source.owner), destination: bytes(member.destination.destinationOwner), amount: member.amount, recentBlockhash: bytes(blockhash), operationId: descriptor.operationId, messageContext: descriptor.messageContext, decimals: operation.intent.asset.kind === 'spl' ? operation.intent.asset.decimals : null }
  const authorization = { feeLamports: member.maxFeeLamports, maxFeeLamports: member.maxFeeLamports, rentLamports: member.rentLamports, maxRentLamports: member.maxRentLamports, maxNativeDebitLamports: member.maxNativeDebitLamports, createDestinationAta: member.createDestinationAta }
  return { descriptor, spend, authorization, source: source.signingReference.kind === 'primary' ? { kind: 'primary' } : { kind: 'received', received: received(source.signingReference) } }
}

/** Pure public fixed construction; no custody handle, seed or signer authority. */
export function experimentalSolanaPaymentConstruction(wasm: PublicBuilderWasm): ExperimentalSolanaPaymentConstruction {
  return Object.freeze({
    async feeProbe(request: Parameters<ExperimentalSolanaPaymentConstruction['feeProbe']>[0]) {
      // Explicitly representative estimation point, not a derived recipient.
      // Public standard basepoint multiples avoid account-key collisions for a
      // self-payment or unusual mint; actual final destinations are quoted later.
      let destination = request.intent.recipientSpendPoint
      for (let scalar = 1n; destination === request.source.owner || request.intent.asset.kind === 'spl' && destination === request.intent.asset.mint; scalar++) destination = new PublicKey(ed25519.ExtendedPoint.BASE.multiply(scalar).toRawBytes()).toBase58()
      return feeProbeMessage({ domain: 'frank:solana-custody-fee-probe:v1', chainIdentifier: request.intent.chainIdentifier, asset: asset(request.intent.asset), owner: bytes(request.source.owner), destination: bytes(destination), amount: '1', recentBlockhash: bytes(request.blockhash), decimals: request.intent.asset.kind === 'spl' ? request.intent.asset.decimals : null, createDestinationAta: request.createDestinationAta }, wasm)
    },
    async unsignedTransfer(request: Parameters<ExperimentalSolanaPaymentConstruction['unsignedTransfer']>[0]) {
      return unsignedTransferMessage(transferRequest(request.operation, request.memberIndex, request.source, request.blockhash), wasm)
    },
  })
}

/** Narrow adapter for the frozen WASM primary and restored-recipient signers. The
 * host owns handle lifetime and closes/revokes it on session disposal. Public
 * descriptors are resolved lazily; no seed, scalar or signing prefix lives in JS. */
export function experimentalSolanaPaymentCustody(handle: ExperimentalCustody): ExperimentalSolanaPaymentCustody {
  return Object.freeze({
    async deriveDestination(operation: Readonly<SolanaPaymentPlan>, memberIndex: number) {
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
      const typed = transferRequest(operation, request.memberIndex, source, request.blockhash)
      if (request.feeCeilingLamports !== typed.authorization.maxFeeLamports || request.rentLamports !== typed.authorization.rentLamports || request.createDestinationAta !== typed.authorization.createDestinationAta) throw new Error('Signing request changed approved caps')
      const result = typed.source.kind === 'primary' ? handle.signPrimaryTransfer(derived.descriptor, typed.spend, typed.authorization) : handle.signReceivedTransfer(typed.source.received, derived.descriptor, typed.spend, typed.authorization)
      if (new PublicKey(result.publicKey).toBase58() !== source.owner) throw new Error('Custody signed with another owner')
      const tx = new VersionedTransaction(VersionedMessage.deserialize(result.message))
      tx.addSignature(new PublicKey(result.publicKey), result.signature)
      return tx.serialize()
    },
  })
}
