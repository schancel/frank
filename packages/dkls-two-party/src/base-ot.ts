/**
 * Base oblivious transfer: Verified Simplest OT, exactly Protocol 7 of
 * Doerner, Kondi, Lee, shelat, "Secure Two-party Threshold ECDSA from ECDSA
 * Assumptions" (ePrint 2018/499, Appendix A), run as a batch of 128 random
 * OTs under one sender key (the remark after Protocol 7: one key may serve
 * many transfers when every hash carries a public nonce; here the instance
 * context and the index `j`).
 *
 *   sender                                        receiver (choice bits w_j)
 *   B = b*G, proof of knowledge of b      -->     verify proof
 *                                         <--     A_j = a_j*G + w_j*B
 *   pad0_j = H(b*A_j)                             pad_j = H(a_j*B)
 *   pad1_j = H(b*(A_j - B))
 *   xi_j = H2(H1(pad0_j)) ^ H2(H1(pad1_j)) -->
 *                                         <--     H2(H1(pad_j)) ^ w_j*xi_j
 *   require response = H2(H1(pad0_j))
 *   H1(pad0_j), H1(pad1_j)                -->     require own H1(pad_j) matches
 *                                                 and xi_j = H2(.) ^ H2(.)
 *
 * It realises random OT with selective failure by the sender: a sender that
 * sends a challenge built from a guess of w_j is caught at the last step when
 * the guess is wrong. The caller aborts key generation on any failure, which
 * discards the whole instance.
 *
 * The outputs are `seed_j^b = H(seed, pad_j^b)`, never the pads themselves,
 * so nothing revealed during verification is an output.
 *
 * These are pure functions over byte strings; the key-generation state
 * machine in `keygen.ts` decides which message carries what.
 */
import {
  bit,
  concat,
  equalBytes,
  intToBytes,
  Reader,
  xor,
} from './bytes.js'
import {
  DLOG_PROOF_BYTES,
  G,
  HASH_BYTES,
  hedgedScalar,
  multiply,
  parsePoint,
  POINT_BYTES,
  pointBytes,
  proveDlog,
  SCALAR_BYTES,
  requireDlogProof,
  scalarBytes,
  transcript,
} from './group.js'
import { kernel } from './kernel.js'
import { fail } from './result.js'
import { draw, type RandomBytes } from './rng.js'

/** Number of base OTs per direction: the computational security parameter. */
export const BASE_OT_COUNT = 128
export const CHOICE_BYTES = BASE_OT_COUNT / 8

export const ENCODED_CHOICES_BYTES = BASE_OT_COUNT * POINT_BYTES
export const PAD_VECTOR_BYTES = BASE_OT_COUNT * HASH_BYTES
export const OPENINGS_BYTES = 2 * PAD_VECTOR_BYTES
export const SENDER_KEY_BYTES = POINT_BYTES + DLOG_PROOF_BYTES

/**
 * Context of one base-OT instance: the full key-generation binding (both
 * salts) and who sends. Every hash and proof of the instance includes it.
 */
export function baseOtContext(
  binding: Uint8Array,
  senderId: Uint8Array,
  receiverId: Uint8Array,
): Uint8Array {
  return transcript('vsot/context', binding, senderId, receiverId)
}

function index(j: number): Uint8Array {
  return intToBytes(j, 4)
}

/** The pad of a shared Diffie-Hellman point, given as its 33-byte encoding. */
function pad(context: Uint8Array, j: number, shared: Uint8Array): Uint8Array {
  return transcript('vsot/pad', context, index(j), shared)
}

function h1(context: Uint8Array, j: number, value: Uint8Array): Uint8Array {
  return transcript('vsot/h1', context, index(j), value)
}

function h2(context: Uint8Array, j: number, value: Uint8Array): Uint8Array {
  return transcript('vsot/h2', context, index(j), value)
}

function seed(context: Uint8Array, j: number, value: Uint8Array): Uint8Array {
  return transcript('vsot/seed', context, index(j), value)
}

function slot(vector: Uint8Array, j: number, width = HASH_BYTES): Uint8Array {
  return vector.subarray(j * width, (j + 1) * width)
}

// --- Step 1-2: sender key ---------------------------------------------------

export interface SenderKey {
  /** SECRET b, 32 bytes. */
  readonly secret: Uint8Array
  /** `B (33) || proof of knowledge (65)`. */
  readonly message: Uint8Array
}

