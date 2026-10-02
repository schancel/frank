import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

import { verifyEcdsa } from '@frank/nakamoto'
import { PrivateKey, crypto as bitcoreCrypto } from 'bitcore-lib-xpi'

import __pb_metadata_pb from './metadata_pb'
import { RegistryHandler, registryAddressMetadataDigest } from './index'

const { AddressMetadata } = __pb_metadata_pb

const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
// prost AddressMetadata { timestamp: 1234, ttl: 10, entries: [] }
// encode_to_vec, then Sha256::digest. Field 1 varint 1234, field 2 varint 10.
const EMPTY_ENTRIES_METADATA = Buffer.from('08d209100a', 'hex')
const EMPTY_ENTRIES_SHA256 =
  '34095659432189c2f20da437d34a0f2a1de9016ab1ca3d4e12e4390153aac0f0'
const SECRET =
  '12b004fff7f4b69ef8650e767f18f11ede158148b425660723b9f9a66e61f747'

function methodBody(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

it('hashes address metadata with one SHA-256', () => {
  const empty = Buffer.from(registryAddressMetadataDigest(new Uint8Array()))
  expect(empty.toString('hex')).toBe(EMPTY_SHA256)
  expect(empty.toString('hex')).toBe(
    createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
  )
  expect(empty).toEqual(bitcoreCrypto.Hash.sha256(Buffer.alloc(0)))

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
  expect(digest).toEqual(bitcoreCrypto.Hash.sha256(encoded))
  const doubled = createHash('sha256').update(digest).digest('hex')
  expect(digest.toString('hex')).not.toBe(doubled)
})

it('signs relay-url metadata over that digest', () => {
  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  const relayUrl = methodBody(
    source,
    'constructRelayUrlMetadata(',
    'async fetchMetadata',
  )
  const payment = methodBody(
    source,
    'async updateKeyMetadata(',
    'private constructBurnTransaction',
  )
  expect(relayUrl).toContain('registryAddressMetadataDigest')
  expect(relayUrl).not.toContain('crypto.Hash')
  expect(payment).toContain('registryAddressMetadataDigest')
  expect(payment).not.toContain('crypto.Hash')
  expect(payment).not.toContain('.buffer')

  const privKey = new PrivateKey(SECRET)
  const handler = new RegistryHandler({
    registrys: ['https://registry.example'],
    networkName: 'livenet',
  })
  const signed = handler.constructRelayUrlMetadata('https://relay.example', privKey)
  const payload = signed.getPayload_asU8()
  const digest = bitcoreCrypto.Hash.sha256(Buffer.from(payload))
  expect(Buffer.from(registryAddressMetadataDigest(payload))).toEqual(digest)
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
