/**
 * Non-interactive discrete-log-equality (DLEQ) proof: proves that the same scalar `x` is the
 * discrete log of `X` (base `G`) and of `Z` (base `Y`), i.e. `X = x*G` and `Z = x*Y`, without
 * revealing `x`.
 *
 * This is a Fiat-Shamir-transformed Sigma protocol (see [Sch] below), specified exactly as in
 * the "Proof of Discrete Logarithm Equality" section of the discreetlogcontracts/dlcspecs
 * ECDSA-adaptor.md spec:
 *   https://github.com/discreetlogcontracts/dlcspecs/blob/master/ECDSA-adaptor.md
 *
 * It is the building block the ECDSA adaptor signature scheme (`./ecdsa-adaptor.ts`) uses to let
 * a verifier confirm an adaptor signature's encryption point `R = k*T` was derived from the same
 * nonce `k` as the public commitment `R_a = k*G`, without learning `k`.
 *
 * [Sch]: Sigma protocols / Fiat-Shamir background, https://www.win.tue.nl/~berry/CryptographicProtocols/LectureNotes.pdf
 */
import {
  type Point,
  G,
  modAdd,
  modMul,
  sampleNonce,
  pointBytes,
  scalarBytes,
  taggedHash,
  hashToScalar,
} from './curve'

const DLEQ_TAG = 'DLEQ'

export interface DleqProof {
  b: bigint
  c: bigint
}

function challenge(
  X: Point,
  Y: Point,
  Z: Point,
  A_G: Point,
  A_Y: Point,
): bigint {
  return hashToScalar(
    taggedHash(
      DLEQ_TAG,
      pointBytes(X),
      pointBytes(Y),
      pointBytes(Z),
      pointBytes(A_G),
      pointBytes(A_Y),
    ),
  )
}

/**
 * Prove that `x` is the discrete log of both `X` (base `G`) and `Z` (base `Y`).
 * Caller must ensure `X === x*G` and `Z === x*Y` -- this function does not check that itself.
 *
 * Side-channel note: `x` (the witness) and `a` (the proof nonce, from `sampleNonce`) are both
 * secret here. This function itself has no branches keyed on either. `G.multiply(a)` /
 * `Y.multiply(a)` use Noble's algorithmically constant-shape wNAF path without scalar blinding;
 * `modAdd`/`modMul` rely on curve.ts's branchless `mod()`. See curve.ts for the JavaScript-runtime
 * limitation.
 */
export function dleqProve(x: bigint, X: Point, Y: Point, Z: Point): DleqProof {
  // Matches the spec's `sample_nonce(tag || X || Y || Z || x)`, folding the witness and
  // statement into the nonce derivation; `sampleNonce` additionally mixes in fresh system
  // randomness per this codebase's non-deterministic nonce convention (see curve.ts).
  const a = sampleNonce(
    DLEQ_TAG,
    pointBytes(X),
    pointBytes(Y),
    pointBytes(Z),
    scalarBytes(x),
  )
  const A_G = G.multiply(a)
  const A_Y = Y.multiply(a)
  const b = challenge(X, Y, Z, A_G, A_Y)
  const c = modAdd(a, modMul(b, x))
  return { b, c }
}

/**
 * Verify a DLEQ proof that some (unknown) `x` satisfies `X = x*G` and `Z = x*Y`.
 *
 * Side-channel note: every input here is public (the proof and the three statement points), so
 * the early returns and try/catch below are ordinary branching on public data, not a side-channel
 * concern -- see curve.ts's header comment.
 */
export function dleqVerify(
  X: Point,
  Y: Point,
  Z: Point,
  proof: DleqProof,
): boolean {
  try {
    const { b, c } = proof
    if (b === 0n || c === 0n) return false
    const A_G = G.multiply(c).subtract(X.multiply(b))
    const A_Y = Y.multiply(c).subtract(Z.multiply(b))
    const impliedB = challenge(X, Y, Z, A_G, A_Y)
    return impliedB === b
  } catch {
    // Malformed/adversarial points (e.g. multiplying by a rejected scalar) must fail closed.
    return false
  }
}
