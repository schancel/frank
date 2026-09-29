/**
 * ECDSA adaptor signatures ("scriptless scripts") over secp256k1.
 *
 * Construction: the DLEQ-based ECDSA adaptor signature scheme specified in
 * discreetlogcontracts/dlcspecs' ECDSA-adaptor.md,
 *   https://github.com/discreetlogcontracts/dlcspecs/blob/master/ECDSA-adaptor.md
 * which is itself based on Lloyd Fournier's "One-Time Verifiably Encrypted Signatures A.K.A.
 * Adaptor Signatures" (https://github.com/LLFourn/one-time-VES/blob/master/main.pdf), refined so
 * that Aumayr et al.'s security proof ("Generalized Bitcoin-Compatible Channels",
 * https://eprint.iacr.org/2020/476.pdf) applies. This is the same construction implemented in
 * production by Blockstream's secp256k1-zkp `ecdsa_adaptor` module (used by rust-dlc and other
 * real DLC implementations) -- this file is an independent TypeScript implementation from the
 * public spec text, not a port of that C/Rust code. It IS checked against the upstream dlcspecs
 * test vectors (all 11 pass -- see ./dlcspecs-vectors.jest.test.ts and this package's top-level
 * README for the conformance details), which is meaningful evidence of correctness but, per that
 * README's security-status section, not a substitute for an external cryptographer's review --
 * this has not had one.
 *
 * IMPORTANT non-DLC caveat: the dlcspecs document explicitly warns this scheme is "applicable to
 * DLCs only" without "careful analysis" of other contexts, because each adaptor signature leaks
 * the Diffie-Hellman key between the signing key `X` and the encryption key `Y`/`T`. Per that
 * same document, the Aumayr et al. security proof covers the general case too, *provided* the
 * encryption point carries a proof of knowledge of its own discrete log. This package requires
 * exactly that: `generateTweak()` always produces a proof of knowledge alongside `T`, and
 * `verifyEncryptedSignature` takes an already-verified `T` -- callers MUST call `verifyTweak`
 * (or equivalent) on any `T` supplied by a counterparty before ever encrypting or accepting an
 * adaptor signature under it. See `./tweak-pok.ts` for the detailed rationale.
 *
 * Terminology used throughout, matching the task/spec vocabulary:
 *   - `t`: the tweak/adaptor secret (a scalar). `T = t*G` is the adaptor/encryption point.
 *   - "encrypted signing" / adaptor signature: a signature on a message, encrypted under `T`,
 *     producible from a real private key without knowledge of `t`.
 *   - "decryption" / "completion": turning an adaptor signature into a normal ECDSA signature,
 *     given `t`.
 *   - "recovery" / "extraction": recovering `t` from an adaptor signature plus the completed
 *     ECDSA signature it decrypts to.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { concatBytes } from '@noble/curves/utils.js'
import {
  type Point,
  G,
  CURVE_ORDER,
  mod,
  modAdd,
  modMul,
  modInv,
  modNeg,
  negateIfGreaterThan,
  randomScalar,
  sampleNonce,
  pointBytes,
  scalarBytes,
  pointFromBytes,
  scalarFromBytesCanonical,
  hashToScalar,
} from './curve'
import { dleqProve, dleqVerify, type DleqProof } from './dleq'
import { pokProve, pokVerify, type PokProof } from './tweak-pok'

const SIGN_TAG = 'ECDSA-ADAPTOR'
const HALF_ORDER = CURVE_ORDER >> 1n

export interface Keypair {
  privateKey: bigint
  publicKey: Point
}

export interface Tweak {
  /** The tweak secret `t`. Never share this until the swap/game outcome should be revealed. */
  t: bigint
  /** The public adaptor point `T = t*G`. Safe to share; this is what adaptor sigs encrypt under. */
  T: Point
  /** Proof that the party publishing `T` knows `t`. See ./tweak-pok.ts for why this matters. */
  pok: PokProof
}

export interface AdaptorSignature {
  /** The "encryption point" R = k*T, where k is the signer's per-signature nonce. */
  R: Point
  /** The public nonce commitment R_a = k*G. */
  Ra: Point
  /** The encrypted `s` scalar. */
  sa: bigint
  /** DLEQ proof that R and Ra share the same discrete log k (base T and base G respectively). */
  proof: DleqProof
}

