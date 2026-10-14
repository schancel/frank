import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha256'
import { toHex } from '@frank/codec'

import {
  CHUNK_PLAINTEXT_SIZE_BYTES,
  INLINE_PAYLOAD_THRESHOLD_BYTES,
  buildChunkAad,
  buildHomeRelayBlobUrl,
  createHomeRelayBlobClient,
  deriveChunkNonce,
  reassembleSplitPayload,
  rehydrateSplitMessageItems,
  splitLargePayload,
  splitMessageItemsForSend,
} from './payload-splitter'
import type { BlobManifest } from './payload-splitter'
import type { EmailItem, ImageItem, MessageItem } from '../types/messages'
import { createDefaultMessageItemRegistry } from '../../wallet/message-item-plugins/default-registry'
import { pluginCapabilitiesNotYetAvailable } from '../../wallet/message-item-plugins/registry'
import {
  decodeItemFrames,
  encodeItemFrames,
} from '../../wallet/message-item-plugins/wire'
import { encodeFrame, standaloneItemBudget, validateFrame } from '@frank/codec'
import type { Encodable } from '@frank/codec'

function deterministicBytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length)
  const block = new Uint8Array(4096)
  let x = seed & 0xff
  for (let i = 0; i < block.length; i += 1) {
    x = (x * 73 + i + 19) & 0xff
    block[i] = x
  }
  for (let offset = 0; offset < length; offset += block.length) {
    const sliceLen = Math.min(block.length, length - offset)
    out.set(block.subarray(0, sliceLen), offset)
    out[offset] ^= (offset >>> 12) & 0xff
  }
  return out
}

function wireRoundtrip(items: MessageItem[]): MessageItem[] {
  const registry = createDefaultMessageItemRegistry(
    pluginCapabilitiesNotYetAvailable,
  )
  const revision = validateFrame(
    encodeFrame(
      { typeId: 20, schemaVersion: 1, minReaderVersion: 1 },
      new Map<number, Encodable>([
        [0, 'frank'],
        [1, encodeItemFrames(registry, items)],
      ]),
    ),
  )
  if (revision.kind !== 'parsed' || revision.typed?.type !== 20)
    throw new Error('expected revision')
  return decodeItemFrames(
    registry,
    revision.typed.items,
    standaloneItemBudget(),
  )
}

