import assert from 'assert'
import { hmacSha256 } from '@frank/crypto-box'
import {
  compressPoint,
  pointFromPublicKey,
  uncompressPoint,
} from '../../nakamoto/src/secp256k1'

import type { ReceivedMessageWrapper } from '../types/user-interface'
import { relayCipherPayloadDigest } from './cipher-payload-digest'
import { PayloadConstructor } from './crypto'
import type { Message, Stamp } from './relay_pb'
import { stealthSharedPoint } from './stealth-shared'

/** Index assigns this to ReceivedMessageWrapper.copartyPubKey. */
type StoredMessageKey = ReceivedMessageWrapper['copartyPubKey']

type KeyBytes = { toBuffer(): Uint8Array }

/** SEC1 message key. 33-byte inputs stay compressed and 65-byte inputs
 * stay uncompressed. Other lengths, hybrid prefixes, and off-curve
 * points throw. toBuffer returns a copy of the re-encoded point. */
function messagePublicKey(bytes: Uint8Array): KeyBytes {
  const copy = Uint8Array.from(bytes)
  const point = pointFromPublicKey(copy)
  if (point === null) {
    throw new TypeError('Invalid DER format public key')
  }
  const encoded =
    copy.length === 33 ? compressPoint(point) : uncompressPoint(point)
  if (encoded === null) {
    throw new TypeError('Invalid DER format public key')
  }
  const stored = Uint8Array.from(encoded)
  return {
    toBuffer() {
      return Uint8Array.from(stored)
    },
  }
}

/** Same shared-key bytes as PayloadConstructor.constructSharedKey.
 * The HMAC key is the compressed ECDH point. The caller's secret is not wiped. */
function messageSharedKey(
  privateKey: KeyBytes,
  publicKey: KeyBytes,
  salt: Uint8Array,
): Buffer {
  const secret = Uint8Array.from(privateKey.toBuffer())
  try {
    const point = stealthSharedPoint(
      secret,
      Uint8Array.from(publicKey.toBuffer()),
    )
    return Buffer.from(hmacSha256(Uint8Array.from(salt), point))
  } finally {
    secret.fill(0)
  }
}

export class ParsedMessage {
  sourcePublicKey: StoredMessageKey
  destinationPublicKey: StoredMessageKey
  receivedTime: number
  salt: Uint8Array
  stamp: Stamp
  scheme: Message.EncryptionSchemeMap
  payloadDigest: Uint8Array
  payloadHmac: Uint8Array
  payloadSize: number
  payload: Uint8Array
  payloadConstructor: PayloadConstructor

  constructor(
    sourcePublicKey: KeyBytes,
    destinationPublicKey: KeyBytes,
    receivedTime: number,
    salt: Uint8Array,
    stamp: Stamp,
    scheme: Message.EncryptionSchemeMap,
    payloadDigest: Uint8Array,
    payloadHmac: Uint8Array,
    payloadSize: number,
    payload: Uint8Array,
    networkName: string,
  ) {
    this.sourcePublicKey = sourcePublicKey as StoredMessageKey
    this.destinationPublicKey = destinationPublicKey as StoredMessageKey
    this.receivedTime = receivedTime
    this.salt = salt
    this.stamp = stamp
    this.scheme = scheme
    this.payloadDigest = payloadDigest
    this.payloadHmac = payloadHmac
    this.payloadSize = payloadSize
    this.payload = payload
    this.payloadConstructor = new PayloadConstructor({ networkName })
  }

  constructSharedKey(privateKey: KeyBytes) {
    return messageSharedKey(privateKey, this.sourcePublicKey, this.salt)
  }

  constructSharedKeySelf(privateKey: KeyBytes) {
    return messageSharedKey(privateKey, this.destinationPublicKey, this.salt)
  }

  authenticate(sharedKey: Buffer) {
    const payloadHmac = this.payloadConstructor.constructPayloadHmac(
      sharedKey,
      this.payloadDigest,
    )
    return this.payloadHmac.every(
      (value, index) => value === payloadHmac[index],
    )
  }

  decrypt(sharedKey: Buffer) {
    // TODO: Check scheme
    return this.payloadConstructor.decrypt(sharedKey, this.payload)
  }

  open(privateKey: KeyBytes) {
    const sharedKey = this.constructSharedKey(privateKey)
    if (!this.authenticate(sharedKey)) {
      throw new Error('Failed to authenticate message')
    }

    return this.decrypt(sharedKey)
  }

  openSelf(privateKey: KeyBytes) {
    const sharedKey = this.constructSharedKeySelf(privateKey)
    if (!this.authenticate(sharedKey)) {
      throw new Error('Failed to authenticate message')
    }

    return this.decrypt(sharedKey)
  }
}

interface ExtendedMessage {
  digest(): string | Uint8Array | Buffer
  parse(): ParsedMessage
}

export function messageMixin(
  networkName: string,
  message: Message,
): Message & ExtendedMessage {
  return Object.assign(message, {
    digest() {
      const payloadDigest = message.getPayloadDigest()
      const payload = message.getPayload()
      const payloadBuffer = Buffer.from(payload)
      switch (payloadDigest.length) {
        case 0:
          if (!payload.length) {
            throw new Error('Missing payload and digest')
          }
          return Buffer.from(relayCipherPayloadDigest(payloadBuffer))
        case 32:
          assert(
            typeof payloadDigest !== 'string',
            'payload digest is a string',
          )
          if (payload.length) {
            const computedPayloadDigest =
              relayCipherPayloadDigest(payloadBuffer)
            const computedDigest = Buffer.from(computedPayloadDigest)
            if (computedDigest.compare(payloadDigest) !== 0) {
              throw new Error(
                `Fraudulent payload digest: ${payloadDigest} !== ${computedDigest}`,
              )
            }
          }
          return payloadDigest
        default:
          throw new Error('Unexpected length payload digest')
      }
    },
    parse() {
      const sourcePublicKey = messagePublicKey(
        Buffer.from(message.getSourcePublicKey()),
      )
      const destinationPublicKey = messagePublicKey(
        Buffer.from(message.getDestinationPublicKey()),
      )
      const payloadDigest = this.digest()

      const payloadHmac = message.getPayloadHmac()
      assert(
        typeof payloadHmac !== 'string',
        `payloadHmac is string? ${payloadHmac}`,
      )
      if (payloadHmac.length !== 32) {
        throw new Error('Unexpected length payload hmac')
      }

      const payload = message.getPayload()
      const payloadSize = payload.length
      const reportedPayloadSize = message.getPayloadSize()
      if (reportedPayloadSize !== 0 && reportedPayloadSize !== payloadSize) {
        throw new Error('Unexpected payload size')
      }
      const salt = message.getSalt()
      assert(typeof salt !== 'string', `Salt is string? ${salt}`)
      const stamp = message.getStamp()
      assert(stamp, 'Message missing stamp?')
      const encryptionScheme: Message.EncryptionSchemeMap =
        message.getScheme() as unknown as Message.EncryptionSchemeMap

      return new ParsedMessage(
        sourcePublicKey,
        destinationPublicKey,
        message.getReceivedTime(),
        salt,
        stamp,
        encryptionScheme,
        payloadDigest,
        payloadHmac,
        payloadSize,
        typeof payload === 'string' ? new Uint8Array() : payload,
        networkName,
      )
    },
  })
}
