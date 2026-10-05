/**
 * Two-party signing and two-party adaptor pre-signing.
 *
 * PLAIN SIGNING is Protocol 3.2 of Lindell, "Fast Secure Two-Party ECDSA
 * Signing" (CRYPTO 2017, ePrint 2017/552). Roles are fixed by key
 * generation: the key's initiator is P1 (it owns the Paillier key and learns
 * the signature first), the key's responder is P2. With n the curve order, m the digest as a scalar, h the
 * public key tweak (0 if none), x_I and x_R the shares:
 *
 *  1 I->R  commit(R1, pok)                  R1 = k1*G
 *  2 R->I  R2 || pok                        R2 = k2*G
 *  3 I->R  R1 || pok || nonce               (after verifying R's proof)
 *  4 R->I  c3                               (after verifying I's opening+proof)
 *          R = k2*R1, r = R.x,
 *          c3 = Enc_I(rho*n + k2^-1*(m + r*h))  (+)  (k2^-1 * r * x_R) (*) c_key_I
 *          with rho uniform in [0, n^2)
 *  5 I->R  r || s || recovery               s = k1^-1 * Dec(c3) mod n, low-s
 *
 * The only change to the paper is the `r*h` term, which makes the signature
 * valid for the tweaked key X + h*G (see tweak.ts): Dec(c3) = k2^-1 *
 * (m + r*(x_I*x_R + h)) mod n.
 *
 * ABORT RULE (Protocol 3.2 step 5 and the paper's proof): if the value the
 * initiator decrypts does not yield a valid signature, the initiator must
 * never use this key share again. A responder who can make the initiator
 * keep signing after such failures learns the initiator's share bit by bit
 * (the 2023 "Lindell17 abort" attack, CVE-2023-33242). This file burns the
 * share in that case and reports `keyShareBurned`.
 *
 * ADAPTOR PRE-SIGNING produces the 162-byte encrypted signature of
 * `@frank/adaptor-signatures` for the joint key, locked to the point T of a
 * validated lock (lock.ts). The published two-party ECDSA lock on Lindell
 * 2017 is Malavolta, Moreno-Sanchez, Schneidewind, Kate, Maffei, "Anonymous
 * Multi-Hop Locks for Blockchain Scalability and Interoperability" (NDSS
 * 2019), Section on ECDSA-based locks: both parties send their nonce share
 * over G and over the lock point with a proof that the two have the same
 * discrete log, the Paillier step uses r = (k1*k2*T).x, and P1 outputs
 * s' = k1^-1 * Dec(c3), which completes to a signature by dividing by the
 * lock secret. This file follows that structure. It differs in one place:
 * AMHL's pre-signature is checked by the two parties themselves, each using
 * its own nonce share; here the output must also be the self-contained
 * dlcspecs encoding, which carries one equality proof for the JOINT nonce.
 * The joint-proof step below produces that proof and is this package's own
 * construction. The output is: (R, R_a, s_a, b, c) with R_a = k*G, R = k*T, r = R.x,
 * s_a = k^-1*(m + r*x), and a discrete-log-equality proof (b, c) for
 * (R_a, R) over bases (G, T), where k = k1*k2. Each party also sends its
 * nonce share over base T with a proof, and the two build the final proof
 * together:
 *
 *  1 I->R  commit(R1, R1T, dleq, A1, A1T)   R1T = k1*T, A1 = a1*G, A1T = a1*T
 *  2 R->I  R2 || R2T || dleq || A2 || A2T   R2T = k2*T, A2 = a2*G, A2T = a2*T
 *  3 I->R  R1 || R1T || dleq || A1 || A1T || nonce
 *  4 R->I  c3 || z2                         z2 = a2 + b*k2
 *  5 I->R  the 162-byte adaptor signature   c = a1 + k1*z2
 *
 * with proof commitments A_G = A1 + k1*A2 = A1 + a2*R1 and
 * A_T = A1T + k1*A2T = A1T + a2*R1T and b the dlcspecs DLEQ challenge over
 * (R_a, T, R, A_G, A_T). Then c*G = A_G + b*R_a and c*T = A_T + b*R, which
 * is exactly what the single-signer verifier checks. The README states the
 * argument for the joint proof and lists it first among the points to
 * review.
 */
import {
  adaptorSignatureFromBytes,
  type AdaptorSignatureBytes,
} from '@frank/adaptor-signatures'
import {
  hashToScalar,
  mod,
  modAdd,
  modInv,
  modMul,
  taggedHash,
} from '@frank/adaptor-signatures/src/curve.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'

import {
  asciiBytes,
  bytesToInt,
  concat,
  equalBytes,
  intToBytes,
  Reader,
  snapshot,
  snapshotBounded,
  wipe,
} from './bytes.js'
import {
  commit,
  CURVE_ORDER,
  DLEQ_PROOF_BYTES,
  DLOG_PROOF_BYTES,
  G,
  HASH_BYTES,
  hedgedScalar,
  multiply,
  parsePoint,
  parseScalar,
  pointBytes,
  POINT_BYTES,
  proveDleq,
  proveDlog,
  requireDleqProof,
  requireDlogProof,
  requireOpening,
  SCALAR_BYTES,
  scalarBytes,
  type Point,
} from './group.js'
import {
  addressOfPoint,
  burnShare,
  internalShare,
  shareIsBurned,
  storageMac,
  type KeyShare,
  type KeyShareInternal,
} from './key-share.js'
import {
  decodeLock,
  isLockedSignature,
  requireLockOpening,
  resolveLock,
  type AdaptorLock,
  type LockOpening,
} from './lock.js'
import {
  addCiphertexts,
  CIPHERTEXT_BYTES,
  ciphertextBytes,
  decrypt,
  drawUnit,
  encrypt,
  paillierSecretKey,
  parseCiphertext,
  parseModulus,
  scaleCiphertext,
} from './paillier.js'
import { draw, drawBelow, type RandomBytes } from './rng.js'
import {
  fail,
  failure,
  failureCode,
  success,
  type ThresholdResult,
} from './result.js'
import {
  advance,
  type BodyBounds,
  type SessionCore,
  type Step,
} from './session.js'
import { computeTweak } from './tweak.js'
import {
  encodeMessage,
  PROTOCOL_ADAPTOR_SIGN,
  PROTOCOL_SIGN,
  SESSION_ID_BYTES,
  signBinding,
} from './wire.js'

