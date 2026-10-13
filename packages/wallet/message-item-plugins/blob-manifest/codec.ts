import type { BlobManifestItem } from '@frank/cashweb/types/messages'

import {
  cborItemCodec,
  hash32,
  hex,
  int,
  listOf,
  opt,
  req,
  str,
  type Field,
} from '../shared/cbor-fields'

export const MAX_BLOB_PLAINTEXT_BYTES = 104_857_600
export const MAX_BLOB_CHUNK_PLAINTEXT_BYTES = 1_048_576
export const MAX_BLOB_CHUNKS = 4096

export const blobManifestCodec = cborItemCodec<BlobManifestItem>(
  'blob-manifest',
  {
    version: req(0, int(1, 1) as unknown as Field<1>),
    rootPlaintextSha256: req(1, hash32),
    totalPlaintextBytes: req(2, int(1, MAX_BLOB_PLAINTEXT_BYTES)),
    chunkSize: req(3, int(1, MAX_BLOB_CHUNK_PLAINTEXT_BYTES)),
    symmetricKeyHex: req(4, hash32),
    baseNonceHex: req(5, hex(24)),
    chunkHashes: req(6, listOf(hash32, MAX_BLOB_CHUNKS, 1)),
    mimeType: opt(7, str(128, 1)),
    fileName: opt(8, str(256, 1)),
    targetItemIndex: opt(9, int(0, 255)),
    originRelayHint: opt(10, str(512, 1)),
  },
)
