/**
 * A suite on a real node (anvil, a Chronik bitcoind) decides whether it can run through
 * `nodeSuiteReady` (node-binaries.testutil.ts): without its binary it reports NOT RUN and skips,
 * unless FRANK_REQUIRE_NODES=1 is set, when it fails. So the suite itself guarantees it ran, and
 * this check only needs every tracked anvil suite (`*.anvil.*.ts`) and regtest suite
 * (`*.regtest.jest.test.ts`) under app/ and packages/ to be:
 *   - named by a workflow step that sets FRANK_REQUIRE_NODES=1 and runs it with
 *     `yarn workspace <package> <script>`, where that package's script runs jest, and
 *   - free of its own NOT RUN skip, so the shared decision is the only one.
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

/** The steps of every workflow that set FRANK_REQUIRE_NODES=1, each as its own block of lines. */
const requiringSteps = readdirSync(workflowsDir)
  .filter(name => /\.ya?ml$/.test(name))
  .flatMap(name =>
    readFileSync(join(workflowsDir, name), 'utf8')
      .split(/^\s*- (?=name:|run:|uses:)/m)
      .slice(1),
  )
  .filter(block => /^\s*FRANK_REQUIRE_NODES: ["']?1["']?\s*$/m.test(block))

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

/** The suites a `yarn workspace <package> <jest script> ...` line in a requiring step names. */
const named = new Set<string>()
for (const block of requiringSteps) {
  for (const line of block.split('\n')) {
    const match = line.match(/yarn workspace ([@\w/-]+) ([\w:-]+)(\s.*)?$/)
    if (!match) continue
    const pkg = packages.get(match[1])
    if (!pkg || !/^jest\b/.test(pkg.scripts[match[2]] ?? '')) continue
    // A bare name, or a `--testMatch '<rootDir>/...'` path.
    const names = ((match[3] ?? '').match(/[\w./-]+\.(anvil|regtest)\.[\w.]+\.ts/g) ?? []).map(name =>
      name.replace(/^\//, ''),
    )
    for (const suite of suites) {
      if (!suite.startsWith(`${pkg.dir}/`)) continue
      const inPackage = relative(pkg.dir, suite)
      if (names.some(name => inPackage === name || inPackage.endsWith(`/${name}`))) named.add(suite)
    }
  }
}

describe('the suites on a real node that hosted CI runs', () => {
  it('finds the tracked suites and the steps that require nodes', () => {
    expect(suites.length).toBeGreaterThan(5)
    expect(requiringSteps.length).toBeGreaterThan(0)
  })

  it.each(Object.keys(NOT_IN_CI))('%s, listed as not run in CI, exists and is unnamed', suite => {
    expect(suites).toContain(suite)
    expect(named.has(suite)).toBe(false)
  })

  it.each(suites.filter(suite => !(suite in NOT_IN_CI)))(
    '%s is named by a step that sets FRANK_REQUIRE_NODES=1',
    suite => {
      expect(named.has(suite)).toBe(true)
    },
  )

  it.each(suites)('%s has no NOT RUN skip of its own', suite => {
    expect(readFileSync(join(repo, suite), 'utf8')).not.toMatch(/['"`]NOT RUN/)
  })
})
