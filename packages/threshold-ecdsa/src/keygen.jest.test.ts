import { secp256k1 } from '@noble/curves/secp256k1.js'
import { computeAddress, getAddress } from 'ethers'
import { randomBytes } from 'crypto'

import {
  abortKeygen,
  describeKeyShare,
  exportKeyShare,
  exportKeyShareRecord,
  importKeyShare,
  keygenStep,
  restoreKeyShare,
  signStep,
  startKeygen,
  startSign,
  type KeygenSession,
  type KeyShare,
  type StartKeygenInput,
} from './index.js'
import { bytesToInt, intToBytes } from './bytes.js'
import {
  commit,
  CURVE_ORDER,
  G,
  multiply,
  pointBytes,
  SHARE_HIGH,
  SHARE_LOW,
} from './group.js'
import { computeKeyId } from './key-share.js'
import { KEYGEN_BODY_BOUNDS } from './keygen.js'
import {
  ciphertextBytes,
  drawUnit,
  encrypt,
  paillierSecretKey,
  parseModulus,
} from './paillier.js'
import { HEADER_BYTES, MAX_MESSAGE_BYTES } from './wire.js'
import {
  ascii,
  cloneState,
  drive,
  flip,
  frameError,
  fromHex,
  hex,
  must,
  peerAbort,
  recordedVectors,
  replace,
  type Trace,
} from './test-support.js'

const rng = (length: number): Uint8Array => new Uint8Array(randomBytes(length))
const recorded = recordedVectors()

// Body offsets, see the message table at the top of keygen.ts.
const M2 = { SALT: 0, Q: 32, POK: 65, COM_E: 130 }
const M3 = {
  Q: 0,
  POK: 33,
  NONCE: 98,
  N: 130,
  PROOF: 386,
  CKEY: 3202,
  RANGE: 3714,
}
const M4 = { E: 0, E_NONCE: 10, PDL: 42, PDL_COM: 554 }
const M5 = { HAT: 0, RANGE: 32 }
const M6 = { A: 0, B: 32, NONCE: 96 }
const M7 = { QHAT: 0, NONCE: 33, CONFIRM: 65 }

const sessionId = rng(32)
const initiatorSeed = rng(32)
const responderSeed = rng(32)
const alice = ascii('alice')
const bob = ascii('bob')

let trace: Trace<KeygenSession, KeyShare>
let a: KeyShare
let b: KeyShare

beforeAll(() => {
  trace = drive(
    startKeygen({
      role: 'initiator',
      sessionId,
      localId: alice,
      peerId: bob,
      secretSeed: initiatorSeed,
      randomBytes: rng,
    }),
    startKeygen({
      role: 'responder',
      sessionId,
      localId: bob,
      peerId: alice,
      secretSeed: responderSeed,
      randomBytes: rng,
    }),
    keygenStep,
  )
  a = trace.initiatorResult!
  b = trace.responderResult!
})

function message(index: number): Uint8Array {
  return trace.messages[index]!
}

function deliver(index: number, bytes: Uint8Array) {
  return keygenStep(cloneState(trace.before[index]!), bytes)
}

function at(index: number, offset: number, patch: Uint8Array): Uint8Array {
  return replace(message(index), HEADER_BYTES + offset, patch)
}

function flipAt(index: number, offset: number): Uint8Array {
  return flip(message(index), HEADER_BYTES + offset)
}

function expectAbort(
  result: ReturnType<typeof keygenStep>,
  ...codes: string[]
) {
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(codes).toContain(result.error.code)
  expect(result.error.sessionAborted).toBe(true)
  expect(result.error.keyShareBurned).toBe(false)
  // The application can tell a misbehaving peer from a stray frame.
  expect(result.error.peerFault).toBe(true)
}

function field<T>(share: KeyShare, name: string): T {
  return (share as unknown as Record<string, T>)[name]!
}

function secretOf(share: KeyShare): bigint {
  return bytesToInt(field<Uint8Array>(share, 'secretShare'))
}

const offCurve = (() => {
  const bytes = new Uint8Array(33)
  bytes[0] = 0x02
  bytes[32] = 5
  return bytes
})()

