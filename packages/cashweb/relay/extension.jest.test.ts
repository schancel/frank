import { PrivateKey, PublicKey } from 'bitcore-lib-xpi'

import { lotusFromPublicKey } from '../legacy-wallet/lotus-address'
import { relayCipherPayloadDigest } from './cipher-payload-digest'
import { PayloadConstructor } from './crypto'
import { messageMixin } from './extension'
import type { Message } from './relay_pb'

const NETWORK = 'livenet'
const SALT = Uint8Array.from(Buffer.from('ab'.repeat(32), 'hex'))

function uncompressedKey(hex: string): PublicKey {
  return PrivateKey.fromBuffer(Buffer.from(hex, 'hex'), NETWORK).toPublicKey()
}

function compressedKey(hex: string): PublicKey {
  return new PrivateKey(hex).toPublicKey()
}

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
  source: PublicKey,
  destination: PublicKey,
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

it('re-encodes message public keys the way bitcore does', () => {
  const source = compressedKey('11'.repeat(32))
  const destination = uncompressedKey('22'.repeat(32))
  expect(source.toBuffer().length).toBe(33)
  expect(destination.toBuffer().length).toBe(65)
  const leading = compressedKey(`${'00'.repeat(31)}99`)
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
  expect(() => new PublicKey(bad)).toThrow()
})

it('opens messages with the same shared key bitcore derives', () => {
  const alice = new PrivateKey('33'.repeat(32))
  const bob = PrivateKey.fromBuffer(
    Buffer.from('44'.repeat(32), 'hex'),
    NETWORK,
  )
  const leading = new PrivateKey(`${'00'.repeat(31)}6d`)
  const ctor = new PayloadConstructor({ networkName: NETWORK })
  const plain = Uint8Array.from(Buffer.from('relay-message'))

  for (const [reader, writer, destination] of [
    [bob, alice, bob.toPublicKey()],
    [alice, bob, alice.toPublicKey()],
    [leading, alice, leading.toPublicKey()],
  ] as const) {
    const shared = ctor.constructSharedKey(reader, writer.toPublicKey(), SALT)
    expect(shared.length).toBe(32)
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
