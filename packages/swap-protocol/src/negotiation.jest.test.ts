import { readFileSync } from 'fs'
import { join } from 'path'
import { sha256 } from '@noble/hashes/sha256.js'
import {
  encodeCanonical,
  decodeCanonical,
  standaloneItemBudget,
  verifyAlgorithm1,
  type Encodable,
} from '@frank/codec'
import { MonadIdentity } from '../../wallet/monad-identity'
import {
  createSignedSwapEvent,
  decodeSignedSwapEvent,
  encodeSignedSwapEvent,
  signaturePreimageForCore,
  type SignedSwapEvent,
  type SwapResult,
  type UnsignedSwapEventCore,
} from './index'
import {
  TESTNET_NEGOTIATION_POLICY,
  REGTEST_PROOF_NEGOTIATION_POLICY,
  buildNegotiationOffer,
  buildNegotiationResponse,
  decodeNegotiationEvent,
  decodeNegotiationEventStandalone,
  decodeNegotiationEventSchema,
  encodeOfferPayload,
  negotiationEligibility,
  negotiationIdentityKeyId,
  negotiationTermsHash,
  reduceNegotiation,
  reduceNegotiationStandalone,
  validateAuthenticatedNegotiationEvent,
  negotiationLimits,
  type NegotiationContext,
  type AuthenticatedNegotiationContext,
} from './negotiation'

const a = MonadIdentity.fromPrivateKeyHex(`0x${'00'.repeat(31)}01`)
const b = MonadIdentity.fromPrivateKeyHex(`0x${'00'.repeat(31)}02`)
const signA = (digest: Uint8Array) =>
  new Uint8Array(a.signHash(Buffer.from(digest)))
const signB = (digest: Uint8Array) =>
  new Uint8Array(b.signHash(Buffer.from(digest)))
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex')
const fromHex = (value: string) => new Uint8Array(Buffer.from(value, 'hex'))
function must<T>(value: SwapResult<T>): T {
  if (!value.ok) throw new Error(JSON.stringify(value.error))
  return value.value
}
const context = (): NegotiationContext => ({
  swapId: new Uint8Array(32).fill(0x11),
  conversationId: new Uint8Array(16).fill(0x22),
  parties: [
    new Uint8Array(a.compressedPubKey),
    new Uint8Array(b.compressedPubKey),
  ],
  policy: { ...TESTNET_NEGOTIATION_POLICY },
})
const amounts = () => ({
  xecPrincipal: 12345n,
  evmPrincipal: 1000000000000000001n,
  expiry: 2000000000n,
})
const encoded = (event: SignedSwapEvent) => must(encodeSignedSwapEvent(event))
const offer = async (bound = context()) =>
  must(
    await buildNegotiationOffer(bound, amounts(), async digest =>
      signA(digest),
    ),
  )
const response = async (
  first: SignedSwapEvent,
  decision: 'accept' | 'reject' = 'accept',
  bound = context(),
) =>
  must(
    await buildNegotiationResponse(
      bound,
      encoded(first),
      decision,
      async digest => signB(digest),
    ),
  )
function signed(core: UnsignedSwapEventCore): SignedSwapEvent {
  return must(
    createSignedSwapEvent({
      core,
      signatureAlgorithm: 1,
      sign: preimage =>
        (core.senderRole === 0 ? signA : signB)(sha256(preimage)),
    }),
  )
}
function changePayload(
  event: SignedSwapEvent,
  change: (fields: Map<bigint, Encodable>) => void,
): SignedSwapEvent {
  const fields = decodeCanonical(event.payload)
  if (!(fields instanceof Map)) throw new Error('Expected map')
  const changed = new Map<bigint, Encodable>()
  fields.forEach((value, key) => changed.set(key, value))
  change(changed)
  return signed({ ...event, payload: encodeCanonical(changed) })
}
const auth = (
  role: 0 | 1,
  direction: 'incoming' | 'outbound-replay' = 'incoming',
): AuthenticatedNegotiationContext => {
  const bound = context()
  return {
    direction,
    localPublicKey: bound.parties[direction === 'incoming' ? 1 - role : role]!,
    senderPublicKey: bound.parties[role],
    recipientPublicKey: bound.parties[1 - role]!,
    conversationId: bound.conversationId,
  }
}

