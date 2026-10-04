/**
 * Key generation: additive key shares plus the pairwise base-OT setup, in
 * six alternating messages. I = initiator, R = responder.
 *
 *   1  I -> R   salt_I, commitment to X_I, VSOT key B_I with proof
 *   2  R -> I   salt_R, X_R with proof, VSOT key B_R with proof,
 *               encoded choices for I's instance
 *   3  I -> R   X_I opened with proof, encoded choices for R's instance,
 *               challenges of I's instance
 *   4  R -> I   responses for I's instance, challenges of R's instance
 *   5  I -> R   pad openings of I's instance, responses for R's instance
 *   6  R -> I   pad openings of R's instance
 *
 * Key shares. X = X_I + X_R with a proof of knowledge of each share; the
 * initiator commits to X_I before seeing X_R, so neither party can choose
 * its share as a function of the other's. This is the two-party case of the
 * committed-proof key generation DKLs18 (Functionality 3.2 / 3.3 of the 2023
 * revision) assumes and Asharov's signing proof requires (shares extractable
 * at key generation). Extraction is by rewinding (Fiat-Shamir Schnorr).
 *
 * "I's instance" is the base OT in which I is the sender: I ends with both
 * seeds of every OT (so I is the OT-extension RECEIVER in signing) and R with
 * choice bits Delta_R and one seed each (the extension SENDER).
 *
 * THE PACKING OF ROUNDS is the `BODY_BYTES` table and the six handlers
 * below; nothing else in the package knows which message carries what.
 *
 * Any failure after the frame check aborts the key generation. No key exists
 * yet, so nothing is burned; everything a cheating peer could have learned
 * (for example a guessed base-OT choice bit) dies with the session.
 */
import { concat, equalBytes, Reader, snapshot, snapshotBounded } from './bytes.js'
import {
  baseOtContext,
  ENCODED_CHOICES_BYTES,
  OPENINGS_BYTES,
  PAD_VECTOR_BYTES,
  receiverChoose,
  receiverRespond,
  receiverSeeds,
  receiverVerify,
  requireSenderKey,
  SENDER_KEY_BYTES,
  senderKey,
  senderOpen,
  senderPads,
  senderSeeds,
} from './base-ot.js'
import {
  commit,
  DLOG_PROOF_BYTES,
  G,
  HASH_BYTES,
  hedgedScalar,
  multiply,
  parsePoint,
  POINT_BYTES,
  pointBytes,
  proveDlog,
  requireDlogProof,
  requireOpening,
  scalarBytes,
  transcript,
} from './group.js'
import { assembleShare, wrapShare, type KeyShare } from './key-share.js'
import {
  fail,
  failure,
  failureCode,
  success,
  type DklsResult,
} from './result.js'
import { draw, type RandomBytes } from './rng.js'
import {
  advance,
  need,
  wipeVars,
  type Hooks,
  type SessionCore,
  type Step,
  type Vars,
} from './session.js'
import {
  encodeMessage,
  fullBinding,
  initiatorBinding,
  keygenFrame,
  MAX_IDENTITY_BYTES,
  MIN_IDENTITY_BYTES,
  PROTOCOL_KEYGEN,
  SALT_BYTES,
  SESSION_ID_BYTES,
  type RoleName,
} from './wire.js'

export interface KeygenSession extends SessionCore {
  readonly role: RoleName
  readonly localId: Uint8Array
  readonly peerId: Uint8Array
  readonly rng: RandomBytes
}

export type KeygenStepOutput = Step<KeygenSession, KeyShare>

export interface StartKeygenInput {
  readonly role: RoleName
  /** 32 bytes, agreed by both parties, new for every run. */
  readonly sessionId: Uint8Array
  /** 1..64 bytes each, different. */
  readonly localId: Uint8Array
  readonly peerId: Uint8Array
  readonly randomBytes: RandomBytes
}

/** Body length of each message. Every message has exactly one valid length. */
const BODY_BYTES: Readonly<Record<number, number>> = {
  1: SALT_BYTES + HASH_BYTES + SENDER_KEY_BYTES,
  2:
    SALT_BYTES +
    POINT_BYTES +
    DLOG_PROOF_BYTES +
    SENDER_KEY_BYTES +
    ENCODED_CHOICES_BYTES,
  3:
    POINT_BYTES +
    HASH_BYTES +
    DLOG_PROOF_BYTES +
    ENCODED_CHOICES_BYTES +
    PAD_VECTOR_BYTES,
  4: 2 * PAD_VECTOR_BYTES,
  5: OPENINGS_BYTES + PAD_VECTOR_BYTES,
  6: OPENINGS_BYTES,
}

