/**
 * The `frank-lindell` backend: `@frank/threshold-ecdsa` (Lindell 2017, our own
 * TypeScript) behind the neutral interface. A thin translation: that package
 * already frames, binds and validates its own messages and stored state.
 *
 * Roles are fixed per key: the key-generation initiator initiates every
 * signing session and is the party that extracts lock secrets; the responder
 * creates locks.
 */
import * as lindell from '@frank/threshold-ecdsa'
import type {
  AdaptorLock,
  ThresholdErrorCode,
  ThresholdResult,
} from '@frank/threshold-ecdsa'

import { failure, success } from '../result.js'
import type {
  ImportSignSessionInput,
  JointKey,
  JointLock,
  JointLockOpening,
  JointPreSignature,
  JointSignature,
  JointSignerCapabilities,
  JointSignerErrorCode,
  JointSignerResult,
  KeygenSession,
  KeyInfo,
  LockFeature,
  LockingJointSigner,
  PreSignSession,
  Role,
  SignSession,
  StartKeygenInput,
  StartPreSignInput,
  StartSignInput,
  Step,
} from '../types.js'

export const FRANK_LINDELL_BACKEND = 'frank-lindell'

const CAPABILITIES: JointSignerCapabilities & { readonly adaptorLocks: true } =
  {
    backend: FRANK_LINDELL_BACKEND,
    roles: 'fixed-per-key',
    adaptorLocks: true,
    keyTweak: true,
    keygenSessionExport: false,
    keygenMessages: 8,
    signMessages: 5,
    maxMessageBytes: 47000,
    perHandKey: 'tweak',
  }

const CODES: Readonly<Record<ThresholdErrorCode, JointSignerErrorCode>> = {
  'invalid-input': 'invalid-input',
  'rng-failed': 'rng-failed',
  'malformed-message': 'malformed-message',
  'wrong-session': 'wrong-session',
  'unexpected-message': 'unexpected-message',
  'invalid-point': 'peer-check-failed',
  'out-of-range': 'peer-check-failed',
  'invalid-commitment': 'peer-check-failed',
  'invalid-proof': 'peer-check-failed',
  'invalid-paillier': 'peer-check-failed',
  'lock-not-owned': 'lock-not-owned',
  'invalid-signature': 'invalid-signature',
  'unusable-nonce': 'peer-check-failed',
  'session-finished': 'session-finished',
  'session-aborted': 'session-aborted',
  'state-already-used': 'state-already-used',
  'key-share-burned': 'key-unusable',
  'invalid-key-share': 'invalid-key',
  'internal-error': 'internal-error',
}

function translate<T, U>(
  result: ThresholdResult<T>,
  map: (value: T) => U,
): JointSignerResult<U> {
  if (result.ok) return success(map(result.value))
  const error = result.error
  return failure(CODES[error.code] ?? 'internal-error', {
    sessionAborted: error.sessionAborted,
    keyUnusable: error.keyShareBurned || error.code === 'key-share-burned',
    peerFault: error.peerFault,
    backendCode: error.code,
  })
}

interface KeyHandle extends JointKey {
  readonly backend: typeof FRANK_LINDELL_BACKEND
  readonly inner: lindell.KeyShare
}

interface KeygenHandle extends KeygenSession {
  readonly backend: typeof FRANK_LINDELL_BACKEND
  readonly inner: lindell.KeygenSession
}

interface SignHandle {
  readonly __jointSigner: 'sign-session' | 'pre-sign-session'
  readonly backend: typeof FRANK_LINDELL_BACKEND
  readonly inner: lindell.SignSession
}

function wrapKey(inner: lindell.KeyShare): KeyHandle {
  return { __jointSigner: 'key', backend: FRANK_LINDELL_BACKEND, inner }
}

function unwrap<Handle extends { readonly backend: string }>(
  value: unknown,
  kind: string,
): Handle | null {
  const handle = value as (Handle & { __jointSigner?: string }) | null
  if (handle === null || typeof handle !== 'object') return null
  if (handle.__jointSigner !== kind) return null
  if (handle.backend !== FRANK_LINDELL_BACKEND) return null
  return handle
}

function keygenStepOutput(
  step: Step<lindell.KeygenSession, lindell.KeyShare>,
): Step<KeygenSession, JointKey> {
  const session: KeygenHandle = {
    __jointSigner: 'keygen-session',
    backend: FRANK_LINDELL_BACKEND,
    inner: step.session,
  }
  return {
    session,
    outgoing: step.outgoing,
    result: step.result === null ? null : wrapKey(step.result),
  }
}

/** A finished session of the wrong kind is our bug, not the peer's. */
type SignKind = 'signature' | 'adaptor-signature'

