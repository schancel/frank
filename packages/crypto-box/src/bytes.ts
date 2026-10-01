// Plain Uint8Array helpers. No Node built-ins and no Buffer.

export function isPlainBytes(value: unknown): value is Uint8Array {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { constructor?: unknown }).constructor === Uint8Array
  )
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return diff === 0
}

/** ASCII only. Labels are fixed strings, not attacker input. */
export function ascii(value: string): Uint8Array {
  const out = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code > 0x7f) throw new Error('ascii')
    out[index] = code
  }
  return out
}

export function i2osp(value: number, length: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('i2osp')
  const out = new Uint8Array(length)
  let rest = value
  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = rest & 0xff
    rest = Math.floor(rest / 256)
  }
  if (rest !== 0) throw new Error('i2osp')
  return out
}

export function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) * 256 + (bytes[offset + 1] ?? 0)
}

export function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 0x1000000 +
    (bytes[offset + 1] ?? 0) * 0x10000 +
    (bytes[offset + 2] ?? 0) * 256 +
    (bytes[offset + 3] ?? 0)
  )
}
