import { Interface, getAddress } from 'ethers'
import type { RecordStore } from '../storage/evm-coin-store'
import type { EvmNativeSource } from '../storage/evm-native-operation-journal'
import { PROTOCOL_CHAINS } from './chains-registry'
import {
  decodeSignedTempoTransaction,
  encodeSignedTempoTransaction,
  tempoPathUsdMaximumFee,
  tempoSigningHash,
  type TempoTransaction,
} from './tempo-transaction'

export const PATHUSD = '0x20c0000000000000000000000000000000000000'
const TRANSFER = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
])
const TRANSFER_TOPIC = TRANSFER.getEvent('Transfer')!.topicHash
const HASH = /^0x[0-9a-f]{64}$/

/** Superseded signatures remain durable because any candidate may still settle. */
export interface TempoSignedAttempt {
  readonly gasLimit: string
  readonly maxFeePerGas: string
  readonly maxPriorityFeePerGas: string
  readonly maximumFeeAtomic: string
  readonly signedRaw: string
  readonly transactionHash: string
}

/** Distinct from the native EVM journal: amounts and fees are six-decimal PathUSD units. */
export interface TempoPathUsdOperation {
  readonly version: 1
  readonly operationId: string
  readonly chainIdentifier: 'tempo-testnet' | 'tempo-mainnet'
  readonly source: EvmNativeSource
  readonly recipient: string
  readonly amountAtomic: string
  readonly nonce: string
  readonly gasLimit: string
  readonly maxFeePerGas: string
  readonly maxPriorityFeePerGas: string
  readonly maximumFeeAtomic: string
  readonly signedRaw: string | null
  readonly transactionHash: string | null
  readonly priorAttempts: readonly TempoSignedAttempt[]
  readonly exposed: boolean
  readonly submission: { state: 'never' | 'accepted' | 'ambiguous' | 'inconsistent-rpc' }
  readonly observation:
    | { state: 'unknown' | 'pending' }
    | { state: 'nonce-consumed-unknown'; finalizedNonce: string }
    | {
        state: 'included-success' | 'included-revert' | 'included-mismatch'
        transactionHash: string
        finalized: boolean
        blockHash: string
        blockNumber: number
        feeAtomic: string
      }
}

export interface TempoReceipt {
  readonly transactionHash: string
  readonly blockHash: string
  readonly blockNumber: number
  readonly status: number
  readonly gasUsed: bigint
  readonly effectiveGasPrice: bigint
  readonly feeToken: string
  readonly feePayer: string
  readonly logs: readonly {
    readonly address: string
    readonly topics: readonly string[]
    readonly data: string
  }[]
}

