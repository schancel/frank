/**
 * The backend-neutral interface the game layer uses for a jointly held
 * secp256k1 key. A backend is one implementation of `JointSigner`; the game
 * layer holds a `JointSigner` and never imports a backend's own types.
 *
 * Style (same as `@frank/threshold-ecdsa`): transport-agnostic step functions
 * `(state, incomingMessage) -> (newState, outgoingMessage | result)`, opaque
 * byte messages, caller-supplied randomness, typed results, errors that carry
 * no data.
 */

/** Must return exactly `length` fresh cryptographically secure random bytes. */
export type RandomBytes = (length: number) => Uint8Array

/** The initiator sends the first message of a protocol run. */
export type Role = 'initiator' | 'responder'

export type JointSignerErrorCode =
  /** A caller-supplied argument has the wrong type, length or range. */
  | 'invalid-input'
  /** The caller-supplied CSPRNG threw or returned the wrong shape. */
  | 'rng-failed'
  /** The bytes are not a message of this backend. Session still usable. */
  | 'malformed-message'
  /** A message of another session, key or digest. Session still usable. */
  | 'wrong-session'
  /** A message of this session but not the expected round. Session still usable. */
  | 'unexpected-message'
  /** The peer's message failed a cryptographic or consistency check. */
  | 'peer-check-failed'
  /** The final signature or pre-signature did not verify. */
  | 'invalid-signature'
  /** The session already produced its result. */
  | 'session-finished'
  /** The session aborted earlier. */
  | 'session-aborted'
  /** This state object was already advanced; use the state it returned. */
  | 'state-already-used'
  /** The key was destroyed or burned and must never sign again. */
  | 'key-unusable'
  /** Stored key bytes failed validation or belong to another backend. */
  | 'invalid-key'
  /** Stored session bytes failed validation or do not match the key. */
  | 'invalid-state'
  /** The backend fixes roles per key and this role is not this key's role. */
  | 'role-fixed'
  /** The backend does not have this capability. Check `capabilities` first. */
  | 'unsupported'
  /** An invariant failed. The session is aborted. */
  | 'internal-error'

export interface JointSignerError {
  readonly code: JointSignerErrorCode
  /** The session this call was advancing is dead. Retry with a new session id. */
  readonly sessionAborted: boolean
  /** The key must never sign again. The caller must record this durably. */
  readonly keyUnusable: boolean
  /** The peer's message failed a check. Only meaningful over an authenticated transport. */
  readonly peerFault: boolean
  /** The backend's own fixed error code, for logs. Never contains data. */
  readonly backendCode: string | null
}

export type JointSignerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: JointSignerError }

/** Opaque handles. Only the backend that made one can use it. */
export interface JointKey {
  readonly __jointSigner: 'key'
}
export interface KeygenSession {
  readonly __jointSigner: 'keygen-session'
}
export interface SignSession {
  readonly __jointSigner: 'sign-session'
}
export interface PreSignSession {
  readonly __jointSigner: 'pre-sign-session'
}

export interface Step<Session, Result> {
  /** The state to pass to the next step call. The one passed in is consumed. */
  readonly session: Session
  /** Bytes to deliver to the other party, if any. */
  readonly outgoing: Uint8Array | null
  /** The protocol's output once this party has finished, else null. */
  readonly result: Result | null
}

export interface JointSignerCapabilities {
  /** Stable backend name. Stored keys and sessions are bound to it. */
  readonly backend: string
  /**
   * `symmetric`: either party may take either role in every signing session.
   * `fixed-per-key`: the key-generation role is the signing role for the life
   * of the key; two users who need both assignments generate two keys.
   */
  readonly roles: 'symmetric' | 'fixed-per-key'
  /** Adaptor pre-signing. True exactly when `locks` is present. */
  readonly adaptorLocks: boolean
  /** Signing for a key tweaked by a 32-byte commitment. True exactly when `tweak` is present. */
  readonly keyTweak: boolean
  /** In-flight key generation can be exported. True exactly when `keygenSessions` is present. */
  readonly keygenSessionExport: boolean
  /** Messages per key generation and per signing session, both directions together. */
  readonly keygenMessages: number
  readonly signMessages: number
  /** No message of this backend is longer than this. */
  readonly maxMessageBytes: number
  /**
   * How a new joint key per hand should be obtained. `keygen`: run key
   * generation again (it is cheap). `tweak`: generate once per pair and
   * tweak per hand (key generation is slow).
   */
  readonly perHandKey: 'keygen' | 'tweak'
}

