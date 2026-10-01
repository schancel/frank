// HPKE-shaped HKDF (RFC 9180 labels, RFC 5869 HKDF-SHA256).
// The key-schedule secret uses the per-message salt as HKDF-Extract salt.
// That is not RFC 9180's shared-secret-as-salt. There is no PSK.

import { expand, extract } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha256.js'

import { ascii, concatBytes, i2osp } from './bytes.js'
import { KDF_HKDF_SHA256, KEM_SECP256K1 } from './ids.js'

const HPKE_V1 = ascii('HPKE-v1')
const KEM_SUITE = concatBytes([ascii('KEM'), i2osp(KEM_SECP256K1, 2)])
const INFO_LABEL = ascii('frank-crypto-box/v1')

function defaultSalt(salt: Uint8Array): Uint8Array {
  return salt.length === 0 ? new Uint8Array(sha256.outputLen) : salt
}

/** RFC 5869 HKDF-Extract. An empty salt is HashLen zeros. */
export function hkdfExtract(ikm: Uint8Array, salt: Uint8Array): Uint8Array {
  return extract(sha256, ikm, defaultSalt(salt))
}

/** RFC 5869 HKDF-Expand. */
export function hkdfExpand(
  prk: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  return expand(sha256, prk, info, length)
}

function labeledExtract(
  suiteId: Uint8Array,
  salt: Uint8Array,
  label: string,
  ikm: Uint8Array,
): Uint8Array {
  return hkdfExtract(concatBytes([HPKE_V1, suiteId, ascii(label), ikm]), salt)
}

function labeledExpand(
  suiteId: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
): Uint8Array {
  const labeledInfo = concatBytes([
    i2osp(length, 2),
    HPKE_V1,
    suiteId,
    ascii(label),
    info,
  ])
  return hkdfExpand(prk, labeledInfo, length)
}

function hpkeSuite(aeadId: number): Uint8Array {
  return concatBytes([
    ascii('HPKE'),
    i2osp(KEM_SECP256K1, 2),
    i2osp(KDF_HKDF_SHA256, 2),
    i2osp(aeadId, 2),
  ])
}

/** RFC 9180 ExtractAndExpand on the DH bytes. Nsecret is 32. */
export function sharedSecret(
  dh: Uint8Array,
  kemContext: Uint8Array,
): Uint8Array {
  const prk = labeledExtract(KEM_SUITE, new Uint8Array(0), 'eae_prk', dh)
  const secret = labeledExpand(KEM_SUITE, prk, 'shared_secret', kemContext, 32)
  prk.fill(0)
  return secret
}

export function messageKeys(input: {
  readonly suiteId: number
  readonly mode: number
  readonly aeadId: number
  readonly shared: Uint8Array
  readonly salt: Uint8Array
  readonly nonceLength: number
}): { readonly key: Uint8Array; readonly nonce: Uint8Array } {
  const suite = hpkeSuite(input.aeadId)
  const secret = labeledExtract(suite, input.salt, 'secret', input.shared)
  const pskIdHash = labeledExtract(
    suite,
    new Uint8Array(0),
    'psk_id_hash',
    new Uint8Array(0),
  )
  const infoHash = labeledExtract(
    suite,
    new Uint8Array(0),
    'info_hash',
    concatBytes([INFO_LABEL, i2osp(input.suiteId, 2)]),
  )
  const scheduleContext = concatBytes([
    Uint8Array.of(input.mode),
    pskIdHash,
    infoHash,
  ])
  const key = labeledExpand(suite, secret, 'key', scheduleContext, 32)
  const nonce = labeledExpand(
    suite,
    secret,
    'base_nonce',
    scheduleContext,
    input.nonceLength,
  )
  secret.fill(0)
  pskIdHash.fill(0)
  infoHash.fill(0)
  return { key, nonce }
}

export function associatedData(
  suiteId: number,
  sender: Uint8Array,
  recipient: Uint8Array,
  context: Uint8Array,
): Uint8Array {
  return concatBytes([
    i2osp(suiteId, 2),
    i2osp(sender.length, 2),
    sender,
    i2osp(recipient.length, 2),
    recipient,
    i2osp(context.length, 4),
    context,
  ])
}