export interface TempoPathUsdRpc {
  /** Verifies both chain ID and the registry's genesis checkpoint. */
  verifyChain(chainIdentifier: 'tempo-testnet' | 'tempo-mainnet'): Promise<void>
  getPendingNonce(address: string): Promise<bigint>
  getFinalizedNonce(address: string): Promise<bigint>
  getPathUsdBalance(address: string): Promise<bigint>
  quoteTransfer(params: {
    from: string
    to: string
    data: string
  }): Promise<{ gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>
  sendRawTransaction(raw: string): Promise<string>
  getReceipt(hash: string): Promise<TempoReceipt | null>
  isFinalizedReceipt(receipt: TempoReceipt): Promise<boolean>
}

export interface TempoPathUsdSigner {
  readonly source: EvmNativeSource
  signDigest(digest: string): Promise<{
    r: string
    s: string
    yParity: 0 | 1
  }>
}

function canonicalAddress(address: string): string {
  return getAddress(address).toLowerCase()
}

function atomic(value: string, name: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error(`Invalid Tempo ${name}`)
  return BigInt(value)
}

function chainId(chainIdentifier: TempoPathUsdOperation['chainIdentifier']): bigint {
  const chain = PROTOCOL_CHAINS[chainIdentifier]
  if (chain?.kind !== 'tempo' || !chain.nativeChainId)
    throw new Error('Unknown Tempo chain')
  return BigInt(chain.nativeChainId)
}

function transferData(recipient: string, amount: bigint): string {
  return TRANSFER.encodeFunctionData('transfer', [recipient, amount])
}

function transaction(row: TempoPathUsdOperation): TempoTransaction {
  return {
    chainId: chainId(row.chainIdentifier),
    nonce: atomic(row.nonce, 'nonce'),
    gasLimit: atomic(row.gasLimit, 'gas limit'),
    maxFeePerGas: atomic(row.maxFeePerGas, 'max fee'),
    maxPriorityFeePerGas: atomic(row.maxPriorityFeePerGas, 'priority fee'),
    feeToken: PATHUSD,
    calls: [{
      to: PATHUSD,
      value: 0n,
      data: transferData(row.recipient, atomic(row.amountAtomic, 'amount')),
    }],
  }
}

function signedAttempts(row: TempoPathUsdOperation): TempoSignedAttempt[] {
  return [
    ...row.priorAttempts,
    ...(row.signedRaw && row.transactionHash ? [{
      gasLimit: row.gasLimit,
      maxFeePerGas: row.maxFeePerGas,
      maxPriorityFeePerGas: row.maxPriorityFeePerGas,
      maximumFeeAtomic: row.maximumFeeAtomic,
      signedRaw: row.signedRaw,
      transactionHash: row.transactionHash,
    }] : []),
  ]
}

function validateAttempt(row: TempoPathUsdOperation, attempt: TempoSignedAttempt): void {
  const candidate = transaction({ ...row, ...attempt })
  const ceiling = tempoPathUsdMaximumFee(candidate.gasLimit, candidate.maxFeePerGas)
  if (attempt.maximumFeeAtomic !== ceiling.toString())
    throw new Error('Invalid Tempo attempt fee hold')
  const decoded = decodeSignedTempoTransaction(attempt.signedRaw, candidate.chainId)
  if (
    canonicalAddress(decoded.sender) !== row.source.address ||
    decoded.transactionHash !== attempt.transactionHash ||
    tempoSigningHash(decoded.transaction) !== tempoSigningHash(candidate)
  ) throw new Error('Signed Tempo attempt differs from its authorization')
}

function validate(row: TempoPathUsdOperation): TempoPathUsdOperation {
  if (row.version !== 1 || !HASH.test(row.operationId))
    throw new Error('Invalid Tempo operation ID')
  if (canonicalAddress(row.source.address) !== row.source.address)
    throw new Error('Invalid Tempo source')
  if (canonicalAddress(row.recipient) !== row.recipient)
    throw new Error('Invalid Tempo recipient')
  const amount = atomic(row.amountAtomic, 'amount')
  if (amount === 0n) throw new Error('Tempo amount must be positive')
  const tx = transaction(row)
  const maxFee = tempoPathUsdMaximumFee(tx.gasLimit, tx.maxFeePerGas)
  if (row.maximumFeeAtomic !== maxFee.toString())
    throw new Error('Invalid Tempo fee hold')
  if (row.signedRaw === null) {
    if (row.transactionHash !== null || row.exposed || row.priorAttempts.length)
      throw new Error('Invalid unsigned Tempo operation')
  } else {
    if (!row.transactionHash) throw new Error('Missing Tempo transaction hash')
  }
  const attempts = signedAttempts(row)
  const hashes = new Set<string>()
  for (const attempt of attempts) {
    validateAttempt(row, attempt)
    if (hashes.has(attempt.transactionHash)) throw new Error('Duplicate Tempo attempt')
    hashes.add(attempt.transactionHash)
  }
  if (!['never', 'accepted', 'ambiguous', 'inconsistent-rpc'].includes(row.submission.state) ||
    (row.submission.state !== 'never' && !row.exposed))
    throw new Error('Invalid Tempo submission state')
  if ('feeAtomic' in row.observation) {
    const included = row.observation
    const includedAttempt = attempts.find(attempt => attempt.transactionHash === included.transactionHash)
    if (
      !row.exposed ||
      !hashes.has(included.transactionHash) ||
      !includedAttempt ||
      typeof included.finalized !== 'boolean' ||
      !HASH.test(included.blockHash) ||
      !Number.isSafeInteger(included.blockNumber) ||
      included.blockNumber < 0 ||
      atomic(included.feeAtomic, 'observed fee') > atomic(includedAttempt.maximumFeeAtomic, 'attempt fee hold')
    )
      throw new Error('Invalid Tempo inclusion observation')
  } else if (row.observation.state === 'nonce-consumed-unknown') {
    if (!row.exposed || atomic(row.observation.finalizedNonce, 'finalized nonce') <= atomic(row.nonce, 'operation nonce'))
      throw new Error('Invalid Tempo consumed nonce observation')
  }
  return structuredClone(row)
}

function receiptObservation(row: TempoPathUsdOperation, attempt: TempoSignedAttempt, receipt: TempoReceipt, finalized: boolean): TempoPathUsdOperation['observation'] {
  if (
    receipt.transactionHash !== attempt.transactionHash ||
    canonicalAddress(receipt.feeToken) !== PATHUSD ||
    canonicalAddress(receipt.feePayer) !== row.source.address ||
    !HASH.test(receipt.blockHash) ||
    !Number.isSafeInteger(receipt.blockNumber) ||
    receipt.blockNumber < 0 ||
    ![0, 1].includes(receipt.status)
  )
    throw new Error('Invalid Tempo receipt identity')
  const feeAtomic = tempoPathUsdMaximumFee(receipt.gasUsed, receipt.effectiveGasPrice)
  if (feeAtomic > atomic(attempt.maximumFeeAtomic, 'maximum fee'))
    throw new Error('Tempo receipt exceeds authorized fee')
  let state: 'included-success' | 'included-revert' | 'included-mismatch' =
    receipt.status === 0 ? 'included-revert' : 'included-mismatch'
  if (receipt.status === 1) {
    const expectedAmount = atomic(row.amountAtomic, 'amount')
    for (const log of receipt.logs) {
      if (canonicalAddress(log.address) !== PATHUSD || log.topics[0] !== TRANSFER_TOPIC)
        continue
      const parsed = TRANSFER.parseLog({ topics: [...log.topics], data: log.data })
      if (
        parsed &&
        canonicalAddress(parsed.args[0]) === row.source.address &&
        canonicalAddress(parsed.args[1]) === row.recipient &&
        parsed.args[2] === expectedAmount
      ) {
        state = 'included-success'
        break
      }
    }
  }
  return {
    state,
    transactionHash: attempt.transactionHash,
    finalized,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber,
    feeAtomic: feeAtomic.toString(),
  }
}

/** One source/nonce claim per operation. The host supplies a cross-instance spend lock. */
export class TempoPathUsdJournal {
  private tail: Promise<unknown> = Promise.resolve()
  private uncertain = false

