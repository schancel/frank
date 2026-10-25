import {
  FrankCodecError,
  I64_MAX,
  I64_MIN,
  U64_MAX,
  commonTranscript,
  contentHash,
  contentHashNetwork,
  defaultContext,
  messageContentDigest,
  paymentCommitment,
  toHex,
  validateFrame,
} from '../src'
import type { ChildFrame, ParsedFrame, RetainedFrame } from '../src'
import {
  M,
  NET,
  UNKNOWN_TYPE,
  WORKED_TEXT_HI,
  acct2,
  attestationFrame,
  bytesOf,
  checkpointFrame,
  containerItem,
  deliveryFrame,
  fact,
  fr,
  rev8Frame,
  section,
  sig,
  statementFrame,
  statementPayload,
  textItem,
  type5Frame,
  type6Frame,
  unknownItem,
  body,
  ts,
} from '../fixtures/builders'
import {
  DIRECTORY_STATEMENT,
  MESSAGE_CONTENT_REVISION,
  TEXT_MESSAGE_ITEM,
  TYPE_CONTAINER_MESSAGE_ITEM,
  TYPE_DIRECTORY_ATTESTATION,
  TYPE_DIRECTORY_STATEMENT,
  TYPE_DIRECT_MESSAGE_DELIVERY,
  TYPE_ENCRYPTED_MESSAGE_CONTENT,
  TYPE_MAILBOX_CHECKPOINT,
  TYPE_MESSAGE_CONTENT_REVISION,
  TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
  TYPE_TEXT_MESSAGE_ITEM,
} from '../src/constants'

const parse = (f: Uint8Array, o = {}): ParsedFrame => {
  const r = validateFrame(f, defaultContext(o))
  if (r.kind !== 'parsed') throw new Error(`expected parsed, got ${r.kind}`)
  return r
}
const asParsed = (c: ChildFrame): ParsedFrame => {
  if (c.kind !== 'parsed') throw new Error('expected a parsed child')
  return c
}
const asRetained = (c: ChildFrame): RetainedFrame => {
  if (c.kind !== 'retained') throw new Error('expected a retained child')
  return c
}