const NONCE_BYTES = 32
const HALF_ORDER = CURVE_ORDER >> 1n
const ORDER_SQUARED = CURVE_ORDER * CURVE_ORDER
const ADAPTOR_SIGNATURE_BYTES = 162
const COMPACT_SIGNATURE_BYTES = 64
const EMPTY = new Uint8Array(0)

/** Plain: R || pok. */
const PLAIN_SHARE_BYTES = POINT_BYTES + DLOG_PROOF_BYTES
/** Adaptor: R || RT || dleq || A || AT. */
const ADAPTOR_SHARE_BYTES = 4 * POINT_BYTES + DLEQ_PROOF_BYTES

function exact(length: number): BodyBounds {
  return { minBody: length, maxBody: length }
}

/** Exact body size of each signing message, by protocol and round. */
export const SIGN_BODY_BOUNDS: Readonly<
  Record<number, Readonly<Record<number, BodyBounds>>>
> = {
  [PROTOCOL_SIGN]: {
    1: exact(HASH_BYTES),
    2: exact(PLAIN_SHARE_BYTES),
    3: exact(PLAIN_SHARE_BYTES + NONCE_BYTES),
    4: exact(CIPHERTEXT_BYTES),
    5: exact(COMPACT_SIGNATURE_BYTES + 1),
  },
  [PROTOCOL_ADAPTOR_SIGN]: {
    1: exact(HASH_BYTES),
    2: exact(ADAPTOR_SHARE_BYTES),
    3: exact(ADAPTOR_SHARE_BYTES + NONCE_BYTES),
    4: exact(CIPHERTEXT_BYTES + SCALAR_BYTES),
    5: exact(ADAPTOR_SIGNATURE_BYTES),
  },
}

/** Opaque signing state. Pass it to `signStep` exactly once. */
export interface SignSession {
  readonly __thresholdEcdsa: 'sign-session'
}

interface SignState extends SessionCore, SignSession {
  readonly initiator: boolean
  readonly rng: RandomBytes
  readonly keyShare: KeyShareInternal
  /** The (tweaked) public key the signature must verify under. */
  readonly publicKey: Uint8Array
  /** The public tweak scalar h, zero when the key is not tweaked. */
  readonly tweak: Uint8Array
  /** The caller's inputs, kept so exported state can be re-validated. */
  readonly sessionId: Uint8Array
  readonly tweakCommitment: Uint8Array
  readonly digest: Uint8Array
  /** Adaptor only: the lock point T and the lock's canonical encoding. */
  readonly adaptorPoint: Uint8Array | null
  readonly lock: Uint8Array
  /** Secret: this party's nonce share k_i. */
  readonly nonce: Uint8Array
  /** Secret, adaptor only: this party's proof nonce a_i. */
  readonly proofNonce: Uint8Array | null
  /** Initiator: opening of its round-1 commitment (payload || nonce). */
  readonly opening: Uint8Array | null
  /** Responder: the initiator's round-1 commitment. */
  readonly peerCommit: Uint8Array | null
  /** Initiator after round 2: the responder's verified round-2 payload. */
  readonly peerShare: Uint8Array | null
  /** Responder after round 3: R (plain) or R || R_a (adaptor). */
  readonly jointNonce: Uint8Array | null
}

export type SignResult =
  | {
      readonly kind: 'signature'
      /** 33-byte compressed public key the signature verifies under. */
      readonly publicKey: Uint8Array
      /** 20-byte EVM address of that key. */
      readonly address: Uint8Array
      /** `r (32) || s (32)`, low-s. */
      readonly signature: Uint8Array
      /** y-parity of the nonce point: the EIP-1559 `yParity`. */
      readonly recovery: 0 | 1
    }
  | {
      readonly kind: 'adaptor-signature'
      readonly publicKey: Uint8Array
      readonly address: Uint8Array
      /** 162-byte encrypted signature of `@frank/adaptor-signatures`. */
      readonly adaptorSignature: AdaptorSignatureBytes
    }

export type SignStepOutput = Step<SignSession, SignResult>
type InternalStep = Step<SignState, SignResult>

function wipeSign(state: SignState): void {
  wipe(state.nonce, state.proofNonce, state.opening)
}

function burnSign(state: SignState): void {
  burnShare(state.keyShare)
}

function need<T>(value: T | null): T {
  if (value === null) fail('internal-error')
  return value
}

function next(
  state: SignState,
  expectedRound: number,
  changes: Partial<SignState>,
): SignState {
  return { ...state, ...changes, status: 'active', expectedRound }
}

function finished(state: SignState): SignState {
  return { ...state, status: 'finished', expectedRound: 0 }
}

