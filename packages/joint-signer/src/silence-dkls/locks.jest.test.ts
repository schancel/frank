/**
 * Lock and storage tests specific to the silence-dkls backend. The
 * backend-neutral rules are in `../conformance.ts`.
 */
import { randomBytes as nodeRandomBytes } from 'crypto'
import { performance } from 'perf_hooks'
import { getAddress, Signature, Transaction } from 'ethers'
import {
  completeAdaptorSignature,
  extractAdaptorSecret,
  verifyAdaptorSignature,
} from '@frank/adaptor-signatures'
import { pointBytes } from '@frank/adaptor-signatures/src/curve.js'
import {
  PEDERSEN_H as LINDELL_H,
  resolveLock,
} from '@frank/threshold-ecdsa/src/lock.js'

import {
  createCommitmentLock,
  createPointLock,
  encodeLock,
  PEDERSEN_H,
} from '../locks.js'
import type {
  JointKey,
  JointLock,
  JointLockOpening,
  JointPreSignature,
  JointSignerResult,
  PreSignSession,
  Role,
  Step,
} from '../types.js'
import { loadSilenceDklsNode } from './load-node.js'

const rng = (length: number): Uint8Array =>
  new Uint8Array(nodeRandomBytes(length))

const hex = (bytes: Uint8Array): string =>
  '0x' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

const ascii = (text: string): Uint8Array =>
  Uint8Array.from(text, character => character.charCodeAt(0))

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

function senderOf(tx: Transaction, signature: Uint8Array): string[] {
  return [0, 1].map(yParity => {
    const signed = tx.clone()
    signed.signature = Signature.from({
      r: hex(signature.subarray(0, 32)),
      s: hex(signature.subarray(32, 64)),
      yParity: yParity as 0 | 1,
    })
    return Transaction.from(signed.serialized).from ?? ''
  })
}

