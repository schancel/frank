// Replays the unchanged #719 policy functions, not its historical artifact/generation driver.
// The full historical driver intentionally fails its frozen-document guards after allocation.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const Module = require('node:module')
const root = path.resolve(__dirname, '../../../..')
const filename = path.join(
  root,
  'packages/frank-codec/proposals/suite1-directory/check.ts',
)
const source = fs.readFileSync(filename, 'utf8')
assert.equal(
  crypto.createHash('sha256').update(source).digest('hex'),
  'f7ff7932703801cea329ef3b8cb76dc513c195de2e3fcc7a12e262b43ba77bc2',
  'reviewed oracle source changed',
)
const boundary = '\nconst generated = generate()'
assert.equal(source.split(boundary).length, 2)
const driver = `
const corpus = JSON.parse(readFileSync(FILE, 'utf8')) as Corpus
for (const c of corpus.cases) {
  assert.equal(outcome(c, corpus), c.expected, c.id)
  if (c.operation === 'advance') {
    const actual = advance(c, corpus)
    assert.deepEqual(actual.history, c.committed_history, c.id + ': history')
    assert.equal(actual.previous_stamp, c.previous_stamp, c.id + ': previous')
  }
}
const shared = JSON.parse(readFileSync(resolve(ROOT, 'docs/protocol/cbor/vectors/directory-admission.json'), 'utf8'))
for (const c of shared.cases) {
  const original = c.oracle_input || corpus.cases.find(x => x.id === c.id)!
  assert.equal(outcome(original, corpus), c.proposal_expected, c.id)
  if (original.operation === 'advance') {
    const actual = advance(original, corpus)
    assert.deepEqual(actual.history, c.expected.history, c.id + ': shared history')
    assert.equal(actual.previous_stamp, c.expected.previous_stamp, c.id + ': shared pair')
  }
}
console.log('TS unchanged proposal policy replay: ' + corpus.cases.length + ' outcomes, ' + shared.cases.length + ' shared cases; historical artifact driver NOT run')
`
const result = require('esbuild').buildSync({
  stdin: {
    contents: source.split(boundary)[0] + driver,
    loader: 'ts',
    resolveDir: path.dirname(filename),
    sourcefile: filename,
  },
  bundle: true,
  platform: 'node',
  write: false,
  nodePaths: (process.env.NODE_PATH || '')
    .split(path.delimiter)
    .filter(Boolean),
  define: { __dirname: JSON.stringify(path.dirname(filename)) },
})
const compiled = new Module(filename, module)
compiled.filename = filename
compiled.paths = module.paths
compiled._compile(result.outputFiles[0].text, filename)
