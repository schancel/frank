// Offline Option A fixture conversion. Source revision contains public synthetic data only.
// Run from repository root: node packages/frank-codec/scripts/renumber-signed-vectors.cjs [--check]
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '../../..')
const bundled = buildSync({
  entryPoints: [path.join(root, 'packages/frank-codec/src/index.ts')],
  bundle: true,
  platform: 'node',
  write: false,
})
const mod = new Module(__filename, module)
mod.paths = module.paths
mod._compile(bundled.outputFiles[0].text, __filename)
const c = mod.exports
const { secp256k1 } = require('@noble/curves/secp256k1.js')
const { createHash } = require('node:crypto')
const inputs = JSON.parse(
  fs.readFileSync(
    path.join(
      root,
      'packages/frank-codec/fixtures/option-a-signed-inputs.json',
    ),
    'utf8',
  ),
)
const read = name => structuredClone(inputs.corpora[name])
const write = (name, value) => {
  const file = path.join(root, `docs/protocol/cbor/vectors/${name}.json`)
  const text = JSON.stringify(value, null, 2) + '\n'
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(file, 'utf8') !== text)
      throw Error(`${name}: regenerate signed fixtures`)
  } else fs.writeFileSync(file, text)
}
const sha = bytes => createHash('sha256').update(bytes).digest()
const scalar = n => c.fromHex(BigInt(n).toString(16).padStart(64, '0'))
const secrets = new Map()
for (let i = 1; i <= 32; i++) {
  for (const secret of [scalar(i), new Uint8Array(32).fill(i)])
    secrets.set(c.toHex(secp256k1.getPublicKey(secret, true)), secret)
}
const replacements = new Map()
function secretFor(key) {
  const hex = c.toHex(key)
  if (!secrets.has(hex)) {
    const secret = sha(Buffer.from(`frank/option-a/public-fixture/${hex}`))
    const publicKey = secp256k1.getPublicKey(secret, true)
    replacements.set(hex, c.toHex(publicKey))
    secrets.set(c.toHex(publicKey), secret)
    secrets.set(hex, secret)
  }
  return secrets.get(hex)
}
const registration = read('account-registration')
// Collect valid public synthetic signers before converting raw bytes. Invalid points stay invalid.
for (const item of registration.cases) {
  try {
    const envelope = c.decodeCanonical(c.fromHex(item.frame_hex).slice(9))
    const payload = c.decodeCanonical(envelope.get(3n))
    for (const entry of payload.get(1n) || []) {
      if (!(entry instanceof Map)) continue
      const key = entry.get(1n)?.get(1n)
      if (key?.length === 33) {
        try {
          secp256k1.ProjectivePoint.fromHex(key).assertValidity()
          secretFor(key)
        } catch {}
      }
    }
  } catch {}
}
function raw(hex) {
  hex = hex
    .replace(/46524e4b01([0-9a-f]{8})a40004/g, '46524e4b01$1a40001')
    .replace(/46524e4b01([0-9a-f]{8})a40007/g, '46524e4b01$1a40003')
  for (const [before, after] of replacements)
    hex = hex.split(before).join(after)
  return c.fromHex(hex)
}
function envelope(frame) {
  return c.decodeCanonical(frame.slice(9))
}
function payload(frame) {
  return c.decodeCanonical(envelope(frame).get(3n))
}
function frameWith(frame, value) {
  const env = envelope(frame)
  return c.encodeFrame(
    {
      typeId: Number(env.get(0n)),
      schemaVersion: Number(env.get(1n)),
      minReaderVersion: Number(env.get(2n)),
    },
    value,
  )
}
function rustSign(secret, digest) {
  return c.fromHex(
    execFileSync(
      'cargo',
      [
        'run',
        '--quiet',
        '--manifest-path',
        path.join(root, 'backend/cashweb/frank-cbor/Cargo.toml'),
        '--example',
        'sign-fixture',
        '--',
        c.toHex(secret),
        c.toHex(digest),
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .toString()
      .trim(),
  )
}
function signed(frame, id) {
  const env = envelope(frame)
  if (env.get(0n) !== 2n) return frame
  const p = payload(frame)
  let inner = p.get(0n)
  const statement = payload(inner),
    network = statement.get(0n)
  for (const transition of statement.get(5n) || []) {
    if (transition.get(1n) !== 1n) continue
    const signer = transition.get(2n)?.get(1n)
    if (signer?.length !== 33) continue
    if (id === 'reg-t2a-rust-known-answer-full') continue
    transition.set(
      3n,
      secp256k1
        .sign(
          c.keyTransitionSignatureDigest(network, transition.get(0n)),
          secretFor(signer),
        )
        .toDERRawBytes(),
    )
  }
  inner = frameWith(inner, statement)
  p.set(0n, inner)
  for (const entry of p.get(1n)) {
    if (entry.get(0n) !== 1n || entry.get(1n)?.get(0n) !== 1n) continue
    const publicKey = entry.get(1n).get(1n)
    if (id === 'reg-t2-sig-7-bytes') continue
    let digest = c.directorySignatureDigest(network, inner)
    if (id === 'reg-crypto-wrong-network')
      digest = c.directorySignatureDigest('monad-testnet', inner)
    if (id === 'reg-crypto-wrong-domain')
      digest = sha(Buffer.from('wrong-domain'))
    let signature = secp256k1.sign(digest, secretFor(publicKey))
    if (id === 'reg-crypto-high-s')
      signature = new secp256k1.Signature(
        signature.r,
        secp256k1.CURVE.n - signature.s,
      )
    let bytes =
      id === 'rust-origin-bootstrap'
        ? rustSign(secretFor(publicKey), digest)
        : signature.toDERRawBytes()
    if (/sig-mutation|bad-signature|corrupt-outer/.test(id))
      bytes[bytes.length - 1] ^= 1
    if (id === 'reg-crypto-malformed-der') bytes = new Uint8Array(8).fill(1)
    entry.set(2n, bytes)
  }
  return frameWith(frame, p)
}
for (const item of registration.cases) {
  item.type_id = item.type_id === 4 ? 1 : item.type_id
  const ctx = item.validation_context
  for (const s of ctx.supported_schemas)
    s.type_id =
      {
        4: 1,
        7: 3,
        1: 10,
        3: 14,
        5: 11,
        6: 12,
        8: 20,
        9: 40,
        10: 41,
        11: 42,
        16: 21,
        17: 22,
      }[s.type_id] || s.type_id
  ctx.supported_schemas.sort((a, b) => a.type_id - b.type_id)
  if (ctx.prior_directory_statement_frame_hex)
    ctx.prior_directory_statement_frame_hex = c.toHex(
      raw(ctx.prior_directory_statement_frame_hex),
    )
  let frame = raw(item.frame_hex)
  try {
    frame = signed(frame, item.id)
  } catch (error) {
    if (item.expectation !== 'reject' || Number(item.error_stage) >= 10)
      throw error
  }
  item.frame_hex = c.toHex(frame)
  if (item.content_hash_hex) {
    const p = payload(frame)
    const network =
      envelope(frame).get(0n) === 2n ? payload(p.get(0n)).get(0n) : p.get(0n)
    item.content_hash_hex = c.toHex(
      sha(c.commonTranscript('frank/content-hash/v1', network, frame)),
    )
  }
}
const values = read('account-registration-values')
for (const row of values.key_transition_authorizations) {
  row.prior_statement_frame_hex = c.toHex(raw(row.prior_statement_frame_hex))
  row.transition_statement_frame_hex = c.toHex(
    raw(row.transition_statement_frame_hex),
  )
  row.digest_hex = c.toHex(
    c.keyTransitionSignatureDigest(
      row.network,
      c.fromHex(row.transition_statement_frame_hex),
    ),
  )
  row.signature_der_hex = c.toHex(
    rustSign(secrets.get(row.signer_public_key_hex), c.fromHex(row.digest_hex)),
  )
  const item = registration.cases.find(x => x.id === row.attestation_case_id)
  const frame = c.fromHex(item.frame_hex),
    p = payload(frame),
    inner = p.get(0n),
    st = payload(inner)
  // Re-sign the nested key-transition authorization and the enclosing statement.
  st.get(5n)[0].set(3n, c.fromHex(row.signature_der_hex))
  p.set(0n, frameWith(inner, st))
  item.frame_hex = c.toHex(signed(frameWith(frame, p), item.id))
  item.content_hash_hex = c.toHex(
    sha(
      c.commonTranscript(
        'frank/content-hash/v1',
        row.network,
        c.fromHex(item.frame_hex),
      ),
    ),
  )
}
write('account-registration', registration)
write('account-registration-values', values)
// Reuse the authoritative proposal's deterministic definitions without running its CLI.
const proposalSource = path.join(
  root,
  'packages/frank-codec/proposals/suite1-directory/check.ts',
)
const code =
  fs
    .readFileSync(proposalSource, 'utf8')
    .split('const generated = generate()')[0] +
  '\nmodule.exports = generate()\n'
const result = buildSync({
  stdin: {
    contents: code,
    loader: 'ts',
    resolveDir: path.dirname(proposalSource),
    sourcefile: proposalSource,
  },
  bundle: true,
  platform: 'node',
  write: false,
  define: { __dirname: JSON.stringify(path.dirname(proposalSource)) },
})
const proposalModule = new Module(proposalSource, module)
proposalModule.paths = module.paths
proposalModule._compile(result.outputFiles[0].text, proposalSource)
const proposal = proposalModule.exports
const preview = read('directory-preview')
preview.records = preview.records.map(row => {
  if (row.id !== 'rust-origin-bootstrap')
    return {
      ...proposal.records.find(r => r.id === row.id),
      expected: row.expected,
    }
  const base = proposal.records.find(r => r.id === 'bootstrap')
  const outer = signed(c.fromHex(base.type2_hex), row.id)
  return {
    ...base,
    id: row.id,
    type2_hex: c.toHex(outer),
    expected: row.expected,
  }
})
write('directory-preview', preview)
function writePath(file, value) {
  const text = JSON.stringify(value, null, 2) + '\n'
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(file, 'utf8') !== text)
      throw Error(`${file}: regenerate signed fixtures`)
  } else fs.writeFileSync(file, text)
}
writePath(
  path.join(root, 'docs/protocol/proposals/suite1-directory/vectors.json'),
  proposal,
)
const { expected, ...rustOrigin } = preview.records[0]
writePath(
  path.join(
    root,
    'backend/cashweb/frank-cbor/proposals/suite1-directory/rust-origin.json',
  ),
  rustOrigin,
)
// The runtime corpus includes authenticated ciphertext, so regenerate its enclosing chain.
const runtime = read('dm-runtime')
const rv = runtime.runtime_case
rv.statement = c.toHex(raw(rv.statement))
rv.attestation = c.toHex(signed(raw(rv.attestation), 'runtime'))
rv.t1 = c.toHex(
  sha(
    c.commonTranscript(
      'frank/content-hash/v1',
      runtime.network,
      c.fromHex(rv.statement),
    ),
  ),
)
const ctx = c.decodeCanonical(c.fromHex(rv.context))
ctx.set(4n, c.fromHex(rv.t1))
ctx.set(5n, c.fromHex(rv.t1))
ctx.set(13n, 11n)
rv.context = c.toHex(c.encodeCanonical(ctx))
const oldContent = c.fromHex(rv.content),
  content = payload(oldContent)
