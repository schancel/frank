// The positive fixtures and hostile-vector corpus as data. `manifest.ts` turns these into the
// JSON manifest of docs/protocol/cbor/vectors.schema.json; the tests also read the expected
// stage, which the manifest schema has no field for.
import { Encodable, encodeCanonical } from '../src/cbor'
import { ErrorCategory, ErrorStage } from '../src/errors'
import { SupportedSchema } from '../src/validate'
import {
  M,
  NET,
  UNKNOWN_TYPE,
  WORKED_RETAINED,
  WORKED_TEXT_HI,
  acct1,
  acct2,
  attestationFrame,
  body,
  bytesOf,
  checkpointFrame,
  checkpointPayload,
  concatBytes,
  containerItem,
  deliveryFrame,
  deliveryPayload,
  fact,
  fr,
  framePayload,
  hex,
  payment,
  recipientPayloadDigest,
  relay,
  rev8Frame,
  revision8,
  section,
  sig,
  statementFrame,
  statementPayload,
  textItem,
  transition,
  ts,
  transitionStatement,
  type5Frame,
  type5Payload,
  type6Frame,
  unknownItem,
  patchBytes,
  withField,
  withLength,
} from './builders'

export type PairRelation = 'one_byte_mutation' | 'insertion_order_equivalent'

export interface CaseDef {
  id: string
  description: string
  source: 'typescript' | 'handcrafted'
  frame: Uint8Array
  op: 'frame' | 'generic' | 'typed'
  expect: 'accept' | 'reject' | 'retain'
  category?: ErrorCategory
  /** The section 9 stage the README assigns; asserted by the tests. */
  stage?: ErrorStage
  rules: string[]
  routeByteLimit?: number
  readerVersion?: number
  supported?: SupportedSchema[]
  retention?: boolean
  /** Type-2 roots: the last accepted type-4 frame, or null for bootstrap. */
  prior?: Uint8Array | null
  paired?: string
  relation?: PairRelation
}

export const CASES: CaseDef[] = []

interface Opts {
  source?: 'typescript' | 'handcrafted'
  op?: 'frame' | 'generic' | 'typed'
  routeByteLimit?: number
  readerVersion?: number
  supported?: SupportedSchema[]
  retention?: boolean
  prior?: Uint8Array | null
  paired?: string
  relation?: PairRelation
}

function add(def: CaseDef): void {
  CASES.push(def)
}

/** A reject case. `stage` is the README section 9 stage. */
function rej(
  id: string,
  description: string,
  frame: Uint8Array,
  category: ErrorCategory,
  stage: ErrorStage,
  rules: string[],
  o: Opts = {},
): void {
  add({
    id,
    description,
    source: o.source ?? 'handcrafted',
    frame,
    op: o.op ?? 'typed',
    expect: 'reject',
    category,
    stage,
    rules,
    routeByteLimit: o.routeByteLimit,
    readerVersion: o.readerVersion,
    supported: o.supported,
    retention: o.retention,
    prior: o.prior,
    paired: o.paired,
    relation: o.relation,
  })
}

function acc(
  id: string,
  description: string,
  frame: Uint8Array,
  rules: string[],
  o: Opts = {},
): void {
  add({
    id,
    description,
    source: o.source ?? 'typescript',
    frame,
    op: o.op ?? 'typed',
    expect: 'accept',
    rules,
    routeByteLimit: o.routeByteLimit,
    readerVersion: o.readerVersion,
    supported: o.supported,
    retention: o.retention,
    prior: o.prior,
    paired: o.paired,
    relation: o.relation,
  })
}

function ret(
  id: string,
  description: string,
  frame: Uint8Array,
  rules: string[],
  o: Opts = {},
): void {
  add({
    id,
    description,
    source: o.source ?? 'handcrafted',
    frame,
    op: o.op ?? 'typed',
    expect: 'retain',
    rules,
    routeByteLimit: o.routeByteLimit,
    readerVersion: o.readerVersion,
    supported: o.supported,
    retention: true,
    prior: o.prior,
  })
}

const g = { op: 'generic' as const }
const fo = { op: 'frame' as const }

// Envelope bodies (no header) for the hand-written frame and envelope vectors.
const ENV_HI = 'a4 0011 0101 0201 0345 a100626869'
const withHeader = (h: string) => body(h)

// ---------------------------------------------------------------------------------------------
// Positive fixtures (README section 6 families) and the worked examples
// ---------------------------------------------------------------------------------------------

const hi = WORKED_TEXT_HI
const hiMutated = hi.slice()
hiMutated[hiMutated.length - 1] = 0x6f // "hi" -> "ho"

acc(
  'worked-type17-hi',
  'README section 1 worked example: type-17 text item {0: "hi"}, 23 bytes.',
  hi,
  ['F3', 'E1', 'T1'],
  {
    paired: 'worked-type17-ho-mutation',
    relation: 'one_byte_mutation',
  },
)
acc(
  'worked-type17-ho-mutation',
  'The worked example with its last byte changed ("hi" -> "ho"): still a valid frame, but a different T1 content hash (T6).',
  hiMutated,
  ['T6', 'T1'],
  { paired: 'worked-type17-hi', relation: 'one_byte_mutation' },
)
ret(
  'worked-retained-ffff0001',
  'README section 1 retention example: type 0xffff0001 in shortest form, payload a0, retained as the exact 23 frame bytes.',
  WORKED_RETAINED,
  ['E3', 'V4', 'V6.1'],
)
acc(
  'frame-only-accepts-worked-frame',
  'Stages 1-4 accept the worked frame.',
  hi,
  ['F1', 'F3'],
  fo,
)

const dmFrame = deliveryFrame()
acc(
  'fixture-direct-message-typed',
  'Fixture 1: type-1 delivery with two stamp payments, opening its type-5 payload by typed validation. Address bytes are placeholders (T3a is not implemented), so this is a typed case, not full.',
  dmFrame,
  ['S3', 'S8', 'S9', 'T3', 'T4'],
)
acc(
  'fixture-recipient-payload-typed',
  'A type-5 recipient-encrypted payload whose suite-65535 ciphertext is a complete type-6 frame.',
  type5Frame(),
  ['S2c', 'E3'],
)
acc(
  'fixture-decrypted-content-typed',
  'Type 6 decrypted content: opens the type-8 revision and its recursive message items (text, container with an unknown 0xffff0001 child and a nested container).',
  type6Frame(),
  ['S8', 'T1a', 'V6.1'],
)
acc(
  'fixture-revision8-typed',
  'Type 8 plaintext revision with a two-level nested item graph and an unknown child retained.',
  rev8Frame(),
  ['S8', 'V6.1'],
)

const stmtBase = statementFrame({
  revision: 18446744073709551615n,
  expiry: M([
    [0, 1_900_000_000],
    [1, 999_999_999],
  ]),
})
acc(
  'fixture-directory-attestation-typed',
  'Fixture 2: type-2 attestation of a type-4 statement with two relay bindings, u64::MAX revision, seconds+nanoseconds timestamps and one subject-signed Ed25519 entry (bootstrap). Signature bytes are structurally valid filler: no signature is verified.',
  attestationFrame(stmtBase, [sig(acct2(1))]),
  ['S4', 'S10', 'T1'],
  { prior: null },
)
acc(
  'fixture-directory-statement-typed',
  'The type-4 statement alone (u64::MAX revision).',
  stmtBase,
  ['S4', 'C7'],
  { prior: null },
)

const priorStmt = statementFrame()
const t7 = (o?: Parameters<typeof transitionStatement>[0]) =>
  transitionStatement(o)
const updStmt = (o: Parameters<typeof statementPayload>[0] = {}) =>
  fr(
    4,
    statementPayload({
      subject: acct2(2),
      revision: 6n,
      transitions: [transition(t7())],
      ...o,
    }),
  )
acc(
  'fixture-directory-update-with-transition',
  'A type-2 update that changes the subject A to B, with the one linked type-7 transition signed under prior authority A (S10).',
  attestationFrame(updStmt(), [sig(acct2(2))]),
  ['S10', 'S5', 'T2a'],
  { prior: priorStmt },
)
const priorWithRecovery = statementFrame({ authorities: [acct2(7)] })
acc(
  'fixture-directory-update-recovery-authority',
  'A subject change authorized by a registered offline recovery authority from the last accepted statement (S4a).',
  attestationFrame(
    updStmt({ transitions: [transition(t7({ prior: acct2(7) }), acct2(7))] }),
    [sig(acct2(2))],
  ),
  ['S4a', 'S10'],
  { prior: priorWithRecovery },
)

acc(
  'fixture-checkpoint-typed',
  'Fixture 3: type-3 checkpoint with two journal facts (one retaining an unknown nested 0xffff0001 item in its opaque payload) and two opaque sections including a future section kind. None of it is interpreted.',
  checkpointFrame(),
  ['S6', 'S7'],
  { prior: null },
)

// Insertion-order equivalence: the same statement built from two different Map insertion orders.
const forward = fr(4, statementPayload({ revision: 42n }))
const reversedPayload = statementPayload({ revision: 42n })
const reversed = new Map([...reversedPayload.entries()].reverse()) as Map<
  number,
  Encodable
>
acc(
  'insertion-order-forward',
  'Type-4 statement encoded from a Map filled in ascending key order.',
  forward,
  ['C1', 'C11'],
  {
    prior: null,
    paired: 'insertion-order-reversed',
    relation: 'insertion_order_equivalent',
  },
)
acc(
  'insertion-order-reversed',
  'The same statement encoded from a Map filled in descending key order: byte-identical.',
  fr(4, reversed),
  ['C1', 'C11'],
  {
    prior: null,
    paired: 'insertion-order-forward',
    relation: 'insertion_order_equivalent',
  },
)

// ---------------------------------------------------------------------------------------------
// Stage 1-4: frame
// ---------------------------------------------------------------------------------------------

