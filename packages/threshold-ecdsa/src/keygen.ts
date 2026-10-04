/**
 * Two-party key generation.
 *
 * This is Protocol 3.1 of Lindell, "Fast Secure Two-Party ECDSA Signing"
 * (CRYPTO 2017, ePrint 2017/552), run in BOTH directions at once: in the
 * paper only P1 owns a Paillier key and sends an encryption of its share; here
 * each party does that for the other, so that later either party can take the
 * decrypting role of a signing session. Each direction is the paper's
 * protocol unchanged.
 *
 * Per direction (prover P, verifier V), with n the curve order and
 * l = floor(n / 3):
 *
 *  - P picks its share x in [l, 2l) and proves knowledge of x for Q = x*G
 *    (Protocol 3.1 steps 1-3; the initiator commits to its Q first, exactly
 *    as P1 does in the paper, so neither party can choose its point as a
 *    function of the other's).
 *  - P generates a Paillier key N, sends c_key = Enc_N(x) and proves:
 *      (a) gcd(N, phi(N)) = 1                      (modulus proof)
 *      (b) c_key encrypts a value in [0, n)        (range proof, Appendix A)
 *      (c) c_key encrypts the discrete log of Q    (proof for L_PDL, Section 6)
 *    (Protocol 3.1 steps 3-5.)
 *
 * The joint public key is X = x_A * Q_B = x_B * Q_A.
 *
 * Messages (I = initiator, R = responder). Bodies are fixed-layout:
 *
 *  1 I->R  commit(Q_I, pok_I) || commit(e_I)
 *  2 R->I  Q_R || pok_R || commit(e_R) || bundle_R
 *  3 I->R  Q_I || pok_I || nonce || bundle_I || e_I || nonce || c'_I || c''_I
 *  4 R->I  hat_R || e_R || nonce || c'_R || c''_R || rangeResponse_R
 *  5 I->R  a_I || b_I || nonce || hat_I || rangeResponse_I
 *  6 R->I  Qhat_R || nonce || a_R || b_R || nonce
 *  7 I->R  Qhat_I || nonce
 *
 * where bundle = N || modulusProof || c_key || rangeCommitments, e is the
 * verifier's range challenge (committed before the prover's range
 * commitments are seen), (c', c'') is the verifier's L_PDL challenge and its
 * commitment to (a, b), and hat is the prover's commitment to Qhat.
 *
 * Order of release: a party opens its L_PDL challenge (a, b) only after the
 * other side's range proof verified (Section 6 assumes a range-proven
 * ciphertext), and reveals Qhat only after checking that the decrypted
 * challenge equals a*x + b.
 */
import {
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
  DLOG_PROOF_BYTES,
  G,
  HASH_BYTES,
  multiply,
  parsePoint,
  parseScalar,
  pointBytes,
  POINT_BYTES,
  proveDlog,
  requireDlogProof,
  requireOpening,
  SCALAR_BYTES,
  SHARE_HIGH,
  SHARE_LOW,
} from './group.js'
import {
  assembleKeyShare,
  computeKeyId,
  derivePaillierKey,
  deriveShare,
  type KeyShare,
} from './key-share.js'
import {
  addCiphertexts,
  CIPHERTEXT_BYTES,
  ciphertextBytes,
  decrypt,
  drawUnit,
  encrypt,
  generatePaillierKey,
  MODULUS_BYTES,
  modulusBytes,
  paillierSecretKey,
  parseCiphertext,
  parseModulus,
  PRIME_BYTES,
  scaleCiphertext,
  subtractConstant,
  unitBytes,
  type PaillierPublicKey,
  type PaillierSecretKey,
} from './paillier.js'
import {
  MODULUS_PROOF_BYTES,
  parseRangeCommitments,
  proveModulus,
  RANGE_CHALLENGE_BYTES,
  RANGE_COMMIT_BYTES,
  RANGE_RESPONSE_MAX_BYTES,
  RANGE_RESPONSE_MIN_BYTES,
  rangeCommit,
  rangeRespond,
  requireModulusProof,
  requireRangeProof,
} from './paillier-proofs.js'
import { draw, drawBelow, drawInRange, type RandomBytes } from './rng.js'
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
import {
  encodeMessage,
  keygenBinding,
  MAX_IDENTITY_BYTES,
  MIN_IDENTITY_BYTES,
  PROTOCOL_KEYGEN,
  SESSION_ID_BYTES,
} from './wire.js'

