/**
 * Shared secp256k1 scalar/point helpers used by the DLEQ proof, the Schnorr proof-of-knowledge,
 * and the ECDSA adaptor signature scheme itself.
 *
 * Uses @noble/curves (audited, widely-used, minimal-dependency) rather than this monorepo's
 * existing `elliptic`-based `bitcore-lib-xpi` dependency: @noble/curves ships first-class
 * TypeScript types for the exact primitives this module needs (a scalar field object, typed
 * Weierstrass points) and no separate BN.js-style big-number dependency to keep in sync.
 * `elliptic` would work too (Frank already trusts it, via bitcore-lib-xpi), but its API is untyped
 * JS and its `BN` reduction helpers are more awkward to use safely from TypeScript for the modular
 * arithmetic this construction leans on heavily.
 *
 * SIDE-CHANNEL / TIMING POSTURE (read this before touching secret-scalar code in this file):
 *
 * I am not a cryptographer, and nothing below is a substitute for a real, external security
 * review or measured (not just reasoned-about) timing analysis. What follows is the concrete,
 * checkable hardening I could actually do and verify by reading code: no branch or loop bound in
 * this file is keyed on the *value* of a secret scalar (a private key, a tweak secret `t`, or a
 * nonce `k`/`a`/`r`). Specifically:
 *
 *   - `mod()` avoids an `if`/ternary on the sign of its input (which would branch on secret data
 *     whenever called on secret-derived values) by using `select()`/`negativeMask()` below --
 *     arithmetic bit-masking instead of a conditional.
 *   - `modInv()` uses Fermat's little theorem (`x^(n-2) mod n`, valid because `n` is prime) via a
 *     fixed-shape square-and-multiply (`modPow`), instead of @noble/curves' own scalar-field
 *     `Fn.inv()`. As of @noble/curves 2.4.0, `Fn.inv` (see
 *     node_modules/@noble/curves/src/abstract/modular.ts, the generic `Field(...).inv()` used for
 *     both the coordinate field `Fp` and the scalar field `Fn`) implements the extended Euclidean
 *     algorithm, whose control flow branches on the *value* of its input at every step -- exactly
 *     the class of bug behind real-world ECDSA nonce-recovery timing attacks. @noble/curves does
 *     ship a constant-time alternative for this (`invertCt`, also Fermat-based, used internally
 *     for `Fp`/sqrt) but does not expose an `Fn`-flavored equivalent, so `modInv` below
 *     reimplements the same idea directly for the scalar field. `modPow`'s exponent is always the
 *     fixed public constant `n - 2`, never secret data, so looping over *its* bits is not a
 *     secret-dependent branch -- every call executes the identical sequence of squarings and
 *     multiplications regardless of the (secret) base.
 *   - `scalarBytes()` encodes with a fixed 32-iteration byte-extraction loop instead of
 *     @noble/curves' `numberToBytesBE`, which (see node_modules/@noble/curves/src/utils.ts)
 *     round-trips the value through `n.toString(16)` and `padStart` -- both of whose cost scales
 *     with the number of leading zero nibbles, a (low-bandwidth, but real) secret-dependent timing
 *     signal for values fed to it that happen to be secret (private keys, tweak secrets, nonces).
 *
 * What this file does NOT attempt to fix, and instead explicitly delegates to @noble/curves,
 * trusting its own documented guarantees rather than silently assuming them:
 *
 *   - Scalar-point multiplication (`Point.multiply`, used everywhere in dleq.ts/tweak-pok.ts/
 *     ecdsa-adaptor.ts, including on secret scalars) is documented by @noble/curves as
 *     constant-time with scalar blinding (see `multiply()`'s doc comment in
 *     node_modules/@noble/curves/src/abstract/weierstrass.ts). This package always uses the plain
 *     `.multiply()`, never the explicitly-non-constant-time `.multiplyUnsafe()`, even in
 *     verification-only code paths that only ever see public data (where `multiplyUnsafe` would
 *     be safe and faster) -- simplicity and not having two code paths to keep straight won out
 *     over that performance gain.
 *   - `secp256k1.utils.randomSecretKey()` (used by `randomScalar`) for CSPRNG-backed, uniform,
 *     rejection-sampled secret generation.
 *   - SHA-256 (`@noble/hashes/sha2.js`) for fixed-time hashing of fixed-length inputs (every value
 *     hashed by `taggedHash` in this package -- points, scalars, message digests -- has a length
 *     that depends only on its *type*, never on a secret's value, so hash-input-length is not a
 *     side channel here).
 *
 * Also out of scope, deliberately: the underlying JS bigint arithmetic itself (`+`, `-`, `*`,
 * `%`, `>>`, `&`) is provided by the JS engine (V8), and this package cannot make any binding
 * guarantee about its constant-timeness -- only that this file's own control flow (branches, loop
 * bounds) does not add secret-dependent variation on top of whatever the engine already does.
 * A couple of remaining, deliberately-accepted exceptions to "no secret-dependent branch",
 * documented at their call sites rather than hidden: `modInv`'s explicit zero-input rejection, and
 * `sampleNonce`'s zero-digest retry loop. Both guard against a ~1-in-2^256 malformed/degenerate
 * input whose *presence* (not value) is what the branch reveals, and in both cases that same "did
 * this degenerate case happen" fact is already visible through the function's ordinary return
 * value/thrown exception (or, for the retry loop, is simply unobservable in practice -- it will
 * not execute a second iteration in the lifetime of this software) -- a timing channel would tell
 * an attacker nothing they couldn't already read directly off the result. `ecdsa-adaptor.ts`'s
 * `decryptSignature` BIP62 low-S negation is handled
 * branchlessly anyway (via `negateIfGreaterThan` below), even though the same reasoning applies to
 * it (the low/high-ness of `s` becomes public the moment the completed signature is used), simply
 * because doing so was free.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import type { WeierstrassPoint } from '@noble/curves/abstract/weierstrass.js'
import { bytesToNumberBE, concatBytes, randomBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'

/** A secp256k1 curve point (affine coordinates are plain bigints). */
export type Point = WeierstrassPoint<bigint>