rej(
  'frame-route-limit-exceeded',
  'A 23-byte frame against a route_byte_limit of 22: stage 1.',
  hi,
  'resource',
  '1',
  ['F4'],
  {
    ...fo,
    routeByteLimit: 22,
  },
)
rej(
  'frame-empty',
  'Zero bytes: fewer than nine header bytes.',
  new Uint8Array(0),
  'frame',
  '2',
  ['F1'],
  fo,
)
rej(
  'frame-short-header',
  'Eight bytes: a header cut one byte short.',
  hi.slice(0, 8),
  'frame',
  '2',
  ['F1'],
  fo,
)
const badMagic = hi.slice()
badMagic[3] = 0x4c // FRNL
rej(
  'frame-bad-magic',
  'Magic FRNL instead of FRNK.',
  badMagic,
  'frame',
  '2',
  ['F1'],
  fo,
)
const v2 = hi.slice()
v2[4] = 2
rej(
  'frame-version-2-rejected',
  'Frame version 2 where retention is not permitted.',
  v2,
  'unsupported',
  '3',
  ['F2'],
  fo,
)
ret(
  'frame-version-2-retained',
  'The same version-2 bytes where the boundary permits retention: kept whole, length field uninterpreted.',
  v2,
  ['F2', 'V4'],
  fo,
)
const v0 = hi.slice()
v0[4] = 0
rej(
  'frame-version-0-rejected',
  'Frame version 0.',
  v0,
  'unsupported',
  '3',
  ['F2'],
  fo,
)
rej(
  'frame-length-too-long',
  'Declared body length 15 but 14 bytes follow.',
  withLength(hi, 15),
  'frame',
  '4',
  ['F3'],
  fo,
)
rej(
  'frame-length-too-short',
  'Declared body length 13 but 14 bytes follow.',
  withLength(hi, 13),
  'frame',
  '4',
  ['F3'],
  fo,
)
rej(
  'frame-truncated',
  'The worked frame with its last byte removed.',
  hi.slice(0, hi.length - 1),
  'frame',
  '4',
  ['F3'],
  fo,
)
rej(
  'frame-concatenated',
  'Two complete frames back to back.',
  concatBytes(hi, hi),
  'frame',
  '4',
  ['F3'],
  fo,
)
rej(
  'frame-trailing-byte',
  'The worked frame followed by one byte.',
  concatBytes(hi, Uint8Array.of(0)),
  'frame',
  '4',
  ['F3'],
  fo,
)
rej(
  'frame-zero-length-with-body',
  'Declared length 0 with a 14-byte body present.',
  withLength(hi, 0),
  'frame',
  '4',
  ['F3'],
  fo,
)
rej(
  'frame-zero-length-body',
  'Declared length 0 and no body: stage 4 passes, the empty envelope is truncated CBOR (stage 5).',
  withHeader(''),
  'malformed',
  '5',
  ['F3', 'C9'],
  g,
)

// ---------------------------------------------------------------------------------------------
// Stage 5: envelope CBOR (pass A then pass B)
// ---------------------------------------------------------------------------------------------

rej(
  'env-pass-a-truncated',
  'README pass example `78 05 61`: truncated with a non-minimal header is malformed in pass A.',
  withHeader('780561'),
  'malformed',
  '5',
  ['C10'],
  g,
)
rej(
  'env-stray-break',
  'A lone break code as the envelope.',
  withHeader('ff'),
  'malformed',
  '5',
  ['C5'],
  g,
)
rej(
  'env-reserved-additional-info',
  'Reserved additional information 28.',
  withHeader('1c'),
  'malformed',
  '5',
  ['C5'],
  g,
)
rej(
  'env-trailing-item',
  'A valid envelope followed by an extra CBOR item.',
  withHeader(`${ENV_HI} 00`),
  'malformed',
  '5',
  ['C9'],
  g,
)
rej(
  'env-nonminimal-type-id',
  'type_id 17 encoded as 18 11 (non-minimal).',
  withHeader('a4 0018 11 0101 0201 0345 a100626869'),
  'noncanonical',
  '5',
  ['C2'],
  g,
)
rej(
  'env-nonminimal-map-count',
  'Envelope map count 4 encoded as b8 04.',
  withHeader('b804 0011 0101 0201 0345 a100626869'),
  'noncanonical',
  '5',
  ['C2'],
  g,
)
rej(
  'env-indefinite-map',
  'Indefinite-length envelope map.',
  withHeader('bf 0011 0101 0201 0345 a100626869 ff'),
  'noncanonical',
  '5',
  ['C3', 'C5'],
  g,
)
rej(
  'env-duplicate-key',
  'Envelope with key 0 twice.',
  withHeader('a4 0011 0011 0201 0345 a100626869'),
  'noncanonical',
  '5',
  ['C4'],
  g,
)
rej(
  'env-unsorted-keys',
  'Envelope keys 1 then 0.',
  withHeader('a4 0101 0011 0201 0345 a100626869'),
  'noncanonical',
  '5',
  ['C1', 'C4'],
  g,
)
rej(
  'env-float',
  'A half-precision float as the envelope.',
  withHeader('f93c00'),
  'schema',
  '5',
  ['C5'],
  g,
)
rej(
  'env-tag',
  'Tag 0 as the envelope.',
  withHeader('c0 00'),
  'schema',
  '5',
  ['C5'],
  g,
)
rej(
  'env-text-key',
  'Envelope map with a text key.',
  withHeader('a1 6161 01'),
  'schema',
  '5',
  ['C1a'],
  g,
)
rej(
  'env-byte-declared-oversize',
  'A byte string in the envelope declaring 8,388,609 bytes while truncated: resource wins because the header is checked first.',
  withHeader('a4 0011 0101 0201 03 5a00800001'),
  'resource',
  '5',
  ['R1', 'R5'],
  g,
)

// Stage 6
rej(
  'env-not-a-map',
  'The envelope is a valid CBOR item but not a map.',
  withHeader('01'),
  'schema',
  '6',
  ['E1'],
  g,
)
rej(
  'env-missing-key',
  'Envelope without min_reader_version.',
  withHeader('a3 0011 0101 0345 a100626869'),
  'schema',
  '6',
  ['E1'],
  g,
)
rej(
  'env-extra-key',
  'Envelope with a forbidden key 4.',
  withHeader(`a5 0011 0101 0201 0345 a100626869 0400`),
  'schema',
  '6',
  ['E1'],
  g,
)
rej(
  'env-type-id-out-of-range',
  'type_id 2^32.',
  withHeader('a4 001b0000000100000000 0101 0201 0345 a100626869'),
  'schema',
  '6',
  ['E1'],
  g,
)
rej(
  'env-schema-version-zero',
  'schema_version 0.',
  withHeader('a4 0011 0100 0201 0345 a100626869'),
  'schema',
  '6',
  ['E1'],
  g,
)
rej(
  'env-min-reader-above-schema',
  'min_reader_version 2 exceeds schema_version 1.',
  withHeader('a4 0011 0101 0202 0345 a100626869'),
  'schema',
  '6',
  ['E2'],
  g,
)
rej(
  'env-payload-not-bytes',
  'Envelope payload is an integer, not a byte string.',
  withHeader('a4 0011 0101 0201 0300'),
  'schema',
  '6',
  ['E1'],
  g,
)

// ---------------------------------------------------------------------------------------------
// Stage 7: payload CBOR (pass A then pass B) and resource limits
// ---------------------------------------------------------------------------------------------

const P = (payloadHex: string, typeId = 17) =>
  framePayload(hex(payloadHex), typeId)

rej(
  'payload-empty',
  'Zero-length payload item.',
  framePayload(new Uint8Array(0)),
  'malformed',
  '7',
  ['C9'],
  g,
)
rej(
  'payload-pass-a-truncated',
  'README pass example `78 05 61` as the payload.',
  P('780561'),
  'malformed',
  '7',
  ['C10'],
  g,
)
rej(
  'payload-truncated-text',
  'Payload map whose text value is cut short.',
  P('a1 00 62 68'),
  'malformed',
  '7',
  ['C9'],
  g,
)
rej(
  'payload-trailing-item',
  'Payload item followed by a second item.',
  P('a0 00'),
  'malformed',
  '7',
  ['C9'],
  g,
)
rej(
  'payload-stray-break',
  'A break code inside a definite array.',
  P('81 ff'),
  'malformed',
  '7',
  ['C5'],
  g,
)
rej(
  'payload-invalid-utf8-continuation',
  'Text with an invalid continuation byte (c3 28).',
  P('a1 00 62 c328'),
  'malformed',
  '7',
  ['C6'],
  g,
)
rej(
  'payload-invalid-utf8-overlong',
  'Text with an overlong encoding (c0 af).',
  P('a1 00 62 c0af'),
  'malformed',
  '7',
  ['C6'],
  g,
)
rej(
  'payload-invalid-utf8-surrogate',
  'Text encoding the surrogate U+D800 (ed a0 80).',
  P('a1 00 63 eda080'),
  'malformed',
  '7',
  ['C6'],
  g,
)
rej(
  'payload-invalid-utf8-above-max',
  'Text encoding U+110000 (f4 90 80 80).',
  P('a1 00 64 f4908080'),
  'malformed',
  '7',
  ['C6'],
  g,
)
rej(
  'payload-simple-below-32',
  'Two-byte simple value f8 10 is malformed.',
  P('a1 00 f810'),
  'malformed',
  '7',
  ['C2'],
  g,
)
rej(
  'payload-nonminimal-int',
  'Value 5 encoded as 18 05.',
  P('a1 00 1805'),
  'noncanonical',
  '7',
  ['C2'],
  g,
)
rej(
  'payload-nonminimal-text-length',
  'Two-byte text with length encoded as 78 02.',
  P('a1 00 78 02 6869'),
  'noncanonical',
  '7',
  ['C2'],
  g,
)
rej(
  'payload-nonminimal-map-count',
  'Map count 0 encoded as b8 00.',
  P('b800'),
  'noncanonical',
  '7',
  ['C2'],
  g,
)
rej(
  'payload-nonminimal-key',
  'Map key 0 encoded as 18 00.',
  P('a1 1800 00'),
  'noncanonical',
  '7',
  ['C2'],
  g,
)
rej(
  'payload-nonminimal-negative',
  'Negative one encoded as 38 00.',
  P('a1 00 3800'),
  'noncanonical',
  '7',
  ['C2'],
  g,
)
rej(
  'payload-indefinite-array',
  'Indefinite-length array.',
  P('a1 00 9f 01 ff'),
  'noncanonical',
  '7',
  ['C3'],
  g,
)
rej(
  'payload-indefinite-map',
  'Indefinite-length map.',
  P('bf ff'),
  'noncanonical',
  '7',
  ['C3'],
  g,
)
rej(
  'payload-indefinite-text',
  'Indefinite-length text string.',
  P('a1 00 7f 61 68 ff'),
  'noncanonical',
  '7',
  ['C3'],
  g,
)
rej(
  'payload-indefinite-bytes',
  'Indefinite-length byte string.',
  P('a1 00 5f 41 01 ff'),
  'noncanonical',
  '7',
  ['C3'],
  g,
)
rej(
  'payload-duplicate-key',
  'Map with key 0 twice.',
  P('a2 00 01 00 02'),
  'noncanonical',
  '7',
  ['C4'],
  g,
)
rej(
  'payload-unsorted-keys',
  'Map keys 1 then 0.',
  P('a2 01 01 00 01'),
  'noncanonical',
  '7',
  ['C1', 'C4'],
  g,
)
rej(
  'payload-half-float',
  'Half-precision float.',
  P('a1 00 f93c00'),
  'schema',
  '7',
  ['C5'],
  g,
)
rej(
  'payload-single-float',
  'Single-precision float.',
  P('a1 00 fa3f800000'),
  'schema',
  '7',
  ['C5'],
  g,
)
rej(
  'payload-double-float',
  'Double-precision float.',
  P('a1 00 fb3ff0000000000000'),
  'schema',
  '7',
  ['C5'],
  g,
)
rej(
  'payload-tag',
  'Tag 1 wrapping an integer.',
  P('a1 00 c1 01'),
  'schema',
  '7',
  ['C5'],
  g,
)
rej(
  'payload-bignum-tag',
  'Tag 2 (bignum): no bignum tag is permitted.',
  P('a1 00 c2 41 01'),
  'schema',
  '7',
  ['C5', 'C8'],
  g,
)
rej(
  'payload-undefined',
  'The simple value undefined.',
  P('a1 00 f7'),
  'schema',
  '7',
  ['C5'],
  g,
)
rej(
  'payload-simple-16',
  'Unassigned simple value 16.',
  P('a1 00 f0'),
  'schema',
  '7',
  ['C5'],
  g,
)
rej(
  'payload-simple-32',
  'Two-byte simple value f8 20 (32) is forbidden, not malformed.',
  P('a1 00 f820'),
  'schema',
  '7',
  ['C2', 'C5'],
  g,
)
rej(
  'payload-text-keys-unsorted',
  'README pass example {"b":1,"a":2}: fails at the first key as schema, not ordering.',
  P('a2 6162 01 6161 02'),
  'schema',
  '7',
  ['C1a', 'C10'],
  g,
)
rej(
  'payload-negative-key',
  'Negative-integer map key.',
  P('a1 20 01'),
  'schema',
  '7',
  ['C1a'],
  g,
)
rej(
  'payload-bytes-key',
  'Byte-string map key.',
  P('a1 41 00 01'),
  'schema',
  '7',
  ['C1a'],
  g,
)
rej(
  'payload-array-key',
  'Array as a map key.',
  P('a1 80 01'),
  'schema',
  '7',
  ['C1a'],
  g,
)
rej(
  'payload-noncanonical-before-schema',
  'A non-minimal text key length is noncanonical, reported before the non-uint key class.',
  P('a1 7801 61 01'),
  'noncanonical',
  '7',
  ['C1a', 'C2', 'C10'],
  g,
)
rej(
  'unknown-type-text-key-not-retained',
  'C1a applies inside an unknown-type payload: a text key is a schema error even where root retention is permitted.',
  framePayload(hex('a1 00 a1 6161 01'), UNKNOWN_TYPE),
  'schema',
  '7',
  ['C1a', 'E3'],
  { ...g, retention: true },
)
rej(
  'unknown-type-noncanonical-not-retained',
  'A non-minimal integer inside an unknown-type payload is noncanonical even where root retention is permitted.',
  framePayload(hex('a1 00 1805'), UNKNOWN_TYPE),
  'noncanonical',
  '7',
  ['C2', 'E3'],
  { ...g, retention: true },
)

