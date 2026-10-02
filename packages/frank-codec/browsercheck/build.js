/* eslint-env node */
// Bundles @frank/codec for the browser with esbuild: platform=browser, no Node polyfills, no
// Node built-ins. Also writes dist/browsercheck.html, the page the headless-Chrome check loads.
const fs = require('fs')
const path = require('path')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')
const vectors = path.resolve(root, '../../docs/protocol/cbor/vectors')

async function main() {
  fs.mkdirSync(dist, { recursive: true })
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'src/index.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'FrankCodec',
    platform: 'browser',
    target: 'es2020',
    outfile: path.join(dist, 'frank-codec.iife.js'),
    // Any Node built-in import would fail the build instead of being polyfilled or shimmed.
    external: [],
    logLevel: 'warning',
    metafile: true,
  })
  const inputs = Object.keys(result.metafile.inputs)
  const nodeBuiltins = inputs.filter(i =>
    /^node:|^(fs|path|crypto|buffer|stream|util|os)\b/.test(i),
  )
  if (nodeBuiltins.length)
    throw new Error(`Node built-ins in the bundle: ${nodeBuiltins}`)
  fs.copyFileSync(
    path.join(__dirname, 'runner.js'),
    path.join(dist, 'runner.js'),
  )
  const browserData = [
    ['FRANK_MANIFEST', 'manifest.json'],
    ['FRANK_RUST_ORIGIN', 'rust-origin.json'],
    ['FRANK_INTEROPERABILITY', 'interoperability.json'],
    ['FRANK_REGISTRATION', 'account-registration.json'],
    ['FRANK_REGISTRATION_VALUES', 'account-registration-values.json'],
  ]
    .map(
      ([globalName, file]) =>
        `globalThis.${globalName} = ${fs.readFileSync(
          path.join(vectors, file),
          'utf8',
        )}`,
    )
    .join('\n')
  fs.writeFileSync(path.join(dist, 'manifest.js'), browserData + '\n')
  fs.writeFileSync(
    path.join(dist, 'browsercheck.html'),
    `<!doctype html>
<html><head><meta charset="utf-8"><title>frank-codec browser check</title></head>
<body>
<pre id="result">running</pre>
<script src="frank-codec.iife.js"></script>
<script src="manifest.js"></script>
<script src="runner.js"></script>
<script>
  document.getElementById('result').textContent = JSON.stringify(
    globalThis.frankBrowserCheck(
      globalThis.FrankCodec,
      globalThis.FRANK_MANIFEST,
      globalThis.FRANK_RUST_ORIGIN,
      globalThis.FRANK_INTEROPERABILITY,
      globalThis.FRANK_REGISTRATION,
      globalThis.FRANK_REGISTRATION_VALUES,
    ),
  )
</script>
</body></html>
`,
  )
  const size = fs.statSync(path.join(dist, 'frank-codec.iife.js')).size
  console.log(
    `built dist/frank-codec.iife.js (${size} bytes, ${inputs.length} input files)`,
  )
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