function send(
  state: SignState,
  round: number,
  ...parts: Uint8Array[]
): Uint8Array {
  return encodeMessage(state.protocol, round, state.session, concat(...parts))
}

function isAdaptor(state: SignState): boolean {
  return state.protocol === PROTOCOL_ADAPTOR_SIGN
}

/**
 * The ECDSA `r` of a nonce point. Rejects x >= n: such a point (probability
 * about 2^-128) needs recovery ids 2 and 3, which EVM transactions cannot
 * express. Nothing secret has been released at that stage; retry with a new
 * session.
 */
function nonceR(point: Point): bigint {
  const x = point.toAffine().x
  if (x === 0n || x >= CURVE_ORDER) fail('unusable-nonce')
  return x
}

function isOdd(point: Point): boolean {
  return (point.toAffine().y & 1n) === 1n
}

/** `left + right`, failing instead of returning the identity. */
function addPoints(left: Point, right: Point): Point {
  const sum = left.add(right)
  try {
    sum.assertValidity()
  } catch {
    return fail('invalid-proof')
  }
  return sum
}

/**
 * The discrete-log-equality challenge of the dlcspecs ECDSA adaptor
 * signature: `H_DLEQ(R_a || T || R || A_G || A_T) mod n`, byte-identical to
 * the challenge `@frank/adaptor-signatures` recomputes when it verifies.
 */
function adaptorDleqChallenge(
  nonceBase: Point,
  adaptorPoint: Point,
  nonceAdaptor: Point,
  commitBase: Point,
  commitAdaptor: Point,
): bigint {
  const challenge = hashToScalar(
    taggedHash(
      'DLEQ',
      pointBytes(nonceBase),
      pointBytes(adaptorPoint),
      pointBytes(nonceAdaptor),
      pointBytes(commitBase),
      pointBytes(commitAdaptor),
    ),
  )
  // The single-signer verifier rejects a zero challenge.
  if (challenge === 0n) fail('unusable-nonce')
  return challenge
}

// --- Nonce shares ----------------------------------------------------------

interface LocalShare {
  /** Round payload: plain `R || pok`, adaptor `R || RT || dleq || A || AT`. */
  readonly payload: Uint8Array
  readonly nonce: Uint8Array
  readonly proofNonce: Uint8Array | null
}

/**
 * Draws this party's nonce share (and, for adaptor signing, its proof nonce)
 * and builds the payload with its proof of knowledge. Protocol 3.2 steps 1
 * and 2.
 */
function makeLocalShare(state: {
  readonly protocol: number
  readonly rng: RandomBytes
  readonly session: Uint8Array
  readonly keyShare: KeyShareInternal
  readonly adaptorPoint: Uint8Array | null
}): LocalShare {
  const { rng, session, keyShare } = state
  const localId = keyShare.localId
  const k = hedgedScalar(rng, 'sign/k', session, keyShare.secretShare)
  const noncePoint = multiply(G, k)
  if (state.protocol === PROTOCOL_SIGN) {
    return {
      payload: concat(
        pointBytes(noncePoint),
        proveDlog(rng, session, localId, k, noncePoint),
      ),
      nonce: scalarBytes(k),
      proofNonce: null,
    }
  }
  const adaptorPoint = parsePoint(need(state.adaptorPoint))
  const nonceAdaptor = multiply(adaptorPoint, k)
  const a = hedgedScalar(rng, 'sign/a', session, keyShare.secretShare)
  return {
    payload: concat(
      pointBytes(noncePoint),
      pointBytes(nonceAdaptor),
      proveDleq(
        rng,
        session,
        localId,
        k,
        adaptorPoint,
        noncePoint,
        nonceAdaptor,
      ),
      pointBytes(multiply(G, a)),
      pointBytes(multiply(adaptorPoint, a)),
    ),
    nonce: scalarBytes(k),
    proofNonce: scalarBytes(a),
  }
}

interface PeerShare {
  readonly noncePoint: Point
  /** Adaptor only. */
  readonly nonceAdaptor: Point | null
  readonly commitBase: Point | null
  readonly commitAdaptor: Point | null
}

/** Parses the other party's payload and verifies its proof of knowledge. */
function acceptPeerShare(state: SignState, payload: Uint8Array): PeerShare {
  const reader = new Reader(payload)
  const peerId = state.keyShare.peerId
  if (!isAdaptor(state)) {
    const noncePoint = parsePoint(reader.take(POINT_BYTES))
    const proof = reader.take(DLOG_PROOF_BYTES)
    reader.finish()
    requireDlogProof(state.session, peerId, noncePoint, proof)
    return {
      noncePoint,
      nonceAdaptor: null,
      commitBase: null,
      commitAdaptor: null,
    }
  }
  const noncePoint = parsePoint(reader.take(POINT_BYTES))
  const nonceAdaptor = parsePoint(reader.take(POINT_BYTES))
  const proof = reader.take(DLEQ_PROOF_BYTES)
  const commitBase = parsePoint(reader.take(POINT_BYTES))
  const commitAdaptor = parsePoint(reader.take(POINT_BYTES))
  reader.finish()
  requireDleqProof(
    state.session,
    peerId,
    parsePoint(need(state.adaptorPoint)),
    noncePoint,
    nonceAdaptor,
    proof,
  )
  return { noncePoint, nonceAdaptor, commitBase, commitAdaptor }
}

// --- Round handlers --------------------------------------------------------