function signStepOutput<Session, Result>(
  step: Step<lindell.SignSession, lindell.SignResult>,
  tag: 'sign-session' | 'pre-sign-session',
  kind: SignKind,
): JointSignerResult<Step<Session, Result>> {
  if (step.result !== null && step.result.kind !== kind) {
    lindell.abortSign(step.session)
    return failure('internal-error', { sessionAborted: true })
  }
  const session: SignHandle = {
    __jointSigner: tag,
    backend: FRANK_LINDELL_BACKEND,
    inner: step.session,
  }
  return success({
    session: session as unknown as Session,
    outgoing: step.outgoing,
    result: step.result as unknown as Result | null,
  })
}

function flatten<T>(
  result: JointSignerResult<JointSignerResult<T>>,
): JointSignerResult<T> {
  return result.ok ? result.value : result
}

export function createFrankLindellBackend(): LockingJointSigner {
  function keyRole(key: KeyHandle): JointSignerResult<Role> {
    return translate(lindell.describeKeyShare(key.inner), info => info.role)
  }

  /** Refuses a role other than the key's own. */
  function checkedKey(
    input: { readonly key: JointKey; readonly role: Role } | null,
  ): JointSignerResult<KeyHandle> {
    if (input === null || typeof input !== 'object') {
      return failure('invalid-input')
    }
    const key = unwrap<KeyHandle>(input.key, 'key')
    if (key === null) return failure('invalid-input')
    if (input.role !== 'initiator' && input.role !== 'responder') {
      return failure('invalid-input')
    }
    const role = keyRole(key)
    if (!role.ok) return role
    if (role.value !== input.role) return failure('role-fixed')
    return success(key)
  }

  function startKeygen(
    input: StartKeygenInput,
  ): JointSignerResult<Step<KeygenSession, JointKey>> {
    if (input === null || typeof input !== 'object') {
      return failure('invalid-input')
    }
    return translate(
      lindell.startKeygen({
        role: input.role,
        sessionId: input.sessionId,
        localId: input.localId,
        peerId: input.peerId,
        randomBytes: input.randomBytes,
      }),
      keygenStepOutput,
    )
  }

  function keygenStep(
    session: KeygenSession,
    message: Uint8Array,
  ): JointSignerResult<Step<KeygenSession, JointKey>> {
    const handle = unwrap<KeygenHandle>(session, 'keygen-session')
    if (handle === null) return failure('invalid-input')
    return translate(
      lindell.keygenStep(handle.inner, message),
      keygenStepOutput,
    )
  }

  function abortKeygen(session: KeygenSession): void {
    const handle = unwrap<KeygenHandle>(session, 'keygen-session')
    if (handle !== null) lindell.abortKeygen(handle.inner)
  }

  function describeKey(key: JointKey): JointSignerResult<KeyInfo> {
    const handle = unwrap<KeyHandle>(key, 'key')
    if (handle === null) return failure('invalid-input')
    return translate(lindell.describeKeyShare(handle.inner), info => ({
      keyId: info.keyId,
      publicKey: info.publicKey,
      address: info.address,
      localId: info.localId,
      peerId: info.peerId,
      keygenRole: info.role,
      signRoles: [info.role],
      usable: !info.burned,
    }))
  }

  function exportKey(key: JointKey): JointSignerResult<Uint8Array> {
    const handle = unwrap<KeyHandle>(key, 'key')
    if (handle === null) return failure('invalid-input')
    return translate(lindell.exportKeyShare(handle.inner), bytes => bytes)
  }

  function importKey(bytes: Uint8Array): JointSignerResult<JointKey> {
    return translate(lindell.importKeyShare(bytes), wrapKey)
  }

  function destroyKey(key: JointKey): JointSignerResult<true> {
    const handle = unwrap<KeyHandle>(key, 'key')
    if (handle === null) return failure('invalid-input')
    return translate(lindell.destroyKeyShare(handle.inner), done => done)
  }

  function start<Session, Result>(
    input: StartSignInput,
    lock: AdaptorLock | undefined,
    tag: 'sign-session' | 'pre-sign-session',
    kind: SignKind,
    lockOpening?: JointLockOpening,
  ): JointSignerResult<Step<Session, Result>> {
    const key = checkedKey(input)
    if (!key.ok) return key
    return flatten(
      translate(
        lindell.startSign({
          keyShare: key.value.inner,
          sessionId: input.sessionId,
          digest: input.digest,
          tweakCommitment: input.tweakCommitment,
          lock,
          // The package itself refuses a holder that cannot open the lock
          // (`lock-not-owned`) and an initiator that passes an opening.
          lockOpening,
          randomBytes: input.randomBytes,
        }),
        step => signStepOutput<Session, Result>(step, tag, kind),
      ),
    )
  }

  function step<Session, Result>(
    session: unknown,
    message: Uint8Array,
    tag: 'sign-session' | 'pre-sign-session',
    kind: SignKind,
  ): JointSignerResult<Step<Session, Result>> {
    const handle = unwrap<SignHandle>(session, tag)
    if (handle === null) return failure('invalid-input')
    return flatten(
      translate(lindell.signStep(handle.inner, message), output =>
        signStepOutput<Session, Result>(output, tag, kind),
      ),
    )
  }

  function abort(session: unknown, tag: string): void {
    const handle = unwrap<SignHandle>(session, tag)
    if (handle !== null) lindell.abortSign(handle.inner)
  }

  function exportSignSession(
    session: SignSession,
  ): JointSignerResult<Uint8Array> {
    const handle = unwrap<SignHandle>(session, 'sign-session')
    if (handle === null) return failure('invalid-input')
    return translate(lindell.exportSignSession(handle.inner), bytes => bytes)
  }

  function importSignSession(
    input: ImportSignSessionInput,
  ): JointSignerResult<SignSession> {
    if (input === null || typeof input !== 'object') {
      return failure('invalid-input')
    }
    const key = unwrap<KeyHandle>(input.key, 'key')
    if (key === null) return failure('invalid-input')
    const imported = lindell.importSignSession({
      state: input.state,
      keyShare: key.inner,
      randomBytes: input.randomBytes,
    })
    if (!imported.ok && imported.error.code === 'invalid-input') {
      // That package reports unusable stored bytes as invalid input.
      return failure('invalid-state', { backendCode: imported.error.code })
    }
    return translate(imported, inner => {
      const handle: SignHandle = {
        __jointSigner: 'sign-session',
        backend: FRANK_LINDELL_BACKEND,
        inner,
      }
      return handle as SignSession
    })
  }

  const locks: LockFeature = {
    lockCreator: 'responder',
    createPointLock(input) {
      const key = unwrap<KeyHandle>(input?.key, 'key')
      if (key === null) return failure('invalid-input')
      return translate(
        lindell.createPointLock({
          keyShare: key.inner,
          randomBytes: input.randomBytes,
        }),
        material => ({
          secret: material.secret,
          lock: material.lock,
          opening: material.opening as JointLockOpening & {
            readonly kind: 'point'
          },
        }),
      )
    },
    createCommitmentLock(input) {
      const key = unwrap<KeyHandle>(input?.key, 'key')
      if (key === null) return failure('invalid-input')
      return translate(
        lindell.createCommitmentLock({
          keyShare: key.inner,
          value: input.value,
          randomBytes: input.randomBytes,
        }),
        material => ({
          secret: material.secret,
          commitment: material.commitment,
          proof: material.proof,
          opening: material.opening as JointLockOpening & {
            readonly kind: 'commitment'
          },
        }),
      )
    },
    commitmentLockPoint(commitment, index) {
      return translate(
        lindell.commitmentLockPoint(commitment, index),
        point => point,
      )
    },
    startPreSign(input: StartPreSignInput) {
      if (input === null || typeof input !== 'object') {
        return failure('invalid-input')
      }
      const lock = input.lock as JointLock | undefined
      if (lock === null || typeof lock !== 'object') {
        return failure('invalid-input')
      }
      // The lock is validated at run time by the package; the cast only
      // drops the type brand of `@frank/adaptor-signatures`.
      return start<PreSignSession, JointPreSignature>(
        input,
        lock as unknown as AdaptorLock,
        'pre-sign-session',
        'adaptor-signature',
        input.lockOpening,
      )
    },
    preSignStep(session, message) {
      return step<PreSignSession, JointPreSignature>(
        session,
        message,
        'pre-sign-session',
        'adaptor-signature',
      )
    },
    abortPreSign(session) {
      abort(session, 'pre-sign-session')
    },
    completeCommitmentLock(input) {
      return translate(
        lindell.completeCommitmentLock({
          ...input,
          adaptorSignature: input.adaptorSignature as unknown as Parameters<
            typeof lindell.completeCommitmentLock
          >[0]['adaptorSignature'],
        }),
        completed => ({
          signature: completed.signature,
          recovery: completed.recovery,
        }),
      )
    },
    extractCommitmentLockSecret(input) {
      return translate(
        lindell.extractCommitmentLockSecret({
          ...input,
          adaptorSignature: input.adaptorSignature as unknown as Parameters<
            typeof lindell.extractCommitmentLockSecret
          >[0]['adaptorSignature'],
        }),
        secret => secret,
      )
    },
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
    startSign(input) {
      return start<SignSession, JointSignature>(
        input,
        undefined,
        'sign-session',
        'signature',
      )
    },
    signStep(session, message) {
      return step<SignSession, JointSignature>(
        session,
        message,
        'sign-session',
        'signature',
      )
    },
    abortSign(session) {
      abort(session, 'sign-session')
    },
    exportSignSession,
    importSignSession,
    tweak: {
      tweakPublicKey(publicKey, commitment) {
        return translate(
          lindell.tweakPublicKey(publicKey, commitment),
          tweaked => ({
            publicKey: tweaked.publicKey,
            address: tweaked.address,
          }),
        )
      },
    },
    locks,
  }
}
