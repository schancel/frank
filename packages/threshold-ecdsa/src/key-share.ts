/**
 * A party's long-lived output of key generation, and its serialization.
 *
 * The joint private key is `x = x_A * x_B mod n` (Lindell 2017 uses
 * multiplicative shares) and the joint public key is `X = x * G`. Each party
 * holds its own share, its own Paillier key, and the other party's verified
 * Paillier modulus and encryption of the other party's share. Because BOTH
 * directions are set up, either party can be the one that decrypts in a
 * signing session.
 */
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

export interface KeyShareInternal extends KeyShare {
  /** Set to true by a failed signing decryption or `destroyKeyShare`. */
  burned: boolean
  readonly localIsInitiator: boolean
  /** Binding of the key-generation session that produced this share. */
  readonly keygenSession: Uint8Array
  readonly localId: Uint8Array
  readonly peerId: Uint8Array
  readonly localPoint: Uint8Array
  readonly peerPoint: Uint8Array
  readonly publicKey: Uint8Array
  readonly localModulus: Uint8Array
  readonly localCiphertext: Uint8Array
  readonly peerModulus: Uint8Array
  readonly peerCiphertext: Uint8Array
  readonly keyId: Uint8Array
  /** Secret: this party's multiplicative share, 32 bytes big-endian. */
  readonly secretShare: Uint8Array
  /** Secret: this party's Paillier primes, 128 bytes each. */
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
  readonly burned: boolean
}

/** `keccak256(uncompressed public key without the 04 prefix)[12..32]`. */
export function addressOfPoint(publicKey: Uint8Array): Uint8Array {
  const uncompressed = parsePoint(publicKey).toRawBytes(false)
  return keccak_256(uncompressed.subarray(1)).slice(12)
}

/**
 * Identifier both parties compute independently. It covers every value the
 * two key-generation runs exchanged, so two shares with equal ids agree on
 * the public key, both moduli and both encrypted shares.
 */
export function computeKeyId(share: {
  readonly localIsInitiator: boolean
  readonly keygenSession: Uint8Array
  readonly localId: Uint8Array
  readonly peerId: Uint8Array
  readonly localPoint: Uint8Array
  readonly peerPoint: Uint8Array
  readonly localModulus: Uint8Array
  readonly localCiphertext: Uint8Array
  readonly peerModulus: Uint8Array
  readonly peerCiphertext: Uint8Array
}): Uint8Array {
  const local = [
    share.localId,
    share.localPoint,
    share.localModulus,
    share.localCiphertext,
  ]
  const peer = [
    share.peerId,
    share.peerPoint,
    share.peerModulus,
    share.peerCiphertext,
  ]
  const [first, second] = share.localIsInitiator ? [local, peer] : [peer, local]
  return transcript('key-id', share.keygenSession, ...first, ...second)
}

// --- Deterministic derivation from a seed ----------------------------------

/**
 * This party's share derived from a 32-byte seed: 512 hash bits over the
 * seed, the key-generation session binding and the party's identity, reduced
 * into `[SHARE_LOW, SHARE_HIGH)`. A new key-generation session id therefore
 * always yields a new share.
 */
export function deriveShare(
  seed: Uint8Array,
  keygenSession: Uint8Array,
  localId: Uint8Array,
): bigint {
  const high = transcript('seed/share/1', seed, keygenSession, localId)
  const low = transcript('seed/share/0', seed, keygenSession, localId)
  const wide = concat(high, low)
  const share = SHARE_LOW + (bytesToInt(wide) % SHARE_LOW)
  wipe(high, low, wide)
  return share
}

/** This party's Paillier key derived from the same seed and context. */
export function derivePaillierKey(
  seed: Uint8Array,
  keygenSession: Uint8Array,
  localId: Uint8Array,
): PaillierSecretKey {
  const streamSeed = transcript('seed/paillier', seed, keygenSession, localId)
  const key = generatePaillierKey(
    deterministicStream(`${TAG_PREFIX}seed/paillier-stream`, streamSeed),
  )
  streamSeed.fill(0)
  return key
}

// --- Serialization ---------------------------------------------------------

