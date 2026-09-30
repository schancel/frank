// The pure hashes of the topic events (README T1 for a type 9, T7 for a type 10 and a type 11),
// as a JSON document both codecs recompute. A decode manifest has no field for a hash that is not
// a content hash, so these live beside it in `vectors/topic-commitments.json`.
import { contentHash, toHex, topicVoteCommitment } from '../src'
import { validateFrame } from '../src/validate'
import {
  NET,
  concatBytes,
  topicPostFrame,
  topicSubmissionFrame,
  topicVoteFrame,
} from './builders'

function t1(frame: Uint8Array): Uint8Array {
  const r = validateFrame(frame, {
    operation: 'typed',
    routeByteLimit: 8_388_617,
    readerVersion: 1,
    supportedSchemas: [9, 10, 11].map(typeId => ({ typeId, schemaVersion: 1 })),
    opaqueRetentionAllowed: false,
    priorDirectoryStatementFrame: null,
  })
  if (r.kind !== 'parsed') throw new Error('not parsed')
  return contentHash(r)
}

/** The T7 preimage, spelled out so a third implementation can check it without this codec. */
function preimage(network: string, target: Uint8Array): Uint8Array {
  const net = new TextEncoder().encode(network)
  return concatBytes(
    new TextEncoder().encode('frank:topic-vote:v1'),
    Uint8Array.of(net.length >>> 8, net.length & 0xff),
    net,
    target,
  )
}

export function buildTopicCommitments(): unknown {
  const post = topicPostFrame()
  const mutated = post.slice()
  mutated[mutated.length - 1] ^= 1
  const reply = topicPostFrame({ parent: t1(post), topic: 'frank.demo.reply' })
  const otherNet = topicPostFrame({ net: 'frank-other' })
  const postHash = t1(post)
  const cases = [
    {
      id: 'topic-post',
      description: 'T1 of the fixture type-9 post (network: field 0).',
      frame_hex: toHex(post),
      network: NET,
      t1_hex: toHex(postHash),
    },
    {
      id: 'topic-post-one-byte-mutation',
      description: 'The post with one body byte flipped: another T1 (T6).',
      frame_hex: toHex(mutated),
      network: NET,
      t1_hex: toHex(t1(mutated)),
    },
    {
      id: 'topic-post-other-network',
      description: 'The same fields on another network: another T1 (T5).',
      frame_hex: toHex(otherNet),
      network: 'frank-other',
      t1_hex: toHex(t1(otherNet)),
    },
    {
      id: 'topic-reply',
      description: 'A reply naming the fixture post as its parent.',
      frame_hex: toHex(reply),
      network: NET,
      t1_hex: toHex(t1(reply)),
    },
    {
      id: 'topic-post-submission',
      description:
        'T7 of a type-10 submission: the target is the T1 hash of the opened post.',
      frame_hex: toHex(topicSubmissionFrame({ post })),
      network: NET,
      target_hash_hex: toHex(postHash),
      t7_preimage_hex: toHex(preimage(NET, postHash)),
      t7_hex: toHex(topicVoteCommitment(NET, postHash)),
    },
    {
      id: 'topic-vote',
      description: 'T7 of a type-11 vote: the target is field 1.',
      frame_hex: toHex(topicVoteFrame({ target: postHash })),
      network: NET,
      target_hash_hex: toHex(postHash),
      t7_preimage_hex: toHex(preimage(NET, postHash)),
      t7_hex: toHex(topicVoteCommitment(NET, postHash)),
    },
    {
      id: 'topic-vote-other-network',
      description:
        'The same target under another network: another T7, so a burn cannot cross networks (T5).',
      frame_hex: toHex(
        topicVoteFrame({ net: 'frank-other', target: postHash }),
      ),
      network: 'frank-other',
      target_hash_hex: toHex(postHash),
      t7_preimage_hex: toHex(preimage('frank-other', postHash)),
      t7_hex: toHex(topicVoteCommitment('frank-other', postHash)),
    },
    {
      id: 'topic-vote-mutated-target',
      description:
        'The mutated post as target: another T7, so a burn cannot pay for a post that differs by one byte (T6).',
      frame_hex: toHex(topicVoteFrame({ target: t1(mutated) })),
      network: NET,
      target_hash_hex: toHex(t1(mutated)),
      t7_preimage_hex: toHex(preimage(NET, t1(mutated))),
      t7_hex: toHex(topicVoteCommitment(NET, t1(mutated))),
    },
  ]
  return { format: 'frank-cbor-v1-topic-commitments', cases }
}
