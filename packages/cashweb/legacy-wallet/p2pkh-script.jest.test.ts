import { readFileSync } from 'fs'
import { join } from 'path'

import { PublicKey, Script } from 'bitcore-lib-xpi'

import { p2pkhScriptFromPublicKey } from './index'

// lotusd src/test/descriptor_tests.cpp descriptor_test.
// WIF L4rK1yDtCWekvXuE6oXD9jCYfFNV2cWRpVuPLBcCU2z8TrisoyY1
const COMPRESSED =
  '03a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd'
const LOTUSD_P2PKH = '76a9149a1c78a507689f6f54b847ad1cef1e614ee23f1e88ac'

function bitcoreScript(publicKey: PublicKey): Buffer {
  return Script.buildPublicKeyHashOut(publicKey).toBuffer()
}

it('builds the lotusd descriptor P2PKH script from the serialized public key', () => {
  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  expect(source).toContain('export function p2pkhScriptFromPublicKey')
  expect(source).toContain('lockingScript')
  expect(source).not.toContain('Script.buildPublicKeyHashOut(key.toPublicKey())')
  expect(source).not.toContain('new Script(new Address(')

  const compressed = new PublicKey(COMPRESSED)
  const built = p2pkhScriptFromPublicKey(compressed)
  expect(built.toString('hex')).toBe(LOTUSD_P2PKH)
  expect(bitcoreScript(compressed).equals(built)).toBe(true)
  expect(built.length).toBe(25)

  const fromPoint = PublicKey.fromPoint as (
    point: PublicKey['point'],
    compressed: boolean,
  ) => PublicKey
  const uncompressed = fromPoint(compressed.point, false)
  expect(uncompressed.toBuffer().length).toBe(65)
  const uncompressedScript = p2pkhScriptFromPublicKey(uncompressed)
  expect(bitcoreScript(uncompressed).equals(uncompressedScript)).toBe(true)
  expect(uncompressedScript.length).toBe(25)
  expect(uncompressedScript.equals(built)).toBe(false)
})
