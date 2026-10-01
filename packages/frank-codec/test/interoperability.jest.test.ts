import * as fs from 'fs'
import * as path from 'path'
import {
  defaultContext,
  encodeFrame,
  fromHex,
  toHex,
  validateFrame,
} from '../src'
import { type5Payload, unknownItem } from '../fixtures/builders'
import { contextFromManifest, runCase } from '../fixtures/checker'
import type { Manifest } from '../fixtures/checker'
import {
  InteroperabilityFixture,
  cryptoObservation,
  exactFrameObservation,
} from '../fixtures/interoperability'
import type { ManifestCase } from '../fixtures/manifest'

const VECTORS = path.resolve(__dirname, '../../../docs/protocol/cbor/vectors')
const manifest = JSON.parse(
  fs.readFileSync(path.join(VECTORS, 'manifest.json'), 'utf8'),
) as Manifest
const rustOrigin = JSON.parse(
  fs.readFileSync(path.join(VECTORS, 'rust-origin.json'), 'utf8'),
) as Manifest
const interoperability = JSON.parse(
  fs.readFileSync(path.join(VECTORS, 'interoperability.json'), 'utf8'),
) as InteroperabilityFixture

const byId = (m: Manifest, id: string): ManifestCase => {
  const c = m.cases.find(candidate => candidate.id === id)
  if (!c) throw new Error(`missing case ${id}`)
  return c
}

