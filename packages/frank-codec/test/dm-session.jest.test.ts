// Structural-only fixtures: no cipher authentication, payment, or full-stage-10 claim.
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  beginDirectMessageValidation,
  defaultContext,
  FrankCodecError,
  FrankContextError,
  fromHex,
  MAX_FRAME_BYTES,
  parseFrame,
  type Encodable,
  type Operation,
} from '../src'
import {
  M,
  NET,
  T3C,
  acct1,
  bytesOf,
  containerItem,
  deliveryPayload,
  fr,
  frRaw,
  rev8Frame,
  textItem,
  type5Payload,
  unknownItem,
} from '../fixtures/builders'

function encrypted(suite = 1, schema = 2, min = 2): Uint8Array {
  return fr(
    5,
    M([
      [0, NET],
      [1, acct1(9)],
      [2, acct1(3)],
      [3, suite],
      [4, Uint8Array.of(0xa0)],
      [5, T3C.ephemeral],
      [6, T3C.shared],
      [7, T3C.proof],
    ]),
    schema,
    min,
  )
}
function root(extra?: Encodable): Uint8Array {
  const payload = deliveryPayload({ payloadFrame: encrypted() })
  if (extra !== undefined) payload.set(99, extra)
  return fr(1, payload, extra === undefined ? 1 : 2, 1)
}
function content(extra?: Encodable, items = [unknownItem()]): Uint8Array {
  const payload = M([
    [0, NET],
    [1, bytesOf(16, 7)],
    [2, rev8Frame(items)],
    [3, bytesOf(32, 8)],
    [4, bytesOf(16, 8)],
  ])
  if (extra !== undefined) payload.set(99, extra)
  return fr(6, payload, extra === undefined ? 1 : 2, 1)
}
function grouped(n: number, containers: boolean): Encodable[] {
  const groups: Encodable[] = []
  for (let offset = 0; offset < n; offset += 4096)
    groups.push(
      Array.from({ length: Math.min(4096, n - offset) }, () =>
        containers ? [] : 0,
      ),
    )
  return groups
}
const nested = (n: number): Encodable => {
  let value: Encodable = 0
  for (let i = 0; i < n; i++) value = [value]
  return value
}
function outcome(run: () => unknown): string {
  try {
    run()
    return 'parsed'
  } catch (error) {
    if (error instanceof FrankCodecError)
      return `${error.category}@${error.stage}`
    if (error instanceof FrankContextError) return 'context'
    throw error
  }
}
const finish = (r: Uint8Array, c: Uint8Array) =>
  beginDirectMessageValidation(
    r,
    defaultContext(),
  ).completeAuthenticatedContent(c)