export interface EcdsaSignature {
  r: bigint
  s: bigint
}

/**
 * Generate a fresh secp256k1 keypair.
 *
 * Side-channel note: `G.multiply(privateKey)` multiplies the curve generator by a freshly
 * generated secret scalar. This relies entirely on @noble/curves' `Point.multiply` being
 * constant-time (with scalar blinding) -- see curve.ts's header comment. This file never uses
 * `multiplyUnsafe` on a secret scalar anywhere.
 */
export function generateKeypair(): Keypair {
  const privateKey = randomScalar()
  return { privateKey, publicKey: G.multiply(privateKey) }
}

/**
 * Generate a fresh tweak secret `t` and its public point `T = t*G`, together with a
 * proof-of-knowledge of `t`. Whoever will reveal `t` later (the game host revealing a provably
 * fair outcome seed, or a swap counterparty revealing their half of the swap) calls this.
 *
 * Side-channel note: same as `generateKeypair` above -- `G.multiply(t)` relies on @noble/curves'
 * constant-time `Point.multiply`.
 */
export function generateTweak(): Tweak {
  const t = randomScalar()
  const T = G.multiply(t)
  const pok = pokProve(t, T)
  return { t, T, pok }
}

/**
 * Verify that a `T` supplied by a counterparty really does have a known discrete log, per its
 * accompanying proof of knowledge. Callers MUST call this (and reject on failure) before treating
 * any externally-supplied `T` as safe to encrypt an adaptor signature under or to accept one
 * against -- see the module-level caveat above.
 */
export function verifyTweak(T: Point, pok: PokProof): boolean {
  return pokVerify(T, pok)
}

/**
 * Encrypted signing ("adaptor sign"): produce a signature on `messageHash` under private key
 * `privateKey`, encrypted so that it can only be completed into a normal ECDSA signature by
 * whoever knows the discrete log of `T`.
 *
 * `messageHash` must be a 32-byte digest (e.g. sha256/keccak256 of the actual message/tx), not
 * the raw message -- matching ordinary ECDSA/secp256k1 convention.
 *
 * Side-channel note: this is the function in this package that does the most work on secret
 * material at once -- the private signing key `privateKey` and the per-call nonce `k` are both
 * secret here. The length check below only inspects the public `messageHash`'s length (fixed,
 * public-format validation, not a secret-dependent branch) and fails before any secret is
 * touched. `G.multiply(k)` / `T.multiply(k)` rely on @noble/curves' constant-time `Point.multiply`
 * (see curve.ts's header comment); `modInv(k)` uses curve.ts's Fermat-based constant-shape
 * inverse, not a data-dependent one.
 */
export function encryptedSign(privateKey: bigint, T: Point, messageHash: Uint8Array): AdaptorSignature {
  if (messageHash.length !== 32) {
    throw new Error('messageHash must be a 32-byte digest')
  }
  const m = hashToScalar(messageHash)
  const k = sampleNonce(SIGN_TAG, pointBytes(T), messageHash, scalarBytes(privateKey))
  const Ra = G.multiply(k)
  const R = T.multiply(k)
  const proof = dleqProve(k, Ra, T, R)
  const r = mod(R.x)
  const sa = modMul(modInv(k), modAdd(m, modMul(r, privateKey)))
  return { R, Ra, sa, proof }
}

/**
 * Verify that an adaptor signature is well-formed relative to the signer's public key and the
 * adaptor point `T`, WITHOUT knowing `t`. A verifier who accepts this has cryptographic
 * assurance that decrypting with the true `t` (discrete log of `T`) yields a valid ECDSA
 * signature from `publicKey` over `messageHash`.
 *
 * Side-channel note: every input here is public (a public key, a public adaptor point, a message
 * hash, and the adaptor signature itself), so the early returns and try/catch below are ordinary,
 * unproblematic branching on public data -- see curve.ts's header comment for the distinction this
 * package draws between that and branching on secret material.
 */
