import { createHash } from 'crypto'

import { privateKeyFromHex, signEcdsa, verifyEcdsa } from '@frank/nakamoto'

import { MessageConstructor, relayProfilePayloadDigest } from './constructors'
import { compactRsFromDer } from '../registry'
import { sec1Point, sec1PrivateKey, SEC1_IDENTITY } from '../sec1-pins'

const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

// Profile metadata keeps compact r||s (header byte removed): r is
// minimal, s is 32 bytes. signRegistryDigest is that encoding (decision #489).
// libsecp256k1's ECDSA+DER nonce tag is not used.

it('signs profile metadata as compact r||s bytes', () => {
  const privKey = sec1PrivateKey(SEC1_IDENTITY, true)
  const ctor = new MessageConstructor({ networkName: 'livenet' })
  const priceFilter = ctor.constructPriceFilter(false, 1, 2)
  const signed = ctor.constructProfileMetadata(
    { name: 'Ada', bio: 'profile' },
    priceFilter,
    privKey,
  )
  const payload = signed.getPayload_asU8()
  const digest = createHash('sha256').update(Buffer.from(payload)).digest()
  expect(Buffer.from(relayProfilePayloadDigest(payload))).toEqual(digest)
  const parsed = privateKeyFromHex(SEC1_IDENTITY, true)
  if (!parsed.ok) throw new Error(parsed.error.code)
  try {
    const der = signEcdsa(parsed.value, Uint8Array.from(digest))
    if (!der.ok) throw new Error(der.error.code)
    const signature = Buffer.from(signed.getSignature_asU8())
    expect(signature).toEqual(compactRsFromDer(der.value))
    expect(
      verifyEcdsa(
        der.value,
        Uint8Array.from(digest),
        Uint8Array.from(sec1Point(SEC1_IDENTITY, true)),
      ),
    ).toEqual({ ok: true, value: true })
  } finally {
    parsed.value.bytes.fill(0)
  }
})

it('hashes profile payloads with one SHA-256', () => {
  const empty = Buffer.from(relayProfilePayloadDigest(new Uint8Array()))
  expect(empty.toString('hex')).toBe(EMPTY_SHA256)
  expect(empty.toString('hex')).toBe(
    createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
  )

  const sample = Uint8Array.from([0, 1, 2, 255, 16])
  const digest = Buffer.from(relayProfilePayloadDigest(sample))
  expect(digest.toString('hex')).toBe(
    createHash('sha256').update(sample).digest('hex'),
  )
  const doubled = createHash('sha256')
    .update(createHash('sha256').update(sample).digest())
    .digest('hex')
  expect(digest.toString('hex')).not.toBe(doubled)
})