/** Responder, message 1: store the commitment, send own nonce share. */
function responderRound1(state: SignState, body: Uint8Array): InternalStep {
  const local = makeLocalShare(state)
  return {
    session: next(state, 3, {
      peerCommit: body,
      nonce: local.nonce,
      proofNonce: local.proofNonce,
    }),
    outgoing: send(state, 2, local.payload),
    result: null,
  }
}

/** Initiator, message 2: verify the responder's proof, then open. */
function initiatorRound2(state: SignState, body: Uint8Array): InternalStep {
  acceptPeerShare(state, body)
  return {
    session: next(state, 4, { peerShare: body }),
    outgoing: send(state, 3, need(state.opening)),
    result: null,
  }
}

/**
 * Responder, message 3: verify the opening and proof, then compute the
 * Paillier ciphertext of Protocol 3.2 step 4 (and, for adaptor signing, its
 * half of the joint proof response).
 */
function responderRound3(state: SignState, body: Uint8Array): InternalStep {
  const shareBytes = isAdaptor(state) ? ADAPTOR_SHARE_BYTES : PLAIN_SHARE_BYTES
  const reader = new Reader(body)
  const payload = reader.take(shareBytes)
  const openingNonce = reader.take(NONCE_BYTES)
  reader.finish()
  requireOpening(
    need(state.peerCommit),
    'sign-nonce',
    state.session,
    state.keyShare.peerId,
    payload,
    openingNonce,
  )
  const peer = acceptPeerShare(state, payload)
  const k = bytesToInt(state.nonce)
  const out: Uint8Array[] = []
  let jointNonce: Uint8Array
  let r: bigint
  let response: Uint8Array | null = null
  if (!isAdaptor(state)) {
    const joint = multiply(peer.noncePoint, k)
    r = nonceR(joint)
    jointNonce = pointBytes(joint)
  } else {
    const adaptorPoint = parsePoint(need(state.adaptorPoint))
    const a = bytesToInt(need(state.proofNonce))
    const nonceBase = multiply(peer.noncePoint, k)
    const nonceAdaptor = multiply(need(peer.nonceAdaptor), k)
    r = nonceR(nonceAdaptor)
    const challenge = adaptorDleqChallenge(
      nonceBase,
      adaptorPoint,
      nonceAdaptor,
      addPoints(need(peer.commitBase), multiply(peer.noncePoint, a)),
      addPoints(need(peer.commitAdaptor), multiply(need(peer.nonceAdaptor), a)),
    )
    // z2 = a2 + b*k2: a Schnorr response for k2 under the one-time nonce a2.
    const z = modAdd(a, modMul(challenge, k))
    if (z === 0n) fail('unusable-nonce')
    response = scalarBytes(z)
    jointNonce = concat(pointBytes(nonceAdaptor), pointBytes(nonceBase))
  }
  // Protocol 3.2 step 4. All three values below are secret.
  const share = state.keyShare
  const peerKey = parseModulus(share.modulus)
  const peerCiphertext = parseCiphertext(peerKey, share.ciphertext)
  const kInverse = modInv(k)
  const m = hashToScalar(state.digest)
  const tweak = bytesToInt(state.tweak)
  const messageTerm = modMul(kInverse, modAdd(m, modMul(r, tweak)))
  const shareTerm = modMul(kInverse, modMul(r, bytesToInt(share.secretShare)))
  const rho = drawBelow(state.rng, ORDER_SQUARED)
  const masked = encrypt(
    peerKey,
    rho * CURVE_ORDER + messageTerm,
    drawUnit(peerKey, state.rng),
  )
  const partial = addCiphertexts(
    peerKey,
    masked,
    scaleCiphertext(peerKey, peerCiphertext, shareTerm),
  )
  out.push(ciphertextBytes(partial))
  if (response !== null) out.push(response)
  // The nonce shares are spent: nothing later needs them.
  wipe(state.nonce, state.proofNonce)
  return {
    session: next(state, 5, { jointNonce }),
    outgoing: send(state, 4, ...out),
    result: null,
  }
}

function signatureResult(
  state: SignState,
  signature: Uint8Array,
  recovery: 0 | 1,
): SignResult {
  return {
    kind: 'signature',
    publicKey: state.publicKey.slice(),
    address: addressOfPoint(state.publicKey),
    signature,
    recovery,
  }
}

/**
 * Full acceptance check of a plain signature: canonical low-s `(r, s)`,
 * verifies under the public key with `@noble/curves`, and the recovery bit
 * recovers exactly that key.
 */
function isValidSignature(
  state: SignState,
  signature: Uint8Array,
  recovery: number,
): boolean {
  try {
    const parsed = secp256k1.Signature.fromCompact(signature)
    if (parsed.hasHighS()) return false
    if (
      !secp256k1.verify(parsed, state.digest, state.publicKey, {
        prehash: false,
        lowS: true,
      })
    ) {
      return false
    }
    const recovered = parsed
      .addRecoveryBit(recovery)
      .recoverPublicKey(state.digest)
      .toRawBytes(true)
    return equalBytes(recovered, state.publicKey)
  } catch {
    return false
  }
}

function initiatorPaillier(state: SignState) {
  return paillierSecretKey(
    bytesToInt(state.keyShare.primeP),
    bytesToInt(state.keyShare.primeQ),
  )
}

/**
 * Initiator, message 4 (plain): Protocol 3.2 step 5. Decrypt, unblind with
 * k1, verify. A failure after decryption burns the key share.
 */
