// The account-registration corpus (docs/protocol/cbor/vectors/account-registration.json, README
// section 11) and the pure-value vectors: schema-3 dispatch, the M2/M3/M6 mappings, and the
// stage-10.6 signature verification, including the evidence that its T5 network binding is real.
import * as fs from 'fs'
import * as path from 'path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import * as codec from '../src'
import {
  FrankCodecError,
  FrankContextError,
  addressFromCompressedPubkey,
  addressFromUncompressedPubkey,
  contentHash,
  decodeCanonical,
  defaultContext,
  directorySignatureDigest,
  encodeFrame,
  expiryTimestamp,
  fromHex,
  joinMs,
  keyTransitionSignatureDigest,
  splitMs,
  splitTimestampMs,
  toHex,
  uncompressedPubkeyXy,
  validateFrame,
  verifyAlgorithm1,
} from '../src'
import type { Encodable, Operation, Timestamp, ValidationContext } from '../src'
import { M, deliveryFrame } from '../fixtures/builders'
import { checkManifest } from '../fixtures/checker'
import type { ManifestCase } from '../fixtures/manifest'

const DOCS = path.resolve(__dirname, '../../../docs/protocol/cbor')
const CORPUS: Manifest = JSON.parse(
  fs.readFileSync(
    path.join(DOCS, 'vectors', 'account-registration.json'),
    'utf8',
  ),
)
const VALUES = JSON.parse(
  fs.readFileSync(
    path.join(DOCS, 'vectors', 'account-registration-values.json'),
    'utf8',
  ),
)
const README = fs.readFileSync(path.join(DOCS, 'README.md'), 'utf8')

const EXPECTED_CASE_IDS = [
  'reg-fixture-testnet-statement-typed',
  'reg-fixture-mainnet-statement-typed',
  'reg-fixture-testnet-update-typed',
  'reg-fixture-v63-profile-retained',
  'reg-alg16-recognized-typed',
  'reg-t4-key-32-bytes',
  'reg-t4-key-uncompressed-65',
  'reg-t2-sig-7-bytes',
  'reg-t2-algorithm-unallocated-99',
  'reg-t2-alg1-keytype3',
  'reg-t4-schema2-carries-profile',
  'reg-t4-schema1-carries-profile',
  'reg-t4-network-uppercase',
  'reg-t4-noncanonical-statement',
  'reg-s10a2-schema-downgrade',
  'reg-t4-headers-unsorted',
  'reg-t4-headers-duplicate',
  'reg-fixture-testnet-full',
  'reg-fixture-testnet-minimal-full',
  'reg-fixture-mainnet-full',
  'reg-fixture-testnet-update-full',
  'reg-crypto-sig-mutation',
  'reg-crypto-wrong-network',
  'reg-crypto-wrong-domain',
  'reg-crypto-malformed-der',
  'reg-crypto-high-s',
  'reg-crypto-subject-not-point',
  'reg-unsupported-alg16-entry',
  'reg-t2a-rust-known-answer-full',
  'reg-m7-transition-precedes-corrupt-outer',
]

interface Manifest {
  format: string
  cases: ManifestCase[]
}

type CorpusCtx = {
  operation: Operation
  route_byte_limit: number
  reader_version: number
  supported_schemas: Array<{ type_id: number; schema_version: number }>
  opaque_retention_allowed: boolean
  payment_policy?: unknown
  decrypted_frame_hex?: string | null
  recipient_directory_state?: unknown
  prior_directory_statement_frame_hex?: string | null
}

const caseById = new Map(CORPUS.cases.map(c => [c.id, c]))

function contextOf(id: string): ValidationContext {
  const c = caseById.get(id)
  if (!c) throw new Error(`no case ${id}`)
  const v = c.validation_context as unknown as CorpusCtx
  return {
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
  }
}

function mustGet(id: string): ManifestCase {
  const c = caseById.get(id)
  if (!c) throw new Error(`no case ${id}`)
  return c
}

const frameOf = (id: string): Uint8Array => fromHex(mustGet(id).frame_hex)

interface Observed {
  kind: 'accept' | 'reject'
  category?: string
  stage?: string
  typeId?: number
  schemaVersion?: number
  contentHashHex?: string
}

function observe(frame: Uint8Array, ctx: ValidationContext): Observed {
  try {
    const r = validateFrame(frame, ctx)
    if (r.kind !== 'parsed') throw new Error(`unexpected ${r.kind} result`)
    const out: Observed = {
      kind: 'accept',
      typeId: r.typeId,
      schemaVersion: r.schemaVersion,
    }
    if (ctx.operation === 'typed' || ctx.operation === 'full') {
      out.contentHashHex = toHex(contentHash(r))
    }
    return out
  } catch (e) {
    if (!(e instanceof FrankCodecError)) throw e
    return { kind: 'reject', category: e.category, stage: e.stage }
  }
}

