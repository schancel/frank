// The first failing check determines the category (README section 9): each test builds bytes
// that violate two stages at once and asserts the earlier one is reported.
import {
  FrankCodecError,
  FrankContextError,
  MAX_FRAME_BYTES,
  defaultContext,
  encodeFrame,
  validateFrame,
  wrapFrame,
} from '../src'
import type { ValidationContext } from '../src'
import {
  M,
  NET,
  WORKED_TEXT_HI,
  acct1,
  acct2,
  attestationFrame,
  body,
  bytesOf,
  concatBytes,
  containerItem,
  deliveryFrame,
  fr,
  framePayload,
  hex,
  sig,
  statementFrame,
  textItem,
  type5Frame,
  type5Payload,
  unknownItem,
  withLength,
} from '../fixtures/builders'

function outcome(f: Uint8Array, ctx: Partial<ValidationContext> = {}): string {
  try {
    const r = validateFrame(f, defaultContext(ctx))
    return r.kind
  } catch (e) {
    if (!(e instanceof FrankCodecError)) throw e
    return `${e.category}@${e.stage}`
  }
}

describe('stage precedence', () => {
  it('stage 1 (resource) precedes the header: an oversize input with bad magic is resource', () => {
    const big = new Uint8Array(MAX_FRAME_BYTES + 1)
    expect(outcome(big)).toBe('resource@1')
    expect(outcome(new Uint8Array(30), { routeByteLimit: 29 })).toBe(
      'resource@1',
    )
    expect(outcome(new Uint8Array(30), { routeByteLimit: 30 })).toBe('frame@2')
  })

  it('a narrower route limit never widens the global limit', () => {
    expect(
      outcome(new Uint8Array(MAX_FRAME_BYTES + 1), {
        routeByteLimit: MAX_FRAME_BYTES + 100,
      }),
    ).toBe('resource@1')
  })

  it('stage 2 (frame) precedes the version: bad magic with version 2 is a frame error', () => {
    const f = WORKED_TEXT_HI.slice()
    f[0] = 0
    f[4] = 2
    expect(outcome(f)).toBe('frame@2')
  })

  it('stage 3 (unsupported) precedes the length: a version-2 frame with a wrong length', () => {
    const f = withLength(WORKED_TEXT_HI, 999)
    f[4] = 2
    expect(outcome(f)).toBe('unsupported@3')
    // Where retention is allowed the length field is never interpreted and later stages do not run.
    expect(outcome(f, { opaqueRetentionAllowed: true })).toBe('retained')
    const junk = concatBytes(
      hex('46524e4b02'),
      new Uint8Array(4).fill(255),
      hex('ffffffffff'),
    )
    expect(outcome(junk, { opaqueRetentionAllowed: true })).toBe('retained')
  })

  it('stage 4 (frame) precedes CBOR: a wrong length over malformed CBOR is a frame error', () => {
    const f = body('780561')
    expect(outcome(withLength(f, 2))).toBe('frame@4')
    expect(outcome(f)).toBe('malformed@5')
  })

  it('stage 5 precedes stage 6: a malformed envelope is not reported as a schema error', () => {
    expect(outcome(body('a1 00 ff'))).toBe('malformed@5')
    expect(outcome(body('01'))).toBe('schema@6')
  })

  it('stage 6 precedes stage 7: an envelope schema error hides a malformed payload', () => {
    // min_reader 2 > schema 1 (schema), with a truncated payload byte string content.
    const f = body('a4 0011 0101 0202 0342 a1 00'.replace(/ /g, ''))
    expect(outcome(f)).toBe('schema@6')
  })

  it('stage 7: a malformed payload beats an unknown type, even when retention is permitted', () => {
    const f = framePayload(hex('780561'), 0xffff0001)
    expect(outcome(f, { opaqueRetentionAllowed: true })).toBe('malformed@7')
    expect(
      outcome(framePayload(hex('a0'), 0xffff0001), {
        opaqueRetentionAllowed: true,
      }),
    ).toBe('retained')
  })

  it('stage 7 ends a generic operation; stage 8 problems are invisible to it', () => {
    const f = fr(17, M([[0, 5]])) // wrong type for field 0: a stage 8.2 schema error
    expect(outcome(f, { operation: 'generic' })).toBe('parsed')
    expect(outcome(f, { operation: 'typed' })).toBe('schema@8.2')
    expect(outcome(WORKED_TEXT_HI, { operation: 'frame' })).toBe('frame')
  })

  it('8.1 precedes 8.2, 8.2 precedes 8.3, and 8.3 precedes 8.4', () => {
    // 65 members of the wrong shape: resource (8.1), not schema.
    expect(
      outcome(fr(1, M([[4, Array.from({ length: 65 }, () => M([]))]]))),
    ).toBe('resource@8.1')
    // Unallocated suite plus a bad network tag: schema (8.2) wins over unsupported (8.3).
    expect(outcome(fr(5, type5Payload({ net: 'BAD', suite: 1 })))).toBe(
      'schema@8.2',
    )
    // Unallocated suite plus a wrong-typed child field would surface at 8.4 only after 8.3.
    const d = deliveryFrame({
      payloadFrame: textItem(),
      destination: M([
        [0, 9],
        [1, bytesOf(33, 1)],
      ]),
    })
    expect(outcome(d)).toBe('unsupported@8.3')
    expect(outcome(deliveryFrame({ payloadFrame: textItem() }))).toBe(
      'semantic@8.4',
    )
  })

  it('children open depth-first in array order and the first failure wins', () => {
    const items = [textItem('ok'), fr(17, M([[0, 1]])), body('780561')]
    const f = fr(
      8,
      M([
        [0, 'frank'],
        [1, items],
      ]),
    )
    let err: FrankCodecError | undefined
    try {
      validateFrame(f, defaultContext())
    } catch (e) {
      err = e as FrankCodecError
    }
    expect([err?.category, err?.stage]).toEqual(['schema', '8.2'])
    expect(err?.location).toContain('[1]')
  })

  it('a child failure precedes the parent stage 9 checks', () => {
    // Parent violations: network mismatch and unsorted payments (semantic at 9), but the child is
    // malformed at its stage 7, which is reported first.
    const child = framePayload(hex('a1 00 1805'), 5)
    expect(
      outcome(deliveryFrame({ payloadFrame: child, net: 'other-net' })),
    ).toBe('noncanonical@7')
  })

  it('a required child runs stages 2-6 before its type is compared (bad magic beats wrong type)', () => {
    const wrong = textItem()
    wrong[0] = 0
    expect(outcome(deliveryFrame({ payloadFrame: wrong }))).toBe('frame@2')
    // ...and a wrong type beats the child payload it would otherwise fail at stage 7.
    expect(
      outcome(deliveryFrame({ payloadFrame: framePayload(hex('780561'), 17) })),
    ).toBe('semantic@8.4')
  })

  it('an open-field child of an assigned type is a semantic error after its stage 6, before its payload', () => {
    const c = framePayload(hex('780561'), 5)
    expect(
      outcome(
        fr(
          8,
          M([
            [0, 'frank'],
            [1, [c]],
          ]),
        ),
      ),
    ).toBe('semantic@8.4')
    // Whereas an unassigned type reaches stage 7 and reports its malformed payload.
    expect(
      outcome(
        fr(
          8,
          M([
            [0, 'frank'],
            [1, [framePayload(hex('780561'), 9)]],
          ]),
        ),
      ),
    ).toBe('malformed@7')
  })

  it('root retention flag governs only the root: children retain regardless', () => {
    const f = fr(
      8,
      M([
        [0, 'frank'],
        [1, [unknownItem()]],
      ]),
    )
    expect(outcome(f, { opaqueRetentionAllowed: false })).toBe('parsed')
    expect(outcome(unknownItem(), { opaqueRetentionAllowed: false })).toBe(
      'unsupported@7',
    )
    expect(outcome(unknownItem(), { opaqueRetentionAllowed: true })).toBe(
      'retained',
    )
  })

  it('shares counters across the envelope, payload and every opened child (R1, no reset)', () => {
    // Each child alone stays under 16,384 containers; three together do not.
    const heavy = (): Uint8Array =>
      framePayload(
        concatBytes(hex('99 2000'), new Uint8Array(8192).fill(0x80)),
        0xffff0001,
      )
    const alone = fr(
      8,
      M([
        [0, 'frank'],
        [1, [heavy()]],
      ]),
    )
    expect(outcome(alone)).toBe('parsed')
    const three = fr(
      8,
      M([
        [0, 'frank'],
        [1, [heavy(), heavy(), heavy()]],
      ]),
    )
    expect(outcome(three)).toBe('resource@7')
  })

  it('shares the item counter with children: MAX_ITEMS is charged across frames', () => {
    // 8,192 scalars per child payload; 17 children exceed 131,072 items in all, each alone is tiny.
    const child = (): Uint8Array =>
      framePayload(
        concatBytes(hex('99 2000'), new Uint8Array(8192)),
        0xffff0001,
      )
    const ok = fr(
      8,
      M([
        [0, 'frank'],
        [1, Array.from({ length: 15 }, child)],
      ]),
    )
    expect(outcome(ok)).toBe('parsed')
    const over = fr(
      8,
      M([
        [0, 'frank'],
        [1, Array.from({ length: 16 }, child)],
      ]),
    )
    expect(outcome(over)).toBe('resource@7')
  })
})