describe('two-party key generation', () => {
  it('gives both parties the same public key, address and key id, with fixed roles', () => {
    const first = must(describeKeyShare(a))
    const second = must(describeKeyShare(b))
    expect(hex(first.publicKey)).toBe(hex(second.publicKey))
    expect(hex(first.keyId)).toBe(hex(second.keyId))
    expect(hex(first.address)).toBe(hex(second.address))
    expect(hex(first.localId)).toBe(hex(alice))
    expect(hex(first.peerId)).toBe(hex(bob))
    expect(first.role).toBe('initiator')
    expect(second.role).toBe('responder')
    expect(first.burned).toBe(false)
    expect(getAddress(`0x${hex(first.address)}`)).toBe(
      computeAddress(`0x${hex(first.publicKey)}`),
    )
  })

  it('shares are multiplicative; only the initiator holds Paillier secrets', () => {
    const xa = secretOf(a)
    const xb = secretOf(b)
    // Protocol 3.1: x1 in [n/3, 2n/3), x2 in [1, n).
    expect(xa >= SHARE_LOW && xa < SHARE_HIGH).toBe(true)
    expect(xb >= 1n && xb < CURVE_ORDER).toBe(true)
    const joint = (xa * xb) % CURVE_ORDER
    const info = must(describeKeyShare(a))
    expect(hex(pointBytes(multiply(G, joint)))).toBe(hex(info.publicKey))
    expect(hex(secp256k1.getPublicKey(intToBytes(joint, 32), true))).toBe(
      hex(info.publicKey),
    )
    expect(field<Uint8Array>(a, 'primeP')).toHaveLength(128)
    expect(field<Uint8Array>(b, 'primeP')).toHaveLength(0)
    expect(hex(field<Uint8Array>(a, 'modulus'))).toBe(
      hex(field<Uint8Array>(b, 'modulus')),
    )
  })

  it('has eight messages of the documented, bounded sizes', () => {
    expect(trace.messages).toHaveLength(8)
    const sizes = trace.messages.map(bytes => bytes.length - HEADER_BYTES)
    expect([sizes[0], sizes[1], sizes[2], sizes[3]]).toEqual([
      64, 162, 3746, 586,
    ])
    expect([sizes[5], sizes[6], sizes[7]]).toEqual([128, 97, 32])
    sizes.forEach((size, index) => {
      const bounds = KEYGEN_BODY_BOUNDS[index + 1]!
      expect(size).toBeGreaterThanOrEqual(bounds.minBody)
      expect(size).toBeLessThanOrEqual(bounds.maxBody)
    })
    // The largest possible message stays under the cap and under 64 KB.
    expect(HEADER_BYTES + KEYGEN_BODY_BOUNDS[5]!.maxBody).toBe(46230)
    expect(MAX_MESSAGE_BYTES).toBeLessThan(64 * 1024)
  })

  it('wipes session secrets once finished and refuses further messages', () => {
    for (const session of [trace.initiatorSession, trace.responderSession]) {
      const state = session as unknown as Record<string, Uint8Array | null>
      for (const name of [
        'share',
        'primeP',
        'primeQ',
        'keyRandomness',
        'rangeSecret',
        'pdlAlpha',
        'pdlA',
        'pdlB',
        'seed',
      ]) {
        const value = state[name]
        if (value !== null) expect(value!.every(byte => byte === 0)).toBe(true)
      }
      expect(keygenStep(session, message(0))).toEqual(
        frameError('session-finished'),
      )
    }
  })

  it('key confirmation: the initiator gets its share only after the responder confirmed', () => {
    // Message 7 is the initiator's last; processing message 6 gave no result.
    const waiting = trace.before[7] as unknown as { pending: unknown }
    expect(waiting.pending).not.toBeNull()
    // A wrong confirmation aborts and wipes the share that was held back
    // (a copy here, so the suite's own share survives).
    const copy = must(importKeyShare(must(exportKeyShare(a))))
    const refused = cloneState(trace.before[7]!) as unknown as {
      pending: KeyShare
    }
    refused.pending = copy
    expectAbort(
      keygenStep(refused as unknown as KeygenSession, flipAt(7, 3)),
      'invalid-commitment',
    )
    expect(
      field<Uint8Array>(copy, 'secretShare').every(byte => byte === 0),
    ).toBe(true)
    const confirmed = deliver(7, message(7))
    expect(confirmed.ok && confirmed.value.result !== null).toBe(true)
    // The responder refuses a wrong confirmation from the initiator.
    expectAbort(deliver(6, flipAt(6, M7.CONFIRM + 1)), 'invalid-commitment')
  })

  it('exports and re-imports a share that still signs', () => {
    const digest = rng(32)
    const again = must(importKeyShare(must(exportKeyShare(a))))
    expect(must(describeKeyShare(again))).toEqual(must(describeKeyShare(a)))
    const signSession = rng(32)
    const signed = drive(
      startSign({
        keyShare: again,
        sessionId: signSession,
        digest,
        randomBytes: rng,
      }),
      startSign({
        keyShare: b,
        sessionId: signSession,
        digest,
        randomBytes: rng,
      }),
      signStep,
    )
    const result = signed.responderResult
    if (result === null || result.kind !== 'signature') {
      throw new Error('no signature')
    }
    expect(
      secp256k1.verify(
        result.signature,
        digest,
        must(describeKeyShare(a)).publicKey,
        { prehash: false },
      ),
    ).toBe(true)
  })

  it('rejects tampered or truncated share bytes', () => {
    for (const share of [a, b]) {
      const bytes = must(exportKeyShare(share))
      for (const index of [
        0,
        4,
        5,
        20,
        60,
        100,
        400,
        900,
        bytes.length - 40,
        bytes.length - 1,
      ]) {
        expect(importKeyShare(flip(bytes, index))).toEqual(
          frameError('invalid-key-share'),
        )
      }
      expect(importKeyShare(bytes.subarray(1)).ok).toBe(false)
      expect(importKeyShare(new Uint8Array([...bytes, 0])).ok).toBe(false)
    }
    expect(importKeyShare('x' as unknown as Uint8Array).ok).toBe(false)
  })

  it('restores a share from the seed and the public record alone', () => {
    for (const [share, seed, other] of [
      [a, initiatorSeed, responderSeed],
      [b, responderSeed, initiatorSeed],
    ] as const) {
      const record = must(exportKeyShareRecord(share))
      const restored = must(restoreKeyShare({ secretSeed: seed, record }))
      expect(hex(must(exportKeyShare(restored)))).toBe(
        hex(must(exportKeyShare(share))),
      )
      // The record holds no secret: the wrong seed cannot rebuild the share.
      expect(restoreKeyShare({ secretSeed: other, record })).toEqual(
        frameError('invalid-key-share'),
      )
      expect(restoreKeyShare({ secretSeed: rng(31), record }).ok).toBe(false)
      expect(hex(record)).not.toContain(hex(intToBytes(secretOf(share), 32)))
    }
  })

  it('a seeded party never derives the same share twice, even for a repeated session id', () => {
    const start = () =>
      must(
        startKeygen({
          role: 'responder',
          sessionId,
          localId: bob,
          peerId: alice,
          secretSeed: responderSeed,
          randomBytes: rng,
        }),
      ).session as unknown as {
        localPoint: Uint8Array
        shareContext: Uint8Array
      }
    const one = start()
    const two = start()
    expect(hex(one.localPoint)).not.toBe(hex(two.localPoint))
    expect(hex(one.shareContext)).not.toBe(hex(two.shareContext))
    expect(hex(one.localPoint)).not.toBe(
      hex(field<Uint8Array>(b, 'localPoint')),
    )
  })

  it('rejects malformed inputs', () => {
    const base: StartKeygenInput = {
      role: 'initiator',
      sessionId: rng(32),
      localId: alice,
      peerId: bob,
      randomBytes: rng,
    }
    const invalid = (input: StartKeygenInput, code = 'invalid-input') => {
      expect(startKeygen(input)).toEqual(frameError(code))
    }
    invalid({ ...base, sessionId: rng(31) })
    invalid({ ...base, peerId: alice })
    invalid({ ...base, localId: new Uint8Array(0) })
    invalid({ ...base, peerId: new Uint8Array(65) })
    invalid({ ...base, secretSeed: rng(16) })
    invalid({ ...base, role: 'other' as 'initiator' })
    invalid(
      { ...base, randomBytes: null as unknown as typeof rng },
      'rng-failed',
    )
    invalid({ ...base, randomBytes: () => new Uint8Array(1) }, 'rng-failed')
  })
})