const NONCE_BYTES = 32
const PDL_B_BYTES = 2 * SCALAR_BYTES
const BUNDLE_BYTES =
  MODULUS_BYTES + MODULUS_PROOF_BYTES + CIPHERTEXT_BYTES + RANGE_COMMIT_BYTES
const ORDER_SQUARED = CURVE_ORDER * CURVE_ORDER
/** Stand-in encoding of the identity inside the Qhat commitment only. */
const IDENTITY_BYTES = new Uint8Array(POINT_BYTES)

const ROUND_1_BYTES = 2 * HASH_BYTES
const ROUND_2_BYTES = POINT_BYTES + DLOG_PROOF_BYTES + HASH_BYTES + BUNDLE_BYTES
const ROUND_3_BYTES =
  POINT_BYTES +
  DLOG_PROOF_BYTES +
  NONCE_BYTES +
  BUNDLE_BYTES +
  RANGE_CHALLENGE_BYTES +
  NONCE_BYTES +
  CIPHERTEXT_BYTES +
  HASH_BYTES
const ROUND_4_FIXED_BYTES =
  HASH_BYTES +
  RANGE_CHALLENGE_BYTES +
  NONCE_BYTES +
  CIPHERTEXT_BYTES +
  HASH_BYTES
const ROUND_5_FIXED_BYTES =
  SCALAR_BYTES + PDL_B_BYTES + NONCE_BYTES + HASH_BYTES
const ROUND_6_BYTES =
  POINT_BYTES + NONCE_BYTES + SCALAR_BYTES + PDL_B_BYTES + NONCE_BYTES
const ROUND_7_BYTES = POINT_BYTES + NONCE_BYTES

/** Exact or bounded body size of each key-generation message, by round. */
export const KEYGEN_BODY_BOUNDS: Readonly<Record<number, BodyBounds>> = {
  1: { minBody: ROUND_1_BYTES, maxBody: ROUND_1_BYTES },
  2: { minBody: ROUND_2_BYTES, maxBody: ROUND_2_BYTES },
  3: { minBody: ROUND_3_BYTES, maxBody: ROUND_3_BYTES },
  4: {
    minBody: ROUND_4_FIXED_BYTES + RANGE_RESPONSE_MIN_BYTES,
    maxBody: ROUND_4_FIXED_BYTES + RANGE_RESPONSE_MAX_BYTES,
  },
  5: {
    minBody: ROUND_5_FIXED_BYTES + RANGE_RESPONSE_MIN_BYTES,
    maxBody: ROUND_5_FIXED_BYTES + RANGE_RESPONSE_MAX_BYTES,
  },
  6: { minBody: ROUND_6_BYTES, maxBody: ROUND_6_BYTES },
  7: { minBody: ROUND_7_BYTES, maxBody: ROUND_7_BYTES },
}

/** Opaque key-generation state. Pass it to `keygenStep` exactly once. */
export interface KeygenSession {
  readonly __thresholdEcdsa: 'keygen-session'
}

