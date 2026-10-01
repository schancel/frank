import { execFileSync } from 'child_process'
import { join } from 'path'
import pkg from '../package.json'
import runtime from '../runtime-deps.json'

const root = join(__dirname, '..')

describe('crypto-box runtime', () => {
  test('the package is ESM and pins the section 11 cipher and hash builds', () => {
    expect(pkg.type).toBe('module')
    expect(pkg.sideEffects).toBe(false)
    expect(pkg.dependencies).toEqual({
      '@frank/nakamoto': '0.0.1',
      '@noble/ciphers': '1.3.0',
      '@noble/hashes': '1.8.0',
    })
    expect(Object.keys(pkg.exports)).toEqual(['.'])
    expect(runtime.allowed).toEqual([
      '@frank/nakamoto',
      '@noble/ciphers',
      '@noble/hashes',
    ])
    expect(runtime.optional).toEqual([])
    expect(runtime.planned).toEqual([])
    expect(runtime.plannedOptional).toEqual([])
    expect(JSON.stringify(pkg.dependencies)).not.toContain('^')
    expect(JSON.stringify(pkg.dependencies)).not.toContain('2.4.0')
    expect(JSON.stringify(pkg.dependencies)).not.toContain('2.3.0')
  })

  test('shared source and the dependency list pass their checks', () => {
    const shared = execFileSync(
      process.execPath,
      [join(root, 'scripts/check-shared.mjs')],
      { cwd: root, encoding: 'utf8' },
    )
    const deps = execFileSync(
      process.execPath,
      [join(root, 'scripts/check-deps.mjs')],
      { cwd: root, encoding: 'utf8' },
    )
    expect(shared).toContain('no Node built-ins')
    expect(deps).toContain('justified list')
  })
})
