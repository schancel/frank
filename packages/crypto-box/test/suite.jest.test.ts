import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

import { ecdh } from '@frank/nakamoto/curve'
import { privateKeyFromBytes } from '@frank/nakamoto/constructors'

import {
  KEM_NAME,
  KEM_SECP256K1,
  RESERVED_PROOF_SUITE_ID,
  SUITE_AUTH_AES_GCM,
  SUITE_AUTH_XCHACHA,
  SUITE_BASE_AES_GCM,
  SUITE_BASE_XCHACHA,
  SUITES,
  isSuiteError,
  open,
  producedSuiteIds,
  seal,
} from '../src'
import { decodeEnvelope, encodeEnvelope } from '../src/envelope.js'
import { MAX_MESSAGE, MAX_PADDING } from '../src/ids.js'
import { sealAuthAsRecipient } from '../src/seal.js'

const GENERATOR = Uint8Array.from([
  0x02, 0x79, 0xbe, 0x66, 0x7e, 0xf9, 0xdc, 0xbb, 0xac, 0x55, 0xa0, 0x62, 0x95,
  0xce, 0x87, 0x0b, 0x07, 0x02, 0x9b, 0xfc, 0xdb, 0x2d, 0xce, 0x28, 0xd9, 0x59,
  0xf2, 0x81, 0x5b, 0x16, 0xf8, 0x17, 0x98,
])

function secret(byte: number): Uint8Array {
  const out = new Uint8Array(32)
  out[31] = byte
  return out
}

function publicKey(bytes: Uint8Array): Uint8Array {
  const key = privateKeyFromBytes(bytes, true)
  if (!key.ok) throw new Error('secret')
  const point = ecdh(key.value, GENERATOR)
  if (!point.ok) throw new Error('public')
  return point.value.point
}

