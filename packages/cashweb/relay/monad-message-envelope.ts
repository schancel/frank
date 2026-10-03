/**
 * Versioned, deniable authenticated encryption for Monad direct messages.
 *
 * Version 2 derives an AES-256-GCM key from the identities' secp256k1 ECDH point with
 * HKDF-SHA256. The HKDF info string separates this key from every other use of the long-lived
 * identity ECDH secret. A fresh 32-byte salt and 96-bit nonce are generated for every envelope.
 *
 * The exact UTF-8 encoding of `JSON.stringify([2, networkTag, from, to])` is the GCM associated
 * data. This length-delimited JSON tuple unambiguously authenticates the version, network, sender,
 * and recipient without a stable public signature. Both identities know the same AEAD key, so
 * either party can construct an indistinguishable valid transcript; that deniability is
 * intentional.
 *
 * Version 1 is retained only as an explicitly named read path for already-stored AES-CBC
 * envelopes. New builders never emit it, and the relay does not admit it on PUT.
 */
import {
  createFrankStampProof,
  verifyFrankStampProof,
} from '@frank/adaptor-signatures/frank-stamp-dleq'
import {
  addressFromCompressedPubkey,
  cborMap,
  encodeDirectMessageCryptoContext,
  encodeFrame,
  parseFrame,
  type AccountRef,
  type DirectMessageCryptoContext,
  type RecipientEncryptedPayloadV2,
} from '@frank/codec'
import {
  hmacSha256,
  open,
  randomBytes,
  seal,
  sha256,
  SUITE_AUTH_XCHACHA,
} from '@frank/crypto-box'
import { ecdh, type PrivateKey } from '@frank/nakamoto'
import * as forge from 'node-forge'

import {
  MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES,
  MAX_RELAY_BODY_BYTES,
} from './message-limits'

const CURRENT_ENVELOPE_VERSION = 2 as const
const FRANK_CBOR_ENVELOPE_VERSION = 3 as const
const LEGACY_ENVELOPE_VERSION = 1 as const
const HKDF_SALT_BYTES = 32
const GCM_NONCE_BYTES = 12
const GCM_TAG_BYTES = 16
export { MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES }
const MAX_V2_CIPHERTEXT_BYTES = MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES
// V1 has no write path. Preserve its historical 1 MiB read ceiling so already-stored records do
// not become unreadable when the stricter request-framing limit is applied to new v2 envelopes.
const MAX_LEGACY_READ_CIPHERTEXT_BYTES = MAX_RELAY_BODY_BYTES / 2
const MAX_NETWORK_TAG_BYTES = 32
const HKDF_INFO = Buffer.from(
  'frank:monad-dm-envelope:v2:identity-ecdh:aes-256-gcm',
  'ascii',
)
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

export interface MonadMessageEnvelopeV2 {
  v: 2
  networkTag: string
  from: string
  to: string
  /** Hex-encoded, random 32-byte HKDF-SHA256 salt. */
  salt: string
  /** Hex-encoded, unique random 96-bit AES-GCM nonce. */
  nonce: string
  /** Hex-encoded AES-256-GCM ciphertext, excluding the authentication tag. */
  ciphertext: string
  /** Hex-encoded 16-byte AES-GCM authentication tag. */
  tag: string
}

/** Current Frank-CBOR type-5 schema-2 envelope using crypto-box suite 1. */
export interface MonadMessageEnvelopeV3 {
  v: 3
  networkTag: string
  from: string
  to: string
  sender: AccountRef
  recipient: AccountRef
  cryptoBoxEnvelope: Uint8Array
  ephemeralPoint: Uint8Array
  sharedPoint: Uint8Array
  dleqProof: Uint8Array
}

/** Read-only compatibility shape for records stored before authenticated v2 envelopes. */
export interface LegacyMonadMessageEnvelopeV1 {
  v: 1
  networkTag: string
  from: string
  to: string
  /** Hex-encoded 16-byte salt used by the legacy HMAC-SHA256 derivation. */
  salt: string
  /** Hex-encoded legacy AES-CBC ciphertext. */
  ciphertext: string
}