describe('payload-splitter: transparent payload splitting & encrypted Merkle chunks', () => {
  it('keeps payloads <= 32 KB inline without generating chunks or a manifest', () => {
    const exactThreshold = deterministicBytes(INLINE_PAYLOAD_THRESHOLD_BYTES, 7)
    const res = splitLargePayload(exactThreshold)
    expect(res.inlineBytes).toBe(exactThreshold)
    expect(res.manifest).toBeUndefined()
    expect(res.encryptedChunks).toEqual([])
  })

  it('splits payloads > 32 KB (including > 1 MB) into 256 KB XChaCha20-Poly1305 encrypted chunks and reassembles them', async () => {
    // 1.1 MB payload -> 5 chunks (256 KB * 4 + 100 KB)
    const totalBytes = 1124 * 1024
    const original = deterministicBytes(totalBytes, 42)
    const split = splitLargePayload(original, {
      mimeType: 'application/pdf',
      fileName: 'whitepaper.pdf',
      originRelayHint: 'https://relay-a.example.org',
    })

    expect(split.inlineBytes).toBeUndefined()
    expect(split.manifest).toBeDefined()
    const manifest = split.manifest!
    expect(manifest.version).toBe(1)
    expect(manifest.totalPlaintextBytes).toBe(totalBytes)
    expect(manifest.chunkSize).toBe(CHUNK_PLAINTEXT_SIZE_BYTES)
    expect(manifest.rootPlaintextSha256).toBe(toHex(sha256(original)))
    expect(manifest.chunkHashes).toHaveLength(5)
    expect(split.encryptedChunks).toHaveLength(5)
    expect(manifest.mimeType).toBe('application/pdf')
    expect(manifest.fileName).toBe('whitepaper.pdf')
    expect(manifest.originRelayHint).toBe('https://relay-a.example.org')

    // Each encrypted chunk has 16-byte Poly1305 tag overhead and matches its SHA-256 hash
    for (let i = 0; i < 4; i += 1) {
      expect(split.encryptedChunks[i].ciphertext.byteLength).toBe(
        CHUNK_PLAINTEXT_SIZE_BYTES + 16,
      )
    }
    expect(split.encryptedChunks[4].ciphertext.byteLength).toBe(100 * 1024 + 16)
    for (let i = 0; i < 5; i += 1) {
      expect(toHex(sha256(split.encryptedChunks[i].ciphertext))).toBe(
        manifest.chunkHashes[i],
      )
    }

    const store = new Map<string, Uint8Array>(
      split.encryptedChunks.map(c => [c.chunkHash, c.ciphertext]),
    )
    const seenHints: Array<string | undefined> = []
    const reassembled = await reassembleSplitPayload(
      manifest,
      async (chunkHash, hint) => {
        seenHints.push(hint)
        const found = store.get(chunkHash)
        if (!found) throw new Error(`missing chunk ${chunkHash}`)
        return found
      },
    )

    expect(reassembled).toEqual(original)
    expect(seenHints).toEqual(Array(5).fill('https://relay-a.example.org'))
  })

  it.each([
    {
      declaredTotal: 4,
      chunkSize: 1,
      lengths: [524288, 524288, 524288, 524288],
      fetches: 1,
    },
    { declaredTotal: 3, chunkSize: 2, lengths: [2, 2], fetches: 2 },
    { declaredTotal: 4, chunkSize: 2, lengths: [1, 3], fetches: 1 },
  ])(
    'rejects authenticated chunks outside declared bounds before fetching further: $lengths',
    async ({ declaredTotal, chunkSize, lengths, fetches }) => {
      const key = new Uint8Array(32)
      const nonce = new Uint8Array(24)
      const root = '00'.repeat(32)
      const ciphertexts = lengths.map((length, index) =>
        xchacha20poly1305(
          key,
          deriveChunkNonce(nonce, index),
          buildChunkAad(root, index),
        ).encrypt(new Uint8Array(length)),
      )
      const manifest: BlobManifest = {
        version: 1,
        rootPlaintextSha256: root,
        totalPlaintextBytes: declaredTotal,
        chunkSize,
        symmetricKeyHex: toHex(key),
        baseNonceHex: toHex(nonce),
        chunkHashes: ciphertexts.map(bytes => toHex(sha256(bytes))),
      }
      const [decoded] = wireRoundtrip([{ type: 'blob-manifest', ...manifest }])
      if (decoded.type !== 'blob-manifest') throw new Error('expected manifest')
      const fetchChunk = jest.fn(
        async (hash: string) => ciphertexts[manifest.chunkHashes.indexOf(hash)],
      )
      await expect(reassembleSplitPayload(decoded, fetchChunk)).rejects.toThrow(
        /Chunk ciphertext byte length mismatch/,
      )
      expect(fetchChunk).toHaveBeenCalledTimes(fetches)
    },
  )

  it('derives distinct per-chunk nonces and AAD bindings for each chunk index', () => {
    const baseNonce = new Uint8Array(24).fill(0xaa)
    const n0 = deriveChunkNonce(baseNonce, 0)
    const n1 = deriveChunkNonce(baseNonce, 1)
    const n2 = deriveChunkNonce(baseNonce, 2)
    expect(n0).toEqual(baseNonce)
    expect(n1).not.toEqual(n0)
    expect(n2).not.toEqual(n1)
    expect(n1[23]).toBe(0xaa ^ 1)
    expect(n2[23]).toBe(0xaa ^ 2)

    const rootHash = '11'.repeat(32)
    const aad0 = buildChunkAad(rootHash, 0)
    const aad1 = buildChunkAad(rootHash, 1)
    expect(aad0.byteLength).toBe(20 + 32 + 4)
    expect(aad0).not.toEqual(aad1)
  })

  it('rejects tampered ciphertext chunks BEFORE decryption via SHA-256 verification', async () => {
    const original = deterministicBytes(80 * 1024, 99)
    const { manifest, encryptedChunks } = splitLargePayload(original)
    const tampered = new Uint8Array(encryptedChunks[0].ciphertext)
    tampered[0] ^= 0x01

    await expect(
      reassembleSplitPayload(manifest!, async () => tampered),
    ).rejects.toThrow(/Chunk ciphertext SHA-256 mismatch at index 0/)
  })

  it('rejects reordered chunks and tampered manifest rootPlaintextSha256 via AAD binding', async () => {
    const original = deterministicBytes(600 * 1024, 12)
    const { manifest, encryptedChunks } = splitLargePayload(original)
    const store = new Map<string, Uint8Array>(
      encryptedChunks.map(c => [c.chunkHash, c.ciphertext]),
    )

    // Swap chunk 0 and chunk 1 hashes in the manifest: ciphertext SHA-256 matches the swapped
    // hash, but XChaCha20-Poly1305 decryption fails because nonce/AAD bind chunk index `i`!
    const swappedManifest: BlobManifest = {
      ...manifest!,
      chunkHashes: [
        manifest!.chunkHashes[1],
        manifest!.chunkHashes[0],
        manifest!.chunkHashes[2],
      ],
    }
    await expect(
      reassembleSplitPayload(swappedManifest, async hash => store.get(hash)!),
    ).rejects.toThrow(
      /Chunk XChaCha20-Poly1305 authentication failed at index 0/,
    )

    // Tamper with rootPlaintextSha256 in the manifest: AAD binds rootPlaintextSha256, so AEAD
    // authentication rejects the chunk immediately!
    const forgedRootManifest: BlobManifest = {
      ...manifest!,
      rootPlaintextSha256: 'ff'.repeat(32),
    }
    await expect(
      reassembleSplitPayload(
        forgedRootManifest,
        async hash => store.get(hash)!,
      ),
    ).rejects.toThrow(
      /Chunk XChaCha20-Poly1305 authentication failed at index 0/,
    )
  })

  it('automatically splits large image, email attachment, and attachment items for send and rehydrates via Home Relay', async () => {
    const registry = createDefaultMessageItemRegistry(
      pluginCapabilitiesNotYetAvailable,
    )

    // Relay A (sender's home relay) and Relay B (recipient's home relay) blob stores
    const relayABlobs = new Map<string, Uint8Array>()
    const relayBBlobs = new Map<string, Uint8Array>()
    const clientFetchedUrls: string[] = []

    const mockFetch: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url.startsWith('https://relay-a.example.org/blobs/')) {
        const hash = url.split('/blobs/')[1].split('?')[0]
        if (method === 'PUT') {
          const body = new Uint8Array(init?.body as ArrayBuffer)
          if (toHex(sha256(body)) !== hash) {
            return new Response('blob_hash_mismatch', { status: 400 })
          }
          relayABlobs.set(hash, body)
          return new Response(JSON.stringify({ sha256: hash }), { status: 200 })
        }
      }

      if (url.startsWith('https://relay-b.example.org/blobs/')) {
        clientFetchedUrls.push(url)
        const parsed = new URL(url)
        const hash = parsed.pathname.split('/blobs/')[1]
        const cached = relayBBlobs.get(hash)
        if (cached) {
          return new Response(cached, { status: 200 })
        }
        const origin = parsed.searchParams.get('origin')
        if (origin === 'https://relay-a.example.org') {
          const upstream = relayABlobs.get(hash)
          if (!upstream) return new Response('not_found', { status: 404 })
          if (toHex(sha256(upstream)) !== hash) {
            return new Response('upstream_blob_hash_mismatch', { status: 502 })
          }
          relayBBlobs.set(hash, upstream)
          return new Response(upstream, { status: 200 })
        }
        return new Response('not_found', { status: 404 })
      }

      throw new Error(`Unexpected fetch URL: ${url}`)
    }) as typeof fetch

    const senderBlobClient = createHomeRelayBlobClient(
      'https://relay-a.example.org',
      { fetch: mockFetch },
    )
    const recipientBlobClient = createHomeRelayBlobClient(
      'https://relay-b.example.org',
      { fetch: mockFetch },
    )

    const largeImageUri = 'data:image/png;base64,' + 'A'.repeat(40 * 1024)
    const smallImageUri = 'data:image/png;base64,AAAA'
    const largePdfBytes = deterministicBytes(300 * 1024, 55)

    const originalItems: MessageItem[] = [
      { type: 'text', text: 'Here are the files' },
      { type: 'image', image: smallImageUri },
      { type: 'image', image: largeImageUri },
      {
        type: 'email',
        messageId: '<msg-1@example.com>',
        from: { address: 'alice@example.com' },
        to: [{ address: 'bob@example.com' }],
        subject: 'Quarterly report',
        textBody: 'Attached is the PDF',
        attachments: [
          {
            filename: 'report.pdf',
            contentType: 'application/pdf',
            content: largePdfBytes,
          },
        ],
      },
    ]

    const splitItems = await splitMessageItemsForSend(
      originalItems,
      senderBlobClient,
    )

    // Small text and small image remain unchanged; large image becomes blob-manifest;
    // email attachment content is stripped to 0 bytes and accompanied by a blob-manifest item.
    expect(splitItems.map(i => i.type)).toEqual([
      'text',
      'image',
      'blob-manifest',
      'email',
      'blob-manifest',
    ])
    expect(
      ((splitItems[3] as EmailItem).attachments![0].content ?? new Uint8Array())
        .byteLength,
    ).toBe(0)

    // Encode through canonical wire item frames and decode back on recipient side
    const wireFrames = encodeItemFrames(registry, splitItems)
    const revision = validateFrame(
      encodeFrame(
        { typeId: 20, schemaVersion: 1, minReaderVersion: 1 },
        new Map<number, Encodable>([
          [0, 'frank'],
          [1, wireFrames],
        ]),
      ),
    )
    if (revision.kind !== 'parsed' || revision.typed?.type !== 20) {
      throw new Error('expected parsed revision frame')
    }
    const decodedWireItems = decodeItemFrames(
      registry,
      revision.typed.items,
      standaloneItemBudget(),
    )

    // Recipient rehydrates Strictly via Relay B (recipient's Home Relay)
    const rehydrated = await rehydrateSplitMessageItems(
      decodedWireItems,
      recipientBlobClient,
    )

    expect(rehydrated).toHaveLength(4)
    expect(rehydrated[0]).toEqual(originalItems[0])
    expect(rehydrated[1]).toEqual(originalItems[1])
    expect(rehydrated[2]).toEqual({
      type: 'image',
      image: largeImageUri,
    } satisfies ImageItem)
    expect((rehydrated[3] as EmailItem).attachments![0].content).toEqual(
      largePdfBytes,
    )

    // Every client request went ONLY to Relay B with ?origin=https%3A%2F%2Frelay-a.example.org
    expect(clientFetchedUrls.length).toBeGreaterThan(0)
    for (const url of clientFetchedUrls) {
      expect(url.startsWith('https://relay-b.example.org/blobs/')).toBe(true)
      expect(url).toContain(
        '?origin=' + encodeURIComponent('https://relay-a.example.org'),
      )
    }

    // Even if Relay A goes offline now, Relay B has cached all chunks locally!
    relayABlobs.clear()
    const rehydratedFromCache = await rehydrateSplitMessageItems(
      decodedWireItems,
      recipientBlobClient,
    )
    expect((rehydratedFromCache[2] as ImageItem).image).toBe(largeImageUri)
    expect(
      (rehydratedFromCache[3] as EmailItem).attachments![0].content,
    ).toEqual(largePdfBytes)
  })

  it('preserves duplicate-filename attachment slots, including empty attachments, through canonical wire rehydration', async () => {
    const contents = [
      new Uint8Array(0),
      deterministicBytes(40000, 7),
      new Uint8Array(0),
      deterministicBytes(50000, 8),
    ]
    const email: EmailItem = {
      type: 'email',
      messageId: '<slots@example.com>',
      from: { address: 'alice@example.com' },
      to: [{ address: 'bob@example.com' }],
      subject: 'Slots',
      textBody: 'Attachments',
      attachments: contents.map(content => ({
        filename: 'same.pdf',
        contentType: 'application/pdf',
        content,
      })),
    }
    const store = new Map<string, Uint8Array>()
    const split = await splitMessageItemsForSend(
      [email],
      async (hash, bytes) => {
        store.set(hash, bytes)
      },
    )
    const decoded = wireRoundtrip(split)
    const hydrated = await rehydrateSplitMessageItems(
      decoded,
      async hash => store.get(hash)!,
    )
    expect(hydrated).toHaveLength(1)
    expect(
      (hydrated[0] as EmailItem).attachments!.map(att => att.content),
    ).toEqual(contents)
    // Rehydration leaves the received wire representation reusable.
    expect(
      (decoded[0] as EmailItem).attachments!.map(
        att => att.content!.byteLength,
      ),
    ).toEqual([0, 0, 0, 0])
  })

  it.each([
    { targetItemIndex: 0 },
    { targetAttachmentIndex: 0 },
    { targetItemIndex: 1, targetAttachmentIndex: 0 },
    { targetItemIndex: 0, targetAttachmentIndex: 1 },
    { targetItemIndex: 0, targetAttachmentIndex: 0, fileName: 'missing.pdf' },
  ])(
    'rejects unresolved attachment target before fetching: %j',
    async target => {
      const email: EmailItem = {
        type: 'email',
        messageId: '<target@example.com>',
        from: { address: 'alice@example.com' },
        to: [{ address: 'bob@example.com' }],
        subject: 'Target',
        textBody: '',
        attachments: [
          {
            filename: 'same.pdf',
            contentType: 'application/pdf',
            content: new Uint8Array(0),
          },
        ],
      }
      const { manifest } = splitLargePayload(deterministicBytes(40000), {
        fileName: 'same.pdf',
      })
      const fetchChunk = jest.fn()
      const decoded = wireRoundtrip([
        email,
        { type: 'blob-manifest', ...manifest!, ...target },
      ])
      await expect(
        rehydrateSplitMessageItems(decoded, fetchChunk),
      ).rejects.toThrow('Unresolved blob attachment target')
      expect(fetchChunk).not.toHaveBeenCalled()
    },
  )

  it('rejects two companion manifests targeting the same attachment slot', async () => {
    const email: EmailItem = {
      type: 'email',
      messageId: '<duplicate@example.com>',
      from: { address: 'alice@example.com' },
      to: [{ address: 'bob@example.com' }],
      subject: 'Duplicate',
      textBody: '',
      attachments: [
        {
          filename: 'same.pdf',
          contentType: 'application/pdf',
          content: deterministicBytes(40000),
        },
      ],
    }
    const store = new Map<string, Uint8Array>()
    const split = await splitMessageItemsForSend(
      [email],
      async (hash, bytes) => {
        store.set(hash, bytes)
      },
    )
    const decoded = wireRoundtrip([...split, split[1]])
    const fetchChunk = jest.fn(async (hash: string) => store.get(hash)!)
    await expect(
      rehydrateSplitMessageItems(decoded, fetchChunk),
    ).rejects.toThrow('Unresolved blob attachment target')
    expect(fetchChunk).toHaveBeenCalledTimes(1)
  })

  it('builds Home-Relay blob URLs without leaking direct foreign origin connections', () => {
    const hash = 'ab'.repeat(32)
    expect(
      buildHomeRelayBlobUrl(
        'https://relay-b.org/',
        hash,
        'https://relay-a.org/',
      ),
    ).toBe(
      `https://relay-b.org/blobs/${hash}?origin=${encodeURIComponent(
        'https://relay-a.org',
      )}`,
    )
    // Same-origin hint omits redundant ?origin= param
    expect(
      buildHomeRelayBlobUrl(
        'https://relay-b.org/',
        hash,
        'https://relay-b.org',
      ),
    ).toBe(`https://relay-b.org/blobs/${hash}`)
  })
})
