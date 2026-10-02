import { readFileSync } from 'fs'
import { join } from 'path'

import { crypto as bitcoreCrypto } from 'bitcore-lib-xpi'

import {
  FrankIdentity,
  base58Encode,
  computeLotusAddress,
  lotusAddressFromPubKeyHash,
  pubKeyHash160,
  type LotusNet,
} from './lotus-identity'

// BIP173 example key. HASH160 is the witness program in
// bitcoin/bips bip-0173.mediawiki and packages/nakamoto/test/fixtures/bip341-keypath.json.
const GENERATOR = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex',
)
const GENERATOR_HASH160 = '751e76e8199196d454941c45d1b3a323f1433bd6'

// bitcoinsuite-core lotusaddress.rs encode_lotus_address / decode_lotus_address.
const SUITE_PKH = Buffer.from('b50b86a893d80c9e2ee72b199612374b7b4c1cd8', 'hex')
const SUITE_MAINNET = 'lotus_16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyW61iGi'
const SUITE_REGTEST = 'lotusR16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyVqAied'

// Same layout as lotus-identity, hashed with bitcore.
function bitcoreLotusAddress(pubKeyHash20: Buffer, net: LotusNet): string {
  const script = Buffer.concat([
    Buffer.from([0x76, 0xa9, 0x14]),
    pubKeyHash20,
    Buffer.from([0x88, 0xac]),
  ])
  const netChar = net === 'mainnet' ? '_' : 'R'
  const preimage = Buffer.concat([
    Buffer.from('lotus', 'ascii'),
    Buffer.from([netChar.charCodeAt(0), 0]),
    script,
  ])
  const checksum = bitcoreCrypto.Hash.sha256(preimage).slice(0, 4)
  const data = Buffer.concat([Buffer.from([0]), script, checksum])
  return `lotus${netChar}${base58Encode(data)}`
}

it('hashes a pubkey and encodes the bitcoinsuite Lotus address vectors', () => {
  const source = readFileSync(join(__dirname, 'lotus-identity.ts'), 'utf8')
  expect(source).not.toContain('bitcoreCrypto')
  expect(source).not.toContain('Hash.sha256')
  expect(source).toContain('cryptoBackend.hash160')
  expect(source).toContain('cryptoBackend.sha256')
  expect(source).toContain('const payloadHash = sha256(serializedPayload)')

  const hashed = pubKeyHash160(GENERATOR)
  expect(hashed.toString('hex')).toBe(GENERATOR_HASH160)
  expect(hashed.toString('hex')).toBe(
    bitcoreCrypto.Hash.sha256ripemd160(GENERATOR).toString('hex'),
  )

  expect(lotusAddressFromPubKeyHash(SUITE_PKH, 'mainnet')).toBe(SUITE_MAINNET)
  expect(lotusAddressFromPubKeyHash(SUITE_PKH, 'regtest')).toBe(SUITE_REGTEST)
  expect(lotusAddressFromPubKeyHash(SUITE_PKH, 'mainnet')).toBe(
    bitcoreLotusAddress(SUITE_PKH, 'mainnet'),
  )
  expect(lotusAddressFromPubKeyHash(SUITE_PKH, 'regtest')).toBe(
    bitcoreLotusAddress(SUITE_PKH, 'regtest'),
  )

  const mainnet = computeLotusAddress(GENERATOR, 'mainnet')
  const regtest = computeLotusAddress(GENERATOR, 'regtest')
  expect(mainnet).toBe(
    bitcoreLotusAddress(Buffer.from(GENERATOR_HASH160, 'hex'), 'mainnet'),
  )
  expect(regtest).toBe(
    bitcoreLotusAddress(Buffer.from(GENERATOR_HASH160, 'hex'), 'regtest'),
  )
  expect(mainnet).toBe('lotus_16PSJLhUGdrTnRU52YVxxTT6UBUNs5g4YkNdoSb6N')
  expect(regtest).toBe('lotusR16PSJLhUGdrTnRU52YVxxTT6UBUNs5g4YkNgr3wpN')
  expect(mainnet).not.toBe(SUITE_MAINNET)

  const identity = FrankIdentity.fromPrivateKeyHex(
    '12b004fff7f4b69ef8650e767f18f11ede158148b425660723b9f9a66e61f747',
    'mainnet',
  )
  expect(identity.pubKey.length).toBe(33)
  expect(pubKeyHash160(identity.pubKey).toString('hex')).toBe(
    bitcoreCrypto.Hash.sha256ripemd160(identity.pubKey).toString('hex'),
  )
  expect(identity.address).toBe(computeLotusAddress(identity.pubKey, 'mainnet'))
  expect(identity.address).toBe(
    bitcoreLotusAddress(pubKeyHash160(identity.pubKey), 'mainnet'),
  )

  expect(() =>
    lotusAddressFromPubKeyHash(SUITE_PKH.subarray(0, 19), 'mainnet'),
  ).toThrow('address-hash')
})
