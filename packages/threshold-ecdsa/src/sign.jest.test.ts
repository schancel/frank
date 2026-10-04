import { secp256k1 } from '@noble/curves/secp256k1.js'
import { getAddress, Signature, Transaction } from 'ethers'
import { randomBytes } from 'crypto'

import {
  abortSign,
  describeKeyShare,
  destroyKeyShare,
  exportKeyShare,
  exportSignSession,
  importKeyShare,
  importSignSession,
  signStep,
  startSign,
  tweakPublicKey,
  type KeyShare,
  type SignResult,
  type SignSession,
  type StartSignInput,
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
  seededRandom,
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

function filled(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte)
}

type Options = Partial<
  Pick<
    StartSignInput,
    'sessionId' | 'digest' | 'tweakCommitment' | 'randomBytes'
  >
>

function sign(
  initiator: KeyShare,
  responder: KeyShare,
  options: Options = {},
): Trace<SignSession, SignResult> {
  const common = {
    sessionId: options.sessionId ?? rng(32),
    digest: options.digest ?? filled(0x5a),
    tweakCommitment: options.tweakCommitment,
  }
  return drive(
    startSign({
      ...common,
      keyShare: initiator,
      role: 'initiator',
      randomBytes: options.randomBytes ?? rng,
    }),
    startSign({
      ...common,
      keyShare: responder,
      role: 'responder',
      randomBytes: options.randomBytes ?? rng,
    }),
    signStep,
  )
}

function signature(result: SignResult | null): {
  signature: Uint8Array
  recovery: 0 | 1
  publicKey: Uint8Array
} {
  if (result === null || result.kind !== 'signature') {
    throw new Error('no signature')
  }
  return result
}

/** Runs one tampered delivery against a copy of the recorded recipient state. */
function deliver(
  trace: Trace<SignSession, SignResult>,
  index: number,
  message: Uint8Array,
) {
  const state = trace.before[index]
  if (state === undefined) throw new Error('no such message')
  return signStep(cloneState(state), message)
}

function message(
  trace: Trace<SignSession, SignResult>,
  index: number,
): Uint8Array {
  const bytes = trace.messages[index]
  if (bytes === undefined) throw new Error('no such message')
  return bytes
}