/** The secp256k1 base point / generator. */
export const G: Point = secp256k1.Point.BASE

/** The secp256k1 group order (a 256-bit prime). */
export const CURVE_ORDER: bigint = secp256k1.Point.Fn.ORDER

const n = CURVE_ORDER

/**
 * -1n if `x` is negative, else 0n. Implemented as an arithmetic (sign-extending) right shift
 * rather than a comparison: bigints are conceptually arbitrary-precision two's complement, so
 * shifting a negative value right by more bits than its magnitude converges to -1n (all-ones),
 * and a non-negative value converges to 0n. 1023 bits is comfortably more than any magnitude this
 * package ever produces (every value here is a sum/difference/product of already curve-order-
 * bounded, i.e. ~256-bit, scalars). This is the building block `mod()` and `negateIfGreaterThan()`
 * use to avoid an `if`/ternary on secret-derived values.
 */
function negativeMask(x: bigint): bigint {
  return x >> 1023n
}

/**
 * Select `whenTrue` if `mask` is the all-ones mask (-1n), else `whenFalse` (`mask` is 0n) --
 * branchless (no `if`/ternary) select between two already-computed values, driven by a
 * `negativeMask()` result rather than a plain boolean comparison.
 */
function select(mask: bigint, whenTrue: bigint, whenFalse: bigint): bigint {
  return whenFalse + (mask & (whenTrue - whenFalse))
}

/** Reduce an arbitrary (possibly negative) bigint into the canonical [0, n) scalar range. */
export function mod(x: bigint): bigint {
  const r = x % n
  return select(negativeMask(r), r + n, r)
}

export function modAdd(a: bigint, b: bigint): bigint {
  return mod(a + b)
}

export function modSub(a: bigint, b: bigint): bigint {
  return mod(a - b)
}

export function modMul(a: bigint, b: bigint): bigint {
  return mod(a * b)
}

/** Curve order minus 2: the fixed, public Fermat's-little-theorem exponent used by `modInv`. */
const INVERSE_EXPONENT = n - 2n

/**
 * `base^exponent mod n` via left-to-right square-and-multiply. Only ever called internally with
 * `exponent = INVERSE_EXPONENT`, a fixed public constant -- see this file's header comment for why
 * branching on the exponent's bits (as this loop does) is not a secret-dependent branch even when
 * `base` is secret.
 */
