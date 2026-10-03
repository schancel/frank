import { createHash } from 'crypto'

import { sha256 } from '@frank/crypto-box'

import { PayloadConstructor } from './crypto'
import { stealthPointDigest } from './stealth-point-digest'
import {
  addedPoint,
  addedSecretMod,
  digestSha256,
  secretKey,
  sharedPoint,
} from '../nakamoto-oracle'

const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const ABC_SHA256 =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

const DEST_SECRET = '11'.repeat(32)
const EPHEMERAL_SECRET = '22'.repeat(32)

it('hashes a compressed stealth point with one SHA-256', () => {
  const empty = Buffer.from(stealthPointDigest(new Uint8Array()))
  expect(empty.toString('hex')).toBe(EMPTY_SHA256)
  expect(empty.toString('hex')).toBe(
    createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
  )
  expect(empty).toEqual(Buffer.from(sha256(new Uint8Array())))

  const abc = Buffer.from('abc')
  const abcDigest = Buffer.from(stealthPointDigest(Uint8Array.from(abc)))
  expect(abcDigest.toString('hex')).toBe(ABC_SHA256)
  expect(abcDigest.toString('hex')).toBe(
    createHash('sha256').update(abc).digest('hex'),
  )
  expect(abcDigest).toEqual(Buffer.from(sha256(Uint8Array.from(abc))))

  const leadingZero = Uint8Array.from([0x02, 0x00, 0x01])
  const leadingZeroDigest = Buffer.from(stealthPointDigest(leadingZero))
  expect(leadingZeroDigest).toEqual(
    Buffer.from(sha256(Uint8Array.from(leadingZero))),
  )
  expect(leadingZeroDigest.toString('hex')).toBe(
    createHash('sha256').update(leadingZero).digest('hex'),
  )
  const doubled = createHash('sha256').update(leadingZeroDigest).digest('hex')
  expect(leadingZeroDigest.toString('hex')).not.toBe(doubled)
})

it('derives stealth keys from that digest', () => {
  const ctor = new PayloadConstructor({ networkName: 'livenet' })
  const destination = secretKey(DEST_SECRET, false)
  const ephemeral = secretKey(EPHEMERAL_SECRET, false)
  const destinationPublic = destination.toPublicKey()
  const ephemeralPublic = ephemeral.toPublicKey()
  const raw = sharedPoint(EPHEMERAL_SECRET, destinationPublic.toBuffer())
  const expectedDigest = digestSha256(raw)
  expect(Buffer.from(stealthPointDigest(raw))).toEqual(expectedDigest)
  expect(expectedDigest.toString('hex')).toBe(
    createHash('sha256').update(raw).digest('hex'),
  )

  const stealthPublic = ctor.constructStealthPublicKey(
    ephemeral,
    destinationPublic,
  )
  expect(Buffer.from(stealthPublic.digest)).toEqual(expectedDigest)
  expect(stealthPublic.stealthPublicKey.toBuffer()).toEqual(
    addedPoint(destinationPublic.toBuffer(), expectedDigest),
  )

  const stealthPrivate = ctor.constructStealthPrivateKey(
    ephemeralPublic,
    destination,
  )
  expect(Buffer.from(stealthPrivate.digest)).toEqual(expectedDigest)
  expect(stealthPrivate.stealthPrivateKey.toBuffer()).toEqual(
    addedSecretMod(destination.toBuffer(), expectedDigest),
  )
})
