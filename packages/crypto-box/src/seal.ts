// Envelope seal and open. ECDH is @frank/nakamoto's ecdh: 33-byte compressed
// SEC1, no hash. Sequence number is fixed at 0. One ciphertext per encap.

import { ecdh } from '@frank/nakamoto/curve'
import {
  privateKeyFromBytes,
  type PrivateKey,
} from '@frank/nakamoto/constructors'

import { aeadDecrypt, aeadEncrypt } from './aead.js'
import {
  concatBytes,
  equalBytes,
  i2osp,
  isPlainBytes,
  readU32,
} from './bytes.js'
import { decodeEnvelope, encodeEnvelope } from './envelope.js'
import {
  ENC_LENGTH,
  ENVELOPE_VERSION,
  KEM_SECP256K1,
  MAX_MESSAGE,
  MAX_PADDING,
  MODE_AUTH,
  RESERVED_PROOF_SUITE_ID,
  SALT_LENGTH,
  type SuiteSpec,
  suiteById,
} from './ids.js'
import { fail, type SuiteFailure, type SuiteResult } from './result.js'
import { associatedData, messageKeys, sharedSecret } from './schedule.js'

const GENERATOR = Uint8Array.from([
  0x02, 0x79, 0xbe, 0x66, 0x7e, 0xf9, 0xdc, 0xbb, 0xac, 0x55, 0xa0, 0x62, 0x95,
  0xce, 0x87, 0x0b, 0x07, 0x02, 0x9b, 0xfc, 0xdb, 0x2d, 0xce, 0x28, 0xd9, 0x59,
  0xf2, 0x81, 0x5b, 0x16, 0xf8, 0x17, 0x98,
])

export interface SealArgs {
  readonly suiteId: number
  readonly recipientPublicKey: Uint8Array
  readonly senderPublicKey: Uint8Array
  readonly senderPrivateKey?: Uint8Array
  readonly plaintext: Uint8Array
  readonly context: Uint8Array
  readonly padding?: number
  readonly ephemeralSecret?: Uint8Array
  readonly salt?: Uint8Array
  readonly paddingBytes?: Uint8Array
}

export interface OpenArgs {
  readonly envelope: Uint8Array
  readonly recipientPrivateKey: Uint8Array
  readonly senderPublicKey: Uint8Array
  readonly context: Uint8Array
}

interface Loaded {
  readonly key: PrivateKey
  readonly publicKey: Uint8Array
}

function mapCurve(error: { code: string; actual?: number }): SuiteFailure {
  if (error.code === 'bad-length') {
    return { code: 'bad-length', actual: error.actual ?? 0 }
  }
  if (error.code === 'scalar-out-of-range')
    return { code: 'scalar-out-of-range' }
  return { code: 'point-invalid' }
}

function csprng(length: number): Uint8Array | null {
  const host = (
    globalThis as {
      crypto?: { getRandomValues?: (bytes: Uint8Array) => Uint8Array }
    }
  ).crypto
  if (!host || typeof host.getRandomValues !== 'function') return null
  const out = new Uint8Array(length)
  host.getRandomValues(out)
  return out
}

function wipe(key: PrivateKey): void {
  key.bytes.fill(0)
}

function loadScalar(bytes: Uint8Array): SuiteResult<Loaded> {
  if (!isPlainBytes(bytes)) return fail({ code: 'bytes' })
  if (bytes.length !== 32)
    return fail({ code: 'bad-length', actual: bytes.length })
  const branded = privateKeyFromBytes(bytes, true)
  if (!branded.ok) return fail({ code: 'bad-length', actual: bytes.length })
  const pub = ecdh(branded.value, GENERATOR)
  if (!pub.ok) {
    wipe(branded.value)
    return fail(mapCurve(pub.error))
  }
  return { ok: true, value: { key: branded.value, publicKey: pub.value.point } }
}

function freshScalar(): SuiteResult<Loaded> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bytes = csprng(32)
    if (bytes === null) return fail({ code: 'random' })
    const loaded = loadScalar(bytes)
    bytes.fill(0)
    if (loaded.ok) return loaded
    if (loaded.error.code !== 'scalar-out-of-range') return loaded
  }
  return fail({ code: 'random' })
}

