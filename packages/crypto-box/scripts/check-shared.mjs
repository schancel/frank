// Fails when shared source imports a Node built-in or a banned package.
// src/backend/node/ may import Node built-ins. Nothing else may import that
// directory. The checker is the regression for "no polyfills in shared code".

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { argv, exit } from 'node:process'
import { fileURLToPath } from 'node:url'

const NODE_BUILTINS = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
])

const BANNED_PACKAGES = new Set([
  'bn.js',
  'elliptic',
  'bs58',
  'buffer-compare',
  'inherits',
  'lodash',
  'node-forge',
  'buffer',
])

const SPECIFIER = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g
const DYNAMIC = /import\(\s*['"]([^'"]+)['"]\s*\)/g
const REQUIRE = /require\(\s*['"]([^'"]+)['"]\s*\)/g

function packageRoot(args) {
  const flag = args.indexOf('--root')
  if (flag !== -1 && args[flag + 1]) return args[flag + 1]
  return fileURLToPath(new URL('..', import.meta.url))
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(path)
  }
}

function stripComments(source) {
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      index += 2
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (
        index < source.length &&
        !(source[index] === '*' && source[index + 1] === '/')
      ) {
        index += 1
      }
      index += 2
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      out += char
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') {
          out += source[index] + (source[index + 1] ?? '')
          index += 2
          continue
        }
        out += source[index]
        if (source[index] === char) {
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    out += char
    index += 1
  }
  return out
}

function specifiers(source) {
  const found = []
  for (const pattern of [SPECIFIER, DYNAMIC, REQUIRE]) {
    pattern.lastIndex = 0
    let match = pattern.exec(source)
    while (match) {
      found.push(match[1])
      match = pattern.exec(source)
    }
  }
  return found
}

function packageName(spec) {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/')
  return spec.split('/')[0]
}

function isBuiltin(spec) {
  if (spec.startsWith('node:')) return true
  return NODE_BUILTINS.has(packageName(spec))
}

function isNodeBackend(rel) {
  const norm = rel.split(sep).join('/')
  return norm === 'src/backend/node' || norm.startsWith('src/backend/node/')
}

export function checkShared(root) {
  const src = join(root, 'src')
  const files = []
  walk(src, files)
  const failures = []
  for (const file of files) {
    const rel = relative(root, file)
    const text = readFileSync(file, 'utf8')
    const stripped = stripComments(text)
    const nodeBackend = isNodeBackend(rel)
    for (const spec of specifiers(text)) {
      if (BANNED_PACKAGES.has(packageName(spec))) {
        failures.push(`${rel} imports banned package ${spec}`)
      }
      if (!nodeBackend && isBuiltin(spec)) {
        failures.push(`${rel} imports Node built-in ${spec}`)
      }
      if (!nodeBackend && spec.includes('backend/node')) {
        failures.push(`${rel} imports the Node backend (${spec})`)
      }
    }
    if (/\bBuffer\b/.test(stripped)) failures.push(`${rel} uses Buffer`)
    if (/\bprocess\b/.test(stripped)) failures.push(`${rel} uses process`)
    if (/\brequire\b/.test(stripped)) failures.push(`${rel} uses require`)
    if (!nodeBackend && stripped.includes('node:')) {
      failures.push(`${rel} mentions node:`)
    }
  }
  return failures
}

const root = packageRoot(argv)
const failures = checkShared(root)
if (failures.length > 0) {
  for (const line of failures) console.error(line)
  exit(1)
}
console.log(`shared source under ${root}/src imports no Node built-ins`)