describe('the account-registration corpus (README section 11, M9)', () => {
  it('has the exact standard-manifest case inventory', () => {
    expect(CORPUS.format).toBe('frank-cbor-v1-vectors')
    expect(CORPUS.cases.map(c => c.id)).toEqual(EXPECTED_CASE_IDS)
    expect(VALUES.manifest_case_ids).toEqual(EXPECTED_CASE_IDS)
    expect(checkManifest(CORPUS, README)).toEqual([])
  })

  for (const c of CORPUS.cases) {
    it(c.id, () => {
      const got = observe(frameOf(c.id), contextOf(c.id))
      if (c.expectation === 'reject') {
        expect(got).toEqual({
          kind: 'reject',
          category: c.error_category,
          stage: c.error_stage,
        })
      } else {
        expect(got.kind).toBe(c.expectation)
        expect([got.typeId, got.schemaVersion]).toEqual([
          c.type_id,
          c.schema_version,
        ])
        expect(got.contentHashHex).toBe(c.content_hash_hex)
      }
    })
  }

  it('keeps the exact complete frame bytes of every accepted case', () => {
    for (const c of CORPUS.cases) {
      if (c.expectation !== 'accept') continue
      const r = validateFrame(frameOf(c.id), contextOf(c.id))
      if (r.kind !== 'parsed') throw new Error(c.id)
      expect(toHex(r.frame)).toBe(c.frame_hex)
    }
  })
})

describe('schema-version dispatch of the type-4 statement (V1/V2, M4)', () => {
  it('a schema-2 reader projects a schema-3 statement through V6.3 and retains field 9', () => {
    const r = validateFrame(
      frameOf('reg-fixture-v63-profile-retained'),
      contextOf('reg-fixture-v63-profile-retained'),
    )
    if (r.kind !== 'parsed' || r.typed?.type !== 2)
      throw new Error('not a parsed type-2')
    expect(r.typed.statementFrame.projection).toBe('newer-schema')
    const st = r.typed.statementFrame.typed
    if (st?.type !== 4) throw new Error('statement not typed')
    expect(st.schemaVersion).toBe(3)
    expect(st.profileEntries).toBeUndefined()
    expect([...st.unknownFields.keys()]).toEqual([9n])
  })

  it('a schema-3 reader types the profile entries in authored order', () => {
    const r = validateFrame(
      frameOf('reg-fixture-testnet-statement-typed'),
      contextOf('reg-fixture-testnet-statement-typed'),
    )
    if (r.kind !== 'parsed' || r.typed?.type !== 2)
      throw new Error('not a parsed type-2')
    expect(r.typed.statementFrame.projection).toBe('exact')
    const st = r.typed.statementFrame.typed
    if (st?.type !== 4) throw new Error('statement not typed')
    expect(st.schemaVersion).toBe(3)
    if (!st.profileEntries) throw new Error('field 9 absent')
    expect(st.profileEntries.map(e => e.kind)).toEqual([
      'display_name',
      'avatar',
    ])
    const [first] = st.profileEntries
    expect(first.headers.map(h => [h.name, h.value])).toEqual([['lang', 'en']])
    expect(toHex(first.body)).toBe('616c696365')
    expect(first.unknownFields.size).toBe(0)
  })

  it('rejects field 9 on a schema-1 or schema-2 statement at 8.2 (C12)', () => {
    for (const id of [
      'reg-t4-schema2-carries-profile',
      'reg-t4-schema1-carries-profile',
    ]) {
      expect(observe(frameOf(id), contextOf(id))).toEqual({
        kind: 'reject',
        category: 'schema',
        stage: '8.2',
      })
    }
  })
})

