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
 * public spec text, not a port of that C/Rust code, and has NOT been checked against the
 * upstream dlcspecs test vectors (see this package's top-level report/PR notes for why, and for
 * what that gap means for how much to trust this code).
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
import {
  type Point,
  G,
  CURVE_ORDER,
  mod,
  modAdd,
  modMul,
  modInv,
  modNeg,
  randomScalar,
  sampleNonce,
  pointBytes,
  scalarBytes,
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

/** Generate a fresh secp256k1 keypair. */
export function generateKeypair(): Keypair {
  const privateKey = randomScalar()
  return { privateKey, publicKey: G.multiply(privateKey) }
}

/**
 * Generate a fresh tweak secret `t` and its public point `T = t*G`, together with a
 * proof-of-knowledge of `t`. Whoever will reveal `t` later (the game host revealing a provably
 * fair outcome seed, or a swap counterparty revealing their half of the swap) calls this.
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
 */
export function decryptSignature(adaptorSig: AdaptorSignature, t: bigint): EcdsaSignature {
  const { R, sa } = adaptorSig
  let s = modMul(sa, modInv(t))
  const r = mod(R.x)
  // BIP62-style low-S normalization, matching the spec and standard Bitcoin/Ethereum convention.
  if (s > HALF_ORDER) {
    s = modNeg(s)
  }
  return { r, s }
}

/**
 * Extraction: given the original adaptor signature and the completed ECDSA signature it was
 * decrypted into (e.g. observed on-chain), recover the tweak secret `t`. This is what makes
 * atomic swaps and adaptor-signature-based payouts work: whoever holds the adaptor signature can
 * watch the completed signature land on-chain and pull `t` back out of it.
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