const oldRevision = content.get(2n),
  revision = payload(oldRevision)
revision.set(
  1n,
  revision.get(1n).map(item => {
    const env = envelope(item)
    return c.encodeFrame(
      {
        typeId: 22,
        schemaVersion: Number(env.get(1n)),
        minReaderVersion: Number(env.get(2n)),
      },
      payload(item),
    )
  }),
)
const newRevision = c.encodeFrame(
  { typeId: 20, schemaVersion: 1, minReaderVersion: 1 },
  revision,
)
content.set(2n, newRevision)
content.set(3n, c.messageContentDigest(newRevision))
const newContent = c.encodeFrame(
  { typeId: 12, schemaVersion: 1, minReaderVersion: 1 },
  content,
)
rv.content = c.toHex(newContent)
const cryptoBuild = buildSync({
  entryPoints: [path.join(root, 'packages/crypto-box/src/index.ts')],
  bundle: true,
  platform: 'node',
  write: false,
})
const cryptoModule = new Module(__filename, module)
cryptoModule.paths = module.paths
cryptoModule._compile(cryptoBuild.outputFiles[0].text, __filename)
const oldPayload = payload(c.fromHex(rv.payload)),
  oldCrypto = c.decodeCanonical(oldPayload.get(4n))
const sealed = cryptoModule.exports.seal({
  suiteId: 1,
  recipientPublicKey: ctx.get(7n).get(1n),
  senderPublicKey: ctx.get(6n).get(1n),
  senderPrivateKey: c.fromHex(rv.message_secret_test_only),
  plaintext: newContent,
  context: c.fromHex(rv.context),
  ephemeralSecret: scalar(3),
  salt: oldCrypto.get(3n),
})
if (!sealed.ok) throw Error(sealed.error.code)
oldPayload.set(4n, sealed.value)
const newPayload = c.encodeFrame(
  { typeId: 11, schemaVersion: 2, minReaderVersion: 2 },
  oldPayload,
)
rv.payload = c.toHex(newPayload)
rv.t3 = c.toHex(c.recipientPayloadDigest(runtime.network, newPayload))
rv.t4 = c.toHex(c.paymentCommitment(c.fromHex(rv.t3), 0))
const delivery = payload(c.fromHex(rv.delivery))
delivery.set(2n, newPayload)
delivery.set(3n, c.fromHex(rv.t3))
for (const payment of delivery.get(4n)) payment.set(4n, c.fromHex(rv.t4))
rv.delivery = c.toHex(
  c.encodeFrame(
    { typeId: 10, schemaVersion: 1, minReaderVersion: 1 },
    delivery,
  ),
)

