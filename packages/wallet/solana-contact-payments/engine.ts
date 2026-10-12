import { VersionedTransaction } from '@solana/web3.js'
import { MAX_PAYMENT_MEMBERS } from '@frank/codec'
import protocol from '../../../docs/protocol/chains/v1.json'
import { SolanaPaymentState } from './state'
import { u64 } from './amount'
import { associatedAccount, validateOriginal } from './transaction-policy'
import { incomingSolanaReceiptClaim, receivedSolanaSigningReference, validateExperimentalSolanaClaim, verifyExperimentalSolanaReceipt, type SolanaReceiptClaim, type SolanaReceiptRpc } from './receipt'
import type { SolanaIncomingPayment, SolanaPaymentAsset, SolanaPaymentDestination, SolanaPaymentIntent, SolanaPaymentOperation, SolanaSignedPayment, SolanaSigningReference, SolanaSpendPosition } from './types'

function sameAsset(a: SolanaPaymentAsset, b: SolanaPaymentAsset): boolean {
  return a.kind === 'native' ? b.kind === 'native' : b.kind === 'spl' && a.mint === b.mint && a.program === b.program && a.decimals === b.decimals
}
export interface ExperimentalSolanaPaymentCustody {
  deriveDestination(operation: Readonly<SolanaPaymentOperation>, memberIndex: number): Promise<SolanaPaymentDestination>
  validateReceived(reference: Extract<SolanaSigningReference, { kind: 'received' }>): Promise<void>
  /** Closed, typed custody adapter; no seed/scalar or arbitrary-message API. */
  signTransfer(request: {
    operation: Readonly<SolanaPaymentOperation>
    memberIndex: number
    source: Readonly<SolanaSpendPosition>
    blockhash: string
    lastValidBlockHeight: number
    feeCeilingLamports: string
    createDestinationAta: boolean
    rentLamports: string
  }): Promise<Uint8Array>
}
export interface ExperimentalSolanaPaymentRpc extends SolanaReceiptRpc {
  getGenesisHash(): Promise<string>
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>
  /** Must verify owner, mint, classic program, initialized state and decimals. */
  hasInitializedTokenAccount(address: string, expected: { owner: string; mint: string; program: string; decimals: number }): Promise<boolean>
  getFeeForMessage(message: Uint8Array): Promise<string | null>
  getTokenAccountRentLamports(): Promise<string>
  sendRawTransaction(original: Uint8Array): Promise<string>
  getFinalizedSignature(signature: string): Promise<{ outcome: 'confirmed' | 'failed'; slot: number } | null>
}
export class SolanaPaymentPrerequisiteError extends Error {
  constructor(readonly requirement: 'needs-account-and-rent-policy' | 'needs-native-gas' | 'insufficient-value' | 'member-limit' | 'fee-rent-budget') { super(requirement) }
}

/** Uncomposed experimental engine. RPC lifetime and custody are injected and bound
 * to this owner; changing the selected UI network cannot redirect an operation. */
