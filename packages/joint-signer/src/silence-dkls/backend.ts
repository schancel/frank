/**
 * The `silence-dkls` backend: two-party DKLs23 from OUR FORK of Silence
 * Laboratories' library (`third_party/silent-shard-dkls23-ll`, built to
 * WebAssembly; non-commercial licence, see that directory and this package's
 * README). The fork adds sessions bound to one digest and adaptor
 * pre-signing; this file is the MIT-licensed wrapper around the built module.
 *
 * What this file adds around the wasm, all of it ours and unreviewed:
 *
 *  - A frame around every message: backend, protocol, round and a 32-byte
 *    binding of the session (key, digest, initiator and, for pre-signing,
 *    the lock). Stray messages are rejected before the wasm sees them. The
 *    same binding is handed to the wasm, which mixes it into its own session
 *    id.
 *  - Turn-taking. DKLs23 is written as rounds in which both parties send at
 *    once. Here the parties alternate, five frames per protocol, and a frame
 *    carries every wasm message its sender can already compute. Each wasm
 *    message is still computed from exactly the inputs the protocol gives it.
 *  - Sessions as values. The wasm session lives only inside one step call:
 *    it is rebuilt from bytes, advanced, serialised and freed.
 *  - Caller-supplied randomness: every wasm call that draws randomness gets a
 *    32-byte seed from the caller's `randomBytes`.
 *  - Integrity of stored keys and stored signing sessions: a MAC keyed from
 *    the key share, checked before anything else is parsed.
 *  - Locks: creation, the holder's check that it can open a lock before it
 *    pre-signs under it, completion and extraction (`../locks.ts`). The wasm
 *    verifies every lock proof and repeats the holder's check itself.
 *
 * Party numbers: the key-generation initiator is party 0, the responder
 * party 1. Signing roles are free per session. In a pre-signing session the
 * lock's holder is always the responder: the initiator gets the
 * pre-signature first and is the party that later extracts the secret.
 */
import { pointFromBytes } from '@frank/adaptor-signatures/src/curve.js'
import {
  decodeAdaptorSignature,
  verifyEncryptedSignature,
} from '@frank/adaptor-signatures/src/ecdsa-adaptor.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha256.js'

import {
  concat,
  draw,
  equalBytes,
  evmAddress,
  field,
  Reader,
  recoveryBit,
  snapshot,
  transcriptHash,
} from '../bytes.js'
import {
  commitmentLockPoint,
  completeCommitmentLock,
  createCommitmentLock,
  createPointLock,
  encodeLock,
  encodeOpening,
  extractCommitmentLockSecret,
  lockOpenedBy,
} from '../locks.js'
import { fail, Failure, failure, success } from '../result.js'
import type {
  ImportSignSessionInput,
  JointKey,
  JointPreSignature,
  JointSignature,
  JointSignerCapabilities,
  JointSignerResult,
  KeygenSession,
  KeyInfo,
  LockFeature,
  LockingJointSigner,
  PreSignSession,
  RandomBytes,
  Role,
  SignSession,
  StartKeygenInput,
  StartPreSignInput,
  StartSignInput,
  Step,
} from '../types.js'
import type {
  DklsAdaptorSignSession,
  DklsMessage,
  DklsSignSession,
  SilenceDklsModule,
} from './module.js'

export const SILENCE_DKLS_BACKEND = 'silence-dkls'

const DOMAIN = 'FRANK-JOINT-SIGNER-V1/silence-dkls'
const FRAME_MAGIC = Uint8Array.of(0x46, 0x4a, 0x53, 0x31) // "FJS1"
const KEY_MAGIC = Uint8Array.of(0x46, 0x4a, 0x4b, 0x31) // "FJK1"
const STATE_MAGIC = Uint8Array.of(0x46, 0x4a, 0x54, 0x31) // "FJT1"
const BACKEND_BYTE = 0x01
const PROTOCOL_KEYGEN = 1
const PROTOCOL_SIGN = 2
const PROTOCOL_PRESIGN = 3
const MAC_BYTES = 32
const HEADER_BYTES = 4 + 1 + 1 + 1 + 32 + 1
/** Largest wasm message measured is about 95 KB (signing message 3). */
const MAX_PART_BYTES = 130_000
const MAX_MESSAGE_BYTES = 180_000
const MAX_SHARE_BYTES = 200_000
const MAX_WASM_STATE_BYTES = 400_000
const MAX_ID_BYTES = 64
const LAST_ROUND = 5

const CAPABILITIES: JointSignerCapabilities & { readonly adaptorLocks: true } =
  {
    backend: SILENCE_DKLS_BACKEND,
    roles: 'symmetric',
    adaptorLocks: true,
    keyTweak: false,
    keygenSessionExport: true,
    keygenMessages: 5,
    signMessages: 5,
    maxMessageBytes: MAX_MESSAGE_BYTES,
    perHandKey: 'keygen',
  }

type Status = 'active' | 'used' | 'finished' | 'aborted'

interface KeyInternal extends JointKey {
  readonly backend: typeof SILENCE_DKLS_BACKEND
  usable: boolean
  readonly keygenRole: Role
  readonly localId: Uint8Array
  readonly peerId: Uint8Array
  readonly publicKey: Uint8Array
  readonly address: Uint8Array
  readonly keyId: Uint8Array
  /** SECRET: the wasm key share, about 124 KB. */
  readonly share: Uint8Array
}

interface SessionCore {
  readonly backend: typeof SILENCE_DKLS_BACKEND
  status: Status
  readonly role: Role
  /** Round of the next incoming frame; 0 when none is expected. */
  readonly expectedRound: number
  readonly sessionId: Uint8Array
  readonly binding: Uint8Array
  /** SECRET: the serialised wasm session. */
  readonly wasm: Uint8Array
  /** Own wasm messages produced but not yet sent. */
  readonly pending: Uint8Array[]
  readonly randomBytes: RandomBytes
}

interface KeygenInternal extends KeygenSession, SessionCore {
  readonly localId: Uint8Array
  readonly peerId: Uint8Array
  /** Chain-code commitments by party number; empty until known. */
  readonly commitments: [Uint8Array, Uint8Array]
}

