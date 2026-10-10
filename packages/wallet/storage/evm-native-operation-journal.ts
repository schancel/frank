import level, { type LevelDB } from 'level'
import { join } from 'path'
import { getAddress, keccak256, Transaction } from 'ethers'
import { PROTOCOL_CHAINS } from '../chain/chains-registry'
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
export interface EvmNativeOperation {
  version: 1
  operationId: string
  binding: EvmNativeBinding
  kind: EvmNativeOperationKind
  recipient: string
  intendedValueWei: string
  maximumFeeWei: string
  members: EvmNativeMember[]
  cancelled: boolean
  reservedBytes: number
}
export interface EvmNativePlan {
  kind: EvmNativeOperationKind
  recipient: string
  intendedValueWei: string
  members: EvmNativeMemberPlan[]
}
export class EvmNativeJournalError extends Error {
  constructor(
    readonly code:
      | 'invalid'
      | 'binding'
      | 'capacity'
      | 'conflict'
      | 'closed'
      | 'uncertain',
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
function fail(code: EvmNativeJournalError['code'] = 'invalid'): never {
  throw new EvmNativeJournalError(code)
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
    kind === 'main'
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
  ])
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
  if (row.kind !== 'legacy' && row.members.length !== 1) fail()
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
    const source = validateSource(member.source)
    if (sourceAddresses.has(source.address)) fail()
    sourceAddresses.add(source.address)
    const tx = unsigned(member.unsignedTransaction, binding)
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
        fail()
    } else if (member.exposed || member.syncApplied) fail()
    const observation = validateObservation(member.observation)
    if (
      'transactionHash' in observation &&
      (member.signed === null ||
        observation.transactionHash !==
          (member.signed as { transactionHash: string }).transactionHash)
    )
      fail()
    if (member.syncApplied && observation.state !== 'included-success') fail()
    validateAccount(member.account)
    if (row.cancelled && (member.signed !== null || member.exposed)) fail()
  }
  if (fee.toString() !== row.maximumFeeWei) fail()
  if (fee + uint(row.intendedValueWei) > UINT_MAX) fail()
  if (row.kind === 'contract') {
    const call = (row.members as EvmNativeMember[])[0]!
    const tx = Transaction.from(call.unsignedTransaction)
    if (
      call.source.kind !== 'main' ||
      tx.to?.toLowerCase() !== row.recipient ||
      tx.value.toString() !== row.intendedValueWei ||
      tx.data === '0x'
    )
      fail()
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
  async Open(): Promise<void> {
    if (this.lifecycle !== 'closed') fail('conflict')
    this.closing = false
    const rows = new Map<string, EvmNativeOperation>()
    let manifest: unknown
    try {
      if (this.options.location) {
        const database: LevelDB = level(join(this.options.location, COMPONENT))
        this.database = database
        await openDurableLevel(database, this.options.location, COMPONENT)
        for await (const [key, value] of database.iterator()) {
          const name = String(key)
          const text = String(value)
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
      }
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
        this.nextSequence = m.nextSequence
      } else if (rows.size) fail()
      // Rows are never deleted, including cancelled plans. The manifest therefore
      // commits to every allocated sequence, not merely an upper bound.
      if (rows.size !== this.nextSequence - 1) fail()
      for (const row of rows.values()) {
        const sequence = parseInt(row.operationId.split(':')[1]!, 16)
        if (sequence < 1 || sequence >= this.nextSequence) fail()
      }
      if (
        rows.size > this.maxRecords ||
        [...rows.values()].reduce((n, r) => n + r.reservedBytes, 0) >
          this.maxBytes
      )
        fail('capacity')
      this.rows = rows
      if (manifest === undefined && this.database)
        await durablePut(
          this.database,
          'manifest',
          JSON.stringify(this.manifest()),
        )
      this.lifecycle = 'open'
      // Detect corrupt competing claims even before any input can be selected.
      const pairs = new Set<string>()
      for (const row of rows.values())
        if (!row.cancelled)
          for (const m of row.members) {
            const pair = `${m.source.address}:${
              Transaction.from(m.unsignedTransaction).nonce
            }`
            if (pairs.has(pair)) fail('conflict')
            pairs.add(pair)
          }
    } catch (error) {
      this.lifecycle = 'closed'
      await this.database?.close()
      this.database = undefined
      throw error
    }
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
    return this.list().some(
      row =>
        !row.cancelled &&
        row.members.some(
          m => m.source.kind === 'spend' && m.source.index === index,
        ),
    )
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
            m.observation.state !== 'included-revert'
          )
            return false
        }
    }
    return true
  }
  async prepare(plan: EvmNativePlan): Promise<EvmNativeOperation> {
    const frozen = clone(plan)
    return this.exclusive(async () => {
      if (
        !Array.isArray(frozen.members) ||
        !frozen.members.length ||
        frozen.members.length > MAX_MEMBERS ||
        this.nextSequence >= Number.MAX_SAFE_INTEGER ||
        this.rows.size >= this.maxRecords
      )
        fail('capacity')
      const row: EvmNativeOperation = {
        version: 1,
        operationId: `evm-native-v1:${this.nextSequence
          .toString(16)
          .padStart(16, '0')}`,
        binding: this.binding,
        kind: frozen.kind,
        recipient: frozen.recipient,
        intendedValueWei: frozen.intendedValueWei,
        maximumFeeWei: frozen.members
          .reduce(
            (n, m) =>
              n +
              nativeMaximumFee(unsigned(m.unsignedTransaction, this.binding)),
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
      }
      row.reservedBytes = reservation(row)
      const validated = validateRow(row, this.binding)
      if (
        [...this.rows.values()].reduce((n, r) => n + r.reservedBytes, 0) +
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
    })
  }
  private async mutate(
    id: string,
    change: (row: EvmNativeOperation) => void | boolean,
  ): Promise<EvmNativeOperation> {
    return this.exclusive(async () => {
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
    })
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
      m.signed = { rawTransaction, transactionHash: keccak256(rawTransaction) }
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
  ): Promise<boolean> {
    const frozenObservation = validateObservation(observation)
    const frozenAccount = validateAccount(account)
    const key = `${capture.operationId}:${capture.memberIndex}`
    let recorded = false
    await this.mutate(capture.operationId, row => {
      if (this.captures.get(key) !== capture.token) return false
      const m = row.members[capture.memberIndex]!
      // `unknown` is the absence of an answer (a failed or inconsistent read), not evidence.
      // It never replaces what the chain has already been seen to say: a member recorded
      // included stays included, and one recorded missing or pending stays so, until a read
      // that did answer says otherwise.
      if (
        frozenObservation.state === 'unknown' &&
        m.observation.state !== 'unknown'
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