describe('two-party signing', () => {
  it('produces a low-s signature that @noble/curves verifies, in both role assignments', () => {
    const { a, b } = shares()
    const publicKey = fromHex(recorded.keygen.publicKey)
    for (const [initiator, responder] of [
      [a, b],
      [b, a],
    ] as const) {
      const digest = rng(32)
      const trace = sign(initiator, responder, { digest })
      const first = signature(trace.initiatorResult)
      const second = signature(trace.responderResult)
      expect(second).toEqual(first)
      expect(hex(first.publicKey)).toBe(hex(publicKey))
      const parsed = secp256k1.Signature.fromCompact(first.signature)
      expect(parsed.hasHighS()).toBe(false)
      expect(
        secp256k1.verify(first.signature, digest, publicKey, {
          prehash: false,
          lowS: true,
        }),
      ).toBe(true)
      expect(
        hex(
          parsed
            .addRecoveryBit(first.recovery)
            .recoverPublicKey(digest)
            .toRawBytes(true),
        ),
      ).toBe(hex(publicKey))
      expect(trace.messages.map(bytes => bytes.length)).toEqual([
        70, 136, 168, 550, 103,
      ])
    }
  })

  it('signs a real EIP-1559 transaction that ethers recovers to the joint address', () => {
    const { a, b } = shares()
    const address = getAddress(`0x${recorded.keygen.address}`)
    const transaction = Transaction.from({
      type: 2,
      chainId: 10143n,
      nonce: 7,
      to: '0x000000000000000000000000000000000000dEaD',
      value: 123456789n,
      gasLimit: 21000n,
      maxFeePerGas: 100_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
      data: '0x',
    })
    const digest = fromHex(transaction.unsignedHash.slice(2))
    const result = signature(sign(a, b, { digest }).initiatorResult)
    transaction.signature = Signature.from({
      r: `0x${hex(result.signature.subarray(0, 32))}`,
      s: `0x${hex(result.signature.subarray(32))}`,
      yParity: result.recovery,
    })
    const reparsed = Transaction.from(transaction.serialized)
    expect(reparsed.type).toBe(2)
    expect(reparsed.from).toBe(address)
    expect(reparsed.unsignedHash).toBe(transaction.unsignedHash)
  })

  it('signs for a state-committed tweak of the joint key without new key generation', () => {
    const { a, b } = shares()
    const publicKey = fromHex(recorded.keygen.publicKey)
    const commitment = rng(32)
    const tweaked = must(tweakPublicKey(publicKey, commitment))
    // P' = P + h*G, cross-checked with @noble/curves directly.
    const expected = secp256k1.ProjectivePoint.fromHex(publicKey)
      .add(secp256k1.ProjectivePoint.BASE.multiply(bytesToInt(tweaked.tweak)))
      .toRawBytes(true)
    expect(hex(tweaked.publicKey)).toBe(hex(expected))
    const digest = rng(32)
    for (const [initiator, responder] of [
      [a, b],
      [b, a],
    ] as const) {
      const result = signature(
        sign(initiator, responder, { digest, tweakCommitment: commitment })
          .initiatorResult,
      )
      expect(hex(result.publicKey)).toBe(hex(tweaked.publicKey))
      expect(
        secp256k1.verify(result.signature, digest, tweaked.publicKey, {
          prehash: false,
          lowS: true,
        }),
      ).toBe(true)
      // Not valid for the untweaked key.
      expect(
        secp256k1.verify(result.signature, digest, publicKey, {
          prehash: false,
        }),
      ).toBe(false)
    }
    const transaction = Transaction.from({
      type: 2,
      chainId: 10143n,
      nonce: 0,
      to: '0x000000000000000000000000000000000000dEaD',
      value: 1n,
      gasLimit: 21000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    })
    const result = signature(
      sign(a, b, {
        digest: fromHex(transaction.unsignedHash.slice(2)),
        tweakCommitment: commitment,
      }).initiatorResult,
    )
    transaction.signature = Signature.from({
      r: `0x${hex(result.signature.subarray(0, 32))}`,
      s: `0x${hex(result.signature.subarray(32))}`,
      yParity: result.recovery,
    })
    expect(Transaction.from(transaction.serialized).from).toBe(
      getAddress(`0x${hex(tweaked.address)}`),
    )
  })

  it('never shows the two parties different tweaks: a mismatch is a different session', () => {
    const { a, b } = shares()
    const sessionId = rng(32)
    const digest = rng(32)
    const initiator = must(
      startSign({
        keyShare: a,
        role: 'initiator',
        sessionId,
        digest,
        tweakCommitment: filled(1),
        randomBytes: rng,
      }),
    )
    const responder = must(
      startSign({
        keyShare: b,
        role: 'responder',
        sessionId,
        digest,
        tweakCommitment: filled(2),
        randomBytes: rng,
      }),
    )
    const rejected = signStep(responder.session, initiator.outgoing!)
    expect(rejected).toEqual({
      ok: false,
      error: {
        code: 'wrong-session',
        sessionAborted: false,
        keyShareBurned: false,
      },
    })
  })
})

