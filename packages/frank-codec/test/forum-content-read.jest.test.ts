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
import {
  FORUM_CONTENT,
  FORUM_POST_ENTRY,
  FORUM_SINGLE_VIEW,
  FORUM_TOPIC_PAGE,
  TOPIC_POST,
  TYPE_FORUM_DISCOVERY_PAGE,
  TYPE_FORUM_OPERATION_STATUS,
  TYPE_FORUM_TOPIC_PAGE,
  TYPE_FORUM_VIEW,
  TYPE_TOPIC_POST,
  TYPE_TOPIC_POST_SUBMISSION,
} from '../src/constants'

const parsed = (bytes: Uint8Array, ctx = defaultContext()): ParsedFrame => {
  const r = validateFrame(bytes, ctx)
  if (r.kind !== 'parsed') throw Error('not parsed')
  return r
}
const raw = (id: string) => fromHex(forumFixture(id).hex)
const frame = (
  type: number,
  payload: Encodable,
  schema = type === TYPE_TOPIC_POST ? 2 : 1,
  min = type === TYPE_TOPIC_POST ? 2 : 1,
) =>
  encodeFrame(
    { typeId: type, schemaVersion: schema, minReaderVersion: min },
    payload,
  )
const FORUM_READ_TYPES = [
  TYPE_FORUM_VIEW,
  TYPE_FORUM_TOPIC_PAGE,
  TYPE_FORUM_DISCOVERY_PAGE,
  TYPE_FORUM_DISCOVERY_PAGE,
  TYPE_FORUM_OPERATION_STATUS,
] as const
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
        s.typeId === TYPE_TOPIC_POST ? { ...s, schemaVersion: topicSchema } : s,
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
    if (
      (FORUM_READ_TYPES as readonly number[]).includes(f.type) &&
      f.schema === 1
    )
      expect(
        toHex(
          encodeForumReadFrame(
            f.type as (typeof FORUM_READ_TYPES)[number],
            recipeValue(f.payload),
          ),
        ),
      ).toBe(f.hex)
    if (f.t1) expect(toHex(contentHash(result))).toBe(f.t1)
    if (f.t7)
      expect(
        toHex(topicVoteCommitment('monad-testnet', contentHash(result))),
      ).toBe(f.t7)
    if (f.type === TYPE_TOPIC_POST) {
      expect(result.typed?.type).toBe(TYPE_TOPIC_POST)
      if (result.typed?.type === TYPE_TOPIC_POST)
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
      if (post?.type !== TYPE_TOPIC_POST || post.schemaVersion !== 2)
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
      ).toBe(TYPE_TOPIC_POST_SUBMISSION)
    }
    const opaque = parsed(
      frame(TYPE_TOPIC_POST, payloadOf('typescript-origin'), 1, 1),
    ).typed
    expect(opaque).toMatchObject({ type: TYPE_TOPIC_POST, schemaVersion: 1 })
    expect(opaque && 'content' in opaque).toBe(false)
    expect(contentHash(parsed(raw('typescript-origin')))).not.toEqual(
      contentHash(parsed(raw('different-authored-time'))),
    )
  })
  it('retains unknown future bytes and uses only a fixed bounded placeholder', () => {
    const bytes = raw('future-retention'),
      post = parsed(bytes).typed
    if (post?.type !== TYPE_TOPIC_POST || post.schemaVersion !== 2)
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
    // raw-cbor-key: byte-size list, not a map entry
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
      // raw-cbor-key: network (0) sits at the same key in topic and discovery cursors
      value.set(0n, network)
      expect(() => decodeForumCursor(encodeCanonical(value))).toThrow()
    }
    const missing = new Map(decodeCanonical(bytes) as Map<bigint, FrankValue>)
    // raw-cbor-key: incarnation (7) sits at the same key in topic and discovery cursors
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
      if (p?.type !== TYPE_FORUM_OPERATION_STATUS) throw Error('status')
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
    if (
      v?.type !== TYPE_FORUM_VIEW ||
      v.postFrame.typed?.type !== TYPE_TOPIC_POST
    )
      throw Error('view')
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
    if (p?.type !== TYPE_FORUM_TOPIC_PAGE) throw Error('page')
    expect(
      matchForumPage(raw('equal-time-page'), {
        network: p.network,
        family: TYPE_FORUM_TOPIC_PAGE,
        topic: p.topic,
        since: p.since,
      }).frame,
    ).toEqual(raw('equal-time-page'))
    expect(() =>
      matchForumPage(raw('equal-time-page'), {
        network: p.network,
        family: TYPE_FORUM_TOPIC_PAGE,
        topic: p.topic,
        since: p.since,
        requestCursor: fromHex(corpus.cursors[0].hex),
      }),
    ).toThrow()
  })
})