const GOLDEN = {
  keyId: 'd90ea4471f3ace9eaa5fe1dfd73a68b7c7bab615f0edb7cdab354440cd760007',
  payload:
    'a900010101025022222222222222222222222222222222038258210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798582102c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5046b7865632d746573746e6574056d6d6f6e61642d746573746e6574061930390758200000000000000000000000000000000000000000000000000de0b6b3a7640001081a77359400',
  termsHash: 'f8b7ee07bf1dc40ae416b07c01dd0d501e480833102bf87b07da54d3336257cb',
  signatureDigest:
    '582624b31fece4adebb3e8691df54dc71845f857036b9c18b1de9cf1a911332f',
  event:
    '00011111111111111111111111111111111111111111111111111111111111111111000001d90ea4471f3ace9eaa5fe1dfd73a68b7c7bab615f0edb7cdab354440cd760007000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a8a900010101025022222222222222222222222222222222038258210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798582102c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5046b7865632d746573746e6574056d6d6f6e61642d746573746e6574061930390758200000000000000000000000000000000000000000000000000de0b6b3a7640001081a7735940002f346f20985ee9596e4b5b09d0e860238aa98372e8a10716b0837f16b66c77da657d96836b569c6cdaa57fe2b008e4f145eb3b52e32e546585b2d5da1114cf6000100473045022100da639b92d0689c44a6de244544fd53b3d3b832e7aee4bebde1b4fbb270d07eb20220261ccdb884567ae97b14e82347720acd32743711ed91e7ca5bed07d625c6ff01',
}

