/* eslint-env browser, node */
// Runs inside a browser page or a bare `vm` context: it may use only ES2020 built-ins plus the
// FrankCodec bundle. It executes the committed manifest and a few API checks and returns a
// JSON-serializable summary.
const frankBrowserCheckInstall = function () {
  function check(codec, manifest) {
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

    let accepted = 0
    let rejected = 0
    let retained = 0
    for (const c of manifest.cases) {
      const ctx = ctxOf(c)
      let kind
      let category
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
        rejected++
        if (category !== c.error_category) fail(c.id, 'category ' + category)
      } else if (kind === 'retain') {
        retained++
        if (codec.toHex(r.frame) !== c.retained_frame_hex)
          fail(c.id, 'retained bytes differ')
      } else {
        accepted++
        if (c.content_hash_hex !== undefined) {
          const h = codec.toHex(codec.contentHash(r))
          if (h !== c.content_hash_hex) fail(c.id, 'content hash differs')
        }
      }
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

    // No Node globals leaked into this realm.
    const g = globalThis
    const leaked = ['process', 'Buffer', 'require', 'module', 'global'].filter(
      n => typeof g[n] !== 'undefined',
    )
    return {
      total: manifest.cases.length,
      accepted,
      rejected,
      retained,
      failures,
      leakedNodeGlobals: leaked,
      ok: failures.length === 0,
    }
  }
  globalThis.frankBrowserCheck = check
}
frankBrowserCheckInstall()
