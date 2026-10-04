/**
 * Two-party key generation: Protocol 3.1 of Lindell, "Fast Secure Two-Party
 * ECDSA Signing" (CRYPTO 2017, ePrint 2017/552), in one direction with fixed
 * roles, exactly as in the paper. The initiator is P1, the responder P2.
 *
 * With n the curve order and l = floor(n / 3):
 *
 *  - P1 picks x1 in [l, 2l), P2 picks x2 in [1, n). Each proves knowledge of
 *    its share for Q_i = x_i * G; P1 commits to (Q1, proof) first so neither
 *    point can depend on the other (Protocol 3.1 steps 1-3).
 *  - P1 generates a Paillier key N, sends c_key = Enc_N(x1) and proves
 *      (a) gcd(N, phi(N)) = 1                      (modulus proof)
 *      (b) c_key encrypts a value in [0, n)        (range proof, Appendix A)
 *      (c) c_key encrypts the discrete log of Q1   (proof for L_PDL, Section 6)
 *    (Protocol 3.1 steps 3-5.)
 *
 * The joint public key is X = x1 * Q2 = x2 * Q1.
 *
 * Messages (I = initiator / P1, R = responder / P2), fixed-layout bodies:
 *
 *  1 I->R  salt_I || commit(Q_I, pok_I)
 *  2 R->I  salt_R || Q_R || pok_R || commit(e)
 *  3 I->R  Q_I || pok_I || nonce || N || modulusProof || c_key || rangeCommit
 *  4 R->I  e || nonce || c' || c''
 *  5 I->R  hat || rangeResponse
 *  6 R->I  a || b || nonce
 *  7 I->R  Qhat || nonce || confirm_I
 *  8 R->I  confirm_R
 *
 * e is the verifier's range challenge, committed before the prover's range
 * commitment is sent; (c', c'') is the verifier's L_PDL challenge and its
 * commitment to (a, b); hat is the prover's commitment to Qhat.
 *
 * Two additions to the paper, neither touching its proofs:
 *
 *  - Each party contributes 32 fresh random bytes (salt). Every proof and
 *    commitment after message 1 is bound to both salts, and a seeded share is
 *    derived from the party's own salt, so a peer that repeats a session id
 *    cannot make this party reuse a share, a Paillier key or a transcript.
 *  - Key confirmation (messages 7 and 8): each party sends a hash of the key
 *    id, which covers every public value exchanged. The initiator outputs its
 *    share only after the responder confirmed, the responder only after the
 *    initiator did, so both know the other finished with the same key.
 *
 * Order of release: R opens its L_PDL challenge (a, b) only after I's range
 * proof verified (Section 6 assumes a range-proven ciphertext), and I reveals
 * Qhat only after checking that the decrypted challenge equals a*x1 + b.
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
  transcript,
} from './group.js'
import {
  assembleKeyShare,
  computeKeyId,
  derivePaillierKey,
  deriveShare,
  exportKeyShareRecord,
  shareContextOf,
  type KeyShare,
} from './key-share.js'
import {
  addCiphertexts,
  CIPHERTEXT_BYTES,
  ciphertextBytes,
  decrypt,
  drawUnit,
  encrypt,
  encryptAsOwner,
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
} from './paillier.js'
import {
  MODULUS_PROOF_BYTES,
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
  keygenFrameBinding,
  keygenFullBinding,
  keygenInitiatorBinding,
  MAX_IDENTITY_BYTES,
  MIN_IDENTITY_BYTES,
  PROTOCOL_KEYGEN,
  SESSION_ID_BYTES,
} from './wire.js'

const NONCE_BYTES = 32
const SALT_BYTES = 32
const PDL_B_BYTES = 2 * SCALAR_BYTES
const ORDER_SQUARED = CURVE_ORDER * CURVE_ORDER
/** Stand-in encoding of the identity inside the Qhat commitment only. */
const IDENTITY_BYTES = new Uint8Array(POINT_BYTES)
const EMPTY = new Uint8Array(0)