describe('authenticated negotiation schema and domains', () => {
  it('keeps production imports limited to pure primitives, registry facts and the existing core', () => {
    const source = readFileSync(join(__dirname, 'negotiation.ts'), 'utf8')
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      match => match[1],
    )
    expect(imports).toEqual([
      '@noble/hashes/sha256.js',
      '@frank/codec',
      '../../../docs/protocol/chains/v1.json',
      './index',
    ])
  })

  it('schema-decodes orphan responses without inventing A, then separately binds full context', async () => {
    const first = await offer(),
      second = await response(first)
    const real = standaloneItemBudget(),
      decodeCbor = jest.fn(real.decodeCbor)
    const schema = must(
      decodeNegotiationEventSchema(
        encoded(second),
        TESTNET_NEGOTIATION_POLICY,
        { ...real, decodeCbor },
      ),
    )
    expect(schema.kind).toBe('accept')
    expect(schema.terms).not.toHaveProperty('parties')
    expect(decodeCbor).toHaveBeenCalledTimes(1)
    const fullBudget = standaloneItemBudget(),
      fullDecode = jest.fn(fullBudget.decodeCbor)
    expect(
      decodeNegotiationEvent(encoded(second), context(), {
        ...fullBudget,
        decodeCbor: fullDecode,
      }).ok,
    ).toBe(true)
    expect(fullDecode).toHaveBeenCalledTimes(1)
    for (const bad of [
      { ...context(), swapId: new Uint8Array(32) },
      { ...context(), conversationId: new Uint8Array(16) },
      {
        ...context(),
        parties: [context().parties[1], context().parties[0]] as const,
      },
    ])
      expect(decodeNegotiationEventStandalone(encoded(second), bad).ok).toBe(
        false,
      )
    expect(
      decodeNegotiationEventSchema(
        encoded(first),
        REGTEST_PROOF_NEGOTIATION_POLICY,
        standaloneItemBudget(),
      ).ok,
    ).toBe(false)
    const changed = encoded(second)
    changed[changed.length - 1] ^= 1
    expect(
      decodeNegotiationEventSchema(
        changed,
        TESTNET_NEGOTIATION_POLICY,
        standaloneItemBudget(),
      ).ok,
    ).toBe(false)
  })

  it('pins exact golden bytes and interoperates with the existing DER identity signer', async () => {
    const first = await offer()
    const decoded = must(
      decodeNegotiationEventStandalone(encoded(first), context()),
    )
    expect(hex(first.payload)).toBe(GOLDEN.payload)
    expect(hex(must(negotiationIdentityKeyId(context().parties[0])))).toBe(
      GOLDEN.keyId,
    )
    expect(hex(must(negotiationTermsHash(decoded)))).toBe(GOLDEN.termsHash)
    const digest = sha256(must(signaturePreimageForCore(first)))
    expect(hex(digest)).toBe(GOLDEN.signatureDigest)
    expect(
      verifyAlgorithm1(digest, first.signature, context().parties[0]),
    ).toBe(true)
    expect(hex(encoded(first))).toBe(GOLDEN.event)
    expect(must(decodeSignedSwapEvent(fromHex(GOLDEN.event)))).toEqual(first)
    expect(decoded.kind).toBe('offer')
    if (decoded.kind === 'offer') expect(decoded.terms).toMatchObject(amounts())
  })

  it('keeps testnet and explicitly named regtest proof configurations distinct', async () => {
    const local = { ...context(), policy: REGTEST_PROOF_NEGOTIATION_POLICY }
    const first = await offer(local)
    expect(decodeNegotiationEventStandalone(encoded(first), local).ok).toBe(
      true,
    )
    expect(decodeNegotiationEventStandalone(encoded(first), context()).ok).toBe(
      false,
    )
    for (const bad of [
      { ...TESTNET_NEGOTIATION_POLICY, xecChainIdentifier: 'ecash-testnet' },
      { ...TESTNET_NEGOTIATION_POLICY, evmChainIdentifier: 'evm' },
      { ...TESTNET_NEGOTIATION_POLICY, evmChainIdentifier: 'monad-regtest' },
    ])
      expect(
        (
          await buildNegotiationOffer(
            { ...context(), policy: bad },
            amounts(),
            async d => signA(d),
          )
        ).ok,
      ).toBe(false)
  })

  it('rejects malformed or unsupported payload fields, curve points and numeric forms', async () => {
    const first = await offer()
    const invalidFields: Array<[bigint, Encodable]> = [
      [0n, 2],
      [1n, 2],
      [2n, new Uint8Array(15)],
      [3n, [context().parties[0], context().parties[0]]],
      [3n, [new Uint8Array(33).fill(0xff), context().parties[1]]],
      [4n, 'xec-regtest'],
      [4n, fromHex('786563')],
      [5n, 'monad'],
      [6n, 0n],
      [6n, -1n],
      [6n, '12345'],
      [6n, new Uint8Array(8)],
      [7n, new Uint8Array(32)],
      [7n, new Uint8Array(31)],
      [7n, 1n],
      [8n, -1n],
      [8n, '2000000000'],
      [9n, 1],
    ]
    for (const [field, value] of invalidFields) {
      const changed = changePayload(first, fields => fields.set(field, value))
      expect(
        decodeNegotiationEventStandalone(encoded(changed), context()).ok,
      ).toBe(false)
    }
    const deleted = changePayload(first, fields => fields.delete(8n))
    expect(
      decodeNegotiationEventStandalone(encoded(deleted), context()).ok,
    ).toBe(false)
    const decoded = must(
      decodeNegotiationEventStandalone(encoded(first), context()),
    )
    if (decoded.kind !== 'offer') throw new Error('Expected offer')
    expect(
      encodeOfferPayload(
        {
          ...decoded.terms,
          parties: [...context().parties, context().parties[0]],
        } as never,
        context(),
      ).ok,
    ).toBe(false)
    expect(
      decodeNegotiationEventStandalone(encoded(first), {
        ...context(),
        parties: [...context().parties, context().parties[0]],
      } as never).ok,
    ).toBe(false)
    for (const changes of [
      { xecPrincipal: 1n << 64n },
      { xecPrincipal: 0n },
      { evmPrincipal: 1n << 256n },
      { evmPrincipal: 0n },
      { expiry: 1n << 64n },
    ])
      expect(
        encodeOfferPayload({ ...decoded.terms, ...changes }, context()).ok,
      ).toBe(false)
    // Same integer, deliberately non-minimal encoding, signed over those actual bytes.
    const nonminimal = fromHex(GOLDEN.payload.replace(/^a90001/, 'a9001801'))
    expect(
      decodeNegotiationEventStandalone(
        encoded(signed({ ...first, payload: nonminimal })),
        context(),
      ).ok,
    ).toBe(false)
    // CBOR float in place of the positive integral XEC principal.
    const floating = fromHex(GOLDEN.payload.replace('06193039', '06fa3fc00000'))
    expect(
      decodeNegotiationEventStandalone(
        encoded(signed({ ...first, payload: floating })),
        context(),
      ).ok,
    ).toBe(false)
  })

  it('rejects wire tampering, wrong identity algorithms and mutated signed amounts', async () => {
    const first = await offer()
    const tampered = encoded(first)
    tampered[tampered.length - 1] ^= 1
    expect(decodeNegotiationEventStandalone(tampered, context())).toMatchObject(
      { ok: false, error: { code: 'invalid-signature' } },
    )
    const changed = changePayload(first, fields => fields.set(6n, 12346n))
    changed.signature = first.signature
    expect(
      decodeNegotiationEventStandalone(encoded(changed), context()).ok,
    ).toBe(false)
    expect(
      decodeNegotiationEventStandalone(
        encoded({ ...first, signatureAlgorithm: 2 }),
        context(),
      ).ok,
    ).toBe(false)
    expect(
      (
        await buildNegotiationOffer(
          context(),
          amounts(),
          async () => new Uint8Array(71),
        )
      ).ok,
    ).toBe(false)
    expect(
      (
        await buildNegotiationOffer(context(), amounts(), async () => {
          throw new Error('Unavailable signer')
        })
      ).ok,
    ).toBe(false)
    expect(
      (await buildNegotiationOffer(context(), amounts(), async d => signB(d)))
        .ok,
    ).toBe(false)
  })

  it('binds the exact swap, conversation, ordered parties and authenticated direction', async () => {
    const first = await offer()
    for (const bad of [
      { ...context(), swapId: new Uint8Array(32) },
      { ...context(), conversationId: new Uint8Array(16) },
      {
        ...context(),
        parties: [context().parties[1], context().parties[0]] as const,
      },
      { ...context(), conversationId: new Uint8Array() },
    ])
      expect(decodeNegotiationEventStandalone(encoded(first), bad).ok).toBe(
        false,
      )
    for (const direction of ['incoming', 'outbound-replay'] as const)
      expect(
        validateAuthenticatedNegotiationEvent(
          encoded(first),
          context(),
          auth(0, direction),
          standaloneItemBudget(),
        ).ok,
      ).toBe(true)
    const initial = must(reduceNegotiationStandalone([], context()))
    for (const bad of [
      { ...auth(0), senderPublicKey: context().parties[1] },
      { ...auth(0), recipientPublicKey: context().parties[0] },
      { ...auth(0), localPublicKey: context().parties[0] },
      { ...auth(0), conversationId: new Uint8Array(16) },
      { ...auth(0, 'outbound-replay'), localPublicKey: context().parties[1] },
    ]) {
      const admitted = validateAuthenticatedNegotiationEvent(
        encoded(first),
        context(),
        bad,
        standaloneItemBudget(),
      )
      expect(admitted.ok).toBe(false)
      expect(initial.history).toEqual({ offer: null, decision: null })
    }
  })

  it('snapshots all mutable builder inputs before awaiting the injected signer', async () => {
    const bound = context(),
      economic = amounts(),
      mutablePolicy = { ...TESTNET_NEGOTIATION_POLICY }
    const input = { ...bound, policy: mutablePolicy }
    let finish: (signature: Uint8Array) => void = () => {
      throw new Error('Not started')
    }
    let captured = new Uint8Array()
    const pending = buildNegotiationOffer(
      input,
      economic,
      async digest =>
        new Promise<Uint8Array>(resolve => {
          captured = digest.slice()
          digest.fill(0)
          finish = resolve
        }),
    )
    input.swapId.fill(0)
    input.conversationId.fill(0)
    input.parties[0].fill(0)
    mutablePolicy.xecChainIdentifier = 'xec-regtest'
    economic.xecPrincipal = 1n
    economic.expiry = 0n
    const signature = signA(captured)
    finish(signature)
    const first = must(await pending)
    signature.fill(0)
    expect(hex(encoded(first))).toBe(GOLDEN.event)
    expect(decodeNegotiationEventStandalone(encoded(first), context()).ok).toBe(
      true,
    )
  })
})

