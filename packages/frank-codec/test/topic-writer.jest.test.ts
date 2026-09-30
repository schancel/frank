// The topic-event writers: they emit exactly the fixtures both codecs and the relay decide, in the
// order T7 fixes, and refuse input that a relay would reject.
import {
  FrankCodecError,
  TOPIC_CBOR_CALLDATA_LENGTH,
  contentHash,
  defaultContext,
  encodeTopicPost,
  encodeTopicPostSubmission,
  encodeTopicVote,
  toHex,
  topicBurnCalldata,
  topicBurnCommitment,
  topicPostHash,
  topicVoteCommitment,
  validateFrame,
} from '../src'
import {
  NET,
  burnTx,
  bytesOf,
  topicPostFrame,
  topicSubmissionFrame,
  topicVoteFrame,
} from '../fixtures/builders'

const body = bytesOf(64, 21)

function category(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof FrankCodecError) return `${e.category}@${e.stage}`
    throw e
  }
  return 'no error'
}

describe('topic writers', () => {
  it('emit byte-for-byte the fixtures the manifest pins', () => {
    const post = encodeTopicPost({ network: NET, topic: 'frank.demo', body })
    expect(post).toEqual(topicPostFrame())
    expect(encodeTopicPostSubmission(post, burnTx())).toEqual(
      topicSubmissionFrame(),
    )
    const target = topicPostHash(post)
    expect(encodeTopicVote(NET, target, burnTx(32))).toEqual(
      topicVoteFrame({ target }),
    )
  })

  it('write a reply with its parent hash', () => {
    const parent = topicPostHash(topicPostFrame())
    const reply = encodeTopicPost({
      network: NET,
      topic: 'frank.demo.reply',
      parentHash: parent,
      body,
    })
    expect(reply).toEqual(
      topicPostFrame({ parent, topic: 'frank.demo.reply', body }),
    )
  })

  it('follow T7: the commitment is derived from the post before the burn exists', () => {
    const post = encodeTopicPost({ network: NET, topic: 'frank.demo', body })
    const { network, hash, commitment } = topicBurnCommitment(post)
    expect(network).toBe(NET)
    const parsed = validateFrame(post, defaultContext())
    if (parsed.kind !== 'parsed') throw new Error('not parsed')
    expect(toHex(hash)).toBe(toHex(contentHash(parsed)))
    expect(toHex(commitment)).toBe(toHex(topicVoteCommitment(NET, hash)))
    // A submission does not change the post's identity or commitment: the burn is outside it.
    const a = encodeTopicPostSubmission(post, burnTx(1))
    const b = encodeTopicPostSubmission(post, burnTx(2))
    expect(a).not.toEqual(b)
    expect(toHex(topicBurnCommitment(post).commitment)).toBe(toHex(commitment))
  })

  it('build the version-2 calldata with the direction in its own byte', () => {
    const commitment = bytesOf(32, 5)
    const up = topicBurnCalldata('up', commitment)
    const down = topicBurnCalldata('down', commitment)
    expect(up.length).toBe(TOPIC_CBOR_CALLDATA_LENGTH)
    expect(toHex(up.subarray(0, 6))).toBe('545049430201')
    expect(toHex(down.subarray(0, 6))).toBe('545049430200')
    expect(toHex(up.subarray(6))).toBe(toHex(commitment))
    expect(() => topicBurnCalldata('up', commitment.subarray(1))).toThrow(
      RangeError,
    )
  })

  it('refuse a field that violates its bound instead of emitting a frame a relay rejects', () => {
    const ok = { network: NET, topic: 'frank.demo', body }
    expect(category(() => encodeTopicPost({ ...ok, topic: '' }))).toBe(
      'schema@8.2',
    )
    expect(
      category(() => encodeTopicPost({ ...ok, topic: 'a'.repeat(513) })),
    ).toBe('schema@8.2')
    expect(
      category(() => encodeTopicPost({ ...ok, body: new Uint8Array(0) })),
    ).toBe('schema@8.2')
    expect(
      category(() => encodeTopicPost({ ...ok, body: new Uint8Array(524_289) })),
    ).toBe('resource@8.1')
    expect(
      category(() => encodeTopicPost({ ...ok, parentHash: bytesOf(31, 1) })),
    ).toBe('schema@8.2')
    expect(category(() => encodeTopicPost({ ...ok, network: 'Frank' }))).toBe(
      'schema@8.2',
    )
    const post = encodeTopicPost(ok)
    expect(
      category(() => encodeTopicPostSubmission(post, new Uint8Array(0))),
    ).toBe('schema@8.2')
    expect(category(() => encodeTopicVote(NET, bytesOf(31, 1), burnTx()))).toBe(
      'schema@8.2',
    )
    expect(category(() => encodeTopicVote(NET, bytesOf(32, 1), burnTx()))).toBe(
      'no error',
    )
  })

  it('refuse to wrap or hash a frame that is not a valid type-9 post', () => {
    const vote = topicVoteFrame()
    expect(() => encodeTopicPostSubmission(vote, burnTx())).toThrow()
    expect(() => topicPostHash(vote)).toThrow()
    expect(() => topicBurnCommitment(new Uint8Array(3))).toThrow(
      FrankCodecError,
    )
  })
})
