/** SEC1 points for the fixed secrets these tests use.
 * `02`/`03` || x is compressed. `04` || x || y is uncompressed.
 * Scalar 1 is the secp256k1 generator. */

export const SEC1_SECRET = '22'.repeat(32)
export const SEC1_N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
export const SEC1_ONE = `${'00'.repeat(31)}01`
export const SEC1_IDENTITY =
  '12b004fff7f4b69ef8650e767f18f11ede158148b425660723b9f9a66e61f747'

const COMPRESSED: Record<string, string> = {
  [SEC1_SECRET]:
    '02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27',
  [SEC1_N_MINUS_1]:
    '0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  [SEC1_ONE]:
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  [SEC1_IDENTITY]:
    '030b4c866585dd868a9d62348a9cd008d6a312937048fff31670e7e920cfc7a744',
  ['11'.repeat(32)]:
    '034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa',
  ['33'.repeat(32)]:
    '023c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1',
  [`${'00'.repeat(31)}6d`]:
    '0332d31c222f8f6f0ef86f7c98d3a3335ead5bcd32abdd94289fe4d3091aa824bf',
}

const UNCOMPRESSED: Record<string, string> = {
  [SEC1_SECRET]:
    '04466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f276728176c3c6431f8eeda4538dc37c865e2784f3a9e77d044f33e407797e1278a',
  [SEC1_N_MINUS_1]:
    '0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798b7c52588d95c3b9aa25b0403f1eef75702e84bb7597aabe663b82f6f04ef2777',
  [SEC1_ONE]:
    '0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8',
  [SEC1_IDENTITY]:
    '040b4c866585dd868a9d62348a9cd008d6a312937048fff31670e7e920cfc7a7447b5f0bba9e01e6fe4735c8383e6e7a3347a0fd72381b8f797a19f694054e5a69',
  ['11'.repeat(32)]:
    '044f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa385b6b1b8ead809ca67454d9683fcf2ba03456d6fe2c4abe2b07f0fbdbb2f1c1',
  ['33'.repeat(32)]:
    '043c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b13b306b0fe085665d8fc1b28ae1676cd3ad6e08eaeda225fe38d0da4de55703e0',
  [`${'00'.repeat(31)}6d`]:
    '0432d31c222f8f6f0ef86f7c98d3a3335ead5bcd32abdd94289fe4d3091aa824bf5f3032f5892156e39ccd3d7915b9e1da2e6dac9e6f26e961118d14b8462e1661',
}

export function sec1Point(hex: string, compressed: boolean): Buffer {
  const point = (compressed ? COMPRESSED : UNCOMPRESSED)[hex.toLowerCase()]
  if (point === undefined) throw new Error('sec1-pin')
  return Buffer.from(point, 'hex')
}

/** `{ toBuffer, toPublicKey, compressed }` for a pinned secret.
 * `toBuffer` returns a copy of the 32-byte scalar. */
export function sec1PrivateKey(hex: string, compressed: boolean) {
  const secret = Buffer.from(hex.toLowerCase(), 'hex')
  const point = sec1Point(hex, compressed)
  return {
    compressed,
    toBuffer(): Uint8Array {
      return Uint8Array.from(secret)
    },
    toPublicKey() {
      return {
        toBuffer(): Uint8Array {
          return Uint8Array.from(point)
        },
      }
    },
  }
}