export type MonadMessageEnvelope =
  | MonadMessageEnvelopeV3
  | MonadMessageEnvelopeV2
  | LegacyMonadMessageEnvelopeV1

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const KECCAK_MASK_64 = (BigInt(1) << BigInt(64)) - BigInt(1)
const KECCAK_RATE_BYTES = 136
const KECCAK_ROTATIONS = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18,
  2, 61, 56, 14,
]
const KECCAK_ROUND_CONSTANTS = [
  '0000000000000001',
  '0000000000008082',
  '800000000000808a',
  '8000000080008000',
  '000000000000808b',
  '0000000080000001',
  '8000000080008081',
  '8000000000008009',
  '000000000000008a',
  '0000000000000088',
  '0000000080008009',
  '000000008000000a',
  '000000008000808b',
  '800000000000008b',
  '8000000000008089',
  '8000000000008003',
  '8000000000008002',
  '8000000000000080',
  '000000000000800a',
  '800000008000000a',
  '8000000080008081',
  '8000000000008080',
  '0000000080000001',
  '8000000080008008',
].map(value => BigInt(`0x${value}`))

function rotateLane(value: bigint, bits: number): bigint {
  if (bits === 0) return value
  const shift = BigInt(bits)
  return ((value << shift) | (value >> (BigInt(64) - shift))) & KECCAK_MASK_64
}

/** Minimal Keccak-256 used only for EIP-55 address checksum validation. */
function keccak256(bytes: Uint8Array): Uint8Array {
  const paddedLength =
    Math.ceil((bytes.length + 1) / KECCAK_RATE_BYTES) * KECCAK_RATE_BYTES
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  // Ethereum uses legacy Keccak's 0x01 domain suffix, not FIPS SHA3's 0x06.
  padded[bytes.length] = 0x01
  padded[padded.length - 1] |= 0x80

  const state = Array<bigint>(25).fill(BigInt(0))
  for (let block = 0; block < padded.length; block += KECCAK_RATE_BYTES) {
    for (let lane = 0; lane < KECCAK_RATE_BYTES / 8; lane++) {
      let word = BigInt(0)
      for (let byte = 0; byte < 8; byte++) {
        word |= BigInt(padded[block + lane * 8 + byte]) << BigInt(byte * 8)
      }
      state[lane] ^= word
    }

    for (const roundConstant of KECCAK_ROUND_CONSTANTS) {
      const columns = Array<bigint>(5).fill(BigInt(0))
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) columns[x] ^= state[x + 5 * y]
      }
      const deltas = columns.map(
        (_column, x) =>
          columns[(x + 4) % 5] ^ rotateLane(columns[(x + 1) % 5], 1),
      )
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) state[x + 5 * y] ^= deltas[x]
      }

      const rotated = Array<bigint>(25).fill(BigInt(0))
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          rotated[y + 5 * ((2 * x + 3 * y) % 5)] = rotateLane(
            state[x + 5 * y],
            KECCAK_ROTATIONS[x + 5 * y],
          )
        }
      }
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          state[x + 5 * y] =
            rotated[x + 5 * y] ^
            (~rotated[((x + 1) % 5) + 5 * y] &
              KECCAK_MASK_64 &
              rotated[((x + 2) % 5) + 5 * y])
        }
      }
      state[0] ^= roundConstant
    }
  }

  const digest = new Uint8Array(32)
  for (let index = 0; index < digest.length; index++) {
    digest[index] = Number(
      (state[Math.floor(index / 8)] >> BigInt((index % 8) * 8)) & BigInt(0xff),
    )
  }
  return digest
}

function isAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return false
  }
  const body = value.slice(2)
  const lower = body.toLowerCase()
  if (body === lower) return true
  const checksum = keccak256(textEncoder.encode(lower))
  return [...body].every((character, index) => {
    if (/\d/.test(character)) return true
    const byte = checksum[Math.floor(index / 2)]
    const nibble = index % 2 === 0 ? byte >> 4 : byte & 0x0f
    return (character === character.toUpperCase()) === nibble >= 8
  })
}

/**
 * Legacy v1 authenticated neither routing field, and historical writers did not promise an
 * EIP-55 spelling. Keep its read-only parser syntax-based and case-insensitive so casing alone
 * cannot strand an already-stored message. New v2 envelopes continue through {@link isAddress}.
 */
function isLegacyAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}