// Public deterministic leaf vectors retain the captured participants' exact identities.
const roleVectors = JSON.parse(
  fs.readFileSync(
    path.join(
      root,
      'docs/protocol/proposals/message-stamp-derivation/vectors.json',
    ),
    'utf8',
  ),
)
for (const account of roleVectors.accounts)
  for (const leaf of account.leaves)
    secrets.set(leaf.public_hex, c.fromHex(leaf.private_hex))
const typeMap = {
  1: 10,
  2: 2,
  3: 14,
  4: 1,
  5: 11,
  6: 12,
  7: 3,
  8: 20,
  9: 40,
  10: 41,
  11: 42,
  12: 43,
  13: 44,
  14: 45,
  15: 46,
  16: 21,
  17: 22,
  18: 26,
  19: 24,
  24: 25,
  25: 13,
  26: 23,
  27: 27,
}
function convertFrame(bytes) {
  const env = envelope(bytes),
    oldType = Number(env.get(0n)),
    p = payload(bytes)
  function children(v) {
    if (v instanceof Uint8Array)
      return Buffer.from(v.slice(0, 4)).toString() === 'FRNK'
        ? convertFrame(v)
        : v
    if (Array.isArray(v)) return v.map(children)
    if (v instanceof Map)
      return new Map([...v].map(([k, x]) => [k, children(x)]))
    return v
  }
  const value = children(p)
  if (oldType === 6) value.set(3n, c.messageContentDigest(value.get(2n)))
  return c.encodeFrame(
    {
      typeId: typeMap[oldType] || oldType,
      schemaVersion: Number(env.get(1n)),
      minReaderVersion: Number(env.get(2n)),
    },
    value,
  )
}
function convertWire(wire, attestations) {
  const changed = attestations.map(hex =>
    signed(convertFrame(c.fromHex(hex)), 'capture'),
  )
  const hashes = changed.map(bytes =>
    c.toHex(
      sha(
        c.commonTranscript(
          'frank/content-hash/v1',
          wire.network,
          payload(bytes).get(0n),
        ),
      ),
    ),
  )
  const ctx = c.decodeCanonical(c.fromHex(wire.context))
  ctx.set(4n, c.fromHex(hashes[0]))
  ctx.set(5n, c.fromHex(hashes[1]))
  ctx.set(13n, 11n)
  const context = c.encodeCanonical(ctx),
    content = convertFrame(c.fromHex(wire.content)),
    p = payload(c.fromHex(wire.payload)),
    oldCrypto = c.decodeCanonical(p.get(4n))
  const oldPlain = c.fromHex(wire.content),
    padding = oldCrypto.get(5n).length - oldPlain.length - 20
  const recipient = ctx.get(7n).get(1n),
    sender = ctx.get(6n).get(1n)
  const sealed = cryptoModule.exports.seal({
    suiteId: 1,
    recipientPublicKey: recipient,
    senderPublicKey: sender,
    senderPrivateKey: secretFor(sender),
    plaintext: content,
    context,
    ephemeralSecret: scalar(3),
    salt: oldCrypto.get(3n),
    padding: Math.max(0, padding),
    paddingBytes: new Uint8Array(Math.max(0, padding)),
  })
  if (!sealed.ok) throw Error(sealed.error.code)
  p.set(4n, sealed.value)
  const newPayload = c.encodeFrame(
    { typeId: 11, schemaVersion: 2, minReaderVersion: 2 },
    p,
  )
  wire.payload = c.toHex(newPayload)
  wire.context = c.toHex(context)
  wire.t3 = c.toHex(c.recipientPayloadDigest(wire.network, newPayload))
  wire.t4 = c.toHex(c.paymentCommitment(c.fromHex(wire.t3), 0))
  wire.sender_t1 = hashes[0]
  wire.recipient_t1 = hashes[1]
  wire.content = c.toHex(content)
  wire.revision = c.toHex(payload(content).get(2n))
  if (wire.content_digest)
    wire.content_digest = c.toHex(payload(content).get(3n))
  if (wire.delivery) {
    const d = payload(c.fromHex(wire.delivery))
    d.set(2n, newPayload)
    d.set(3n, c.fromHex(wire.t3))
    for (const pay of d.get(4n)) pay.set(4n, c.fromHex(wire.t4))
    wire.delivery = c.toHex(
      c.encodeFrame({ typeId: 10, schemaVersion: 1, minReaderVersion: 1 }, d),
    )
  }
  return changed.map(c.toHex)
}
const browser = runtime.canonical_facade_browser_case
const ba = convertWire(browser, [
  browser.sender_attestation,
  browser.recipient_attestation,
])
browser.sender_attestation = ba[0]
browser.recipient_attestation = ba[1]
browser.recipient_statement = c.toHex(payload(c.fromHex(ba[1])).get(0n))
const final = runtime.canonical_facade_final_http_case,
  fw = final.wire
