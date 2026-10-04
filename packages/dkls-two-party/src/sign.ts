/**
 * Two-party signing and adaptor pre-signing: Protocol 6.2 of Asharov,
 * "Revisiting DKLs Threshold ECDSA" (ePrint 2026/976), with its two
 * simultaneous-round phases packed into five alternating messages.
 * I = initiator, R = responder. "X" is the multiplication in which I is the
 * receiver (and the OT-extension receiver), "Y" the one in which R is.
 *
 *   1  I -> R   salt_I, commitment to I's nonce payload, OT extension for X
 *   2  R -> I   salt_R, commitment to R's nonce payload, OT extension for Y,
 *               multiplication message for X
 *   3  I -> R   multiplication message for Y; I's nonce payload opened;
 *               I's corrections (gamma) and check points (Gamma)
 *   4  R -> I   R's nonce payload opened; R's gamma, Gamma; R's (u, w)
 *   5  I -> R   I's (u, w)
 *
 * I holds the result after message 4, R after message 5.
 *
 * THE PACKING OF ROUNDS is `bodyBytes` and the five handlers below. The
 * paper's phases are: preprocessing round 1 (commit, VOLE round 1),
 * preprocessing round 2 (VOLE round 2), signing round 1 (open, gamma,
 * Gamma), signing round 2 (u, w). A party's later-round message shares a
 * frame with its earlier-round one only when it already holds every message
 * of the peer for the earlier round, which is what a rushing adversary in
 * the simultaneous model sees anyway.
 *
 * What differs for pre-signing is in `adaptor.ts`.
 *
 * FAILURES. A frame rejection leaves the session usable. Any failure after
 * it that is attributable to the peer aborts the session AND BURNS THE KEY:
 * the share and the pairwise setup are wiped and the share id enters the
 * process-wide burned set that every step consults. That is required for the
 * OT-extension check (the peer may have learned bits of Delta) and for the
 * multiplication check (DKLs18, 2023 preface, erratum 4); for the remaining
 * checks it is a uniform conservative rule.
 *
 * Arithmetic of Protocol 6.2 for one party with nonce share k, key share x,
 * sender outputs (alpha_k, alpha_x; t_k, t_x) and receiver outputs
 * (beta; r_k, r_x), peer nonce point R' and peer public share X':
 *
 *   gamma_k = k - alpha_k    gamma_x = x - alpha_x
 *   Gamma_k = t_k * G        Gamma_x = t_x * G
 *   c_k = gamma'_k * beta + r_k,   require c_k * G = beta * R' - Gamma'_k
 *   c_x = gamma'_x * beta + r_x,   require c_x * G = beta * X' - Gamma'_x
 *   u = k * beta + t_k + c_k
 *   v = x * beta + t_x + c_x
 *   w = m * beta + r * v
 *   s = (w_I + w_R) / (u_I + u_R)
 */
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hashToScalar } from '@frank/adaptor-signatures/src/curve.js'

import {
  finish,
  drawNonceShare,
  jointNonce,
  nonceResponse,
  openNonceShare,
  payloadBytes,
  proofBytes,
  proveNonceShare,
  responseBytes,
  type OpenedNonce,
  type SignResult as CoreResult,
} from './adaptor.js'
import {
  asciiBytes,
  bytesToInt,
  concat,
  equalBytes,
  intToBytes,
  Reader,
  snapshot,
  snapshotBounded,
  variable,
} from './bytes.js'
import {
  commit,
  CURVE_ORDER,
  G,
  HASH_BYTES,
  modAdd,
  modInv,
  modMul,
  modSub,
  parsePoint,
  parseScalar,
  POINT_BYTES,
  requireOpening,
  SCALAR_BYTES,
  scalarBytes,
  transcript,
  type Point,
} from './group.js'
import {
  burnShare,
  internalShare,
  shareIsBurned,
  usableShare,
  type InternalShare,
  type KeyShare,
} from './key-share.js'
import {
  decodeLock,
  requireLockOpening,
  resolveLock,
  type AdaptorLock,
  type LockOpening,
  type ResolvedLock,
} from './lock.js'
import {
  EXTENSION_MESSAGE_BYTES,
  extendReceiver,
  extendSender,
  extensionNonce,
  padPrefix,
  receiverPads,
  senderPadPairs,
} from './ot-extension.js'
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
  extensionDigest,
  VOLE_COLUMNS,
  VOLE_MESSAGE_BYTES,
  voleContext,
  voleReceive,
  voleSend,
} from './vole.js'
import {
  DIGEST_BYTES,
  encodeMessage,
  fullBinding,
  initiatorBinding,
  PROTOCOL_PRE_SIGN,
  PROTOCOL_SIGN,
  SALT_BYTES,
  SESSION_ID_BYTES,
  signFrame,
  type RoleName,
} from './wire.js'

