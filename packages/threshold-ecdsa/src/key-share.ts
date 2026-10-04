/**
 * A party's long-lived output of key generation, and its serialization.
 *
 * Roles are fixed for the life of a key, exactly as in Lindell 2017. The
 * key-generation initiator is the paper's P1: it owns the Paillier key, holds
 * a share x1 in [n/3, 2n/3), and is the initiator (the decrypting party) of
 * every signing session. The responder is P2: it holds x2 in [1, n) and P1's
 * verified modulus and encrypted share. The joint private key is
 * `x1 * x2 mod n`.
 */
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { keccak_256 } from '@noble/hashes/sha3.js'

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
import { hasSmallPrimeFactor } from './bigint.js'
import {
  CURVE_ORDER,
  G,
  HASH_BYTES,
  multiply,
  parsePoint,
  pointBytes,
  POINT_BYTES,
  SCALAR_BYTES,
  SHARE_HIGH,
  SHARE_LOW,
  TAG_PREFIX,
  transcript,
} from './group.js'
import {
  CIPHERTEXT_BYTES,
  decrypt,
  generatePaillierKey,
  MODULUS_BYTES,
  paillierSecretKey,
  parseCiphertext,
  parseModulus,
  PRIME_BYTES,
  type PaillierSecretKey,
} from './paillier.js'
import { deterministicStream } from './rng.js'
import {
  fail,
  failure,
  failureCode,
  success,
  type ThresholdResult,
} from './result.js'
import { MAX_IDENTITY_BYTES, MIN_IDENTITY_BYTES } from './wire.js'

/** Opaque handle. Create with key generation, `importKeyShare` or `restoreKeyShare`. */
export interface KeyShare {
  readonly __thresholdEcdsa: 'key-share'
}

export type KeyRole = 'initiator' | 'responder'

export interface KeyShareInternal extends KeyShare {
  /** Set to true by a failed signing decryption or `destroyKeyShare`. */
  burned: boolean
  readonly role: KeyRole
  /** Binding of the key-generation session that produced this share. */
  readonly keygenSession: Uint8Array
  /** Context the share (and Paillier key) is derived from when seeded. */
  readonly shareContext: Uint8Array
  readonly localId: Uint8Array
  readonly peerId: Uint8Array
  readonly localPoint: Uint8Array
  readonly peerPoint: Uint8Array
  readonly publicKey: Uint8Array
  /** The initiator's Paillier modulus N. */
  readonly modulus: Uint8Array
  /** `c_key = Enc_N(x1)`, the initiator's encrypted share. */
  readonly ciphertext: Uint8Array
  readonly keyId: Uint8Array
  /** Secret: this party's multiplicative share, 32 bytes big-endian. */
  readonly secretShare: Uint8Array
  /** Secret, initiator only (empty for the responder): the Paillier primes. */
  readonly primeP: Uint8Array
  readonly primeQ: Uint8Array
}

export interface KeyShareInfo {
  /** 32-byte identifier of the key and all key-generation material. */
  readonly keyId: Uint8Array
  /** 33-byte compressed joint public key. */
  readonly publicKey: Uint8Array
  /** 20-byte EVM address of the joint public key. */
  readonly address: Uint8Array
  readonly localId: Uint8Array
  readonly peerId: Uint8Array
  /** This party's fixed role in every signing session of this key. */
  readonly role: KeyRole
  readonly burned: boolean
}

/** `keccak256(uncompressed public key without the 04 prefix)[12..32]`. */
export function addressOfPoint(publicKey: Uint8Array): Uint8Array {
  const uncompressed = parsePoint(publicKey).toRawBytes(false)
  return keccak_256(uncompressed.subarray(1)).slice(12)
}

type PublicFields = Omit<
  KeyShareInternal,
  '__thresholdEcdsa' | 'burned' | 'secretShare' | 'primeP' | 'primeQ'
>

/**
 * Identifier both parties compute independently. It covers every public
 * value of key generation, so two shares with equal ids agree on the public
 * key, the modulus and the encrypted share. It is NOT an integrity check on
 * stored data (anyone can recompute it); the storage MAC below is.
 */
