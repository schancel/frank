// Manifest checker and runner. The checker enforces the "MUST enforce" list of README section
// 10 that JSON Schema cannot express; a violation is an invalid manifest, not a case outcome.
import { FrankCodecError } from '../src/errors'
import { contentHash, fromHex, toHex } from '../src/hash'
import {
  KNOWN_TYPES,
  ValidationContext,
  defaultContext,
  validateFrame,
} from '../src/validate'
import type { ManifestCase } from './manifest'

export interface Manifest {
  format: string
  cases: ManifestCase[]
}

type Ctx = {
  operation: 'frame' | 'generic' | 'typed' | 'full'
  route_byte_limit: number
  reader_version: number
  supported_schemas: Array<{ type_id: number; schema_version: number }>
  opaque_retention_allowed: boolean
  payment_policy?: unknown
  decrypted_frame_hex?: string | null
  prior_directory_statement_frame_hex?: string | null
}

/** Numbered rule identifiers defined by the README (F1, C1a, S2b, ...) plus sub-rules it cites. */
export function readmeRuleIds(readme: string): Set<string> {
  const ids = new Set<string>()
  for (const m of readme.matchAll(/^([A-Z]\d+[a-z]?)\. /gm)) ids.add(m[1])
  // Sub-rules such as V6.1 or T3a.5 are valid when the README names them literally.
  for (const m of readme.matchAll(/\b([A-Z]\d+[a-z]?\.\d+)\b/g)) {
    if (ids.has(m[1].split('.')[0])) ids.add(m[1])
  }
  return ids
}

export function contextFromManifest(c: ManifestCase): ValidationContext {
  const v = c.validation_context as unknown as Ctx
  if (v.operation === 'full')
    throw new Error('stage 10 (full) is not implemented by this codec')
  return defaultContext({
    operation: v.operation,
    routeByteLimit: v.route_byte_limit,
    readerVersion: v.reader_version,
    supportedSchemas: v.supported_schemas.map(s => ({
      typeId: s.type_id,
      schemaVersion: s.schema_version,
    })),
    opaqueRetentionAllowed: v.opaque_retention_allowed,
    priorDirectoryStatementFrame:
      v.prior_directory_statement_frame_hex == null
        ? null
        : fromHex(v.prior_directory_statement_frame_hex),
  })
}

