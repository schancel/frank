// https://github.com/bitcoincashjs/cashaddr
// Copyright (c) 2018 Matias Alejo Garcia
// Copyright (c) 2017 Emilio Almansi
// Distributed under the MIT software license, see the accompanying
// file LICENSE or http://www.opensource.org/licenses/mit-license.php.
//
// This is the cashaddr and bech32 5-bit alphabet, not RFC 4648.

import type { EncodingResult } from './encoding-error.js'

export const CASHADDR_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

const INDEX = new Map<string, number>()
for (let value = 0; value < CASHADDR_CHARSET.length; value += 1) {
  INDEX.set(CASHADDR_CHARSET.charAt(value), value)
}

export function encodeBase32(
  values: readonly number[],
): EncodingResult<string> {
  if (!Array.isArray(values)) {
    return { ok: false, error: { code: 'base32-invalid-type' } }
  }
  let out = ''
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 31) {
      return { ok: false, error: { code: 'base32-invalid-value', value } }
    }
    out += CASHADDR_CHARSET.charAt(value)
  }
  return { ok: true, value: out }
}

export function decodeBase32(text: string): EncodingResult<number[]> {
  if (typeof text !== 'string') {
    return { ok: false, error: { code: 'base32-invalid-type' } }
  }
  const data: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index)
    const value = INDEX.get(char)
    if (value === undefined) {
      return {
        ok: false,
        error: { code: 'base32-invalid-char', index, char },
      }
    }
    data.push(value)
  }
  return { ok: true, value: data }
}
