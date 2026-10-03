import { validateMasterPayload } from '@frank/codex32'
import {
  DERIVATION_REGISTRY_CODE,
  DERIVATION_REGISTRY_ID,
  RECOVERY_FORMAT_CODE,
  RECOVERY_FORMAT_ID,
} from '@frank/domain-roots'
import { decodeBech32, encodeBech32 } from '@frank/nakamoto/bech32'
import { convertBits } from '@frank/nakamoto/convert-bits'
import { sha256 } from '@noble/hashes/sha256.js'
import {
  AccountRecoveryError,
  type AccountRecoveryErrorCode,
} from './errors.js'

/** Public identity envelope. Structural validity does not establish its trust source. */
export interface PublicRecoveryDescriptor {
  readonly recoveryFormat: typeof RECOVERY_FORMAT_ID
  readonly recoveryFormatCode: typeof RECOVERY_FORMAT_CODE
  readonly registry: typeof DERIVATION_REGISTRY_ID
  readonly registryCode: typeof DERIVATION_REGISTRY_CODE
  /** Fresh owned copy on every read from a library-created descriptor. */
  readonly publicRecoveryFingerprint: Uint8Array
}

export interface RecoveryPublicMetadata {
  readonly descriptor: PublicRecoveryDescriptor
  /** Public, format/registry-independent commitment to the validated root. */
  readonly masterRetirementId: Uint8Array
  readonly recoveryIdentityCommitment: Uint8Array
}

const TYPED_ARRAY = Object.getPrototypeOf(Uint8Array.prototype)
const BYTE_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY, 'length')!.get!
const BYTE_TAG = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY,
  Symbol.toStringTag,
)!.get!
const BYTE_SET = Uint8Array.prototype.set

/** Snapshot fixed-size bytes without invoking caller getters, iterators or species. */
export function snapshotBytes(
  value: unknown,
  length: number,
  code: AccountRecoveryErrorCode,
): Uint8Array {
  try {
    if (
      Reflect.apply(BYTE_TAG, value, []) !== 'Uint8Array' ||
      Reflect.apply(BYTE_LENGTH, value, []) !== length
    )
      throw new Error()
    const copy = new Uint8Array(length)
    Reflect.apply(BYTE_SET, copy, [value])
    return copy
  } catch {
    throw new AccountRecoveryError(code)
  }
}

/** The returned object is frozen and never exposes its retained fingerprint buffer. */
function descriptorFor(fingerprint: Uint8Array): PublicRecoveryDescriptor {
  const retained = new Uint8Array(fingerprint)
  return Object.freeze({
    recoveryFormat: RECOVERY_FORMAT_ID,
    recoveryFormatCode: RECOVERY_FORMAT_CODE,
    registry: DERIVATION_REGISTRY_ID,
    registryCode: DERIVATION_REGISTRY_CODE,
    get publicRecoveryFingerprint() {
      return new Uint8Array(retained)
    },
  })
}

/** Internal boundary snapshot; each caller-controlled property is read once. */
export function snapshotPublicDescriptor(
  value: PublicRecoveryDescriptor,
): PublicRecoveryDescriptor {
  let format: unknown,
    formatCode: unknown,
    registry: unknown,
    registryCode: unknown
  let fingerprint: Uint8Array
  try {
    format = value.recoveryFormat
    formatCode = value.recoveryFormatCode
    registry = value.registry
    registryCode = value.registryCode
    fingerprint = snapshotBytes(
      value.publicRecoveryFingerprint,
      32,
      'invalid-descriptor',
    )
  } catch {
    throw new AccountRecoveryError('invalid-descriptor')
  }
  if (format !== RECOVERY_FORMAT_ID || formatCode !== RECOVERY_FORMAT_CODE) {
    throw new AccountRecoveryError('wrong-recovery-format')
  }
  if (
    registry !== DERIVATION_REGISTRY_ID ||
    registryCode !== DERIVATION_REGISTRY_CODE
  ) {
    throw new AccountRecoveryError('wrong-registry')
  }
  return descriptorFor(fingerprint)
}

export function encodeRecoveryDescriptor(
  value: PublicRecoveryDescriptor,
): string {
  const descriptor = snapshotPublicDescriptor(value)
  const payload = new Uint8Array(37)
  payload.set([1, 0, descriptor.recoveryFormatCode, 0, descriptor.registryCode])
  payload.set(descriptor.publicRecoveryFingerprint, 5)
  return encode('frankdesc', payload, 'invalid-descriptor')
}

