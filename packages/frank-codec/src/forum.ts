/** Pure Forum construction and comparison. Nothing here verifies chain facts or changes wallet state. */
import {
  decodeSingleItem,
  encodeCanonical,
  newCounters,
  Encodable,
} from './cbor'
import { MAX_FORUM_CURSOR_BYTES, MAX_FORUM_CURSOR_TRANSPORT } from './constants'
import { FrankCodecError } from './errors'
import { encodeFrame } from './frame'
import { contentHash, topicVoteCommitment } from './hash'
import { parseForumCursor } from './schema'
import { compareBytes } from './semantic'
import { defaultContext, validateFrame } from './validate'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { addressFromCompressedPubkey } from './registration'
import { topicPostSignatureDigest } from './hash'
import { verifyAlgorithm1 } from './verify'
import type {
  AccountRef,
  ForumCursor,
  ForumOperationStatus,
  ForumView,
  ParsedFrame,
  Timestamp,
  TopicPost,
} from './types'

const fail = (message: string) =>
  new FrankCodecError('semantic', '9', message, 'root/forum-binding')
const time = (t: Timestamp): Encodable =>
  new Map<number, Encodable>([
    [0, t.seconds],
    [1, t.nanoseconds],
  ])
function checked(frame: Uint8Array): ParsedFrame {
  const result = validateFrame(frame, defaultContext())
  if (result.kind !== 'parsed') throw fail('expected parsed Forum frame')
  return result
}

export interface ForumPostFields {
  network: string
  topic: string
  parentHash?: Uint8Array
  authored: Timestamp
  entries: readonly { title?: string; url?: string; message?: string }[]
  from?: AccountRef | Uint8Array
  signature?: Uint8Array
}

/** Encodes the canonical CBOR body of a schema-2 topic post (authored timestamp + entries). */
export function encodeForumPostContent(
  authored: Timestamp,
  entries: readonly { title?: string; url?: string; message?: string }[],
): Uint8Array {
  const content = new Map<number, Encodable>([
    [0, time(authored)],
    [
      1,
      entries.map(entry => {
        const m = new Map<number, Encodable>([[0, 1]])
        for (const [key, value] of [
          [1, entry.title],
          [2, entry.url],
          [3, entry.message],
        ] as const)
          if (value !== undefined && value !== '') m.set(key, value)
        return m
      }),
    ],
  ])
  return encodeCanonical(content)
}

/** Explicit schema-2 writer. The historical opaque-body writer remains schema 1. */
export function encodeForumPost(fields: ForumPostFields): Uint8Array {
  const body = encodeForumPostContent(fields.authored, fields.entries)
  const payload = new Map<number, Encodable>([
    [0, fields.network],
    [1, fields.topic],
    [3, body],
  ])
  if (fields.parentHash !== undefined) payload.set(2, fields.parentHash)
  if (fields.from !== undefined) {
    if (fields.from instanceof Uint8Array) {
      payload.set(4, fields.from)
    } else {
      payload.set(
        4,
        new Map<number, Encodable>([
          [0, fields.from.keyType],
          [1, fields.from.keyBytes],
        ]),
      )
    }
  }
  if (fields.signature !== undefined) payload.set(5, fields.signature)
  const frame = encodeFrame(
    { typeId: 9, schemaVersion: 2, minReaderVersion: 2 },
    payload,
  )
  checked(frame)
  return frame
}