fw.http_attestations = convertWire(fw, fw.http_attestations)
fw.type18_frames = fw.type18_frames.map(hex =>
  c.toHex(convertFrame(c.fromHex(hex))),
)
for (let i = 0; i < final.installed_principals.length; i++)
  final.installed_principals[i].rev0T1 =
    i === 0 ? fw.sender_t1 : fw.recipient_t1
// Old Chrome captures are evidence of the old allocation, not proof of regenerated bytes.
final.origin =
  'Option A offline synthetic regeneration from the public captured fixture and public role-key vectors; no fresh browser/network claim'
fw.proof_scope =
  'Offline synthetic codec/context/crypto fixture; independent readers and integration tests verify these regenerated bytes'
fw.browser_checkpoints = []
delete final.capture_sha256
delete final.captured_aead_tamper
delete final.aead_tamper_sha256
browser.source =
  'Option A offline synthetic regeneration of the captured distinct-party fixture; no fresh Chrome claim'
write('dm-runtime', runtime)
// Admission expectations describe retained exact bytes, including conflict evidence charges.
const admission = read('directory-admission'),
  oldProposal = read('suite1-directory')
const hashChanges = new Map(
  oldProposal.records.map(old => [
    old.t1,
    proposal.records.find(row => row.id === old.id).t1,
  ]),
)
function replaceHashes(value) {
  if (typeof value === 'string') return hashChanges.get(value) || value
  if (Array.isArray(value)) return value.map(replaceHashes)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, replaceHashes(v)]),
    )
  return value
}
const convertedAdmission = replaceHashes(admission)
convertedAdmission.source.sha256 = c.toHex(
  sha(Buffer.from(JSON.stringify(proposal, null, 2) + '\n')),
)
for (const row of convertedAdmission.cases) {
  const expected = row.expected
  if (expected.charged_bytes !== undefined)
    expected.charged_bytes = [
      ...new Set([...(expected.history || []), ...(expected.proof || [])]),
    ].reduce((sum, id) => {
      const r = proposal.records.find(x => x.id === id)
      return sum + (r.type4_hex.length + r.type2_hex.length) / 2
    }, 0)
}
write('directory-admission', convertedAdmission)
// Native HTTP regression requests carry the same captured payload inside multipart framing.
const nativePath = path.join(
  root,
  'backend/cashweb/cashweb-registry/src/http/monad_message_cbor_tests.rs',
)

