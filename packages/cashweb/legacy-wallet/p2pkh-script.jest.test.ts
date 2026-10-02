import { createHash } from 'crypto'

import { p2pkhScriptFromPublicKey } from './index'

// lotusd src/test/descriptor_tests.cpp descriptor_test.
// WIF L4rK1yDtCWekvXuE6oXD9jCYfFNV2cWRpVuPLBcCU2z8TrisoyY1
const COMPRESSED = Buffer.from(
  '03a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd',
  'hex',
)
const UNCOMPRESSED = Buffer.from(
  '04a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd5b8dec5235a0fa8722476c7709c02559e3aa73aa03918ba2d492eea75abea235',
  'hex',
)
const LOTUSD_P2PKH = '76a9149a1c78a507689f6f54b847ad1cef1e614ee23f1e88ac'
const UNCOMPRESSED_P2PKH = '76a914b5bd079c4d57cc7fc28ecf8213a6b791625b818388ac'

function hash160(data: Buffer): Buffer {
  return createHash('ripemd160')
    .update(createHash('sha256').update(data).digest())
    .digest()
}

it('builds the lotusd descriptor P2PKH script from the serialized public key', () => {
  const built = p2pkhScriptFromPublicKey(COMPRESSED)
  expect(p2pkhScriptFromPublicKey(Uint8Array.from(COMPRESSED))).toEqual(built)
  expect(built.toString('hex')).toBe(LOTUSD_P2PKH)
  expect(built.subarray(3, 23)).toEqual(hash160(COMPRESSED))
  expect(built.length).toBe(25)

  expect(UNCOMPRESSED.length).toBe(65)
  const uncompressedScript = p2pkhScriptFromPublicKey(UNCOMPRESSED)
  expect(uncompressedScript.toString('hex')).toBe(UNCOMPRESSED_P2PKH)
  expect(uncompressedScript.subarray(3, 23)).toEqual(hash160(UNCOMPRESSED))
  expect(uncompressedScript.length).toBe(25)
  expect(uncompressedScript.equals(built)).toBe(false)
})