function isNetworkTag(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    textEncoder.encode(value).length <= MAX_NETWORK_TAG_BYTES
  )
}

const GENERATOR = Uint8Array.from([
  0x02, 0x79, 0xbe, 0x66, 0x7e, 0xf9, 0xdc, 0xbb, 0xac, 0x55, 0xa0, 0x62, 0x95,
  0xce, 0x87, 0x0b, 0x07, 0x02, 0x9b, 0xfc, 0xdb, 0x2d, 0xce, 0x28, 0xd9, 0x59,
  0xf2, 0x81, 0x5b, 0x16, 0xf8, 0x17, 0x98,
])

function account(keyBytes: Uint8Array): AccountRef {
  return { keyType: 1, keyBytes: Uint8Array.from(keyBytes) }
}

function evmAddress(keyBytes: Uint8Array): string {
  const lower = Buffer.from(addressFromCompressedPubkey(keyBytes)).toString(
    'hex',
  )
  const checksum = keccak256(textEncoder.encode(lower))
  const body = [...lower]
    .map((character, index) => {
      if (/\d/.test(character)) return character
      const byte = checksum[Math.floor(index / 2)]
      const nibble = index % 2 === 0 ? byte >> 4 : byte & 0x0f
      return nibble >= 8 ? character.toUpperCase() : character
    })
    .join('')
  return `0x${body}`
}

/**
 * Transitional directory binding for the demo runtime. It is deterministic and authenticated,
 * but uses SHA-256(message key) until the live directory API exposes accepted type-4 T1 hashes.
 */
function transitionalContext(params: {
  network: string
  sender: AccountRef
  recipient: AccountRef
  ephemeralPoint: Uint8Array
  sharedPoint: Uint8Array
  dleqProof: Uint8Array
}): DirectMessageCryptoContext {
  return {
    network: params.network,
    sender: params.sender,
    recipient: params.recipient,
    senderDirectoryHash: sha256(params.sender.keyBytes),
    recipientDirectoryHash: sha256(params.recipient.keyBytes),
    senderMessageKey: params.sender,
    recipientMessageKey: params.recipient,
    // The legacy registry has no independent stamp key yet. Identity-as-stamp-key is permitted by
    // S10a for migration/testing, though production wallets should derive a separate domain key.
    stampKey: params.recipient,
    ephemeralPoint: params.ephemeralPoint,
    sharedPoint: params.sharedPoint,
    dleqProof: params.dleqProof,
  }
}

function isLowerHexBytes(
  value: unknown,
  options: { exactBytes?: number; minBytes?: number; maxBytes?: number },
): value is string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value)) {
    return false
  }
  const bytes = value.length / 2
  return (
    (options.exactBytes === undefined || bytes === options.exactBytes) &&
    (options.minBytes === undefined || bytes >= options.minBytes) &&
    (options.maxBytes === undefined || bytes <= options.maxBytes)
  )
}

function isMonadMessageEnvelopeV2(
  value: unknown,
): value is MonadMessageEnvelopeV2 {
  if (!isRecord(value)) return false
  return (
    value.v === CURRENT_ENVELOPE_VERSION &&
    isNetworkTag(value.networkTag) &&
    isAddress(value.from) &&
    isAddress(value.to) &&
    isLowerHexBytes(value.salt, { exactBytes: HKDF_SALT_BYTES }) &&
    isLowerHexBytes(value.nonce, { exactBytes: GCM_NONCE_BYTES }) &&
    isLowerHexBytes(value.ciphertext, {
      minBytes: 1,
      maxBytes: MAX_V2_CIPHERTEXT_BYTES,
    }) &&
    isLowerHexBytes(value.tag, { exactBytes: GCM_TAG_BYTES })
  )
}

function isLegacyMonadMessageEnvelopeV1(
  value: unknown,
): value is LegacyMonadMessageEnvelopeV1 {
  if (!isRecord(value)) return false
  return (
    value.v === LEGACY_ENVELOPE_VERSION &&
    isNetworkTag(value.networkTag) &&
    isLegacyAddress(value.from) &&
    isLegacyAddress(value.to) &&
    isLowerHexBytes(value.salt, { exactBytes: 16 }) &&
    isLowerHexBytes(value.ciphertext, {
      minBytes: 16,
      maxBytes: MAX_LEGACY_READ_CIPHERTEXT_BYTES,
    }) &&
    value.ciphertext.length % 32 === 0
  )
}

