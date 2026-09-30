// The topic-event writers: they emit exactly the fixtures both codecs and the relay decide, in the
// order T7 fixes, and refuse input that a relay would reject.
import * as fs from 'fs'
import * as path from 'path'
import {
  FrankCodecError,
  TOPIC_CBOR_CALLDATA_LENGTH,
  contentHash,
  defaultContext,
  encodeTopicPost,
  encodeTopicPostSubmission,
  encodeTopicVote,
  fromHex,
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
      FrankCodecError,
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

  it('reject an invalid direction, including inherited keys, with a typed error', () => {
    const commitment = bytesOf(32, 5)
    for (const bad of [
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'sideways',
      '',
      'UP',
    ]) {
      expect(() =>
        topicBurnCalldata(bad as unknown as 'up', commitment),
      ).toThrow(FrankCodecError)
    }
    expect(() => topicBurnCalldata(undefined as never, commitment)).toThrow(
      FrankCodecError,
    )
    expect(() => topicBurnCalldata('up', new Uint8Array(33))).toThrow(
      FrankCodecError,
    )
  })

  it('report a lone surrogate as a typed malformed error, not a RangeError', () => {
    for (const topic of ['a\ud800', '\udc00b', 'x\ud800y']) {
      expect(
        category(() => encodeTopicPost({ network: NET, topic, body })),
      ).toBe('malformed@7')
    }
    expect(
      category(() =>
        encodeTopicPost({ network: 'ne\ud800t', topic: 'a', body }),
      ),
    ).toBe('malformed@7')
    // A valid surrogate pair is fine.
    expect(
      category(() =>
        encodeTopicPost({ network: NET, topic: '\ud83d\ude00', body }),
      ),
    ).toBe('no error')
  })

  it('refuse to wrap or hash a frame that is not a valid type-9 post', () => {
    const vote = topicVoteFrame()
    expect(() => encodeTopicPostSubmission(vote, burnTx())).toThrow()
    expect(() => topicPostHash(vote)).toThrow()
    expect(() => topicBurnCommitment(new Uint8Array(3))).toThrow(
      FrankCodecError,
    )
  })

  it('pin topicPostHash and topicBurnCommitment to the committed T1 and T7 vectors', () => {
    const doc = JSON.parse(
      fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../docs/protocol/cbor/vectors/topic-commitments.json',
        ),
        'utf8',
      ),
    )
    const byId = (id: string) =>
      doc.cases.find((c: { id: string }) => c.id === id)
    let posts = 0
    for (const c of doc.cases) {
      if (c.t1_hex === undefined) continue
      const frame = fromHex(c.frame_hex)
      expect(toHex(topicPostHash(frame))).toBe(c.t1_hex)
      const { network, hash, commitment } = topicBurnCommitment(frame)
      expect(network).toBe(c.network)
      expect(toHex(hash)).toBe(c.t1_hex)
      // The commitment equals the T7 pinned for a vote on that post under the same network.
      const vote = doc.cases.find(
        (v: { target_hash_hex?: string; network: string }) =>
          v.target_hash_hex === c.t1_hex && v.network === c.network,
      )
      if (vote) expect(toHex(commitment)).toBe(vote.t7_hex)
      posts++
    }
    expect(posts).toBe(4)
    // The submission vector's T7 is the commitment of its embedded post.
    const sub = byId('topic-post-submission')
    expect(
      toHex(
        topicBurnCommitment(fromHex(byId('topic-post').frame_hex)).commitment,
      ),
    ).toBe(sub.t7_hex)
    // Writers reproduce the pinned vote and submission frames exactly.
    const vote = byId('topic-vote')
    expect(
      toHex(
        encodeTopicVote(
          vote.network,
          fromHex(vote.target_hash_hex),
          burnTx(32),
        ),
      ),
    ).toBe(vote.frame_hex)
    expect(
      toHex(
        encodeTopicPostSubmission(
          fromHex(byId('topic-post').frame_hex),
          burnTx(),
        ),
      ),
    ).toBe(sub.frame_hex)
  })

  it('do not alias their inputs or outputs', () => {
    const b = bytesOf(64, 21)
    const parent = bytesOf(32, 9)
    const post = encodeTopicPost({
      network: NET,
      topic: 'frank.demo',
      parentHash: parent,
      body: b,
    })
    const snapshot = toHex(post)
    b.fill(0)
    parent.fill(0)
    expect(toHex(post)).toBe(snapshot)
    const tx = burnTx()
    const sub = encodeTopicPostSubmission(post, tx)
    const subSnapshot = toHex(sub)
    tx.fill(0)
    post.fill(0)
    expect(toHex(sub)).toBe(subSnapshot)
    const target = bytesOf(32, 3)
    const vote = encodeTopicVote(NET, target, burnTx())
    const voteSnapshot = toHex(vote)
    target.fill(0)
    expect(toHex(vote)).toBe(voteSnapshot)
    const hash = topicPostHash(topicPostFrame())
    const again = topicPostHash(topicPostFrame())
    hash.fill(0)
    expect(toHex(again)).not.toBe(toHex(hash))
  })
})