export interface SignSession extends SessionCore {
  readonly role: RoleName
  readonly share: InternalShare
  readonly rng: RandomBytes
  readonly sessionId: Uint8Array
  readonly digest: Uint8Array
  /** Null for plain signing. */
  readonly lock: ResolvedLock | null
}

export type SignResult = CoreResult & {
  /** The 33-byte joint key the result verifies under. */
  readonly publicKey: Uint8Array
  /** Its 20-byte EVM address. */
  readonly address: Uint8Array
}

export type SignStepOutput = Step<SignSession, SignResult>

export interface StartSignInput {
  readonly keyShare: KeyShare
  /** Either party may take either role in any session. */
  readonly role: RoleName
  /** 32 bytes, agreed, never reused with this key. */
  readonly sessionId: Uint8Array
  /** 32 bytes: the transaction's signing hash. */
  readonly digest: Uint8Array
  /** Pre-sign under this lock instead of signing. Both parties pass it. */
  readonly lock?: AdaptorLock
  /**
   * The lock's secret opening. REQUIRED for the responder (the lock holder),
   * and refused for the initiator.
   */
  readonly lockOpening?: LockOpening
  readonly randomBytes: RandomBytes
}

export const SIGN_MESSAGES = 5

const SHARE_BYTES = 2 * SCALAR_BYTES + 2 * POINT_BYTES
const PAIR_BYTES = 2 * SCALAR_BYTES

function locked(state: { readonly lock: ResolvedLock | null }): boolean {
  return state.lock !== null
}

function openingBytes(isLocked: boolean): number {
  return payloadBytes(isLocked) + HASH_BYTES + proofBytes(isLocked)
}

/** Body length of the message a state expects. One valid length each. */
function bodyBytes(round: number, isLocked: boolean): number {
  switch (round) {
    case 1:
      return SALT_BYTES + HASH_BYTES + EXTENSION_MESSAGE_BYTES
    case 2:
      return (
        SALT_BYTES + HASH_BYTES + EXTENSION_MESSAGE_BYTES + VOLE_MESSAGE_BYTES
      )
    case 3:
      return VOLE_MESSAGE_BYTES + openingBytes(isLocked) + SHARE_BYTES
    case 4:
      return (
        openingBytes(isLocked) +
        SHARE_BYTES +
        PAIR_BYTES +
        responseBytes(isLocked)
      )
    case 5:
      return PAIR_BYTES + responseBytes(isLocked)
    default:
      return 0
  }
}

const hooks: Hooks<SignSession> = {
  bodyBytes: state => bodyBytes(state.expectedRound, locked(state)),
  blocked: state =>
    state.share.destroyed || shareIsBurned(state.share) ? 'key-burned' : null,
  onFailure(state, peerFault) {
    if (!peerFault) return false
    burnShare(state.share)
    return true
  },
}

function next(state: SignSession, expectedRound: number, vars: Vars): SignSession {
  return { ...state, status: 'active', expectedRound, vars }
}

function send(state: SignSession, round: number, body: Uint8Array): Uint8Array {
  if (body.length !== bodyBytes(round, locked(state))) fail('internal-error')
  return encodeMessage(state.protocol, round, state.frame, body)
}

function ids(state: SignSession): {
  initiator: Uint8Array
  responder: Uint8Array
} {
  return state.role === 'initiator'
    ? { initiator: state.share.localId, responder: state.share.peerId }
    : { initiator: state.share.peerId, responder: state.share.localId }
}

function lockPoint(state: SignSession): Uint8Array | null {
  return state.lock === null ? null : state.lock.point
}

function scalar(bytes: Uint8Array): bigint {
  return bytesToInt(bytes)
}

/** `value * G`, allowing zero. */
function timesG(value: bigint): Point {
  return value === 0n ? secp256k1.ProjectivePoint.ZERO : G.multiply(value)
}