export function verifyEncryptedSignature(
  publicKey: Point,
  T: Point,
  messageHash: Uint8Array,
  adaptorSig: AdaptorSignature,
): boolean {
  try {
    if (messageHash.length !== 32) return false
    const { R, Ra, sa, proof } = adaptorSig
    if (sa === 0n) return false
    if (!dleqVerify(Ra, T, R, proof)) return false
    const m = hashToScalar(messageHash)
    const r = mod(R.x)
    if (r === 0n) return false
    const saInv = modInv(sa)
    const u1 = modMul(saInv, m)
    const u2 = modMul(saInv, r)
    const RaPrime = G.multiply(u1).add(publicKey.multiply(u2))
    return RaPrime.equals(Ra)
  } catch {
    return false
  }
}

/**
 * Completion / decryption: given the tweak secret `t`, turn an adaptor signature into a normal
 * ECDSA (r, s) signature. The result is indistinguishable from an ordinary ECDSA signature --
 * see this package's tests for confirmation it verifies via @noble/curves' standard ECDSA
 * verifier, the same one used for any other secp256k1 signature.
 *
 * Side-channel note: `t` is secret at the point this function receives it (this is, in fact, the
 * function that turns it from "known only to whoever generated the tweak" into "whoever calls
 * this also has enough to complete the signature"). `modInv(t)` uses curve.ts's Fermat-based
 * constant-shape inverse rather than a data-dependent one, and the BIP62 low-S check below uses
 * `negateIfGreaterThan` (branchless) rather than an `if` -- see curve.ts's header comment for the
 * full reasoning, including why this particular branch wouldn't actually leak anything new even
 * if it weren't branchless (the result `s` is published either way).
 */
export function decryptSignature(adaptorSig: AdaptorSignature, t: bigint): EcdsaSignature {
  const { R, sa } = adaptorSig
  const s = negateIfGreaterThan(modMul(sa, modInv(t)), HALF_ORDER)
  const r = mod(R.x)
  return { r, s }
}

/**
 * Extraction: given the original adaptor signature and the completed ECDSA signature it was
 * decrypted into (e.g. observed on-chain), recover the tweak secret `t`. This is what makes
 * atomic swaps and adaptor-signature-based payouts work: whoever holds the adaptor signature can
 * watch the completed signature land on-chain and pull `t` back out of it.
 *
 * Side-channel note: every input here (`T`, `adaptorSig`, `sig`) is public/already-broadcast data,
 * and this function's entire purpose is to publicly reveal `t` from it -- there is no
 * confidentiality property left to protect by the time this runs, so the branches/early-throws
 * below (unlike everywhere `t`/a private key/a nonce is still secret, e.g. `decryptSignature`)
 * are ordinary and not a side-channel concern.
 */
export function recoverTweak(T: Point, adaptorSig: AdaptorSignature, sig: EcdsaSignature): bigint {
  const { R, sa } = adaptorSig
  const rImplied = mod(R.x)
  if (mod(sig.r) !== rImplied) {
    throw new Error('signature does not correspond to this adaptor signature (r mismatch)')
  }
  const y = modMul(modInv(sig.s), sa)
  const Yimplied = G.multiply(y)
  if (Yimplied.equals(T)) return y
  const negY = modNeg(y)
  if (G.multiply(negY).equals(T)) return negY
  throw new Error('recovered scalar does not match the expected adaptor point T')
}

/** Encode an EcdsaSignature as compact (r || s) bytes, and verify it via @noble/curves' verifier. */
export function verifyStandardEcdsaSignature(publicKey: Point, messageHash: Uint8Array, sig: EcdsaSignature): boolean {
  const sigBytes = new secp256k1.Signature(sig.r, sig.s).toBytes('compact')
  return secp256k1.verify(sigBytes, messageHash, pointBytes(publicKey), { prehash: false })
}

// --- Wire serialization ------------------------------------------------------------------------
//
// Everything below encodes/decodes the *public* structures this module already works with (an
// AdaptorSignature or an EcdsaSignature) to/from the exact byte layout the dlcspecs
// ECDSA-adaptor.md spec defines, so this implementation can actually interoperate with other
// implementations (e.g. rust-dlc / secp256k1-zkp) on the wire, and so it can be checked against
// the spec's own serialization test vectors (see ./dlcspecs-vectors.jest.test.ts). None of this
// touches secret material -- it only ever encodes/decodes public signature data -- so ordinary
// branching and early returns on parsed values are fine here.

