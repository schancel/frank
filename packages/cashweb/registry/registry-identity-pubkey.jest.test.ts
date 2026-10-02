import { readFileSync } from 'fs'
import { join } from 'path'

import { PrivateKey } from 'bitcore-lib-xpi'

import { registryIdentityPublicKey } from './identity-pubkey'
import { RegistryHandler } from './index'

const SECRET = '22'.repeat(32)
const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const ONE = `${'00'.repeat(31)}01`

function bitcorePublicKey(hex: string, compressed: boolean): Buffer {
  const key = compressed
    ? new PrivateKey(hex)
    : new PrivateKey(Buffer.from(hex, 'hex'))
  return key.toPublicKey().toBuffer()
}

function methodBody(source: string, name: string, next: string): string {
  const start = source.indexOf(name)
  const end = source.indexOf(next, start)
  return source.slice(start, end)
}

it('matches bitcore registry identity public keys', () => {
  const secret = Buffer.from(SECRET, 'hex')
  const compressed = registryIdentityPublicKey(secret, true)
  expect(Buffer.from(compressed)).toEqual(bitcorePublicKey(SECRET, true))
  expect(compressed.length).toBe(33)
  expect(Buffer.from(registryIdentityPublicKey(secret, false))).toEqual(
    bitcorePublicKey(SECRET, false),
  )
  expect(registryIdentityPublicKey(secret, false).length).toBe(65)

  const almost = Buffer.from(N_MINUS_1, 'hex')
  expect(Buffer.from(registryIdentityPublicKey(almost, true))).toEqual(
    bitcorePublicKey(N_MINUS_1, true),
  )
  expect(
    Buffer.from(registryIdentityPublicKey(Buffer.from(ONE, 'hex'), true)),
  ).toEqual(bitcorePublicKey(ONE, true))
  expect(secret.toString('hex')).toBe(SECRET)
  expect(almost.toString('hex')).toBe(N_MINUS_1)

  const privKey = new PrivateKey(SECRET)
  expect(privKey.toBuffer().toString('hex')).toBe(SECRET)
  const registry = new RegistryHandler({
    registrys: ['https://registry.example'],
    networkName: 'livenet',
  })
  const signed = registry.constructRelayUrlMetadata('https://relay.example', privKey)
  expect(Buffer.from(signed.getPublicKey_asU8())).toEqual(
    privKey.toPublicKey().toBuffer(),
  )
  expect(privKey.toBuffer().toString('hex')).toBe(SECRET)

  const uncompressed = new PrivateKey(Buffer.from(SECRET, 'hex'))
  const uncompressedSigned = registry.constructRelayUrlMetadata(
    'https://relay.example',
    uncompressed,
  )
  expect(Buffer.from(uncompressedSigned.getPublicKey_asU8())).toEqual(
    uncompressed.toPublicKey().toBuffer(),
  )
  expect(uncompressed.toPublicKey().toBuffer().length).toBe(65)

  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  const metadata = methodBody(
    source,
    'constructRelayUrlMetadata(',
    'async fetchMetadata(',
  )
  const broadcast = methodBody(source, 'async createBroadcast(', 'async addOfferings(')
  const offerings = methodBody(source, 'async addOfferings(', 'parseWrapper(')
  for (const body of [metadata, broadcast, offerings]) {
    expect(body).toContain('registryIdentityPoint(')
    expect(body).not.toContain('toPublicKey')
  }
  expect(broadcast).toContain('crypto.Hash.sha256(')
  expect(offerings).not.toContain('crypto.Hash.sha256(')
  const burn = methodBody(
    source,
    'private constructBurnTransaction(',
    'async createBroadcast(',
  )
  expect(burn).toContain('registryBurnOutput(')
  expect(burn).not.toContain('new Transaction.Output(')
  expect(source).toContain('PublicKey.fromBuffer(')
  expect(source).toContain('crypto.Hash.sha256(')

  const helper = readFileSync(join(__dirname, 'identity-pubkey.ts'), 'utf8')
  expect(helper).toContain('publicFromPrivate(')
  expect(helper).toContain('privateKeyFromSecretBytes(')
  expect(helper).not.toContain('point.mul')
  expect(helper).not.toContain('pointMultiply')
  expect(helper).not.toContain('point.add')
  expect(helper).not.toContain('899')
  expect(helper).not.toContain('10605')
})

it('rejects a secret outside (0, n), a non-32-byte secret, and a missing flag', () => {
  expect(() => registryIdentityPublicKey(Buffer.alloc(32), true)).toThrow(
    'registry-identity-pubkey:scalar-out-of-range',
  )
  expect(() =>
    registryIdentityPublicKey(Buffer.from(N_HEX, 'hex'), true),
  ).toThrow('registry-identity-pubkey:scalar-out-of-range')
  expect(() =>
    registryIdentityPublicKey(Buffer.from('22'.repeat(31), 'hex'), true),
  ).toThrow('registry-identity-pubkey:secret')
  expect(() => registryIdentityPublicKey(Buffer.alloc(0), false)).toThrow(
    'registry-identity-pubkey:secret',
  )
  const kept = Buffer.from(SECRET, 'hex')
  expect(() =>
    registryIdentityPublicKey(kept, undefined as unknown as boolean),
  ).toThrow('registry-identity-pubkey:compressed')
  expect(kept.toString('hex')).toBe(SECRET)

  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  const point = source.slice(
    source.indexOf('function registryIdentityPoint('),
    source.indexOf('function calculateBurnAmount('),
  )
  expect(point).toContain('registry-identity-pubkey:compressed')
  expect(point).toContain('registryIdentityPublicKey(')
  expect(point).not.toContain('toPublicKey')
})