function initiatorRound4Plain(
  state: SignState,
  body: Uint8Array,
): InternalStep {
  const paillier = initiatorPaillier(state)
  const partial = parseCiphertext(paillier, body)
  const peer = acceptPeerShare(state, need(state.peerShare))
  const k = bytesToInt(state.nonce)
  const joint = multiply(peer.noncePoint, k)
  const r = nonceR(joint)
  // Everything above depends only on public data and this party's nonce.
  // Everything below depends on the decryption, so any failure burns.
  const decrypted = mod(decrypt(paillier, partial))
  const unblinded = modMul(modInv(k), decrypted)
  if (unblinded === 0n) fail('invalid-signature', true)
  const high = unblinded > HALF_ORDER
  const s = high ? CURVE_ORDER - unblinded : unblinded
  const recovery = (isOdd(joint) !== high ? 1 : 0) as 0 | 1
  const signature = concat(scalarBytes(r), scalarBytes(s))
  if (!isValidSignature(state, signature, recovery)) {
    fail('invalid-signature', true)
  }
  wipeSign(state)
  return {
    session: finished(state),
    outgoing: send(state, 5, signature, Uint8Array.of(recovery)),
    result: signatureResult(state, signature, recovery),
  }
}

function adaptorResult(state: SignState, signature: Uint8Array): SignResult {
  return {
    kind: 'adaptor-signature',
    publicKey: state.publicKey.slice(),
    address: addressOfPoint(state.publicKey),
    adaptorSignature: signature as AdaptorSignatureBytes,
  }
}

/**
 * Runs the single-signer verifier of `@frank/adaptor-signatures` on a
 * canonically encoded pre-signature. The lock point was validated, with its
 * proofs, when the session started.
 */
function isValidAdaptorSignature(
  state: SignState,
  signature: Uint8Array,
): boolean {
  const parsed = adaptorSignatureFromBytes(signature)
  if (!parsed.ok) return false
  return isLockedSignature(
    parsePoint(state.publicKey),
    parsePoint(need(state.adaptorPoint)),
    state.digest,
    parsed.value,
  )
}

/**
 * Initiator, message 4 (adaptor): finish the joint proof, decrypt, unblind,
 * verify. The proof half is checked BEFORE decrypting, so that the only
 * thing that can fail after decryption is the encrypted value itself.
 */
function initiatorRound4Adaptor(
  state: SignState,
  body: Uint8Array,
): InternalStep {
  const reader = new Reader(body)
  const paillier = initiatorPaillier(state)
  const partial = parseCiphertext(paillier, reader.take(CIPHERTEXT_BYTES))
  const peerResponse = parseScalar(reader.take(SCALAR_BYTES))
  reader.finish()
  const peer = acceptPeerShare(state, need(state.peerShare))
  const peerNonceAdaptor = need(peer.nonceAdaptor)
  const peerCommitBase = need(peer.commitBase)
  const peerCommitAdaptor = need(peer.commitAdaptor)
  const adaptorPoint = parsePoint(need(state.adaptorPoint))
  const own = new Reader(need(state.opening))
  own.take(2 * POINT_BYTES + DLEQ_PROOF_BYTES)
  const ownCommitBase = parsePoint(own.take(POINT_BYTES))
  const ownCommitAdaptor = parsePoint(own.take(POINT_BYTES))
  const k = bytesToInt(state.nonce)
  const a = bytesToInt(need(state.proofNonce))
  const nonceBase = multiply(peer.noncePoint, k)
  const nonceAdaptor = multiply(peerNonceAdaptor, k)
  nonceR(nonceAdaptor)
  const commitBase = addPoints(ownCommitBase, multiply(peerCommitBase, k))
  const commitAdaptor = addPoints(
    ownCommitAdaptor,
    multiply(peerCommitAdaptor, k),
  )
  const challenge = adaptorDleqChallenge(
    nonceBase,
    adaptorPoint,
    nonceAdaptor,
    commitBase,
    commitAdaptor,
  )
  // The responder's z2 must be the response for (A2, A2T) and (R2, R2T)
  // under this challenge:  z2*G = A2 + b*R2  and  z2*T = A2T + b*R2T.
  const baseOk = multiply(G, peerResponse).equals(
    addPoints(peerCommitBase, multiply(peer.noncePoint, challenge)),
  )
  const adaptorOk = multiply(adaptorPoint, peerResponse).equals(
    addPoints(peerCommitAdaptor, multiply(peerNonceAdaptor, challenge)),
  )
  if (!baseOk || !adaptorOk) fail('invalid-proof')
  // c = a1 + k1*z2 completes the proof for the joint nonce k1*k2.
  const response = modAdd(a, modMul(k, peerResponse))
  if (response === 0n) fail('unusable-nonce')
  // Below this line every failure depends on the decryption and burns.
  const decrypted = mod(decrypt(paillier, partial))
  const encrypted = modMul(modInv(k), decrypted)
  if (encrypted === 0n) fail('invalid-signature', true)
  const signature = concat(
    pointBytes(nonceAdaptor),
    pointBytes(nonceBase),
    scalarBytes(encrypted),
    scalarBytes(challenge),
    scalarBytes(response),
  )
  // s_a^-1 * (m*G + r*X) must equal R_a; the single-signer verifier checks
  // this together with the proof (b, c).
  if (!isValidAdaptorSignature(state, signature)) {
    fail('invalid-signature', true)
  }
  wipeSign(state)
  return {
    session: finished(state),
    outgoing: send(state, 5, signature),
    result: adaptorResult(state, signature),
  }
}