interface LockBinding {
  /** Canonical lock encoding, as the wasm verifies it. */
  readonly encoded: Uint8Array
  /** The lock point T, 33 bytes, as the wasm computed it. */
  readonly point: Uint8Array
  /** Identity of the lock's holder: the responder of the session. */
  readonly holderId: Uint8Array
  readonly otherId: Uint8Array
}

/** A signing session, or (with `lock`) a pre-signing session. */
interface SignInternal extends SessionCore {
  readonly __jointSigner: 'sign-session' | 'pre-sign-session'
  readonly key: KeyInternal
  readonly digest: Uint8Array
  readonly lock: LockBinding | null
}

type SignOutput = JointSignature | JointPreSignature

function roleByte(role: Role): number {
  return role === 'initiator' ? 0 : 1
}

function roleFromByte(value: number | null): Role | null {
  return value === 0 ? 'initiator' : value === 1 ? 'responder' : null
}

function isRole(value: unknown): value is Role {
  return value === 'initiator' || value === 'responder'
}

/** Rounds 1, 3, 5 go to the responder; rounds 2 and 4 to the initiator. */
function receives(role: Role, round: number): boolean {
  return (round % 2 === 1) === (role === 'responder')
}

/**
 * The wasm's error strings are fixed Rust literals. Turn one into a slug for
 * logs; anything unexpected becomes `wasm-error`, so no data can pass through.
 */