/** A point that must not be the identity, as 33 bytes. */
function checkPoint(value: bigint): Uint8Array {
  // Zero has probability 2^-256 for an honest run and cannot be encoded.
  if (value === 0n) fail('internal-error')
  return G.multiply(value).toRawBytes(true)
}

// --- The two multiplications -------------------------------------------------

/**
 * This party as OT-extension receiver and multiplication receiver: round 1.
 * `nonceBinding` must contain this party's own fresh salt.
 */
function receiveStart(
  state: SignSession,
  nonceBinding: Uint8Array,
): { message: Uint8Array; vars: Vars } {
  const share = state.share
  const extension = extendReceiver(
    share.seedPairs,
    extensionNonce(nonceBinding, share.localId, share.peerId),
  )
  return {
    message: extension.message,
    vars: {
      choices: extension.choices,
      rows: extension.rows,
      extension: extensionDigest(extension.message),
    },
  }
}

/** This party as multiplication receiver: output. Returns beta, r_k, r_x. */
function receiveFinish(
  state: SignSession,
  binding: Uint8Array,
  vars: Vars,
  message: Uint8Array,
): { beta: bigint; shares: readonly bigint[] } {
  const share = state.share
  const pads = receiverPads(
    padPrefix(binding, share.localId, share.peerId),
    need(vars, 'rows'),
    VOLE_COLUMNS,
  )
  const output = voleReceive(
    voleContext(binding, share.localId, share.peerId),
    need(vars, 'extension'),
    need(vars, 'choices'),
    pads,
    message,
  )
  pads.fill(0)
  return output
}

/**
 * This party as OT-extension sender and multiplication sender. Verifies the
 * peer's extension message (a failure here burns the key) and returns the
 * multiplication message with alpha_k, alpha_x, t_k, t_x.
 */
function sendMultiplication(
  state: SignSession,
  nonceBinding: Uint8Array,
  binding: Uint8Array,
  extensionMessage: Uint8Array,
): { message: Uint8Array; alpha: readonly bigint[]; shares: readonly bigint[] } {
  const share = state.share
  const rows = extendSender(
    share.delta,
    share.seeds,
    extensionNonce(nonceBinding, share.peerId, share.localId),
    extensionMessage,
  )
  const pairs = senderPadPairs(
    padPrefix(binding, share.peerId, share.localId),
    rows,
    share.delta,
    VOLE_COLUMNS,
  )
  rows.fill(0)
  const output = voleSend(
    state.rng,
    voleContext(binding, share.peerId, share.localId),
    extensionDigest(extensionMessage),
    pairs.zero,
    pairs.one,
    share.secret,
  )
  pairs.zero.fill(0)
  pairs.one.fill(0)
  return output
}

// --- Signing rounds of Protocol 6.2 ------------------------------------------

/** Signing round 1 of this party: gamma_k, gamma_x, Gamma_k, Gamma_x. */
function corrections(
  state: SignSession,
  k: bigint,
  alpha: readonly bigint[],
  shares: readonly bigint[],
): Uint8Array {
  const x = scalar(state.share.secret)
  return concat(
    scalarBytes(modSub(k, alpha[0] ?? 0n)),
    scalarBytes(modSub(x, alpha[1] ?? 0n)),
    checkPoint(shares[0] ?? 0n),
    checkPoint(shares[1] ?? 0n),
  )
}

/**
 * Applies the peer's signing round 1 and checks it against the peer's nonce
 * point and public share. Returns c_k, c_x.
 */
function applyCorrections(
  state: SignSession,
  peerNonce: Point,
  beta: bigint,
  received: readonly bigint[],
  body: Uint8Array,
): { ck: bigint; cx: bigint } {
  const reader = new Reader(body)
  const gammaK = parseScalar(reader.take(SCALAR_BYTES), true)
  const gammaX = parseScalar(reader.take(SCALAR_BYTES), true)
  const checkK = parsePoint(reader.take(POINT_BYTES))
  const checkX = parsePoint(reader.take(POINT_BYTES))
  reader.finish()
  if (beta === 0n) fail('internal-error')
  const ck = modAdd(modMul(gammaK, beta), received[0] ?? 0n)
  const cx = modAdd(modMul(gammaX, beta), received[1] ?? 0n)
  const peerShare = parsePoint(state.share.peerPublicShare)
  const goodK = timesG(ck).equals(peerNonce.multiply(beta).subtract(checkK))
  const goodX = timesG(cx).equals(peerShare.multiply(beta).subtract(checkX))
  if (!goodK || !goodX) fail('inconsistent-share')
  return { ck, cx }
}

