import { Address, PrivateKey, Script } from 'bitcore-lib-xpi'
import {
  cryptoBackend,
  encodeAddress,
  encodeBase58,
  pubkeyHashFromBytes,
  XEC_MAINNET,
} from '@frank/nakamoto'

import { lotusFromAddress, p2pkhLockingScript } from './lotus-address'

const HASH = 'b50b86a893d80c9e2ee72b199612374b7b4c1cd8'
const LOTUS = 'lotus_16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyW61iGi'
const SCRIPT = '76a914b50b86a893d80c9e2ee72b199612374b7b4c1cd888ac'
const WIF = 'L4rK1yDtCWekvXuE6oXD9jCYfFNV2cWRpVuPLBcCU2z8TrisoyY1'
const SHORT_LEGACY = '16HgC8KRBEhXYbF4riJyJFLSHt34Te5YA'

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function sha256(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(cryptoBackend.sha256(Uint8Array.from(bytes)))
}

function makeX(
  prefix: string,
  net: string,
  typeByte: number,
  payload: Uint8Array,
): string {
  const script = Uint8Array.from(payload)
  const preimage = concat([
    Uint8Array.from(Buffer.from(prefix)),
    Uint8Array.of(net.charCodeAt(0)),
    Uint8Array.of(typeByte),
    script,
  ])
  const checksum = sha256(preimage).subarray(0, 4)
  return (
    prefix +
    net +
    encodeBase58(
      concat([Uint8Array.of(typeByte), script, Uint8Array.from(checksum)]),
    )
  )
}

function makeLegacy(
  prefix: string,
  net: string,
  typeByte: number,
  payload: Uint8Array,
): string {
  const script = Uint8Array.from(payload)
  const prefixBytes = Uint8Array.from(Buffer.from(prefix))
  const preimage = concat([
    Uint8Array.of(prefixBytes.length),
    prefixBytes,
    Uint8Array.of(0, 0),
    Uint8Array.of(script.length),
    script,
  ])
  const checksum = sha256(preimage).subarray(0, 4)
  return (
    prefix +
    net +
    encodeBase58(
      concat([Uint8Array.of(typeByte), script, Uint8Array.from(checksum)]),
    )
  )
}

function expectSame(address: string, networkName: string) {
  const oracle = new Address(address)
  expect(lotusFromAddress(address, networkName)).toBe(
    lotusFromAddress(oracle, networkName),
  )
  if (oracle.type === 'scripthash') {
    expect(() => p2pkhLockingScript(address)).toThrow('address-kind')
    return
  }
  expect(Buffer.from(p2pkhLockingScript(address))).toEqual(
    Buffer.from(p2pkhLockingScript(oracle)),
  )
}

it('matches bitcore for cashaddr, legacy base58, and xaddress strings', () => {
  const key = new PrivateKey(WIF)
  const p2pkh = Script.buildPublicKeyHashOut(key.toPublicKey()).toBuffer()
  const p2sh = Buffer.concat([
    Buffer.from([0xa9, 0x14]),
    Buffer.from(HASH, 'hex'),
    Buffer.from([0x87]),
  ])
  const scriptHash = new Address(
    Buffer.from(HASH, 'hex'),
    'livenet',
    'scripthash',
  )

  for (const net of ['livenet', 'testnet', 'regtest'] as const) {
    const address = key.toAddress(net)
    for (const form of [
      address.toString(),
      address.toCashAddress(),
      address.toCashAddress(true),
      address.toLegacyAddress(),
      address.toCashAddress().toUpperCase(),
      ` ${address.toString()} `,
      `  ${address.toLegacyAddress()}  `,
    ]) {
      expectSame(form, 'livenet')
      expectSame(form, 'testnet')
      expectSame(form, 'regtest')
    }
  }

  for (const form of [
    scriptHash.toString(),
    scriptHash.toCashAddress(),
    scriptHash.toCashAddress(true),
    scriptHash.toLegacyAddress(),
    scriptHash.toCashAddress().toUpperCase(),
  ]) {
    expectSame(form, 'livenet')
  }

  expectSame(makeX('lotus', '_', 1, p2pkh), 'livenet')
  expectSame(makeX('lotus', 'T', 2, p2sh), 'testnet')
  expectSame(makeX('token', 'R', 0, p2pkh), 'regtest')
  expectSame(makeX('', '_', 0, p2pkh), 'livenet')
  expectSame(
    makeX(
      'lotus',
      '_',
      0,
      Buffer.concat([
        Buffer.from([0x76, 0xa9, 0x4c, 0x14]),
        key.toAddress().hashBuffer,
        Buffer.from([0x88, 0xac]),
      ]),
    ),
    'livenet',
  )
  expectSame(makeLegacy('lotus', '_', 7, p2pkh), 'testnet')
  expectSame(makeLegacy('abc', 'R', 3, p2sh), 'regtest')

  const typedScript = makeX('lotus', '_', 4, p2sh)
  expect(new Address(typedScript).type).toBe('scripthash')
  expectSame(typedScript, 'livenet')
  expect(lotusFromAddress(typedScript, 'livenet')).not.toBe(
    lotusFromAddress(
      new Address(Buffer.from(HASH, 'hex'), 'livenet', 'pubkeyhash'),
      'livenet',
    ),
  )

  const satoshi = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
  expect(new Address(satoshi).hashBuffer.toString('hex')).toBe(
    '62e907b15cbf27d5425399ebf6f0fb50ebb88f18',
  )
  expectSame(satoshi, 'livenet')

  expect(SHORT_LEGACY).toHaveLength(33)
  expect(() => new Address(SHORT_LEGACY)).toThrow()
  expect(() => lotusFromAddress(SHORT_LEGACY, 'livenet')).toThrow()
  expect(() => p2pkhLockingScript(SHORT_LEGACY)).toThrow()

  const junk = makeX(
    'lotus',
    '_',
    0,
    Uint8Array.from(Buffer.from('hello world hello!!!!')),
  )
  expect(() => new Address(junk)).toThrow()
  expect(() => lotusFromAddress(junk, 'livenet')).toThrow()
  expect(() => p2pkhLockingScript(junk)).toThrow()

  const cash = key.toAddress().toCashAddress()
  const mixed = cash.slice(0, 4).toUpperCase() + cash.slice(4)
  expect(() => new Address(mixed)).toThrow()
  expect(() => lotusFromAddress(mixed, 'livenet')).toThrow()
  expect(() => p2pkhLockingScript(mixed)).toThrow()

  const branded = pubkeyHashFromBytes(Uint8Array.from(Buffer.from(HASH, 'hex')))
  if (!branded.ok) throw new Error('address-hash')
  const ecash = encodeAddress(
    { kind: 'p2pkh', hash: branded.value },
    XEC_MAINNET,
    'cashaddr',
  )
  if (!ecash.ok) throw new Error(ecash.error.code)
  expect(() => new Address(ecash.value)).toThrow()
  expect(lotusFromAddress(ecash.value, 'livenet')).toBe(LOTUS)
  expect(Buffer.from(p2pkhLockingScript(ecash.value)).toString('hex')).toBe(
    SCRIPT,
  )
})