function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n
  let b = mod(base)
  let e = exponent
  while (e > 0n) {
    if (e & 1n) result = modMul(result, b)
    b = modMul(b, b)
    e >>= 1n
  }
  return result
}

/**
 * Modular inverse of `x` mod the curve order, via Fermat's little theorem (`n` is prime, so
 * `x^(n-2) === x^-1 (mod n)` for non-zero `x`). See this file's header comment for why this
 * reimplements inversion instead of using @noble/curves' `Fn.inv`.
 */
export function modInv(x: bigint): bigint {
  const reduced = mod(x)
  if (reduced === 0n) {
    throw new Error('cannot invert zero scalar')
  }
  return modPow(reduced, INVERSE_EXPONENT)
}

/** Negate a scalar mod n. */
export function modNeg(x: bigint): bigint {
  return modSub(0n, x)
}

/**
 * Branchless (no `if`/ternary keyed on the comparison) equivalent of
 * `x > threshold ? modNeg(x) : x`. Used for BIP62 low-S normalization in ecdsa-adaptor.ts's
 * `decryptSignature` -- see this file's header comment for why that's defense-in-depth rather
 * than strictly load-bearing (the result is published either way).
 */
export function negateIfGreaterThan(x: bigint, threshold: bigint): bigint {
  const negated = modNeg(x)
  const isGreaterMask = negativeMask(threshold - x)
  return select(isGreaterMask, negated, x)
}

/**
 * A cryptographically random scalar in [1, n-1], suitable for use as a private key, a tweak
 * secret, or (when combined with additional context via `sampleNonce`) a nonce.
 */
export function randomScalar(): bigint {
  return bytesToNumberBE(secp256k1.utils.randomSecretKey())
}

/** Encode a point as 33-byte compressed SEC1 bytes. */
export function pointBytes(p: Point): Uint8Array {
  return p.toBytes(true)
}

/**
 * Encode a scalar as 32-byte big-endian bytes, via a fixed 32-iteration extraction loop (always
 * exactly 32 iterations, regardless of `x`) rather than @noble/curves' `numberToBytesBE` -- see
 * this file's header comment for why.
 */
export function scalarBytes(x: bigint): Uint8Array {
  const reduced = mod(x)
  const out = new Uint8Array(32)
  let v = reduced
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/**
 * Parse 33-byte compressed SEC1 bytes into a curve point. This operates on public,
 * externally-supplied wire data (never a secret), so it is fine for it to branch/throw based on
 * its input; it exists so verification/deserialization code has a single, obviously-correct place
 * that does that. All of the actual validation (length, valid prefix byte, x is a valid field
 * element, x/y is actually on the curve) is delegated entirely to @noble/curves'
 * `secp256k1.Point.fromBytes` -- this package does not re-implement or double-check any of that,
 * and trusts @noble/curves to reject malformed/invalid-curve-point input rather than silently
 * coercing it.
 *
 * Note this deliberately allows an x-coordinate at or above the curve order `n` (the point is a
 * valid element of the elliptic curve group over the field of size `p > n`; only after it's used
 * to derive an ECDSA `r` value does anything get reduced mod `n`) -- this matches the dlcspecs
 * test vectors, which include exactly this case ("R can be above curve order").
 */
export function pointFromBytes(bytes: Uint8Array): Point {
  return secp256k1.Point.fromBytes(bytes)
}

/**
 * Parse exactly 32 big-endian bytes into a scalar, enforcing canonical range `[0, n-1]` (or
 * `[1, n-1]` when `allowZero` is false). This is for decoding scalars that arrived as fixed-width
 * wire bytes (e.g. an adaptor signature's `s_a` or DLEQ proof scalars) where a non-canonical
 * encoding (equal to or above the curve order, or -- for `s_a` -- exactly zero) must be rejected
 * outright rather than silently reduced mod `n`, per the dlcspecs serialization test vectors
 * ("s_a cannot be zero", "s_a too high"). This is intentionally *not* used for secret scalars: it
 * always operates on public/wire-format data, so branching on the parsed value here is fine (see
 * the file-level side-channel note for the distinction this package draws between secret-touching
 * and public-data code paths).
 */
export function scalarFromBytesCanonical(bytes: Uint8Array, allowZero: boolean): bigint {
  if (bytes.length !== 32) {
    throw new Error(`scalar must be exactly 32 bytes, got ${bytes.length}`)
  }
  const x = bytesToNumberBE(bytes)
  if (x >= n) {
    throw new Error('scalar out of range: must be less than the curve order')
  }
  if (x === 0n && !allowZero) {
    throw new Error('scalar out of range: must be non-zero')
  }
  return x
}

/** Reduce a 32-byte hash digest into a scalar mod n, per the usual ECDSA `bits2int` convention. */
export function hashToScalar(hash: Uint8Array): bigint {
  return mod(bytesToNumberBE(hash))
}

/**
 * Domain-separated tagged hash used to build Fiat-Shamir challenges and nonces, following the
 * "tag || tag || data" convention from BIP340 / the dlcspecs ECDSA-adaptor.md spec. Using a
 * distinct tag per protocol/purpose keeps the DLEQ proof's hash, the proof-of-knowledge's hash,
 * and nonce generation from colliding with each other even if used with identical inputs.
 */
export function taggedHash(tag: string, ...parts: Uint8Array[]): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag))
  return sha256(concatBytes(tagHash, tagHash, ...parts))
}