describe('the M2/M3/M6 pure-value vectors', () => {
  it('pins one Rust-originated T2a known answer used by the shared corpus', () => {
    expect(
      VALUES.key_transition_authorizations.map((v: { id: string }) => v.id),
    ).toEqual(['t2a-rust-secret-2'])
    const v = VALUES.key_transition_authorizations[0]
    const transition = fromHex(v.transition_statement_frame_hex)
    expect(toHex(keyTransitionSignatureDigest(v.network, transition))).toBe(
      v.digest_hex,
    )
    expect(
      verifyAlgorithm1(
        fromHex(v.digest_hex),
        fromHex(v.signature_der_hex),
        fromHex(v.signer_public_key_hex),
      ),
    ).toBe(true)
    const corpusCase = mustGet(v.attestation_case_id)
    expect(
      corpusCase.validation_context.prior_directory_statement_frame_hex,
    ).toBe(v.prior_statement_frame_hex)
    const attestation = decodeEnvelope(fromHex(corpusCase.frame_hex))
    const statement = decodeEnvelope(attestation.statement)
    expect(statement.payload.get(0n)).toBe(v.network)
    const transitions = statement.payload.get(5n) as Map<bigint, unknown>[]
    expect(transitions).toHaveLength(1)
    const entry = transitions[0]
    const signer = entry.get(2n) as Map<bigint, unknown>
    expect(toHex(entry.get(0n) as Uint8Array)).toBe(
      v.transition_statement_frame_hex,
    )
    expect(toHex(signer.get(1n) as Uint8Array)).toBe(v.signer_public_key_hex)
    expect(toHex(entry.get(3n) as Uint8Array)).toBe(v.signature_der_hex)
  })

  it('maps every timestamp vector losslessly (M2)', () => {
    for (const v of VALUES.timestamp_mappings) {
      const ms = BigInt(v.timestamp_ms)
      const got = splitMs(ms)
      expect(got.revision.toString()).toBe(v.revision)
      expect(got.seconds.toString()).toBe(v.seconds)
      expect(String(got.nanoseconds)).toBe(v.nanoseconds)
      expect(joinMs(got.seconds, got.nanoseconds)).toBe(ms)
    }
  })

  it('fails closed on the unencodable negative ms (M2)', () => {
    for (const v of VALUES.timestamp_unencodable) {
      expect(() => splitMs(BigInt(v.timestamp_ms))).toThrow(RangeError)
    }
    expect(() => splitMs(-1n)).toThrow(/unencodable/)
  })

  it('maps every expiry vector with floor semantics (M3)', () => {
    for (const v of VALUES.expiry_mappings) {
      const got: Timestamp = expiryTimestamp(
        BigInt(v.timestamp_ms),
        BigInt(v.ttl_ms),
      )
      expect(got.seconds.toString()).toBe(v.expiry_seconds)
      expect(String(got.nanoseconds)).toBe(v.expiry_nanoseconds)
    }
    const negative: Timestamp = splitTimestampMs(-1500n)
    expect([negative.seconds.toString(), String(negative.nanoseconds)]).toEqual(
      ['-2', '500000000'],
    )
    expect(joinMs(negative.seconds, negative.nanoseconds)).toBe(-1500n)
  })

  it('rejects a timestamp whose nanoseconds could not come from an ms value (M2)', () => {
    expect(() => joinMs(0n, 1n)).toThrow(RangeError)
    expect(() => joinMs(0n, 1_000_000_000n)).toThrow(RangeError)
    expect(() => joinMs(0n, 4_000_000_000n)).toThrow(RangeError)
  })

  it('enforces the signed-i64 timestamp seconds domain (M2)', () => {
    const min = -9_223_372_036_854_775_808n
    const max = 9_223_372_036_854_775_807n
    expect(splitTimestampMs(joinMs(min, 0n))).toEqual({
      seconds: min,
      nanoseconds: 0,
    })
    expect(splitTimestampMs(joinMs(max, 999_000_000n))).toEqual({
      seconds: max,
      nanoseconds: 999_000_000,
    })
    expect(() => joinMs(min - 1n, 0n)).toThrow(RangeError)
    expect(() => joinMs(max + 1n, 0n)).toThrow(RangeError)
  })

  it('derives every address vector (M6)', () => {
    for (const v of VALUES.address_derivations) {
      const compressed = fromHex(v.compressed_pubkey_hex)
      expect(toHex(uncompressedPubkeyXy(compressed))).toBe(
        v.uncompressed_x_y_hex,
      )
      expect(toHex(addressFromCompressedPubkey(compressed))).toBe(v.address_hex)
      expect(
        toHex(
          addressFromUncompressedPubkey(fromHex('04' + v.uncompressed_x_y_hex)),
        ),
      ).toBe(v.address_hex)
    }
  })

  it('rejects garbage keys and wrong lengths (M6)', () => {
    expect(() => uncompressedPubkeyXy(new Uint8Array(32))).toThrow(RangeError)
    expect(() =>
      addressFromUncompressedPubkey(fromHex('02' + '11'.repeat(32))),
    ).toThrow(RangeError)
  })
})

