/** Pure Forum construction and comparison. Nothing here verifies chain facts or changes wallet state. */
import {
  decodeSingleItem,
  encodeCanonical,
  newCounters,
  Encodable,
} from './cbor'
import {
  ACCOUNT_REF,
  FORUM_CONTENT,
  FORUM_CURSOR_LAST,
  FORUM_DISCOVERY_CURSOR,
  FORUM_ENTRY_KIND,
  FORUM_GAME_ENTRY,
  FORUM_POST_ENTRY,
  FORUM_TOPIC_CURSOR,
  KEY_TYPE,
  MAX_FORUM_CURSOR_BYTES,
  MAX_FORUM_CURSOR_TRANSPORT,
  TIMESTAMP,
  TOPIC_POST,
  TYPE_FORUM_DISCOVERY_PAGE,
  TYPE_FORUM_OPERATION_STATUS,
  TYPE_FORUM_TOPIC_PAGE,
  TYPE_FORUM_VIEW,
  TYPE_TOPIC_POST,
} from './constants'
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
    [TIMESTAMP.seconds, t.seconds],
    [TIMESTAMP.nanoseconds, t.nanoseconds],
  ])
function checked(frame: Uint8Array): ParsedFrame {
  const result = validateFrame(frame, defaultContext())
  if (result.kind !== 'parsed') throw fail('expected parsed Forum frame')
  return result
}

export type ForumPostContentEntry =
  | {
      kind?: 'post'
      title?: string
      url?: string
      message?: string
    }
  | {
      kind: 'game'
      gameType: string
      tableId: string
      hostAddress: string
      buyInAmount?: string
      currentPlayers?: number
      maxPlayers?: number
      botAddress?: string
      title?: string
      message?: string
    }

export interface ForumPostFields {
  network: string
  topic: string
  parentHash?: Uint8Array
  authored: Timestamp
  entries: readonly ForumPostContentEntry[]
  from?: AccountRef | Uint8Array
  signature?: Uint8Array
}

/** Encodes the canonical CBOR body of a schema-2 topic post (authored timestamp + entries). */
export function encodeForumPostContent(
  authored: Timestamp,
  entries: readonly ForumPostContentEntry[],
): Uint8Array {
  const content = new Map<number, Encodable>([
    [FORUM_CONTENT.authored, time(authored)],
    [
      FORUM_CONTENT.entries,
      entries.map(entry => {
        if (entry.kind === 'game') {
          const m = new Map<number, Encodable>([
            [FORUM_GAME_ENTRY.kind, FORUM_ENTRY_KIND.game],
            [FORUM_GAME_ENTRY.gameType, entry.gameType],
            [FORUM_GAME_ENTRY.tableId, entry.tableId],
            [FORUM_GAME_ENTRY.hostAddress, entry.hostAddress],
          ])
          if (entry.buyInAmount !== undefined && entry.buyInAmount !== '') {
            m.set(FORUM_GAME_ENTRY.buyInAmount, entry.buyInAmount)
          }
          if (entry.currentPlayers !== undefined) {
            m.set(FORUM_GAME_ENTRY.currentPlayers, BigInt(entry.currentPlayers))
          }
          if (entry.maxPlayers !== undefined) {
            m.set(FORUM_GAME_ENTRY.maxPlayers, BigInt(entry.maxPlayers))
          }
          if (entry.botAddress !== undefined && entry.botAddress !== '') {
            m.set(FORUM_GAME_ENTRY.botAddress, entry.botAddress)
          }
          if (entry.title !== undefined && entry.title !== '') {
            m.set(FORUM_GAME_ENTRY.title, entry.title)
          }
          if (entry.message !== undefined && entry.message !== '') {
            m.set(FORUM_GAME_ENTRY.message, entry.message)
          }
          return m
        }
        const m = new Map<number, Encodable>([
          [FORUM_POST_ENTRY.kind, FORUM_ENTRY_KIND.post],
        ])
        for (const [key, value] of [
          [FORUM_POST_ENTRY.title, entry.title],
          [FORUM_POST_ENTRY.url, entry.url],
          [FORUM_POST_ENTRY.message, entry.message],
        ] as const)
          if (value !== undefined && value !== '') m.set(key, value)
        return m
      }),
    ],
  ])
  return encodeCanonical(content)
}

