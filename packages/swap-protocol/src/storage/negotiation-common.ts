import { sha256 } from '@noble/hashes/sha256.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { uncompressedPubkey } from '@frank/codec'
import {
  inspectNegotiationJournalRecord,
  negotiationJournalLimits,
  NegotiationJournalError,
  type NegotiationJournalStore,
} from '../negotiation-journal'

/** Account storage policy, independent of protocol and per-journal admission limits. */
export const negotiationStorageLimits = Object.freeze({
  rows: 128,
  rawBytes: 8388608,
})
export interface NegotiationStorageBinding {
  readonly hostDiscriminator: string
  readonly accountIncarnation: string
  readonly localPublicKey: Uint8Array
}
export interface OwnedNegotiationJournalStore extends NegotiationJournalStore {
  readonly namespace: string
  close(): Promise<void>
}
export const BINDING_KEY = 'binding-v1'
export const RECORDS_STORE = 'records'
function scalar(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > maximum ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    ) ||
    utf8ToBytes(value).length > maximum
  )
    throw new TypeError('Bounded scalar UTF-8 storage binding required')
  return value
}
function framed(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(
    parts.reduce((sum, part) => sum + 4 + part.length, 0),
  )
  const view = new DataView(bytes.buffer)
  let offset = 0
  for (const part of parts) {
    view.setUint32(offset, part.length, false)
    bytes.set(part, offset + 4)
    offset += part.length + 4
  }
  return bytes
}
export function bind(input: NegotiationStorageBinding) {
  const hostDiscriminator = scalar(input?.hostDiscriminator, 128)
  const accountIncarnation = scalar(input?.accountIncarnation, 256)
  if (
    !(input?.localPublicKey instanceof Uint8Array) ||
    input.localPublicKey.length !== 33
  )
    throw new TypeError('Compressed local public key required')
  const key = new Uint8Array(input.localPublicKey)
  uncompressedPubkey(key) // Actual secp256k1 point validation, not merely length/prefix.
  const localPublicKey = bytesToHex(key)
  const metadata = JSON.stringify({
    version: 1,
    hostDiscriminator,
    accountIncarnation,
    localPublicKey,
  })
  const namespace =
    'frank-swap-negotiation-v1-' +
    bytesToHex(
      sha256(
        framed([
          utf8ToBytes('frank/swap-negotiation-storage/v1'),
          utf8ToBytes(hostDiscriminator),
          utf8ToBytes(accountIncarnation),
          key,
        ]),
      ),
    )
  return Object.freeze({
    hostDiscriminator,
    accountIncarnation,
    localPublicKey,
    metadata,
    namespace,
  })
}
export type Binding = ReturnType<typeof bind>
export function requireKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key))
    throw new TypeError('Canonical journal row key required')
}
export function validateRow(
  binding: Binding,
  key: string,
  raw: unknown,
): string {
  requireKey(key)
  if (
    typeof raw !== 'string' ||
    raw.length > negotiationJournalLimits.rawBytes ||
    utf8ToBytes(raw).length > negotiationJournalLimits.rawBytes
  )
    throw new TypeError('Bounded serialized journal row required')
  const row = inspectNegotiationJournalRecord(raw)
  if (
    row.rowKey !== key ||
    row.owner.accountIncarnation !== binding.accountIncarnation ||
    bytesToHex(row.owner.localPublicKey) !== binding.localPublicKey
  )
    throw new TypeError('Negotiation storage owner/key affinity mismatch')
  return raw
}
/** Bound an untrusted inventory while scanning, before retaining or inspecting all rows. */
export function appendRecord(
  entries: Array<[unknown, unknown]>,
  key: unknown,
  value: unknown,
): number {
  if (key !== BINDING_KEY) requireKey(key)
  if (
    typeof value !== 'string' ||
    value.length > negotiationJournalLimits.rawBytes
  )
    throw new Error('Invalid serialized storage record')
  const bytes = utf8ToBytes(value).length
  if (bytes > negotiationJournalLimits.rawBytes)
    throw new Error('Invalid serialized storage record')
  entries.push([key, value])
  if (
    entries.filter(([rowKey]) => rowKey !== BINDING_KEY).length >
    negotiationStorageLimits.rows
  )
    throw new Error('Existing negotiation storage exceeds capacity')
  return key === BINDING_KEY ? 0 : bytes
}
export function validateRecords(
  binding: Binding,
  entries: readonly (readonly [unknown, unknown])[],
): Map<string, string> {
  const rows = new Map<string, string>()
  let metadata = false,
    bytes = 0
  for (const [key, value] of entries) {
    if (key === BINDING_KEY) {
      if (metadata || value !== binding.metadata)
        throw new Error('Invalid negotiation storage binding metadata')
      metadata = true
    } else {
      requireKey(key)
      if (typeof value !== 'string' || rows.has(key))
        throw new Error('Invalid negotiation storage record')
      bytes += utf8ToBytes(value).length
      rows.set(key, value)
      if (
        rows.size > negotiationStorageLimits.rows ||
        bytes > negotiationStorageLimits.rawBytes
      )
        throw new Error('Existing negotiation storage exceeds capacity')
    }
  }
  if (!metadata)
    throw new Error(
      'Incomplete negotiation namespace: missing binding metadata',
    )
  for (const [key, value] of rows) validateRow(binding, key, value)
  return rows
}
export function checkCapacity(
  rows: ReadonlyMap<string, string>,
  key: string,
  next: string,
): void {
  const count = rows.size + (rows.has(key) ? 0 : 1)
  const bytes =
    Array.from(rows, ([rowKey, raw]) =>
      rowKey === key ? 0 : utf8ToBytes(raw).length,
    ).reduce((a, b) => a + b, 0) + utf8ToBytes(next).length
  if (
    count > negotiationStorageLimits.rows ||
    bytes > negotiationStorageLimits.rawBytes
  )
    throw new NegotiationJournalError(
      'capacity',
      'Negotiation account storage capacity reached; no eviction',
    )
}
/** Serializes a sole handle. Platform transactions/Level ownership provide cross-handle CAS. */
export class StoreQueue {
  private tail: Promise<void> = Promise.resolve()
  private failure: unknown
  private failed = false
  private revoked = false
  private closing?: Promise<void>
  get isClosing(): boolean {
    return this.revoked
  }
  poison(error: unknown): void {
    if (!this.failed) {
      this.failed = true
      this.failure = error
    }
  }
  assertAvailable(): void {
    if (this.revoked) throw new Error('Negotiation storage is closed')
    if (this.failed) throw this.failure
  }
  run<T>(work: () => Promise<T>): Promise<T> {
    try {
      this.assertAvailable()
    } catch (error) {
      return Promise.reject(error)
    }
    const result = this.tail.then(async () => {
      if (this.failed) throw this.failure
      try {
        const value = await work()
        if (this.failed) throw this.failure
        return value
      } catch (error) {
        if (
          !(
            error instanceof NegotiationJournalError &&
            error.code === 'capacity'
          )
        )
          this.poison(error)
        throw error
      }
    })
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  close(release: () => Promise<void>, revoke?: () => void): Promise<void> {
    if (!this.revoked) {
      this.revoked = true
      revoke?.()
    }
    return (this.closing ??= this.tail.then(release))
  }
}