const ROUND_1_BYTES = SALT_BYTES + HASH_BYTES
const ROUND_2_BYTES = SALT_BYTES + POINT_BYTES + DLOG_PROOF_BYTES + HASH_BYTES
const ROUND_3_BYTES =
  POINT_BYTES +
  DLOG_PROOF_BYTES +
  NONCE_BYTES +
  MODULUS_BYTES +
  MODULUS_PROOF_BYTES +
  CIPHERTEXT_BYTES +
  RANGE_COMMIT_BYTES
const ROUND_4_BYTES =
  RANGE_CHALLENGE_BYTES + NONCE_BYTES + CIPHERTEXT_BYTES + HASH_BYTES
const ROUND_5_FIXED_BYTES = HASH_BYTES
const ROUND_6_BYTES = SCALAR_BYTES + PDL_B_BYTES + NONCE_BYTES
const ROUND_7_BYTES = POINT_BYTES + NONCE_BYTES + HASH_BYTES
const ROUND_8_BYTES = HASH_BYTES
const CONFIRMATION_MESSAGE_BYTES = 4 + 2 + HASH_BYTES + ROUND_8_BYTES

function exact(length: number): BodyBounds {
  return { minBody: length, maxBody: length }
}

/** Exact or bounded body size of each key-generation message, by round. */
export const KEYGEN_BODY_BOUNDS: Readonly<Record<number, BodyBounds>> = {
  1: exact(ROUND_1_BYTES),
  2: exact(ROUND_2_BYTES),
  3: exact(ROUND_3_BYTES),
  4: exact(ROUND_4_BYTES),
  5: {
    minBody: ROUND_5_FIXED_BYTES + RANGE_RESPONSE_MIN_BYTES,
    maxBody: ROUND_5_FIXED_BYTES + RANGE_RESPONSE_MAX_BYTES,
  },
  6: exact(ROUND_6_BYTES),
  7: exact(ROUND_7_BYTES),
  8: exact(ROUND_8_BYTES),
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
  readonly localSalt: Uint8Array
  /** Context a seeded share is derived from; stored in the key share. */
  readonly shareContext: Uint8Array
  /** Full binding (both salts); null until message 2 is processed. */
  readonly binding: Uint8Array | null
  /** Secret: seed for deterministic derivation, or null. */
  readonly seed: Uint8Array | null
  /** Secret: this party's share. */
  readonly share: Uint8Array
  readonly localPoint: Uint8Array
  readonly peerPoint: Uint8Array | null
  readonly modulus: Uint8Array | null
  readonly ciphertext: Uint8Array | null
  // --- initiator (prover) ---
  /** Opening of the message-1 commitment: Q || pok || nonce. */
  readonly pointOpening: Uint8Array | null
  readonly peerChallengeCommit: Uint8Array | null
  /** Secret: Paillier primes, c_key randomness, range-proof secrets. */
  readonly primeP: Uint8Array | null
  readonly primeQ: Uint8Array | null
  readonly keyRandomness: Uint8Array | null
  readonly rangeSecret: Uint8Array | null
  /** Secret: decryption of the L_PDL challenge, and the opening of Qhat. */
  readonly pdlAlpha: Uint8Array | null
  readonly pdlHat: Uint8Array | null
  readonly pdlHatNonce: Uint8Array | null
  readonly peerPdlCommit: Uint8Array | null
  /** The finished share, held back until the responder confirms. */
  readonly pending: KeyShare | null
  // --- responder (verifier) ---
  readonly peerSalt: Uint8Array | null
  readonly peerPointCommit: Uint8Array | null
  /** Range challenge and its commitment nonce. */
  readonly challenge: Uint8Array | null
  readonly challengeNonce: Uint8Array | null
  readonly peerRangeCommit: Uint8Array | null
  /** Secret until opened: the L_PDL challenge (a, b). */
  readonly pdlA: Uint8Array | null
  readonly pdlB: Uint8Array | null
  readonly pdlNonce: Uint8Array | null
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
  return { ...state, pending: null, status: 'finished', expectedRound: 0 }
}