function associatedData(envelope: {
  networkTag: string
  from: string
  to: string
}): Buffer {
  return Buffer.from(
    JSON.stringify([
      CURRENT_ENVELOPE_VERSION,
      envelope.networkTag,
      envelope.from,
      envelope.to,
    ]),
    'utf8',
  )
}

/**
 * Encodings of the ECDH shared point, canonical first. `ecdh` returns the 33-byte compressed
 * point (`02`/`03` || x), the same bytes as bitcore `publicKey.point.mul(privateKey.toBigNumber())`
 * then `toBuffer()`. Before #309, an x coordinate that starts with zero was sometimes hashed with
 * those leading zero bytes trimmed. That form is second, and only when it differs. Writers use
 * only the first entry.
 */
function sharedPointEncodings(
  privateKey: PrivateKey,
  publicKey: Uint8Array,
): Uint8Array[] {
  const shared = ecdh(privateKey, Uint8Array.from(publicKey))
  if (!shared.ok) throw new Error(`monad-envelope:${shared.error.code}`)
  const canonical = Uint8Array.from(shared.value.point)
  let firstNonZero = 1
  while (firstNonZero < canonical.length - 1 && canonical[firstNonZero] === 0) {
    firstNonZero++
  }
  if (firstNonZero === 1) return [canonical]
  const trimmed = new Uint8Array(canonical.length - firstNonZero + 1)
  trimmed[0] = canonical[0]
  trimmed.set(canonical.subarray(firstNonZero), 1)
  return [canonical, trimmed]
}

/**
 * Derives the AES-256-GCM key for each ECDH point encoding, canonical first. The IKM is the
 * 33-byte compressed shared point with x zero-padded to 32 bytes; the envelope version is
 * unchanged because that is the encoding every working v2 pair already used. Writers use only
 * the first key; readers try the rest when the authentication tag rejects it.
 */
function deriveV2Keys(params: {
  privateKey: PrivateKey
  publicKey: Uint8Array
  salt: Buffer
}): Buffer[] {
  return sharedPointEncodings(params.privateKey, params.publicKey).map(
    ecdhPoint => {
      // RFC 5869 extract + the first (and only) expand block. SHA-256 emits the requested 32
      // bytes in one block: PRK = HMAC(salt, IKM), OKM = HMAC(PRK, info || 0x01).
      const pseudorandomKey = hmacSha256(ecdhPoint, params.salt)
      return Buffer.from(
        hmacSha256(
          Buffer.concat([HKDF_INFO, Buffer.from([1])]),
          pseudorandomKey,
        ),
      )
    },
  )
}

/** AES-CBC split used by already-stored v1 records: 16-byte IV, then the key. */
function decryptLegacyCiphertext(
  sharedKey: Buffer,
  cipherText: Buffer,
): Uint8Array {
  const iv = forge.util.createBuffer(sharedKey.slice(0, 16).toString('binary'))
  const key = forge.util.createBuffer(sharedKey.slice(16).toString('binary'))
  const cipher = forge.cipher.createDecipher('AES-CBC', key)
  cipher.start({ iv })
  const rawBuffer = forge.util.createBuffer(cipherText.toString('binary'))
  cipher.update(rawBuffer)
  cipher.finish()
  return Uint8Array.from(Buffer.from(cipher.output.toHex(), 'hex'))
}

/**
 * @deprecated Compatibility writer for tests and pre-CBOR peers. Live wallet and bot sends use
 * {@link buildFrankCborEnvelope}; this remains only until the legacy fixture suite is migrated.
 */
