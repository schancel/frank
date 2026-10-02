import { readFileSync } from 'fs'
import { join } from 'path'

import { PrivateKey, PublicKey, crypto as bitcoreCrypto } from 'bitcore-lib-xpi'

import { stampOutpointPublicKey } from './stamp-outpoint-pub'

const SECRET = '22'.repeat(32)
const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const ONE = `${'00'.repeat(31)}01`

function bitcoreCompressed(hex: string): Buffer {
  const key = new PrivateKey(hex)
  return Buffer.from(
    bitcoreCrypto.Point.pointToCompressed(key.toPublicKey().point),
  )
}

it('matches bitcore compressed stamp outpoint public keys', () => {
  const secret = Buffer.from(SECRET, 'hex')
  const bytes = stampOutpointPublicKey(secret)
  const wrapped = new PublicKey(Buffer.from(bytes))
  const described = wrapped.toObject() as { compressed: boolean }
  expect(Buffer.from(bytes)).toEqual(bitcoreCompressed(SECRET))
  expect(wrapped.toBuffer()).toEqual(bitcoreCompressed(SECRET))
  expect(described.compressed).toBe(true)
  expect(wrapped.network.name).toBe('livenet')
  expect(bytes.length).toBe(33)
  expect(wrapped.toAddress('testnet').toBuffer()).toEqual(
    new PublicKey(bitcoreCompressed(SECRET)).toAddress('testnet').toBuffer(),
  )
  expect(wrapped.toAddress('livenet').toBuffer()).toEqual(
    new PublicKey(bitcoreCompressed(SECRET)).toAddress('livenet').toBuffer(),
  )

  const almost = Buffer.from(N_MINUS_1, 'hex')
  expect(Buffer.from(stampOutpointPublicKey(almost))).toEqual(
    bitcoreCompressed(N_MINUS_1),
  )
  expect(Buffer.from(stampOutpointPublicKey(Buffer.from(ONE, 'hex')))).toEqual(
    bitcoreCompressed(ONE),
  )
  expect(secret.toString('hex')).toBe(SECRET)

  const index = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  const receiveStart = index.indexOf('async receiveMessage')
  const receive = index.slice(
    receiveStart,
    index.indexOf('Decode entries', receiveStart),
  )
  expect(receive).toContain('stampOutpointPublicKey(')
  expect(receive).not.toContain('pointToCompressed')
  expect(receive).not.toContain('point.mul')
  expect(receive).toContain('.toAddress(')
  const stealth = readFileSync(join(__dirname, 'decode-entry.ts'), 'utf8')
  expect(stealth).toContain('stealthOutpointPublicKey(')
  expect(stealth).not.toContain('pointToCompressed')
  const helper = readFileSync(join(__dirname, 'stamp-outpoint-pub.ts'), 'utf8')
  expect(helper).toContain('publicFromPrivate(')
  expect(helper).toContain('privateKeyFromSecretBytes(')
  expect(helper).not.toContain('point.mul')
  expect(helper).not.toContain('pointMultiply')
  expect(helper).not.toContain('point.add')
  expect(helper).not.toContain('899')
  expect(helper).not.toContain('10605')
})

it('rejects a secret outside (0, n) and a non-32-byte secret', () => {
  expect(() => stampOutpointPublicKey(Buffer.alloc(32))).toThrow(
    'stamp-outpoint-pub:scalar-out-of-range',
  )
  expect(() => stampOutpointPublicKey(Buffer.from(N_HEX, 'hex'))).toThrow(
    'stamp-outpoint-pub:scalar-out-of-range',
  )
  expect(() => stampOutpointPublicKey(Buffer.from('22'.repeat(31), 'hex'))).toThrow(
    'stamp-outpoint-pub:secret',
  )
  expect(() => stampOutpointPublicKey(Buffer.alloc(0))).toThrow(
    'stamp-outpoint-pub:secret',
  )
})
