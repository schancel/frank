// Drift guard for ./level.d.ts, the repository's single hand-written declaration of the bare
// `level` module. It opens no database. It fails when:
//   - an installed Level package differs from the version the declaration was verified against
//     (re-verify level.d.ts against the new source, then update VERIFIED_AGAINST), or
//   - a second declaration of the bare `level` module appears anywhere in app/src or packages, or
//   - the app's tsconfig stops including the shared declaration.
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, relative, resolve } from 'path'

const repoRoot = resolve(__dirname, '../..')

const VERIFIED_AGAINST: Record<string, string> = {
  'level': '7.0.1',
  'level-packager': '6.0.1',
  'levelup': '5.1.1',
  'encoding-down': '7.1.0',
  'abstract-leveldown': '7.2.0',
  'deferred-leveldown': '7.0.0',
  'leveldown': '6.1.1',
  'level-js': '6.1.0',
}

function installedVersion(name: string): string {
  const manifest = require.resolve(`${name}/package.json`, {
    paths: [__dirname],
  })
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string })
    .version
}

function declarationFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name.startsWith('.')
    )
      continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) declarationFiles(path, found)
    else if (entry.name.endsWith('.d.ts')) found.push(path)
  }
  return found
}

describe('bare level declaration', () => {
  it('was verified against the installed Level packages', () => {
    const installed = Object.fromEntries(
      Object.keys(VERIFIED_AGAINST).map(name => [name, installedVersion(name)]),
    )
    expect(installed).toEqual(VERIFIED_AGAINST)
  })

  it('has exactly one owner', () => {
    const owners = ['app/src', 'packages']
      .map(directory => join(repoRoot, directory))
      .filter(existsSync)
      .flatMap(directory => declarationFiles(directory))
      .filter(path =>
        /declare\s+module\s+['"]level['"]/.test(readFileSync(path, 'utf8')),
      )
      .map(path => relative(repoRoot, path))
    expect(owners).toEqual(['packages/wallet/level.d.ts'])
  })

  it('is included by the app tsconfig', () => {
    const appTsconfig = readFileSync(
      join(repoRoot, 'app/tsconfig.json'),
      'utf8',
    )
    expect(appTsconfig).toContain('"../packages/wallet/level.d.ts"')
  })
})
