import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha256'
import { randomBytes } from '@frank/crypto-box'
import { fromHex, toHex, type EmailAttachment } from '@frank/codec'

import type {
  CanonicalFetch,
  CanonicalStreamResponse,
} from '../relay/canonical-dm-transport'

import type {
  BlobManifest,
  BlobManifestItem,
  EmailItem,
  ImageItem,
  MessageItem,
} from '../types/messages'

export type { BlobManifest, BlobManifestItem }

/** Attachments or images exceeding 32 KB are automatically split into encrypted chunks. */
export const INLINE_PAYLOAD_THRESHOLD_BYTES = 32 * 1024

/** Default plaintext size per chunk before XChaCha20-Poly1305 encryption (256 KB). */
export const CHUNK_PLAINTEXT_SIZE_BYTES = 256 * 1024

/** Domain separation prefix for chunk AAD binding. */
export const BLOB_CHUNK_AAD_DOMAIN = 'frank-blob-chunk-v1\0'

const AAD_DOMAIN_BYTES = new TextEncoder().encode(BLOB_CHUNK_AAD_DOMAIN)
const HEX64_RE = /^[0-9a-f]{64}$/i
const HEX48_RE = /^[0-9a-f]{48}$/i

export interface EncryptedBlobChunk {
  chunkHash: string
  ciphertext: Uint8Array
}

export interface SplitLargePayloadOptions {
  thresholdBytes?: number
  chunkSizeBytes?: number
  mimeType?: string
  fileName?: string
  targetItemIndex?: number
  targetAttachmentIndex?: number
  originRelayHint?: string
  symmetricKey?: Uint8Array
  baseNonce?: Uint8Array
}

export interface SplitLargePayloadResult {
  inlineBytes?: Uint8Array
  manifest?: BlobManifest
  encryptedChunks: EncryptedBlobChunk[]
}

export type BlobChunkUploadFn = (
  chunkHash: string,
  ciphertext: Uint8Array,
) => Promise<void>

export type BlobUploader =
  | BlobChunkUploadFn
  | {
      uploadChunk: BlobChunkUploadFn
      originRelayHint?: string
    }

export type BlobChunkFetchFn = (
  chunkHash: string,
  originRelayHint?: string,
) => Promise<Uint8Array>

export type BlobFetcher =
  | BlobChunkFetchFn
  | {
      fetchChunk: BlobChunkFetchFn
    }

export interface SplitMessageItemsOptions {
  thresholdBytes?: number
  chunkSizeBytes?: number
  originRelayHint?: string
}

/**
 * Derives the 24-byte XChaCha20-Poly1305 nonce for chunk `chunkIndex` by XORing `u32be(chunkIndex)`
 * into the last 4 bytes of `baseNonce`.
 */
export function deriveChunkNonce(
  baseNonce: Uint8Array,
  chunkIndex: number,
): Uint8Array {
  if (!(baseNonce instanceof Uint8Array) || baseNonce.byteLength !== 24) {
    throw new Error('baseNonce must be a 24-byte Uint8Array')
  }
  if (
    !Number.isInteger(chunkIndex) ||
    chunkIndex < 0 ||
    chunkIndex > 0xffffffff
  ) {
    throw new Error(`Invalid chunkIndex: ${chunkIndex}`)
  }
  const nonce = new Uint8Array(baseNonce)
  nonce[20] ^= (chunkIndex >>> 24) & 0xff
  nonce[21] ^= (chunkIndex >>> 16) & 0xff
  nonce[22] ^= (chunkIndex >>> 8) & 0xff
  nonce[23] ^= chunkIndex & 0xff
  return nonce
}

/**
 * Constructs the per-chunk AAD: `"frank-blob-chunk-v1\0" || rootPlaintextSha256 (32B) || u32be(i)`.
 */
export function buildChunkAad(
  rootPlaintextSha256: string,
  chunkIndex: number,
): Uint8Array {
  if (!HEX64_RE.test(rootPlaintextSha256)) {
    throw new Error('rootPlaintextSha256 must be 64 hex characters')
  }
  if (
    !Number.isInteger(chunkIndex) ||
    chunkIndex < 0 ||
    chunkIndex > 0xffffffff
  ) {
    throw new Error(`Invalid chunkIndex: ${chunkIndex}`)
  }
  const rootBytes = fromHex(rootPlaintextSha256.toLowerCase())
  const aad = new Uint8Array(AAD_DOMAIN_BYTES.byteLength + 32 + 4)
  aad.set(AAD_DOMAIN_BYTES, 0)
  aad.set(rootBytes, AAD_DOMAIN_BYTES.byteLength)
  const view = new DataView(
    aad.buffer,
    aad.byteOffset + AAD_DOMAIN_BYTES.byteLength + 32,
    4,
  )
  view.setUint32(0, chunkIndex, false)
  return aad
}