/** Signing round 2 of this party: (u, w). */
function contribution(
  state: SignSession,
  r: bigint,
  k: bigint,
  beta: bigint,
  sent: readonly bigint[],
  c: { ck: bigint; cx: bigint },
): { u: bigint; w: bigint } {
  const x = scalar(state.share.secret)
  const m = hashToScalar(state.digest)
  const u = modAdd(modAdd(modMul(k, beta), sent[0] ?? 0n), c.ck)
  const v = modAdd(modAdd(modMul(x, beta), sent[1] ?? 0n), c.cx)
  const w = modAdd(modMul(m, beta), modMul(r, v))
  return { u, w }
}

function finalResult(
  state: SignSession,
  joint: ReturnType<typeof jointNonce>,
  mine: { u: bigint; w: bigint },
  theirs: { u: bigint; w: bigint },
  responses: readonly Uint8Array[],
): SignResult {
  const u = modAdd(mine.u, theirs.u)
  if (u === 0n) fail('invalid-signature')
  const s = modMul(modAdd(mine.w, theirs.w), modInv(u))
  const result = finish({
    lockPoint: lockPoint(state),
    publicKey: state.share.publicKey,
    digest: state.digest,
    joint,
    s,
    responses,
  })
  return {
    ...result,
    publicKey: state.share.publicKey.slice(),
    address: state.share.address.slice(),
  }
}

/** Parses the peer's opened nonce payload and checks it against its commitment. */
function openPeerNonce(
  state: SignSession,
  commitment: Uint8Array,
  commitBinding: Uint8Array,
  binding: Uint8Array,
  reader: Reader,
): { opened: OpenedNonce; payload: Uint8Array } {
  const isLocked = locked(state)
  const payload = reader.take(payloadBytes(isLocked))
  const nonce = reader.take(HASH_BYTES)
  const proof = reader.take(proofBytes(isLocked))
  const peerId = state.share.peerId
  requireOpening(commitment, 'sign-nonce', commitBinding, peerId, payload, nonce)
  return {
    opened: openNonceShare(lockPoint(state), payload, {
      binding,
      proverId: peerId,
      proof,
    }),
    payload,
  }
}

function pair(value: { u: bigint; w: bigint }): Uint8Array {
  return concat(scalarBytes(value.u), scalarBytes(value.w))
}

function readPair(reader: Reader): { u: bigint; w: bigint } {
  return {
    u: parseScalar(reader.take(SCALAR_BYTES), true),
    w: parseScalar(reader.take(SCALAR_BYTES), true),
  }
}

// --- Start --------------------------------------------------------------------