export function computeKeyId(
  share: Omit<PublicFields, 'keyId' | 'shareContext'>,
): Uint8Array {
  const local = [share.localId, share.localPoint]
  const peer = [share.peerId, share.peerPoint]
  const [first, second] =
    share.role === 'initiator' ? [local, peer] : [peer, local]
  return transcript(
    'key-id',
    share.keygenSession,
    ...first,
    ...second,
    share.modulus,
    share.ciphertext,
  )
}

// --- Burned shares -----------------------------------------------------------
//
// A share that was burned (Lindell 2017 abort rule) must never sign again,
// whichever handle or stored copy it is reached through. This set, keyed by
// the party's public share point, makes that hold for the life of the
// process. It is the only module-level state in the package, and it cannot
// outlive the process: the caller must still record burns durably.

const BURNED_POINTS = new Set<string>()

function pointKey(localPoint: Uint8Array): string {
  return Array.from(localPoint, byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

export function isBurnedPoint(localPoint: Uint8Array): boolean {
  return BURNED_POINTS.has(pointKey(localPoint))
}

/** Test support only; not exported from the package. */
export function forgetBurnedSharesForTests(): void {
  BURNED_POINTS.clear()
}

// --- Deterministic derivation from a seed ----------------------------------

/**
 * Context a seeded share is derived from: the key-generation session id and
 * both identities (inside `frameBinding`), 32 bytes of this party's own fresh
 * randomness, and its identity. Because the local salt is fresh in every key
 * generation, the other party cannot make this party derive the same share
 * (or Paillier key) twice by repeating a session id.
 */
export function shareContextOf(
  frameBinding: Uint8Array,
  localSalt: Uint8Array,
  localId: Uint8Array,
): Uint8Array {
  return transcript('seed/context', frameBinding, localSalt, localId)
}

/**
 * A share derived from a 32-byte seed and a share context: 512 hash bits
 * reduced into `[SHARE_LOW, SHARE_HIGH)` for the initiator (Protocol 3.1
 * step 1) or `[1, n)` for the responder.
 */
export function deriveShare(
  seed: Uint8Array,
  shareContext: Uint8Array,
  role: KeyRole,
): bigint {
  const high = transcript('seed/share/1', seed, shareContext)
  const low = transcript('seed/share/0', seed, shareContext)
  const wide = concat(high, low)
  const value = bytesToInt(wide)
  const share =
    role === 'initiator'
      ? SHARE_LOW + (value % SHARE_LOW)
      : 1n + (value % (CURVE_ORDER - 1n))
  wipe(high, low, wide)
  return share
}

/** The initiator's Paillier key derived from the same seed and context. */
export function derivePaillierKey(
  seed: Uint8Array,
  shareContext: Uint8Array,
): PaillierSecretKey {
  const streamSeed = transcript('seed/paillier', seed, shareContext)
  const key = generatePaillierKey(
    deterministicStream(`${TAG_PREFIX}seed/paillier-stream`, streamSeed),
  )
  streamSeed.fill(0)
  return key
}

// --- Serialization ---------------------------------------------------------
//
//   share  = "FTEK" || body || x (32) || [p (128) || q (128)] || mac (32)
//   record = "FTER" || body || mac (32)
//   body   = version || role || len || localId || len || peerId
//            || keygenSession || shareContext || localPoint || peerPoint
//            || publicKey || modulus || ciphertext || keyId
//   mac    = HMAC-SHA256(H("storage-mac-key", x), everything before the mac)
//
// The MAC is what makes stored bytes trustworthy. The responder's stored
// `ciphertext` is used in every signature; an attacker who could replace it
// (say with an encryption of x1 + 2^1200 * n) and fix up the unkeyed key id
// would read the responder's share out of a single signature. The MAC key is
// derived from the secret share, which the record does not contain and which
// `restoreKeyShare` re-derives from the seed, so only the owner can produce
// or accept a record.

const SHARE_MAGIC = asciiBytes('FTEK')
const RECORD_MAGIC = asciiBytes('FTER')
const FORMAT_VERSION = 2
const MAC_BYTES = 32
const BODY_FIXED_BYTES =
  2 +
  2 +
  2 * HASH_BYTES +
  3 * POINT_BYTES +
  MODULUS_BYTES +
  CIPHERTEXT_BYTES +
  HASH_BYTES
const MIN_BODY_BYTES = BODY_FIXED_BYTES + 2 * MIN_IDENTITY_BYTES
const MAX_BODY_BYTES = BODY_FIXED_BYTES + 2 * MAX_IDENTITY_BYTES

function bodyOf(share: PublicFields): Uint8Array {
  return concat(
    Uint8Array.of(FORMAT_VERSION, share.role === 'initiator' ? 1 : 0),
    Uint8Array.of(share.localId.length),
    share.localId,
    Uint8Array.of(share.peerId.length),
    share.peerId,
    share.keygenSession,
    share.shareContext,
    share.localPoint,
    share.peerPoint,
    share.publicKey,
    share.modulus,
    share.ciphertext,
    share.keyId,
  )
}

function readIdentity(reader: Reader): Uint8Array {
  const length = reader.byte()
  if (length < MIN_IDENTITY_BYTES || length > MAX_IDENTITY_BYTES) {
    fail('invalid-key-share')
  }
  return reader.take(length)
}

function readBody(reader: Reader): PublicFields {
  if (reader.byte() !== FORMAT_VERSION) fail('invalid-key-share')
  const flag = reader.byte()
  if (flag !== 0 && flag !== 1) fail('invalid-key-share')
  const localId = readIdentity(reader)
  const peerId = readIdentity(reader)
  return {
    role: flag === 1 ? 'initiator' : 'responder',
    localId,
    peerId,
    keygenSession: reader.take(HASH_BYTES),
    shareContext: reader.take(HASH_BYTES),
    localPoint: reader.take(POINT_BYTES),
    peerPoint: reader.take(POINT_BYTES),
    publicKey: reader.take(POINT_BYTES),
    modulus: reader.take(MODULUS_BYTES),
    ciphertext: reader.take(CIPHERTEXT_BYTES),
    keyId: reader.take(HASH_BYTES),
  }
}

export function storageMac(
  secretShare: Uint8Array,
  data: Uint8Array,
): Uint8Array {
  const key = transcript('storage-mac-key', secretShare)
  const mac = hmac(sha256, key, data)
  key.fill(0)
  return mac
}

/**
 * Assembles a key share and checks every relation that can be checked
 * locally. Takes ownership of the secret arrays. Used by key generation,
 * import and restore, so a share object always satisfies these invariants:
 *
 *  - the share is in its role's range and matches `localPoint`;
 *  - `publicKey = share * peerPoint`;
 *  - initiator: the primes form a valid Paillier key with modulus `modulus`
 *    and `ciphertext` decrypts to the share;
 *  - responder: the modulus and ciphertext are well-formed (they were proven
 *    correct in key generation; stored copies are protected by the MAC);
 *  - `keyId` is the hash of all of the above;
 *  - the share was not burned earlier in this process.
 */
export function assembleKeyShare(
  fields: PublicFields,
  secretShare: Uint8Array,
  primeP: Uint8Array,
  primeQ: Uint8Array,
): KeyShareInternal {
  let burned = false
  try {
    if (isBurnedPoint(fields.localPoint)) {
      burned = true
      fail('key-share-burned')
    }
    if (equalBytes(fields.localId, fields.peerId)) fail('invalid-key-share')
    const share = bytesToInt(secretShare)
    if (!equalBytes(pointBytes(multiply(G, share)), fields.localPoint)) {
      fail('invalid-key-share')
    }
    const joint = multiply(parsePoint(fields.peerPoint), share)
    if (!equalBytes(pointBytes(joint), fields.publicKey)) {
      fail('invalid-key-share')
    }
    if (fields.role === 'initiator') {
      if (share < SHARE_LOW || share >= SHARE_HIGH) fail('invalid-key-share')
      const paillier = paillierSecretKey(bytesToInt(primeP), bytesToInt(primeQ))
      if (!equalBytes(intToBytes(paillier.n, MODULUS_BYTES), fields.modulus)) {
        fail('invalid-key-share')
      }
      const own = parseCiphertext(paillier, fields.ciphertext)
      if (decrypt(paillier, own) !== share) fail('invalid-key-share')
    } else {
      if (primeP.length !== 0 || primeQ.length !== 0) fail('invalid-key-share')
      const peerKey = parseModulus(fields.modulus)
      if (hasSmallPrimeFactor(peerKey.n)) fail('invalid-key-share')
      parseCiphertext(peerKey, fields.ciphertext)
    }
    if (!equalBytes(computeKeyId(fields), fields.keyId)) {
      fail('invalid-key-share')
    }
    return {
      __thresholdEcdsa: 'key-share',
      burned: false,
      ...fields,
      secretShare,
      primeP,
      primeQ,
    }
  } catch {
    wipe(secretShare, primeP, primeQ)
    return fail(burned ? 'key-share-burned' : 'invalid-key-share')
  }
}

export function internalShare(share: KeyShare): KeyShareInternal {
  const internal = share as KeyShareInternal
  if (
    typeof internal !== 'object' ||
    internal === null ||
    internal.__thresholdEcdsa !== 'key-share' ||
    typeof internal.burned !== 'boolean'
  ) {
    fail('invalid-input')
  }
  return internal
}

/**
 * Burns a share: wipes its secrets, marks this handle unusable, and records
 * its public share point so that no other handle or stored copy of the same
 * share can be used in this process. Irreversible.
 */
export function burnShare(share: KeyShareInternal): void {
  BURNED_POINTS.add(pointKey(share.localPoint))
  share.burned = true
  wipe(share.secretShare, share.primeP, share.primeQ)
}

/** True if this handle, or any other handle of the same share, was burned. */
export function shareIsBurned(share: KeyShareInternal): boolean {
  return share.burned || isBurnedPoint(share.localPoint)
}

export function describeKeyShare(
  share: KeyShare,
): ThresholdResult<KeyShareInfo> {
  try {
    const internal = internalShare(share)
    return success({
      keyId: internal.keyId.slice(),
      publicKey: internal.publicKey.slice(),
      address: addressOfPoint(internal.publicKey),
      localId: internal.localId.slice(),
      peerId: internal.peerId.slice(),
      role: internal.role,
      burned: shareIsBurned(internal),
    })
  } catch (error) {
    return failure(failureCode(error))
  }
}

/**
 * Wipes a share's secrets and makes this handle unusable. Call it when the
 * escrow is closed. It cannot erase copies made by `exportKeyShare`.
 */
export function destroyKeyShare(share: KeyShare): ThresholdResult<true> {
  try {
    const internal = internalShare(share)
    internal.burned = true
    wipe(internal.secretShare, internal.primeP, internal.primeQ)
    return success(true as const)
  } catch (error) {
    return failure(failureCode(error))
  }
}

/**
 * Serializes a share INCLUDING its secrets, with an integrity MAC. The caller
 * must store the result encrypted and must delete it if the share is ever
 * burned.
 */
export function exportKeyShare(share: KeyShare): ThresholdResult<Uint8Array> {
  try {
    const internal = internalShare(share)
    if (shareIsBurned(internal)) return failure('key-share-burned')
    const data = concat(
      SHARE_MAGIC,
      bodyOf(internal),
      internal.secretShare,
      internal.primeP,
      internal.primeQ,
    )
    return success(concat(data, storageMac(internal.secretShare, data)))
  } catch (error) {
    return failure(failureCode(error))
  }
}

function storedFailure<T>(error: unknown): ThresholdResult<T> {
  return failure(
    failureCode(error) === 'key-share-burned'
      ? 'key-share-burned'
      : 'invalid-key-share',
  )
}

/** Rebuilds a share from `exportKeyShare` output after verifying its MAC. */
export function importKeyShare(bytes: Uint8Array): ThresholdResult<KeyShare> {
  const copied = snapshotBounded(
    bytes,
    4 + MIN_BODY_BYTES + SCALAR_BYTES + MAC_BYTES,
    4 + MAX_BODY_BYTES + SCALAR_BYTES + 2 * PRIME_BYTES + MAC_BYTES,
  )
  if (copied === null) return failure('invalid-key-share')
  try {
    const data = copied.subarray(0, copied.length - MAC_BYTES)
    const reader = new Reader(data)
    if (!equalBytes(reader.take(4), SHARE_MAGIC)) fail('invalid-key-share')
    const fields = readBody(reader)
    const secretShare = reader.take(SCALAR_BYTES)
    const isInitiator = fields.role === 'initiator'
    const primeP = reader.take(isInitiator ? PRIME_BYTES : 0)
    const primeQ = reader.take(isInitiator ? PRIME_BYTES : 0)
    reader.finish()
    // Integrity first: nothing below is trusted until the MAC verifies.
    const mac = storageMac(secretShare, data)
    if (!equalBytes(mac, copied.subarray(copied.length - MAC_BYTES))) {
      wipe(secretShare, primeP, primeQ)
      fail('invalid-key-share')
    }
    return success(assembleKeyShare(fields, secretShare, primeP, primeQ))
  } catch (error) {
    return storedFailure(error)
  } finally {
    copied.fill(0)
  }
}

/**
 * Serializes the PUBLIC part of a share with an integrity MAC. Together with
 * the seed passed to key generation it is enough to rebuild the share with
 * `restoreKeyShare`. The record holds no secret, but its integrity is
 * critical: see the MAC note above. Only meaningful for a share created with
 * `secretSeed`.
 */
export function exportKeyShareRecord(
  share: KeyShare,
): ThresholdResult<Uint8Array> {
  try {
    const internal = internalShare(share)
    if (shareIsBurned(internal)) return failure('key-share-burned')
    const data = concat(RECORD_MAGIC, bodyOf(internal))
    return success(concat(data, storageMac(internal.secretShare, data)))
  } catch (error) {
    return failure(failureCode(error))
  }
}

export interface RestoreKeyShareInput {
  /** The 32-byte seed that was passed to `startKeygen` as `secretSeed`. */
  readonly secretSeed: Uint8Array
  /** Output of `exportKeyShareRecord`. */
  readonly record: Uint8Array
}

/**
 * Rebuilds a share from the key-generation seed and the public record. The
 * share is re-derived from the seed, the record's MAC is verified under a key
 * derived from that share BEFORE any other field is used, and only then are
 * the Paillier primes re-derived (initiator; about as slow as Paillier key
 * generation) and the share assembled.
 */
export function restoreKeyShare(
  input: RestoreKeyShareInput,
): ThresholdResult<KeyShare> {
  let seed: Uint8Array | null = null
  let secretShare: Uint8Array | null = null
  try {
    seed = snapshot(input.secretSeed, 32)
    const record = snapshotBounded(
      input.record,
      4 + MIN_BODY_BYTES + MAC_BYTES,
      4 + MAX_BODY_BYTES + MAC_BYTES,
    )
    if (seed === null) return failure('invalid-input')
    if (record === null) return failure('invalid-key-share')
    const data = record.subarray(0, record.length - MAC_BYTES)
    const reader = new Reader(data)
    if (!equalBytes(reader.take(4), RECORD_MAGIC)) fail('invalid-key-share')
    const fields = readBody(reader)
    reader.finish()
    secretShare = intToBytes(
      deriveShare(seed, fields.shareContext, fields.role),
      SCALAR_BYTES,
    )
    const mac = storageMac(secretShare, data)
    if (!equalBytes(mac, record.subarray(record.length - MAC_BYTES))) {
      fail('invalid-key-share')
    }
    let primeP: Uint8Array = new Uint8Array(0)
    let primeQ: Uint8Array = new Uint8Array(0)
    if (fields.role === 'initiator') {
      const paillier = derivePaillierKey(seed, fields.shareContext)
      primeP = intToBytes(paillier.p, PRIME_BYTES)
      primeQ = intToBytes(paillier.q, PRIME_BYTES)
    }
    const share = assembleKeyShare(fields, secretShare, primeP, primeQ)
    secretShare = null
    return success(share)
  } catch (error) {
    return storedFailure(error)
  } finally {
    wipe(seed, secretShare)
  }
}
