// Copyright (c) 2018 Matias Alejo Garcia
// Copyright (c) 2017 Emilio Almansi
// Copyright (c) 2017 Pieter Wuille
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

// Bit regrouping for cashaddr and bech32. Derived from Pieter Wuille's
// convertbits: the accumulator is masked to from+to-1 bits, and strict mode
// rejects leftover non-zero padding. The arithmetic is bigint so a wide
// regroup does not wrap at 32 bits.

import type { EncodingResult } from './encoding-error.js'

export function convertBits(
  data: readonly number[],
  fromBits: number,
  toBits: number,
  strict = false,
): EncodingResult<number[]> {
  if (!Array.isArray(data)) {
    return {
      ok: false,
      error: { code: 'convert-bits-width', fromBits, toBits },
    }
  }
  if (
    !Number.isSafeInteger(fromBits) ||
    !Number.isSafeInteger(toBits) ||
    fromBits < 1 ||
    fromBits > 31 ||
    toBits < 1 ||
    toBits > 31
  ) {
    return {
      ok: false,
      error: { code: 'convert-bits-width', fromBits, toBits },
    }
  }
  const from = BigInt(fromBits)
  const to = BigInt(toBits)
  const maxAcc = (1n << (from + to - 1n)) - 1n
  const mask = (1n << to) - 1n
  let accumulator = 0n
  let bits = 0
  const result: number[] = []
  for (const value of data) {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      BigInt(value) >> from !== 0n
    ) {
      return {
        ok: false,
        error: { code: 'convert-bits-range', value, fromBits },
      }
    }
    accumulator = ((accumulator << from) | BigInt(value)) & maxAcc
    bits += fromBits
    while (bits >= toBits) {
      bits -= toBits
      result.push(Number((accumulator >> BigInt(bits)) & mask))
    }
  }
  if (!strict) {
    if (bits > 0) {
      result.push(Number((accumulator << BigInt(toBits - bits)) & mask))
    }
  } else if (
    bits >= fromBits ||
    ((accumulator << BigInt(toBits - bits)) & mask) !== 0n
  ) {
    return { ok: false, error: { code: 'convert-bits-padding' } }
  }
  return { ok: true, value: result }
}
