/**
 * A suite on a real node skips itself (prints NOT RUN and passes) when it finds no node binary,
 * so a suite that hosted CI does not name, or names in a step that has no binary, is silently
 * gone. Every tracked anvil suite (`*.anvil.*.ts`) and regtest suite (`*.regtest.jest.test.ts`)
 * under app/ and packages/ must be named by a workflow step that:
 *   - finds each binary the suite needs and fails if it is missing
 *     (`test -x "$ANVIL_BIN" || { ...; exit 1; }`, and for a Chronik bitcoind
 *     `test -x "$BITCOIND" || { ...; exit 1; }`),
 *   - hands it to the command (ANVIL_BIN, FRANK_BITCOIN_ABC_BIN_DIR), and
 *   - runs it with `yarn workspace <package> <script>`, where that package's script runs jest.
 * A suite needs anvil if it is an anvil suite or reads ANVIL_BIN, and a bitcoind if it uses
 * `availableBitcoinAbc`.
 */
import { execFileSync } from 'child_process'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

const repo = join(__dirname, '..', '..')
const workflowsDir = join(repo, '.github', 'workflows')

/** Suites no hosted job can run yet, each with the reason. A stale entry fails below. */
const NOT_IN_CI: Record<string, string> = {
  'app/src/components/wallet/wallet-history.devices.regtest.jest.test.ts':
    'needs solonet (monad-regtest) and a cashwebd relay build; runs only with FRANK_REGTEST_LIVE=1',
}

/** Package name (`@frank/wallet`) to its directory and scripts. */
const packages = new Map<string, { dir: string; scripts: Record<string, string> }>()
for (const dir of ['app', ...readdirSync(join(repo, 'packages')).map(name => `packages/${name}`)]) {
  const manifest = join(repo, dir, 'package.json')
  if (!existsSync(manifest)) continue
  const { name, scripts } = JSON.parse(readFileSync(manifest, 'utf8'))
  packages.set(name, { dir, scripts: scripts ?? {} })
}

/** The steps of every workflow, each as its own block of lines. */
const steps = readdirSync(workflowsDir)
  .filter(name => /\.ya?ml$/.test(name))
  .flatMap(name =>
    readFileSync(join(workflowsDir, name), 'utf8')
      .split(/^\s*- (?=name:|run:|uses:)/m)
      .slice(1),
  )

const suites = execFileSync(
  'git',
  [
    'ls-files',
    '-z',
    'app/**/*.anvil.*.ts',
    'packages/**/*.anvil.*.ts',
    'app/**/*.regtest.jest.test.ts',
    'packages/**/*.regtest.jest.test.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean)

function needs(suite: string): { anvil: boolean; bitcoind: boolean } {
  const source = readFileSync(join(repo, suite), 'utf8')
  return {
    anvil: /\.anvil\./.test(suite) || source.includes('ANVIL_BIN'),
    bitcoind: source.includes('availableBitcoinAbc'),
  }
}

/** The check fails the step: `test -x "$X" || { ... exit 1; }`, not `|| true`. */
const failingCheck = (block: string, variable: string) =>
  new RegExp(`test -x "\\$${variable}" \\|\\| \\{[^}]*\\bexit 1;? *\\}`).test(block)

/** The binary reaches the command: set on its line, or exported earlier in the step. */
const handed = (block: string, line: string, variable: string) =>
  new RegExp(`\\b${variable}=\\S`).test(line) || new RegExp(`export ${variable}=`).test(block)

/** Each suite, with the requirements of the steps that name it. */
const coverage = new Map<string, { anvil: boolean; bitcoind: boolean }[]>()
for (const block of steps) {
  const anvil = failingCheck(block, 'ANVIL_BIN')
  const bitcoind = failingCheck(block, 'BITCOIND')
  for (const line of block.split('\n')) {
    const match = line.match(/yarn workspace ([@\w/-]+) ([\w:-]+)(\s.*)?$/)
    if (!match) continue
    const pkg = packages.get(match[1])
    if (!pkg || !/^jest\b/.test(pkg.scripts[match[2]] ?? '')) continue
    const names = (match[3] ?? '').match(/[\w./-]+\.(anvil|regtest)\.[\w.]+\.ts/g) ?? []
    for (const suite of suites) {
      if (!suite.startsWith(`${pkg.dir}/`)) continue
      const inPackage = relative(pkg.dir, suite)
      const named = names.some(name => {
        const bare = name.replace(/^\//, '')
        return inPackage === bare || inPackage.endsWith(`/${bare}`)
      })
      if (!named) continue
      coverage.set(suite, [
        ...(coverage.get(suite) ?? []),
        {
          anvil: anvil && handed(block, line, 'ANVIL_BIN'),
          bitcoind: bitcoind && handed(block, line, 'FRANK_BITCOIN_ABC_BIN_DIR'),
        },
      ])
    }
  }
}

describe('the suites on a real node that hosted CI runs', () => {
  it('finds the tracked suites', () => {
    expect(suites.length).toBeGreaterThan(5)
  })

  it.each(Object.keys(NOT_IN_CI))('%s, listed as not run in CI, exists and is unnamed', suite => {
    expect(suites).toContain(suite)
    expect(coverage.has(suite)).toBe(false)
  })

  it.each(suites.filter(suite => !(suite in NOT_IN_CI)))(
    '%s is named by a step that requires every binary it needs',
    suite => {
      const need = needs(suite)
      const steps = coverage.get(suite) ?? []
      expect(steps.length).toBeGreaterThan(0)
      for (const step of steps) {
        if (need.anvil) expect(step.anvil).toBe(true)
        if (need.bitcoind) expect(step.bitcoind).toBe(true)
      }
    },
  )
})