function send(
  state: KeygenState,
  round: number,
  ...parts: Uint8Array[]
): Uint8Array {
  return encodeMessage(PROTOCOL_KEYGEN, round, state.session, concat(...parts))
}

function confirmation(keyId: Uint8Array, party: Uint8Array): Uint8Array {
  return transcript('key-confirm', keyId, party)
}

/** Builds this party's key share from the session state. */
function buildShare(state: KeygenState): {
  share: KeyShare
  keyId: Uint8Array
} {
  const secret = bytesToInt(state.share)
  const peerPoint = need(state.peerPoint)
  const fields = {
    role: state.initiator ? ('initiator' as const) : ('responder' as const),
    keygenSession: need(state.binding).slice(),
    shareContext: state.shareContext.slice(),
    localId: state.localId.slice(),
    peerId: state.peerId.slice(),
    localPoint: state.localPoint.slice(),
    peerPoint: peerPoint.slice(),
    publicKey: pointBytes(multiply(parsePoint(peerPoint), secret)),
    modulus: need(state.modulus).slice(),
    ciphertext: need(state.ciphertext).slice(),
  }
  const keyId = computeKeyId(fields)
  const share = assembleKeyShare(
    { ...fields, keyId },
    state.share.slice(),
    state.initiator ? need(state.primeP).slice() : EMPTY.slice(),
    state.initiator ? need(state.primeQ).slice() : EMPTY.slice(),
  )
  return { share, keyId }
}

// --- Round handlers --------------------------------------------------------

type KeygenStep = Step<KeygenState, KeyShare>

/** Responder, message 1: Protocol 3.1 step 2. */
function responderRound1(state: KeygenState, body: Uint8Array): KeygenStep {
  const reader = new Reader(body)
  const peerSalt = reader.take(SALT_BYTES)
  const peerPointCommit = reader.take(HASH_BYTES)
  reader.finish()
  const binding = keygenFullBinding(state.session, peerSalt, state.localSalt)
  const proof = proveDlog(
    state.rng,
    binding,
    state.localId,
    bytesToInt(state.share),
    parsePoint(state.localPoint),
  )
  // Commit to the range challenge before the prover's commitment exists.
  const challenge = draw(state.rng, RANGE_CHALLENGE_BYTES)
  const challengeNonce = draw(state.rng, NONCE_BYTES)
  return {
    session: next(state, 3, {
      binding,
      peerSalt,
      peerPointCommit,
      challenge,
      challengeNonce,
    }),
    outgoing: send(
      state,
      2,
      state.localSalt,
      state.localPoint,
      proof,
      commit(
        'range-challenge',
        binding,
        state.localId,
        challenge,
        challengeNonce,
      ),
    ),
    result: null,
  }
}

/**
 * Initiator, message 2: Protocol 3.1 step 3. Verify P2's proof, open the
 * commitment, generate the Paillier key, send c_key with the modulus proof
 * and the first message of the range proof.
 */
function initiatorRound2(state: KeygenState, body: Uint8Array): KeygenStep {
  const reader = new Reader(body)
  const peerSalt = reader.take(SALT_BYTES)
  const peerPoint = reader.take(POINT_BYTES)
  const peerProof = reader.take(DLOG_PROOF_BYTES)
  const peerChallengeCommit = reader.take(HASH_BYTES)
  reader.finish()
  const binding = keygenFullBinding(state.session, state.localSalt, peerSalt)
  requireDlogProof(binding, state.peerId, parsePoint(peerPoint), peerProof)
  const key =
    state.seed === null
      ? generatePaillierKey(state.rng)
      : derivePaillierKey(state.seed, state.shareContext)
  const randomness = drawUnit(key, state.rng)
  const ciphertext = ciphertextBytes(
    encryptAsOwner(key, bytesToInt(state.share), randomness),
  )
  const modulus = modulusBytes(key)
  const proof = proveModulus(binding, state.localId, key)
  const range = rangeCommit(key, state.rng)
  return {
    session: next(state, 4, {
      binding,
      peerPoint,
      peerChallengeCommit,
      primeP: intToBytes(key.p, PRIME_BYTES),
      primeQ: intToBytes(key.q, PRIME_BYTES),
      keyRandomness: unitBytes(randomness),
      rangeSecret: range.secret,
      modulus,
      ciphertext,
    }),
    outgoing: send(
      state,
      3,
      need(state.pointOpening),
      modulus,
      proof,
      ciphertext,
      range.wire,
    ),
    result: null,
  }
}

