// At-limit accepts and one-over rejects for the limits too large for the committed manifest.
import {
  FrankCodecError,
  MAX_FRAME_BYTES,
  contentHash,
  defaultContext,
  validateFrame,
} from '../src'
import type { Encodable, ParsedFrame } from '../src'
import {
  M,
  NET,
  T3C,
  acct1,
  acct2,
  attestationFrame,
  bytesOf,
  concatBytes,
  deliveryPayload,
  fact,
  fr,
  framePayload,
  hex,
  section,
  sig,
  statementPayload,
  type5Payload,
} from '../fixtures/builders'

function outcome(f: Uint8Array, ctx = {}): string {
  try {
    return validateFrame(f, defaultContext(ctx)).kind
  } catch (e) {
    if (!(e instanceof FrankCodecError)) throw e
    return `${e.category}@${e.stage}`
  }
}

const generic = { operation: 'generic' as const, opaqueRetentionAllowed: true }

describe('global limits', () => {
  it('accepts a frame of exactly MAX_FRAME_BYTES and rejects one byte more at stage 1', () => {
    // envelope (17 bytes) + payload byte-string item (5-byte head) filling 8 MiB exactly.
    const dataLen = 8_388_608 - 22
    const payload = concatBytes(
      hex('5a'),
      Uint8Array.of(0, 0, 0, 0),
      new Uint8Array(dataLen),
    )
    new DataView(payload.buffer).setUint32(1, dataLen)
    const f = framePayload(payload, 0xffff0001)
    expect(f.length).toBe(MAX_FRAME_BYTES)
    expect(outcome(f, generic)).toBe('retained')
    expect(outcome(concatBytes(f, Uint8Array.of(0)), generic)).toBe(
      'resource@1',
    )
  })

  it('counts every item, keys included, against MAX_ITEMS = 131,072 in one operation', () => {
    // Envelope map + 4 keys + 4 values = 9 items; the payload array is 1, 16 inner arrays are 16.
    const payloadWithScalars = (scalars: number): Uint8Array => {
      const arrays = 16
      const first = 8192
      let left = scalars
      const bodies: Uint8Array[] = []
      for (let i = 0; i < arrays; i++) {
        const n = Math.min(first, left)
        left -= n
        bodies.push(
          concatBytes(Uint8Array.of(0x99, n >> 8, n & 255), new Uint8Array(n)),
        )
      }
      expect(left).toBe(0)
      return concatBytes(Uint8Array.of(0x80 | arrays), ...bodies)
    }
    const atLimit = 131_072 - 9 - 1 - 16
    expect(
      outcome(framePayload(payloadWithScalars(atLimit), 0xffff0001), generic),
    ).toBe('retained')
    expect(
      outcome(
        framePayload(payloadWithScalars(atLimit + 1), 0xffff0001),
        generic,
      ),
    ).toBe('resource@7')
  })

  it('charges each tag head as an item (R1): more than 131,072 tags is resource, not schema', () => {
    // 9 envelope items + N tag heads + 1 wrapped uint. At the limit every tag is still a forbidden
    // class (schema, pass B); one more item is resource in pass A.
    const tags = (n: number): Uint8Array =>
      concatBytes(new Uint8Array(n).fill(0xc1), Uint8Array.of(0x00))
    const atLimit = 131_072 - 9 - 1
    expect(outcome(framePayload(tags(atLimit), 0xffff0001), generic)).toBe(
      'schema@7',
    )
    expect(outcome(framePayload(tags(atLimit + 1), 0xffff0001), generic)).toBe(
      'resource@7',
    )
  })

  it('does not count indefinite-string chunks as items but caps their aggregate length', () => {
    const chunked = (chunk: number, n: number, extra = 0): Uint8Array => {
      const head = Uint8Array.of(
        0x7a,
        (chunk >>> 24) & 255,
        (chunk >>> 16) & 255,
        (chunk >>> 8) & 255,
        chunk & 255,
      )
      const parts: Uint8Array[] = [Uint8Array.of(0x7f)]
      for (let i = 0; i < n; i++)
        parts.push(head, new Uint8Array(chunk).fill(0x61))
      if (extra)
        parts.push(
          Uint8Array.of(0x60 + extra),
          new Uint8Array(extra).fill(0x61),
        )
      parts.push(Uint8Array.of(0xff))
      return concatBytes(...parts)
    }
    // 140,000 one-byte chunks would exceed MAX_ITEMS if chunks were items.
    const many = new Uint8Array(140_000 * 2 + 2)
    many[0] = 0x7f
    for (let i = 0; i < 140_000; i++) {
      many[1 + 2 * i] = 0x61
      many[2 + 2 * i] = 0x61
    }
    many[many.length - 1] = 0xff
    expect(outcome(framePayload(many, 0xffff0001), generic)).toBe(
      'noncanonical@7',
    )
    // Four 64 KiB chunks total exactly 262,144 bytes; one more byte exceeds the text limit.
    expect(outcome(framePayload(chunked(65_536, 4), 0xffff0001), generic)).toBe(
      'noncanonical@7',
    )
    expect(
      outcome(framePayload(chunked(65_536, 4, 1), 0xffff0001), generic),
    ).toBe('resource@7')
  })

  it('counts map keys as items (R1): 256-entry maps cost 513 items each', () => {
    const map256 = (): Uint8Array => {
      const parts: number[] = [0xb9, 1, 0]
      for (let k = 0; k < 256; k++) {
        if (k < 24) parts.push(k)
        else parts.push(0x18, k)
        parts.push(0)
      }
      return Uint8Array.from(parts)
    }
    // 255 maps of 256 entries = 255 * 513 = 130,815 items, plus 9 envelope items and 1 array.
    const arrays = (n: number): Uint8Array => {
      const head =
        n < 256 ? Uint8Array.of(0x98, n) : Uint8Array.of(0x99, n >> 8, n & 255)
      const m = map256()
      return concatBytes(head, ...Array.from({ length: n }, () => m))
    }
    expect(outcome(framePayload(arrays(255), 0xffff0001), generic)).toBe(
      'retained',
    )
    expect(outcome(framePayload(arrays(256), 0xffff0001), generic)).toBe(
      'resource@7',
    )
  })

  it('accepts a 262,144-byte text and rejects 262,145 as resource, not malformed', () => {
    const ok = fr(17, M([[0, 'a'.repeat(262_144)]]))
    const t = (validateFrame(ok, defaultContext()) as ParsedFrame).typed
    expect(t).toMatchObject({ type: 17 })
    expect(outcome(fr(17, M([[0, 'a'.repeat(262_145)]])))).toBe('resource@7')
    // Text size counts UTF-8 bytes, not characters.
    expect(outcome(fr(17, M([[0, '€'.repeat(87_381)]])))).toBe('parsed') // 262,143 bytes
    expect(outcome(fr(17, M([[0, '€'.repeat(87_382)]])))).toBe('resource@7') // 262,146 bytes
  })
})