  constructor(private readonly store: RecordStore<TempoPathUsdOperation>) {
    const claims = new Set<string>()
    const ids = new Set<string>()
    for (const row of store.all()) {
      validate(row)
      if (ids.has(row.operationId)) throw new Error('Duplicate Tempo operation ID')
      ids.add(row.operationId)
      const claim = `${row.chainIdentifier}:${row.source.address}:${row.nonce}`
      if (claims.has(claim)) throw new Error('Duplicate Tempo source nonce claim')
      claims.add(claim)
    }
  }

  get(operationId: string): TempoPathUsdOperation | undefined {
    if (this.uncertain) throw new Error('Tempo journal write outcome is uncertain')
    const row = this.store.get(operationId)
    return row ? validate(row) : undefined
  }

  list(): TempoPathUsdOperation[] {
    if (this.uncertain) throw new Error('Tempo journal write outcome is uncertain')
    return this.store.all().map(validate)
  }

  /** A pending or merely prepared spend holds this account's token balance and nonce lane. */
  hasActiveSource(chainIdentifier: TempoPathUsdOperation['chainIdentifier'], source: string): boolean {
    return this.list().some(row =>
      row.chainIdentifier === chainIdentifier &&
      row.source.address === source &&
      (row.observation.state !== 'nonce-consumed-unknown' &&
        (!row.observation.state.startsWith('included-') || !('finalized' in row.observation) || !row.observation.finalized))
    )
  }