const POINT_BYTE_LENGTH = 33
const SCALAR_BYTE_LENGTH = 32
/** `R || R_a || s_a || proof.b || proof.c`, per dlcspecs ECDSA-adaptor.md's `a := ...` encoding. */
const ADAPTOR_SIGNATURE_BYTE_LENGTH = POINT_BYTE_LENGTH * 2 + SCALAR_BYTE_LENGTH * 3

/**
 * Serialize an AdaptorSignature to the 162-byte wire format the dlcspecs spec defines:
 * `R (33) || R_a (33) || s_a (32) || proof.b (32) || proof.c (32)`.
 */
export function encodeAdaptorSignature(sig: AdaptorSignature): Uint8Array {
  return concatBytes(
    pointBytes(sig.R),
    pointBytes(sig.Ra),
    scalarBytes(sig.sa),
    scalarBytes(sig.proof.b),
    scalarBytes(sig.proof.c),
  )
}

/**
 * Parse the 162-byte wire format back into an AdaptorSignature. Throws on anything that isn't a
 * validly-encoded adaptor signature per the spec: wrong length, an `R`/`R_a` that isn't a valid
 * compressed secp256k1 point (delegated to @noble/curves), or a non-canonical scalar (`s_a`
 * greater than or equal to the curve order, or exactly zero -- matching the dlcspecs
 * "s_a too high" / "s_a cannot be zero" serialization test vectors). `R`/`R_a` are deliberately
 * *not* required to have an x-coordinate below the curve order: a valid curve point's coordinates
 * live in the (larger) field, not mod `n`, and the spec's own vectors include this case
 * ("R can be above curve order").
 *
 * This function does not verify the resulting signature is valid against any key/message -- call
 * `verifyEncryptedSignature` for that.
 */
export function decodeAdaptorSignature(bytes: Uint8Array): AdaptorSignature {
  if (bytes.length !== ADAPTOR_SIGNATURE_BYTE_LENGTH) {
    throw new Error(`adaptor signature must be exactly ${ADAPTOR_SIGNATURE_BYTE_LENGTH} bytes, got ${bytes.length}`)
  }
  let offset = 0
  const takePoint = (): Point => {
    const p = pointFromBytes(bytes.subarray(offset, offset + POINT_BYTE_LENGTH))
    offset += POINT_BYTE_LENGTH
    return p
  }
  const takeScalar = (allowZero: boolean): bigint => {
    const s = scalarFromBytesCanonical(bytes.subarray(offset, offset + SCALAR_BYTE_LENGTH), allowZero)
    offset += SCALAR_BYTE_LENGTH
    return s
  }
  const R = takePoint()
  const Ra = takePoint()
  const sa = takeScalar(false)
  const b = takeScalar(true)
  const c = takeScalar(true)
  return { R, Ra, sa, proof: { b, c } }
}

/** `EcdsaSignature` wire length: `r (32) || s (32)`, matching dlcspecs' `ecdsa_adaptor_decrypt`. */
const ECDSA_SIGNATURE_BYTE_LENGTH = SCALAR_BYTE_LENGTH * 2

/** Serialize an EcdsaSignature to compact `r (32) || s (32)` bytes. */
export function encodeEcdsaSignature(sig: EcdsaSignature): Uint8Array {
  return concatBytes(scalarBytes(sig.r), scalarBytes(sig.s))
}

/** Parse compact `r (32) || s (32)` bytes back into an EcdsaSignature. Throws on invalid input. */
export function decodeEcdsaSignature(bytes: Uint8Array): EcdsaSignature {
  if (bytes.length !== ECDSA_SIGNATURE_BYTE_LENGTH) {
    throw new Error(`ECDSA signature must be exactly ${ECDSA_SIGNATURE_BYTE_LENGTH} bytes, got ${bytes.length}`)
  }
  const r = scalarFromBytesCanonical(bytes.subarray(0, SCALAR_BYTE_LENGTH), false)
  const s = scalarFromBytesCanonical(bytes.subarray(SCALAR_BYTE_LENGTH), false)
  return { r, s }
}
