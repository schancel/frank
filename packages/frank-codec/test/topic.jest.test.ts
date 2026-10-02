// Topic events (types 9, 10, 11): typed projections, R6 limits, T1/T7 hashes, and the guarantee
// that the corpus written before #136 behaves identically once the new types are listed.
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import {
  FrankCodecError,
  contentHash,
  contentHashNetwork,
  defaultContext,
  fromHex,
  toHex,
  topicVoteCommitment,
  validateFrame,
} from '../src'
import type { ParsedFrame } from '../src'
import {
  M,
  bytesOf,
  burnTx,
  fr,
  topicPostFrame,
  topicSubmissionFrame,
  topicVoteFrame,
} from '../fixtures/builders'
import { CASES, PRE_TOPIC_SCHEMAS } from '../fixtures/cases'
import { contextOf } from '../fixtures/manifest'
import { buildTopicCommitments } from '../fixtures/topic-commitments'

const COMMITMENTS_PATH = path.resolve(
  __dirname,
  '../../../docs/protocol/cbor/vectors/topic-commitments.json',
)
const serialized = JSON.stringify(buildTopicCommitments(), null, 2) + '\n'
if (process.env.FRANK_UPDATE_VECTORS === '1') {
  fs.writeFileSync(COMMITMENTS_PATH, serialized)
}

function outcome(f: Uint8Array, ctx = {}): string {
  try {
    return validateFrame(f, defaultContext(ctx)).kind
  } catch (e) {
    if (!(e instanceof FrankCodecError)) throw e
    return `${e.category}@${e.stage}`
  }
}

function parsed(f: Uint8Array): ParsedFrame {
  const r = validateFrame(f, defaultContext())
  if (r.kind !== 'parsed') throw new Error('not parsed')
  return r
}

describe('topic event projections', () => {
  it('projects a type-9 post, with and without a parent', () => {
    const parent = bytesOf(32, 9)
    const top = parsed(topicPostFrame()).typed
    const reply = parsed(topicPostFrame({ parent })).typed
    expect(top).toMatchObject({ type: 9, topic: 'frank.demo' })
    expect(top && 'parentHash' in top).toBe(false)
    expect(reply && reply.type === 9 && reply.parentHash).toEqual(parent)
  })

  it('opens the type-9 post inside a type-10 submission and keeps the burn bytes exact', () => {
    const post = topicPostFrame()
    const sub = parsed(topicSubmissionFrame({ post, burnTx: burnTx(7) })).typed
    if (sub?.type !== 10) throw new Error('not a submission')
    expect(sub.postFrame.frame).toEqual(post)
    expect(sub.postFrame.typed?.type).toBe(9)
    expect(sub.burnTx).toEqual(burnTx(7))
  })

  it('projects a type-11 vote with no direction, weight, or sender field', () => {
    const t = parsed(topicVoteFrame({ target: bytesOf(32, 3) })).typed
    if (t?.type !== 11) throw new Error('not a vote')
    expect(Object.keys(t).sort()).toEqual(
      ['burnTx', 'network', 'targetHash', 'type', 'unknownFields'].sort(),
    )
  })

  it('takes the T1 network from field 0 of types 9, 10, and 11', () => {
    for (const f of [
      topicPostFrame({ net: 'net-a' }),
      topicSubmissionFrame({
        net: 'net-a',
        post: topicPostFrame({ net: 'net-a' }),
      }),
      topicVoteFrame({ net: 'net-a' }),
    ]) {
      expect(contentHashNetwork(parsed(f))).toBe('net-a')
    }
  })

  it('never re-encodes: the parsed frame is the exact input', () => {
    const f = topicSubmissionFrame()
    expect(parsed(f).frame).toEqual(f)
  })
})

describe('R6 limits', () => {
  const MAX_BODY = 524_288
  it('accepts a body of exactly 512 KiB and rejects one byte more as resource at 8.1', () => {
    expect(outcome(topicPostFrame({ body: new Uint8Array(MAX_BODY) }))).toBe(
      'parsed',
    )
    expect(
      outcome(topicPostFrame({ body: new Uint8Array(MAX_BODY + 1) })),
    ).toBe('resource@8.1')
  })

  it('accepts a type-10 submission of a maximal post and rejects the frame over 1 MiB', () => {
    const big = topicPostFrame({ body: new Uint8Array(MAX_BODY) })
    expect(outcome(topicSubmissionFrame({ post: big }))).toBe('parsed')
    // A 1 MiB + 1 frame: the body is within R6 but the wrapper frame is not.
    const wrapper = topicSubmissionFrame({
      post: big,
      burnTx: burnTx(1, 16_384),
    })
    expect(wrapper.length).toBeLessThanOrEqual(1_048_576)
    const padded = fr(
      10,
      new Map([
        ...(M([
          [0, 'frank-test'],
          [1, big],
          [2, burnTx()],
        ]) as Map<number, unknown>),
        [9, new Uint8Array(1_048_576 - big.length)],
      ]) as never,
    )
    expect(padded.length).toBeGreaterThan(1_048_576)
    expect(outcome(padded)).toBe('resource@8.1')
  })

  it('caps a type-11 vote frame at 64 KiB while a type-9 or type-10 frame may be larger', () => {
    const over = fr(
      11,
      new Map([
        ...(M([
          [0, 'frank-test'],
          [1, bytesOf(32, 1)],
          [2, burnTx()],
        ]) as Map<number, unknown>),
        [9, new Uint8Array(65_536)],
      ]) as never,
    )
    expect(over.length).toBeGreaterThan(65_536)
    expect(outcome(over)).toBe('resource@8.1')
    expect(outcome(topicVoteFrame())).toBe('parsed')
  })

  it('applies the type limit only to a root, so a large post inside a submission is not double-charged', () => {
    const post = topicPostFrame({ body: new Uint8Array(MAX_BODY) })
    expect(post.length).toBeGreaterThan(65_536)
    expect(outcome(topicSubmissionFrame({ post }))).toBe('parsed')
  })
})

