import { sha256 } from '@noble/hashes/sha256.js'

import {
  allowedLocalExit,
  createSignedSwapEvent,
  decodeSignedSwapEvent,
  encodeSignedSwapEvent,
  encodeUnsignedSwapEventCore,
  eventIdForCore,
  frame,
  reduceSwapJournal,
  signaturePreimageForCore,
  SignedSwapEvent,
  SwapManifest,
  SwapMessageDescriptor,
  UnsignedSwapEventCore,
} from './index'

const swapId = Uint8Array.from({ length: 32 }, (_, index) => index)
const keyA = new Uint8Array(32).fill(0xa1)
const keyB = new Uint8Array(32).fill(0xb2)
const zero = new Uint8Array(32)

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

function fakeSign(preimage: Uint8Array): Uint8Array {
  return sha256(preimage)
}

function core(
  overrides: Partial<UnsignedSwapEventCore> = {},
): UnsignedSwapEventCore {
  return {
    protocolVersion: 1,
    swapId,
    laneId: 0,
    messageType: 1,
    senderKeyId: keyA,
    senderRole: 0,
    sequence: 0n,
    previousEventHash: zero,
    prerequisiteEventIds: [],
    payload: Uint8Array.of(1, 2, 3),
    ...overrides,
  }
}

function signed(
  overrides: Partial<UnsignedSwapEventCore> = {},
): SignedSwapEvent {
  const result = createSignedSwapEvent({
    core: core(overrides),
    signatureAlgorithm: 7,
    sign: fakeSign,
  })
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

function encoded(event: SignedSwapEvent): Uint8Array {
  const result = encodeSignedSwapEvent(event)
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

interface TestState {
  readonly order: readonly number[]
}

function descriptor(
  params: {
    budget?: 'ordinary' | 'safety'
    roles?: readonly number[]
    slot?: (event: SignedSwapEvent) => string
    transition?: SwapMessageDescriptor<TestState>['transition']
  } = {},
): SwapMessageDescriptor<TestState> {
  return {
    budget: params.budget ?? 'ordinary',
    producerRoles: params.roles ?? [0, 1],
    effect: event => ({
      ok: true,
      value: {
        key: params.slot?.(event) ?? `event:${hex(event.eventId)}`,
        value: event.payload,
      },
    }),
    transition:
      params.transition ??
      ((state, event) => ({
        disposition: 'apply',
        state: { order: [...state.order, event.payload[0] ?? 0] },
      })),
  }
}

function manifest(
  descriptors: ReadonlyMap<number, SwapMessageDescriptor<TestState>> = new Map([
    [1, descriptor()],
  ]),
): SwapManifest<TestState> {
  return {
    swapId,
    laneId: 0,
    participants: [
      { keyId: keyA, role: 0 },
      { keyId: keyB, role: 1 },
    ],
    messageTypes: descriptors,
    initialState: { order: [] },
    verifySignature: (event, preimage) =>
      event.signatureAlgorithm === 7 &&
      hex(event.signature) === hex(fakeSign(preimage)),
  }
}

describe('v1 swap coordination event encoding', () => {
  it('uses the specified frame layout and freezes an independent event vector', () => {
    expect(hex(frame('a', Uint8Array.of(0x10, 0x20)))).toBe(
      '000161000000021020',
    )
    const encodedCore = encodeUnsignedSwapEventCore(core())
    const eventId = eventIdForCore(core())
    const preimage = signaturePreimageForCore(core())
    expect(encodedCore.ok && hex(encodedCore.value)).toBe(
      '0001000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f000001a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003010203039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
    )
    expect(eventId.ok && hex(eventId.value)).toBe(
      '215cfadb870efa20c2c40bf55fb5502b1f2ce2d04c9be7d62268e7fac9977e51',
    )
    expect(preimage.ok && hex(sha256(preimage.value))).toBe(
      '67378f84b6631e9b3b732dcb698ab927a038751f53ecee1bd89d46cccb278ac8',
    )
  })

  it('round-trips canonical bytes and snapshots caller-owned arrays', () => {
    const mutablePayload = Uint8Array.of(9, 8, 7)
    const mutableSwapId = Uint8Array.from({ length: 32 }, (_, index) => index)
    const mutableKey = new Uint8Array(32).fill(0xa1)
    const event = signed({
      swapId: mutableSwapId,
      senderKeyId: mutableKey,
      payload: mutablePayload,
    })
    const canonical = encoded(event)
    mutablePayload.fill(0)
    mutableSwapId.fill(0xff)
    mutableKey.fill(0xff)
    const decoded = decodeSignedSwapEvent(canonical)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(Array.from(decoded.value.payload)).toEqual([9, 8, 7])
    expect(hex(encoded(decoded.value))).toBe(hex(canonical))
  })

  it('rejects unsorted prerequisites, payload-hash mutation, and trailing bytes', () => {
    const high = new Uint8Array(32).fill(2)
    const low = new Uint8Array(32).fill(1)
    expect(
      encodeUnsignedSwapEventCore(core({ prerequisiteEventIds: [high, low] })),
    ).toMatchObject({ ok: false, error: { code: 'non-canonical' } })

    const canonical = encoded(signed())
    const payloadOffset = 2 + 32 + 1 + 2 + 32 + 1 + 8 + 32 + 1 + 4
    const badPayload = canonical.slice()
    badPayload[payloadOffset] ^= 1
    expect(decodeSignedSwapEvent(badPayload)).toMatchObject({
      ok: false,
      error: { code: 'non-canonical' },
    })
    expect(
      decodeSignedSwapEvent(Uint8Array.from([...canonical, 0])),
    ).toMatchObject({ ok: false, error: { code: 'bad-length' } })
    expect(
      encodeUnsignedSwapEventCore(core({ sequence: 1 as unknown as bigint })),
    ).toMatchObject({ ok: false, error: { code: 'bad-format' } })
  })

  it('binds every core field into the event id', () => {
    const base = eventIdForCore(core())
    if (!base.ok) throw new Error(base.error.code)
    const mutations: UnsignedSwapEventCore[] = [
      core({ swapId: new Uint8Array(32).fill(4) }),
      core({ laneId: 1 }),
      core({ messageType: 2 }),
      core({ senderKeyId: keyB, senderRole: 1 }),
      core({ payload: Uint8Array.of(1, 2, 4) }),
      core({ prerequisiteEventIds: [new Uint8Array(32).fill(1)] }),
    ]
    for (const mutation of mutations) {
      const id = eventIdForCore(mutation)
      expect(id.ok).toBe(true)
      if (id.ok) expect(hex(id.value)).not.toBe(hex(base.value))
    }
  })
})

describe('deterministic sender chains and reduction', () => {
  it('buffers out-of-order input, then applies prerequisites in event-id order', () => {
    const firstA = signed({ payload: Uint8Array.of(1) })
    const firstB = signed({
      senderKeyId: keyB,
      senderRole: 1,
      payload: Uint8Array.of(2),
      prerequisiteEventIds: [firstA.eventId],
    })
    const secondA = signed({
      sequence: 1n,
      previousEventHash: firstA.eventId,
      payload: Uint8Array.of(3),
      prerequisiteEventIds: [firstB.eventId],
    })

    const withoutFirst = reduceSwapJournal(
      [encoded(secondA), encoded(firstB)],
      manifest(),
    )
    expect(withoutFirst.ok).toBe(true)
    if (!withoutFirst.ok) return
    expect(withoutFirst.value.applied).toHaveLength(0)
    expect(withoutFirst.value.buffered).toHaveLength(2)

    const all = reduceSwapJournal(
      [encoded(secondA), encoded(firstB), encoded(firstA), encoded(firstA)],
      manifest(),
    )
    expect(all.ok).toBe(true)
    if (!all.ok) return
    expect(all.value.violation).toBeNull()
    expect(all.value.state.order).toEqual([1, 2, 3])
    expect(all.value.applied).toHaveLength(3)
  })

  it('detects either arrival order of two signed successors as sender equivocation', () => {
    const first = signed({ payload: Uint8Array.of(1) })
    const left = signed({
      sequence: 1n,
      previousEventHash: first.eventId,
      payload: Uint8Array.of(2),
    })
    const right = signed({
      sequence: 1n,
      previousEventHash: first.eventId,
      payload: Uint8Array.of(3),
    })
    for (const order of [
      [first, left, right],
      [right, first, left],
    ]) {
      const result = reduceSwapJournal(order.map(encoded), manifest())
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.violation).toMatchObject({ code: 'equivocation' })
        expect(result.value.applied).toHaveLength(1)
        expect(result.value.state.order).toEqual([1])
      }
    }
  })

  it('treats conflicting sequence and predecessor slots as equivocation', () => {
    const first = signed({ payload: Uint8Array.of(1) })
    const validSecond = signed({
      sequence: 1n,
      previousEventHash: first.eventId,
      payload: Uint8Array.of(2),
    })
    const wrongPredecessor = signed({
      sequence: 1n,
      previousEventHash: new Uint8Array(32).fill(8),
      payload: Uint8Array.of(3),
    })
    const wrongSequence = signed({
      sequence: 2n,
      previousEventHash: first.eventId,
      payload: Uint8Array.of(4),
    })
    for (const conflict of [wrongPredecessor, wrongSequence]) {
      const result = reduceSwapJournal(
        [first, validSecond, conflict].map(encoded),
        manifest(),
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.violation).toMatchObject({ code: 'equivocation' })
      }
    }
  })

  it('fails closed on conflicting semantic slots across otherwise independent senders', () => {
    const sharedSlot = descriptor({ slot: () => 'offer' })
    const descriptors = new Map([[1, sharedSlot]])
    const left = signed({ payload: Uint8Array.of(1) })
    const right = signed({
      senderKeyId: keyB,
      senderRole: 1,
      payload: Uint8Array.of(2),
    })
    const result = reduceSwapJournal(
      [encoded(left), encoded(right)],
      manifest(descriptors),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.violation).toMatchObject({ code: 'equivocation' })
      expect(result.value.applied).toHaveLength(1)
    }
  })

  it('advances a fresh-sequence semantic duplicate without reapplying it', () => {
    const sameSlot = descriptor({ slot: () => 'offer' })
    const first = signed({ payload: Uint8Array.of(7) })
    const duplicate = signed({
      sequence: 1n,
      previousEventHash: first.eventId,
      payload: Uint8Array.of(7),
    })
    const result = reduceSwapJournal(
      [encoded(duplicate), encoded(first)],
      manifest(new Map([[1, sameSlot]])),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.applied).toHaveLength(2)
    expect(result.value.buffered).toHaveLength(0)
    expect(result.value.state.order).toEqual([7])
  })

  it('does not let exhausted ordinary traffic consume a reserved safety slot', () => {
    const descriptors = new Map([
      [1, descriptor({ budget: 'ordinary' })],
      [2, descriptor({ budget: 'safety' })],
    ])
    const events: SignedSwapEvent[] = []
    let previous = zero
    for (let index = 0; index < 24; index += 1) {
      const event = signed({
        sequence: BigInt(index),
        previousEventHash: previous,
        payload: Uint8Array.of(index),
      })
      events.push(event)
      previous = event.eventId
    }
    const exhaustedOrdinary = signed({
      sequence: 24n,
      previousEventHash: previous,
      payload: Uint8Array.of(24),
    })
    const safety = signed({
      sequence: 24n,
      previousEventHash: previous,
      messageType: 2,
      payload: Uint8Array.of(99),
    })
    const result = reduceSwapJournal(
      [...events, exhaustedOrdinary, safety].map(encoded),
      manifest(descriptors),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.violation).toBeNull()
    expect(result.value.applied).toHaveLength(25)
    expect(result.value.state.order.at(-1)).toBe(99)
    expect(result.value.ignored.map(event => event.payload[0])).toContain(24)
  })

  it('rejects context, producer, and signature substitutions before reduction', () => {
    const event = signed()
    const wrongContext = signed({ laneId: 1 })
    expect(
      reduceSwapJournal([encoded(wrongContext)], manifest()),
    ).toMatchObject({ ok: false, error: { code: 'wrong-context' } })

    const roleRestricted = manifest(new Map([[1, descriptor({ roles: [1] })]]))
    expect(reduceSwapJournal([encoded(event)], roleRestricted)).toMatchObject({
      ok: false,
      error: { code: 'unauthorized-producer' },
    })

    const bytes = encoded(event)
    bytes[bytes.length - 1] ^= 1
    expect(reduceSwapJournal([bytes], manifest())).toMatchObject({
      ok: false,
      error: { code: 'invalid-signature' },
    })

    const throwingVerifier = {
      ...manifest(),
      verifySignature: () => {
        throw new Error('malformed signature')
      },
    }
    expect(reduceSwapJournal([encoded(event)], throwingVerifier)).toMatchObject(
      { ok: false, error: { code: 'invalid-signature' } },
    )
  })
})

describe('Stage-0 conservative exit invariant', () => {
  it('offers terminal cancel only before either authorization cutoff', () => {
    expect(
      allowedLocalExit({
        readyToFundReleased: false,
        fundingAuthorizationReleased: false,
        recoveryPlan: null,
      }),
    ).toEqual({ ok: true, value: 'terminal-cancel' })

    for (const snapshot of [
      {
        readyToFundReleased: true,
        fundingAuthorizationReleased: false,
        recoveryPlan: 'monitor' as const,
      },
      {
        readyToFundReleased: false,
        fundingAuthorizationReleased: true,
        recoveryPlan: 'refund' as const,
      },
      {
        readyToFundReleased: true,
        fundingAuthorizationReleased: true,
        recoveryPlan: 'salvage' as const,
      },
    ]) {
      expect(allowedLocalExit(snapshot)).toEqual({
        ok: true,
        value: 'stop-and-enter-recovery',
      })
    }
  })

  it('fails closed if a post-cutoff state lacks a concrete recovery plan', () => {
    expect(
      allowedLocalExit({
        readyToFundReleased: true,
        fundingAuthorizationReleased: false,
        recoveryPlan: null,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'transition-rejected' },
    })
  })
})