/**
 * Splits a payload exceeding `thresholdBytes` (default 32 KB) into `chunkSizeBytes` (default 256 KB)
 * chunks encrypted with XChaCha20-Poly1305 and addressed by `SHA256(ciphertext)`.
 */
export function splitLargePayload(
  bytes: Uint8Array,
  options?: SplitLargePayloadOptions,
): SplitLargePayloadResult {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('bytes must be a Uint8Array')
  }
  const thresholdBytes =
    options?.thresholdBytes ?? INLINE_PAYLOAD_THRESHOLD_BYTES
  const chunkSizeBytes = options?.chunkSizeBytes ?? CHUNK_PLAINTEXT_SIZE_BYTES
  if (!Number.isInteger(thresholdBytes) || thresholdBytes < 0) {
    throw new Error('thresholdBytes must be a non-negative integer')
  }
  if (!Number.isInteger(chunkSizeBytes) || chunkSizeBytes <= 0) {
    throw new Error('chunkSizeBytes must be a positive integer')
  }

  if (bytes.byteLength <= thresholdBytes) {
    return {
      inlineBytes: bytes,
      encryptedChunks: [],
    }
  }

  const symmetricKey = options?.symmetricKey ?? randomBytes(32)
  if (!(symmetricKey instanceof Uint8Array) || symmetricKey.byteLength !== 32) {
    throw new Error('symmetricKey must be a 32-byte Uint8Array')
  }
  const baseNonce = options?.baseNonce ?? randomBytes(24)
  if (!(baseNonce instanceof Uint8Array) || baseNonce.byteLength !== 24) {
    throw new Error('baseNonce must be a 24-byte Uint8Array')
  }

  const rootPlaintextSha256 = toHex(sha256(bytes))
  const encryptedChunks: EncryptedBlobChunk[] = []
  const chunkHashes: string[] = []

  let chunkIndex = 0
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSizeBytes) {
    const end = Math.min(offset + chunkSizeBytes, bytes.byteLength)
    const plaintextChunk = bytes.subarray(offset, end)
    const nonce = deriveChunkNonce(baseNonce, chunkIndex)
    const aad = buildChunkAad(rootPlaintextSha256, chunkIndex)
    const ciphertext = xchacha20poly1305(symmetricKey, nonce, aad).encrypt(
      plaintextChunk,
    )
    const chunkHash = toHex(sha256(ciphertext))
    encryptedChunks.push({ chunkHash, ciphertext })
    chunkHashes.push(chunkHash)
    chunkIndex += 1
  }

  const manifest: BlobManifest = {
    version: 1,
    rootPlaintextSha256,
    totalPlaintextBytes: bytes.byteLength,
    chunkSize: chunkSizeBytes,
    symmetricKeyHex: toHex(symmetricKey),
    baseNonceHex: toHex(baseNonce),
    chunkHashes,
    ...(options?.mimeType !== undefined ? { mimeType: options.mimeType } : {}),
    ...(options?.fileName !== undefined ? { fileName: options.fileName } : {}),
    ...(options?.targetItemIndex !== undefined
      ? { targetItemIndex: options.targetItemIndex }
      : {}),
    ...(options?.targetAttachmentIndex !== undefined
      ? { targetAttachmentIndex: options.targetAttachmentIndex }
      : {}),
    ...(options?.originRelayHint !== undefined
      ? { originRelayHint: options.originRelayHint }
      : {}),
  }

  return {
    manifest,
    encryptedChunks,
  }
}

/**
 * Fetches each chunk in `manifest.chunkHashes`, verifies `SHA256(ciphertext) === expectedChunkHash`
 * BEFORE decrypting, decrypts each chunk with XChaCha20-Poly1305 and AAD binding
 * `(rootPlaintextSha256, chunkIndex)`, concatenates, and verifies `SHA256(plaintext)` and length.
 */
