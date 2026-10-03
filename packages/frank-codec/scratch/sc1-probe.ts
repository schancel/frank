/* SC-1 probe: feed a schema-3 type-4 statement (with field 9) to default contexts. */
import * as fs from 'fs'
import {
  contentHash,
  defaultContext,
  toHex,
  validateFrame,
} from '../src'

const CORPUS = JSON.parse(
  fs.readFileSync(
    '/Users/shammah/repos/frank/.worktrees/verify-582-scm1/docs/protocol/cbor/vectors/account-registration.json',
    'utf8',
  ),
) as {
  cases: Array<{
    id: string
    frame_hex: string
    validation_context: Record<string, unknown>
  }>
}
const caseById = new Map(CORPUS.cases.map(c => [c.id, c]))
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'))

const c = caseById.get('reg-fixture-testnet-statement-typed')!
const att = validateFrame(fromHex(c.frame_hex), defaultContext({
  operation: 'typed',
  supportedSchemas: (c.validation_context.supported_schemas as Array<{type_id:number;schema_version:number}>).map(s => ({ typeId: s.type_id, schemaVersion: s.schema_version })),
}) as never) as never as {
  kind: string
  typed?: { statementFrame?: { frame: Uint8Array } }
}
if (att.kind !== 'parsed' || !att.typed?.statementFrame) throw new Error('no statement frame')
const t4 = att.typed.statementFrame.frame
fs.writeFileSync('/var/folders/j3/nh8wltcx7l58w2gw1ycc_ryr0000gn/T/opencode/t4-schema3.hex', toHex(t4))

// The type-4 statement as a ROOT under the TS default context.
const r = validateFrame(t4, defaultContext())
console.log('TS defaultContext root outcome:', r.kind)
if (r.kind === 'parsed') {
  console.log('  typeId', r.typeId, 'schemaVersion', r.schemaVersion)
  const st = r.typed as unknown as {
    type: number
    schemaVersion: number
    projection?: string
    profileEntries?: unknown[]
    unknownFields?: Map<bigint, unknown>
  }
  console.log('  typed.type', st.type, 'st.schemaVersion', st.schemaVersion)
  console.log('  statement projection', st.projection)
  console.log('  profileEntries', st.profileEntries === undefined ? 'UNDEFINED' : JSON.stringify(st.profileEntries))
  console.log('  unknownFields keys', st.unknownFields ? [...st.unknownFields.keys()] : 'none')
  console.log('  contentHash', toHex(contentHash(r)))
}
// For contrast: same frame under a schema-2 type-4 reader (what Rust's default claims).
const r2 = validateFrame(t4, defaultContext({
  supportedSchemas: defaultContext().supportedSchemas.map(s =>
    s.typeId === 4 ? { typeId: 4, schemaVersion: 2 } : s,
  ),
}))
console.log('TS schema-2-type-4 root outcome:', r2.kind)
if (r2.kind === 'parsed') {
  const st = r2.typed as unknown as {
    projection?: string
    profileEntries?: unknown[]
    unknownFields?: Map<bigint, unknown>
  }
  console.log('  statement projection', st.projection)
  console.log('  profileEntries', st.profileEntries === undefined ? 'UNDEFINED' : JSON.stringify(st.profileEntries))
  console.log('  unknownFields keys', st.unknownFields ? [...st.unknownFields.keys()] : 'none')
}