// package.json dependencies must equal runtime-deps.json allowed.
// Yarn 1 does not record a workspace package's own dependency map as a
// lockfile key, so this file is the install list the lockfile is built from.
// Planned names must not be installed early.

import { readFileSync } from 'node:fs'
import { argv, exit } from 'node:process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const BANNED = [
  'bn.js',
  'elliptic',
  'bs58',
  'buffer-compare',
  'inherits',
  'lodash',
  'node-forge',
  'buffer',
]

function packageRoot(args) {
  const flag = args.indexOf('--root')
  if (flag !== -1 && args[flag + 1]) return args[flag + 1]
  return fileURLToPath(new URL('..', import.meta.url))
}

function keys(record) {
  return Object.keys(record ?? {}).sort()
}

const root = packageRoot(argv)
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const runtime = JSON.parse(
  readFileSync(join(root, 'runtime-deps.json'), 'utf8'),
)
const failures = []

if (!Array.isArray(runtime.allowed) || !Array.isArray(runtime.planned)) {
  failures.push('runtime-deps.json needs allowed and planned arrays')
}

const allowed = [...(runtime.allowed ?? [])].sort()
const optional = [...(runtime.optional ?? [])].sort()
const planned = [...(runtime.planned ?? []), ...(runtime.plannedOptional ?? [])]
const declared = keys(pkg.dependencies)
const declaredOptional = keys(pkg.optionalDependencies)
const installed = new Set([
  ...declared,
  ...declaredOptional,
  ...keys(pkg.devDependencies),
])

if (JSON.stringify(declared) !== JSON.stringify(allowed)) {
  failures.push(
    `dependencies ${JSON.stringify(declared)} != allowed ${JSON.stringify(
      allowed,
    )}`,
  )
}
if (JSON.stringify(declaredOptional) !== JSON.stringify(optional)) {
  failures.push(
    `optionalDependencies ${JSON.stringify(
      declaredOptional,
    )} != optional ${JSON.stringify(optional)}`,
  )
}
for (const name of installed) {
  if (BANNED.includes(name)) failures.push(`banned package declared: ${name}`)
}
for (const name of [...allowed, ...optional]) {
  if (BANNED.includes(name)) {
    failures.push(`justified list contains banned package: ${name}`)
  }
}
for (const name of planned) {
  if (installed.has(name))
    failures.push(`planned package is installed early: ${name}`)
}

if (failures.length > 0) {
  for (const line of failures) console.error(line)
  exit(1)
}
console.log(
  `${pkg.name} dependencies match the justified list (${allowed.length} runtime, ${optional.length} optional)`,
)