/** Responder, message 5: verify what the initiator claims is the result. */
function responderRound5(state: SignState, body: Uint8Array): InternalStep {
  const jointNonce = need(state.jointNonce)
  let result: SignResult
  if (!isAdaptor(state)) {
    const signature = body.slice(0, COMPACT_SIGNATURE_BYTES)
    const recovery = body[COMPACT_SIGNATURE_BYTES]
    if (recovery !== 0 && recovery !== 1) fail('invalid-signature')
    const r = scalarBytes(nonceR(parsePoint(jointNonce)))
    if (!equalBytes(signature.subarray(0, SCALAR_BYTES), r)) {
      fail('invalid-signature')
    }
    if (!isValidSignature(state, signature, recovery)) fail('invalid-signature')
    result = signatureResult(state, signature, recovery)
  } else {
    // Must be for the joint nonce this party computed, not merely valid.
    if (!equalBytes(body.subarray(0, 2 * POINT_BYTES), jointNonce)) {
      fail('invalid-signature')
    }
    if (!isValidAdaptorSignature(state, body)) fail('invalid-signature')
    result = adaptorResult(state, body)
  }
  wipeSign(state)
  return {
    session: finished(state),
    outgoing: null,
    result,
  }
}

function handle(state: SignState, body: Uint8Array): InternalStep {
  if (shareIsBurned(state.keyShare)) fail('key-share-burned')
  switch (state.expectedRound) {
    case 1:
      return responderRound1(state, body)
    case 2:
      return initiatorRound2(state, body)
    case 3:
      return responderRound3(state, body)
    case 4:
      return isAdaptor(state)
        ? initiatorRound4Adaptor(state, body)
        : initiatorRound4Plain(state, body)
    case 5:
      return responderRound5(state, body)
    default:
      return fail('internal-error')
  }
}

// --- Public API ------------------------------------------------------------

export interface StartSignInput {
  /**
   * The key share. Its role decides this party's role in the session: the
   * key's initiator sends the first message, decrypts, and learns the result
   * first; the key's responder receives the result in the last message.
   */
  readonly keyShare: KeyShare
  /**
   * 32 bytes both parties agree on, never used before with this key. A
   * retry after any failure MUST use a new value.
   */
  readonly sessionId: Uint8Array
  /** The 32-byte digest to sign (for EVM: the transaction's unsigned hash). */
  readonly digest: Uint8Array
  /** Sign for `P + H(tag, P, commitment)*G` instead of the joint key `P`. */
  readonly tweakCommitment?: Uint8Array
  /**
   * Produce an adaptor pre-signature locked to this lock instead of a
   * signature. Locks are created by the key's responder (lock.ts). Both
   * parties pass the same public lock.
   */
  readonly lock?: AdaptorLock
  /**
   * RESPONDER ONLY, and required there whenever `lock` is given: the private
   * opening returned with the lock by `createPointLock` /
   * `createCommitmentLock`. The responder refuses to pre-sign under a lock it
   * cannot open itself. The initiator must not pass it.
   */
  readonly lockOpening?: LockOpening
  readonly randomBytes: RandomBytes
}

interface Resolved {
  readonly protocol: number
  readonly session: Uint8Array
  readonly publicKey: Uint8Array
  readonly tweak: Uint8Array
  readonly adaptorPoint: Uint8Array | null
  readonly lock: Uint8Array
}

/**
 * Derives everything a session's messages depend on from the key share and
 * the caller's inputs, verifying the lock's proofs. Used when a session
 * starts and again when one is imported, so imported state can never pair a
 * session binding with a different key, tweak, digest or lock.
 */
function resolve(
  keyShare: KeyShareInternal,
  sessionId: Uint8Array,
  digest: Uint8Array,
  tweakCommitment: Uint8Array,
  lock: AdaptorLock | null,
): Resolved {
  let publicKey: Uint8Array = keyShare.publicKey.slice()
  let tweak: Uint8Array = new Uint8Array(SCALAR_BYTES)
  if (tweakCommitment.length !== 0) {
    const tweaked = computeTweak(keyShare.publicKey, tweakCommitment)
    publicKey = pointBytes(tweaked.point)
    tweak = scalarBytes(tweaked.tweak)
  }
  const initiator = keyShare.role === 'initiator'
  const initiatorId = initiator ? keyShare.localId : keyShare.peerId
  const responderId = initiator ? keyShare.peerId : keyShare.localId
  const resolved =
    lock === null ? null : resolveLock(lock, keyShare.keyId, responderId)
  const protocol = resolved === null ? PROTOCOL_SIGN : PROTOCOL_ADAPTOR_SIGN
  const encoded = resolved === null ? EMPTY : resolved.encoded
  return {
    protocol,
    session: signBinding({
      protocol,
      sessionId,
      initiatorId,
      responderId,
      keyId: keyShare.keyId,
      publicKey,
      tweakCommitment,
      digest,
      lock: encoded,
    }),
    publicKey,
    tweak,
    adaptorPoint: resolved === null ? null : resolved.point,
    lock: encoded,
  }
}

/**
 * Starts a signing session. The initiator's output carries the first
 * message; the responder's carries none.
 */
