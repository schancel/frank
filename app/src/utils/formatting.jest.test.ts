import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

import { Address, Networks, crypto as bitcoreCrypto } from 'bitcore-lib-xpi'

import { colorSalt } from './constants'
import { addressColor, pubKeyToColor } from './formatting'

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
    const color = addressColor(address)
    expect(color.hue).toBe(addressBitcore[0])
    expect(color.saturation).toBe(addressBitcore[1] / 255)

    const zeroLead = Buffer.alloc(32, 0)
    const zeroHash = bitcoreCrypto.Hash.sha256(salted(zeroLead))
    expect(pubKeyToColor(zeroLead)).toBe(hsl(zeroHash))
  })

  it('keeps address-string parsing on bitcore', () => {
    const source = readFileSync(join(__dirname, 'formatting.ts'), 'utf8')
    expect(source).toContain('cryptoBackend.sha256')
    expect(source.match(/crypto\.Hash\.sha256\(/g)).toBeNull()
    expect(source).not.toContain('sha256d')
    expect(source).toContain('new Address(addrStr)')
    expect(source).toContain("from 'bitcore-lib-xpi'")
  })
})
