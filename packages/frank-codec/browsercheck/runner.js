/* eslint-env browser, node */
// Runs inside a browser page or a bare `vm` context: it may use only ES2020 built-ins plus the
// FrankCodec bundle. It executes the committed manifest and a few API checks and returns a
// JSON-serializable summary.
const frankBrowserCheckInstall = function () {
  function check(
    codec,
    manifest,
    rustOrigin,
    interoperability,
    registration,
    registrationValues,
  ) {
    rustOrigin = rustOrigin || globalThis.FRANK_RUST_ORIGIN
    interoperability = interoperability || globalThis.FRANK_INTEROPERABILITY
    registration = registration || globalThis.FRANK_REGISTRATION
    registrationValues =
      registrationValues || globalThis.FRANK_REGISTRATION_VALUES
    const failures = []
    const fail = (id, msg) => failures.push(id + ': ' + msg)

    const ctxOf = c => {
      const v = c.validation_context
      return codec.defaultContext({
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
            : codec.fromHex(v.prior_directory_statement_frame_hex),
      })
    }

    const counts = {
      typescript: { total: 0, accepted: 0, rejected: 0, retained: 0 },
      rust: { total: 0, accepted: 0, rejected: 0, retained: 0 },
    }
    const runManifest = (source, document) => {
      const count = counts[source]
      count.total = document.cases.length
      for (const c of document.cases) {
        const ctx = ctxOf(c)
        let kind
        let category
        let stage
        let r
        try {
          r = codec.validateFrame(codec.fromHex(c.frame_hex), ctx)
          kind = r.kind === 'retained' ? 'retain' : 'accept'
        } catch (e) {
          if (!(e instanceof codec.FrankCodecError)) {
            fail(c.id, 'unexpected exception ' + e)
            continue
          }
          kind = 'reject'
          category = e.category
          stage = e.stage
        }
        if (kind !== c.expectation) {
          fail(
            c.id,
            'expected ' +
              c.expectation +
              ', got ' +
              kind +
              ' ' +
              (category || ''),
          )
          continue
        }
        if (kind === 'reject') {
          count.rejected++
          if (category !== c.error_category) fail(c.id, 'category ' + category)
          if (c.error_stage === undefined)
            fail(c.id, 'reject without error_stage')
          else if (stage !== c.error_stage) fail(c.id, 'stage ' + stage)
        } else if (kind === 'retain') {
          count.retained++
          if (codec.toHex(r.frame) !== c.retained_frame_hex)
            fail(c.id, 'retained bytes differ')
        } else {
          count.accepted++
          if (codec.toHex(r.frame) !== c.frame_hex)
            fail(c.id, 'complete frame bytes differ')
          const body = r.frame.subarray(9)
          if (
            codec.toHex(codec.encodeCanonical(codec.decodeCanonical(body))) !==
            codec.toHex(body)
          )
            fail(c.id, 'envelope body bytes differ')
          if (r.kind === 'parsed') {
            if (
              codec.toHex(
                codec.encodeCanonical(codec.decodeCanonical(r.payloadBytes)),
              ) !== codec.toHex(r.payloadBytes)
            )
              fail(c.id, 'payload bytes differ')
          }
          if (c.content_hash_hex !== undefined) {
            const h = codec.toHex(codec.contentHash(r))
            if (h !== c.content_hash_hex) fail(c.id, 'content hash differs')
          }
        }
      }
    }
    runManifest('typescript', manifest)
    runManifest('rust', rustOrigin)

    // The active Forum corpus intentionally gives no new content identity to read frames.
    // Consume through the public facade in the same bare VM and real Chrome harness.
    const forum = globalThis.FRANK_FORUM
    for (const f of forum.frames) {
      const context = codec.defaultContext({
        readerVersion: f.context?.readerVersion ?? 2,
        opaqueRetentionAllowed: f.context?.retention ?? false,
      })
      if (f.context?.topicSchema)
        context.supportedSchemas = context.supportedSchemas.map(s =>
          s.typeId === 9 ? { ...s, schemaVersion: f.context.topicSchema } : s,
        )
      try {
        const r = codec.validateFrame(codec.fromHex(f.hex), context)
        if (!f.valid) fail(f.id, 'accepted invalid Forum frame')
        if (codec.toHex(r.frame) !== f.hex) fail(f.id, 'Forum bytes differ')
        if (f.retained && r.kind !== 'retained') fail(f.id, 'not retained')
        if (f.t1 && codec.toHex(codec.contentHash(r)) !== f.t1)
          fail(f.id, 'Forum T1 differs')
        if (
          f.t7 &&
          codec.toHex(
            codec.topicVoteCommitment('monad-testnet', codec.contentHash(r)),
          ) !== f.t7
        )
          fail(f.id, 'Forum T7 differs')
      } catch (e) {
        if (!(e instanceof codec.FrankCodecError) || f.valid)
          fail(f.id, 'unexpected Forum rejection ' + e)
        else if (f.error && `${e.category}@${e.stage}` !== f.error)
          fail(f.id, 'Forum rejection boundary differs')
      }
    }

    const byId = (document, id) => document.cases.find(c => c.id === id)
    const unknownItem = n =>
      codec.encodeFrame(
        { typeId: 0xffff0001, schemaVersion: 1, minReaderVersion: 1 },
        new Map([[0, 'future item ' + n]]),
      )
    for (const id of interoperability.typescript_origin_ids) {
      if (!byId(manifest, id)) fail(id, 'missing TypeScript-origin proof case')
    }
    for (const id of interoperability.typescript_retention_ids) {
      if (!byId(manifest, id)) fail(id, 'missing TypeScript retention case')
    }
    const tsAdditive = byId(
      manifest,
      interoperability.typescript_retention_ids[0],
    )
    if (tsAdditive) {
      const r = codec.validateFrame(
        codec.fromHex(tsAdditive.frame_hex),
        ctxOf(tsAdditive),
      )
      if (r.kind !== 'parsed' || !r.payload.has(1n))
        fail(tsAdditive.id, 'additive field 1 was not retained')
    }
    for (const id of interoperability.typescript_retention_ids.slice(1)) {
      const c = byId(manifest, id)
      if (!c || !c.frame_hex.includes('1affff0001'))
        fail(id, 'nested opaque future frame missing')
    }
    const rustExpected = [
      [1, 'rust-additive-direct'],
      [2, 'rust-additive-directory'],
      [3, 'rust-additive-checkpoint'],
    ]
    for (const [index, id] of interoperability.rust_origin_ids.entries()) {
      const c = byId(rustOrigin, id)
      if (!c) {
        fail(id, 'missing Rust-origin proof case')
        continue
      }
      const r = codec.validateFrame(codec.fromHex(c.frame_hex), ctxOf(c))
      if (r.kind !== 'parsed' || !r.payload.has(100n)) {
        fail(id, 'additive field 100 was not retained')
        continue
      }
      const [expectedType, expectedUnknown] = rustExpected[index]
      if (r.projection !== 'newer-schema')
        fail(id, 'typed projection was not newer-schema')
      if (!r.typed || r.typed.type !== expectedType) {
        fail(id, 'unexpected typed payload')
        continue
      }
      if (r.typed.unknownFields.get(100n) !== expectedUnknown)
        fail(id, 'typed unknown field 100 differs')
      if (r.typed.type === 1) {
        const recipient = r.typed.payloadFrame.typed
        const encrypted =
          recipient && recipient.type === 5
            ? codec.validateFrame(recipient.ciphertext, codec.defaultContext())
            : undefined
        const revision =
          encrypted &&
          encrypted.kind === 'parsed' &&
          encrypted.typed?.type === 6
            ? encrypted.typed.revisionFrame.typed
            : undefined
        const container =
          revision && revision.type === 8 ? revision.items[1] : undefined
        const opaque =
          container &&
          container.kind === 'parsed' &&
          container.typed?.type === 16
            ? container.typed.items[1]
            : undefined
        if (
          !opaque ||
          opaque.kind !== 'retained' ||
          codec.toHex(opaque.frame) !== codec.toHex(unknownItem(1))
        )
          fail(id, 'typed nested opaque child bytes differ')
      }
      if (r.typed.type === 3) {
        if (
          codec.toHex(r.typed.facts[1].payload) !== codec.toHex(unknownItem(2))
        )
          fail(id, 'typed opaque fact bytes differ')
        if (
          !r.typed.sections ||
          codec.toHex(r.typed.sections[1].value) !== codec.toHex(unknownItem(3))
        )
          fail(id, 'typed opaque section bytes differ')
      }
    }

    const rejectCategories = {}
    for (const c of manifest.cases) {
      if (c.expectation !== 'reject') continue
      rejectCategories[c.error_category] =
        (rejectCategories[c.error_category] || 0) + 1
    }
    const hostile = interoperability.hostile_manifest
    if (hostile.case_count !== manifest.cases.length)
      fail('hostile', 'case count differs')
    if (hostile.reject_count !== counts.typescript.rejected)
      fail('hostile', 'reject count differs')
    for (const category of Object.keys(hostile.reject_category_counts)) {
      if (
        hostile.reject_category_counts[category] !== rejectCategories[category]
      )
        fail('hostile', 'category count differs for ' + category)
    }

    const crypto = interoperability.crypto
    const original = codec.fromHex(crypto.frame_hex)
    const mutated = codec.fromHex(crypto.mutated_frame_hex)
    const differences = [...original.keys()].filter(
      i => original[i] !== mutated[i],
    )
    if (differences.length !== 1 || differences[0] !== crypto.mutation_offset)
      fail('crypto', 'mutation is not the committed one-byte change')
    const originalParsed = codec.validateFrame(original, codec.defaultContext())
    const mutatedParsed = codec.validateFrame(mutated, codec.defaultContext())
    if (originalParsed.kind !== 'parsed' || mutatedParsed.kind !== 'parsed') {
      fail('crypto', 'complete frame did not parse')
    } else {
      const checks = [
        [codec.toHex(codec.contentHash(originalParsed)), crypto.t1_hex, 'T1'],
        [
          codec.toHex(codec.contentHash(mutatedParsed)),
          crypto.mutated_t1_hex,
          'mutated T1',
        ],
        [
          codec.toHex(
            codec.messageContentDigest(codec.fromHex(crypto.t1a_frame_hex)),
          ),
          crypto.t1a_hex,
          'T1a',
        ],
      ]
      const t3 = codec.recipientPayloadDigest(crypto.network, original)
      const mutatedT3 = codec.recipientPayloadDigest(crypto.network, mutated)
      checks.push(
        [codec.toHex(t3), crypto.t3_hex, 'T3'],
        [codec.toHex(mutatedT3), crypto.mutated_t3_hex, 'mutated T3'],
        [
          codec.toHex(codec.paymentCommitment(t3, crypto.payment_child_index)),
          crypto.t4_hex,
          'T4',
        ],
        [
          codec.toHex(
            codec.paymentCommitment(mutatedT3, crypto.payment_child_index),
          ),
          crypto.mutated_t4_hex,
          'mutated T4',
        ],
      )
      for (const [got, want, label] of checks)
        if (got !== want) fail('crypto', label + ' differs')

      const reversePayload = new Map([...originalParsed.payload].reverse())
      const reverseFrame = codec.encodeFrame(
        {
          typeId: originalParsed.typeId,
          schemaVersion: originalParsed.schemaVersion,
          minReaderVersion: originalParsed.minReaderVersion,
        },
        reversePayload,
      )
      if (codec.toHex(reverseFrame) !== crypto.frame_hex)
        fail('crypto', 'insertion orders did not converge')
    }

    // Encoder: the README worked example, insertion order, and bigint.
    const hi = codec.encodeFrame(
      { typeId: 17, schemaVersion: 1, minReaderVersion: 1 },
      new Map([[0, 'hi']]),
    )
    if (codec.toHex(hi) !== '46524e4b010000000ea40011010102010345a100626869') {
      fail('encode', 'worked example bytes differ')
    }
    const a = codec.encodeCanonical(
      new Map([
        [2, 'b'],
        [0, 'a'],
        [1, 'c'],
      ]),
    )
    const b = codec.encodeCanonical(
      new Map([
        [0, 'a'],
        [1, 'c'],
        [2, 'b'],
      ]),
    )
    if (codec.toHex(a) !== codec.toHex(b))
      fail('encode', 'insertion order changed the bytes')
    const big = codec.decodeCanonical(codec.fromHex('1bffffffffffffffff'))
    if (typeof big !== 'bigint' || big !== 18446744073709551615n)
      fail('decode', 'u64 max not a bigint')

    // Account-registration corpus (README section 11): every case, including the full
    // operation's stage-10.6 signature verification, plus the pure-value M2/M3/M6 vectors.
    const registrationIds = registration.cases.map(c => c.id)
    if (
      registrationIds.length !== 30 ||
      registrationIds.join('\n') !==
        registrationValues.manifest_case_ids.join('\n')
    )
      fail('registration', 'exact case inventory differs')
    const registrationCounts = { total: 0, accepted: 0, rejected: 0 }
    for (const c of registration.cases) {
      registrationCounts.total++
      let kind
      let category
      let stage
      let r
      try {
        r = codec.validateFrame(codec.fromHex(c.frame_hex), ctxOf(c))
        kind = r.kind === 'retained' ? 'retain' : 'accept'
      } catch (e) {
        if (!(e instanceof codec.FrankCodecError)) {
          fail(c.id, 'unexpected exception ' + e)
          continue
        }
        kind = 'reject'
        category = e.category
        stage = e.stage
      }
      if (kind !== c.expectation) {
        fail(
          c.id,
          'expected ' +
            c.expectation +
            ', got ' +
            kind +
            ' ' +
            (category || ''),
        )
        continue
      }
      if (kind === 'reject') {
        registrationCounts.rejected++
        if (category !== c.error_category) fail(c.id, 'category ' + category)
        if (stage !== c.error_stage) fail(c.id, 'stage ' + stage)
      } else {
        registrationCounts.accepted++
        if (codec.toHex(r.frame) !== c.frame_hex)
          fail(c.id, 'complete frame bytes differ')
        if (codec.toHex(codec.contentHash(r)) !== c.content_hash_hex)
          fail(c.id, 'content hash differs')
      }
    }
    if (
      registrationCounts.accepted === 0 ||
      registrationCounts.rejected === 0
    ) {
      fail('registration', 'implausible outcome split')
    }
    const t2a = registrationValues.key_transition_authorizations
    if (t2a.length !== 1 || t2a[0].id !== 't2a-rust-secret-2') {
      fail('T2a', 'exact known-answer inventory differs')
    } else {
      const v = t2a[0]
      const digest = codec.keyTransitionSignatureDigest(
        v.network,
        codec.fromHex(v.transition_statement_frame_hex),
      )
      if (codec.toHex(digest) !== v.digest_hex) fail(v.id, 'T2a digest differs')
      if (
        !codec.verifyAlgorithm1(
          digest,
          codec.fromHex(v.signature_der_hex),
          codec.fromHex(v.signer_public_key_hex),
        )
      )
        fail(v.id, 'T2a signature does not verify')
      const corpusCase = byId(registration, v.attestation_case_id)
      if (!corpusCase) {
        fail(v.id, 'linked attestation case is missing')
      } else {
        if (
          corpusCase.validation_context.prior_directory_statement_frame_hex !==
          v.prior_statement_frame_hex
        )
          fail(v.id, 'linked prior statement differs')
        const attestationEnvelope = codec.decodeCanonical(
          codec.fromHex(corpusCase.frame_hex).subarray(9),
        )
        const attestation = codec.decodeCanonical(attestationEnvelope.get(3n))
        const statementFrame = attestation.get(0n)
        const statementEnvelope = codec.decodeCanonical(
          statementFrame.subarray(9),
        )
        const statement = codec.decodeCanonical(statementEnvelope.get(3n))
        const transitions = statement.get(5n)
        if (statement.get(0n) !== v.network)
          fail(v.id, 'linked network differs')
        if (!Array.isArray(transitions) || transitions.length !== 1) {
          fail(v.id, 'linked transition inventory differs')
        } else {
          const entry = transitions[0]
          const signer = entry.get(2n)
          if (codec.toHex(entry.get(0n)) !== v.transition_statement_frame_hex)
            fail(v.id, 'linked transition statement differs')
          if (codec.toHex(signer.get(1n)) !== v.signer_public_key_hex)
            fail(v.id, 'linked signer key differs')
          if (codec.toHex(entry.get(3n)) !== v.signature_der_hex)
            fail(v.id, 'linked signature differs')
        }
      }
    }
    for (const v of registrationValues.timestamp_mappings) {
      const ms = BigInt(v.timestamp_ms)
      const got = codec.splitMs(ms)
      if (got.revision.toString() !== v.revision)
        fail('M2 ' + v.timestamp_ms, 'revision differs')
      if (got.seconds.toString() !== v.seconds)
        fail('M2 ' + v.timestamp_ms, 'seconds differ')
      if (String(got.nanoseconds) !== v.nanoseconds)
        fail('M2 ' + v.timestamp_ms, 'nanoseconds differ')
      if (codec.joinMs(got.seconds, got.nanoseconds) !== ms)
        fail('M2 ' + v.timestamp_ms, 'round trip differs')
    }
    for (const v of registrationValues.timestamp_unencodable) {
      let threw = false
      try {
        codec.splitMs(BigInt(v.timestamp_ms))
      } catch (e) {
        threw = true
      }
      if (!threw)
        fail('M2 unencodable ' + v.timestamp_ms, 'accepted a negative ms')
    }
    for (const v of registrationValues.expiry_mappings) {
      const got = codec.expiryTimestamp(
        BigInt(v.timestamp_ms),
        BigInt(v.ttl_ms),
      )
      if (got.seconds.toString() !== v.expiry_seconds)
        fail('M3 ' + v.timestamp_ms + '+' + v.ttl_ms, 'seconds differ')
      if (String(got.nanoseconds) !== v.expiry_nanoseconds)
        fail('M3 ' + v.timestamp_ms + '+' + v.ttl_ms, 'nanoseconds differ')
    }
    for (const v of registrationValues.address_derivations) {
      const compressed = codec.fromHex(v.compressed_pubkey_hex)
      if (
        codec.toHex(codec.addressFromCompressedPubkey(compressed)) !==
        v.address_hex
      )
        fail('M6 ' + v.label, 'address differs')
      if (
        codec.toHex(codec.uncompressedPubkeyXy(compressed)) !==
        v.uncompressed_x_y_hex
      )
        fail('M6 ' + v.label, 'uncompressed key differs')
    }

    const g = globalThis
    const leaked = ['process', 'Buffer', 'require', 'module', 'global'].filter(
      n => typeof g[n] !== 'undefined',
    )
    return {
      typescript: counts.typescript,
      rust: counts.rust,
      registration: registrationCounts,
      forum: { total: forum.frames.length },
      interoperability: {
        hostileCases: hostile.case_count,
        mutationOffset: crypto.mutation_offset,
        signatureBytes: codec.fromHex(crypto.signature_der_hex).length,
      },
      failures,
      leakedNodeGlobals: leaked,
      ok: failures.length === 0,
    }
  }
  globalThis.frankBrowserCheck = check
}
frankBrowserCheckInstall()