/**
 * Responder, message 3: Protocol 3.1 step 4. Verify the opening and P1's
 * proof of knowledge, validate the modulus (length, parity, no small factor,
 * modulus proof) BEFORE parsing anything under it, then open the range
 * challenge and send the L_PDL challenge (Section 6):
 *   a <- [1, n), b <- [0, n^2), c' = a (*) c_key (+) Enc(b), c'' = commit(a, b).
 */
function responderRound3(state: KeygenState, body: Uint8Array): KeygenStep {
  const binding = need(state.binding)
  const reader = new Reader(body)
  const peerPoint = reader.take(POINT_BYTES)
  const peerProof = reader.take(DLOG_PROOF_BYTES)
  const pointNonce = reader.take(NONCE_BYTES)
  const modulus = reader.take(MODULUS_BYTES)
  const modulusProof = reader.take(MODULUS_PROOF_BYTES)
  const ciphertext = reader.take(CIPHERTEXT_BYTES)
  const peerRangeCommit = reader.take(RANGE_COMMIT_BYTES)
  reader.finish()
  const initiatorBinding = keygenInitiatorBinding(
    state.session,
    need(state.peerSalt),
  )
  requireOpening(
    need(state.peerPointCommit),
    'keygen-point',
    initiatorBinding,
    state.peerId,
    concat(peerPoint, peerProof),
    pointNonce,
  )
  requireDlogProof(
    initiatorBinding,
    state.peerId,
    parsePoint(peerPoint),
    peerProof,
  )
  const key = parseModulus(modulus)
  requireModulusProof(binding, state.peerId, key, modulusProof)
  const encryptedShare = parseCiphertext(key, ciphertext)
  const a = drawInRange(state.rng, 1n, CURVE_ORDER)
  const b = drawBelow(state.rng, ORDER_SQUARED)
  const masked = addCiphertexts(
    key,
    scaleCiphertext(key, encryptedShare, a),
    encrypt(key, b, drawUnit(key, state.rng)),
  )
  const pdlA = intToBytes(a, SCALAR_BYTES)
  const pdlB = intToBytes(b, PDL_B_BYTES)
  const pdlNonce = draw(state.rng, NONCE_BYTES)
  return {
    session: next(state, 5, {
      peerPoint,
      modulus,
      ciphertext,
      peerRangeCommit,
      pdlA,
      pdlB,
      pdlNonce,
    }),
    outgoing: send(
      state,
      4,
      need(state.challenge),
      need(state.challengeNonce),
      ciphertextBytes(masked),
      commit(
        'pdl-challenge',
        binding,
        state.localId,
        concat(pdlA, pdlB),
        pdlNonce,
      ),
    ),
    result: null,
  }
}

/**
 * Initiator, message 4: answer the range challenge (Appendix A applied to
 * c_key - Enc(l), witness x1 - l in [0, l)) and commit to Qhat = alpha * G
 * for alpha = Dec(c'). Nothing about alpha is revealed yet.
 */
