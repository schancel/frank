import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  RESERVED_PROOF_SUITE_ID,
  ReservedSuiteError,
  isProducedSuite,
  isReservedSuiteError,
  producedSuiteIds,
  refuseReservedSuite,
} from '../src'

function listSources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (name.endsWith('.ts')) out.push(readFileSync(path, 'utf8'))
  }
  return out
}

describe('@frank/crypto-box scaffold', () => {
  test('suite 65535 is never produced', () => {
    expect(RESERVED_PROOF_SUITE_ID).toBe(65535)
    expect(producedSuiteIds).not.toContain(65535)
    expect(isProducedSuite(65535)).toBe(false)
    expect(isProducedSuite(1)).toBe(false)
    expect(isProducedSuite(0xfe01)).toBe(true)
    expect(producedSuiteIds).toEqual([0xfe01, 0xfe02, 0xfe03, 0xfe04])
    expect(() => refuseReservedSuite(1)).not.toThrow()
    try {
      refuseReservedSuite(65535)
      throw new Error('expected the reserved suite to be refused')
    } catch (error) {
      expect(isReservedSuiteError(error)).toBe(true)
      if (isReservedSuiteError(error)) expect(error.suiteId).toBe(65535)
    }
    const foreign = Object.assign(new Error('other copy'), {
      code: 'reserved-suite',
      suiteId: 65535,
    })
    expect(foreign instanceof ReservedSuiteError).toBe(false)
    expect(isReservedSuiteError(foreign)).toBe(true)
    expect(isReservedSuiteError({ code: 'reserved-suite' })).toBe(false)
    expect(isReservedSuiteError(null)).toBe(false)
  })

  test('shared source does not import Node, forge, or AES-CBC', () => {
    const sources = listSources(join(__dirname, '../src'))
    expect(sources.length).toBeGreaterThan(0)
    for (const source of sources) {
      expect(source).not.toContain('node:')
      expect(source).not.toContain("from 'crypto'")
      expect(source).not.toContain("from 'fs'")
      expect(source.toLowerCase()).not.toContain('node-forge')
      expect(source.toLowerCase()).not.toContain('aes-cbc')
      expect(source.toLowerCase()).not.toContain('aes-256-cbc')
      expect(source.toLowerCase()).not.toContain('bitcore')
    }
  })
})
