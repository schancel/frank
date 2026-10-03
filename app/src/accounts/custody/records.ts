import {
  decodeRecoveryDescriptor,
  encodeRecoveryDescriptor,
  encodeRecoveryFingerprint,
} from '@frank/account-recovery'
import { createVaultWriteIntent } from '@frank/account-vault'
import {
  DERIVATION_REGISTRY_ID,
  DOMAIN_PURPOSES,
  type DomainRoot,
} from '@frank/domain-roots'
import {
  CustodyError,
  type CustodySnapshot,
  type ExpectedActive,
  type PublicAccount,
  type StageAccount,
} from './types'

const MAX_REVISION = 0xfffffffe
const typed = Object.getPrototypeOf(Uint8Array.prototype)
const lengthOf = Object.getOwnPropertyDescriptor(typed, 'length')!.get!
const bufferOf = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!
const tagOf = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!
const setBytes = Uint8Array.prototype.set

export function invalid(): never {
  throw new CustodyError('invalid-input')
}
export function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    invalid()
  return value
}
function revision(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_REVISION
  )
    invalid()
  return value as number
}
export function expected(value: ExpectedActive): ExpectedActive {
  const n = revision(value.revision),
    accountId = value.accountId
  if ((n === 0) !== (accountId === null)) invalid()
  return Object.freeze({
    revision: n,
    accountId: accountId === null ? null : id(accountId),
  })
}
export function matches(
  state: CustodySnapshot,
  value: ExpectedActive,
): boolean {
  return (
    state.revision === value.revision &&
    (state.active?.receipt.context.accountId ?? null) === value.accountId
  )
}
export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function bytes(value: Uint8Array): Uint8Array {
  if (
    Reflect.apply(tagOf, value, []) !== 'Uint8Array' ||
    Reflect.apply(lengthOf, value, []) !== 32 ||
    !(Reflect.apply(bufferOf, value, []) instanceof ArrayBuffer)
  )
    invalid()
  const result = new Uint8Array(32)
  Reflect.apply(setBytes, result, [value])
  return result
}
function hex(value: Uint8Array): string {
  const snapshot = bytes(value)
  return Array.from(snapshot, byte => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}
function hexText(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid()
  return value
}
function displayName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 80 ||
    value !== value.trim() ||
    Array.from(value).some(character => {
      const code = character.charCodeAt(0)
      return code <= 31 || (code >= 127 && code <= 159)
    })
  )
    invalid()
  return value
}

export function wipe(roots: readonly DomainRoot[]): void {
  for (const root of roots) root.bytes.fill(0)
}

/** Capture every caller-controlled property before the first await. No object spreads. */
export function capture(input: StageAccount): {
  account: PublicAccount
  expectedActive: ExpectedActive
  roots: readonly DomainRoot[]
} {
  const roots: DomainRoot[] = []
  try {
    const attemptId = id(input.attemptId),
      accountId = id(input.accountId)
    const expectedActive = expected(input.expectedActive)
    const name = displayName(input.displayName),
      custodyEpoch = revision(input.custodyEpoch)
    const metadata = input.metadata
    const descriptor = encodeRecoveryDescriptor(metadata.descriptor)
    const decoded = decodeRecoveryDescriptor(descriptor)
    const fingerprint = encodeRecoveryFingerprint(
      decoded.publicRecoveryFingerprint,
    )
    const masterRetirementId = hex(metadata.masterRetirementId)
    const recoveryIdentityCommitment = hex(metadata.recoveryIdentityCommitment)
    const source = input.roots
    if (!Array.isArray(source)) invalid()
    const count = source.length
    if (count < 1 || count > DOMAIN_PURPOSES.length) invalid()
    let last = -1
    for (let i = 0; i < count; i++) {
      const root = source[i],
        registry = root.registry,
        purpose = root.purpose
      const index = DOMAIN_PURPOSES.indexOf(purpose)
      if (registry !== DERIVATION_REGISTRY_ID || index <= last) invalid()
      last = index
      roots.push(Object.freeze({ registry, purpose, bytes: bytes(root.bytes) }))
    }
    const intent = createVaultWriteIntent({
      expected: null,
      operationId: attemptId,
      context: {
        accountId,
        creationId: attemptId,
        custodyEpoch,
        recoveryFormat: decoded.recoveryFormat,
        registry: decoded.registry,
        purposes: roots.map(root => root.purpose),
        recoveryFingerprint: fingerprint,
        retirementContext: masterRetirementId,
      },
    })
    return {
      account: Object.freeze({
        displayName: name,
        descriptor,
        fingerprint,
        masterRetirementId,
        recoveryIdentityCommitment,
        receipt: intent.receipt,
      }),
      expectedActive,
      roots: Object.freeze(roots),
    }
  } catch {
    wipe(roots)
    throw new CustodyError('invalid-input')
  }
}