describe('cumulative opened resource budgets', () => {
  const postWith = (content: FrankValue, schema = 2) =>
    frame(TYPE_TOPIC_POST, contentPayload(content), schema, 2)
  it('enforces 64 entries and the inclusive text/content byte ceilings', () => {
    const c = baseContent(),
      entry = new Map<bigint, FrankValue>([
        [BigInt(FORUM_POST_ENTRY.kind), 1n],
        [BigInt(FORUM_POST_ENTRY.message), 'x'],
      ])
    c.set(
      BigInt(FORUM_CONTENT.entries),
      Array.from({ length: 64 }, () => entry),
    )
    expect(outcome(postWith(c))).toBe('parsed')
    c.set(
      BigInt(FORUM_CONTENT.entries),
      Array.from({ length: 65 }, () => entry),
    )
    expect(outcome(postWith(c))).toBe('resource@8.1')
    // raw-cbor-key: byte-size list, not a map entry
    for (const size of [262144, 262145]) {
      c.set(BigInt(FORUM_CONTENT.entries), [
        new Map<bigint, FrankValue>([
          [BigInt(FORUM_POST_ENTRY.kind), 1n],
          [BigInt(FORUM_POST_ENTRY.message), 'x'.repeat(size)],
        ]),
      ])
      expect(outcome(postWith(c))).toBe(
        size === 262144 ? 'parsed' : 'resource@8.4',
      )
    }
    // Pad a compatible future map to an exact body size without exceeding per-string limits.
    const body = baseContent()
    // raw-cbor-key: key 8 is undeclared in forum content: compatible future padding
    body.set(8n, new Uint8Array(0))
    const overhead = encodeCanonical(body).length
    // Header for this large byte string grows by four bytes relative to the empty one.
    // raw-cbor-key: key 8 is undeclared in forum content: compatible future padding
    body.set(8n, new Uint8Array(524288 - overhead - 4))
    expect(encodeCanonical(body).length).toBe(524288)
    expect(outcome(postWith(body, 3))).toBe('parsed')
    // raw-cbor-key: key 8 is undeclared in forum content: compatible future padding
    body.set(8n, new Uint8Array(524289 - overhead - 4))
    expect(outcome(postWith(body, 3))).toBe('resource@8.1')
  })
  it('charges content, cursor and required children to one depth budget', () => {
    const wrap = (post: Uint8Array) => {
      const view = payloadOf('view-large-aggregate')
      view.set(FORUM_SINGLE_VIEW.postFrame, post)
      const page = payloadOf('equal-time-page')
      page.set(FORUM_TOPIC_PAGE.rows, [frame(TYPE_FORUM_VIEW, view)])
      return frame(TYPE_FORUM_TOPIC_PAGE, page)
    }
    let found = false
    for (let depth = 20; depth < 34; depth++) {
      let extra: FrankValue = 0n
      for (let i = 0; i < depth; i++) extra = [extra]
      const content = baseContent()
      // raw-cbor-key: key 8 is undeclared in forum content: compatible future nesting
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
        // raw-cbor-key: key 8 is undeclared in forum content: compatible future nesting
        8n,
        kind === 'containers'
          ? Array.from({ length: 8190 }, () => [])
          : Array.from({ length: 20 }, () => Array<FrankValue>(8190).fill(0n)),
      )
      if (kind === 'items')
        content.set(
          // raw-cbor-key: key 8 is undeclared in forum content: compatible future nesting
          8n,
          Array.from({ length: 8 }, () => Array<FrankValue>(8190).fill(0n)),
        )
      // raw-cbor-key: post-index list, not a map entry
      const posts = [0, 1, 2].map(i => {
        const p = contentPayload(content)
        p.set(TOPIC_POST.parentHash, new Uint8Array(32).fill(i))
        return frame(TYPE_TOPIC_POST, p, 3, 2)
      })
      for (const p of posts) expect(outcome(p)).toBe('parsed')
      const views = posts.map(p => {
        const v = payloadOf('view-large-aggregate')
        v.set(FORUM_SINGLE_VIEW.postFrame, p)
        return frame(TYPE_FORUM_VIEW, v)
      })
      for (const v of views) expect(outcome(v)).toBe('parsed')
      const page = payloadOf('equal-time-page')
      page.set(FORUM_TOPIC_PAGE.rows, views)
      expect(outcome(frame(TYPE_FORUM_TOPIC_PAGE, page))).toBe('resource@8.4')
    }
  })
  it('enforces encoded view/page bytes and rejects excess rows before opening them', () => {
    for (const [type, id, limit] of [
      [TYPE_FORUM_VIEW, 'view-large-aggregate', 2097152],
      [TYPE_FORUM_TOPIC_PAGE, 'equal-time-page', 4194304],
    ] as const) {
      const payload = payloadOf(id)
      // raw-cbor-key: key 99 is undeclared: compatible future padding
      payload.set(99, new Uint8Array(0))
      const overhead = frame(type, payload, 2, 1).length
      // Both the padding string and the envelope's payload string widen their headers.
      // raw-cbor-key: key 99 is undeclared: compatible future padding
      payload.set(99, new Uint8Array(limit - overhead - 6))
      expect(frame(type, payload, 2, 1).length).toBe(limit)
      expect(outcome(frame(type, payload, 2, 1))).toBe('parsed')
      // raw-cbor-key: key 99 is undeclared: compatible future padding
      payload.set(99, new Uint8Array(limit - overhead - 5))
      expect(outcome(frame(type, payload, 2, 1))).toBe('resource@8.1')
    }
    const page = payloadOf('equal-time-page')
    const rows = Array.from({ length: 128 }, (_, i) => {
      const post = payloadOf('typescript-origin')
      post.set(TOPIC_POST.parentHash, new Uint8Array(32).fill(i))
      const view = payloadOf('view-large-aggregate')
      view.set(FORUM_SINGLE_VIEW.postFrame, frame(TYPE_TOPIC_POST, post))
      return frame(TYPE_FORUM_VIEW, view)
    }).sort((a, b) => {
      const av = parsed(a).typed,
        bv = parsed(b).typed
      if (av?.type !== TYPE_FORUM_VIEW || bv?.type !== TYPE_FORUM_VIEW)
        throw Error('view')
      return toHex(contentHash(av.postFrame)).localeCompare(
        toHex(contentHash(bv.postFrame)),
      )
    })
    page.set(FORUM_TOPIC_PAGE.rows, rows)
    expect(outcome(frame(TYPE_FORUM_TOPIC_PAGE, page))).toBe('parsed')
    page.set(
      FORUM_TOPIC_PAGE.rows,
      Array.from({ length: 129 }, () => raw('view-rust')),
    )
    expect(outcome(frame(TYPE_FORUM_TOPIC_PAGE, page))).toBe('resource@8.1')
  })
})
