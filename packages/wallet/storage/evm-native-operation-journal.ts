import level, { type LevelDB } from 'level'
import { join } from 'path'
import { getAddress, keccak256, toUtf8Bytes, Transaction } from 'ethers'
import { PROTOCOL_CHAINS } from '../chain/chains-registry'
import { runNativeTransactionExclusive } from '../chain/chain-wallet'
import { durableBatch, durablePut, openDurableLevel } from './level-durability'
import { validateTransactionSetGraph } from './evm-transaction-set-graph'

/** Public derivation provenance only. Custody resolves and address-checks these references. */
export type EvmNativeSource =
  | { kind: 'main'; address: string }
  | { kind: 'identity'; address: string; identityPublicKey: string }
  | { kind: 'spend'; address: string; index: number }
  | { kind: 'change'; address: string; index: number }
  | {
      kind: 'identity-stealth-v1'
      address: string
      identityPublicKey: string
      ephemeralPublicKey: string
    }
  /** A received coin whose key the wallet's coin list holds (a stamp payment's account). */
  | { kind: 'coin'; address: string }

export interface EvmNativeBinding {
  readonly chainIdentifier: string
  readonly nativeChainId: string
  readonly publicTuple: string
}
export interface EvmNativeAccountObservation {
  blockHash: string
  blockNumber: number
  nonce: number
  balanceWei: string
}
/**
 * True when the chain has shown that this signed transaction can never land: the node knows
 * neither it nor a receipt for it (`missing`), and in that same look the account's nonce was
 * already past its nonce, so another transaction took its place. The operation has failed for
 * good and no longer holds its account. (A later look that does find a receipt replaces the
 * observation, as any look does; the nonce is consumed either way.)
 */
export function nativeMemberSuperseded(member: {
  unsignedTransaction: string
  observation: EvmNativeObservation
  account: EvmNativeAccountObservation | null
}): boolean {
  return (
    member.observation.state === 'missing' &&
    member.account !== null &&
    member.account.nonce > Transaction.from(member.unsignedTransaction).nonce
  )
}

/** A canonical account observation must confirm consumption before its residual can be applied. */
function terminalInventoryEvidence(member: EvmNativeMember): boolean {
  return (
    member.signed !== null &&
    member.account !== null &&
    member.account.nonce > Transaction.from(member.unsignedTransaction).nonce &&
    (member.observation.state === 'included-success' ||
      member.observation.state === 'included-revert' ||
      nativeMemberSuperseded(member))
  )
}

export type EvmNativeObservation =
  | { state: 'unknown' | 'missing' | 'pending' }
  | {
      state: 'included-success' | 'included-revert'
      transactionHash: string
      blockHash: string
      blockNumber: number
      transactionIndex: number
      feeWei: string
    }
/** Fresh canonical evidence contradicting a specific previously observed inclusion. This is
 * capture-bound evidence for a journal update, not a second persisted settlement record. */
export interface EvmNativeInclusionContradiction {
  blockNumber: number
  orphanedBlockHash: string
  canonicalBlockHash: string
}
/**
 * `native`: one transfer from one account. `legacy`: fan-in transfers into one account, then one
 * transfer out of it. `contract`: one call with calldata from the main account, which holds the
 * tokens the call moves; the call may carry no value (an approval, or a swap that pays a token).
 */
export type EvmNativeOperationKind =
  | 'native'
  | 'legacy'
  | 'contract'
  | 'transaction-set'
export interface EvmTransactionSetMember {
  /** Durable checkpoint of terminal inventory application, independent of payment success. */
  inventoryApplied?: true
  role: 'payment' | 'change' | 'funding'
  intendedValueWei?: string
  stageId?: string
  fundingWaitBlocks?: number
  logicalIndex: number
  changeIndex?: number
  balanceBeforeWei: string
  balanceAfterWei: string
  predecessorWaitBlocks?: number
  remainderSpendableFromBlock?: number
  refundPending?: boolean
}
function transactionSetIntent(
  meta: EvmTransactionSetMember,
): Omit<EvmTransactionSetMember, 'inventoryApplied'> {
  const { inventoryApplied: _checkpoint, ...intent } = meta
  return intent
}
export interface EvmNativeMemberPlan {
  transactionSet?: EvmTransactionSetMember
  source: EvmNativeSource
  unsignedTransaction: string
  dependencies: number[]
}
export interface EvmNativeMember extends EvmNativeMemberPlan {
  signed: { rawTransaction: string; transactionHash: string } | null
  exposed: boolean
  observation: EvmNativeObservation
  account: EvmNativeAccountObservation | null
  syncApplied: boolean
}
/**
 * What a contract call is, kept with its signed transaction: the record a swap carries. Plain
 * JSON, amounts as decimal strings in each asset's smallest unit. The chain is the journal's
 * binding. The wallet's sync event turns it into the note the account sends itself.
 */
export interface EvmContractCallRecord {
  kind: 'swap'
  venueId: string
  account: string
  assetIn: { symbol: string; address: string | null; decimals: number }
  amountIn: string
  assetOut: { symbol: string; address: string | null; decimals: number }
  quotedAmountOut: string
  minimumAmountOut: string
  /** Frank's fee, in the output asset; "0" when the exchange has none. */
  interfaceFeeAmount: string
  /** The network fee the transaction reserves, in the native coin. */
  networkFeeWei: string
  /** The exchange's own description of the route; needed to read the outcome later. */
  route: unknown
}
const MAX_RECORD_BYTES = 8 * 1024
function validateRecord(value: unknown, kind: unknown): EvmContractCallRecord {
  if (kind !== 'contract') fail()
  const row = object(value, [
    'kind',
    'venueId',
    'account',
    'assetIn',
    'amountIn',
    'assetOut',
    'quotedAmountOut',
    'minimumAmountOut',
    'interfaceFeeAmount',
    'networkFeeWei',
    'route',
  ])
  if (row.kind !== 'swap' || typeof row.venueId !== 'string' || !row.venueId)
    fail()
  if (typeof row.account !== 'string') fail()
  for (const asset of [row.assetIn, row.assetOut]) {
    const a = object(asset, ['symbol', 'address', 'decimals'])
    if (typeof a.symbol !== 'string' || !a.symbol) fail()
    if (a.address !== null && typeof a.address !== 'string') fail()
    integer(a.decimals)
  }
  for (const amount of [
    row.amountIn,
    row.quotedAmountOut,
    row.minimumAmountOut,
    row.interfaceFeeAmount,
    row.networkFeeWei,
  ])
    uint(amount)
  if (encodedBytes(value) > MAX_RECORD_BYTES) fail('capacity')
  return clone(value) as EvmContractCallRecord
}
export interface EvmTransactionSetStage {
  /** Absent only for the original recipient leg. */
  stageId?: string
  startIndex: number
  memberCount: number
  intendedValueWei: string
  calldata: string
  destinations: string[]
  /** Whole-operation authorization; appending may tighten but never raise it. */
  maxFeeWei?: string
  reserveForContinuationWei?: string
  minimumPaymentWei?: string
  legacy?: true
}
export interface EvmNativeOperation {
  /** Explicit submission of this complete graph, durable independently of member exposure. */
  submissionAuthorized?: true
  transactionSetStages?: EvmTransactionSetStage[]
  version: 1
  operationId: string
  binding: EvmNativeBinding
  kind: EvmNativeOperationKind
  /** An intentionally prepared contract call: preserve signed bytes at wallet open until its
   * owner explicitly submits or releases it. Ordinary calls retain their existing cleanup. */
  submissionPolicy?: 'explicit'
  /** Stable financial intent identity; distinct from this journal's sequential operation ID. */
  preparationId?: string
  recipient: string
  intendedValueWei: string
  maximumFeeWei: string
  members: EvmNativeMember[]
  cancelled: boolean
  reservedBytes: number
  /**
   * A contract call's record, written with the plan and so before anything is signed. Only a
   * contract call that was given one has the key at all: a row without a record (every native
   * and legacy send, and every row written before records existed) is the same row it always
   * was, so adding the field needed no new journal version and no reset.
   */
  record?: EvmContractCallRecord
}
/** The composing owner checkpoints its obligations before requesting archival. This is
 * evidence of local completion bookkeeping, never atomicity of external chain/relay steps. */
