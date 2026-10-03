// Opt-in in-memory build; never imported by an active entry point.
const { buildSync } = require('esbuild')
const Module = require('node:module')
const path = require('node:path')
const filename = path.join(__dirname, 'check.ts')
const result = buildSync({
  entryPoints: [filename],
  bundle: true,
  platform: 'node',
  write: false,
  define: { __dirname: JSON.stringify(__dirname) },
})
const compiled = new Module(filename, module)
compiled.filename = filename
compiled.paths = module.paths
compiled._compile(result.outputFiles[0].text, filename)
