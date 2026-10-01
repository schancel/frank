// secp256k1 encoding checks for the type-5 stamp fields (README T3b, stage 8.2). This is only
// the wire-level well-formedness of a point and of the proof scalars; no group arithmetic
// beyond the curve equation lives here, and the DLEQ proof itself is a stage 10 check.

/** Field prime `p` of secp256k1. */
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn
/** Group order `n` of secp256k1. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

function bytesToBigInt(b: Uint8Array): bigint {
  let x = 0n
  for (const v of b) x = (x << 8n) | BigInt(v)
  return x
}

function powMod(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n
  let b = base % mod
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod
    b = (b * b) % mod
    e >>= 1n
  }
  return result
}

/**
 * True when `b` is a 33-byte SEC1 compressed encoding of a finite secp256k1 point: prefix `02`
 * or `03`, x below `p`, and `y^2 = x^3 + 7` solvable. The point at infinity has no compressed
 * encoding, so an all-zero or `00`-prefixed value is invalid. The prefix parity is not
 * checked against a specific root, because both roots exist for every valid x.
 */
export function isCompressedPoint(b: Uint8Array): boolean {
  if (b.length !== 33 || (b[0] !== 0x02 && b[0] !== 0x03)) return false
  const x = bytesToBigInt(b.subarray(1))
  if (x >= P) return false
  const rhs = (powMod(x, 3n, P) + 7n) % P
  // p = 3 mod 4, so a square root, when one exists, is rhs^((p+1)/4).
  const y = powMod(rhs, (P + 1n) / 4n, P)
  return (y * y) % P === rhs
}

/** True when `b` is a 64-byte DLEQ proof `c || s` with each scalar in `1..n-1` (T3b). */
export function isProofEncoding(b: Uint8Array): boolean {
  if (b.length !== 64) return false
  for (const half of [b.subarray(0, 32), b.subarray(32)]) {
    const v = bytesToBigInt(half)
    if (v < 1n || v >= N) return false
  }
  return true
}
