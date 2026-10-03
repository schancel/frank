import corpus from '../../../docs/protocol/cbor/vectors/forum-content-read.json'
import proposal from '../../../docs/protocol/proposals/forum-content-read/vectors.json'
import {
  validateFrame,
  defaultContext,
  fromHex,
  toHex,
  encodeFrame,
  encodeCanonical,
  decodeCanonical,
  contentHash,
  topicVoteCommitment,
  encodeForumPost,
  encodeForumReadFrame,
  decodeForumCursor,
  forumCursorFromTransport,
  forumCursorToTransport,
  encodeForumCursor,
  matchForumOperation,
  matchForumPage,
  matchForumView,
  topicBurnCommitment,
  encodeTopicPostSubmission,
  FrankCodecError,
  ParsedFrame,
  Encodable,
  FrankValue,
  ForumOperationExpectation,
} from '../src'
import {
  buildForumCorpus,
  recipeValue,
  payloadOf,
  forumFixture,
  baseContent,
  contentPayload,
  ForumFixture,
} from '../fixtures/forum-content-read'

const parsed = (bytes: Uint8Array, ctx = defaultContext()): ParsedFrame => {
  const r = validateFrame(bytes, ctx)
  if (r.kind !== 'parsed') throw Error('not parsed')
  return r
}
const raw = (id: string) => fromHex(forumFixture(id).hex)
const frame = (
  type: number,
  payload: Encodable,
  schema = type === 9 ? 2 : 1,
  min = type === 9 ? 2 : 1,
) =>
  encodeFrame(
    { typeId: type, schemaVersion: schema, minReaderVersion: min },
    payload,
  )
const outcome = (bytes: Uint8Array) => {
  try {
    return validateFrame(bytes, defaultContext()).kind
  } catch (e) {
    if (!(e instanceof FrankCodecError)) throw e
    return `${e.category}@${e.stage}`
  }
}

