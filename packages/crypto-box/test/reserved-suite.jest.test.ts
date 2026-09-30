import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  RESERVED_PROOF_SUITE_ID,
  ReservedSuiteError,
  isProducedSuite,
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
    expect(() => refuseReservedSuite(65535)).toThrow(ReservedSuiteError)
    expect(() => refuseReservedSuite(1)).not.toThrow()
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
