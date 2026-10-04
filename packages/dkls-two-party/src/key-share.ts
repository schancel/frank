/**
 * A party's share of a joint key together with its half of the pairwise
 * setup (the base-OT outputs in both directions).
 *
 * The handle the caller holds is opaque; the data lives in a module-private
 * `WeakMap`. Three ways a share stops working:
 *
 *  - DESTROYED: this handle was wiped by the caller. Other handles and stored
 *    copies of the same share are unaffected.
 *  - BURNED: a cryptographic check failed in a signing session. The share id
 *    enters a process-wide set consulted by every step of every session and
 *    by import, so every handle and stored copy is refused for the rest of
 *    the process. Across restarts only the caller's durable record can do
 *    that (README, caller rules).
 *
 * Stored form. The export is secret AND integrity-critical: an attacker who
 * can write (but not read) storage must not be able to swap seeds, the peer's
 * public share or the identities. The bytes end in an HMAC keyed from the
 * secret share, and import verifies it before anything else is parsed.
 */
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha256.js'

import {
  asciiBytes,
  bytesToInt,
  concat,
  equalBytes,
  Reader,
  snapshotBounded,
  variable,
  wipe,
} from './bytes.js'
import { BASE_OT_COUNT, CHOICE_BYTES } from './base-ot.js'
import {
  CURVE_ORDER,
  evmAddress,
  G,
  HASH_BYTES,
  multiply,
  parsePoint,
  POINT_BYTES,
  SCALAR_BYTES,
  transcript,
} from './group.js'
import { fail, failure, failureCode, success, type DklsResult } from './result.js'
import { MAX_IDENTITY_BYTES, MIN_IDENTITY_BYTES, type RoleName } from './wire.js'

const SEEDS_BYTES = BASE_OT_COUNT * HASH_BYTES
const SEED_PAIRS_BYTES = 2 * SEEDS_BYTES
const MAGIC = asciiBytes('FDKS')
const VERSION = 1
const MAC_BYTES = 32
const SECRET_OFFSET = MAGIC.length + 1
const MAX_EXPORT_BYTES = 16384

export interface InternalShare {
  readonly keyId: Uint8Array
  readonly localId: Uint8Array
  readonly peerId: Uint8Array
  /** The role this party had in key generation. Signing roles are free. */
  readonly keygenRole: RoleName
  /** SECRET additive share x_i, 32 bytes. */
  readonly secret: Uint8Array
  readonly publicShare: Uint8Array
  readonly peerPublicShare: Uint8Array
  readonly publicKey: Uint8Array
  readonly address: Uint8Array
  /** SECRET base-OT choice bits: this party's Delta as extension sender. */
  readonly delta: Uint8Array
  /** SECRET one seed per base OT, selected by `delta`. */
  readonly seeds: Uint8Array
  /** SECRET both seeds per base OT: this party as extension receiver. */
  readonly seedPairs: Uint8Array
  destroyed: boolean
}

/** Opaque handle. */
export interface KeyShare {
  readonly __dklsTwoParty: 'key-share'
}

const shares = new WeakMap<KeyShare, InternalShare>()

/**
 * The package's only module-level state: ids of burned shares. Keyed by key
 * id AND local identity so that, when both parties of a key run in one
 * process (tests), burning one party's share does not burn the other's.
 */
const burned = new Set<string>()

