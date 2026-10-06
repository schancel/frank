#!/usr/bin/env node
import { spawnSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join, resolve } from 'path'

const rootDir = resolve(__dirname, '..')

// Collect all package tsconfig files
const targetConfigs: string[] = []

const packagesDir = join(rootDir, 'packages')
if (existsSync(packagesDir)) {
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const configPath = join(packagesDir, entry.name, 'tsconfig.json')
      if (existsSync(configPath)) {
        targetConfigs.push(configPath)
      }
    }
  }
}

const custodyConfig = join(rootDir, 'app/src/accounts/custody/tsconfig.json')
if (existsSync(custodyConfig)) {
  targetConfigs.push(custodyConfig)
}

// Parse CLI flags
const args = process.argv.slice(2)
const forceTsc = args.includes('--tsc')
const forceFast = args.includes('--fast')

const tsgoBin = join(rootDir, 'node_modules/.bin/tsgo')
const tscBin = join(rootDir, 'node_modules/.bin/tsc')

let compilerBin = tscBin
let compilerName = 'tsc'

if (!forceTsc && existsSync(tsgoBin)) {
  compilerBin = tsgoBin
  compilerName = 'tsgo (native Go TypeScript compiler)'
} else if (forceFast && !existsSync(tsgoBin)) {
  console.warn('[typecheck] tsgo binary not found, falling back to standard tsc')
}

console.log(`[typecheck] Using compiler: ${compilerName}`)
console.log(`[typecheck] Checking ${targetConfigs.length} TypeScript projects...\n`)

const results: Array<{ config: string; passed: boolean; durationMs: number; output: string }> = []
const startTime = Date.now()

for (const config of targetConfigs) {
  const relConfig = config.replace(`${rootDir}/`, '')
  process.stdout.write(`  checking ${relConfig.padEnd(52)} `)
  const pkgStart = Date.now()
  const proc = spawnSync(compilerBin, ['--project', config, '--noEmit'], {
    cwd: rootDir,
    encoding: 'utf8',
  })
  const durationMs = Date.now() - pkgStart
  const passed = proc.status === 0
  results.push({
    config: relConfig,
    passed,
    durationMs,
    output: (proc.stdout || '') + (proc.stderr || ''),
  })

  if (passed) {
    console.log(`\x1b[32mPASS\x1b[0m  (${durationMs}ms)`)
  } else {
    console.log(`\x1b[31mFAIL\x1b[0m  (${durationMs}ms)`)
  }
}

const totalDurationSec = ((Date.now() - startTime) / 1000).toFixed(2)
const failures = results.filter(r => !r.passed)

console.log(`\n------------------------------------------------------------`)
console.log(`Total: ${targetConfigs.length} checked, ${targetConfigs.length - failures.length} passed, ${failures.length} failed in ${totalDurationSec}s`)
console.log(`------------------------------------------------------------`)

if (failures.length > 0) {
  console.error(`\nFailures encountered:\n`)
  for (const failure of failures) {
    console.error(`\x1b[31m=== ${failure.config} ===\x1b[0m`)
    console.error(failure.output.trim())
    console.error(`\n`)
  }
  process.exit(1)
} else {
  console.log(`\x1b[32mALL TYPECHECKS PASSED\x1b[0m\n`)
}
