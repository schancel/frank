import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  contentHash,
  decodeCanonical,
  defaultContext,
  encodeCanonical,
  encodeFrame,
  FrankCodecError,
  FrankContextError,
  fromHex,
  ParsedFrame,
  previewDirectoryContext,
  toHex,
  validateFrame,
  verifyPreviewDirectoryEvidence,
  wrapFrame,
} from '../src'
import type { Encodable } from '../src'
import {
  DIRECTORY_ATTESTATION,
  DIRECTORY_PREVIEW_RELAY,
  DIRECTORY_STATEMENT,
  TIMESTAMP,
  TYPE_DIRECTORY_ATTESTATION,
  TYPE_DIRECTORY_STATEMENT,
} from '../src/constants'

const root = resolve(__dirname, '../../..')
const corpus = JSON.parse(
  readFileSync(
    resolve(root, 'docs/protocol/cbor/vectors/directory-preview.json'),
    'utf8',
  ),
) as {
  network: string
  records: {
    id: string
    type4_hex: string
    type2_hex: string
    t1: string
    t2_digest: string
    old_reader: string
    expected: { category: string; stage?: string }
  }[]
}
const record = (id: string) => {
  const found = corpus.records.find(r => r.id === id)
  if (!found) throw new Error(`missing record ${id}`)
  return found
}
const parsed = (hex: string) =>
  validateFrame(fromHex(hex), previewDirectoryContext()) as ParsedFrame
const bootstrap = () =>
  new Map(
    decodeCanonical(parsed(record('bootstrap').type4_hex).payloadBytes) as Map<
      bigint,
      Encodable
    >,
  )
const statement = (
  payload: Map<bigint, Encodable>,
  schemaVersion = 4,
  minReaderVersion = 4,
) =>
  encodeFrame(
    { typeId: TYPE_DIRECTORY_STATEMENT, schemaVersion, minReaderVersion },
    payload,
  )
const expectError = (f: () => unknown, category: string, stage: string) => {
  try {
    f()
    throw new Error('unexpected acceptance')
  } catch (e) {
    expect(e).toBeInstanceOf(FrankCodecError)
    expect(e).toMatchObject({ category, stage })
  }
}