const originalFinal = read('dm-runtime').canonical_facade_final_http_case.wire
function nativeFrame(bytes) {
  if (c.toHex(bytes) === originalFinal.payload) return c.fromHex(fw.payload)
  const env = envelope(bytes),
    oldType = Number(env.get(0n)),
    p = payload(bytes)
  if (oldType === 5) {
    const oldBox = payload(c.fromHex(originalFinal.payload)).get(4n),
      thisBox = p.get(4n)
    if (
      thisBox.length === oldBox.length &&
      Buffer.from(thisBox.slice(0, -1)).equals(Buffer.from(oldBox.slice(0, -1)))
    ) {
      const fresh = payload(c.fromHex(fw.payload)),
        box = fresh.get(4n)
      box[box.length - 1] ^=
        thisBox[thisBox.length - 1] ^ oldBox[oldBox.length - 1]
      fresh.set(4n, box)
      return c.encodeFrame(
        { typeId: 11, schemaVersion: 2, minReaderVersion: 2 },
        fresh,
      )
    }
  }
  const walk = v =>
    v instanceof Uint8Array && Buffer.from(v.slice(0, 4)).toString() === 'FRNK'
      ? nativeFrame(v)
      : Array.isArray(v)
      ? v.map(walk)
      : v instanceof Map
      ? new Map([...v].map(([k, x]) => [k, walk(x)]))
      : v
  const converted = walk(p)
  if (oldType === 1) {
    const digest = c.recipientPayloadDigest(
      converted.get(0n),
      converted.get(2n),
    )
    converted.set(3n, digest)
    converted
      .get(4n)
      .forEach((payment, i) => payment.set(4n, c.paymentCommitment(digest, i)))
  }
  return c.encodeFrame(
    {
      typeId: typeMap[oldType] || oldType,
      schemaVersion: Number(env.get(1n)),
      minReaderVersion: Number(env.get(2n)),
    },
    converted,
  )
}
let native = fs.readFileSync(nativePath, 'utf8')
for (const [name, originalBody] of Object.entries(inputs.native_http_bodies)) {
  const body = Buffer.from(originalBody, 'hex'),
    boundary = body.subarray(0, body.indexOf('\r\n')),
    parts = []
  let offset = 0
  while (offset < body.length) {
    const headerEnd = body.indexOf('\r\n\r\n', offset)
    if (headerEnd < 0) {
      parts.push(body.subarray(offset))
      break
    }
    const end = body.indexOf(
      Buffer.concat([Buffer.from('\r\n'), boundary]),
      headerEnd + 4,
    )
    if (end < 0) throw Error('native fixture multipart delimiter')
    const headers = body.subarray(offset, headerEnd + 4),
      data = body.subarray(headerEnd + 4, end)
    let converted = data
    if (headers.includes('name="delivery"'))
      converted = Buffer.from(nativeFrame(data))
    else if (headers.includes('name="context"')) {
      if (data.toString('hex') === originalFinal.context)
        converted = Buffer.from(c.fromHex(fw.context))
      else {
        const context = c.decodeCanonical(data)
        context.set(13n, 11n)
        converted = Buffer.from(c.encodeCanonical(context))
      }
    }
    parts.push(headers, converted)
    offset = end
  }
  const hex = Buffer.concat(parts).toString('hex')
  native = native.replace(
    new RegExp(`const ${name}: &str = "[0-9a-f]+";`),
    `const ${name}: &str = "${hex}";`,
  )
}
if (process.argv.includes('--check')) {
  if (fs.readFileSync(nativePath, 'utf8') !== native)
    throw Error('native HTTP fixtures: regenerate')
} else fs.writeFileSync(nativePath, native)