export function buildEnvelope(params: {
  fromAddress: string
  fromPrivateKey: PrivateKey
  toAddress: string
  toPubKey: Uint8Array
  plaintext: string
  networkTag: string
}): Uint8Array {
  if (!isAddress(params.fromAddress) || !isAddress(params.toAddress)) {
    throw new Error('Monad envelope addresses must be 0x-prefixed 20-byte hex')
  }
  if (!isNetworkTag(params.networkTag)) {
    throw new Error('Monad envelope networkTag must be 1..32 UTF-8 bytes')
  }
  const plaintext = Buffer.from(params.plaintext, 'utf8')
  if (plaintext.length === 0 || plaintext.length > MAX_V2_CIPHERTEXT_BYTES) {
    throw new Error(
      `Monad envelope plaintext must be 1..${MAX_V2_CIPHERTEXT_BYTES} UTF-8 bytes`,
    )
  }
  const salt = Buffer.from(randomBytes(HKDF_SALT_BYTES))
  const nonce = Buffer.from(randomBytes(GCM_NONCE_BYTES))
  const core = {
    networkTag: params.networkTag,
    from: params.fromAddress,
    to: params.toAddress,
  }
  const [key] = deriveV2Keys({
    privateKey: params.fromPrivateKey,
    publicKey: params.toPubKey,
    salt,
  })
  const cipher = forge.cipher.createCipher(
    'AES-GCM',
    forge.util.createBuffer(key.toString('binary')),
  )
  cipher.start({
    iv: forge.util.createBuffer(nonce.toString('binary')),
    additionalData: associatedData(core).toString('binary'),
    tagLength: GCM_TAG_BYTES * 8,
  })
  cipher.update(forge.util.createBuffer(plaintext.toString('binary')))
  if (!cipher.finish()) throw new Error('AES-GCM encryption failed')
  const envelope: MonadMessageEnvelopeV2 = {
    v: CURRENT_ENVELOPE_VERSION,
    ...core,
    salt: salt.toString('hex'),
    nonce: nonce.toString('hex'),
    ciphertext: cipher.output.toHex(),
    tag: cipher.mode.tag.toHex(),
  }
  return textEncoder.encode(JSON.stringify(envelope))
}

/** Builds the current Frank-CBOR type-5 schema-2 envelope for the relay payload. */
export function buildFrankCborEnvelope(params: {
  fromAddress: string
  fromPrivateKey: PrivateKey
  toAddress: string
  toPubKey: Uint8Array
  plaintext: string
  /** Frank network tag (for example `MONT`), not an EVM chain ID. */
  networkTag: string
}): Uint8Array {
  if (!isAddress(params.fromAddress) || !isAddress(params.toAddress)) {
    throw new Error('Monad envelope addresses must be 0x-prefixed 20-byte hex')
  }
  if (!isNetworkTag(params.networkTag)) {
    throw new Error('Monad envelope networkTag must be 1..32 UTF-8 bytes')
  }
  const plaintext = Buffer.from(params.plaintext, 'utf8')
  if (plaintext.length === 0 || plaintext.length > MAX_V2_CIPHERTEXT_BYTES) {
    throw new Error(
      `Monad envelope plaintext must be 1..${MAX_V2_CIPHERTEXT_BYTES} UTF-8 bytes`,
    )
  }
  const network = params.networkTag.toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(network)) {
    throw new Error('Frank-CBOR network tag does not match S1')
  }

  const senderDh = ecdh(params.fromPrivateKey, GENERATOR)
  if (!senderDh.ok) throw new Error(`monad-envelope:${senderDh.error.code}`)
  const sender = account(senderDh.value.point)
  const recipient = account(params.toPubKey)
  if (
    evmAddress(sender.keyBytes).toLowerCase() !==
    params.fromAddress.toLowerCase()
  ) {
    throw new Error(
      'Monad envelope sender address does not match its private key',
    )
  }
  if (
    evmAddress(recipient.keyBytes).toLowerCase() !==
    params.toAddress.toLowerCase()
  ) {
    throw new Error(
      'Monad envelope recipient address does not match its public key',
    )
  }
  const stamp = createFrankStampProof({
    network,
    stampKey: recipient.keyBytes,
  })
  const contextFields = transitionalContext({
    network,
    sender,
    recipient,
    ephemeralPoint: stamp.ephemeralPoint,
    sharedPoint: stamp.sharedPoint,
    dleqProof: stamp.proof,
  })
  const sealed = seal({
    suiteId: SUITE_AUTH_XCHACHA,
    recipientPublicKey: recipient.keyBytes,
    senderPublicKey: sender.keyBytes,
    senderPrivateKey: params.fromPrivateKey.bytes,
    plaintext: Uint8Array.from(plaintext),
    context: encodeDirectMessageCryptoContext(contextFields),
  })
  if (!sealed.ok) throw new Error(`monad-envelope:${sealed.error.code}`)
  const accountMap = (value: AccountRef) =>
    cborMap([
      [0, value.keyType],
      [1, value.keyBytes],
    ])
  return encodeFrame(
    { typeId: 5, schemaVersion: 2, minReaderVersion: 2 },
    cborMap([
      [0, network],
      [1, accountMap(sender)],
      [2, accountMap(recipient)],
      [3, SUITE_AUTH_XCHACHA],
      [4, sealed.value],
      [5, stamp.ephemeralPoint],
      [6, stamp.sharedPoint],
      [7, stamp.proof],
    ]),
  )
}

