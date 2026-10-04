import { equalBytes } from './bytes.js'
import { G, multiply, parsePoint, pointBytes } from './group.js'
import {
  describeKeyShare,
  destroyKeyShare,
  exportKeyShare,
  importKeyShare,
  internalShare,
  type KeyShare,
} from './key-share.js'
import {
  abortKeygen,
  KEYGEN_MESSAGES,
  keygenStep,
  startKeygen,
  type KeygenSession,
} from './keygen.js'
import { ascii, drive, flip, hex, must, rng, type DriveHooks } from './test-support.js'
import { bit, bytesToInt } from './bytes.js'
import { HEADER_BYTES, MAX_MESSAGE_BYTES } from './wire.js'

const ids = { initiator: ascii('alice'), responder: ascii('bob') }

function keygen(hooks?: DriveHooks<KeygenSession>, sessionId = rng(32)) {
  return drive<KeygenSession, KeyShare>(
    role =>
      startKeygen({
        role,
        sessionId,
        localId: ids[role],
        peerId: ids[role === 'initiator' ? 'responder' : 'initiator'],
        randomBytes: rng,
      }),
    keygenStep,
    hooks,
  )
}

describe('key generation', () => {
  const trace = keygen()
  const a = trace.initiator.result
  const b = trace.responder.result
  if (a === null || b === null) throw new Error('no key')

  it('gives both parties one key and matching setup halves', () => {
    expect(trace.failure).toBeNull()
    expect(trace.messages).toHaveLength(KEYGEN_MESSAGES)
    for (const message of trace.messages) {
      expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES)
    }
    const ia = must(describeKeyShare(a))
    const ib = must(describeKeyShare(b))
    expect(hex(ia.publicKey)).toBe(hex(ib.publicKey))
    expect(hex(ia.keyId)).toBe(hex(ib.keyId))
    expect(hex(ia.address)).toBe(hex(ib.address))
    expect(ia.keygenRole).toBe('initiator')
    expect(ib.keygenRole).toBe('responder')
    expect(ia.usable && ib.usable).toBe(true)

    const sa = internalShare(a)
    const sb = internalShare(b)
    // The shares add up to the joint key.
    const sum = multiply(G, bytesToInt(sa.secret)).add(
      multiply(G, bytesToInt(sb.secret)),
    )
    expect(hex(pointBytes(sum))).toBe(hex(ia.publicKey))
    expect(hex(sa.peerPublicShare)).toBe(hex(sb.publicShare))
    void parsePoint
    // Each party's single seeds are the other's pair selected by its Delta.
    for (const [single, pair] of [
      [sa, sb],
      [sb, sa],
    ] as const) {
      for (let j = 0; j < 128; j += 1) {
        const choice = bit(single.delta, j)
        expect(
          equalBytes(
            single.seeds.subarray(32 * j, 32 * j + 32),
            pair.seedPairs.subarray(32 * (2 * j + choice), 32 * (2 * j + choice + 1)),
          ),
        ).toBe(true)
        expect(
          equalBytes(
            single.seeds.subarray(32 * j, 32 * j + 32),
            pair.seedPairs.subarray(32 * (2 * j + 1 - choice), 32 * (2 * j + 2 - choice)),
          ),
        ).toBe(false)
      }
    }
  })

  it('makes a different key every time, even with a repeated session id', () => {
    const sessionId = rng(32)
    const one = keygen(undefined, sessionId)
    const two = keygen(undefined, sessionId)
    const k1 = must(describeKeyShare(one.initiator.result as KeyShare))
    const k2 = must(describeKeyShare(two.initiator.result as KeyShare))
    expect(hex(k1.publicKey)).not.toBe(hex(k2.publicKey))
    expect(hex(k1.keyId)).not.toBe(hex(k2.keyId))
  })

  it('exports and imports a share, authenticated', () => {
    const stored = must(exportKeyShare(a))
    const restored = must(importKeyShare(stored))
    expect(hex(must(exportKeyShare(restored)))).toBe(hex(stored))
    // Any altered byte, including in the seeds or the peer's public share,
    // is refused before the content is used.
    for (const index of [0, 4, 5, 40, 120, 1000, stored.length - 1]) {
      const imported = importKeyShare(flip(stored, index))
      expect(imported.ok).toBe(false)
      if (!imported.ok) expect(imported.error.code).toBe('invalid-key-share')
    }
    for (const bad of [new Uint8Array(0), rng(100), stored.subarray(0, stored.length - 1)]) {
      expect(importKeyShare(bad).ok).toBe(false)
    }
    expect(must(destroyKeyShare(restored))).toBe(true)
    expect(exportKeyShare(restored).ok).toBe(false)
    expect(must(describeKeyShare(restored)).usable).toBe(false)
    // Destroying one handle leaves the others alone.
    expect(must(describeKeyShare(a)).usable).toBe(true)
  })

  it('rejects bad arguments', () => {
    const base = {
      role: 'initiator' as const,
      sessionId: rng(32),
      localId: ids.initiator,
      peerId: ids.responder,
      randomBytes: rng,
    }
    for (const bad of [
      { ...base, sessionId: rng(31) },
      { ...base, peerId: ids.initiator },
      { ...base, localId: new Uint8Array(0) },
      { ...base, localId: rng(65) },
    ]) {
      const started = startKeygen(bad)
      expect(started.ok).toBe(false)
      if (!started.ok) expect(started.error.code).toBe('invalid-input')
    }
  })

  it('aborts on every altered message, at every field', () => {
    // One flipped bit in each field of each message. The recipient of the
    // altered message (or, for fields only checked later, a later step) must
    // abort; nobody may end with a key the other does not share.
    const offsets: Record<number, number[]> = {
      0: [0, 40, 70, 129],
      1: [0, 40, 70, 110, 200, 300, 4000],
      2: [5, 40, 70, 150, 4000, 4500, 8000],
      3: [10, 4000, 4100, 8000],
      4: [10, 5000, 8200, 12000],
      5: [10, 8000],
    }
    for (let target = 0; target < KEYGEN_MESSAGES; target += 1) {
      for (const offset of offsets[target] ?? []) {
        const altered = keygen({
          rewrite: (index, message) =>
            index === target ? flip(message, HEADER_BYTES + offset) : message,
        })
        const failed = altered.failure
        if (failed === null) {
          throw new Error(`message ${target + 1} offset ${offset} was accepted`)
        }
        expect(failed.error.sessionAborted).toBe(true)
        expect(failed.error.peerFault).toBe(true)
        expect(failed.error.keyBurned).toBe(false)
        expect(failed.index).toBeGreaterThanOrEqual(target)
        const ka = altered.initiator.result
        const kb = altered.responder.result
        // The initiator never holds a key after a failure anywhere.
        expect(ka).toBeNull()
        if (kb !== null) {
          // Only possible when the very last message was altered.
          expect(target).toBe(5)
        }
      }
    }
  })

  it('refuses stray frames without aborting, and refuses a used state', () => {
    const started = must(
      startKeygen({
        role: 'responder',
        sessionId: rng(32),
        localId: ids.responder,
        peerId: ids.initiator,
        randomBytes: rng,
      }),
    )
    for (const [junk, code] of [
      [rng(64), 'malformed-message'],
      [trace.messages[0], 'wrong-session'],
      [rng(MAX_MESSAGE_BYTES + 1), 'malformed-message'],
    ] as const) {
      const refused = keygenStep(started.session, junk as Uint8Array)
      expect(refused.ok).toBe(false)
      if (!refused.ok) {
        expect(refused.error.code).toBe(code)
        expect(refused.error.sessionAborted).toBe(false)
      }
    }
    abortKeygen(started.session)
    const after = keygenStep(started.session, rng(64))
    expect(!after.ok && after.error.code).toBe('session-aborted')

    const stale: KeygenSession[] = []
    const again = keygen({
      restore: (index, session) => {
        stale.push(session)
        return session
      },
    })
    expect(again.failure).toBeNull()
    stale.forEach((session, index) => {
      const refused = keygenStep(session, again.messages[index] as Uint8Array)
      expect(!refused.ok && refused.error.code).toBe('state-already-used')
    })
  })

  it('reports timing', () => {
    const run = keygen()
    // eslint-disable-next-line no-console
    console.info(
      `keygen: initiator ${run.initiator.elapsed.toFixed(0)} ms, responder ` +
        `${run.responder.elapsed.toFixed(0)} ms, sizes ` +
        run.messages.map(message => message.length).join('/'),
    )
  })
})
