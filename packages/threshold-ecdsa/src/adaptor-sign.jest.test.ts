import {
  completeAdaptorSignature,
  extractAdaptorSecret,
  generateAdaptorSecret,
  verifyAdaptorSignature,
  type AdaptorSecretMaterial,
  type AdaptorSecretProof,
} from '@frank/adaptor-signatures'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { getAddress, Signature, Transaction } from 'ethers'
import { randomBytes } from 'crypto'

import {
  describeKeyShare,
  importKeyShare,
  signStep,
  startSign,
  tweakPublicKey,
  type KeyShare,
  type SignResult,
  type SignSession,
} from './index.js'
import { bytesToInt, intToBytes } from './bytes.js'
import { CURVE_ORDER } from './group.js'
import { ciphertextBytes, encrypt, paillierPublicKey } from './paillier.js'
import { HEADER_BYTES } from './wire.js'
import {
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

const recorded = recordedVectors()
const rng = (length: number): Uint8Array => new Uint8Array(randomBytes(length))

function shares(): { a: KeyShare; b: KeyShare } {
  return {
    a: must(importKeyShare(fromHex(recorded.keygen.initiatorShare))),
    b: must(importKeyShare(fromHex(recorded.keygen.responderShare))),
  }
}

function presign(
  initiator: KeyShare,
  responder: KeyShare,
  material: AdaptorSecretMaterial,
  digest: Uint8Array,
  tweakCommitment?: Uint8Array,
): Trace<SignSession, SignResult> {
  const common = {
    sessionId: rng(32),
    digest,
    tweakCommitment,
    adaptor: { point: material.point, proof: material.proof },
    randomBytes: rng,
  }
  return drive(
    startSign({ ...common, keyShare: initiator, role: 'initiator' }),
    startSign({ ...common, keyShare: responder, role: 'responder' }),
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

const INVALID_PROOF = {
  ok: false,
  error: { code: 'invalid-proof', sessionAborted: true, keyShareBurned: false },
}

describe('two-party adaptor pre-signing', () => {
  it('is byte-compatible with @frank/adaptor-signatures: verify, complete, extract', () => {
    const { a, b } = shares()
    for (const [initiator, responder] of [
      [a, b],
      [b, a],
    ] as const) {
      const material = must(generateAdaptorSecret(rng))
      const digest = rng(32)
      const trace = presign(initiator, responder, material, digest)
      const first = adaptorResult(trace.initiatorResult)
      const second = adaptorResult(trace.responderResult)
      expect(second).toEqual(first)
      expect(first.adaptorSignature).toHaveLength(162)
      expect(hex(first.publicKey)).toBe(recorded.keygen.publicKey)
      const common = {
        publicKey: first.publicKey,
        adaptorPoint: material.point,
        adaptorProof: material.proof,
        digest,
        signature: first.adaptorSignature,
      }
      // The existing single-signer verifier accepts it, for this point only.
      expect(verifyAdaptorSignature(common)).toEqual({ ok: true, value: true })
      const otherPoint = must(generateAdaptorSecret(rng))
      expect(
        verifyAdaptorSignature({
          ...common,
          adaptorPoint: otherPoint.point,
          adaptorProof: otherPoint.proof,
        }),
      ).toEqual({ ok: true, value: false })
      expect(verifyAdaptorSignature({ ...common, digest: rng(32) })).toEqual({
        ok: true,
        value: false,
      })
      // The pre-signature is not itself a signature.
      expect(
        secp256k1.verify(
          new Uint8Array([
            ...intToBytes(
              secp256k1.ProjectivePoint.fromHex(
                first.adaptorSignature.subarray(0, 33),
              ).toAffine().x,
              32,
            ),
            ...first.adaptorSignature.subarray(66, 98),
          ]),
          digest,
          first.publicKey,
          { prehash: false, lowS: false },
        ),
      ).toBe(false)
      // Whoever knows the secret completes it into an ordinary signature.
      const completed = must(
        completeAdaptorSignature({ ...common, secret: material.secret }),
      )
      expect(
        secp256k1.verify(completed, digest, first.publicKey, {
          prehash: false,
          lowS: true,
        }),
      ).toBe(true)
      // The other party extracts the secret from the completed signature.
      const extracted = must(
        extractAdaptorSecret({ ...common, completedSignature: completed }),
      )
      expect(hex(extracted)).toBe(hex(material.secret))
      // A wrong secret cannot complete it.
      const wrong = completeAdaptorSignature({
        ...common,
        secret: otherPoint.secret,
      })
      expect(wrong.ok).toBe(false)
    }
  })

  it('completes into an EIP-1559 transaction signature for the tweaked joint address', () => {
    const { a, b } = shares()
    const commitment = rng(32)
    const tweaked = must(
      tweakPublicKey(fromHex(recorded.keygen.publicKey), commitment),
    )
    const address = getAddress(`0x${hex(tweaked.address)}`)
    const material = must(generateAdaptorSecret(rng))
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
      presign(b, a, material, digest, commitment).responderResult,
    )
    expect(hex(result.publicKey)).toBe(hex(tweaked.publicKey))
    const completed = must(
      completeAdaptorSignature({
        publicKey: result.publicKey,
        adaptorPoint: material.point,
        adaptorProof: material.proof,
        digest,
        signature: result.adaptorSignature,
        secret: material.secret,
      }),
    )
    // The completed signature has no recovery bit; exactly one parity
    // recovers the escrow address.
    const recovered = [0, 1].filter(yParity => {
      const candidate = Transaction.from(transaction.unsignedSerialized)
      candidate.signature = Signature.from({
        r: `0x${hex(completed.subarray(0, 32))}`,
        s: `0x${hex(completed.subarray(32))}`,
        yParity: yParity as 0 | 1,
      })
      return Transaction.from(candidate.serialized).from === address
    })
    expect(recovered).toHaveLength(1)
  })

  it('requires a valid proof of knowledge for the adaptor point', () => {
    const { a } = shares()
    const material = must(generateAdaptorSecret(rng))
    const result = startSign({
      keyShare: a,
      role: 'initiator',
      sessionId: rng(32),
      digest: rng(32),
      adaptor: {
        point: material.point,
        proof: flip(material.proof, 40) as AdaptorSecretProof,
      },
      randomBytes: rng,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-proof')
  })

  it('treats a different adaptor point, or plain versus adaptor, as a different session', () => {
    const { a, b } = shares()
    const sessionId = rng(32)
    const digest = rng(32)
    const one = must(generateAdaptorSecret(rng))
    const two = must(generateAdaptorSecret(rng))
    const initiator = must(
      startSign({
        keyShare: a,
        role: 'initiator',
        sessionId,
        digest,
        adaptor: one,
        randomBytes: rng,
      }),
    )
    for (const adaptor of [two, undefined]) {
      const responder = must(
        startSign({
          keyShare: b,
          role: 'responder',
          sessionId,
          digest,
          adaptor,
          randomBytes: rng,
        }),
      )
      const rejected = signStep(responder.session, initiator.outgoing!)
      expect(rejected.ok).toBe(false)
      if (!rejected.ok) {
        expect(rejected.error.code).toBe('wrong-session')
        expect(rejected.error.sessionAborted).toBe(false)
      }
    }
  })
})

describe('malicious counterpart: adaptor pre-signing', () => {
  const { a, b } = shares()
  const material = must(generateAdaptorSecret(rng))
  const digest = rng(32)
  const trace = presign(a, b, material, digest)
  // Body layout of messages 2 and 3: R(33) RT(33) dleq(64) A(33) AT(33).
  const OFFSET = { R: 0, RT: 33, DLEQ: 66, A: 130, AT: 163 }

  it('has the documented message sizes', () => {
    expect(trace.messages.map(bytes => bytes.length)).toEqual([
      70, 234, 266, 582, 200,
    ])
  })

  it('message 2: rejects a nonce share whose two halves have different discrete logs', () => {
    const other = presign(a, b, material, digest)
    // R2T taken from another session: a valid point, wrong discrete log.
    const mixed = replace(
      message(trace, 1),
      HEADER_BYTES + OFFSET.RT,
      message(other, 1).subarray(
        HEADER_BYTES + OFFSET.RT,
        HEADER_BYTES + OFFSET.DLEQ,
      ),
    )
    expect(deliver(trace, 1, mixed)).toEqual(INVALID_PROOF)
    expect(
      deliver(
        trace,
        1,
        flip(message(trace, 1), HEADER_BYTES + OFFSET.DLEQ + 5),
      ),
    ).toEqual(INVALID_PROOF)
    // The whole share replayed from another session of the same point.
    const replayed = replace(
      message(trace, 1),
      HEADER_BYTES,
      message(other, 1).subarray(HEADER_BYTES),
    )
    expect(deliver(trace, 1, replayed)).toEqual(INVALID_PROOF)
    const offCurve = new Uint8Array(33)
    offCurve[0] = 0x03
    offCurve[32] = 5
    for (const offset of [OFFSET.R, OFFSET.RT, OFFSET.A, OFFSET.AT]) {
      const rejected = deliver(
        trace,
        1,
        replace(message(trace, 1), HEADER_BYTES + offset, offCurve),
      )
      expect(rejected.ok).toBe(false)
      if (!rejected.ok) {
        expect(rejected.error.code).toBe('invalid-point')
        expect(rejected.error.keyShareBurned).toBe(false)
      }
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
      expect(rejected.ok).toBe(false)
      if (!rejected.ok) {
        // A flipped x coordinate is either off the curve or a different
        // point; either way nothing is released.
        expect(['invalid-commitment', 'invalid-point']).toContain(
          rejected.error.code,
        )
        expect(rejected.error.sessionAborted).toBe(true)
      }
    }
  })

  it('message 4: a wrong proof response is rejected before anything is decrypted', () => {
    const fresh = shares()
    const local = presign(fresh.a, fresh.b, material, digest)
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
      }
    }
    expect(must(describeKeyShare(fresh.a)).burned).toBe(false)
  })

  it('message 4: a well-formed ciphertext of a wrong value burns the key share', () => {
    const fresh = shares()
    const local = presign(fresh.a, fresh.b, material, digest)
    const modulus = bytesToInt(
      (fresh.a as unknown as { localModulus: Uint8Array }).localModulus,
    )
    const probe = ciphertextBytes(encrypt(paillierPublicKey(modulus), 99n, 5n))
    const rejected = deliver(
      local,
      3,
      replace(message(local, 3), HEADER_BYTES, probe),
    )
    expect(rejected).toEqual({
      ok: false,
      error: {
        code: 'invalid-signature',
        sessionAborted: true,
        keyShareBurned: true,
      },
    })
    expect(must(describeKeyShare(fresh.a)).burned).toBe(true)
  })

  it('message 5: the responder accepts only the pre-signature for the agreed nonce', () => {
    const good = message(trace, 4)
    const other = presign(a, b, material, digest)
    // A valid pre-signature for the same key, point and digest but another
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
      expect(deliver(trace, 4, bad)).toEqual({
        ok: false,
        error: {
          code: 'invalid-signature',
          sessionAborted: true,
          keyShareBurned: false,
        },
      })
    }
  })

  it('before message 5 the responder holds neither a pre-signature nor a live nonce', () => {
    // After message 4 only the initiator holds the pre-signature. The
    // responder's state has the joint nonce points and a wiped nonce share,
    // so an initiator that withholds message 5 leaves it nothing to complete.
    const state = cloneState(trace.before[4]!) as unknown as Record<
      string,
      unknown
    >
    expect(state.jointNonce).toHaveLength(66)
    const nonce = state.nonce as Uint8Array
    expect(nonce.every(byte => byte === 0)).toBe(true)
  })
})