describe('nonce handling', () => {
  it('uses fresh nonces in every session, also for the same digest', () => {
    const { a, b } = shares()
    const digest = filled(9)
    const first = signature(sign(a, b, { digest }).initiatorResult)
    const second = signature(sign(a, b, { digest }).initiatorResult)
    expect(hex(first.signature.subarray(0, 32))).not.toBe(
      hex(second.signature.subarray(0, 32)),
    )
  })

  it('derives different nonces for different session ids even from a repeating RNG', () => {
    const { a, b } = shares()
    const digest = filled(9)
    const repeating = () => seededRandom('stuck')
    const run = (sessionId: Uint8Array) => {
      const stream = repeating()
      return signature(
        sign(a, b, { digest, sessionId, randomBytes: stream }).initiatorResult,
      )
    }
    const first = run(filled(1))
    const second = run(filled(2))
    expect(hex(first.signature.subarray(0, 32))).not.toBe(
      hex(second.signature.subarray(0, 32)),
    )
  })

  it('refuses to advance a state twice', () => {
    const { a, b } = shares()
    const sessionId = rng(32)
    const digest = rng(32)
    const initiator = must(
      startSign({
        keyShare: a,
        role: 'initiator',
        sessionId,
        digest,
        randomBytes: rng,
      }),
    )
    const responder = must(
      startSign({
        keyShare: b,
        role: 'responder',
        sessionId,
        digest,
        randomBytes: rng,
      }),
    )
    const reply = must(signStep(responder.session, initiator.outgoing!))
    const advanced = must(signStep(initiator.session, reply.outgoing!))
    expect(advanced.outgoing).not.toBeNull()
    // The old initiator state must not accept a second message 2.
    expect(signStep(initiator.session, reply.outgoing!)).toEqual({
      ok: false,
      error: {
        code: 'state-already-used',
        sessionAborted: false,
        keyShareBurned: false,
      },
    })
  })

  it('makes an aborted session unusable and wipes its nonce', () => {
    const { a, b } = shares()
    const trace = sign(a, b)
    // Responder state waiting for message 3 holds a live nonce.
    const state = cloneState(trace.before[2]!)
    const nonce = (state as unknown as { nonce: Uint8Array }).nonce
    expect(nonce.some(byte => byte !== 0)).toBe(true)
    const rejected = signStep(state, flip(message(trace, 2), HEADER_BYTES + 40))
    expect(rejected.ok).toBe(false)
    if (rejected.ok) return
    expect(rejected.error.sessionAborted).toBe(true)
    expect(nonce.every(byte => byte === 0)).toBe(true)
    expect(signStep(state, message(trace, 2))).toEqual({
      ok: false,
      error: {
        code: 'session-aborted',
        sessionAborted: false,
        keyShareBurned: false,
      },
    })
    expect(exportSignSession(state).ok).toBe(false)
  })

  it('wipes nonces on completion and on abortSign', () => {
    const { a, b } = shares()
    const trace = sign(a, b)
    for (const session of [trace.initiatorSession, trace.responderSession]) {
      const nonce = (session as unknown as { nonce: Uint8Array }).nonce
      expect(nonce.every(byte => byte === 0)).toBe(true)
      expect(signStep(session, message(trace, 0))).toEqual({
        ok: false,
        error: {
          code: 'session-finished',
          sessionAborted: false,
          keyShareBurned: false,
        },
      })
    }
    const pending = must(
      startSign({
        keyShare: a,
        role: 'initiator',
        sessionId: rng(32),
        digest: rng(32),
        randomBytes: rng,
      }),
    )
    const nonce = (pending.session as unknown as { nonce: Uint8Array }).nonce
    abortSign(pending.session)
    expect(nonce.every(byte => byte === 0)).toBe(true)
  })
})

