import { execFileSync } from 'child_process'
import { join } from 'path'
import pkg from '../package.json'
import runtime from '../runtime-deps.json'

const root = join(__dirname, '..')

describe('crypto-box runtime', () => {
  test('the package is ESM and has no runtime dependencies', () => {
    expect(pkg.type).toBe('module')
    expect(pkg.sideEffects).toBe(false)
    expect(pkg).not.toHaveProperty('dependencies')
    expect(Object.keys(pkg.exports)).toEqual(['.'])
    expect(runtime.allowed).toEqual([])
    expect(runtime.optional).toEqual([])
    expect(runtime.planned).toEqual(['@noble/ciphers', '@frank/nakamoto'])
    expect(runtime.plannedOptional).toEqual([])
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
