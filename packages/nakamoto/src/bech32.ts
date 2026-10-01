// Bech32 and Bech32m checksums. BIP173 and BIP350 (Pieter Wuille).
// The 6-character checksum is 30 bits. Bech32 expects residue 1.
// Bech32m expects residue 0x2bc830a3. Encoders emit lowercase only.

import { decodeBase32, encodeBase32 } from './base32.js'
import type { EncodingResult } from './encoding-error.js'

export type Bech32Spec = 'bech32' | 'bech32m'

export interface Bech32MixedCase {
  readonly code: 'mixed-case'
}

export interface Bech32SeparatorMissing {
  readonly code: 'separator-missing'
}

export interface Bech32EmptyHrp {
  readonly code: 'empty-hrp'
}

export interface Bech32TooLong {
  readonly code: 'address-too-long'
  readonly actual: number
}

export interface Bech32Checksum {
  readonly code: 'bad-checksum'
}

export interface Bech32HrpChar {
  readonly code: 'hrp-char'
  readonly index: number
}

export type Bech32Error =
  | Bech32MixedCase
  | Bech32SeparatorMissing
  | Bech32EmptyHrp
  | Bech32TooLong
  | Bech32Checksum
  | Bech32HrpChar
  | Extract<EncodingResult<never>, { ok: false }>['error']

export type Bech32Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Bech32Error }

export interface Bech32Decoded {
  readonly hrp: string
  readonly data: readonly number[]
  readonly spec: Bech32Spec
}

const BECH32_CONST = 1n
const BECH32M_CONST = 0x2bc830a3n
const GENERATOR = [
  0x3b6a57b2n,
  0x26508e6dn,
  0x1ea119fan,
  0x3d4233ddn,
  0x2a1462b3n,
] as const
const MAX_LENGTH = 90
const CHECKSUM_LENGTH = 6

function polymod(values: readonly number[]): bigint {
  let chk = 1n
  for (const value of values) {
    const top = chk >> 25n
    chk = ((chk & 0x1ffffffn) << 5n) ^ BigInt(value)
    for (let index = 0; index < GENERATOR.length; index += 1) {
      if (((top >> BigInt(index)) & 1n) === 1n) {
        chk ^= GENERATOR[index] ?? 0n
      }
    }
  }
  return chk
}

function expandHrp(hrp: string): number[] {
  const high: number[] = []
  const low: number[] = []
  for (let index = 0; index < hrp.length; index += 1) {
    const code = hrp.charCodeAt(index)
    high.push(code >> 5)
    low.push(code & 31)
  }
  return [...high, 0, ...low]
}

function checksumWords(mod: bigint): number[] {
  const words: number[] = []
  for (let index = 0; index < CHECKSUM_LENGTH; index += 1) {
    const shift = 5 * (CHECKSUM_LENGTH - 1 - index)
    words.push(Number((mod >> BigInt(shift)) & 31n))
  }
  return words
}

function hrpChars(hrp: string): Bech32Result<string> {
  if (hrp.length < 1) return { ok: false, error: { code: 'empty-hrp' } }
  const lower = hrp.toLowerCase()
  for (let index = 0; index < lower.length; index += 1) {
    const code = lower.charCodeAt(index)
    if (code < 33 || code > 126) {
      return { ok: false, error: { code: 'hrp-char', index } }
    }
  }
  return { ok: true, value: lower }
}

export function encodeBech32(
  hrp: string,
  data: readonly number[],
  spec: Bech32Spec,
): Bech32Result<string> {
  const human = hrpChars(hrp)
  if (!human.ok) return human
  const constant = spec === 'bech32' ? BECH32_CONST : BECH32M_CONST
  const residue = polymod([
    ...expandHrp(human.value),
    ...data,
    0,
    0,
    0,
    0,
    0,
    0,
  ])
  const words = checksumWords(residue ^ constant)
  const encoded = encodeBase32([...data, ...words])
  if (!encoded.ok) return encoded
  const text = `${human.value}1${encoded.value}`
  if (text.length > MAX_LENGTH) {
    return {
      ok: false,
      error: { code: 'address-too-long', actual: text.length },
    }
  }
  return { ok: true, value: text }
}

function singleCase(text: string): Bech32Result<string> {
  const lower = text.toLowerCase()
  const upper = text.toUpperCase()
  if (text !== lower && text !== upper) {
    return { ok: false, error: { code: 'mixed-case' } }
  }
  return { ok: true, value: lower }
}

export function decodeBech32(text: string): Bech32Result<Bech32Decoded> {
  if (typeof text !== 'string') {
    return { ok: false, error: { code: 'base32-invalid-type' } }
  }
  if (text.length > MAX_LENGTH) {
    return {
      ok: false,
      error: { code: 'address-too-long', actual: text.length },
    }
  }
  const cased = singleCase(text)
  if (!cased.ok) return cased
  const lower = cased.value
  const split = lower.lastIndexOf('1')
  if (split === -1) return { ok: false, error: { code: 'separator-missing' } }
  const hrp = lower.slice(0, split)
  const dataText = lower.slice(split + 1)
  const human = hrpChars(hrp)
  if (!human.ok) return human
  if (dataText.length < CHECKSUM_LENGTH) {
    return { ok: false, error: { code: 'bad-checksum' } }
  }
  const decoded = decodeBase32(dataText)
  if (!decoded.ok) return decoded
  const residue = polymod([...expandHrp(human.value), ...decoded.value])
  let spec: Bech32Spec
  if (residue === BECH32_CONST) spec = 'bech32'
  else if (residue === BECH32M_CONST) spec = 'bech32m'
  else return { ok: false, error: { code: 'bad-checksum' } }
  return {
    ok: true,
    value: {
      hrp: human.value,
      data: decoded.value.slice(0, -CHECKSUM_LENGTH),
      spec,
    },
  }
}