describe('stage 10.6 (full)', () => {
  it('keeps the stage-9-dependent attestation verifier off the public surface', () => {
    expect('verifyDirectoryAttestation' in codec).toBe(false)
  })

  it('rejects a corrupted signature byte in a scratch copy of the minimal record', () => {
    const frame = frameOf('reg-fixture-testnet-minimal-full')
    const mutated = frame.slice()
    mutated[mutated.length - 1] ^= 0x01
    expect(
      observe(mutated, contextOf('reg-fixture-testnet-minimal-full')),
    ).toEqual({
      kind: 'reject',
      category: 'cryptographic',
      stage: '10.6',
    })
  })

  it('binds the T2 digest network to the statement field 0, not ambient state (T5)', () => {
    const c = mustGet('reg-crypto-wrong-network')
    const frame = fromHex(c.frame_hex)
    // Stage 9 accepts this frame: only the network-bound verification rejects it.
    expect(
      observe(frame, {
        ...contextOf('reg-crypto-wrong-network'),
        operation: 'typed',
      }),
    ).toEqual({
      kind: 'accept',
      typeId: 2,
      schemaVersion: 1,
      contentHashHex: expect.any(String),
    })
    const body = decodeEnvelope(frame)
    const statement = body.statement
    const stPayload = decodeEnvelope(statement).payload
    const subject = stPayload.get(1n) as Map<bigint, unknown>
    const key = subject.get(1n) as Uint8Array
    const entry = (body.payload.get(1n) as unknown[])[0] as Map<bigint, unknown>
    const der = entry.get(2n) as Uint8Array
    expect(stPayload.get(0n)).toBe('monad-mainnet')
    // The signature was made over the testnet transcript: an unbound verifier with the
    // ambient testnet network configured would accept this record.
    expect(
      verifyAlgorithm1(
        directorySignatureDigest('monad-testnet', statement),
        der,
        key,
      ),
    ).toBe(true)
    // With the network taken from field 0 (T5) the digest differs and verification fails.
    expect(
      verifyAlgorithm1(
        directorySignatureDigest('monad-mainnet', statement),
        der,
        key,
      ),
    ).toBe(false)
    expect(observe(frame, contextOf('reg-crypto-wrong-network'))).toEqual({
      kind: 'reject',
      category: 'cryptographic',
      stage: '10.6',
    })
  })

  it('fails closed with a context error for a type-1 full root (10.1-10.5 outside this slice)', () => {
    expect(() =>
      validateFrame(deliveryFrame(), {
        ...defaultContext(),
        operation: 'full',
      }),
    ).toThrow(FrankContextError)
  })

  it('reports allocated-but-unverifiable algorithms before any verification runs (M7)', () => {
    // Take the minimal record, append a second, allocated-but-unverifiable algorithm-16
    // entry after the (corrupted) algorithm-1 entry. M7 requires the whole attestation to be
    // unsupported before any signature verification runs.
    const base = frameOf('reg-fixture-testnet-minimal-full')
    const body = decodeEnvelope(base)
    const statements = body.payload.get(0n) as Uint8Array
    const entries = body.payload.get(1n) as unknown[]
    const first = entries[0] as Map<bigint, unknown>
    const corrupted = new Map(first)
    const der = (first.get(2n) as Uint8Array).slice()
    der[der.length - 1] ^= 0x01
    corrupted.set(2n, der)
    const ed25519Signer = M([
      [0, 2],
      [1, new Uint8Array(32).fill(7)],
    ])
    const second = M([
      [0, 16],
      [1, ed25519Signer],
      [2, new Uint8Array(64).fill(3)],
    ])
    const attestation = encodeFrame(
      { typeId: 2, schemaVersion: 1, minReaderVersion: 1 },
      M([
        [0, statements],
        [1, [corrupted as unknown as Encodable, second]],
      ]),
    )
    const ctx = contextOf('reg-fixture-testnet-minimal-full')
    expect(observe(attestation, ctx)).toEqual({
      kind: 'reject',
      category: 'unsupported',
      stage: '10.6',
    })
    // With the first entry left valid, the same second entry is still unsupported.
    const withValidFirst = encodeFrame(
      { typeId: 2, schemaVersion: 1, minReaderVersion: 1 },
      M([
        [0, statements],
        [1, [first as unknown as Encodable, second]],
      ]),
    )
    expect(observe(withValidFirst, ctx)).toEqual({
      kind: 'reject',
      category: 'unsupported',
      stage: '10.6',
    })
  })
})

