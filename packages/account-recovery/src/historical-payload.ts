import { sha256 } from '@noble/hashes/sha256.js'
import { BIP39_DERIVATION } from '@frank/domain-roots'
import {
  codex32SymbolsToBytes,
  decodeCodex32,
  type Codex32Result,
  type Codex32Share,
} from '@frank/codex32'

export const HISTORICAL_SHARE_PREFIX = 'frank-bip39-v1:'
// This protocol context is ASCII, so its UTF-8 bytes need no host text encoder.
const CONTEXT = Uint8Array.from(
  `frank/bip39-backup/v1\0${BIP39_DERIVATION}\0`,
  character => character.charCodeAt(0),
)

/** Integrity binds the entire original seed to its historical derivation, never a root conversion. */
export function historicalValidation(seed: Uint8Array): Uint8Array {
  return sha256.create().update(CONTEXT).update(seed).digest()
}

/** One paper share contains both standard Codex32 components, with a single shared header. */
export function decodeHistoricalShare(
  text: string,
): Codex32Result<Codex32Share> {
  if (text.length !== HISTORICAL_SHARE_PREFIX.length + 127 + 1 + 74)
    return { ok: false, error: { code: 'unsupported-length' } }
  const parts = text.split(':')
  if (parts.length !== 3 || `${parts[0]}:` !== HISTORICAL_SHARE_PREFIX)
    return { ok: false, error: { code: 'bad-format' } }
  const seed = decodeCodex32(parts[1]!)
  if (!seed.ok) return seed
  const check = decodeCodex32(parts[2]!)
  try {
    if (!check.ok) return check
    const a = seed.value,
      b = check.value
    if (
      a.payload.length !== 103 ||
      b.payload.length !== 52 ||
      a.identifier !== b.identifier ||
      a.threshold !== b.threshold ||
      a.index !== b.index
    )
      return { ok: false, error: { code: 'inconsistent-share' } }
    const payload = new Uint8Array(155)
    payload.set(a.payload)
    payload.set(b.payload, 103)
    return {
      ok: true,
      value: {
        threshold: a.threshold,
        identifier: a.identifier,
        index: a.index,
        payload,
        seed: null,
      },
    }
  } finally {
    seed.value.payload.fill(0)
    seed.value.seed?.fill(0)
    if (check.ok) {
      check.value.payload.fill(0)
      check.value.seed?.fill(0)
    }
  }
}

/** Shared search interpolates both independent polynomials together, then validates separately. */
export function validateHistoricalSymbols(
  symbols: Uint8Array,
): Uint8Array | null {
  if (symbols.length !== 155) return null
  const seed = codex32SymbolsToBytes(symbols.subarray(0, 103))
  const check = codex32SymbolsToBytes(symbols.subarray(103))
  let validation: Uint8Array | undefined
  try {
    if (
      !seed.ok ||
      !check.ok ||
      seed.value.length !== 64 ||
      check.value.length !== 32
    )
      return null
    validation = historicalValidation(seed.value)
    let difference = 0
    for (let i = 0; i < 32; i++) difference |= validation[i]! ^ check.value[i]!
    return difference === 0 ? new Uint8Array(seed.value) : null
  } finally {
    if (seed.ok) seed.value.fill(0)
    if (check.ok) check.value.fill(0)
    validation?.fill(0)
  }
}