export async function reassembleSplitPayload(
  manifest: BlobManifest,
  fetchChunk: BlobChunkFetchFn,
): Promise<Uint8Array> {
  if (!manifest || manifest.version !== 1) {
    throw new Error(`Unsupported blob manifest version: ${manifest?.version}`)
  }
  if (!HEX64_RE.test(manifest.rootPlaintextSha256)) {
    throw new Error('Invalid manifest rootPlaintextSha256')
  }
  if (!HEX64_RE.test(manifest.symmetricKeyHex)) {
    throw new Error('Invalid manifest symmetricKeyHex')
  }
  if (!HEX48_RE.test(manifest.baseNonceHex)) {
    throw new Error('Invalid manifest baseNonceHex')
  }
  if (
    !Number.isSafeInteger(manifest.totalPlaintextBytes) ||
    manifest.totalPlaintextBytes <= 0
  ) {
    throw new Error('Invalid manifest totalPlaintextBytes')
  }
  if (!Number.isSafeInteger(manifest.chunkSize) || manifest.chunkSize <= 0) {
    throw new Error('Invalid manifest chunkSize')
  }
  if (
    !Array.isArray(manifest.chunkHashes) ||
    manifest.chunkHashes.length === 0
  ) {
    throw new Error('Manifest chunkHashes must be a non-empty array')
  }

  const expectedChunkCount = Math.ceil(
    manifest.totalPlaintextBytes / manifest.chunkSize,
  )
  if (manifest.chunkHashes.length !== expectedChunkCount) {
    throw new Error(
      `Manifest chunk count mismatch: expected ${expectedChunkCount}, got ${manifest.chunkHashes.length}`,
    )
  }

  const symmetricKey = fromHex(manifest.symmetricKeyHex.toLowerCase())
  const baseNonce = fromHex(manifest.baseNonceHex.toLowerCase())
  const rootPlaintextSha256 = manifest.rootPlaintextSha256.toLowerCase()

  const decryptedChunks: Uint8Array[] = []
  let totalDecryptedBytes = 0

  for (let i = 0; i < manifest.chunkHashes.length; i += 1) {
    const expectedChunkHash = manifest.chunkHashes[i].toLowerCase()
    if (!HEX64_RE.test(expectedChunkHash)) {
      throw new Error(`Invalid chunkHash at index ${i}`)
    }
    const expectedPlaintextBytes = Math.min(
      manifest.chunkSize,
      manifest.totalPlaintextBytes - totalDecryptedBytes,
    )
    const ciphertext = await fetchChunk(
      expectedChunkHash,
      manifest.originRelayHint,
    )
    if (!(ciphertext instanceof Uint8Array)) {
      throw new Error(`Fetched chunk at index ${i} is not a Uint8Array`)
    }

    // AEAD adds exactly one 16-byte tag. Reject oversized or short chunks before
    // hashing/decrypting them, retaining plaintext, or fetching another chunk.
    if (ciphertext.byteLength !== expectedPlaintextBytes + 16) {
      throw new Error(
        `Chunk ciphertext byte length mismatch at index ${i}: expected ${
          expectedPlaintextBytes + 16
        }, got ${ciphertext.byteLength}`,
      )
    }

    const actualChunkHash = toHex(sha256(ciphertext))
    if (actualChunkHash !== expectedChunkHash) {
      throw new Error(
        `Chunk ciphertext SHA-256 mismatch at index ${i}: expected ${expectedChunkHash}, got ${actualChunkHash}`,
      )
    }

    const nonce = deriveChunkNonce(baseNonce, i)
    const aad = buildChunkAad(rootPlaintextSha256, i)
    let plaintextChunk: Uint8Array
    try {
      plaintextChunk = xchacha20poly1305(symmetricKey, nonce, aad).decrypt(
        ciphertext,
      )
    } catch {
      throw new Error(
        `Chunk XChaCha20-Poly1305 authentication failed at index ${i}`,
      )
    }

    if (
      plaintextChunk.byteLength !== expectedPlaintextBytes ||
      totalDecryptedBytes + plaintextChunk.byteLength >
        manifest.totalPlaintextBytes
    ) {
      throw new Error(`Chunk plaintext byte length mismatch at index ${i}`)
    }
    decryptedChunks.push(plaintextChunk)
    totalDecryptedBytes += plaintextChunk.byteLength
  }

  if (totalDecryptedBytes !== manifest.totalPlaintextBytes) {
    throw new Error(
      `Reassembled plaintext byte length mismatch: expected ${manifest.totalPlaintextBytes}, got ${totalDecryptedBytes}`,
    )
  }

  const plaintext = new Uint8Array(totalDecryptedBytes)
  let offset = 0
  for (const chunk of decryptedChunks) {
    plaintext.set(chunk, offset)
    offset += chunk.byteLength
  }

  const actualRootSha256 = toHex(sha256(plaintext))
  if (actualRootSha256 !== rootPlaintextSha256) {
    throw new Error(
      `Reassembled plaintext root SHA-256 mismatch: expected ${rootPlaintextSha256}, got ${actualRootSha256}`,
    )
  }

  return plaintext
}

