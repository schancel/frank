import { stampOutpointPublicKey } from './stamp-outpoint-pub'
import { sec1Point, SEC1_N_MINUS_1, SEC1_ONE, SEC1_SECRET } from '../sec1-pins'

const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'

it('matches the pinned compressed stamp outpoint public keys', () => {
  const secret = Buffer.from(SEC1_SECRET, 'hex')
  const bytes = stampOutpointPublicKey(secret)
  expect(Buffer.from(bytes)).toEqual(sec1Point(SEC1_SECRET, true))
  expect(bytes.length).toBe(33)
  expect(bytes[0] === 0x02 || bytes[0] === 0x03).toBe(true)

  const almost = Buffer.from(SEC1_N_MINUS_1, 'hex')
  expect(Buffer.from(stampOutpointPublicKey(almost))).toEqual(
    sec1Point(SEC1_N_MINUS_1, true),
  )
  expect(Buffer.from(stampOutpointPublicKey(Buffer.from(SEC1_ONE, 'hex')))).toEqual(
    sec1Point(SEC1_ONE, true),
  )
  expect(secret.toString('hex')).toBe(SEC1_SECRET)
})

it('rejects a secret outside (0, n) and a non-32-byte secret', () => {
  expect(() => stampOutpointPublicKey(Buffer.alloc(32))).toThrow(
    'stamp-outpoint-pub:scalar-out-of-range',
  )
  expect(() => stampOutpointPublicKey(Buffer.from(N_HEX, 'hex'))).toThrow(
    'stamp-outpoint-pub:scalar-out-of-range',
  )
  expect(() =>
    stampOutpointPublicKey(Buffer.from('22'.repeat(31), 'hex')),
  ).toThrow('stamp-outpoint-pub:secret')
  expect(() => stampOutpointPublicKey(Buffer.alloc(0))).toThrow(
    'stamp-outpoint-pub:secret',
  )
})
