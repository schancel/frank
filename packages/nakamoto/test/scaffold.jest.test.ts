import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { crypto as oldCrypto } from 'bitcore-lib-xpi'
import { PACKAGE_NAME } from '../src'

const FIXTURE = 'nakamoto-scaffold-v1'
const FIXTURE_SHA256 =
  'c4cd3722ce06dad69e6bbc384c0e96d2c531e96174b7a87182431a99ac96c63a'

describe('@frank/nakamoto scaffold', () => {
  test('public entry does not name or import the old library', () => {
    const entry = readFileSync(join(__dirname, '../src/index.ts'), 'utf8')
    expect(PACKAGE_NAME).toBe('@frank/nakamoto')
    expect(entry.toLowerCase()).not.toContain('bitcore')
    expect(entry).not.toContain('node:')
    expect(entry).not.toContain("from 'crypto'")
    expect(entry).not.toContain("from 'fs'")
  })

  test('old-library sha256 matches Node on a fixed input', () => {
    const input = Buffer.from(FIXTURE, 'utf8')
    const fromOld = oldCrypto.Hash.sha256(input)
    const fromNode = createHash('sha256').update(input).digest()
    expect(fromOld.equals(fromNode)).toBe(true)
    expect(fromNode.toString('hex')).toBe(FIXTURE_SHA256)
  })
})