const nested = (levels: number): Uint8Array => {
  const out = new Uint8Array(levels)
  out.fill(0x81)
  out[levels - 1] = 0x80
  return out
}
acc(
  'limit-depth-31-payload',
  'Payload nested 31 levels (depths 2 through 32): at the depth limit.',
  framePayload(nested(31)),
  ['R1'],
  g,
)
rej(
  'limit-depth-32-payload',
  'Payload nested 32 levels (first container at depth 2 reaches depth 33).',
  framePayload(nested(32)),
  'resource',
  '7',
  ['R1'],
  g,
)
acc(
  'limit-array-8192-elements',
  'Array of 8,192 elements.',
  framePayload(concatBytes(hex('99 2000'), new Uint8Array(8192))),
  ['R1'],
  g,
)
rej(
  'limit-array-8193-elements',
  'Array declaring 8,193 elements.',
  framePayload(concatBytes(hex('99 2001'), new Uint8Array(8193))),
  'resource',
  '7',
  ['R1'],
  g,
)
/** A map {0:0, 1:0, ..., n-1:0} with a minimal head. */
function fixMap(n: number): Uint8Array {
  const parts: number[] =
    n < 24 ? [0xa0 | n] : n < 256 ? [0xb8, n] : [0xb9, n >> 8, n & 0xff]
  for (let k = 0; k < n; k++) {
    if (k < 24) parts.push(k)
    else parts.push(0x18, k)
    parts.push(0)
  }
  return Uint8Array.from(parts)
}

acc(
  'limit-map-256-entries',
  'Map of 256 entries.',
  framePayload(fixMap(256)),
  ['R1'],
  g,
)
rej(
  'limit-map-257-entries',
  'Map declaring 257 entries.',
  framePayload(fixMap(257)),
  'resource',
  '7',
  ['R1'],
  g,
)

/** An outer array holding two inner arrays of empty arrays, sized for a container total. */
function containerHeavy(totalContainers: number): Uint8Array {
  // Envelope map (1) + outer array (1) + two inner arrays (2) + their empty-array elements.
  const elems = totalContainers - 4
  const first = 8192
  const second = elems - first
  return concatBytes(
    hex('82'),
    hex('99 2000'),
    new Uint8Array(first).fill(0x80),
    Uint8Array.of(0x99, second >> 8, second & 255),
    new Uint8Array(second).fill(0x80),
  )
}
acc(
  'limit-containers-16384',
  'Exactly 16,384 arrays and maps (envelope map included) in one operation.',
  framePayload(containerHeavy(16384)),
  ['R1'],
  g,
)
rej(
  'limit-containers-16385',
  'One container over the 16,384 limit.',
  framePayload(containerHeavy(16385)),
  'resource',
  '7',
  ['R1'],
  g,
)
rej(
  'limit-byte-string-declared-oversize',
  'Payload byte string declaring 8,388,609 bytes, truncated: resource, not malformed.',
  P('5a 00800001'),
  'resource',
  '7',
  ['R1', 'R5'],
  g,
)
rej(
  'limit-text-declared-oversize',
  'Payload text declaring 262,145 bytes, truncated: resource, not malformed.',
  P('7a 00040001'),
  'resource',
  '7',
  ['R1', 'R5'],
  g,
)
rej(
  'limit-indefinite-array-8193-elements',
  'An indefinite array reaching 8,193 elements counts them as it reads: resource, not noncanonical.',
  framePayload(concatBytes(hex('9f'), new Uint8Array(8193), hex('ff'))),
  'resource',
  '7',
  ['R1', 'C3'],
  g,
)

// ---------------------------------------------------------------------------------------------
// Stage 7 V6 decisions
// ---------------------------------------------------------------------------------------------

rej(
  'v6-unknown-type-unsupported',
  'The worked 0xffff0001 frame where the root may not retain.',
  WORKED_RETAINED,
  'unsupported',
  '7',
  ['E3', 'V6.1'],
)
rej(
  'v6-min-reader-above-reader-unsupported',
  'Type 17 with schema 2 / min_reader 2 read by reader version 1, no retention permitted.',
  fr(17, M([[0, 'x']]), 2, 2),
  'unsupported',
  '7',
  ['E2', 'V6.1'],
  { source: 'typescript' },
)
ret(
  'v6-min-reader-above-reader-retained',
  'The same frame where the root may retain it opaquely.',
  fr(17, M([[0, 'x']]), 2, 2),
  ['E3', 'V6.1'],
  { source: 'typescript' },
)
acc(
  'v6-newer-schema-extra-field',
  'Type 17 at schema 2 (min_reader 1) with an undeclared field 1: read through the schema-1 projection, unknown field retained (V6.3).',
  fr(
    17,
    M([
      [0, 'x'],
      [1, 7],
    ]),
    2,
    1,
  ),
  ['V6.3', 'V1'],
)
rej(
  'v6-exact-schema-extra-field',
  'The same extra field at schema 1 is a C12 schema error.',
  fr(
    17,
    M([
      [0, 'x'],
      [1, 7],
    ]),
    1,
    1,
  ),
  'schema',
  '8.2',
  ['C12', 'V6.2'],
  { source: 'typescript' },
)
rej(
  'v6-newer-schema-closed-map-extra-key',
  'A closed map (signature-entry) stays closed at schema 2: an undeclared key is a schema error.',
  fr(
    2,
    M([
      [0, statementFrame()],
      [1, [new Map([...sig(acct2(1)), [9, 1]])]],
    ]),
    2,
    1,
  ),
  'schema',
  '8.2',
  ['C12'],
  { source: 'typescript', prior: null },
)
rej(
  'v6-newer-schema-missing-required',
  'Schema 2 still needs the fields the reader knows.',
  fr(17, M([[1, 7]]), 2, 1),
  'schema',
  '8.2',
  ['V6.3'],
  { source: 'typescript' },
)
rej(
  'v6-supported-list-omits-type',
  'A supported-schema list without type 17 makes it unknown: unsupported without root retention.',
  hi,
  'unsupported',
  '7',
  ['V6.1', 'E3'],
  { supported: [{ typeId: 1, schemaVersion: 1 }], source: 'handcrafted' },
)
rej(
  'v6-required-child-unlisted-type',
  'A required-type child of a type omitted from the supported list is unsupported.',
  type6Frame(),
  'unsupported',
  '7',
  ['V6.1', 'S8'],
  {
    supported: [
      { typeId: 5, schemaVersion: 1 },
      { typeId: 6, schemaVersion: 1 },
      { typeId: 16, schemaVersion: 1 },
      { typeId: 17, schemaVersion: 1 },
    ],
    source: 'typescript',
  },
)

// ---------------------------------------------------------------------------------------------
// Stage 8.1 type-specific limits, 8.2 structure, 8.3 allocated identifiers
// ---------------------------------------------------------------------------------------------

const dummyList = (n: number): Encodable[] =>
  Array.from({ length: n }, () => M([]))
const TS = { source: 'typescript' as const }

acc(
  'limit-type1-64-payments',
  'Type-1 delivery with 64 payment members: at the R2 limit.',
  deliveryFrame({ payments: 64 }),
  ['R2'],
)
rej(
  'limit-type1-65-payments',
  'Type 1 declaring 65 payment members: resource at 8.1, before any structural check (the members are empty maps).',
  fr(1, M([[4, dummyList(65)]])),
  'resource',
  '8.1',
  ['R2'],
  TS,
)
const items = (n: number, text = 'x') =>
  Array.from({ length: n }, () => textItem(text))