export const KEYGEN_MESSAGES = 6

const hooks: Hooks<KeygenSession> = {
  bodyBytes: state => BODY_BYTES[state.expectedRound] ?? 0,
  blocked: () => null,
  onFailure: () => false,
}

function next(
  state: KeygenSession,
  expectedRound: number,
  vars: Vars,
): KeygenSession {
  return { ...state, status: 'active', expectedRound, vars }
}

function finished(state: KeygenSession): KeygenSession {
  return { ...state, status: 'finished', expectedRound: 0, vars: {} }
}

function send(state: KeygenSession, round: number, body: Uint8Array): Uint8Array {
  if (body.length !== BODY_BYTES[round]) fail('internal-error')
  return encodeMessage(PROTOCOL_KEYGEN, round, state.frame, body)
}

function ids(state: KeygenSession): {
  initiator: Uint8Array
  responder: Uint8Array
} {
  return state.role === 'initiator'
    ? { initiator: state.localId, responder: state.peerId }
    : { initiator: state.peerId, responder: state.localId }
}

/** A fresh additive key share and its public point. */
function drawShare(
  state: KeygenSession,
  binding: Uint8Array,
): { secret: bigint; point: Uint8Array } {
  const secret = hedgedScalar(state.rng, 'keygen/share', binding, state.localId)
  return { secret, point: pointBytes(multiply(G, secret)) }
}

function keyId(
  binding: Uint8Array,
  shareI: Uint8Array,
  shareR: Uint8Array,
  otKeyI: Uint8Array,
  otKeyR: Uint8Array,
  choicesForI: Uint8Array,
  choicesForR: Uint8Array,
): Uint8Array {
  return transcript(
    'key-id',
    binding,
    shareI,
    shareR,
    otKeyI,
    otKeyR,
    transcript('key-id/choices', choicesForI),
    transcript('key-id/choices', choicesForR),
  )
}

export function startKeygen(
  input: StartKeygenInput,
): DklsResult<KeygenStepOutput> {
  if (input === null || typeof input !== 'object') {
    return failure('invalid-input')
  }
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
  if (
    (role !== 'initiator' && role !== 'responder') ||
    sessionId === null ||
    localId === null ||
    peerId === null ||
    equalBytes(localId, peerId)
  ) {
    return failure('invalid-input')
  }
  const rng = input.randomBytes
  if (typeof rng !== 'function') return failure('rng-failed')
  const frame =
    role === 'initiator'
      ? keygenFrame(sessionId, localId, peerId)
      : keygenFrame(sessionId, peerId, localId)
  const base: KeygenSession = {
    status: 'active',
    protocol: PROTOCOL_KEYGEN,
    expectedRound: role === 'initiator' ? 2 : 1,
    frame,
    vars: {},
    role,
    localId,
    peerId,
    rng,
  }
  if (role === 'responder') {
    return success({ session: base, outgoing: null, result: null })
  }
  const vars: Vars = {}
  try {
    // Message 1.
    const salt = draw(rng, SALT_BYTES)
    const first = initiatorBinding(frame, salt)
    const share = drawShare(base, first)
    const nonce = draw(rng, HASH_BYTES)
    const otKey = senderKey(rng, first, localId)
    vars.saltI = salt
    vars.share = scalarBytes(share.secret)
    vars.sharePoint = share.point
    vars.commitNonce = nonce
    vars.otSecret = otKey.secret
    vars.otKeyI = otKey.message.slice(0, POINT_BYTES)
    const body = concat(
      salt,
      commit('keygen-share', first, localId, share.point, nonce),
      otKey.message,
    )
    return success({
      session: { ...base, vars },
      outgoing: send(base, 1, body),
      result: null,
    })
  } catch (error) {
    wipeVars(vars)
    return failure(failureCode(error))
  }
}

/** R handles message 1 and sends message 2. */
function responder1(state: KeygenSession, body: Uint8Array): KeygenStepOutput {
  const reader = new Reader(body)
  const saltI = reader.take(SALT_BYTES)
  const commitment = reader.take(HASH_BYTES)
  const otKeyMessage = reader.take(SENDER_KEY_BYTES)
  reader.finish()
  const { initiator, responder } = ids(state)
  const first = initiatorBinding(state.frame, saltI)
  const otKeyI = requireSenderKey(first, initiator, otKeyMessage)

  const saltR = draw(state.rng, SALT_BYTES)
  const binding = fullBinding(state.frame, saltI, saltR)
  const share = drawShare(state, binding)
  const shareProof = proveDlog(
    state.rng,
    binding,
    responder,
    share.secret,
    parsePoint(share.point),
  )
  const otKey = senderKey(state.rng, binding, responder)
  // R is the receiver of I's instance.
  const chosen = receiverChoose(
    state.rng,
    baseOtContext(binding, initiator, responder),
    otKeyI,
  )
  const vars: Vars = {
    binding,
    first,
    commitment,
    otKeyI,
    otKeyR: otKey.message.slice(0, POINT_BYTES),
    otSecret: otKey.secret,
    share: scalarBytes(share.secret),
    sharePoint: share.point,
    choices: chosen.choices,
    pads: chosen.pads,
    choicesForI: chosen.message,
  }
  return {
    session: next(state, 3, vars),
    outgoing: send(
      state,
      2,
      concat(saltR, share.point, shareProof, otKey.message, chosen.message),
    ),
    result: null,
  }
}