describe('silence-dkls locks', () => {
  const signer = loadSilenceDklsNode()
  const locks = signer.locks
  const ids = { initiator: ascii('alice'), responder: ascii('bob') }
  const timings: string[] = []
  let keys: { initiator: JointKey; responder: JointKey }
  let keyId: Uint8Array
  let publicKey: Uint8Array
  let address: string

  interface Run {
    readonly messages: Uint8Array[]
    readonly results: Record<Role, JointPreSignature | null>
    readonly elapsed: Record<Role, number>
    readonly failure: { index: number; code: string; peerFault: boolean } | null
  }

  /** Runs a pre-signing session; each role may use its own lock and digest. */
  function preSign(options: {
    readonly lock: JointLock | Record<Role, JointLock>
    readonly opening: JointLockOpening
    readonly digest: Uint8Array | Record<Role, Uint8Array>
    readonly rewrite?: (index: number, message: Uint8Array) => Uint8Array
  }): Run {
    const sessionId = rng(32)
    const pick = <T>(value: T | Record<Role, T>, role: Role): T =>
      value !== null &&
      typeof value === 'object' &&
      'initiator' in (value as object) &&
      'responder' in (value as object)
        ? (value as Record<Role, T>)[role]
        : (value as T)
    const elapsed = { initiator: 0, responder: 0 }
    const timed = <T>(role: Role, call: () => T): T => {
      const started = performance.now()
      try {
        return call()
      } finally {
        elapsed[role] += performance.now() - started
      }
    }
    const start = (role: Role): Step<PreSignSession, JointPreSignature> =>
      must(
        timed(role, () =>
          locks.startPreSign({
            key: keys[role],
            role,
            sessionId,
            digest: pick<Uint8Array>(options.digest, role),
            lock: pick<JointLock>(options.lock, role),
            ...(role === 'responder' ? { lockOpening: options.opening } : {}),
            randomBytes: rng,
          }),
        ),
      )
    const sessions = {
      initiator: start('initiator'),
      responder: start('responder'),
    }
    const results: Record<Role, JointPreSignature | null> = {
      initiator: null,
      responder: null,
    }
    const messages: Uint8Array[] = []
    let failure: Run['failure'] = null
    let outgoing = sessions.initiator.outgoing
    let to: Role = 'responder'
    while (outgoing !== null) {
      const index = messages.length
      const delivered = options.rewrite?.(index, outgoing) ?? outgoing
      messages.push(delivered)
      const recipient = to
      const stepped = timed(recipient, () =>
        locks.preSignStep(sessions[recipient].session, delivered),
      )
      if (!stepped.ok) {
        failure = {
          index,
          code: stepped.error.code,
          peerFault: stepped.error.peerFault,
        }
        break
      }
      sessions[recipient] = stepped.value
      results[recipient] = stepped.value.result ?? results[recipient]
      outgoing = stepped.value.outgoing
      to = to === 'responder' ? 'initiator' : 'responder'
    }
    return { messages, results, elapsed, failure }
  }

  function commitmentLock(value: number, index: number) {
    const material = must(
      locks.createCommitmentLock({
        key: keys.responder,
        value,
        randomBytes: rng,
      }),
    )
    const lock: JointLock = {
      kind: 'commitment',
      commitment: material.commitment,
      proof: material.proof,
      index,
    }
    return { material, lock, opening: material.opening }
  }

  beforeAll(() => {
    const sessionId = rng(32)
    const start = (role: Role) =>
      must(
        signer.startKeygen({
          role,
          sessionId,
          localId: ids[role],
          peerId: ids[role === 'initiator' ? 'responder' : 'initiator'],
          randomBytes: rng,
        }),
      )
    const sessions = {
      initiator: start('initiator'),
      responder: start('responder'),
    }
    let outgoing = sessions.initiator.outgoing
    let to: Role = 'responder'
    while (outgoing !== null) {
      const stepped = must(signer.keygenStep(sessions[to].session, outgoing))
      sessions[to] = stepped
      outgoing = stepped.outgoing
      to = to === 'responder' ? 'initiator' : 'responder'
    }
    const a = sessions.initiator.result
    const b = sessions.responder.result
    if (a === null || b === null) throw new Error('no key')
    keys = { initiator: a, responder: b }
    const info = must(signer.describeKey(a))
    keyId = info.keyId
    publicKey = info.publicKey
    address = getAddress(hex(info.address))
  })

  afterAll(() => {
    // eslint-disable-next-line no-console
    console.info(
      `[silence-dkls locks] ${timings.join('\n[silence-dkls locks] ')}`,
    )
  })

  it('uses the lock definitions of @frank/threshold-ecdsa byte for byte', () => {
    expect(hex(pointBytes(PEDERSEN_H))).toBe(hex(pointBytes(LINDELL_H)))
    // Locks made here are accepted by that package's own verifier for the
    // same key id and holder, and resolve to the same point and encoding.
    const point = must(
      createPointLock({ keyId, holderId: ids.responder, randomBytes: rng }),
    )
    const resolvedPoint = resolveLock(point.lock as never, keyId, ids.responder)
    expect(hex(resolvedPoint.point)).toBe(
      hex((point.lock as { point: Uint8Array }).point),
    )
    expect(hex(resolvedPoint.encoded)).toBe(
      hex(encodeLock(point.lock) ?? new Uint8Array(0)),
    )
    const committed = must(
      createCommitmentLock({
        keyId,
        holderId: ids.responder,
        value: 9,
        randomBytes: rng,
      }),
    )
    const lock: JointLock = {
      kind: 'commitment',
      commitment: committed.commitment,
      proof: committed.proof,
      index: 4,
    }
    const resolved = resolveLock(lock as never, keyId, ids.responder)
    expect(hex(resolved.point)).toBe(
      hex(must(locks.commitmentLockPoint(committed.commitment, 4))),
    )
    expect(hex(resolved.encoded)).toBe(
      hex(encodeLock(lock) ?? new Uint8Array(0)),
    )
    // And they are bound: another key or another holder is refused there too.
    expect(() => resolveLock(lock as never, rng(32), ids.responder)).toThrow()
    expect(() => resolveLock(lock as never, keyId, ids.initiator)).toThrow()
  })

  it('point lock: pre-sign, verify, complete and extract with @frank/adaptor-signatures', () => {
    const { tx, digest } = transfer(0)
    const material = must(
      locks.createPointLock({ key: keys.responder, randomBytes: rng }),
    )
    const lock = material.lock
    const run = preSign({
      lock,
      opening: material.opening,
      digest,
    })
    expect(run.failure).toBeNull()
    const pre = run.results.initiator
    const other = run.results.responder
    if (pre === null || other === null) throw new Error('no pre-signature')
    expect(hex(other.adaptorSignature)).toBe(hex(pre.adaptorSignature))
    expect(pre.adaptorSignature).toHaveLength(162)
    expect(hex(pre.publicKey)).toBe(hex(publicKey))
    expect(run.messages).toHaveLength(5)

    const common = {
      publicKey,
      adaptorPoint: lock.point as never,
      adaptorProof: lock.proof as never,
      digest,
      signature: pre.adaptorSignature as never,
    }
    expect(verifyAdaptorSignature(common)).toEqual({ ok: true, value: true })
    // Not valid for another digest or another key.
    expect(
      verifyAdaptorSignature({ ...common, digest: transfer(1).digest }),
    ).not.toEqual({ ok: true, value: true })

    // The pre-signature itself is not a signature of the joint key.
    const raw = Uint8Array.from([
      ...pre.adaptorSignature.subarray(1, 33),
      ...pre.adaptorSignature.subarray(66, 98),
    ])
    let rawSenders: string[] = []
    try {
      rawSenders = senderOf(tx, raw)
    } catch {
      rawSenders = []
    }
    expect(rawSenders).not.toContain(address)

    const startedComplete = performance.now()
    const completed = completeAdaptorSignature({
      ...common,
      secret: material.secret as never,
    })
    const completeMs = performance.now() - startedComplete
    if (!completed.ok) throw new Error(completed.error.code)
    expect(senderOf(tx, completed.value as unknown as Uint8Array)).toContain(
      address,
    )
    const startedExtract = performance.now()
    const extracted = extractAdaptorSecret({
      ...common,
      completedSignature: completed.value,
    })
    const extractMs = performance.now() - startedExtract
    if (!extracted.ok) throw new Error(extracted.error.code)
    expect(hex(extracted.value as unknown as Uint8Array)).toBe(
      hex(material.secret),
    )
    timings.push(
      `point-lock pre-sign: initiator ${run.elapsed.initiator.toFixed(
        0,
      )} ms, ` +
        `responder ${run.elapsed.responder.toFixed(0)} ms, sizes ` +
        run.messages.map(message => message.length).join('/'),
      `complete ${completeMs.toFixed(1)} ms, extract ${extractMs.toFixed(
        1,
      )} ms`,
    )
  })

  it('commitment lock: only the committed candidate can be completed', () => {
    const { tx, digest } = transfer(2)
    const value = 5
    const base = commitmentLock(value, value)
    const { material, opening } = base
    let committedMs = ''
    for (const index of [0, value, 51]) {
      const lock: JointLock = { ...base.lock, index } as JointLock
      const run = preSign({ lock, opening, digest })
      expect(run.failure).toBeNull()
      const pre = run.results.initiator
      if (pre === null) throw new Error('no pre-signature')
      const completed = locks.completeCommitmentLock({
        publicKey: pre.publicKey,
        commitment: material.commitment,
        index,
        digest,
        adaptorSignature: pre.adaptorSignature,
        secret: material.secret,
      })
      expect(completed.ok).toBe(index === value)
      if (completed.ok) {
        expect(
          senderOf(tx, completed.value.signature)[completed.value.recovery],
        ).toBe(address)
        const extracted = must(
          locks.extractCommitmentLockSecret({
            publicKey: pre.publicKey,
            commitment: material.commitment,
            index,
            digest,
            adaptorSignature: pre.adaptorSignature,
            completedSignature: completed.value.signature,
          }),
        )
        expect(hex(extracted)).toBe(hex(material.secret))
        committedMs =
          `commitment-lock pre-sign: initiator ${run.elapsed.initiator.toFixed(
            0,
          )} ms, ` +
          `responder ${run.elapsed.responder.toFixed(0)} ms, sizes ` +
          run.messages.map(message => message.length).join('/')
      }
      // A pre-signature for one candidate does not verify under another.
      const wrongIndex = locks.extractCommitmentLockSecret({
        publicKey: pre.publicKey,
        commitment: material.commitment,
        index: index + 1,
        digest,
        adaptorSignature: pre.adaptorSignature,
        completedSignature: rng(64),
      })
      expect(wrongIndex.ok).toBe(false)
    }
    timings.push(committedMs)
  })

  it('blocks a lock the other party made in the holder’s name', () => {
    const { digest } = transfer(3)
    // The initiator picks its own secret and builds a lock whose proofs name
    // the responder as holder. Every public proof verifies.
    const forged = must(
      createCommitmentLock({
        keyId,
        holderId: ids.responder,
        value: 1,
        randomBytes: rng,
      }),
    )
    const lock: JointLock = {
      kind: 'commitment',
      commitment: forged.commitment,
      proof: forged.proof,
      index: 1,
    }
    const initiator = locks.startPreSign({
      key: keys.initiator,
      role: 'initiator',
      sessionId: rng(32),
      digest,
      lock,
      randomBytes: rng,
    })
    expect(initiator.ok).toBe(true)
    // The responder is the holder and has no opening of this lock: it never
    // starts, whatever it passes.
    const own = commitmentLock(1, 1)
    for (const opening of [undefined, own.opening]) {
      const responder = locks.startPreSign({
        key: keys.responder,
        role: 'responder',
        sessionId: rng(32),
        digest,
        lock,
        ...(opening === undefined ? {} : { lockOpening: opening }),
        randomBytes: rng,
      })
      expect(responder.ok).toBe(false)
      if (!responder.ok) expect(responder.error.code).toBe('lock-not-owned')
    }
  })

  it('refuses locks without valid proofs for this key and holder', () => {
    const { digest } = transfer(4)
    const good = commitmentLock(2, 2)
    const start = (role: Role, lock: JointLock, opening?: JointLockOpening) =>
      locks.startPreSign({
        key: keys[role],
        role,
        sessionId: rng(32),
        digest,
        lock,
        ...(opening === undefined ? {} : { lockOpening: opening }),
        randomBytes: rng,
      })
    expect(start('initiator', good.lock).ok).toBe(true)
    const commitment = good.lock as JointLock & { kind: 'commitment' }
    const bad: JointLock[] = [
      // Made for another key.
      (() => {
        const other = must(
          createCommitmentLock({
            keyId: rng(32),
            holderId: ids.responder,
            value: 2,
            randomBytes: rng,
          }),
        )
        return {
          ...commitment,
          commitment: other.commitment,
          proof: other.proof,
        }
      })(),
      // Held by the initiator: the holder must be the responder.
      (() => {
        const other = must(
          locks.createCommitmentLock({
            key: keys.initiator,
            value: 2,
            randomBytes: rng,
          }),
        )
        return {
          ...commitment,
          commitment: other.commitment,
          proof: other.proof,
        }
      })(),
      { ...commitment, proof: flip(commitment.proof, 40) },
      { ...commitment, proof: flip(commitment.proof, 96) },
      { ...commitment, commitment: flip(commitment.commitment, 32) },
      { ...commitment, index: -1 },
      { ...commitment, proof: commitment.proof.subarray(1) },
      // A bare point with made-up proofs.
      {
        kind: 'point',
        point: must(locks.commitmentLockPoint(commitment.commitment, 2)),
        proof: rng(65),
        ownerProof: rng(65),
      },
    ]
    for (const lock of bad) {
      const refused = start('initiator', lock)
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.error.code).toBe('invalid-input')
    }
    const point = must(
      locks.createPointLock({ key: keys.responder, randomBytes: rng }),
    )
    expect(start('initiator', point.lock).ok).toBe(true)
    for (const lock of [
      { ...point.lock, ownerProof: flip(point.lock.ownerProof, 50) },
      { ...point.lock, proof: flip(point.lock.proof, 50) },
      { ...point.lock, point: commitment.commitment },
    ] as JointLock[]) {
      expect(start('initiator', lock).ok).toBe(false)
    }
  })

  it('stops before any partial signature when the parties differ on lock, candidate or digest', () => {
    const { digest } = transfer(5)
    const a = commitmentLock(2, 2)
    const otherIndex: JointLock = { ...a.lock, index: 3 } as JointLock
    const b = commitmentLock(2, 2)
    const cases: Array<Parameters<typeof preSign>[0]> = [
      {
        lock: { initiator: otherIndex, responder: a.lock },
        opening: a.opening,
        digest,
      },
      {
        lock: { initiator: b.lock, responder: a.lock },
        opening: a.opening,
        digest,
      },
      {
        lock: a.lock,
        opening: a.opening,
        digest: { initiator: transfer(6).digest, responder: digest },
      },
    ]
    for (const options of cases) {
      const run = preSign(options)
      // The very first frame is already refused: it belongs to a session
      // with another binding. Nothing nonce-dependent has been sent.
      expect(run.failure).not.toBeNull()
      expect(run.failure?.index).toBe(0)
      expect(run.failure?.code).toBe('wrong-session')
      expect(run.results.initiator).toBeNull()
      expect(run.results.responder).toBeNull()
    }
  })

  it('aborts and yields nothing when a pre-signing message is altered', () => {
    const { digest } = transfer(7)
    const { lock, opening } = commitmentLock(4, 4)
    for (let target = 0; target < 5; target += 1) {
      for (const offset of [1, 40]) {
        const run = preSign({
          lock,
          opening,
          digest,
          rewrite: (index, message) =>
            index === target ? flip(message, message.length - offset) : message,
        })
        expect(run.failure).not.toBeNull()
        expect(run.failure?.index).toBeGreaterThanOrEqual(target)
        const victim: Role =
          (run.failure?.index ?? 0) % 2 === 0 ? 'responder' : 'initiator'
        expect(run.results[victim]).toBeNull()
      }
    }
  })

  it('keeps signing and pre-signing sessions apart', () => {
    const { digest } = transfer(8)
    const { lock, opening } = commitmentLock(1, 1)
    const sessionId = rng(32)
    const sign = must(
      signer.startSign({
        key: keys.initiator,
        role: 'initiator',
        sessionId,
        digest,
        randomBytes: rng,
      }),
    )
    const pre = must(
      locks.startPreSign({
        key: keys.responder,
        role: 'responder',
        sessionId,
        digest,
        lock,
        lockOpening: opening,
        randomBytes: rng,
      }),
    )
    if (sign.outgoing === null) throw new Error('no message')
    // A signing frame is not a pre-signing frame, even with the same session
    // id, key and digest; and the handles are not interchangeable.
    const crossed = locks.preSignStep(pre.session, sign.outgoing)
    expect(crossed.ok).toBe(false)
    if (!crossed.ok) expect(crossed.error.code).toBe('wrong-session')
    expect(signer.signStep(pre.session as never, sign.outgoing).ok).toBe(false)
    expect(locks.preSignStep(sign.session as never, sign.outgoing).ok).toBe(
      false,
    )
    expect(signer.exportSignSession(pre.session as never).ok).toBe(false)
  })

  it('refuses stored keys and stored sessions that were altered', () => {
    const storedKey = must(signer.exportKey(keys.initiator))
    for (const index of [
      5,
      8,
      20,
      200,
      storedKey.length - 40,
      storedKey.length - 1,
    ]) {
      const imported = signer.importKey(flip(storedKey, index))
      expect(imported.ok).toBe(false)
      if (!imported.ok) expect(imported.error.code).toBe('invalid-key')
    }
    expect(signer.importKey(storedKey).ok).toBe(true)

    const { digest } = transfer(9)
    const started = must(
      signer.startSign({
        key: keys.initiator,
        role: 'initiator',
        sessionId: rng(32),
        digest,
        randomBytes: rng,
      }),
    )
    const stored = must(signer.exportSignSession(started.session))
    for (const index of [
      0,
      6,
      12,
      60,
      100,
      stored.length - 40,
      stored.length - 1,
    ]) {
      const imported = signer.importSignSession({
        state: flip(stored, index),
        key: keys.initiator,
        randomBytes: rng,
      })
      expect(imported.ok).toBe(false)
      if (!imported.ok) expect(imported.error.code).toBe('invalid-state')
    }
    // The other party's share cannot authenticate it either.
    expect(
      signer.importSignSession({
        state: stored,
        key: keys.responder,
        randomBytes: rng,
      }).ok,
    ).toBe(false)
    expect(
      signer.importSignSession({
        state: stored,
        key: keys.initiator,
        randomBytes: rng,
      }).ok,
    ).toBe(true)
  })
})
