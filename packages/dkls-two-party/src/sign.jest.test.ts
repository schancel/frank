import { secp256k1 } from '@noble/curves/secp256k1.js'
import { getAddress, Signature, Transaction } from 'ethers'

import { bit } from './bytes.js'
import {
  describeKeyShare,
  exportKeyShare,
  importKeyShare,
  internalShare,
} from './key-share.js'
import {
  abortSign,
  exportSignSession,
  importSignSession,
  SIGN_MESSAGES,
  signStep,
  startSign,
  type SignSession,
} from './sign.js'
import {
  flip,
  hex,
  makeKeys,
  must,
  rng,
  runSign,
  shareFor,
  type KeyPair,
} from './test-support.js'
import { HEADER_BYTES, MAX_MESSAGE_BYTES } from './wire.js'

/** A Monad-testnet EIP-1559 transfer and its signing digest. */
function transfer(nonce: number): { tx: Transaction; digest: Uint8Array } {
  const tx = Transaction.from({
    type: 2,
    chainId: 10143,
    nonce,
    to: '0x000000000000000000000000000000000000dEaD',
    value: 1_000_000_000_000_000n,
    gasLimit: 21_000n,
    maxFeePerGas: 100_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
  })
  const digest = Uint8Array.from(Buffer.from(tx.unsignedHash.slice(2), 'hex'))
  return { tx, digest }
}

function recoveredSender(
  tx: Transaction,
  signature: Uint8Array,
  recovery: 0 | 1,
): string | null {
  const signed = tx.clone()
  signed.signature = Signature.from({
    r: '0x' + hex(signature.subarray(0, 32)),
    s: '0x' + hex(signature.subarray(32, 64)),
    yParity: recovery,
  })
  return Transaction.from(signed.serialized).from
}