function extractDataUriMimeType(value: string): string | undefined {
  const match = /^data:([^;,]+)[;,]/.exec(value)
  return match ? match[1] : undefined
}

function decodeBase64Attachment(dataBase64: string): Uint8Array {
  const clean = dataBase64
    .replace(/^data:[^;]+;base64,/, '')
    .replace(/\s+/g, '')
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(clean, 'base64'))
  }
  const binary = atob(clean)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

function resolveUploadFn(uploader: BlobUploader): {
  uploadChunk: BlobChunkUploadFn
  originRelayHint?: string
} {
  if (typeof uploader === 'function') {
    return { uploadChunk: uploader }
  }
  return {
    uploadChunk: uploader.uploadChunk.bind(uploader),
    originRelayHint: uploader.originRelayHint,
  }
}

function resolveFetchFn(fetcher: BlobFetcher): BlobChunkFetchFn {
  if (typeof fetcher === 'function') {
    return fetcher
  }
  return fetcher.fetchChunk.bind(fetcher)
}

/**
 * Automatically splits large `image`, `email` attachments, or duck-typed `attachment` items
 * exceeding `thresholdBytes` (default 32 KB) into encrypted chunks, uploads them via `blobUploader`,
 * and replaces/augments the message items with `BlobManifestItem` (`type: 'blob-manifest'`).
 */
export async function splitMessageItemsForSend(
  items: readonly MessageItem[],
  blobUploader: BlobUploader,
  options?: SplitMessageItemsOptions,
): Promise<MessageItem[]> {
  const { uploadChunk, originRelayHint: uploaderOriginHint } =
    resolveUploadFn(blobUploader)
  const thresholdBytes =
    options?.thresholdBytes ?? INLINE_PAYLOAD_THRESHOLD_BYTES
  const chunkSizeBytes = options?.chunkSizeBytes ?? CHUNK_PLAINTEXT_SIZE_BYTES
  const originRelayHint = options?.originRelayHint ?? uploaderOriginHint

  const out: MessageItem[] = []

  for (const item of items) {
    const rawType = (item as { type?: string } | null)?.type

    if (item.type === 'image') {
      const imageBytes = new TextEncoder().encode(item.image)
      if (imageBytes.byteLength > thresholdBytes) {
        const mimeType = extractDataUriMimeType(item.image) ?? 'image/png'
        const split = splitLargePayload(imageBytes, {
          thresholdBytes,
          chunkSizeBytes,
          mimeType,
          originRelayHint,
        })
        for (const chunk of split.encryptedChunks) {
          await uploadChunk(chunk.chunkHash, chunk.ciphertext)
        }
        const manifestItem: BlobManifestItem = {
          type: 'blob-manifest',
          ...split.manifest!,
        }
        out.push(manifestItem)
        continue
      }
      out.push(item)
      continue
    }

    if (
      item.type === 'email' &&
      Array.isArray(item.attachments) &&
      item.attachments.length > 0
    ) {
      const emailIndex = out.length
      const clonedAttachments: EmailAttachment[] = []
      const companionManifests: BlobManifestItem[] = []

      for (const [attachmentIndex, att] of item.attachments.entries()) {
        const attBytes =
          att.content ??
          (att.dataBase64 ? decodeBase64Attachment(att.dataBase64) : undefined)
        if (attBytes && attBytes.byteLength > thresholdBytes) {
          const split = splitLargePayload(attBytes, {
            thresholdBytes,
            chunkSizeBytes,
            mimeType: att.contentType,
            fileName: att.filename,
            targetItemIndex: emailIndex,
            targetAttachmentIndex: attachmentIndex,
            originRelayHint,
          })
          for (const chunk of split.encryptedChunks) {
            await uploadChunk(chunk.chunkHash, chunk.ciphertext)
          }
          const strippedAtt: EmailAttachment = {
            ...att,
            content: new Uint8Array(0),
            size: attBytes.byteLength,
            sizeBytes: attBytes.byteLength,
          }
          delete strippedAtt.dataBase64
          clonedAttachments.push(strippedAtt)
          companionManifests.push({
            type: 'blob-manifest',
            ...split.manifest!,
          })
        } else {
          clonedAttachments.push(att)
        }
      }

      const updatedEmail: EmailItem = {
        ...item,
        attachments: clonedAttachments,
      }
      out.push(updatedEmail)
      out.push(...companionManifests)
      continue
    }

    if (rawType === 'attachment') {
      const anyItem = item as unknown as {
        type: 'attachment'
        data?: Uint8Array | string
        content?: Uint8Array | string
        bytes?: Uint8Array
        mimeType?: string
        contentType?: string
        fileName?: string
        filename?: string
      }
      const rawPayload = anyItem.data ?? anyItem.content ?? anyItem.bytes
      const payloadBytes =
        typeof rawPayload === 'string'
          ? new TextEncoder().encode(rawPayload)
          : rawPayload
      if (
        payloadBytes instanceof Uint8Array &&
        payloadBytes.byteLength > thresholdBytes
      ) {
        const split = splitLargePayload(payloadBytes, {
          thresholdBytes,
          chunkSizeBytes,
          mimeType:
            anyItem.mimeType ??
            anyItem.contentType ??
            'application/octet-stream',
          fileName: anyItem.fileName ?? anyItem.filename ?? 'attachment.bin',
          originRelayHint,
        })
        for (const chunk of split.encryptedChunks) {
          await uploadChunk(chunk.chunkHash, chunk.ciphertext)
        }
        out.push({
          type: 'blob-manifest',
          ...split.manifest!,
        })
        continue
      }
    }

    out.push(item)
  }

  return out
}