describe('stage 10.6 verifies the key-transition authorizations (T2a)', () => {
  // Real secp256k1 keys: secret 1 signs the attestation, secret 2 is the prior authority that
  // signs the type-7 transition frame; the subject is the key behind secret 1.
  const subjectSecret = new Uint8Array(32).fill(1)
  const priorSecret = new Uint8Array(32).fill(2)
  const subjectKey = secp256k1.getPublicKey(subjectSecret, true)
  const priorKey = secp256k1.getPublicKey(priorSecret, true)
  const NETWORK = 'monad-testnet'

  const sign = (digest: Uint8Array, secret: Uint8Array): Uint8Array =>
    new Uint8Array(secp256k1.sign(digest, secret).toDERRawBytes())

  const priorStatement = encodeFrame(
    { typeId: 4, schemaVersion: 3, minReaderVersion: 2 },
    M([
      [0, NETWORK],
      [
        1,
        M([
          [0, 1],
          [1, priorKey],
        ]),
      ],
      [2, 9n],
      [
        3,
        M([
          [0, 1_700_000_000],
          [1, 0],
        ]),
      ],
      [
        4,
        [
          M([
            [0, new Uint8Array(16).fill(1)],
            [1, 'https://relay.example/r'],
            [
              2,
              M([
                [0, 1],
                [1, priorKey],
              ]),
            ],
            [
              3,
              M([
                [0, 1_800_000_000],
                [1, 0],
              ]),
            ],
          ]),
        ],
      ],
      [
        8,
        M([
          [0, 1],
          [1, subjectKey],
        ]),
      ],
    ]),
  )
  const transitionStatement = encodeFrame(
    { typeId: 7, schemaVersion: 1, minReaderVersion: 1 },
    M([
      [0, NETWORK],
      [
        1,
        M([
          [0, 1],
          [1, priorKey],
        ]),
      ],
      [
        2,
        M([
          [0, 1],
          [1, priorKey],
        ]),
      ],
      [3, 10n],
      [
        4,
        M([
          [0, 1],
          [1, subjectKey],
        ]),
      ],
    ]),
  )
  const statement = encodeFrame(
    { typeId: 4, schemaVersion: 3, minReaderVersion: 2 },
    M([
      [0, NETWORK],
      [
        1,
        M([
          [0, 1],
          [1, subjectKey],
        ]),
      ],
      [2, 10n],
      [
        3,
        M([
          [0, 1_700_000_100],
          [1, 0],
        ]),
      ],
      [
        4,
        [
          M([
            [0, new Uint8Array(16).fill(2)],
            [1, 'https://relay.example/r'],
            [
              2,
              M([
                [0, 1],
                [1, subjectKey],
              ]),
            ],
            [
              3,
              M([
                [0, 1_800_000_000],
                [1, 0],
              ]),
            ],
          ]),
        ],
      ],
      [
        5,
        [
          M([
            [0, transitionStatement],
            [1, 1],
            [
              2,
              M([
                [0, 1],
                [1, priorKey],
              ]),
            ],
            [
              3,
              sign(
                keyTransitionSignatureDigest(NETWORK, transitionStatement),
                new Uint8Array(32).fill(2),
              ),
            ],
          ]),
        ],
      ],
      [
        8,
        M([
          [0, 1],
          [1, subjectKey],
        ]),
      ],
    ]),
  )
  const attestation = encodeFrame(
    { typeId: 2, schemaVersion: 1, minReaderVersion: 1 },
    M([
      [0, statement],
      [
        1,
        [
          M([
            [0, 1],
            [
              1,
              M([
                [0, 1],
                [1, subjectKey],
              ]),
            ],
            [
              2,
              sign(
                directorySignatureDigest(NETWORK, statement),
                new Uint8Array(32).fill(1),
              ),
            ],
          ]),
        ],
      ],
    ]),
  )
  const ctx: ValidationContext = {
    operation: 'full',
    routeByteLimit: 8_388_617,
    readerVersion: 2,
    supportedSchemas: [
      { typeId: 1, schemaVersion: 1 },
      { typeId: 2, schemaVersion: 1 },
      { typeId: 3, schemaVersion: 1 },
      { typeId: 4, schemaVersion: 3 },
      { typeId: 5, schemaVersion: 1 },
      { typeId: 6, schemaVersion: 1 },
      { typeId: 7, schemaVersion: 1 },
      { typeId: 8, schemaVersion: 1 },
      { typeId: 9, schemaVersion: 1 },
      { typeId: 10, schemaVersion: 1 },
      { typeId: 11, schemaVersion: 1 },
      { typeId: 16, schemaVersion: 1 },
      { typeId: 17, schemaVersion: 1 },
    ],
    opaqueRetentionAllowed: false,
    priorDirectoryStatementFrame: priorStatement,
  }

  it('accepts a record whose transition authorization verifies', () => {
    expect(observe(attestation, ctx)).toEqual({
      kind: 'accept',
      typeId: 2,
      schemaVersion: 1,
      contentHashHex: expect.any(String),
    })
  })

  it('rejects a corrupted transition signature at 10.6', () => {
    const transitionSigBytes = toHex(
      sign(
        keyTransitionSignatureDigest(NETWORK, transitionStatement),
        priorSecret,
      ),
    )
    const corruptedDer = fromHex(transitionSigBytes)
    corruptedDer[corruptedDer.length - 1] ^= 0x01
    const withBadTransition = encodeFrame(
      { typeId: 2, schemaVersion: 1, minReaderVersion: 1 },
      M([
        [0, statement],
        [
          1,
          [
            M([
              [0, 1],
              [
                1,
                M([
                  [0, 1],
                  [1, subjectKey],
                ]),
              ],
              [
                2,
                sign(
                  directorySignatureDigest(NETWORK, statement),
                  subjectSecret,
                ),
              ],
            ]),
          ],
        ],
      ]),
    )
    void withBadTransition
    const badTransitionStatement = encodeFrame(
      { typeId: 4, schemaVersion: 3, minReaderVersion: 2 },
      M([
        [0, NETWORK],
        [
          1,
          M([
            [0, 1],
            [1, subjectKey],
          ]),
        ],
        [2, 10n],
        [
          3,
          M([
            [0, 1_700_000_100],
            [1, 0],
          ]),
        ],
        [
          4,
          [
            M([
              [0, new Uint8Array(16).fill(2)],
              [1, 'https://relay.example/r'],
              [
                2,
                M([
                  [0, 1],
                  [1, subjectKey],
                ]),
              ],
              [
                3,
                M([
                  [0, 1_800_000_000],
                  [1, 0],
                ]),
              ],
            ]),
          ],
        ],
        [
          5,
          [
            M([
              [0, transitionStatement],
              [1, 1],
              [
                2,
                M([
                  [0, 1],
                  [1, priorKey],
                ]),
              ],
              [3, corruptedDer],
            ]),
          ],
        ],
        [
          8,
          M([
            [0, 1],
            [1, subjectKey],
          ]),
        ],
      ]),
    )
    const badAttestation = encodeFrame(
      { typeId: 2, schemaVersion: 1, minReaderVersion: 1 },
      M([
        [0, badTransitionStatement],
        [
          1,
          [
            M([
              [0, 1],
              [
                1,
                M([
                  [0, 1],
                  [1, subjectKey],
                ]),
              ],
              [
                2,
                sign(
                  directorySignatureDigest(NETWORK, badTransitionStatement),
                  subjectSecret,
                ),
              ],
            ]),
          ],
        ],
      ]),
    )
    expect(observe(badAttestation, ctx)).toEqual({
      kind: 'reject',
      category: 'cryptographic',
      stage: '10.6',
    })
  })
})

