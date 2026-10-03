import { createHash } from 'crypto'

import { privateKeyFromHex, signEcdsa, verifyEcdsa } from '@frank/nakamoto'

import __pb_metadata_pb from './metadata_pb'
import { RegistryHandler, compactRsFromDer, registryAddressMetadataDigest } from './index'
import { sec1Point, sec1PrivateKey, SEC1_IDENTITY } from '../sec1-pins'

const { AddressMetadata } = __pb_metadata_pb

const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
// prost AddressMetadata { timestamp: 1234, ttl: 10, entries: [] }
// encode_to_vec, then Sha256::digest. Field 1 varint 1234, field 2 varint 10.
const EMPTY_ENTRIES_METADATA = Buffer.from('08d209100a', 'hex')
const EMPTY_ENTRIES_SHA256 =
  '34095659432189c2f20da437d34a0f2a1de9016ab1ca3d4e12e4390153aac0f0'

it('hashes address metadata with one SHA-256', () => {
  const empty = Buffer.from(registryAddressMetadataDigest(new Uint8Array()))
  expect(empty.toString('hex')).toBe(EMPTY_SHA256)
  expect(empty.toString('hex')).toBe(
    createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
  )

  const metadata = new AddressMetadata()
  metadata.setTimestamp(1234)
  metadata.setTtl(10)
  const encoded = Buffer.from(metadata.serializeBinary())
  expect(encoded).toEqual(EMPTY_ENTRIES_METADATA)
  const digest = Buffer.from(registryAddressMetadataDigest(encoded))
  expect(digest).toHaveLength(32)
  expect(digest.toString('hex')).toBe(EMPTY_ENTRIES_SHA256)
  expect(digest.toString('hex')).toBe(
    createHash('sha256').update(encoded).digest('hex'),
  )
  const doubled = createHash('sha256').update(digest).digest('hex')
  expect(digest.toString('hex')).not.toBe(doubled)
})

it('signs relay-url metadata over that digest', () => {
  const privKey = sec1PrivateKey(SEC1_IDENTITY, true)
  const handler = new RegistryHandler({
    registrys: ['https://registry.example'],
    networkName: 'livenet',
  })
  const signed = handler.constructRelayUrlMetadata(
    'https://relay.example',
    privKey,
  )
  const payload = signed.getPayload_asU8()
  const digest = createHash('sha256').update(Buffer.from(payload)).digest()
  expect(Buffer.from(registryAddressMetadataDigest(payload))).toEqual(digest)
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