describe('active Forum public facade', () => {
  it('pins the accepted bytes and every additional active recipe', () => {
    expect(corpus).toEqual(buildForumCorpus())
    expect(corpus.frames.slice(0, proposal.frames.length)).toEqual(
      proposal.frames,
    )
  })
  test.each(corpus.frames as ForumFixture[])('$id', f => {
    const bytes = fromHex(f.hex)
    expect(toHex(frame(f.type, recipeValue(f.payload), f.schema, f.min))).toBe(
      f.hex,
    )
    const context = defaultContext({
      readerVersion: f.context?.readerVersion ?? 2,
      opaqueRetentionAllowed: f.context?.retention ?? false,
    })
    const topicSchema = f.context?.topicSchema
    if (topicSchema)
      context.supportedSchemas = context.supportedSchemas.map(s =>
        s.typeId === 9 ? { ...s, schemaVersion: topicSchema } : s,
      )
    if (!f.valid) {
      try {
        validateFrame(bytes, context)
        throw Error(`accepted ${f.id}`)
      } catch (e) {
        expect(e).toBeInstanceOf(FrankCodecError)
        if (f.error)
          expect(
            `${(e as FrankCodecError).category}@${
              (e as FrankCodecError).stage
            }`,
          ).toBe(f.error)
      }
      return
    }
    const result = validateFrame(bytes, context)
    expect(result.frame).toEqual(bytes)
    if (f.retained) {
      expect(result.kind).toBe('retained')
      return
    }
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') throw Error('not parsed')
    if (f.type >= 12 && f.type <= 15 && f.schema === 1)
      expect(
        toHex(
          encodeForumReadFrame(
            f.type as 12 | 13 | 14 | 15,
            recipeValue(f.payload),
          ),
        ),
      ).toBe(f.hex)
    if (f.t1) expect(toHex(contentHash(result))).toBe(f.t1)
    if (f.t7)
      expect(
        toHex(topicVoteCommitment('monad-testnet', contentHash(result))),
      ).toBe(f.t7)
    if (f.type === 9) {
      expect(result.typed?.type).toBe(9)
      if (result.typed?.type === 9)
        expect(result.typed.schemaVersion).toBe(f.schema === 1 ? 1 : 2)
    }
  })
  it('independently constructs the two encode-origin posts and keeps the historical writer untouched', () => {
    expect(
      toHex(
        encodeForumPost({
          network: 'monad-testnet',
          topic: 'Forum/é',
          authored: { seconds: 1700000000n, nanoseconds: 999999999 },
          entries: [
            {
              title: 'Title',
              url: 'https://example.invalid/é?q=é',
              message: 'Body 😀 é é',
            },
          ],
        }),
      ),
    ).toBe(forumFixture('typescript-origin').hex)
    expect(
      toHex(
        encodeForumPost({
          network: 'monad-testnet',
          topic: 'Forum/é',
          authored: { seconds: -1n, nanoseconds: 1 },
          entries: [{ message: 'Rust origin λ' }],
        }),
      ),
    ).toBe(forumFixture('rust-origin').hex)
    for (const id of ['typescript-origin', 'rust-origin']) {
      const post = parsed(raw(id)).typed
      if (post?.type !== 9 || post.schemaVersion !== 2)
        throw Error('not structured')
      expect(post.content.entries.every(e => e.kind === 'post')).toBe(true)
      const entries = post.content.entries.map(e => {
        if (e.kind !== 'post') throw Error('unsupported')
        return { title: e.title, url: e.url, message: e.message }
      })
      expect(
        toHex(
          encodeForumPost({
            network: post.network,
            topic: post.topic,
            parentHash: post.parentHash,
            authored: post.content.authored,
            entries,
          }),
        ),
      ).toBe(toHex(raw(id)))
      const commitment = topicBurnCommitment(raw(id))
      expect(toHex(commitment.hash)).toBe(forumFixture(id).t1)
      expect(
        parsed(encodeTopicPostSubmission(raw(id), Uint8Array.of(1))).typed
          ?.type,
      ).toBe(10)
    }
    const opaque = parsed(frame(9, payloadOf('typescript-origin'), 1, 1)).typed
    expect(opaque).toMatchObject({ type: 9, schemaVersion: 1 })
    expect(opaque && 'content' in opaque).toBe(false)
    expect(contentHash(parsed(raw('typescript-origin')))).not.toEqual(
      contentHash(parsed(raw('different-authored-time'))),
    )
  })
  it('retains unknown future bytes and uses only a fixed bounded placeholder', () => {
    const bytes = raw('future-retention'),
      post = parsed(bytes).typed
    if (post?.type !== 9 || post.schemaVersion !== 2)
      throw Error('not structured')
    expect(
      post.content.entries.find(e => e.kind === 'unsupported'),
    ).toMatchObject({ placeholder: 'Unsupported content' })
    expect(parsed(bytes).frame).toEqual(bytes)
  })
})

