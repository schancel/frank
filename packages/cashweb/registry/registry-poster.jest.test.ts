import { pointFromPublicKey } from '../../nakamoto/src/secp256k1'

import { lotusFromPublicKey } from '../legacy-wallet/lotus-address'
import { pointKey, secretKey } from '../nakamoto-oracle'
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

function wrapperFor(pubKey: Uint8Array) {
  const message = new BroadcastMessage()
  message.setTopic('t')
  message.setTimestamp(1)
  const signed = new SignedPayload()
  signed.setPayload(message.serializeBinary())
  signed.setPublicKey(pubKey)
  signed.setBurnAmount(0)
  return signed
}

function poster(networkName: string, pubKey: Uint8Array): string {
  return handler(networkName).parseWrapper(wrapperFor(pubKey)).poster
}

it('keeps the Lotus poster string of a canonical point', () => {
  const secrets = [
    '12b004fff7f4b69ef8650e767f18f11ede158148b425660723b9f9a66e61f747',
    '22'.repeat(32),
    '01'.padStart(64, '0'),
    (153).toString(16).padStart(64, '0'),
    (122).toString(16).padStart(64, '0'),
  ]
  for (const secret of secrets) {
    for (const compressed of [true, false]) {
      const key = secretKey(secret, compressed)
      const pubKey = key.toPublicKey().toBuffer()
      expect(pointFromPublicKey(Uint8Array.from(pubKey))).not.toBeNull()
      for (const networkName of ['livenet', 'testnet', 'regtest']) {
        expect(poster(networkName, pubKey)).toBe(
          lotusFromPublicKey(pointKey(pubKey), networkName),
        )
      }
    }
  }
})

it('throws on a point the curve rejects before a Lotus string', () => {
  const bad = [
    new Uint8Array(),
    new Uint8Array(32),
    Uint8Array.from(Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32)])),
    Uint8Array.from(Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64)])),
    Uint8Array.from(Buffer.concat([Buffer.from([0x06]), Buffer.alloc(64)])),
    Uint8Array.from(
      Buffer.from(
        '041ff0fe0f7b15ffaa85ff9f4744d539139c252a49710fb053bb9f2b933173ff9a7baad41d04514751e6851f5304fd243751703bed21b914f6be218c0fa354a34112',
        'hex',
      ),
    ),
  ]
  for (const pubKey of bad) {
    expect(pointFromPublicKey(pubKey)).toBeNull()
    expect(() => poster('livenet', pubKey)).toThrow('registry-public-key')
  }
})