acc(
  'limit-type8-256-items',
  'Type 8 with 256 message items: at the per-array and total limit.',
  fr(8, revision8(items(256))),
  ['R2'],
)
rej(
  'limit-type8-257-items',
  'Type 8 declaring 257 message-item frames: resource at 8.1.',
  fr(8, revision8(items(257))),
  'resource',
  '8.1',
  ['R2'],
  TS,
)
acc(
  'limit-type8-total-256',
  'Type 8 with one container of 255 texts: 256 opened items in all.',
  fr(8, revision8([containerItem(items(255))])),
  ['R2'],
)
rej(
  'limit-type8-total-257',
  'Type 8 with one container of 256 texts: the 257th opened item exceeds the total (charged at 8.4).',
  fr(8, revision8([containerItem(items(256))])),
  'resource',
  '8.4',
  ['R2'],
  TS,
)
rej(
  'limit-type16-257-items',
  'Type-16 container declaring 257 items.',
  fr(16, M([[0, items(257)]])),
  'resource',
  '8.1',
  ['R2'],
  TS,
)
const chain = (levels: number): Uint8Array => {
  let f = textItem('leaf')
  for (let i = 0; i < levels; i++) f = containerItem([f])
  return f
}
acc(
  'limit-type16-depth-10-levels',
  'A type-16 root with nine further nested type-16 levels and a text leaf: depth 32, no headroom (README R1 rationale).',
  chain(10),
  ['R1'],
)
rej(
  'limit-type16-depth-11-levels',
  'One more type-16 level: the deepest container is at depth 33 (stage 7 of the eleventh container).',
  chain(11),
  'resource',
  '7',
  ['R1'],
  TS,
)
acc(
  'limit-type4-32-relays',
  'Type-4 statement with 32 relay bindings: at the R3 limit.',
  fr(
    4,
    statementPayload({
      relays: Array.from({ length: 32 }, (_, i) => relay(i + 1)),
    }),
  ),
  ['R3'],
  { prior: null },
)
rej(
  'limit-type4-33-relays',
  'Type 4 declaring 33 relay bindings.',
  fr(4, M([[4, dummyList(33)]])),
  'resource',
  '8.1',
  ['R3'],
  { ...TS, prior: null },
)
const sigs16 = Array.from({ length: 16 }, (_, i) => sig(acct2(i + 1)))
acc(
  'limit-type2-16-signatures',
  'Type-2 attestation with 16 signature entries: at the R3 limit.',
  attestationFrame(statementFrame(), sigs16),
  ['R3'],
  { prior: null },
)
rej(
  'limit-type2-17-signatures',
  'Type 2 declaring 17 signature entries.',
  fr(
    2,
    M([
      [0, statementFrame()],
      [1, dummyList(17)],
    ]),
  ),
  'resource',
  '8.1',
  ['R3'],
  { ...TS, prior: null },
)
rej(
  'limit-type3-4097-facts',
  'Type 3 declaring 4,097 journal facts.',
  fr(3, M([[4, dummyList(4097)]])),
  'resource',
  '8.1',
  ['R4'],
  { ...TS, prior: null },
)
rej(
  'limit-type3-4097-sections',
  'Type 3 declaring 4,097 opaque sections.',
  fr(
    3,
    M([
      [4, []],
      [5, dummyList(4097)],
    ]),
  ),
  'resource',
  '8.1',
  ['R4'],
  { ...TS, prior: null },
)

rej(
  't17-text-wrong-type',
  'Type 17 with an integer where text is required.',
  fr(17, M([[0, 5]])),
  'schema',
  '8.2',
  ['E3'],
  TS,
)
rej(
  't17-missing-field',
  'Type 17 without field 0.',
  fr(17, M([])),
  'schema',
  '8.2',
  ['E3'],
  TS,
)
rej(
  't17-payload-not-a-map',
  'Type 17 whose payload is an array.',
  fr(17, []),
  'schema',
  '8.2',
  ['E3'],
  TS,
)
rej(
  't17-undeclared-key-exact-schema',
  'An undeclared key at an exactly supported schema is a schema error (C12).',
  fr(
    17,
    M([
      [0, 'x'],
      [1, 1],
    ]),
  ),
  'schema',
  '8.2',
  ['C12'],
  TS,
)
rej(
  't5-network-uppercase',
  'Network tag with an uppercase letter.',
  fr(5, type5Payload({ net: 'Frank' })),
  'schema',
  '8.2',
  ['S1'],
  TS,
)
rej(
  't5-network-empty',
  'Empty network tag.',
  fr(5, type5Payload({ net: '' })),
  'schema',
  '8.2',
  ['S1'],
  TS,
)
rej(
  't5-network-leading-hyphen',
  'Network tag starting with a hyphen.',
  fr(5, type5Payload({ net: '-frank' })),
  'schema',
  '8.2',
  ['S1'],
  TS,
)
rej(
  't1-key-length-wrong',
  'Key type 1 with a 32-byte key.',
  deliveryFrame({
    destination: M([
      [0, 1],
      [1, bytesOf(32, 1)],
    ]),
  }),
  'schema',
  '8.2',
  ['S2'],
  TS,
)
rej(
  't1-payments-empty',
  'Type 1 with an empty payment list: the [1*64] lower bound is a schema error, not resource.',
  fr(1, deliveryPayload({ payments: [] })),
  'schema',
  '8.2',
  ['R2', 'S3'],
  TS,
)
rej(
  't1-account-ref-extra-key',
  'account-ref is closed: an extra key is a schema error at every schema version.',
  deliveryFrame({ destination: new Map([...acct1(3), [2, 0]]) }),
  'schema',
  '8.2',
  ['C12'],
  TS,
)
rej(
  't1-child-index-hardened',
  'Child index 2^31 (hardened).',
  fr(
    1,
    deliveryPayload({
      payments: [payment(new Uint8Array(32), { index: 2147483648 })],
    }),
  ),
  'schema',
  '8.2',
  ['S3', 'T3a'],
  TS,
)
rej(
  't4-endpoint-space',
  'Endpoint containing a space.',
  fr(4, statementPayload({ relays: [relay(1, 'https://a b/')] })),
  'schema',
  '8.2',
  ['S4'],
  { ...TS, prior: null },
)
rej(
  't4-endpoint-no-scheme',
  'Endpoint without a scheme.',
  fr(4, statementPayload({ relays: [relay(1, '//relay.example')] })),
  'schema',
  '8.2',
  ['S4'],
  { ...TS, prior: null },
)
rej(
  't4-endpoint-backslash',
  'Endpoint containing a backslash.',
  fr(4, statementPayload({ relays: [relay(1, 'https://a\\b')] })),
  'schema',
  '8.2',
  ['S4'],
  { ...TS, prior: null },
)
rej(
  't4-authorities-9',
  'Nine offline recovery authorities: the [1*8] upper bound is a schema error, not resource.',
  fr(
    4,
    statementPayload({
      authorities: Array.from({ length: 9 }, (_, i) => acct2(i + 1)),
    }),
  ),
  'schema',
  '8.2',
  ['S4a'],
  { ...TS, prior: null },
)
rej(
  't4-nanoseconds-out-of-range',
  'Timestamp nanoseconds 1,000,000,000.',
  fr(
    4,
    withField(
      statementPayload(),
      3,
      M([
        [0, 1],
        [1, 1_000_000_000],
      ]),
    ),
  ),
  'schema',
  '8.2',
  ['C7'],
  { ...TS, prior: null },
)
rej(
  't4-revision-negative',
  'A negative revision: only an unsigned u64 is allowed.',
  fr(4, withField(statementPayload(), 2, -1n)),
  'schema',
  '8.2',
  ['C7'],
  { ...TS, prior: null },
)
rej(
  't4-revision-as-bignum-tag',
  'A revision written as a bignum tag (there is no way to write 2^64 without one): forbidden tag, reported at stage 7.',
  framePayload(
    patchBytes(
      encodeCanonical(withField(statementPayload(), 2, 0xdeadbeefn)),
      hex('1adeadbeef'),
      hex('c249010000000000000000'),
    ),
    4,
  ),
  'schema',
  '7',
  ['C5', 'C7', 'C8'],
  { prior: null, ...g },
)
rej(
  't8-domain-not-frank',
  'Type 8 whose field 0 is not the text "frank".',
  fr(
    8,
    M([
      [0, 'other'],
      [1, [textItem()]],
    ]),
  ),
  'schema',
  '8.2',
  ['T1a'],
  TS,
)
rej(
  't3-fact-id-wrong-length',
  'Journal fact with a 15-byte fact_id.',
  checkpointFrame({ facts: [withField(fact(1, 0, 1), 1, bytesOf(15, 1))] }),
  'schema',
  '8.2',
  ['S6'],
  { ...TS, prior: null },
)
rej(
  't3-section-closed-map',
  'opaque-section is closed: an extra key is a schema error.',
  checkpointFrame({
    sections: [new Map([...section(1, 1, new Uint8Array(0)), [3, 0]])],
  }),
  'schema',
  '8.2',
  ['C12', 'S7'],
  { ...TS, prior: null },
)

rej(
  't5-suite-unallocated',
  'Encryption suite 1 is unallocated in version 1.',
  fr(5, type5Payload({ suite: 1 })),
  'unsupported',
  '8.3',
  ['S2c'],
  TS,
)
rej(
  't1-key-type-unallocated',
  'Destination account with unallocated key type 9.',
  deliveryFrame({
    destination: M([
      [0, 9],
      [1, bytesOf(33, 1)],
    ]),
  }),
  'unsupported',
  '8.3',
  ['S2'],
  TS,
)
rej(
  't2-algorithm-key-type-mismatch',
  'Signature algorithm 1 (secp256k1 ECDSA) with an Ed25519 key type.',
  attestationFrame(statementFrame(), [sig(acct2(1), 1, 1)]),
  'unsupported',
  '8.3',
  ['S2a', 'S2b'],
  { ...TS, prior: null },
)
rej(
  't2-algorithm-unallocated',
  'Signature algorithm 99.',
  attestationFrame(statementFrame(), [sig(acct2(1), 1, 99)]),
  'unsupported',
  '8.3',
  ['S2a'],
  { ...TS, prior: null },
)
rej(
  't2-ed25519-signature-63-bytes',
  'Algorithm 16 with a 63-byte signature: an unallocated pairing, not a signature failure.',
  attestationFrame(statementFrame(), [
    new Map([...sig(acct2(1)), [2, bytesOf(63, 1)]]),
  ]),
  'unsupported',
  '8.3',
  ['S2b'],
  { ...TS, prior: null },
)

// ---------------------------------------------------------------------------------------------
// Stage 8.4: recursive opening
// ---------------------------------------------------------------------------------------------

