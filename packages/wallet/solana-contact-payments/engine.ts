import { VersionedTransaction } from '@solana/web3.js'
import { MAX_PAYMENT_MEMBERS } from '@frank/codec'
import protocol from '../../../docs/protocol/chains/v1.json'
import { SolanaPaymentState, paymentRequest, validateSolanaPaymentRequest } from './state'
import { u64 } from './amount'
import { associatedAccount, validateOriginal } from './transaction-policy'
import { incomingSolanaReceiptClaim, receivedSolanaSigningReference, validateExperimentalSolanaClaim, verifyExperimentalSolanaReceipt, type SolanaReceiptClaim, type SolanaReceiptRpc } from './receipt'
import type { SolanaIncomingPayment, SolanaPaymentAsset, SolanaPaymentDestination, SolanaPaymentDraftMember, SolanaPaymentPlan, SolanaPaymentRequest, SolanaPaymentOperation, SolanaSignedPayment, SolanaSigningReference, SolanaSpendPosition } from './types'

function sameAsset(a: SolanaPaymentAsset, b: SolanaPaymentAsset): boolean {
  return a.kind === 'native' ? b.kind === 'native' : b.kind === 'spl' && a.mint === b.mint && a.program === b.program && a.decimals === b.decimals
}
export interface ExperimentalSolanaPaymentCustody {
  deriveDestination(operation: Readonly<SolanaPaymentPlan>, memberIndex: number): Promise<SolanaPaymentDestination>
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
export interface ExperimentalSolanaPaymentConstruction {
  /** Domain-separated representative message; estimation only, never approval. */
  feeProbe(request: { intent: SolanaPaymentRequest; source: SolanaSpendPosition; blockhash: string; createDestinationAta: boolean }): Promise<Uint8Array>
  unsignedTransfer(request: { operation: SolanaPaymentOperation; memberIndex: number; source: SolanaSpendPosition; blockhash: string }): Promise<Uint8Array>
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
  constructor(private readonly state: SolanaPaymentState, private readonly custody: ExperimentalSolanaPaymentCustody, private readonly rpc: ExperimentalSolanaPaymentRpc, private readonly construction: ExperimentalSolanaPaymentConstruction, private readonly maxMembers = MAX_PAYMENT_MEMBERS) {
    if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > MAX_PAYMENT_MEMBERS) throw new Error('Invalid payment member policy')
  }
  private async verifyChain(): Promise<void> {
    const facts = protocol.chains.find(row => row.id === this.state.chainIdentifier && row.family === 'solana')
    const expected = facts?.identity_probes.find(probe => probe.kind === 'genesis-hash')?.expected
    if (!expected || await this.rpc.getGenesisHash() !== expected) throw new Error('Solana RPC chain identity mismatch')
  }
  async quoteReview(request: SolanaPaymentRequest): Promise<SolanaPaymentOperation> {
    request = structuredClone(request)
    validateSolanaPaymentRequest(request, this.state.chainIdentifier)
    const snapshot = await this.state.inspect()
    let draft = snapshot.operations[request.operationId]
    if (draft && JSON.stringify(paymentRequest(draft.intent)) !== JSON.stringify(paymentRequest(request))) throw new Error('Operation ID already binds another intent')
    if (draft && draft.phase !== 'quoting') return draft
    await this.verifyChain()
    const lifetime = await this.rpc.getLatestBlockhash()
    if (!Number.isSafeInteger(lifetime.lastValidBlockHeight) || lifetime.lastValidBlockHeight < 0) throw new Error('Invalid blockhash lifetime')
    if (!draft) {
      const positions = Object.values(snapshot.positions).filter(position => !position.reservedBy)
      const estimatedRent = request.asset.kind === 'spl' && request.allowDestinationAtaCreation ? u64(await this.rpc.getTokenAccountRentLamports()) : 0n
      if (request.asset.kind === 'spl' && request.allowDestinationAtaCreation && estimatedRent === 0n) throw new Error('ATA rent unavailable')
      const eligible: { source: SolanaSpendPosition; value: bigint; fee: string; sources: string[] }[] = []
      let tokenWithoutGas = false
      for (const source of positions.filter(position => sameAsset(position.asset, request.asset))) {
        const probe = await this.construction.feeProbe({ intent: request, source, blockhash: lifetime.blockhash, createDestinationAta: request.asset.kind === 'spl' && request.allowDestinationAtaCreation })
        const fee = await this.rpc.getFeeForMessage(probe)
        if (fee === null) throw new Error('Unsigned fee estimation unavailable')
        const feeValue = u64(fee)
        let value = u64(source.balance), sources = [source.address]
        if (request.asset.kind === 'native') value = value > feeValue ? value - feeValue : 0n
        else {
          const gas = positions.find(position => position.asset.kind === 'native' && position.address === source.owner && u64(position.balance) >= feeValue + estimatedRent)
          if (!gas) { tokenWithoutGas = true; continue }
          sources = [source.address, gas.address]
        }
        if (value > 0n) eligible.push({ source, value, fee, sources })
      }
      const smallFirst = [...eligible].sort((a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : a.source.address.localeCompare(b.source.address))
      const allocate = (sources: typeof eligible): SolanaPaymentDraftMember[] | undefined => {
        let remaining = u64(request.amount)
        const members: SolanaPaymentDraftMember[] = []
        for (const source of sources.slice(0, this.maxMembers)) {
          const amount = source.value < remaining ? source.value : remaining
          members.push({ amount: amount.toString(), plannedSources: source.sources, estimatedFeeLamports: source.fee })
          remaining -= amount
          if (remaining === 0n) return members
        }
        return undefined
      }
      const largeFirst = [...smallFirst].sort((a, b) => a.value > b.value ? -1 : a.value < b.value ? 1 : a.source.address.localeCompare(b.source.address))
      const members = allocate(smallFirst) ?? allocate(largeFirst)
      if (!members) throw new SolanaPaymentPrerequisiteError(eligible.reduce((sum, source) => sum + source.value, 0n) >= u64(request.amount) ? 'member-limit' : tokenWithoutGas ? 'needs-native-gas' : 'insufficient-value')
      draft = await this.state.beginReview(request, members)
      if (draft.phase !== 'quoting') return draft
    }
    // This durable draft is the only owner of contexts and allocation. It is
    // never returned as a complete review and holds no spend reservation.
    for (let index = 0; index < draft.members.length; index++) {
      const derived = await this.custody.deriveDestination(draft, index)
      draft = await this.state.bindReviewDestination(request.operationId, index, derived)
    }
    const current = await this.state.inspect()
    const members: SolanaPaymentOperation['members'] = []
    for (const member of draft.members) {
      const source = current.positions[member.plannedSources[0]]
      if (!source || member.plannedSources.some(address => !current.positions[address] || current.positions[address].reservedBy)) throw new Error('Review source is no longer available')
      let createDestinationAta = false, rentLamports = '0'
      if (request.asset.kind === 'spl') {
        const exists = await this.rpc.hasInitializedTokenAccount(associatedAccount(member.destination!.destinationOwner, request.asset.mint), { owner: member.destination!.destinationOwner, mint: request.asset.mint, program: request.asset.program, decimals: request.asset.decimals })
        if (!exists) {
          if (!request.allowDestinationAtaCreation) throw new SolanaPaymentPrerequisiteError('needs-account-and-rent-policy')
          createDestinationAta = true; rentLamports = await this.rpc.getTokenAccountRentLamports()
          if (u64(rentLamports) === 0n) throw new Error('ATA rent unavailable')
        }
      }
      const maxNativeDebitLamports = (u64(member.estimatedFeeLamports) + u64(rentLamports) + (request.asset.kind === 'native' ? u64(member.amount) : 0n)).toString()
      u64(maxNativeDebitLamports)
      members.push({ amount: member.amount, destination: member.destination, sourceAddresses: [], createDestinationAta, rentLamports, maxFeeLamports: member.estimatedFeeLamports, maxRentLamports: rentLamports, maxNativeDebitLamports, review: { sourceAddresses: [...member.plannedSources], ...lifetime, message: '', feeLamports: member.estimatedFeeLamports, rentLamports } })
    }
    const maxFeeLamports = members.reduce((sum, member) => sum + u64(member.maxFeeLamports), 0n).toString()
    const maxRentLamports = members.reduce((sum, member) => sum + u64(member.maxRentLamports), 0n).toString()
    const maxNativeDebitLamports = members.reduce((sum, member) => sum + u64(member.maxNativeDebitLamports), 0n).toString()
    u64(maxFeeLamports); u64(maxRentLamports); u64(maxNativeDebitLamports)
    const operation: SolanaPaymentOperation = { intent: { ...request, maxFeeLamports, maxRentLamports, maxNativeDebitLamports }, contexts: draft.contexts, members, phase: 'quoted', sourceAddresses: [], signed: [], outcomes: {} }
    for (const [memberIndex, member] of members.entries()) {
      const source = current.positions[member.review.sourceAddresses[0]]
      const unsigned = await this.construction.unsignedTransfer({ operation, memberIndex, source, blockhash: lifetime.blockhash })
      const exactFee = await this.rpc.getFeeForMessage(unsigned)
      if (exactFee === null || u64(exactFee) !== u64(member.maxFeeLamports)) throw new Error('Exact unsigned fee differs from planning estimate; unsigned review remains incomplete')
      member.review.message = Buffer.from(unsigned).toString('base64')
      this.assertMemberFunds(operation, memberIndex, Object.values(current.positions))
    }
    return this.state.finalizeReview(operation)
  }
  private assertMemberFunds(operation: SolanaPaymentOperation, memberIndex: number, positions: readonly SolanaSpendPosition[]): void {
    const member = operation.members[memberIndex], addresses = member.review.sourceAddresses
    const source = positions.find(position => position.address === addresses[0])
    if (!source || !sameAsset(source.asset, operation.intent.asset) || source.reservedBy && source.reservedBy !== operation.intent.operationId) throw new Error('Approved source unavailable')
    if (operation.intent.asset.kind === 'native') {
      if (source.owner !== source.address || u64(source.balance) < u64(member.maxNativeDebitLamports)) throw new SolanaPaymentPrerequisiteError('insufficient-value')
    } else {
      const gas = positions.find(position => position.address === addresses[1])
      if (source.address !== associatedAccount(source.owner, operation.intent.asset.mint) || u64(source.balance) < u64(member.amount) || !gas || gas.asset.kind !== 'native' || gas.owner !== source.owner || gas.address !== source.owner || gas.reservedBy && gas.reservedBy !== operation.intent.operationId || u64(gas.balance) < u64(member.maxNativeDebitLamports)) throw new SolanaPaymentPrerequisiteError('needs-native-gas')
    }
  }
  async prepare(operationId: string): Promise<SolanaPaymentOperation> {
    let operation = (await this.state.inspect()).operations[operationId]
    if (!operation || operation.phase === 'quoting' || !operation.members.every(member => member.destination)) throw new Error('Complete reviewed operation required')
    if (operation.signed.length) return operation
    await this.verifyChain()
    const lifetime = await this.rpc.getLatestBlockhash()
    if (!Number.isSafeInteger(lifetime.lastValidBlockHeight) || lifetime.lastValidBlockHeight < 0) throw new Error('Invalid blockhash lifetime')
    const snapshot = await this.state.inspect(), messages: Uint8Array[] = [], fees: string[] = []
    for (const [memberIndex, member] of operation.members.entries()) {
      this.assertMemberFunds(operation, memberIndex, Object.values(snapshot.positions))
      if (operation.intent.asset.kind === 'spl') {
        const asset = operation.intent.asset
        const exists = await this.rpc.hasInitializedTokenAccount(associatedAccount(member.destination!.destinationOwner, asset.mint), { owner: member.destination!.destinationOwner, mint: asset.mint, program: asset.program, decimals: asset.decimals })
        if (!exists && !member.createDestinationAta) throw new SolanaPaymentPrerequisiteError('needs-account-and-rent-policy')
        if (!exists && u64(await this.rpc.getTokenAccountRentLamports()) > u64(member.maxRentLamports)) throw new Error('ATA rent exceeds approved review')
      }
      const message = await this.construction.unsignedTransfer({ operation, memberIndex, source: snapshot.positions[member.review.sourceAddresses[0]], blockhash: lifetime.blockhash })
      const fee = await this.rpc.getFeeForMessage(message)
      if (fee === null || u64(fee) > u64(member.maxFeeLamports)) throw new Error('Actual transaction fee unavailable or exceeds authorization')
      messages.push(message); fees.push(fee)
    }
    operation = await this.state.reserve(operationId, (positions, current) => {
      for (let index = 0; index < current.members.length; index++) this.assertMemberFunds(current, index, positions)
      return current.members.map(member => member.review.sourceAddresses)
    })
    if (operation.signed.length) return operation
    const reserved = await this.state.inspect(), originals: SolanaSignedPayment[] = []
    for (const [memberIndex, member] of operation.members.entries()) {
      const source = reserved.positions[member.sourceAddresses[0]]
      const bytes = await this.custody.signTransfer({ operation, memberIndex, source, ...lifetime, feeCeilingLamports: member.maxFeeLamports, createDestinationAta: member.createDestinationAta, rentLamports: member.rentLamports })
      const signed = validateOriginal(bytes, operation, source, lifetime, memberIndex)
      if (Buffer.compare(Buffer.from(VersionedTransaction.deserialize(bytes).message.serialize()), Buffer.from(messages[memberIndex])) !== 0) throw new Error('Signer changed exact approved unsigned message')
      signed.feeLamports = fees[memberIndex]; originals.push(signed)
    }
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
    if (!operation || operation.phase === 'quoting' || !operation.payloadDigest) throw new Error('Durable envelope exposure required')
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