describe('prevalidated negotiation journal and eligibility', () => {
  it.each(['accept', 'reject'] as const)(
    'reduces a two-party %s and buffers response-before-offer',
    async decision => {
      const first = await offer(),
        second = await response(first, decision)
      expect(
        validateAuthenticatedNegotiationEvent(
          encoded(second),
          context(),
          auth(1),
          standaloneItemBudget(),
        ).ok,
      ).toBe(true)
      const orphan = must(
        reduceNegotiationStandalone([encoded(second)], context()),
      )
      expect(orphan.buffered).toEqual([second])
      expect(orphan.usableAcceptance).toBeNull()
      const ordered = must(
        reduceNegotiationStandalone(
          [encoded(first), encoded(second)],
          context(),
        ),
      )
      const reordered = must(
        reduceNegotiationStandalone(
          [encoded(second), encoded(first), encoded(first), encoded(second)],
          context(),
        ),
      )
      expect(reordered).toEqual(ordered)
      expect(ordered.history.decision).toBe(decision)
      expect(ordered.violation).toBeNull()
      expect(ordered.applied).toHaveLength(2)
      expect(ordered.usableAcceptance === null).toBe(decision === 'reject')
    },
  )

  it('prevalidates invalid orphan payloads, producers, sequences and exact prerequisites', async () => {
    const first = await offer(),
      second = await response(first)
    const bad = [
      signed({ ...second, sequence: 1n, previousEventHash: first.eventId }),
      signed({ ...second, prerequisiteEventIds: [] }),
      signed({
        ...second,
        prerequisiteEventIds: [new Uint8Array(32), first.eventId],
      }),
      signed({
        ...second,
        senderRole: 0,
        senderKeyId: must(negotiationIdentityKeyId(context().parties[0])),
      }),
      changePayload(second, fields => fields.set(1n, new Uint8Array(16))),
      changePayload(second, fields => fields.set(2n, context().parties[0])),
      changePayload(second, fields => fields.set(5n, 1)),
      changePayload(second, fields => fields.set(3n, new Uint8Array(32))),
    ]
    for (const event of bad)
      expect(reduceNegotiationStandalone([encoded(event)], context()).ok).toBe(
        false,
      )
    expect(
      reduceNegotiationStandalone(
        [
          encoded(
            signed({ ...first, prerequisiteEventIds: [new Uint8Array(32)] }),
          ),
        ],
        context(),
      ).ok,
    ).toBe(false)
    expect(
      reduceNegotiationStandalone(
        [encoded(signed({ ...first, laneId: 1 }))],
        context(),
      ).ok,
    ).toBe(false)
    expect(
      reduceNegotiationStandalone(
        [encoded(signed({ ...first, messageType: 4 }))],
        context(),
      ).ok,
    ).toBe(false)
  })

  it('rejects incorrect actual terms and exposes no usable acceptance after equivocation', async () => {
    const first = await offer(),
      yes = await response(first),
      no = await response(first, 'reject')
    const changedHash = changePayload(yes, fields =>
      fields.set(4n, new Uint8Array(32)),
    )
    const badTerms = must(
      reduceNegotiationStandalone(
        [encoded(first), encoded(changedHash)],
        context(),
      ),
    )
    expect(badTerms.violation?.code).toBe('transition-rejected')
    expect(badTerms.usableAcceptance).toBeNull()
    const otherOffer = changePayload(first, fields => fields.set(6n, 12346n))
    for (const events of [
      [first, yes, no],
      [no, yes, first],
      [first, yes, otherOffer],
      [otherOffer, yes, first],
    ]) {
      const reduction = must(
        reduceNegotiationStandalone(events.map(encoded), context()),
      )
      expect(reduction.violation?.code).toBe('equivocation')
      expect(reduction.usableAcceptance).toBeNull()
      expect(must(negotiationEligibility(reduction, 1n))).toEqual({
        eligibleForPreparation: false,
        reason: 'violation',
      })
    }
  })

  it('keeps historical acceptance while expiry exclusively gates current preparation', async () => {
    const first = await offer(),
      second = await response(first)
    const reduction = must(
      reduceNegotiationStandalone([encoded(second), encoded(first)], context()),
    )
    expect(
      must(negotiationEligibility(reduction, amounts().expiry - 1n)),
    ).toEqual({ eligibleForPreparation: true, reason: 'accepted' })
    for (const now of [amounts().expiry, amounts().expiry + 1n]) {
      expect(must(negotiationEligibility(reduction, now))).toEqual({
        eligibleForPreparation: false,
        reason: 'expired',
      })
      expect(reduction.history.decision).toBe('accept')
    }
    expect(negotiationEligibility(reduction, -1n).ok).toBe(false)
  })

  it('bounds admission before payload/signature processing, including duplicate inputs', async () => {
    const first = await offer(),
      data = encoded(first)
    const real = standaloneItemBudget(),
      decodeCbor = jest.fn(real.decodeCbor)
    const budget = { ...real, decodeCbor }
    expect(
      reduceNegotiation(
        Array.from({ length: 65 }, () => data),
        context(),
        budget,
      ),
    ).toMatchObject({ ok: false, error: { code: 'bad-length' } })
    expect(decodeCbor).not.toHaveBeenCalled()
    expect(
      decodeNegotiationEvent(new Uint8Array(1025), context(), budget).ok,
    ).toBe(false)
    expect(decodeCbor).not.toHaveBeenCalled()
    const oversized = signed({ ...first, payload: new Uint8Array(513) })
    expect(
      decodeNegotiationEvent(encoded(oversized), context(), budget).ok,
    ).toBe(false)
    expect(decodeCbor).not.toHaveBeenCalled()
    const admitted = must(
      reduceNegotiationStandalone(
        Array.from({ length: 64 }, () => data),
        context(),
      ),
    )
    expect(admitted.applied).toHaveLength(1)
    expect(negotiationLimits).toEqual({
      events: 64,
      eventBytes: 1024,
      totalBytes: 65536,
      payloadBytes: 512,
    })
  })

  it('charges payload traversal to the supplied enclosing budget rather than resetting it', async () => {
    const first = await offer(),
      real = standaloneItemBudget(),
      decodeCbor = jest.fn(real.decodeCbor)
    expect(
      decodeNegotiationEvent(encoded(first), context(), { ...real, decodeCbor })
        .ok,
    ).toBe(true)
    expect(decodeCbor).toHaveBeenCalledWith(
      first.payload,
      'swap-negotiation/payload',
    )
    // Exhaust the real operation's remaining item counter before reading this payload.
    const shared = standaloneItemBudget()
    shared.decodeCbor(
      encodeCanonical(Array.from({ length: 8191 }, () => Array(15).fill(null))),
    )
    expect(decodeNegotiationEvent(encoded(first), context(), shared).ok).toBe(
      false,
    )
    expect(decodeNegotiationEventStandalone(encoded(first), context()).ok).toBe(
      true,
    )
    const rejected = {
      ...real,
      decodeCbor: () => {
        throw new Error('Enclosing budget exhausted')
      },
    }
    expect(decodeNegotiationEvent(encoded(first), context(), rejected).ok).toBe(
      false,
    )
  })
})

