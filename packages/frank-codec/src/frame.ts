// FRNK frame (README section 1): magic, version, length, exact envelope bytes.
import { Encodable, encodeCanonical } from './cbor'
import {
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  FRAME_VERSION,
  MAX_BODY_BYTES,
  U32_MAX,
} from './constants'

/** Wraps already-encoded envelope bytes in the nine-byte FRNK header. */
export function wrapFrame(
  body: Uint8Array,
  version = FRAME_VERSION,
): Uint8Array {
  if (body.length > MAX_BODY_BYTES)
    throw new RangeError('envelope body exceeds MAX_BODY_BYTES')
  if (!Number.isInteger(version) || version < 0 || version > 0xff) {
    throw new RangeError('frame version is not a byte')
  }
  const out = new Uint8Array(FRAME_HEADER_BYTES + body.length)
  out.set(FRAME_MAGIC, 0)
  out[4] = version
  out[5] = (body.length >>> 24) & 0xff
  out[6] = (body.length >>> 16) & 0xff
  out[7] = (body.length >>> 8) & 0xff
  out[8] = body.length & 0xff
  out.set(body, FRAME_HEADER_BYTES)
  return out
}

export interface EnvelopeFields {
  typeId: number
  schemaVersion: number
  minReaderVersion: number
}

function checkU32(name: string, v: number, min: number): void {
  if (!Number.isInteger(v) || v < min || v > U32_MAX) {
    throw new RangeError(`${name} must be an integer in ${min}..${U32_MAX}`)
  }
}

/**
 * Encodes a version-1 frame. `payload` is either a value (encoded canonically here) or, as
 * `{ bytes }`, an already-encoded payload data item (used to retain exact bytes).
 */
export function encodeFrame(
  env: EnvelopeFields,
  payload: Encodable | { readonly bytes: Uint8Array },
): Uint8Array {
  checkU32('type_id', env.typeId, 0)
  checkU32('schema_version', env.schemaVersion, 1)
  checkU32('min_reader_version', env.minReaderVersion, 1)
  if (env.minReaderVersion > env.schemaVersion) {
    throw new RangeError(
      'min_reader_version must not exceed schema_version (E2)',
    )
  }
  const payloadBytes =
    payload !== null &&
    typeof payload === 'object' &&
    !(payload instanceof Uint8Array) &&
    !(payload instanceof Map) &&
    !Array.isArray(payload) &&
    'bytes' in payload
      ? (payload as { bytes: Uint8Array }).bytes
      : encodeCanonical(payload as Encodable)
  const body = encodeCanonical(
    new Map<number, Encodable>([
      [0, env.typeId],
      [1, env.schemaVersion],
      [2, env.minReaderVersion],
      [3, payloadBytes],
    ]),
  )
  return wrapFrame(body)
}