describe('signing', () => {
  let keys: KeyPair
  let address: string
  let publicKey: Uint8Array

  beforeAll(() => {
    keys = makeKeys().keys
    const info = must(describeKeyShare(keys.initiator))
    address = getAddress('0x' + hex(info.address))
    publicKey = info.publicKey
  })

  function expectValid(
    trace: ReturnType<typeof runSign>,
    nonce: number,
  ): Uint8Array {
    expect(trace.failure).toBeNull()
    const a = trace.initiator.result
    const b = trace.responder.result
    if (a === null || b === null) throw new Error('no result')
    if (a.kind !== 'signature' || b.kind !== 'signature') {
      throw new Error('wrong kind')
    }
    expect(hex(a.signature)).toBe(hex(b.signature))
    expect(a.recovery).toBe(b.recovery)
    expect(hex(a.publicKey)).toBe(hex(publicKey))
    const { tx, digest } = transfer(nonce)
    expect(
      secp256k1.verify(a.signature, digest, publicKey, {
        prehash: false,
        lowS: true,
      }),
    ).toBe(true)
    expect(recoveredSender(tx, a.signature, a.recovery)).toBe(address)
    return a.signature
  }

  it('signs an EIP-1559 digest that ethers recovers to the joint address, in both role assignments', () => {
    const one = runSign(keys, transfer(0).digest)
    expectValid(one, 0)
    expect(one.messages).toHaveLength(SIGN_MESSAGES)
    for (const message of one.messages) {
      expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES)
    }
    const two = runSign(keys, transfer(0).digest, { swapRoles: true })
    expectValid(two, 0)
    // eslint-disable-next-line no-console
    console.info(
      `sign: initiator ${one.initiator.elapsed.toFixed(0)} ms, responder ` +
        `${one.responder.elapsed.toFixed(0)} ms, sizes ` +
        one.messages.map(message => message.length).join('/'),
    )
  })

  it('gets both recovery bits and low s right over many signatures', () => {
    const seen = new Set<number>()
    for (let index = 0; index < 8; index += 1) {
      const trace = runSign(keys, transfer(1).digest, {
        swapRoles: index % 2 === 1,
      })
      expectValid(trace, 1)
      const result = trace.initiator.result
      if (result?.kind === 'signature') seen.add(result.recovery)
    }
    expect(seen.size).toBe(2)
  })

  it('uses fresh nonces: a repeated session id and digest still gives another signature', () => {
    const sessionId = rng(32)
    const { digest } = transfer(2)
    const one = runSign(keys, digest, { sessionId })
    const two = runSign(keys, digest, { sessionId })
    const s1 = expectValid(one, 2)
    const s2 = expectValid(two, 2)
    expect(hex(s1.subarray(0, 32))).not.toBe(hex(s2.subarray(0, 32)))
    // No message body repeats either: every pad and mask depends on both salts.
    for (let index = 0; index < SIGN_MESSAGES; index += 1) {
      expect(hex(one.messages[index] as Uint8Array)).not.toBe(
        hex(two.messages[index] as Uint8Array),
      )
    }
  })

  it('does not let a peer that repeats its salt make the honest party repeat its pads', () => {
    // The initiator replays its whole first message (same salt, same
    // extension). The honest responder's reply must still differ everywhere
    // that depends on its secrets, because its own salt is in every pad.
    const sessionId = rng(32)
    const { digest } = transfer(2)
    const first = runSign(keys, digest, { sessionId })
    const replayed = first.messages[0] as Uint8Array
    const replies: string[] = []
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const responder = must(
        startSign({
          keyShare: keys.responder,
          role: 'responder',
          sessionId,
          digest,
          randomBytes: rng,
        }),
      )
      const reply = must(signStep(responder.session, replayed)).outgoing
      if (reply === null) throw new Error('no reply')
      replies.push(hex(reply.subarray(reply.length - 66880)))
      abortSign(must(signStep(responder.session, replayed).ok ? ({} as never) : { ok: true, value: responder.session } as never))
    }
    const a = Buffer.from(replies[0] as string, 'hex')
    const b = Buffer.from(replies[1] as string, 'hex')
    // Compare the multiplication matrices scalar by scalar: none repeats, and
    // no two differ by the same amount in the first columns (which a reused
    // pad pair would cause).
    let equal = 0
    for (let offset = 0; offset + 32 <= 66816; offset += 32) {
      if (a.subarray(offset, offset + 32).equals(b.subarray(offset, offset + 32))) {
        equal += 1
      }
    }
    expect(equal).toBe(0)
    const n = secp256k1.CURVE.n
    const difference = (offset: number): bigint =>
      (BigInt('0x' + a.subarray(offset, offset + 32).toString('hex')) -
        BigInt('0x' + b.subarray(offset, offset + 32).toString('hex')) +
        n) %
      n
    // Rows 0 and 1, column 0: with reused pads both would equal alpha - alpha'.
    expect(difference(0)).not.toBe(difference(96))
  })

  it('rejects bad arguments without starting', () => {
    const base = {
      keyShare: keys.initiator,
      role: 'initiator' as const,
      sessionId: rng(32),
      digest: transfer(3).digest,
      randomBytes: rng,
    }
    for (const bad of [
      { ...base, digest: rng(31) },
      { ...base, sessionId: rng(33) },
      { ...base, keyShare: { __dklsTwoParty: 'key-share' } as never },
      { ...base, role: 'other' as never },
      { ...base, lockOpening: { kind: 'point', secret: rng(32) } as never },
    ]) {
      const started = startSign(bad)
      expect(started.ok).toBe(false)
      if (!started.ok) expect(started.error.code).toBe('invalid-input')
    }
  })

  describe('frames', () => {
    const { digest } = transfer(4)

    it('refuses garbage, duplicates, other sessions, digests and roles without aborting', () => {
      const other = runSign(keys, transfer(5).digest)
      const sessionId = rng(32)
      const sameIdOtherDigest = runSign(keys, transfer(6).digest, { sessionId })
      const swapped = runSign(keys, digest, { sessionId, swapRoles: true })
      const delivered: Uint8Array[] = []
      let refusals = 0
      const trace = runSign(keys, digest, {
        sessionId,
        hooks: {
          rewrite(index, message) {
            delivered[index] = message
            return message
          },
          restore(index, session) {
            const strays: [Uint8Array | undefined, string[]][] = [
              [new Uint8Array(0), ['malformed-message']],
              [rng(200), ['malformed-message']],
              [rng(MAX_MESSAGE_BYTES + 1), ['malformed-message']],
              [other.messages[index], ['wrong-session']],
              [sameIdOtherDigest.messages[index], ['wrong-session']],
              // Same key, session id and digest, but the roles the other
              // way round: a different frame.
              [swapped.messages[index], ['wrong-session']],
              // A correct frame with a truncated body.
              [
                (delivered[index] as Uint8Array).subarray(
                  0,
                  (delivered[index] as Uint8Array).length - 1,
                ),
                ['malformed-message'],
              ],
              ...delivered
                .slice(0, index)
                .map(
                  earlier =>
                    [earlier, ['unexpected-message']] as [Uint8Array, string[]],
                ),
            ]
            for (const [stray, codes] of strays) {
              if (stray === undefined) throw new Error('missing message')
              const refused = signStep(session, stray)
              expect(refused.ok).toBe(false)
              if (!refused.ok) {
                expect(codes).toContain(refused.error.code)
                expect(refused.error.sessionAborted).toBe(false)
                expect(refused.error.keyBurned).toBe(false)
                refusals += 1
              }
            }
            return session
          },
        },
      })
      expectValid(trace, 4)
      expect(refusals).toBe(7 * SIGN_MESSAGES + 10)
    })

    it('refuses a second message for a state that was already advanced', () => {
      const stale: SignSession[] = []
      const trace = runSign(keys, digest, {
        hooks: {
          restore(index, session) {
            stale.push(session)
            return session
          },
        },
      })
      expectValid(trace, 4)
      stale.forEach((session, index) => {
        const refused = signStep(session, trace.messages[index] as Uint8Array)
        expect(!refused.ok && refused.error.code).toBe('state-already-used')
        expect(exportSignSession(session).ok).toBe(false)
      })
      // And the finished sessions accept nothing more.
      const done = signStep(
        trace.responder.session,
        trace.messages[4] as Uint8Array,
      )
      expect(!done.ok && done.error.code).toBe('session-finished')
    })
  })

  describe('stored state', () => {
    it('resumes from exported state before every message, with imported keys', () => {
      const restored: KeyPair = {
        initiator: must(importKeyShare(must(exportKeyShare(keys.initiator)))),
        responder: must(importKeyShare(must(exportKeyShare(keys.responder)))),
      }
      const sizes: number[] = []
      const trace = runSign(restored, transfer(7).digest, {
        hooks: {
          restore(index, session, recipient) {
            const bytes = must(exportSignSession(session))
            sizes.push(bytes.length)
            return must(
              importSignSession({
                state: bytes,
                keyShare: restored[recipient],
                randomBytes: rng,
              }),
            )
          },
        },
      })
      expectValid(trace, 7)
      // eslint-disable-next-line no-console
      console.info(`stored sign session sizes: ${sizes.join('/')} bytes`)
    })

    it('refuses state that was altered anywhere, truncated, or belongs to another key', () => {
      const started = must(
        startSign({
          keyShare: keys.initiator,
          role: 'initiator',
          sessionId: rng(32),
          digest: transfer(8).digest,
          randomBytes: rng,
        }),
      )
      const bytes = must(exportSignSession(started.session))
      const load = (state: Uint8Array, keyShare = keys.initiator) =>
        importSignSession({ state, keyShare, randomBytes: rng })
      expect(load(bytes).ok).toBe(true)
      // The digest sits at a fixed offset: swapping it would pair the stored
      // nonce with another message. The MAC refuses it, and everything else.
      const digestOffset = 4 + 1 + 32 + 3 + 32
      for (const index of [0, 5, 37, 38, 39, digestOffset, 200, bytes.length - 1]) {
        const loaded = load(flip(bytes, index))
        expect(!loaded.ok && loaded.error.code).toBe('invalid-state')
      }
      for (const bad of [rng(50), bytes.subarray(0, bytes.length - 3), new Uint8Array(0)]) {
        const loaded = load(bad)
        expect(!loaded.ok && loaded.error.code).toBe('invalid-state')
      }
      const wrongKey = load(bytes, keys.responder)
      expect(!wrongKey.ok && wrongKey.error.code).toBe('invalid-state')
      const otherKeys = makeKeys().keys
      const foreign = load(bytes, otherKeys.initiator)
      expect(!foreign.ok && foreign.error.code).toBe('invalid-state')
      abortSign(started.session)
      expect(exportSignSession(started.session).ok).toBe(false)
    })
  })

  describe('a malicious counterpart', () => {
    // One flipped bit in every field of every message. Offsets are into the
    // body. Each must abort the session, burn the victim's key, and leave the
    // victim without a signature.
    const fields: Record<number, [string, number, string][]> = {
      0: [
        ['salt', 0, 'ot-extension-check-failed'],
        ['nonce commitment', 40, 'invalid-commitment'],
        ['extension syndrome', 64 + 100, 'ot-extension-check-failed'],
        ['extension hashed choices', 64 + 13208 + 3, 'ot-extension-check-failed'],
        ['extension check hash', 64 + 13208 + 17 + 5, 'ot-extension-check-failed'],
      ],
      1: [
        ['salt', 0, 'multiplication-check-failed'],
        ['nonce commitment', 40, 'invalid-commitment'],
        ['extension syndrome', 64 + 100, 'ot-extension-check-failed'],
        ['multiplication matrix', 64 + 13257 + 31, 'multiplication-check-failed'],
        ['multiplication check hash', 64 + 13257 + 66816 + 3, 'multiplication-check-failed'],
        ['multiplication v', 64 + 13257 + 66816 + 32 + 31, 'multiplication-check-failed'],
      ],
      2: [
        ['multiplication matrix', 31, 'multiplication-check-failed'],
        ['nonce point', 66880 + 20, ''],
        ['commitment nonce', 66880 + 33 + 5, 'invalid-commitment'],
        ['gamma_k', 66880 + 65 + 31, 'inconsistent-share'],
        ['gamma_x', 66880 + 65 + 32 + 31, 'inconsistent-share'],
        ['Gamma_k', 66880 + 65 + 64 + 20, ''],
        ['Gamma_x', 66880 + 65 + 64 + 33 + 20, ''],
      ],
      3: [
        ['nonce point', 20, ''],
        ['commitment nonce', 33 + 5, 'invalid-commitment'],
        ['gamma_k', 65 + 31, 'inconsistent-share'],
        ['gamma_x', 65 + 32 + 31, 'inconsistent-share'],
        ['Gamma_k', 65 + 64 + 20, ''],
        ['Gamma_x', 65 + 64 + 33 + 20, ''],
        ['u', 65 + 130 + 31, 'invalid-signature'],
        ['w', 65 + 130 + 32 + 31, 'invalid-signature'],
      ],
      4: [
        ['u', 31, 'invalid-signature'],
        ['w', 63, 'invalid-signature'],
      ],
    }

    for (let target = 0; target < SIGN_MESSAGES; target += 1) {
      for (const [name, offset, expected] of fields[target] ?? []) {
        it(`message ${target + 1}, ${name}: detected, session dead, key burned`, () => {
          const fresh = makeKeys().keys
          const { digest } = transfer(9)
          const trace = runSign(fresh, digest, {
            hooks: {
              rewrite: (index, message) =>
                index === target
                  ? flip(message, HEADER_BYTES + offset)
                  : message,
            },
          })
          const failed = trace.failure
          if (failed === null) throw new Error('the altered message was accepted')
          if (expected !== '') expect(failed.error.code).toBe(expected)
          expect(failed.error.sessionAborted).toBe(true)
          expect(failed.error.peerFault).toBe(true)
          expect(failed.error.keyBurned).toBe(true)
          const victimRole = failed.index % 2 === 0 ? 'responder' : 'initiator'
          const victim = trace[victimRole]
          expect(victim.result).toBeNull()
          // Nobody holds a signature unless only the last message was altered
          // (the initiator already had it then).
          if (target < 4) expect(trace.initiator.result).toBeNull()
          expect(trace.responder.result).toBeNull()
          // The session is dead.
          const again = signStep(
            victim.session,
            trace.messages[failed.index] as Uint8Array,
          )
          expect(again.ok).toBe(false)
          // The key is burned: new sessions, export and import are refused.
          const share = shareFor(fresh, victimRole)
          expect(must(describeKeyShare(share)).usable).toBe(false)
          const refused = startSign({
            keyShare: share,
            role: victimRole,
            sessionId: rng(32),
            digest,
            randomBytes: rng,
          })
          expect(!refused.ok && refused.error.code).toBe('key-burned')
          expect(!refused.ok && refused.error.keyBurned).toBe(true)
          expect(exportKeyShare(share).ok).toBe(false)
          // The other party's share is untouched.
          const otherRole = victimRole === 'initiator' ? 'responder' : 'initiator'
          expect(must(describeKeyShare(shareFor(fresh, otherRole))).usable).toBe(true)
        })
      }
    }
  })

  describe('the burn rule', () => {
    it('reaches stored copies, other handles and sessions already in flight', () => {
      const fresh = makeKeys().keys
      const stored = must(exportKeyShare(fresh.responder))
      const secondHandle = must(importKeyShare(stored))
      const { digest } = transfer(10)
      // A second session is in flight on another handle of the same share.
      const inFlight = must(
        startSign({
          keyShare: secondHandle,
          role: 'responder',
          sessionId: rng(32),
          digest,
          randomBytes: rng,
        }),
      )
      const honest = runSign(fresh, digest)
      expect(honest.failure).toBeNull()
      const trace = runSign(fresh, digest, {
        hooks: {
          rewrite: (index, message) =>
            index === 0 ? flip(message, message.length - 1) : message,
        },
      })
      expect(trace.failure?.error.keyBurned).toBe(true)
      // The in-flight session on the other handle refuses to continue.
      const blocked = signStep(inFlight.session, honest.messages[0] as Uint8Array)
      expect(!blocked.ok && blocked.error.code).toBe('key-burned')
      expect(!blocked.ok && blocked.error.sessionAborted).toBe(true)
      // The stored copy is refused for the rest of the process.
      const imported = importKeyShare(stored)
      expect(!imported.ok && imported.error.code).toBe('key-burned')
      expect(must(describeKeyShare(secondHandle)).usable).toBe(false)
    })

    it('selective abort on the OT extension: one bit per attempt, burned on the first wrong guess', () => {
      // The attacker (alice, extension receiver) replaces one of her two
      // seeds for base OT i. Bob's check passes exactly when his choice bit
      // Delta_i selects the seed she left alone, so each attempt tests one
      // bit of Delta. A wrong guess burns bob's key; the bits she learned
      // then describe a setup that is never used again.
      const fresh = makeKeys().keys
      const alice = internalShare(fresh.initiator)
      const bobDelta = internalShare(fresh.responder).delta.slice()
      const { digest } = transfer(11)
      let learned = 0
      let burned = false
      for (let i = 0; i < 128 && !burned; i += 1) {
        // Guess "Delta_i = 0": corrupt seed 1 of pair i.
        const offset = (2 * i + 1) * 32
        const saved = alice.seedPairs.slice(offset, offset + 32)
        alice.seedPairs.set(rng(32), offset)
        const trace = runSign(fresh, digest)
        alice.seedPairs.set(saved, offset)
        if (bit(bobDelta, i) === 0) {
          // Right guess: undetectable, and the signature is valid.
          expect(trace.failure).toBeNull()
          learned += 1
        } else {
          expect(trace.failure?.index).toBe(0)
          expect(trace.failure?.error.code).toBe('ot-extension-check-failed')
          expect(trace.failure?.error.keyBurned).toBe(true)
          burned = true
        }
      }
      expect(burned).toBe(true)
      // She learned exactly the run of zero bits before the first one bit
      // (plus that one bit): k + 1 bits with probability 2^-k.
      let zeros = 0
      while (bit(bobDelta, zeros) === 0) zeros += 1
      expect(learned).toBe(zeros)
      const refused = startSign({
        keyShare: fresh.responder,
        role: 'responder',
        sessionId: rng(32),
        digest,
        randomBytes: rng,
      })
      expect(!refused.ok && refused.error.code).toBe('key-burned')
    })
  })
})