describe('malicious counterpart: plain signing', () => {
  const { a, b } = shares()
  const trace = sign(a, b)

  it('rejects frames that are not for this session and round without aborting', () => {
    const other = sign(a, b)
    for (let index = 0; index < 5; index += 1) {
      const state = cloneState(trace.before[index]!)
      // Replay of the same round from another session.
      expect(signStep(state, message(other, index))).toEqual({
        ok: false,
        error: {
          code: 'wrong-session',
          sessionAborted: false,
          keyShareBurned: false,
        },
      })
      // Out-of-order message of this session.
      const wrongRound = message(trace, (index + 1) % 5)
      const outOfOrder = signStep(state, wrongRound)
      expect(outOfOrder.ok).toBe(false)
      if (!outOfOrder.ok) {
        expect(outOfOrder.error).toEqual({
          code: 'unexpected-message',
          sessionAborted: false,
          keyShareBurned: false,
        })
      }
      // Truncated, extended, wrong magic, wrong type.
      const good = message(trace, index)
      for (const bad of [
        good.subarray(0, good.length - 1),
        new Uint8Array([...good, 0]),
        flip(good, 0),
        new Uint8Array(0),
        'not bytes' as unknown as Uint8Array,
        new Uint8Array(100_000),
      ]) {
        const rejected = signStep(state, bad)
        expect(rejected.ok).toBe(false)
        if (!rejected.ok) {
          expect(rejected.error.code).toBe('malformed-message')
          expect(rejected.error.sessionAborted).toBe(false)
        }
      }
      // The session is still usable after all of the above.
      expect(signStep(state, good).ok).toBe(true)
    }
  })

  it('message 2: rejects a wrong proof of knowledge, an invalid point, and a replayed share', () => {
    // Flip a bit of the proof response.
    const tampered = deliver(
      trace,
      1,
      flip(message(trace, 1), HEADER_BYTES + 33 + 40),
    )
    expect(tampered).toEqual({
      ok: false,
      error: {
        code: 'invalid-proof',
        sessionAborted: true,
        keyShareBurned: false,
      },
    })
    // A point that is not on the curve (x = 5 has no square root for y).
    const offCurve = new Uint8Array(33)
    offCurve[0] = 0x02
    offCurve[32] = 5
    for (const bad of [
      offCurve,
      new Uint8Array(33), // all zero: the "identity"
      Uint8Array.of(0x04, ...new Uint8Array(32)), // uncompressed prefix
      Uint8Array.of(0x02, ...new Uint8Array(32).fill(0xff)), // x >= p
    ]) {
      const rejected = deliver(
        trace,
        1,
        replace(message(trace, 1), HEADER_BYTES, bad),
      )
      expect(rejected).toEqual({
        ok: false,
        error: {
          code: 'invalid-point',
          sessionAborted: true,
          keyShareBurned: false,
        },
      })
    }
    // A valid (R2, proof) from another session, re-framed for this one: the
    // proof is bound to the session, so it does not verify here.
    const other = sign(a, b)
    const spliced = replace(
      message(trace, 1),
      HEADER_BYTES,
      message(other, 1).subarray(HEADER_BYTES),
    )
    expect(deliver(trace, 1, spliced)).toEqual({
      ok: false,
      error: {
        code: 'invalid-proof',
        sessionAborted: true,
        keyShareBurned: false,
      },
    })
  })

  it('message 3: rejects an opening that does not match the commitment, and a bad proof', () => {
    // Different nonce point than committed.
    const other = sign(a, b)
    const spliced = replace(
      message(trace, 2),
      HEADER_BYTES,
      message(other, 2).subarray(HEADER_BYTES),
    )
    expect(deliver(trace, 2, spliced)).toEqual({
      ok: false,
      error: {
        code: 'invalid-commitment',
        sessionAborted: true,
        keyShareBurned: false,
      },
    })
    // Wrong commitment nonce.
    expect(
      deliver(trace, 2, flip(message(trace, 2), message(trace, 2).length - 1)),
    ).toEqual({
      ok: false,
      error: {
        code: 'invalid-commitment',
        sessionAborted: true,
        keyShareBurned: false,
      },
    })
    // A responder whose stored commitment matches a share with a bad proof:
    // the proof is still checked after the commitment opens.
    const state = cloneState(trace.before[2]!) as unknown as {
      peerCommit: Uint8Array
      session: Uint8Array
      keyShare: { peerId: Uint8Array }
    }
    const body = message(trace, 2).subarray(HEADER_BYTES)
    const badPayload = flip(body.subarray(0, 98), 97)
    const { commit } = jest.requireActual(
      './group',
    ) as typeof import('./group.js')
    state.peerCommit = commit(
      'sign-nonce',
      state.session,
      state.keyShare.peerId,
      badPayload,
      body.subarray(98),
    )
    const forged = replace(message(trace, 2), HEADER_BYTES, badPayload)
    expect(signStep(state as unknown as SignSession, forged)).toEqual({
      ok: false,
      error: {
        code: 'invalid-proof',
        sessionAborted: true,
        keyShareBurned: false,
      },
    })
  })

  it('message 4: rejects out-of-range Paillier values without burning the share', () => {
    const fresh = shares()
    const local = sign(fresh.a, fresh.b)
    const modulus = bytesToInt(
      (fresh.a as unknown as { localModulus: Uint8Array }).localModulus,
    )
    const prime = bytesToInt(
      (fresh.a as unknown as { primeP: Uint8Array }).primeP,
    )
    for (const bad of [
      0n,
      modulus * modulus,
      modulus * modulus + 5n,
      prime * 12345n, // shares a factor with N: not in Z*_{N^2}
    ]) {
      const rejected = deliver(
        local,
        3,
        replace(message(local, 3), HEADER_BYTES, intToBytes(bad, 512)),
      )
      expect(rejected).toEqual({
        ok: false,
        error: {
          code: 'invalid-paillier',
          sessionAborted: true,
          keyShareBurned: false,
        },
      })
    }
    expect(must(describeKeyShare(fresh.a)).burned).toBe(false)
  })

  it('message 4: a well-formed ciphertext of a wrong value burns the key share (Lindell17 abort rule)', () => {
    const fresh = shares()
    const local = sign(fresh.a, fresh.b)
    const modulus = bytesToInt(
      (fresh.a as unknown as { localModulus: Uint8Array }).localModulus,
    )
    const key = paillierPublicKey(modulus)
    // A valid encryption of an arbitrary value, as a cheating responder that
    // probes the initiator's share would send.
    const probe = ciphertextBytes(encrypt(key, CURVE_ORDER + 12345n, 7n))
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
    // The share is dead: no new session, no export, secrets wiped.
    expect(must(describeKeyShare(fresh.a)).burned).toBe(true)
    expect(
      startSign({
        keyShare: fresh.a,
        role: 'initiator',
        sessionId: rng(32),
        digest: rng(32),
        randomBytes: rng,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'key-share-burned',
        sessionAborted: false,
        keyShareBurned: false,
      },
    })
    expect(exportKeyShare(fresh.a).ok).toBe(false)
    const internal = fresh.a as unknown as {
      secretShare: Uint8Array
      primeP: Uint8Array
      primeQ: Uint8Array
    }
    for (const secret of [
      internal.secretShare,
      internal.primeP,
      internal.primeQ,
    ]) {
      expect(secret.every(byte => byte === 0)).toBe(true)
    }
    // Another in-flight session of the same share dies too.
    const stale = cloneState(local.before[1]!)
    const refused = signStep(stale, message(local, 1))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe('key-share-burned')
  })

  it('message 5: rejects a signature that is invalid, high-s, for another nonce, or has the wrong recovery bit', () => {
    const good = message(trace, 4)
    const body = good.subarray(HEADER_BYTES)
    const s = bytesToInt(body.subarray(32, 64))
    const highS = replace(
      good,
      HEADER_BYTES + 32,
      intToBytes(CURVE_ORDER - s, 32),
    )
    const other = sign(a, b, { digest: filled(0x5a) })
    const otherNonce = replace(
      good,
      HEADER_BYTES,
      message(other, 4).subarray(HEADER_BYTES),
    )
    for (const bad of [
      flip(good, HEADER_BYTES + 40),
      highS,
      otherNonce,
      flip(good, good.length - 1),
      replace(good, good.length - 1, Uint8Array.of(2)),
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

  it('an initiator that keeps the signature to itself gains nothing reusable', () => {
    // The initiator finishes after message 4; it can withhold message 5.
    const fresh = shares()
    const withheld = sign(fresh.a, fresh.b, { digest: filled(3) })
    const kept = signature(withheld.initiatorResult)
    // The responder, never having seen message 5, aborts and starts over
    // with a new session id: new nonces, a different valid signature.
    const again = signature(
      sign(fresh.a, fresh.b, { digest: filled(3) }).responderResult,
    )
    expect(hex(again.signature.subarray(0, 32))).not.toBe(
      hex(kept.signature.subarray(0, 32)),
    )
    for (const result of [kept, again]) {
      expect(
        secp256k1.verify(result.signature, filled(3), result.publicKey, {
          prehash: false,
        }),
      ).toBe(true)
    }
  })
})

describe('inputs and persistence', () => {
  it('rejects malformed inputs with typed errors', () => {
    const { a } = shares()
    const base = {
      keyShare: a,
      role: 'initiator' as const,
      sessionId: rng(32),
      digest: rng(32),
      randomBytes: rng,
    }
    const invalid = (input: StartSignInput, code = 'invalid-input') => {
      const result = startSign(input)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe(code)
    }
    invalid({ ...base, digest: rng(31) })
    invalid({ ...base, sessionId: rng(33) })
    invalid({ ...base, tweakCommitment: rng(31) })
    invalid({ ...base, role: 'both' as unknown as 'initiator' })
    invalid({ ...base, keyShare: {} as KeyShare })
    invalid(
      { ...base, randomBytes: undefined as unknown as typeof rng },
      'rng-failed',
    )
    invalid({ ...base, randomBytes: () => new Uint8Array(3) }, 'rng-failed')
    invalid(
      {
        ...base,
        randomBytes: () => {
          throw new Error('secret detail')
        },
      },
      'rng-failed',
    )
  })

  it('errors carry only a code and two flags', () => {
    const { a } = shares()
    const result = startSign({
      keyShare: a,
      role: 'initiator',
      sessionId: rng(32),
      digest: rng(31),
      randomBytes: rng,
    })
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'invalid-input',
        sessionAborted: false,
        keyShareBurned: false,
      },
    })
  })

  it('resumes a session from exported state at every waiting point', () => {
    const { a, b } = shares()
    const digest = rng(32)
    const sessionId = rng(32)
    let initiator = must(
      startSign({
        keyShare: a,
        role: 'initiator',
        sessionId,
        digest,
        randomBytes: rng,
      }),
    )
    let responder = must(
      startSign({
        keyShare: b,
        role: 'responder',
        sessionId,
        digest,
        randomBytes: rng,
      }),
    )
    const reload = (session: SignSession, keyShare: KeyShare): SignSession =>
      must(
        importSignSession({
          state: must(exportSignSession(session)),
          keyShare,
          randomBytes: rng,
        }),
      )
    let outgoing = initiator.outgoing
    let toResponder = true
    let result: SignResult | null = null
    while (outgoing !== null) {
      if (toResponder) {
        responder = must(signStep(reload(responder.session, b), outgoing))
        outgoing = responder.outgoing
        result = responder.result ?? result
      } else {
        initiator = must(signStep(reload(initiator.session, a), outgoing))
        outgoing = initiator.outgoing
      }
      toResponder = !toResponder
    }
    const final = signature(result)
    expect(
      secp256k1.verify(final.signature, digest, final.publicKey, {
        prehash: false,
      }),
    ).toBe(true)
    // Finished sessions cannot be exported.
    expect(exportSignSession(initiator.session).ok).toBe(false)
  })

  it('refuses to import state for another key, or malformed state', () => {
    const { a, b } = shares()
    const started = must(
      startSign({
        keyShare: a,
        role: 'initiator',
        sessionId: rng(32),
        digest: rng(32),
        randomBytes: rng,
      }),
    )
    const state = must(exportSignSession(started.session))
    // Same key id on both shares, so tamper with the id instead.
    for (const bad of [
      flip(state, 10),
      flip(state, 0),
      state.subarray(0, state.length - 1),
      new Uint8Array([...state, 0]),
      replace(state, 6, Uint8Array.of(3)),
    ]) {
      const result = importSignSession({
        state: bad,
        keyShare: a,
        randomBytes: rng,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('invalid-input')
    }
    expect(importSignSession({ state, keyShare: b, randomBytes: rng }).ok).toBe(
      true,
    )
    destroyKeyShare(a)
    const dead = importSignSession({ state, keyShare: a, randomBytes: rng })
    expect(dead.ok).toBe(false)
    if (!dead.ok) expect(dead.error.code).toBe('key-share-burned')
  })
})