export class ExperimentalSolanaContactPayments {
  constructor(private readonly state: SolanaPaymentState, private readonly custody: ExperimentalSolanaPaymentCustody, private readonly rpc: ExperimentalSolanaPaymentRpc, private readonly maxMembers = MAX_PAYMENT_MEMBERS) {
    if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > MAX_PAYMENT_MEMBERS) throw new Error('Invalid payment member policy')
  }
  private async verifyChain(): Promise<void> {
    const facts = protocol.chains.find(row => row.id === this.state.chainIdentifier && row.family === 'solana')
    const expected = facts?.identity_probes.find(probe => probe.kind === 'genesis-hash')?.expected
    if (!expected || await this.rpc.getGenesisHash() !== expected) throw new Error('Solana RPC chain identity mismatch')
  }
  async quote(intent: SolanaPaymentIntent): Promise<SolanaPaymentOperation> {
    intent = structuredClone(intent)
    const prior = (await this.state.inspect()).operations[intent.operationId]
    let amounts: string[] = prior?.members.map(member => member.amount) ?? []
    if (!prior) {
      let remaining = u64(intent.amount)
      const positions = Object.values((await this.state.inspect()).positions).filter(position => !position.reservedBy)
      const candidates = positions.filter(position => sameAsset(position.asset, intent.asset)).sort((a, b) => u64(a.balance) < u64(b.balance) ? -1 : u64(a.balance) > u64(b.balance) ? 1 : a.address.localeCompare(b.address))
      const fee = u64(intent.maxFeePerTransferLamports), rent = intent.asset.kind === 'spl' && intent.allowDestinationAtaCreation ? u64(intent.maxRentPerTransferLamports) : 0n
      let tokenWithoutGas = false
      for (const source of candidates) {
        let value = u64(source.balance)
        if (intent.asset.kind === 'native') value = value > fee ? value - fee : 0n
        else {
          const gas = positions.find(position => position.asset.kind === 'native' && position.address === source.owner && u64(position.balance) >= fee + rent)
          if (!gas) { tokenWithoutGas = true; continue }
        }
        if (value === 0n) continue
        const amount = value < remaining ? value : remaining
        amounts.push(amount.toString()); remaining -= amount
        if (remaining === 0n) break
        if (amounts.length === this.maxMembers) throw new SolanaPaymentPrerequisiteError('member-limit')
      }
      if (remaining) throw new SolanaPaymentPrerequisiteError(tokenWithoutGas ? 'needs-native-gas' : 'insufficient-value')
      const fees = BigInt(amounts.length) * fee, rents = BigInt(amounts.length) * rent
      if (fees > u64(intent.maxFeeLamports) || rents > u64(intent.maxRentLamports) || fees + rents + (intent.asset.kind === 'native' ? u64(intent.amount) : 0n) > u64(intent.maxNativeDebitLamports)) throw new SolanaPaymentPrerequisiteError('fee-rent-budget')
    }
    // Durable random contexts precede custody derivation, never an envelope hash.
    let operation = await this.state.quote(intent, amounts)
    for (const [memberIndex, member] of operation.members.entries()) {
      const derived = await this.custody.deriveDestination(operation, memberIndex)
      let createDestinationAta = member.createDestinationAta, rentLamports = member.rentLamports
      if (!member.destination && intent.asset.kind === 'spl') {
        await this.verifyChain()
        const exists = await this.rpc.hasInitializedTokenAccount(associatedAccount(derived.destinationOwner, intent.asset.mint), { owner: derived.destinationOwner, mint: intent.asset.mint, program: intent.asset.program, decimals: intent.asset.decimals })
        if (!exists && intent.allowDestinationAtaCreation) {
          createDestinationAta = true; rentLamports = await this.rpc.getTokenAccountRentLamports()
          if (u64(rentLamports) === 0n || u64(rentLamports) > u64(intent.maxRentPerTransferLamports)) throw new SolanaPaymentPrerequisiteError('fee-rent-budget')
        }
      }
      operation = await this.state.bindDestination(intent.operationId, memberIndex, derived, { createDestinationAta, rentLamports })
    }
    return operation
  }
  async prepare(operationId: string): Promise<SolanaPaymentOperation> {
    let operation = (await this.state.inspect()).operations[operationId]
    if (!operation?.members.every(member => member.destination)) throw new Error('Durable derived quote required')
    if (operation.signed.length) return operation
    await this.verifyChain()
    const paymentAsset = operation.intent.asset
    if (paymentAsset.kind === 'spl') for (const member of operation.members) {
      const exists = await this.rpc.hasInitializedTokenAccount(associatedAccount(member.destination!.destinationOwner, paymentAsset.mint), { owner: member.destination!.destinationOwner, mint: paymentAsset.mint, program: paymentAsset.program, decimals: paymentAsset.decimals })
      if (!exists && !member.createDestinationAta) throw new SolanaPaymentPrerequisiteError('needs-account-and-rent-policy')
      if (!exists && await this.rpc.getTokenAccountRentLamports() !== member.rentLamports) throw new Error('ATA rent quote changed; original authorization requires a new quote')
    }
    operation = await this.state.reserve(operationId, (positions, current) => {
      const used = new Set<string>(), selected: string[][] = current.members.map(() => [])
      // Largest frozen allocations first; each member has an independent source owner.
      const ordered = current.members.map((member, index) => ({ member, index })).sort((a, b) => u64(a.member.amount) > u64(b.member.amount) ? -1 : 1)
      for (const { member, index } of ordered) {
        const fee = u64(current.intent.maxFeePerTransferLamports), rent = member.createDestinationAta ? u64(current.intent.maxRentPerTransferLamports) : 0n
        const candidates = positions.filter(position => !used.has(position.address) && sameAsset(position.asset, current.intent.asset)).sort((a, b) => u64(a.balance) < u64(b.balance) ? -1 : 1)
        let found = false
        for (const source of candidates) {
          const n = u64(member.amount)
          if (current.intent.asset.kind === 'native') {
            if (u64(source.balance) < n + fee) continue
            selected[index] = [source.address]
          } else {
            if (u64(source.balance) < n || source.address !== associatedAccount(source.owner, current.intent.asset.mint)) continue
            const gas = positions.find(position => !used.has(position.address) && position.asset.kind === 'native' && position.address === source.owner && u64(position.balance) >= fee + rent)
            if (!gas) continue
            selected[index] = [source.address, gas.address]
          }
          selected[index].forEach(source => used.add(source)); found = true; break
        }
        if (!found) throw new SolanaPaymentPrerequisiteError(current.intent.asset.kind === 'spl' ? 'needs-native-gas' : 'insufficient-value')
      }
      return selected
    })
    // A crash leaves unsigned reservations reclaimable through releaseUnsigned.
    // Never auto-release in a catch: another same-ID prepare may have persisted signatures.
    const snapshot = await this.state.inspect()
    const lifetime = await this.rpc.getLatestBlockhash()
    if (!Number.isSafeInteger(lifetime.lastValidBlockHeight) || lifetime.lastValidBlockHeight < 0) throw new Error('Invalid blockhash lifetime')
    const originals: SolanaSignedPayment[] = []
    for (const [memberIndex, member] of operation.members.entries()) {
      const source = snapshot.positions[member.sourceAddresses[0]]
      const bytes = await this.custody.signTransfer({ operation, memberIndex, source, ...lifetime, feeCeilingLamports: operation.intent.maxFeePerTransferLamports, createDestinationAta: member.createDestinationAta, rentLamports: member.rentLamports })
      const signed = validateOriginal(bytes, operation, source, lifetime, memberIndex)
      const fee = await this.rpc.getFeeForMessage(VersionedTransaction.deserialize(bytes).message.serialize())
      if (fee === null || u64(fee) > u64(operation.intent.maxFeePerTransferLamports)) throw new Error('Actual transaction fee unavailable or exceeds authorization')
      signed.feeLamports = fee; originals.push(signed)
    }
    // Complete original is durable before any caller can receive it.
    return this.state.persistSigned(operationId, originals)
  }
  expose(operationId: string, proof: { payloadDigest: string }): Promise<SolanaPaymentOperation> { return this.state.expose(operationId, proof) }
  /** Authenticated host ingestion precedes mailbox frontier progress. No RPC is
   * consulted and no funds are credited by this durable evidence operation. */
  async recordIncomingClaim(claim: SolanaReceiptClaim, proof: { payloadDigest: string }): Promise<SolanaIncomingPayment> {
    if (claim.chainIdentifier !== this.state.chainIdentifier) throw new Error('Foreign receipt chain')
    const captured = { ...structuredClone(claim), signedTransaction: Uint8Array.from(claim.signedTransaction) }
    const payloadDigest = proof.payloadDigest
    validateExperimentalSolanaClaim(captured)
    await this.custody.validateReceived(receivedSolanaSigningReference(captured))
    const { signedTransaction, ...publicClaim } = captured
    return this.state.recordIncoming({ ...publicClaim, transaction: Buffer.from(signedTransaction).toString('base64'), payloadDigest, status: 'pending' })
  }
  private async incoming(signature: string): Promise<SolanaIncomingPayment> {
    const payment = (await this.state.inspect()).incoming[signature]
    if (!payment) throw new Error('Unknown incoming original')
    await this.custody.validateReceived(receivedSolanaSigningReference(incomingSolanaReceiptClaim(payment)))
    return payment
  }
  /** Retry the retained original only; expiry, offline status and failed execution
   * never trigger recipient signing, replacement or discarded recovery facts. */
  async rebroadcastIncoming(signature: string): Promise<void> {
    const payment = await this.incoming(signature)
    if (payment.status !== 'pending') return
    await this.verifyChain()
    const actual = await this.rpc.sendRawTransaction(incomingSolanaReceiptClaim(payment).signedTransaction)
    if (actual !== signature) throw new Error('RPC returned another incoming original signature')
  }
  async reconcileIncoming(signature: string): Promise<SolanaIncomingPayment> {
    const payment = await this.incoming(signature)
    if (payment.status !== 'pending') return payment
    await this.verifyChain()
    const outcome = await this.rpc.getFinalizedSignature(signature)
    if (outcome === null) return payment
    const evidence = await this.rpc.getFinalizedTransaction(signature)
    const claim = incomingSolanaReceiptClaim(payment)
    if (!evidence || evidence.slot !== outcome.slot || evidence.err === undefined || !Buffer.from(evidence.signedTransaction).equals(Buffer.from(claim.signedTransaction)) || (outcome.outcome === 'confirmed' ? evidence.err !== null : evidence.err === null)) throw new Error('Inconsistent finalized incoming original evidence')
    if (outcome.outcome === 'failed') return this.state.finalizeIncoming(signature, 'failed', outcome.slot)
    // Use the same captured finalized tuple for verification and the atomic commit.
    const verified = await verifyExperimentalSolanaReceipt(claim, { getGenesisHash: () => this.rpc.getGenesisHash(), getFinalizedTransaction: async () => evidence })
    return this.state.finalizeIncoming(signature, 'confirmed', outcome.slot, { ...verified.position, signingReference: receivedSolanaSigningReference(claim) })
  }
  async incomingProgress(signatures: readonly string[]): Promise<{ status: 'pending' | 'partial' | 'succeeded' | 'failed'; intendedAmount: string; verifiedReceivedAmount: string }> {
    signatures = [...signatures]
    if (!signatures.length || signatures.length > MAX_PAYMENT_MEMBERS || new Set(signatures).size !== signatures.length) throw new Error('Invalid incoming member set')
    const snapshot = await this.state.inspect(), payments = signatures.map(signature => snapshot.incoming[signature])
    if (payments.some(payment => !payment) || payments.some(payment => !sameAsset(payment.asset, payments[0].asset))) throw new Error('Unknown or mixed incoming asset set')
    const total = payments.reduce((sum, payment) => sum + u64(payment.amount), 0n)
    const received = payments.reduce((sum, payment) => sum + (payment.status === 'confirmed' ? u64(payment.amount) : 0n), 0n)
    const pending = payments.some(payment => payment.status === 'pending')
    return { status: pending ? received > 0n ? 'partial' : 'pending' : received === total ? 'succeeded' : received > 0n ? 'partial' : 'failed', intendedAmount: u64(total.toString()).toString(), verifiedReceivedAmount: received.toString() }
  }
  async submit(operationId: string): Promise<void> {
    const operation = (await this.state.inspect()).operations[operationId]
    if (!operation?.payloadDigest) throw new Error('Durable envelope exposure required')
    if (operation.phase === 'settled') return
    await this.verifyChain()
    for (const original of operation.signed) {
      const current = await this.state.inspect()
      if (current.operations[operationId].outcomes[original.signature]) continue
      const source = current.positions[original.sourceAddresses[0]]
      if (!source) throw new Error('Signed original source unavailable')
      const validated = validateOriginal(Uint8Array.from(Buffer.from(original.transaction, 'base64')), operation, source, original, original.memberIndex)
      if (validated.signature !== original.signature || validated.transaction !== original.transaction) throw new Error('Corrupt persisted signed original')
      const signature = await this.rpc.sendRawTransaction(Uint8Array.from(Buffer.from(original.transaction, 'base64')))
      if (signature !== original.signature) throw new Error('RPC returned another transaction signature')
    }
  }
  async reconcile(operationId: string): Promise<'pending' | 'settled'> {
    const operation = (await this.state.inspect()).operations[operationId]
    if (!operation?.signed.length) throw new Error('No signed original set')
    if (operation.phase === 'settled') return 'settled'
    await this.verifyChain()
    for (const original of operation.signed) {
      if (operation.outcomes[original.signature]) continue
      const outcome = await this.rpc.getFinalizedSignature(original.signature)
      if (outcome !== null) {
        if (outcome.outcome === 'confirmed') await verifyExperimentalSolanaReceipt({ chainIdentifier: operation.intent.chainIdentifier, asset: operation.intent.asset, amount: original.amount, destination: original.destination, context: operation.contexts[original.memberIndex], signedTransaction: Uint8Array.from(Buffer.from(original.transaction, 'base64')), signature: original.signature }, this.rpc)
        const evidence = await this.rpc.getFinalizedTransaction(original.signature)
        if (!evidence || evidence.slot !== outcome.slot || !Buffer.from(evidence.signedTransaction).equals(Buffer.from(original.transaction, 'base64')) || (outcome.outcome === 'confirmed' ? evidence.err !== null : evidence.err === null)) throw new Error('Inconsistent finalized original evidence')
        const message = VersionedTransaction.deserialize(evidence.signedTransaction).message
        const keys: string[] = message.staticAccountKeys.map(key => key.toBase58())
        if (evidence.postBalances.length !== keys.length) throw new Error('Missing finalized source balances')
        const remaining: Record<string, string> = {}
        for (const sourceAddress of original.sourceAddresses) {
          const index = keys.indexOf(sourceAddress)
          if (index < 0) throw new Error('Finalized source account missing')
          if (operation.intent.asset.kind === 'native' || sourceAddress === original.sourceOwner) remaining[sourceAddress] = u64(evidence.postBalances[index]).toString()
          else {
            const asset = operation.intent.asset
            const rows = evidence.postTokenBalances.filter(row => row.accountIndex === index)
            if (rows.length !== 1 || rows[0].owner !== original.sourceOwner || rows[0].mint !== asset.mint || rows[0].program !== asset.program || rows[0].decimals !== asset.decimals) throw new Error('Missing finalized source token balance')
            remaining[sourceAddress] = u64(rows[0].amount).toString()
          }
        }
        await this.state.settle(operationId, original.signature, outcome.outcome, outcome.slot, remaining)
      }
    }
    // Expiry alone never releases claims or authorizes a replacement.
    return (await this.state.inspect()).operations[operationId].phase === 'settled' ? 'settled' : 'pending'
  }
  async progress(operationId: string): Promise<{ status: 'pending' | 'partial' | 'succeeded' | 'failed'; intendedAmount: string; verifiedReceivedAmount: string }> {
    const operation = (await this.state.inspect()).operations[operationId]
    if (!operation) throw new Error('Unknown operation')
    const received = operation.signed.reduce((sum, original) => sum + (operation.outcomes[original.signature] === 'confirmed' ? u64(original.amount) : 0n), 0n)
    const status = operation.phase === 'settled' ? received === u64(operation.intent.amount) ? 'succeeded' : received > 0n ? 'partial' : 'failed' : received > 0n ? 'partial' : 'pending'
    return { status, intendedAmount: operation.intent.amount, verifiedReceivedAmount: received.toString() }
  }
}
