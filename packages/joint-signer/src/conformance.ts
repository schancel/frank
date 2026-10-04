/**
 * The conformance suite every backend must pass. Test-only: excluded from the
 * production typecheck and not exported from the package.
 *
 * A future backend replaces an existing one with no change to the game layer
 * exactly when `runConformance` passes for it.
 */
import { randomBytes as nodeRandomBytes } from 'crypto'
import { performance } from 'perf_hooks'
import { getAddress, Signature, Transaction } from 'ethers'

import type {
  JointKey,
  JointSignature,
  JointSigner,
  JointSignerError,
  JointSignerResult,
  KeygenSession,
  PlainJointSigner,
  Role,
  SignSession,
  Step,
} from './types.js'

const rng = (length: number): Uint8Array =>
  new Uint8Array(nodeRandomBytes(length))

function hex(bytes: Uint8Array): string {
  return (
    '0x' +
    Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  )
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, character => character.charCodeAt(0))
}

function must<T>(result: JointSignerResult<T>): T {
  if (!result.ok) {
    throw new Error(`${result.error.code} (${result.error.backendCode})`)
  }
  return result.value
}

function flip(bytes: Uint8Array, index: number): Uint8Array {
  const out = bytes.slice()
  out[index] = (out[index] ?? 0) ^ 0x01
  return out
}

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
  const digestHex = tx.unsignedHash
  const digest = Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(digestHex.slice(2 + index * 2, 4 + index * 2), 16),
  )
  return { tx, digest }
}

/** The sender ethers recovers from the serialised signed transaction. */
function recoveredSender(
  tx: Transaction,
  signature: Uint8Array,
  recovery: 0 | 1,
): string | null {
  const signed = tx.clone()
  signed.signature = Signature.from({
    r: hex(signature.subarray(0, 32)),
    s: hex(signature.subarray(32, 64)),
    yParity: recovery,
  })
  return Transaction.from(signed.serialized).from
}

type Stepper<S, R> = (
  session: S,
  message: Uint8Array,
) => JointSignerResult<Step<S, R>>

interface Party<S, R> {
  session: S
  result: R | null
  /** Wall time spent in this party's calls, in milliseconds. */
  elapsed: number
}

interface Trace<S, R> {
  /** Message `i` goes to the responder when `i` is even, else the initiator. */
  readonly messages: Uint8Array[]
  readonly initiator: Party<S, R>
  readonly responder: Party<S, R>
  /** The first failed step, if any. Delivery stops there. */
  readonly failure: {
    readonly index: number
    readonly error: JointSignerError
  } | null
}

interface DriveHooks<S> {
  /** Replaces message `index` before delivery. */
  readonly rewrite?: (index: number, message: Uint8Array) => Uint8Array
  /** Replaces the recipient's state before message `index` is delivered. */
  readonly restore?: (index: number, session: S, recipient: Role) => S
}

function timed<T>(party: { elapsed: number }, call: () => T): T {
  const started = performance.now()
  try {
    return call()
  } finally {
    party.elapsed += performance.now() - started
  }
}

/** Runs a two-party protocol by alternating delivery, recording everything. */
function drive<S, R>(
  start: (role: Role) => JointSignerResult<Step<S, R>>,
  step: Stepper<S, R>,
  hooks: DriveHooks<S> = {},
): Trace<S, R> {
  const timers = { initiator: { elapsed: 0 }, responder: { elapsed: 0 } }
  const first = must(timed(timers.initiator, () => start('initiator')))
  const second = must(timed(timers.responder, () => start('responder')))
  const initiator: Party<S, R> = {
    session: first.session,
    result: first.result,
    elapsed: 0,
  }
  const responder: Party<S, R> = {
    session: second.session,
    result: second.result,
    elapsed: 0,
  }
  const messages: Uint8Array[] = []
  let failure: Trace<S, R>['failure'] = null
  let outgoing = first.outgoing
  let toResponder = true
  while (outgoing !== null) {
    const index = messages.length
    const delivered = hooks.rewrite?.(index, outgoing) ?? outgoing
    messages.push(delivered)
    const role: Role = toResponder ? 'responder' : 'initiator'
    const recipient = toResponder ? responder : initiator
    if (hooks.restore !== undefined) {
      recipient.session = hooks.restore(index, recipient.session, role)
    }
    const stepped = timed(timers[role], () =>
      step(recipient.session, delivered),
    )
    if (!stepped.ok) {
      failure = { index, error: stepped.error }
      break
    }
    recipient.session = stepped.value.session
    recipient.result = stepped.value.result ?? recipient.result
    outgoing = stepped.value.outgoing
    toResponder = !toResponder
  }
  initiator.elapsed = timers.initiator.elapsed
  responder.elapsed = timers.responder.elapsed
  return { messages, initiator, responder, failure }
}