describe('type-2 context handling', () => {
  it('needs a prior slot (null for bootstrap) and rejects an invalid prior as a context error', () => {
    const att = attestationFrame(statementFrame(), [sig(acct2(1))])
    expect(() =>
      validateFrame(
        att,
        defaultContext({ priorDirectoryStatementFrame: undefined }),
      ),
    ).toThrow(FrankContextError)
    expect(() =>
      validateFrame(
        att,
        defaultContext({ priorDirectoryStatementFrame: hex('00') }),
      ),
    ).toThrow(FrankContextError)
    expect(() =>
      validateFrame(
        att,
        defaultContext({ priorDirectoryStatementFrame: WORKED_TEXT_HI }),
      ),
    ).toThrow(FrankContextError)
    expect(
      validateFrame(att, defaultContext({ priorDirectoryStatementFrame: null }))
        .kind,
    ).toBe('parsed')
  })

  it('does not consult the prior for other roots', () => {
    expect(
      outcome(WORKED_TEXT_HI, { priorDirectoryStatementFrame: hex('00') }),
    ).toBe('parsed')
  })

  it('validates routeByteLimit', () => {
    expect(() =>
      validateFrame(WORKED_TEXT_HI, defaultContext({ routeByteLimit: 0 })),
    ).toThrow(FrankContextError)
  })
})