/**
 * Transparently rehydrates `BlobManifestItem` entries in a received message by fetching and
 * verifying each chunk via `blobFetcher` (strictly through the recipient's Home Relay) and
 * restoring the original `image`, `email` attachment, or `attachment` payload.
 */
export async function rehydrateSplitMessageItems(
  items: readonly MessageItem[],
  blobFetcher: BlobFetcher,
): Promise<MessageItem[]> {
  const fetchChunk = resolveFetchFn(blobFetcher)
  const working: MessageItem[] = items.map(item => {
    if (item.type === 'email' && Array.isArray(item.attachments)) {
      return {
        ...item,
        attachments: item.attachments.map(att => ({ ...att })),
      }
    }
    return item
  })

  const consumedIndices = new Set<number>()

  // First pass: rehydrate companion manifests targeting an EmailItem at `targetItemIndex`.
  for (let i = 0; i < working.length; i += 1) {
    const item = working[i]
    if (item.type !== 'blob-manifest') continue
    const { targetItemIndex, targetAttachmentIndex } = item
    if (targetItemIndex === undefined && targetAttachmentIndex === undefined)
      continue
    if (
      typeof targetItemIndex !== 'number' ||
      !Number.isInteger(targetItemIndex) ||
      targetItemIndex < 0 ||
      targetItemIndex >= working.length ||
      typeof targetAttachmentIndex !== 'number' ||
      !Number.isInteger(targetAttachmentIndex) ||
      targetAttachmentIndex < 0
    ) {
      throw new Error(
        `Unresolved blob attachment target at manifest index ${i}`,
      )
    }
    const emailItem = working[targetItemIndex]
    if (emailItem.type !== 'email') {
      throw new Error(
        `Unresolved blob attachment target at manifest index ${i}`,
      )
    }
    const targetAtt = emailItem.attachments?.[targetAttachmentIndex]
    if (
      !targetAtt ||
      targetAtt.filename !== item.fileName ||
      (targetAtt.content && targetAtt.content.byteLength !== 0) ||
      targetAtt.dataBase64
    ) {
      throw new Error(
        `Unresolved blob attachment target at manifest index ${i}`,
      )
    }
    const plaintext = await reassembleSplitPayload(item, fetchChunk)
    targetAtt.content = plaintext
    targetAtt.size = plaintext.byteLength
    targetAtt.sizeBytes = plaintext.byteLength
    consumedIndices.add(i)
  }

  // Second pass: rehydrate standalone BlobManifestItems (`image` or `attachment`).
  const out: MessageItem[] = []
  for (let i = 0; i < working.length; i += 1) {
    if (consumedIndices.has(i)) continue
    const item = working[i]
    if (item.type !== 'blob-manifest') {
      out.push(item)
      continue
    }

    const plaintext = await reassembleSplitPayload(item, fetchChunk)
    if (item.fileName === undefined) {
      const imageItem: ImageItem = {
        type: 'image',
        image: new TextDecoder().decode(plaintext),
      }
      out.push(imageItem)
    } else {
      out.push({
        type: 'attachment',
        fileName: item.fileName,
        mimeType: item.mimeType ?? 'application/octet-stream',
        data: plaintext,
        content: plaintext,
      } as unknown as MessageItem)
    }
  }

  return out
}

