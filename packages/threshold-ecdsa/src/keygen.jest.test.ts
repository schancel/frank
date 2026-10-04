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
import { KEYGEN_BODY_BOUNDS } from './keygen.js'
import { ciphertextBytes, encrypt, parseModulus } from './paillier.js'
import { HEADER_BYTES } from './wire.js'
import {
  ascii,
  cloneState,
  drive,
  flip,
  fromHex,
  hex,
  must,
  recordedVectors,
  replace,
  type Trace,
} from './test-support.js'

const rng = (length: number): Uint8Array => new Uint8Array(randomBytes(length))
const recorded = recordedVectors()

// Body offsets, see the message table at the top of keygen.ts.
const BUNDLE = { N: 0, PROOF: 256, CKEY: 3072, RANGE: 3584 }
const M2 = { Q: 0, POK: 33, COM_E: 98, BUNDLE: 130 }
const M3 = {
  Q: 0,
  POK: 33,
  NONCE: 98,
  BUNDLE: 130,
  E: 44674,
  E_NONCE: 44679,
  PDL: 44711,
  PDL_COM: 45223,
}
const M4 = { HAT: 0, E: 32, E_NONCE: 37, PDL: 69, PDL_COM: 581, RANGE: 613 }
const M5 = { A: 0, B: 32, NONCE: 96, HAT: 128, RANGE: 160 }
const M6 = { QHAT: 0, NONCE: 33, A: 65, B: 97, PDL_NONCE: 161 }

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

function expectAbort(
  result: ReturnType<typeof keygenStep>,
  ...codes: string[]
) {
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(codes).toContain(result.error.code)
  expect(result.error.sessionAborted).toBe(true)
  expect(result.error.keyShareBurned).toBe(false)
}

function secretOf(share: KeyShare): bigint {
  return bytesToInt(
    (share as unknown as { secretShare: Uint8Array }).secretShare,
  )
}

const offCurve = (() => {
  const bytes = new Uint8Array(33)
  bytes[0] = 0x02
  bytes[32] = 5
  return bytes
})()

