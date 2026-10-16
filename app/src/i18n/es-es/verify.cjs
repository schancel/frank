// Catalog-only check: run from the worktree root with the signed UI English path.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const { baseCompile } = require('@intlify/message-compiler')

function load(file) {
  const source = fs.readFileSync(file, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  })
  assert.equal(output.diagnostics.length, 0, `${file}: TypeScript diagnostics`)
  const module = { exports: {} }
  new Function('require', 'exports', 'module', output.outputText)(
    id => load(path.resolve(path.dirname(file), `${id}.ts`)),
    module.exports,
    module,
  )
  return module.exports
}
function flatten(object, prefix = '', result = {}) {
  for (const [key, value] of Object.entries(object)) {
    const full = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') result[full] = value
    else flatten(value, full, result)
  }
  return result
}
const signedEnglish = process.argv[2]
assert.ok(signedEnglish, 'Provide the stable signed UI English catalog path')
const english = load('app/src/i18n/en-us/index.ts').default
english.settings.languageAutomatic = 'Automatic (browser language)'
english.signedSwap = load(signedEnglish).default.signedSwap
assert.ok(english.signedSwap)
const en = flatten(english)
const es = flatten(load('app/src/i18n/es-es/index.ts').default)
assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort())
const tokens = value => (value.match(/\{[^}]*\}/g) || []).sort()
const numbers = value =>
  (value.replace(/\{[^}]*\}/g, '').match(/\d+(?:[.,]\d+)*/g) || []).sort()
const urls = value =>
  (value.match(/(?:https?:\/\/|bitcoincash:)[^\s]+/g) || []).sort()
for (const [key, value] of Object.entries(es)) {
  assert.deepEqual(tokens(value), tokens(en[key]), `${key}: interpolation`)
  assert.deepEqual(numbers(value), numbers(en[key]), `${key}: numbers`)
  assert.deepEqual(urls(value), urls(en[key]), `${key}: URLs`)
  baseCompile(value, {
    onError: error => {
      throw new Error(`${key}: ${error.message}`)
    },
  })
}
const source = fs.readFileSync('app/src/i18n/es-es/index.ts', 'utf8')
const ast = ts.createSourceFile(
  'index.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
)
function checkLiteral(node) {
  assert.ok(
    !ts.isImportDeclaration(node) &&
      !ts.isSpreadAssignment(node) &&
      !ts.isCallExpression(node),
    'Catalog must contain its own complete values',
  )
  ts.forEachChild(node, checkLiteral)
}
checkLiteral(ast)
console.log(
  `${
    Object.keys(es).length
  } Spanish leaves: keys, interpolation, numbers, URLs and message compilation passed`,
)