describe('opaque DM structural continuation', () => {
  it('owns the unchanged production suite1 vector; arbitrary authenticated bytes are not type6', () => {
    const vector = JSON.parse(
      readFileSync(
        join(__dirname, '../../../docs/protocol/cbor/vectors/dm-suite-1.json'),
        'utf8',
      ),
    ) as {
      type5FrameHex: string
      cryptoBox: { plaintextHex: string }
    }
    const bytes = fromHex(vector.type5FrameHex)
    const session = beginDirectMessageValidation(bytes, defaultContext())
    expect(session.payload).toEqual(parseFrame(bytes))
    // The frozen cipher test's plaintext is just "frank", not a valid content frame.
    expect(
      outcome(() =>
        session.completeAuthenticatedContent(
          fromHex(vector.cryptoBox.plaintextHex),
        ),
      ),
    ).toBe('frame@2')
  })

  it('matches ordinary typed results for actual type1 and standalone type5; retains opaque items', () => {
    for (const r of [root(), encrypted()]) {
      const c = content()
      expect(finish(r, c)).toEqual({
        root: parseFrame(r),
        content: parseFrame(c),
      })
      const parsed = finish(r, c).content
      if (
        parsed.typed?.type !== 6 ||
        parsed.typed.revisionFrame.typed?.type !== 8
      )
        throw new Error('not typed content')
      expect(parsed.typed.revisionFrame.typed.items[0].kind).toBe('retained')
    }
    expect(
      outcome(() => parseFrame(root(), defaultContext({ operation: 'full' }))),
    ).toBe('context')
  })

  it.each<Operation>(['frame', 'generic', 'full'])(
    'rejects non-typed %s without changing ordinary parsing',
    operation => {
      const ctx = defaultContext({ operation })
      expect(
        outcome(() => beginDirectMessageValidation(encrypted(), ctx)),
      ).toBe('context')
      expect(outcome(() => parseFrame(encrypted(), ctx))).toBe('parsed')
    },
  )

  it('rejects non-DM, legacy/future payload schemas, suite and reader downgrade', () => {
    expect(
      outcome(() => beginDirectMessageValidation(content(), defaultContext())),
    ).toBe('context')
    expect(
      outcome(() =>
        beginDirectMessageValidation(fr(5, type5Payload()), defaultContext()),
      ),
    ).toBe('context')
    for (const bad of [
      encrypted(65535),
      encrypted(1, 3, 2),
      encrypted(1, 2, 1),
    ]) {
      expect(
        outcome(() => beginDirectMessageValidation(bad, defaultContext())),
      ).toBe(outcome(() => parseFrame(bad)))
      expect(outcome(() => parseFrame(bad))).not.toBe('parsed')
    }
  })

  it('requires type6, never retains an unsupported required child, and preserves first errors', () => {
    for (const [bad, expected] of [
      [unknownItem(), 'semantic@8.4'],
      [frRaw(17, Uint8Array.of(0xff)), 'semantic@8.4'],
      [frRaw(6, Uint8Array.of(0xff)), 'malformed@7'],
      [fr(6, M([]), 3, 3), 'unsupported@7'],
      [fr(6, M([])), 'schema@8.2'],
      [Uint8Array.of(0), 'frame@2'],
    ] as const)
      expect(outcome(() => finish(root(), bad))).toBe(expected)
    const unsupported = content()
    unsupported[4] = 2
    expect(outcome(() => finish(root(), unsupported))).toBe('unsupported@3')
    expect(
      outcome(() =>
        beginDirectMessageValidation(Uint8Array.of(0), defaultContext()),
      ),
    ).toBe('frame@2')
  })

  it('owns context, original bytes and every payload view; completion/failure/abort are terminal', () => {
    const input = root(),
      original = new Uint8Array(input)
    const ctx = defaultContext(),
      session = beginDirectMessageValidation(input, ctx)
    input.fill(0)
    ctx.readerVersion = 0
    ctx.supportedSchemas = []
    const copy = session.payload
    copy.frame.fill(0)
    copy.payloadBytes.fill(0)
    ;(copy.payload as Map<bigint, Encodable>).clear()
    if (copy.typed?.type !== 5) throw new Error('not payload')
    copy.typed.ephemeralPoint.fill(0)
    expect(session.payload).toEqual(parseFrame(encrypted()))
    expect(session.completeAuthenticatedContent(content()).root.frame).toEqual(
      original,
    )
    expect(() => session.payload).toThrow(FrankContextError)
    expect(() => session.abort()).toThrow(FrankContextError)
    expect(() => session.completeAuthenticatedContent(content())).toThrow(
      FrankContextError,
    )
    const failed = beginDirectMessageValidation(root(), defaultContext())
    expect(() => failed.completeAuthenticatedContent(unknownItem())).toThrow(
      FrankCodecError,
    )
    expect(() => failed.completeAuthenticatedContent(content())).toThrow(
      FrankContextError,
    )
    const aborted = beginDirectMessageValidation(root(), defaultContext())
    aborted.abort()
    expect(() => aborted.payload).toThrow(FrankContextError)
    expect(() => aborted.completeAuthenticatedContent(content())).toThrow(
      FrankContextError,
    )
  })

  it('does not charge plaintext against route bytes, but checks MAX_FRAME_BYTES before header', () => {
    const r = encrypted(),
      c = content('x'.repeat(r.length * 2))
    const session = beginDirectMessageValidation(
      r,
      defaultContext({ routeByteLimit: r.length }),
    )
    expect(c.length).toBeGreaterThan(r.length)
    expect(session.completeAuthenticatedContent(c).content.typeId).toBe(6)
    expect(outcome(() => finish(r, new Uint8Array(MAX_FRAME_BYTES + 1)))).toBe(
      'resource@1',
    )
    expect(
      outcome(() =>
        beginDirectMessageValidation(
          r,
          defaultContext({ routeByteLimit: r.length - 1 }),
        ),
      ),
    ).toBe('resource@1')
  })

  it.each([
    ['containers', true, 8000, 8360],
    ['items', false, 60000, 70908],
  ] as const)(
    'retains aggregate %s across encryption: exact ceiling and one over',
    (_label, containers, rootCount, at) => {
      // Same deterministic counts in Rust. Baselines: root 10 containers/80 items;
      // content 7 containers/45 items. Each extension adds one outer array and chunk arrays.
      const r = root(grouped(rootCount, containers))
      expect(outcome(() => parseFrame(r))).toBe('parsed')
      for (const n of [at, at + 1]) {
        const c = content(grouped(n, containers))
        expect(outcome(() => parseFrame(c))).toBe('parsed') // Old two-parse workaround accepts both.
        expect(outcome(() => finish(r, c))).toBe(
          n === at ? 'parsed' : 'resource@7',
        )
      }
    },
  )

  it('retains actual graph depth: standalone5 and type1 have different exact boundaries', () => {
    for (const [r, at] of [
      [root(), 26],
      [encrypted(), 28],
    ] as const) {
      for (const n of [at, at + 1]) {
        const c = content(nested(n))
        expect(outcome(() => parseFrame(c))).toBe('parsed')
        expect(outcome(() => finish(r, c))).toBe(
          n === at ? 'parsed' : 'resource@7',
        )
      }
    }
    const c = content(nested(28))
    expect(outcome(() => finish(encrypted(), c))).toBe('parsed')
    expect(outcome(() => finish(root(), c))).toBe('resource@7')
  })

  it('keeps recursive message-item depth and the 256-item budget', () => {
    let item = textItem()
    for (let i = 0; i < 7; i++) item = containerItem([item])
    expect(outcome(() => finish(root(), content(undefined, [item])))).toBe(
      'parsed',
    )
    item = containerItem([item])
    expect(outcome(() => parseFrame(content(undefined, [item])))).toBe('parsed')
    expect(outcome(() => finish(root(), content(undefined, [item])))).toBe(
      'resource@7',
    )
    const group = containerItem(
      Array.from({ length: 127 }, () => unknownItem()),
    )
    const at = content(undefined, [group, group])
    expect(outcome(() => finish(root(), at))).toBe('parsed')
    expect(
      outcome(() =>
        finish(root(), content(undefined, [group, group, unknownItem()])),
      ),
    ).toBe('resource@8.4')
  })
})