export interface EvmNativeCompletionReceipt {
  expectedOperationHash: string
  ownerReference: string
  sync: 'complete' | 'not-required'
  delivery: 'complete' | 'not-required'
  dependencies: 'complete'
}

/** Pins the exact validated snapshot, including observations and the complete signed graph. */
export function evmNativeOperationDigest(operation: EvmNativeOperation): string {
  return keccak256(toUtf8Bytes(JSON.stringify(operation)))
}

function validateCompletionReceipt(value: unknown): EvmNativeCompletionReceipt {
  const receipt = object(value, ['expectedOperationHash', 'ownerReference', 'sync', 'delivery', 'dependencies'])
  hash(receipt.expectedOperationHash)
  if (typeof receipt.ownerReference !== 'string' || !receipt.ownerReference.length ||
      receipt.ownerReference.length > 1024 ||
      !['complete', 'not-required'].includes(receipt.sync as string) ||
      !['complete', 'not-required'].includes(receipt.delivery as string) ||
      receipt.dependencies !== 'complete') fail()
  return clone(receipt) as unknown as EvmNativeCompletionReceipt
}

function completedForHistory(row: EvmNativeOperation): boolean {
  // The original cancellation validator proves these bytes were never exposed and removed
  // signed members. The exact cancelled tombstone remains authoritative in history.
  if (row.cancelled) return row.members.every(member => !member.signed && !member.exposed)
  // Other operation kinds need their owner's completion contract before they can retire.
  return row.kind === 'transaction-set' && row.members.every(member =>
    terminalInventoryEvidence(member) && member.transactionSet?.inventoryApplied === true)
}

export interface EvmNativePlan {
  transactionSetStages?: EvmTransactionSetStage[]
  kind: EvmNativeOperationKind
  submissionPolicy?: 'explicit'
  /** Stable financial intent identity; distinct from this journal's sequential operation ID. */
  preparationId?: string
  recipient: string
  intendedValueWei: string
  members: EvmNativeMemberPlan[]
  record?: EvmContractCallRecord | null
}
export type EvmNativeValidation =
  | 'record'
  | 'source'
  | 'unsigned'
  | 'signature'
  | 'observation'
  | 'account'
  | 'contract-binding'

export class EvmNativeJournalError extends Error {
  constructor(
    readonly code:
      | 'invalid'
      | 'binding'
      | 'capacity'
      | 'conflict'
      | 'closed'
      | 'uncertain',
    readonly validation?: EvmNativeValidation,
  ) {
    super(`EVM native operation journal: ${code}`)
    this.name = 'EvmNativeJournalError'
  }
}
const COMPONENT = 'evm-native-operations-v1'
const UINT_MAX = (1n << 256n) - 1n
const MAX_MEMBERS = 64
const MAX_UNSIGNED = 64 * 1024
const MAX_ROW = 16 * 1024 * 1024
const MAX_ROWS = 1024
const MAX_BYTES = 64 * 1024 * 1024
const HASH = /^0x[0-9a-f]{64}$/
function fail(
  code: EvmNativeJournalError['code'] = 'invalid',
  validation?: EvmNativeValidation,
): never {
  throw new EvmNativeJournalError(code, validation)
}
/** Fixed validation categories only: never retain rejected data or provider payloads. */
function checked<T>(validation: EvmNativeValidation, validate: () => T): T {
  try {
    return validate()
  } catch (error) {
    if (
      error instanceof EvmNativeJournalError &&
      error.code === 'invalid' &&
      !error.validation
    ) {
      throw new EvmNativeJournalError(error.code, validation)
    }
    throw error
  }
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== keys.sort().join(',')) fail()
  return row
}
function integer(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    fail()
}
function uint(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) fail()
  const result = BigInt(value)
  if (result > UINT_MAX) fail()
  return result
}
function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !HASH.test(value)) fail()
}
function address(value: unknown): asserts value is string {
  if (typeof value !== 'string' || getAddress(value).toLowerCase() !== value)
    fail()
}
function point(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^0x(?:[0-9a-f]{66}|[0-9a-f]{130})$/.test(value)
  )
    fail()
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}
export function nativeMaximumFee(tx: Transaction): bigint {
  const fee = tx.gasLimit * (tx.maxFeePerGas ?? tx.gasPrice ?? 0n)
  if (fee > UINT_MAX) fail()
  return fee
}
function validateSource(value: unknown): EvmNativeSource {
  if (!value || typeof value !== 'object') fail()
  const kind = (value as { kind?: unknown }).kind
  const keys =
    kind === 'main' || kind === 'coin'
      ? ['kind', 'address']
      : kind === 'identity'
      ? ['kind', 'address', 'identityPublicKey']
      : kind === 'spend' || kind === 'change'
      ? ['kind', 'address', 'index']
      : kind === 'identity-stealth-v1'
      ? ['kind', 'address', 'identityPublicKey', 'ephemeralPublicKey']
      : fail()
  const row = object(value, keys)
  address(row.address)
  if ('index' in row) {
    integer(row.index)
    if (row.index >= 0x80000000) fail()
  }
  if ('identityPublicKey' in row) point(row.identityPublicKey)
  if ('ephemeralPublicKey' in row) point(row.ephemeralPublicKey)
  return clone(value) as EvmNativeSource
}
function validateBinding(value: unknown): EvmNativeBinding {
  const row = object(value, ['chainIdentifier', 'nativeChainId', 'publicTuple'])
  if (typeof row.chainIdentifier !== 'string') fail()
  const entry = PROTOCOL_CHAINS[row.chainIdentifier]
  if (
    !entry ||
    entry.family !== 'evm' ||
    String(entry.nativeChainId) !== row.nativeChainId
  )
    fail('binding')
  uint(row.nativeChainId)
  if (
    typeof row.publicTuple !== 'string' ||
    row.publicTuple.length === 0 ||
    Buffer.byteLength(row.publicTuple) > 4096
  )
    fail('binding')
  return clone(value) as EvmNativeBinding
}
function validateObservation(value: unknown): EvmNativeObservation {
  if (!value || typeof value !== 'object') fail()
  const state = (value as { state?: unknown }).state
  if (state === 'unknown' || state === 'missing' || state === 'pending')
    object(value, ['state'])
  else if (state === 'included-success' || state === 'included-revert') {
    const row = object(value, [
      'state',
      'transactionHash',
      'blockHash',
      'blockNumber',
      'transactionIndex',
      'feeWei',
    ])
    hash(row.transactionHash)
    hash(row.blockHash)
    integer(row.blockNumber)
    integer(row.transactionIndex)
    uint(row.feeWei)
  } else fail()
  return clone(value) as EvmNativeObservation
}
function validateAccount(value: unknown): EvmNativeAccountObservation | null {
  if (value === null) return null
  const row = object(value, ['blockHash', 'blockNumber', 'nonce', 'balanceWei'])
  hash(row.blockHash)
  integer(row.blockNumber)
  integer(row.nonce)
  uint(row.balanceWei)
  return clone(value) as EvmNativeAccountObservation
}
function unsigned(value: unknown, binding: EvmNativeBinding): Transaction {
  if (
    typeof value !== 'string' ||
    !/^0x(?:[0-9a-f]{2})+$/.test(value) ||
    (value.length - 2) / 2 > MAX_UNSIGNED
  )
    fail()
  const tx = Transaction.from(value)
  if (
    tx.isSigned() ||
    tx.unsignedSerialized !== value ||
    ![0, 1, 2].includes(tx.type ?? -1) ||
    tx.chainId.toString() !== binding.nativeChainId ||
    tx.to === null
  )
    fail()
  integer(tx.nonce)
  uint(tx.value.toString())
  uint(tx.gasLimit.toString())
  if (tx.gasPrice !== null) uint(tx.gasPrice.toString())
  if (tx.maxFeePerGas !== null) uint(tx.maxFeePerGas.toString())
  if (tx.maxPriorityFeePerGas !== null) uint(tx.maxPriorityFeePerGas.toString())
  nativeMaximumFee(tx)
  return tx
}
/** Development candidate baseline: inventoryApplied is budgeted before signed bytes can
 * escape. Earlier, unlanded transaction-set candidates reserved a smaller envelope and fail
 * capacity validation clearly. There is no migration or automatic reset. Preserve the old
 * candidate and its signed evidence to reconcile authorized operations before an explicitly
 * scoped development reset; never delete funded wallets, keys, or unrelated stores. Existing
 * native/legacy/contract journal envelopes are unchanged. */