/** Encodes a single kind-2 game announcement into canonical CBOR post content. */
export function encodeForumGameContent(
  authored: Timestamp,
  game: {
    gameType: string
    tableId: string
    hostAddress: string
    buyInAmount?: string
    currentPlayers?: number
    maxPlayers?: number
    botAddress?: string
    title?: string
    message?: string
  },
): Uint8Array {
  return encodeForumPostContent(authored, [{ kind: 'game', ...game }])
}

/** Explicit schema-2 writer. The historical opaque-body writer remains schema 1. */
export function encodeForumPost(fields: ForumPostFields): Uint8Array {
  const body = encodeForumPostContent(fields.authored, fields.entries)
  const payload = new Map<number, Encodable>([
    [TOPIC_POST.network, fields.network],
    [TOPIC_POST.topic, fields.topic],
    [TOPIC_POST.body, body],
  ])
  if (fields.parentHash !== undefined)
    payload.set(TOPIC_POST.parentHash, fields.parentHash)
  if (fields.from !== undefined) {
    if (fields.from instanceof Uint8Array) {
      payload.set(TOPIC_POST.author, fields.from)
    } else {
      payload.set(
        TOPIC_POST.author,
        new Map<number, Encodable>([
          [ACCOUNT_REF.keyType, fields.from.keyType],
          [ACCOUNT_REF.keyBytes, fields.from.keyBytes],
        ]),
      )
    }
  }
  if (fields.signature !== undefined)
    payload.set(TOPIC_POST.signature, fields.signature)
  const frame = encodeFrame(
    { typeId: TYPE_TOPIC_POST, schemaVersion: 2, minReaderVersion: 2 },
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
      post.from.keyType === KEY_TYPE.secp256k1 &&
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
  typeId:
    | typeof TYPE_FORUM_VIEW
    | typeof TYPE_FORUM_TOPIC_PAGE
    | typeof TYPE_FORUM_DISCOVERY_PAGE
    | typeof TYPE_FORUM_OPERATION_STATUS,
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
    [FORUM_TOPIC_CURSOR.network, cursor.network],
    [FORUM_TOPIC_CURSOR.family, cursor.family],
    [FORUM_TOPIC_CURSOR.revision, cursor.revision],
    [FORUM_TOPIC_CURSOR.epoch, cursor.epoch],
    [FORUM_TOPIC_CURSOR.incarnation, cursor.incarnation],
  ])
  if (cursor.family === TYPE_FORUM_TOPIC_PAGE) {
    m.set(
      FORUM_TOPIC_CURSOR.last,
      new Map<number, Encodable>([
        [FORUM_CURSOR_LAST.timestamp, time(cursor.last.timestamp)],
        [FORUM_CURSOR_LAST.hash, cursor.last.hash],
      ]),
    )
    m.set(FORUM_TOPIC_CURSOR.topic, cursor.topic)
    m.set(FORUM_TOPIC_CURSOR.since, time(cursor.since))
  } else m.set(FORUM_DISCOVERY_CURSOR.last, cursor.last)
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
    status?.type !== TYPE_FORUM_OPERATION_STATUS ||
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
  if (
    view?.type !== TYPE_FORUM_VIEW ||
    view.postFrame.typed?.type !== TYPE_TOPIC_POST
  )
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
    family: typeof TYPE_FORUM_TOPIC_PAGE | typeof TYPE_FORUM_DISCOVERY_PAGE
    topic?: string
    since?: Timestamp
    requestCursor?: Uint8Array
  },
): ParsedFrame {
  const parsed = checked(frame),
    page = parsed.typed
  if (
    !page ||
    (page.type !== TYPE_FORUM_TOPIC_PAGE &&
      page.type !== TYPE_FORUM_DISCOVERY_PAGE) ||
    page.type !== expected.family ||
    page.network !== expected.network
  )
    throw fail('page network/family binding')
  if (
    page.type === TYPE_FORUM_TOPIC_PAGE &&
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