rej(
  't1-payload-frame-wrong-type',
  'Type-1 field 2 carries a type-17 frame instead of type 5.',
  deliveryFrame({ payloadFrame: textItem() }),
  'semantic',
  '8.4',
  ['S8'],
  TS,
)
rej(
  't1-payload-frame-unknown-type',
  'Type-1 field 2 carries an unknown-type frame: a required-type mismatch, never retained.',
  deliveryFrame({ payloadFrame: unknownItem() }),
  'semantic',
  '8.4',
  ['S8', 'V6.1'],
  { ...TS, retention: true },
)
rej(
  't1-payload-frame-version-2',
  'Type-1 field 2 carries a version-2 frame: unsupported, no retention in a required field.',
  deliveryFrame({ payloadFrame: body('a0', 2) }),
  'unsupported',
  '3',
  ['F2', 'S8'],
  { ...TS, retention: true },
)
rej(
  't1-payload-frame-min-reader-above',
  'Required type-5 child with min_reader_version 2 for a version-1 reader.',
  deliveryFrame({ payloadFrame: fr(5, type5Payload(), 2, 2) }),
  'unsupported',
  '7',
  ['V6.1', 'S8'],
  TS,
)
rej(
  't1-payload-frame-bad-magic',
  'Required child with bad magic.',
  deliveryFrame({
    payloadFrame: (() => {
      const f = type5Frame()
      f[0] = 0x58
      return f
    })(),
  }),
  'frame',
  '2',
  ['F1', 'S8'],
  TS,
)
rej(
  't1-payload-frame-length-mismatch',
  'Required child whose declared length is one too large.',
  deliveryFrame({
    payloadFrame: (() => {
      const f = type5Frame()
      return withLength(f, f.length - 9 + 1)
    })(),
  }),
  'frame',
  '4',
  ['F3', 'S8'],
  TS,
)
rej(
  't1-payload-frame-bad-cbor',
  'Required child whose envelope is truncated CBOR.',
  deliveryFrame({ payloadFrame: body('780561') }),
  'malformed',
  '5',
  ['C10', 'S8'],
  TS,
)
rej(
  't1-payload-frame-noncanonical-payload',
  'Required child whose payload has a non-minimal integer.',
  deliveryFrame({ payloadFrame: framePayload(hex('a1 00 1805'), 5) }),
  'noncanonical',
  '7',
  ['C2', 'S8'],
  TS,
)
rej(
  't2-statement-frame-wrong-type',
  'Type-2 field 0 carries a type-17 frame instead of type 4.',
  attestationFrame(textItem(), [sig(acct2(1))]),
  'semantic',
  '8.4',
  ['S8'],
  { ...TS, prior: null },
)
rej(
  't6-revision-frame-wrong-type',
  'Type-6 field 2 carries a type-17 frame instead of type 8.',
  fr(
    6,
    M([
      [0, NET],
      [1, bytesOf(16, 7)],
      [2, textItem()],
      [3, bytesOf(32, 1)],
    ]),
  ),
  'semantic',
  '8.4',
  ['S8'],
  TS,
)
rej(
  't4-transition-frame-wrong-type',
  'A key-transition entry whose field 0 is a type-17 frame instead of type 7.',
  fr(4, statementPayload({ transitions: [transition(textItem())] })),
  'semantic',
  '8.4',
  ['S8'],
  { ...TS, prior: null },
)
rej(
  't8-item-assigned-type',
  'A message item carrying assigned type 5: not an open-field type.',
  fr(8, revision8([type5Frame()])),
  'semantic',
  '8.4',
  ['S8'],
  TS,
)
rej(
  't16-item-assigned-type',
  'A container holding a type-8 frame.',
  fr(16, M([[0, [rev8Frame()]]])),
  'semantic',
  '8.4',
  ['S8'],
  TS,
)
rej(
  't8-item-bad-magic',
  'An open-field child with bad magic is a frame error, not retained.',
  fr(8, revision8([Uint8Array.of(0x58, 0x52, 0x4e, 0x4b, 1, 0, 0, 0, 0)])),
  'frame',
  '2',
  ['F1'],
  TS,
)
rej(
  't8-item-noncanonical-payload',
  'An unknown-type child with a non-minimal payload integer is noncanonical, not retained.',
  fr(8, revision8([framePayload(hex('a1 00 1805'), UNKNOWN_TYPE)])),
  'noncanonical',
  '7',
  ['C2', 'V6.1'],
  TS,
)
rej(
  't8-item-text-key-in-unknown',
  'An unknown-type child with a text map key is a schema error, not retained.',
  fr(8, revision8([framePayload(hex('a1 6161 01'), UNKNOWN_TYPE)])),
  'schema',
  '7',
  ['C1a', 'V6.1'],
  TS,
)
acc(
  't8-unknown-item-retained',
  'An unknown item type is retained exactly whatever opaque_retention_allowed says.',
  fr(8, revision8([textItem(), unknownItem(5)])),
  ['V6.1', 'V4'],
  { retention: false },
)
acc(
  't8-unknown-frame-version-item-retained',
  'A version-2 child frame with an uninterpreted length field is retained exactly.',
  fr(8, revision8([textItem(), body('ffffffffffff', 2)])),
  ['F2', 'V6.1'],
  { retention: false },
)
acc(
  't8-min-reader-above-item-retained',
  'A known-type child whose min_reader_version exceeds the reader is retained in an open field.',
  fr(8, revision8([fr(17, M([[0, 'x']]), 2, 2)])),
  ['V6.1'],
  { retention: false },
)
acc(
  't16-newer-schema-item',
  'A type-17 item at schema 2 (min_reader 1) is read through the schema-1 projection.',
  fr(
    16,
    M([
      [
        0,
        [
          fr(
            17,
            M([
              [0, 'x'],
              [1, 3],
            ]),
            2,
            1,
          ),
        ],
      ],
    ]),
  ),
  ['V6.3'],
)

// ---------------------------------------------------------------------------------------------
// Stage 9: semantics
// ---------------------------------------------------------------------------------------------

const S = { ...TS }
const pf = type5Frame()
const t3 = recipientPayloadDigest(NET, pf)
const pays = (
  idx: number[],
  o: { txSeed?: (i: number) => number; addrSeed?: (i: number) => number } = {},
) =>
  idx.map((index, i) =>
    payment(t3, { index, txSeed: o.txSeed?.(i), addrSeed: o.addrSeed?.(i) }),
  )
const dm = (payments: Array<Map<number, Encodable>>) =>
  deliveryFrame({ payloadFrame: pf, payments })

rej(
  'sem-t1-network-differs',
  'Delivery network differs from the opened type-5 network (S8).',
  deliveryFrame({ net: 'other-net' }),
  'semantic',
  '9',
  ['S8'],
  S,
)
rej(
  'sem-t1-recipient-differs',
  'Delivery destination differs from the type-5 recipient (S8).',
  deliveryFrame({ destination: acct1(4) }),
  'semantic',
  '9',
  ['S8'],
  S,
)
rej(
  'sem-t1-destination-not-key-type-1',
  'Destination (and matching recipient) is key type 2: S9 requires key type 1.',
  deliveryFrame({
    destination: acct2(3),
    payloadFrame: type5Frame({ recipient: acct2(3) }),
  }),
  'semantic',
  '9',
  ['S9'],
  S,
)
rej(
  'sem-t1-payments-unsorted',
  'Payment members ordered child index 1 then 0.',
  dm(pays([1, 0])),
  'semantic',
  '9',
  ['S3'],
  S,
)
rej(
  'sem-t1-duplicate-child-index',
  'Two members with child index 0 and different transactions.',
  dm(pays([0, 0])),
  'semantic',
  '9',
  ['S3'],
  S,
)
rej(
  'sem-t1-duplicate-transaction-id',
  'Two members with the same transaction id.',
  dm(pays([0, 1], { txSeed: () => 100 })),
  'semantic',
  '9',
  ['S3'],
  S,
)
rej(
  'sem-t1-index-gap',
  'Child indices 0 and 2: not exactly contiguous (T3a.5).',
  dm(pays([0, 2])),
  'semantic',
  '9',
  ['T3a', 'S9'],
  S,
)
rej(
  'sem-t1-indices-start-at-one',
  'Child indices 1 and 2: contiguity starts at 0 (T3a.5).',
  dm(pays([1, 2])),
  'semantic',
  '9',
  ['T3a', 'S9'],
  S,
)
rej(
  'sem-t1-duplicate-address',
  'Two members with the same derived destination address.',
  dm(pays([0, 1], { addrSeed: () => 60 })),
  'semantic',
  '9',
  ['S9'],
  S,
)

const NOP = { ...S, prior: null as Uint8Array | null }
rej(
  'sem-t4-relays-unsorted',
  'Relay bindings ordered by descending relay_id.',
  fr(4, statementPayload({ relays: [relay(2), relay(1)] })),
  'semantic',
  '9',
  ['S4'],
  NOP,
)
rej(
  'sem-t4-relay-id-duplicate',
  'Two relay bindings sharing a relay_id.',
  fr(
    4,
    statementPayload({
      relays: [relay(1, 'https://a.example/'), relay(1, 'https://b.example/')],
    }),
  ),
  'semantic',
  '9',
  ['S4'],
  NOP,
)
rej(
  'sem-t4-recovery-authorities-unsorted',
  'Offline recovery authorities out of order.',
  fr(4, statementPayload({ authorities: [acct2(2), acct2(1)] })),
  'semantic',
  '9',
  ['S4a'],
  NOP,
)
rej(
  'sem-t4-recovery-authorities-duplicate',
  'Duplicate offline recovery authority.',
  fr(4, statementPayload({ authorities: [acct2(1), acct2(1)] })),
  'semantic',
  '9',
  ['S4a'],
  NOP,
)
rej(
  'sem-t4-transitions-descending-revision',
  'Two key transitions with descending revisions.',
  fr(
    4,
    statementPayload({
      transitions: [
        transition(t7({ revision: 7n })),
        transition(t7({ revision: 6n })),
      ],
    }),
  ),
  'semantic',
  '9',
  ['S5'],
  NOP,
)
rej(
  'sem-t4-transitions-same-revision',
  'Two key transitions with the same revision are invalid, not tie-broken.',
  fr(
    4,
    statementPayload({
      transitions: [
        transition(t7({ revision: 6n, newKey: acct2(2) })),
        transition(t7({ revision: 6n, newKey: acct2(3) })),
      ],
    }),
  ),
  'semantic',
  '9',
  ['S5'],
  NOP,
)

const stmt = statementFrame()
rej(
  'sem-t2-signatures-unsorted',
  'Signature entries with descending signer keys.',
  attestationFrame(stmt, [sig(acct2(2)), sig(acct2(1))]),
  'semantic',
  '9',
  ['S4'],
  NOP,
)
rej(
  'sem-t2-signature-duplicate',
  'The same signature tuple twice.',
  attestationFrame(stmt, [sig(acct2(1)), sig(acct2(1))]),
  'semantic',
  '9',
  ['S4'],
  NOP,
)
rej(
  'sem-t2-no-subject-signature',
  'No entry is signed by the statement subject.',
  attestationFrame(stmt, [sig(acct2(2))]),
  'semantic',
  '9',
  ['S10'],
  NOP,
)
rej(
  'sem-t2-bootstrap-with-transition',
  'A bootstrap statement (no prior) carrying a key transition.',
  attestationFrame(updStmt(), [sig(acct2(2))]),
  'semantic',
  '9',
  ['S10'],
  NOP,
)

const upd = (o: Parameters<typeof statementPayload>[0], signer = acct2(2)) =>
  attestationFrame(fr(4, statementPayload(o)), [sig(signer)])