/**
 * Builds the recipient Home-Relay URL for fetching a content-addressed blob chunk:
 * `${homeRelayUrl}/blobs/${chunkHash}` or `${homeRelayUrl}/blobs/${chunkHash}?origin=${encodeURIComponent(originRelayHint)}`.
 * Never returns a foreign relay URL.
 */
export function buildHomeRelayBlobUrl(
  homeRelayUrl: string,
  chunkHash: string,
  originRelayHint?: string,
): string {
  const normalizedHash = chunkHash.toLowerCase()
  if (!HEX64_RE.test(normalizedHash)) {
    throw new Error(`Invalid chunkHash: ${chunkHash}`)
  }
  const base = homeRelayUrl.replace(/\/+$/, '')
  const path = `${base}/blobs/${normalizedHash}`
  if (!originRelayHint) {
    return path
  }
  const trimmedOrigin = originRelayHint.replace(/\/+$/, '')
  if (trimmedOrigin === base) {
    return path
  }
  return `${path}?origin=${encodeURIComponent(trimmedOrigin)}`
}

/**
 * Creates a `BlobUploader` and `BlobFetcher` pair bound to the user's configured Home Relay.
 * All chunk fetches go strictly to `homeRelayUrl` (passing `?origin=` when `originRelayHint` is
 * present), ensuring zero direct browser connections to foreign relays.
 */
export function createHomeRelayBlobClient(
  homeRelayUrl: string,
  options?: {
    fetch?: typeof fetch | CanonicalFetch
    advertiseOriginHint?: boolean
  },
): {
  originRelayHint?: string
  uploadChunk: BlobChunkUploadFn
  fetchChunk: BlobChunkFetchFn
} {
  const fetchImpl = (options?.fetch ?? globalThis.fetch) as CanonicalFetch
  const base = homeRelayUrl.replace(/\/+$/, '')
  const originRelayHint =
    options?.advertiseOriginHint === false ? undefined : base

  // The relay accepts at most 512 KiB per ciphertext chunk. Bound the actual stream,
  // including error answers, before allocation; Content-Length alone is untrusted.
  const maxChunkBytes = 512 * 1024
  async function request(
    url: string,
    method: 'GET' | 'PUT',
    body?: Uint8Array,
  ): Promise<Uint8Array> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    let reader:
      | ReturnType<NonNullable<CanonicalStreamResponse['body']>['getReader']>
      | undefined
    try {
      const response = await fetchImpl(url, {
        method,
        headers: { 'content-type': 'application/octet-stream' },
        ...(body ? { body } : {}),
        redirect: 'error',
        credentials: 'omit',
        signal: controller.signal,
      })
      if (response.url && response.url !== url)
        throw new Error(
          'Blob response redirected away from the Home Relay request',
        )
      reader = response.body?.getReader()
      if (response.status < 200 || response.status >= 300)
        throw new Error(
          `Blob ${method} via Home Relay failed (${response.status})`,
        )
      if (method === 'PUT') return new Uint8Array()
      if (!reader) throw new Error('Blob response has no bounded stream')
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        if (!(next.value instanceof Uint8Array))
          throw new Error('Invalid blob response stream')
        total += next.value.byteLength
        if (total > maxChunkBytes)
          throw new Error('Blob response exceeds chunk limit')
        chunks.push(next.value)
      }
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return bytes
    } finally {
      clearTimeout(timer)
      controller.abort()
      await reader?.cancel().catch(() => undefined)
      reader?.releaseLock()
    }
  }

  return {
    originRelayHint,
    async uploadChunk(chunkHash, ciphertext): Promise<void> {
      const normalizedHash = chunkHash.toLowerCase()
      if (!HEX64_RE.test(normalizedHash))
        throw new Error(`Invalid chunkHash: ${chunkHash}`)
      if (ciphertext.byteLength > maxChunkBytes)
        throw new Error('Blob upload exceeds chunk limit')
      await request(`${base}/blobs/${normalizedHash}`, 'PUT', ciphertext)
    },
    async fetchChunk(chunkHash, hint): Promise<Uint8Array> {
      return request(buildHomeRelayBlobUrl(base, chunkHash, hint), 'GET')
    },
  }
}
