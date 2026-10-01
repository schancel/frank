// CashAddr polymod. Bitcoin Cash Node src/cashaddr.cpp PolyMod, which is the
// same generator Bitcoin ABC src/cashaddr.cpp uses. Eight 5-bit checksum
// characters, residue 0 after the implicit xor-1 inside the polymod.
// Prefix characters are the low 5 bits, then a zero. No default prefix.

import { decodeBase32, encodeBase32 } from './base32.js'
import { convertBits } from './convert-bits.js'
import type { EncodingResult } from './encoding-error.js'

export interface CashaddrMixedCase {
  readonly code: 'mixed-case'
}

export interface CashaddrChecksum {
  readonly code: 'bad-checksum'
}

export interface CashaddrPrefix {
  readonly code: 'wrong-prefix'
  readonly prefix: string
}

export interface CashaddrChainRequired {
  readonly code: 'chain-required'
}

export type CashaddrError =
  | CashaddrMixedCase
  | CashaddrChecksum
  | CashaddrPrefix
  | CashaddrChainRequired
  | Extract<EncodingResult<never>, { ok: false }>['error']

export type CashaddrResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CashaddrError }

export interface CashaddrDecoded {
  readonly prefix: string
  readonly payload: Uint8Array
}

function polymod(values: readonly number[]): bigint {
  const generator = [
    0x98f2bc8e61n,
    0x79b76d99e2n,
    0xf33e5fb3c4n,
    0xae2eabe2a8n,
    0x1e4f43e470n,
  ] as const
  let checksum = 1n
  for (const value of values) {
    const top = checksum >> 35n
    checksum = ((checksum & 0x07ffffffffn) << 5n) ^ BigInt(value)
    for (let index = 0; index < generator.length; index += 1) {
      if (((top >> BigInt(index)) & 1n) === 1n) {
        checksum ^= generator[index] ?? 0n
      }
    }
  }
  return checksum ^ 1n
}

function expandPrefix(prefix: string): number[] {
  const expanded: number[] = []
  for (let index = 0; index < prefix.length; index += 1) {
    expanded.push(prefix.charCodeAt(index) & 31)
  }
  expanded.push(0)
  return expanded
}

function checksumWords(mod: bigint): number[] {
  const words: number[] = []
  for (let index = 0; index < 8; index += 1) {
    const shift = 5 * (7 - index)
    words.push(Number((mod >> BigInt(shift)) & 31n))
  }
  return words
}

function prefixChars(prefix: string): CashaddrResult<string> {
  const lower = prefix.toLowerCase()
  if (lower.length < 1 || lower.includes(':')) {
    return { ok: false, error: { code: 'wrong-prefix', prefix } }
  }
  for (let index = 0; index < lower.length; index += 1) {
    const code = lower.charCodeAt(index)
    const digit = code >= 48 && code <= 57
    const letter = code >= 97 && code <= 122
    if (!letter || digit) {
      return { ok: false, error: { code: 'wrong-prefix', prefix: lower } }
    }
  }
  return { ok: true, value: lower }
}

export function encodeCashaddr(
  prefix: string,
  payload: Uint8Array,
): CashaddrResult<string> {
  const human = prefixChars(prefix)
  if (!human.ok) return human
  const converted = convertBits(Array.from(payload), 8, 5)
  if (!converted.ok) return converted
  const residue = polymod([
    ...expandPrefix(human.value),
    ...converted.value,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ])
  const encoded = encodeBase32([...converted.value, ...checksumWords(residue)])
  if (!encoded.ok) return encoded
  return { ok: true, value: `${human.value}:${encoded.value}` }
}

function singleCase(text: string): CashaddrResult<string> {
  const lower = text.toLowerCase()
  const upper = text.toUpperCase()
  if (text !== lower && text !== upper) {
    return { ok: false, error: { code: 'mixed-case' } }
  }
  return { ok: true, value: lower }
}

export function decodeCashaddr(
  text: string,
  defaultPrefix?: string,
): CashaddrResult<CashaddrDecoded> {
  if (typeof text !== 'string') {
    return { ok: false, error: { code: 'base32-invalid-type' } }
  }
  const cased = singleCase(text)
  if (!cased.ok) return cased
  const lower = cased.value
  const colon = lower.indexOf(':')
  if (colon !== lower.lastIndexOf(':')) {
    return { ok: false, error: { code: 'wrong-prefix', prefix: lower } }
  }
  let prefix: string
  let dataText: string
  if (colon === -1) {
    if (defaultPrefix === undefined) {
      return { ok: false, error: { code: 'chain-required' } }
    }
    const human = prefixChars(defaultPrefix)
    if (!human.ok) return human
    prefix = human.value
    dataText = lower
  } else {
    const human = prefixChars(lower.slice(0, colon))
    if (!human.ok) return human
    prefix = human.value
    dataText = lower.slice(colon + 1)
  }
  if (dataText.length < 8) {
    return { ok: false, error: { code: 'bad-checksum' } }
  }
  const decoded = decodeBase32(dataText)
  if (!decoded.ok) return decoded
  const residue = polymod([...expandPrefix(prefix), ...decoded.value])
  if (residue !== 0n) return { ok: false, error: { code: 'bad-checksum' } }
  const payloadBits = decoded.value.slice(0, -8)
  const payload = convertBits(payloadBits, 5, 8, true)
  if (!payload.ok) return payload
  return {
    ok: true,
    value: { prefix, payload: Uint8Array.from(payload.value) },
  }
}
