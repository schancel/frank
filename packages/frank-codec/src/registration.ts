// Pure-value mapping of README section 11 (M2, M3, M6): lossless milliseconds, TTL expiry,
// and the Keccak-256 canonical address. Nothing here touches a frame; the claimed-address
// comparison is a consumer check that stays out of the codec (M6).
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3'

import type {
  AccountRef,
  AccountType,
  BotRole,
  ProfileEntry,
  RelayBinding,
  Timestamp,
} from './types'
import { cborMap, type Encodable } from './cbor'
import { encodeFrame } from './frame'
import {
  ACCOUNT_REF,
  DIRECTORY_STATEMENT,
  KEY_TYPE,
  PROFILE_ENTRY,
  PROFILE_HEADER,
  RELAY_BINDING,
  TIMESTAMP,
  TYPE_DIRECTORY_STATEMENT,
} from './constants'

const MS = 1000n
const NANOS_PER_MS = 1_000_000n
const I64_MIN = -9_223_372_036_854_775_808n
const I64_MAX = 9_223_372_036_854_775_807n

/**
 * Splits a total millisecond value into a `timestamp` (M2): `seconds = ms div 1000` rounds
 * toward negative infinity and `nanoseconds` is the non-negative remainder of that division,
 * always a multiple of 1,000,000. Accepts any i64-width total; negative totals are encodable
 * timestamps (M3).
 */
export function splitTimestampMs(totalMs: bigint): Timestamp {
  if (totalMs < I64_MIN * MS || totalMs > I64_MAX * MS + 999n) {
    throw new RangeError('total milliseconds outside the timestamp range')
  }
  const remainder = ((totalMs % MS) + MS) % MS
  const nanoseconds = remainder * NANOS_PER_MS
  const seconds = (totalMs - remainder) / MS
  return { seconds, nanoseconds: Number(nanoseconds) }
}

/** Inverse of {@link splitTimestampMs}: `ms = seconds * 1000 + nanoseconds div 1000000`. */
export function joinMs(seconds: bigint, nanoseconds: number | bigint): bigint {
  if (seconds < I64_MIN || seconds > I64_MAX) {
    throw new RangeError('seconds outside the timestamp i64 range')
  }
  const nanos = BigInt(nanoseconds)
  if (nanos < 0n || nanos > 999_999_999n || nanos % NANOS_PER_MS !== 0n) {
    throw new RangeError(
      'nanoseconds is outside the timestamp range or not a millisecond multiple: no ms value produced it (M2)',
    )
  }
  return seconds * MS + nanos / NANOS_PER_MS
}

/**
 * The registration mapping of M2: `ms` becomes the revision (its exact value, unsigned) and
 * the timestamp. A negative `ms` has no unsigned revision, so the record is unencodable and
 * this fails closed.
 */
export function splitMs(ms: bigint): {
  revision: bigint
  seconds: bigint
  nanoseconds: number
} {
  if (ms < 0n || ms > I64_MAX) {
    throw new RangeError(
      'a negative millisecond value has no unsigned revision: unencodable (M2)',
    )
  }
  const timestamp = splitTimestampMs(ms)
  return {
    revision: ms,
    seconds: timestamp.seconds,
    nanoseconds: timestamp.nanoseconds,
  }
}

/** M3: field 6 is `split_ms(ms + ttl)` in width that cannot overflow (`bigint`). */
export function expiryTimestamp(ms: bigint, ttlMs: bigint): Timestamp {
  return splitTimestampMs(ms + ttlMs)
}

/** The 65-byte uncompressed SEC1 encoding `04 || X || Y` of a 33-byte compressed key. */
export function uncompressedPubkey(compressed: Uint8Array): Uint8Array {
  if (
    compressed.length !== 33 ||
    (compressed[0] !== 0x02 && compressed[0] !== 0x03)
  ) {
    throw new RangeError('expected a 33-byte compressed SEC1 public key')
  }
  try {
    const point = secp256k1.ProjectivePoint.fromHex(compressed)
    return new Uint8Array(point.toRawBytes(false))
  } catch {
    throw new RangeError('not a valid secp256k1 point')
  }
}

/** The 64-byte `X || Y` Keccak input of M6. */
export function uncompressedPubkeyXy(compressed: Uint8Array): Uint8Array {
  return uncompressedPubkey(compressed).subarray(1)
}

/** M6: the canonical address is the low 20 bytes of Keccak256 of the 64-byte `X || Y`. */
export function addressFromUncompressedPubkey(
  uncompressed: Uint8Array,
): Uint8Array {
  const xy =
    uncompressed.length === 65 && uncompressed[0] === 0x04
      ? uncompressed.subarray(1)
      : uncompressed
  if (xy.length !== 64) {
    throw new RangeError('expected the 64-byte uncompressed X || Y public key')
  }
  const digest = keccak_256(xy)
  return digest.slice(digest.length - 20)
}