export interface StartKeygenInput {
  readonly role: Role
  /** 32 bytes, agreed by both parties, new for every run. */
  readonly sessionId: Uint8Array
  /** 1..64 bytes each, different. */
  readonly localId: Uint8Array
  readonly peerId: Uint8Array
  readonly randomBytes: RandomBytes
}

export interface KeyInfo {
  /** 32 bytes, equal on both sides. */
  readonly keyId: Uint8Array
  /** 33 bytes, compressed. */
  readonly publicKey: Uint8Array
  /** 20 bytes, EVM. */
  readonly address: Uint8Array
  readonly localId: Uint8Array
  readonly peerId: Uint8Array
  /** The role this party had in key generation. */
  readonly keygenRole: Role
  /** The roles this party may take in a signing session with this key. */
  readonly signRoles: readonly Role[]
  /** False once the key was destroyed or burned. */
  readonly usable: boolean
}

export interface StartSignInput {
  readonly key: JointKey
  /** Must be one of `describeKey(key).signRoles`. */
  readonly role: Role
  /** 32 bytes, agreed, never reused with this key. */
  readonly sessionId: Uint8Array
  /** 32 bytes: the transaction's signing hash. */
  readonly digest: Uint8Array
  /** Sign for the tweaked key. Refused with `unsupported` without `keyTweak`. */
  readonly tweakCommitment?: Uint8Array
  readonly randomBytes: RandomBytes
}

export interface JointSignature {
  readonly kind: 'signature'
  /** r (32) || s (32), low-s. */
  readonly signature: Uint8Array
  /** EIP-1559 yParity. */
  readonly recovery: 0 | 1
  /** The 33-byte key the signature verifies under (tweaked if a tweak was given). */
  readonly publicKey: Uint8Array
  /** Its 20-byte EVM address. */
  readonly address: Uint8Array
}

export interface ImportSignSessionInput {
  readonly state: Uint8Array
  readonly key: JointKey
  readonly randomBytes: RandomBytes
}

/** What every backend provides. */
export interface JointSignerCore {
  readonly capabilities: JointSignerCapabilities

  startKeygen(
    input: StartKeygenInput,
  ): JointSignerResult<Step<KeygenSession, JointKey>>
  keygenStep(
    session: KeygenSession,
    message: Uint8Array,
  ): JointSignerResult<Step<KeygenSession, JointKey>>
  abortKeygen(session: KeygenSession): void

  describeKey(key: JointKey): JointSignerResult<KeyInfo>
  /** SECRET. Store encrypted and authenticated. */
  exportKey(key: JointKey): JointSignerResult<Uint8Array>
  importKey(bytes: Uint8Array): JointSignerResult<JointKey>
  destroyKey(key: JointKey): JointSignerResult<true>

  startSign(
    input: StartSignInput,
  ): JointSignerResult<Step<SignSession, JointSignature>>
  signStep(
    session: SignSession,
    message: Uint8Array,
  ): JointSignerResult<Step<SignSession, JointSignature>>
  abortSign(session: SignSession): void

  /** SECRET. See the README's persistence rules before using these. */
  exportSignSession(session: SignSession): JointSignerResult<Uint8Array>
  importSignSession(
    input: ImportSignSessionInput,
  ): JointSignerResult<SignSession>
}

/** Present only when `capabilities.keyTweak`. */
export interface TweakFeature {
  tweakPublicKey(
    publicKey: Uint8Array,
    commitment: Uint8Array,
  ): JointSignerResult<{
    readonly publicKey: Uint8Array
    readonly address: Uint8Array
  }>
}