describe('stored key material is authenticated', () => {
  // Replace the stored c_key by an encryption of x1 + 2^1200 * n under the
  // initiator's key and fix up the (unkeyed) key id. Before the storage MAC
  // this restored cleanly and let the initiator read the responder's share
  // out of one signature. Layout from the end: mac 32, keyId 32, c_key 512.
  function tamper(stored: Uint8Array, trailing: number): Uint8Array {
    const key = paillierSecretKey(
      bytesToInt(field<Uint8Array>(a, 'primeP')),
      bytesToInt(field<Uint8Array>(a, 'primeQ')),
    )
    const evil = ciphertextBytes(
      encrypt(
        key,
        secretOf(a) + (1n << 1200n) * CURVE_ORDER,
        drawUnit(key, rng),
      ),
    )
    const end = stored.length - trailing
    const out = replace(stored, end - 32 - 32 - 512, evil)
    const fields = {
      role: 'responder' as const,
      keygenSession: field<Uint8Array>(b, 'keygenSession'),
      localId: bob,
      peerId: alice,
      localPoint: field<Uint8Array>(b, 'localPoint'),
      peerPoint: field<Uint8Array>(b, 'peerPoint'),
      publicKey: field<Uint8Array>(b, 'publicKey'),
      modulus: field<Uint8Array>(b, 'modulus'),
      ciphertext: evil,
    }
    return replace(out, end - 32 - 32, computeKeyId(fields))
  }

  it('restoreKeyShare refuses a record whose encrypted share was replaced', () => {
    const record = must(exportKeyShareRecord(b))
    expect(restoreKeyShare({ secretSeed: responderSeed, record }).ok).toBe(true)
    expect(
      restoreKeyShare({ secretSeed: responderSeed, record: tamper(record, 0) }),
    ).toEqual(frameError('invalid-key-share'))
    // Any single changed byte, including in the MAC, is refused.
    for (const index of [
      6,
      50,
      120,
      300,
      700,
      record.length - 40,
      record.length - 1,
    ]) {
      expect(
        restoreKeyShare({
          secretSeed: responderSeed,
          record: flip(record, index),
        }),
      ).toEqual(frameError('invalid-key-share'))
    }
  })

  it('importKeyShare refuses the same replacement', () => {
    const stored = must(exportKeyShare(b))
    // Trailing bytes after the body: the 32-byte secret share.
    expect(importKeyShare(tamper(stored, 32))).toEqual(
      frameError('invalid-key-share'),
    )
    expect(importKeyShare(stored).ok).toBe(true)
  })
})

