// The #131 "BCS falsification check". The additive unknown-field/variant outcomes below were
// RECORDED by running the experiments (see bcs-falsification.result.json), not assumed: the
// test regenerates them and compares against the committed record.
import * as fs from 'fs'
import * as path from 'path'
import { defaultContext, toHex, validateFrame } from '../src'
import type { ParsedFrame } from '../src'
import { toBcs } from '../fixtures/bcs'
import { BcsReader, BcsWriter } from '../fixtures/mini-bcs'
import {
  acct2,
  attestationFrame,
  checkpointFrame,
  deliveryFrame,
  sig,
  statementFrame,
  rev8Frame,
} from '../fixtures/builders'

const RESULT_PATH = path.resolve(__dirname, '../bcs-falsification.result.json')
const parse = (f: Uint8Array): ParsedFrame => {
  const r = validateFrame(
    f,
    defaultContext({ priorDirectoryStatementFrame: null }),
  )
  if (r.kind !== 'parsed') throw new Error('parsed frame expected')
  return r
}

// ---- The reference struct used to pin the mini encoder to @mysten/bcs 2.1.2 --------------------
const acct = (n: number) => ({
  keyType: 2,
  keyBytes: Uint8Array.from({ length: 32 }, (_, i) => n + i),
})
const relay = (n: number) => ({
  id: Uint8Array.from({ length: 16 }, (_, i) => n + i),
  endpoint: `https://r${n}.example/`,
  identity: acct(n + 9),
  expiry: { seconds: 1700000000n, nanos: 123456789 },
})
type Acct = ReturnType<typeof acct>
type Relay = ReturnType<typeof relay>

const wAcct = (w: BcsWriter, a: Acct) => w.u16(a.keyType).bytes(a.keyBytes)
const wTs = (w: BcsWriter, t: Relay['expiry']) => w.u64(t.seconds).u32(t.nanos)
const wRelayV1 = (w: BcsWriter, r: Relay) => {
  w.bytes(r.id).string(r.endpoint)
  wAcct(w, r.identity)
  wTs(w, r.expiry)
}

function statementV1(extra: {
  topNote?: string
  relayWeight?: number
  relayExtWrapper?: boolean
}): Uint8Array {
  const w = new BcsWriter()
  w.string('frank-test')
  wAcct(w, acct(1))
  w.u64(18446744073709551615n)
  wTs(w, { seconds: 1700000000n, nanos: 123456789 })
  const relays = [relay(1), relay(2)]
  w.uleb(relays.length)
  for (const r of relays) {
    wRelayV1(w, r)
    if (extra.relayWeight !== undefined) w.u8(extra.relayWeight) // v2: new nested field
    // "Opaque wrapper" design: every relay ends in a length-prefixed extension blob from v1 on.
    if (extra.relayExtWrapper) w.bytes(new Uint8Array(0))
  }
  if (extra.topNote !== undefined) w.string(extra.topNote) // v2: new top-level field
  return w.toBytes()
}

/** A v1 reader for the statement struct above; `wrapper` selects the extension-blob layout. */
function readStatementV1(
  bytes: Uint8Array,
  opts: { strict: boolean; wrapper?: boolean },
) {
  const r = new BcsReader(bytes)
  const network = r.string()
  const keyType = r.u16()
  r.bytes()
  const revision = r.u64()
  r.u64()
  r.u32()
  const n = r.uleb()
  const endpoints: string[] = []
  for (let i = 0; i < n; i++) {
    r.bytes()
    endpoints.push(r.string())
    r.u16()
    r.bytes()
    r.u64()
    r.u32()
    if (opts.wrapper) r.bytes() // known extension blob: skipped without interpretation
  }
  if (opts.strict && r.remaining !== 0) {
    throw new RangeError(
      `${r.remaining} trailing bytes a v1 reader cannot interpret`,
    )
  }
  return { network, keyType, revision, endpoints, trailing: r.remaining }
}

function attempt<T>(f: () => T): string {
  try {
    const v = f() as unknown
    return `accepted: ${JSON.stringify(v, (_, x) =>
      typeof x === 'bigint' ? x.toString() : x,
    )}`
  } catch (e) {
    return `error: ${(e as Error).message}`
  }
}