/** Returns the list of manifest-validity violations (empty when the manifest is valid). */
export function checkManifest(m: Manifest, readme: string): string[] {
  const errs: string[] = []
  const rules = readmeRuleIds(readme)
  const byId = new Map<string, ManifestCase>()
  for (const c of m.cases) {
    if (byId.has(c.id)) errs.push(`duplicate case id ${c.id}`)
    byId.set(c.id, c)
  }
  for (const c of m.cases) {
    const at = (msg: string) => errs.push(`${c.id}: ${msg}`)
    const v = c.validation_context as unknown as Ctx
    const frame = fromHex(c.frame_hex)
    for (const r of c.rules) if (!rules.has(r)) at(`unknown rule id ${r}`)
    // supported_schemas sorted by type_id with unique ids
    for (let i = 1; i < v.supported_schemas.length; i++) {
      if (
        v.supported_schemas[i - 1].type_id >= v.supported_schemas[i].type_id
      ) {
        at('supported_schemas not strictly sorted by type_id')
      }
    }
    if (
      c.retained_frame_hex !== undefined &&
      c.retained_frame_hex !== c.frame_hex
    ) {
      at('retained_frame_hex differs from frame_hex')
    }
    if (v.route_byte_limit < frame.length && c.error_category !== 'resource') {
      at(
        'route_byte_limit below the frame length without a resource expectation',
      )
    }
    if (c.error_stage !== undefined) {
      // The operation selects the final stage (README section 10): frame 4, generic 7, typed 9.
      const last = { frame: 4, generic: 7, typed: 9, full: 10 }[v.operation]
      if (Number(c.error_stage.split('.')[0]) > last)
        at(
          `error_stage ${c.error_stage} is past the last stage of ${v.operation}`,
        )
    }
    // Envelope type/version of the frame, when readable.
    let envType: number | undefined
    let envSchema: number | undefined
    let envMinReader: number | undefined
    try {
      const r = validateFrame(
        frame,
        defaultContext({ operation: 'generic', opaqueRetentionAllowed: true }),
      )
      if (
        r.kind === 'parsed' ||
        (r.kind === 'retained' && r.typeId !== undefined)
      ) {
        envType = r.typeId
        envSchema = r.schemaVersion
        envMinReader = r.minReaderVersion
      }
    } catch (e) {
      if (!(e instanceof FrankCodecError)) throw e
    }
    if (c.expectation === 'accept') {
      if (c.type_id !== undefined && c.type_id !== envType)
        at('accept type_id differs from the envelope')
      if (c.schema_version !== undefined && c.schema_version !== envSchema) {
        at('accept schema_version differs from the envelope')
      }
    }
    // Context nullness rules.
    const nonNull = (x: unknown) => x !== null && x !== undefined
    if (envType !== 1 && nonNull(v.payment_policy))
      at('payment_policy for a non-type-1 root')
    if (envType !== 1 && nonNull(v.decrypted_frame_hex))
      at('decrypted_frame_hex for a non-type-1 root')
    if (envType !== 2 && nonNull(v.prior_directory_statement_frame_hex)) {
      at('prior_directory_statement_frame_hex for a non-type-2 root')
    }
    if (
      c.expectation === 'retain' &&
      v.operation === 'frame' &&
      frame.length > 4 &&
      frame[4] === 1
    ) {
      at(
        'a frame-operation retain case must have an unsupported frame version byte',
      )
    }
    if (
      c.expectation === 'retain' &&
      envType !== undefined &&
      KNOWN_TYPES.includes(envType) &&
      envMinReader !== undefined &&
      envMinReader <= v.reader_version &&
      frame.length > 4 &&
      frame[4] === 1 &&
      v.supported_schemas.some(s => s.type_id === envType)
    ) {
      at(
        'a retain case with a known root type, supported min_reader_version and frame version 01',
      )
    }
    // pairing
    if (c.paired_case !== undefined) {
      const other = byId.get(c.paired_case)
      if (!other) at(`dangling paired_case ${c.paired_case}`)
      else if (other.id === c.id) at('paired_case names itself')
      else {
        if (other.paired_case !== c.id) at('paired_case is not reciprocal')
        if (other.pair_relation !== c.pair_relation)
          at('pair_relation differs between the pair')
        checkPair(c, other, at)
      }
    }
    // A typed/full prior statement must be a valid type-4 frame accepted by validation.
    const prior = v.prior_directory_statement_frame_hex
    if (prior) {
      try {
        const r = validateFrame(fromHex(prior), defaultContext())
        if (r.kind !== 'parsed' || r.typeId !== 4)
          at('prior statement is not a type-4 frame')
      } catch (e) {
        if (e instanceof FrankCodecError)
          at(`prior statement is invalid: ${e.message}`)
        else throw e
      }
    }
  }
  return errs
}

function checkPair(
  c: ManifestCase,
  other: ManifestCase,
  at: (m: string) => void,
): void {
  const a = fromHex(c.frame_hex)
  const b = fromHex(other.frame_hex)
  if (c.pair_relation === 'one_byte_mutation') {
    if (a.length !== b.length)
      at('one_byte_mutation pair has different lengths')
    else if (a.filter((x, i) => x !== b[i]).length !== 1) {
      at('one_byte_mutation pair does not differ in exactly one byte')
    }
  } else if (c.pair_relation === 'insertion_order_equivalent') {
    if (c.frame_hex !== other.frame_hex)
      at('insertion_order_equivalent pair has different frames')
  } else if (c.pair_relation === 'opaque_retention') {
    if (c.frame_hex !== other.frame_hex)
      at('opaque_retention pair has different bytes')
  }
}

export interface Outcome {
  kind: 'accept' | 'reject' | 'retain'
  category?: string
  stage?: string
  typeId?: number
  schemaVersion?: number
  contentHashHex?: string
  retainedFrameHex?: string
}

/** Runs one manifest case and reports what the codec did. */
export function runCase(c: ManifestCase): Outcome {
  const ctx = contextFromManifest(c)
  try {
    const r = validateFrame(fromHex(c.frame_hex), ctx)
    if (r.kind === 'retained')
      return { kind: 'retain', retainedFrameHex: toHex(r.frame) }
    if (r.kind === 'frame') return { kind: 'accept' }
    const out: Outcome = {
      kind: 'accept',
      typeId: r.typeId,
      schemaVersion: r.schemaVersion,
    }
    if (ctx.operation === 'typed') out.contentHashHex = toHex(contentHash(r))
    return out
  } catch (e) {
    if (e instanceof FrankCodecError)
      return { kind: 'reject', category: e.category, stage: e.stage }
    throw e
  }
}