describe('frame encoder', () => {
  it('rejects out-of-range envelope fields and oversize bodies', () => {
    const e =
      (
        o: Partial<{
          typeId: number
          schemaVersion: number
          minReaderVersion: number
        }>,
      ) =>
      () =>
        encodeFrame(
          { typeId: 1, schemaVersion: 1, minReaderVersion: 1, ...o },
          0,
        )
    expect(e({ typeId: -1 })).toThrow(RangeError)
    expect(e({ typeId: 4294967296 })).toThrow(RangeError)
    expect(e({ schemaVersion: 0 })).toThrow(RangeError)
    expect(e({ minReaderVersion: 0 })).toThrow(RangeError)
    expect(e({ schemaVersion: 1, minReaderVersion: 2 })).toThrow(RangeError)
    expect(e({ typeId: 1.5 })).toThrow(RangeError)
    expect(() => wrapFrame(new Uint8Array(8_388_609))).toThrow(RangeError)
    expect(() => wrapFrame(new Uint8Array(1), 256)).toThrow(RangeError)
  })

  it('encodes the envelope canonically regardless of how fields are supplied', () => {
    const a = encodeFrame(
      { typeId: 17, schemaVersion: 1, minReaderVersion: 1 },
      M([[0, 'hi']]),
    )
    const b = encodeFrame(
      { minReaderVersion: 1, schemaVersion: 1, typeId: 17 },
      new Map([[0, 'hi']]),
    )
    expect(a).toEqual(b)
    // An already-encoded payload (for exact retention) is embedded verbatim.
    const c = encodeFrame(
      { typeId: 17, schemaVersion: 1, minReaderVersion: 1 },
      { bytes: hex('a100626869') },
    )
    expect(c).toEqual(a)
    void NET
    void acct1
    void containerItem
    void type5Frame
  })
})
