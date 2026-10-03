const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '../../..')
const packageRoot = path.resolve(__dirname, '..')
const corpus = require(path.join(
  root,
  'docs/protocol/cbor/vectors/directory-admission.json',
))
const source = fs.readFileSync(path.join(root, corpus.source.path))
if (
  crypto.createHash('sha256').update(source).digest('hex') !==
  corpus.source.sha256
)
  throw new Error('published directory vector SHA-256 mismatch')
async function build(kind) {
  return esbuild.build({
    entryPoints: [path.join(packageRoot, `test/${kind}.js`)],
    outfile: path.join(
      packageRoot,
      `dist/test-${kind}.${kind === 'browser' ? 'js' : 'cjs'}`,
    ),
    bundle: true,
    platform: kind === 'browser' ? 'browser' : 'node',
    format: kind === 'browser' ? 'iife' : 'cjs',
    target: 'es2022',
    alias: {
      '@frank/codec': path.join(root, 'packages/frank-codec/src/index.ts'),
    },
    external: kind === 'browser' ? [] : ['level', 'levelup'],
    metafile: true,
  })
}
module.exports = { build, root, packageRoot }
if (require.main === module)
  build(process.argv[2] || 'node').catch(error => {
    console.error(error)
    process.exitCode = 1
  })
