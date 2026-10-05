import { ecdh } from '@frank/nakamoto/curve'
import { privateKeyFromBytes } from '@frank/nakamoto/constructors'

import {
  SUITE_AUTH_XCHACHA,
  SUITE_BASE_XCHACHA,
  open,
  openAsSender,
  randomBytes,
  seal,
  selfOpenEphemeral,
  selfOpenKeyFromRoot,
} from '../src'

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

describe('selfOpenKeyFromRoot', () => {
  it('derives a deterministic 32-byte key from messaging root', () => {
    const root1 = new Uint8Array(32).fill(1)
    const key1a = selfOpenKeyFromRoot(root1)
    const key1b = selfOpenKeyFromRoot(root1)
    expect(key1a.length).toBe(32)
    expect(key1a).toEqual(key1b)

    const root2 = new Uint8Array(32).fill(2)
    const key2 = selfOpenKeyFromRoot(root2)
    expect(key2).not.toEqual(key1a)
  })

  it('rejects roots that are not exactly 32 bytes', () => {
    expect(() => selfOpenKeyFromRoot(new Uint8Array(31))).toThrow(RangeError)
    expect(() => selfOpenKeyFromRoot(new Uint8Array(33))).toThrow(RangeError)
    expect(() => selfOpenKeyFromRoot(new Uint8Array(0))).toThrow(RangeError)
  })
})

describe('selfOpenEphemeral', () => {
  const selfOpenKey = new Uint8Array(32).fill(3)
  const salt = new Uint8Array(32).fill(4)
  const recipient = publicKey(secret(5))
  const sender = publicKey(secret(6))

  it('derives a deterministic scalar', () => {
    const eph1 = selfOpenEphemeral({
      selfOpenKey,
      salt,
      recipientPublicKey: recipient,
      senderPublicKey: sender,
    })
    const eph2 = selfOpenEphemeral({
      selfOpenKey,
      salt,
      recipientPublicKey: recipient,
      senderPublicKey: sender,
    })
    expect(eph1).not.toBeNull()
    expect(eph1!.length).toBe(32)
    expect(eph1).toEqual(eph2)
  })

  it('changes when salt changes', () => {
    const saltAlt = new Uint8Array(32).fill(99)
    const eph1 = selfOpenEphemeral({
      selfOpenKey,
      salt,
      recipientPublicKey: recipient,
      senderPublicKey: sender,
    })
    const eph2 = selfOpenEphemeral({
      selfOpenKey,
      salt: saltAlt,
      recipientPublicKey: recipient,
      senderPublicKey: sender,
    })
    expect(eph1).not.toEqual(eph2)
  })

  it('returns null on invalid inputs', () => {
    expect(
      selfOpenEphemeral({
        selfOpenKey: new Uint8Array(31),
        salt,
        recipientPublicKey: recipient,
        senderPublicKey: sender,
      }),
    ).toBeNull()

    expect(
      selfOpenEphemeral({
        selfOpenKey,
        salt: new Uint8Array(16),
        recipientPublicKey: recipient,
        senderPublicKey: sender,
      }),
    ).toBeNull()

    expect(
      selfOpenEphemeral({
        selfOpenKey,
        salt,
        recipientPublicKey: new Uint8Array(32),
        senderPublicKey: sender,
      }),
    ).toBeNull()

    expect(
      selfOpenEphemeral({
        selfOpenKey,
        salt,
        recipientPublicKey: recipient,
        senderPublicKey: new Uint8Array(32),
      }),
    ).toBeNull()
  })
})