describe('type-specific limits (R2-R4)', () => {
  it('bounds the ciphertext at 524,288 bytes (resource at 8.1)', () => {
    const p = (n: number) =>
      fr(5, new Map([...type5Payload(), [5, new Uint8Array(n)]]))
    expect(outcome(p(524_288))).toBe('parsed')
    expect(outcome(p(524_289))).toBe('resource@8.1')
  })

  it('classifies schema-1 nonce length before applying schema-2 envelope limits', () => {
    const legacy = new Map(type5Payload())
    legacy.set(4, new Uint8Array(524_377))
    expect(outcome(fr(5, legacy, 1, 1))).toBe('schema@8.2')

    const production = new Map<number, Encodable>([
      [0, NET],
      [1, acct2(9)],
      [2, acct1(3)],
      [3, 1],
      [4, new Uint8Array(524_377)],
      [5, T3C.ephemeral],
      [6, T3C.shared],
      [7, T3C.proof],
    ])
    expect(outcome(fr(5, production, 2, 2))).toBe('resource@8.1')
  })

  /** A newer type-1 root projected through schema 1 with one padding field. */
  const paddedDelivery = (pad: number): Uint8Array => {
    const payload = deliveryPayload({ payments: 2 })
    payload.set(7, new Uint8Array(pad))
    return fr(1, payload, 2, 1)
  }

  it('bounds a type-1 frame at 1 MiB (R2) using the root frame length', () => {
    // Find the pad making the delivery exactly 1,048,576 bytes; length grows 1:1 with the pad.
    let pad = 1_040_000
    pad += 1_048_576 - paddedDelivery(pad).length
    const exact = paddedDelivery(pad)
    expect(exact.length).toBe(1_048_576)
    expect(outcome(exact)).toBe('parsed')
    const over = paddedDelivery(pad + 1)
    expect(over.length).toBe(1_048_577)
    expect(outcome(over)).toBe('resource@8.1')
  })

  it('bounds a type-2 frame at 256 KiB (R3)', () => {
    const stmt = (pad: number) =>
      fr(
        4,
        new Map<number, Encodable>([
          ...statementPayload(),
          [9, new Uint8Array(pad)],
        ]),
        3,
        1,
      )
    const att = (pad: number) => attestationFrame(stmt(pad), [sig(acct2(1))])
    let pad = 260_000
    pad += 262_144 - att(pad).length
    // A reader whose highest type-4 schema is 2 keeps the byte-string pad as a retained
    // V6.3 field-9 value; a schema-3 reader would type it and reject the shape.
    const opts = {
      priorDirectoryStatementFrame: null as Uint8Array | null,
      supportedSchemas: defaultContext().supportedSchemas.map(s =>
        s.typeId === 4 ? { ...s, schemaVersion: 2 } : s,
      ),
    }
    expect(att(pad).length).toBe(262_144)
    expect(outcome(att(pad), opts)).toBe('parsed')
    expect(att(pad + 1).length).toBe(262_145)
    expect(outcome(att(pad + 1), opts)).toBe('resource@8.1')
  })

  it('lets a maximal checkpoint (4,096 facts + 4,096 sections) fit one counter (R1 rationale)', () => {
    const facts = Array.from({ length: 4096 }, (_, i) =>
      fact(1_000_000 + i, 0, 0),
    )
    // fact ids must be unique: derive from the index.
    const withIds = facts.map((f, i) => {
      const id = new Uint8Array(16)
      new DataView(id.buffer).setUint32(12, i)
      return new Map(f).set(1, id)
    })
    const sections = Array.from({ length: 4096 }, (_, i) =>
      section(i, 1, new Uint8Array(0)),
    )
    const cp = fr(
      3,
      M([
        [0, NET],
        [1, acct1(5)],
        [2, bytesOf(16, 77)],
        [
          3,
          M([
            [0, 1],
            [1, 0],
          ]),
        ],
        [4, withIds],
        [5, sections],
      ]),
    )
    const r = validateFrame(
      cp,
      defaultContext({ priorDirectoryStatementFrame: null }),
    )
    expect(r.kind).toBe('parsed')
    expect(contentHash(r as ParsedFrame)).toHaveLength(32)
    const t = (r as ParsedFrame).typed
    if (t?.type !== 3) throw new Error('type 3 expected')
    expect(t.facts).toHaveLength(4096)
    expect(t.sections).toHaveLength(4096)
    // One more fact is a resource error at 8.1.
    const over = fr(3, M([[4, Array.from({ length: 4097 }, () => M([]))]]))
    expect(outcome(over)).toBe('resource@8.1')
  })
})