function dh(key: PrivateKey, point: Uint8Array): SuiteResult<Uint8Array> {
  const shared = ecdh(key, point)
  if (!shared.ok) return fail(mapCurve(shared.error))
  if (shared.value.point.length !== ENC_LENGTH) {
    return fail({ code: 'point-invalid' })
  }
  return { ok: true, value: shared.value.point }
}

function requirePoint(bytes: Uint8Array): SuiteResult<Uint8Array> {
  if (!isPlainBytes(bytes)) return fail({ code: 'bytes' })
  if (bytes.length !== ENC_LENGTH) {
    return fail({ code: 'bad-length', actual: bytes.length })
  }
  return { ok: true, value: bytes }
}

function requireMessage(bytes: Uint8Array): SuiteResult<Uint8Array> {
  if (!isPlainBytes(bytes)) return fail({ code: 'bytes' })
  if (bytes.length > MAX_MESSAGE) return fail({ code: 'too-large' })
  return { ok: true, value: bytes }
}

function saltOf(supplied: Uint8Array | undefined): SuiteResult<Uint8Array> {
  if (supplied === undefined) {
    const salt = csprng(SALT_LENGTH)
    if (salt === null) return fail({ code: 'random' })
    return { ok: true, value: salt }
  }
  if (!isPlainBytes(supplied)) return fail({ code: 'bytes' })
  if (supplied.length !== SALT_LENGTH) {
    return fail({ code: 'bad-length', actual: supplied.length })
  }
  return { ok: true, value: new Uint8Array(supplied) }
}

function paddingOf(
  count: number | undefined,
  supplied: Uint8Array | undefined,
): SuiteResult<Uint8Array> {
  if (supplied !== undefined) {
    if (!isPlainBytes(supplied)) return fail({ code: 'bytes' })
    if (supplied.length > MAX_PADDING) return fail({ code: 'padding' })
    if (count !== undefined && count !== supplied.length)
      return fail({ code: 'padding' })
    return { ok: true, value: supplied }
  }
  const length = count ?? 0
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PADDING) {
    return fail({ code: 'padding' })
  }
  if (length === 0) return { ok: true, value: new Uint8Array(0) }
  const bytes = csprng(length)
  if (bytes === null) return fail({ code: 'random' })
  return { ok: true, value: bytes }
}

function selectSuite(suiteId: number): SuiteResult<SuiteSpec> {
  if (suiteId === RESERVED_PROOF_SUITE_ID) {
    return fail({ code: 'reserved-suite', suiteId })
  }
  const spec = suiteById(suiteId)
  if (!spec) return fail({ code: 'suite-unknown', suiteId })
  return { ok: true, value: spec }
}

function finish(
  spec: SuiteSpec,
  sender: Uint8Array,
  recipient: Uint8Array,
  enc: Uint8Array,
  dhBytes: Uint8Array,
  kemContext: Uint8Array,
  salt: Uint8Array,
  plaintext: Uint8Array,
  padding: Uint8Array,
  context: Uint8Array,
): SuiteResult<Uint8Array> {
  const shared = sharedSecret(dhBytes, kemContext)
  const keys = messageKeys({
    suiteId: spec.id,
    mode: spec.mode,
    aeadId: spec.aeadId,
    shared,
    salt,
    nonceLength: spec.nonceLength,
  })
  const aad = associatedData(spec.id, sender, recipient, context)
  const inner = concatBytes([i2osp(plaintext.length, 4), plaintext, padding])
  try {
    const ciphertext = aeadEncrypt(spec.aead, keys.key, keys.nonce, aad, inner)
    return {
      ok: true,
      value: encodeEnvelope(spec.id, KEM_SECP256K1, salt, enc, ciphertext),
    }
  } catch {
    return fail({ code: 'aead' })
  } finally {
    keys.key.fill(0)
    keys.nonce.fill(0)
    shared.fill(0)
    dhBytes.fill(0)
    inner.fill(0)
  }
}

function unpad(inner: Uint8Array): SuiteResult<Uint8Array> {
  if (inner.length < 4) return fail({ code: 'open-failed' })
  const length = readU32(inner, 0)
  if (length > MAX_MESSAGE || 4 + length > inner.length) {
    return fail({ code: 'open-failed' })
  }
  if (inner.length - 4 - length > MAX_PADDING)
    return fail({ code: 'open-failed' })
  return { ok: true, value: new Uint8Array(inner.subarray(4, 4 + length)) }
}