/** M6 applied to a compressed key: derive the canonical 20-byte address directly. */
export function addressFromCompressedPubkey(
  compressed: Uint8Array,
): Uint8Array {
  return addressFromUncompressedPubkey(uncompressedPubkeyXy(compressed))
}

/** Canonical username regex: lowercase ASCII alphanumeric with hyphen or underscore, starting with alphanumeric. */
export const CANONICAL_USERNAME_REGEX = /^[a-z0-9][a-z0-9_-]{2,31}$/

/**
 * Validates whether a handle conforms to the canonical username specification (ticket #972):
 * - Length between 3 and 32 characters
 * - Lowercase ASCII alphanumeric, hyphen, or underscore
 * - Starts with an alphanumeric character
 */
export function isValidCanonicalUsername(handle: unknown): handle is string {
  return (
    typeof handle === 'string' &&
    handle.length >= 3 &&
    handle.length <= 32 &&
    CANONICAL_USERNAME_REGEX.test(handle)
  )
}

export interface DirectoryStatementBuilderParams {
  network: string
  subject: AccountRef | Uint8Array
  revision: bigint | number
  timestamp: Timestamp
  relays: RelayBinding[]
  stampKey?: AccountRef | Uint8Array
  expiry?: Timestamp
  recoveryAuthorities?: AccountRef[]
  profileEntries?: ProfileEntry[]
  canonicalUsername?: string
  accountType?: AccountType
  botRole?: BotRole
  spendKeys?: AccountRef[]
}

/**
 * Encodes the Type 4 directory statement CBOR map entries, including optional field 14.
 */
export function buildDirectoryStatementMap(
  params: DirectoryStatementBuilderParams,
): Map<number | bigint, Encodable> {
  const encAccount = (acc: AccountRef | Uint8Array): Encodable => {
    if (acc instanceof Uint8Array) {
      return cborMap([
        [ACCOUNT_REF.keyType, KEY_TYPE.secp256k1],
        [ACCOUNT_REF.keyBytes, acc],
      ])
    }
    return cborMap([
      [ACCOUNT_REF.keyType, acc.keyType],
      [ACCOUNT_REF.keyBytes, acc.keyBytes],
    ])
  }

  const K = DIRECTORY_STATEMENT
  const time = (t: Timestamp): Encodable =>
    cborMap([
      [TIMESTAMP.seconds, t.seconds],
      [TIMESTAMP.nanoseconds, t.nanoseconds],
    ])
  const entries: Array<[number | bigint, Encodable]> = [
    [K.network, params.network],
    [K.subject, encAccount(params.subject)],
    [K.revision, BigInt(params.revision)],
    [K.timestamp, time(params.timestamp)],
    [
      K.relays,
      params.relays.map(r =>
        cborMap([
          [RELAY_BINDING.relayId, r.relayId],
          [RELAY_BINDING.endpoint, r.endpoint],
          [RELAY_BINDING.identity, encAccount(r.identity)],
          [RELAY_BINDING.expiry, time(r.expiry)],
        ]),
      ),
    ],
  ]

  if (params.expiry !== undefined) {
    entries.push([K.expiry, time(params.expiry)])
  }

  if (
    params.recoveryAuthorities !== undefined &&
    params.recoveryAuthorities.length > 0
  ) {
    entries.push([
      K.recoveryAuthorities,
      params.recoveryAuthorities.map(encAccount),
    ])
  }

  if (params.stampKey !== undefined) {
    entries.push([K.stampKey, encAccount(params.stampKey)])
  }

  if (params.profileEntries !== undefined && params.profileEntries.length > 0) {
    entries.push([
      K.profileEntries,
      params.profileEntries.map(e =>
        cborMap([
          [PROFILE_ENTRY.kind, e.kind],
          [
            PROFILE_ENTRY.headers,
            e.headers.map(h =>
              cborMap([
                [PROFILE_HEADER.name, h.name],
                [PROFILE_HEADER.value, h.value],
              ]),
            ),
          ],
          [PROFILE_ENTRY.body, e.body],
        ]),
      ),
    ])
  }

  if (params.canonicalUsername !== undefined) {
    entries.push([K.username, params.canonicalUsername])
  } else if (params.spendKeys !== undefined && params.spendKeys.length > 0) {
    entries.push([K.username, params.spendKeys.map(encAccount)])
  }

  if (params.accountType !== undefined) {
    entries.push([K.accountType, BigInt(params.accountType)])
  }

  if (params.botRole !== undefined) {
    entries.push([K.botRole, BigInt(params.botRole)])
  }

  return cborMap(entries)
}

/**
 * Encodes a complete Type 4 directory statement frame.
 */
export function encodeDirectoryStatement(
  params: DirectoryStatementBuilderParams,
  schemaVersion = 3,
  minReaderVersion = 2,
): Uint8Array {
  return encodeFrame(
    { typeId: TYPE_DIRECTORY_STATEMENT, schemaVersion, minReaderVersion },
    buildDirectoryStatementMap(params),
  )
}