describe('Buffer ownership across deferred identity signing', () => {
  it('owns a Buffer swap ID before awaiting the offer signer', async () => {
    const input = { ...context(), swapId: Buffer.alloc(32, 0x11) }
    let release: () => void = () => {
      throw new Error('Signer not started')
    }
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const pending = buildNegotiationOffer(input, amounts(), async digest => {
      const signature = signA(digest)
      await gate
      return signature
    })
    input.swapId.fill(0x33)
    release()
    const event = must(await pending)
    expect(hex(event.swapId)).toBe('11'.repeat(32))
    expect(hex(encoded(event))).toBe(GOLDEN.event)
    expect(
      verifyAlgorithm1(
        sha256(must(signaturePreimageForCore(event))),
        event.signature,
        a.compressedPubKey,
      ),
    ).toBe(true)
    expect(
      decodeNegotiationEventSchema(
        encoded(event),
        TESTNET_NEGOTIATION_POLICY,
        standaloneItemBudget(),
      ).ok,
    ).toBe(true)
  })

  it('owns the Buffer offer event ID used by a response prerequisite across the signer await', async () => {
    const first = await offer()
    const raw = Buffer.from(encoded(first))
    const at = raw.indexOf(Buffer.from(first.eventId))
    expect(at).toBeGreaterThan(0)
    let release: () => void = () => {
      throw new Error('Signer not started')
    }
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const pending = buildNegotiationResponse(
      context(),
      raw,
      'accept',
      async digest => {
        const signature = signB(digest)
        await gate
        return signature
      },
    )
    raw[at] ^= 1
    release()
    const event = must(await pending)
    expect(hex(event.prerequisiteEventIds[0])).toBe(hex(first.eventId))
    expect(
      verifyAlgorithm1(
        sha256(must(signaturePreimageForCore(event))),
        event.signature,
        b.compressedPubKey,
      ),
    ).toBe(true)
    expect(
      must(
        reduceNegotiationStandalone(
          [encoded(first), encoded(event)],
          context(),
        ),
      ).usableAcceptance,
    ).not.toBeNull()
  })
})