const P1 = { ...S, prior: priorStmt }
rej(
  'sem-s10-revision-equal',
  'Revision equal to the prior revision.',
  upd({ revision: 5n }, acct2(1)),
  'semantic',
  '9',
  ['S10'],
  P1,
)
rej(
  'sem-s10-revision-lower',
  'Revision below the prior revision.',
  upd({ revision: 4n }, acct2(1)),
  'semantic',
  '9',
  ['S10'],
  P1,
)
rej(
  'sem-s10-network-differs',
  'Unchanged subject but a different network from the prior statement.',
  upd({ revision: 6n, net: 'other-net' }, acct2(1)),
  'semantic',
  '9',
  ['S10'],
  P1,
)
acc(
  'sem-s10-unchanged-subject-accepted',
  'Same subject, greater revision, no transition: accepted.',
  upd({ revision: 6n }, acct2(1)),
  ['S10'],
  { prior: priorStmt },
)
rej(
  'sem-s10-transition-with-unchanged-subject',
  'A key transition alongside an unchanged subject.',
  upd(
    { revision: 6n, subject: acct2(1), transitions: [transition(t7())] },
    acct2(1),
  ),
  'semantic',
  '9',
  ['S10'],
  P1,
)
rej(
  'sem-s10-subject-change-without-transition',
  'The subject changes with no key transition.',
  upd({ revision: 6n, subject: acct2(2) }),
  'semantic',
  '9',
  ['S10'],
  P1,
)
rej(
  'sem-s10-two-transitions',
  'A subject change carrying two ordered transitions (extra or chained).',
  upd(
    {
      revision: 7n,
      subject: acct2(3),
      transitions: [
        transition(t7({ revision: 6n })),
        transition(
          t7({
            revision: 7n,
            subject: acct2(2),
            prior: acct2(2),
            newKey: acct2(3),
          }),
          acct2(2),
        ),
      ],
    },
    acct2(3),
  ),
  'semantic',
  '9',
  ['S10'],
  P1,
)
rej(
  'sem-s10-transition-new-key-differs',
  'Transition new_key differs from the new statement subject.',
  upd({
    transitions: [transition(t7({ newKey: acct2(3) }))],
    subject: acct2(2),
    revision: 6n,
  }),
  'semantic',
  '9',
  ['S10'],
  P1,
)
rej(
  'sem-s10-transition-subject-differs',
  'Transition directory_subject differs from the previous subject.',
  upd({
    transitions: [transition(t7({ subject: acct2(9) }))],
    subject: acct2(2),
    revision: 6n,
  }),
  'semantic',
  '9',
  ['S10'],
  P1,
)
rej(
  'sem-s10-transition-revision-differs',
  'Transition revision differs from the new statement revision.',
  upd({
    transitions: [transition(t7({ revision: 7n }))],
    subject: acct2(2),
    revision: 6n,
  }),
  'semantic',
  '9',
  ['S10'],
  P1,
)
rej(
  'sem-s10-transition-network-differs',
  'Transition network differs from the statement networks.',
  upd({
    transitions: [transition(t7({ net: 'other-net' }))],
    subject: acct2(2),
    revision: 6n,
  }),
  'semantic',
  '9',
  ['S10'],
  P1,
)
rej(
  'sem-s10-prior-authority-unregistered',
  'Prior authority is neither the last registered key nor a registered recovery authority.',
  upd({
    transitions: [transition(t7({ prior: acct2(9) }), acct2(9))],
    subject: acct2(2),
    revision: 6n,
  }),
  'semantic',
  '9',
  ['S4a', 'S10'],
  P1,
)
rej(
  'sem-s10-recovery-authority-introduced-by-update',
  'A recovery authority introduced by the statement being authorized cannot authorize it.',
  upd({
    transitions: [transition(t7({ prior: acct2(7) }), acct2(7))],
    subject: acct2(2),
    revision: 6n,
    authorities: [acct2(7)],
  }),
  'semantic',
  '9',
  ['S4a'],
  P1,
)
rej(
  'sem-s10-transition-signer-differs',
  'The entry signer differs from the statement prior_authority.',
  upd({
    transitions: [transition(t7(), acct2(9))],
    subject: acct2(2),
    revision: 6n,
  }),
  'semantic',
  '9',
  ['T2a', 'S10'],
  P1,
)

const cp = (o: Parameters<typeof checkpointPayload>[0]) => checkpointFrame(o)
rej(
  'sem-t3-facts-unsorted',
  'Journal facts with descending timestamps.',
  cp({ facts: [fact(200, 0, 1), fact(100, 0, 2)] }),
  'semantic',
  '9',
  ['S6'],
  NOP,
)
rej(
  'sem-t3-facts-same-time-unsorted-ids',
  'Equal timestamps ordered by descending fact_id.',
  cp({ facts: [fact(100, 0, 2), fact(100, 0, 1)] }),
  'semantic',
  '9',
  ['S6'],
  NOP,
)
rej(
  'sem-t3-fact-id-duplicate',
  'The same fact_id at two timestamps.',
  cp({ facts: [fact(100, 0, 1), fact(200, 0, 1)] }),
  'semantic',
  '9',
  ['S6'],
  NOP,
)
rej(
  'sem-t3-sections-unsorted',
  'Opaque sections with descending section types.',
  cp({
    sections: [
      section(2, 1, new Uint8Array(0)),
      section(1, 1, new Uint8Array(0)),
    ],
  }),
  'semantic',
  '9',
  ['S7'],
  NOP,
)
rej(
  'sem-t3-section-type-duplicate',
  'Two opaque sections with the same section_type.',
  cp({
    sections: [
      section(1, 1, new Uint8Array(0)),
      section(1, 2, new Uint8Array(0)),
    ],
  }),
  'semantic',
  '9',
  ['S7'],
  NOP,
)

// ---------------------------------------------------------------------------------------------
// Round 2: single-fault boundary vectors (non-minimal widths, UTF-8 kinds, CDDL bounds, depth
// accounting of every required-child path)
// ---------------------------------------------------------------------------------------------

const zeros = (n: number): string => '00'.repeat(n)

// Non-minimal integer and length arguments, at each width boundary.
rej(
  'r2-nonminimal-int-23-as-1byte',
  'Value 23 written as 18 17 (fits the initial byte).',
  P('a1 00 1817'),
  'noncanonical',
  '7',
  ['C2'],
  g,
)
acc(
  'r2-minimal-int-24',
  'Value 24 as 18 18: the smallest value needing one argument byte.',
  P('a1 00 1818'),
  ['C2'],
  g,
)
rej(
  'r2-nonminimal-int-255-as-2byte',
  'Value 255 written as 19 00 ff (fits one argument byte).',
  P('a1 00 1900ff'),
  'noncanonical',
  '7',
  ['C2'],
  g,
)
acc(
  'r2-minimal-int-256',
  'Value 256 as 19 01 00: the smallest value needing two argument bytes.',
  P('a1 00 190100'),
  ['C2'],
  g,
)
rej(
  'r2-nonminimal-int-65535-as-4byte',
  'Value 65535 written as 1a 00 00 ff ff.',
  P('a1 00 1a0000ffff'),
  'noncanonical',
  '7',
  ['C2'],
  g,
)
acc(
  'r2-minimal-int-65536',
  'Value 65536 as 1a 00 01 00 00.',
  P('a1 00 1a00010000'),
  ['C2'],
  g,
)
rej(
  'r2-nonminimal-int-u32max-as-8byte',
  'Value 2^32-1 written as 1b 00 00 00 00 ff ff ff ff.',
  P('a1 00 1b00000000ffffffff'),
  'noncanonical',
  '7',
  ['C2'],
  g,
)
acc(
  'r2-minimal-int-2pow32',
  'Value 2^32 as 1b 00 00 00 01 00 00 00 00.',
  P('a1 00 1b0000000100000000'),
  ['C2'],
  g,
)
rej(
  'r2-nonminimal-bytes-length-1',
  'One-byte byte string with length written as 58 01.',
  P('a1 00 580100'),
  'noncanonical',
  '7',
  ['C2'],
  g,
)
rej(
  'r2-nonminimal-bytes-length-23',
  '23-byte byte string with length written as 58 17.',
  P(`a1 00 5817${zeros(23)}`),
  'noncanonical',
  '7',
  ['C2'],
  g,
)
acc(
  'r2-minimal-bytes-length-24',
  '24-byte byte string with length 58 18.',
  P(`a1 00 5818${zeros(24)}`),
  ['C2'],
  g,
)
rej(
  'r2-nonminimal-array-count-16bit',
  'Array of 1 element with count written as 99 00 01.',
  P('a1 00 99000100'),
  'noncanonical',
  '7',
  ['C2'],
  g,
)

// Invalid UTF-8, one fault each.
rej(
  'r2-utf8-overlong-e0',
  'Overlong three-byte encoding e0 80 80.',
  P('a1 00 63 e08080'),
  'malformed',
  '7',
  ['C6'],
  g,
)
rej(
  'r2-utf8-overlong-f0',
  'Overlong four-byte encoding f0 80 80 80.',
  P('a1 00 64 f0808080'),
  'malformed',
  '7',
  ['C6'],
  g,
)
rej(
  'r2-utf8-lead-f5',
  'Invalid lead byte f5 followed by three continuation bytes.',
  P('a1 00 64 f5808080'),
  'malformed',
  '7',
  ['C6'],
  g,
)
rej(
  'r2-utf8-lead-f6',
  'Invalid lead byte f6 followed by three continuation bytes.',
  P('a1 00 64 f6808080'),
  'malformed',
  '7',
  ['C6'],
  g,
)
rej(
  'r2-utf8-lead-f7',
  'Invalid lead byte f7 followed by three continuation bytes.',
  P('a1 00 64 f7808080'),
  'malformed',
  '7',
  ['C6'],
  g,
)
rej(
  'r2-utf8-truncated-sequence',
  'A three-byte sequence cut off at the end of the string (e2 82).',
  P('a1 00 62 e282'),
  'malformed',
  '7',
  ['C6'],
  g,
)
rej(
  'r2-utf8-bad-continuation-3byte-last',
  'Three-byte form with a bad last continuation byte (e2 82 28).',
  P('a1 00 63 e28228'),
  'malformed',
  '7',
  ['C6'],
  g,
)
rej(
  'r2-utf8-bad-continuation-3byte-first',
  'Three-byte form with a bad first continuation byte (e2 28 ac).',
  P('a1 00 63 e228ac'),
  'malformed',
  '7',
  ['C6'],
  g,
)
rej(
  'r2-utf8-bad-continuation-4byte-last',
  'Four-byte form with a bad last continuation byte (f0 9f 98 28).',
  P('a1 00 64 f09f9828'),
  'malformed',
  '7',
  ['C6'],
  g,
)
rej(
  'r2-utf8-bad-continuation-4byte-middle',
  'Four-byte form with a bad third byte (f0 9f 28 80).',
  P('a1 00 64 f09f2880'),
  'malformed',
  '7',
  ['C6'],
  g,
)
acc(
  'r2-utf8-max-scalar',
  'U+10FFFF (f4 8f bf bf) is well-formed.',
  P('a1 00 64 f48fbfbf'),
  ['C6'],
  g,
)

// Indefinite map entry counting.
const indefMap = (n: number): Uint8Array => {
  const parts: number[] = [0xbf]
  for (let k = 0; k < n; k++) {
    if (k < 24) parts.push(k)
    else if (k < 256) parts.push(0x18, k)
    else parts.push(0x19, k >> 8, k & 255)
    parts.push(0)
  }
  parts.push(0xff)
  return Uint8Array.from(parts)
}
rej(
  'r2-indefinite-map-257-entries',
  'An indefinite map reaching 257 entries counts them as it reads: resource.',
  framePayload(indefMap(257)),
  'resource',
  '7',
  ['R1', 'C3'],
  g,
)
rej(
  'r2-indefinite-map-256-entries',
  'An indefinite map with exactly 256 entries stays within the entry limit and is then noncanonical.',
  framePayload(indefMap(256)),
  'noncanonical',
  '7',
  ['R1', 'C3'],
  g,
)

