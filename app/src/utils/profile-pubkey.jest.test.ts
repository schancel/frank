import { readFileSync } from 'fs'
import { join } from 'path'

import { ProfilePubKeyError, profilePubKeyFromBytes } from './profile-pubkey'

// secp256k1 generator. Compressed 33 bytes, then uncompressed 65 bytes.
const GENERATOR_COMPRESSED =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const GENERATOR_UNCOMPRESSED =
  '0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8'

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

describe('profilePubKeyFromBytes', () => {
  it('round-trips a compressed point and an uncompressed point', () => {
    const compressed = fromHex(GENERATOR_COMPRESSED)
    const uncompressed = fromHex(GENERATOR_UNCOMPRESSED)
    const compressedKey = profilePubKeyFromBytes(compressed)
    const uncompressedKey = profilePubKeyFromBytes(uncompressed)

    expect(hex(compressedKey.toBuffer())).toBe(GENERATOR_COMPRESSED)
    expect(hex(uncompressedKey.toBuffer())).toBe(GENERATOR_UNCOMPRESSED)
    expect(compressedKey.toBuffer()).not.toBe(compressed)
    expect(uncompressedKey.toBuffer()).not.toBe(uncompressed)

    const returned = compressedKey.toBuffer()
    returned[0] = 0
    expect(compressedKey.toBuffer()[0]).toBe(0x02)

    compressed[1] = 0
    uncompressed[10] = 0
    expect(hex(compressedKey.toBuffer())).toBe(GENERATOR_COMPRESSED)
    expect(hex(uncompressedKey.toBuffer())).toBe(GENERATOR_UNCOMPRESSED)
  })

  it('rejects a bad length, a bad prefix, and a non-point', () => {
    const badLength = fromHex(GENERATOR_COMPRESSED).subarray(0, 32)
    const badPrefix = fromHex(GENERATOR_COMPRESSED)
    badPrefix[0] = 0x01
    // x = 0 is not on the curve (y^2 = 7 has no root mod p).
    const nonPoint = new Uint8Array(33)
    nonPoint[0] = 0x02
    const before = Uint8Array.from(nonPoint)

    expect(() => profilePubKeyFromBytes(badLength)).toThrow(ProfilePubKeyError)
    expect(() => profilePubKeyFromBytes(badPrefix)).toThrow(ProfilePubKeyError)
    expect(() => profilePubKeyFromBytes(nonPoint)).toThrow(ProfilePubKeyError)
    expect(Array.from(nonPoint)).toEqual(Array.from(before))
    expect(badPrefix[0]).toBe(0x01)
  })

  it('does not import bitcore-lib-xpi from the profile public-key UI files', () => {
    const files = [
      'adapters/pinia-chain-adapter.ts',
      'components/contacts/ContactItem.vue',
      'pages/AddContact.vue',
      'stores/contacts.ts',
    ]
    for (const file of files) {
      const source = readFileSync(join(__dirname, '..', file), 'utf8')
      expect(source).not.toMatch(/from ['"]bitcore-lib-xpi['"]/)
    }
  })
})