describe('complete-frame TypeScript/Rust interoperability', () => {
  it('reproduces the three TypeScript-origin families after the Rust round trip', () => {
    expect(interoperability.typescript_origin_ids).toEqual([
      'fixture-direct-message-typed',
      'fixture-directory-attestation-typed',
      'fixture-checkpoint-typed',
    ])
    for (const id of interoperability.typescript_origin_ids) {
      const c = byId(manifest, id)
      const observed = exactFrameObservation(c)
      expect([id, observed.outcome.kind]).toEqual([id, 'accept'])
      expect(observed.frameHex).toBe(c.frame_hex)
      expect(observed.bodyCanonical).toBe(true)
      expect(observed.payloadCanonical).toBe(true)
    }
    expect(interoperability.typescript_retention_ids).toEqual([
      'v6-newer-schema-extra-field',
      'fixture-revision8-typed',
      'fixture-checkpoint-typed',
    ])
    for (const id of interoperability.typescript_retention_ids) {
      const c = byId(manifest, id)
      expect(exactFrameObservation(c).frameHex).toBe(c.frame_hex)
    }
    expect(
      exactFrameObservation(
        byId(manifest, interoperability.typescript_retention_ids[0]),
      ).payloadFieldKeys,
    ).toContain(1n)
    for (const id of interoperability.typescript_retention_ids.slice(1)) {
      expect(byId(manifest, id).frame_hex).toContain('1affff0001')
    }
  })

  it('reproduces Rust-origin families and preserves additive and nested opaque data', () => {
    expect(interoperability.rust_origin_ids).toEqual([
      'rust-fixture-direct-message',
      'rust-fixture-directory-attestation',
      'rust-fixture-checkpoint',
    ])
    const expected = [
      [1, 'rust-additive-direct'],
      [2, 'rust-additive-directory'],
      [3, 'rust-additive-checkpoint'],
    ] as const
    for (const [index, id] of interoperability.rust_origin_ids.entries()) {
      const c = byId(rustOrigin, id)
      const observed = exactFrameObservation(c)
      expect([id, observed.outcome.kind]).toEqual([id, 'accept'])
      expect(observed.frameHex).toBe(c.frame_hex)
      expect(observed.bodyCanonical).toBe(true)
      expect(observed.payloadCanonical).toBe(true)
      expect(observed.payloadFieldKeys).toContain(100n)
      const parsed = validateFrame(fromHex(c.frame_hex), contextFromManifest(c))
      expect(parsed.kind).toBe('parsed')
      if (parsed.kind !== 'parsed') throw new Error(`${id} was not parsed`)
      expect(parsed.projection).toBe('newer-schema')
      expect(parsed.typed?.type).toBe(expected[index][0])
      expect(parsed.typed?.unknownFields.get(100n)).toBe(expected[index][1])
      if (parsed.typed?.type === 1) assertDirectNestedOpaque(parsed.typed)
      if (parsed.typed?.type === 3) {
        expect(parsed.typed.facts[1].payload).toEqual(unknownItem(2))
        expect(parsed.typed.sections?.[1].value).toEqual(unknownItem(3))
      }
    }
  })

  it('replays the complete hostile corpus with exact category and stage', () => {
    const categories: Record<string, number> = {}
    let rejects = 0
    for (const c of manifest.cases) {
      const outcome = runCase(c)
      expect([c.id, outcome.kind]).toEqual([c.id, c.expectation])
      if (c.expectation === 'reject') {
        rejects++
        expect([c.id, outcome.category]).toEqual([c.id, c.error_category])
        expect([c.id, outcome.stage]).toEqual([c.id, c.error_stage])
        categories[c.error_category as string] =
          (categories[c.error_category as string] ?? 0) + 1
      }
    }
    expect({
      case_count: manifest.cases.length,
      reject_count: rejects,
      reject_category_counts: categories,
    }).toEqual(interoperability.hostile_manifest)
  })

  it('converges independent source insertion orders on the complete frame', () => {
    const forward = type5Payload()
    const reverse = new Map([...forward.entries()].reverse())
    const fields = { typeId: 5, schemaVersion: 1, minReaderVersion: 1 }
    expect(toHex(encodeFrame(fields, reverse))).toBe(
      toHex(encodeFrame(fields, forward)),
    )
    expect(toHex(encodeFrame(fields, reverse))).toBe(
      interoperability.crypto.frame_hex,
    )
  })

  it('matches T1/T1a/T3/T4 and binds a fixed signature/payment fixture to one byte', () => {
    const c = interoperability.crypto
    const observed = cryptoObservation(c)
    expect(observed.differenceOffsets).toEqual([c.mutation_offset])
    expect(observed).toEqual({
      differenceOffsets: [c.mutation_offset],
      t1Hex: c.t1_hex,
      mutatedT1Hex: c.mutated_t1_hex,
      t1aHex: c.t1a_hex,
      t3Hex: c.t3_hex,
      mutatedT3Hex: c.mutated_t3_hex,
      t4Hex: c.t4_hex,
      mutatedT4Hex: c.mutated_t4_hex,
    })
    expect(c.t1_hex).not.toBe(c.mutated_t1_hex)
    expect(c.t3_hex).not.toBe(c.mutated_t3_hex)
    expect(c.t4_hex).not.toBe(c.mutated_t4_hex)
    expect(fromHex(c.signature_public_key_hex)).toHaveLength(33)
    expect(fromHex(c.signature_der_hex).length).toBeGreaterThanOrEqual(8)
  })
})

function assertDirectNestedOpaque(
  direct: Extract<
    NonNullable<
      Extract<ReturnType<typeof validateFrame>, { kind: 'parsed' }>['typed']
    >,
    { type: 1 }
  >,
): void {
  const recipient = direct.payloadFrame.typed
  expect(recipient?.type).toBe(5)
  if (recipient?.type !== 5) throw new Error('type-5 payload expected')
  const encrypted = validateFrame(recipient.ciphertext, defaultContext())
  expect(encrypted.kind).toBe('parsed')
  if (encrypted.kind !== 'parsed' || encrypted.typed?.type !== 6)
    throw new Error('type-6 ciphertext expected')
  const revision = encrypted.typed.revisionFrame.typed
  expect(revision?.type).toBe(8)
  if (revision?.type !== 8) throw new Error('type-8 revision expected')
  const container = revision.items[1]
  expect(container.kind).toBe('parsed')
  if (container.kind !== 'parsed' || container.typed?.type !== 16)
    throw new Error('type-16 container expected')
  const opaque = container.typed.items[1]
  expect(opaque.kind).toBe('retained')
  if (opaque.kind !== 'retained') throw new Error('retained item expected')
  expect(opaque.frame).toEqual(unknownItem(1))
}