/**
 * The context of the sender key. The initiator must send its key before the
 * responder's salt exists, so the key proof is bound to `keyBinding` (the
 * session and the salts known when the key is sent) rather than to the full
 * instance context. The prover's identity is part of the proof, so a proof
 * cannot be presented by anyone else.
 */
export function senderKey(
  rng: RandomBytes,
  keyBinding: Uint8Array,
  senderId: Uint8Array,
): SenderKey {
  const b = hedgedScalar(rng, 'vsot/key', keyBinding, senderId)
  const B = multiply(G, b)
  const proof = proveDlog(rng, keyBinding, senderId, b, B)
  return { secret: scalarBytes(b), message: concat(pointBytes(B), proof) }
}

/** Verifies the proof of knowledge and returns B. */
export function requireSenderKey(
  keyBinding: Uint8Array,
  senderId: Uint8Array,
  message: Uint8Array,
): Uint8Array {
  if (message.length !== SENDER_KEY_BYTES) fail('malformed-message')
  const encoded = message.slice(0, POINT_BYTES)
  requireDlogProof(
    keyBinding,
    senderId,
    parsePoint(encoded),
    message.subarray(POINT_BYTES),
  )
  return encoded
}

// --- Step 3: receiver encodes its choices -----------------------------------

export interface ReceiverChoices {
  /** SECRET choice bits, 16 bytes, bit j least-significant-first. */
  readonly choices: Uint8Array
  /** SECRET pads `pad_j`, 128 x 32 bytes. */
  readonly pads: Uint8Array
  /** `A_j`, 128 x 33 bytes. */
  readonly message: Uint8Array
}

export function receiverChoose(
  rng: RandomBytes,
  context: Uint8Array,
  senderPublicKey: Uint8Array,
): ReceiverChoices {
  parsePoint(senderPublicKey)
  const choices = draw(rng, CHOICE_BYTES)
  const scalars = new Uint8Array(BASE_OT_COUNT * SCALAR_BYTES)
  for (let j = 0; j < BASE_OT_COUNT; j += 1) {
    scalars.set(
      scalarBytes(hedgedScalar(rng, 'vsot/choice', context, index(j), choices)),
      j * SCALAR_BYTES,
    )
  }
  let points: Uint8Array
  try {
    points = kernel().otReceiverPoints(
      senderPublicKey,
      choices,
      scalars,
      BASE_OT_COUNT,
    )
  } catch {
    // a_j = -b for some j: probability 2^-256 for an honest run.
    return fail('rng-failed')
  } finally {
    scalars.fill(0)
  }
  const message = new Uint8Array(ENCODED_CHOICES_BYTES)
  const pads = new Uint8Array(PAD_VECTOR_BYTES)
  for (let j = 0; j < BASE_OT_COUNT; j += 1) {
    const at = j * 2 * POINT_BYTES
    message.set(points.subarray(at, at + POINT_BYTES), j * POINT_BYTES)
    pads.set(
      pad(context, j, points.subarray(at + POINT_BYTES, at + 2 * POINT_BYTES)),
      j * HASH_BYTES,
    )
  }
  points.fill(0)
  return { choices, pads, message }
}

// --- Steps 4-5: sender pads and challenge -----------------------------------

export interface SenderPads {
  /** SECRET `pad0_j`, 128 x 32 bytes. */
  readonly pads0: Uint8Array
  /** SECRET `pad1_j`, 128 x 32 bytes. */
  readonly pads1: Uint8Array
  /** Challenges `xi_j`, 128 x 32 bytes. */
  readonly message: Uint8Array
}

export function senderPads(
  context: Uint8Array,
  secret: Uint8Array,
  senderPublicKey: Uint8Array,
  encodedChoices: Uint8Array,
): SenderPads {
  if (encodedChoices.length !== ENCODED_CHOICES_BYTES) {
    fail('malformed-message')
  }
  for (let j = 0; j < BASE_OT_COUNT; j += 1) {
    // A_j = B would make b*(A_j - B) the identity.
    if (equalBytes(slot(encodedChoices, j, POINT_BYTES), senderPublicKey)) {
      fail('invalid-point')
    }
  }
  // b*A_j and b*(A_j - B) = b*A_j - b*B for every j.
  const points = kernel().otSenderPoints(
    secret,
    senderPublicKey,
    encodedChoices,
    BASE_OT_COUNT,
  )
  const pads0 = new Uint8Array(PAD_VECTOR_BYTES)
  const pads1 = new Uint8Array(PAD_VECTOR_BYTES)
  const message = new Uint8Array(PAD_VECTOR_BYTES)
  for (let j = 0; j < BASE_OT_COUNT; j += 1) {
    const at = j * 2 * POINT_BYTES
    const pad0 = pad(context, j, points.subarray(at, at + POINT_BYTES))
    const pad1 = pad(
      context,
      j,
      points.subarray(at + POINT_BYTES, at + 2 * POINT_BYTES),
    )
    pads0.set(pad0, j * HASH_BYTES)
    pads1.set(pad1, j * HASH_BYTES)
    message.set(
      xor(
        h2(context, j, h1(context, j, pad0)),
        h2(context, j, h1(context, j, pad1)),
      ),
      j * HASH_BYTES,
    )
  }
  points.fill(0)
  return { pads0, pads1, message }
}

