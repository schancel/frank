// Writers for the topic events of docs/protocol/cbor (README section 6 "Topic events", T7, T8):
// a type-9 post, the type-10 submission that wraps it with its burn transaction, and the type-11
// vote. Every writer validates what it produced with the same typed validation a reader runs, so
// an invalid input throws a `FrankCodecError` instead of yielding a frame a relay would reject.
//
// The order a wallet follows is fixed by T7: the burn must commit to the post it pays for, and
// the post cannot contain that burn, so the post is encoded and hashed first, the burn is signed
// for the resulting commitment, and only then is the submission written.
//
//   const post = encodeTopicPost({ network, topic, body })
//   const { commitment } = topicBurnCommitment(post)
//   const calldata = topicBurnCalldata('up', commitment)      // sign a burn tx carrying this
//   const submission = encodeTopicPostSubmission(post, rawSignedTx)
import type { Encodable } from './cbor'
import { encodeFrame } from './frame'
import { contentHash, topicVoteCommitment } from './hash'
import {
  TYPE_TOPIC_POST,
  TYPE_TOPIC_POST_SUBMISSION,
  TYPE_TOPIC_VOTE_SUBMISSION,
} from './constants'
import { FrankCodecError } from './errors'
import { defaultContext, validateFrame } from './validate'
import type { ParsedFrame } from './types'

/** The direction of a burn-weighted vote. Read from the burn's calldata by a relay (T8). */
export type TopicVoteDirection = 'up' | 'down'

const TOPIC_LOKAD_ID = Uint8Array.of(0x54, 0x50, 0x49, 0x43) // "TPIC"
/** Calldata version byte of the Frank-CBOR topic path (README T8). The protobuf path uses `01`. */
export const TOPIC_CBOR_CALLDATA_VERSION = 0x02
const DIRECTION_BYTE: Record<TopicVoteDirection, number> = {
  up: 0x01,
  down: 0x00,
}
/** `"TPIC" || 02 || direction || commitment`: 4 + 1 + 1 + 32 bytes. */
export const TOPIC_CBOR_CALLDATA_LENGTH = 38

export interface TopicPostFields {
  network: string
  /** Exact UTF-8, 1 through 512 bytes; never normalized (S12). */
  topic: string
  /** The T1 hash of the parent post's type-9 frame. Omit for a top-level post. */
  parentHash?: Uint8Array
  /** Opaque in version 1, 1 through 524,288 bytes. */
  body: Uint8Array
}

/** Writer-side misuse is reported as the same typed error a reader would raise. */
function refuse(message: string, location: string): FrankCodecError {
  return new FrankCodecError('schema', '8.2', message, location)
}

/** True for a `Uint8Array` of any realm or subclass; false for other typed arrays, proxies, objects. */
function isBytes(v: unknown): v is Uint8Array {
  return (
    ArrayBuffer.isView(v) &&
    Object.prototype.toString.call(v) === '[object Uint8Array]'
  )
}

/**
 * Returns a fresh same-realm copy of `v`, so a later change to the caller's array cannot reach
 * what was written and a cross-realm array is usable by the encoder. Copying a detached or
 * out-of-bounds view throws in the engine, which is reported as a typed refusal.
 */
function requireBytes(v: unknown, name: string): Uint8Array {
  if (!isBytes(v)) throw refuse(`${name} must be a Uint8Array`, name)
  try {
    return new Uint8Array(v)
  } catch {
    throw refuse(`${name} is a detached or out-of-bounds Uint8Array`, name)
  }
}

function requireText(v: unknown, name: string): string {
  if (typeof v !== 'string') throw refuse(`${name} must be a string`, name)
  requireWellFormed(v, name)
  return v
}

/** A lone surrogate is not text: a reader reports invalid UTF-8 as `malformed` at stage 7. */
function requireWellFormed(text: string, location: string): void {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++
        continue
      }
    } else if (c < 0xdc00 || c > 0xdfff) {
      continue
    }
    throw new FrankCodecError(
      'malformed',
      '7',
      'text contains a lone surrogate (invalid UTF-8)',
      location,
    )
  }
}

function validated(frame: Uint8Array, typeId: number): ParsedFrame {
  const r = validateFrame(frame, defaultContext({ operation: 'typed' }))
  if (r.kind !== 'parsed' || r.typeId !== typeId)
    throw new Error(
      `internal: a writer produced a frame that is not type ${typeId}`,
    )
  return r
}

/** Encodes a type-9 topic post. Throws `FrankCodecError` if a field violates its bound. */
export function encodeTopicPost(fields: TopicPostFields): Uint8Array {
  if (fields === null || typeof fields !== 'object')
    throw refuse('fields must be an object', 'fields')
  let raw: {
    network: unknown
    topic: unknown
    body: unknown
    parentHash: unknown
  }
  try {
    // Read every field once, up front: a throwing getter or a revoked proxy is a misuse of the
    // writer, not an error of the caller's to receive.
    raw = {
      network: fields.network,
      topic: fields.topic,
      body: fields.body,
      parentHash: fields.parentHash,
    }
  } catch {
    throw refuse('the fields object could not be read', 'fields')
  }
  const network = requireText(raw.network, 'network')
  const topic = requireText(raw.topic, 'topic')
  const body = requireBytes(raw.body, 'body')
  const payload = new Map<number, Encodable>([
    [0, network],
    [1, topic],
    [3, body],
  ])
  if (raw.parentHash !== undefined)
    payload.set(2, requireBytes(raw.parentHash, 'parentHash'))
  const frame = encodeFrame(
    { typeId: TYPE_TOPIC_POST, schemaVersion: 1, minReaderVersion: 1 },
    payload,
  )
  validated(frame, TYPE_TOPIC_POST)
  return frame
}