// Endpoint syntax (S4), one character class at a time.
const withEndpoint = (e: string) =>
  fr(4, statementPayload({ relays: [relay(1, e)] }))
const ENDP = { ...TS, prior: null as Uint8Array | null }
for (const [name, e] of [
  ['double-quote', 'https://a"b/'],
  ['caret', 'https://a^b/'],
  ['backtick', 'https://a`b/'],
  ['open-brace', 'https://a{b/'],
  ['pipe', 'https://a|b/'],
  ['close-brace', 'https://a}b/'],
  ['less-than', 'https://a<b/'],
  ['greater-than', 'https://a>b/'],
  ['digit-first-scheme', '1http://relay.example/'],
  ['empty-scheme', ':relay.example/'],
  ['control-character', 'https://a\u0001b/'],
  ['non-ascii', 'https://\u00e9.example/'],
] as const) {
  rej(
    `r2-endpoint-${name}`,
    `Endpoint ${name}: violates S4.`,
    withEndpoint(e),
    'schema',
    '8.2',
    ['S4'],
    ENDP,
  )
}
acc(
  'r2-endpoint-allowed-punctuation',
  'Endpoint using allowed punctuation (! # ; = ? [ ] _ ~ + . -).',
  withEndpoint('a+b.c-d://x!#;=?[]_~'),
  ['S4'],
  { prior: null },
)
acc(
  'r2-endpoint-2048-bytes',
  'Endpoint of exactly 2,048 bytes.',
  withEndpoint(`https://${'a'.repeat(2040)}`),
  ['S4'],
  { prior: null },
)
rej(
  'r2-endpoint-2049-bytes',
  'Endpoint of 2,049 bytes.',
  withEndpoint(`https://${'a'.repeat(2041)}`),
  'schema',
  '8.2',
  ['S4'],
  ENDP,
)
acc(
  'r2-relay-id-16-bytes',
  'relay_id of 16 bytes.',
  fr(4, statementPayload({ relays: [withField(relay(1), 0, bytesOf(16, 1))] })),
  ['S4'],
  { prior: null },
)
rej(
  'r2-relay-id-15-bytes',
  'relay_id of 15 bytes.',
  fr(4, statementPayload({ relays: [withField(relay(1), 0, bytesOf(15, 1))] })),
  'schema',
  '8.2',
  ['S4'],
  ENDP,
)
acc(
  'r2-relay-id-64-bytes',
  'relay_id of 64 bytes.',
  fr(4, statementPayload({ relays: [withField(relay(1), 0, bytesOf(64, 1))] })),
  ['S4'],
  { prior: null },
)
rej(
  'r2-relay-id-65-bytes',
  'relay_id of 65 bytes.',
  fr(4, statementPayload({ relays: [withField(relay(1), 0, bytesOf(65, 1))] })),
  'schema',
  '8.2',
  ['S4'],
  ENDP,
)
rej(
  'r2-transitions-17-entries',
  'Seventeen key-transition entries: the [1*16] bound is a schema error, not resource.',
  fr(
    4,
    statementPayload({
      transitions: Array.from({ length: 17 }, () => transition(t7())),
    }),
  ),
  'schema',
  '8.2',
  ['S5'],
  ENDP,
)

// Network tag (S1).
const net5 = (n: string) => fr(5, type5Payload({ net: n }))
acc(
  'r2-network-64-chars',
  'A 64-character network tag.',
  net5('a'.repeat(64)),
  ['S1'],
)
rej(
  'r2-network-65-chars',
  'A 65-character network tag.',
  net5('a'.repeat(65)),
  'schema',
  '8.2',
  ['S1'],
  TS,
)
rej(
  'r2-network-uppercase-later',
  'Uppercase letter after the first character.',
  net5('aBc'),
  'schema',
  '8.2',
  ['S1'],
  TS,
)
acc(
  'r2-network-punctuation',
  'Network tag using . _ - after the first character.',
  net5('a.b_c-d'),
  ['S1'],
)
rej(
  'r2-network-space',
  'Network tag containing a space.',
  net5('a b'),
  'schema',
  '8.2',
  ['S1'],
  TS,
)

// Key types and lengths (S2).
const acctK = (type: number, n: number) =>
  M([
    [0, type],
    [1, bytesOf(n, 3)],
  ])
acc(
  'r2-key-type-3-32-bytes',
  'Key type 3 with a 32-byte key (allocated, correct length).',
  fr(5, new Map([...type5Payload(), [1, acctK(3, 32)]])),
  ['S2'],
)
rej(
  'r2-key-type-3-33-bytes',
  'Key type 3 with a 33-byte key.',
  fr(5, new Map([...type5Payload(), [1, acctK(3, 33)]])),
  'schema',
  '8.2',
  ['S2'],
  TS,
)
rej(
  'r2-key-type-2-33-bytes',
  'Key type 2 with a 33-byte key.',
  fr(5, new Map([...type5Payload(), [1, acctK(2, 33)]])),
  'schema',
  '8.2',
  ['S2'],
  TS,
)
rej(
  'r2-key-type-1-32-bytes',
  'Key type 1 with a 32-byte key.',
  fr(5, new Map([...type5Payload(), [1, acctK(1, 32)]])),
  'schema',
  '8.2',
  ['S2'],
  TS,
)
rej(
  'r2-key-bytes-128-unallocated-type',
  '128 key bytes pass the CDDL bound; the unallocated type is then unsupported.',
  fr(5, new Map([...type5Payload(), [1, acctK(9, 128)]])),
  'unsupported',
  '8.3',
  ['S2'],
  TS,
)
rej(
  'r2-key-bytes-129',
  '129 key bytes exceed the account-ref bound.',
  fr(5, new Map([...type5Payload(), [1, acctK(9, 129)]])),
  'schema',
  '8.2',
  ['S2'],
  TS,
)
rej(
  'r2-key-bytes-empty',
  'An empty key.',
  fr(5, new Map([...type5Payload(), [1, acctK(9, 0)]])),
  'schema',
  '8.2',
  ['S2'],
  TS,
)
rej(
  'r2-key-type-65536',
  'key_type 65536 exceeds uint .le 65535.',
  fr(5, new Map([...type5Payload(), [1, acctK(65536, 33)]])),
  'schema',
  '8.2',
  ['S2'],
  TS,
)

// Fixed-size byte fields.
const t5 = (k: number, v: Encodable) =>
  fr(5, new Map([...type5Payload(), [k, v]]))
acc('r2-nonce-64-bytes', 'A 64-byte nonce.', t5(4, bytesOf(64, 1)), ['S2c'])
rej(
  'r2-nonce-65-bytes',
  'A 65-byte nonce.',
  t5(4, bytesOf(65, 1)),
  'schema',
  '8.2',
  ['S2c'],
  TS,
)
rej(
  'r2-nonce-empty',
  'An empty nonce.',
  t5(4, new Uint8Array(0)),
  'schema',
  '8.2',
  ['S2c'],
  TS,
)
rej(
  'r2-ciphertext-empty',
  'An empty ciphertext.',
  t5(5, new Uint8Array(0)),
  'schema',
  '8.2',
  ['S2c'],
  TS,
)
const dlv = (k: number, v: Encodable) =>
  fr(1, withField(deliveryPayload(), k, v))
rej(
  'r2-digest-31-bytes',
  'type-1 payload digest of 31 bytes.',
  dlv(3, bytesOf(31, 1)),
  'schema',
  '8.2',
  ['T3'],
  TS,
)
rej(
  'r2-digest-33-bytes',
  'type-1 payload digest of 33 bytes.',
  dlv(3, bytesOf(33, 1)),
  'schema',
  '8.2',
  ['T3'],
  TS,
)
const t6 = (id: Uint8Array, digest: Uint8Array) =>
  fr(
    6,
    M([
      [0, NET],
      [1, id],
      [2, rev8Frame()],
      [3, digest],
    ]),
  )
acc(
  'r2-uuid-16-bytes',
  'message_id of 16 bytes.',
  t6(bytesOf(16, 7), bytesOf(32, 1)),
  ['T1a'],
)
rej(
  'r2-uuid-15-bytes',
  'message_id of 15 bytes.',
  t6(bytesOf(15, 7), bytesOf(32, 1)),
  'schema',
  '8.2',
  ['T1a'],
  TS,
)
rej(
  'r2-uuid-17-bytes',
  'message_id of 17 bytes.',
  t6(bytesOf(17, 7), bytesOf(32, 1)),
  'schema',
  '8.2',
  ['T1a'],
  TS,
)
rej(
  'r2-content-digest-31-bytes',
  'type-6 content digest of 31 bytes.',
  t6(bytesOf(16, 7), bytesOf(31, 1)),
  'schema',
  '8.2',
  ['T1a'],
  TS,
)
rej(
  'r2-content-digest-33-bytes',
  'type-6 content digest of 33 bytes.',
  t6(bytesOf(16, 7), bytesOf(33, 1)),
  'schema',
  '8.2',
  ['T1a'],
  TS,
)
const dmPay = (k: number, v: Encodable) =>
  deliveryFrame({
    payloadFrame: pf,
    payments: [withField(payment(t3, { index: 0 }), k, v)],
  })
rej(
  'r2-payment-value-31-bytes',
  'Payment value of 31 bytes (C8 fixed width).',
  dmPay(2, bytesOf(31, 1)),
  'schema',
  '8.2',
  ['C8', 'S3'],
  TS,
)
rej(
  'r2-payment-value-33-bytes',
  'Payment value of 33 bytes.',
  dmPay(2, bytesOf(33, 1)),
  'schema',
  '8.2',
  ['C8', 'S3'],
  TS,
)
rej(
  'r2-payment-commitment-31-bytes',
  'Payment commitment of 31 bytes.',
  dmPay(4, bytesOf(31, 1)),
  'schema',
  '8.2',
  ['T4'],
  TS,
)
rej(
  'r2-payment-commitment-33-bytes',
  'Payment commitment of 33 bytes.',
  dmPay(4, bytesOf(33, 1)),
  'schema',
  '8.2',
  ['T4'],
  TS,
)
rej(
  'r2-payment-txid-empty',
  'Empty transaction id.',
  dmPay(1, new Uint8Array(0)),
  'schema',
  '8.2',
  ['S3'],
  TS,
)
rej(
  'r2-payment-txid-129-bytes',
  'Transaction id of 129 bytes.',
  dmPay(1, bytesOf(129, 1)),
  'schema',
  '8.2',
  ['S3'],
  TS,
)
rej(
  'r2-payment-address-129-bytes',
  'Payment address of 129 bytes.',
  dmPay(3, bytesOf(129, 1)),
  'schema',
  '8.2',
  ['S9'],
  TS,
)
const sigWith = (n: number) =>
  attestationFrame(statementFrame(), [
    new Map([...sig(acct2(1)), [2, bytesOf(n, 1)]]),
  ])
