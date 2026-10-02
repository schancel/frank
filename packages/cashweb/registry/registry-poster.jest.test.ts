import { PrivateKey, PublicKey } from 'bitcore-lib-xpi'

import { lotusFromPublicKey } from '../legacy-wallet/lotus-address'
import __pb_signed_payload_payload_pb from '../signed_payload/payload_pb'
import __pb_broadcast_pb from './broadcast_pb'
import { RegistryHandler } from './index'

const { SignedPayload } = __pb_signed_payload_payload_pb
const { BroadcastMessage } = __pb_broadcast_pb

function handler(networkName: string) {
  return new RegistryHandler({
    registrys: ['https://registry.example'],
    networkName,
  })
}

function wrapperFor(pubKey: Buffer) {
  const message = new BroadcastMessage()
  message.setTopic('t')
  message.setTimestamp(1)
  const signed = new SignedPayload()
  signed.setPayload(message.serializeBinary())
  signed.setPublicKey(pubKey)
  signed.setBurnAmount(0)
  return signed
}

function poster(networkName: string, pubKey: Buffer): string {
  return handler(networkName).parseWrapper(wrapperFor(pubKey)).poster
}

it('keeps the Lotus poster string bitcore derives from a canonical point', () => {
  const secrets = [
    '12b004fff7f4b69ef8650e767f18f11ede158148b425660723b9f9a66e61f747',
    '22'.repeat(32),
    '01'.padStart(64, '0'),
    (153).toString(16).padStart(64, '0'),
    (122).toString(16).padStart(64, '0'),
  ]
  for (const secret of secrets) {
    for (const compressed of [true, false]) {
      const key = compressed
        ? new PrivateKey(secret)
        : new PrivateKey(Buffer.from(secret, 'hex'))
      const pubKey = key.toPublicKey().toBuffer()
      const parsed = PublicKey.fromBuffer(pubKey)
      expect(parsed.toBuffer().equals(pubKey)).toBe(true)
      for (const networkName of ['livenet', 'testnet', 'regtest']) {
        expect(poster(networkName, pubKey)).toBe(
          lotusFromPublicKey(parsed, networkName),
        )
      }
    }
  }
})

it('throws on a point bitcore rejects before a Lotus string', () => {
  const bad = [
    Buffer.alloc(0),
    Buffer.alloc(32),
    Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32)]),
    Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64)]),
    Buffer.concat([Buffer.from([0x06]), Buffer.alloc(64)]),
    Buffer.from(
      '041ff0fe0f7b15ffaa85ff9f4744d539139c252a49710fb053bb9f2b933173ff9a7baad41d04514751e6851f5304fd243751703bed21b914f6be218c0fa354a34112',
      'hex',
    ),
  ]
  for (const pubKey of bad) {
    expect(() => PublicKey.fromBuffer(pubKey)).toThrow()
    expect(() => poster('livenet', pubKey)).toThrow('registry-public-key')
  }
})