function reservation(row: EvmNativeOperation): number {
  const max = clone(row)
  max.cancelled = false
  max.members = max.members.map(member => ({
    ...member,
    ...(member.transactionSet
      ? { transactionSet: { ...member.transactionSet, inventoryApplied: true } }
      : {}),
    signed: {
      rawTransaction:
        '0x' + 'ff'.repeat((member.unsignedTransaction.length - 2) / 2 + 128),
      transactionHash: '0x' + 'f'.repeat(64),
    },
    exposed: false,
    syncApplied: false,
    observation: {
      state: 'included-success',
      transactionHash: '0x' + 'f'.repeat(64),
      blockHash: '0x' + 'f'.repeat(64),
      blockNumber: Number.MAX_SAFE_INTEGER,
      transactionIndex: Number.MAX_SAFE_INTEGER,
      feeWei: UINT_MAX.toString(),
    },
    account: {
      blockHash: '0x' + 'f'.repeat(64),
      blockNumber: Number.MAX_SAFE_INTEGER,
      nonce: Number.MAX_SAFE_INTEGER,
      balanceWei: UINT_MAX.toString(),
    },
  }))
  max.reservedBytes = 0
  for (let i = 0; i < 8; i++) {
    const bytes = encodedBytes(max)
    if (bytes === max.reservedBytes) return bytes
    max.reservedBytes = bytes
  }
  return fail()
}
/** Only immutable signature facts are memoized. Every durable reload still validates the
 * row, binding, graph, mutable observations and cross-record reservations. Exact strings
 * (not hashes or object identities) prevent changed durable bytes from inheriting trust. */
class NativeSignatureValidationCache {
  private readonly entries = new Set<string>()
  private bytes = 0

  validate(inputs: readonly string[], verify: () => void): void {
    const key = JSON.stringify(inputs)
    if (this.entries.has(key)) return
    verify()
    // Account for UTF-16 string storage, with both a byte and entry bound. An oversized
    // valid input remains usable; it is simply verified again on the next reload.
    const bytes = key.length * 2
    const maximumBytes = 8 * 1024 * 1024
    // Retain the verified prefix when full. Evicting during ordered full-journal scans
    // would thrash the entire cache once history exceeds its capacity.
    if (this.entries.size >= 4096 || this.bytes + bytes > maximumBytes) return
    this.entries.add(key)
    this.bytes += bytes
  }

  clear(): void {
    this.entries.clear()
    this.bytes = 0
  }
}