  private async write(row: TempoPathUsdOperation): Promise<TempoPathUsdOperation> {
    const valid = validate(row)
    try {
      await this.store.put(valid.operationId, valid)
    } catch (error) {
      this.uncertain = true
      throw error
    }
    return valid
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.uncertain) return Promise.reject(new Error('Tempo journal write outcome is uncertain'))
    const run = this.tail.then(task)
    this.tail = run.catch(() => undefined)
    return run
  }

  prepare(row: TempoPathUsdOperation): Promise<TempoPathUsdOperation> {
    return this.exclusive(async () => {
      if (this.get(row.operationId)) throw new Error('Tempo operation already exists')
      if (this.list().some(existing =>
        existing.chainIdentifier === row.chainIdentifier &&
        existing.source.address === row.source.address &&
        existing.nonce === row.nonce
      )) throw new Error('Tempo source nonce is reserved')
      return this.write(row)
    })
  }

  mutate(operationId: string, change: (row: TempoPathUsdOperation) => TempoPathUsdOperation): Promise<TempoPathUsdOperation> {
    return this.exclusive(async () => {
      const previous = this.get(operationId)
      if (!previous) throw new Error('Unknown Tempo operation')
      return this.write(change(previous))
    })
  }

  /** Only a row whose signed bytes never crossed a broadcast boundary may release its claim. */
  abandonUnexposed(operationId: string): Promise<void> {
    return this.exclusive(async () => {
      const row = this.get(operationId)
      if (!row) throw new Error('Unknown Tempo operation')
      if (row.exposed) throw new Error('Exposed Tempo operation cannot be abandoned')
      try {
        await this.store.delete(operationId)
      } catch (error) {
        this.uncertain = true
        throw error
      }
    })
  }

  close(): Promise<void> { return this.store.close() }
}

/** Stable request ID prevents retries from authorizing a second payment. */
export class TempoPathUsdTransfers {
  constructor(
    private readonly chainIdentifier: 'tempo-testnet' | 'tempo-mainnet',
    private readonly journal: TempoPathUsdJournal,
    private readonly rpc: TempoPathUsdRpc,
    private readonly withSourceLock: <T>(source: string, operation: () => Promise<T>) => Promise<T>,
  ) {}

  async prepare(params: {
    operationId: string
    signer: TempoPathUsdSigner
    recipient: string
    amountAtomic: bigint
  }): Promise<TempoPathUsdOperation> {
    if (!HASH.test(params.operationId)) throw new Error('Invalid Tempo operation ID')
    const existing = this.journal.get(params.operationId)
    if (existing) {
      if (
        existing.chainIdentifier !== this.chainIdentifier ||
        existing.source.address !== canonicalAddress(params.signer.source.address) ||
        existing.recipient !== canonicalAddress(params.recipient) ||
        atomic(existing.amountAtomic, 'amount') !== params.amountAtomic
      ) throw new Error('Tempo operation ID has a different authorization')
      return existing
    }
    const source = canonicalAddress(params.signer.source.address)
    const recipient = canonicalAddress(params.recipient)
    if (params.amountAtomic <= 0n) throw new RangeError('Tempo amount must be positive')
    await this.rpc.verifyChain(this.chainIdentifier)
    const data = transferData(recipient, params.amountAtomic)
    const quote = await this.rpc.quoteTransfer({ from: source, to: PATHUSD, data })
    const maximumFeeAtomic = tempoPathUsdMaximumFee(quote.gasLimit, quote.maxFeePerGas)
    return this.withSourceLock(source, async () => {
      const retry = this.journal.get(params.operationId)
      if (retry) {
        if (
          retry.source.address !== source ||
          retry.recipient !== recipient ||
          atomic(retry.amountAtomic, 'amount') !== params.amountAtomic
        ) throw new Error('Tempo operation ID has a different authorization')
        return retry
      }
      if (this.journal.hasActiveSource(this.chainIdentifier, source))
        throw new Error('Tempo source has an unresolved PathUSD operation')
      const [nonce, balance] = await Promise.all([
        this.rpc.getPendingNonce(source),
        this.rpc.getPathUsdBalance(source),
      ])
      if (balance < params.amountAtomic + maximumFeeAtomic)
        throw new RangeError('Insufficient PathUSD for transfer and network fee')
      const row: TempoPathUsdOperation = {
        version: 1,
        operationId: params.operationId,
        chainIdentifier: this.chainIdentifier,
        source: structuredClone(params.signer.source),
        recipient,
        amountAtomic: params.amountAtomic.toString(),
        nonce: nonce.toString(),
        gasLimit: quote.gasLimit.toString(),
        maxFeePerGas: quote.maxFeePerGas.toString(),
        maxPriorityFeePerGas: quote.maxPriorityFeePerGas.toString(),
        maximumFeeAtomic: maximumFeeAtomic.toString(),
        signedRaw: null,
        transactionHash: null,
        priorAttempts: [],
        exposed: false,
        submission: { state: 'never' },
        observation: { state: 'unknown' },
      }
      return this.journal.prepare(row)
    })
  }

