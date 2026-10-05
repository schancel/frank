// Self-open derivation: lets the sender reopen its own auth-mode envelopes.
//
// selfOpenKey = HKDF-SHA256(ikm = 32-byte messaging root,
//                           salt = "frank/self-open/v1",
//                           info = "frank/self-open/v1/key", L = 32)
// eph = first k_c in [1, n-1], c = 0..255, where
//   k_c = HMAC-SHA256(selfOpenKey, "frank/self-open/v1/ephemeral" || 0x00 ||
//                     salt(32) || recipient(33) || sender(33) || u8(c))
//
// The salt is the envelope's own per-message CSPRNG salt (cleartext and bound
// into the AEAD key schedule), so no extra wire field is needed. AEAD key and
// nonce become a function of (salt, recipient, sender, sender static key):
// salt freshness is the entire uniqueness requirement. Callers MUST NOT supply
// a repeated salt; the default path draws it from the CSPRNG.

import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha256.js'

import { aeadDecrypt } from './aead.js'
import { ascii, concatBytes, equalBytes, isPlainBytes } from './bytes.js'
import { decodeEnvelope } from './envelope.js'
import {
  ENC_LENGTH,
  KEM_SECP256K1,
  LEGACY_ENVELOPE_VERSION,
  MODE_AUTH,
  SALT_LENGTH,
  SUITE_AUTH_XCHACHA,
} from './ids.js'
import { fail, type SuiteResult } from './result.js'
import {
  associatedData,
  hkdfExpand,
  hkdfExtract,
  messageKeys,
  sharedSecret,
} from './schedule.js'
import {
  dh,
  loadScalar,
  requireMessage,
  requirePoint,
  selectSuite,
  unpad,
  wipe,
} from './seal.js'

export const SELF_OPEN_DOMAIN = 'frank/self-open/v1'
const KEY_INFO = ascii('frank/self-open/v1/key')
const EPHEMERAL_LABEL = concatBytes([
  ascii('frank/self-open/v1/ephemeral'),
  Uint8Array.of(0),
])
const SELF_OPEN_KEY_LENGTH = 32

const ORDER = Uint8Array.from([
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xfe, 0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2,
  0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
])

function validScalar(bytes: Uint8Array): boolean {
  let zero = true
  for (const byte of bytes) if (byte !== 0) zero = false
  if (zero) return false
  for (let i = 0; i < 32; i += 1) {
    if (bytes[i] !== ORDER[i]) return bytes[i] < ORDER[i]
  }
  return false
}

/**
 * Dedicated self-open key from the 32-byte messaging-encryption domain root.
 * Never the identity key or a role leaf scalar. Caller wipes the result.
 */
export function selfOpenKeyFromRoot(messagingRoot: Uint8Array): Uint8Array {
  if (!isPlainBytes(messagingRoot) || messagingRoot.length !== 32) {
    throw new RangeError('self-open root must be exactly 32 bytes')
  }
  const prk = hkdfExtract(messagingRoot, ascii(SELF_OPEN_DOMAIN))
  try {
    return hkdfExpand(prk, KEY_INFO, SELF_OPEN_KEY_LENGTH)
  } finally {
    prk.fill(0)
  }
}

/** Deterministic ephemeral scalar for one envelope. Null only on bad input. */
export function selfOpenEphemeral(input: {
  readonly selfOpenKey: Uint8Array
  readonly salt: Uint8Array
  readonly recipientPublicKey: Uint8Array
  readonly senderPublicKey: Uint8Array
}): Uint8Array | null {
  if (
    !isPlainBytes(input.selfOpenKey) ||
    input.selfOpenKey.length !== SELF_OPEN_KEY_LENGTH ||
    !isPlainBytes(input.salt) ||
    input.salt.length !== SALT_LENGTH ||
    !isPlainBytes(input.recipientPublicKey) ||
    input.recipientPublicKey.length !== ENC_LENGTH ||
    !isPlainBytes(input.senderPublicKey) ||
    input.senderPublicKey.length !== ENC_LENGTH
  ) {
    return null
  }
  const key = Uint8Array.from(input.selfOpenKey)
  try {
    for (let counter = 0; counter < 256; counter += 1) {
      const candidate = hmac(
        sha256,
        key,
        concatBytes([
          EPHEMERAL_LABEL,
          input.salt,
          input.recipientPublicKey,
          input.senderPublicKey,
          Uint8Array.of(counter),
        ]),
      )
      if (validScalar(candidate)) return candidate
      candidate.fill(0)
    }
    return null
  } finally {
    key.fill(0)
  }
}

export interface OpenAsSenderArgs {
  readonly envelope: Uint8Array
  readonly selfOpenKey: Uint8Array
  readonly senderPrivateKey: Uint8Array
  readonly senderPublicKey?: Uint8Array
  readonly recipientPublicKey: Uint8Array
  readonly context: Uint8Array
}