rej(
  'r2-signature-513-bytes',
  'A 513-byte signature exceeds the entry bound.',
  sigWith(513),
  'schema',
  '8.2',
  ['S2b'],
  NOP,
)
rej(
  'r2-signature-512-bytes-wrong-length',
  '512 bytes pass the CDDL bound; algorithm 16 then needs exactly 64.',
  sigWith(512),
  'unsupported',
  '8.3',
  ['S2b'],
  NOP,
)
rej(
  'r2-signature-empty',
  'An empty signature.',
  sigWith(0),
  'schema',
  '8.2',
  ['S2b'],
  NOP,
)

// Depth accounting of every required-child path. Each child is a schema-2 frame whose unknown
// field 9 nests arrays: the child's payload map sits at depth D, so `32 - D` array levels fit.
// (Any change to the depth offset used when opening that child flips exactly one of each pair.)
const nestedArrays = (levels: number): Encodable => {
  let v: Encodable = []
  for (let i = 1; i < levels; i++) v = [v]
  return v
}
const deep = (payload: Fields, levels: number) =>
  new Map([...payload, [9, nestedArrays(levels)]])
type Fields = Map<number, Encodable>
const child2 = (type: number, payload: Fields, levels: number) =>
  fr(type, deep(payload, levels), 2, 1)
const pair = (
  id: string,
  what: string,
  max: number,
  build: (levels: number) => Uint8Array,
  o: Opts,
) => {
  acc(
    `r2-depth-${id}-at-limit`,
    `${what}: ${max} nested levels reach depth 32 exactly.`,
    build(max),
    ['R1'],
    o,
  )
  rej(
    `r2-depth-${id}-one-over`,
    `${what}: ${max + 1} nested levels reach depth 33.`,
    build(max + 1),
    'resource',
    '7',
    ['R1'],
    { ...o, source: 'typescript' },
  )
}
// Root envelope depth 1, payload map 2: a child in a byte string of the payload map has its
// envelope at depth 3 and its payload map at depth 4, leaving 28 levels.
pair(
  't1-child-t5',
  'type-1 to type-5 child',
  28,
  n => deliveryFrame({ payloadFrame: child2(5, type5Payload(), n) }),
  {},
)
pair(
  't2-child-t4',
  'type-2 to type-4 child',
  28,
  n => attestationFrame(child2(4, statementPayload(), n), [sig(acct2(1))]),
  { prior: null },
)
pair(
  't6-child-t8',
  'type-6 to type-8 child',
  28,
  n =>
    fr(
      6,
      M([
        [0, NET],
        [1, bytesOf(16, 7)],
        [2, child2(8, revision8([textItem()]), n)],
        [3, bytesOf(32, 1)],
      ]),
    ),
  {},
)
// type-4 key-transition entry: payload map 2, transitions array 3, entry map 4, child envelope 5,
// child payload map 6, leaving 26 levels.
pair(
  't4-transition-t7',
  'type-4 key-transition child',
  26,
  n =>
    fr(
      4,
      statementPayload({
        transitions: [
          transition(
            child2(
              7,
              M([
                [0, NET],
                [1, acct2(1)],
                [2, acct2(1)],
                [3, 6n],
                [4, acct2(2)],
              ]),
              n,
            ),
          ),
        ],
      }),
    ),
  { prior: null },
)
// message-item array: payload map 2, items array 3, child envelope 4, child payload map 5,
// leaving 27 levels.
pair(
  't8-item-t17',
  'type-8 message item',
  27,
  n => fr(8, revision8([child2(17, M([[0, 'x']]), n)])),
  {},
)
pair(
  't16-item-t17',
  'type-16 message item',
  27,
  n => fr(16, M([[0, [child2(17, M([[0, 'x']]), n)]]])),
  {},
)

// ---------------------------------------------------------------------------------------------
// Spec clarifications (#182): each vector below pins a reading that the README states explicitly
// after the codec-implementation ambiguity review.
// ---------------------------------------------------------------------------------------------

// Pass A scans an indefinite string before pass B reports it (C5, section 9 passes A and B).
rej(
  'payload-indefinite-text-truncated',
  'A truncated indefinite text string is malformed (pass A), not noncanonical: pass A scans the chunks before pass B calls the indefinite start noncanonical.',
  P('a1 00 7f 61 68'),
  'malformed',
  '7',
  ['C3', 'C5', 'C10'],
  g,
)
rej(
  'payload-indefinite-bytes-chunk-wrong-major',
  'An indefinite byte string holding a text chunk is malformed (pass A).',
  P('a1 00 5f 61 68 ff'),
  'malformed',
  '7',
  ['C3', 'C5', 'C10'],
  g,
)
rej(
  'payload-indefinite-string-nested-chunk',
  'An indefinite byte string whose chunk is itself indefinite is malformed (pass A).',
  P('a1 00 5f 5f 41 01 ff ff'),
  'malformed',
  '7',
  ['C3', 'C5', 'C10'],
  g,
)

// C7: the u64 bound is unreachable for unsigned values; the i64 lower bound is reachable.
const seconds = (n: bigint) => ts(n, 0)
acc(
  't4-timestamp-seconds-i64-min',
  'Timestamp seconds -2^63, the i64 minimum: accepted (C7).',
  fr(4, withField(statementPayload(), 3, seconds(-9223372036854775808n))),
  ['C7'],
  { prior: null },
)
rej(
  't4-timestamp-seconds-below-i64-min',
  'Timestamp seconds -2^63-1: a negative integer that still fits a CBOR head but not an i64, a schema error at 8.2 (C7).',
  framePayload(
    patchBytes(
      encodeCanonical(
        withField(statementPayload(), 3, seconds(-9223372036854775808n)),
      ),
      hex('3b7fffffffffffffff'),
      hex('3b8000000000000000'),
    ),
    4,
  ),
  'schema',
  '8.2',
  ['C7'],
  { prior: null },
)

// framed-object `.size (9..)`: a short embedded child is a parent schema error (8.2).
rej(
  't1-payload-frame-8-bytes',
  'A required child of 8 bytes violates the framed-object size bound: schema at the parent stage 8.2, never the child stage 2 frame error.',
  deliveryFrame({ payloadFrame: type5Frame().slice(0, 8) }),
  'schema',
  '8.2',
  ['F3', 'S8'],
  TS,
)
rej(
  't1-payload-frame-9-bytes-empty-body',
  'A required child of exactly 9 bytes (valid header, declared length 0) passes the size bound; its empty body is truncated CBOR at the child stage 5.',
  deliveryFrame({ payloadFrame: body('') }),
  'malformed',
  '5',
  ['F3', 'S8'],
  TS,
)

// S2b for key-transition entries (type 4 fields 1-3), at stage 8.3.
const transitionWith = (field: number, value: Encodable) =>
  fr(
    4,
    statementPayload({
      transitions: [withField(transition(transitionStatement()), field, value)],
    }),
  )
rej(
  't4-transition-algorithm-key-type-mismatch',
  'A key-transition entry with algorithm 1 and an Ed25519 (key type 2) signer: unsupported at 8.3, as for a type-2 signature entry (S2b).',
  transitionWith(1, 1),
  'unsupported',
  '8.3',
  ['S2a', 'S2b'],
  { ...TS, prior: null },
)
rej(
  't4-transition-signature-length-mismatch',
  'A key-transition entry with algorithm 16 and a 63-byte signature: unsupported at 8.3 (S2b).',
  transitionWith(3, bytesOf(63, 9)),
  'unsupported',
  '8.3',
  ['S2b'],
  { ...TS, prior: null },
)
rej(
  't4-transition-algorithm-unallocated',
  'A key-transition entry with unallocated algorithm 99: unsupported at 8.3 (S2a).',
  transitionWith(1, 99),
  'unsupported',
  '8.3',
  ['S2a', 'S2b'],
  { ...TS, prior: null },
)

// C12 / V6.3: the frame containing a map decides whether its wildcard is open.
const factExtra = withField(fact(1_700_000_100, 0, 1, bytesOf(10, 1)), 9, 7)
acc(
  'v6-nested-wildcard-journal-fact-schema2-accept',
  'Type 3 at schema 2 (min_reader 1): a journal fact, a map nested in the payload, carries an undeclared key 9; the frame is read as a newer compatible schema, so the wildcard is open (C12, V6.3).',
  fr(3, checkpointPayload({ facts: [factExtra] }), 2, 1),
  ['C12', 'V6.3'],
)
rej(
  'v6-nested-wildcard-journal-fact-schema1-reject',
  'The same nested key at exact schema 1 is a schema error at 8.2 (C12).',
  fr(3, checkpointPayload({ facts: [factExtra] }), 1, 1),
  'schema',
  '8.2',
  ['C12'],
  TS,
)
rej(
  'v6-nested-closed-map-schema2-reject',
  'Type 3 at schema 2: an opaque-section map (no wildcard) with an undeclared key stays closed at every schema version (C12).',
  fr(
    3,
    checkpointPayload({
      sections: [withField(section(1, 1, bytesOf(12, 3)), 9, 1)],
    }),
    2,
    1,
  ),
  'schema',
  '8.2',
  ['C12'],
  TS,
)
rej(
  'v6-parent-newer-schema-does-not-open-child-wildcard',
  'A type-2 root at schema 2 (V6.3) wrapping a type-4 child at exact schema 1 whose relay binding has an undeclared key: the child frame decides, so its wildcard is closed (schema at the child stage 8.2, C12).',
  fr(
    2,
    M([
      [
        0,
        fr(
          4,
          statementPayload({
            relays: [withField(relay(1), 9, 1), relay(2)],
          }),
        ),
      ],
      [1, [sig(acct2(1))]],
    ]),
    2,
    1,
  ),
  'schema',
  '8.2',
  ['C12', 'V6.3'],
  { ...TS, prior: null },
)

// S10 is a type-2 parent check: a type-4 root alone has no prior statement.
acc(
  'sem-t4-root-with-transition-alone-accepted',
  "A type-4 root validated by itself is not checked against S10: it may carry a transition (field 5) that a type-2 bootstrap would reject. The transition (revision 6 against statement revision 5) is accepted only because the link check lives in S10, which runs only in a type-2 parent's stage 9.",
  fr(4, statementPayload({ transitions: [transition(transitionStatement())] })),
  ['S10'],
  { prior: null },
)

// R2 applies to any root, not only type 1 (charged at 8.4).
acc(
  'limit-type16-root-total-256',
  'Type-16 root holding one container of 255 texts: 256 opened items in all.',
  fr(16, M([[0, [containerItem(items(255))]]])),
  ['R2'],
)
rej(
  'limit-type16-root-total-257',
  'Type-16 root holding one container of 256 texts: the 257th opened item exceeds the total (charged at 8.4).',
  fr(16, M([[0, [containerItem(items(256))]]])),
  'resource',
  '8.4',
  ['R2'],
  TS,
)

// The retention flag only permits retention (F2, section 10).
acc(
  'frame-only-version1-accepts-with-retention-allowed',
  'A version-1 frame under the frame operation is accepted even where opaque retention is allowed: the flag never turns an interpretable frame into a retain.',
  hi,
  ['F2'],
  { ...fo, retention: true },
)