function initiatorRound4(state: KeygenState, body: Uint8Array): KeygenStep {
  const binding = need(state.binding)
  const reader = new Reader(body)
  const challenge = reader.take(RANGE_CHALLENGE_BYTES)
  const challengeNonce = reader.take(NONCE_BYTES)
  const pdlCiphertext = reader.take(CIPHERTEXT_BYTES)
  const peerPdlCommit = reader.take(HASH_BYTES)
  reader.finish()
  requireOpening(
    need(state.peerChallengeCommit),
    'range-challenge',
    binding,
    state.peerId,
    challenge,
    challengeNonce,
  )
  const key = paillierSecretKey(
    bytesToInt(need(state.primeP)),
    bytesToInt(need(state.primeQ)),
  )
  const rangeResponse = rangeRespond(
    key,
    need(state.rangeSecret),
    bytesToInt(state.share) - SHARE_LOW,
    bytesToInt(need(state.keyRandomness)),
    challenge,
  )
  const alpha = decrypt(key, parseCiphertext(key, pdlCiphertext))
  const reduced = alpha % CURVE_ORDER
  // alpha = 0 mod n is not told apart here from any other value: the
  // commitment is sent either way and the check happens after (a, b) opens.
  const pdlHat =
    reduced === 0n ? IDENTITY_BYTES.slice() : pointBytes(multiply(G, reduced))
  const pdlHatNonce = draw(state.rng, NONCE_BYTES)
  return {
    session: next(state, 6, {
      pdlAlpha: intToBytes(alpha, MODULUS_BYTES),
      pdlHat,
      pdlHatNonce,
      peerPdlCommit,
    }),
    outgoing: send(
      state,
      5,
      commit('pdl-hat', binding, state.localId, pdlHat, pdlHatNonce),
      rangeResponse,
    ),
    result: null,
  }
}

/** Responder, message 5: verify the range proof, THEN open (a, b). */
function responderRound5(state: KeygenState, body: Uint8Array): KeygenStep {
  const reader = new Reader(body)
  const peerHatCommit = reader.take(HASH_BYTES)
  const rangeResponse = reader.take(reader.remaining())
  const key = parseModulus(need(state.modulus))
  const encryptedShare = parseCiphertext(key, need(state.ciphertext))
  requireRangeProof(
    key,
    subtractConstant(key, encryptedShare, SHARE_LOW),
    need(state.peerRangeCommit),
    need(state.challenge),
    rangeResponse,
  )
  return {
    session: next(state, 7, { peerHatCommit }),
    outgoing: send(
      state,
      6,
      need(state.pdlA),
      need(state.pdlB),
      need(state.pdlNonce),
    ),
    result: null,
  }
}

/**
 * Initiator, message 6: check the opening and that alpha = a*x1 + b over the
 * integers, then reveal Qhat. A mismatch means the responder sent a malformed
 * challenge; the initiator aborts WITHOUT revealing Qhat. That abort still
 * tells the responder one bit about x1, which is why a share is never reused
 * across key generations (the local salt guarantees it for seeded shares).
 */
function initiatorRound6(state: KeygenState, body: Uint8Array): KeygenStep {
  const binding = need(state.binding)
  const reader = new Reader(body)
  const aBytes = reader.take(SCALAR_BYTES)
  const bBytes = reader.take(PDL_B_BYTES)
  const nonce = reader.take(NONCE_BYTES)
  reader.finish()
  requireOpening(
    need(state.peerPdlCommit),
    'pdl-challenge',
    binding,
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
  const built = buildShare(state)
  const outgoing = send(
    state,
    7,
    hat,
    need(state.pdlHatNonce),
    confirmation(built.keyId, state.localId),
  )
  // Session secrets now live in the pending share only.
  wipeKeygen(state)
  return {
    session: next(state, 8, { pending: built.share }),
    outgoing,
    result: null,
  }
}

/**
 * Responder, message 7: accept iff Qhat = a*Q1 + b*G (Section 6), check the
 * initiator's key confirmation, output the share and confirm back.
 */
function responderRound7(state: KeygenState, body: Uint8Array): KeygenStep {
  const binding = need(state.binding)
  const reader = new Reader(body)
  const hat = reader.take(POINT_BYTES)
  const hatNonce = reader.take(NONCE_BYTES)
  const peerConfirmation = reader.take(HASH_BYTES)
  reader.finish()
  requireOpening(
    need(state.peerHatCommit),
    'pdl-hat',
    binding,
    state.peerId,
    hat,
    hatNonce,
  )
  const claimed = parsePoint(hat)
  const a = bytesToInt(need(state.pdlA))
  const b = bytesToInt(need(state.pdlB)) % CURVE_ORDER
  let expected = multiply(parsePoint(need(state.peerPoint)), a)
  if (b !== 0n) expected = expected.add(multiply(G, b))
  if (!claimed.equals(expected)) fail('invalid-proof')
  const built = buildShare(state)
  if (!equalBytes(peerConfirmation, confirmation(built.keyId, state.peerId))) {
    fail('invalid-commitment')
  }
  const outgoing = send(state, 8, confirmation(built.keyId, state.localId))
  wipeKeygen(state)
  return { session: finished(state), outgoing, result: built.share }
}

/** Initiator, message 8: the responder confirmed the same key. */
function initiatorRound8(state: KeygenState, body: Uint8Array): KeygenStep {
  const pending = need(state.pending)
  const keyId = (pending as unknown as { keyId: Uint8Array }).keyId
  if (!equalBytes(body, confirmation(keyId, state.peerId))) {
    fail('invalid-commitment')
  }
  return { session: finished(state), outgoing: null, result: pending }
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
    case 8:
      return initiatorRound8(state, body)
    default:
      return fail('internal-error')
  }
}

