import { DERIVATION_REGISTRY_ID, DOMAIN_PURPOSES, RECOVERY_FORMAT_ID, type DomainRoot } from '@frank/domain-roots'
import { VaultError, type VaultContext, type VaultReceipt, type VaultWriteIntent } from './types.js'

export const POLICY = 'browser-preview-aes-gcm-v1'
export const MAX_SLOTS = 1024
const MAX_REVISION = 0xfffffffe

/** Caller accessors/proxies must not leak arbitrary exceptions through the public API. */
export function validate<T>(parse: () => T): T {
  try { return parse() } catch { throw new VaultError('invalid-input') }
}

function reject(): never { throw new VaultError('invalid-input') }
function text(value: unknown, empty = false): string {
  if (typeof value !== 'string' || value.length > 128 || (!empty && !value.length) || /[^\x20-\x7e]/.test(value)) reject()
  return value
}
function integer(value: unknown, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > MAX_REVISION) reject()
  return value as number
}

export function context(value: VaultContext): VaultContext {
  if (!value || value.registry !== DERIVATION_REGISTRY_ID || value.recoveryFormat !== RECOVERY_FORMAT_ID) reject()
  const source = value.purposes
  if (!Array.isArray(source)) reject()
  const count = source.length
  if (!Number.isInteger(count) || count < 1 || count > DOMAIN_PURPOSES.length) reject()
  const purposes: VaultContext['purposes'][number][] = []
  let last = -1
  for (let i = 0; i < count; i++) {
    const purpose = source[i]
    const index = DOMAIN_PURPOSES.indexOf(purpose)
    if (index <= last) reject()
    last = index
    purposes.push(purpose)
  }
  return Object.freeze({
    accountId: text(value.accountId), creationId: text(value.creationId),
    recoveryFormat: RECOVERY_FORMAT_ID, registry: DERIVATION_REGISTRY_ID,
    purposes: Object.freeze(purposes), custodyEpoch: integer(value.custodyEpoch, 0),
    recoveryFingerprint: text(value.recoveryFingerprint), retirementContext: text(value.retirementContext, true),
  })
}

export function receipt(value: VaultReceipt): VaultReceipt {
  if (!value || value.schema !== 1 || value.policy !== POLICY) reject()
  const previousRevision = integer(value.previousRevision, 0)
  const revision = integer(value.revision, 1)
  if (revision !== previousRevision + 1) reject()
  return Object.freeze({ schema: 1, policy: POLICY, context: context(value.context), previousRevision, revision, operationId: text(value.operationId) })
}

export function createIntent(input: { context: VaultContext; expected: VaultReceipt | null; operationId: string }): VaultWriteIntent {
  if (!input) reject()
  const next = context(input.context)
  const expected = input.expected === null ? null : receipt(input.expected)
  if (expected && (expected.context.accountId !== next.accountId || expected.context.creationId !== next.creationId ||
      next.custodyEpoch < expected.context.custodyEpoch || expected.operationId === input.operationId)) reject()
  return Object.freeze({ expected, receipt: receipt({ schema: 1, policy: POLICY, context: next,
    previousRevision: expected?.revision ?? 0, revision: (expected?.revision ?? 0) + 1, operationId: input.operationId }) })
}

export function intent(value: VaultWriteIntent): VaultWriteIntent {
  if (!value) reject()
  const supplied = receipt(value.receipt)
  const canonical = createIntent({ context: supplied.context, expected: value.expected, operationId: supplied.operationId })
  if (!same(canonical.receipt, supplied)) reject()
  return canonical
}

/** Fixed order, length-prefixed ASCII and big-endian u32. Only public metadata. */
export function aad(value: VaultReceipt): Uint8Array<ArrayBuffer> {
  const parts: number[] = []
  const u32 = (n: number) => parts.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)
  const field = (s: string) => { parts.push(s.length >>> 8, s.length & 255); for (let i = 0; i < s.length; i++) parts.push(s.charCodeAt(i)) }
  field('frank/local-vault'); u32(value.schema); field(value.policy)
  const c = value.context
  field(c.accountId); field(c.creationId); field(c.recoveryFormat); field(c.registry)
  parts.push(c.purposes.length)
  for (const purpose of c.purposes) field(purpose)
  u32(c.custodyEpoch); u32(value.previousRevision); u32(value.revision)
  field(c.recoveryFingerprint); field(c.retirementContext); field(value.operationId)
  return Uint8Array.from(parts)
}

export function same(a: VaultReceipt, b: VaultReceipt): boolean {
  const x = aad(a), y = aad(b)
  return x.length === y.length && x.every((byte, i) => byte === y[i])
}

/**
 * Encode typed roots followed by the account root they were derived from, copying
 * synchronously before the first asynchronous boundary. Framing version 2.
 */
export function plaintext(roots: readonly DomainRoot[], accountRoot: Uint8Array, c: VaultContext): Uint8Array<ArrayBuffer> {
  const count = c.purposes.length
  if (!Array.isArray(roots) || roots.length !== count) reject()
  const output = new Uint8Array(2 + count * 33 + 32)
  try {
    output[0] = 2; output[1] = count
    for (let i = 0; i < count; i++) {
      const root = roots[i]
      if (!root || root.registry !== DERIVATION_REGISTRY_ID || root.purpose !== c.purposes[i]) reject()
      output[2 + 33 * i] = DOMAIN_PURPOSES.indexOf(c.purposes[i]) + 1
      output.set(secret(root.bytes), 3 + 33 * i)
    }
    output.set(secret(accountRoot), 2 + 33 * count)
    return output
  } catch (error) { output.fill(0); throw error }
}

function secret(bytes: unknown): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32 || !(bytes.buffer instanceof ArrayBuffer)) reject()
  return bytes
}

/** Version 1 records predate the stored account root: they hold the typed roots only. */
function framed(bytes: Uint8Array, c: VaultContext): 1 | 2 {
  const version = bytes[0], roots = 2 + c.purposes.length * 33
  if ((version !== 1 && version !== 2) || bytes.length !== roots + (version === 2 ? 32 : 0) || bytes[1] !== c.purposes.length) throw new VaultError('corrupt')
  // Validate the whole payload before publishing any independently owned secret.
  for (let i = 0; i < c.purposes.length; i++) {
    if (bytes[2 + i * 33] !== DOMAIN_PURPOSES.indexOf(c.purposes[i]) + 1) throw new VaultError('corrupt')
  }
  return version
}

export function decode(bytes: Uint8Array, c: VaultContext): readonly DomainRoot[] {
  framed(bytes, c)
  return Object.freeze(c.purposes.map((purpose, i) => Object.freeze({
    purpose, registry: DERIVATION_REGISTRY_ID, bytes: bytes.slice(3 + i * 33, 35 + i * 33),
  })))
}

/** The stored account root, or null for a version 1 record that never held one. */
export function decodeAccountRoot(bytes: Uint8Array, c: VaultContext): Uint8Array | null {
  return framed(bytes, c) === 2 ? bytes.slice(2 + c.purposes.length * 33) : null
}