describe('directory statement spendKeys (field 14)', () => {
  it('parses and validates spendKeys for both secp256k1 (keyType 1) and ed25519 (keyType 2)', () => {
    const secpKey = new Uint8Array(33)
    secpKey[0] = 0x02
    secpKey.fill(0x11, 1)

    const edKey = new Uint8Array(32).fill(0x22)

    const statement = encodeFrame(
      { typeId: 4, schemaVersion: 3, minReaderVersion: 2 },
      M([
        [0, 'monad-testnet'],
        [
          1,
          M([
            [0, 1],
            [1, secpKey],
          ]),
        ],
        [2, 1000n],
        [
          3,
          M([
            [0, 100n],
            [1, 0],
          ]),
        ],
        [
          4,
          [
            M([
              [0, new Uint8Array(16)],
              [1, 'https://relay1.frank.example'],
              [
                2,
                M([
                  [0, 1],
                  [1, secpKey],
                ]),
              ],
              [
                3,
                M([
                  [0, 2000n],
                  [1, 0],
                ]),
              ],
            ]),
          ],
        ],
        [
          8,
          M([
            [0, 1],
            [1, secpKey],
          ]),
        ],
        [
          14,
          [
            M([
              [0, 1],
              [1, secpKey],
            ]),
            M([
              [0, 2],
              [1, edKey],
            ]),
          ],
        ],
      ]),
    )

    const ctx = defaultContext({ operation: 'typed' })
    const validated = validateFrame(statement, ctx)
    expect(validated.kind).toBe('parsed')
    if (validated.kind === 'parsed' && validated.typed?.type === 4) {
      expect(validated.typed.spendKeys).toBeDefined()
      expect(validated.typed.spendKeys?.length).toBe(2)
      expect(validated.typed.spendKeys?.[0]).toEqual({
        keyType: 1,
        keyBytes: secpKey,
      })
      expect(validated.typed.spendKeys?.[1]).toEqual({
        keyType: 2,
        keyBytes: edKey,
      })
    }
  })

  it('rejects unsorted spendKeys at stage 9 semantic', () => {
    const secpKey = new Uint8Array(33)
    secpKey[0] = 0x02
    secpKey.fill(0x11, 1)

    const edKey = new Uint8Array(32).fill(0x22)

    // edKey (keyType 2) placed before secpKey (keyType 1)
    const statement = encodeFrame(
      { typeId: 4, schemaVersion: 3, minReaderVersion: 2 },
      M([
        [0, 'monad-testnet'],
        [
          1,
          M([
            [0, 1],
            [1, secpKey],
          ]),
        ],
        [2, 1000n],
        [
          3,
          M([
            [0, 100n],
            [1, 0],
          ]),
        ],
        [
          4,
          [
            M([
              [0, new Uint8Array(16)],
              [1, 'https://relay1.frank.example'],
              [
                2,
                M([
                  [0, 1],
                  [1, secpKey],
                ]),
              ],
              [
                3,
                M([
                  [0, 2000n],
                  [1, 0],
                ]),
              ],
            ]),
          ],
        ],
        [
          8,
          M([
            [0, 1],
            [1, secpKey],
          ]),
        ],
        [
          14,
          [
            M([
              [0, 2],
              [1, edKey],
            ]),
            M([
              [0, 1],
              [1, secpKey],
            ]),
          ],
        ],
      ]),
    )

    const ctx = defaultContext({ operation: 'typed' })
    expect(() => validateFrame(statement, ctx)).toThrow(FrankCodecError)
    try {
      validateFrame(statement, ctx)
    } catch (e: any) {
      expect(e.category).toBe('semantic')
      expect(e.stage).toBe('9')
      expect(e.location).toBe('root/payload.14')
    }
  })

  it('rejects spendKey with wrong key length at stage 8.2 schema', () => {
    const secpKey = new Uint8Array(33)
    secpKey[0] = 0x02
    secpKey.fill(0x11, 1)

    const badEdKey = new Uint8Array(33).fill(0x22) // keyType 2 expects 32 bytes

    const statement = encodeFrame(
      { typeId: 4, schemaVersion: 3, minReaderVersion: 2 },
      M([
        [0, 'monad-testnet'],
        [
          1,
          M([
            [0, 1],
            [1, secpKey],
          ]),
        ],
        [2, 1000n],
        [
          3,
          M([
            [0, 100n],
            [1, 0],
          ]),
        ],
        [
          4,
          [
            M([
              [0, new Uint8Array(16)],
              [1, 'https://relay1.frank.example'],
              [
                2,
                M([
                  [0, 1],
                  [1, secpKey],
                ]),
              ],
              [
                3,
                M([
                  [0, 2000n],
                  [1, 0],
                ]),
              ],
            ]),
          ],
        ],
        [
          8,
          M([
            [0, 1],
            [1, secpKey],
          ]),
        ],
        [
          14,
          [
            M([
              [0, 2],
              [1, badEdKey],
            ]),
          ],
        ],
      ]),
    )

    const ctx = defaultContext({ operation: 'typed' })
    expect(() => validateFrame(statement, ctx)).toThrow(FrankCodecError)
    try {
      validateFrame(statement, ctx)
    } catch (e: any) {
      expect(e.category).toBe('schema')
      expect(e.stage).toBe('8.2')
    }
  })
})

