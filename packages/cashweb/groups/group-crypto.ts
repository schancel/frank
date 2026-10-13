import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { randomBytes } from '@frank/crypto-box'

const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

export const GROUP_ID_DOMAIN = 'frank-group-v1'
export const GROUP_IDENTIFIER_PREFIX = 'group:'
export const GROUP_EPOCH_SIGN_DOMAIN = 'frank-group-epoch-v1'
export const GROUP_MSG_WRITE_SIGN_DOMAIN = 'frank-group-msg-write-v1'
export const GROUP_INNER_MSG_SIGN_DOMAIN = 'frank-group-inner-msg-v1'
export const GROUP_MSG_AEAD_DOMAIN = 'frank-group-aead-v1'
export const GROUP_ROSTER_AEAD_DOMAIN = 'frank-group-roster-v1'

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0')
  }
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, '').toLowerCase()
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/.test(clean)) {
    throw new Error(`Invalid hex string (length ${clean.length})`)
  }
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function u64Be(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid non-negative integer for u64: ${value}`)
  }
  const buf = new Uint8Array(8)
  const view = new DataView(buf.buffer)
  const hi = Math.floor(value / 0x100000000)
  const lo = value >>> 0
  view.setUint32(0, hi, false)
  view.setUint32(4, lo, false)
  return buf
}

function u32Be(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`Invalid u32: ${value}`)
  }
  const buf = new Uint8Array(4)
  new DataView(buf.buffer).setUint32(0, value >>> 0, false)
  return buf
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let acc = 0n
  for (let i = 0; i < bytes.length; i += 1) {
    acc = (acc << 8n) | BigInt(bytes[i] ?? 0)
  }
  return acc
}

function bigIntTo32Bytes(value: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let rem = value
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(rem & 0xffn)
    rem >>= 8n
  }
  return out
}

/**
 * Maps arbitrary 32-byte material deterministically into a valid secp256k1 scalar in `[1, n - 1]`.
 */
export function normalizeSecp256k1Scalar(material32: Uint8Array): Uint8Array {
  if (material32.length !== 32) {
    throw new Error(`Expected 32 bytes for scalar, got ${material32.length}`)
  }
  const raw = bytesToBigInt(material32)
  const scalar = (raw % (SECP256K1_N - 1n)) + 1n
  return bigIntTo32Bytes(scalar)
}

export function formatGroupIdentifier(groupIdHex: string): string {
  const clean = groupIdHex.trim().replace(/^group:/i, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error(`groupIdHex must be 64 hex chars, got: ${groupIdHex}`)
  }
  return `${GROUP_IDENTIFIER_PREFIX}${clean}`
}

export function isGroupIdentifier(value: string | undefined | null): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim().toLowerCase()
  if (!trimmed.startsWith(GROUP_IDENTIFIER_PREFIX)) return false
  const hex = trimmed.slice(GROUP_IDENTIFIER_PREFIX.length)
  return /^[0-9a-f]{64}$/.test(hex)
}

export function parseGroupIdentifier(value: string): string | null {
  if (!isGroupIdentifier(value)) return null
  return value.trim().toLowerCase().slice(GROUP_IDENTIFIER_PREFIX.length)
}

/**
 * Deterministic UUIDv5-shaped conversation ID derived from `groupIdHex` so all group members
 * address the group conversation by the exact same UUID without leaking `group_id` directly.
 */
export function groupConversationUuid(groupIdHex: string): string {
  const clean = groupIdHex.trim().replace(/^group:/i, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error(`Invalid groupIdHex: ${groupIdHex}`)
  }
  const digest = sha256(
    concatBytes(
      utf8Encoder.encode('frank-group-conversation-uuid-v1:'),
      hexToBytes(clean),
    ),
  )
  const b = new Uint8Array(digest.slice(0, 16))
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x50 // version 5
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80 // RFC 4122 variant
  const hex = bytesToHex(b)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export interface GroupIdentity {
  readonly groupSecretKey: Uint8Array
  readonly groupSecretKeyHex: string
  readonly groupPubKey: Uint8Array
  readonly groupPubKeyHex: string
  readonly groupIdBytes: Uint8Array
  readonly groupIdHex: string
  readonly groupIdentifier: string
  readonly conversationId: string
}

/**
 * Derives the group root keypair $(k_G, P_G)$ and $\text{group\_id} = \text{SHA256}(\text{"frank-group-v1"} \parallel P_G)$.
 */
export function deriveGroupIdentity(
  groupSeed: Uint8Array = randomBytes(32),
): GroupIdentity {
  if (groupSeed.length !== 32) {
    throw new Error(`groupSeed must be 32 bytes, got ${groupSeed.length}`)
  }
  const groupSecretKey = normalizeSecp256k1Scalar(groupSeed)
  const groupPubKey = secp256k1.getPublicKey(groupSecretKey, true)
  const groupPubKeyHex = bytesToHex(groupPubKey)
  const groupIdBytes = sha256(
    concatBytes(utf8Encoder.encode(GROUP_ID_DOMAIN), groupPubKey),
  )
  const groupIdHex = bytesToHex(groupIdBytes)
  const groupIdentifier = formatGroupIdentifier(groupIdHex)
  const conversationId = groupConversationUuid(groupIdHex)
  return {
    groupSecretKey,
    groupSecretKeyHex: bytesToHex(groupSecretKey),
    groupPubKey,
    groupPubKeyHex,
    groupIdBytes,
    groupIdHex,
    groupIdentifier,
    conversationId,
  }
}

export function computeGroupIdFromPubKey(
  groupPubKey: Uint8Array | string,
): string {
  const pubBytes =
    typeof groupPubKey === 'string' ? hexToBytes(groupPubKey) : groupPubKey
  if (pubBytes.length !== 33) {
    throw new Error(
      `Expected 33-byte compressed groupPubKey, got ${pubBytes.length}`,
    )
  }
  return bytesToHex(
    sha256(concatBytes(utf8Encoder.encode(GROUP_ID_DOMAIN), pubBytes)),
  )
}

export interface GroupKeyPair {
  readonly privateKey: Uint8Array
  readonly privateKeyHex: string
  readonly publicKey: Uint8Array
  readonly publicKeyHex: string
}

export interface GroupEpochKeys {
  readonly groupIdHex: string
  readonly epoch: number
  readonly epochSecret: Uint8Array
  readonly epochSecretHex: string
  /** $K_e = \text{HKDF-SHA256}(S_e, \text{group\_id}, \text{"frank-group-enc:"} \parallel e)$ */
  readonly encryptionKey: Uint8Array
  readonly encryptionKeyHex: string
  /** $w_e = \text{HKDF-SHA256}(S_e, \text{group\_id}, \text{"frank-group-write:"} \parallel e)$, $W_{G,e} = w_e \cdot G$ */
  readonly writeKeyPair: GroupKeyPair
  /** $R_e = \text{HKDF-SHA256}(S_e, \text{group\_id}, \text{"frank-group-read:"} \parallel e)$ */
  readonly readToken: Uint8Array
  readonly readTokenHex: string
  /** $\text{SHA256}(R_e)$ stored in the relay's `G_meta` epoch frame */
  readonly readTokenHash: Uint8Array
  readonly readTokenHashHex: string
}

/**
 * Derives the per-epoch symmetric encryption key $K_e$, shared write keypair $(w_e, W_{G,e})$,
 * and relay read token $R_e$ from the 32-byte epoch secret $S_e$.
 */
export function deriveEpochKeys(
  epochSecret: Uint8Array,
  groupIdHex: string,
  epoch: number,
): GroupEpochKeys {
  if (epochSecret.length !== 32) {
    throw new Error(`epochSecret must be 32 bytes, got ${epochSecret.length}`)
  }
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error(`epoch must be a non-negative integer, got ${epoch}`)
  }
  const cleanGroupId = groupIdHex.trim().replace(/^group:/i, '').toLowerCase()
  const groupIdBytes = hexToBytes(cleanGroupId)
  if (groupIdBytes.length !== 32) {
    throw new Error(`groupIdHex must decode to 32 bytes`)
  }

  const encryptionKey = hkdf(
    sha256,
    epochSecret,
    groupIdBytes,
    utf8Encoder.encode(`frank-group-enc:${epoch}`),
    32,
  )
  const rawWriteSecret = hkdf(
    sha256,
    epochSecret,
    groupIdBytes,
    utf8Encoder.encode(`frank-group-write:${epoch}`),
    32,
  )
  const writePrivateKey = normalizeSecp256k1Scalar(rawWriteSecret)
  const writePublicKey = secp256k1.getPublicKey(writePrivateKey, true)

  const readToken = hkdf(
    sha256,
    epochSecret,
    groupIdBytes,
    utf8Encoder.encode(`frank-group-read:${epoch}`),
    32,
  )
  const readTokenHash = sha256(readToken)

  return {
    groupIdHex: cleanGroupId,
    epoch,
    epochSecret: new Uint8Array(epochSecret),
    epochSecretHex: bytesToHex(epochSecret),
    encryptionKey,
    encryptionKeyHex: bytesToHex(encryptionKey),
    writeKeyPair: {
      privateKey: writePrivateKey,
      privateKeyHex: bytesToHex(writePrivateKey),
      publicKey: writePublicKey,
      publicKeyHex: bytesToHex(writePublicKey),
    },
    readToken,
    readTokenHex: bytesToHex(readToken),
    readTokenHash,
    readTokenHashHex: bytesToHex(readTokenHash),
  }
}

/**
 * Derives a member's per-epoch ephemeral signing keypair $(s_{i,e}, S_{i,e})$:
 * $s_{i,e} = \text{HKDF-SHA256}(\text{memberSecretSeed}, \text{group\_id}, \text{"frank-group-member-sig:"} \parallel e)$.
 *
 * Rotating $S_{i,e}$ every epoch ensures a member's signatures cannot be correlated across
 * epochs or groups even if an epoch roster is later compromised.
 */
export function deriveMemberEpochSigningKey(
  memberSecretSeed: Uint8Array,
  groupIdHex: string,
  epoch: number,
): GroupKeyPair {
  if (memberSecretSeed.length !== 32) {
    throw new Error(
      `memberSecretSeed must be 32 bytes, got ${memberSecretSeed.length}`,
    )
  }
  const cleanGroupId = groupIdHex.trim().replace(/^group:/i, '').toLowerCase()
  const groupIdBytes = hexToBytes(cleanGroupId)
  if (groupIdBytes.length !== 32) {
    throw new Error(`groupIdHex must decode to 32 bytes`)
  }
  const raw = hkdf(
    sha256,
    memberSecretSeed,
    groupIdBytes,
    utf8Encoder.encode(`frank-group-member-sig:${epoch}`),
    32,
  )
  const privateKey = normalizeSecp256k1Scalar(raw)
  const publicKey = secp256k1.getPublicKey(privateKey, true)
  return {
    privateKey,
    privateKeyHex: bytesToHex(privateKey),
    publicKey,
    publicKeyHex: bytesToHex(publicKey),
  }
}

export interface GroupRosterMember {
  readonly index: number
  readonly address: string
  readonly epochSigningPubKeyHex: string
  readonly role?: 'admin' | 'member'
}

export interface GroupRoster {
  readonly epoch: number
  readonly groupName: string
  readonly homeRelay: string
  readonly members: readonly GroupRosterMember[]
}

function buildRosterAad(groupIdBytes: Uint8Array, epoch: number): Uint8Array {
  return concatBytes(
    utf8Encoder.encode(GROUP_ROSTER_AEAD_DOMAIN),
    groupIdBytes,
    u64Be(epoch),
  )
}

/**
 * Encrypts the `GroupRoster` under $K_e$ (`XChaCha20-Poly1305`), prefixing the 24-byte nonce
 * to the ciphertext so it can be stored directly in `GroupEpochFrame.encrypted_roster`.
 */
export function encryptGroupRoster(
  roster: GroupRoster,
  epochKeys: GroupEpochKeys,
  nonce: Uint8Array = randomBytes(24),
): Uint8Array {
  if (nonce.length !== 24) {
    throw new Error(`Nonce must be 24 bytes, got ${nonce.length}`)
  }
  const groupIdBytes = hexToBytes(epochKeys.groupIdHex)
  const aad = buildRosterAad(groupIdBytes, epochKeys.epoch)
  const plaintext = utf8Encoder.encode(JSON.stringify(roster))
  const ciphertext = xchacha20poly1305(
    epochKeys.encryptionKey,
    nonce,
    aad,
  ).encrypt(plaintext)
  return concatBytes(nonce, ciphertext)
}

/**
 * Decrypts `encrypted_roster` (`nonce_24 || ciphertext_with_tag`) under $K_e$.
 */
export function decryptGroupRoster(
  encryptedRoster: Uint8Array | string,
  epochKeys: GroupEpochKeys,
): GroupRoster {
  const raw =
    typeof encryptedRoster === 'string'
      ? hexToBytes(encryptedRoster)
      : encryptedRoster
  if (raw.length < 24 + 16) {
    throw new Error('Encrypted roster is too short')
  }
  const nonce = raw.slice(0, 24)
  const ciphertext = raw.slice(24)
  const groupIdBytes = hexToBytes(epochKeys.groupIdHex)
  const aad = buildRosterAad(groupIdBytes, epochKeys.epoch)
  const plaintext = xchacha20poly1305(
    epochKeys.encryptionKey,
    nonce,
    aad,
  ).decrypt(ciphertext)
  const parsed = JSON.parse(utf8Decoder.decode(plaintext)) as GroupRoster
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    parsed.epoch !== epochKeys.epoch ||
    !Array.isArray(parsed.members)
  ) {
    throw new Error('Decrypted roster failed validation')
  }
  return parsed
}

export interface GroupEpochFrameWire {
  readonly epoch: number
  readonly group_pubkey: string
  readonly prev_epoch_hash: string
  readonly write_pubkey: string
  readonly read_token_hash: string
  readonly encrypted_roster: string
  readonly authority_sig: string
  readonly epoch_hash?: string
}

export function computeEpochSigningHash(params: {
  groupIdHex: string
  epoch: number
  prevEpochHashHex: string
  writePubKeyHex: string
  readTokenHashHex: string
  encryptedRoster: Uint8Array | string
}): Uint8Array {
  const groupIdBytes = hexToBytes(params.groupIdHex)
  const prevHashBytes = hexToBytes(params.prevEpochHashHex)
  const writePubKeyBytes = hexToBytes(params.writePubKeyHex)
  const readTokenHashBytes = hexToBytes(params.readTokenHashHex)
  const rosterBytes =
    typeof params.encryptedRoster === 'string'
      ? hexToBytes(params.encryptedRoster)
      : params.encryptedRoster
  const rosterHash = sha256(rosterBytes)

  return sha256(
    concatBytes(
      utf8Encoder.encode(GROUP_EPOCH_SIGN_DOMAIN),
      groupIdBytes,
      u64Be(params.epoch),
      prevHashBytes,
      writePubKeyBytes,
      readTokenHashBytes,
      rosterHash,
    ),
  )
}

export function signEpochFrame(params: {
  groupIdHex: string
  groupPubKeyHex: string
  epoch: number
  prevEpochHashHex?: string
  epochKeys: GroupEpochKeys
  encryptedRoster: Uint8Array | string
  authorityPrivateKey: Uint8Array
}): GroupEpochFrameWire {
  const prevEpochHashHex = (
    params.prevEpochHashHex ?? '00'.repeat(32)
  ).toLowerCase()
  const encryptedRosterHex =
    typeof params.encryptedRoster === 'string'
      ? params.encryptedRoster.toLowerCase()
      : bytesToHex(params.encryptedRoster)
  const digest = computeEpochSigningHash({
    groupIdHex: params.groupIdHex,
    epoch: params.epoch,
    prevEpochHashHex,
    writePubKeyHex: params.epochKeys.writeKeyPair.publicKeyHex,
    readTokenHashHex: params.epochKeys.readTokenHashHex,
    encryptedRoster: encryptedRosterHex,
  })
  const sig = secp256k1.sign(digest, params.authorityPrivateKey, {
    lowS: true,
  })
  const authoritySigHex = bytesToHex(sig.toCompactRawBytes())
  const epochHashHex = bytesToHex(
    sha256(concatBytes(digest, sig.toCompactRawBytes())),
  )
  return {
    epoch: params.epoch,
    group_pubkey: params.groupPubKeyHex.toLowerCase(),
    prev_epoch_hash: prevEpochHashHex,
    write_pubkey: params.epochKeys.writeKeyPair.publicKeyHex,
    read_token_hash: params.epochKeys.readTokenHashHex,
    encrypted_roster: encryptedRosterHex,
    authority_sig: authoritySigHex,
    epoch_hash: epochHashHex,
  }
}

export function verifyEpochFrame(
  frame: GroupEpochFrameWire,
  groupIdHex: string,
  authorityPubKeyHex: string,
): boolean {
  try {
    const digest = computeEpochSigningHash({
      groupIdHex,
      epoch: frame.epoch,
      prevEpochHashHex: frame.prev_epoch_hash,
      writePubKeyHex: frame.write_pubkey,
      readTokenHashHex: frame.read_token_hash,
      encryptedRoster: frame.encrypted_roster,
    })
    const sig = secp256k1.Signature.fromCompact(hexToBytes(frame.authority_sig))
    if (sig.hasHighS()) return false
    return secp256k1.verify(sig, digest, hexToBytes(authorityPubKeyHex), {
      lowS: true,
    })
  } catch {
    return false
  }
}

export interface GroupInnerMessageFrame {
  readonly groupId: string
  readonly epoch: number
  readonly senderIndex: number
  readonly senderEpochPubKeyHex: string
  readonly senderAddress?: string
  readonly timestampMs: number
  readonly payloadHex: string
  readonly innerSigHex: string
}

export interface SealedGroupMessageEnvelope {
  readonly epoch: number
  readonly nonce: string
  readonly ciphertext: string
  readonly write_sig: string
}

export function computeInnerMessageSigningHash(params: {
  groupIdHex: string
  epoch: number
  senderIndex: number
  senderEpochPubKey: Uint8Array
  timestampMs: number
  payload: Uint8Array
}): Uint8Array {
  const groupIdBytes = hexToBytes(params.groupIdHex)
  const payloadHash = sha256(params.payload)
  return sha256(
    concatBytes(
      utf8Encoder.encode(GROUP_INNER_MSG_SIGN_DOMAIN),
      groupIdBytes,
      u64Be(params.epoch),
      u32Be(params.senderIndex),
      params.senderEpochPubKey,
      u64Be(params.timestampMs),
      payloadHash,
    ),
  )
}

export function computeOuterWriteSigningHash(params: {
  groupIdHex: string
  epoch: number
  nonce: Uint8Array
  ciphertext: Uint8Array
}): Uint8Array {
  const groupIdBytes = hexToBytes(params.groupIdHex)
  const ciphertextHash = sha256(params.ciphertext)
  return sha256(
    concatBytes(
      utf8Encoder.encode(GROUP_MSG_WRITE_SIGN_DOMAIN),
      groupIdBytes,
      u64Be(params.epoch),
      params.nonce,
      ciphertextHash,
    ),
  )
}

function buildMessageAad(groupIdBytes: Uint8Array, epoch: number): Uint8Array {
  return concatBytes(
    utf8Encoder.encode(GROUP_MSG_AEAD_DOMAIN),
    groupIdBytes,
    u64Be(epoch),
  )
}

/**
 * Seals a group message in two cryptographic layers:
 * 1. Signs the inner payload with the sender's per-epoch ephemeral key $s_{i,e}$ ($S_{i,e}$),
 *    binding `groupId`, `epoch`, `senderIndex`, `timestampMs`, and `payload`.
 * 2. Encrypts the inner signed frame with `XChaCha20-Poly1305` under the shared epoch key $K_e$,
 *    and signs the outer `(group_id, epoch, nonce, ciphertext)` tuple with the shared epoch write
 *    key $w_e$ ($W_{G,e}$) so the relay can reject spam without learning which member sent it.
 */
export function sealGroupMessage(params: {
  epochKeys: GroupEpochKeys
  senderIndex: number
  senderEpochKeyPair: GroupKeyPair
  payload: Uint8Array | string
  senderAddress?: string
  timestampMs?: number
  nonce?: Uint8Array
}): SealedGroupMessageEnvelope {
  const { epochKeys, senderIndex, senderEpochKeyPair } = params
  const payloadBytes =
    typeof params.payload === 'string'
      ? utf8Encoder.encode(params.payload)
      : params.payload
  const timestampMs = params.timestampMs ?? Date.now()
  const nonce = params.nonce ?? randomBytes(24)
  if (nonce.length !== 24) {
    throw new Error(`Nonce must be 24 bytes, got ${nonce.length}`)
  }

  const innerDigest = computeInnerMessageSigningHash({
    groupIdHex: epochKeys.groupIdHex,
    epoch: epochKeys.epoch,
    senderIndex,
    senderEpochPubKey: senderEpochKeyPair.publicKey,
    timestampMs,
    payload: payloadBytes,
  })
  const innerSig = secp256k1
    .sign(innerDigest, senderEpochKeyPair.privateKey, { lowS: true })
    .toCompactRawBytes()

  const innerFrame: GroupInnerMessageFrame = {
    groupId: epochKeys.groupIdHex,
    epoch: epochKeys.epoch,
    senderIndex,
    senderEpochPubKeyHex: senderEpochKeyPair.publicKeyHex,
    ...(params.senderAddress ? { senderAddress: params.senderAddress } : {}),
    timestampMs,
    payloadHex: bytesToHex(payloadBytes),
    innerSigHex: bytesToHex(innerSig),
  }

  const innerPlaintext = utf8Encoder.encode(JSON.stringify(innerFrame))
  const groupIdBytes = hexToBytes(epochKeys.groupIdHex)
  const aad = buildMessageAad(groupIdBytes, epochKeys.epoch)
  const ciphertext = xchacha20poly1305(
    epochKeys.encryptionKey,
    nonce,
    aad,
  ).encrypt(innerPlaintext)

  const outerDigest = computeOuterWriteSigningHash({
    groupIdHex: epochKeys.groupIdHex,
    epoch: epochKeys.epoch,
    nonce,
    ciphertext,
  })
  const writeSig = secp256k1
    .sign(outerDigest, epochKeys.writeKeyPair.privateKey, { lowS: true })
    .toCompactRawBytes()

  return {
    epoch: epochKeys.epoch,
    nonce: bytesToHex(nonce),
    ciphertext: bytesToHex(ciphertext),
    write_sig: bytesToHex(writeSig),
  }
}

export interface OpenedGroupMessage {
  readonly groupId: string
  readonly epoch: number
  readonly senderIndex: number
  readonly senderEpochPubKeyHex: string
  readonly senderAddress?: string
  readonly timestampMs: number
  readonly payload: Uint8Array
  readonly payloadText: string
}

/**
 * Verifies the outer shared write signature ($W_{G,e}$), decrypts the `XChaCha20-Poly1305`
 * ciphertext under $K_e$, verifies the sender's per-epoch public key $S_{i,e}$ against the
 * epoch roster (if provided), and verifies the inner signature over the payload.
 */
export function openGroupMessage(params: {
  envelope: SealedGroupMessageEnvelope
  epochKeys: GroupEpochKeys
  roster?: GroupRoster | readonly GroupRosterMember[]
}): OpenedGroupMessage {
  const { envelope, epochKeys, roster } = params
  if (envelope.epoch !== epochKeys.epoch) {
    throw new Error(
      `Envelope epoch ${envelope.epoch} does not match epochKeys epoch ${epochKeys.epoch}`,
    )
  }
  const nonce = hexToBytes(envelope.nonce)
  if (nonce.length !== 24) {
    throw new Error(`Invalid nonce length: ${nonce.length}`)
  }
  const ciphertext = hexToBytes(envelope.ciphertext)
  const writeSigBytes = hexToBytes(envelope.write_sig)

  // 1. Verify outer shared write signature W_{G,e}
  const outerDigest = computeOuterWriteSigningHash({
    groupIdHex: epochKeys.groupIdHex,
    epoch: epochKeys.epoch,
    nonce,
    ciphertext,
  })
  const outerSig = secp256k1.Signature.fromCompact(writeSigBytes)
  if (
    outerSig.hasHighS() ||
    !secp256k1.verify(outerSig, outerDigest, epochKeys.writeKeyPair.publicKey, {
      lowS: true,
    })
  ) {
    throw new Error('Invalid outer group write signature')
  }

  // 2. Decrypt XChaCha20-Poly1305 ciphertext under K_e
  const groupIdBytes = hexToBytes(epochKeys.groupIdHex)
  const aad = buildMessageAad(groupIdBytes, epochKeys.epoch)
  let innerPlaintext: Uint8Array
  try {
    innerPlaintext = xchacha20poly1305(
      epochKeys.encryptionKey,
      nonce,
      aad,
    ).decrypt(ciphertext)
  } catch {
    throw new Error('Failed to decrypt group message ciphertext')
  }

  const innerFrame = JSON.parse(
    utf8Decoder.decode(innerPlaintext),
  ) as GroupInnerMessageFrame
  if (
    innerFrame.groupId !== epochKeys.groupIdHex ||
    innerFrame.epoch !== epochKeys.epoch
  ) {
    throw new Error('Inner group message metadata mismatch')
  }

  const senderEpochPubKey = hexToBytes(innerFrame.senderEpochPubKeyHex)
  if (senderEpochPubKey.length !== 33) {
    throw new Error('Invalid inner senderEpochPubKey length')
  }

  // 3. Check against epoch roster if supplied
  const members: readonly GroupRosterMember[] | undefined = Array.isArray(
    roster,
  )
    ? roster
    : roster
      ? (roster as GroupRoster).members
      : undefined
  let rosterAddress: string | undefined
  if (members) {
    const member = members.find(m => m.index === innerFrame.senderIndex)
    if (!member) {
      throw new Error(
        `Sender index ${innerFrame.senderIndex} is not in the epoch roster`,
      )
    }
    if (
      member.epochSigningPubKeyHex.toLowerCase() !==
      innerFrame.senderEpochPubKeyHex.toLowerCase()
    ) {
      throw new Error(
        `Sender epoch pubkey mismatch for member index ${innerFrame.senderIndex}`,
      )
    }
    rosterAddress = member.address
  }

  // 4. Verify inner member signature S_{i,e}
  const payload = hexToBytes(innerFrame.payloadHex)
  const innerDigest = computeInnerMessageSigningHash({
    groupIdHex: innerFrame.groupId,
    epoch: innerFrame.epoch,
    senderIndex: innerFrame.senderIndex,
    senderEpochPubKey,
    timestampMs: innerFrame.timestampMs,
    payload,
  })
  const innerSig = secp256k1.Signature.fromCompact(
    hexToBytes(innerFrame.innerSigHex),
  )
  if (
    innerSig.hasHighS() ||
    !secp256k1.verify(innerSig, innerDigest, senderEpochPubKey, { lowS: true })
  ) {
    throw new Error('Invalid inner member signature')
  }

  return {
    groupId: innerFrame.groupId,
    epoch: innerFrame.epoch,
    senderIndex: innerFrame.senderIndex,
    senderEpochPubKeyHex: innerFrame.senderEpochPubKeyHex.toLowerCase(),
    senderAddress: rosterAddress ?? innerFrame.senderAddress,
    timestampMs: innerFrame.timestampMs,
    payload,
    payloadText: utf8Decoder.decode(payload),
  }
}
