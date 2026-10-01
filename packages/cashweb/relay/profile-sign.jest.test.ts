import { readFileSync } from 'fs'
import { join } from 'path'

import { verifyEcdsa } from '@frank/nakamoto'
import { PrivateKey, crypto as bitcoreCrypto } from 'bitcore-lib-xpi'

import { MessageConstructor } from './constructors'

// Profile metadata keeps bitcore's compact r||s (header byte removed): r is
// minimal, s is 32 bytes. signRegistryDigest is that encoding (decision #489).
// libsecp256k1's ECDSA+DER nonce tag is not used.

it('signs profile metadata as the bitcore compact r||s bytes', () => {
  const source = readFileSync(join(__dirname, 'constructors.ts'), 'utf8')
  expect(source).not.toContain('ECDSA.sign')
  expect(source).not.toContain('toCompact')
  expect(source).toContain('signRegistryDigest')

  const privKey = new PrivateKey(
    '12b004fff7f4b69ef8650e767f18f11ede158148b425660723b9f9a66e61f747',
  )
  const ctor = new MessageConstructor({ networkName: 'livenet' })
  const priceFilter = ctor.constructPriceFilter(false, 1, 2)
  const signed = ctor.constructProfileMetadata(
    { name: 'Ada', bio: 'profile' },
    priceFilter,
    privKey,
  )
  const payload = signed.getPayload_asU8()
  const digest = bitcoreCrypto.Hash.sha256(Buffer.from(payload))
  const live = bitcoreCrypto.ECDSA.sign(digest, privKey)
  const signature = Buffer.from(signed.getSignature_asU8())
  expect(signature.toString('hex')).toBe(
    live.toCompact(1, true).slice(1).toString('hex'),
  )

  const pubkey = Uint8Array.from(privKey.toPublicKey().toBuffer())
  expect(
    verifyEcdsa(
      Uint8Array.from(live.toBuffer()),
      Uint8Array.from(digest),
      pubkey,
    ),
  ).toEqual({ ok: true, value: true })
})