describe('typed conversion and exact-byte retention', () => {
  it('keeps declared u64 and i64 values as bigint at their boundaries', () => {
    const stmt = statementFrame({ revision: U64_MAX })
    const p = parse(attestationFrame(stmt, [sig(acct2(1))]), {
      priorDirectoryStatementFrame: null,
    })
    const t = p.typed
    if (t?.type !== TYPE_DIRECTORY_ATTESTATION)
      throw new Error('type 2 expected')
    const st = asParsed(t.statementFrame).typed
    if (st?.type !== TYPE_DIRECTORY_STATEMENT)
      throw new Error('type 1 expected')
    expect(st.revision).toBe(18446744073709551615n)
    expect(typeof st.revision).toBe('bigint')
    expect(typeof st.timestamp.seconds).toBe('bigint')

    for (const seconds of [I64_MIN, I64_MAX, 0n, -1n]) {
      const f = fr(
        TYPE_DIRECTORY_STATEMENT,
        new Map([
          ...statementPayload(),
          [DIRECTORY_STATEMENT.timestamp, ts(seconds, 999_999_999)],
        ]),
      )
      const q = parse(f, { priorDirectoryStatementFrame: null }).typed
      if (q?.type !== TYPE_DIRECTORY_STATEMENT)
        throw new Error('type 1 expected')
      expect(q.timestamp.seconds).toBe(seconds)
      expect(q.timestamp.nanoseconds).toBe(999_999_999)
    }
    // One outside the i64 range is a schema error at 8.2, one below u64 zero likewise.
    for (const bad of [I64_MAX + 1n, I64_MIN - 1n]) {
      const f = fr(
        TYPE_DIRECTORY_STATEMENT,
        new Map([
          ...statementPayload(),
          [DIRECTORY_STATEMENT.timestamp, ts(bad, 0)],
        ]),
      )
      expect(() => parse(f)).toThrow(/i64/)
    }
    expect(() =>
      parse(
        fr(
          TYPE_DIRECTORY_STATEMENT,
          new Map([
            ...statementPayload(),
            [DIRECTORY_STATEMENT.revision, U64_MAX + 1n],
          ]),
        ),
      ),
    ).toThrow(RangeError)
  })

  it('exposes the exact original frame bytes at every level, unchanged by later input mutation', () => {
    const input = deliveryFrame()
    const original = input.slice()
    const p = parse(input)
    expect(p.frame).toEqual(original)
    input.fill(0) // caller mutates its buffer after parsing
    expect(p.frame).toEqual(original)
    const t = p.typed
    if (t?.type !== TYPE_DIRECT_MESSAGE_DELIVERY)
      throw new Error('type 10 expected')
    const child = asParsed(t.payloadFrame)
    // The child's bytes are exactly the byte string carried in field 2 of the parent.
    expect(child.frame).toEqual(type5Frame())
    expect(toHex(original)).toContain(toHex(child.frame))
    expect(child.typeId).toBe(TYPE_RECIPIENT_ENCRYPTED_PAYLOAD)
  })

  it('opens the recursive message-item graph and retains unknown children byte for byte', () => {
    const unknown = unknownItem(1)
    const inner = containerItem([textItem('two levels down')])
    const middle = containerItem([textItem('nested text'), unknown, inner])
    const rev = rev8Frame([textItem('hello'), middle])
    const p = parse(type6Frame(rev))
    const t6 = p.typed
    if (t6?.type !== TYPE_ENCRYPTED_MESSAGE_CONTENT)
      throw new Error('type 12 expected')
    const r8 = asParsed(t6.revisionFrame)
    expect(r8.frame).toEqual(rev)
    const t8 = r8.typed
    if (t8?.type !== TYPE_MESSAGE_CONTENT_REVISION)
      throw new Error('type 20 expected')
    expect(t8.items).toHaveLength(2)
    const c16 = asParsed(t8.items[1])
    expect(c16.frame).toEqual(middle)
    const t16 = c16.typed
    if (t16?.type !== TYPE_CONTAINER_MESSAGE_ITEM)
      throw new Error('type 21 expected')
    const kept = asRetained(t16.items[1])
    expect(kept.reason).toBe('unknown-type')
    expect(kept.typeId).toBe(UNKNOWN_TYPE)
    expect(kept.frame).toEqual(unknown)
    const deep = asParsed(t16.items[2]).typed
    if (deep?.type !== TYPE_CONTAINER_MESSAGE_ITEM)
      throw new Error('type 21 expected')
    expect(asParsed(deep.items[0]).typed).toMatchObject({
      type: TYPE_TEXT_MESSAGE_ITEM,
      text: 'two levels down',
    })
  })

  it('retains an unknown frame version child without reading its length field', () => {
    const weird = body('ffff', 9) // version 9, nonsense after
    const p = parse(
      fr(
        TYPE_MESSAGE_CONTENT_REVISION,
        M([
          [MESSAGE_CONTENT_REVISION.network, 'frank'],
          [MESSAGE_CONTENT_REVISION.items, [textItem(), weird]],
        ]),
      ),
    )
    const t = p.typed
    if (t?.type !== TYPE_MESSAGE_CONTENT_REVISION)
      throw new Error('type 20 expected')
    const kept = asRetained(t.items[1])
    expect(kept.reason).toBe('unsupported-frame-version')
    expect(kept.frame).toEqual(weird)
    expect(kept.typeId).toBeUndefined()
  })

  it('retains opaque checkpoint bytes and sections exactly and never opens them', () => {
    const unknownInFact = unknownItem(2)
    const unknownInSection = unknownItem(3)
    const cp = checkpointFrame({
      facts: [fact(10, 0, 1, bytesOf(5, 1)), fact(10, 5, 2, unknownInFact)],
      sections: [
        section(1, 1, bytesOf(4, 4)),
        section(0x7fff0001, 9, unknownInSection),
      ],
    })
    const p = parse(cp)
    const t = p.typed
    if (t?.type !== TYPE_MAILBOX_CHECKPOINT) throw new Error('type 14 expected')
    expect(t.facts[1].payload).toEqual(unknownInFact)
    expect(t.sections?.[1].value).toEqual(unknownInSection)
    expect(t.sections?.[1].sectionType).toBe(0x7fff0001)
    expect(p.frame).toEqual(cp)
  })

  it('retains unknown fields of a newer compatible schema and the original frame (V6.3)', () => {
    const f = fr(
      TYPE_TEXT_MESSAGE_ITEM,
      M([
        [TEXT_MESSAGE_ITEM.text, 'x'],
        // raw-cbor-key: keys 5 and 9 are undeclared: unknown fields of a newer schema
        [5, new Uint8Array([1, 2])],
        // raw-cbor-key: keys 5 and 9 are undeclared: unknown fields of a newer schema
        [9, M([[1, 'y']])],
      ]),
      3,
      1,
    )
    const p = parse(f)
    expect(p.projection).toBe('newer-schema')
    expect(p.schemaVersion).toBe(3)
    const t = p.typed
    if (t?.type !== TYPE_TEXT_MESSAGE_ITEM) throw new Error('type 22 expected')
    expect(t.text).toBe('x')
    // raw-cbor-key: keys 5 and 9 are undeclared: unknown fields of a newer schema
    expect([...t.unknownFields.keys()]).toEqual([5n, 9n])
    expect(p.frame).toEqual(f)
    // An exactly supported schema has no unknown fields.
    expect(parse(WORKED_TEXT_HI).projection).toBe('exact')
  })

  it('returns no partial typed object when a later child fails', () => {
    const bad = fr(
      TYPE_MESSAGE_CONTENT_REVISION,
      M([
        [MESSAGE_CONTENT_REVISION.network, 'frank'],
        [
          MESSAGE_CONTENT_REVISION.items,
          [
            textItem(),
            fr(TYPE_TEXT_MESSAGE_ITEM, M([[TEXT_MESSAGE_ITEM.text, 5]])),
          ],
        ],
      ]),
    )
    let result: unknown
    try {
      result = validateFrame(bad, defaultContext())
    } catch (e) {
      expect(e).toBeInstanceOf(FrankCodecError)
      expect((e as FrankCodecError).stage).toBe('8.2')
      expect((e as FrankCodecError).location).toContain('[1]')
    }
    expect(result).toBeUndefined()
  })
})