/**
 * Re-open an auth-mode envelope using the sender's self-open key and static key.
 * Verifies that the envelope was sealed with the deterministic ephemeral key.
 */
export function openAsSender(args: OpenAsSenderArgs): SuiteResult<Uint8Array> {
  if (!isPlainBytes(args.envelope)) return fail({ code: 'bytes' })
  if (!isPlainBytes(args.selfOpenKey)) return fail({ code: 'bytes' })
  if (args.selfOpenKey.length !== SELF_OPEN_KEY_LENGTH) {
    return fail({ code: 'bad-length', actual: args.selfOpenKey.length })
  }
  const context = requireMessage(args.context)
  if (!context.ok) return context
  const recipient = requirePoint(args.recipientPublicKey)
  if (!recipient.ok) return recipient

  let senderPublicPoint: Uint8Array | undefined
  if (args.senderPublicKey !== undefined) {
    const senderPublic = requirePoint(args.senderPublicKey)
    if (!senderPublic.ok) return senderPublic
    senderPublicPoint = senderPublic.value
  }

  const senderSecret = loadScalar(args.senderPrivateKey)
  if (!senderSecret.ok) return senderSecret
  if (
    senderPublicPoint !== undefined &&
    !equalBytes(senderSecret.value.publicKey, senderPublicPoint)
  ) {
    wipe(senderSecret.value.key)
    return fail({ code: 'sender-key' })
  }
  const senderPoint = senderSecret.value.publicKey

  const envelope = decodeEnvelope(args.envelope)
  if (envelope === null) {
    wipe(senderSecret.value.key)
    return fail({ code: 'envelope' })
  }
  if (envelope.kemId !== KEM_SECP256K1) {
    wipe(senderSecret.value.key)
    return fail({ code: 'envelope' })
  }
  if (
    envelope.suiteId === SUITE_AUTH_XCHACHA &&
    envelope.version === LEGACY_ENVELOPE_VERSION
  ) {
    wipe(senderSecret.value.key)
    return fail({ code: 'envelope' })
  }
  const spec = selectSuite(envelope.suiteId)
  if (!spec.ok) {
    wipe(senderSecret.value.key)
    return spec
  }
  if (spec.value.mode !== MODE_AUTH) {
    wipe(senderSecret.value.key)
    return fail({ code: 'not-self-openable' })
  }

  const ephScalarBytes = selfOpenEphemeral({
    selfOpenKey: args.selfOpenKey,
    salt: envelope.salt,
    recipientPublicKey: recipient.value,
    senderPublicKey: senderPoint,
  })
  if (ephScalarBytes === null) {
    wipe(senderSecret.value.key)
    return fail({ code: 'not-self-openable' })
  }

  const ephemeral = loadScalar(ephScalarBytes)
  ephScalarBytes.fill(0)
  if (!ephemeral.ok) {
    wipe(senderSecret.value.key)
    return fail({ code: 'not-self-openable' })
  }

  if (!equalBytes(ephemeral.value.publicKey, envelope.enc)) {
    wipe(ephemeral.value.key)
    wipe(senderSecret.value.key)
    return fail({ code: 'not-self-openable' })
  }

  const toRecipient = dh(ephemeral.value.key, recipient.value)
  wipe(ephemeral.value.key)
  if (!toRecipient.ok) {
    wipe(senderSecret.value.key)
    return toRecipient
  }

  const senderDh = dh(senderSecret.value.key, recipient.value)
  wipe(senderSecret.value.key)
  if (!senderDh.ok) {
    toRecipient.value.fill(0)
    return senderDh
  }

  const dhBytes = concatBytes([toRecipient.value, senderDh.value])
  toRecipient.value.fill(0)
  senderDh.value.fill(0)
  const kemContext = concatBytes([envelope.enc, recipient.value, senderPoint])
  const shared = sharedSecret(dhBytes, kemContext)
  dhBytes.fill(0)

  const keys = messageKeys({
    suiteId: spec.value.id,
    mode: spec.value.mode,
    aeadId: spec.value.aeadId,
    shared,
    salt: envelope.salt,
    nonceLength: spec.value.nonceLength,
  })
  shared.fill(0)

  const aad = associatedData(
    envelope.version,
    spec.value.id,
    senderPoint,
    recipient.value,
    context.value,
  )
  const inner = aeadDecrypt(
    spec.value.aead,
    keys.key,
    keys.nonce,
    aad,
    envelope.ciphertext,
  )
  keys.key.fill(0)
  keys.nonce.fill(0)
  if (inner === null) return fail({ code: 'open-failed' })
  const plain = unpad(inner)
  inner.fill(0)
  return plain
}
