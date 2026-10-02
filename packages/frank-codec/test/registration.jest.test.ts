// The account-registration corpus (docs/protocol/cbor/vectors/account-registration.json, README
// section 11) and the pure-value vectors: schema-3 dispatch, the M2/M3/M6 mappings, and the
// stage-10.6 signature verification, including the evidence that its T5 network binding is real.
import * as fs from 'fs'
import * as path from 'path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
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
  it('has 28 cases in the standard manifest format', () => {
    expect(CORPUS.format).toBe('frank-cbor-v1-vectors')
    expect(CORPUS.cases.length).toBe(28)
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

  it('rejects a timestamp whose nanoseconds are not a ms multiple (M2)', () => {
    expect(() => joinMs(0n, 1n)).toThrow(RangeError)
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

  it('the first failing entry in document order decides the 10.6 category', () => {
    // Take the minimal record, append a second, allocated-but-unverifiable algorithm-16
    // entry after the (corrupted) algorithm-1 entry: sorted, and the algorithm-1 failure
    // comes first, so the outcome is cryptographic, not the later unsupported.
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
      category: 'cryptographic',
      stage: '10.6',
    })
    // With the first entry left valid, the same second entry is the first failure: unsupported.
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