describe('openAsSender', () => {
  const messagingRoot = new Uint8Array(32).fill(0x42)
  const selfOpenKey = selfOpenKeyFromRoot(messagingRoot)
  const senderPrivate = secret(10)
  const senderPublic = publicKey(senderPrivate)
  const recipientPrivate = secret(20)
  const recipientPublic = publicKey(recipientPrivate)
  const plaintext = new Uint8Array([10, 20, 30, 40, 50])
  const context = new Uint8Array([1, 2, 3])

  it('allows sender to open its own deterministic-ephemeral envelope', () => {
    const salt = randomBytes(32)
    const ephSecret = selfOpenEphemeral({
      selfOpenKey,
      salt,
      recipientPublicKey: recipientPublic,
      senderPublicKey: senderPublic,
    })!
    expect(ephSecret).not.toBeNull()

    const sealed = seal({
      suiteId: SUITE_AUTH_XCHACHA,
      senderPrivateKey: senderPrivate,
      senderPublicKey: senderPublic,
      recipientPublicKey: recipientPublic,
      plaintext,
      context,
      salt,
      ephemeralSecret: ephSecret,
    })
    expect(sealed.ok).toBe(true)
    if (!sealed.ok) return

    // Recipient can open normally.
    const recipientOpened = open({
      envelope: sealed.value,
      recipientPrivateKey: recipientPrivate,
      senderPublicKey: senderPublic,
      context,
    })
    expect(recipientOpened).toEqual({ ok: true, value: plaintext })

    // Sender can open using openAsSender.
    const senderOpened = openAsSender({
      envelope: sealed.value,
      selfOpenKey,
      senderPrivateKey: senderPrivate,
      senderPublicKey: senderPublic,
      recipientPublicKey: recipientPublic,
      context,
    })
    expect(senderOpened).toEqual({ ok: true, value: plaintext })

    // Sender can also open without explicitly specifying senderPublicKey.
    const senderOpenedNoPub = openAsSender({
      envelope: sealed.value,
      selfOpenKey,
      senderPrivateKey: senderPrivate,
      recipientPublicKey: recipientPublic,
      context,
    })
    expect(senderOpenedNoPub).toEqual({ ok: true, value: plaintext })
  })

  it('rejects envelope sealed with random ephemeral key with not-self-openable', () => {
    // Normal seal without ephemeralSecret uses fresh random ephemeral.
    const sealed = seal({
      suiteId: SUITE_AUTH_XCHACHA,
      senderPrivateKey: senderPrivate,
      senderPublicKey: senderPublic,
      recipientPublicKey: recipientPublic,
      plaintext,
      context,
    })
    expect(sealed.ok).toBe(true)
    if (!sealed.ok) return

    const res = openAsSender({
      envelope: sealed.value,
      selfOpenKey,
      senderPrivateKey: senderPrivate,
      recipientPublicKey: recipientPublic,
      context,
    })
    expect(res).toEqual({
      ok: false,
      error: { code: 'not-self-openable' },
    })
  })

  it('rejects with not-self-openable if selfOpenKey is incorrect', () => {
    const salt = randomBytes(32)
    const ephSecret = selfOpenEphemeral({
      selfOpenKey,
      salt,
      recipientPublicKey: recipientPublic,
      senderPublicKey: senderPublic,
    })!

    const sealed = seal({
      suiteId: SUITE_AUTH_XCHACHA,
      senderPrivateKey: senderPrivate,
      senderPublicKey: senderPublic,
      recipientPublicKey: recipientPublic,
      plaintext,
      context,
      salt,
      ephemeralSecret: ephSecret,
    })
    expect(sealed.ok).toBe(true)
    if (!sealed.ok) return

    const wrongKey = new Uint8Array(32).fill(0xff)
    const res = openAsSender({
      envelope: sealed.value,
      selfOpenKey: wrongKey,
      senderPrivateKey: senderPrivate,
      recipientPublicKey: recipientPublic,
      context,
    })
    expect(res).toEqual({
      ok: false,
      error: { code: 'not-self-openable' },
    })
  })

  it('rejects with not-self-openable if recipientPublicKey does not match', () => {
    const salt = randomBytes(32)
    const ephSecret = selfOpenEphemeral({
      selfOpenKey,
      salt,
      recipientPublicKey: recipientPublic,
      senderPublicKey: senderPublic,
    })!

    const sealed = seal({
      suiteId: SUITE_AUTH_XCHACHA,
      senderPrivateKey: senderPrivate,
      senderPublicKey: senderPublic,
      recipientPublicKey: recipientPublic,
      plaintext,
      context,
      salt,
      ephemeralSecret: ephSecret,
    })
    expect(sealed.ok).toBe(true)
    if (!sealed.ok) return

    const otherRecipient = publicKey(secret(30))
    const res = openAsSender({
      envelope: sealed.value,
      selfOpenKey,
      senderPrivateKey: senderPrivate,
      recipientPublicKey: otherRecipient,
      context,
    })
    expect(res).toEqual({
      ok: false,
      error: { code: 'not-self-openable' },
    })
  })

  it('rejects with sender-key if senderPublicKey does not match senderPrivateKey', () => {
    const salt = randomBytes(32)
    const ephSecret = selfOpenEphemeral({
      selfOpenKey,
      salt,
      recipientPublicKey: recipientPublic,
      senderPublicKey: senderPublic,
    })!

    const sealed = seal({
      suiteId: SUITE_AUTH_XCHACHA,
      senderPrivateKey: senderPrivate,
      senderPublicKey: senderPublic,
      recipientPublicKey: recipientPublic,
      plaintext,
      context,
      salt,
      ephemeralSecret: ephSecret,
    })
    expect(sealed.ok).toBe(true)
    if (!sealed.ok) return

    const mismatchedPub = publicKey(secret(40))
    const res = openAsSender({
      envelope: sealed.value,
      selfOpenKey,
      senderPrivateKey: senderPrivate,
      senderPublicKey: mismatchedPub,
      recipientPublicKey: recipientPublic,
      context,
    })
    expect(res).toEqual({
      ok: false,
      error: { code: 'sender-key' },
    })
  })

  it('rejects with open-failed if context does not match', () => {
    const salt = randomBytes(32)
    const ephSecret = selfOpenEphemeral({
      selfOpenKey,
      salt,
      recipientPublicKey: recipientPublic,
      senderPublicKey: senderPublic,
    })!

    const sealed = seal({
      suiteId: SUITE_AUTH_XCHACHA,
      senderPrivateKey: senderPrivate,
      senderPublicKey: senderPublic,
      recipientPublicKey: recipientPublic,
      plaintext,
      context,
      salt,
      ephemeralSecret: ephSecret,
    })
    expect(sealed.ok).toBe(true)
    if (!sealed.ok) return

    const wrongContext = new Uint8Array([9, 9, 9])
    const res = openAsSender({
      envelope: sealed.value,
      selfOpenKey,
      senderPrivateKey: senderPrivate,
      recipientPublicKey: recipientPublic,
      context: wrongContext,
    })
    expect(res).toEqual({
      ok: false,
      error: { code: 'open-failed' },
    })
  })

  it('rejects base-mode suites with not-self-openable', () => {
    const salt = randomBytes(32)
    const sealed = seal({
      suiteId: SUITE_BASE_XCHACHA,
      senderPublicKey: senderPublic,
      recipientPublicKey: recipientPublic,
      plaintext,
      context,
      salt,
    })
    expect(sealed.ok).toBe(true)
    if (!sealed.ok) return

    const res = openAsSender({
      envelope: sealed.value,
      selfOpenKey,
      senderPrivateKey: senderPrivate,
      recipientPublicKey: recipientPublic,
      context,
    })
    expect(res).toEqual({
      ok: false,
      error: { code: 'not-self-openable' },
    })
  })
})