export function startSign(input: StartSignInput): DklsResult<SignStepOutput> {
  if (input === null || typeof input !== 'object') {
    return failure('invalid-input')
  }
  let share: InternalShare
  let lock: ResolvedLock | null = null
  try {
    internalShare(input.keyShare)
  } catch {
    return failure('invalid-input')
  }
  const role = input.role
  const sessionId = snapshot(input.sessionId, SESSION_ID_BYTES)
  const digest = snapshot(input.digest, DIGEST_BYTES)
  if (
    (role !== 'initiator' && role !== 'responder') ||
    sessionId === null ||
    digest === null
  ) {
    return failure('invalid-input')
  }
  const rng = input.randomBytes
  if (typeof rng !== 'function') return failure('rng-failed')
  try {
    share = usableShare(input.keyShare)
    if (input.lock !== undefined) {
      const holder = role === 'responder' ? share.localId : share.peerId
      lock = resolveLock(input.lock, share.keyId, holder)
      if (role === 'responder') {
        requireLockOpening(input.lock, input.lockOpening)
      } else if (input.lockOpening !== undefined) {
        return failure('invalid-input')
      }
    } else if (input.lockOpening !== undefined) {
      return failure('invalid-input')
    }
  } catch (error) {
    const code = failureCode(error)
    return failure(code, false, code === 'key-burned')
  }
  const protocol = lock === null ? PROTOCOL_SIGN : PROTOCOL_PRE_SIGN
  const base: SignSession = {
    status: 'active',
    protocol,
    expectedRound: role === 'initiator' ? 2 : 1,
    frame: frameOf(share, role, protocol, sessionId, digest, lock),
    vars: {},
    role,
    share,
    rng,
    sessionId,
    digest,
    lock,
  }
  if (role === 'responder') {
    return success({ session: base, outgoing: null, result: null })
  }
  const vars: Vars = {}
  try {
    // Message 1.
    const salt = draw(rng, SALT_BYTES)
    const first = initiatorBinding(base.frame, salt)
    const nonce = drawNonceShare(rng, lockPoint(base), first, share.secret)
    const commitNonce = draw(rng, HASH_BYTES)
    const receiving = receiveStart(base, first)
    Object.assign(vars, receiving.vars, {
      saltI: salt,
      k: scalarBytes(nonce.k),
      payload: nonce.payload,
      commitNonce,
    })
    if (nonce.a !== null) vars.a = scalarBytes(nonce.a)
    const body = concat(
      salt,
      commit('sign-nonce', first, share.localId, nonce.payload, commitNonce),
      receiving.message,
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

function frameOf(
  share: InternalShare,
  role: RoleName,
  protocol: number,
  sessionId: Uint8Array,
  digest: Uint8Array,
  lock: ResolvedLock | null,
): Uint8Array {
  return signFrame({
    protocol,
    sessionId,
    initiatorId: role === 'initiator' ? share.localId : share.peerId,
    responderId: role === 'initiator' ? share.peerId : share.localId,
    keyId: share.keyId,
    publicKey: share.publicKey,
    digest,
    lock: lock === null ? new Uint8Array(0) : lock.encoded,
  })
}

// --- Handlers ------------------------------------------------------------------

/** R handles message 1 and sends message 2. */
function responder1(state: SignSession, body: Uint8Array): SignStepOutput {
  const reader = new Reader(body)
  const saltI = reader.take(SALT_BYTES)
  const peerCommitment = reader.take(HASH_BYTES)
  const extensionX = reader.take(EXTENSION_MESSAGE_BYTES)
  reader.finish()
  const share = state.share
  const first = initiatorBinding(state.frame, saltI)
  const saltR = draw(state.rng, SALT_BYTES)
  const binding = fullBinding(state.frame, saltI, saltR)

  // X: R is the sender. I stretched its seeds under its own salt only.
  const sent = sendMultiplication(state, first, binding, extensionX)
  // Y: R is the receiver.
  const receiving = receiveStart(state, binding)

  const nonce = drawNonceShare(state.rng, lockPoint(state), binding, share.secret)
  const commitNonce = draw(state.rng, HASH_BYTES)
  const vars: Vars = {
    ...receiving.vars,
    binding,
    first,
    peerCommitment,
    k: scalarBytes(nonce.k),
    payload: nonce.payload,
    commitNonce,
    alphaK: scalarBytes(sent.alpha[0] ?? 0n),
    alphaX: scalarBytes(sent.alpha[1] ?? 0n),
    sentK: scalarBytes(sent.shares[0] ?? 0n),
    sentX: scalarBytes(sent.shares[1] ?? 0n),
  }
  if (nonce.a !== null) vars.a = scalarBytes(nonce.a)
  return {
    session: next(state, 3, vars),
    outgoing: send(
      state,
      2,
      concat(
        saltR,
        commit('sign-nonce', binding, share.localId, nonce.payload, commitNonce),
        receiving.message,
        sent.message,
      ),
    ),
    result: null,
  }
}

/** I handles message 2 and sends message 3. */
function initiator2(state: SignSession, body: Uint8Array): SignStepOutput {
  const reader = new Reader(body)
  const saltR = reader.take(SALT_BYTES)
  const peerCommitment = reader.take(HASH_BYTES)
  const extensionY = reader.take(EXTENSION_MESSAGE_BYTES)
  const multiplicationX = reader.take(VOLE_MESSAGE_BYTES)
  reader.finish()
  const share = state.share
  const old = state.vars
  const binding = fullBinding(state.frame, need(old, 'saltI'), saltR)

  // X: I is the receiver.
  const received = receiveFinish(state, binding, old, multiplicationX)
  // Y: I is the sender. R stretched its seeds under the full binding.
  const sent = sendMultiplication(state, binding, binding, extensionY)

  const k = scalar(need(old, 'k'))
  const payload = need(old, 'payload')
  const proof = proveNonceShare(
    state.rng,
    lockPoint(state),
    binding,
    share.localId,
    k,
    payload,
  )
  const vars: Vars = {
    binding,
    peerCommitment,
    k: need(old, 'k'),
    payload,
    beta: scalarBytes(received.beta),
    receivedK: scalarBytes(received.shares[0] ?? 0n),
    receivedX: scalarBytes(received.shares[1] ?? 0n),
    sentK: scalarBytes(sent.shares[0] ?? 0n),
    sentX: scalarBytes(sent.shares[1] ?? 0n),
  }
  if (old.a !== undefined) vars.a = old.a
  const outgoing = send(
    state,
    3,
    concat(
      sent.message,
      payload,
      need(old, 'commitNonce'),
      proof,
      corrections(state, k, sent.alpha, sent.shares),
    ),
  )
  for (const name of ['choices', 'rows']) old[name]?.fill(0)
  return { session: next(state, 4, vars), outgoing, result: null }
}

/** R handles message 3 and sends message 4. */
function responder3(state: SignSession, body: Uint8Array): SignStepOutput {
  const reader = new Reader(body)
  const multiplicationY = reader.take(VOLE_MESSAGE_BYTES)
  const share = state.share
  const old = state.vars
  const binding = need(old, 'binding')

  // Y: R is the receiver.
  const received = receiveFinish(state, binding, old, multiplicationY)

  // I's signing round 1.
  const peer = openPeerNonce(
    state,
    need(old, 'peerCommitment'),
    need(old, 'first'),
    binding,
    reader,
  )
  const c = applyCorrections(
    state,
    peer.opened.plain,
    received.beta,
    received.shares,
    reader.take(SHARE_BYTES),
  )
  reader.finish()

  // R's signing rounds 1 and 2.
  const k = scalar(need(old, 'k'))
  const payload = need(old, 'payload')
  const mine = openNonceShare(lockPoint(state), payload)
  const joint = jointNonce(lockPoint(state), mine, peer.opened)
  const sentShares = [scalar(need(old, 'sentK')), scalar(need(old, 'sentX'))]
  const own = contribution(state, joint.r, k, received.beta, sentShares, c)
  const response = nonceResponse(
    joint,
    old.a === undefined ? null : scalar(old.a),
    k,
  )
  const proof = proveNonceShare(
    state.rng,
    lockPoint(state),
    binding,
    share.localId,
    k,
    payload,
  )
  const vars: Vars = {
    payload: payload.slice(),
    peerPayload: peer.payload,
    u: scalarBytes(own.u),
    w: scalarBytes(own.w),
    response,
  }
  const outgoing = send(
    state,
    4,
    concat(
      payload,
      need(old, 'commitNonce'),
      proof,
      corrections(
        state,
        k,
        [scalar(need(old, 'alphaK')), scalar(need(old, 'alphaX'))],
        sentShares,
      ),
      pair(own),
      response,
    ),
  )
  wipeVars(old)
  return { session: next(state, 5, vars), outgoing, result: null }
}

/** I handles message 4, has the result and sends message 5. */
function initiator4(state: SignSession, body: Uint8Array): SignStepOutput {
  const reader = new Reader(body)
  const old = state.vars
  const binding = need(old, 'binding')
  // R committed under the full binding.
  const peer = openPeerNonce(
    state,
    need(old, 'peerCommitment'),
    binding,
    binding,
    reader,
  )
  const beta = scalar(need(old, 'beta'))
  const c = applyCorrections(
    state,
    peer.opened.plain,
    beta,
    [scalar(need(old, 'receivedK')), scalar(need(old, 'receivedX'))],
    reader.take(SHARE_BYTES),
  )
  const theirs = readPair(reader)
  const theirResponse = reader.take(responseBytes(locked(state)))
  reader.finish()

  const k = scalar(need(old, 'k'))
  const mine = openNonceShare(lockPoint(state), need(old, 'payload'))
  const joint = jointNonce(lockPoint(state), mine, peer.opened)
  const own = contribution(
    state,
    joint.r,
    k,
    beta,
    [scalar(need(old, 'sentK')), scalar(need(old, 'sentX'))],
    c,
  )
  const response = nonceResponse(
    joint,
    old.a === undefined ? null : scalar(old.a),
    k,
  )
  // Verified before anything of this round is sent.
  const result = finalResult(
    state,
    joint,
    own,
    theirs,
    locked(state) ? [response, theirResponse] : [],
  )
  const outgoing = send(state, 5, concat(pair(own), response))
  wipeVars(old)
  return {
    session: { ...state, status: 'finished', expectedRound: 0, vars: {} },
    outgoing,
    result,
  }
}

/** R handles message 5 and has the result. */
function responder5(state: SignSession, body: Uint8Array): SignStepOutput {
  const reader = new Reader(body)
  const theirs = readPair(reader)
  const theirResponse = reader.take(responseBytes(locked(state)))
  reader.finish()
  const old = state.vars
  const joint = jointNonce(
    lockPoint(state),
    openNonceShare(lockPoint(state), need(old, 'payload')),
    openNonceShare(lockPoint(state), need(old, 'peerPayload')),
  )
  const result = finalResult(
    state,
    joint,
    { u: scalar(need(old, 'u')), w: scalar(need(old, 'w')) },
    theirs,
    locked(state) ? [need(old, 'response'), theirResponse] : [],
  )
  wipeVars(old)
  return {
    session: { ...state, status: 'finished', expectedRound: 0, vars: {} },
    outgoing: null,
    result,
  }
}

const HANDLERS: Readonly<
  Record<number, (state: SignSession, body: Uint8Array) => SignStepOutput>
> = {
  1: responder1,
  2: initiator2,
  3: responder3,
  4: initiator4,
  5: responder5,
}

export function signStep(
  session: SignSession,
  message: Uint8Array,
): DklsResult<SignStepOutput> {
  return advance(session, message, hooks, (state, body) => {
    const handler = HANDLERS[state.expectedRound]
    if (handler === undefined) return fail('internal-error')
    return handler(state, body)
  })
}

/** Abandons a signing session and wipes its secrets. The key is not burned. */
export function abortSign(session: SignSession): void {
  if (session === null || typeof session !== 'object') return
  if (session.status === 'finished') return
  if (session.vars !== undefined) wipeVars(session.vars)
  session.status = 'aborted'
}

// --- Stored sessions -----------------------------------------------------------
//
// SECRET and integrity-critical. Layout:
//
//   "FDKX" || version || key id || protocol || role || expected round ||
//   session id || digest || var(encoded lock) || count ||
//   count x (var(name) || var(value)) || HMAC
//
// The HMAC is keyed from the secret key share and is verified before
// anything is parsed. Without it, someone who can write storage could pair a
// stored nonce with a different digest or peer commitment. It cannot detect
// an OLD state: see the README's persistence rules.

const STATE_MAGIC = asciiBytes('FDKX')
const STATE_VERSION = 1
const MAC_BYTES = 32
const MAX_STATE_BYTES = 32768
const MAX_VAR_BYTES = 16384
const MAX_LOCK_BYTES = 512

/** The values a state must hold, per role and expected round. */
function expectedVars(state: {
  readonly role: RoleName
  readonly expectedRound: number
  readonly lock: ResolvedLock | null
}): string[] | null {
  const key = `${state.role}/${state.expectedRound}`
  const table: Record<string, string[]> = {
    'responder/1': [],
    'initiator/2': [
      'choices',
      'rows',
      'extension',
      'saltI',
      'k',
      'payload',
      'commitNonce',
    ],
    'responder/3': [
      'choices',
      'rows',
      'extension',
      'binding',
      'first',
      'peerCommitment',
      'k',
      'payload',
      'commitNonce',
      'alphaK',
      'alphaX',
      'sentK',
      'sentX',
    ],
    'initiator/4': [
      'binding',
      'peerCommitment',
      'k',
      'payload',
      'beta',
      'receivedK',
      'receivedX',
      'sentK',
      'sentX',
    ],
    'responder/5': ['payload', 'peerPayload', 'u', 'w', 'response'],
  }
  const names = table[key]
  if (names === undefined) return null
  const withProofNonce =
    state.lock !== null && key !== 'responder/1' && key !== 'responder/5'
  return (withProofNonce ? [...names, 'a'] : names).sort()
}

function stateMac(share: InternalShare, body: Uint8Array): Uint8Array {
  const key = transcript('storage/sign-session', share.secret, share.keyId)
  const mac = hmac(sha256, key, body)
  key.fill(0)
  return mac
}

/** SECRET. See the README's persistence rules before using this. */
export function exportSignSession(session: SignSession): DklsResult<Uint8Array> {
  try {
    if (session === null || typeof session !== 'object') {
      return failure('invalid-input')
    }
    if (session.status !== 'active') {
      return failure(
        session.status === 'used'
          ? 'state-already-used'
          : session.status === 'finished'
          ? 'session-finished'
          : 'session-aborted',
      )
    }
    const share = session.share
    if (share.destroyed || shareIsBurned(share)) {
      return failure('key-burned', false, true)
    }
    const names = Object.keys(session.vars).sort()
    const parts: Uint8Array[] = [
      STATE_MAGIC,
      Uint8Array.of(STATE_VERSION),
      share.keyId,
      Uint8Array.of(
        session.protocol,
        session.role === 'initiator' ? 1 : 2,
        session.expectedRound,
      ),
      session.sessionId,
      session.digest,
      variable(session.lock === null ? new Uint8Array(0) : session.lock.encoded),
      intToBytes(names.length, 2),
    ]
    for (const name of names) {
      parts.push(variable(asciiBytes(name)), variable(need(session.vars, name)))
    }
    const body = concat(...parts)
    return success(concat(body, stateMac(share, body)))
  } catch (error) {
    return failure(failureCode(error))
  }
}

export interface ImportSignSessionInput {
  readonly state: Uint8Array
  readonly keyShare: KeyShare
  readonly randomBytes: RandomBytes
}

export function importSignSession(
  input: ImportSignSessionInput,
): DklsResult<SignSession> {
  if (input === null || typeof input !== 'object') {
    return failure('invalid-input')
  }
  let share: InternalShare
  try {
    share = usableShare(input.keyShare)
  } catch (error) {
    const code = failureCode(error)
    return failure(code, false, code === 'key-burned')
  }
  const rng = input.randomBytes
  if (typeof rng !== 'function') return failure('rng-failed')
  const copied = snapshotBounded(
    input.state,
    STATE_MAGIC.length + 1 + MAC_BYTES,
    MAX_STATE_BYTES,
  )
  if (copied === null) return failure('invalid-state')
  const vars: Vars = {}
  try {
    // Authenticate first.
    const body = copied.subarray(0, copied.length - MAC_BYTES)
    if (
      !equalBytes(stateMac(share, body), copied.subarray(body.length))
    ) {
      return failure('invalid-state')
    }
    const reader = new Reader(body)
    if (
      !equalBytes(reader.take(STATE_MAGIC.length), STATE_MAGIC) ||
      reader.byte() !== STATE_VERSION ||
      !equalBytes(reader.take(HASH_BYTES), share.keyId)
    ) {
      return failure('invalid-state')
    }
    const protocol = reader.byte()
    const roleByte = reader.byte()
    const expectedRound = reader.byte()
    const sessionId = reader.take(SESSION_ID_BYTES)
    const digest = reader.take(DIGEST_BYTES)
    const encodedLock = reader.variable(MAX_LOCK_BYTES)
    const count = Number(bytesToInt(reader.take(2)))
    for (let index = 0; index < count; index += 1) {
      const name = String.fromCharCode(...reader.variable(32))
      vars[name] = reader.variable(MAX_VAR_BYTES)
    }
    reader.finish()
    if (roleByte !== 1 && roleByte !== 2) return failure('invalid-state')
    const role: RoleName = roleByte === 1 ? 'initiator' : 'responder'
    // The lock is validated again from its encoding.
    let lock: ResolvedLock | null = null
    if (encodedLock.length > 0) {
      const holder = role === 'responder' ? share.localId : share.peerId
      lock = resolveLock(decodeLock(encodedLock), share.keyId, holder)
      if (!equalBytes(lock.encoded, encodedLock)) return failure('invalid-state')
    }
    if (protocol !== (lock === null ? PROTOCOL_SIGN : PROTOCOL_PRE_SIGN)) {
      return failure('invalid-state')
    }
    const expected = expectedVars({ role, expectedRound, lock })
    if (
      expected === null ||
      expected.join(',') !== Object.keys(vars).sort().join(',')
    ) {
      return failure('invalid-state')
    }
    return success({
      status: 'active',
      protocol,
      expectedRound,
      frame: frameOf(share, role, protocol, sessionId, digest, lock),
      vars,
      role,
      share,
      rng,
      sessionId,
      digest,
      lock,
    })
  } catch {
    wipeVars(vars)
    return failure('invalid-state')
  } finally {
    copied.fill(0)
  }
}