// --- Step 6: receiver response ----------------------------------------------

export function receiverRespond(
  context: Uint8Array,
  choices: Uint8Array,
  pads: Uint8Array,
  challenges: Uint8Array,
): Uint8Array {
  if (challenges.length !== PAD_VECTOR_BYTES) fail('malformed-message')
  const message = new Uint8Array(PAD_VECTOR_BYTES)
  const zero = new Uint8Array(HASH_BYTES)
  for (let j = 0; j < BASE_OT_COUNT; j += 1) {
    const own = h2(context, j, h1(context, j, slot(pads, j)))
    const mask = bit(choices, j) === 1 ? slot(challenges, j) : zero
    message.set(xor(own, mask), j * HASH_BYTES)
  }
  return message
}

// --- Step 7: sender verifies and opens --------------------------------------

/** Fails with `base-ot-check-failed` if any response is wrong. */
export function senderOpen(
  context: Uint8Array,
  pads0: Uint8Array,
  pads1: Uint8Array,
  responses: Uint8Array,
): Uint8Array {
  if (responses.length !== PAD_VECTOR_BYTES) fail('malformed-message')
  const message = new Uint8Array(OPENINGS_BYTES)
  let good = true
  for (let j = 0; j < BASE_OT_COUNT; j += 1) {
    const open0 = h1(context, j, slot(pads0, j))
    const open1 = h1(context, j, slot(pads1, j))
    // Every index is checked before anything is decided.
    good = equalBytes(slot(responses, j), h2(context, j, open0)) && good
    message.set(open0, 2 * j * HASH_BYTES)
    message.set(open1, (2 * j + 1) * HASH_BYTES)
  }
  if (!good) fail('base-ot-check-failed')
  return message
}

// --- Step 8: receiver verifies the opening ----------------------------------

/** Fails with `base-ot-check-failed` if the sender's challenge was not honest. */
export function receiverVerify(
  context: Uint8Array,
  choices: Uint8Array,
  pads: Uint8Array,
  challenges: Uint8Array,
  openings: Uint8Array,
): void {
  if (openings.length !== OPENINGS_BYTES) fail('malformed-message')
  const reader = new Reader(openings)
  let good = true
  for (let j = 0; j < BASE_OT_COUNT; j += 1) {
    const open0 = reader.take(HASH_BYTES)
    const open1 = reader.take(HASH_BYTES)
    const own = h1(context, j, slot(pads, j))
    const chosen = bit(choices, j) === 1 ? open1 : open0
    good = equalBytes(own, chosen) && good
    good =
      equalBytes(
        slot(challenges, j),
        xor(h2(context, j, open0), h2(context, j, open1)),
      ) && good
  }
  reader.finish()
  if (!good) fail('base-ot-check-failed')
}

// --- Outputs ----------------------------------------------------------------

/** The sender's 128 seed pairs: `seed0_0 || seed1_0 || seed0_1 || ...`. */
export function senderSeeds(
  context: Uint8Array,
  pads0: Uint8Array,
  pads1: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(OPENINGS_BYTES)
  for (let j = 0; j < BASE_OT_COUNT; j += 1) {
    out.set(seed(context, j, slot(pads0, j)), 2 * j * HASH_BYTES)
    out.set(seed(context, j, slot(pads1, j)), (2 * j + 1) * HASH_BYTES)
  }
  return out
}

/** The receiver's 128 seeds, one per choice bit. */
export function receiverSeeds(context: Uint8Array, pads: Uint8Array): Uint8Array {
  const out = new Uint8Array(PAD_VECTOR_BYTES)
  for (let j = 0; j < BASE_OT_COUNT; j += 1) {
    out.set(seed(context, j, slot(pads, j)), j * HASH_BYTES)
  }
  return out
}