function shareTag(keyId: Uint8Array, localId: Uint8Array): string {
  return Array.from(transcript('burn/tag', keyId, localId), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

export function wrapShare(internal: InternalShare): KeyShare {
  const handle: KeyShare = Object.freeze({ __dklsTwoParty: 'key-share' })
  shares.set(handle, internal)
  return handle
}

export function internalShare(share: unknown): InternalShare {
  const internal =
    typeof share === 'object' && share !== null
      ? shares.get(share as KeyShare)
      : undefined
  if (internal === undefined) return fail('invalid-input')
  return internal
}

export function shareIsBurned(internal: InternalShare): boolean {
  return burned.has(shareTag(internal.keyId, internal.localId))
}

/** A share that may sign: neither destroyed nor burned. */
export function usableShare(share: unknown): InternalShare {
  const internal = internalShare(share)
  if (internal.destroyed || shareIsBurned(internal)) fail('key-burned')
  return internal
}

function wipeShare(internal: InternalShare): void {
  wipe(internal.secret, internal.delta, internal.seeds, internal.seedPairs)
  internal.destroyed = true
}

/** Burns the share: process-wide, every handle and stored copy. */
export function burnShare(internal: InternalShare): void {
  burned.add(shareTag(internal.keyId, internal.localId))
  wipeShare(internal)
}

/** Builds the derived fields and checks the share against its public parts. */
export function assembleShare(input: {
  readonly keyId: Uint8Array
  readonly localId: Uint8Array
  readonly peerId: Uint8Array
  readonly keygenRole: RoleName
  readonly secret: Uint8Array
  readonly publicShare: Uint8Array
  readonly peerPublicShare: Uint8Array
  readonly delta: Uint8Array
  readonly seeds: Uint8Array
  readonly seedPairs: Uint8Array
}): InternalShare {
  if (
    input.keyId.length !== HASH_BYTES ||
    input.secret.length !== SCALAR_BYTES ||
    input.delta.length !== CHOICE_BYTES ||
    input.seeds.length !== SEEDS_BYTES ||
    input.seedPairs.length !== SEED_PAIRS_BYTES ||
    input.localId.length < MIN_IDENTITY_BYTES ||
    input.localId.length > MAX_IDENTITY_BYTES ||
    input.peerId.length < MIN_IDENTITY_BYTES ||
    input.peerId.length > MAX_IDENTITY_BYTES ||
    equalBytes(input.localId, input.peerId)
  ) {
    fail('invalid-key-share')
  }
  const secret = bytesToInt(input.secret)
  if (secret === 0n || secret >= CURVE_ORDER) fail('invalid-key-share')
  const own = parsePoint(input.publicShare)
  const peer = parsePoint(input.peerPublicShare)
  if (!multiply(G, secret).equals(own)) fail('invalid-key-share')
  const joint = own.add(peer)
  try {
    joint.assertValidity()
  } catch {
    return fail('invalid-key-share')
  }
  return {
    keyId: input.keyId.slice(),
    localId: input.localId.slice(),
    peerId: input.peerId.slice(),
    keygenRole: input.keygenRole,
    secret: input.secret.slice(),
    publicShare: input.publicShare.slice(),
    peerPublicShare: input.peerPublicShare.slice(),
    publicKey: joint.toRawBytes(true),
    address: evmAddress(joint),
    delta: input.delta.slice(),
    seeds: input.seeds.slice(),
    seedPairs: input.seedPairs.slice(),
    destroyed: false,
  }
}

export interface KeyShareInfo {
  readonly keyId: Uint8Array
  readonly publicKey: Uint8Array
  readonly address: Uint8Array
  readonly localId: Uint8Array
  readonly peerId: Uint8Array
  readonly keygenRole: RoleName
  /** False once the share was destroyed or burned. */
  readonly usable: boolean
}

export function describeKeyShare(share: KeyShare): DklsResult<KeyShareInfo> {
  try {
    const internal = internalShare(share)
    return success({
      keyId: internal.keyId.slice(),
      publicKey: internal.publicKey.slice(),
      address: internal.address.slice(),
      localId: internal.localId.slice(),
      peerId: internal.peerId.slice(),
      keygenRole: internal.keygenRole,
      usable: !internal.destroyed && !shareIsBurned(internal),
    })
  } catch (error) {
    return failure(failureCode(error))
  }
}

/** Wipes this handle. Stored copies and other handles are not affected. */
export function destroyKeyShare(share: KeyShare): DklsResult<true> {
  try {
    wipeShare(internalShare(share))
    return success(true)
  } catch (error) {
    return failure(failureCode(error))
  }
}

/** HMAC-SHA256 under a key derived from the secret share. */
export function storageMac(
  purpose: string,
  secret: Uint8Array,
  body: Uint8Array,
): Uint8Array {
  const key = transcript(`storage/${purpose}`, secret)
  const mac = hmac(sha256, key, body)
  key.fill(0)
  return mac
}

/**
 * SECRET. Layout: magic, version, secret share (fixed offset), role, both
 * identities, key id, both public shares, Delta, seeds, seed pairs, MAC.
 */
export function exportKeyShare(share: KeyShare): DklsResult<Uint8Array> {
  try {
    const internal = usableShare(share)
    const body = concat(
      MAGIC,
      Uint8Array.of(VERSION),
      internal.secret,
      Uint8Array.of(internal.keygenRole === 'initiator' ? 1 : 2),
      variable(internal.localId),
      variable(internal.peerId),
      internal.keyId,
      internal.publicShare,
      internal.peerPublicShare,
      internal.delta,
      internal.seeds,
      internal.seedPairs,
    )
    return success(concat(body, storageMac('key-share', internal.secret, body)))
  } catch (error) {
    return failure(failureCode(error))
  }
}

export function importKeyShare(bytes: Uint8Array): DklsResult<KeyShare> {
  const copied = snapshotBounded(
    bytes,
    SECRET_OFFSET + SCALAR_BYTES + MAC_BYTES,
    MAX_EXPORT_BYTES,
  )
  if (copied === null) return failure('invalid-key-share')
  try {
    if (
      !equalBytes(copied.subarray(0, MAGIC.length), MAGIC) ||
      copied[MAGIC.length] !== VERSION
    ) {
      return failure('invalid-key-share')
    }
    // Authenticate first. Only the fixed-offset secret is read before that.
    const body = copied.subarray(0, copied.length - MAC_BYTES)
    const secret = copied.slice(SECRET_OFFSET, SECRET_OFFSET + SCALAR_BYTES)
    const expected = storageMac('key-share', secret, body)
    secret.fill(0)
    if (!equalBytes(expected, copied.subarray(copied.length - MAC_BYTES))) {
      return failure('invalid-key-share')
    }
    const reader = new Reader(body)
    reader.take(SECRET_OFFSET)
    const share = reader.take(SCALAR_BYTES)
    const role = reader.byte()
    if (role !== 1 && role !== 2) return failure('invalid-key-share')
    const localId = reader.variable(MAX_IDENTITY_BYTES)
    const peerId = reader.variable(MAX_IDENTITY_BYTES)
    const keyId = reader.take(HASH_BYTES)
    const publicShare = reader.take(POINT_BYTES)
    const peerPublicShare = reader.take(POINT_BYTES)
    const delta = reader.take(CHOICE_BYTES)
    const seeds = reader.take(SEEDS_BYTES)
    const seedPairs = reader.take(SEED_PAIRS_BYTES)
    reader.finish()
    const internal = assembleShare({
      keyId,
      localId,
      peerId,
      keygenRole: role === 1 ? 'initiator' : 'responder',
      secret: share,
      publicShare,
      peerPublicShare,
      delta,
      seeds,
      seedPairs,
    })
    wipe(share, delta, seeds, seedPairs)
    if (shareIsBurned(internal)) {
      wipeShare(internal)
      return failure('key-burned', false, true)
    }
    return success(wrapShare(internal))
  } catch (error) {
    const code = failureCode(error)
    return failure(code === 'key-burned' ? code : 'invalid-key-share')
  } finally {
    copied.fill(0)
  }
}