interface KeygenState extends SessionCore, KeygenSession {
  readonly initiator: boolean
  readonly rng: RandomBytes
  readonly localId: Uint8Array
  readonly peerId: Uint8Array
  /** Secret: seed for deterministic share and Paillier derivation, or null. */
  readonly seed: Uint8Array | null
  /** Secret: this party's share x. */
  readonly share: Uint8Array
  readonly localPoint: Uint8Array
  /** Initiator only: opening of its commitment to (Q, pok). */
  readonly pointOpening: Uint8Array | null
  /** This party's range challenge (as verifier) and its commitment nonce. */
  readonly challenge: Uint8Array
  readonly challengeNonce: Uint8Array
  /** Responder only: the initiator's commitment to (Q, pok). */
  readonly peerPointCommit: Uint8Array | null
  readonly peerChallengeCommit: Uint8Array | null
  /** Secret: own Paillier primes, own c_key randomness, own range secrets. */
  readonly primeP: Uint8Array | null
  readonly primeQ: Uint8Array | null
  readonly keyRandomness: Uint8Array | null
  readonly rangeSecret: Uint8Array | null
  readonly localModulus: Uint8Array | null
  readonly localCiphertext: Uint8Array | null
  /** The other party's validated public material. */
  readonly peerPoint: Uint8Array | null
  readonly peerModulus: Uint8Array | null
  readonly peerCiphertext: Uint8Array | null
  readonly peerRangeCommit: Uint8Array | null
  /** Secret until opened: this party's L_PDL challenge (a, b) as verifier. */
  readonly pdlA: Uint8Array | null
  readonly pdlB: Uint8Array | null
  readonly pdlNonce: Uint8Array | null
  /** As L_PDL prover: the peer's commitment to its (a, b). */
  readonly peerPdlCommit: Uint8Array | null
  /** Secret: decryption alpha of the peer's challenge, and Qhat's opening. */
  readonly pdlAlpha: Uint8Array | null
  readonly pdlHat: Uint8Array | null
  readonly pdlHatNonce: Uint8Array | null
  /** As L_PDL verifier: the peer's commitment to its Qhat. */
  readonly peerHatCommit: Uint8Array | null
}

function wipeKeygen(state: KeygenState): void {
  wipe(
    state.seed,
    state.share,
    state.primeP,
    state.primeQ,
    state.keyRandomness,
    state.rangeSecret,
    state.pdlA,
    state.pdlB,
    state.pdlNonce,
    state.pdlAlpha,
    state.pdlHatNonce,
    state.challengeNonce,
    state.pointOpening,
  )
}

function need<T>(value: T | null): T {
  if (value === null) fail('internal-error')
  return value
}

function next(
  state: KeygenState,
  expectedRound: number,
  changes: Partial<KeygenState>,
): KeygenState {
  return { ...state, ...changes, status: 'active', expectedRound }
}

function finished(state: KeygenState): KeygenState {
  return { ...state, status: 'finished', expectedRound: 0 }
}

function send(
  state: KeygenState,
  round: number,
  ...parts: Uint8Array[]
): Uint8Array {
  return encodeMessage(PROTOCOL_KEYGEN, round, state.session, concat(...parts))
}

// --- The prover's Paillier bundle ------------------------------------------

interface LocalBundle {
  readonly wire: Uint8Array
  readonly changes: Partial<KeygenState>
}

function localPaillier(state: KeygenState): PaillierSecretKey {
  return paillierSecretKey(
    bytesToInt(need(state.primeP)),
    bytesToInt(need(state.primeQ)),
  )
}

/**
 * Protocol 3.1 step 3, P1's side: Paillier key, c_key = Enc(x), the modulus
 * proof, and the first message of the range proof.
 */
function buildBundle(state: KeygenState): LocalBundle {
  const key =
    state.seed === null
      ? generatePaillierKey(state.rng)
      : derivePaillierKey(state.seed, state.session, state.localId)
  const randomness = drawUnit(key, state.rng)
  const ciphertext = encrypt(key, bytesToInt(state.share), randomness)
  const proof = proveModulus(state.session, state.localId, key)
  const range = rangeCommit(key, state.rng)
  const modulus = modulusBytes(key)
  const encrypted = ciphertextBytes(ciphertext)
  return {
    wire: concat(modulus, proof, encrypted, range.wire),
    changes: {
      primeP: intToBytes(key.p, PRIME_BYTES),
      primeQ: intToBytes(key.q, PRIME_BYTES),
      keyRandomness: unitBytes(randomness),
      rangeSecret: range.secret,
      localModulus: modulus,
      localCiphertext: encrypted,
    },
  }
}

/**
 * Protocol 3.1 step 4, P2's side: validate the modulus (length, parity, no
 * small factor, modulus proof), then the ciphertext and the range
 * commitments. The modulus proof is checked before any ciphertext is parsed
 * under that modulus.
 */