/**
 * Parses stored envelope bytes. V2 is the current authenticated format; v1 is returned only for
 * explicit read compatibility. Unsupported versions and malformed fields are rejected.
 */
export function parseEnvelope(
  bytes: Uint8Array,
): MonadMessageEnvelope | undefined {
  try {
    const frame = parseFrame(bytes)
    if (
      frame.kind === 'parsed' &&
      frame.typed?.type === 5 &&
      frame.typed.schemaVersion === 2
    ) {
      const typed = frame.typed as RecipientEncryptedPayloadV2
      if (
        typed.suite !== SUITE_AUTH_XCHACHA ||
        typed.sender.keyType !== 1 ||
        typed.recipient.keyType !== 1 ||
        !verifyFrankStampProof({
          network: typed.network,
          stampKey: typed.recipient.keyBytes,
          ephemeralPoint: typed.ephemeralPoint,
          sharedPoint: typed.sharedPoint,
          proof: typed.dleqProof,
        })
      ) {
        return undefined
      }
      return {
        v: FRANK_CBOR_ENVELOPE_VERSION,
        networkTag: typed.network,
        from: evmAddress(typed.sender.keyBytes),
        to: evmAddress(typed.recipient.keyBytes),
        sender: typed.sender,
        recipient: typed.recipient,
        cryptoBoxEnvelope: typed.cryptoBoxEnvelope,
        ephemeralPoint: typed.ephemeralPoint,
        sharedPoint: typed.sharedPoint,
        dleqProof: typed.dleqProof,
      }
    }
  } catch {
    // Continue into explicitly retained legacy JSON reads.
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(textDecoder.decode(bytes))
  } catch {
    return undefined
  }
  if (isMonadMessageEnvelopeV2(parsed)) return parsed
  if (isLegacyMonadMessageEnvelopeV1(parsed)) return parsed
  return undefined
}

/** Decrypts the current authenticated v2 format. Authentication failure throws. */
export function decryptEnvelopeV2(params: {
  envelope: MonadMessageEnvelopeV2
  myPrivateKey: PrivateKey
  senderPubKey: Uint8Array
}): string {
  const salt = Buffer.from(params.envelope.salt, 'hex')
  const nonce = Buffer.from(params.envelope.nonce, 'hex')
  const ciphertext = Buffer.from(params.envelope.ciphertext, 'hex')
  const tag = Buffer.from(params.envelope.tag, 'hex')
  // Canonical key first. Only a GCM tag rejection moves on to the pre-#309 trimmed-x key, so an
  // envelope that authenticates under either key is never re-attempted or partially trusted.
  const keys = deriveV2Keys({
    privateKey: params.myPrivateKey,
    publicKey: params.senderPubKey,
    salt,
  })
  for (const key of keys) {
    const decipher = forge.cipher.createDecipher(
      'AES-GCM',
      forge.util.createBuffer(key.toString('binary')),
    )
    decipher.start({
      iv: forge.util.createBuffer(nonce.toString('binary')),
      additionalData: associatedData(params.envelope).toString('binary'),
      tagLength: GCM_TAG_BYTES * 8,
      tag: forge.util.createBuffer(tag.toString('binary')),
    })
    decipher.update(forge.util.createBuffer(ciphertext.toString('binary')))
    if (decipher.finish()) {
      return textDecoder.decode(Buffer.from(decipher.output.toHex(), 'hex'))
    }
  }
  throw new Error('Monad envelope authentication failed')
}