describe('T1/T1a content hashes and one-byte mutation', () => {
  it('matches an independently computed T1 known answer for the worked frame', () => {
    // Computed with Python hashlib over the section 8 transcript, not with this codec.
    const p = parse(WORKED_TEXT_HI)
    expect(toHex(contentHash(p))).toBe(
      '128985c9a648dd9bdf280e4e6513db8616d1e7c94dc546cb17b342864b45de91',
    )
    expect(
      toHex(commonTranscript('frank/content-hash/v1', 'frank', WORKED_TEXT_HI)),
    ).toBe(
      '00156672616e6b2f636f6e74656e742d686173682f763100056672616e6b0000001746524e4b010000000ea40016010102010345a100626869',
    )
  })

  it('matches an independently computed T4 known answer', () => {
    expect(toHex(paymentCommitment(new Uint8Array(32), 1))).toBe(
      '3dcaf20957605225ae2d865d32ac3753cf303cd028393cec43c193aad4f4f4f6',
    )
  })

  it('selects the T1 network as the README table says', () => {
    expect(contentHashNetwork(parse(WORKED_TEXT_HI))).toBe('frank')
    expect(contentHashNetwork(parse(rev8Frame()))).toBe('frank')
    expect(contentHashNetwork(parse(containerItem([textItem()])))).toBe('frank')
    expect(contentHashNetwork(parse(type5Frame()))).toBe(NET)
    const stmt = statementFrame({ net: 'other-net' })
    const att = parse(attestationFrame(stmt, [sig(acct2(1))]), {
      priorDirectoryStatementFrame: null,
    })
    expect(contentHashNetwork(att)).toBe('other-net')
    const generic = validateFrame(
      type5Frame(),
      defaultContext({ operation: 'generic' }),
    )
    expect(() => contentHash(generic as ParsedFrame)).toThrow(
      /typed projection/,
    )
  })

  it('computes T1a over the type-20 frame with the literal network', () => {
    const rev = rev8Frame()
    expect(toHex(messageContentDigest(rev))).toBe(
      toHex(
        contentHashFor(
          commonTranscript('frank/message-content/v1', 'frank', rev),
        ),
      ),
    )
    // T1 and T1a differ by domain even for the same frame.
    expect(toHex(messageContentDigest(rev))).not.toBe(
      toHex(contentHash(parse(rev))),
    )
  })

  it('changes the content hash, or fails validation, for every one-byte mutation', () => {
    const fixtures: Array<[string, Uint8Array, object]> = [
      ['worked', WORKED_TEXT_HI, {}],
      ['direct message', deliveryFrame(), {}],
      ['checkpoint', checkpointFrame(), {}],
      [
        'attestation',
        attestationFrame(statementFrame({ revision: U64_MAX }), [
          sig(acct2(1)),
        ]),
        { priorDirectoryStatementFrame: null },
      ],
    ]
    let mutantsParsed = 0
    let mutantsRejected = 0
    for (const [name, frame, ctx] of fixtures) {
      const baseline = toHex(contentHash(parse(frame, ctx)))
      for (let i = 0; i < frame.length; i++) {
        const m = frame.slice()
        m[i] ^= 0x01
        let r
        try {
          r = validateFrame(
            m,
            defaultContext({ ...ctx, opaqueRetentionAllowed: true }),
          )
        } catch (e) {
          if (!(e instanceof FrankCodecError)) throw e
          mutantsRejected++
          continue
        }
        if (r.kind !== 'parsed') {
          mutantsRejected++
          continue
        }
        mutantsParsed++
        expect([name, i, toHex(contentHash(r)) === baseline]).toEqual([
          name,
          i,
          false,
        ])
      }
    }
    expect(mutantsParsed).toBeGreaterThan(50)
    expect(mutantsRejected).toBeGreaterThan(50)
  })

  it('binds the signature set only into the type-2 hash, not the statement hash (README section 6)', () => {
    const stmt = statementFrame()
    const one = parse(attestationFrame(stmt, [sig(acct2(1))]), {
      priorDirectoryStatementFrame: null,
    })
    const two = parse(attestationFrame(stmt, [sig(acct2(1)), sig(acct2(2))]), {
      priorDirectoryStatementFrame: null,
    })
    expect(toHex(contentHash(one))).not.toBe(toHex(contentHash(two)))
    const child = (p: ParsedFrame) => {
      const t = p.typed
      if (t?.type !== TYPE_DIRECTORY_ATTESTATION)
        throw new Error('type 2 expected')
      return asParsed(t.statementFrame)
    }
    expect(toHex(contentHash(child(one)))).toBe(toHex(contentHash(child(two))))
  })
})

function contentHashFor(transcript: Uint8Array): Uint8Array {
  // Independent route to SHA-256 for the T1a assertion: hash the transcript through the same
  // primitive the library uses, but not through messageContentDigest.
  const { sha256 } = jest.requireActual('@noble/hashes/sha256') as {
    sha256: (b: Uint8Array) => Uint8Array
  }
  return sha256(transcript)
}