function validateRow(
  value: unknown,
  binding: EvmNativeBinding,
  signatures: NativeSignatureValidationCache,
): EvmNativeOperation {
  const hasRecord = !!value && typeof value === 'object' && 'record' in value
  const hasSubmissionPolicy =
    !!value && typeof value === 'object' && 'submissionPolicy' in value
  const hasPreparationId =
    !!value && typeof value === 'object' && 'preparationId' in value
  const row = object(value, [
    'version',
    'operationId',
    'binding',
    'kind',
    'recipient',
    'intendedValueWei',
    'maximumFeeWei',
    'members',
    'cancelled',
    'reservedBytes',
    ...(hasPreparationId ? ['preparationId'] : []),
    ...('transactionSetStages' in (value as object) ? ['transactionSetStages'] : []),
    ...('submissionAuthorized' in (value as object) ? ['submissionAuthorized'] : []),
    ...(hasRecord ? ['record'] : []),
    ...(hasSubmissionPolicy ? ['submissionPolicy'] : []),
  ])
  if ('submissionAuthorized' in row && (row.submissionAuthorized !== true || row.kind !== 'transaction-set')) fail()
  if (
    hasPreparationId &&
    (typeof row.preparationId !== 'string' ||
      !(
        row.kind === 'transaction-set'
          ? /^evm-transaction-set:[a-zA-Z0-9_-]{1,128}$/
          : /^stealth-payment:[a-zA-Z0-9_-]{1,128}$/
      ).test(row.preparationId) ||
      !(
        row.kind === 'native' ||
        row.kind === 'transaction-set' ||
        (row.kind === 'contract' && row.submissionPolicy === 'explicit')
      ))
  )
    fail()
  if (hasRecord) checked('record', () => validateRecord(row.record, row.kind))
  if (
    hasSubmissionPolicy &&
    (row.kind !== 'contract' || row.submissionPolicy !== 'explicit')
  )
    fail()
  if (
    row.version !== 1 ||
    typeof row.operationId !== 'string' ||
    !/^evm-native-v1:[0-9a-f]{16}$/.test(row.operationId)
  )
    fail()
  if (JSON.stringify(validateBinding(row.binding)) !== JSON.stringify(binding))
    fail('binding')
  if (
    row.kind !== 'native' &&
    row.kind !== 'legacy' &&
    row.kind !== 'contract' &&
    row.kind !== 'transaction-set'
  )
    fail()
  address(row.recipient)
  if (
    uint(row.intendedValueWei) === 0n &&
    row.kind !== 'contract' &&
    row.kind !== 'transaction-set'
  )
    fail()
  uint(row.maximumFeeWei)
  integer(row.reservedBytes)
  if (
    typeof row.cancelled !== 'boolean' ||
    !Array.isArray(row.members) ||
    !row.members.length ||
    row.members.length > MAX_MEMBERS
  )
    fail()
  let fee = 0n
  const sourceAddresses = new Set<string>()
  const claims = new Set<string>()
  for (let i = 0; i < row.members.length; i++) {
    const member = object(row.members[i], [
      'source',
      'unsignedTransaction',
      'dependencies',
      'signed',
      'exposed',
      'observation',
      'account',
      'syncApplied',
      ...(row.kind === 'transaction-set' ? ['transactionSet'] : []),
    ])
    const source = checked('source', () => validateSource(member.source))
    if (sourceAddresses.has(source.address) && row.kind !== 'transaction-set')
      fail()
    sourceAddresses.add(source.address)
    const tx = checked('unsigned', () =>
      unsigned(member.unsignedTransaction, binding),
    )
    fee += nativeMaximumFee(tx)
    const claim = `${source.address}:${tx.nonce}`
    if (claims.has(claim)) fail()
    claims.add(claim)
    if (
      !Array.isArray(member.dependencies) ||
      new Set(member.dependencies).size !== member.dependencies.length
    )
      fail()
    for (const dependency of member.dependencies) {
      integer(dependency)
      if (dependency >= i) fail()
    }
    if (
      typeof member.exposed !== 'boolean' ||
      typeof member.syncApplied !== 'boolean'
    )
      fail()
    if (member.signed !== null) {
      const signed = object(member.signed, [
        'rawTransaction',
        'transactionHash',
      ])
      hash(signed.transactionHash)
      if (
        typeof signed.rawTransaction !== 'string' ||
        signed.rawTransaction.length >
          (member.unsignedTransaction as string).length + 256
      )
        fail()
      const rawTransaction = signed.rawTransaction
      signatures.validate([
        source.address,
        member.unsignedTransaction as string,
        rawTransaction,
        signed.transactionHash as string,
      ], () => {
        const parsed = Transaction.from(rawTransaction)
        if (
          !parsed.isSigned() ||
          parsed.serialized !== signed.rawTransaction ||
          parsed.unsignedSerialized !== member.unsignedTransaction ||
          parsed.from?.toLowerCase() !== source.address ||
          parsed.hash !== signed.transactionHash
        )
          fail('invalid', 'signature')
      })
    } else if (member.exposed || member.syncApplied) fail()
    const observation = checked('observation', () =>
      validateObservation(member.observation),
    )
    if (
      'transactionHash' in observation &&
      (member.signed === null ||
        observation.transactionHash !==
          (member.signed as { transactionHash: string }).transactionHash)
    )
      fail()
    if (member.syncApplied && observation.state !== 'included-success') fail()
    checked('account', () => validateAccount(member.account))
    if (row.cancelled && (member.signed !== null || member.exposed)) fail()
  }
  if (row.kind === 'transaction-set')
    validateTransactionSet(
      row.members as EvmNativeMember[],
      uint(row.intendedValueWei),
      row.transactionSetStages,
    )
  if (
    row.members.length > 1 &&
    row.kind !== 'legacy' &&
    row.kind !== 'transaction-set'
  ) {
    if (
      hasRecord ||
      (row.kind === 'contract' && row.submissionPolicy !== 'explicit')
    )
      fail()
    let value = 0n
    for (const item of row.members as EvmNativeMember[]) {
      const tx = unsigned(item.unsignedTransaction, binding)
      if (item.dependencies.length || tx.to?.toLowerCase() !== row.recipient)
        fail()
      if (row.kind === 'native') {
        if (tx.data !== '0x' || tx.value <= 0n) fail()
        value += tx.value
      } else if (tx.data === '0x' || tx.value !== 0n) fail()
    }
    if (value.toString() !== row.intendedValueWei) fail()
  }
  if (fee.toString() !== row.maximumFeeWei) fail()
  if (fee + uint(row.intendedValueWei) > UINT_MAX) fail()
  if (row.kind === 'contract') {
    const call = (row.members as EvmNativeMember[])[0]!
    const tx = Transaction.from(call.unsignedTransaction)
    if (
      (call.source.kind !== 'main' && row.submissionPolicy !== 'explicit') ||
      tx.to?.toLowerCase() !== row.recipient ||
      tx.value.toString() !== row.intendedValueWei ||
      tx.data === '0x'
    )
      fail('invalid', 'contract-binding')
  }
  if (row.kind === 'legacy') {
    const members = row.members as EvmNativeMember[]
    const drain = members[members.length - 1]!
    const tx = Transaction.from(drain.unsignedTransaction)
    if (
      tx.to?.toLowerCase() !== row.recipient ||
      tx.value.toString() !== row.intendedValueWei ||
      tx.data !== '0x' ||
      JSON.stringify(drain.dependencies) !==
        JSON.stringify(members.slice(0, -1).map((_, index) => index))
    )
      fail()
    for (const member of members.slice(0, -1)) {
      const fanIn = Transaction.from(member.unsignedTransaction)
      if (
        member.dependencies.length ||
        fanIn.to?.toLowerCase() !== drain.source.address ||
        fanIn.data !== '0x'
      )
        fail()
    }
  }
  const typed = clone(value) as EvmNativeOperation
  if (
    row.reservedBytes !== reservation(typed) ||
    row.reservedBytes > MAX_ROW ||
    encodedBytes(row) > row.reservedBytes
  )
    fail('capacity')
  return typed
}

/** The new baseline alone permits repeated sources, with an explicit contiguous nonce chain. */
function validateTransactionSet(
  members: EvmNativeMember[],
  intended: bigint,
  stages?: unknown,
): void {
  validateTransactionSetGraph(members, intended, stages, () => fail())

}

export interface EvmNativeCapture {
  readonly operationId: string
  readonly memberIndex: number
  readonly token: object
}