function acceptBundle(
  state: KeygenState,
  reader: Reader,
): Partial<KeygenState> {
  const modulus = reader.take(MODULUS_BYTES)
  const proof = reader.take(MODULUS_PROOF_BYTES)
  const ciphertext = reader.take(CIPHERTEXT_BYTES)
  const rangeCommitments = reader.take(RANGE_COMMIT_BYTES)
  const key = parseModulus(modulus)
  requireModulusProof(state.session, state.peerId, key, proof)
  parseCiphertext(key, ciphertext)
  parseRangeCommitments(key, rangeCommitments)
  return {
    peerModulus: modulus,
    peerCiphertext: ciphertext,
    peerRangeCommit: rangeCommitments,
  }
}

function peerPaillier(state: KeygenState): PaillierPublicKey {
  return parseModulus(need(state.peerModulus))
}

// --- Range proof glue ------------------------------------------------------

/** Appendix A applied to c_key - Enc(l): the witness is x - l in [0, l). */
function respondRange(state: KeygenState, challenge: Uint8Array): Uint8Array {
  const key = localPaillier(state)
  return rangeRespond(
    key,
    need(state.rangeSecret),
    bytesToInt(state.share) - SHARE_LOW,
    bytesToInt(need(state.keyRandomness)),
    challenge,
  )
}

function verifyPeerRange(state: KeygenState, response: Uint8Array): void {
  const key = peerPaillier(state)
  const ciphertext = parseCiphertext(key, need(state.peerCiphertext))
  requireRangeProof(
    key,
    subtractConstant(key, ciphertext, SHARE_LOW),
    need(state.peerRangeCommit),
    state.challenge,
    response,
  )
}

function openPeerChallenge(
  state: KeygenState,
  challenge: Uint8Array,
  nonce: Uint8Array,
): void {
  requireOpening(
    need(state.peerChallengeCommit),
    'range-challenge',
    state.session,
    state.peerId,
    challenge,
    nonce,
  )
}

// --- L_PDL (Lindell 2017, Section 6) ---------------------------------------
//
// Verifier V holds (c_key, Q) of prover P.
//   V: a <- [1, n), b <- [0, n^2), c' = a (*) c_key (+) Enc(b; r),
//      c'' = commit(a, b); sends (c', c'').
//   P: alpha = Dec(c'), Qhat = alpha * G; sends commit(Qhat).
//   V: opens (a, b).
//   P: checks alpha = a * x + b over the integers, then opens Qhat.
//   V: accepts iff Qhat = a * Q + b * G.

interface PdlChallenge {
  readonly wire: Uint8Array
  readonly changes: Partial<KeygenState>
}

function pdlChallenge(state: KeygenState): PdlChallenge {
  const key = peerPaillier(state)
  const ciphertext = parseCiphertext(key, need(state.peerCiphertext))
  const a = drawInRange(state.rng, 1n, CURVE_ORDER)
  const b = drawBelow(state.rng, ORDER_SQUARED)
  const masked = addCiphertexts(
    key,
    scaleCiphertext(key, ciphertext, a),
    encrypt(key, b, drawUnit(key, state.rng)),
  )
  const pdlA = intToBytes(a, SCALAR_BYTES)
  const pdlB = intToBytes(b, PDL_B_BYTES)
  const pdlNonce = draw(state.rng, NONCE_BYTES)
  const commitment = commit(
    'pdl-challenge',
    state.session,
    state.localId,
    concat(pdlA, pdlB),
    pdlNonce,
  )
  return {
    wire: concat(ciphertextBytes(masked), commitment),
    changes: { pdlA, pdlB, pdlNonce },
  }
}

interface PdlHat {
  readonly commitment: Uint8Array
  readonly changes: Partial<KeygenState>
}

/** P decrypts c' and commits to Qhat. Nothing about alpha is revealed yet. */
function pdlCommitHat(
  state: KeygenState,
  challengeCiphertext: Uint8Array,
  peerPdlCommit: Uint8Array,
): PdlHat {
  const key = localPaillier(state)
  const alpha = decrypt(key, parseCiphertext(key, challengeCiphertext))
  const reduced = alpha % CURVE_ORDER
  // alpha = 0 mod n cannot be told apart here from any other value: the
  // commitment is sent either way and the check happens after V opens (a, b).
  const pdlHat =
    reduced === 0n ? IDENTITY_BYTES.slice() : pointBytes(multiply(G, reduced))
  const pdlHatNonce = draw(state.rng, NONCE_BYTES)
  return {
    commitment: commit(
      'pdl-hat',
      state.session,
      state.localId,
      pdlHat,
      pdlHatNonce,
    ),
    changes: {
      pdlAlpha: intToBytes(alpha, MODULUS_BYTES),
      pdlHat,
      pdlHatNonce,
      peerPdlCommit,
    },
  }
}

