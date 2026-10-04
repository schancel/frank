/**
 * Prints how long each party spends in key generation and signing. The
 * numbers are informational; the only assertion is that the protocols finish.
 */
import { randomBytes } from 'crypto'

import {
  createPointLock,
  keygenStep,
  signStep,
  startKeygen,
  startSign,
  type KeyShare,
} from './index.js'
import { ascii, must } from './test-support.js'

const rng = (length: number): Uint8Array => new Uint8Array(randomBytes(length))

interface StepLike<S, R> {
  session: S
  outgoing: Uint8Array | null
  result: R | null
}

function timed<S, R>(
  start: (role: 'initiator' | 'responder') => StepLike<S, R>,
  step: (session: S, message: Uint8Array) => StepLike<S, R>,
): {
  initiatorMs: number
  responderMs: number
  results: (R | null)[]
  perMessage: number[]
} {
  const clock = () => Number(process.hrtime.bigint()) / 1e6
  let t = clock()
  let initiator = start('initiator')
  let initiatorMs = clock() - t
  t = clock()
  let responder = start('responder')
  let responderMs = clock() - t
  const perMessage: number[] = []
  let outgoing = initiator.outgoing
  let toResponder = true
  while (outgoing !== null) {
    t = clock()
    if (toResponder) {
      responder = step(responder.session, outgoing)
      outgoing = responder.outgoing
      responderMs += clock() - t
    } else {
      initiator = step(initiator.session, outgoing)
      outgoing = initiator.outgoing
      initiatorMs += clock() - t
    }
    perMessage.push(Math.round(clock() - t))
    toResponder = !toResponder
  }
  return {
    initiatorMs,
    responderMs,
    results: [initiator.result, responder.result],
    perMessage,
  }
}

it('reports key generation and signing time per party', () => {
  const keygenSession = rng(32)
  const keygen = timed<unknown, KeyShare>(
    role =>
      must(
        startKeygen({
          role,
          sessionId: keygenSession,
          localId: ascii(role === 'initiator' ? 'alice' : 'bob'),
          peerId: ascii(role === 'initiator' ? 'bob' : 'alice'),
          randomBytes: rng,
        }),
      ),
    (session, message) => must(keygenStep(session as never, message)),
  )
  const [a, b] = keygen.results
  expect(a).not.toBeNull()
  expect(b).not.toBeNull()
  const runs = 5
  const totals = { plainI: 0, plainR: 0, adaptorI: 0, adaptorR: 0 }
  for (let run = 0; run < runs; run += 1) {
    for (const adaptor of [false, true]) {
      const sessionId = rng(32)
      const digest = rng(32)
      const made = adaptor
        ? must(createPointLock({ keyShare: b!, randomBytes: rng }))
        : undefined
      const signed = timed(
        role =>
          must(
            startSign({
              keyShare: role === 'initiator' ? a! : b!,
              sessionId,
              digest,
              lock: made?.lock,
              lockOpening: role === 'responder' ? made?.opening : undefined,
              randomBytes: rng,
            }),
          ),
        (session, message) => must(signStep(session, message)),
      )
      expect(signed.results[0]).not.toBeNull()
      expect(signed.results[1]).toEqual(signed.results[0])
      if (adaptor) {
        totals.adaptorI += signed.initiatorMs
        totals.adaptorR += signed.responderMs
      } else {
        totals.plainI += signed.initiatorMs
        totals.plainR += signed.responderMs
      }
    }
  }
  const ms = (value: number) => `${Math.round(value)} ms`
  // eslint-disable-next-line no-console
  console.log(
    [
      'threshold-ecdsa timing (single thread, under jest)',
      `keygen initiator: ${ms(keygen.initiatorMs)}`,
      `keygen responder: ${ms(keygen.responderMs)}`,
      `keygen per message (recipient's processing): ${keygen.perMessage.join(
        ', ',
      )} ms`,
      `sign initiator:   ${ms(totals.plainI / runs)} (mean of ${runs})`,
      `sign responder:   ${ms(totals.plainR / runs)}`,
      `adaptor initiator: ${ms(totals.adaptorI / runs)}`,
      `adaptor responder: ${ms(totals.adaptorR / runs)}`,
    ].join('\n'),
  )
})
