import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { build } from 'esbuild'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
  '@frank/domain-roots',
  '@frank/nakamoto',
])
assert.deepEqual(manifest.exports, { '.': './src/index.ts' })
const result = await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'RoleKeys',
  target: 'es2020',
  write: false,
  metafile: true,
  logLevel: 'silent',
})
const inputs = Object.keys(result.metafile.inputs)
for (const input of inputs) {
  assert.ok(
    input.startsWith('src/') ||
      input.startsWith('../domain-roots/src/') ||
      input.startsWith('../nakamoto/dist/') ||
      /\/node_modules\/@noble\/(hashes|curves)\//.test(input),
    `Unexpected production browser input: ${input}`,
  )
}
assert.ok(
  inputs.includes('../nakamoto/dist/hd.js'),
  'Must bundle the built public HD API',
)
for (const output of Object.values(result.metafile.outputs))
  assert.equal(output.imports.length, 0)

// Run the actual browser bundle in a bare realm. No Node globals, Buffer shim,
// ethers wallet, require, process, WebCrypto or browser UI is injected.
const realm = createContext({})
runInContext(result.outputFiles[0].text, realm, { timeout: 5000 })
const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../docs/protocol/proposals/message-stamp-derivation/vectors.json',
      root,
    ),
    'utf8',
  ),
).accounts[1]
const roots = Object.fromEntries(
  fixture.roots.map(r => [r.purpose, r.output_hex]),
)
const points = Object.fromEntries(
  fixture.leaves
    .filter(v => ['auth-0', 'message-1', 'stamp-1'].includes(v.id))
    .map(v => [v.role, v.public_hex]),
)
const report = runInContext(
  `(() => {
  const bytes = hex => Uint8Array.from(hex.match(/../g), x => parseInt(x, 16));
  const hex = bytes => Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
  const roots = ${JSON.stringify(roots)};
  const root = purpose => ({ registry: 'frank-domain-roots-v1', purpose, bytes: bytes(roots[purpose]) });
  const input = { authRoot: root('identity-authentication'), messageRoot: root('messaging-encryption'), stampRoot: root('evm-wallet'), messageGeneration: 1n, stampGeneration: 1n };
  const leaves = RoleKeys.deriveRoleLeaves(input);
  const points = Object.fromEntries(['auth', 'message', 'stamp'].map(role => [role, hex(leaves[role].public.compressedPoint)]));
  const match = RoleKeys.matchLocalRolePoints(input, Object.fromEntries(Object.entries(points).map(([k,v]) => [k, bytes(v)])));
  leaves.dispose();
  let disposed = false;
  try { leaves.message.useSecret(hex) } catch (error) { disposed = error.code === 'disposed' }
  return JSON.stringify({ points, match, disposed, exports: Object.keys(RoleKeys).sort(), node: [typeof Buffer, typeof process, typeof require] });
})()`,
  realm,
  { timeout: 5000 },
)
const actual = JSON.parse(report)
assert.deepEqual(actual.points, points)
assert.deepEqual(actual.match, {
  kind: 'local-point-comparison',
  matches: true,
})
assert.equal(actual.disposed, true)
assert.deepEqual(actual.exports, [
  'RoleKeyError',
  'deriveRoleLeaves',
  'matchLocalRolePoints',
])
assert.deepEqual(actual.node, ['undefined', 'undefined', 'undefined'])
console.log(
  `Browser VM and dependency boundary pass: ${inputs.length} inputs; no Node crypto, Buffer shim, ethers or runtime consumer.`,
)
