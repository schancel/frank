/**
 * Standard non-interactive Schnorr proof-of-knowledge (PoK) of the discrete log of a point.
 *
 * Why this file exists (important for how this package is safe to use):
 *
 * The dlcspecs ECDSA-adaptor.md spec this package's `ecdsa-adaptor.ts` implements carries an
 * explicit warning:
 *
 *   "WARNING: This scheme is applicable to DLCs only and should not be applied in another
 *   context without careful analysis. This is because each adaptor signature leaks the
 *   Diffie-Hellman key for the signing key X and the encryption key Y."
 *
 * The spec goes on to explain *why* DLCs get away without extra precautions: the security proof
 * for the construction (Aumayr, Ersoy, Erwig, Faust, Hostakova, Maffei, Moreno-Sanchez, Riahi,
 * "Generalized Bitcoin-Compatible Channels", https://eprint.iacr.org/2020/476.pdf) requires a
 * proof of knowledge of the discrete log to be attached to the encryption point (`Y`/`T`). In a
 * DLC, `Y` is an oracle's anticipated signature point, which by construction the oracle already
 * "knows" the discrete log of -- so the DLC spec safely omits an explicit PoK.
 *
 * Frank's two target use cases (a provably-fair game's outcome commitment, and an atomic swap's
 * per-swap secret) are *not* DLCs: `T = t*G` is generated directly by whichever party will later
 * reveal `t`, and nothing about the protocol structurally guarantees they know it. To use this
 * construction safely outside the DLC-only context the spec restricts itself to, this package
 * requires every tweak point `T` to carry a PoK of its discrete log (see `generateTweak` /
 * `verifyTweak` in `ecdsa-adaptor.ts`), restoring the precondition the Aumayr et al. security
 * proof actually needs.
 *
 * The PoK construction itself is the textbook Schnorr identification protocol made
 * non-interactive via Fiat-Shamir (Schnorr, "Efficient Identification and Signatures for Smart
 * Cards", CRYPTO '89) -- unrelated to the ECDSA-adaptor-specific machinery above, and not novel.
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

const POK_TAG = 'ADAPTOR-TWEAK-POK'

export interface PokProof {
  R: Point
  z: bigint
}

function challenge(T: Point, R: Point): bigint {
  return hashToScalar(taggedHash(POK_TAG, pointBytes(T), pointBytes(R)))
}

/**
 * Prove knowledge of `t` such that `T = t*G`. Caller must ensure this holds.
 *
 * Side-channel note: `t` and the proof nonce `r` (from `sampleNonce`) are both secret here. This
 * function has no branches keyed on either; `G.multiply(r)` uses Noble's algorithmically
 * constant-shape wNAF path without scalar blinding, and `modAdd`/`modMul` use curve.ts's
 * branchless arithmetic. See curve.ts for the JavaScript-runtime limitation.
 */
export function pokProve(t: bigint, T: Point): PokProof {
  const r = sampleNonce(POK_TAG, pointBytes(T), scalarBytes(t))
  const R = G.multiply(r)
  const e = challenge(T, R)
  const z = modAdd(r, modMul(e, t))
  return { R, z }
}

/**
 * Verify a proof of knowledge of the discrete log of `T`.
 *
 * Side-channel note: every input here is public (`T` and the proof), so the branching below is
 * ordinary branching on public data -- see curve.ts's header comment.
 */
export function pokVerify(T: Point, proof: PokProof): boolean {
  try {
    const { R, z } = proof
    if (z === 0n) return false
    const e = challenge(T, R)
    const lhs = G.multiply(z)
    const rhs = R.add(T.multiply(e))
    return lhs.equals(rhs)
  } catch {
    return false
  }
}