/**
 * P checks V's opening and that alpha = a*x + b. A mismatch means V sent a
 * malformed challenge; P aborts WITHOUT revealing Qhat. That abort still
 * tells V one bit about x, which is why an aborted key generation must never
 * be retried with the same share (README, "Rules for callers").
 */
function pdlCheckOpening(
  state: KeygenState,
  aBytes: Uint8Array,
  bBytes: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  requireOpening(
    need(state.peerPdlCommit),
    'pdl-challenge',
    state.session,
    state.peerId,
    concat(aBytes, bBytes),
    nonce,
  )
  const a = parseScalar(aBytes)
  const b = bytesToInt(bBytes)
  if (b >= ORDER_SQUARED) fail('out-of-range')
  const alpha = bytesToInt(need(state.pdlAlpha))
  if (alpha !== a * bytesToInt(state.share) + b) fail('invalid-proof')
  const hat = need(state.pdlHat)
  if (equalBytes(hat, IDENTITY_BYTES)) fail('invalid-proof')
  return concat(hat, need(state.pdlHatNonce))
}

/** V checks P's opening and that Qhat = a*Q + b*G. */
function pdlVerifyHat(
  state: KeygenState,
  hat: Uint8Array,
  nonce: Uint8Array,
): void {
  requireOpening(
    need(state.peerHatCommit),
    'pdl-hat',
    state.session,
    state.peerId,
    hat,
    nonce,
  )
  const claimed = parsePoint(hat)
  const a = bytesToInt(need(state.pdlA))
  const b = bytesToInt(need(state.pdlB)) % CURVE_ORDER
  let expected = multiply(parsePoint(need(state.peerPoint)), a)
  if (b !== 0n) expected = expected.add(multiply(G, b))
  if (!claimed.equals(expected)) fail('invalid-proof')
}

// --- Output ----------------------------------------------------------------

function finish(state: KeygenState): KeyShare {
  const share = bytesToInt(state.share)
  const peerPoint = need(state.peerPoint)
  const publicKey = pointBytes(multiply(parsePoint(peerPoint), share))
  const fields = {
    localIsInitiator: state.initiator,
    keygenSession: state.session.slice(),
    localId: state.localId.slice(),
    peerId: state.peerId.slice(),
    localPoint: state.localPoint.slice(),
    peerPoint: peerPoint.slice(),
    publicKey,
    localModulus: need(state.localModulus).slice(),
    localCiphertext: need(state.localCiphertext).slice(),
    peerModulus: need(state.peerModulus).slice(),
    peerCiphertext: need(state.peerCiphertext).slice(),
  }
  const keyShare = assembleKeyShare(
    { ...fields, keyId: computeKeyId(fields) },
    state.share.slice(),
    need(state.primeP).slice(),
    need(state.primeQ).slice(),
  )
  wipeKeygen(state)
  return keyShare
}

// --- Round handlers --------------------------------------------------------

type KeygenStep = Step<KeygenState, KeyShare>

/** Responder, message 1: store both commitments, answer with its own half. */
function responderRound1(state: KeygenState, body: Uint8Array): KeygenStep {
  const reader = new Reader(body)
  const peerPointCommit = reader.take(HASH_BYTES)
  const peerChallengeCommit = reader.take(HASH_BYTES)
  reader.finish()
  const proof = proveDlog(
    state.rng,
    state.session,
    state.localId,
    bytesToInt(state.share),
    parsePoint(state.localPoint),
  )
  const bundle = buildBundle(state)
  const challengeCommit = commit(
    'range-challenge',
    state.session,
    state.localId,
    state.challenge,
    state.challengeNonce,
  )
  return {
    session: next(state, 3, {
      ...bundle.changes,
      peerPointCommit,
      peerChallengeCommit,
    }),
    outgoing: send(
      state,
      2,
      state.localPoint,
      proof,
      challengeCommit,
      bundle.wire,
    ),
    result: null,
  }
}