function text(value: string): Uint8Array {
  return Uint8Array.from(value, char => char.charCodeAt(0))
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

function replaceBytes(
  bytes: Uint8Array,
  offset: number,
  removed: number,
  inserted: readonly number[],
): Uint8Array {
  const out = new Uint8Array(bytes.length - removed + inserted.length)
  out.set(bytes.subarray(0, offset))
  out.set(inserted, offset)
  out.set(bytes.subarray(offset + removed), offset + inserted.length)
  return out
}

const senderSk = secret(1)
const recipientSk = secret(2)
const ephemeral = secret(3)
const salt = new Uint8Array(32).fill(0x07)
const senderPk = publicKey(senderSk)
const recipientPk = publicKey(recipientSk)
const ephemeralPk = publicKey(ephemeral)
const context = text('ctx')
const CIPHERTEXT_HEAD_OFFSET = 83
const LEGACY_V1_VECTORS = new Map([
  [
    SUITE_BASE_AES_GCM,
    '01fe01ff00070707070707070707070707070707070707070707070707070707070707070702f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f98c60b582dc48876cd46f72eaa4544263a6ab1804aa709d44b1',
  ],
  [
    SUITE_BASE_XCHACHA,
    '01fe02ff00070707070707070707070707070707070707070707070707070707070707070702f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f951a7ad9509175b1502c13aeffec3f63af78a76298fee13861e',
  ],
  [
    SUITE_AUTH_AES_GCM,
    '01fe03ff00070707070707070707070707070707070707070707070707070707070707070702f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9988bf88bd65e72ddf13713ea9cc5be63da20d7fb81ab73f864',
  ],
  [
    SUITE_AUTH_XCHACHA,
    '01fe04ff00070707070707070707070707070707070707070707070707070707070707070702f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9c1b582181da35780536a806ac7f220b9ccb5e3760fa2ca3daa',
  ],
])

function mustSeal(suiteId: number, plaintext: string, padding = 0): Uint8Array {
  const sealed = seal({
    suiteId,
    recipientPublicKey: recipientPk,
    senderPublicKey: senderPk,
    senderPrivateKey: senderSk,
    plaintext: text(plaintext),
    context,
    padding,
    ephemeralSecret: ephemeral,
    salt,
  })
  if (!sealed.ok) throw new Error(sealed.error.code)
  return sealed.value
}

function rewrapAsLegacy(envelope: Uint8Array): Uint8Array {
  const decoded = decodeEnvelope(envelope)
  if (decoded === null) throw new Error('envelope')
  const out = new Uint8Array(70 + decoded.ciphertext.length)
  out.set([
    1,
    decoded.suiteId >>> 8,
    decoded.suiteId & 0xff,
    decoded.kemId >>> 8,
    decoded.kemId & 0xff,
  ])
  out.set(decoded.salt, 5)
  out.set(decoded.enc, 37)
  out.set(decoded.ciphertext, 70)
  return out
}

describe('encryption suites', () => {
  test('the registry is not a CBOR version-1 suite and never emits 65535', () => {
    expect(KEM_SECP256K1).toBe(0xff00)
    expect(KEM_NAME).toBe('DHKEM(secp256k1, HKDF-SHA256)')
    expect(producedSuiteIds).not.toContain(RESERVED_PROOF_SUITE_ID)
    for (const suite of SUITES) {
      expect(suite.cborVersion1).toBe('waiting')
      expect(suite.id).not.toBe(65535)
    }
    const refused = seal({
      suiteId: 65535,
      recipientPublicKey: recipientPk,
      senderPublicKey: senderPk,
      plaintext: text('x'),
      context,
    })
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(isSuiteError(refused.error)).toBe(true)
      expect(refused.error.code).toBe('reserved-suite')
    }
    const readme = readFileSync(join(__dirname, '../README.md'), 'utf8')
    expect(readme).toContain('key-compromise impersonation')
    expect(readme).toContain(
      'no forward secrecy against the recipient static key',
    )
    expect(readme).toContain('does not decrypt recorded auth-mode mail')
    expect(readme).not.toContain('lets an attacker open auth-mode traffic')
    expect(readme).toContain('no prekeys')
    expect(readme).toContain('no ratchet')
    expect(readme).toContain('0xFF00')
    expect(readme).toContain('0xFE01')
    expect(readme).toContain('0xFE02')
    expect(readme).toContain('0xFE03')
    expect(readme).toContain('0xFE04')
    expect(readme).toContain('does not read or write CashWeb CBOR')
    expect(readme).toContain('@frank/codec')
    expect(readme).toContain('frank-cbor')
    expect(readme).toContain('not the live relay protobuf')
    expect(readme).toContain('protobuf')
    expect(readme).toContain('AES-CBC is not used')
    expect(readme).not.toContain('CBOR v1')
    expect(readme).not.toContain('encryption-suite field')
    expect(readme).not.toContain('waiting')
    const spec = readFileSync(
      join(__dirname, '../../../docs/protocol/cbor/README.md'),
      'utf8',
    )
    const codecReadme = readFileSync(
      join(__dirname, '../../frank-codec/README.md'),
      'utf8',
    )
    const rustReadme = readFileSync(
      join(__dirname, '../../../backend/cashweb/frank-cbor/README.md'),
      'utf8',
    )
    for (const boundary of [spec, codecReadme, rustReadme]) {
      expect(boundary).toContain('0xFE01')
      expect(boundary).toContain('65535')
      expect(boundary).toContain(
        'not version-1 encryption-suite allocations (decision 356)',
      )
    }
    const sources = readdirSync(join(__dirname, '../src')).filter(name =>
      name.endsWith('.ts'),
    )
    for (const name of sources) {
      const source = readFileSync(join(__dirname, '../src', name), 'utf8')
      expect(source.toLowerCase()).not.toContain('aes-cbc')
      expect(source).not.toMatch(/\bcbc\s*\(/)
    }
  })

  test('round-trips every produced suite and ignores the sender secret in base mode', () => {
    for (const suiteId of [
      SUITE_BASE_AES_GCM,
      SUITE_BASE_XCHACHA,
      SUITE_AUTH_AES_GCM,
      SUITE_AUTH_XCHACHA,
    ]) {
      const envelope = mustSeal(suiteId, 'frank')
      expect(envelope[0]).toBe(0xa6)
      expect(envelope.slice(0, 4)).toEqual(Uint8Array.of(0xa6, 0, 2, 1))
      expect((envelope[5] << 8) | envelope[6]).toBe(suiteId)
      expect((envelope[9] << 8) | envelope[10]).toBe(0xff00)
      const opened = open({
        envelope,
        recipientPrivateKey: recipientSk,
        senderPublicKey: senderPk,
        context,
      })
      expect(opened.ok).toBe(true)
      if (opened.ok) expect(Buffer.from(opened.value).toString()).toBe('frank')
    }
    const without = seal({
      suiteId: SUITE_BASE_AES_GCM,
      recipientPublicKey: recipientPk,
      senderPublicKey: senderPk,
      plaintext: text('frank'),
      context,
      ephemeralSecret: ephemeral,
      salt,
    })
    const ignored = seal({
      suiteId: SUITE_BASE_AES_GCM,
      recipientPublicKey: recipientPk,
      senderPublicKey: senderPk,
      senderPrivateKey: secret(9),
      plaintext: text('frank'),
      context,
      ephemeralSecret: ephemeral,
      salt,
    })
    expect(without.ok && ignored.ok).toBe(true)
    if (without.ok && ignored.ok) {
      expect(toHex(without.value)).toBe(toHex(ignored.value))
    }
    const missing = seal({
      suiteId: SUITE_AUTH_AES_GCM,
      recipientPublicKey: recipientPk,
      senderPublicKey: senderPk,
      plaintext: text('frank'),
      context,
      ephemeralSecret: ephemeral,
      salt,
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('sender-key')
  })

  test('optional padding hides the plaintext length and still opens', () => {
    const bare = mustSeal(SUITE_BASE_AES_GCM, 'frank', 0)
    const padded = mustSeal(SUITE_BASE_AES_GCM, 'frank', 8)
    expect(padded.length - bare.length).toBe(8)
    const opened = open({
      envelope: padded,
      recipientPrivateKey: recipientSk,
      senderPublicKey: senderPk,
      context,
    })
    expect(opened.ok).toBe(true)
    if (opened.ok) expect(Buffer.from(opened.value).toString()).toBe('frank')
  })

  test('the recipient forges an authenticated ciphertext without the sender secret', () => {
    const forged = sealAuthAsRecipient({
      suiteId: SUITE_AUTH_AES_GCM,
      recipientPrivateKey: recipientSk,
      recipientPublicKey: recipientPk,
      senderPublicKey: senderPk,
      plaintext: text('forged'),
      context,
      ephemeralSecret: secret(4),
      salt,
    })
    expect(forged.ok).toBe(true)
    if (!forged.ok) return
    const opened = open({
      envelope: forged.value,
      recipientPrivateKey: recipientSk,
      senderPublicKey: senderPk,
      context,
    })
    expect(opened.ok).toBe(true)
    if (opened.ok) expect(Buffer.from(opened.value).toString()).toBe('forged')
    const xchacha = sealAuthAsRecipient({
      suiteId: SUITE_AUTH_XCHACHA,
      recipientPrivateKey: recipientSk,
      recipientPublicKey: recipientPk,
      senderPublicKey: senderPk,
      plaintext: text('forged'),
      context,
      ephemeralSecret: secret(4),
      salt,
    })
    expect(xchacha.ok).toBe(true)
    if (!xchacha.ok) return
    const openedX = open({
      envelope: xchacha.value,
      recipientPrivateKey: recipientSk,
      senderPublicKey: senderPk,
      context,
    })
    expect(openedX.ok).toBe(true)
  })

  test('negative opens fail, including a bit flip in each envelope byte', () => {
    const envelope = mustSeal(SUITE_AUTH_XCHACHA, 'frank')
    const wrongContext = open({
      envelope,
      recipientPrivateKey: recipientSk,
      senderPublicKey: senderPk,
      context: text('cty'),
    })
    const wrongSender = open({
      envelope,
      recipientPrivateKey: recipientSk,
      senderPublicKey: publicKey(secret(5)),
      context,
    })
    const wrongRecipient = open({
      envelope,
      recipientPrivateKey: secret(6),
      senderPublicKey: senderPk,
      context,
    })
    expect(wrongContext.ok).toBe(false)
    expect(wrongSender.ok).toBe(false)
    expect(wrongRecipient.ok).toBe(false)
    if (!wrongContext.ok) expect(wrongContext.error.code).toBe('open-failed')

    const salted = new Uint8Array(envelope)
    salted[14] ^= 0x01
    const wrongSalt = open({
      envelope: salted,
      recipientPrivateKey: recipientSk,
      senderPublicKey: senderPk,
      context,
    })
    expect(wrongSalt.ok).toBe(false)

    for (let index = 0; index < envelope.length; index += 1) {
      const flipped = new Uint8Array(envelope)
      flipped[index] ^= 0x01
      const result = open({
        envelope: flipped,
        recipientPrivateKey: recipientSk,
        senderPublicKey: senderPk,
        context,
      })
      expect(result.ok).toBe(false)
    }
    for (let length = 0; length < envelope.length; length += 1) {
      const result = open({
        envelope: envelope.slice(0, length),
        recipientPrivateKey: recipientSk,
        senderPublicKey: senderPk,
        context,
      })
      expect(result.ok).toBe(false)
    }

    const reserved = new Uint8Array(envelope)
    reserved[5] = 0xff
    reserved[6] = 0xff
    const reservedOpen = open({
      envelope: reserved,
      recipientPrivateKey: recipientSk,
      senderPublicKey: senderPk,
      context,
    })
    expect(reservedOpen.ok).toBe(false)
    if (!reservedOpen.ok) expect(reservedOpen.error.code).toBe('reserved-suite')

    const badKem = new Uint8Array(envelope)
    badKem[9] = 0x00
    badKem[10] = 0x10
    const kemOpen = open({
      envelope: badKem,
      recipientPrivateKey: recipientSk,
      senderPublicKey: senderPk,
      context,
    })
    expect(kemOpen.ok).toBe(false)
    if (!kemOpen.ok) expect(kemOpen.error.code).toBe('envelope')

    const badLength = seal({
      suiteId: SUITE_BASE_AES_GCM,
      recipientPublicKey: senderPk.slice(0, 32),
      senderPublicKey: senderPk,
      plaintext: text('frank'),
      context,
    })
    expect(badLength.ok).toBe(false)
    if (!badLength.ok) expect(badLength.error.code).toBe('bad-length')
  })

  test('rejects every non-canonical or malformed envelope shape', () => {
    const valid = mustSeal(SUITE_AUTH_XCHACHA, 'frank')
    const malformed = [
      replaceBytes(valid, 0, 1, [0xb8, 0x06]), // non-canonical map length
      replaceBytes(valid, 1, 1, [0x18, 0x00]), // non-canonical map key
      replaceBytes(valid, 2, 1, [0x18, 0x02]), // non-canonical integer
      replaceBytes(valid, 4, 3, [0x1a, 0x00, 0x00, 0xfe, 0x04]),
      replaceBytes(valid, 12, 2, [0x59, 0x00, 0x20]), // non-canonical bstr length
      replaceBytes(valid, 83, 2, [0x59, 0x00, 0x19]),
      replaceBytes(
        valid,
        3,
        8,
        Array.from(valid.subarray(7, 11)).concat(
          Array.from(valid.subarray(3, 7)),
        ),
      ), // reordered keys
      replaceBytes(valid, 7, 1, [0x01]), // duplicate key
      replaceBytes(valid, 7, 1, [0x06]), // unknown key
      replaceBytes(valid, 0, 1, [0xa5]).slice(0, 82), // missing key
      replaceBytes(valid, 4, 1, [0x59]), // wrong suite type
      replaceBytes(valid, 12, 1, [0x98]), // wrong salt type
      replaceBytes(valid, 83, 1, [0x99]), // wrong ciphertext type
      replaceBytes(valid, 0, 1, [0xbf]), // indefinite map
      replaceBytes(valid, 12, 1, [0x5f]), // indefinite bstr
      replaceBytes(valid, valid.length, 0, [0x00]), // trailing byte
      replaceBytes(valid, 12, 2, [0x58, 0x1f]), // salt fixed length
      replaceBytes(valid, 47, 2, [0x58, 0x20]), // enc fixed length
    ]
    for (const envelope of malformed) {
      const result = open({
        envelope,
        recipientPrivateKey: recipientSk,
        senderPublicKey: senderPk,
        context,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('envelope')
    }

    const oversized = new Uint8Array(1_114_220)
    oversized[0] = 0xa6
    expect(decodeEnvelope(oversized)).toBeNull()
    const overBound = open({
      envelope: oversized,
      recipientPrivateKey: recipientSk,
      senderPublicKey: senderPk,
      context,
    })
    expect(overBound.ok).toBe(false)
    if (!overBound.ok) expect(overBound.error.code).toBe('envelope')
  })

  test.each([
    SUITE_BASE_AES_GCM,
    SUITE_BASE_XCHACHA,
    SUITE_AUTH_AES_GCM,
    SUITE_AUTH_XCHACHA,
  ])('authenticates v1 and v2 as distinct domains for suite %i', suiteId => {
    const frozen = LEGACY_V1_VECTORS.get(suiteId)
    if (frozen === undefined) throw new Error('legacy vector')
    const legacy = fromHex(frozen)
    const legacyOpened = open({
      envelope: legacy,
      recipientPrivateKey: recipientSk,
      senderPublicKey: senderPk,
      context,
    })
    expect(legacyOpened.ok).toBe(true)
    if (legacyOpened.ok) {
      expect(Buffer.from(legacyOpened.value).toString()).toBe('frank')
    }

    const current = mustSeal(suiteId, 'frank')
    const currentOpened = open({
      envelope: current,
      recipientPrivateKey: recipientSk,
      senderPublicKey: senderPk,
      context,
    })
    expect(currentOpened.ok).toBe(true)

    const v2AsV1 = open({
      envelope: rewrapAsLegacy(current),
      recipientPrivateKey: recipientSk,
      senderPublicKey: senderPk,
      context,
    })
    expect(v2AsV1.ok).toBe(false)
    if (!v2AsV1.ok) expect(v2AsV1.error.code).toBe('open-failed')

    const decodedLegacy = decodeEnvelope(legacy)
    if (decodedLegacy === null) throw new Error('legacy decode')
    const v1AsV2 = open({
      envelope: encodeEnvelope(
        decodedLegacy.suiteId,
        decodedLegacy.kemId,
        decodedLegacy.salt,
        decodedLegacy.enc,
        decodedLegacy.ciphertext,
      ),
      recipientPrivateKey: recipientSk,
      senderPublicKey: senderPk,
      context,
    })
    expect(v1AsV2.ok).toBe(false)
    if (!v1AsV2.ok) expect(v1AsV2.error.code).toBe('open-failed')
  })

  test('rejects unknown versions and malformed legacy envelopes', () => {
    const frozen = LEGACY_V1_VECTORS.get(SUITE_BASE_AES_GCM)
    if (frozen === undefined) throw new Error('legacy vector')
    const legacy = fromHex(frozen)

    const current = mustSeal(SUITE_BASE_AES_GCM, 'frank')
    expect(current.slice(0, 3)).toEqual(Uint8Array.of(0xa6, 0, 2))

    for (const version of [1, 3]) {
      const changed = new Uint8Array(current)
      changed[2] = version
      const result = open({
        envelope: changed,
        recipientPrivateKey: recipientSk,
        senderPublicKey: senderPk,
        context,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('envelope')
    }

    for (const [envelope, code] of [
      [legacy.slice(0, 89), 'envelope'],
      [legacy.slice(0, 90), 'open-failed'],
      [Uint8Array.of(0x02), 'envelope'],
      [new Uint8Array(1_114_202).fill(0x01), 'envelope'],
    ] as const) {
      const result = open({
        envelope,
        recipientPrivateKey: recipientSk,
        senderPublicKey: senderPk,
        context,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe(code)
    }

    const legacyBadKem = new Uint8Array(legacy)
    legacyBadKem[4] = 0x01
    const badKem = open({
      envelope: legacyBadKem,
      recipientPrivateKey: recipientSk,
      senderPublicKey: senderPk,
      context,
    })
    expect(badKem.ok).toBe(false)
    if (!badKem.ok) expect(badKem.error.code).toBe('envelope')
  })

  test('rejects structurally impossible ciphertext lengths before opening', () => {
    for (const length of [0, 15, 16, 19]) {
      const envelope = encodeEnvelope(
        SUITE_BASE_AES_GCM,
        KEM_SECP256K1,
        salt,
        ephemeralPk,
        new Uint8Array(length),
      )
      const result = open({
        envelope,
        recipientPrivateKey: recipientSk,
        senderPublicKey: senderPk,
        context,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('envelope')
    }

    const minimum = encodeEnvelope(
      SUITE_BASE_AES_GCM,
      KEM_SECP256K1,
      salt,
      ephemeralPk,
      new Uint8Array(20),
    )
    const minimumResult = open({
      envelope: minimum,
      recipientPrivateKey: recipientSk,
      senderPublicKey: senderPk,
      context,
    })
    expect(minimumResult.ok).toBe(false)
    if (!minimumResult.ok) expect(minimumResult.error.code).toBe('open-failed')

    const empty = mustSeal(SUITE_BASE_AES_GCM, '')
    expect(empty.slice(CIPHERTEXT_HEAD_OFFSET, 84)).toEqual(Uint8Array.of(0x54))
    const opened = open({
      envelope: empty,
      recipientPrivateKey: recipientSk,
      senderPublicKey: senderPk,
      context,
    })
    expect(opened.ok).toBe(true)
    if (opened.ok) expect(opened.value).toHaveLength(0)
  })

  test.each([
    [23, [0x57]],
    [24, [0x58, 0x18]],
    [255, [0x58, 0xff]],
    [256, [0x59, 0x01, 0x00]],
    [65535, [0x59, 0xff, 0xff]],
    [65536, [0x5a, 0x00, 0x01, 0x00, 0x00]],
  ] as const)(
    'uses the canonical byte-string head at length %i',
    (length, head) => {
      const envelope = encodeEnvelope(
        SUITE_BASE_AES_GCM,
        KEM_SECP256K1,
        salt,
        ephemeralPk,
        new Uint8Array(length),
      )
      expect(
        envelope.slice(
          CIPHERTEXT_HEAD_OFFSET,
          CIPHERTEXT_HEAD_OFFSET + head.length,
        ),
      ).toEqual(Uint8Array.from(head))
      expect(envelope).toHaveLength(
        CIPHERTEXT_HEAD_OFFSET + head.length + length,
      )
      expect(decodeEnvelope(envelope)?.ciphertext).toHaveLength(length)
    },
  )

  test('round-trips the maximum message and padding envelope', () => {
    const plaintext = new Uint8Array(MAX_MESSAGE).fill(0x42)
    const paddingBytes = new Uint8Array(MAX_PADDING).fill(0xa5)
    const sealed = seal({
      suiteId: SUITE_BASE_AES_GCM,
      recipientPublicKey: recipientPk,
      senderPublicKey: senderPk,
      plaintext,
      context,
      paddingBytes,
      ephemeralSecret: ephemeral,
      salt,
    })
    expect(sealed.ok).toBe(true)
    if (!sealed.ok) return
    expect(sealed.value).toHaveLength(1_114_219)
    expect(sealed.value.slice(CIPHERTEXT_HEAD_OFFSET, 88)).toEqual(
      Uint8Array.of(0x5a, 0x00, 0x11, 0x00, 0x13),
    )
    const opened = open({
      envelope: sealed.value,
      recipientPrivateKey: recipientSk,
      senderPublicKey: senderPk,
      context,
    })
    expect(opened.ok).toBe(true)
    if (opened.ok) {
      expect(opened.value).toHaveLength(MAX_MESSAGE)
      expect(
        Buffer.compare(Buffer.from(opened.value), Buffer.from(plaintext)),
      ).toBe(0)
    }
  })

  test('encoded fields control dispatch and cryptographic inputs', () => {
    const envelope = mustSeal(SUITE_AUTH_XCHACHA, 'frank')
    const mutations = [
      [2, 0x01], // CBOR v1 is not the legacy fixed layout
      [6, 0x03], // suite: auth XChaCha -> auth AES-GCM
      [10, 0x01], // KEM
      [14, 0x06], // salt
      [49, envelope[49] ^ 0x01], // encapsulated point
      [85, envelope[85] ^ 0x01], // ciphertext
    ] as const
    for (const [offset, value] of mutations) {
      const changed = new Uint8Array(envelope)
      changed[offset] = value
      const result = open({
        envelope: changed,
        recipientPrivateKey: recipientSk,
        senderPublicKey: senderPk,
        context,
      })
      expect(result.ok).toBe(false)
    }
    const unknownSuite = new Uint8Array(envelope)
    unknownSuite[6] = 0x05
    const unknown = open({
      envelope: unknownSuite,
      recipientPrivateKey: recipientSk,
      senderPublicKey: senderPk,
      context,
    })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('suite-unknown')
  })

  test('whole-envelope deterministic-CBOR vectors for every suite', () => {
    const vectors = new Map([
      [
        SUITE_BASE_AES_GCM,
        'a600020119fe010219ff00035820070707070707070707070707070707070707070707070707070707070707070704582102f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f90558198c60b582dc48876cd4c9094cf347d1f73ba9573694f1ad2c55',
      ],
      [
        SUITE_BASE_XCHACHA,
        'a600020119fe020219ff00035820070707070707070707070707070707070707070707070707070707070707070704582102f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f905581951a7ad9509175b1502d2a5a3327090ed57a609e14918954b32',
      ],
      [
        SUITE_AUTH_AES_GCM,
        'a600020119fe030219ff00035820070707070707070707070707070707070707070707070707070707070707070704582102f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9055819988bf88bd65e72ddf1084879129f81d4070f65edfd087f6aa6',
      ],
      [
        SUITE_AUTH_XCHACHA,
        'a600020119fe040219ff00035820070707070707070707070707070707070707070707070707070707070707070704582102f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9055819c1b582181da3578053f5e224eb01c12b89ce7429dc47ef3803',
      ],
    ])
    for (const [suiteId, expected] of vectors) {
      const envelope = mustSeal(suiteId, 'frank')
      expect(toHex(envelope)).toBe(expected)
      const opened = open({
        envelope,
        recipientPrivateKey: recipientSk,
        senderPublicKey: senderPk,
        context,
      })
      expect(opened.ok).toBe(true)
      if (opened.ok) expect(Buffer.from(opened.value).toString()).toBe('frank')
    }
  })
})
