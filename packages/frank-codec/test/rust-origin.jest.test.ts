import * as fs from 'fs'
import * as path from 'path'
import Ajv2020 from 'ajv/dist/2020'
import { decodeCanonical, encodeCanonical } from '../src/cbor'
import { fromHex } from '../src/hash'
import { validateFrame } from '../src/validate'
import {
  checkManifest,
  contextFromManifest,
  runCase,
} from '../fixtures/checker'

const DOCS = path.resolve(__dirname, '../../../docs/protocol/cbor')
const rustOrigin = JSON.parse(
  fs.readFileSync(path.join(DOCS, 'vectors', 'rust-origin.json'), 'utf8'),
)
const schema = JSON.parse(
  fs.readFileSync(path.join(DOCS, 'vectors.schema.json'), 'utf8'),
)
const readme = fs.readFileSync(path.join(DOCS, 'README.md'), 'utf8')

describe('rust-originated proof fixtures', () => {
  it('conforms to the vector schema and the manifest-validity rules', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    const validate = ajv.compile(schema)
    expect(validate(rustOrigin)).toBe(true)
    expect(validate.errors ?? []).toEqual([])
    expect(checkManifest(rustOrigin, readme)).toEqual([])
    expect(rustOrigin.cases.map((c: { id: string }) => c.id)).toEqual([
      'rust-fixture-direct-message',
      'rust-fixture-directory-attestation',
      'rust-fixture-checkpoint',
    ])
    for (const c of rustOrigin.cases) expect(c.source).toBe('rust')
  })

  it('accepts each fixture and re-encodes its body and payload byte-identically', () => {
    for (const c of rustOrigin.cases) {
      const out = runCase(c)
      expect([c.id, out.kind, out.contentHashHex]).toEqual([
        c.id,
        'accept',
        c.content_hash_hex,
      ])
      const frame = fromHex(c.frame_hex)
      const body = frame.subarray(9)
      expect(encodeCanonical(decodeCanonical(body))).toEqual(body)
      const parsed = validateFrame(frame, contextFromManifest(c))
      if (parsed.kind !== 'parsed') throw new Error(`${c.id} was not parsed`)
      expect(encodeCanonical(decodeCanonical(parsed.payloadBytes))).toEqual(
        parsed.payloadBytes,
      )
      expect(parsed.frame).toEqual(frame)
    }
  })
})