const SHARE_MAGIC = asciiBytes('FTEK')
const RECORD_MAGIC = asciiBytes('FTER')
const FORMAT_VERSION = 1
const PUBLIC_FIXED_BYTES =
  HASH_BYTES +
  3 * POINT_BYTES +
  2 * (MODULUS_BYTES + CIPHERTEXT_BYTES) +
  HASH_BYTES
const SECRET_BYTES = SCALAR_BYTES + 2 * PRIME_BYTES
const MIN_PUBLIC_BYTES = 4 + 2 + 2 + 2 * MIN_IDENTITY_BYTES + PUBLIC_FIXED_BYTES
const MAX_PUBLIC_BYTES = 4 + 2 + 2 + 2 * MAX_IDENTITY_BYTES + PUBLIC_FIXED_BYTES

function publicFields(share: KeyShareInternal): Uint8Array {
  return concat(
    Uint8Array.of(FORMAT_VERSION, share.localIsInitiator ? 1 : 0),
    Uint8Array.of(share.localId.length),
    share.localId,
    Uint8Array.of(share.peerId.length),
    share.peerId,
    share.keygenSession,
    share.localPoint,
    share.peerPoint,
    share.publicKey,
    share.localModulus,
    share.localCiphertext,
    share.peerModulus,
    share.peerCiphertext,
    share.keyId,
  )
}

type PublicFields = Omit<
  KeyShareInternal,
  '__thresholdEcdsa' | 'burned' | 'secretShare' | 'primeP' | 'primeQ'
>

function readIdentity(reader: Reader): Uint8Array {
  const length = reader.byte()
  if (length < MIN_IDENTITY_BYTES || length > MAX_IDENTITY_BYTES) {
    fail('invalid-key-share')
  }
  return reader.take(length)
}

function readPublicFields(reader: Reader): PublicFields {
  if (reader.byte() !== FORMAT_VERSION) fail('invalid-key-share')
  const flag = reader.byte()
  if (flag !== 0 && flag !== 1) fail('invalid-key-share')
  const localId = readIdentity(reader)
  const peerId = readIdentity(reader)
  return {
    localIsInitiator: flag === 1,
    localId,
    peerId,
    keygenSession: reader.take(HASH_BYTES),
    localPoint: reader.take(POINT_BYTES),
    peerPoint: reader.take(POINT_BYTES),
    publicKey: reader.take(POINT_BYTES),
    localModulus: reader.take(MODULUS_BYTES),
    localCiphertext: reader.take(CIPHERTEXT_BYTES),
    peerModulus: reader.take(MODULUS_BYTES),
    peerCiphertext: reader.take(CIPHERTEXT_BYTES),
    keyId: reader.take(HASH_BYTES),
  }
}

/**
 * Assembles a key share and checks every relation that can be checked
 * locally. Takes ownership of the secret arrays. Used by key generation,
 * import and restore, so a share object always satisfies these invariants:
 *
 *  - the share is in `[SHARE_LOW, SHARE_HIGH)` and matches `localPoint`;
 *  - `publicKey = share * peerPoint`;
 *  - the primes form a valid Paillier key whose modulus is `localModulus`;
 *  - `localCiphertext` decrypts to the share;
 *  - the peer's modulus and ciphertext are well-formed;
 *  - `keyId` is the hash of all of the above.
 */
export function assembleKeyShare(
  fields: PublicFields,
  secretShare: Uint8Array,
  primeP: Uint8Array,
  primeQ: Uint8Array,
): KeyShareInternal {
  try {
    if (equalBytes(fields.localId, fields.peerId)) fail('invalid-key-share')
    const share = bytesToInt(secretShare)
    if (share < SHARE_LOW || share >= SHARE_HIGH) fail('invalid-key-share')
    if (!equalBytes(pointBytes(multiply(G, share)), fields.localPoint)) {
      fail('invalid-key-share')
    }
    const joint = multiply(parsePoint(fields.peerPoint), share)
    if (!equalBytes(pointBytes(joint), fields.publicKey)) {
      fail('invalid-key-share')
    }
    const paillier = paillierSecretKey(bytesToInt(primeP), bytesToInt(primeQ))
    if (
      !equalBytes(intToBytes(paillier.n, MODULUS_BYTES), fields.localModulus)
    ) {
      fail('invalid-key-share')
    }
    const own = parseCiphertext(paillier, fields.localCiphertext)
    if (decrypt(paillier, own) !== share) fail('invalid-key-share')
    const peerKey = parseModulus(fields.peerModulus)
    if (hasSmallPrimeFactor(peerKey.n)) fail('invalid-key-share')
    parseCiphertext(peerKey, fields.peerCiphertext)
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
    return fail('invalid-key-share')
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

/** Marks a share unusable and wipes its secrets. Irreversible. */
export function burnShare(share: KeyShareInternal): void {
  share.burned = true
  wipe(share.secretShare, share.primeP, share.primeQ)
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
      burned: internal.burned,
    })
  } catch (error) {
    return failure(failureCode(error))
  }
}

