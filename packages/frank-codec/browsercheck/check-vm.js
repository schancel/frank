/* eslint-env node */
// Executes the browser bundle in a bare `vm` context: only ECMAScript built-ins, no `require`,
// `process`, `Buffer`, `TextEncoder`, `crypto`, `window` or `document`. This proves the bundle has
// no Node dependency; it does NOT exercise a real browser engine's DOM/WebCrypto (see
// check-chrome.js for that).
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const dist = path.resolve(__dirname, '../dist')
const read = f => fs.readFileSync(path.join(dist, f), 'utf8')

const bundle = read('frank-codec.iife.js')
for (const banned of [/\brequire\(/, /\bprocess\./, /\bBuffer\b/, /node:/]) {
  if (banned.test(bundle)) {
    console.error('bundle mentions ' + banned)
    process.exit(1)
  }
}

const sandbox = Object.create(null)
const context = vm.createContext(sandbox)
vm.runInContext('globalThis.globalThis = globalThis', context)
vm.runInContext(bundle, context, { filename: 'frank-codec.iife.js' })
vm.runInContext(read('manifest.js'), context, { filename: 'manifest.js' })
vm.runInContext(read('runner.js'), context, { filename: 'runner.js' })
const result = JSON.parse(
  vm.runInContext(
    'JSON.stringify(globalThis.frankBrowserCheck(FrankCodec, FRANK_MANIFEST))',
    context,
  ),
)
console.log('vm check (bare context, no Node globals):', JSON.stringify(result))
if (!result.ok || result.leakedNodeGlobals.length) process.exit(1)
