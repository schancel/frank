import {
  HDPrivateKey,
  HDPublicKey,
  Networks,
  PrivateKey,
  crypto as bitcoreCrypto,
} from 'bitcore-lib-xpi'
import {
  BTC_MAINNET,
  deriveHdPublic,
  parseHdPublic,
  serializeHdPublic,
} from '@frank/nakamoto'

import { PayloadConstructor } from './crypto'
import { outpointPrivateKey, outpointPublicKey } from './outpoint-hd'

// lotusd src/test/bip32_tests.cpp vector 1. The node checked before
// nChild 1000000000 (path m/0'/1/2'/2) and the next extended public key.
const PARENT_XPUB =
  'xpub6FHa3pjLCk84BayeJxFW2SP4XRrFd1JYnxeLeU8EqN3vDfZmbqBqaGJAyiLjTAwm6ZLRQUMv1ZACTj37sR62cfN7fe5JnJ7dh8zL4fiyLHV'
const CHILD_XPUB =
  'xpub6H1LXWLaKsWFhvm6RVpEL9P4KfRZSW7abD2ttkWP3SSQvnyA8FSVqNTEcYFgJS2UaFcxupHiYkro49S8yGasTvXEYBVPamhGW6cFJodrTHy'

const NETWORK = 'livenet'
const DEST_SECRET = '11'.repeat(32)
const EPHEMERAL_SECRET = '22'.repeat(32)
const PAYLOAD_DIGEST = Buffer.from('33'.repeat(32), 'hex')

function bitcoreOutpoint(
  parentPublicKey: Buffer,
  chainCode: Buffer,
  transactionNumber: number,
  outputNumber: number,
  network: string,
): Buffer {
  const parent = new HDPublicKey({
    publicKey: parentPublicKey,
    depth: 0,
    network,
    childIndex: 0,
    chainCode,
    parentFingerPrint: 0,
  })
  const child = parent
    .deriveChild(44, false)
    .deriveChild(145, false)
    .deriveChild(transactionNumber, false)
    .deriveChild(outputNumber, false)
  return bitcoreCrypto.Point.pointToCompressed(child.publicKey.point)
}

it('matches the lotusd BIP32 public child at index 1000000000', () => {
  const parent = parseHdPublic(PARENT_XPUB, BTC_MAINNET)
  expect(parent.ok).toBe(true)
  if (!parent.ok) return
  const child = deriveHdPublic(parent.value, 1000000000)
  expect(child.ok).toBe(true)
  if (!child.ok) return
  const serialized = serializeHdPublic(child.value, BTC_MAINNET)
  expect(serialized.ok).toBe(true)
  if (!serialized.ok) return
  expect(serialized.value).toBe(CHILD_XPUB)

  const bitcoreChild = new HDPublicKey(PARENT_XPUB).deriveChild(
    1000000000,
    false,
  )
  expect(bitcoreChild.toString()).toBe(CHILD_XPUB)
  expect(Buffer.from(child.value.publicKey).toString('hex')).toBe(
    bitcoreChild.publicKey.toBuffer().toString('hex'),
  )
})

it('derives stamp and stealth outpoints on the bitcore m/44/145 path', () => {
  const ctor = new PayloadConstructor({ networkName: NETWORK })
  const destination = PrivateKey.fromBuffer(
    Buffer.from(DEST_SECRET, 'hex'),
    NETWORK,
  )
  const destinationPublic = destination.toPublicKey()
  const stampParent = ctor.constructStampPublicKey(
    PAYLOAD_DIGEST,
    destinationPublic,
  )
  const stampChild = Buffer.from(
    outpointPublicKey(stampParent.toBuffer(), PAYLOAD_DIGEST, 0, 1),
  )
  expect(stampChild).toEqual(
    bitcoreOutpoint(stampParent.toBuffer(), PAYLOAD_DIGEST, 0, 1, NETWORK),
  )
  expect(stampChild).toEqual(
    bitcoreOutpoint(stampParent.toBuffer(), PAYLOAD_DIGEST, 0, 1, 'testnet'),
  )
  expect(stampChild).not.toEqual(
    bitcoreOutpoint(stampParent.toBuffer(), PAYLOAD_DIGEST, 1, 1, NETWORK),
  )
  expect(stampChild).not.toEqual(
    bitcoreOutpoint(stampParent.toBuffer(), PAYLOAD_DIGEST, 0, 0, NETWORK),
  )

  const ephemeral = PrivateKey.fromBuffer(
    Buffer.from(EPHEMERAL_SECRET, 'hex'),
    NETWORK,
  )
  const stealth = ctor.constructStealthPublicKey(ephemeral, destinationPublic)
  const stealthChain = Buffer.from(stealth.digest)
  const stealthChild = Buffer.from(
    outpointPublicKey(stealth.stealthPublicKey.toBuffer(), stealthChain, 2, 3),
  )
  expect(stealthChild).toEqual(
    bitcoreOutpoint(
      stealth.stealthPublicKey.toBuffer(),
      stealthChain,
      2,
      3,
      NETWORK,
    ),
  )

  expect(() =>
    outpointPublicKey(stampParent.toBuffer(), PAYLOAD_DIGEST, -1, 0),
  ).toThrow('outpoint-hd:hd-path')
  expect(() =>
    outpointPublicKey(stampParent.toBuffer(), Buffer.alloc(31), 0, 0),
  ).toThrow('outpoint-hd:chain-code')
})