/** Opens the current Frank-CBOR suite-1 envelope. */
export function decryptEnvelopeV3(params: {
  envelope: MonadMessageEnvelopeV3
  myPrivateKey: PrivateKey
  senderPubKey: Uint8Array
}): string {
  if (
    Buffer.compare(
      Buffer.from(params.envelope.sender.keyBytes),
      Buffer.from(params.senderPubKey),
    ) !== 0
  ) {
    throw new Error('Monad envelope sender key does not match the directory')
  }
  const context = transitionalContext({
    network: params.envelope.networkTag,
    sender: params.envelope.sender,
    recipient: params.envelope.recipient,
    ephemeralPoint: params.envelope.ephemeralPoint,
    sharedPoint: params.envelope.sharedPoint,
    dleqProof: params.envelope.dleqProof,
  })
  const opened = open({
    envelope: Uint8Array.from(params.envelope.cryptoBoxEnvelope),
    recipientPrivateKey: Uint8Array.from(params.myPrivateKey.bytes),
    senderPublicKey: Uint8Array.from(params.senderPubKey),
    context: encodeDirectMessageCryptoContext(context),
  })
  if (!opened.ok) throw new Error(`monad-envelope:${opened.error.code}`)
  return textDecoder.decode(opened.value)
}

/**
 * Decrypts an already-stored legacy v1 record. There is deliberately no v1 builder. V1 has no
 * authentication tag, so the pre-#309 trimmed-x key is tried only when the canonical key's output
 * is not valid UTF-8 (the historical read contract); a wrong key yields garbage that fails that
 * check with overwhelming probability, but this is a heuristic rather than a proof.
 */
export function decryptLegacyEnvelopeV1(params: {
  envelope: LegacyMonadMessageEnvelopeV1
  myPrivateKey: PrivateKey
  senderPubKey: Uint8Array
}): string {
  const salt = Buffer.from(params.envelope.salt, 'hex')
  const sharedKeys = sharedPointEncodings(
    params.myPrivateKey,
    params.senderPubKey,
  ).map(rawMergedKey => Buffer.from(hmacSha256(salt, rawMergedKey)))
  const ciphertext = Buffer.from(params.envelope.ciphertext, 'hex')
  let failure: unknown
  for (const sharedKey of sharedKeys) {
    try {
      return textDecoder.decode(decryptLegacyCiphertext(sharedKey, ciphertext))
    } catch (error) {
      failure = error
    }
  }
  throw failure
}

/** Decrypts a parsed stored envelope, dispatching v1 only to its named read-only path. */
export function decryptEnvelope(params: {
  envelope: MonadMessageEnvelope
  myPrivateKey: PrivateKey
  senderPubKey: Uint8Array
}): string {
  if (params.envelope.v === FRANK_CBOR_ENVELOPE_VERSION) {
    return decryptEnvelopeV3({
      envelope: params.envelope,
      myPrivateKey: params.myPrivateKey,
      senderPubKey: params.senderPubKey,
    })
  }
  if (params.envelope.v === CURRENT_ENVELOPE_VERSION) {
    return decryptEnvelopeV2({
      envelope: params.envelope,
      myPrivateKey: params.myPrivateKey,
      senderPubKey: params.senderPubKey,
    })
  }
  return decryptLegacyEnvelopeV1({
    envelope: params.envelope,
    myPrivateKey: params.myPrivateKey,
    senderPubKey: params.senderPubKey,
  })
}

/** Canonical durable key for a syntactically valid EVM identity; non-address keys stay distinct. */
export function canonicalMonadEnvelopeAddress(address: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : address
}

/** Compare relay-visible EVM identities without making checksum casing part of identity. */
export function sameMonadEnvelopeAddress(left: string, right: string): boolean {
  return (
    canonicalMonadEnvelopeAddress(left) === canonicalMonadEnvelopeAddress(right)
  )
}

/**
 * Decrypt one untrusted stored record without allowing a malformed key or failed authentication
 * tag to abort a mailbox polling loop. Callers must treat `undefined` as a rejected record.
 */
export function tryDecryptEnvelope(params: {
  envelope: MonadMessageEnvelope
  myPrivateKey: PrivateKey
  senderPubKey: Uint8Array
}): string | undefined {
  try {
    return decryptEnvelope(params)
  } catch {
    return undefined
  }
}