/** I handles message 2 and sends message 3. */
function initiator2(state: KeygenSession, body: Uint8Array): KeygenStepOutput {
  const reader = new Reader(body)
  const saltR = reader.take(SALT_BYTES)
  const peerPoint = reader.take(POINT_BYTES)
  const peerProof = reader.take(DLOG_PROOF_BYTES)
  const otKeyMessage = reader.take(SENDER_KEY_BYTES)
  const choicesForI = reader.take(ENCODED_CHOICES_BYTES)
  reader.finish()
  const { initiator, responder } = ids(state)
  const old = state.vars
  const binding = fullBinding(state.frame, need(old, 'saltI'), saltR)
  requireDlogProof(binding, responder, parsePoint(peerPoint), peerProof)
  const otKeyR = requireSenderKey(binding, responder, otKeyMessage)

  // I is the sender of its own instance ...
  const otKeyI = need(old, 'otKeyI')
  const sent = senderPads(
    baseOtContext(binding, initiator, responder),
    need(old, 'otSecret'),
    otKeyI,
    choicesForI,
  )
  // ... and the receiver of R's.
  const chosen = receiverChoose(
    state.rng,
    baseOtContext(binding, responder, initiator),
    otKeyR,
  )
  const sharePoint = need(old, 'sharePoint')
  const share = need(old, 'share')
  const shareProof = proveDlog(
    state.rng,
    binding,
    initiator,
    parseSecret(share),
    parsePoint(sharePoint),
  )
  const vars: Vars = {
    binding,
    share,
    sharePoint,
    peerPoint,
    pads0: sent.pads0,
    pads1: sent.pads1,
    choices: chosen.choices,
    pads: chosen.pads,
    keyId: keyId(
      binding,
      sharePoint,
      peerPoint,
      otKeyI,
      otKeyR,
      choicesForI,
      chosen.message,
    ),
  }
  const outgoing = send(
    state,
    3,
    concat(
      sharePoint,
      need(old, 'commitNonce'),
      shareProof,
      chosen.message,
      sent.message,
    ),
  )
  need(old, 'otSecret').fill(0)
  return { session: next(state, 4, vars), outgoing, result: null }
}

function parseSecret(bytes: Uint8Array): bigint {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}

/** R handles message 3 and sends message 4. */
function responder3(state: KeygenSession, body: Uint8Array): KeygenStepOutput {
  const reader = new Reader(body)
  const peerPoint = reader.take(POINT_BYTES)
  const nonce = reader.take(HASH_BYTES)
  const peerProof = reader.take(DLOG_PROOF_BYTES)
  const choicesForR = reader.take(ENCODED_CHOICES_BYTES)
  const challenges = reader.take(PAD_VECTOR_BYTES)
  reader.finish()
  const { initiator, responder } = ids(state)
  const old = state.vars
  const binding = need(old, 'binding')
  requireOpening(
    need(old, 'commitment'),
    'keygen-share',
    need(old, 'first'),
    initiator,
    peerPoint,
    nonce,
  )
  requireDlogProof(binding, initiator, parsePoint(peerPoint), peerProof)
  const sharePoint = need(old, 'sharePoint')
  const otKeyR = need(old, 'otKeyR')
  // R is the sender of its own instance.
  const sent = senderPads(
    baseOtContext(binding, responder, initiator),
    need(old, 'otSecret'),
    otKeyR,
    choicesForR,
  )
  const responses = receiverRespond(
    baseOtContext(binding, initiator, responder),
    need(old, 'choices'),
    need(old, 'pads'),
    challenges,
  )
  const vars: Vars = {
    binding,
    share: need(old, 'share'),
    sharePoint,
    peerPoint,
    choices: need(old, 'choices'),
    pads: need(old, 'pads'),
    challenges,
    pads0: sent.pads0,
    pads1: sent.pads1,
    keyId: keyId(
      binding,
      peerPoint,
      sharePoint,
      need(old, 'otKeyI'),
      otKeyR,
      need(old, 'choicesForI'),
      choicesForR,
    ),
  }
  need(old, 'otSecret').fill(0)
  return {
    session: next(state, 5, vars),
    outgoing: send(state, 4, concat(responses, sent.message)),
    result: null,
  }
}

