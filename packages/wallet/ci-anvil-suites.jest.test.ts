/**
 * An anvil suite skips itself (prints NOT RUN and passes) when it finds no anvil binary, so a
 * suite that hosted CI does not name, or names in a step that has no binary, is silently gone.
 * Every tracked `*.anvil.jest.test.ts` under app/ and packages/ must be named by a workflow step
 * that finds the binary, fails if it is missing (`test -x "$ANVIL_BIN"`), and passes it as
 * ANVIL_BIN to the `yarn workspace <package> test` (or `test:<script>`) command naming it.
 */
import { execFileSync } from 'child_process'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

const repo = join(__dirname, '..', '..')
const workflowsDir = join(repo, '.github', 'workflows')

/** Package name (`@frank/wallet`) to its directory relative to the repo (`packages/wallet`). */
const packageDirs = new Map<string, string>()
for (const dir of ['app', ...readdirSync(join(repo, 'packages')).map(name => `packages/${name}`)]) {
  const manifest = join(repo, dir, 'package.json')
  if (existsSync(manifest)) packageDirs.set(JSON.parse(readFileSync(manifest, 'utf8')).name, dir)
}

/** The steps of every workflow, each as its own block of lines. */
const steps = readdirSync(workflowsDir)
  .filter(name => /\.ya?ml$/.test(name))
  .flatMap(name =>
    readFileSync(join(workflowsDir, name), 'utf8')
      .split(/^\s*- (?=name:|run:|uses:)/m)
      .slice(1),
  )

const anvilSuites = execFileSync(
  'git',
  ['ls-files', '-z', 'app/**/*.anvil.jest.test.ts', 'packages/**/*.anvil.jest.test.ts'],
  { cwd: repo, encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean)

/** Repo-relative suites named by a step that requires the binary, matched as jest filters. */
const guarded = new Set<string>()
for (const block of steps) {
  if (!block.includes('test -x "$ANVIL_BIN"')) continue
  const exported = /export ANVIL_BIN=/.test(block)
  for (const line of block.split('\n')) {
    const match =
      line.match(/ANVIL_BIN=\S+.*yarn workspace ([@\w/-]+) test(?::[\w:]+)?(\s.*)$/) ??
      (exported ? line.match(/yarn workspace ([@\w/-]+) test(?::[\w:]+)?(\s.*)$/) : null)
    if (!match) continue
    const dir = packageDirs.get(match[1])
    if (!dir) continue
    const names = match[2].match(/[\w./-]+\.anvil\.jest\.test\.ts/g) ?? []
    for (const suite of anvilSuites) {
      if (!suite.startsWith(`${dir}/`)) continue
      const inPackage = relative(dir, suite)
      if (names.some(name => inPackage === name || inPackage.endsWith(`/${name}`)))
        guarded.add(suite)
    }
  }
}

describe('the anvil suites hosted CI runs', () => {
  it('finds the tracked anvil suites', () => {
    expect(anvilSuites.length).toBeGreaterThan(5)
  })
  it.each(anvilSuites)('%s is named by a step that requires the anvil binary', suite => {
    expect(guarded).toContain(suite)
  })
})
