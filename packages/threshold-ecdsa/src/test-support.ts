/**
 * Test-only helpers. Not exported from the package and excluded from the
 * production typecheck.
 */
import { sha256 } from '@noble/hashes/sha256.js'

import { deterministicStream, type RandomBytes } from './rng.js'

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function fromHex(text: string): Uint8Array {
  if (text.length % 2 !== 0) throw new Error('odd hex length')
  return Uint8Array.from({ length: text.length / 2 }, (_, index) =>
    Number.parseInt(text.slice(index * 2, index * 2 + 2), 16),
  )
}

export function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, character => character.charCodeAt(0))
}

/** A reproducible stand-in for a CSPRNG, keyed by a label. */
export function seededRandom(label: string): RandomBytes {
  return deterministicStream('test-vector-rng', sha256(ascii(label)))
}

/**
 * Copies a session state so a test can feed several different messages to
 * the same point of a protocol. Byte arrays are duplicated (an abort wipes
 * them); everything else, including the key share handle, is shared.
 */
export function cloneState<T>(state: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
    out[key] = value instanceof Uint8Array ? value.slice() : value
  }
  return out as T
}

export function flip(bytes: Uint8Array, index: number): Uint8Array {
  const out = bytes.slice()
  out[index] = (out[index] ?? 0) ^ 0x01
  return out
}

export function replace(
  bytes: Uint8Array,
  offset: number,
  patch: Uint8Array,
): Uint8Array {
  const out = bytes.slice()
  out.set(patch, offset)
  return out
}