describe('cursor and exact request boundaries', () => {
  it('checks cursor byte and transport ceilings before parsing or allocation', () => {
    // Closed cursor fields cannot fill 2048 bytes; prove the inclusive byte gate
    // separately from the subsequent canonical/schema rejection.
    for (const size of [2048, 2049]) {
      try {
        decodeForumCursor(new Uint8Array(size))
        throw Error('accepted')
      } catch (e) {
        expect(e).toBeInstanceOf(FrankCodecError)
        expect((e as FrankCodecError).category === 'resource').toBe(
          size === 2049,
        )
      }
    }
    expect(() => forumCursorFromTransport('A'.repeat(2731))).not.toThrow(
      'invalid cursor transport',
    )
    expect(() => forumCursorFromTransport('A'.repeat(2732))).toThrow(
      'invalid cursor transport',
    )
  })
  test.each(corpus.cursors)('round trips canonical cursor $hex', f => {
    const bytes = fromHex(f.hex),
      cursor = decodeForumCursor(bytes)
    expect(encodeForumCursor(cursor)).toEqual(bytes)
    expect(forumCursorFromTransport(forumCursorToTransport(bytes))).toEqual(
      cursor,
    )
    for (const spelling of [
      forumCursorToTransport(bytes) + '=',
      ' ' + forumCursorToTransport(bytes),
      'A',
      '*',
      'A'.repeat(2732),
    ])
      expect(() => forumCursorFromTransport(spelling)).toThrow()
    for (const network of ['UPPER', 'é', '', '-net', 'n'.repeat(65)]) {
      const value = new Map(decodeCanonical(bytes) as Map<bigint, FrankValue>)
      value.set(0n, network)
      expect(() => decodeForumCursor(encodeCanonical(value))).toThrow()
    }
    const missing = new Map(decodeCanonical(bytes) as Map<bigint, FrankValue>)
    missing.delete(7n)
    expect(() => decodeForumCursor(encodeCanonical(missing))).toThrow()
  })
  it('keeps status echoes unverified and rejects every retained-request mismatch', () => {
    for (const id of [
      'confirmed-a',
      'unknown-b-same-post',
      'pending-a',
      'rejected-b',
    ]) {
      const p = parsed(raw(id)).typed
      if (p?.type !== 15) throw Error('status')
      const expected: ForumOperationExpectation = {
        network: p.network,
        submittedFrame: p.submittedFrame.frame,
        targetHash: p.targetHash,
        transactionHash: p.transactionHash,
        sender: p.sender,
        direction: p.direction,
        value: p.value,
      }
      expect(matchForumOperation(raw(id), expected).evidence).toBe(
        p.state === 0 || p.state === 3
          ? 'unverified-request'
          : 'relay-observed',
      )
      for (const key of [
        'submittedFrame',
        'targetHash',
        'transactionHash',
        'sender',
      ] as const) {
        const changed = expected[key].slice()
        changed[changed.length - 1] ^= 1
        expect(() =>
          matchForumOperation(raw(id), { ...expected, [key]: changed }),
        ).toThrow()
      }
      expect(() =>
        matchForumOperation(raw(id), { ...expected, network: 'other' }),
      ).toThrow()
      expect(() =>
        matchForumOperation(raw(id), {
          ...expected,
          direction: p.direction === 0 ? 1 : 0,
        }),
      ).toThrow()
      expect(() =>
        matchForumOperation(raw(id), { ...expected, value: p.value + 1n }),
      ).toThrow()
    }
  })
  it('matches explicit view facts without inventing chain evidence or a read-frame T1', () => {
    const bytes = raw('view-large-aggregate'),
      v = parsed(bytes).typed
    if (v?.type !== 12 || v.postFrame.typed?.type !== 9) throw Error('view')
    const hash = contentHash(v.postFrame),
      expected = {
        network: v.network,
        topic: v.postFrame.typed.topic,
        targetHash: hash,
        rawTransaction: v.authorBurnTx,
        transactionHash: v.transactionHash,
        sender: v.author,
        direction: 1 as const,
        commitment: topicVoteCommitment(v.network, hash),
      }
    expect(matchForumView(bytes, expected)).toEqual(v)
    expect(() => matchForumView(bytes, { ...expected, direction: 0 })).toThrow()
    expect(() =>
      matchForumView(bytes, { ...expected, topic: 'different' }),
    ).toThrow()
    const p = parsed(raw('equal-time-page')).typed
    if (p?.type !== 13) throw Error('page')
    expect(
      matchForumPage(raw('equal-time-page'), {
        network: p.network,
        family: 13,
        topic: p.topic,
        since: p.since,
      }).frame,
    ).toEqual(raw('equal-time-page'))
    expect(() =>
      matchForumPage(raw('equal-time-page'), {
        network: p.network,
        family: 13,
        topic: p.topic,
        since: p.since,
        requestCursor: fromHex(corpus.cursors[0].hex),
      }),
    ).toThrow()
  })
})