export function seal(args: SealArgs): SuiteResult<Uint8Array> {
  const spec = selectSuite(args.suiteId)
  if (!spec.ok) return spec
  const recipient = requirePoint(args.recipientPublicKey)
  if (!recipient.ok) return recipient
  const sender = requirePoint(args.senderPublicKey)
  if (!sender.ok) return sender
  const plaintext = requireMessage(args.plaintext)
  if (!plaintext.ok) return plaintext
  const context = requireMessage(args.context)
  if (!context.ok) return context
  const salt = saltOf(args.salt)
  if (!salt.ok) return salt
  const padding = paddingOf(args.padding, args.paddingBytes)
  if (!padding.ok) return padding

  const ephemeral =
    args.ephemeralSecret === undefined
      ? freshScalar()
      : loadScalar(args.ephemeralSecret)
  if (!ephemeral.ok) return ephemeral

  const enc = ephemeral.value.publicKey
  const toRecipient = dh(ephemeral.value.key, recipient.value)
  if (!toRecipient.ok) {
    wipe(ephemeral.value.key)
    return toRecipient
  }
  const senderPoint = dh(ephemeral.value.key, sender.value)
  if (!senderPoint.ok) {
    wipe(ephemeral.value.key)
    toRecipient.value.fill(0)
    return senderPoint
  }
  senderPoint.value.fill(0)

  let dhBytes: Uint8Array
  let kemContext: Uint8Array
  if (spec.value.mode === MODE_AUTH) {
    if (args.senderPrivateKey === undefined) {
      wipe(ephemeral.value.key)
      toRecipient.value.fill(0)
      return fail({ code: 'sender-key' })
    }
    const senderSecret = loadScalar(args.senderPrivateKey)
    if (!senderSecret.ok) {
      wipe(ephemeral.value.key)
      toRecipient.value.fill(0)
      return senderSecret
    }
    if (!equalBytes(senderSecret.value.publicKey, sender.value)) {
      wipe(ephemeral.value.key)
      wipe(senderSecret.value.key)
      toRecipient.value.fill(0)
      return fail({ code: 'sender-key' })
    }
    const senderDh = dh(senderSecret.value.key, recipient.value)
    wipe(senderSecret.value.key)
    if (!senderDh.ok) {
      wipe(ephemeral.value.key)
      toRecipient.value.fill(0)
      return senderDh
    }
    dhBytes = concatBytes([toRecipient.value, senderDh.value])
    senderDh.value.fill(0)
    kemContext = concatBytes([enc, recipient.value, sender.value])
  } else {
    dhBytes = new Uint8Array(toRecipient.value)
    kemContext = concatBytes([enc, recipient.value])
  }
  wipe(ephemeral.value.key)
  toRecipient.value.fill(0)
  return finish(
    spec.value,
    sender.value,
    recipient.value,
    enc,
    dhBytes,
    kemContext,
    salt.value,
    plaintext.value,
    padding.value,
    context.value,
  )
}

/**
 * Auth-mode ciphertext built from the recipient static key and the sender
 * public key. Not exported from the package root. Proves the recipient can
 * forge: the sender static secret is not an input.
 */