/**
 * Generate a nonce scalar for a signing/proving operation.
 *
 * Design decision (nonce generation scheme): this is a *hedged* nonce -- `H(tag, fresh random
 * bytes, ...context)`, where `...context` includes whatever secret material and public statement
 * data the caller is proving/signing over (e.g. `encryptedSign` passes `scalarBytes(privateKey)`;
 * `dleqProve`/`pokProve` pass the witness scalar). This is deliberately *not* pure RFC6979-style
 * determinism (nonce = a pure function of the secret key and message, with no randomness at all),
 * even though the task that produced this package's hardening pass asked me to consider moving
 * closer to that. I considered it and am keeping this hedged construction instead. Reasoning:
 *
 *   - The dlcspecs spec this package implements explicitly recommends this direction over plain
 *     determinism: "we recommend adding system randomness into the process as well ... or applying
 *     a more sophisticated approach as in [BIP340]" (ECDSA-adaptor.md, "Secure Nonce Generation").
 *   - BIP340 (Schnorr) itself made the same call for the same reason: its `aux_rand`-hedged nonce
 *     was chosen over plain RFC6979-style determinism specifically for defense-in-depth against
 *     fault/differential-power attacks that target the fact that a purely deterministic nonce
 *     computation is bit-for-bit repeatable on demand -- repeatability that an attacker with fault
 *     injection can exploit by forcing the same computation multiple times and comparing traces.
 *     Folding in fresh randomness breaks that repeatability at zero cost to a well-seeded system.
 *   - This construction already gets RFC6979's core benefit -- a broken/predictable/all-zeros RNG
 *     cannot make nonces low-entropy or repeat across distinct signing contexts -- because the
 *     hash input already includes secret, per-call context (the private key / witness scalar,
 *     which an RNG-only scheme wouldn't include). A failing RNG here degrades to "as good as pure
 *     RFC6979 over this same context", not to "predictable nonce": recovering `k` would still
 *     require recovering the secret scalar mixed into the hash.
 *   - Frank's actual deployment (a server-side Node process, not an embedded/hardware signer under
 *     an attacker's physical control) makes the fault-injection scenario hedging defends against
 *     fairly remote here, but the fresh-randomness ingredient costs nothing to keep and is cheap
 *     insurance against implementation bugs elsewhere in this package that might accidentally
 *     cause the same context to be hashed twice.
 *
 * The zero-digest case (a ~1-in-2^256 event) retries with fresh randomness rather than falling
 * back to a fixed constant nonce -- this is unreachable in practice, but a loop is a strictly
 * cleaner failure mode than a hardcoded low-entropy fallback value would have been.
 */
export function sampleNonce(tag: string, ...parts: Uint8Array[]): bigint {
  for (;;) {
    const fresh = randomBytes(32)
    const digest = taggedHash(tag, fresh, ...parts)
    const k = hashToScalar(digest)
    if (k !== 0n) return k
  }
}