/** I handles message 4 and sends message 5. */
function initiator4(state: KeygenSession, body: Uint8Array): KeygenStepOutput {
  const reader = new Reader(body)
  const responses = reader.take(PAD_VECTOR_BYTES)
  const challenges = reader.take(PAD_VECTOR_BYTES)
  reader.finish()
  const { initiator, responder } = ids(state)
  const old = state.vars
  const binding = need(old, 'binding')
  const openings = senderOpen(
    baseOtContext(binding, initiator, responder),
    need(old, 'pads0'),
    need(old, 'pads1'),
    responses,
  )
  const answer = receiverRespond(
    baseOtContext(binding, responder, initiator),
    need(old, 'choices'),
    need(old, 'pads'),
    challenges,
  )
  return {
    session: next(state, 6, { ...old, challenges }),
    outgoing: send(state, 5, concat(openings, answer)),
    result: null,
  }
}

/** The finished share of the party whose state this is. */
function buildShare(state: KeygenSession): KeyShare {
  const { initiator, responder } = ids(state)
  const vars = state.vars
  const binding = need(vars, 'binding')
  const own =
    state.role === 'initiator'
      ? baseOtContext(binding, initiator, responder)
      : baseOtContext(binding, responder, initiator)
  const other =
    state.role === 'initiator'
      ? baseOtContext(binding, responder, initiator)
      : baseOtContext(binding, initiator, responder)
  const seedPairs = senderSeeds(own, need(vars, 'pads0'), need(vars, 'pads1'))
  const seeds = receiverSeeds(other, need(vars, 'pads'))
  const share = wrapShare(
    assembleShare({
      keyId: need(vars, 'keyId'),
      localId: state.localId,
      peerId: state.peerId,
      keygenRole: state.role,
      secret: need(vars, 'share'),
      publicShare: need(vars, 'sharePoint'),
      peerPublicShare: need(vars, 'peerPoint'),
      delta: need(vars, 'choices'),
      seeds,
      seedPairs,
    }),
  )
  seedPairs.fill(0)
  seeds.fill(0)
  wipeVars(vars)
  return share
}

/** R handles message 5, sends message 6 and has its share. */
function responder5(state: KeygenSession, body: Uint8Array): KeygenStepOutput {
  const reader = new Reader(body)
  const openings = reader.take(OPENINGS_BYTES)
  const responses = reader.take(PAD_VECTOR_BYTES)
  reader.finish()
  const { initiator, responder } = ids(state)
  const vars = state.vars
  const binding = need(vars, 'binding')
  receiverVerify(
    baseOtContext(binding, initiator, responder),
    need(vars, 'choices'),
    need(vars, 'pads'),
    need(vars, 'challenges'),
    openings,
  )
  const own = senderOpen(
    baseOtContext(binding, responder, initiator),
    need(vars, 'pads0'),
    need(vars, 'pads1'),
    responses,
  )
  const outgoing = send(state, 6, own)
  return { session: finished(state), outgoing, result: buildShare(state) }
}

/** I handles message 6 and has its share. */
function initiator6(state: KeygenSession, body: Uint8Array): KeygenStepOutput {
  const { initiator, responder } = ids(state)
  const vars = state.vars
  receiverVerify(
    baseOtContext(need(vars, 'binding'), responder, initiator),
    need(vars, 'choices'),
    need(vars, 'pads'),
    need(vars, 'challenges'),
    body,
  )
  return { session: finished(state), outgoing: null, result: buildShare(state) }
}

const HANDLERS: Readonly<
  Record<number, (state: KeygenSession, body: Uint8Array) => KeygenStepOutput>
> = {
  1: responder1,
  2: initiator2,
  3: responder3,
  4: initiator4,
  5: responder5,
  6: initiator6,
}

export function keygenStep(
  session: KeygenSession,
  message: Uint8Array,
): DklsResult<KeygenStepOutput> {
  return advance(session, message, hooks, (state, body) => {
    const handler = HANDLERS[state.expectedRound]
    if (handler === undefined) return fail('internal-error')
    return handler(state, body)
  })
}

/** Abandons a key generation and wipes its secrets. */
export function abortKeygen(session: KeygenSession): void {
  if (session === null || typeof session !== 'object') return
  if (session.status === 'finished') return
  if (session.vars !== undefined) wipeVars(session.vars)
  session.status = 'aborted'
}
