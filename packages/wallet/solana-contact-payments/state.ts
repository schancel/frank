import { PublicKey, PACKET_DATA_SIZE } from '@solana/web3.js'
import { u64 } from './amount'
import { incomingSolanaReceiptClaim, receivedSolanaSigningReference, validateExperimentalSolanaClaim } from './receipt'
import { associatedAccount, validateOriginal } from './transaction-policy'
import { MAX_PAYMENT_MEMBERS } from '@frank/codec'
import protocol from '../../../docs/protocol/chains/v1.json'
import type { SolanaIncomingPayment, SolanaPaymentAsset, SolanaPaymentDestination, SolanaPaymentIntent, SolanaPaymentOperation, SolanaPaymentPersistence, SolanaPaymentSnapshot, SolanaSignedPayment, SolanaSpendPosition } from './types'

const CLASSIC_SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export function address(value: string): void {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44 || new PublicKey(value).toBase58() !== value) throw new Error('Noncanonical Solana address')
}
function hex32(value: string): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Expected lowercase bytes32')
}
function slot(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Solana slot/height')
}
function asset(value: SolanaPaymentAsset): void {
  if (!value || typeof value !== 'object') throw new Error('Invalid asset')
  if (value.kind === 'native' && Object.keys(value).length === 1) return
  if (value.kind !== 'spl' || Object.keys(value).sort().join() !== 'decimals,kind,mint,program' || value.program !== CLASSIC_SPL || !Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255) throw new Error('Only native and classic SPL are supported')
  address(value.mint)
}
function same(a: unknown, b: unknown): boolean {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
    return value
  }
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}
function intent(value: SolanaPaymentIntent, chain: string): void {
  if (Object.keys(value).sort().join() !== ['amount', 'asset', 'chainIdentifier', 'maxFeeLamports', 'maxNativeDebitLamports', 'operationId', 'recipientSpendPoint', 'maxFeePerTransferLamports', 'maxRentPerTransferLamports', 'maxRentLamports', 'allowDestinationAtaCreation'].sort().join() || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.operationId) || value.chainIdentifier !== chain) throw new Error('Invalid immutable payment intent')
  address(value.recipientSpendPoint); asset(value.asset)
  if (u64(value.amount) === 0n) throw new Error('Payment amount must be positive')
  u64(value.maxFeeLamports); u64(value.maxNativeDebitLamports)
  u64(value.maxFeePerTransferLamports); u64(value.maxRentPerTransferLamports); u64(value.maxRentLamports)
  if (typeof value.allowDestinationAtaCreation !== 'boolean' || (value.asset.kind === 'native' && (value.allowDestinationAtaCreation || value.maxRentLamports !== '0' || value.maxRentPerTransferLamports !== '0'))) throw new Error('Invalid native rent policy')
}
function position(value: SolanaSpendPosition): void {
  address(value.address); address(value.owner); asset(value.asset); u64(value.balance); slot(value.observedSlot)
  const reference = value.signingReference
  if (!reference || (value.asset.kind === 'native' && value.owner !== value.address)) throw new Error('Invalid spend position')
  if (reference.kind === 'primary' && Object.keys(reference).length === 1) return
  if (reference.kind !== 'received' || Object.keys(reference).sort().join() !== 'descriptor,kind') throw new Error('Invalid custody reference')
  const d = reference.descriptor
  address(d.recipientSpendPoint); address(d.ephemeralPoint); address(d.publicKey); asset(d.asset); hex32(d.cryptoOperationId32); hex32(d.derivationContext32)
  if (!Number.isInteger(d.memberIndex) || d.memberIndex < 0 || d.memberIndex >= MAX_PAYMENT_MEMBERS || u64(d.recipientAmount) === 0n || d.publicKey !== value.owner) throw new Error('Invalid received descriptor reference')
}

/** One authoritative inventory and reservation owner. No network wait occurs in an
 * atomic update, and unsigned quotes reserve no account. No custody initialization. */