  async submit(operationId: string, signer: TempoPathUsdSigner): Promise<TempoPathUsdOperation> {
    const operation = this.journal.get(operationId)
    if (!operation || operation.chainIdentifier !== this.chainIdentifier)
      throw new Error('Unknown Tempo operation for this chain')
    return this.withSourceLock(operation.source.address, () => this.submitLocked(operationId, signer))
  }

  async abandonUnexposed(operationId: string): Promise<void> {
    const row = this.journal.get(operationId)
    if (!row || row.chainIdentifier !== this.chainIdentifier)
      throw new Error('Unknown Tempo operation for this chain')
    return this.withSourceLock(row.source.address, () => this.journal.abandonUnexposed(operationId))
  }

  private async submitLocked(operationId: string, signer: TempoPathUsdSigner): Promise<TempoPathUsdOperation> {
    let row = this.journal.get(operationId)
    if (!row || row.chainIdentifier !== this.chainIdentifier)
      throw new Error('Unknown Tempo operation for this chain')
    if (canonicalAddress(signer.source.address) !== row.source.address)
      throw new Error('Tempo signer does not own operation source')
    await this.rpc.verifyChain(this.chainIdentifier)
    if (row.observation.state === 'nonce-consumed-unknown') return this.reconcile(operationId)
    if (row.observation.state.startsWith('included-')) return this.reconcile(operationId)
    if (!row.signedRaw) {
      const tx = transaction(row)
      const signature = await signer.signDigest(tempoSigningHash(tx))
      const signed = encodeSignedTempoTransaction(tx, signature, row.source.address)
      row = await this.journal.mutate(operationId, current => {
        if (current.signedRaw && current.signedRaw !== signed.rawTransaction)
          throw new Error('Tempo operation already signed differently')
        return { ...current, signedRaw: signed.rawTransaction, transactionHash: signed.transactionHash }
      })
    }
    if (!row.exposed) {
      row = await this.journal.mutate(operationId, current => ({ ...current, exposed: true }))
    }
    let submission: TempoPathUsdOperation['submission']
    try {
      const returnedHash = await this.rpc.sendRawTransaction(row.signedRaw!)
      submission = { state: returnedHash === row.transactionHash ? 'accepted' : 'inconsistent-rpc' }
    } catch {
      // The signed transaction may already be in the mempool or chain. Reconcile by its exact hash.
      submission = { state: 'ambiguous' }
    }
    await this.journal.mutate(operationId, current => ({ ...current, submission }))
    return this.reconcile(operationId)
  }

