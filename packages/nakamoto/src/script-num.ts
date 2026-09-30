// Bitcoin script numbers are little-endian. The high bit of the last byte is
// the sign. Minimal encoding matches Bitcoin Core IsMinimallyEncoded: a
// trailing sign-extension byte is kept only when the previous byte's high bit
// is set. Negative zero (0x80) is not minimal. The default limit is
// CScriptNum's 4 bytes. requireMinimal defaults on, because script
// verification rejects a non-minimal number.

export interface ScriptNumOverflow {
  readonly code: 'script-num-overflow'
  readonly maxBytes: number
  readonly length: number
}

export interface ScriptNumNonMinimal {
  readonly code: 'script-num-non-minimal'
}

export type ScriptNumError = ScriptNumOverflow | ScriptNumNonMinimal

export type ScriptNumResult =
  | { readonly ok: true; readonly value: bigint }
  | { readonly ok: false; readonly error: ScriptNumError }

export interface ScriptNumDecodeOptions {
  readonly maxBytes?: number
  readonly requireMinimal?: boolean
}

export function isScriptNumError(value: unknown): value is ScriptNumError {
  if (typeof value !== 'object' || value === null) return false
  const code = (value as { code?: unknown }).code
  return code === 'script-num-overflow' || code === 'script-num-non-minimal'
}

export function encodeScriptNum(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array(0)
  const negative = value < 0n
  let magnitude = negative ? -value : value
  const bytes: number[] = []
  while (magnitude > 0n) {
    bytes.push(Number(magnitude & 0xffn))
    magnitude >>= 8n
  }
  const last = bytes[bytes.length - 1] ?? 0
  if ((last & 0x80) !== 0) {
    bytes.push(negative ? 0x80 : 0x00)
  } else if (negative) {
    bytes[bytes.length - 1] = last | 0x80
  }
  return Uint8Array.from(bytes)
}

export function isMinimalScriptNum(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true
  const last = bytes[bytes.length - 1] ?? 0
  if ((last & 0x7f) !== 0) return true
  if (bytes.length <= 1) return false
  const previous = bytes[bytes.length - 2] ?? 0
  return (previous & 0x80) !== 0
}

export function decodeScriptNum(
  bytes: Uint8Array,
  options?: ScriptNumDecodeOptions,
): ScriptNumResult {
  const maxBytes = options?.maxBytes ?? 4
  const requireMinimal = options?.requireMinimal ?? true
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    bytes.length > maxBytes
  ) {
    return {
      ok: false,
      error: {
        code: 'script-num-overflow',
        maxBytes,
        length: bytes.length,
      },
    }
  }
  if (requireMinimal && !isMinimalScriptNum(bytes)) {
    return { ok: false, error: { code: 'script-num-non-minimal' } }
  }
  return { ok: true, value: decodeValue(bytes) }
}

function decodeValue(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n
  const lastIndex = bytes.length - 1
  const last = bytes[lastIndex] ?? 0
  const negative = (last & 0x80) !== 0
  let value = 0n
  for (let index = 0; index < lastIndex; index += 1) {
    value |= BigInt(bytes[index] ?? 0) << BigInt(8 * index)
  }
  value |= BigInt(last & 0x7f) << BigInt(8 * lastIndex)
  return negative ? -value : value
}
