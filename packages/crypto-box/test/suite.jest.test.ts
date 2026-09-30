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

const senderSk = secret(1)
const recipientSk = secret(2)
const ephemeral = secret(3)
const salt = new Uint8Array(32).fill(0x07)
const senderPk = publicKey(senderSk)
const recipientPk = publicKey(recipientSk)
const context = text('ctx')

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
    expect(readme).toContain('no prekeys')
    expect(readme).toContain('no ratchet')
    expect(readme).toContain('0xFF00')
    expect(readme).toContain('not a CBOR version-1')
    expect(readme).toContain('protobuf')
    expect(readme).toContain('AES-CBC is not used')
    expect(readme).toContain('waiting')
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
      expect(envelope[0]).toBe(1)
      expect((envelope[1] << 8) | envelope[2]).toBe(suiteId)
      expect((envelope[3] << 8) | envelope[4]).toBe(0xff00)
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
    salted[5] ^= 0x01
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
    reserved[1] = 0xff
    reserved[2] = 0xff
    const reservedOpen = open({
      envelope: reserved,
      recipientPrivateKey: recipientSk,
      senderPublicKey: senderPk,
      context,
    })
    expect(reservedOpen.ok).toBe(false)
    if (!reservedOpen.ok) expect(reservedOpen.error.code).toBe('reserved-suite')

    const badKem = new Uint8Array(envelope)
    badKem[3] = 0x00
    badKem[4] = 0x10
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

  test('whole-envelope vectors', () => {
    const base = mustSeal(SUITE_BASE_AES_GCM, 'frank')
    const auth = mustSeal(SUITE_AUTH_XCHACHA, 'frank')
    expect(base.length).toBeGreaterThan(70)
    expect(auth.length).toBe(base.length)
    expect(toHex(base)).not.toBe(toHex(auth))
    expect(toHex(base)).toBe(
      '01fe01ff00070707070707070707070707070707070707070707070707070707070707070702f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f98c60b582dc48876cd46f72eaa4544263a6ab1804aa709d44b1',
    )
    expect(toHex(auth)).toBe(
      '01fe04ff00070707070707070707070707070707070707070707070707070707070707070702f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9c1b582181da35780536a806ac7f220b9ccb5e3760fa2ca3daa',
    )
    const opened = open({
      envelope: base,
      recipientPrivateKey: recipientSk,
      senderPublicKey: senderPk,
      context,
    })
    expect(opened.ok).toBe(true)
    if (opened.ok) expect(Buffer.from(opened.value).toString()).toBe('frank')
  })
})