  /** Explicitly authorized higher fee for the same payment and nonce; old raw bytes stay recoverable. */
  async replaceFee(operationId: string, signer: TempoPathUsdSigner, authorizedFeeCeilingAtomic: bigint): Promise<TempoPathUsdOperation> {
    const original = this.journal.get(operationId)
    if (!original || original.chainIdentifier !== this.chainIdentifier || !original.signedRaw)
      throw new Error('Unknown signed Tempo operation for this chain')
    const source = canonicalAddress(signer.source.address)
    if (source !== original.source.address || authorizedFeeCeilingAtomic < 0n)
      throw new Error('Invalid Tempo replacement authorization')
    return this.withSourceLock(source, async () => {
      const row = await this.reconcile(operationId)
      if (row.observation.state.startsWith('included-') || row.observation.state === 'nonce-consumed-unknown')
        throw new Error('Tempo operation has an included candidate')
      const quote = await this.rpc.quoteTransfer({
        from: source, to: PATHUSD,
        data: transferData(row.recipient, atomic(row.amountAtomic, 'amount')),
      })
      if (quote.maxFeePerGas <= atomic(row.maxFeePerGas, 'old max fee'))
        throw new Error('Tempo replacement fee is not higher')
      const gasLimit = quote.gasLimit > atomic(row.gasLimit, 'old gas limit')
        ? quote.gasLimit : atomic(row.gasLimit, 'old gas limit')
      const maximumFeeAtomic = tempoPathUsdMaximumFee(gasLimit, quote.maxFeePerGas)
      if (maximumFeeAtomic > authorizedFeeCeilingAtomic)
        throw new Error('Tempo replacement exceeds authorized fee ceiling')
      if (await this.rpc.getPathUsdBalance(source) < atomic(row.amountAtomic, 'amount') + maximumFeeAtomic)
        throw new RangeError('Insufficient PathUSD for replacement fee')
      const replacement = {
        ...row,
        gasLimit: gasLimit.toString(),
        maxFeePerGas: quote.maxFeePerGas.toString(),
        maxPriorityFeePerGas: quote.maxPriorityFeePerGas.toString(),
        maximumFeeAtomic: maximumFeeAtomic.toString(),
      }
      const signature = await signer.signDigest(tempoSigningHash(transaction(replacement)))
      const signed = encodeSignedTempoTransaction(transaction(replacement), signature, source)
      return this.journal.mutate(operationId, current => {
        if (current.transactionHash !== row.transactionHash)
          throw new Error('Tempo operation changed while replacing its fee')
        return {
          ...replacement,
          signedRaw: signed.rawTransaction,
          transactionHash: signed.transactionHash,
          priorAttempts: signedAttempts(current),
          exposed: true,
          submission: { state: 'never' },
          observation: { state: 'pending' },
        }
      })
    })
  }

  async reconcile(operationId: string): Promise<TempoPathUsdOperation> {
    const row = this.journal.get(operationId)
    if (!row || row.chainIdentifier !== this.chainIdentifier)
      throw new Error('Unknown Tempo operation for this chain')
    if (!row.exposed || !row.transactionHash) return row
    await this.rpc.verifyChain(this.chainIdentifier)
    let observation: TempoPathUsdOperation['observation'] = { state: 'pending' }
    for (const attempt of signedAttempts(row)) {
      const receipt = await this.rpc.getReceipt(attempt.transactionHash)
      if (!receipt) continue
      if (observation.state !== 'pending') throw new Error('Multiple Tempo candidates included for one nonce')
      observation = receiptObservation(row, attempt, receipt, await this.rpc.isFinalizedReceipt(receipt))
    }
    if (observation.state === 'pending') {
      const finalizedNonce = await this.rpc.getFinalizedNonce(row.source.address)
      if (finalizedNonce > atomic(row.nonce, 'operation nonce'))
        observation = { state: 'nonce-consumed-unknown', finalizedNonce: finalizedNonce.toString() }
    }
    if (JSON.stringify(row.observation) === JSON.stringify(observation)) return row
    return this.journal.mutate(operationId, current => ({ ...current, observation }))
  }
}

/** A successful PathUSD Transfer log is a receivable token amount, never native ETH. */
export function tempoPathUsdReceivedTransfer(log: {
  address: string
  topics: readonly string[]
  data: string
}, expectedRecipient: string): { sender: string; recipient: string; amountAtomic: bigint } | null {
  if (canonicalAddress(log.address) !== PATHUSD || log.topics[0] !== TRANSFER_TOPIC)
    return null
  const parsed = TRANSFER.parseLog({ topics: [...log.topics], data: log.data })
  if (!parsed || canonicalAddress(parsed.args[1]) !== canonicalAddress(expectedRecipient))
    return null
  return {
    sender: canonicalAddress(parsed.args[0]),
    recipient: canonicalAddress(parsed.args[1]),
    amountAtomic: parsed.args[2] as bigint,
  }
}