describe('directory statement canonicalUsername (field 14, ticket #972)', () => {
  const secpKey = new Uint8Array(33)
  secpKey[0] = 0x02
  secpKey.fill(0x11, 1)

  const makeStatement = (handle: any) =>
    encodeFrame(
      { typeId: 4, schemaVersion: 3, minReaderVersion: 2 },
      M([
        [0, 'monad-testnet'],
        [
          1,
          M([
            [0, 1],
            [1, secpKey],
          ]),
        ],
        [2, 1000n],
        [
          3,
          M([
            [0, 100n],
            [1, 0],
          ]),
        ],
        [
          4,
          [
            M([
              [0, new Uint8Array(16)],
              [1, 'https://relay1.frank.example'],
              [
                2,
                M([
                  [0, 1],
                  [1, secpKey],
                ]),
              ],
              [
                3,
                M([
                  [0, 2000n],
                  [1, 0],
                ]),
              ],
            ]),
          ],
        ],
        [
          8,
          M([
            [0, 1],
            [1, secpKey],
          ]),
        ],
        [14, handle],
      ]),
    )

  it('parses valid handles across min/max bounds and allowed character sets', () => {
    const validHandles = [
      'abc',
      'a_1',
      'z-9',
      '007',
      'alice',
      'bob-smith',
      'charlie_123',
      'a' + 'b'.repeat(30) + 'c', // 32 characters
      '0'.repeat(32),
    ]

    for (const handle of validHandles) {
      const statement = makeStatement(handle)
      const res = validateFrame(
        statement,
        defaultContext({ operation: 'typed' }),
      )
      expect(res.kind).toBe('parsed')
      if (res.kind !== 'parsed') throw new Error('not parsed')
      expect(res.typed?.type).toBe(4)
      if (res.typed?.type === 4) {
        expect(res.typed.canonicalUsername).toBe(handle)
      }
    }
  })

  it('rejects handles violating the semantic regex constraint at stage 9', () => {
    const invalidHandles = [
      '-abc', // starts with hyphen
      '_abc', // starts with underscore
      'Alice', // uppercase
      'ALICE', // uppercase
      'aliCe', // uppercase
      'alice@frank', // disallowed char
      'alice.smith', // dot not allowed
      'alice smith', // space not allowed
      'alice!123', // punctuation
    ]

    for (const handle of invalidHandles) {
      const statement = makeStatement(handle)
      const ctx = defaultContext({ operation: 'typed' })
      expect(() => validateFrame(statement, ctx)).toThrow(FrankCodecError)
      try {
        validateFrame(statement, ctx)
      } catch (e: any) {
        expect(e.category).toBe('semantic')
        expect(e.stage).toBe('9')
        expect(e.location).toBe('root/payload.14')
      }
    }
  })

  it('rejects length bounds and non-string types at stage 8.2 schema', () => {
    const schemaFailures = [
      '', // length 0
      'a', // length 1
      'ab', // length 2
      'a'.repeat(33), // length 33
      12345, // integer
      true, // boolean
    ]

    for (const handle of schemaFailures) {
      const statement = makeStatement(handle)
      const ctx = defaultContext({ operation: 'typed' })
      expect(() => validateFrame(statement, ctx)).toThrow(FrankCodecError)
      try {
        validateFrame(statement, ctx)
      } catch (e: any) {
        expect(e.category).toBe('schema')
        expect(e.stage).toBe('8.2')
      }
    }
  })

  it('round-trips through statement builder', () => {
    const relays = [
      {
        relayId: new Uint8Array(16).fill(1),
        endpoint: 'https://relay1.frank.example',
        identity: { keyType: 1, keyBytes: secpKey },
        expiry: { seconds: 2000n, nanoseconds: 0 },
        unknownFields: new Map(),
      },
    ]

    const encodedWithHandle = codec.encodeDirectoryStatement({
      network: 'monad-testnet',
      subject: { keyType: 1, keyBytes: secpKey },
      revision: 1000n,
      timestamp: { seconds: 100n, nanoseconds: 0 },
      relays,
      stampKey: { keyType: 1, keyBytes: secpKey },
      canonicalUsername: 'alice-01',
    })

    const parsedWith = validateFrame(
      encodedWithHandle,
      defaultContext({ operation: 'typed' }),
    )
    if (parsedWith.kind !== 'parsed' || parsedWith.typed?.type !== 4) {
      throw new Error('expected parsed type 4')
    }
    expect(parsedWith.typed.canonicalUsername).toBe('alice-01')

    const encodedWithoutHandle = codec.encodeDirectoryStatement({
      network: 'monad-testnet',
      subject: { keyType: 1, keyBytes: secpKey },
      revision: 1000n,
      timestamp: { seconds: 100n, nanoseconds: 0 },
      relays,
      stampKey: { keyType: 1, keyBytes: secpKey },
    })

    const parsedWithout = validateFrame(
      encodedWithoutHandle,
      defaultContext({ operation: 'typed' }),
    )
    if (parsedWithout.kind !== 'parsed' || parsedWithout.typed?.type !== 4) {
      throw new Error('expected parsed type 4')
    }
    expect(parsedWithout.typed.canonicalUsername).toBeUndefined()
  })

  it('verifies signature on Type 2 DirectoryAttestation carrying canonicalUsername (stage 10.6)', () => {
    const secret = new Uint8Array(32).fill(7)
    const pubKey = secp256k1.getPublicKey(secret, true)
    const NETWORK = 'monad-testnet'

    const relays = [
      {
        relayId: new Uint8Array(16).fill(2),
        endpoint: 'https://relay1.frank.example',
        identity: { keyType: 1, keyBytes: pubKey },
        expiry: { seconds: 2000n, nanoseconds: 0 },
        unknownFields: new Map(),
      },
    ]

    const type4Statement = codec.encodeDirectoryStatement({
      network: NETWORK,
      subject: { keyType: 1, keyBytes: pubKey },
      revision: 500n,
      timestamp: { seconds: 100n, nanoseconds: 0 },
      relays,
      stampKey: { keyType: 1, keyBytes: pubKey },
      canonicalUsername: 'valid-agent_42',
    })

    const digest = directorySignatureDigest(NETWORK, type4Statement)
    const sig = new Uint8Array(secp256k1.sign(digest, secret).toDERRawBytes())

    const attestation = encodeFrame(
      { typeId: 2, schemaVersion: 1, minReaderVersion: 1 },
      M([
        [0, type4Statement],
        [
          1,
          [
            M([
              [0, 1], // alg 1
              [
                1,
                M([
                  [0, 1],
                  [1, pubKey],
                ]),
              ],
              [2, sig],
            ]),
          ],
        ],
      ]),
    )

    const res = validateFrame(
      attestation,
      defaultContext({ operation: 'full' }),
    )
    expect(res.kind).toBe('parsed')
    if (res.kind !== 'parsed') throw new Error('not parsed')
    expect(res.typed?.type).toBe(2)
    if (res.typed?.type === 2) {
      const st = res.typed.statementFrame.typed
      if (st?.type === 4) {
        expect(st.canonicalUsername).toBe('valid-agent_42')
      } else {
        throw new Error('inner statement not typed')
      }
    }

    // Tampered username breaks the signature
    const tamperedStatement = codec.encodeDirectoryStatement({
      network: NETWORK,
      subject: { keyType: 1, keyBytes: pubKey },
      revision: 500n,
      timestamp: { seconds: 100n, nanoseconds: 0 },
      relays,
      stampKey: { keyType: 1, keyBytes: pubKey },
      canonicalUsername: 'other-agent_42',
    })

    const badAttestation = encodeFrame(
      { typeId: 2, schemaVersion: 1, minReaderVersion: 1 },
      M([
        [0, tamperedStatement],
        [
          1,
          [
            M([
              [0, 1],
              [
                1,
                M([
                  [0, 1],
                  [1, pubKey],
                ]),
              ],
              [2, sig],
            ]),
          ],
        ],
      ]),
    )

    expect(() =>
      validateFrame(badAttestation, defaultContext({ operation: 'full' })),
    ).toThrow(FrankCodecError)
    try {
      validateFrame(badAttestation, defaultContext({ operation: 'full' }))
    } catch (e: any) {
      expect(e.category).toBe('cryptographic')
      expect(e.stage).toBe('10.6')
    }
  })
})

/** Minimal envelope reader for the raw fixture frames used by these tests. */
function decodeEnvelope(frame: Uint8Array): {
  typeId: number
  schemaVersion: number
  minReaderVersion: number
  payload: Map<bigint, unknown>
  statement: Uint8Array
} {
  const body = decodeCanonical(frame.subarray(9)) as Map<bigint, unknown>
  const payloadBytes = body.get(3n) as Uint8Array
  const payload = decodeCanonical(payloadBytes) as Map<bigint, unknown>
  return {
    typeId: body.get(0n) as number,
    schemaVersion: body.get(1n) as number,
    minReaderVersion: body.get(2n) as number,
    payload,
    statement: payload.get(0n) as Uint8Array,
  }
}