describe('BCS falsification check (#131)', () => {
  it('mini BCS encoder reproduces @mysten/bcs 2.1.2 for the reference struct', () => {
    const ref = fs
      .readFileSync(
        path.resolve(__dirname, '../fixtures/bcs-reference-v1.hex'),
        'utf8',
      )
      .trim()
    expect(toHex(statementV1({}))).toBe(ref)
  })

  it('encodes the three fixture families in BCS and round-trips the reference struct', () => {
    const r = readStatementV1(statementV1({}), { strict: true })
    expect(r.endpoints).toEqual(['https://r1.example/', 'https://r2.example/'])
    expect(r.revision).toBe(18446744073709551615n)
  })

  it('records the additive unknown-field / unknown-variant outcomes', () => {
    const topAppended = statementV1({ topNote: 'extra' })
    const nestedAppended = statementV1({ relayWeight: 7 })

    // Fixture families as BCS (the type-1 payload nests type 5, whose ciphertext is the CBOR-free
    // BCS-less proof bytes; sizes are reported next to the CBOR frames).
    const fixtures = {
      directMessage: deliveryFrame(),
      directory: attestationFrame(
        statementFrame({ revision: 18446744073709551615n }),
        [sig(acct2(1))],
      ),
      checkpoint: checkpointFrame(),
      decryptedRevisionWithUnknownItem: rev8Frame(),
    }
    const sizes: Record<string, { cborFrameBytes: number; bcsBytes: number }> =
      {}
    for (const [k, f] of Object.entries(fixtures)) {
      sizes[k] = { cborFrameBytes: f.length, bcsBytes: toBcs(parse(f)).length }
    }

    // E3: a v2 writer adds enum variant Image (index 3) to a message-item enum. A v1 reader knows
    // variants 0=Text, 1=Container, 2=Opaque.
    const itemsV2 = new BcsWriter().uleb(3)
    itemsV2.uleb(0).string('a')
    itemsV2.uleb(3).u32(640).u32(480) // new variant Image { w, h }
    itemsV2.uleb(0).string('b')
    const readItemsV1 = (b: Uint8Array) => {
      const r = new BcsReader(b)
      const out: string[] = []
      const n = r.uleb()
      for (let i = 0; i < n; i++) {
        const v = r.uleb()
        if (v === 0) out.push(r.string())
        else
          throw new RangeError(
            `unknown enum variant ${v}: no length to skip it`,
          )
      }
      return out
    }

    const result = {
      note: 'Recorded by test/bcs-falsification.jest.test.ts; regenerate with FRANK_UPDATE_BCS_RESULT=1.',
      library: '@mysten/bcs 2.1.2 (reference bytes only; not a dependency)',
      encodedFixtureSizes: sizes,
      sizeCaveat:
        'The type-5 ciphertext field carries the type-6 frame verbatim in both encodings (suite 65535), and BCS drops the four-byte-per-field key/map framing; sizes are informational only.',
      noSignedIntegers:
        'BCS defines no i64; timestamps.seconds (i64) had to be carried as a two-complement u64 by convention. @mysten/bcs 2.1.2 exposes no i64 constructor.',
      e1_additive_field_appended_to_top_level_struct: {
        strictV1Reader: attempt(() =>
          readStatementV1(topAppended, { strict: true }),
        ),
        lenientV1Reader: attempt(() =>
          readStatementV1(topAppended, { strict: false }),
        ),
        interpretation:
          'Only a struct-final field can be ignored, and only by a lenient reader that stops early; the added field is not delimited, so it cannot be retained as a field.',
      },
      e2_additive_field_in_struct_inside_a_vector: {
        strictV1Reader: attempt(() =>
          readStatementV1(nestedAppended, { strict: true }),
        ),
        lenientV1Reader: attempt(() =>
          readStatementV1(nestedAppended, { strict: false }),
        ),
        interpretation:
          'The added byte shifts every following element: without a per-element length the v1 reader cannot skip it.',
      },
      e3_additive_enum_variant: {
        v1Reader: attempt(() => readItemsV1(itemsV2.toBytes())),
        interpretation:
          'An unknown variant index has no length, so the reader cannot skip or retain it or the items after it.',
      },
      e4_unknown_message_item_type: {
        interpretation:
          'A v1 BCS schema can carry a future item type only through an explicit Opaque { type_id, bytes } variant; the fixtures needed one (enum variant 2), i.e. an opaque wrapper.',
        // Variant index 2 (Opaque) followed by the little-endian u32 type id 0xffff0001.
        opaqueVariantPresentInFixtureBytes: toHex(
          toBcs(parse(rev8Frame())),
        ).includes('020100ffff'),
      },
      e5_opaque_wrapper_designed_in_from_v1: {
        v2WriterWithWrapperV1Reader: attempt(() =>
          readStatementV1(statementV1({ relayExtWrapper: true }), {
            strict: true,
            wrapper: true,
          }),
        ),
        interpretation:
          'Additive evolution works in BCS only when every extensible struct carries a length-prefixed extension blob from the start, which is the opaque-wrapper pattern the CBOR profile gets from integer-keyed maps.',
      },
      scope:
        "Outcomes above were produced by running the experiments with the mini BCS reader/writer on these fixtures only. Interpretations are the author's reading of those outcomes, not a general claim about every BCS schema discipline.",
    }

    const serialized = JSON.stringify(result, null, 2) + '\n'
    if (process.env.FRANK_UPDATE_BCS_RESULT === '1')
      fs.writeFileSync(RESULT_PATH, serialized)
    expect(fs.readFileSync(RESULT_PATH, 'utf8')).toBe(serialized)
  })
})
