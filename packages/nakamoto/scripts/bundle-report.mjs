// Browser bundle per entry point, with no Node polyfills, then load the
// emitted ESM in Node. Prints the byte size of each entry.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import esbuild from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const config = JSON.parse(
  readFileSync(join(root, 'bundle-entries.json'), 'utf8'),
)
const require = createRequire(import.meta.url)
const tscBin = require.resolve('typescript/bin/tsc')

const BUILTIN =
  /^(node:|fs|path|crypto|buffer|stream|util|os|events|process|module|assert|zlib|http|https|net|tls|child_process)(\/|$)/

function forms(value) {
  if (typeof value === 'number' && value > 0xffff) {
    const hex = value.toString(16)
    return [String(value), `0x${hex}`, `0x${hex.toUpperCase()}`]
  }
  return [String(value)]
}

function hits(js, value) {
  return forms(value).filter(form => js.includes(form))
}

const tsc = spawnSync(
  process.execPath,
  [tscBin, '-p', 'tsconfig.json', '--pretty', 'false'],
  { cwd: root, encoding: 'utf8' },
)
if (tsc.status !== 0) {
  console.error(tsc.stdout)
  console.error(tsc.stderr)
  process.exit(tsc.status ?? 1)
}

const sandboxBase = {
  Object,
  Array,
  Uint8Array,
  Uint8ClampedArray,
  Uint16Array,
  Uint32Array,
  Int8Array,
  Int16Array,
  Int32Array,
  BigInt64Array,
  BigUint64Array,
  Float32Array,
  Float64Array,
  ArrayBuffer,
  DataView,
  BigInt,
  Map,
  Set,
  WeakMap,
  WeakSet,
  Symbol,
  Error,
  TypeError,
  RangeError,
  Math,
  Number,
  String,
  Boolean,
  JSON,
  Reflect,
  Proxy,
  Date,
  parseInt,
  parseFloat,
  isFinite,
  isNaN,
  NaN,
  Infinity,
  undefined,
}

for (const entry of config.entries) {
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [entry.entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    metafile: true,
    globalName: config.globalName,
    logLevel: 'silent',
  })
  const inputs = Object.keys(result.metafile.inputs)
  const builtins = inputs.filter(input => BUILTIN.test(input))
  if (builtins.length > 0) {
    console.error(
      `${entry.name} bundle includes Node built-ins: ${builtins.join(', ')}`,
    )
    process.exit(1)
  }
  const js = result.outputFiles[0].text
  if (
    /require\(["'](?:node:|crypto|buffer|fs|stream|events|util)/.test(js) ||
    /from ["']node:/.test(js)
  ) {
    console.error(`${entry.name} bundle still references a Node built-in`)
    process.exit(1)
  }
  console.log(`${entry.name} ${js.length} bytes (${inputs.length} inputs)`)
  for (const tokenName of entry.forbid ?? []) {
    const found = hits(js, config.tokens[tokenName])
    if (found.length > 0) {
      console.error(
        `${entry.name} contains ${tokenName} as ${found.join(', ')}`,
      )
      process.exit(1)
    }
  }
  for (const tokenName of entry.require ?? []) {
    const found = hits(js, config.tokens[tokenName])
    if (found.length === 0) {
      console.error(
        `${entry.name} is missing ${tokenName}; looked for ${forms(
          config.tokens[tokenName],
        ).join(', ')}`,
      )
      process.exit(1)
    }
  }
  const sandbox = { ...sandboxBase }
  try {
    runInContext(js, createContext(sandbox), { filename: `${entry.name}.js` })
  } catch (error) {
    console.error(`${entry.name} failed in a plain vm`)
    console.error(error)
    process.exit(1)
  }
  const exported = sandbox[config.globalName]
  if (exported == null) {
    console.error(`${entry.name} did not assign ${config.globalName}`)
    process.exit(1)
  }
  for (const name of entry.absentExports ?? []) {
    if (name in exported) {
      console.error(`${entry.name} bundle exports ${name}`)
      process.exit(1)
    }
  }
}

for (const entry of config.entries) {
  const distName = entry.entry
    .replace(/^src\//, 'dist/')
    .replace(/\.ts$/, '.js')
  const imported = await import(pathToFileURL(join(root, distName)).href)
  if (Object.keys(imported).length === 0) {
    console.error(`${distName} loaded with no exports`)
    process.exit(1)
  }
  for (const name of entry.absentExports ?? []) {
    if (name in imported) {
      console.error(`node ${distName} exports ${name}`)
      process.exit(1)
    }
  }
  console.log(`node import ${distName}`)
}
