import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)
assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
  '@frank/codex32',
  '@frank/domain-roots',
  '@frank/nakamoto',
  '@noble/hashes',
])
assert.equal(manifest.dependencies['@noble/hashes'], '1.8.0')

const result = await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2020',
  write: false,
  metafile: true,
  minify: true,
  logLevel: 'silent',
})
const inputs = Object.keys(result.metafile.inputs)
const leaf =
  /(?:^|\/)nakamoto\/(?:dist|src)\/(?:bech32|base32|convert-bits|encoding-error)\.[jt]s$/
for (const input of inputs) {
  assert.ok(
    input.startsWith('src/') ||
      input.startsWith('../codex32/src/') ||
      input.startsWith('../domain-roots/src/') ||
      leaf.test(input) ||
      input.includes('/node_modules/@noble/hashes/'),
    `Unexpected browser dependency: ${input}`,
  )
}
assert.ok(
  inputs.some(input => leaf.test(input)),
  'Encoding leaf boundary was not exercised',
)
for (const output of Object.values(result.metafile.outputs)) {
  assert.equal(
    output.imports.length,
    0,
    'Browser bundle must be self-contained',
  )
}
console.log(
  `Browser dependency boundary: ${inputs.length} modules, ${result.outputFiles[0].contents.length} bytes; pure encoding leaves only`,
)