export function startSign(
  input: StartSignInput,
): ThresholdResult<SignStepOutput> {
  try {
    const keyShare = internalShare(input.keyShare)
    const sessionId = snapshot(input.sessionId, SESSION_ID_BYTES)
    const digest = snapshot(input.digest, 32)
    const rawCommitment = input.tweakCommitment
    const rawLock = input.lock
    const rawOpening = input.lockOpening
    const rng = input.randomBytes
    if (shareIsBurned(keyShare)) return failure('key-share-burned')
    if (sessionId === null || digest === null) return failure('invalid-input')
    if (typeof rng !== 'function') return failure('rng-failed')
    let tweakCommitment: Uint8Array = EMPTY
    if (rawCommitment !== undefined) {
      const copied = snapshot(rawCommitment, 32)
      if (copied === null) return failure('invalid-input')
      tweakCommitment = copied
    }
    if (
      rawLock !== undefined &&
      (typeof rawLock !== 'object' || rawLock === null)
    ) {
      return failure('invalid-input')
    }
    const initiator = keyShare.role === 'initiator'
    // The initiator has no lock secrets; the responder must hold this one's.
    if (rawOpening !== undefined && (initiator || rawLock === undefined)) {
      return failure('invalid-input')
    }
    if (rawLock !== undefined && !initiator && rawOpening === undefined) {
      return failure('lock-not-owned')
    }
    const resolved = resolve(
      keyShare,
      sessionId,
      digest,
      tweakCommitment,
      rawLock ?? null,
    )
    if (rawLock !== undefined && rawOpening !== undefined) {
      requireLockOpening(rawLock, rawOpening)
    }
    const base: SignState = {
      __thresholdEcdsa: 'sign-session',
      status: 'active',
      protocol: resolved.protocol,
      expectedRound: initiator ? 2 : 1,
      session: resolved.session,
      initiator,
      rng,
      keyShare,
      publicKey: resolved.publicKey,
      tweak: resolved.tweak,
      sessionId,
      tweakCommitment,
      digest,
      adaptorPoint: resolved.adaptorPoint,
      lock: resolved.lock,
      nonce: new Uint8Array(SCALAR_BYTES),
      proofNonce: null,
      opening: null,
      peerCommit: null,
      peerShare: null,
      jointNonce: null,
    }
    if (!initiator) {
      return success({ session: base, outgoing: null, result: null })
    }
    // Protocol 3.2 step 1: P1 commits to its nonce share and proof.
    const local = makeLocalShare(base)
    const openingNonce = draw(rng, NONCE_BYTES)
    const state: SignState = {
      ...base,
      nonce: local.nonce,
      proofNonce: local.proofNonce,
      opening: concat(local.payload, openingNonce),
    }
    const outgoing = send(
      state,
      1,
      commit(
        'sign-nonce',
        resolved.session,
        keyShare.localId,
        local.payload,
        openingNonce,
      ),
    )
    return success({ session: state, outgoing, result: null })
  } catch (error) {
    return failure(failureCode(error))
  }
}

function asState(session: SignSession): SignState | null {
  const state = session as SignState
  if (
    typeof state !== 'object' ||
    state === null ||
    state.__thresholdEcdsa !== 'sign-session'
  ) {
    return null
  }
  return state
}

/**
 * Advances a signing session by one incoming message. On an error with
 * `sessionAborted`, start over with a NEW session id. On an error with
 * `keyShareBurned`, the key share is dead: record that durably and never
 * load an older copy of it.
 */
export function signStep(
  session: SignSession,
  message: Uint8Array,
): ThresholdResult<SignStepOutput> {
  const state = asState(session)
  if (state === null) return failure('invalid-input')
  return advance<SignState, SignResult>(
    state,
    message,
    current =>
      SIGN_BODY_BOUNDS[current.protocol]?.[current.expectedRound] ?? exact(0),
    handle,
    wipeSign,
    burnSign,
  )
}

/**
 * Aborts a signing session and wipes its nonces. Has no effect on a state
 * that was already advanced, finished or aborted: abort the latest state.
 */
export function abortSign(session: SignSession): void {
  const state = asState(session)
  // Only a live state is aborted. A state that was already advanced shares
  // its buffers with its successor, which must stay usable.
  if (state === null || state.status !== 'active') return
  wipeSign(state)
  state.status = 'aborted'
}

// --- Crash recovery --------------------------------------------------------
//
//   "FTES" || version || expectedRound || keyId || sessionId || digest
//   || field(tweakCommitment) || field(lock) || session || nonce
//   || field(proofNonce) || field(opening) || field(peerCommit)
//   || field(peerShare) || field(jointNonce) || mac (32)
//
// mac = HMAC-SHA256 under the key share's storage key (key-share.ts), over
// everything before it, verified before anything is parsed. Without it a
// writer who cannot read the state could re-pair a stored nonce with another
// digest and a recomputed binding. The MAC cannot detect an OLDER genuine
// state being put back; that remains a caller rule.
//
// Import recomputes the session binding, public key, tweak and lock point
// from the key share and the stored inputs and requires the stored binding
// to match, so the parts of an imported state are always mutually consistent.

const STATE_MAGIC = asciiBytes('FTES')
const STATE_VERSION = 3
const MAC_BYTES = 32
const MAX_STATE_BYTES = 1312

function field(value: Uint8Array | null): Uint8Array {
  const bytes = value ?? EMPTY
  return concat(intToBytes(BigInt(bytes.length), 2), bytes)
}

function readField(reader: Reader): Uint8Array | null {
  const length = Number(bytesToInt(reader.take(2)))
  return length === 0 ? null : reader.take(length)
}

/**
 * Serializes an in-flight signing session, INCLUDING its secret nonce. Only
 * the most recent state of a session may ever be stored or loaded; see the
 * README section "Persistence rules" before using this.
 */