/** Durable recovery authority, not a finality oracle. No signed/history deletion API exists. */
export class EvmNativeOperationJournal {
  private database?: LevelDB
  private rows = new Map<string, EvmNativeOperation>()
  private nextSequence = 1
  private archivedCount = 0
  /** Test-only backing storage. Production history stays on disk, never in a hot map. */
  private readonly ephemeralHistory = new Map<string, { row: EvmNativeOperation; receipt: EvmNativeCompletionReceipt }>()
  private readonly ephemeralPreparations = new Map<string, string>()
  private readonly ephemeralConsumed = new Map<string, string>()
  private lifecycle: 'closed' | 'open' | 'uncertain' = 'closed'
  private closing = false
  private readonly signatures = new NativeSignatureValidationCache()
  private tail: Promise<unknown> = Promise.resolve()
  private captures = new Map<string, object>()
  readonly binding: EvmNativeBinding
  private readonly maxRecords: number
  private readonly maxBytes: number
  constructor(
    private readonly options: {
      binding: EvmNativeBinding
      location?: string
      testOnlyEphemeral?: boolean
      maxRecords?: number
      maxBytes?: number
    },
  ) {
    this.binding = Object.freeze(validateBinding(options.binding))
    this.options = Object.freeze({ ...options, binding: this.binding })
    if (!options.location && options.testOnlyEphemeral !== true) fail('closed')
    this.maxRecords = options.maxRecords ?? MAX_ROWS
    this.maxBytes = options.maxBytes ?? MAX_BYTES
    integer(this.maxRecords)
    integer(this.maxBytes)
    if (
      !this.maxRecords ||
      this.maxRecords > MAX_ROWS ||
      !this.maxBytes ||
      this.maxBytes > MAX_BYTES
    )
      fail('capacity')
  }
  private assertOpen(): void {
    if (this.lifecycle !== 'open')
      fail(this.lifecycle === 'uncertain' ? 'uncertain' : 'closed')
  }
  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    this.assertOpen()
    if (this.closing) fail('closed')
    const run = this.tail.then(() => {
      this.assertOpen()
      return task()
    })
    this.tail = run.catch(() => undefined)
    return run
  }
  /** Durable read/validate/write only: no RPC or signing. Browsers require Web Locks
   * across tabs; Node coordinates this realm while Level owns the physical opener. */
  private coordinated<T>(task: () => Promise<T>): Promise<T> {
    return runNativeTransactionExclusive(
      `evm-native-journal-create:${
        this.options.location ?? JSON.stringify(this.binding)
      }`,
      'single-realm',
      task,
    )
  }
  private async reloadRows(initialize: boolean): Promise<void> {
    if (!this.database) return
    const rows = new Map<string, EvmNativeOperation>()
    const manifestText = await this.stored('manifest')
    const manifest: unknown = manifestText === undefined ? undefined : JSON.parse(manifestText)
    // Only active rows participate in recovery scans. Completed history is read through
    // bounded indexed lookups; opening never materializes lifetime history.
    for await (const [key, value] of this.database.iterator({ gte: 'operation:', lt: 'operation;' })) {
      const name = String(key), text = String(value)
      if (Buffer.byteLength(text) > MAX_ROW) fail('capacity')
      const row = validateRow(JSON.parse(text) as unknown, this.binding, this.signatures)
      if (name !== `operation:${row.operationId}` || rows.has(row.operationId)) fail()
      rows.set(row.operationId, row)
    }
    let nextSequence = 1
    if (manifest !== undefined) {
      const m = object(manifest, ['version', 'binding', 'nextSequence', ...('archivedCount' in (manifest as object) ? ['archivedCount'] : [])])
      if (m.version !== 1) fail()
      if (
        JSON.stringify(validateBinding(m.binding)) !==
        JSON.stringify(this.binding)
      )
        fail('binding')
      integer(m.nextSequence)
      if (m.nextSequence < 1) fail()
      nextSequence = m.nextSequence
      if (m.archivedCount !== undefined) integer(m.archivedCount)
      this.archivedCount = m.archivedCount === undefined ? 0 : m.archivedCount as number
    } else if (rows.size || !initialize) fail()
    if (rows.size + this.archivedCount !== nextSequence - 1) fail()
    const pairs = new Set<string>(),
      preparations = new Set<string>()
    for (const row of rows.values()) {
      const sequence = parseInt(row.operationId.split(':')[1]!, 16)
      if (sequence < 1 || sequence >= nextSequence) fail()
      if (row.preparationId !== undefined) {
        if (preparations.has(row.preparationId)) fail('conflict')
        preparations.add(row.preparationId)
      }
      if (!row.cancelled)
        for (const member of row.members) {
          const pair = `${member.source.address}:${
            Transaction.from(member.unsignedTransaction).nonce
          }`
          if (pairs.has(pair)) fail('conflict')
          pairs.add(pair)
        }
    }
    const activeRows = [...rows.values()].filter(r => !r.cancelled)
    if (
      activeRows.length > this.maxRecords ||
      activeRows.reduce((n, r) => n + r.reservedBytes, 0) > this.maxBytes
    )
      fail('capacity')
    this.rows = rows
    this.nextSequence = nextSequence
    if (manifest === undefined)
      await durablePut(
        this.database,
        'manifest',
        JSON.stringify(this.manifest()),
      )
  }
  async Open(): Promise<void> {
    if (this.lifecycle !== 'closed') fail('conflict')
    this.closing = false
    try {
      if (this.options.location) {
        const database: LevelDB = level(join(this.options.location, COMPONENT))
        this.database = database
        await openDurableLevel(database, this.options.location, COMPONENT)
        await this.coordinated(() => this.reloadRows(true))
      }
      this.lifecycle = 'open'
    } catch (error) {
      this.lifecycle = 'closed'
      await this.database?.close()
      this.database = undefined
      throw error
    }
  }
  /** Read current durable authority before resuming an intent from a different wrapper/tab. */
  refreshPreparation(
    preparationId: string,
  ): Promise<EvmNativeOperation | undefined> {
    return this.exclusive(() =>
      this.coordinated(async () => {
        await this.reloadRows(false)
        this.assertOpen()
        return this.findPreparation(preparationId)
      }),
    )
  }
  private async stored(key: string): Promise<string | undefined> {
    if (!this.database) return undefined
    try {
      const value = String(await this.database.get(key))
      if (Buffer.byteLength(value) > MAX_ROW) fail('capacity')
      return value
    } catch (error) {
      if ((error as { notFound?: boolean }).notFound === true) return undefined
      throw error
    }
  }

  private operationId(id: string): void {
    if (!/^evm-native-v1:[0-9a-f]{16}$/.test(id)) fail()
  }

  private pairKey(account: string, nonce: number): string {
    return `consumed:${account}:${nonce}`
  }

  private async readArchived(id: string): Promise<EvmNativeOperation | undefined> {
    const memory = this.database ? undefined : this.ephemeralHistory.get(id)
    const text = this.database ? await this.stored(`history:${id}`) : memory && JSON.stringify(memory.row)
    if (text === undefined) return undefined
    const row = validateRow(JSON.parse(text) as unknown, this.binding, this.signatures)
    if (row.operationId !== id || !completedForHistory(row)) fail()
    const receiptText = this.database ? await this.stored(`completion:${id}`) : memory && JSON.stringify(memory.receipt)
    if (receiptText === undefined) fail()
    const receipt = validateCompletionReceipt(JSON.parse(receiptText))
    if (receipt.expectedOperationHash !== evmNativeOperationDigest(row)) fail()
    if (row.preparationId !== undefined) {
      const indexed = this.database ? await this.stored(`preparation:${row.preparationId}`) : this.ephemeralPreparations.get(row.preparationId)
      if (indexed !== id) fail()
    }
    if (!row.cancelled)
      for (const member of row.members) {
        const key = this.pairKey(member.source.address, Transaction.from(member.unsignedTransaction).nonce)
        const indexed = this.database ? await this.stored(key) : this.ephemeralConsumed.get(key)
        if (indexed !== id) fail()
      }
    return clone(row)
  }

  private async consumedBy(account: string, nonce: number): Promise<string | undefined> {
    const key = this.pairKey(account, nonce)
    const id = this.database ? await this.stored(key) : this.ephemeralConsumed.get(key)
    if (id === undefined) return undefined
    this.operationId(id)
    const row = await this.readArchived(id)
    if (!row || row.cancelled || !row.members.some(member =>
      member.source.address === account && Transaction.from(member.unsignedTransaction).nonce === nonce)) fail()
    return id
  }

  private async findPreparation(preparationId: string): Promise<EvmNativeOperation | undefined> {
    const active = [...this.rows.values()].find(row => row.preparationId === preparationId)
    const id = this.database ? await this.stored(`preparation:${preparationId}`) : this.ephemeralPreparations.get(preparationId)
    if (active) {
      if (id !== undefined) fail('conflict')
      return clone(active)
    }
    if (id === undefined) return undefined
    this.operationId(id)
    const row = await this.readArchived(id)
    if (!row || row.preparationId !== preparationId) fail()
    return row
  }

  /** Exact active or completed evidence; required missing/corrupt history fails visibly. */
  readOperation(id: string): Promise<EvmNativeOperation | undefined> {
    this.operationId(id)
    return this.exclusive(() => this.coordinated(async () => {
      await this.reloadRows(false)
      const active = this.rows.get(id)
      if (active) return clone(active)
      const archived = await this.readArchived(id)
      if (!archived && parseInt(id.split(':')[1]!, 16) < this.nextSequence) fail()
      return archived
    }))
  }

  /** Bounded exact-history enumeration. The cursor is an exclusive operation ID. */
  historyPage(input: { after?: string; limit: number }): Promise<{ operations: EvmNativeOperation[]; next?: string }> {
    const { after, limit } = input
    integer(limit)
    if (limit < 1 || limit > 100) fail('capacity')
    if (after !== undefined) this.operationId(after)
    return this.exclusive(() => this.coordinated(async () => {
      const operations: EvmNativeOperation[] = []
      let bytes = 0
      const append = async (id: string): Promise<boolean> => {
        const row = await this.readArchived(id)
        if (!row) fail()
        const size = encodedBytes(row)
        if (operations.length >= limit || bytes + size > MAX_BYTES) return false
        operations.push(row)
        bytes += size
        return true
      }
      if (this.database) {
        for await (const [key] of this.database.iterator({
          ...(after === undefined ? { gte: 'history:' } : { gt: `history:${after}` }),
          lt: 'history;', limit: limit + 1,
        })) {
          if (!await append(String(key).slice('history:'.length)))
            return { operations, next: operations.at(-1)!.operationId }
        }
      } else {
        for (const id of [...this.ephemeralHistory.keys()].sort()) {
          if (after !== undefined && id <= after) continue
          if (!await append(id)) return { operations, next: operations.at(-1)!.operationId }
        }
      }
      return { operations }
    }))
  }

  /** Retire local recovery state only after the composing owner durably finishes every
   * delivery, sync and external dependency obligation. The row itself is never rewritten.
   * One Level batch commits history, indexes and active retirement; external steps remain
   * separately checkpointed and may have had partial effects before this call. */
  archiveCompleted(id: string, input: EvmNativeCompletionReceipt): Promise<void> {
    this.operationId(id)
    const receipt = validateCompletionReceipt(input)
    return this.exclusive(() => this.coordinated(async () => {
      await this.reloadRows(false)
      const row = this.rows.get(id)
      if (!row) {
        const archived = await this.readArchived(id)
        if (!archived || evmNativeOperationDigest(archived) !== receipt.expectedOperationHash) fail('conflict')
        const previous = this.database
          ? JSON.parse((await this.stored(`completion:${id}`))!) as unknown
          : this.ephemeralHistory.get(id)!.receipt
        if (JSON.stringify(previous) !== JSON.stringify(receipt)) fail('conflict')
        return
      }
      if (evmNativeOperationDigest(row) !== receipt.expectedOperationHash || !completedForHistory(row)) fail('conflict')
      if (await this.readArchived(id)) fail('conflict')
      const operations: Parameters<typeof durableBatch>[1][number][] = [
        { type: 'put', key: `history:${id}`, value: JSON.stringify(row) },
        { type: 'put', key: `completion:${id}`, value: JSON.stringify(receipt) },
        { type: 'del', key: `operation:${id}` },
        { type: 'put', key: 'manifest', value: JSON.stringify({ ...this.manifest(), archivedCount: this.archivedCount + 1 }) },
      ]
      if (row.preparationId !== undefined) {
        const previous = this.database ? await this.stored(`preparation:${row.preparationId}`) : this.ephemeralPreparations.get(row.preparationId)
        if (previous !== undefined) fail('conflict')
        operations.push({ type: 'put', key: `preparation:${row.preparationId}`, value: id })
      }
      if (!row.cancelled)
        for (const member of row.members) {
          const nonce = Transaction.from(member.unsignedTransaction).nonce
          if (await this.consumedBy(member.source.address, nonce)) fail('conflict')
          operations.push({ type: 'put', key: this.pairKey(member.source.address, nonce), value: id })
        }
      try {
        if (this.database) await durableBatch(this.database, operations)
        else {
          this.ephemeralHistory.set(id, { row: clone(row), receipt: clone(receipt) })
          if (row.preparationId !== undefined) this.ephemeralPreparations.set(row.preparationId, id)
          if (!row.cancelled)
            for (const member of row.members)
              this.ephemeralConsumed.set(this.pairKey(member.source.address, Transaction.from(member.unsignedTransaction).nonce), id)
        }
      } catch (error) {
        this.lifecycle = 'uncertain'
        throw error
      }
      this.rows.delete(id)
      // Successful retirement ends only this operation's observation fences. Keep all
      // tokens on uncertain writes, and preserve captures belonging to active operations.
      row.members.forEach((_, index) => this.captures.delete(`${id}:${index}`))
      this.archivedCount++
    }))
  }

  private manifest() {
    return {
      version: 1,
      binding: this.binding,
      nextSequence: this.nextSequence,
      archivedCount: this.archivedCount,
    }
  }
  /** Active journal records only. Use indexed async reads for completed history. */
  list(): EvmNativeOperation[] {
    this.assertOpen()
    return [...this.rows.values()].map(clone)
  }
  /** Active record only; absence must not be interpreted as a never-created operation. */
  get(operationId: string): EvmNativeOperation {
    this.assertOpen()
    const row = this.rows.get(operationId)
    if (!row) fail('conflict')
    return clone(row)
  }
  /** Retained custody references for legacy stores and their source resolvers.
   * Transaction-set signing material and private change belong to CoinList; its `coin`
   * references must never be projected into the independently owned received-coin store.
   * Selection holds remain authoritative across every kind through canSelect(). */
  sourceReferences(): EvmNativeSource[] {
    return this.list()
      .filter(row => row.kind !== 'transaction-set')
      .flatMap(row => row.members.map(m => m.source))
  }
  referencesSpendIndex(index: number): boolean {
    this.assertOpen()
    for (const row of this.rows.values())
      if (
        !row.cancelled &&
        row.members.some(
          m => m.source.kind === 'spend' && m.source.index === index,
        )
      )
        return true
    return false
  }
  canSelect(address: string, nonce: number): boolean {
    this.assertOpen()
    for (const row of this.rows.values()) {
      if (row.cancelled) continue
      for (const m of row.members)
        if (m.source.address === address) {
          if (Transaction.from(m.unsignedTransaction).nonce === nonce)
            return false
          // The dependency leader retains its provisional value across foreign nonce advances.
          if (
            m.dependencies.length &&
            m.observation.state !== 'included-success' &&
            !(
              row.kind === 'transaction-set' &&
              (m.observation.state === 'included-revert' ||
                nativeMemberSuperseded(m))
            )
          )
            return false
          if (
            !m.dependencies.length &&
            m.observation.state !== 'included-success' &&
            m.observation.state !== 'included-revert' &&
            !nativeMemberSuperseded(m)
          )
            return false
        }
    }
    return true
  }
  async prepare(
    plan: EvmNativePlan,
    signedTransactions?: readonly string[],
  ): Promise<EvmNativeOperation> {
    const signatures =
      signedTransactions === undefined ? undefined : [...signedTransactions]
    if (signatures && signatures.length !== plan.members.length) fail()
    const frozen = clone(plan)
    return this.exclusive(() =>
      this.coordinated(async () => {
        await this.reloadRows(false)
        if (frozen.preparationId !== undefined) {
          const existing = await this.findPreparation(frozen.preparationId)
          if (existing) {
            if (
              existing.cancelled ||
              existing.kind !== frozen.kind ||
              existing.submissionPolicy !== frozen.submissionPolicy ||
              existing.recipient !== frozen.recipient ||
              existing.intendedValueWei !== frozen.intendedValueWei ||
              JSON.stringify(existing.record ?? null) !==
                JSON.stringify(frozen.record ?? null) ||
              JSON.stringify(
                existing.members.map(
                  ({
                    source,
                    unsignedTransaction,
                    dependencies,
                    transactionSet,
                  }) => ({
                    source,
                    unsignedTransaction,
                    dependencies,
                    ...(transactionSet
                      ? { transactionSet: transactionSetIntent(transactionSet) }
                      : {}),
                  }),
                ),
              ) !==
                JSON.stringify(
                  frozen.members.map(
                    ({
                      source,
                      unsignedTransaction,
                      dependencies,
                      transactionSet,
                    }) => ({
                      source,
                      unsignedTransaction,
                      dependencies,
                      ...(transactionSet
                        ? {
                            transactionSet:
                              transactionSetIntent(transactionSet),
                          }
                        : {}),
                    }),
                  ),
                )
            )
              fail('conflict')
            return clone(existing)
          }
        }
        const activeRows = [...this.rows.values()].filter(r => !r.cancelled)
        if (
          !Array.isArray(frozen.members) ||
          !frozen.members.length ||
          frozen.members.length > MAX_MEMBERS ||
          this.nextSequence >= Number.MAX_SAFE_INTEGER ||
          activeRows.length >= this.maxRecords
        )
          fail('capacity')
        const row: EvmNativeOperation = {
          version: 1,
          operationId: `evm-native-v1:${this.nextSequence
            .toString(16)
            .padStart(16, '0')}`,
          binding: this.binding,
          kind: frozen.kind,
          ...(frozen.transactionSetStages ? { transactionSetStages: frozen.transactionSetStages } : {}),
          ...(frozen.preparationId === undefined
            ? {}
            : { preparationId: frozen.preparationId }),
          ...(frozen.submissionPolicy === undefined
            ? {}
            : { submissionPolicy: frozen.submissionPolicy }),
          recipient: frozen.recipient,
          intendedValueWei: frozen.intendedValueWei,
          maximumFeeWei: frozen.members
            .reduce(
              (n, m) =>
                n +
                nativeMaximumFee(
                  checked('unsigned', () =>
                    unsigned(m.unsignedTransaction, this.binding),
                  ),
                ),
              0n,
            )
            .toString(),
          members: frozen.members.map((m, index) => ({
            ...m,
            signed: signatures
              ? {
                  rawTransaction: signatures[index]!,
                  transactionHash: keccak256(signatures[index]!),
                }
              : null,
            exposed: false,
            observation: { state: 'unknown' },
            account: null,
            syncApplied: false,
          })),
          cancelled: false,
          reservedBytes: 0,
          ...(frozen.record ? { record: frozen.record } : {}),
        }
        row.reservedBytes = reservation(row)
        const validated = validateRow(row, this.binding, this.signatures)
        if (
          activeRows.reduce((n, r) => n + r.reservedBytes, 0) +
            row.reservedBytes >
          this.maxBytes
        )
          fail('capacity')
        for (const m of row.members)
          if (
            (await this.consumedBy(m.source.address, Transaction.from(m.unsignedTransaction).nonce)) !== undefined ||
            !this.canSelect(
              m.source.address,
              Transaction.from(m.unsignedTransaction).nonce,
            )
          )
            fail('conflict')
        const nextSequence = this.nextSequence + 1
        try {
          if (this.database)
            await durableBatch(this.database, [
              {
                type: 'put',
                key: `operation:${row.operationId}`,
                value: JSON.stringify(validated),
              },
              {
                type: 'put',
                key: 'manifest',
                value: JSON.stringify({ ...this.manifest(), nextSequence }),
              },
            ])
        } catch (error) {
          this.lifecycle = 'uncertain'
          throw error
        }
        this.rows.set(row.operationId, validated)
        this.nextSequence = nextSequence
        return clone(validated)
      }),
    )
  }
  authorizeTransactionSet(id: string, expectedRawTransactions?: readonly string[]): Promise<EvmNativeOperation> {
    const expected = expectedRawTransactions === undefined ? undefined : [...expectedRawTransactions].sort()
    return this.mutate(id, row => {
      if (row.kind !== 'transaction-set' || row.cancelled || row.members.some(member => !member.signed)) fail('conflict')
      if (expected && JSON.stringify(expected) !== JSON.stringify(row.members.map(member => member.signed!.rawTransaction).sort())) fail('conflict')
      if (row.submissionAuthorized) return false
      row.submissionAuthorized = true
      row.reservedBytes = reservation(row)
      if ([...this.rows.values()].filter(other => !other.cancelled && other.operationId !== id).reduce((sum, other) => sum + other.reservedBytes, 0) + row.reservedBytes > this.maxBytes) fail('capacity')
    })
  }

  appendTransactionSet(
    id: string,
    stage: EvmTransactionSetStage,
    members: readonly EvmNativeMemberPlan[],
    signedTransactions: readonly string[],
  ): Promise<EvmNativeOperation> {
    const input = clone({ stage, members, signedTransactions })
    return this.mutate(id, async row => {
      if (row.kind !== 'transaction-set' || row.cancelled || row.submissionAuthorized || !input.stage.stageId ||
          row.members.some(member => member.exposed || !member.signed || nativeMemberSuperseded(member) || !['unknown', 'missing'].includes(member.observation.state))) fail('conflict')
      const known = row.transactionSetStages?.find(item => item.stageId === input.stage.stageId)
      if (known) {
        if (JSON.stringify(known) !== JSON.stringify(input.stage) ||
            JSON.stringify(row.members.slice(known.startIndex, known.startIndex + known.memberCount).map(member => member.signed!.rawTransaction)) !== JSON.stringify(input.signedTransactions)) fail('conflict')
        return false
      }
      if (!row.transactionSetStages || input.stage.startIndex !== row.members.length ||
          input.stage.memberCount !== input.members.length || !input.members.length ||
          input.members.length !== input.signedTransactions.length) fail('conflict')
      for (const member of input.members)
        if (await this.consumedBy(member.source.address, Transaction.from(member.unsignedTransaction).nonce)) fail('conflict')
      for (const member of input.members)
        for (const other of this.rows.values())
          if (other.operationId !== id && !other.cancelled && other.members.some(candidate =>
              candidate.source.address === member.source.address &&
              !nativeMemberSuperseded(candidate) &&
              candidate.observation.state !== 'included-success' && candidate.observation.state !== 'included-revert')) fail('conflict')
      row.transactionSetStages.push(input.stage)
      row.members.push(...input.members.map((member, index) => ({
        ...member, signed: { rawTransaction: input.signedTransactions[index]!, transactionHash: keccak256(input.signedTransactions[index]!) },
        exposed: false, observation: { state: 'unknown' as const }, account: null, syncApplied: false,
      })))
      row.maximumFeeWei = row.members.reduce((sum, member) => sum + nativeMaximumFee(Transaction.from(member.unsignedTransaction)), 0n).toString()
      row.reservedBytes = reservation(row)
      if (row.members.length > MAX_MEMBERS || [...this.rows.values()].filter(other => !other.cancelled && other.operationId !== id).reduce((sum, other) => sum + other.reservedBytes, 0) + row.reservedBytes > this.maxBytes) fail('capacity')
    })
  }

  private async mutate(
    id: string,
    change: (row: EvmNativeOperation) => void | boolean | Promise<void | boolean>,
  ): Promise<EvmNativeOperation> {
    return this.exclusive(() =>
      this.coordinated(async () => {
        // Mutation owns only its changed fields; the current durable row owns all other facts.
        await this.reloadRows(false)
        const row = this.get(id)
        if (await change(row) === false) return row
        const validated = validateRow(row, this.binding, this.signatures)
        try {
          if (this.database)
            await durablePut(
              this.database,
              `operation:${id}`,
              JSON.stringify(validated),
            )
        } catch (error) {
          this.lifecycle = 'uncertain'
          throw error
        }
        this.rows.set(id, validated)
        return clone(validated)
      }),
    )
  }
  checkpointSigned(
    id: string,
    index: number,
    rawTransaction: string,
  ): Promise<EvmNativeOperation> {
    return this.mutate(id, row => {
      const m = row.members[index]
      if (
        !m ||
        row.cancelled ||
        (m.signed && m.signed.rawTransaction !== rawTransaction)
      )
        fail('conflict')
      m.signed = {
        rawTransaction,
        transactionHash: keccak256(rawTransaction),
      }
    })
  }
  markExposed(id: string, index: number): Promise<EvmNativeOperation> {
    return this.mutate(id, row => {
      const m = row.members[index]
      if (
        !m?.signed ||
        (row.kind === 'transaction-set' &&
          row.members.some(member => !member.signed)) ||
        row.cancelled ||
        m.dependencies.some(d =>
          row.kind === 'transaction-set'
            ? !row.members[d]!.exposed &&
              row.members[d]!.observation.state !== 'included-success' &&
              row.members[d]!.observation.state !== 'included-revert'
            : row.members[d]!.observation.state !== 'included-success',
        )
      )
        fail('conflict')
      if (row.kind === 'transaction-set' && m.dependencies.some(index =>
          row.members[index]!.source.address !== m.source.address && row.members[index]!.observation.state !== 'included-success')) fail('conflict')
      if (
        row.kind === 'transaction-set' &&
        m.transactionSet?.predecessorWaitBlocks !== undefined &&
        m.dependencies.some(
          index => !('blockNumber' in row.members[index]!.observation),
        )
      )
        fail('conflict')
      m.exposed = true
    })
  }
  markTransactionSetInventoryApplied(
    id: string,
    index: number,
  ): Promise<EvmNativeOperation> {
    return this.mutate(id, row => {
      const member = row.members[index]
      if (
        row.kind !== 'transaction-set' ||
        !member?.transactionSet ||
        !terminalInventoryEvidence(member)
      )
        fail('conflict')
      member.transactionSet.inventoryApplied = true
    })
  }
  markSyncApplied(id: string, index: number): Promise<EvmNativeOperation> {
    return this.mutate(id, row => {
      const m = row.members[index]
      if (!m || m.observation.state !== 'included-success') fail('conflict')
      m.syncApplied = true
    })
  }
  cancelUnsigned(id: string): Promise<EvmNativeOperation> {
    return this.mutate(id, row => {
      if (row.members.some(m => m.signed || m.exposed)) fail('conflict')
      row.cancelled = true
    })
  }
  /**
   * Ends an operation none of whose members was ever handed to the network: its signed bytes are
   * dropped and it is cancelled. Bytes that never left this device cannot land, so nothing is
   * left to reconcile; an exposed member refuses this.
   */
  discardUnexposed(id: string): Promise<EvmNativeOperation> {
    return this.mutate(id, row => {
      if (row.submissionAuthorized || row.members.some(m => m.exposed || (row.kind === 'transaction-set' && (nativeMemberSuperseded(m) || !['unknown', 'missing'].includes(m.observation.state))))) fail('conflict')
      for (const m of row.members) {
        m.signed = null
        m.observation = { state: 'unknown' }
        m.account = null
      }
      row.cancelled = true
    })
  }
  beginCapture(operationId: string, memberIndex: number): EvmNativeCapture {
    if (this.closing) fail('closed')
    const row = this.get(operationId)
    if (!row.members[memberIndex]?.signed || row.cancelled) fail('conflict')
    const token = {}
    this.captures.set(`${operationId}:${memberIndex}`, token)
    return { operationId, memberIndex, token }
  }
  async recordObservation(
    capture: EvmNativeCapture,
    observation: EvmNativeObservation,
    account: EvmNativeAccountObservation | null,
    contradiction?: EvmNativeInclusionContradiction,
  ): Promise<boolean> {
    const frozenObservation = checked('observation', () =>
      validateObservation(observation),
    )
    const frozenAccount = checked('account', () => validateAccount(account))
    const frozenContradiction =
      contradiction &&
      checked('observation', () => {
        const proof = object(contradiction, [
          'blockNumber',
          'orphanedBlockHash',
          'canonicalBlockHash',
        ])
        integer(proof.blockNumber)
        hash(proof.orphanedBlockHash)
        hash(proof.canonicalBlockHash)
        if (proof.orphanedBlockHash === proof.canonicalBlockHash) fail()
        return clone(contradiction)
      })
    const key = `${capture.operationId}:${capture.memberIndex}`
    let recorded = false
    await this.mutate(capture.operationId, row => {
      if (this.captures.get(key) !== capture.token) return false
      const m = row.members[capture.memberIndex]
      if (row.cancelled || !m?.signed) return false
      // `unknown` is the absence of an answer (a failed or inconsistent read), not evidence.
      // It never replaces what the chain has already been seen to say: a member recorded
      // included stays included unless fresh canonical evidence contradicts THAT inclusion.
      // An unavailable RPC is never such evidence. The capture and exact block binding prevent
      // a late observation from invalidating a newer inclusion.
      if (
        frozenObservation.state === 'unknown' &&
        m.observation.state !== 'unknown' &&
        !(
          frozenContradiction &&
          (m.observation.state === 'included-success' ||
            m.observation.state === 'included-revert') &&
          m.observation.blockNumber === frozenContradiction.blockNumber &&
          m.observation.blockHash === frozenContradiction.orphanedBlockHash
        )
      )
        return false
      if (
        m.transactionSet &&
        (JSON.stringify(m.observation) !== JSON.stringify(frozenObservation) ||
          JSON.stringify(m.account) !== JSON.stringify(frozenAccount))
      )
        delete m.transactionSet.inventoryApplied
      m.observation = frozenObservation
      m.account = frozenAccount
      if (frozenObservation.state !== 'included-success') m.syncApplied = false
      recorded = true
    })
    return recorded
  }
  async Close(): Promise<void> {
    this.closing = true
    this.captures.clear()
    await this.tail
    this.lifecycle = 'closed'
    this.signatures.clear()
    await this.database?.close()
    this.database = undefined
  }
}