/** The identity of a post: the T1 content hash of its complete type-9 frame (S12). */
export function topicPostHash(postFrame: Uint8Array): Uint8Array {
  return contentHash(
    validated(requireBytes(postFrame, 'postFrame'), TYPE_TOPIC_POST),
  )
}

/**
 * The T7 commitment the burn for `postFrame` must carry, with the post's network and hash. A
 * post's own burn is a vote on that post, so a later vote for it commits with
 * `topicVoteCommitment(network, hash)` and gets the same value.
 */
export function topicBurnCommitment(postFrame: Uint8Array): {
  network: string
  hash: Uint8Array
  commitment: Uint8Array
} {
  const post = validated(requireBytes(postFrame, 'postFrame'), TYPE_TOPIC_POST)
  const typed = post.typed
  if (typed?.type !== 9) throw new Error('internal: not a topic post')
  const hash = contentHash(post)
  return {
    network: typed.network,
    hash,
    commitment: topicVoteCommitment(typed.network, hash),
  }
}

/**
 * The calldata a burn transaction must carry for a Frank-CBOR topic event (T8):
 * `"TPIC" || 02 || direction || commitment`. The direction and the burned value are the vote's,
 * read from the signed transaction by the relay; the frames never repeat them.
 * A vote may use either direction; a type-10 post's own burn MUST use `'up'` (T8), which
 * `topicPostBurnCalldata` fixes.
 */
export function topicBurnCalldata(
  direction: TopicVoteDirection,
  commitment: Uint8Array,
): Uint8Array {
  if (
    typeof direction !== 'string' ||
    !Object.prototype.hasOwnProperty.call(DIRECTION_BYTE, direction)
  )
    throw refuse('the vote direction must be "up" or "down"', 'direction')
  const bytes = requireBytes(commitment, 'commitment')
  if (bytes.length !== 32)
    throw refuse('the topic burn commitment must be 32 bytes', 'commitment')
  const out = new Uint8Array(TOPIC_CBOR_CALLDATA_LENGTH)
  out.set(TOPIC_LOKAD_ID, 0)
  out[4] = TOPIC_CBOR_CALLDATA_VERSION
  out[5] = DIRECTION_BYTE[direction]
  out.set(bytes, 6)
  return out
}

/**
 * The calldata for a type-10 post's own burn: `topicBurnCalldata('up', commitment)`. A post's
 * burn MUST be an up-vote (README T8) and a relay rejects a down-vote one; a vote on an existing
 * post may use either direction through `topicBurnCalldata`.
 */
export function topicPostBurnCalldata(commitment: Uint8Array): Uint8Array {
  return topicBurnCalldata('up', commitment)
}

/**
 * Encodes a type-10 submission: the exact `postFrame` plus the signed burn transaction. The
 * network is the post's, so S11 holds by construction.
 *
 * `burnTx` is opaque here: this writer does not decode it or check that its calldata carries the
 * post's T7 commitment, that it is up-vote (`01`), or that it is signed at all. A relay checks
 * all of that and rejects a mismatch before broadcasting; build the calldata with
 * `topicBurnCalldata` and sign the transaction for it first.
 */
export function encodeTopicPostSubmission(
  postFrame: Uint8Array,
  burnTx: Uint8Array,
): Uint8Array {
  const post = requireBytes(postFrame, 'postFrame')
  const tx = requireBytes(burnTx, 'burnTx')
  const { network } = topicBurnCommitment(post)
  const frame = encodeFrame(
    {
      typeId: TYPE_TOPIC_POST_SUBMISSION,
      schemaVersion: 1,
      minReaderVersion: 1,
    },
    new Map<number, Encodable>([
      [0, network],
      [1, post],
      [2, tx],
    ]),
  )
  validated(frame, TYPE_TOPIC_POST_SUBMISSION)
  return frame
}

/**
 * Encodes a type-11 vote on the post whose T1 hash is `targetHash`. As with the submission,
 * `burnTx` is opaque: the writer does not check that its calldata carries
 * `topicVoteCommitment(network, targetHash)`.
 */
export function encodeTopicVote(
  network: string,
  targetHash: Uint8Array,
  burnTx: Uint8Array,
): Uint8Array {
  const frame = encodeFrame(
    {
      typeId: TYPE_TOPIC_VOTE_SUBMISSION,
      schemaVersion: 1,
      minReaderVersion: 1,
    },
    new Map<number, Encodable>([
      [0, requireText(network, 'network')],
      [1, requireBytes(targetHash, 'targetHash')],
      [2, requireBytes(burnTx, 'burnTx')],
    ]),
  )
  validated(frame, TYPE_TOPIC_VOTE_SUBMISSION)
  return frame
}