describe('two-party key generation', () => {
  it('gives both parties the same public key, address and key id', () => {
    const first = must(describeKeyShare(a))
    const second = must(describeKeyShare(b))
    expect(hex(first.publicKey)).toBe(hex(second.publicKey))
    expect(hex(first.keyId)).toBe(hex(second.keyId))
    expect(hex(first.address)).toBe(hex(second.address))
    expect(hex(first.localId)).toBe(hex(alice))
    expect(hex(first.peerId)).toBe(hex(bob))
    expect(first.burned).toBe(false)
    // The address is the standard EVM address of the joint key.
    expect(getAddress(`0x${hex(first.address)}`)).toBe(
      computeAddress(`0x${hex(first.publicKey)}`),
    )
  })

  it('shares are multiplicative, in [n/3, 2n/3), and neither equals the joint key', () => {
    const xa = secretOf(a)
    const xb = secretOf(b)
    for (const share of [xa, xb]) {
      expect(share >= SHARE_LOW && share < SHARE_HIGH).toBe(true)
    }
    const joint = (xa * xb) % CURVE_ORDER
    const info = must(describeKeyShare(a))
    expect(hex(pointBytes(multiply(G, joint)))).toBe(hex(info.publicKey))
    expect(hex(secp256k1.getPublicKey(intToBytes(joint, 32), true))).toBe(
      hex(info.publicKey),
    )
    expect(joint).not.toBe(xa)
    expect(joint).not.toBe(xb)
  })

  it('has seven messages of the documented, bounded sizes', () => {
    expect(trace.messages).toHaveLength(7)
    const sizes = trace.messages.map(bytes => bytes.length - HEADER_BYTES)
    expect(sizes[0]).toBe(64)
    expect(sizes[1]).toBe(44674)
    expect(sizes[2]).toBe(45255)
    expect(sizes[5]).toBe(193)
    expect(sizes[6]).toBe(65)
    sizes.forEach((size, index) => {
      const bounds = KEYGEN_BODY_BOUNDS[index + 1]!
      expect(size).toBeGreaterThanOrEqual(bounds.minBody)
      expect(size).toBeLessThanOrEqual(bounds.maxBody)
      expect(size + HEADER_BYTES).toBeLessThan(46000)
    })
  })

  it('wipes session secrets once finished and refuses further messages', () => {
    for (const session of [trace.initiatorSession, trace.responderSession]) {
      const state = session as unknown as Record<string, Uint8Array>
      for (const name of [
        'share',
        'primeP',
        'primeQ',
        'keyRandomness',
        'rangeSecret',
        'pdlAlpha',
        'seed',
      ]) {
        expect(state[name]!.every(byte => byte === 0)).toBe(true)
      }
      expect(keygenStep(session, message(0))).toEqual({
        ok: false,
        error: {
          code: 'session-finished',
          sessionAborted: false,
          keyShareBurned: false,
        },
      })
    }
  })

  it('exports and re-imports a share that still signs', () => {
    const digest = rng(32)
    const again = must(importKeyShare(must(exportKeyShare(a))))
    expect(must(describeKeyShare(again))).toEqual(must(describeKeyShare(a)))
    const signSession = rng(32)
    const signed = drive(
      startSign({
        keyShare: again,
        role: 'initiator',
        sessionId: signSession,
        digest,
        randomBytes: rng,
      }),
      startSign({
        keyShare: b,
        role: 'responder',
        sessionId: signSession,
        digest,
        randomBytes: rng,
      }),
      signStep,
    )
    const result = signed.responderResult
    if (result === null || result.kind !== 'signature')
      throw new Error('no signature')
    expect(
      secp256k1.verify(
        result.signature,
        digest,
        must(describeKeyShare(a)).publicKey,
        {
          prehash: false,
        },
      ),
    ).toBe(true)
  })

  it('rejects tampered or truncated share bytes', () => {
    const bytes = must(exportKeyShare(a))
    expect(bytes).toHaveLength(2003 - 8 + alice.length + bob.length)
    for (const index of [
      0,
      4,
      5,
      20,
      60,
      100,
      400,
      900,
      1500,
      bytes.length - 300,
      bytes.length - 100,
      bytes.length - 1,
    ]) {
      const result = importKeyShare(flip(bytes, index))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('invalid-key-share')
    }
    expect(importKeyShare(bytes.subarray(1)).ok).toBe(false)
    expect(importKeyShare(new Uint8Array([...bytes, 0])).ok).toBe(false)
    expect(importKeyShare('x' as unknown as Uint8Array).ok).toBe(false)
  })

  it('restores a share from the seed and the public record alone', () => {
    const record = must(exportKeyShareRecord(a))
    expect(record.length).toBe(1715 - 8 + alice.length + bob.length)
    const restored = must(
      restoreKeyShare({ secretSeed: initiatorSeed, record }),
    )
    expect(hex(must(exportKeyShare(restored)))).toBe(
      hex(must(exportKeyShare(a))),
    )
    // The record holds no secret: the wrong seed cannot rebuild the share.
    const wrong = restoreKeyShare({ secretSeed: responderSeed, record })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.error.code).toBe('invalid-key-share')
    expect(
      restoreKeyShare({ secretSeed: initiatorSeed, record: flip(record, 200) })
        .ok,
    ).toBe(false)
    expect(restoreKeyShare({ secretSeed: rng(31), record }).ok).toBe(false)
    const secret = hex(intToBytes(secretOf(a), 32))
    expect(hex(record)).not.toContain(secret)
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
      const result = startKeygen(input)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toEqual({
          code,
          sessionAborted: false,
          keyShareBurned: false,
        })
      }
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

describe('malicious counterpart: key generation', () => {
  it('rejects foreign, out-of-order and malformed frames without aborting', () => {
    for (let index = 0; index < 7; index += 1) {
      const state = cloneState(trace.before[index]!)
      const reject = (bytes: Uint8Array, code: string) => {
        expect(keygenStep(state, bytes)).toEqual({
          ok: false,
          error: { code, sessionAborted: false, keyShareBurned: false },
        })
      }
      // The same round of the recorded test-vector session.
      reject(fromHex(recorded.keygen.messages[index]!), 'wrong-session')
      reject(message((index + 2) % 7), 'unexpected-message')
      reject(message(index).subarray(0, HEADER_BYTES + 10), 'malformed-message')
      reject(flip(message(index), 1), 'malformed-message')
      reject(new Uint8Array(50_000), 'malformed-message')
      // A signing-protocol frame.
      reject(replace(message(index), 4, Uint8Array.of(2)), 'wrong-session')
    }
  })

  it('message 2: rejects a bad proof of knowledge, an invalid point, and a body replayed from another session', () => {
    expectAbort(
      deliver(1, flip(message(1), HEADER_BYTES + M2.POK + 40)),
      'invalid-proof',
    )
    expectAbort(deliver(1, at(1, M2.Q, offCurve)), 'invalid-point')
    expectAbort(deliver(1, at(1, M2.Q, new Uint8Array(33))), 'invalid-point')
    // Point of the other party's choosing with someone else's proof.
    expectAbort(
      deliver(1, at(1, M2.Q, pointBytes(multiply(G, 2n)))),
      'invalid-proof',
    )
    const foreign = fromHex(recorded.keygen.messages[1]!).subarray(HEADER_BYTES)
    expectAbort(deliver(1, at(1, 0, foreign)), 'invalid-proof')
  })

  it('message 2: rejects out-of-range Paillier values and a wrong modulus proof', () => {
    const body = message(1).subarray(HEADER_BYTES + M2.BUNDLE)
    const modulus = bytesToInt(body.subarray(BUNDLE.N, BUNDLE.N + 256))
    const bundle = (offset: number, patch: Uint8Array) =>
      deliver(1, at(1, M2.BUNDLE + offset, patch))
    // Even, too short, small prime factor: rejected before anything else.
    expectAbort(
      bundle(BUNDLE.N, intToBytes(modulus + 1n, 256)),
      'invalid-paillier',
    )
    expectAbort(
      bundle(BUNDLE.N, intToBytes(modulus >> 1n, 256)),
      'invalid-paillier',
    )
    let smooth = (modulus / 3n) * 3n
    if ((smooth & 1n) === 0n) smooth -= 3n
    expectAbort(bundle(BUNDLE.N, intToBytes(smooth, 256)), 'invalid-paillier')
    // A different well-formed modulus: the proof no longer verifies.
    expectAbort(
      bundle(BUNDLE.N, intToBytes(modulus + 2n, 256)),
      'invalid-proof',
      'invalid-paillier',
    )
    expectAbort(bundle(BUNDLE.PROOF + 10, Uint8Array.of(0xaa)), 'invalid-proof')
    expectAbort(bundle(BUNDLE.PROOF, new Uint8Array(256)), 'invalid-paillier')
    // Encrypted share: zero, N^2, and above N^2.
    expectAbort(bundle(BUNDLE.CKEY, new Uint8Array(512)), 'invalid-paillier')
    expectAbort(
      bundle(BUNDLE.CKEY, intToBytes(modulus * modulus, 512)),
      'invalid-paillier',
    )
    expectAbort(
      bundle(BUNDLE.CKEY, new Uint8Array(512).fill(0xff)),
      'invalid-paillier',
    )
    // A range commitment that is not a ciphertext.
    expectAbort(
      bundle(BUNDLE.RANGE + 512 * 7, new Uint8Array(512)),
      'invalid-paillier',
    )
  })

  it('message 3: rejects an opening that does not match message 1, and bad bundles', () => {
    expectAbort(
      deliver(2, flip(message(2), HEADER_BYTES + M3.NONCE)),
      'invalid-commitment',
    )
    expectAbort(
      deliver(2, at(2, M3.Q, pointBytes(multiply(G, 3n)))),
      'invalid-commitment',
    )
    expectAbort(
      deliver(2, flip(message(2), HEADER_BYTES + M3.POK + 50)),
      'invalid-commitment',
    )
    expectAbort(
      deliver(2, flip(message(2), HEADER_BYTES + M3.BUNDLE + BUNDLE.PROOF + 5)),
      'invalid-proof',
    )
    expectAbort(
      deliver(2, at(2, M3.BUNDLE + BUNDLE.CKEY, new Uint8Array(512))),
      'invalid-paillier',
    )
    // The range challenge must be the one committed in message 1.
    expectAbort(
      deliver(2, flip(message(2), HEADER_BYTES + M3.E)),
      'invalid-commitment',
    )
    expectAbort(
      deliver(2, flip(message(2), HEADER_BYTES + M3.E_NONCE)),
      'invalid-commitment',
    )
    expectAbort(
      deliver(2, at(2, M3.PDL, new Uint8Array(512))),
      'invalid-paillier',
    )
  })

  it('message 3: a valid opening of a share with a bad proof of knowledge is still rejected', () => {
    const state = cloneState(trace.before[2]!) as unknown as {
      peerPointCommit: Uint8Array
      session: Uint8Array
      peerId: Uint8Array
    }
    const body = message(2).subarray(HEADER_BYTES)
    const payload = flip(body.subarray(0, 98), 97)
    state.peerPointCommit = commit(
      'keygen-point',
      state.session,
      state.peerId,
      payload,
      body.subarray(98, 130),
    )
    expectAbort(
      keygenStep(state as unknown as KeygenSession, at(2, 0, payload)),
      'invalid-proof',
    )
  })

  it('message 4: rejects a wrong challenge opening and a wrong range response, and wipes the session', () => {
    expectAbort(
      deliver(3, flip(message(3), HEADER_BYTES + M4.E)),
      'invalid-commitment',
    )
    const state = cloneState(trace.before[3]!)
    const secrets = state as unknown as Record<string, Uint8Array>
    expect(secrets.share!.some(byte => byte !== 0)).toBe(true)
    const tampered = keygenStep(
      state,
      flip(message(3), HEADER_BYTES + M4.RANGE + 20),
    )
    expectAbort(tampered, 'invalid-proof')
    for (const name of [
      'share',
      'primeP',
      'primeQ',
      'keyRandomness',
      'rangeSecret',
      'pdlA',
      'pdlB',
      'seed',
    ]) {
      expect(secrets[name]!.every(byte => byte === 0)).toBe(true)
    }
    expect(keygenStep(state, message(3))).toEqual({
      ok: false,
      error: {
        code: 'session-aborted',
        sessionAborted: false,
        keyShareBurned: false,
      },
    })
    // Response cut short by one round.
    expectAbort(
      deliver(3, message(3).subarray(0, message(3).length - 289)),
      'malformed-message',
      'invalid-proof',
    )
  })

  it('an encrypted share outside [0, n) is caught by the range proof', () => {
    // The responder sends c_key encrypting x + n instead of x (it would make
    // the initiator's later decryptions wrap around). The modulus proof and
    // the layout are fine, so message 2 is accepted; the responder's range
    // response, honest for the real share, cannot verify against it.
    const body = message(1).subarray(HEADER_BYTES + M2.BUNDLE)
    const key = parseModulus(body.slice(BUNDLE.N, BUNDLE.N + 256))
    const lying = ciphertextBytes(encrypt(key, secretOf(b) + CURVE_ORDER, 17n))
    const accepted = deliver(1, at(1, M2.BUNDLE + BUNDLE.CKEY, lying))
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) return
    expectAbort(keygenStep(accepted.value.session, message(3)), 'invalid-proof')
  })

  it('message 5: rejects a wrong opening of the challenge (a, b)', () => {
    expectAbort(
      deliver(4, flip(message(4), HEADER_BYTES + M5.A + 5)),
      'invalid-commitment',
    )
    expectAbort(
      deliver(4, flip(message(4), HEADER_BYTES + M5.B + 5)),
      'invalid-commitment',
    )
    expectAbort(
      deliver(4, flip(message(4), HEADER_BYTES + M5.NONCE)),
      'invalid-commitment',
    )
    expectAbort(
      deliver(4, flip(message(4), HEADER_BYTES + M5.RANGE + 3)),
      'invalid-proof',
    )
  })

  it('message 5: a challenge ciphertext that is not a*c_key + b makes the prover abort without revealing Qhat', () => {
    // The initiator replaces c' by an encryption of an unrelated value under
    // the responder's key. The responder decrypts it and commits; when the
    // initiator later opens (a, b), the decryption does not equal a*x + b.
    const body = message(1).subarray(HEADER_BYTES + M2.BUNDLE)
    const key = parseModulus(body.slice(BUNDLE.N, BUNDLE.N + 256))
    const probe = ciphertextBytes(encrypt(key, 123456789n, 19n))
    const accepted = deliver(2, at(2, M3.PDL, probe))
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) return
    expect(accepted.value.outgoing).not.toBeNull()
    const rejected = keygenStep(accepted.value.session, message(4))
    expectAbort(rejected, 'invalid-proof')
  })

  it('messages 6 and 7: reject a Qhat that is not the committed one, or not a*Q + b*G', () => {
    const other = pointBytes(multiply(G, 12345n))
    expectAbort(deliver(5, at(5, M6.QHAT, other)), 'invalid-commitment')
    expectAbort(
      deliver(5, flip(message(5), HEADER_BYTES + M6.NONCE)),
      'invalid-commitment',
    )
    expectAbort(
      deliver(5, flip(message(5), HEADER_BYTES + M6.A + 9)),
      'invalid-commitment',
    )
    expectAbort(deliver(6, at(6, 0, other)), 'invalid-commitment')
    expectAbort(
      deliver(6, flip(message(6), HEADER_BYTES + 40)),
      'invalid-commitment',
    )
    // A prover that committed to a wrong Qhat from the start (it does not
    // know the plaintext of c_key) opens it correctly and is still rejected.
    for (const index of [5, 6]) {
      const state = cloneState(trace.before[index]!) as unknown as {
        peerHatCommit: Uint8Array
        session: Uint8Array
        peerId: Uint8Array
      }
      const nonce = message(index).subarray(
        HEADER_BYTES + 33,
        HEADER_BYTES + 65,
      )
      state.peerHatCommit = commit(
        'pdl-hat',
        state.session,
        state.peerId,
        other,
        nonce,
      )
      expectAbort(
        keygenStep(state as unknown as KeygenSession, at(index, 0, other)),
        'invalid-proof',
      )
    }
  })

  it('abortKeygen wipes a pending session', () => {
    const state = cloneState(trace.before[3]!)
    const secrets = state as unknown as Record<string, Uint8Array>
    abortKeygen(state)
    expect(secrets.share!.every(byte => byte === 0)).toBe(true)
    expect(keygenStep(state, message(3)).ok).toBe(false)
  })
})
