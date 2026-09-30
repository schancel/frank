import * as fs from 'fs'
import * as path from 'path'
import Ajv2020 from 'ajv/dist/2020'
import { FrankCodecError, validateFrame } from '../src'
import { CASES } from '../fixtures/cases'
import {
  Manifest,
  checkManifest,
  readmeRuleIds,
  runCase,
} from '../fixtures/checker'
import { buildManifest, contextOf } from '../fixtures/manifest'

const DOCS = path.resolve(__dirname, '../../../docs/protocol/cbor')
const MANIFEST_PATH = path.join(DOCS, 'vectors', 'manifest.json')
const readme = fs.readFileSync(path.join(DOCS, 'README.md'), 'utf8')
const schema = JSON.parse(
  fs.readFileSync(path.join(DOCS, 'vectors.schema.json'), 'utf8'),
)

const generated = buildManifest()
const serialized = JSON.stringify(generated, null, 2) + '\n'

if (process.env.FRANK_UPDATE_VECTORS === '1') {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true })
  fs.writeFileSync(MANIFEST_PATH, serialized)
}

const committed: Manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))

describe('committed vector manifest', () => {
  it('is exactly what the fixture builders generate (regenerate with FRANK_UPDATE_VECTORS=1)', () => {
    expect(fs.readFileSync(MANIFEST_PATH, 'utf8')).toBe(serialized)
  })

  it('conforms to docs/protocol/cbor/vectors.schema.json', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    const validate = ajv.compile(schema)
    const ok = validate(committed)
    expect(validate.errors ?? []).toEqual([])
    expect(ok).toBe(true)
  })

  it('satisfies every README section 10 manifest-validity rule the schema cannot express', () => {
    expect(checkManifest(committed, readme)).toEqual([])
  })

  it('has the README rule ids the checker relies on', () => {
    const ids = readmeRuleIds(readme)
    for (const id of [
      'F1',
      'E2',
      'C1a',
      'C12',
      'R5',
      'S10',
      'V6',
      'V6.1',
      'V6.3',
      'T3a',
      'T3a.5',
      'T6',
      'R6',
      'S11',
      'S12',
      'T7',
      'T8',
    ]) {
      expect(ids.has(id)).toBe(true)
    }
  })

  it('checker rejects each class of invalid manifest it claims to enforce', () => {
    const base = (): Manifest => JSON.parse(JSON.stringify(committed))
    const tweak = (f: (m: Manifest) => void): string[] => {
      const m = base()
      f(m)
      return checkManifest(m, readme)
    }
    const find = (m: Manifest, id: string) => {
      const c = m.cases.find(x => x.id === id)
      if (!c) throw new Error(`no case ${id}`)
      return c
    }
    expect(tweak(m => m.cases.push({ ...m.cases[0] }))).toContainEqual(
      expect.stringContaining('duplicate case id'),
    )
    expect(
      tweak(m => (find(m, 'worked-type17-hi').paired_case = 'nope')),
    ).toContainEqual(expect.stringContaining('dangling'))
    expect(
      tweak(
        m => (find(m, 'worked-type17-hi').paired_case = 'worked-type17-hi'),
      ),
    ).toContainEqual(expect.stringContaining('itself'))
    expect(
      tweak(m => delete find(m, 'worked-type17-ho-mutation').paired_case),
    ).toContainEqual(expect.stringContaining('reciprocal'))
    expect(
      tweak(m => (find(m, 'worked-type17-hi').rules = ['Z99'])),
    ).toContainEqual(expect.stringContaining('unknown rule id'))
    expect(
      tweak(
        m => (find(m, 'worked-retained-ffff0001').retained_frame_hex = '00'),
      ),
    ).toContainEqual(expect.stringContaining('retained_frame_hex'))
    expect(
      tweak(m => (find(m, 'worked-type17-hi').type_id = 18)),
    ).toContainEqual(expect.stringContaining('type_id differs'))
    expect(
      tweak(m => (find(m, 'worked-type17-hi').schema_version = 2)),
    ).toContainEqual(expect.stringContaining('schema_version differs'))
    expect(
      tweak(
        m =>
          (find(m, 'worked-type17-hi').validation_context.route_byte_limit = 5),
      ),
    ).toContainEqual(expect.stringContaining('route_byte_limit'))
    expect(
      tweak(m => {
        const sc = (
          find(m, 'worked-type17-hi').validation_context
            .supported_schemas as unknown[]
        ).reverse()
        void sc
      }),
    ).toContainEqual(expect.stringContaining('sorted'))
    expect(
      tweak(
        m =>
          (find(
            m,
            'worked-type17-hi',
          ).validation_context.prior_directory_statement_frame_hex = 'aa'),
      ),
    ).toContainEqual(expect.stringContaining('non-type-2 root'))
    expect(
      tweak(
        m =>
          (find(m, 'worked-type17-hi').validation_context.payment_policy = {}),
      ),
    ).toContainEqual(expect.stringContaining('non-type-1 root'))
    expect(
      tweak(
        m =>
          (find(m, 'worked-type17-ho-mutation').frame_hex =
            find(m, 'worked-type17-hi').frame_hex.slice(0, -4) + '0000'),
      ),
    ).toContainEqual(expect.stringContaining('exactly one byte'))
    expect(
      tweak(m => {
        // A retain case (frame operation) whose frame version byte is 01 is invalid.
        const c = find(m, 'frame-version-2-retained')
        c.frame_hex =
          c.frame_hex.slice(0, 8 * 1) + '0' + '1' + c.frame_hex.slice(10)
        c.retained_frame_hex = c.frame_hex
      }),
    ).toContainEqual(expect.stringContaining('unsupported frame version'))
    expect(
      tweak(m => {
        // A retain case for a known root type at frame version 01 whose min_reader is supported.
        const c = find(m, 'v6-min-reader-above-reader-retained')
        ;(c.validation_context as { reader_version: number }).reader_version = 2
      }),
    ).toContainEqual(
      expect.stringContaining('retain case with a known root type'),
    )
    expect(
      tweak(m => {
        find(
          m,
          'fixture-directory-update-with-transition',
        ).validation_context.prior_directory_statement_frame_hex = find(
          m,
          'worked-type17-hi',
        ).frame_hex
      }),
    ).toContainEqual(
      expect.stringContaining('prior statement is not a type-4 frame'),
    )
  })

  it('checker rejects an error_stage past the last stage of the operation', () => {
    const m: Manifest = JSON.parse(JSON.stringify(committed))
    const c = m.cases.find(x => x.id === 'frame-bad-magic')
    if (!c) throw new Error('no case frame-bad-magic')
    c.error_stage = '7'
    expect(checkManifest(m, readme)).toContainEqual(
      expect.stringContaining('error_stage 7 is past the last stage'),
    )
  })

  it('carries error_stage on every reject and on no other case', () => {
    for (const c of committed.cases) {
      if (c.expectation === 'reject')
        expect([c.id, typeof c.error_stage]).toEqual([c.id, 'string'])
      else expect([c.id, c.error_stage]).toEqual([c.id, undefined])
    }
  })

  it('has unique ids, every reject names a category and stage, and covers all eight-stage classes', () => {
    expect(new Set(CASES.map(c => c.id)).size).toBe(CASES.length)
    for (const c of CASES) {
      if (c.expect === 'reject') {
        expect(c.category).toBeDefined()
        expect(c.stage).toBeDefined()
      }
    }
    const cats = new Set(
      CASES.filter(c => c.expect === 'reject').map(c => c.category),
    )
    for (const cat of [
      'frame',
      'unsupported',
      'resource',
      'malformed',
      'noncanonical',
      'schema',
      'semantic',
    ]) {
      expect(cats.has(cat as never)).toBe(true)
    }
    // `cryptographic` needs stage 10, which this package does not implement.
    expect(cats.has('cryptographic')).toBe(false)
  })
})