function wasmCode(error: unknown): string {
  const text = error instanceof Error ? error.message : ''
  if (!/^[A-Za-z0-9 _:.-]{1,80}$/.test(text)) return 'wasm-error'
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Runs one wasm call that processes the peer's data. Any throw is the peer's fault. */
function peerCall<T>(call: () => T): T {
  try {
    return call()
  } catch (error) {
    if (error instanceof Failure) throw error
    throw new Failure('peer-check-failed', true, wasmCode(error))
  }
}

/** Runs one wasm call on local data only. A throw is ours. */
function localCall<T>(call: () => T): T {
  try {
    return call()
  } catch (error) {
    if (error instanceof Failure) throw error
    throw new Failure('internal-error', false, wasmCode(error))
  }
}

function release(object: { free(): void } | null | undefined): void {
  try {
    object?.free()
  } catch {
    // A wasm object whose call trapped cannot be freed. It is leaked.
  }
}

function encodeFrame(
  protocol: number,
  round: number,
  binding: Uint8Array,
  parts: Uint8Array[],
): Uint8Array {
  return concat(
    FRAME_MAGIC,
    Uint8Array.of(BACKEND_BYTE, protocol, round),
    binding,
    Uint8Array.of(parts.length),
    ...parts.map(field),
  )
}

type Opened =
  | { readonly ok: true; readonly parts: Uint8Array[] }
  | {
      readonly ok: false
      readonly code:
        | 'malformed-message'
        | 'wrong-session'
        | 'unexpected-message'
    }

function openFrame(
  message: unknown,
  protocol: number,
  round: number,
  binding: Uint8Array,
): Opened {
  const malformed: Opened = { ok: false, code: 'malformed-message' }
  if (!(message instanceof Uint8Array)) return malformed
  if (message.length < HEADER_BYTES || message.length > MAX_MESSAGE_BYTES) {
    return malformed
  }
  const reader = new Reader(message)
  const magic = reader.take(4)
  if (magic === null || !equalBytes(magic, FRAME_MAGIC)) return malformed
  if (reader.byte() !== BACKEND_BYTE) return malformed
  const frameProtocol = reader.byte()
  const frameRound = reader.byte()
  const frameBinding = reader.take(32)
  const count = reader.byte()
  if (frameBinding === null || count === null) return malformed
  if (
    frameProtocol !== PROTOCOL_KEYGEN &&
    frameProtocol !== PROTOCOL_SIGN &&
    frameProtocol !== PROTOCOL_PRESIGN
  ) {
    return malformed
  }
  if (frameRound === null || frameRound < 1 || frameRound > LAST_ROUND) {
    return malformed
  }
  const parts: Uint8Array[] = []
  for (let index = 0; index < count; index += 1) {
    const part = reader.field(MAX_PART_BYTES)
    if (part === null) return malformed
    parts.push(part)
  }
  if (!reader.finished) return malformed
  if (frameProtocol !== protocol || !equalBytes(frameBinding, binding)) {
    return { ok: false, code: 'wrong-session' }
  }
  if (frameRound !== round) return { ok: false, code: 'unexpected-message' }
  return { ok: true, parts }
}

function expectParts(parts: Uint8Array[], count: number): void {
  if (parts.length !== count) fail('peer-check-failed', true, 'frame-parts')
  for (const part of parts) {
    if (part.length === 0) fail('peer-check-failed', true, 'frame-parts')
  }
}

/**
 * The state-machine driver. Frame rejections leave the session usable;
 * everything after the frame check consumes the state, and a failure there
 * aborts the session and wipes it.
 */
function advance<State extends SessionCore, Result>(
  state: State,
  message: unknown,
  protocol: number,
  handle: (state: State, parts: Uint8Array[]) => Step<State, Result>,
): JointSignerResult<Step<State, Result>> {
  if (state.status === 'finished') return failure('session-finished')
  if (state.status === 'aborted') return failure('session-aborted')
  if (state.status === 'used') return failure('state-already-used')
  if (state.status !== 'active' || state.expectedRound === 0) {
    return failure('invalid-input')
  }
  const opened = openFrame(
    message,
    protocol,
    state.expectedRound,
    state.binding,
  )
  if (!opened.ok) return failure(opened.code)
  state.status = 'used'
  try {
    const step = handle(state, opened.parts)
    state.wasm.fill(0)
    return success(step)
  } catch (error) {
    state.wasm.fill(0)
    state.status = 'aborted'
    if (error instanceof Failure) {
      return failure(error.code, {
        sessionAborted: true,
        peerFault: error.peerFault,
        backendCode: error.backendCode,
      })
    }
    return failure('internal-error', { sessionAborted: true })
  }
}

function describeFailure<T>(error: unknown): JointSignerResult<T> {
  if (error instanceof Failure) {
    return failure(error.code, {
      peerFault: error.peerFault,
      backendCode: error.backendCode,
    })
  }
  return failure('internal-error')
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return equalBytes(a, b)
}

/** Key of the storage MAC: a hash of the secret key share. */
function storageMacKey(share: Uint8Array): Uint8Array {
  return transcriptHash(`${DOMAIN}/storage-mac-key`, share)
}

function seal(share: Uint8Array, kind: string, body: Uint8Array): Uint8Array {
  const key = storageMacKey(share)
  const tag = hmac(
    sha256,
    key,
    concat(transcriptHash(`${DOMAIN}/${kind}`), body),
  )
  key.fill(0)
  return concat(body, tag)
}

/** The body of sealed bytes, or null if the MAC does not verify. */
function unseal(
  share: Uint8Array,
  kind: string,
  sealed: Uint8Array,
): Uint8Array | null {
  if (sealed.length < MAC_BYTES) return null
  const body = sealed.subarray(0, sealed.length - MAC_BYTES)
  const expected = seal(share, kind, body).subarray(body.length)
  if (!constantTimeEqual(expected, sealed.subarray(body.length))) return null
  return body.slice()
}

export function createSilenceDklsBackend(
  dkls: SilenceDklsModule,
): LockingJointSigner {
  const seed = (randomBytes: RandomBytes): Uint8Array => draw(randomBytes, 32)

  /** Takes a wasm message's bytes and frees it. */
  const payload = (message: DklsMessage): Uint8Array => {
    try {
      return Uint8Array.from(message.payload)
    } finally {
      release(message)
    }
  }

  /** The single reply a two-party round produces. */
  const single = (messages: DklsMessage[]): Uint8Array => {
    if (!Array.isArray(messages) || messages.length !== 1) {
      messages?.forEach?.(release)
      return fail('internal-error', false, 'reply-count')
    }
    return payload(messages[0] as DklsMessage)
  }

  const incoming = (
    bytes: Uint8Array,
    from: number,
    to?: number,
  ): DklsMessage => new dkls.Message(bytes, from, to)

  // --- key generation ------------------------------------------------------

  function keygenBinding(
    sessionId: Uint8Array,
    initiatorId: Uint8Array,
    responderId: Uint8Array,
  ): Uint8Array {
    return transcriptHash(
      `${DOMAIN}/keygen`,
      sessionId,
      initiatorId,
      responderId,
    )
  }

  function keyIdOf(
    publicKey: Uint8Array,
    initiatorId: Uint8Array,
    responderId: Uint8Array,
  ): Uint8Array {
    return transcriptHash(
      `${DOMAIN}/key-id`,
      publicKey,
      initiatorId,
      responderId,
    )
  }

  function makeKey(
    keygenRole: Role,
    localId: Uint8Array,
    peerId: Uint8Array,
    publicKey: Uint8Array,
    share: Uint8Array,
  ): KeyInternal | null {
    const address = publicKey.length === 33 ? evmAddress(publicKey) : null
    if (address === null) return null
    const initiatorId = keygenRole === 'initiator' ? localId : peerId
    const responderId = keygenRole === 'initiator' ? peerId : localId
    return {
      __jointSigner: 'key',
      backend: SILENCE_DKLS_BACKEND,
      usable: true,
      keygenRole,
      localId,
      peerId,
      publicKey,
      address,
      keyId: keyIdOf(publicKey, initiatorId, responderId),
      share,
    }
  }

  function startKeygen(
    input: StartKeygenInput,
  ): JointSignerResult<Step<KeygenSession, JointKey>> {
    try {
      if (input === null || typeof input !== 'object') {
        return failure('invalid-input')
      }
      const role = input.role
      const sessionId = snapshot(input.sessionId, 32)
      const localId = snapshot(input.localId)
      const peerId = snapshot(input.peerId)
      const randomBytes = input.randomBytes
      if (!isRole(role) || sessionId === null) return failure('invalid-input')
      if (localId === null || peerId === null) return failure('invalid-input')
      if (localId.length < 1 || localId.length > MAX_ID_BYTES) {
        return failure('invalid-input')
      }
      if (peerId.length < 1 || peerId.length > MAX_ID_BYTES) {
        return failure('invalid-input')
      }
      if (equalBytes(localId, peerId)) return failure('invalid-input')
      if (typeof randomBytes !== 'function') return failure('rng-failed')

      const initiator = role === 'initiator'
      const binding = keygenBinding(
        sessionId,
        initiator ? localId : peerId,
        initiator ? peerId : localId,
      )
      const first = seed(randomBytes)
      const session = localCall(
        () => new dkls.KeygenSession(2, 2, roleByte(role), first),
      )
      let message1: Uint8Array
      let wasm: Uint8Array
      try {
        message1 = localCall(() => payload(session.createFirstMessage()))
        wasm = localCall(() => session.toBytes())
      } finally {
        release(session)
      }
      const state: KeygenInternal = {
        __jointSigner: 'keygen-session',
        backend: SILENCE_DKLS_BACKEND,
        status: 'active',
        role,
        expectedRound: initiator ? 2 : 1,
        sessionId,
        binding,
        wasm,
        pending: initiator ? [] : [message1],
        localId,
        peerId,
        commitments: [new Uint8Array(0), new Uint8Array(0)],
        randomBytes,
      }
      return success({
        session: state,
        outgoing: initiator
          ? encodeFrame(PROTOCOL_KEYGEN, 1, binding, [message1])
          : null,
        result: null,
      })
    } catch (error) {
      return describeFailure(error)
    }
  }

  function handleKeygen(
    state: KeygenInternal,
    parts: Uint8Array[],
  ): Step<KeygenInternal, JointKey> {
    const me = roleByte(state.role)
    const peer = 1 - me
    const round = state.expectedRound
    const session = localCall(() => dkls.KeygenSession.fromBytes(state.wasm))
    let consumed = false
    try {
      const reply = (
        part: Uint8Array,
        to: number | undefined,
        commitments?: Uint8Array[],
      ): DklsMessage[] => {
        const fresh = seed(state.randomBytes)
        return peerCall(() =>
          session.handleMessages(
            [incoming(part, peer, to)],
            commitments,
            fresh,
          ),
        )
      }
      const next = (
        expectedRound: number,
        sendRound: number,
        send: Uint8Array[],
        commitments: [Uint8Array, Uint8Array],
      ): Step<KeygenInternal, JointKey> => ({
        session: {
          ...state,
          status: 'active',
          expectedRound,
          wasm: localCall(() => session.toBytes()),
          pending: [],
          commitments,
        },
        outgoing: encodeFrame(PROTOCOL_KEYGEN, sendRound, state.binding, send),
        result: null,
      })
      const finish = (
        send: Uint8Array[] | null,
      ): Step<KeygenInternal, JointKey> => {
        consumed = true
        const keyshare = peerCall(() => session.keyshare())
        let key: KeyInternal | null
        try {
          if (
            keyshare.partyId !== me ||
            keyshare.participants !== 2 ||
            keyshare.threshold !== 2
          ) {
            fail('internal-error', false, 'share-shape')
          }
          key = makeKey(
            state.role,
            state.localId,
            state.peerId,
            Uint8Array.from(keyshare.publicKey),
            keyshare.toBytes(),
          )
        } finally {
          release(keyshare)
        }
        if (key === null) return fail('peer-check-failed', true, 'public-key')
        return {
          session: {
            ...state,
            status: 'finished',
            expectedRound: 0,
            wasm: new Uint8Array(0),
            pending: [],
          },
          outgoing:
            send === null
              ? null
              : encodeFrame(PROTOCOL_KEYGEN, LAST_ROUND, state.binding, send),
          result: key,
        }
      }

      if (round === 1) {
        // Responder: [I.m1] -> [R.m1, R.m2, R.commitment]
        expectParts(parts, 1)
        const own1 = state.pending[0]
        if (own1 === undefined) return fail('internal-error')
        const m2 = single(reply(parts[0] as Uint8Array, undefined))
        const commitment = localCall(() =>
          Uint8Array.from(session.calculateChainCodeCommitment()),
        )
        return next(
          3,
          2,
          [own1, m2, commitment],
          [new Uint8Array(0), commitment],
        )
      }
      if (round === 2) {
        // Initiator: [R.m1, R.m2, R.commitment] -> [I.m2, I.commitment, I.m3]
        expectParts(parts, 3)
        const theirs = parts[2] as Uint8Array
        if (theirs.length !== 32) fail('peer-check-failed', true, 'commitment')
        const m2 = single(reply(parts[0] as Uint8Array, undefined))
        const commitment = localCall(() =>
          Uint8Array.from(session.calculateChainCodeCommitment()),
        )
        const m3 = single(reply(parts[1] as Uint8Array, me))
        return next(4, 3, [m2, commitment, m3], [commitment, theirs])
      }
      if (round === 3) {
        // Responder: [I.m2, I.commitment, I.m3] -> [R.m3, R.m4]
        expectParts(parts, 3)
        const theirs = parts[1] as Uint8Array
        if (theirs.length !== 32) fail('peer-check-failed', true, 'commitment')
        const commitments: [Uint8Array, Uint8Array] = [
          theirs,
          state.commitments[1],
        ]
        const m3 = single(reply(parts[0] as Uint8Array, me))
        const m4 = single(reply(parts[2] as Uint8Array, me, commitments))
        return next(5, 4, [m3, m4], commitments)
      }
      if (round === 4) {
        // Initiator: [R.m3, R.m4] -> [I.m4], done
        expectParts(parts, 2)
        const m4 = single(reply(parts[0] as Uint8Array, me, state.commitments))
        const none = reply(parts[1] as Uint8Array, undefined)
        none.forEach(release)
        return finish([m4])
      }
      if (round === 5) {
        // Responder: [I.m4] -> done
        expectParts(parts, 1)
        const none = reply(parts[0] as Uint8Array, undefined)
        none.forEach(release)
        return finish(null)
      }
      return fail('internal-error')
    } finally {
      if (!consumed) release(session)
    }
  }

  function keygenStep(
    session: KeygenSession,
    message: Uint8Array,
  ): JointSignerResult<Step<KeygenSession, JointKey>> {
    const state = keygenInternal(session)
    if (state === null) return failure('invalid-input')
    return advance(state, message, PROTOCOL_KEYGEN, handleKeygen)
  }

  function keygenInternal(session: unknown): KeygenInternal | null {
    const state = session as KeygenInternal | null
    if (state === null || typeof state !== 'object') return null
    if (state.__jointSigner !== 'keygen-session') return null
    if (state.backend !== SILENCE_DKLS_BACKEND) return null
    return state
  }

  function abortKeygen(session: KeygenSession): void {
    const state = keygenInternal(session)
    if (state === null || state.status === 'finished') return
    state.wasm.fill(0)
    state.status = 'aborted'
  }

  // --- keys ----------------------------------------------------------------

  function keyInternal(key: unknown): KeyInternal | null {
    const internal = key as KeyInternal | null
    if (internal === null || typeof internal !== 'object') return null
    if (internal.__jointSigner !== 'key') return null
    if (internal.backend !== SILENCE_DKLS_BACKEND) return null
    return internal
  }

  function describeKey(key: JointKey): JointSignerResult<KeyInfo> {
    const internal = keyInternal(key)
    if (internal === null) return failure('invalid-input')
    return success({
      keyId: internal.keyId.slice(),
      publicKey: internal.publicKey.slice(),
      address: internal.address.slice(),
      localId: internal.localId.slice(),
      peerId: internal.peerId.slice(),
      keygenRole: internal.keygenRole,
      signRoles: ['initiator', 'responder'],
      usable: internal.usable,
    })
  }

  function exportKey(key: JointKey): JointSignerResult<Uint8Array> {
    const internal = keyInternal(key)
    if (internal === null) return failure('invalid-input')
    if (!internal.usable) return failure('key-unusable', { keyUnusable: true })
    return success(
      seal(
        internal.share,
        'stored-key',
        concat(
          KEY_MAGIC,
          Uint8Array.of(BACKEND_BYTE, roleByte(internal.keygenRole)),
          field(internal.localId),
          field(internal.peerId),
          field(internal.publicKey),
          field(internal.share),
        ),
      ),
    )
  }

  function importKey(bytes: Uint8Array): JointSignerResult<JointKey> {
    const copy = snapshot(bytes)
    if (copy === null) return failure('invalid-input')
    if (copy.length < MAC_BYTES) return failure('invalid-key')
    const reader = new Reader(copy.subarray(0, copy.length - MAC_BYTES))
    const magic = reader.take(4)
    if (magic === null || !equalBytes(magic, KEY_MAGIC)) {
      return failure('invalid-key')
    }
    if (reader.byte() !== BACKEND_BYTE) return failure('invalid-key')
    const role = roleFromByte(reader.byte())
    const localId = reader.field(MAX_ID_BYTES)
    const peerId = reader.field(MAX_ID_BYTES)
    const publicKey = reader.field(33)
    const share = reader.field(MAX_SHARE_BYTES)
    if (role === null || localId === null || peerId === null) {
      return failure('invalid-key')
    }
    if (publicKey === null || share === null || !reader.finished) {
      return failure('invalid-key')
    }
    // The MAC is keyed from the share inside. It is checked before the share
    // or anything else in the envelope is used: someone who can write
    // storage but cannot read the share cannot alter any field.
    if (unseal(share, 'stored-key', copy) === null) {
      return failure('invalid-key')
    }
    if (
      localId.length < 1 ||
      peerId.length < 1 ||
      equalBytes(localId, peerId)
    ) {
      return failure('invalid-key')
    }
    // Let the wasm parse the share and check it agrees with the envelope.
    let agrees = false
    try {
      const keyshare = dkls.Keyshare.fromBytes(share)
      try {
        agrees =
          keyshare.partyId === roleByte(role) &&
          keyshare.participants === 2 &&
          keyshare.threshold === 2 &&
          equalBytes(Uint8Array.from(keyshare.publicKey), publicKey)
      } finally {
        release(keyshare)
      }
    } catch {
      return failure('invalid-key')
    }
    if (!agrees) return failure('invalid-key')
    const key = makeKey(role, localId, peerId, publicKey, share)
    return key === null ? failure('invalid-key') : success(key)
  }

  function destroyKey(key: JointKey): JointSignerResult<true> {
    const internal = keyInternal(key)
    if (internal === null) return failure('invalid-input')
    internal.share.fill(0)
    internal.usable = false
    return success(true)
  }

  // --- signing -------------------------------------------------------------

  /** What a session is bound to. The same bytes go into the wasm. */
  function signBinding(
    key: KeyInternal,
    sessionId: Uint8Array,
    digest: Uint8Array,
    role: Role,
    lock: LockBinding | null,
  ): Uint8Array {
    // The party number of whoever initiates this session.
    const me = roleByte(key.keygenRole)
    const initiatorParty = role === 'initiator' ? me : 1 - me
    return transcriptHash(
      lock === null ? `${DOMAIN}/sign` : `${DOMAIN}/pre-sign`,
      sessionId,
      key.keyId,
      digest,
      Uint8Array.of(initiatorParty),
      lock === null ? new Uint8Array(0) : lock.encoded,
    )
  }

  type WasmSession = DklsSignSession | DklsAdaptorSignSession

  function restoreWasm(state: SignInternal): WasmSession {
    return state.lock === null
      ? dkls.SignSession.fromBytes(state.wasm)
      : dkls.AdaptorSignSession.fromBytes(state.wasm)
  }

  interface Common {
    readonly key: KeyInternal
    readonly role: Role
    readonly sessionId: Uint8Array
    readonly digest: Uint8Array
    readonly randomBytes: RandomBytes
  }

  function commonInput(input: StartSignInput): JointSignerResult<Common> {
    if (input === null || typeof input !== 'object') {
      return failure('invalid-input')
    }
    if (input.tweakCommitment !== undefined) return failure('unsupported')
    const key = keyInternal(input.key)
    const role = input.role
    const sessionId = snapshot(input.sessionId, 32)
    const digest = snapshot(input.digest, 32)
    const randomBytes = input.randomBytes
    if (key === null || !isRole(role)) return failure('invalid-input')
    if (sessionId === null || digest === null) return failure('invalid-input')
    if (typeof randomBytes !== 'function') return failure('rng-failed')
    if (!key.usable) return failure('key-unusable', { keyUnusable: true })
    return success({ key, role, sessionId, digest, randomBytes })
  }

  /** Creates the wasm session, takes its first message and serialises it. */
  function begin<Session, Result>(
    common: Common,
    lock: LockBinding | null,
    create: (binding: Uint8Array, first: Uint8Array) => WasmSession,
  ): Step<Session, Result> {
    const { key, role, sessionId, digest, randomBytes } = common
    const initiator = role === 'initiator'
    const binding = signBinding(key, sessionId, digest, role, lock)
    const first = seed(randomBytes)
    const session = create(binding, first)
    let message1: Uint8Array
    let wasm: Uint8Array
    try {
      message1 = localCall(() => payload(session.createFirstMessage()))
      wasm = localCall(() => session.toBytes())
    } finally {
      release(session)
    }
    const state: SignInternal = {
      __jointSigner: lock === null ? 'sign-session' : 'pre-sign-session',
      backend: SILENCE_DKLS_BACKEND,
      status: 'active',
      role,
      expectedRound: initiator ? 2 : 1,
      sessionId,
      binding,
      wasm,
      pending: initiator ? [] : [message1],
      key,
      digest,
      lock,
      randomBytes,
    }
    const protocol = lock === null ? PROTOCOL_SIGN : PROTOCOL_PRESIGN
    return {
      session: state as unknown as Session,
      outgoing: initiator
        ? encodeFrame(protocol, 1, binding, [message1])
        : null,
      result: null,
    }
  }

  function startSign(
    input: StartSignInput,
  ): JointSignerResult<Step<SignSession, JointSignature>> {
    try {
      const common = commonInput(input)
      if (!common.ok) return common
      const { key, digest } = common.value
      return success(
        begin<SignSession, JointSignature>(
          common.value,
          null,
          (binding, first) =>
            localCall(() => {
              // The constructor consumes the key share object.
              const keyshare = dkls.Keyshare.fromBytes(key.share)
              return new dkls.SignSession(keyshare, 'm', digest, binding, first)
            }),
        ),
      )
    } catch (error) {
      return describeFailure(error)
    }
  }

  function startPreSign(
    input: StartPreSignInput,
  ): JointSignerResult<Step<PreSignSession, JointPreSignature>> {
    try {
      const common = commonInput(input)
      if (!common.ok) return common
      const { key, role, digest } = common.value
      const encoded = encodeLock(input.lock)
      if (encoded === null) return failure('invalid-input')

      // The lock's holder is the responder. It must be able to open the
      // lock itself; the initiator brings no opening.
      const holder = role === 'responder'
      let opening: Uint8Array | undefined
      if (holder) {
        if (
          input.lockOpening === undefined ||
          !lockOpenedBy(input.lock, input.lockOpening)
        ) {
          return failure('lock-not-owned')
        }
        const bytes = encodeOpening(input.lockOpening)
        if (bytes === null) return failure('lock-not-owned')
        opening = bytes
      } else if (input.lockOpening !== undefined) {
        return failure('invalid-input')
      }
      const holderId = holder ? key.localId : key.peerId
      const otherId = holder ? key.peerId : key.localId

      // Verifies every proof of the lock for this key and this holder.
      let point: Uint8Array
      try {
        point = Uint8Array.from(dkls.verifyLock(encoded, key.keyId, holderId))
      } catch (error) {
        return failure('invalid-input', { backendCode: wasmCode(error) })
      }
      const lock: LockBinding = { encoded, point, holderId, otherId }

      try {
        return success(
          begin<PreSignSession, JointPreSignature>(
            common.value,
            lock,
            (_binding, first) => {
              const keyshare = localCall(() =>
                dkls.Keyshare.fromBytes(key.share),
              )
              try {
                // Consumes the key share object. The wasm binds key id, both
                // identities, lock, lock point, digest and public key itself
                // and repeats the holder's opening check.
                return dkls.AdaptorSignSession.create(
                  keyshare,
                  'm',
                  digest,
                  encoded,
                  key.keyId,
                  holderId,
                  otherId,
                  key.localId,
                  opening,
                  first,
                )
              } catch (error) {
                throw new Failure('invalid-input', false, wasmCode(error))
              }
            },
          ),
        )
      } finally {
        opening?.fill(0)
      }
    } catch (error) {
      return describeFailure(error)
    }
  }

  function finishSignature(
    state: SignInternal,
    session: DklsSignSession,
    partial: Uint8Array,
    peer: number,
  ): JointSignature {
    let combined: unknown[]
    try {
      combined = session.combine([incoming(partial, peer)])
    } catch (error) {
      // The wasm verifies the combined signature; a bad partial ends here.
      throw new Failure('invalid-signature', true, wasmCode(error))
    }
    const r = combined[0]
    const s = combined[1]
    if (!(r instanceof Uint8Array) || !(s instanceof Uint8Array)) {
      return fail('internal-error', false, 'signature-shape')
    }
    if (r.length !== 32 || s.length !== 32) {
      return fail('internal-error', false, 'signature-shape')
    }
    const signature = concat(r, s)
    const recovery = recoveryBit(state.key.publicKey, state.digest, signature)
    if (recovery === null) return fail('invalid-signature', true)
    return {
      kind: 'signature',
      signature,
      recovery,
      publicKey: state.key.publicKey.slice(),
      address: state.key.address.slice(),
    }
  }

  function finishPreSignature(
    state: SignInternal,
    lock: LockBinding,
    session: DklsAdaptorSignSession,
    partial: Uint8Array,
    peer: number,
  ): JointPreSignature {
    let combined: Uint8Array
    try {
      combined = session.combine([incoming(partial, peer)])
    } catch (error) {
      // The wasm checks the peer's proof response and verifies the whole
      // encrypted signature; a bad last message ends here.
      throw new Failure('invalid-signature', true, wasmCode(error))
    }
    if (!(combined instanceof Uint8Array) || combined.length !== 162) {
      return fail('internal-error', false, 'signature-shape')
    }
    const adaptorSignature = Uint8Array.from(combined)
    // A second, independent check with our own verifier: what the game layer
    // will hold must verify the way a third party verifies it.
    let verified = false
    try {
      verified = verifyEncryptedSignature(
        pointFromBytes(state.key.publicKey),
        pointFromBytes(lock.point),
        state.digest,
        decodeAdaptorSignature(adaptorSignature),
      )
    } catch {
      verified = false
    }
    if (!verified) return fail('invalid-signature', true, 'second-verifier')
    return {
      kind: 'adaptor-signature',
      adaptorSignature,
      publicKey: state.key.publicKey.slice(),
      address: state.key.address.slice(),
    }
  }

  function handleSign(
    state: SignInternal,
    parts: Uint8Array[],
  ): Step<SignInternal, SignOutput> {
    if (!state.key.usable) return fail('key-unusable')
    const me = roleByte(state.key.keygenRole)
    const peer = 1 - me
    const round = state.expectedRound
    const lock = state.lock
    const protocol = lock === null ? PROTOCOL_SIGN : PROTOCOL_PRESIGN
    const session = localCall(() => restoreWasm(state))
    let consumed = false
    try {
      const reply = (
        part: Uint8Array,
        to: number | undefined,
      ): DklsMessage[] => {
        const fresh = seed(state.randomBytes)
        return peerCall(() =>
          session.handleMessages([incoming(part, peer, to)], fresh),
        )
      }
      const next = (
        expectedRound: number,
        sendRound: number,
        send: Uint8Array[],
      ): Step<SignInternal, SignOutput> => ({
        session: {
          ...state,
          status: 'active',
          expectedRound,
          wasm: localCall(() => session.toBytes()),
          pending: [],
        },
        outgoing: encodeFrame(protocol, sendRound, state.binding, send),
        result: null,
      })
      const done = (
        send: Uint8Array[] | null,
        result: SignOutput,
      ): Step<SignInternal, SignOutput> => ({
        session: {
          ...state,
          status: 'finished',
          expectedRound: 0,
          wasm: new Uint8Array(0),
          pending: [],
        },
        outgoing:
          send === null
            ? null
            : encodeFrame(protocol, LAST_ROUND, state.binding, send),
        result,
      })
      /** This party's last message, for the digest (and lock) of the session. */
      const partialOf = (): Uint8Array =>
        localCall(() => payload(session.lastMessage()))
      /** Consumes the wasm session. */
      const finish = (partial: Uint8Array): SignOutput => {
        consumed = true
        return lock === null
          ? finishSignature(state, session as DklsSignSession, partial, peer)
          : finishPreSignature(
              state,
              lock,
              session as DklsAdaptorSignSession,
              partial,
              peer,
            )
      }

      if (round === 1) {
        // Responder: [I.m1] -> [R.m1, R.m2]
        expectParts(parts, 1)
        const own1 = state.pending[0]
        if (own1 === undefined) return fail('internal-error')
        const m2 = single(reply(parts[0] as Uint8Array, undefined))
        return next(3, 2, [own1, m2])
      }
      if (round === 2) {
        // Initiator: [R.m1, R.m2] -> [I.m2, I.m3]
        expectParts(parts, 2)
        const m2 = single(reply(parts[0] as Uint8Array, undefined))
        const m3 = single(reply(parts[1] as Uint8Array, me))
        return next(4, 3, [m2, m3])
      }
      if (round === 3) {
        // Responder: [I.m2, I.m3] -> [R.m3, R.partial]
        expectParts(parts, 2)
        const m3 = single(reply(parts[0] as Uint8Array, me))
        reply(parts[1] as Uint8Array, me).forEach(release)
        return next(5, 4, [m3, partialOf()])
      }
      if (round === 4) {
        // Initiator: [R.m3, R.partial] -> [I.partial], done
        expectParts(parts, 2)
        reply(parts[0] as Uint8Array, me).forEach(release)
        const partial = partialOf()
        return done([partial], finish(parts[1] as Uint8Array))
      }
      if (round === 5) {
        // Responder: [I.partial] -> done
        expectParts(parts, 1)
        return done(null, finish(parts[0] as Uint8Array))
      }
      return fail('internal-error')
    } finally {
      if (!consumed) release(session)
    }
  }

  function signInternal(
    session: unknown,
    kind: 'sign-session' | 'pre-sign-session',
  ): SignInternal | null {
    const state = session as SignInternal | null
    if (state === null || typeof state !== 'object') return null
    if (state.__jointSigner !== kind) return null
    if (state.backend !== SILENCE_DKLS_BACKEND) return null
    if ((state.lock === null) !== (kind === 'sign-session')) return null
    return state
  }

  function stepSigning<Session, Result>(
    session: unknown,
    message: Uint8Array,
    kind: 'sign-session' | 'pre-sign-session',
  ): JointSignerResult<Step<Session, Result>> {
    const state = signInternal(session, kind)
    if (state === null) return failure('invalid-input')
    if (state.status === 'active' && !state.key.usable) {
      state.wasm.fill(0)
      state.status = 'aborted'
      return failure('key-unusable', {
        sessionAborted: true,
        keyUnusable: true,
      })
    }
    return advance(
      state,
      message,
      kind === 'sign-session' ? PROTOCOL_SIGN : PROTOCOL_PRESIGN,
      handleSign,
    ) as unknown as JointSignerResult<Step<Session, Result>>
  }

  function signStep(
    session: SignSession,
    message: Uint8Array,
  ): JointSignerResult<Step<SignSession, JointSignature>> {
    return stepSigning(session, message, 'sign-session')
  }

  function abortSigning(
    session: unknown,
    kind: 'sign-session' | 'pre-sign-session',
  ): void {
    const state = signInternal(session, kind)
    if (state === null || state.status === 'finished') return
    state.wasm.fill(0)
    state.status = 'aborted'
  }

  function abortSign(session: SignSession): void {
    abortSigning(session, 'sign-session')
  }

  const locks: LockFeature = {
    lockCreator: 'responder',
    createPointLock(input) {
      const key = keyInternal(input?.key)
      if (key === null) return failure('invalid-input')
      if (!key.usable) return failure('key-unusable', { keyUnusable: true })
      return createPointLock({
        keyId: key.keyId,
        holderId: key.localId,
        randomBytes: input.randomBytes,
      })
    },
    createCommitmentLock(input) {
      const key = keyInternal(input?.key)
      if (key === null) return failure('invalid-input')
      if (!key.usable) return failure('key-unusable', { keyUnusable: true })
      return createCommitmentLock({
        keyId: key.keyId,
        holderId: key.localId,
        value: input.value,
        randomBytes: input.randomBytes,
      })
    },
    commitmentLockPoint,
    startPreSign,
    preSignStep(session, message) {
      return stepSigning(session, message, 'pre-sign-session')
    },
    abortPreSign(session) {
      abortSigning(session, 'pre-sign-session')
    },
    completeCommitmentLock,
    extractCommitmentLockSecret,
  }

  // --- stored sessions -----------------------------------------------------

  function encodeState(
    protocol: number,
    state: SessionCore,
    extra: Uint8Array[],
  ): Uint8Array {
    return concat(
      STATE_MAGIC,
      Uint8Array.of(
        BACKEND_BYTE,
        protocol,
        roleByte(state.role),
        state.expectedRound,
        state.pending.length,
      ),
      field(state.sessionId),
      ...state.pending.map(field),
      Uint8Array.of(extra.length),
      ...extra.map(field),
      field(state.wasm),
    )
  }

  interface DecodedState {
    readonly role: Role
    readonly expectedRound: number
    readonly sessionId: Uint8Array
    readonly pending: Uint8Array[]
    readonly extra: Uint8Array[]
    readonly wasm: Uint8Array
  }

  function decodeState(bytes: unknown, protocol: number): DecodedState | null {
    const copy = snapshot(bytes)
    if (copy === null) return null
    const reader = new Reader(copy)
    const magic = reader.take(4)
    if (magic === null || !equalBytes(magic, STATE_MAGIC)) return null
    if (reader.byte() !== BACKEND_BYTE || reader.byte() !== protocol)
      return null
    const role = roleFromByte(reader.byte())
    const expectedRound = reader.byte()
    const pendingCount = reader.byte()
    const sessionId = reader.field(32)
    if (role === null || expectedRound === null || pendingCount === null) {
      return null
    }
    if (sessionId === null || sessionId.length !== 32) return null
    if (expectedRound < 1 || expectedRound > LAST_ROUND) return null
    if (!receives(role, expectedRound)) return null
    // Only the responder, before its first frame, holds an unsent message.
    if (pendingCount !== (expectedRound === 1 ? 1 : 0)) return null
    const pending: Uint8Array[] = []
    for (let index = 0; index < pendingCount; index += 1) {
      const part = reader.field(MAX_PART_BYTES)
      if (part === null) return null
      pending.push(part)
    }
    const extraCount = reader.byte()
    if (extraCount === null || extraCount > 4) return null
    const extra: Uint8Array[] = []
    for (let index = 0; index < extraCount; index += 1) {
      const part = reader.field(MAX_ID_BYTES)
      if (part === null) return null
      extra.push(part)
    }
    const wasm = reader.field(MAX_WASM_STATE_BYTES)
    if (wasm === null || !reader.finished) return null
    return { role, expectedRound, sessionId, pending, extra, wasm }
  }

  function exportSignSession(
    session: SignSession,
  ): JointSignerResult<Uint8Array> {
    const state = signInternal(session, 'sign-session')
    if (state === null) return failure('invalid-input')
    if (state.status === 'finished') return failure('session-finished')
    if (state.status === 'aborted') return failure('session-aborted')
    if (state.status === 'used') return failure('state-already-used')
    if (!state.key.usable) return failure('key-unusable', { keyUnusable: true })
    return success(
      seal(
        state.key.share,
        'stored-sign-session',
        encodeState(PROTOCOL_SIGN, state, [
          state.key.keyId,
          state.digest,
          // Both parties share the key id; this says whose share is inside.
          Uint8Array.of(roleByte(state.key.keygenRole)),
        ]),
      ),
    )
  }

  function importSignSession(
    input: ImportSignSessionInput,
  ): JointSignerResult<SignSession> {
    if (input === null || typeof input !== 'object') {
      return failure('invalid-input')
    }
    const key = keyInternal(input.key)
    if (key === null) return failure('invalid-input')
    if (typeof input.randomBytes !== 'function') return failure('rng-failed')
    if (!key.usable) return failure('key-unusable', { keyUnusable: true })
    // Authenticate before parsing anything: the MAC key comes from this
    // party's key share, so stored state that was written or altered by
    // someone without the share (for example to pair the stored nonce with
    // another digest) is refused here.
    const sealed = snapshot(input.state)
    if (sealed === null) return failure('invalid-state')
    const body = unseal(key.share, 'stored-sign-session', sealed)
    if (body === null) return failure('invalid-state')
    const decoded = decodeState(body, PROTOCOL_SIGN)
    if (decoded === null || decoded.extra.length !== 3) {
      return failure('invalid-state')
    }
    const keyId = decoded.extra[0] as Uint8Array
    const digest = decoded.extra[1] as Uint8Array
    const party = decoded.extra[2] as Uint8Array
    if (!equalBytes(keyId, key.keyId) || digest.length !== 32) {
      return failure('invalid-state')
    }
    if (party.length !== 1 || party[0] !== roleByte(key.keygenRole)) {
      return failure('invalid-state')
    }
    try {
      release(dkls.SignSession.fromBytes(decoded.wasm))
    } catch {
      return failure('invalid-state')
    }
    const state: SignInternal = {
      __jointSigner: 'sign-session',
      backend: SILENCE_DKLS_BACKEND,
      status: 'active',
      role: decoded.role,
      expectedRound: decoded.expectedRound,
      sessionId: decoded.sessionId,
      binding: signBinding(key, decoded.sessionId, digest, decoded.role, null),
      wasm: decoded.wasm,
      pending: decoded.pending,
      key,
      digest,
      lock: null,
      randomBytes: input.randomBytes,
    }
    return success(state as unknown as SignSession)
  }

  function exportKeygenSession(
    session: KeygenSession,
  ): JointSignerResult<Uint8Array> {
    const state = keygenInternal(session)
    if (state === null) return failure('invalid-input')
    if (state.status === 'finished') return failure('session-finished')
    if (state.status === 'aborted') return failure('session-aborted')
    if (state.status === 'used') return failure('state-already-used')
    return success(
      encodeState(PROTOCOL_KEYGEN, state, [
        state.localId,
        state.peerId,
        state.commitments[0],
        state.commitments[1],
      ]),
    )
  }

  function importKeygenSession(input: {
    readonly state: Uint8Array
    readonly randomBytes: RandomBytes
  }): JointSignerResult<KeygenSession> {
    if (input === null || typeof input !== 'object') {
      return failure('invalid-input')
    }
    if (typeof input.randomBytes !== 'function') return failure('rng-failed')
    const decoded = decodeState(input.state, PROTOCOL_KEYGEN)
    if (decoded === null || decoded.extra.length !== 4) {
      return failure('invalid-state')
    }
    const [localId, peerId, commitment0, commitment1] = decoded.extra as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ]
    if (
      localId.length < 1 ||
      peerId.length < 1 ||
      equalBytes(localId, peerId)
    ) {
      return failure('invalid-state')
    }
    for (const commitment of [commitment0, commitment1]) {
      if (commitment.length !== 0 && commitment.length !== 32) {
        return failure('invalid-state')
      }
    }
    try {
      release(dkls.KeygenSession.fromBytes(decoded.wasm))
    } catch {
      return failure('invalid-state')
    }
    const initiator = decoded.role === 'initiator'
    const state: KeygenInternal = {
      __jointSigner: 'keygen-session',
      backend: SILENCE_DKLS_BACKEND,
      status: 'active',
      role: decoded.role,
      expectedRound: decoded.expectedRound,
      sessionId: decoded.sessionId,
      binding: keygenBinding(
        decoded.sessionId,
        initiator ? localId : peerId,
        initiator ? peerId : localId,
      ),
      wasm: decoded.wasm,
      pending: decoded.pending,
      localId,
      peerId,
      commitments: [commitment0, commitment1],
      randomBytes: input.randomBytes,
    }
    return success(state)
  }

  return {
    capabilities: CAPABILITIES,
    startKeygen,
    keygenStep,
    abortKeygen,
    describeKey,
    exportKey,
    importKey,
    destroyKey,
    startSign,
    signStep,
    abortSign,
    exportSignSession,
    importSignSession,
    keygenSessions: { exportKeygenSession, importKeygenSession },
    locks,
  }
}
