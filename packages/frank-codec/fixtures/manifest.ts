// Turns the case definitions into the manifest of docs/protocol/cbor/vectors.schema.json.
import { toHex, contentHash } from '../src/hash'
import {
  ValidationContext,
  defaultContext,
  validateFrame,
  KNOWN_TYPES,
} from '../src/validate'
import { CASES, CaseDef } from './cases'

export interface ManifestCase {
  id: string
  description: string
  source: string
  frame_hex: string
  validation_context: Record<string, unknown>
  expectation: string
  rules: string[]
  type_id?: number
  schema_version?: number
  content_hash_hex?: string
  retained_frame_hex?: string
  error_category?: string
  error_stage?: string
  paired_case?: string
  pair_relation?: string
}

export function contextOf(c: CaseDef): ValidationContext {
  return defaultContext({
    operation: c.op,
    routeByteLimit: c.routeByteLimit ?? 8_388_617,
    readerVersion: c.readerVersion ?? 1,
    supportedSchemas:
      c.supported ?? KNOWN_TYPES.map(typeId => ({ typeId, schemaVersion: 1 })),
    opaqueRetentionAllowed: c.retention ?? false,
    priorDirectoryStatementFrame: c.prior === undefined ? null : c.prior,
  })
}

export function manifestCase(c: CaseDef): ManifestCase {
  const ctx = contextOf(c)
  const validation_context: Record<string, unknown> = {
    operation: c.op,
    route_byte_limit: ctx.routeByteLimit,
    reader_version: ctx.readerVersion,
    supported_schemas: [...ctx.supportedSchemas]
      .sort((a, b) => a.typeId - b.typeId)
      .map(s => ({ type_id: s.typeId, schema_version: s.schemaVersion })),
    opaque_retention_allowed: ctx.opaqueRetentionAllowed,
  }
  if (c.op !== 'frame' && c.op !== 'generic') {
    validation_context.prior_directory_statement_frame_hex = c.prior
      ? toHex(c.prior)
      : null
  }
  const out: ManifestCase = {
    id: c.id,
    description: c.description,
    source: c.source,
    frame_hex: toHex(c.frame),
    validation_context,
    expectation: c.expect,
    rules: c.rules,
  }
  if (c.expect === 'reject') {
    out.error_category = c.category
    out.error_stage = c.stage
  }
  if (c.expect === 'retain') out.retained_frame_hex = toHex(c.frame)
  if (c.expect === 'accept') {
    const r = validateFrame(c.frame, ctx)
    if (r.kind === 'parsed') {
      out.type_id = r.typeId
      out.schema_version = r.schemaVersion
      if (c.op === 'typed') out.content_hash_hex = toHex(contentHash(r))
    }
  }
  if (c.paired) {
    out.paired_case = c.paired
    out.pair_relation = c.relation
  }
  return out
}

export function buildManifest(): { format: string; cases: ManifestCase[] } {
  return { format: 'frank-cbor-v1-vectors', cases: CASES.map(manifestCase) }
}