export function exportSignSession(
  session: SignSession,
): ThresholdResult<Uint8Array> {
  const state = asState(session)
  if (state === null) return failure('invalid-input')
  if (state.status === 'finished') return failure('session-finished')
  if (state.status === 'aborted') return failure('session-aborted')
  if (state.status !== 'active') return failure('state-already-used')
  try {
    const data = concat(
      STATE_MAGIC,
      Uint8Array.of(STATE_VERSION, state.expectedRound),
      state.keyShare.keyId,
      state.sessionId,
      state.digest,
      field(state.tweakCommitment),
      field(state.lock),
      state.session,
      state.nonce,
      field(state.proofNonce),
      field(state.opening),
      field(state.peerCommit),
      field(state.peerShare),
      field(state.jointNonce),
    )
    return success(concat(data, storageMac(state.keyShare.secretShare, data)))
  } catch (error) {
    return failure(failureCode(error))
  }
}

export interface ImportSignSessionInput {
  /** Output of `exportSignSession`. */
  readonly state: Uint8Array
  /** The key share the session was started with. */
  readonly keyShare: KeyShare
  readonly randomBytes: RandomBytes
}

/** Rebuilds a signing session from `exportSignSession` output. */
export function importSignSession(
  input: ImportSignSessionInput,
): ThresholdResult<SignSession> {
  let copied: Uint8Array | null = null
  try {
    const keyShare = internalShare(input.keyShare)
    const rng = input.randomBytes
    copied = snapshotBounded(input.state, 0, MAX_STATE_BYTES)
    if (shareIsBurned(keyShare)) return failure('key-share-burned')
    if (typeof rng !== 'function') return failure('rng-failed')
    if (copied === null || copied.length < MAC_BYTES) {
      return failure('invalid-input')
    }
    // Integrity first: nothing is parsed until the MAC verifies under a key
    // derived from this key share's secret.
    const data = copied.subarray(0, copied.length - MAC_BYTES)
    const mac = storageMac(keyShare.secretShare, data)
    if (!equalBytes(mac, copied.subarray(copied.length - MAC_BYTES))) {
      fail('invalid-input')
    }
    const reader = new Reader(data)
    if (!equalBytes(reader.take(4), STATE_MAGIC)) fail('invalid-input')
    if (reader.byte() !== STATE_VERSION) fail('invalid-input')
    const expectedRound = reader.byte()
    if (!equalBytes(reader.take(HASH_BYTES), keyShare.keyId)) {
      fail('invalid-input')
    }
    const sessionId = reader.take(SESSION_ID_BYTES)
    const digest = reader.take(32)
    const tweakCommitment = readField(reader) ?? EMPTY
    const lock = readField(reader)
    const session = reader.take(HASH_BYTES)
    const nonce = reader.take(SCALAR_BYTES)
    const proofNonce = readField(reader)
    const opening = readField(reader)
    const peerCommit = readField(reader)
    const peerShare = readField(reader)
    const jointNonce = readField(reader)
    reader.finish()
    if (tweakCommitment.length !== 0 && tweakCommitment.length !== 32) {
      fail('invalid-input')
    }
    // Recompute everything derivable and require the stored binding to match.
    const resolved = resolve(
      keyShare,
      sessionId,
      digest,
      tweakCommitment,
      lock === null ? null : decodeLock(lock),
    )
    if (!equalBytes(resolved.session, session)) fail('invalid-input')
    const adaptor = resolved.protocol === PROTOCOL_ADAPTOR_SIGN
    const shareBytes = adaptor ? ADAPTOR_SHARE_BYTES : PLAIN_SHARE_BYTES
    const initiator = keyShare.role === 'initiator'
    // Each waiting point has exactly one shape of stored fields.
    const shape = [
      expectedRound,
      proofNonce === null ? 0 : proofNonce.length,
      opening === null ? 0 : opening.length,
      peerCommit === null ? 0 : peerCommit.length,
      peerShare === null ? 0 : peerShare.length,
      jointNonce === null ? 0 : jointNonce.length,
    ].join(',')
    const proofLength = adaptor ? SCALAR_BYTES : 0
    const jointLength = adaptor ? 2 * POINT_BYTES : POINT_BYTES
    const allowed = initiator
      ? [
          [2, proofLength, shareBytes + NONCE_BYTES, 0, 0, 0].join(','),
          [4, proofLength, shareBytes + NONCE_BYTES, 0, shareBytes, 0].join(
            ',',
          ),
        ]
      : [
          [1, 0, 0, 0, 0, 0].join(','),
          [3, proofLength, 0, HASH_BYTES, 0, 0].join(','),
          [5, proofLength, 0, HASH_BYTES, 0, jointLength].join(','),
        ]
    if (!allowed.includes(shape)) fail('invalid-input')
    if (jointNonce !== null) {
      parsePoint(jointNonce.subarray(0, POINT_BYTES))
      if (adaptor) parsePoint(jointNonce.subarray(POINT_BYTES))
    }
    const state: SignState = {
      __thresholdEcdsa: 'sign-session',
      status: 'active',
      protocol: resolved.protocol,
      expectedRound,
      session: resolved.session,
      initiator,
      rng,
      keyShare,
      publicKey: resolved.publicKey,
      tweak: resolved.tweak,
      sessionId,
      tweakCommitment,
      digest,
      adaptorPoint: resolved.adaptorPoint,
      lock: resolved.lock,
      nonce,
      proofNonce,
      opening,
      peerCommit,
      peerShare,
      jointNonce,
    }
    return success(state)
  } catch (error) {
    const code = failureCode(error)
    return failure(code === 'key-share-burned' ? code : 'invalid-input')
  } finally {
    copied?.fill(0)
  }
}