export function sealAuthAsRecipient(args: {
  readonly suiteId: number
  readonly recipientPrivateKey: Uint8Array
  readonly recipientPublicKey: Uint8Array
  readonly senderPublicKey: Uint8Array
  readonly plaintext: Uint8Array
  readonly context: Uint8Array
  readonly ephemeralSecret: Uint8Array
  readonly salt: Uint8Array
  readonly padding?: number
  readonly paddingBytes?: Uint8Array
}): SuiteResult<Uint8Array> {
  const spec = selectSuite(args.suiteId)
  if (!spec.ok) return spec
  if (spec.value.mode !== MODE_AUTH) {
    return fail({ code: 'suite-unknown', suiteId: args.suiteId })
  }
  const recipient = requirePoint(args.recipientPublicKey)
  if (!recipient.ok) return recipient
  const sender = requirePoint(args.senderPublicKey)
  if (!sender.ok) return sender
  const plaintext = requireMessage(args.plaintext)
  if (!plaintext.ok) return plaintext
  const context = requireMessage(args.context)
  if (!context.ok) return context
  const salt = saltOf(args.salt)
  if (!salt.ok) return salt
  const padding = paddingOf(args.padding, args.paddingBytes)
  if (!padding.ok) return padding
  const recipientSecret = loadScalar(args.recipientPrivateKey)
  if (!recipientSecret.ok) return recipientSecret
  if (!equalBytes(recipientSecret.value.publicKey, recipient.value)) {
    wipe(recipientSecret.value.key)
    return fail({ code: 'point-invalid' })
  }
  const ephemeral = loadScalar(args.ephemeralSecret)
  if (!ephemeral.ok) {
    wipe(recipientSecret.value.key)
    return ephemeral
  }
  const toRecipient = dh(ephemeral.value.key, recipient.value)
  const fromSender = dh(recipientSecret.value.key, sender.value)
  wipe(ephemeral.value.key)
  wipe(recipientSecret.value.key)
  if (!toRecipient.ok) return toRecipient
  if (!fromSender.ok) {
    toRecipient.value.fill(0)
    return fromSender
  }
  const dhBytes = concatBytes([toRecipient.value, fromSender.value])
  toRecipient.value.fill(0)
  fromSender.value.fill(0)
  const kemContext = concatBytes([
    ephemeral.value.publicKey,
    recipient.value,
    sender.value,
  ])
  return finish(
    spec.value,
    sender.value,
    recipient.value,
    ephemeral.value.publicKey,
    dhBytes,
    kemContext,
    salt.value,
    plaintext.value,
    padding.value,
    context.value,
  )
}

export function open(args: OpenArgs): SuiteResult<Uint8Array> {
  if (!isPlainBytes(args.envelope)) return fail({ code: 'bytes' })
  const context = requireMessage(args.context)
  if (!context.ok) return context
  const sender = requirePoint(args.senderPublicKey)
  if (!sender.ok) return sender
  const envelope = decodeEnvelope(args.envelope)
  if (envelope === null || envelope.version !== ENVELOPE_VERSION) {
    return fail({ code: 'envelope' })
  }
  if (envelope.kemId !== KEM_SECP256K1) return fail({ code: 'envelope' })
  const spec = selectSuite(envelope.suiteId)
  if (!spec.ok) return spec
  const { salt, enc, ciphertext } = envelope
  const recipientSecret = loadScalar(args.recipientPrivateKey)
  if (!recipientSecret.ok) return recipientSecret
  const toRecipient = dh(recipientSecret.value.key, enc)
  if (!toRecipient.ok) {
    wipe(recipientSecret.value.key)
    return toRecipient
  }
  let dhBytes: Uint8Array
  let kemContext: Uint8Array
  if (spec.value.mode === MODE_AUTH) {
    const fromSender = dh(recipientSecret.value.key, sender.value)
    if (!fromSender.ok) {
      wipe(recipientSecret.value.key)
      toRecipient.value.fill(0)
      return fromSender
    }
    dhBytes = concatBytes([toRecipient.value, fromSender.value])
    fromSender.value.fill(0)
    kemContext = concatBytes([
      enc,
      recipientSecret.value.publicKey,
      sender.value,
    ])
  } else {
    dhBytes = new Uint8Array(toRecipient.value)
    kemContext = concatBytes([enc, recipientSecret.value.publicKey])
  }
  const recipientPublic = recipientSecret.value.publicKey
  wipe(recipientSecret.value.key)
  toRecipient.value.fill(0)
  const shared = sharedSecret(dhBytes, kemContext)
  dhBytes.fill(0)
  const keys = messageKeys({
    suiteId: spec.value.id,
    mode: spec.value.mode,
    aeadId: spec.value.aeadId,
    shared,
    salt,
    nonceLength: spec.value.nonceLength,
  })
  shared.fill(0)
  const aad = associatedData(
    spec.value.id,
    sender.value,
    recipientPublic,
    context.value,
  )
  const inner = aeadDecrypt(
    spec.value.aead,
    keys.key,
    keys.nonce,
    aad,
    ciphertext,
  )
  keys.key.fill(0)
  keys.nonce.fill(0)
  if (inner === null) return fail({ code: 'open-failed' })
  const plain = unpad(inner)
  inner.fill(0)
  return plain
}