/** Initiator, message 2: verify R's point and bundle, open own point. */
function initiatorRound2(state: KeygenState, body: Uint8Array): KeygenStep {
  const reader = new Reader(body)
  const peerPoint = reader.take(POINT_BYTES)
  const peerProof = reader.take(DLOG_PROOF_BYTES)
  const peerChallengeCommit = reader.take(HASH_BYTES)
  requireDlogProof(
    state.session,
    state.peerId,
    parsePoint(peerPoint),
    peerProof,
  )
  const accepted = acceptBundle(state, reader)
  reader.finish()
  const bundle = buildBundle(state)
  const withPeer = { ...state, ...accepted, peerPoint }
  const pdl = pdlChallenge(withPeer)
  return {
    session: next(state, 4, {
      ...accepted,
      ...bundle.changes,
      ...pdl.changes,
      peerPoint,
      peerChallengeCommit,
    }),
    outgoing: send(
      state,
      3,
      need(state.pointOpening),
      bundle.wire,
      state.challenge,
      state.challengeNonce,
      pdl.wire,
    ),
    result: null,
  }
}

/** Responder, message 3: verify I's opening, proofs and bundle. */
function responderRound3(state: KeygenState, body: Uint8Array): KeygenStep {
  const reader = new Reader(body)
  const peerPoint = reader.take(POINT_BYTES)
  const peerProof = reader.take(DLOG_PROOF_BYTES)
  const pointNonce = reader.take(NONCE_BYTES)
  requireOpening(
    need(state.peerPointCommit),
    'keygen-point',
    state.session,
    state.peerId,
    concat(peerPoint, peerProof),
    pointNonce,
  )
  requireDlogProof(
    state.session,
    state.peerId,
    parsePoint(peerPoint),
    peerProof,
  )
  const accepted = acceptBundle(state, reader)
  const peerChallenge = reader.take(RANGE_CHALLENGE_BYTES)
  const peerChallengeNonce = reader.take(NONCE_BYTES)
  const pdlCiphertext = reader.take(CIPHERTEXT_BYTES)
  const peerPdlCommit = reader.take(HASH_BYTES)
  reader.finish()
  openPeerChallenge(state, peerChallenge, peerChallengeNonce)
  const rangeResponse = respondRange(state, peerChallenge)
  const hat = pdlCommitHat(state, pdlCiphertext, peerPdlCommit)
  const withPeer = { ...state, ...accepted, peerPoint }
  const pdl = pdlChallenge(withPeer)
  return {
    session: next(state, 5, {
      ...accepted,
      ...hat.changes,
      ...pdl.changes,
      peerPoint,
    }),
    outgoing: send(
      state,
      4,
      hat.commitment,
      state.challenge,
      state.challengeNonce,
      pdl.wire,
      rangeResponse,
    ),
    result: null,
  }
}

/** Initiator, message 4: verify R's range proof, then open (a, b). */
function initiatorRound4(state: KeygenState, body: Uint8Array): KeygenStep {
  const reader = new Reader(body)
  const peerHatCommit = reader.take(HASH_BYTES)
  const peerChallenge = reader.take(RANGE_CHALLENGE_BYTES)
  const peerChallengeNonce = reader.take(NONCE_BYTES)
  const pdlCiphertext = reader.take(CIPHERTEXT_BYTES)
  const peerPdlCommit = reader.take(HASH_BYTES)
  const peerRangeResponse = reader.take(reader.remaining())
  openPeerChallenge(state, peerChallenge, peerChallengeNonce)
  verifyPeerRange(state, peerRangeResponse)
  const rangeResponse = respondRange(state, peerChallenge)
  const hat = pdlCommitHat(state, pdlCiphertext, peerPdlCommit)
  return {
    session: next(state, 6, { ...hat.changes, peerHatCommit }),
    outgoing: send(
      state,
      5,
      need(state.pdlA),
      need(state.pdlB),
      need(state.pdlNonce),
      hat.commitment,
      rangeResponse,
    ),
    result: null,
  }
}

