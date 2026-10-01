import { createCipheriv, createHmac, hkdfSync } from 'crypto'

import { gcm } from '@noble/ciphers/aes.js'
import { chacha20poly1305, xchacha20poly1305 } from '@noble/ciphers/chacha.js'

import { hkdfExpand, hkdfExtract } from '../src/schedule.js'

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

function nodeAesGcm(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(key),
    Buffer.from(nonce),
  )
  cipher.setAAD(Buffer.from(aad), { plaintextLength: plaintext.length })
  return new Uint8Array(
    Buffer.concat([
      cipher.update(Buffer.from(plaintext)),
      cipher.final(),
      cipher.getAuthTag(),
    ]),
  )
}

function nodeChaCha(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  const cipher = createCipheriv(
    'chacha20-poly1305',
    Buffer.from(key),
    Buffer.from(nonce),
    {
      authTagLength: 16,
    },
  )
  cipher.setAAD(Buffer.from(aad), { plaintextLength: plaintext.length })
  return new Uint8Array(
    Buffer.concat([
      cipher.update(Buffer.from(plaintext)),
      cipher.final(),
      cipher.getAuthTag(),
    ]),
  )
}

describe('known answers', () => {
  test('RFC 5869 HKDF-SHA256 cases 1 and 3', () => {
    const ikm = new Uint8Array(22).fill(0x0b)
    const salt = fromHex('000102030405060708090a0b0c')
    const info = fromHex('f0f1f2f3f4f5f6f7f8f9')
    const prk = hkdfExtract(ikm, salt)
    expect(toHex(prk)).toBe(
      '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5',
    )
    expect(toHex(hkdfExpand(prk, info, 42))).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    )
    expect(toHex(Buffer.from(hkdfSync('sha256', ikm, salt, info, 42)))).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    )

    const empty = new Uint8Array(0)
    const prk3 = hkdfExtract(ikm, empty)
    expect(toHex(prk3)).toBe(
      '19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04',
    )
    const okm3 = hkdfExpand(prk3, empty, 42)
    expect(toHex(okm3)).toBe(
      '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
    )
    const hmacPrk = createHmac('sha256', Buffer.alloc(32)).update(ikm).digest()
    expect(Buffer.from(prk3).equals(hmacPrk)).toBe(true)
  })

  test('AES-256-GCM matches Node and a frozen answer', () => {
    const key = new Uint8Array(32)
    const nonce = new Uint8Array(12)
    const aad = Uint8Array.from([0x61, 0x61, 0x64])
    const plaintext = Uint8Array.from([
      0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x66, 0x72, 0x61, 0x6e, 0x6b,
    ])
    const noble = gcm(key, nonce, aad).encrypt(plaintext)
    const node = nodeAesGcm(key, nonce, aad, plaintext)
    expect(toHex(noble)).toBe(
      'a6c22c5122400d1c6620ae62848a19f6fa1c4194942f07be3c34c8',
    )
    expect(toHex(node)).toBe(toHex(noble))
    expect(toHex(gcm(key, nonce, aad).decrypt(noble))).toBe(toHex(plaintext))
    const flipped = new Uint8Array(noble)
    flipped[flipped.length - 1] ^= 0x01
    expect(() => gcm(key, nonce, aad).decrypt(flipped)).toThrow()
  })

  test('RFC 8439 ChaCha20-Poly1305 matches Node', () => {
    const key = fromHex(
      '808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f',
    )
    const nonce = fromHex('070000004041424344454647')
    const aad = fromHex('50515253c0c1c2c3c4c5c6c7')
    const plaintext = fromHex(
      '4c616469657320616e642047656e746c656d656e206f662074686520636c617373206f66202739393a204966204920636f756c64206f6666657220796f75206f6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73637265656e20776f756c642062652069742e',
    )
    const expected =
      'd31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b61161ae10b594f09e26a7e902ecbd0600691'
    const noble = chacha20poly1305(key, nonce, aad).encrypt(plaintext)
    expect(toHex(noble)).toBe(expected)
    expect(toHex(nodeChaCha(key, nonce, aad, plaintext))).toBe(expected)
  })

  test('draft-irtf-cfrg-xchacha XChaCha20-Poly1305 vector', () => {
    const key = fromHex(
      '808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f',
    )
    const nonce = fromHex('404142434445464748494a4b4c4d4e4f5051525354555657')
    const aad = fromHex('50515253c0c1c2c3c4c5c6c7')
    const plaintext = fromHex(
      '4c616469657320616e642047656e746c656d656e206f662074686520636c617373206f66202739393a204966204920636f756c64206f6666657220796f75206f6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73637265656e20776f756c642062652069742e',
    )
    const expected =
      'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52ec0875924c1c7987947deafd8780acf49'
    const noble = xchacha20poly1305(key, nonce, aad).encrypt(plaintext)
    expect(toHex(noble)).toBe(expected)
    expect(toHex(xchacha20poly1305(key, nonce, aad).decrypt(noble))).toBe(
      toHex(plaintext),
    )
  })
})