/** Present only when `capabilities.keygenSessionExport`. */
export interface KeygenSessionFeature {
  /** SECRET. */
  exportKeygenSession(session: KeygenSession): JointSignerResult<Uint8Array>
  importKeygenSession(input: {
    readonly state: Uint8Array
    readonly randomBytes: RandomBytes
  }): JointSignerResult<KeygenSession>
}

/** A lock for adaptor pre-signing, in the layout of `@frank/threshold-ecdsa`. */
export type JointLock =
  | {
      readonly kind: 'point'
      readonly point: Uint8Array
      readonly proof: Uint8Array
      readonly ownerProof: Uint8Array
    }
  | {
      readonly kind: 'commitment'
      readonly commitment: Uint8Array
      readonly proof: Uint8Array
      readonly index: number
    }

export interface JointPreSignature {
  readonly kind: 'adaptor-signature'
  /** 162 bytes, the `@frank/adaptor-signatures` encoding. */
  readonly adaptorSignature: Uint8Array
  readonly publicKey: Uint8Array
  readonly address: Uint8Array
}

export interface StartPreSignInput extends StartSignInput {
  readonly lock: JointLock
}

/**
 * Adaptor pre-signing. Present only when `capabilities.adaptorLocks`; a
 * backend without it has no `locks` property at all, so pre-signing cannot be
 * called on it.
 */
export interface LockFeature {
  /** Which party creates locks and holds their secrets. The other extracts. */
  readonly lockCreator: Role
  createPointLock(input: {
    readonly key: JointKey
    readonly randomBytes: RandomBytes
  }): JointSignerResult<{
    readonly secret: Uint8Array
    readonly lock: JointLock & { readonly kind: 'point' }
  }>
  createCommitmentLock(input: {
    readonly key: JointKey
    readonly value: number
    readonly randomBytes: RandomBytes
  }): JointSignerResult<{
    readonly secret: Uint8Array
    readonly commitment: Uint8Array
    readonly proof: Uint8Array
  }>
  commitmentLockPoint(
    commitment: Uint8Array,
    index: number,
  ): JointSignerResult<Uint8Array>
  startPreSign(
    input: StartPreSignInput,
  ): JointSignerResult<Step<PreSignSession, JointPreSignature>>
  preSignStep(
    session: PreSignSession,
    message: Uint8Array,
  ): JointSignerResult<Step<PreSignSession, JointPreSignature>>
  abortPreSign(session: PreSignSession): void
  completeCommitmentLock(input: {
    readonly publicKey: Uint8Array
    readonly commitment: Uint8Array
    readonly index: number
    readonly digest: Uint8Array
    readonly adaptorSignature: Uint8Array
    readonly secret: Uint8Array
  }): JointSignerResult<{
    readonly signature: Uint8Array
    readonly recovery: 0 | 1
  }>
  extractCommitmentLockSecret(input: {
    readonly publicKey: Uint8Array
    readonly commitment: Uint8Array
    readonly index: number
    readonly digest: Uint8Array
    readonly adaptorSignature: Uint8Array
    readonly completedSignature: Uint8Array
  }): JointSignerResult<Uint8Array>
}

interface OptionalFeatures {
  readonly tweak?: TweakFeature
  readonly keygenSessions?: KeygenSessionFeature
}

/** A backend with adaptor pre-signing. */
export interface LockingJointSigner extends JointSignerCore, OptionalFeatures {
  readonly capabilities: JointSignerCapabilities & {
    readonly adaptorLocks: true
  }
  readonly locks: LockFeature
}

/** A backend without it: there is nothing to call. */
export interface PlainJointSigner extends JointSignerCore, OptionalFeatures {
  readonly capabilities: JointSignerCapabilities & {
    readonly adaptorLocks: false
  }
  readonly locks?: undefined
}

/**
 * What the game layer holds. Before pre-signing, narrow with
 * `signer.locks !== undefined` (TypeScript does not narrow on the nested
 * `capabilities.adaptorLocks` flag, which always agrees with it).
 */
export type JointSigner = LockingJointSigner | PlainJointSigner