/**
 * Wipes a share's secrets and makes the handle unusable. Call it when the
 * escrow is closed. It cannot erase copies made by `exportKeyShare`.
 */
export function destroyKeyShare(share: KeyShare): ThresholdResult<true> {
  try {
    burnShare(internalShare(share))
    return success(true as const)
  } catch (error) {
    return failure(failureCode(error))
  }
}

/**
 * Serializes a share INCLUDING its secrets. The caller must store the result
 * encrypted and must delete it if the share is ever burned.
 */
export function exportKeyShare(share: KeyShare): ThresholdResult<Uint8Array> {
  try {
    const internal = internalShare(share)
    if (internal.burned) return failure('key-share-burned')
    return success(
      concat(
        SHARE_MAGIC,
        publicFields(internal),
        internal.secretShare,
        internal.primeP,
        internal.primeQ,
      ),
    )
  } catch (error) {
    return failure(failureCode(error))
  }
}

export function importKeyShare(bytes: Uint8Array): ThresholdResult<KeyShare> {
  const copied = snapshotBounded(
    bytes,
    MIN_PUBLIC_BYTES + SECRET_BYTES,
    MAX_PUBLIC_BYTES + SECRET_BYTES,
  )
  if (copied === null) return failure('invalid-key-share')
  try {
    const reader = new Reader(copied)
    if (!equalBytes(reader.take(4), SHARE_MAGIC)) fail('invalid-key-share')
    const fields = readPublicFields(reader)
    const secretShare = reader.take(SCALAR_BYTES)
    const primeP = reader.take(PRIME_BYTES)
    const primeQ = reader.take(PRIME_BYTES)
    reader.finish()
    return success(assembleKeyShare(fields, secretShare, primeP, primeQ))
  } catch {
    return failure('invalid-key-share')
  } finally {
    copied.fill(0)
  }
}

/**
 * Serializes only the PUBLIC part of a share: identities, points, moduli,
 * encrypted shares and the key id. Together with the seed passed to key
 * generation it is enough to rebuild the share with `restoreKeyShare`.
 */
export function exportKeyShareRecord(
  share: KeyShare,
): ThresholdResult<Uint8Array> {
  try {
    const internal = internalShare(share)
    return success(concat(RECORD_MAGIC, publicFields(internal)))
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
 * Rebuilds a share from the key-generation seed and the public record,
 * re-deriving the secret share and the Paillier primes (about as slow as
 * Paillier key generation). Fails unless the derived values match the record.
 */
export function restoreKeyShare(
  input: RestoreKeyShareInput,
): ThresholdResult<KeyShare> {
  let seed: Uint8Array | null = null
  try {
    seed = snapshot(input.secretSeed, 32)
    const record = snapshotBounded(
      input.record,
      MIN_PUBLIC_BYTES,
      MAX_PUBLIC_BYTES,
    )
    if (seed === null) return failure('invalid-input')
    if (record === null) return failure('invalid-key-share')
    const reader = new Reader(record)
    if (!equalBytes(reader.take(4), RECORD_MAGIC)) fail('invalid-key-share')
    const fields = readPublicFields(reader)
    reader.finish()
    const share = deriveShare(seed, fields.keygenSession, fields.localId)
    const paillier = derivePaillierKey(
      seed,
      fields.keygenSession,
      fields.localId,
    )
    return success(
      assembleKeyShare(
        fields,
        intToBytes(share, SCALAR_BYTES),
        intToBytes(paillier.p, PRIME_BYTES),
        intToBytes(paillier.q, PRIME_BYTES),
      ),
    )
  } catch {
    return failure('invalid-key-share')
  } finally {
    seed?.fill(0)
  }
}
