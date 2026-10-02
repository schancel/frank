import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

import { verifyEcdsa } from '@frank/nakamoto'

import { FrankIdentity } from './lotus-identity'

// lotusd src/test/key_tests.cpp. strSecret1 is WIF
// 5HxWvvfubhXpYYpS3tJkw6fq9jE9j18THftkZjHHfmFiWtmAbrj (compressed address
// 1NoJrossxPBKfCHuJXT4HadJrXRE9Fxiqs). Hash("Very deterministic message")
// is SHA-256d. libsecp256k1 mixes the 16-byte tag "ECDSA+DER       " into
// RFC6979, so its DER differs from @frank/nakamoto signEcdsa, which matches
// the bitcore signer this call replaces. Both signatures verify.
const SECRET =
  '12b004fff7f4b69ef8650e767f18f11ede158148b425660723b9f9a66e61f747'
const BITCORE_DER =
  '304402205dbbddda71772d95ce91cd2d14b592cfbc1dd0aabd6a394b6c2d377bbe59d31d022014ddda21494a4e221f0824f0b8b924c43fa43c0ad57dccdaa11f81a6bd4582f6'
const LOTUSD_DER =
  '304402200c648ad9936cae4006f0b0d7bcbacdcdf5a14260eb550c31ddb1eb1a13b1b58602201b868673bb5926d1610a07cd03692dfdcb98ed059314f66b457a794f2c4b8e79'

function sha256d(text: string): Buffer {
  const first = createHash('sha256').update(text).digest()
  return createHash('sha256').update(first).digest()
}

it('signs the lotusd key_tests deterministic ECDSA vector', () => {
  const source = readFileSync(join(__dirname, 'lotus-identity.ts'), 'utf8')
  expect(source).not.toContain('ECDSA.sign')

  const identity = FrankIdentity.fromPrivateKeyHex(SECRET, 'mainnet')
  const digest = sha256d('Very deterministic message')
  const signature = identity.signHash(digest)
  expect(signature.toString('hex')).toBe(BITCORE_DER)

  const pubkey = Uint8Array.from(identity.pubKey)
  const message = Uint8Array.from(digest)
  expect(verifyEcdsa(Uint8Array.from(signature), message, pubkey)).toEqual({
    ok: true,
    value: true,
  })
  expect(
    verifyEcdsa(
      Uint8Array.from(Buffer.from(LOTUSD_DER, 'hex')),
      message,
      pubkey,
    ),
  ).toEqual({ ok: true, value: true })

  expect(() => identity.signHash(Buffer.alloc(31))).toThrow('sign-digest')
})