export function decodeRecoveryDescriptor(
  value: string,
): PublicRecoveryDescriptor {
  const payload = decode(value, 'frankdesc', 76, 37, 'invalid-descriptor')
  if (payload[0] !== 1) throw new AccountRecoveryError('invalid-descriptor')
  if (payload[1] !== 0 || payload[2] !== RECOVERY_FORMAT_CODE) {
    throw new AccountRecoveryError('wrong-recovery-format')
  }
  if (payload[3] !== 0 || payload[4] !== DERIVATION_REGISTRY_CODE) {
    throw new AccountRecoveryError('wrong-registry')
  }
  return descriptorFor(payload.subarray(5))
}

export function encodeRecoveryFingerprint(value: Uint8Array): string {
  return encode(
    'frankrec',
    snapshotBytes(value, 32, 'invalid-fingerprint'),
    'invalid-fingerprint',
  )
}

export function decodeRecoveryFingerprint(value: string): Uint8Array {
  return decode(value, 'frankrec', 67, 32, 'invalid-fingerprint')
}

function encode(
  hrp: string,
  bytes: Uint8Array,
  code: AccountRecoveryErrorCode,
): string {
  const words = convertBits(Array.from(bytes), 8, 5)
  if (!words.ok) throw new AccountRecoveryError(code)
  const result = encodeBech32(hrp, words.value, 'bech32m')
  if (!result.ok) throw new AccountRecoveryError(code)
  return result.value
}

function decode(
  text: string,
  hrp: string,
  textLength: number,
  byteLength: number,
  code: AccountRecoveryErrorCode,
): Uint8Array {
  // Bound before normalization, conversion or any allocation based on input.
  if (
    typeof text !== 'string' ||
    text.length !== textLength ||
    !/^[\x21-\x7e]+$/.test(text)
  ) {
    throw new AccountRecoveryError(code)
  }
  const decoded = decodeBech32(text)
  if (
    !decoded.ok ||
    decoded.value.hrp !== hrp ||
    decoded.value.spec !== 'bech32m'
  ) {
    throw new AccountRecoveryError(code)
  }
  const bytes = convertBits(decoded.value.data, 5, 8, true)
  if (!bytes.ok || bytes.value.length !== byteLength)
    throw new AccountRecoveryError(code)
  return Uint8Array.from(bytes.value)
}

/** Compute public commitments only after validating a single owned snapshot of M. */
export function deriveRecoveryPublicMetadata(
  value: Uint8Array,
): RecoveryPublicMetadata {
  const master = snapshotBytes(value, 64, 'bad-format')
  let root: Uint8Array | undefined
  try {
    const validated = validateMasterPayload(master)
    if (!validated.ok) throw new AccountRecoveryError(validated.error.code)
    root = validated.value
    const fingerprint = hashParts([
      ascii('frank/recovery-fingerprint/v1'),
      Uint8Array.of(0),
      u16be(RECOVERY_FORMAT_ID.length),
      ascii(RECOVERY_FORMAT_ID),
      u16be(DERIVATION_REGISTRY_ID.length),
      ascii(DERIVATION_REGISTRY_ID),
      master,
    ])
    const retirement = hashParts([
      ascii('frank/root-retirement/v1'),
      Uint8Array.of(0),
      root,
    ])
    const identity = hashParts([
      ascii('frank/recovery-identity/v1'),
      Uint8Array.of(0),
      u16be(RECOVERY_FORMAT_CODE),
      u16be(DERIVATION_REGISTRY_CODE),
      fingerprint,
    ])
    return Object.freeze({
      descriptor: descriptorFor(fingerprint),
      get masterRetirementId() {
        return new Uint8Array(retirement)
      },
      get recoveryIdentityCommitment() {
        return new Uint8Array(identity)
      },
    })
  } finally {
    master.fill(0)
    root?.fill(0)
  }
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from(
    Array.from(value, character => character.charCodeAt(0)),
  )
}

function u16be(value: number): Uint8Array {
  return Uint8Array.of(value >>> 8, value & 0xff)
}

function hashParts(parts: readonly Uint8Array[]): Uint8Array {
  const preimage = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  )
  let offset = 0
  try {
    for (const part of parts) {
      preimage.set(part, offset)
      offset += part.length
    }
    return sha256(preimage)
  } finally {
    preimage.fill(0)
  }
}