function keys(value: object, names: string[]): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).sort().join(',') !== names.sort().join(',')
  )
    invalid()
}
function account(value: PublicAccount): PublicAccount {
  keys(value, [
    'displayName',
    'descriptor',
    'fingerprint',
    'masterRetirementId',
    'recoveryIdentityCommitment',
    'receipt',
  ])
  const descriptor = encodeRecoveryDescriptor(
    decodeRecoveryDescriptor(value.descriptor),
  )
  const fingerprint = encodeRecoveryFingerprint(
    decodeRecoveryDescriptor(descriptor).publicRecoveryFingerprint,
  )
  const masterRetirementId = hexText(value.masterRetirementId)
  const supplied = value.receipt
  const receipt = createVaultWriteIntent({
    expected: null,
    context: supplied.context,
    operationId: supplied.operationId,
  }).receipt
  if (
    !same(receipt, supplied) ||
    receipt.context.creationId !== receipt.operationId ||
    fingerprint !== value.fingerprint ||
    receipt.context.recoveryFingerprint !== fingerprint ||
    receipt.context.retirementContext !== masterRetirementId
  )
    invalid()
  id(receipt.context.accountId)
  id(receipt.operationId)
  return Object.freeze({
    displayName: displayName(value.displayName),
    descriptor,
    fingerprint,
    masterRetirementId,
    recoveryIdentityCommitment: hexText(value.recoveryIdentityCommitment),
    receipt,
  })
}

/** Strictly parse our own durable record. Unknown schemas never become an empty account. */
export function parse(value: CustodySnapshot | undefined): CustodySnapshot {
  if (value === undefined)
    return Object.freeze({
      schema: 1,
      revision: 0,
      active: null,
      pending: null,
    })
  try {
    keys(value, ['schema', 'revision', 'active', 'pending'])
    if (value.schema !== 1) invalid()
    const n = revision(value.revision)
    const active = value.active === null ? null : account(value.active)
    if ((n === 0) !== (active === null)) invalid()
    let pending = null
    if (value.pending !== null) {
      keys(value.pending, ['status', 'account', 'expectedActive'])
      const status = value.pending.status
      if (status !== 'staging' && status !== 'discarding') invalid()
      keys(value.pending.expectedActive, ['revision', 'accountId'])
      pending = Object.freeze({
        status,
        account: account(value.pending.account),
        expectedActive: expected(value.pending.expectedActive),
      })
      if (
        pending.account.receipt.context.creationId ===
        active?.receipt.context.creationId
      )
        invalid()
      if (
        status === 'staging' &&
        !matches(
          { revision: n, active } as CustodySnapshot,
          pending.expectedActive,
        )
      )
        invalid()
    }
    return Object.freeze({ schema: 1, revision: n, active, pending })
  } catch {
    throw new CustodyError('locked')
  }
}

export function nextRevision(state: CustodySnapshot): number {
  if (state.revision >= MAX_REVISION) throw new CustodyError('capacity')
  return state.revision + 1
}