it('owns all Buffer context fields and a returned Buffer signature during response signing', async () => {
  const first = await offer(),
    original = context()
  const input = {
    ...original,
    swapId: Buffer.from(original.swapId),
    conversationId: Buffer.from(original.conversationId),
    parties: [
      Buffer.from(original.parties[0]),
      Buffer.from(original.parties[1]),
    ] as const,
  }
  const raw = Buffer.from(encoded(first))
  let release: () => void = () => {
    throw new Error('Signer not started')
  }
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let signature = Buffer.alloc(0)
  const pending = buildNegotiationResponse(
    input,
    raw,
    'accept',
    async digest => {
      signature = Buffer.from(signB(digest))
      await gate
      return signature
    },
  )
  input.swapId.fill(0)
  input.conversationId.fill(0)
  input.parties[0].fill(0)
  input.parties[1].fill(0)
  raw.fill(0)
  release()
  const second = must(await pending)
  signature.fill(0)
  expect(decodeNegotiationEventStandalone(encoded(second), context()).ok).toBe(
    true,
  )
  expect(
    must(
      reduceNegotiationStandalone([encoded(first), encoded(second)], context()),
    ).usableAcceptance,
  ).not.toBeNull()
})

it('schema decoding owns Buffer event and payload fields after returning', async () => {
  const first = await offer(),
    raw = Buffer.from(encoded(first))
  const parsed = must(
    decodeNegotiationEventSchema(
      raw,
      TESTNET_NEGOTIATION_POLICY,
      standaloneItemBudget(),
    ),
  )
  raw.fill(0)
  expect(hex(encoded(parsed.event))).toBe(GOLDEN.event)
  expect(
    decodeNegotiationEventStandalone(encoded(parsed.event), context()).ok,
  ).toBe(true)
})

it('reduction owns Buffer input bytes retained in its applied event history', async () => {
  const first = await offer(),
    raw = Buffer.from(encoded(first))
  const reduced = must(reduceNegotiationStandalone([raw], context()))
  raw.fill(0)
  expect(hex(encoded(reduced.applied[0]))).toBe(GOLDEN.event)
  expect(reduced.history.offer?.event).toEqual(first)
})
