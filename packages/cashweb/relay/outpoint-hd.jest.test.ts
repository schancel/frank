import {
  BTC_MAINNET,
  compressedPublicKeyFromBytes,
  deriveHdPath,
  deriveHdPublic,
  deriveHdPublicPath,
  parseHdPublic,
  privateKeyFromSecretBytes,
  serializeHdPublic,
} from '@frank/nakamoto'

import { PayloadConstructor } from './crypto'
import { outpointPrivateKey, outpointPublicKey } from './outpoint-hd'
import { must, pointOf, secretKey } from '../nakamoto-oracle'

// lotusd src/test/bip32_tests.cpp vector 1. The node checked before
// nChild 1000000000 (path m/0'/1/2'/2) and the next extended public key.
const PARENT_XPUB =
  'xpub6FHa3pjLCk84BayeJxFW2SP4XRrFd1JYnxeLeU8EqN3vDfZmbqBqaGJAyiLjTAwm6ZLRQUMv1ZACTj37sR62cfN7fe5JnJ7dh8zL4fiyLHV'
const CHILD_XPUB =
  'xpub6H1LXWLaKsWFhvm6RVpEL9P4KfRZSW7abD2ttkWP3SSQvnyA8FSVqNTEcYFgJS2UaFcxupHiYkro49S8yGasTvXEYBVPamhGW6cFJodrTHy'

const DEST_SECRET = '11'.repeat(32)
const EPHEMERAL_SECRET = '22'.repeat(32)
const PAYLOAD_DIGEST = Buffer.from('33'.repeat(32), 'hex')

function publicChild(
  parentPublicKey: Uint8Array,
  chainCode: Uint8Array,
  transactionNumber: number,
  outputNumber: number,
): Buffer {
  const parent = must(
    compressedPublicKeyFromBytes(Uint8Array.from(parentPublicKey)),
  )
  const child = must(
    deriveHdPublicPath(
      {
        depth: 0,
        parentFingerprint: new Uint8Array(4),
        childIndex: 0,
        chainCode: Uint8Array.from(chainCode),
        publicKey: parent,
      },
      `m/44/145/${transactionNumber}/${outputNumber}`,
    ),
  )
  return Buffer.from(child.publicKey)
}

function privateChild(
  parentPrivateKey: Uint8Array,
  chainCode: Uint8Array,
  transactionNumber: number,
  outputNumber: number,
): Buffer {
  const secret = must(
    privateKeyFromSecretBytes(Uint8Array.from(parentPrivateKey), true),
  )
  const child = must(
    deriveHdPath(
      {
        depth: 0,
        parentFingerprint: new Uint8Array(4),
        childIndex: 0,
        chainCode: Uint8Array.from(chainCode),
        privateKey: secret,
      },
      `m/44/145/${transactionNumber}/${outputNumber}`,
    ),
  )
  const out = Buffer.from(child.privateKey.bytes)
  secret.bytes.fill(0)
  child.privateKey.bytes.fill(0)
  return out
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
  expect(Buffer.from(child.value.publicKey).length).toBe(33)
})

it('derives stamp and stealth outpoints on m/44/145', () => {
  const ctor = new PayloadConstructor({ networkName: 'livenet' })
  const destination = secretKey(DEST_SECRET, false)
  const destinationPublic = destination.toPublicKey()
  const stampParent = ctor.constructStampPublicKey(
    PAYLOAD_DIGEST,
    destinationPublic,
  )
  const stampChild = Buffer.from(
    outpointPublicKey(stampParent.toBuffer(), PAYLOAD_DIGEST, 0, 1),
  )
  expect(stampChild).toEqual(
    publicChild(stampParent.toBuffer(), PAYLOAD_DIGEST, 0, 1),
  )
  expect(stampChild).not.toEqual(
    publicChild(stampParent.toBuffer(), PAYLOAD_DIGEST, 1, 1),
  )
  expect(stampChild).not.toEqual(
    publicChild(stampParent.toBuffer(), PAYLOAD_DIGEST, 0, 0),
  )

  const ephemeral = secretKey(EPHEMERAL_SECRET, false)
  const stealth = ctor.constructStealthPublicKey(ephemeral, destinationPublic)
  const stealthChain = Buffer.from(stealth.digest)
  const stealthChild = Buffer.from(
    outpointPublicKey(stealth.stealthPublicKey.toBuffer(), stealthChain, 2, 3),
  )
  expect(stealthChild).toEqual(
    publicChild(stealth.stealthPublicKey.toBuffer(), stealthChain, 2, 3),
  )

  expect(() =>
    outpointPublicKey(stampParent.toBuffer(), PAYLOAD_DIGEST, -1, 0),
  ).toThrow('outpoint-hd:hd-path')
  expect(() =>
    outpointPublicKey(stampParent.toBuffer(), Buffer.alloc(31), 0, 0),
  ).toThrow('outpoint-hd:chain-code')
})

it('derives stamp and stealth outpoint private keys on m/44/145', () => {
  const ctor = new PayloadConstructor({ networkName: 'livenet' })
  const destination = secretKey(DEST_SECRET, false)
  const stampParent = ctor.constructStampHDPrivateKey(
    PAYLOAD_DIGEST,
    destination,
  )
  const stampSecret = Buffer.from(stampParent.privateKey.bytes)
  const stampChild = Buffer.from(
    outpointPrivateKey(stampSecret, PAYLOAD_DIGEST, 0, 1),
  )
  expect(stampChild).toEqual(privateChild(stampSecret, PAYLOAD_DIGEST, 0, 1))
  expect(stampChild).not.toEqual(
    privateChild(stampSecret, PAYLOAD_DIGEST, 1, 1),
  )
  expect(stampChild).not.toEqual(
    privateChild(stampSecret, PAYLOAD_DIGEST, 0, 0),
  )
  const stampPublic = ctor.constructStampPublicKey(
    PAYLOAD_DIGEST,
    destination.toPublicKey(),
  )
  expect(pointOf(stampChild, true)).toEqual(
    Buffer.from(
      outpointPublicKey(stampPublic.toBuffer(), PAYLOAD_DIGEST, 0, 1),
    ),
  )

  const ephemeral = secretKey(EPHEMERAL_SECRET, false)
  const stealthParent = ctor.constructHDStealthPrivateKey(
    ephemeral.toPublicKey(),
    destination,
  )
  const stealthSecret = Buffer.from(stealthParent.privateKey.bytes)
  const stealthChain = Buffer.from(stealthParent.chainCode)
  const stealthChild = Buffer.from(
    outpointPrivateKey(Uint8Array.from(stealthSecret), stealthChain, 2, 3),
  )
  expect(stealthChild).toEqual(privateChild(stealthSecret, stealthChain, 2, 3))
  const stealthPublic = ctor.constructStealthPublicKey(
    ephemeral,
    destination.toPublicKey(),
  )
  expect(pointOf(stealthChild, true)).toEqual(
    Buffer.from(
      outpointPublicKey(
        stealthPublic.stealthPublicKey.toBuffer(),
        stealthChain,
        2,
        3,
      ),
    ),
  )

  expect(() => outpointPrivateKey(stampSecret, PAYLOAD_DIGEST, -1, 0)).toThrow(
    'outpoint-hd:hd-path',
  )
  expect(() => outpointPrivateKey(stampSecret, Buffer.alloc(31), 0, 0)).toThrow(
    'outpoint-hd:chain-code',
  )
})
