import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

import { Address, Networks, crypto as bitcoreCrypto } from 'bitcore-lib-xpi'

import { colorSalt } from './constants'
import { addressColor, addressColorFromStr, pubKeyToColor } from './formatting'

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
    const pubBitcore = bitcoreCrypto.Hash.sha256(pubSalted)
    const pubNode = createHash('sha256').update(pubSalted).digest()
    expect(pubBitcore.equals(pubNode)).toBe(true)
    expect(pubKeyToColor(pubKey)).toBe(hsl(pubBitcore))
    expect(pubKeyToColor(Buffer.from(pubKey))).toBe(hsl(pubBitcore))
    const doubled = createHash('sha256').update(pubBitcore).digest()
    expect(pubKeyToColor(pubKey)).not.toBe(hsl(doubled))

    const hash160 = Buffer.alloc(20, 0x11)
    const address = new Address(hash160, Networks.livenet)
    const addressBytes = address.toBuffer()
    const addressSalted = salted(addressBytes)
    const addressBitcore = bitcoreCrypto.Hash.sha256(addressSalted)
    const addressNode = createHash('sha256').update(addressSalted).digest()
    expect(addressBitcore.equals(addressNode)).toBe(true)
    const color = addressColor(addressBytes)
    expect(color.hue).toBe(addressBitcore[0])
    expect(color.saturation).toBe(addressBitcore[1] / 255)

    const zeroLead = Buffer.alloc(32, 0)
    const zeroHash = bitcoreCrypto.Hash.sha256(salted(zeroLead))
    expect(pubKeyToColor(zeroLead)).toBe(hsl(zeroHash))
  })

  it('keeps the color digest on one SHA-256', () => {
    const source = readFileSync(join(__dirname, 'formatting.ts'), 'utf8')
    expect(source).toContain('cryptoBackend.sha256')
    expect(source.match(/crypto\.Hash\.sha256\(/g)).toBeNull()
    expect(source).not.toContain('sha256d')
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
  const networks = [Networks.livenet, Networks.testnet, Networks.regtest]
  const types = ['pubkeyhash', 'scripthash'] as const

  for (const hash of hashes) {
    for (const network of networks) {
      for (const type of types) {
        const address = new Address(hash, network, type)
        const forms = [
          address.toLegacyAddress(),
          address.toCashAddress(),
          address.toCashAddress(true),
          address.toCashAddress().toUpperCase(),
          address.toXAddress(),
        ]
        for (const form of forms) {
          it(`matches toBuffer for ${network} ${type} ${form.slice(
            0,
            16,
          )}`, () => {
            const oracle = new Address(form)
            expect(Array.from(oracle.toBuffer())).toEqual(
              Array.from(address.toBuffer()),
            )
            expectSameColor(form, address.toBuffer())
          })
        }
      }
    }
  }

  it('colors the pinned mainnet and regtest Lotus vectors', () => {
    const hash = Buffer.from('b50b86a893d80c9e2ee72b199612374b7b4c1cd8', 'hex')
    const main = new Address(hash, Networks.livenet)
    const regtest = new Address(hash, Networks.regtest)
    expectSameColor(
      'lotus_16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyW61iGi',
      main.toBuffer(),
    )
    expectSameColor(
      'lotusR16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyVqAied',
      regtest.toBuffer(),
    )
  })
})