export function runConformance(name: string, create: () => JointSigner): void {
  describe(`joint signer conformance: ${name}`, () => {
    const signer = create()
    const capabilities = signer.capabilities
    const ids = { initiator: ascii('alice'), responder: ascii('bob') }
    const timings: string[] = []

    let keys: { initiator: JointKey; responder: JointKey }
    let keygenTrace: Trace<KeygenSession, JointKey>

    function keygen(
      hooks?: DriveHooks<KeygenSession>,
      backend: JointSigner = signer,
    ): Trace<KeygenSession, JointKey> {
      const sessionId = rng(32)
      return drive<KeygenSession, JointKey>(
        role =>
          backend.startKeygen({
            role,
            sessionId,
            localId: ids[role],
            peerId: ids[role === 'initiator' ? 'responder' : 'initiator'],
            randomBytes: rng,
          }),
        (session, message) => backend.keygenStep(session, message),
        hooks,
      )
    }

    /**
     * Signs with `keys`. `initiator` names which key-generation role takes
     * the signing initiator role.
     */
    function sign(
      digest: Uint8Array,
      options: {
        readonly hooks?: DriveHooks<SignSession>
        readonly swapRoles?: boolean
        readonly sessionId?: Uint8Array
        readonly with?: { initiator: JointKey; responder: JointKey }
        readonly backend?: JointSigner
      } = {},
    ): Trace<SignSession, JointSignature> {
      const backend = options.backend ?? signer
      const sessionId = options.sessionId ?? rng(32)
      const pair = options.with ?? keys
      const keyFor = (role: Role): JointKey => {
        if (!options.swapRoles) return pair[role]
        return role === 'initiator' ? pair.responder : pair.initiator
      }
      return drive<SignSession, JointSignature>(
        role =>
          backend.startSign({
            key: keyFor(role),
            role,
            sessionId,
            digest,
            randomBytes: rng,
          }),
        (session, message) => backend.signStep(session, message),
        options.hooks,
      )
    }

    function expectValid(
      trace: Trace<SignSession, JointSignature>,
      nonce: number,
    ): void {
      const { tx } = transfer(nonce)
      const info = must(signer.describeKey(keys.initiator))
      expect(trace.failure).toBeNull()
      const a = trace.initiator.result
      const b = trace.responder.result
      if (a === null || b === null) throw new Error('no result')
      expect(a.kind).toBe('signature')
      expect(a.signature).toHaveLength(64)
      expect(hex(b.signature)).toBe(hex(a.signature))
      expect(b.recovery).toBe(a.recovery)
      expect(hex(a.publicKey)).toBe(hex(info.publicKey))
      expect(hex(a.address)).toBe(hex(info.address))
      expect(recoveredSender(tx, a.signature, a.recovery)).toBe(
        getAddress(hex(info.address)),
      )
    }

    beforeAll(() => {
      keygenTrace = keygen()
      if (keygenTrace.failure !== null) {
        throw new Error(`keygen: ${keygenTrace.failure.error.code}`)
      }
      const a = keygenTrace.initiator.result
      const b = keygenTrace.responder.result
      if (a === null || b === null) throw new Error('keygen gave no key')
      keys = { initiator: a, responder: b }
      timings.push(
        `keygen: initiator ${keygenTrace.initiator.elapsed.toFixed(0)} ms, ` +
          `responder ${keygenTrace.responder.elapsed.toFixed(0)} ms, ` +
          `${keygenTrace.messages.length} messages, sizes ` +
          keygenTrace.messages.map(message => message.length).join('/'),
      )
    })

    afterAll(() => {
      // eslint-disable-next-line no-console
      console.info(`[${name}] ${timings.join('\n[' + name + '] ')}`)
    })

    describe('capabilities', () => {
      it('describes itself consistently', () => {
        expect(capabilities.backend).toBe(name)
        expect(capabilities.adaptorLocks).toBe(signer.locks !== undefined)
        expect(capabilities.keyTweak).toBe(signer.tweak !== undefined)
        expect(capabilities.keygenSessionExport).toBe(
          signer.keygenSessions !== undefined,
        )
      })
    })

    describe('key generation', () => {
      it('gives both parties the same key and address', () => {
        const a = must(signer.describeKey(keys.initiator))
        const b = must(signer.describeKey(keys.responder))
        expect(a.publicKey).toHaveLength(33)
        expect(a.address).toHaveLength(20)
        expect(a.keyId).toHaveLength(32)
        expect(hex(b.publicKey)).toBe(hex(a.publicKey))
        expect(hex(b.address)).toBe(hex(a.address))
        expect(hex(b.keyId)).toBe(hex(a.keyId))
        expect(a.keygenRole).toBe('initiator')
        expect(b.keygenRole).toBe('responder')
        expect(hex(a.localId)).toBe(hex(ids.initiator))
        expect(hex(a.peerId)).toBe(hex(ids.responder))
        expect(a.usable).toBe(true)
      })

      it('uses the declared number and size of messages', () => {
        expect(keygenTrace.messages).toHaveLength(capabilities.keygenMessages)
        for (const message of keygenTrace.messages) {
          expect(message.length).toBeLessThanOrEqual(
            capabilities.maxMessageBytes,
          )
        }
      })

      it('declares signing roles that match the capability', () => {
        const a = must(signer.describeKey(keys.initiator))
        const b = must(signer.describeKey(keys.responder))
        if (capabilities.roles === 'symmetric') {
          expect(a.signRoles).toEqual(['initiator', 'responder'])
          expect(b.signRoles).toEqual(['initiator', 'responder'])
        } else {
          expect(a.signRoles).toEqual(['initiator'])
          expect(b.signRoles).toEqual(['responder'])
        }
      })

      it('rejects bad arguments without starting', () => {
        const base = {
          role: 'initiator' as Role,
          sessionId: rng(32),
          localId: ids.initiator,
          peerId: ids.responder,
          randomBytes: rng,
        }
        for (const bad of [
          { ...base, sessionId: rng(31) },
          { ...base, peerId: ids.initiator },
          { ...base, localId: new Uint8Array(0) },
        ]) {
          const started = signer.startKeygen(bad)
          expect(started.ok).toBe(false)
          if (!started.ok) expect(started.error.code).toBe('invalid-input')
        }
      })
    })

    describe('signing', () => {
      it('signs an EIP-1559 digest that ethers recovers to the joint address', () => {
        const trace = sign(transfer(0).digest)
        expectValid(trace, 0)
        expect(trace.messages).toHaveLength(capabilities.signMessages)
        for (const message of trace.messages) {
          expect(message.length).toBeLessThanOrEqual(
            capabilities.maxMessageBytes,
          )
        }
        timings.push(
          `sign: initiator ${trace.initiator.elapsed.toFixed(0)} ms, ` +
            `responder ${trace.responder.elapsed.toFixed(0)} ms, ` +
            `${trace.messages.length} messages, sizes ` +
            trace.messages.map(message => message.length).join('/'),
        )
      })

      it('produces a different low-s signature per session', () => {
        const one = sign(transfer(1).digest)
        const two = sign(transfer(1).digest)
        expectValid(one, 1)
        expectValid(two, 1)
        expect(
          hex(one.initiator.result?.signature ?? new Uint8Array(0)),
        ).not.toBe(hex(two.initiator.result?.signature ?? new Uint8Array(0)))
      })

      it('lets the roles swap exactly when roles are symmetric', () => {
        const { digest } = transfer(2)
        if (capabilities.roles === 'symmetric') {
          expectValid(sign(digest, { swapRoles: true }), 2)
          return
        }
        const refused = signer.startSign({
          key: keys.initiator,
          role: 'responder',
          sessionId: rng(32),
          digest,
          randomBytes: rng,
        })
        expect(refused.ok).toBe(false)
        if (!refused.ok) expect(refused.error.code).toBe('role-fixed')
      })

      it('rejects bad arguments without starting', () => {
        const base = {
          key: keys.initiator,
          role: 'initiator' as Role,
          sessionId: rng(32),
          digest: transfer(3).digest,
          randomBytes: rng,
        }
        for (const bad of [
          { ...base, digest: rng(31) },
          { ...base, sessionId: rng(33) },
          { ...base, key: { __jointSigner: 'key' } as JointKey },
        ]) {
          const started = signer.startSign(bad)
          expect(started.ok).toBe(false)
          if (!started.ok) expect(started.error.code).toBe('invalid-input')
        }
      })
    })

    describe('message rejection', () => {
      const { digest } = transfer(4)

      it('refuses garbage and keeps the session usable', () => {
        let refusals = 0
        const trace = sign(digest, {
          hooks: {
            restore(index, session) {
              for (const junk of [
                new Uint8Array(0),
                rng(10),
                rng(200),
                rng(capabilities.maxMessageBytes + 1),
              ]) {
                const refused = signer.signStep(session, junk)
                expect(refused.ok).toBe(false)
                if (!refused.ok) {
                  expect(refused.error.code).toBe('malformed-message')
                  expect(refused.error.sessionAborted).toBe(false)
                  refusals += 1
                }
              }
              void index
              return session
            },
          },
        })
        expect(refusals).toBe(4 * capabilities.signMessages)
        expectValid(trace, 4)
      })

      it('refuses a duplicated message and keeps the session usable', () => {
        const delivered: Uint8Array[] = []
        let refusals = 0
        const trace = sign(digest, {
          hooks: {
            rewrite(index, message) {
              delivered[index] = message
              return message
            },
            restore(index, session) {
              // Every earlier message of the session arrives again first:
              // the ones this party already processed and its own.
              for (const earlier of delivered.slice(0, index)) {
                const refused = signer.signStep(session, earlier)
                expect(refused.ok).toBe(false)
                if (!refused.ok) {
                  expect(['unexpected-message', 'wrong-session']).toContain(
                    refused.error.code,
                  )
                  expect(refused.error.sessionAborted).toBe(false)
                  refusals += 1
                }
              }
              return session
            },
          },
        })
        const count = capabilities.signMessages
        expect(refusals).toBe((count * (count - 1)) / 2)
        expectValid(trace, 4)
      })

      it('refuses an out-of-order message and keeps the session usable', () => {
        // A fresh responder with the same session id and digest expects
        // message 1; the later messages of a recorded run are out of order.
        const sessionId = rng(32)
        const recorded = sign(digest, { sessionId })
        expect(recorded.failure).toBeNull()
        const responder = must(
          signer.startSign({
            key: keys.responder,
            role: 'responder',
            sessionId,
            digest,
            randomBytes: rng,
          }),
        )
        for (const index of [2, 4]) {
          const late = recorded.messages[index]
          if (late === undefined) throw new Error('missing message')
          const refused = signer.signStep(responder.session, late)
          expect(refused.ok).toBe(false)
          if (!refused.ok) {
            expect(['unexpected-message', 'wrong-session']).toContain(
              refused.error.code,
            )
            expect(refused.error.sessionAborted).toBe(false)
          }
        }
        // The session still accepts its real first message.
        const first = recorded.messages[0]
        if (first === undefined) throw new Error('missing message')
        expect(signer.signStep(responder.session, first).ok).toBe(true)
      })

      it('refuses a message of another session, key generation or digest', () => {
        const other = sign(transfer(5).digest)
        const sameIdOtherDigest = rng(32)
        const third = sign(transfer(6).digest, { sessionId: sameIdOtherDigest })
        const trace = sign(digest, {
          sessionId: sameIdOtherDigest,
          hooks: {
            restore(index, session) {
              for (const foreign of [
                other.messages[index],
                third.messages[index],
                keygenTrace.messages[index],
              ]) {
                if (foreign === undefined) throw new Error('missing message')
                const refused = signer.signStep(session, foreign)
                expect(refused.ok).toBe(false)
                if (!refused.ok) {
                  expect([
                    'wrong-session',
                    'malformed-message',
                    'unexpected-message',
                  ]).toContain(refused.error.code)
                  expect(refused.error.sessionAborted).toBe(false)
                }
              }
              return session
            },
          },
        })
        expectValid(trace, 4)
      })

      it('refuses a second message for a state that was already advanced', () => {
        const stale: SignSession[] = []
        const trace = sign(digest, {
          hooks: {
            restore(index, session) {
              stale.push(session)
              return session
            },
          },
        })
        expectValid(trace, 4)
        stale.forEach((session, index) => {
          const message = trace.messages[index]
          if (message === undefined) throw new Error('missing message')
          const refused = signer.signStep(session, message)
          expect(refused.ok).toBe(false)
          if (!refused.ok) expect(refused.error.code).toBe('state-already-used')
        })
      })

      it('refuses garbage in key generation and keeps the session usable', () => {
        let refusals = 0
        const started = must(
          signer.startKeygen({
            role: 'responder',
            sessionId: rng(32),
            localId: ids.responder,
            peerId: ids.initiator,
            randomBytes: rng,
          }),
        )
        const candidates = [
          rng(64),
          keygenTrace.messages[0],
          keygenTrace.messages[2],
        ]
        for (const junk of candidates) {
          if (junk === undefined) throw new Error('missing message')
          const refused = signer.keygenStep(started.session, junk)
          expect(refused.ok).toBe(false)
          if (!refused.ok) {
            expect(refused.error.sessionAborted).toBe(false)
            refusals += 1
          }
        }
        expect(refusals).toBe(3)
        signer.abortKeygen(started.session)
        const after = signer.keygenStep(started.session, rng(64))
        expect(after.ok).toBe(false)
        if (!after.ok) expect(after.error.code).toBe('session-aborted')
      })
    })

    describe('stored state across a restart', () => {
      it('exports and imports keys into a new backend instance', () => {
        const restarted = create()
        const stored = {
          initiator: must(signer.exportKey(keys.initiator)),
          responder: must(signer.exportKey(keys.responder)),
        }
        const restored = {
          initiator: must(restarted.importKey(stored.initiator)),
          responder: must(restarted.importKey(stored.responder)),
        }
        const before = must(signer.describeKey(keys.initiator))
        const after = must(restarted.describeKey(restored.initiator))
        expect(hex(after.keyId)).toBe(hex(before.keyId))
        expect(hex(after.publicKey)).toBe(hex(before.publicKey))
        expect(after.keygenRole).toBe('initiator')
        const trace = sign(transfer(7).digest, {
          with: restored,
          backend: restarted,
        })
        expectValid(trace, 7)
        timings.push(
          `stored key: initiator ${stored.initiator.length} bytes, ` +
            `responder ${stored.responder.length} bytes`,
        )
      })

      it('refuses stored keys that are not its own', () => {
        const stored = must(signer.exportKey(keys.initiator))
        for (const bad of [
          new Uint8Array(0),
          rng(100),
          stored.subarray(0, stored.length - 1),
        ]) {
          const imported = signer.importKey(bad)
          expect(imported.ok).toBe(false)
          if (!imported.ok) expect(imported.error.code).toBe('invalid-key')
        }
      })

      it('resumes a signing session from stored state at every step', () => {
        const restarted = create()
        const stored = {
          initiator: must(signer.exportKey(keys.initiator)),
          responder: must(signer.exportKey(keys.responder)),
        }
        const restored = {
          initiator: must(restarted.importKey(stored.initiator)),
          responder: must(restarted.importKey(stored.responder)),
        }
        const sizes: number[] = []
        // Both parties run on `restarted`; before every delivery the
        // recipient's state goes to bytes and comes back, as after a crash.
        const trace = sign(transfer(8).digest, {
          with: restored,
          backend: restarted,
          hooks: {
            restore(index, session, recipient) {
              const bytes = must(restarted.exportSignSession(session))
              sizes.push(bytes.length)
              return must(
                restarted.importSignSession({
                  state: bytes,
                  key: restored[recipient],
                  randomBytes: rng,
                }),
              )
            },
          },
        })
        expectValid(trace, 8)
        timings.push(`stored sign session sizes: ${sizes.join('/')} bytes`)
      })

      it('refuses stored signing state with the wrong key or altered bytes', () => {
        const started = must(
          signer.startSign({
            key: keys.initiator,
            role: 'initiator',
            sessionId: rng(32),
            digest: transfer(9).digest,
            randomBytes: rng,
          }),
        )
        const bytes = must(signer.exportSignSession(started.session))
        const wrongKey = signer.importSignSession({
          state: bytes,
          key: keys.responder,
          randomBytes: rng,
        })
        expect(wrongKey.ok).toBe(false)
        for (const bad of [rng(50), bytes.subarray(0, bytes.length - 3)]) {
          const imported = signer.importSignSession({
            state: bad,
            key: keys.initiator,
            randomBytes: rng,
          })
          expect(imported.ok).toBe(false)
          if (!imported.ok) expect(imported.error.code).toBe('invalid-state')
        }
        signer.abortSign(started.session)
      })

      it('resumes key generation from stored state when the backend can', () => {
        const feature = signer.keygenSessions
        if (feature === undefined) {
          expect(capabilities.keygenSessionExport).toBe(false)
          return
        }
        const restarted = create()
        const restartedFeature = restarted.keygenSessions
        if (restartedFeature === undefined) throw new Error('no feature')
        const sizes: number[] = []
        const trace = keygen(
          {
            restore(index, session) {
              const bytes = must(restartedFeature.exportKeygenSession(session))
              sizes.push(bytes.length)
              return must(
                restartedFeature.importKeygenSession({
                  state: bytes,
                  randomBytes: rng,
                }),
              )
            },
          },
          restarted,
        )
        expect(trace.failure).toBeNull()
        const a = trace.initiator.result
        const b = trace.responder.result
        if (a === null || b === null) throw new Error('no key')
        const fresh = { initiator: a, responder: b }
        const info = must(restarted.describeKey(a))
        const signed = sign(transfer(10).digest, {
          with: fresh,
          backend: restarted,
        })
        expect(signed.failure).toBeNull()
        const result = signed.initiator.result
        if (result === null) throw new Error('no result')
        expect(
          recoveredSender(transfer(10).tx, result.signature, result.recovery),
        ).toBe(getAddress(hex(info.address)))
        timings.push(`stored keygen session sizes: ${sizes.join('/')} bytes`)
        timings.push(
          `second keygen with the same peer: initiator ` +
            `${trace.initiator.elapsed.toFixed(0)} ms, responder ` +
            `${trace.responder.elapsed.toFixed(
              0,
            )} ms (includes state export/import)`,
        )
      })
    })

    describe('adaptor pre-signing capability', () => {
      it('cannot be reached on a backend without it', () => {
        if (signer.locks !== undefined) {
          expect(signer.capabilities.adaptorLocks).toBe(true)
          expect(typeof signer.locks.startPreSign).toBe('function')
          return
        }
        const plain: PlainJointSigner = signer
        expect(plain.capabilities.adaptorLocks).toBe(false)
        expect(plain.locks).toBeUndefined()
        expect('locks' in plain).toBe(false)
        // @ts-expect-error A backend without locks has nothing to call.
        expect(() => plain.locks.startPreSign).toThrow()
      })

      it('refuses a tweak on a backend without key tweaks', () => {
        const started = signer.startSign({
          key: keys.initiator,
          role: 'initiator',
          sessionId: rng(32),
          digest: transfer(11).digest,
          tweakCommitment: rng(32),
          randomBytes: rng,
        })
        if (capabilities.keyTweak) {
          expect(started.ok).toBe(true)
          if (started.ok) signer.abortSign(started.value.session)
          return
        }
        expect(started.ok).toBe(false)
        if (!started.ok) expect(started.error.code).toBe('unsupported')
      })

      it('pre-signs, completes and extracts where the backend has locks', () => {
        const locks = signer.locks
        if (locks === undefined) return
        const { tx, digest } = transfer(12)
        const info = must(signer.describeKey(keys.initiator))
        const creator = keys[locks.lockCreator]
        const value = 7
        const material = must(
          locks.createCommitmentLock({ key: creator, value, randomBytes: rng }),
        )
        const lock = {
          kind: 'commitment' as const,
          commitment: material.commitment,
          proof: material.proof,
          index: value,
        }
        const sessionId = rng(32)
        const trace = drive(
          role =>
            locks.startPreSign({
              key: keys[role],
              role,
              sessionId,
              digest,
              lock,
              randomBytes: rng,
            }),
          (session, message) => locks.preSignStep(session, message),
        )
        expect(trace.failure).toBeNull()
        const pre = trace.initiator.result
        if (pre === null) throw new Error('no pre-signature')
        expect(pre.kind).toBe('adaptor-signature')
        expect(pre.adaptorSignature).toHaveLength(162)
        const completed = must(
          locks.completeCommitmentLock({
            publicKey: pre.publicKey,
            commitment: material.commitment,
            index: value,
            digest,
            adaptorSignature: pre.adaptorSignature,
            secret: material.secret,
          }),
        )
        expect(
          recoveredSender(tx, completed.signature, completed.recovery),
        ).toBe(getAddress(hex(info.address)))
        const extracted = must(
          locks.extractCommitmentLockSecret({
            publicKey: pre.publicKey,
            commitment: material.commitment,
            index: value,
            digest,
            adaptorSignature: pre.adaptorSignature,
            completedSignature: completed.signature,
          }),
        )
        expect(hex(extracted)).toBe(hex(material.secret))
        timings.push(
          `pre-sign: initiator ${trace.initiator.elapsed.toFixed(0)} ms, ` +
            `responder ${trace.responder.elapsed.toFixed(0)} ms`,
        )
      })
    })

    describe('a destroyed key', () => {
      it('refuses to sign or export', () => {
        const restored = must(
          signer.importKey(must(signer.exportKey(keys.initiator))),
        )
        expect(must(signer.destroyKey(restored))).toBe(true)
        const described = signer.describeKey(restored)
        if (described.ok) expect(described.value.usable).toBe(false)
        const started = signer.startSign({
          key: restored,
          role: 'initiator',
          sessionId: rng(32),
          digest: transfer(13).digest,
          randomBytes: rng,
        })
        expect(started.ok).toBe(false)
        if (!started.ok) {
          expect(started.error.code).toBe('key-unusable')
          expect(started.error.keyUnusable).toBe(true)
        }
        expect(signer.exportKey(restored).ok).toBe(false)
      })
    })
    // Last on purpose: on a backend whose abort rule burns the key share,
    // an altered message can leave `keys` unusable for good.
    describe('an altered message body', () => {
      it('aborts the session and never yields a wrong signature', () => {
        const { digest } = transfer(14)
        let aborted = 0
        for (let target = 0; target < capabilities.signMessages; target += 1) {
          const trace = sign(digest, {
            hooks: {
              rewrite(index, message) {
                return index === target
                  ? flip(message, message.length - 1)
                  : message
              },
            },
          })
          const failed = trace.failure
          if (failed === null) {
            // The altered bit did not matter to the protocol: the result
            // must still be a valid signature of the right digest.
            expectValid(trace, 14)
            continue
          }
          aborted += 1
          expect(failed.error.sessionAborted).toBe(true)
          expect(failed.index).toBeGreaterThanOrEqual(target)
          // Whoever failed got no signature and its session is dead.
          const victim =
            failed.index % 2 === 0 ? trace.responder : trace.initiator
          expect(victim.result).toBeNull()
          const again = signer.signStep(
            victim.session,
            trace.messages[failed.index] ?? new Uint8Array(0),
          )
          expect(again.ok).toBe(false)
          if (failed.error.keyUnusable) {
            const refused = signer.startSign({
              key: failed.index % 2 === 0 ? keys.responder : keys.initiator,
              role: failed.index % 2 === 0 ? 'responder' : 'initiator',
              sessionId: rng(32),
              digest,
              randomBytes: rng,
            })
            expect(refused.ok).toBe(false)
            if (!refused.ok) expect(refused.error.code).toBe('key-unusable')
            break
          }
        }
        expect(aborted).toBeGreaterThan(0)
      })
    })
  })
}
