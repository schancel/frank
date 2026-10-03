import { createHash } from 'crypto'

import { sha256 } from '@frank/crypto-box'
import {
  BCH_MAINNET,
  BCH_REGTEST,
  BCH_TESTNET,
  XPI_MAINNET,
  XPI_REGTEST,
  XPI_TESTNET,
  addressVersionBytes,
  encodeAddress,
  pubkeyHashFromBytes,
  type ChainDescriptor,
  type ScriptHash,
} from '@frank/nakamoto'

import { colorSalt } from './constants'
import { addressColor, addressColorFromStr, pubKeyToColor } from './formatting'

function digestOf(bytes: Uint8Array): Buffer {
  const hashed = sha256(Uint8Array.from(bytes))
  const node = createHash('sha256').update(bytes).digest()
  const box = Buffer.from(hashed)
  if (!box.equals(node)) throw new Error('sha256 mismatch')
  return box
}

function destination(hash: Uint8Array, kind: 'p2pkh' | 'p2sh') {
  const branded = pubkeyHashFromBytes(Uint8Array.from(hash))
  if (!branded.ok) throw new Error(branded.error.code)
  if (kind === 'p2pkh') return { kind, hash: branded.value }
  return { kind, hash: branded.value as unknown as ScriptHash }
}

function encoded(
  hash: Uint8Array,
  kind: 'p2pkh' | 'p2sh',
  chain: ChainDescriptor,
  encoding: 'cashaddr' | 'base58check' | 'lotus',
): string {
  const text = encodeAddress(destination(hash, kind), chain, encoding)
  if (!text.ok) throw new Error(text.error.code)
  return text.value
}

function salted(bytes: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(bytes), colorSalt])
}

function hsl(hash: Buffer): string {
  const hue = hash[0]
  const saturation = hash[1] / 255
  return `hsl(${hue}, ${saturation * 100}%, 60%)`
}

describe('pubKeyToColor', () => {
  it('is deterministic: the same key always produces the same color', () => {
    const pubKey = new Uint8Array([1, 2, 3, 4, 5])
    expect(pubKeyToColor(pubKey)).toBe(pubKeyToColor(pubKey))
    expect(pubKeyToColor(new Uint8Array(pubKey))).toBe(pubKeyToColor(pubKey))
  })

  it('produces different colors for different keys', () => {
    const colors = new Set(
      Array.from({ length: 20 }, (_, i) =>
        pubKeyToColor(new Uint8Array([i, i + 1, i + 2])),
      ),
    )
    // Overwhelmingly likely to all be distinct; not a strict cryptographic guarantee.
    expect(colors.size).toBeGreaterThan(15)
  })

  it('does not crash on an empty key', () => {
    expect(() => pubKeyToColor(new Uint8Array())).not.toThrow()
  })

  it('does not crash on a large key', () => {
    expect(() => pubKeyToColor(new Uint8Array(256).fill(7))).not.toThrow()
  })

  it('returns a valid hsl() color string', () => {
    const color = pubKeyToColor(new Uint8Array([9, 8, 7]))
    expect(color).toMatch(/^hsl\(\d+, \d+(\.\d+)?%, 60%\)$/)
  })
})

describe('salted color digest', () => {
  it('hashes public keys and address bytes with one SHA-256', () => {
    const pubKey = Uint8Array.from([0x02, ...new Array(32).fill(1)])
    const pubSalted = salted(pubKey)
    const pubHash = digestOf(pubSalted)
    expect(pubKeyToColor(pubKey)).toBe(hsl(pubHash))
    expect(pubKeyToColor(Buffer.from(pubKey))).toBe(hsl(pubHash))
    const doubled = createHash('sha256').update(pubHash).digest()
    expect(pubKeyToColor(pubKey)).not.toBe(hsl(doubled))

    const hash160 = Buffer.alloc(20, 0x11)
    const addressBytes = Buffer.concat([
      Buffer.from([addressVersionBytes(BCH_MAINNET, 'pubkeyhash')]),
      hash160,
    ])
    const addressHash = digestOf(salted(addressBytes))
    const color = addressColor(addressBytes)
    expect(color.hue).toBe(addressHash[0])
    expect(color.saturation).toBe(addressHash[1] / 255)

    const zeroLead = Buffer.alloc(32, 0)
    expect(pubKeyToColor(zeroLead)).toBe(hsl(digestOf(salted(zeroLead))))
  })
})

describe('address string colors', () => {
  function expectSameColor(addrStr: string, oracleBytes: Uint8Array) {
    const digest = createHash('sha256').update(salted(oracleBytes)).digest()
    const color = addressColor(oracleBytes)
    expect(color.hue).toBe(digest[0])
    expect(color.saturation).toBe(digest[1] / 255)
    expect(addressColorFromStr(addrStr)).toBe(hsl(digest))
    expect(oracleBytes.length).toBe(21)
  }

  const hashes = [
    Buffer.alloc(20, 0x11),
    Buffer.from('b50b86a893d80c9e2ee72b199612374b7b4c1cd8', 'hex'),
  ]
  const networks = [
    { name: 'mainnet', bch: BCH_MAINNET, xpi: XPI_MAINNET },
    { name: 'testnet', bch: BCH_TESTNET, xpi: XPI_TESTNET },
    { name: 'regtest', bch: BCH_REGTEST, xpi: XPI_REGTEST },
  ] as const
  const types = ['p2pkh', 'p2sh'] as const

  for (const hash of hashes) {
    for (const network of networks) {
      for (const type of types) {
        const versionKind = type === 'p2pkh' ? 'pubkeyhash' : 'scripthash'
        const oracleBytes = Uint8Array.from(
          Buffer.concat([
            Buffer.from([addressVersionBytes(network.bch, versionKind)]),
            hash,
          ]),
        )
        const cashaddr = encoded(hash, type, network.bch, 'cashaddr')
        const legacy = encoded(hash, type, network.bch, 'base58check')
        const lotus = encoded(hash, type, network.xpi, 'lotus')
        const forms = [
          legacy,
          cashaddr,
          cashaddr.slice(cashaddr.indexOf(':') + 1),
          cashaddr.toUpperCase(),
          lotus,
        ]
        for (const form of forms) {
          it(`colors ${network.name} ${type} ${form.slice(0, 16)}`, () => {
            expect(addressVersionBytes(network.xpi, versionKind)).toBe(
              addressVersionBytes(network.bch, versionKind),
            )
            expectSameColor(form, oracleBytes)
          })
        }
      }
    }
  }

  it('colors the pinned mainnet and regtest Lotus vectors', () => {
    const hash = Buffer.from('b50b86a893d80c9e2ee72b199612374b7b4c1cd8', 'hex')
    expect(encoded(hash, 'p2pkh', XPI_MAINNET, 'lotus')).toBe(
      'lotus_16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyW61iGi',
    )
    expect(encoded(hash, 'p2pkh', XPI_REGTEST, 'lotus')).toBe(
      'lotusR16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyVqAied',
    )
    expectSameColor(
      'lotus_16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyW61iGi',
      Uint8Array.from(
        Buffer.concat([
          Buffer.from([addressVersionBytes(XPI_MAINNET, 'pubkeyhash')]),
          hash,
        ]),
      ),
    )
    expectSameColor(
      'lotusR16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyVqAied',
      Uint8Array.from(
        Buffer.concat([
          Buffer.from([addressVersionBytes(XPI_REGTEST, 'pubkeyhash')]),
          hash,
        ]),
      ),
    )
  })
})