function bitcoreOutpointPrivate(
  parentPrivateKey: Buffer,
  chainCode: Buffer,
  transactionNumber: number,
  outputNumber: number,
  network: string,
): Buffer {
  const parent = new HDPrivateKey({
    privateKey: parentPrivateKey,
    depth: 0,
    network,
    childIndex: 0,
    chainCode,
    parentFingerPrint: 0,
  })
  return parent
    .deriveChild(44, false)
    .deriveChild(145, false)
    .deriveChild(transactionNumber, false)
    .deriveChild(outputNumber, false)
    .privateKey.toBuffer()
}

it('derives stamp and stealth outpoint private keys on the bitcore m/44/145 path', () => {
  const ctor = new PayloadConstructor({ networkName: NETWORK })
  const destination = PrivateKey.fromBuffer(
    Buffer.from(DEST_SECRET, 'hex'),
    NETWORK,
  )
  const stampParent = ctor.constructStampHDPrivateKey(
    PAYLOAD_DIGEST,
    destination,
  )
  const stampSecret = Buffer.from(stampParent.privateKey.bytes)
  const stampChild = Buffer.from(
    outpointPrivateKey(stampSecret, PAYLOAD_DIGEST, 0, 1),
  )
  expect(stampChild).toEqual(
    bitcoreOutpointPrivate(stampSecret, PAYLOAD_DIGEST, 0, 1, NETWORK),
  )
  expect(stampChild).toEqual(
    bitcoreOutpointPrivate(stampSecret, PAYLOAD_DIGEST, 0, 1, 'testnet'),
  )
  expect(stampChild).not.toEqual(
    bitcoreOutpointPrivate(stampSecret, PAYLOAD_DIGEST, 1, 1, NETWORK),
  )
  expect(stampChild).not.toEqual(
    bitcoreOutpointPrivate(stampSecret, PAYLOAD_DIGEST, 0, 0, NETWORK),
  )
  const stampPublic = ctor.constructStampPublicKey(
    PAYLOAD_DIGEST,
    destination.toPublicKey(),
  )
  expect(
    new PrivateKey(
      stampChild.toString('hex'),
      Networks.get(NETWORK),
    ).toPublicKey().toBuffer(),
  ).toEqual(
    Buffer.from(
      outpointPublicKey(stampPublic.toBuffer(), PAYLOAD_DIGEST, 0, 1),
    ),
  )

  const ephemeral = PrivateKey.fromBuffer(
    Buffer.from(EPHEMERAL_SECRET, 'hex'),
    NETWORK,
  )
  const stealthParent = ctor.constructHDStealthPrivateKey(
    ephemeral.toPublicKey(),
    destination,
  )
  const stealthSecret = Buffer.from(stealthParent.privateKey.bytes)
  const stealthChain = Buffer.from(stealthParent.chainCode)
  const stealthChild = Buffer.from(
    outpointPrivateKey(stealthSecret, stealthChain, 2, 3),
  )
  expect(stealthChild).toEqual(
    bitcoreOutpointPrivate(stealthSecret, stealthChain, 2, 3, NETWORK),
  )
  const stealthPublic = ctor.constructStealthPublicKey(
    ephemeral,
    destination.toPublicKey(),
  )
  expect(
    new PrivateKey(
      stealthChild.toString('hex'),
      Networks.get(NETWORK),
    ).toPublicKey().toBuffer(),
  ).toEqual(
    Buffer.from(
      outpointPublicKey(
        stealthPublic.stealthPublicKey.toBuffer(),
        stealthChain,
        2,
        3,
      ),
    ),
  )

  expect(() =>
    outpointPrivateKey(stampSecret, PAYLOAD_DIGEST, -1, 0),
  ).toThrow('outpoint-hd:hd-path')
  expect(() =>
    outpointPrivateKey(stampSecret, Buffer.alloc(31), 0, 0),
  ).toThrow('outpoint-hd:chain-code')

})
