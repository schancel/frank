import { hmacSha256 } from '@frank/crypto-box'

import { lotusFromPublicKey } from '../legacy-wallet/lotus-address'
import { secretKey, sharedPoint } from '../nakamoto-oracle'
import { relayCipherPayloadDigest } from './cipher-payload-digest'
import { PayloadConstructor } from './crypto'
import { messageMixin } from './extension'
import type { Message } from './relay_pb'

const NETWORK = 'livenet'
const SALT = Uint8Array.from(Buffer.from('ab'.repeat(32), 'hex'))

function stubMessage(
  source: Uint8Array,
  destination: Uint8Array,
  payload: Uint8Array,
  payloadHmac: Uint8Array,
): Message {
  return {
    getSourcePublicKey: () => source,
    getDestinationPublicKey: () => destination,
    getPayloadDigest: () => new Uint8Array(),
    getPayload: () => payload,
    getPayloadHmac: () => payloadHmac,
    getPayloadSize: () => payload.length,
    getSalt: () => SALT,
    getStamp: () => ({}),
    getScheme: () => 1,
    getReceivedTime: () => 17,
  } as unknown as Message
}

function parsed(
  source: { toBuffer(): Uint8Array },
  destination: { toBuffer(): Uint8Array },
  payload: Uint8Array,
  payloadHmac: Uint8Array,
) {
  return messageMixin(
    NETWORK,
    stubMessage(
      Uint8Array.from(source.toBuffer()),
      Uint8Array.from(destination.toBuffer()),
      payload,
      payloadHmac,
    ),
  ).parse()
}

it('keeps message public keys as SEC1 points', () => {
  const source = secretKey('11'.repeat(32), true).toPublicKey()
  const destination = secretKey('22'.repeat(32), false).toPublicKey()
  expect(source.toBuffer().length).toBe(33)
  expect(destination.toBuffer().length).toBe(65)
  const leading = secretKey(`${'00'.repeat(31)}99`, true).toPublicKey()
  expect(leading.toBuffer()[1]).toBe(0)

  const message = parsed(
    source,
    destination,
    Uint8Array.from([1]),
    new Uint8Array(32),
  )
  expect(Buffer.from(message.sourcePublicKey.toBuffer())).toEqual(
    source.toBuffer(),
  )
  expect(Buffer.from(message.destinationPublicKey.toBuffer())).toEqual(
    destination.toBuffer(),
  )
  expect(message.sourcePublicKey.toBuffer()).not.toBe(
    message.sourcePublicKey.toBuffer(),
  )
  expect(lotusFromPublicKey(message.sourcePublicKey, NETWORK)).toBe(
    lotusFromPublicKey(source, NETWORK),
  )
  expect(lotusFromPublicKey(message.destinationPublicKey, NETWORK)).toBe(
    lotusFromPublicKey(destination, NETWORK),
  )

  const raw = Buffer.from(leading.toBuffer())
  const held = messageMixin(
    NETWORK,
    stubMessage(
      raw,
      source.toBuffer(),
      Uint8Array.from([1]),
      new Uint8Array(32),
    ),
  ).parse()
  const before = Buffer.from(held.sourcePublicKey.toBuffer())
  raw[1] ^= 0xff
  expect(Buffer.from(held.sourcePublicKey.toBuffer())).toEqual(before)
  expect(before).toEqual(leading.toBuffer())

  const bad = Buffer.from(destination.toBuffer())
  bad[bad.length - 1] ^= 0xff
  expect(() =>
    messageMixin(
      NETWORK,
      stubMessage(
        bad,
        source.toBuffer(),
        Uint8Array.from([1]),
        new Uint8Array(32),
      ),
    ).parse(),
  ).toThrow(/Invalid DER format public key/)
})

it('opens messages with the ECDH shared key', () => {
  const alice = secretKey('33'.repeat(32), true)
  const bob = secretKey('44'.repeat(32), false)
  const leading = secretKey(`${'00'.repeat(31)}6d`, true)
  const ctor = new PayloadConstructor({ networkName: NETWORK })
  const plain = Uint8Array.from(Buffer.from('relay-message'))

  for (const [readerHex, reader, writer, destination] of [
    ['44'.repeat(32), bob, alice, bob.toPublicKey()],
    ['33'.repeat(32), alice, bob, alice.toPublicKey()],
    [`${'00'.repeat(31)}6d`, leading, alice, leading.toPublicKey()],
  ] as const) {
    const shared = ctor.constructSharedKey(reader, writer.toPublicKey(), SALT)
    expect(shared.length).toBe(32)
    expect(shared).toEqual(
      Buffer.from(
        hmacSha256(
          SALT,
          sharedPoint(readerHex, writer.toPublicKey().toBuffer()),
        ),
      ),
    )
    const payload = ctor.encrypt(shared, plain)
    const payloadHmac = ctor.constructPayloadHmac(
      shared,
      relayCipherPayloadDigest(payload),
    )
    const message = parsed(
      writer.toPublicKey(),
      destination,
      payload,
      payloadHmac,
    )
    expect(message.constructSharedKey(reader)).toEqual(shared)
    expect(message.constructSharedKeySelf(writer)).toEqual(
      ctor.constructSharedKey(writer, destination, SALT),
    )
    expect(Buffer.from(message.open(reader))).toEqual(Buffer.from(plain))
    expect(Buffer.from(message.openSelf(writer))).toEqual(Buffer.from(plain))
    const secret = Buffer.from(reader.toBuffer())
    message.constructSharedKey(reader)
    expect(reader.toBuffer()).toEqual(secret)
  }
})
