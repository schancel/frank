/**
 * Finding the node binaries (anvil, a Chronik bitcoind) that suites on a real node need, and the
 * one decision such a suite makes when one is missing.
 *
 * Locally a suite without its node reports itself as NOT RUN and is skipped. A run that must
 * exercise the nodes (every hosted CI step that names a node suite) sets FRANK_REQUIRE_NODES=1,
 * and then a missing binary fails the suite instead, naming the binary and how to provide it.
 * `ci-anvil-suites.jest.test.ts` checks that every node suite is named by such a step.
 */
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join } from 'path'

type Env = Record<string, string | undefined>

/** True when this run must have its nodes: FRANK_REQUIRE_NODES=1. */
export const nodesRequired = (env: Env = process.env): boolean => env.FRANK_REQUIRE_NODES === '1'

/**
 * The `anvil` to run, or undefined. ANVIL_BIN, when set, is the only candidate (a set path that
 * does not exist is missing, not a cue to look elsewhere); otherwise the `@foundry-rs/anvil`
 * package's platform binary, else `anvil` on PATH.
 */
export function findAnvil(env: Env = process.env): string | undefined {
  if (env.ANVIL_BIN) return existsSync(env.ANVIL_BIN) ? env.ANVIL_BIN : undefined
  try {
    const root = dirname(dirname(require.resolve('@foundry-rs/anvil/package.json')))
    const arch = process.arch === 'x64' ? 'amd64' : process.arch
    const packaged = join(root, `anvil-${process.platform}-${arch}`, 'bin', 'anvil')
    if (existsSync(packaged)) return packaged
  } catch {
    // Not installed as a package.
  }
  return spawnSync('anvil', ['--version']).status === 0 ? 'anvil' : undefined
}

/** A binary a suite needs, whether it was found, and how to provide it. */
export interface NodeBinary {
  name: string
  found: boolean
  hint: string
}

/** anvil as a `NodeBinary` for `nodeSuiteReady`, given what `findAnvil` returned. */
export const anvilBinary = (path: string | undefined): NodeBinary => ({
  name: 'anvil',
  found: path !== undefined,
  hint: 'set ANVIL_BIN, install the @foundry-rs/anvil package (yarn install), or put anvil on PATH',
})

/**
 * Whether the suite `suite` can run. When a binary in `binaries` is missing: with
 * FRANK_REQUIRE_NODES=1 it throws, so the suite fails; otherwise it prints NOT RUN and returns
 * false, and the suite should skip itself.
 */
export function nodeSuiteReady(suite: string, binaries: NodeBinary[], env: Env = process.env): boolean {
  const missing = binaries.filter(binary => !binary.found)
  if (missing.length === 0) return true
  const needs = missing.map(binary => `${binary.name} (${binary.hint})`).join(' and ')
  if (nodesRequired(env))
    throw new Error(`${suite} needs ${needs}, and FRANK_REQUIRE_NODES=1 requires it to run.`)
  // eslint-disable-next-line no-console
  console.warn(`NOT RUN: ${suite} needs ${needs}. Nothing here was exercised.`)
  return false
}