/** Verifies the cryptographic author signature of a topic post and returns the 20-byte author address. */
export function verifyTopicPostAuthor(
  post: TopicPost<any>,
): Uint8Array | undefined {
  if (!post.from || !post.signature) return undefined
  const digest = topicPostSignatureDigest(
    post.network,
    post.topic,
    post.body,
    post.parentHash,
  )
  try {
    if (
      typeof post.from === 'object' &&
      'keyType' in post.from &&
      post.from.keyType === 1 &&
      post.from.keyBytes.length === 33
    ) {
      if (verifyAlgorithm1(digest, post.signature, post.from.keyBytes)) {
        return addressFromCompressedPubkey(post.from.keyBytes)
      }
      return undefined
    }
    if (post.from instanceof Uint8Array && post.from.length === 33) {
      if (verifyAlgorithm1(digest, post.signature, post.from)) {
        return addressFromCompressedPubkey(post.from)
      }
      return undefined
    }
    if (
      post.from instanceof Uint8Array &&
      post.from.length === 20 &&
      (post.signature.length === 64 || post.signature.length === 65)
    ) {
      const rec = post.signature.length === 65 ? post.signature[64] % 4 : 0
      const sig = secp256k1.Signature.fromCompact(
        post.signature.subarray(0, 64),
      ).addRecoveryBit(rec)
      const point = sig.recoverPublicKey(digest)
      const addr = addressFromCompressedPubkey(point.toRawBytes(true))
      if (compareBytes(addr, post.from) === 0) return addr
      return undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

/** Validates complete encoded sizes and required children; does not assert the observations are true. */
export function encodeForumReadFrame(
  typeId: 12 | 13 | 14 | 15,
  payload: Encodable,
): Uint8Array {
  const frame = encodeFrame(
    { typeId, schemaVersion: 1, minReaderVersion: 1 },
    payload,
  )
  checked(frame)
  return frame
}

export function decodeForumCursor(bytes: Uint8Array): ForumCursor {
  if (bytes.length === 0 || bytes.length > MAX_FORUM_CURSOR_BYTES)
    throw new FrankCodecError('resource', '8.1', 'cursor byte limit', 'cursor')
  return parseForumCursor(
    decodeSingleItem(
      bytes,
      { stage: '7', location: 'cursor' },
      newCounters(),
      0,
    ),
    bytes,
    'cursor',
  )
}
type WithoutBytes<T> = T extends unknown ? Omit<T, 'bytes'> : never
export type ForumCursorFields = WithoutBytes<ForumCursor>
export function encodeForumCursor(cursor: ForumCursorFields): Uint8Array {
  const m = new Map<number, Encodable>([
    [0, cursor.network],
    [1, cursor.family],
    [2, cursor.revision],
    [3, cursor.epoch],
    [7, cursor.incarnation],
  ])
  if (cursor.family === 13) {
    m.set(
      4,
      new Map<number, Encodable>([
        [0, time(cursor.last.timestamp)],
        [1, cursor.last.hash],
      ]),
    )
    m.set(5, cursor.topic)
    m.set(6, time(cursor.since))
  } else m.set(4, cursor.last)
  const bytes = encodeCanonical(m)
  decodeForumCursor(bytes)
  return bytes
}

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
export function forumCursorToTransport(bytes: Uint8Array): string {
  decodeForumCursor(bytes)
  let out = '',
    bits = 0,
    value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += ALPHABET[(value >>> bits) & 63]
    }
  }
  if (bits) out += ALPHABET[(value << (6 - bits)) & 63]
  return out
}
export function forumCursorFromTransport(text: string): ForumCursor {
  if (
    text.length === 0 ||
    text.length > MAX_FORUM_CURSOR_TRANSPORT ||
    !/^[A-Za-z0-9_-]+$/.test(text) ||
    text.length % 4 === 1
  )
    throw fail('invalid cursor transport')
  const length = Math.floor((text.length * 6) / 8)
  if (length > MAX_FORUM_CURSOR_BYTES) throw fail('cursor decoded size')
  const bytes = new Uint8Array(length)
  let bits = 0,
    value = 0,
    index = 0
  for (const char of text) {
    value = (value << 6) | ALPHABET.indexOf(char)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[index++] = (value >>> bits) & 255
    }
  }
  if (bits && value & ((1 << bits) - 1))
    throw fail('noncanonical cursor padding bits')
  return decodeForumCursor(bytes)
}

export interface ForumOperationExpectation {
  network: string
  submittedFrame: Uint8Array
  targetHash: Uint8Array
  transactionHash: Uint8Array
  sender: Uint8Array
  direction: 0 | 1
  value: bigint
}
/** Exact request binding only. Even a matched confirmed response is relay-observed. */
export function matchForumOperation(
  frame: Uint8Array,
  expected: ForumOperationExpectation,
): ForumOperationStatus<ParsedFrame> {
  const status = checked(frame).typed
  if (
    status?.type !== 15 ||
    status.network !== expected.network ||
    compareBytes(status.submittedFrame.frame, expected.submittedFrame) ||
    compareBytes(status.targetHash, expected.targetHash) ||
    compareBytes(status.transactionHash, expected.transactionHash) ||
    compareBytes(status.sender, expected.sender) ||
    status.direction !== expected.direction ||
    status.value !== expected.value
  )
    throw fail('operation response differs from retained request')
  return status
}

export interface ForumViewExpectation {
  network: string
  topic: string
  targetHash: Uint8Array
  rawTransaction: Uint8Array
  transactionHash: Uint8Array
  sender: Uint8Array
  direction: 0 | 1
  commitment: Uint8Array
}
/** Compares explicitly supplied transaction facts; does not recover signatures or establish finality. */
export function matchForumView(
  frame: Uint8Array,
  expected: ForumViewExpectation,
): ForumView<ParsedFrame> {
  const view = checked(frame).typed
  if (view?.type !== 12 || view.postFrame.typed?.type !== 9)
    throw fail('expected Forum view')
  const hash = contentHash(view.postFrame)
  if (
    view.network !== expected.network ||
    view.postFrame.typed.topic !== expected.topic ||
    compareBytes(hash, expected.targetHash) ||
    compareBytes(view.authorBurnTx, expected.rawTransaction) ||
    compareBytes(view.transactionHash, expected.transactionHash) ||
    compareBytes(view.author, expected.sender) ||
    expected.direction !== 1 ||
    compareBytes(topicVoteCommitment(view.network, hash), expected.commitment)
  )
    throw fail('view differs from expected author burn')
  return view
}

/** The response must echo precisely the cursor sent by this refresh, including terminal pages. */
export function matchForumPage(
  frame: Uint8Array,
  expected: {
    network: string
    family: 13 | 14
    topic?: string
    since?: Timestamp
    requestCursor?: Uint8Array
  },
): ParsedFrame {
  const parsed = checked(frame),
    page = parsed.typed
  if (
    !page ||
    (page.type !== 13 && page.type !== 14) ||
    page.type !== expected.family ||
    page.network !== expected.network
  )
    throw fail('page network/family binding')
  if (
    page.type === 13 &&
    (page.topic !== expected.topic ||
      page.since.seconds !== expected.since?.seconds ||
      page.since.nanoseconds !== expected.since.nanoseconds)
  )
    throw fail('page query binding')
  if (
    (page.requestCursor === undefined) !==
      (expected.requestCursor === undefined) ||
    (page.requestCursor &&
      expected.requestCursor &&
      compareBytes(page.requestCursor.bytes, expected.requestCursor))
  )
    throw fail('page request cursor echo')
  return parsed
}