// --- Public API ------------------------------------------------------------

export interface StartKeygenInput {
  /**
   * Fixed for the life of the key. The initiator owns the Paillier key and
   * is the initiator of every signing session: it decrypts, learns each
   * result first, and is the party that can extract adaptor secrets. If two
   * users need both assignments they run two key generations and get two
   * independent joint keys.
   */
  readonly role: 'initiator' | 'responder'
  /** 32 bytes both parties agree on. Use a new value for every attempt. */
  readonly sessionId: Uint8Array
  /** This party's identity (1 to 64 bytes), for example its chat public key. */
  readonly localId: Uint8Array
  /** The other party's identity. Must differ from `localId`. */
  readonly peerId: Uint8Array
  /**
   * Optional 32-byte secret. When given, the share (and the initiator's
   * Paillier primes) are derived from it, the session, both identities and
   * this party's fresh salt, so `restoreKeyShare` can rebuild the share from
   * the seed and the public record. When omitted they come from `randomBytes`.
   */
  readonly secretSeed?: Uint8Array
  /** Caller's CSPRNG. Always needed, also with a seed (salt, proofs). */
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
    const frame = initiator
      ? keygenFrameBinding(sessionId, localId, peerId)
      : keygenFrameBinding(sessionId, peerId, localId)
    const localSalt = draw(rng, SALT_BYTES)
    const shareContext = shareContextOf(frame, localSalt, localId)
    // Protocol 3.1 step 1: x1 uniform in [l, 2l); step 2: x2 uniform in [1, n).
    const shareValue =
      seed !== null
        ? deriveShare(seed, shareContext, role)
        : initiator
        ? drawInRange(rng, SHARE_LOW, SHARE_HIGH)
        : drawInRange(rng, 1n, CURVE_ORDER)
    share = intToBytes(shareValue, SCALAR_BYTES)
    const localPoint = pointBytes(multiply(G, shareValue))
    const base: KeygenState = {
      __thresholdEcdsa: 'keygen-session',
      status: 'active',
      protocol: PROTOCOL_KEYGEN,
      expectedRound: initiator ? 2 : 1,
      session: frame,
      initiator,
      rng,
      localId,
      peerId,
      localSalt,
      shareContext,
      binding: null,
      seed,
      share,
      localPoint,
      peerPoint: null,
      modulus: null,
      ciphertext: null,
      pointOpening: null,
      peerChallengeCommit: null,
      primeP: null,
      primeQ: null,
      keyRandomness: null,
      rangeSecret: null,
      pdlAlpha: null,
      pdlHat: null,
      pdlHatNonce: null,
      peerPdlCommit: null,
      pending: null,
      peerSalt: null,
      peerPointCommit: null,
      challenge: null,
      challengeNonce: null,
      peerRangeCommit: null,
      pdlA: null,
      pdlB: null,
      pdlNonce: null,
      peerHatCommit: null,
    }
    if (!initiator) {
      return success({ session: base, outgoing: null, result: null })
    }
    // Protocol 3.1 step 1: P1 commits to its point and proof of knowledge.
    const initiatorBinding = keygenInitiatorBinding(frame, localSalt)
    const proof = proveDlog(
      rng,
      initiatorBinding,
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
      localSalt,
      commit('keygen-point', initiatorBinding, localId, payload, pointNonce),
    )
    return success({ session: state, outgoing, result: null })
  } catch (error) {
    wipe(seed, share)
    return failure(failureCode(error))
  }
}