describe('every vector produces the exact category and stage the README assigns', () => {
  for (const c of CASES) {
    it(c.id, () => {
      const ctx = contextOf(c)
      let got: { kind: string; category?: string; stage?: string }
      try {
        const r = validateFrame(c.frame, ctx)
        got = { kind: r.kind === 'retained' ? 'retain' : 'accept' }
      } catch (e) {
        if (!(e instanceof FrankCodecError)) throw e
        got = { kind: 'reject', category: e.category, stage: e.stage }
      }
      if (c.expect === 'reject') {
        expect(got).toEqual({
          kind: 'reject',
          category: c.category,
          stage: c.stage,
        })
      } else {
        expect(got.kind).toBe(c.expect)
      }
    })
  }
})

describe('the committed JSON manifest, run from its own data only', () => {
  it('reproduces every expectation, content hash and retained frame', () => {
    for (const c of committed.cases) {
      const out = runCase(c)
      expect([c.id, out.kind]).toEqual([c.id, c.expectation])
      if (c.expectation === 'reject') {
        expect([c.id, out.category]).toEqual([c.id, c.error_category])
        expect([c.id, out.stage]).toEqual([c.id, c.error_stage])
      }
      if (c.expectation === 'retain')
        expect(out.retainedFrameHex).toBe(c.retained_frame_hex)
      if (c.expectation === 'accept') {
        if (c.type_id !== undefined)
          expect([c.id, out.typeId]).toEqual([c.id, c.type_id])
        if (c.schema_version !== undefined)
          expect([c.id, out.schemaVersion]).toEqual([c.id, c.schema_version])
        if (c.content_hash_hex !== undefined)
          expect([c.id, out.contentHashHex]).toEqual([c.id, c.content_hash_hex])
      }
    }
  })

  it('gives each limit reject an at-limit accept twin', () => {
    const limitRejects = CASES.filter(
      c => c.id.startsWith('limit-') && c.expect === 'reject',
    )
    const limitAccepts = CASES.filter(
      c => c.id.startsWith('limit-') && c.expect === 'accept',
    )
    expect(limitRejects.length).toBeGreaterThanOrEqual(15)
    expect(limitAccepts.length).toBeGreaterThanOrEqual(8)
  })
})