/** Responder, message 5: verify I's range proof, answer I's L_PDL challenge. */
function responderRound5(state: KeygenState, body: Uint8Array): KeygenStep {
  const reader = new Reader(body)
  const peerA = reader.take(SCALAR_BYTES)
  const peerB = reader.take(PDL_B_BYTES)
  const peerNonce = reader.take(NONCE_BYTES)
  const peerHatCommit = reader.take(HASH_BYTES)
  const peerRangeResponse = reader.take(reader.remaining())
  verifyPeerRange(state, peerRangeResponse)
  const hatOpening = pdlCheckOpening(state, peerA, peerB, peerNonce)
  return {
    session: next(state, 7, { peerHatCommit }),
    outgoing: send(
      state,
      6,
      hatOpening,
      need(state.pdlA),
      need(state.pdlB),
      need(state.pdlNonce),
    ),
    result: null,
  }
}

/** Initiator, message 6: accept R's share, answer R's challenge, finish. */
function initiatorRound6(state: KeygenState, body: Uint8Array): KeygenStep {
  const reader = new Reader(body)
  const peerHat = reader.take(POINT_BYTES)
  const peerHatNonce = reader.take(NONCE_BYTES)
  const peerA = reader.take(SCALAR_BYTES)
  const peerB = reader.take(PDL_B_BYTES)
  const peerNonce = reader.take(NONCE_BYTES)
  reader.finish()
  pdlVerifyHat(state, peerHat, peerHatNonce)
  const hatOpening = pdlCheckOpening(state, peerA, peerB, peerNonce)
  const outgoing = send(state, 7, hatOpening)
  const result = finish(state)
  return {
    session: finished(state),
    outgoing,
    result,
  }
}

/** Responder, message 7: accept I's share and finish. */
function responderRound7(state: KeygenState, body: Uint8Array): KeygenStep {
  const reader = new Reader(body)
  const peerHat = reader.take(POINT_BYTES)
  const peerHatNonce = reader.take(NONCE_BYTES)
  reader.finish()
  pdlVerifyHat(state, peerHat, peerHatNonce)
  const result = finish(state)
  return {
    session: finished(state),
    outgoing: null,
    result,
  }
}

function handle(state: KeygenState, body: Uint8Array): KeygenStep {
  switch (state.expectedRound) {
    case 1:
      return responderRound1(state, body)
    case 2:
      return initiatorRound2(state, body)
    case 3:
      return responderRound3(state, body)
    case 4:
      return initiatorRound4(state, body)
    case 5:
      return responderRound5(state, body)
    case 6:
      return initiatorRound6(state, body)
    case 7:
      return responderRound7(state, body)
    default:
      return fail('internal-error')
  }
}

// --- Public API ------------------------------------------------------------

export interface StartKeygenInput {
  /** The initiator sends the first message. The parties must pick opposite roles. */
  readonly role: 'initiator' | 'responder'
  /**
   * 32 bytes both parties agree on and have never used for key generation
   * before. A retry after any abort MUST use a new value.
   */
  readonly sessionId: Uint8Array
  /** This party's identity (1 to 64 bytes), for example its chat public key. */
  readonly localId: Uint8Array
  /** The other party's identity. Must differ from `localId`. */
  readonly peerId: Uint8Array
  /**
   * Optional 32-byte secret. When given, the share and the Paillier primes
   * are derived from it, the session and `localId`, so `restoreKeyShare` can
   * rebuild the share later. When omitted they come from `randomBytes`.
   */
  readonly secretSeed?: Uint8Array
  /** Caller's CSPRNG. Always needed, also with a seed (proof randomness). */
  readonly randomBytes: RandomBytes
}

export type KeygenStepOutput = Step<KeygenSession, KeyShare>

/**
 * Starts key generation. The initiator's output carries the first message;
 * the responder's output carries none and waits for it.
 */