function asState(session: KeygenSession): KeygenState | null {
  const state = session as KeygenState
  if (
    typeof state !== 'object' ||
    state === null ||
    state.__thresholdEcdsa !== 'keygen-session'
  ) {
    return null
  }
  return state
}

function discardPending(state: KeygenState): void {
  wipeKeygen(state)
  if (state.pending !== null) {
    const pending = state.pending as unknown as Record<string, Uint8Array>
    wipe(pending.secretShare, pending.primeP, pending.primeQ)
  }
}

/**
 * Advances key generation by one incoming message. See `Step` for the
 * output. On an error with `sessionAborted`, start over with a NEW session
 * id. On an error with `peerFault`, the other party sent something that
 * failed a check.
 */
export function keygenStep(
  session: KeygenSession,
  message: Uint8Array,
): ThresholdResult<KeygenStepOutput> {
  const state = asState(session)
  if (state === null) return failure('invalid-input')
  return advance<KeygenState, KeyShare>(
    state,
    message,
    current =>
      KEYGEN_BODY_BOUNDS[current.expectedRound] ?? { minBody: 0, maxBody: 0 },
    handle,
    discardPending,
    () => undefined,
  )
}

/**
 * Aborts a key-generation session and wipes its secrets. Has no effect on a
 * state that was already advanced, finished or aborted.
 */
export function abortKeygen(session: KeygenSession): void {
  const state = asState(session)
  // Only a live state is aborted. A state that was already advanced shares
  // its buffers with its successor (and a finished one with the returned
  // key share), which must stay usable.
  if (state === null || state.status !== 'active') return
  discardPending(state)
  state.status = 'aborted'
}

/**
 * For the INITIATOR while it waits for the responder's key confirmation
 * (message 8): the public record of the share it is holding back. The
 * responder may already have finished, so the initiator must be able to get
 * its share back if this session is lost before message 8 arrives. Store the
 * record; later `restoreKeyShare({ secretSeed, record })` rebuilds the share
 * (key generation must have used `secretSeed`), and `checkKeyConfirmation`
 * verifies a re-sent message 8 against it.
 */
export function exportPendingKeyShareRecord(
  session: KeygenSession,
): ThresholdResult<Uint8Array> {
  const state = asState(session)
  if (state === null) return failure('invalid-input')
  if (state.status !== 'active' || state.pending === null) {
    return failure('invalid-input')
  }
  return exportKeyShareRecord(state.pending)
}

/**
 * Checks the other party's key confirmation (key-generation message 8 for
 * the initiator, the confirmation inside message 7 is checked by the session
 * itself) against a key share obtained outside the session, for example one
 * restored from a pending record. `message` is the complete message 8.
 */
export function checkKeyConfirmation(
  share: KeyShare,
  message: Uint8Array,
): ThresholdResult<true> {
  try {
    const internal = share as unknown as {
      __thresholdEcdsa?: string
      keyId: Uint8Array
      peerId: Uint8Array
    }
    if (
      typeof internal !== 'object' ||
      internal === null ||
      internal.__thresholdEcdsa !== 'key-share'
    ) {
      return failure('invalid-input')
    }
    const copied = snapshot(message, CONFIRMATION_MESSAGE_BYTES)
    if (copied === null) return failure('malformed-message')
    const expected = encodeMessage(
      PROTOCOL_KEYGEN,
      8,
      copied.subarray(6, 6 + HASH_BYTES),
      confirmation(internal.keyId, internal.peerId),
    )
    // Compares magic, protocol, round and the confirmation; the frame
    // binding in between is not stored in a share and is covered by the key
    // id inside the confirmation.
    if (!equalBytes(copied, expected)) return failure('invalid-commitment')
    return success(true as const)
  } catch (error) {
    return failure(failureCode(error))
  }
}