describe('topic hashes', () => {
  const t1 = (f: Uint8Array) => contentHash(parsed(f))
  const sha = (b: Uint8Array) =>
    new Uint8Array(createHash('sha256').update(b).digest())

  it('computes T7 from the spelled-out preimage with an independent SHA-256', () => {
    const target = t1(topicPostFrame())
    const net = new TextEncoder().encode('frank-test')
    const pre = new Uint8Array([
      ...new TextEncoder().encode('frank:topic-vote:v1'),
      0,
      net.length,
      ...net,
      ...target,
    ])
    expect(topicVoteCommitment('frank-test', target)).toEqual(sha(pre))
  })

  it('binds the network, the exact target, and rejects a target that is not 32 bytes', () => {
    const target = t1(topicPostFrame())
    const base = toHex(topicVoteCommitment('frank-test', target))
    expect(toHex(topicVoteCommitment('frank-other', target))).not.toBe(base)
    const flipped = target.slice()
    flipped[0] ^= 1
    expect(toHex(topicVoteCommitment('frank-test', flipped))).not.toBe(base)
    expect(() => topicVoteCommitment('frank-test', target.slice(1))).toThrow(
      RangeError,
    )
  })

  it('has no ambiguity between the network length and content', () => {
    const target = bytesOf(32, 5)
    expect(toHex(topicVoteCommitment('ab', target))).not.toBe(
      toHex(topicVoteCommitment('a', target)),
    )
  })

  it('gives a post and its one-byte mutation different identities and commitments', () => {
    const a = topicPostFrame()
    const b = a.slice()
    b[b.length - 1] ^= 1
    expect(toHex(t1(a))).not.toBe(toHex(t1(b)))
    expect(toHex(topicVoteCommitment('frank-test', t1(a)))).not.toBe(
      toHex(topicVoteCommitment('frank-test', t1(b))),
    )
  })

  it('keeps the same post byte-identical, so its identity is stable', () => {
    expect(toHex(t1(topicPostFrame()))).toBe(toHex(t1(topicPostFrame())))
    expect(toHex(t1(topicPostFrame({ topic: 'a' })))).not.toBe(
      toHex(t1(topicPostFrame({ topic: 'b' }))),
    )
  })
})

describe('committed topic-commitments.json', () => {
  it('is exactly what the fixture builders generate (regenerate with FRANK_UPDATE_VECTORS=1)', () => {
    expect(fs.readFileSync(COMMITMENTS_PATH, 'utf8')).toBe(serialized)
  })

  it('recomputes every hash from its own frame bytes', () => {
    const doc = JSON.parse(fs.readFileSync(COMMITMENTS_PATH, 'utf8'))
    expect(doc.format).toBe('frank-cbor-v1-topic-commitments')
    for (const c of doc.cases) {
      const frame = fromHex(c.frame_hex)
      const p = parsed(frame)
      expect(contentHashNetwork(p)).toBe(c.network)
      if (p.typeId === 9) {
        expect(toHex(contentHash(p))).toBe(c.t1_hex)
      } else if (p.typeId === 10) {
        const typed = p.typed
        if (typed?.type !== 10) throw new Error(c.id)
        const target = contentHash(typed.postFrame)
        expect(toHex(target)).toBe(c.target_hash_hex)
        expect(toHex(topicVoteCommitment(c.network, target))).toBe(c.t7_hex)
      } else {
        const typed = p.typed
        if (typed?.type !== 11) throw new Error(c.id)
        expect(toHex(typed.targetHash)).toBe(c.target_hash_hex)
        expect(toHex(topicVoteCommitment(c.network, typed.targetHash))).toBe(
          c.t7_hex,
        )
      }
    }
  })
})

describe('the corpus written before #136', () => {
  it('behaves identically once types 9 through 11 are listed as supported', () => {
    const legacy = CASES.filter(c => c.supported === undefined)
    expect(legacy.length).toBeGreaterThan(300)
    for (const c of legacy) {
      const before = contextOf(c)
      expect(before.supportedSchemas).toEqual(PRE_TOPIC_SCHEMAS)
      const after = {
        ...before,
        supportedSchemas: [
          ...PRE_TOPIC_SCHEMAS,
          ...[9, 10, 11].map(typeId => ({ typeId, schemaVersion: 1 })),
        ],
      }
      const run = (ctx: typeof before): string => {
        try {
          const r = validateFrame(c.frame, ctx)
          return r.kind
        } catch (e) {
          if (!(e instanceof FrankCodecError)) throw e
          return `${e.category}@${e.stage}`
        }
      }
      expect([c.id, run(after)]).toEqual([c.id, run(before)])
    }
  })
})
