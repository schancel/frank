// Mechanical expansion of the reviewed proposal's authored outcomes into complete expected
// durable states. No production policy is imported. Prints JSON; --check checks the frozen file.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const Module = require('node:module')
const root = path.resolve(__dirname, '../../../..')
const sourcePath = 'docs/protocol/proposals/suite1-directory/vectors.json'
const sourceBytes = fs.readFileSync(path.join(root, sourcePath))
const source = JSON.parse(sourceBytes)
const codecCases = JSON.parse(
  fs.readFileSync(
    path.join(root, 'docs/protocol/cbor/vectors/directory-preview.json'),
  ),
)
const built = require('esbuild').buildSync({
  entryPoints: [path.join(root, 'packages/frank-codec/src/cbor.ts')],
  bundle: true,
  platform: 'node',
  write: false,
})
const compiled = new Module(__filename, module)
compiled._compile(built.outputFiles[0].text, __filename)
const { decodeCanonical } = compiled.exports
const bytes = h => Uint8Array.from(Buffer.from(h, 'hex'))
const hex = b => Buffer.from(b).toString('hex')
const records = new Map(source.records.map(r => [r.id, r]))
const payload = id =>
  decodeCanonical(
    decodeCanonical(bytes(records.get(id).type4_hex).subarray(9)).get(3n),
  )
const key = v => hex(v.get(1n))
const charge = ids =>
  ids.reduce(
    (n, id) =>
      n +
      (records.get(id).type4_hex.length + records.get(id).type2_hex.length) / 2,
    0,
  )
const errorMap = {
  'accept': 'accept',
  'duplicate': 'accept',
  'anchor': 'anchor',
  'clock': 'clock',
  'binding': 'binding',
  'validity': 'validity',
  'generation': 'generation',
  'revision': 'link',
  'predecessor': 'link',
  'issue-order': 'order',
  'schema-downgrade': 'order',
  'fork': 'fork',
  'rollback': 'rollback',
  'key-reuse': 'key-reuse',
  'unsupported-policy': 'anchor',
}
function expected(history, proof, checked) {
  let current = null,
    previous = null
  for (const id of history) {
    const k = key(payload(id).get(8n))
    if (k !== current) {
      previous = current
      current = k
    }
  }
  const head = history.length ? history[history.length - 1] : null
  const p = head ? payload(head) : null
  return {
    enrolled: history.length + proof.length > 0,
    history,
    proof,
    head,
    head_hash: head ? records.get(head).t1 : null,
    revision: p ? String(p.get(2n)) : null,
    generations: p ? [String(p.get(11n)), String(p.get(12n))] : null,
    message_key: p ? key(p.get(10n)) : null,
    current_stamp: current,
    previous_stamp: previous,
    accepted: history.length,
    retained: history.length + proof.length,
    charged_bytes: charge([...history, ...proof]),
    forked: proof.length > 0,
    checked_time: history.length + proof.length ? [checked, '0'] : null,
  }
}
const cases = source.cases
  .filter(
    c =>
      ['directory', 'advance'].includes(c.operation) &&
      !c.reader &&
      !c.claimed_t1 &&
      !c.restart,
  )
  .map(c => {
    let result = errorMap[c.expected] || 'evidence'
    const incoming = c.operation === 'advance' ? c.candidates : [c.record]
    const codecInvalid = incoming.some(
      id =>
        codecCases.records.find(r => r.id === id).expected.category !==
        'accept',
    )
    if (codecInvalid) result = 'evidence'
    const checked = c.last_clock || '1700000100'
    const now = c.clock === null ? null : c.clock || '1700000100'
    let history = [...c.history],
      proof = []
    if (result === 'accept') {
      for (const id of incoming)
        if (history[history.length - 1] !== id) history.push(id)
    } else if (result === 'fork') proof = incoming
    return {
      id: c.id,
      proposal_expected: c.expected,
      history: c.history,
      candidates: incoming,
      anchor:
        c.anchor === undefined
          ? records.get(c.history[0] || 'bootstrap').t1
          : c.anchor,
      clock: now,
      initial_clock: checked,
      relay: c.relay === undefined ? source.synthetic_relay_cbor_hex : c.relay,
      result,
      expected: expected(
        history,
        proof,
        result === 'accept' || result === 'fork' ? now : checked,
      ),
    }
  })
for (const history of [[], ['bootstrap']]) {
  const incoming = history.length
    ? ['renew', 'fork-of-renew']
    : ['bootstrap', 'renew', 'fork-of-renew']
  const id = history.length ? 'staged-future-fork' : 'initial-batch-fork'
  const oracle_input = {
    id,
    operation: 'advance',
    history,
    candidates: incoming,
    anchor: records.get('bootstrap').t1,
    expected: 'fork',
  }
  cases.push({
    id,
    oracle_input,
    proposal_expected: 'fork',
    history,
    candidates: incoming,
    anchor: records.get('bootstrap').t1,
    clock: '1700000100',
    initial_clock: '1700000100',
    relay: source.synthetic_relay_cbor_hex,
    result: 'fork',
    expected: expected(history, incoming, '1700000100'),
  })
}
const probes = source.cases.filter(c =>
  ['history-budget', 'counter'].includes(c.operation),
)
const corpus = {
  format: 'directory-admission-v1',
  source: {
    path: sourcePath,
    sha256: crypto.createHash('sha256').update(sourceBytes).digest('hex'),
  },
  network: 'monad-testnet',
  subject: key(payload('bootstrap').get(1n)),
  frame_limit: 262144,
  statement_limit: 4096,
  charged_byte_limit: 16777216,
  cases,
  probes,
}
const json = JSON.stringify(corpus, null, 2) + '\n'
if (process.argv.includes('--check')) {
  require('node:assert/strict').equal(
    fs.readFileSync(
      path.join(root, 'docs/protocol/cbor/vectors/directory-admission.json'),
      'utf8',
    ),
    json,
  )
  console.log(
    `directory admission: ${cases.length} complete expected durable states; frozen proposal unchanged`,
  )
} else process.stdout.write(json)