describe('cumulative opened resource budgets', () => {
  const postWith = (content: FrankValue, schema = 2) =>
    frame(9, contentPayload(content), schema, 2)
  it('enforces 64 entries and the inclusive text/content byte ceilings', () => {
    const c = baseContent(),
      entry = new Map<bigint, FrankValue>([
        [0n, 1n],
        [3n, 'x'],
      ])
    c.set(
      1n,
      Array.from({ length: 64 }, () => entry),
    )
    expect(outcome(postWith(c))).toBe('parsed')
    c.set(
      1n,
      Array.from({ length: 65 }, () => entry),
    )
    expect(outcome(postWith(c))).toBe('resource@8.1')
    for (const size of [262144, 262145]) {
      c.set(1n, [
        new Map<bigint, FrankValue>([
          [0n, 1n],
          [3n, 'x'.repeat(size)],
        ]),
      ])
      expect(outcome(postWith(c))).toBe(
        size === 262144 ? 'parsed' : 'resource@8.4',
      )
    }
    // Pad a compatible future map to an exact body size without exceeding per-string limits.
    const body = baseContent()
    body.set(8n, new Uint8Array(0))
    const overhead = encodeCanonical(body).length
    // Header for this large byte string grows by four bytes relative to the empty one.
    body.set(8n, new Uint8Array(524288 - overhead - 4))
    expect(encodeCanonical(body).length).toBe(524288)
    expect(outcome(postWith(body, 3))).toBe('parsed')
    body.set(8n, new Uint8Array(524289 - overhead - 4))
    expect(outcome(postWith(body, 3))).toBe('resource@8.1')
  })
  it('charges content, cursor and required children to one depth budget', () => {
    const wrap = (post: Uint8Array) => {
      const view = payloadOf('view-large-aggregate')
      view.set(1, post)
      const page = payloadOf('equal-time-page')
      page.set(4, [frame(12, view)])
      return frame(13, page)
    }
    let found = false
    for (let depth = 20; depth < 34; depth++) {
      let extra: FrankValue = 0n
      for (let i = 0; i < depth; i++) extra = [extra]
      const content = baseContent()
      content.set(8n, extra)
      const post = postWith(content, 3)
      if (
        outcome(post) === 'parsed' &&
        outcome(wrap(post)) === 'resource@8.4'
      ) {
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })
  it('rejects combined container and item counts although every child is individually valid', () => {
    for (const kind of ['containers', 'items']) {
      const content = baseContent()
      content.set(
        8n,
        kind === 'containers'
          ? Array.from({ length: 8190 }, () => [])
          : Array.from({ length: 20 }, () => Array<FrankValue>(8190).fill(0n)),
      )
      if (kind === 'items')
        content.set(
          8n,
          Array.from({ length: 8 }, () => Array<FrankValue>(8190).fill(0n)),
        )
      const posts = [0, 1, 2].map(i => {
        const p = contentPayload(content)
        p.set(2, new Uint8Array(32).fill(i))
        return frame(9, p, 3, 2)
      })
      for (const p of posts) expect(outcome(p)).toBe('parsed')
      const views = posts.map(p => {
        const v = payloadOf('view-large-aggregate')
        v.set(1, p)
        return frame(12, v)
      })
      for (const v of views) expect(outcome(v)).toBe('parsed')
      const page = payloadOf('equal-time-page')
      page.set(4, views)
      expect(outcome(frame(13, page))).toBe('resource@8.4')
    }
  })
  it('enforces encoded view/page bytes and rejects excess rows before opening them', () => {
    for (const [type, id, limit] of [
      [12, 'view-large-aggregate', 2097152],
      [13, 'equal-time-page', 4194304],
    ] as const) {
      const payload = payloadOf(id)
      payload.set(99, new Uint8Array(0))
      const overhead = frame(type, payload, 2, 1).length
      // Both the padding string and the envelope's payload string widen their headers.
      payload.set(99, new Uint8Array(limit - overhead - 6))
      expect(frame(type, payload, 2, 1).length).toBe(limit)
      expect(outcome(frame(type, payload, 2, 1))).toBe('parsed')
      payload.set(99, new Uint8Array(limit - overhead - 5))
      expect(outcome(frame(type, payload, 2, 1))).toBe('resource@8.1')
    }
    const page = payloadOf('equal-time-page')
    const rows = Array.from({ length: 128 }, (_, i) => {
      const post = payloadOf('typescript-origin')
      post.set(2, new Uint8Array(32).fill(i))
      const view = payloadOf('view-large-aggregate')
      view.set(1, frame(9, post))
      return frame(12, view)
    }).sort((a, b) => {
      const av = parsed(a).typed,
        bv = parsed(b).typed
      if (av?.type !== 12 || bv?.type !== 12) throw Error('view')
      return toHex(contentHash(av.postFrame)).localeCompare(
        toHex(contentHash(bv.postFrame)),
      )
    })
    page.set(4, rows)
    expect(outcome(frame(13, page))).toBe('parsed')
    page.set(
      4,
      Array.from({ length: 129 }, () => raw('view-rust')),
    )
    expect(outcome(frame(13, page))).toBe('resource@8.1')
  })
})