export class SolanaPaymentState {
  constructor(readonly walletId: string, readonly chainIdentifier: string, private readonly persistence: SolanaPaymentPersistence, private readonly random32: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(32))) {
    if (!walletId || !protocol.chains.some(row => row.id === chainIdentifier && row.family === 'solana')) throw new Error('Canonical Solana wallet scope required')
  }

  private validateIncoming(key: string, payment: SolanaIncomingPayment): void {
    if (Object.keys(payment).sort().join() !== ['signature','chainIdentifier','asset','amount','destination','context','transaction','payloadDigest','status',...(payment.finalizedSlot === undefined ? [] : ['finalizedSlot']),...(payment.credit === undefined ? [] : ['credit'])].sort().join() || key !== payment.signature || payment.chainIdentifier !== this.chainIdentifier || !['pending', 'confirmed', 'failed'].includes(payment.status)) throw new Error('Invalid incoming claim ownership')
    hex32(payment.payloadDigest)
    if (typeof payment.transaction !== 'string' || payment.transaction.length > Math.ceil(PACKET_DATA_SIZE / 3) * 4 || Buffer.from(payment.transaction, 'base64').toString('base64') !== payment.transaction) throw new Error('Invalid incoming original encoding')
    validateExperimentalSolanaClaim(incomingSolanaReceiptClaim(payment))
    if (payment.status === 'pending') {
      if (payment.finalizedSlot !== undefined || payment.credit !== undefined) throw new Error('Pending claim cannot assert finality or credit')
    } else {
      slot(payment.finalizedSlot!)
      if (payment.status === 'confirmed' ? !['imported', 'already-imported', 'retired'].includes(payment.credit ?? '') : payment.credit !== undefined) throw new Error('Invalid incoming finality credit')
    }
  }
  private load(value: unknown): SolanaPaymentSnapshot {
    if (value === undefined) return { format: 3, walletId: this.walletId, chainIdentifier: this.chainIdentifier, positions: {}, retiredThrough: {}, operations: {}, incoming: {} }
    if (!value || typeof value !== 'object') throw new Error('Invalid Solana payment state')
    const state = structuredClone(value) as SolanaPaymentSnapshot
    if (state.format !== 3 || state.walletId !== this.walletId || state.chainIdentifier !== this.chainIdentifier || !state.positions || !state.operations || !state.retiredThrough || !state.incoming || Object.keys(state).sort().join() !== 'chainIdentifier,format,incoming,operations,positions,retiredThrough,walletId') throw new Error('Unsupported or foreign Solana payment state')
    for (const [key, through] of Object.entries(state.retiredThrough)) { address(key); slot(through) }
    for (const [key, item] of Object.entries(state.positions)) {
      position(item)
      if (item.signingReference.kind === 'received' && item.signingReference.descriptor.chainIdentifier !== this.chainIdentifier) throw new Error('Foreign received descriptor chain')
      const retirement = state.retiredThrough[key] ?? -1
      if (retirement > item.observedSlot || (retirement === item.observedSlot && !Object.values(state.operations).some(operation => operation.outcomes[item.postSpendSignature ?? ''] && operation.signed.some(original => original.signature === item.postSpendSignature && original.sourceAddresses.includes(key))))) throw new Error('Retired observation cannot become spendable')
      if (key !== item.address || (item.reservedBy !== undefined && !state.operations[item.reservedBy]?.sourceAddresses.includes(key))) throw new Error('Invalid reservation ownership')
    }
    for (const [key, operation] of Object.entries(state.operations)) {
      intent(operation.intent, this.chainIdentifier)
      if (key !== operation.intent.operationId || !['quoted', 'reserved', 'signed', 'exposed', 'settled'].includes(operation.phase) || !operation.members.length || operation.members.length > MAX_PAYMENT_MEMBERS || operation.contexts.length !== operation.members.length) throw new Error('Invalid operation')
      let total = 0n
      for (const [index, member] of operation.members.entries()) {
        const context = operation.contexts[index]
        hex32(context.cryptoOperationId32); hex32(context.derivationContext32)
        if (context.memberIndex !== index || context.cryptoOperationId32 === context.derivationContext32 || u64(member.amount) === 0n || u64(member.rentLamports) > u64(operation.intent.maxRentPerTransferLamports) || typeof member.createDestinationAta !== 'boolean' || (member.createDestinationAta && (!operation.intent.allowDestinationAtaCreation || operation.intent.asset.kind !== 'spl' || member.rentLamports === '0')) || (!member.createDestinationAta && member.rentLamports !== '0')) throw new Error('Invalid member authorization')
        total += u64(member.amount)
        if (member.destination) { address(member.destination.recipientPoint); address(member.destination.ephemeralPoint); address(member.destination.destinationOwner); if (member.destination.recipientPoint !== operation.intent.recipientSpendPoint) throw new Error('Foreign recipient derivation') }
      }
      const fees = BigInt(operation.members.length) * u64(operation.intent.maxFeePerTransferLamports)
      const rents = operation.members.reduce((sum, member) => sum + (member.createDestinationAta ? u64(operation.intent.maxRentPerTransferLamports) : 0n), 0n)
      if (total !== u64(operation.intent.amount) || fees > u64(operation.intent.maxFeeLamports) || rents > u64(operation.intent.maxRentLamports) || fees + rents + (operation.intent.asset.kind === 'native' ? total : 0n) > u64(operation.intent.maxNativeDebitLamports)) throw new Error('Member set exceeds total authorization')
      if (new Set(operation.sourceAddresses).size !== operation.sourceAddresses.length) throw new Error('Duplicate reservations')
      if (!same(operation.members.flatMap(member => member.sourceAddresses), operation.sourceAddresses)) throw new Error('Member reservation set mismatch')
      const settledSources = new Set(operation.signed.filter(original => operation.outcomes[original.signature]).flatMap(original => original.sourceAddresses))
      for (const source of operation.sourceAddresses) if (!settledSources.has(source) && state.positions[source]?.reservedBy !== key) throw new Error('Missing source reservation')
      if ((operation.phase === 'quoted' && (operation.sourceAddresses.length || operation.signed.length)) || (['signed', 'exposed', 'settled'].includes(operation.phase) && operation.signed.length !== operation.members.length)) throw new Error('Incomplete operation phase')
      if (operation.payloadDigest !== undefined) hex32(operation.payloadDigest)
      if (operation.phase === 'exposed' && !operation.payloadDigest) throw new Error('Missing durable envelope binding')
      for (const [index, original] of operation.signed.entries()) {
        slot(original.lastValidBlockHeight); address(original.blockhash); address(original.sourceOwner)
        const member = operation.members[index]
        if (original.memberIndex !== index || !member.destination || !same(original.destination, member.destination) || original.amount !== member.amount || !same(original.sourceAddresses, member.sourceAddresses) || u64(original.feeLamports) > u64(operation.intent.maxFeePerTransferLamports) || original.rentLamports !== member.rentLamports) throw new Error('Corrupt signed original binding')
        const raw = Buffer.from(original.transaction, 'base64')
        if (raw.toString('base64') !== original.transaction) throw new Error('Corrupt persisted signed original')
        const source = state.positions[original.sourceAddresses[0]] ?? { address: original.sourceAddresses[0], owner: original.sourceOwner, asset: operation.intent.asset, balance: '0', observedSlot: 0, signingReference: { kind: 'primary' as const } }
        if (source.owner !== original.sourceOwner) throw new Error('Corrupt original signer ownership')
        if (validateOriginal(raw, operation, source, original, index).signature !== original.signature) throw new Error('Corrupt persisted signed original')
      }
      for (const [signature, outcome] of Object.entries(operation.outcomes)) if (!operation.signed.some(original => original.signature === signature) || !['confirmed', 'failed'].includes(outcome)) throw new Error('Foreign finality outcome')
      if (operation.phase === 'settled' && !operation.signed.every(original => operation.outcomes[original.signature])) throw new Error('Missing finality evidence')
    }
    for (const [key, payment] of Object.entries(state.incoming)) this.validateIncoming(key, payment)
    return state
  }
  async inspect(): Promise<SolanaPaymentSnapshot> { return this.load(await this.persistence.read()) }
  private update<T>(mutate: (state: SolanaPaymentSnapshot) => T): Promise<T> {
    return this.persistence.update(previous => {
      const state = this.load(previous)
      const result = mutate(state)
      this.load(state)
      return { value: state, result: structuredClone(result) }
    })
  }
  quote(input: SolanaPaymentIntent, amounts: readonly string[] = [input.amount]): Promise<SolanaPaymentOperation> {
    intent(input, this.chainIdentifier)
    const immutable = structuredClone(input)
    amounts = [...amounts]
    return this.update(state => {
      const prior = state.operations[immutable.operationId]
      if (prior) { if (!same(prior.intent, immutable)) throw new Error('Operation ID already binds another intent'); return prior }
      const random = () => { const bytes = this.random32(); if (bytes.length !== 32) throw new Error('Random context must contain 32 bytes'); return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('') }
      const operation: SolanaPaymentOperation = { intent: immutable, contexts: amounts.map((_, memberIndex) => ({ cryptoOperationId32: random(), derivationContext32: random(), memberIndex })), members: amounts.map(amount => ({ amount, sourceAddresses: [], rentLamports: '0', createDestinationAta: false })), phase: 'quoted', sourceAddresses: [], signed: [], outcomes: {} }
      state.operations[immutable.operationId] = operation
      return operation
    })
  }
  bindDestination(operationId: string, memberIndex: number, destination: SolanaPaymentDestination, policy: { createDestinationAta: boolean; rentLamports: string } = { createDestinationAta: false, rentLamports: '0' }): Promise<SolanaPaymentOperation> {
    address(destination.recipientPoint); address(destination.ephemeralPoint); address(destination.destinationOwner)
    const captured = structuredClone(destination)
    return this.update(state => {
      const operation = state.operations[operationId]
      const member = operation?.members[memberIndex]
      if (!member || captured.recipientPoint !== operation.intent.recipientSpendPoint) throw new Error('Foreign derivation destination')
      if (member.destination && (!same(member.destination, captured) || member.createDestinationAta !== policy.createDestinationAta || member.rentLamports !== policy.rentLamports)) throw new Error('Derivation destination is immutable')
      member.destination = captured; member.createDestinationAta = policy.createDestinationAta; member.rentLamports = policy.rentLamports
      return operation
    })
  }
  /** Host supplies authenticated chain observations; unavailable reserved positions
   * cannot be overwritten by refresh, sync, or a concurrent receipt import. */
  observe(input: SolanaSpendPosition): Promise<void> {
    position(input)
    if (input.reservedBy !== undefined) throw new Error('Observation cannot create a reservation')
    if (input.postSpendSignature !== undefined) throw new Error('Only finalized settlement owns post-spend observations')
    input = structuredClone(input)
    return this.update(state => {
      const prior = state.positions[input.address]
      if ((state.retiredThrough[input.address] ?? -1) >= input.observedSlot) throw new Error('Observation predates finalized spend retirement')
      if (prior?.reservedBy) throw new Error('Position is reserved')
      if (prior && (input.observedSlot < prior.observedSlot || input.owner !== prior.owner || !same(input.asset, prior.asset) || !same(input.signingReference, prior.signingReference))) throw new Error('Stale or conflicting observation')
      state.positions[input.address] = structuredClone(input)
    })
  }
  /** Validated authenticated evidence is durable independently of RPC availability.
   * This creates no inventory position or reservation. */
  recordIncoming(input: SolanaIncomingPayment): Promise<SolanaIncomingPayment> {
    input = structuredClone(input)
    this.validateIncoming(input.signature, input)
    if (input.status !== 'pending' || input.finalizedSlot !== undefined || input.credit !== undefined) throw new Error('Only pending original claims may be recorded')
    return this.update(state => {
      const prior = state.incoming[input.signature]
      if (prior) {
        const { status: _status, finalizedSlot: _slot, credit: _credit, ...immutable } = prior
        const { status: _pending, ...captured } = input
        if (!same(immutable, captured)) throw new Error('Incoming original claim is immutable')
        return prior
      }
      state.incoming[input.signature] = input
      return input
    })
  }
  /** Finality and optional inventory credit share the existing authority commit.
   * Retained finalized claims are never re-imported after spending or receipt replay. */
  finalizeIncoming(signature: string, outcome: 'confirmed' | 'failed', finalizedSlot: number, input?: SolanaSpendPosition): Promise<SolanaIncomingPayment> {
    slot(finalizedSlot)
    input = input === undefined ? undefined : structuredClone(input)
    return this.update(state => {
      const payment = state.incoming[signature]
      if (!payment) throw new Error('Unknown incoming original')
      if (payment.status !== 'pending') {
        if (payment.status !== outcome || payment.finalizedSlot !== finalizedSlot) throw new Error('Conflicting incoming finality')
        return payment
      }
      if (outcome === 'failed') {
        if (input !== undefined) throw new Error('Failed incoming claim cannot credit inventory')
      } else {
        if (!input) throw new Error('Verified incoming position required')
        position(input)
        const claim = incomingSolanaReceiptClaim(payment)
        const expectedAddress = claim.asset.kind === 'native' ? claim.destination.destinationOwner : associatedAccount(claim.destination.destinationOwner, claim.asset.mint)
        if (input.address !== expectedAddress || input.owner !== claim.destination.destinationOwner || !same(input.asset, claim.asset) || !same(input.signingReference, receivedSolanaSigningReference(claim)) || input.observedSlot !== finalizedSlot || input.reservedBy !== undefined || input.postSpendSignature !== undefined || u64(input.balance) < u64(claim.amount)) throw new Error('Incoming finality position does not bind original claim')
        if ((state.retiredThrough[input.address] ?? -1) >= input.observedSlot) payment.credit = 'retired'
        else {
          const prior = state.positions[input.address]
          if (prior && (prior.owner !== input.owner || !same(prior.asset, input.asset) || !same(prior.signingReference, input.signingReference))) throw new Error('Conflicting received descriptor')
          if (prior && (prior.observedSlot >= input.observedSlot || prior.reservedBy)) payment.credit = 'already-imported'
          else { state.positions[input.address] = input; payment.credit = 'imported' }
        }
      }
      payment.status = outcome; payment.finalizedSlot = finalizedSlot
      return payment
    })
  }
  /** Selection executes against current inventory inside the durable transaction. */
  reserve(operationId: string, select: (positions: readonly SolanaSpendPosition[], operation: Readonly<SolanaPaymentOperation>) => readonly (readonly string[])[]): Promise<SolanaPaymentOperation> {
    return this.update(state => {
      const operation = state.operations[operationId]
      if (!operation) throw new Error('Unknown operation')
      if (operation.phase !== 'quoted') return operation
      const selections = select(structuredClone(Object.values(state.positions).filter(p => !p.reservedBy)), structuredClone(operation))
      if (selections.length !== operation.members.length) throw new Error('Incomplete member reservations')
      const sources = selections.flatMap(sources => [...sources])
      if (!sources.length || new Set(sources).size !== sources.length) throw new Error('Invalid source selection')
      for (const source of sources) if (!state.positions[source] || state.positions[source].reservedBy) throw new Error('Source unavailable')
      for (const source of sources) state.positions[source].reservedBy = operationId
      selections.forEach((sources, index) => { operation.members[index].sourceAddresses = [...sources] })
      operation.sourceAddresses = sources; operation.phase = 'reserved'
      return operation
    })
  }
  /** Only an unsigned, unexposed preparation can relinquish its claims. */
  releaseUnsigned(operationId: string): Promise<void> {
    return this.update(state => {
      const operation = state.operations[operationId]
      if (!operation || operation.phase === 'quoted') return
      if (operation.phase !== 'reserved' || operation.signed.length) throw new Error('Signed operation requires chain reconciliation')
      for (const source of operation.sourceAddresses) delete state.positions[source].reservedBy
      for (const member of operation.members) member.sourceAddresses = []
      operation.sourceAddresses = []; operation.phase = 'quoted'
    })
  }
  persistSigned(operationId: string, signed: SolanaSignedPayment[]): Promise<SolanaPaymentOperation> {
    signed = structuredClone(signed)
    return this.update(state => {
      const operation = state.operations[operationId]
      if (!operation) throw new Error('Unknown operation')
      if (operation.signed.length) { if (!same(operation.signed, signed)) throw new Error('Signed original set is immutable'); return operation }
      if (operation.phase !== 'reserved' || signed.length !== operation.members.length || !same(signed.flatMap(original => original.sourceAddresses), operation.sourceAddresses)) throw new Error('Signed set does not bind reserved intent')
      operation.signed = structuredClone(signed); operation.phase = 'signed'
      return operation
    })
  }
  /** Trusted host invokes only after generic onEnvelopeDurable; ciphertext stays
   * with that owner. Digest is an exposure fact, never a crypto derivation input. */
  expose(operationId: string, proof: { payloadDigest: string }): Promise<SolanaPaymentOperation> {
    hex32(proof.payloadDigest)
    const payloadDigest = proof.payloadDigest
    return this.update(state => {
      const operation = state.operations[operationId]
      if (!operation || !['signed', 'exposed', 'settled'].includes(operation.phase)) throw new Error('Signed original set must be durable before exposure')
      if (operation.payloadDigest && operation.payloadDigest !== payloadDigest) throw new Error('Operation already binds another envelope')
      operation.payloadDigest = payloadDigest
      if (operation.phase === 'signed') operation.phase = 'exposed'
      return operation
    })
  }
  /** Finalized chain evidence retires original source observations; refreshed
   * balances must be observed separately. An error/timeout is never finality. */
  settle(operationId: string, signature: string, outcome: 'confirmed' | 'failed', finalizedSlot: number, remaining?: Readonly<Record<string, string>>): Promise<void> {
    slot(finalizedSlot)
    remaining = remaining === undefined ? undefined : structuredClone(remaining)
    return this.update(state => {
      const operation = state.operations[operationId]
      if (!operation?.signed.some(item => item.signature === signature)) throw new Error('Unknown signed original')
      const prior = operation.outcomes[signature]
      if (prior && prior !== outcome) throw new Error('Conflicting final evidence')
      if (prior) return
      operation.outcomes[signature] = outcome
      const original = operation.signed.find(item => item.signature === signature)!
      if (remaining && Object.keys(remaining).some(source => !original.sourceAddresses.includes(source))) throw new Error('Foreign post-spend balance')
      for (const source of original.sourceAddresses) {
        const priorPosition = state.positions[source]
        if (!priorPosition || finalizedSlot < priorPosition.observedSlot) throw new Error('Final evidence predates source observation')
        state.retiredThrough[source] = Math.max(state.retiredThrough[source] ?? 0, finalizedSlot)
        if (remaining?.[source] !== undefined && u64(remaining[source]) > 0n) {
          state.positions[source] = { ...priorPosition, balance: remaining[source], observedSlot: finalizedSlot, postSpendSignature: signature }
          delete state.positions[source].reservedBy
        } else delete state.positions[source]
      }
      if (operation.signed.every(item => operation.outcomes[item.signature])) operation.phase = 'settled'
    })
  }
}