export function startKeygen(
  input: StartKeygenInput,
): ThresholdResult<KeygenStepOutput> {
  let seed: Uint8Array | null = null
  let share: Uint8Array | null = null
  try {
    const role = input.role
    const sessionId = snapshot(input.sessionId, SESSION_ID_BYTES)
    const localId = snapshotBounded(
      input.localId,
      MIN_IDENTITY_BYTES,
      MAX_IDENTITY_BYTES,
    )
    const peerId = snapshotBounded(
      input.peerId,
      MIN_IDENTITY_BYTES,
      MAX_IDENTITY_BYTES,
    )
    const rng = input.randomBytes
    const rawSeed = input.secretSeed
    if (rawSeed !== undefined) {
      seed = snapshot(rawSeed, 32)
      if (seed === null) return failure('invalid-input')
    }
    if (
      (role !== 'initiator' && role !== 'responder') ||
      sessionId === null ||
      localId === null ||
      peerId === null ||
      equalBytes(localId, peerId)
    ) {
      wipe(seed)
      return failure('invalid-input')
    }
    if (typeof rng !== 'function') {
      wipe(seed)
      return failure('rng-failed')
    }
    const initiator = role === 'initiator'
    const session = initiator
      ? keygenBinding(sessionId, localId, peerId)
      : keygenBinding(sessionId, peerId, localId)
    // Protocol 3.1 step 1: the share is uniform in [l, 2l).
    const shareValue =
      seed === null
        ? drawInRange(rng, SHARE_LOW, SHARE_HIGH)
        : deriveShare(seed, session, localId)
    share = intToBytes(shareValue, SCALAR_BYTES)
    const localPoint = pointBytes(multiply(G, shareValue))
    const challenge = draw(rng, RANGE_CHALLENGE_BYTES)
    const challengeNonce = draw(rng, NONCE_BYTES)
    const base: KeygenState = {
      __thresholdEcdsa: 'keygen-session',
      status: 'active',
      protocol: PROTOCOL_KEYGEN,
      expectedRound: initiator ? 2 : 1,
      session,
      initiator,
      rng,
      localId,
      peerId,
      seed,
      share,
      localPoint,
      pointOpening: null,
      challenge,
      challengeNonce,
      peerPointCommit: null,
      peerChallengeCommit: null,
      primeP: null,
      primeQ: null,
      keyRandomness: null,
      rangeSecret: null,
      localModulus: null,
      localCiphertext: null,
      peerPoint: null,
      peerModulus: null,
      peerCiphertext: null,
      peerRangeCommit: null,
      pdlA: null,
      pdlB: null,
      pdlNonce: null,
      peerPdlCommit: null,
      pdlAlpha: null,
      pdlHat: null,
      pdlHatNonce: null,
      peerHatCommit: null,
    }
    if (!initiator)
      return success({ session: base, outgoing: null, result: null })
    // Protocol 3.1 step 1: P1 commits to its point and proof of knowledge.
    const proof = proveDlog(
      rng,
      session,
      localId,
      shareValue,
      parsePoint(localPoint),
    )
    const pointNonce = draw(rng, NONCE_BYTES)
    const payload = concat(localPoint, proof)
    const state: KeygenState = {
      ...base,
      pointOpening: concat(payload, pointNonce),
    }
    const outgoing = send(
      state,
      1,
      commit('keygen-point', session, localId, payload, pointNonce),
      commit('range-challenge', session, localId, challenge, challengeNonce),
    )
    return success({ session: state, outgoing, result: null })
  } catch (error) {
    wipe(seed, share)
    return failure(failureCode(error))
  }
}

/**
 * Advances key generation by one incoming message. See `Step` for the
 * output. On an error with `sessionAborted`, start over with a NEW session
 * id; never retry the same one.
 */
export function keygenStep(
  session: KeygenSession,
  message: Uint8Array,
): ThresholdResult<KeygenStepOutput> {
  const state = session as KeygenState
  if (
    typeof state !== 'object' ||
    state === null ||
    state.__thresholdEcdsa !== 'keygen-session'
  ) {
    return failure('invalid-input')
  }
  return advance<KeygenState, KeyShare>(
    state,
    message,
    current =>
      KEYGEN_BODY_BOUNDS[current.expectedRound] ?? { minBody: 0, maxBody: 0 },
    handle,
    wipeKeygen,
    () => undefined,
  )
}

/** Aborts a key-generation session and wipes its secrets. */
export function abortKeygen(session: KeygenSession): void {
  const state = session as KeygenState
  if (
    typeof state !== 'object' ||
    state === null ||
    state.__thresholdEcdsa !== 'keygen-session' ||
    state.status === 'finished'
  ) {
    return
  }
  wipeKeygen(state)
  state.status = 'aborted'
}