describe('provisional directory codec, not directory admission', () => {
  test('derived corpus preserves all reviewed proposal frames and hashes exactly', () => {
    const proposal = JSON.parse(
      readFileSync(
        resolve(root, 'docs/protocol/proposals/suite1-directory/vectors.json'),
        'utf8',
      ),
    ) as { records: typeof corpus.records }
    for (const original of proposal.records) {
      expect({ ...record(original.id), expected: undefined }).toEqual({
        ...original,
        expected: undefined,
      })
    }
  })
  test.each(corpus.records)(
    '$id: independent shared signed-evidence outcome',
    r => {
      const run = () =>
        verifyPreviewDirectoryEvidence(fromHex(r.type2_hex), corpus.network)
      if (r.expected.category !== 'accept') {
        expectError(
          run,
          r.expected.category,
          r.expected.stage ?? 'missing stage',
        )
        return
      }
      const evidence = run()
      expect(toHex(evidence.statementFrame.frame)).toBe(r.type4_hex)
      expect(toHex(evidence.attestationFrame.frame)).toBe(r.type2_hex)
      expect(toHex(evidence.statementHash)).toBe(r.t1)
      expect(toHex(evidence.signatureDigest)).toBe(r.t2_digest)
      expect(encodeCanonical(evidence.statementFrame.payload)).toEqual(
        evidence.statementFrame.payloadBytes,
      )
      expect(
        encodeCanonical(
          decodeCanonical(evidence.attestationFrame.frame.subarray(9)),
        ),
      ).toEqual(evidence.attestationFrame.frame.subarray(9))
    },
  )

  test.each(corpus.records)(
    '$id: frozen default-reader result unchanged',
    r => {
      const run = () =>
        validateFrame(
          fromHex(r.type2_hex),
          defaultContext({ operation: 'full' }),
        )
      if (r.old_reader === 'accept') expect(run().kind).toBe('parsed')
      else {
        try {
          run()
          throw new Error('unexpected old-reader acceptance')
        } catch (e) {
          expect(e).toBeInstanceOf(FrankCodecError)
          expect(e).toMatchObject({ category: r.old_reader })
        }
      }
    },
  )

  test('default reader and explicitly old readers reject the required v4 child', () => {
    expect(defaultContext().readerVersion).toBe(2)
    expect(
      defaultContext().supportedSchemas.find(
        s => s.typeId === TYPE_DIRECTORY_STATEMENT,
      )?.schemaVersion,
    ).toBe(3)
    // raw-cbor-key: reader-version list, not a map entry
    for (const readerVersion of [1, 2, 3])
      for (const field of ['type4_hex', 'type2_hex'] as const) {
        expectError(
          () =>
            validateFrame(
              fromHex(record('bootstrap')[field]),
              defaultContext({ readerVersion }),
            ),
          'unsupported',
          '7',
        )
      }
  })

  test('full preview validation fails closed; history cannot be smuggled into evidence context', () => {
    for (const field of ['type4_hex', 'type2_hex'] as const) {
      expectError(
        () =>
          validateFrame(
            fromHex(record('bootstrap')[field]),
            defaultContext({ readerVersion: 4, operation: 'full' }),
          ),
        'unsupported',
        '7',
      )
      const ctx = previewDirectoryContext()
      ctx.operation = 'full'
      expect(() =>
        validateFrame(fromHex(record('bootstrap')[field]), ctx),
      ).toThrow(FrankContextError)
    }
    const ctx = previewDirectoryContext()
    ctx.priorDirectoryStatementFrame = fromHex(record('bootstrap').type4_hex)
    expect(() =>
      validateFrame(fromHex(record('renew').type2_hex), ctx),
    ).toThrow(FrankContextError)
    expect(() =>
      verifyPreviewDirectoryEvidence(
        fromHex(record('bootstrap').type2_hex),
        '',
      ),
    ).toThrow(FrankContextError)
  })

  test('evidence exposes separate typed roles and exact uint64 values without claiming lifecycle acceptance', () => {
    const e = verifyPreviewDirectoryEvidence(
      fromHex(record('bootstrap').type2_hex),
      corpus.network,
    )
    expect(e.kind).toBe('preview-directory-signed-evidence')
    expect(e.statement.preview.mailboxKeyGeneration).toBe(0n)
    expect(e.statement.preview.predecessor).toBeNull()
    expect(e.statement.preview.messageDhKey.keyBytes).not.toEqual(
      e.statement.subject.keyBytes,
    )
    const max = verifyPreviewDirectoryEvidence(
      fromHex(record('revision-max').type2_hex),
      corpus.network,
    )
    expect(max.statement.revision).toBe(18446744073709551615n)
    // These signed records fail runtime history/clock/relay policy. The facade promises none.
    for (const id of [
      'expired',
      'future-issue',
      'wrong-relay',
      'wrong-predecessor',
      'changed-key-same-generation',
    ])
      expect(
        verifyPreviewDirectoryEvidence(
          fromHex(record(id).type2_hex),
          corpus.network,
        ).kind,
      ).toBe(e.kind)
  })

  test('preview priors cannot authorize legacy updates or changed-subject transitions', () => {
    const legacy = JSON.parse(
      readFileSync(
        resolve(root, 'docs/protocol/cbor/vectors/account-registration.json'),
        'utf8',
      ),
    ) as {
      cases: {
        id: string
        frame_hex: string
        validation_context: { prior_directory_statement_frame_hex: string }
      }[]
    }
    const transition = legacy.cases.find(
      c => c.id === 'reg-t2a-rust-known-answer-full',
    )
    if (!transition) throw new Error('missing legacy transition control')
    const oldPriorBytes = fromHex(
      transition.validation_context.prior_directory_statement_frame_hex,
    )
    const oldPrior = validateFrame(
      oldPriorBytes,
      defaultContext(),
    ) as ParsedFrame
    if (oldPrior.typed?.type !== TYPE_DIRECTORY_STATEMENT)
      throw new Error('legacy prior')
    const p = bootstrap()
    // Use public fixture roles distinct from the legacy authority (scalar 2).
    p.set(
      BigInt(DIRECTORY_STATEMENT.messageDhKey),
      p.get(BigInt(DIRECTORY_STATEMENT.subject)) as Encodable,
    )
    p.set(
      BigInt(DIRECTORY_STATEMENT.subject),
      (oldPrior.payload as Map<bigint, Encodable>).get(
        BigInt(DIRECTORY_STATEMENT.subject),
      ) as Encodable,
    )
    p.set(BigInt(DIRECTORY_STATEMENT.revision), oldPrior.typed.revision)
    p.set(
      BigInt(DIRECTORY_STATEMENT.predecessorHash),
      oldPrior.typed.revision === 0n ? null : new Uint8Array(32),
    )
    for (const operation of ['typed', 'full'] as const) {
      const ctx = {
        ...previewDirectoryContext(),
        operation,
        priorDirectoryStatementFrame: oldPriorBytes,
      }
      const control = validateFrame(
        fromHex(transition.frame_hex),
        ctx,
      ) as ParsedFrame
      if (
        control.typed?.type !== TYPE_DIRECTORY_ATTESTATION ||
        control.typed.statementFrame.typed?.type !== TYPE_DIRECTORY_STATEMENT
      )
        throw new Error('transition')
      expect(control.typed.statementFrame.typed.subject.keyBytes).not.toEqual(
        oldPrior.typed.subject.keyBytes,
      )
      // raw-cbor-key: schema-version list, not a map entry
      for (const schema of [4, 5]) {
        ctx.priorDirectoryStatementFrame = statement(p, schema)
        expect(
          validateFrame(
            ctx.priorDirectoryStatementFrame,
            previewDirectoryContext(),
          ).kind,
        ).toBe('parsed')
        expect(() => validateFrame(fromHex(transition.frame_hex), ctx)).toThrow(
          FrankContextError,
        )
      }
      ctx.priorDirectoryStatementFrame = fromHex(record('bootstrap').type4_hex)
      expect(() =>
        validateFrame(fromHex(record('old-schema3').type2_hex), ctx),
      ).toThrow(FrankContextError)
    }
  })

  test('future optional bytes stay authenticated and retained; old schemas cannot acquire v4 fields', () => {
    const e = verifyPreviewDirectoryEvidence(
      fromHex(record('optional-future').type2_hex),
      corpus.network,
    )
    expect(e.statementFrame.projection).toBe('newer-schema')
    // raw-cbor-key: key 100 is an undeclared future field
    expect(e.statement.unknownFields.has(100n)).toBe(true)
    expect(contentHash(e.statementFrame)).toEqual(e.statementHash)
    // raw-cbor-key: schema-version list, not a map entry
    for (const schema of [2, 3])
      expectError(
        () =>
          validateFrame(
            statement(bootstrap(), schema, 2),
            previewDirectoryContext(),
          ),
        'schema',
        '8.2',
      )
    for (const field of [
      DIRECTORY_STATEMENT.keyTransitions,
      DIRECTORY_STATEMENT.recoveryAuthorities,
      DIRECTORY_STATEMENT.profileEntries,
    ].map(BigInt)) {
      const p = bootstrap()
      p.set(field, [])
      expectError(
        () => validateFrame(statement(p, 5), previewDirectoryContext()),
        'schema',
        '8.2',
      )
    }
  })

  test('required-field shape, canonical and duplicate-map checks reuse the existing parser', () => {
    for (const key of [
      DIRECTORY_STATEMENT.network,
      DIRECTORY_STATEMENT.subject,
      DIRECTORY_STATEMENT.revision,
      DIRECTORY_STATEMENT.timestamp,
      DIRECTORY_STATEMENT.relays,
      DIRECTORY_STATEMENT.expiry,
      DIRECTORY_STATEMENT.stampKey,
      DIRECTORY_STATEMENT.messageDhKey,
      DIRECTORY_STATEMENT.mailboxKeyGeneration,
      DIRECTORY_STATEMENT.stampKeyGeneration,
      DIRECTORY_STATEMENT.predecessorHash,
    ].map(BigInt)) {
      const p = bootstrap()
      p.delete(key)
      expectError(
        () => validateFrame(statement(p), previewDirectoryContext()),
        'schema',
        '8.2',
      )
    }
    const p = bootstrap()
    p.set(
      BigInt(DIRECTORY_STATEMENT.mailboxKeyGeneration),
      18446744073709551616n,
    )
    expect(() => statement(p)).toThrow()
    for (const payload of [
      fromHex('a200000000'),
      fromHex('a1180000'),
      fromHex('a100'),
    ]) {
      const f = encodeFrame(
        {
          typeId: TYPE_DIRECTORY_STATEMENT,
          schemaVersion: 4,
          minReaderVersion: 4,
        },
        { bytes: payload },
      )
      expect(() => validateFrame(f, previewDirectoryContext())).toThrow(
        FrankCodecError,
      )
    }
  })

  test('bare v4 frame ceiling is inclusive and does not tighten old-schema limits', () => {
    const p = bootstrap()
    // raw-cbor-key: key 100 is an undeclared future field (padding)
    p.set(100n, new Uint8Array(262_144))
    const excess = statement(p, 5).length - 262_144
    // raw-cbor-key: key 100 is an undeclared future field (padding)
    p.set(100n, new Uint8Array(262_144 - excess))
    const exact = statement(p, 5)
    expect(exact.length).toBe(262_144)
    expect(validateFrame(exact, previewDirectoryContext()).kind).toBe('parsed')
    // raw-cbor-key: key 100 is an undeclared future field (padding)
    p.set(100n, new Uint8Array(262_145 - excess))
    expectError(
      () => validateFrame(statement(p, 5), previewDirectoryContext()),
      'resource',
      '8.1',
    )
    const old = statement(p, 5, 2)
    expect(validateFrame(old, defaultContext()).kind).toBe('parsed')
    expectError(
      () =>
        verifyPreviewDirectoryEvidence(new Uint8Array(262_145), corpus.network),
      'resource',
      '1',
    )
    const body = decodeCanonical(exact.subarray(9))
    expect(wrapFrame(encodeCanonical(body))).toEqual(exact)
  })

  test('unchanged wrapper limit and cross-schema signature replay are enforced', () => {
    const wrap = (child: Uint8Array) => {
      const p = new Map(
        parsed(record('bootstrap').type2_hex).payload as Map<bigint, Encodable>,
      )
      p.set(BigInt(DIRECTORY_ATTESTATION.statementFrame), child)
      return encodeFrame(
        {
          typeId: TYPE_DIRECTORY_ATTESTATION,
          schemaVersion: 1,
          minReaderVersion: 1,
        },
        p,
      )
    }
    expectError(
      () =>
        verifyPreviewDirectoryEvidence(
          wrap(statement(bootstrap(), 5)),
          corpus.network,
        ),
      'cryptographic',
      '10.6',
    )
    const p = bootstrap()
    // raw-cbor-key: key 100 is an undeclared future field (padding)
    p.set(100n, new Uint8Array(262_144))
    const overhead = wrap(statement(p, 5)).length - 262_144
    // raw-cbor-key: key 100 is an undeclared future field (padding)
    p.set(100n, new Uint8Array(262_144 - overhead))
    const exact = wrap(statement(p, 5))
    expect(exact.length).toBe(262_144)
    expect(validateFrame(exact, previewDirectoryContext()).kind).toBe('parsed')
    expectError(
      () => verifyPreviewDirectoryEvidence(exact, corpus.network),
      'cryptographic',
      '10.6',
    )
    // raw-cbor-key: key 100 is an undeclared future field (padding)
    p.set(100n, new Uint8Array(262_145 - overhead))
    expectError(
      () => validateFrame(wrap(statement(p, 5)), previewDirectoryContext()),
      'resource',
      '8.1',
    )
  })

  test('uint64 generations and nanosecond validity boundaries stay exact', () => {
    const p = bootstrap()
    p.set(BigInt(DIRECTORY_STATEMENT.revision), 18446744073709551615n)
    p.set(
      BigInt(DIRECTORY_STATEMENT.mailboxKeyGeneration),
      18446744073709551615n,
    )
    p.set(BigInt(DIRECTORY_STATEMENT.stampKeyGeneration), 18446744073709551615n)
    p.set(BigInt(DIRECTORY_STATEMENT.predecessorHash), new Uint8Array(32))
    const result = validateFrame(
      statement(p),
      previewDirectoryContext(),
    ) as ParsedFrame
    if (result.typed?.type !== TYPE_DIRECTORY_STATEMENT)
      throw new Error('statement')
    expect(result.typed.preview?.mailboxKeyGeneration).toBe(
      18446744073709551615n,
    )
    expect(result.typed.preview?.stampKeyGeneration).toBe(18446744073709551615n)
    // Exactly 366 days is accepted; one nanosecond more is refused. The relay binding covers both,
    // so only the validity cap decides.
    const issued = (
      p.get(BigInt(DIRECTORY_STATEMENT.timestamp)) as Map<bigint, Encodable>
    ).get(BigInt(TIMESTAMP.seconds)) as bigint
    const year = new Map<bigint, Encodable>([
      [BigInt(TIMESTAMP.seconds), issued + 31_622_400n],
      [BigInt(TIMESTAMP.nanoseconds), 0n],
    ])
    const relay = new Map(
      (
        p.get(BigInt(DIRECTORY_STATEMENT.relays)) as Map<bigint, Encodable>[]
      )[0] as Map<bigint, Encodable>,
    )
    relay.set(
      BigInt(DIRECTORY_PREVIEW_RELAY.expiry),
      new Map<bigint, Encodable>([
        [BigInt(TIMESTAMP.seconds), issued + 31_622_401n],
        [BigInt(TIMESTAMP.nanoseconds), 0n],
      ]),
    )
    p.set(BigInt(DIRECTORY_STATEMENT.relays), [relay])
    p.set(BigInt(DIRECTORY_STATEMENT.expiry), year)
    expect(validateFrame(statement(p), previewDirectoryContext()).kind).toBe(
      'parsed',
    )
    const expiry = new Map(year)
    expiry.set(BigInt(TIMESTAMP.nanoseconds), 1n)
    p.set(BigInt(DIRECTORY_STATEMENT.expiry), expiry)
    expectError(
      () => validateFrame(statement(p), previewDirectoryContext()),
      'semantic',
      '9',
    )
  })
})
