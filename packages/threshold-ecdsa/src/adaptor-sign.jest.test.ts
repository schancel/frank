import {
  completeAdaptorSignature,
  extractAdaptorSecret,
  generateAdaptorSecret,
  verifyAdaptorSignature,
} from '@frank/adaptor-signatures'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { getAddress, Signature, Transaction } from 'ethers'
import { randomBytes } from 'crypto'

import {
  commitmentLockPoint,
  completeCommitmentLock,
  createCommitmentLock,
  createPointLock,
  describeKeyShare,
  extractCommitmentLockSecret,
  importKeyShare,
  recoveryBit,
  signStep,
  startSign,
  tweakPublicKey,
  type AdaptorLock,
  type KeyShare,
  type SignResult,
  type SignSession,
} from './index.js'
import { bytesToInt, intToBytes } from './bytes.js'
import { CURVE_ORDER, G, multiply, pointBytes } from './group.js'
import { forgetBurnedSharesForTests } from './key-share.js'
import { PEDERSEN_H } from './lock.js'
import { ciphertextBytes, encrypt, paillierPublicKey } from './paillier.js'
import { HEADER_BYTES } from './wire.js'
import {
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

const recorded = recordedVectors()
const rng = (length: number): Uint8Array => new Uint8Array(randomBytes(length))

afterEach(() => {
  forgetBurnedSharesForTests()
})

function shares(): { a: KeyShare; b: KeyShare } {
  return {
    a: must(importKeyShare(fromHex(recorded.keygen.initiatorShare))),
    b: must(importKeyShare(fromHex(recorded.keygen.responderShare))),
  }
}

function presign(
  a: KeyShare,
  b: KeyShare,
  lock: AdaptorLock,
  digest: Uint8Array,
  tweakCommitment?: Uint8Array,
): Trace<SignSession, SignResult> {
  const common = {
    sessionId: rng(32),
    digest,
    tweakCommitment,
    lock,
    randomBytes: rng,
  }
  return drive(
    startSign({ ...common, keyShare: a }),
    startSign({ ...common, keyShare: b }),
    signStep,
  )
}

function adaptorResult(result: SignResult | null) {
  if (result === null || result.kind !== 'adaptor-signature') {
    throw new Error('no adaptor signature')
  }
  return result
}

function message(
  trace: Trace<SignSession, SignResult>,
  index: number,
): Uint8Array {
  const bytes = trace.messages[index]
  if (bytes === undefined) throw new Error('no such message')
  return bytes
}

function deliver(
  trace: Trace<SignSession, SignResult>,
  index: number,
  bytes: Uint8Array,
) {
  return signStep(cloneState(trace.before[index]!), bytes)
}

describe('point locks', () => {
  it('pre-signs in the format of @frank/adaptor-signatures: verify, complete, extract', () => {
    const { a, b } = shares()
    const made = must(createPointLock({ keyShare: b, randomBytes: rng }))
    const digest = rng(32)
    const trace = presign(a, b, made.lock, digest)
    const first = adaptorResult(trace.initiatorResult)
    expect(adaptorResult(trace.responderResult)).toEqual(first)
    expect(first.adaptorSignature).toHaveLength(162)
    expect(hex(first.publicKey)).toBe(recorded.keygen.publicKey)
    const common = {
      publicKey: first.publicKey,
      adaptorPoint: made.lock.point,
      adaptorProof: made.lock.proof,
      digest,
      signature: first.adaptorSignature,
    }
    // The existing single-signer verifier accepts it, for this point only.
    expect(verifyAdaptorSignature(common)).toEqual({ ok: true, value: true })
    const other = must(generateAdaptorSecret(rng))
    expect(
      verifyAdaptorSignature({
        ...common,
        adaptorPoint: other.point,
        adaptorProof: other.proof,
      }),
    ).toEqual({ ok: true, value: false })
    expect(verifyAdaptorSignature({ ...common, digest: rng(32) })).toEqual({
      ok: true,
      value: false,
    })
    // The pre-signature is not itself a signature.
    const asIfComplete = new Uint8Array([
      ...intToBytes(
        secp256k1.ProjectivePoint.fromHex(
          first.adaptorSignature.subarray(0, 33),
        ).toAffine().x,
        32,
      ),
      ...first.adaptorSignature.subarray(66, 98),
    ])
    expect(
      secp256k1.verify(asIfComplete, digest, first.publicKey, {
        prehash: false,
        lowS: false,
      }),
    ).toBe(false)
    // The responder, who knows the secret, completes it.
    const completed = must(
      completeAdaptorSignature({ ...common, secret: made.secret }),
    )
    expect(
      secp256k1.verify(completed, digest, first.publicKey, {
        prehash: false,
        lowS: true,
      }),
    ).toBe(true)
    // The initiator extracts the secret from the completed signature.
    const extracted = must(
      extractAdaptorSecret({ ...common, completedSignature: completed }),
    )
    expect(hex(extracted)).toBe(hex(made.secret))
    expect(
      completeAdaptorSignature({ ...common, secret: other.secret }).ok,
    ).toBe(false)
  })

  it('completes into an EIP-1559 transaction signature for the tweaked joint address', () => {
    const { a, b } = shares()
    const commitment = rng(32)
    const tweaked = must(
      tweakPublicKey(fromHex(recorded.keygen.publicKey), commitment),
    )
    const address = getAddress(`0x${hex(tweaked.address)}`)
    const made = must(createPointLock({ keyShare: b, randomBytes: rng }))
    const transaction = Transaction.from({
      type: 2,
      chainId: 10143n,
      nonce: 3,
      to: '0x000000000000000000000000000000000000dEaD',
      value: 5n,
      gasLimit: 21000n,
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 2n,
    })
    const digest = fromHex(transaction.unsignedHash.slice(2))
    const result = adaptorResult(
      presign(a, b, made.lock, digest, commitment).responderResult,
    )
    expect(hex(result.publicKey)).toBe(hex(tweaked.publicKey))
    const completed = must(
      completeAdaptorSignature({
        publicKey: result.publicKey,
        adaptorPoint: made.lock.point,
        adaptorProof: made.lock.proof,
        digest,
        signature: result.adaptorSignature,
        secret: made.secret,
      }),
    )
    const yParity = recoveryBit(result.publicKey, digest, completed)
    expect(yParity).not.toBeNull()
    transaction.signature = Signature.from({
      r: `0x${hex(completed.subarray(0, 32))}`,
      s: `0x${hex(completed.subarray(32))}`,
      yParity: yParity!,
    })
    expect(Transaction.from(transaction.serialized).from).toBe(address)
    expect(recoveryBit(result.publicKey, rng(32), completed)).toBeNull()
  })

  it('only the responder can create locks, and a lock is bound to its key and owner', () => {
    const { a, b } = shares()
    expect(createPointLock({ keyShare: a, randomBytes: rng })).toEqual(
      frameError('invalid-input'),
    )
    expect(
      createCommitmentLock({ keyShare: a, value: 1, randomBytes: rng }),
    ).toEqual(frameError('invalid-input'))
    const made = must(createPointLock({ keyShare: b, randomBytes: rng }))
    const start = (lock: AdaptorLock) =>
      startSign({
        keyShare: a,
        sessionId: rng(32),
        digest: rng(32),
        lock,
        randomBytes: rng,
      })
    expect(start(made.lock).ok).toBe(true)
    // A (T, proof) pair seen elsewhere: its adaptor-signatures proof verifies
    // (that proof is not bound to anything), but without t nobody can produce
    // the owner proof for this key.
    const stolen = must(generateAdaptorSecret(rng))
    expect(
      start({ ...made.lock, point: stolen.point, proof: stolen.proof }),
    ).toEqual(frameError('invalid-proof'))
    expect(
      start({ ...made.lock, ownerProof: flip(made.lock.ownerProof, 50) }),
    ).toEqual(frameError('invalid-proof'))
    expect(
      start({
        ...made.lock,
        proof: flip(made.lock.proof, 40) as typeof made.lock.proof,
      }),
    ).toEqual(frameError('invalid-proof'))
    // An owner proof made under a tweak of the key id (another key) fails.
    const otherKey = cloneState(b) as unknown as { keyId: Uint8Array }
    otherKey.keyId = flip(otherKey.keyId, 0)
    const foreign = must(
      createPointLock({
        keyShare: otherKey as unknown as KeyShare,
        randomBytes: rng,
      }),
    )
    expect(start(foreign.lock)).toEqual(frameError('invalid-proof'))
    expect(start({ kind: 'bare', point: stolen.point } as never)).toEqual(
      frameError('invalid-input'),
    )
  })

  it('treats a different lock, or plain versus adaptor, as a different session', () => {
    const { a, b } = shares()
    const sessionId = rng(32)
    const digest = rng(32)
    const one = must(createPointLock({ keyShare: b, randomBytes: rng }))
    const two = must(createPointLock({ keyShare: b, randomBytes: rng }))
    const initiator = must(
      startSign({
        keyShare: a,
        sessionId,
        digest,
        lock: one.lock,
        randomBytes: rng,
      }),
    )
    for (const lock of [two.lock, undefined]) {
      const responder = must(
        startSign({ keyShare: b, sessionId, digest, lock, randomBytes: rng }),
      )
      expect(signStep(responder.session, initiator.outgoing!)).toEqual(
        frameError('wrong-session'),
      )
    }
  })
})

describe('commitment locks', () => {
  it('derives H from a hash with no known discrete log relation', () => {
    expect(hex(PEDERSEN_H.toRawBytes(true))).toBe(
      '0227760f010449dd266567f5a439f620e8211c89ba01dbcaf43a31f76c8de02e43',
    )
    expect(PEDERSEN_H.equals(G)).toBe(false)
  })

  it('lets the holder complete exactly the pre-signature for the committed value, revealing its secret', () => {
    const { a, b } = shares()
    const value = 37
    const made = must(
      createCommitmentLock({ keyShare: b, value, randomBytes: rng }),
    )
    // C = s*G + v*H, and the lock point of the committed value is s*G.
    const s = bytesToInt(made.secret)
    expect(hex(made.commitment)).toBe(
      hex(pointBytes(multiply(G, s).add(multiply(PEDERSEN_H, BigInt(value))))),
    )
    expect(hex(must(commitmentLockPoint(made.commitment, value)))).toBe(
      hex(pointBytes(multiply(G, s))),
    )
    const publicKey = fromHex(recorded.keygen.publicKey)
    // One pre-signed "transaction" per candidate value.
    const candidates = [36, 37, 38, 0]
    const signed = candidates.map(index => {
      const digest = rng(32)
      const trace = presign(
        a,
        b,
        {
          kind: 'commitment',
          commitment: made.commitment,
          proof: made.proof,
          index,
        },
        digest,
      )
      const result = adaptorResult(trace.initiatorResult)
      expect(adaptorResult(trace.responderResult)).toEqual(result)
      return { index, digest, adaptorSignature: result.adaptorSignature }
    })
    for (const entry of signed) {
      const common = {
        publicKey,
        commitment: made.commitment,
        index: entry.index,
        digest: entry.digest,
        adaptorSignature: entry.adaptorSignature,
      }
      const completed = completeCommitmentLock({
        ...common,
        secret: made.secret,
      })
      if (entry.index !== value) {
        // The holder's secret does not open any other candidate.
        expect(completed).toEqual(frameError('invalid-input'))
        continue
      }
      const done = must(completed)
      expect(
        secp256k1.verify(done.signature, entry.digest, publicKey, {
          prehash: false,
          lowS: true,
        }),
      ).toBe(true)
      expect(recoveryBit(publicKey, entry.digest, done.signature)).toBe(
        done.recovery,
      )
      // The initiator extracts s from the completed signature...
      const extracted = must(
        extractCommitmentLockSecret({
          ...common,
          completedSignature: done.signature,
        }),
      )
      expect(hex(extracted)).toBe(hex(made.secret))
      // ...and extraction is refused for a pre-signature of another candidate.
      const wrong = signed[0]!
      expect(
        extractCommitmentLockSecret({
          ...common,
          index: wrong.index,
          adaptorSignature: wrong.adaptorSignature,
          completedSignature: done.signature,
        }).ok,
      ).toBe(false)
    }
  })

  it('completing any other candidate needs a discrete log that the holder does not have', () => {
    // For index i != v the lock point is s*G + (v - i)*H. Decrypting the
    // pre-signature with ANY scalar the holder can compute from (s, v) gives
    // a signature that does not verify; the right scalar is
    // s + (v - i)*log_G(H).
    const { a, b } = shares()
    const made = must(
      createCommitmentLock({ keyShare: b, value: 5, randomBytes: rng }),
    )
    const digest = rng(32)
    const index = 6
    const result = adaptorResult(
      presign(
        a,
        b,
        {
          kind: 'commitment',
          commitment: made.commitment,
          proof: made.proof,
          index,
        },
        digest,
      ).initiatorResult,
    )
    const publicKey = fromHex(recorded.keygen.publicKey)
    const s = bytesToInt(made.secret)
    const sa = bytesToInt(result.adaptorSignature.subarray(66, 98))
    const r = intToBytes(
      secp256k1.ProjectivePoint.fromHex(
        result.adaptorSignature.subarray(0, 33),
      ).toAffine().x,
      32,
    )
    const inverse = (x: bigint): bigint => {
      let [r0, r1, t0, t1] = [CURVE_ORDER, x % CURVE_ORDER, 0n, 1n]
      while (r1 !== 0n) {
        const q = r0 / r1
        ;[r0, r1] = [r1, r0 - q * r1]
        ;[t0, t1] = [t1, t0 - q * t1]
      }
      return ((t0 % CURVE_ORDER) + CURVE_ORDER) % CURVE_ORDER
    }
    for (const guess of [s, s + 1n, s - 1n, (s * 5n) % CURVE_ORDER, 1n]) {
      const candidate = (sa * inverse(guess)) % CURVE_ORDER
      for (const sValue of [candidate, CURVE_ORDER - candidate]) {
        expect(
          secp256k1.verify(
            new Uint8Array([...r, ...intToBytes(sValue, 32)]),
            digest,
            publicKey,
            { prehash: false, lowS: false },
          ),
        ).toBe(false)
      }
    }
    // The pre-signature itself is valid for the lock point C - 6*H.
    expect(
      completeCommitmentLock({
        publicKey,
        commitment: made.commitment,
        index,
        digest,
        adaptorSignature: result.adaptorSignature,
        secret: made.secret,
      }),
    ).toEqual(frameError('invalid-input'))
  })

  it('rejects a commitment without a valid opening proof before any session exists', () => {
    const { a, b } = shares()
    const made = must(
      createCommitmentLock({ keyShare: b, value: 9, randomBytes: rng }),
    )
    const start = (keyShare: KeyShare, lock: AdaptorLock) =>
      startSign({
        keyShare,
        sessionId: rng(32),
        digest: rng(32),
        lock,
        randomBytes: rng,
      })
    const good: AdaptorLock = {
      kind: 'commitment',
      commitment: made.commitment,
      proof: made.proof,
      index: 9,
    }
    expect(start(a, good).ok).toBe(true)
    // A commitment of unknown opening (here: someone else's point).
    const foreign = pointBytes(multiply(PEDERSEN_H, 12345n))
    for (const keyShare of [a, b]) {
      expect(start(keyShare, { ...good, commitment: foreign })).toEqual(
        frameError('invalid-proof'),
      )
      for (const offset of [5, 40, 70]) {
        const rejected = start(keyShare, {
          ...good,
          proof: flip(made.proof, offset),
        })
        expect(rejected.ok).toBe(false)
        if (!rejected.ok) {
          expect(['invalid-proof', 'invalid-point']).toContain(
            rejected.error.code,
          )
        }
      }
      expect(
        start(keyShare, { ...good, proof: made.proof.subarray(1) }),
      ).toEqual(frameError('invalid-input'))
      for (const index of [-1, 1.5, 2 ** 32, Number.NaN]) {
        expect(start(keyShare, { ...good, index })).toEqual(
          frameError('invalid-input'),
        )
      }
    }
    // The proof is bound to the key: the same commitment and proof are
    // refused for a different key id.
    const otherKey = cloneState(a) as unknown as { keyId: Uint8Array }
    otherKey.keyId = flip(otherKey.keyId, 3)
    expect(start(otherKey as unknown as KeyShare, good)).toEqual(
      frameError('invalid-proof'),
    )
    expect(
      createCommitmentLock({ keyShare: b, value: -1, randomBytes: rng }),
    ).toEqual(frameError('invalid-input'))
  })

  it('binds the commitment and the index into the session', () => {
    const { a, b } = shares()
    const made = must(
      createCommitmentLock({ keyShare: b, value: 2, randomBytes: rng }),
    )
    const sessionId = rng(32)
    const digest = rng(32)
    const lock = (index: number): AdaptorLock => ({
      kind: 'commitment',
      commitment: made.commitment,
      proof: made.proof,
      index,
    })
    const initiator = must(
      startSign({
        keyShare: a,
        sessionId,
        digest,
        lock: lock(2),
        randomBytes: rng,
      }),
    )
    const responder = must(
      startSign({
        keyShare: b,
        sessionId,
        digest,
        lock: lock(3),
        randomBytes: rng,
      }),
    )
    expect(signStep(responder.session, initiator.outgoing!)).toEqual(
      frameError('wrong-session'),
    )
  })
})

describe('malicious counterpart: adaptor pre-signing', () => {
  const { a, b } = shares()
  const made = must(createPointLock({ keyShare: b, randomBytes: rng }))
  const digest = rng(32)
  const trace = presign(a, b, made.lock, digest)
  // Body layout of messages 2 and 3: R(33) RT(33) dleq(64) A(33) AT(33).
  const OFFSET = { R: 0, RT: 33, DLEQ: 66, A: 130, AT: 163 }

  it('has the documented message sizes', () => {
    expect(trace.messages.map(bytes => bytes.length)).toEqual([
      70, 234, 266, 582, 200,
    ])
  })

  it('message 2: rejects a nonce share whose two halves have different discrete logs', () => {
    const other = presign(a, b, made.lock, digest)
    // R2T taken from another session: a valid point, wrong discrete log.
    const mixed = replace(
      message(trace, 1),
      HEADER_BYTES + OFFSET.RT,
      message(other, 1).subarray(
        HEADER_BYTES + OFFSET.RT,
        HEADER_BYTES + OFFSET.DLEQ,
      ),
    )
    expect(deliver(trace, 1, mixed)).toEqual(peerAbort('invalid-proof'))
    expect(
      deliver(
        trace,
        1,
        flip(message(trace, 1), HEADER_BYTES + OFFSET.DLEQ + 5),
      ),
    ).toEqual(peerAbort('invalid-proof'))
    // The whole share replayed from another session of the same lock.
    const replayed = replace(
      message(trace, 1),
      HEADER_BYTES,
      message(other, 1).subarray(HEADER_BYTES),
    )
    expect(deliver(trace, 1, replayed)).toEqual(peerAbort('invalid-proof'))
    const offCurve = new Uint8Array(33)
    offCurve[0] = 0x03
    offCurve[32] = 5
    for (const offset of [OFFSET.R, OFFSET.RT, OFFSET.A, OFFSET.AT]) {
      expect(
        deliver(
          trace,
          1,
          replace(message(trace, 1), HEADER_BYTES + offset, offCurve),
        ),
      ).toEqual(peerAbort('invalid-point'))
    }
  })

  it('message 3: rejects anything but the committed share', () => {
    for (const offset of [
      OFFSET.R,
      OFFSET.RT,
      OFFSET.DLEQ,
      OFFSET.A,
      OFFSET.AT,
    ]) {
      const rejected = deliver(
        trace,
        2,
        flip(message(trace, 2), HEADER_BYTES + offset + 20),
      )
      expect(rejected).toEqual(peerAbort('invalid-commitment'))
    }
  })

  it('message 4: a wrong proof response is rejected before anything is decrypted', () => {
    const fresh = shares()
    const local = presign(fresh.a, fresh.b, made.lock, digest)
    const body = message(local, 3)
    const z = bytesToInt(body.subarray(HEADER_BYTES + 512))
    for (const bad of [
      intToBytes((z + 1n) % CURVE_ORDER, 32),
      intToBytes(0n, 32),
      intToBytes(CURVE_ORDER, 32),
    ]) {
      const rejected = deliver(local, 3, replace(body, HEADER_BYTES + 512, bad))
      expect(rejected.ok).toBe(false)
      if (!rejected.ok) {
        expect(['invalid-proof', 'out-of-range']).toContain(rejected.error.code)
        expect(rejected.error.keyShareBurned).toBe(false)
        expect(rejected.error.peerFault).toBe(true)
      }
    }
    expect(must(describeKeyShare(fresh.a)).burned).toBe(false)
  })

  it('message 4: a well-formed ciphertext of a wrong value burns the key share', () => {
    const fresh = shares()
    const local = presign(fresh.a, fresh.b, made.lock, digest)
    const modulus = bytesToInt(
      (fresh.a as unknown as { modulus: Uint8Array }).modulus,
    )
    const probe = ciphertextBytes(encrypt(paillierPublicKey(modulus), 99n, 5n))
    expect(
      deliver(local, 3, replace(message(local, 3), HEADER_BYTES, probe)),
    ).toEqual(peerAbort('invalid-signature', true))
    expect(must(describeKeyShare(fresh.a)).burned).toBe(true)
  })

  it('message 5: the responder accepts only the pre-signature for the agreed nonce', () => {
    const good = message(trace, 4)
    const other = presign(a, b, made.lock, digest)
    // A valid pre-signature for the same key, lock and digest but another
    // nonce (as if replayed from another session).
    const replayed = replace(
      good,
      HEADER_BYTES,
      message(other, 4).subarray(HEADER_BYTES),
    )
    for (const bad of [
      replayed,
      flip(good, HEADER_BYTES + 70), // s_a
      flip(good, HEADER_BYTES + 110), // proof challenge
      flip(good, HEADER_BYTES + 150), // proof response
    ]) {
      expect(deliver(trace, 4, bad)).toEqual(peerAbort('invalid-signature'))
    }
  })

  it('before message 5 the responder holds neither a pre-signature nor a live nonce', () => {
    // After message 4 only the initiator holds the pre-signature. The
    // responder (the secret holder) has the joint nonce points and a wiped
    // nonce share, so an initiator that withholds message 5 leaves it
    // nothing to complete, and the initiator cannot complete it either.
    const state = cloneState(trace.before[4]!) as unknown as Record<
      string,
      unknown
    >
    expect(state.jointNonce).toHaveLength(66)
    const nonce = state.nonce as Uint8Array
    expect(nonce.every(byte => byte === 0)).toBe(true)
  })
})
