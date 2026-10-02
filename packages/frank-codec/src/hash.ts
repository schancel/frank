// T1/T1a content hashes and the pure-hash helpers T3/T4 (README section 8). No signature is
// verified here and no stage 10 check is implemented.
import { sha256 } from '@noble/hashes/sha256'
import { utf8Encode } from './utf8'
import type { ParsedFrame } from './types'

const ASCII_LITERAL = /^[\x20-\x7e]*$/

function u16be(n: number): Uint8Array {
  if (n > 0xffff)
    throw new RangeError('transcript field longer than 65535 bytes')
  return Uint8Array.of(n >>> 8, n & 0xff)
}

function u32be(n: number): Uint8Array {
  if (n > 0xffffffff)
    throw new RangeError('transcript frame longer than 2^32-1 bytes')
  return Uint8Array.of(
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  )
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/**
 * The common transcript: `u16be(len(domain)) || ascii(domain) || u16be(len(network)) ||
 * utf8(network) || u32be(len(frame)) || frame || context`. `frame` is the complete frame.
 */
export function commonTranscript(
  domain: string,
  network: string,
  frame: Uint8Array,
  context: Uint8Array = new Uint8Array(0),
): Uint8Array {
  if (!ASCII_LITERAL.test(domain))
    throw new RangeError('transcript domain must be ASCII')
  const d = utf8Encode(domain)
  const n = utf8Encode(network)
  return concat([
    u16be(d.length),
    d,
    u16be(n.length),
    n,
    u32be(frame.length),
    frame,
    context,
  ])
}

/** T1's network source for each type; undefined for an unknown type. */
export function contentHashNetwork(p: ParsedFrame): string {
  switch (p.typeId) {
    case 8:
    case 16:
    case 17:
      return 'frank'
    case 2: {
      const t = p.typed
      if (t?.type === 2 && t.statementFrame.typed?.type === 4)
        return t.statementFrame.typed.network
      throw new Error(
        'T1 for a type-2 frame needs the stage 8 typed projection',
      )
    }
    case 1:
    case 3:
    case 4:
    case 5:
    case 6:
    case 7:
    case 9:
    case 10:
    case 11: {
      const t = p.typed
      if (t && 'network' in t) return t.network
      throw new Error(
        `T1 for a type-${p.typeId} frame needs the stage 8 typed projection`,
      )
    }
    default:
      throw new Error('content hashes are undefined for an unknown type (T1)')
  }
}

/** T1: SHA-256 of the common transcript with domain `frank/content-hash/v1`. */
export function contentHash(p: ParsedFrame): Uint8Array {
  return sha256(
    commonTranscript('frank/content-hash/v1', contentHashNetwork(p), p.frame),
  )
}

/** T1a: `content_digest` of a complete type-8 frame (network is the literal `frank`). */
export function messageContentDigest(type8Frame: Uint8Array): Uint8Array {
  return sha256(
    commonTranscript('frank/message-content/v1', 'frank', type8Frame),
  )
}

/**
 * T2: the 32-byte SHA-256 digest algorithm 1 signs, over the complete type-4 statement frame.
 * The network argument is the statement's own field 0 (T5), never ambient state; the context
 * is empty.
 */
export function directorySignatureDigest(
  network: string,
  type4Frame: Uint8Array,
): Uint8Array {
  return sha256(
    commonTranscript('frank/directory-signature/v1', network, type4Frame),
  )
}

/** T2a: the digest of a key-transition authorization over the complete type-7 frame. */
export function keyTransitionSignatureDigest(
  network: string,
  type7Frame: Uint8Array,
): Uint8Array {
  return sha256(
    commonTranscript('frank/key-transition-signature/v1', network, type7Frame),
  )
}

/** T3: recipient payload digest of a complete type-5 frame with its field-0 network. */
export function recipientPayloadDigest(
  network: string,
  type5Frame: Uint8Array,
): Uint8Array {
  return sha256(
    commonTranscript('frank/recipient-payload/v1', network, type5Frame),
  )
}

/** T4: `SHA256("frank:dm-stamp-payment:v1" || T3_digest || u32be(child_index))`. */
export function paymentCommitment(
  t3Digest: Uint8Array,
  childIndex: number,
): Uint8Array {
  return sha256(
    concat([
      utf8Encode('frank:dm-stamp-payment:v1'),
      t3Digest,
      u32be(childIndex),
    ]),
  )
}

/**
 * T7: `SHA256("frank:topic-vote:v1" || u16be(len(network)) || utf8(network) || target_hash)`.
 * `targetHash` is the T1 hash of the type-9 frame the burn pays for: a type-11 frame's field 1,
 * or the content hash of the frame a type 10 opens.
 */
export function topicVoteCommitment(
  network: string,
  targetHash: Uint8Array,
): Uint8Array {
  if (targetHash.length !== 32)
    throw new RangeError('the topic target hash must be 32 bytes')
  const n = utf8Encode(network)
  return sha256(
    concat([utf8Encode('frank:topic-vote:v1'), u16be(n.length), n, targetHash]),
  )
}

export function toHex(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++)
    s += (b[i] < 16 ? '0' : '') + b[i].toString(16)
  return s
}

export function fromHex(h: string): Uint8Array {
  if (h.length % 2 !== 0 || !/^[0-9a-f]*$/.test(h))
    throw new RangeError('invalid lowercase hex')
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16)
  return out
}
