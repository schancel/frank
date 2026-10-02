import {
  BCH_MAINNET,
  BCH_REGTEST,
  BCH_TESTNET,
  XEC_MAINNET,
  XPI_MAINNET,
  XPI_REGTEST,
  XPI_TESTNET,
  cryptoBackend,
  encodeAddress,
  encodeBase58,
  pubkeyHashFromBytes,
  type ChainDescriptor,
} from '@frank/nakamoto'

import { lotusFromAddress, p2pkhLockingScript } from './lotus-address'
import { must } from '../nakamoto-oracle'

const HASH = 'b50b86a893d80c9e2ee72b199612374b7b4c1cd8'
const LOTUS = 'lotus_16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyW61iGi'
const SCRIPT = '76a914b50b86a893d80c9e2ee72b199612374b7b4c1cd888ac'
const SHORT_LEGACY = '16HgC8KRBEhXYbF4riJyJFLSHt34Te5YA'
const P2PKH = Uint8Array.from(Buffer.from(SCRIPT, 'hex'))
const P2SH = Uint8Array.from(
  Buffer.concat([
    Buffer.from([0xa9, 0x14]),
    Buffer.from(HASH, 'hex'),
    Buffer.from([0x87]),
  ]),
)

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

function chainFor(networkName: string): ChainDescriptor {
  if (networkName === 'testnet') return XPI_TESTNET
  if (networkName === 'regtest') return XPI_REGTEST
  return XPI_MAINNET
}

function lotusOf(kind: 'p2pkh' | 'p2sh', hashHex: string, networkName: string) {
  const hash = must(
    pubkeyHashFromBytes(Uint8Array.from(Buffer.from(hashHex, 'hex'))),
  )
  return must(encodeAddress({ kind, hash }, chainFor(networkName), 'lotus'))
}

function expectLotus(
  address: string,
  kind: 'p2pkh' | 'p2sh',
  hashHex: string,
  networkName: string,
) {
  const expected = lotusOf(kind, hashHex, networkName)
  const record = {
    hashBuffer: Uint8Array.from(Buffer.from(hashHex, 'hex')),
    type: kind === 'p2sh' ? 'scripthash' : 'pubkeyhash',
  }
  expect(lotusFromAddress(address, networkName)).toBe(expected)
  expect(lotusFromAddress(record, networkName)).toBe(expected)
  if (kind === 'p2sh') {
    expect(() => p2pkhLockingScript(address)).toThrow('address-kind')
    expect(() => p2pkhLockingScript(record)).toThrow('address-kind')
    return
  }
  expect(Buffer.from(p2pkhLockingScript(address)).toString('hex')).toBe(
    `76a914${hashHex}88ac`,
  )
  expect(Buffer.from(p2pkhLockingScript(record)).toString('hex')).toBe(
    `76a914${hashHex}88ac`,
  )
}

it('reads cashaddr, legacy base58, and xaddress strings as Lotus', () => {
  const networks = [
    { name: 'livenet', chain: BCH_MAINNET },
    { name: 'testnet', chain: BCH_TESTNET },
    { name: 'regtest', chain: BCH_REGTEST },
  ] as const
  for (const network of networks) {
    for (const kind of ['p2pkh', 'p2sh'] as const) {
      const hash = must(
        pubkeyHashFromBytes(Uint8Array.from(Buffer.from(HASH, 'hex'))),
      )
      const cashaddr = must(
        encodeAddress({ kind, hash }, network.chain, 'cashaddr'),
      )
      const legacy = must(
        encodeAddress({ kind, hash }, network.chain, 'base58check'),
      )
      for (const output of ['livenet', 'testnet', 'regtest'] as const) {
        for (const form of [
          cashaddr,
          cashaddr.toUpperCase(),
          ` ${legacy} `,
          legacy,
        ]) {
          expectLotus(form, kind, HASH, output)
        }
      }
    }
  }

  expectLotus(makeX('lotus', '_', 1, P2PKH), 'p2pkh', HASH, 'livenet')
  expectLotus(makeX('lotus', 'T', 2, P2SH), 'p2sh', HASH, 'testnet')
  expectLotus(makeX('token', 'R', 0, P2PKH), 'p2pkh', HASH, 'regtest')
  expectLotus(makeX('', '_', 0, P2PKH), 'p2pkh', HASH, 'livenet')
  expectLotus(
    makeX(
      'lotus',
      '_',
      0,
      Uint8Array.from(
        Buffer.concat([
          Buffer.from([0x76, 0xa9, 0x4c, 0x14]),
          Buffer.from(HASH, 'hex'),
          Buffer.from([0x88, 0xac]),
        ]),
      ),
    ),
    'p2pkh',
    HASH,
    'livenet',
  )
  expectLotus(makeLegacy('lotus', '_', 7, P2PKH), 'p2pkh', HASH, 'testnet')
  expectLotus(makeLegacy('abc', 'R', 3, P2SH), 'p2sh', HASH, 'regtest')

  const typedScript = makeX('lotus', '_', 4, P2SH)
  expectLotus(typedScript, 'p2sh', HASH, 'livenet')
  expect(lotusFromAddress(typedScript, 'livenet')).not.toBe(
    lotusOf('p2pkh', HASH, 'livenet'),
  )

  const satoshi = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
  expectLotus(
    satoshi,
    'p2pkh',
    '62e907b15cbf27d5425399ebf6f0fb50ebb88f18',
    'livenet',
  )

  expect(SHORT_LEGACY).toHaveLength(33)
  expect(() => lotusFromAddress(SHORT_LEGACY, 'livenet')).toThrow()
  expect(() => p2pkhLockingScript(SHORT_LEGACY)).toThrow()

  const junk = makeX(
    'lotus',
    '_',
    0,
    Uint8Array.from(Buffer.from('hello world hello!!!!')),
  )
  expect(() => lotusFromAddress(junk, 'livenet')).toThrow()
  expect(() => p2pkhLockingScript(junk)).toThrow()

  const cash = must(
    encodeAddress(
      {
        kind: 'p2pkh',
        hash: must(
          pubkeyHashFromBytes(Uint8Array.from(Buffer.from(HASH, 'hex'))),
        ),
      },
      BCH_MAINNET,
      'cashaddr',
    ),
  )
  const mixed = cash.slice(0, 4).toUpperCase() + cash.slice(4)
  expect(() => lotusFromAddress(mixed, 'livenet')).toThrow()
  expect(() => p2pkhLockingScript(mixed)).toThrow()

  const ecash = must(
    encodeAddress(
      {
        kind: 'p2pkh',
        hash: must(
          pubkeyHashFromBytes(Uint8Array.from(Buffer.from(HASH, 'hex'))),
        ),
      },
      XEC_MAINNET,
      'cashaddr',
    ),
  )
  expect(lotusFromAddress(ecash, 'livenet')).toBe(LOTUS)
  expect(Buffer.from(p2pkhLockingScript(ecash)).toString('hex')).toBe(SCRIPT)
})
