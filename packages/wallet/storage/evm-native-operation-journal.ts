import level, { type LevelDB } from 'level'
import { join } from 'path'
import { getAddress, keccak256, Transaction } from 'ethers'
import { PROTOCOL_CHAINS } from '../chain/chains-registry'
import { runNativeTransactionExclusive } from '../chain/chain-wallet'
import { durableBatch, durablePut, openDurableLevel } from './level-durability'

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
export type EvmNativeOperationKind = 'native' | 'legacy' | 'contract'
export interface EvmNativeMemberPlan {
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
export interface EvmNativeOperation {
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
export interface EvmNativePlan {
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
    )
      throw new EvmNativeJournalError(error.code, validation)
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
function reservation(row: EvmNativeOperation): number {
  const max = clone(row)
  max.cancelled = false
  max.members = max.members.map(member => ({
    ...member,
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
function validateRow(
  value: unknown,
  binding: EvmNativeBinding,
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
    ...(hasRecord ? ['record'] : []),
    ...(hasSubmissionPolicy ? ['submissionPolicy'] : []),
  ])
  if (
    hasPreparationId &&
    (typeof row.preparationId !== 'string' ||
      !/^stealth-payment:[a-zA-Z0-9_-]{1,128}$/.test(row.preparationId) ||
      !(
        row.kind === 'native' ||
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
  if (row.kind !== 'native' && row.kind !== 'legacy' && row.kind !== 'contract')
    fail()
  address(row.recipient)
  if (uint(row.intendedValueWei) === 0n && row.kind !== 'contract') fail()
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
    ])
    const source = checked('source', () => validateSource(member.source))
    if (sourceAddresses.has(source.address)) fail()
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
      const parsed = Transaction.from(signed.rawTransaction)
      if (
        !parsed.isSigned() ||
        parsed.serialized !== signed.rawTransaction ||
        parsed.unsignedSerialized !== member.unsignedTransaction ||
        parsed.from?.toLowerCase() !== source.address ||
        parsed.hash !== signed.transactionHash
      )
        fail('invalid', 'signature')
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
  if (row.members.length > 1 && row.kind !== 'legacy') {
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
  private lifecycle: 'closed' | 'open' | 'uncertain' = 'closed'
  private closing = false
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
    let manifest: unknown
    for await (const [key, value] of this.database.iterator()) {
      const name = String(key),
        text = String(value)
      if (Buffer.byteLength(text) > MAX_ROW) fail('capacity')
      if (name === 'manifest') manifest = JSON.parse(text) as unknown
      else if (name.startsWith('operation:')) {
        const row = validateRow(JSON.parse(text) as unknown, this.binding)
        if (
          name !== `operation:${row.operationId}` ||
          rows.has(row.operationId)
        )
          fail()
        rows.set(row.operationId, row)
      } else fail()
    }
    let nextSequence = 1
    if (manifest !== undefined) {
      const m = object(manifest, ['version', 'binding', 'nextSequence'])
      if (m.version !== 1) fail()
      if (
        JSON.stringify(validateBinding(m.binding)) !==
        JSON.stringify(this.binding)
      )
        fail('binding')
      integer(m.nextSequence)
      if (m.nextSequence < 1) fail()
      nextSequence = m.nextSequence
    } else if (rows.size || !initialize) fail()
    if (rows.size !== nextSequence - 1) fail()
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
        return this.list().find(row => row.preparationId === preparationId)
      }),
    )
  }
  private manifest() {
    return {
      version: 1,
      binding: this.binding,
      nextSequence: this.nextSequence,
    }
  }
  list(): EvmNativeOperation[] {
    this.assertOpen()
    return [...this.rows.values()].map(clone)
  }
  get(operationId: string): EvmNativeOperation {
    this.assertOpen()
    const row = this.rows.get(operationId)
    if (!row) fail('conflict')
    return clone(row)
  }
  sourceReferences(): EvmNativeSource[] {
    return this.list().flatMap(row => row.members.map(m => m.source))
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
            m.observation.state !== 'included-success'
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
  async prepare(plan: EvmNativePlan): Promise<EvmNativeOperation> {
    const frozen = clone(plan)
    return this.exclusive(() =>
      this.coordinated(async () => {
        await this.reloadRows(false)
        if (frozen.preparationId !== undefined) {
          const existing = [...this.rows.values()].find(
            row => row.preparationId === frozen.preparationId,
          )
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
                  ({ source, unsignedTransaction, dependencies }) => ({
                    source,
                    unsignedTransaction,
                    dependencies,
                  }),
                ),
              ) !==
                JSON.stringify(
                  frozen.members.map(
                    ({ source, unsignedTransaction, dependencies }) => ({
                      source,
                      unsignedTransaction,
                      dependencies,
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
          members: frozen.members.map(m => ({
            ...m,
            signed: null,
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
        const validated = validateRow(row, this.binding)
        if (
          activeRows.reduce((n, r) => n + r.reservedBytes, 0) +
            row.reservedBytes >
          this.maxBytes
        )
          fail('capacity')
        for (const m of row.members)
          if (
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
  private async mutate(
    id: string,
    change: (row: EvmNativeOperation) => void | boolean,
  ): Promise<EvmNativeOperation> {
    return this.exclusive(() =>
      this.coordinated(async () => {
        // Mutation owns only its changed fields; the current durable row owns all other facts.
        await this.reloadRows(false)
        const row = this.get(id)
        if (change(row) === false) return row
        const validated = validateRow(row, this.binding)
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
        row.cancelled ||
        m.dependencies.some(
          d => row.members[d]!.observation.state !== 'included-success',
        )
      )
        fail('conflict')
      m.exposed = true
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
      if (row.members.some(m => m.exposed)) fail('conflict')
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
    await this.database?.close()
    this.database = undefined
  }
}