describe('malicious counterpart: key generation', () => {
  it('rejects foreign, out-of-order and malformed frames without aborting', () => {
    for (let index = 0; index < 8; index += 1) {
      const state = cloneState(trace.before[index]!)
      const reject = (bytes: Uint8Array, code: string) => {
        expect(keygenStep(state, bytes)).toEqual(frameError(code))
      }
      // The same round of the recorded test-vector session.
      reject(fromHex(recorded.keygen.messages[index]!), 'wrong-session')
      reject(message((index + 2) % 8), 'unexpected-message')
      reject(message(index).subarray(0, HEADER_BYTES + 10), 'malformed-message')
      reject(flip(message(index), 1), 'malformed-message')
      reject(new Uint8Array(50_000), 'malformed-message')
      // A signing-protocol frame.
      reject(replace(message(index), 4, Uint8Array.of(2)), 'wrong-session')
    }
  })

  it('message 2: rejects a bad proof of knowledge, an invalid point, and a proof made under another salt', () => {
    expectAbort(deliver(1, flipAt(1, M2.POK + 40)), 'invalid-proof')
    expectAbort(deliver(1, at(1, M2.Q, offCurve)), 'invalid-point')
    expectAbort(deliver(1, at(1, M2.Q, new Uint8Array(33))), 'invalid-point')
    // A point of the responder's choosing with someone else's proof.
    expectAbort(
      deliver(1, at(1, M2.Q, pointBytes(multiply(G, 2n)))),
      'invalid-proof',
    )
    // The proof is bound to both salts: changing the responder's salt (as in
    // a replay of an old message 2) invalidates it.
    expectAbort(deliver(1, flipAt(1, M2.SALT)), 'invalid-proof')
  })

  it('message 3: rejects a wrong opening, a wrong proof, and out-of-range Paillier values', () => {
    expectAbort(deliver(2, flipAt(2, M3.NONCE)), 'invalid-commitment')
    expectAbort(
      deliver(2, at(2, M3.Q, pointBytes(multiply(G, 3n)))),
      'invalid-commitment',
    )
    expectAbort(deliver(2, flipAt(2, M3.POK + 50)), 'invalid-commitment')
    const body = message(2).subarray(HEADER_BYTES)
    const modulus = bytesToInt(body.subarray(M3.N, M3.N + 256))
    // Even, too short, small prime factor: rejected before anything else.
    expectAbort(
      deliver(2, at(2, M3.N, intToBytes(modulus + 1n, 256))),
      'invalid-paillier',
    )
    expectAbort(
      deliver(2, at(2, M3.N, intToBytes(modulus >> 1n, 256))),
      'invalid-paillier',
    )
    let smooth = (modulus / 3n) * 3n
    if ((smooth & 1n) === 0n) smooth -= 3n
    expectAbort(
      deliver(2, at(2, M3.N, intToBytes(smooth, 256))),
      'invalid-paillier',
    )
    // A different well-formed modulus: the proof no longer verifies.
    expectAbort(
      deliver(2, at(2, M3.N, intToBytes(modulus + 2n, 256))),
      'invalid-proof',
      'invalid-paillier',
    )
    expectAbort(deliver(2, flipAt(2, M3.PROOF + 10)), 'invalid-proof')
    expectAbort(
      deliver(2, at(2, M3.PROOF, new Uint8Array(256))),
      'invalid-paillier',
    )
    // Encrypted share: zero, N^2, and above N^2.
    expectAbort(
      deliver(2, at(2, M3.CKEY, new Uint8Array(512))),
      'invalid-paillier',
    )
    expectAbort(
      deliver(2, at(2, M3.CKEY, intToBytes(modulus * modulus, 512))),
      'invalid-paillier',
    )
    expectAbort(
      deliver(2, at(2, M3.CKEY, new Uint8Array(512).fill(0xff))),
      'invalid-paillier',
    )
  })

  it('message 3: a valid opening of a share with a bad proof of knowledge is still rejected', () => {
    const state = cloneState(trace.before[2]!) as unknown as {
      peerPointCommit: Uint8Array
      peerSalt: Uint8Array
      session: Uint8Array
      peerId: Uint8Array
    }
    const { keygenInitiatorBinding } = jest.requireActual(
      './wire',
    ) as typeof import('./wire.js')
    const body = message(2).subarray(HEADER_BYTES)
    const payload = flip(body.subarray(0, 98), 97)
    state.peerPointCommit = commit(
      'keygen-point',
      keygenInitiatorBinding(state.session, state.peerSalt),
      state.peerId,
      payload,
      body.subarray(98, 130),
    )
    expectAbort(
      keygenStep(state as unknown as KeygenSession, at(2, 0, payload)),
      'invalid-proof',
    )
  })

  it('message 4: rejects a range challenge other than the committed one, and wipes the session', () => {
    const state = cloneState(trace.before[3]!)
    const secrets = state as unknown as Record<string, Uint8Array>
    expect(secrets.share!.some(byte => byte !== 0)).toBe(true)
    expectAbort(keygenStep(state, flipAt(3, M4.E)), 'invalid-commitment')
    for (const name of [
      'share',
      'primeP',
      'primeQ',
      'keyRandomness',
      'rangeSecret',
      'seed',
    ]) {
      expect(secrets[name]!.every(byte => byte === 0)).toBe(true)
    }
    expect(keygenStep(state, message(3))).toEqual(frameError('session-aborted'))
    expectAbort(deliver(3, flipAt(3, M4.E_NONCE)), 'invalid-commitment')
    expectAbort(
      deliver(3, at(3, M4.PDL, new Uint8Array(512))),
      'invalid-paillier',
    )
  })

  it('message 5: rejects a wrong range response', () => {
    expectAbort(deliver(4, flipAt(4, M5.RANGE + 20)), 'invalid-proof')
    // Cut short by one round.
    expectAbort(
      deliver(4, message(4).subarray(0, message(4).length - 321)),
      'malformed-message',
      'invalid-proof',
    )
  })

  it('an encrypted share outside [0, n) is caught by the range proof', () => {
    // The initiator sends c_key encrypting x1 + n instead of x1 (it would
    // make later decryptions wrap around and leak the responder's share).
    // The modulus proof and the layout are fine, so message 3 is accepted;
    // the range response, honest for the real share, cannot verify.
    const key = parseModulus(field<Uint8Array>(a, 'modulus'))
    const lying = ciphertextBytes(encrypt(key, secretOf(a) + CURVE_ORDER, 17n))
    const accepted = deliver(2, at(2, M3.CKEY, lying))
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) return
    expectAbort(keygenStep(accepted.value.session, message(4)), 'invalid-proof')
  })

  it('message 6: rejects a wrong opening of the challenge (a, b)', () => {
    expectAbort(deliver(5, flipAt(5, M6.A + 5)), 'invalid-commitment')
    expectAbort(deliver(5, flipAt(5, M6.B + 5)), 'invalid-commitment')
    expectAbort(deliver(5, flipAt(5, M6.NONCE)), 'invalid-commitment')
  })

  it('a challenge ciphertext that is not a*c_key + b makes the prover abort without revealing Qhat', () => {
    // The responder replaces c' by an encryption of an unrelated value. The
    // initiator decrypts it and commits; when the responder opens (a, b),
    // the decryption does not equal a*x1 + b and the initiator stops.
    const key = parseModulus(field<Uint8Array>(a, 'modulus'))
    const probe = ciphertextBytes(encrypt(key, 123456789n, 19n))
    const accepted = deliver(3, at(3, M4.PDL, probe))
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) return
    expect(accepted.value.outgoing).not.toBeNull()
    expectAbort(keygenStep(accepted.value.session, message(5)), 'invalid-proof')
  })

  it('message 7: rejects a Qhat that is not the committed one, or not a*Q + b*G', () => {
    const other = pointBytes(multiply(G, 12345n))
    expectAbort(deliver(6, at(6, M7.QHAT, other)), 'invalid-commitment')
    expectAbort(deliver(6, flipAt(6, M7.NONCE)), 'invalid-commitment')
    // A prover that committed to a wrong Qhat from the start (it does not
    // know the plaintext of c_key) opens it correctly and is still rejected.
    const state = cloneState(trace.before[6]!) as unknown as {
      peerHatCommit: Uint8Array
      binding: Uint8Array
      peerId: Uint8Array
    }
    const nonce = message(6).subarray(HEADER_BYTES + 33, HEADER_BYTES + 65)
    state.peerHatCommit = commit(
      'pdl-hat',
      state.binding,
      state.peerId,
      other,
      nonce,
    )
    expectAbort(
      keygenStep(state as unknown as KeygenSession, at(6, 0, other)),
      'invalid-proof',
    )
  })

  it('abortKeygen wipes a pending session', () => {
    const state = cloneState(trace.before[3]!)
    const secrets = state as unknown as Record<string, Uint8Array>
    abortKeygen(state)
    expect(secrets.share!.every(byte => byte === 0)).toBe(true)
    expect(keygenStep(state, message(3)).ok).toBe(false)
  })
})
