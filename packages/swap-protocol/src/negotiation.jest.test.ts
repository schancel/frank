import { readFileSync } from 'fs'
import { join } from 'path'
import { sha256 } from '@noble/hashes/sha256.js'
import { hmac } from '@noble/hashes/hmac.js'
import {
  encodeCanonical,
  decodeCanonical,
  standaloneItemBudget,
  verifyAlgorithm1,
  type Encodable,
} from '@frank/codec'
import { MonadIdentity } from '../../wallet/evm-identity'
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
  negotiationDeadlineRules,
  defaultNegotiationDeadlines,
  deriveOfferSwapId,
  offerSwapIdTranscript,
  validateOfferFields,
  type NegotiationContext,
  type AuthenticatedNegotiationContext,
} from './negotiation'
import {
  FIXTURE_EXPIRY,
  FIXTURE_XEC_CLAIM_KEY,
  fixtureAccept,
  fixtureOfferFields,
} from './negotiation-fixtures.testutil'

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
const amounts = () => fixtureOfferFields()
const decide = (decision: 'accept' | 'reject') =>
  decision === 'accept' ? fixtureAccept() : ({ kind: 'reject' } as const)
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
      decide(decision),
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
  keyId:
    'd90ea4471f3ace9eaa5fe1dfd73a68b7c7bab615f0edb7cdab354440cd760007',
  payload:
    'af00020102025022222222222222222222222222222222038258210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798582102c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5046b7865632d746573746e6574056d6d6f6e61642d746573746e6574061930390758200000000000000000000000000000000000000000000000000de0b6b3a7640001081a77359400095820bb391415c05e39d77ca17381d3be3f7d0cd5e5332e5a579311adaa0aa62106e90a582102f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f90b54aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0c1a7736e5800d1a77363cc00e54cccccccccccccccccccccccccccccccccccccccc',
  termsHash:
    '1f591cee420a6b20ba2ae83d45809876f3b4aea4b87aedcdf46d4d99cf43dc73',
  signatureDigest:
    '90e17d2eb654b86de8183579e142bd2776aa02c148d71647cd6d71d8dc50ac6c',
  event:
    '00011111111111111111111111111111111111111111111111111111111111111111000001d90ea4471f3ace9eaa5fe1dfd73a68b7c7bab615f0edb7cdab354440cd76000700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000127af00020102025022222222222222222222222222222222038258210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798582102c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5046b7865632d746573746e6574056d6d6f6e61642d746573746e6574061930390758200000000000000000000000000000000000000000000000000de0b6b3a7640001081a77359400095820bb391415c05e39d77ca17381d3be3f7d0cd5e5332e5a579311adaa0aa62106e90a582102f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f90b54aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0c1a7736e5800d1a77363cc00e54cccccccccccccccccccccccccccccccccccccccc3137d0a7e4276b75b59f41fa3975f7a93bff889f5c62e178ca5393cdb19bd386a4c4e2d6592fc19b57b49f5ab6a7ab6613c43267ee550d9134e0d344aa53a1ab0001004730450221008a4db8787cd472da731576d2a6ff67252e5ecfc2168c4c91f6c5361fafbe24b002201993bf9aa8efaf107f49471ad45a4da7aa0154658f39bede0c58ccf04d037611',
  acceptPayload:
    'a7000201502222222222222222222222222222222202582102c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5035820a4c4e2d6592fc19b57b49f5ab6a7ab6613c43267ee550d9134e0d344aa53a1ab0458201f591cee420a6b20ba2ae83d45809876f3b4aea4b87aedcdf46d4d99cf43dc7305582102e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd130654bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  acceptEvent:
    '00011111111111111111111111111111111111111111111111111111111111111111000002c1632be52db81d114dd8765e53d9f627663162f748d69686521d3419ea5f76fb010000000000000000000000000000000000000000000000000000000000000000000000000000000001a4c4e2d6592fc19b57b49f5ab6a7ab6613c43267ee550d9134e0d344aa53a1ab000000b9a7000201502222222222222222222222222222222202582102c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5035820a4c4e2d6592fc19b57b49f5ab6a7ab6613c43267ee550d9134e0d344aa53a1ab0458201f591cee420a6b20ba2ae83d45809876f3b4aea4b87aedcdf46d4d99cf43dc7305582102e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd130654bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2ec092321a2a282b8606498e67313b59fc1330eeaa3e89555c995409b8a072b1ff94119fc15212f09847a970bddc64eac066f19e609a3888e733207bbf4deec00001004630440220738c37ed39ef028ab6969e0c29135c750b4958ad990148ad853dec44442d53d4022054bd5330c8f6ea959718adee23e1cf819eeed68dc1bf3566f89d1ec52ea80640',
  swapIdTranscript:
    '8d766672616e6b2f737761702d6f666665722d69642f7631747865632d6d6f6e61642d746573746e65742d76326b7865632d746573746e65746d6d6f6e61642d746573746e657450222222222222222222222222222222228258210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798582102c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee519303958200000000000000000000000000000000000000000000000000de0b6b3a76400011a773594001a7736e5801a77363cc054aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa54cccccccccccccccccccccccccccccccccccccccc',
  swapId:
    '587e24fd9a9cd43854d5802c1b2df28827994cccfcb46bd306a1ee24a352ab02',
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
      [0n, 1],
      [1n, 1],
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
      [9n, new Uint8Array(31)],
      [10n, new Uint8Array(33).fill(0xff)],
      [10n, new Uint8Array(32)],
      [11n, new Uint8Array(19)],
      [12n, -1n],
      [13n, '1'],
      [14n, new Uint8Array(21)],
      [15n, 1],
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
    const nonminimal = fromHex(GOLDEN.payload.replace(/^af0002/, 'af001802'))
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
      expect(initial.history).toEqual({
        offer: null,
        decision: null,
        accept: null,
      })
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
    ;(economic as { xecPrincipal: bigint }).xecPrincipal = 1n
    ;(economic as { expiry: bigint }).expiry = 0n
    economic.hashLock.fill(0)
    economic.evmRecipient.fill(0)
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
      must(negotiationEligibility(reduction, FIXTURE_EXPIRY - 1n)),
    ).toEqual({ eligibleForPreparation: true, reason: 'accepted' })
    for (const now of [FIXTURE_EXPIRY, FIXTURE_EXPIRY + 1n]) {
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
      fixtureAccept(),
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
    fixtureAccept(),
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

describe('v2 HTLC terms: deadline rules R1–R3 and the other executability checks', () => {
  const E = FIXTURE_EXPIRY
  const H = 3600n
  /** A signed offer carrying `changes`, built past the builder (which refuses them). */
  const signedOffer = async (changes: Record<number, Encodable>) => {
    const base = await offer()
    return changePayload(base, fields => {
      for (const [k, v] of Object.entries(changes)) fields.set(BigInt(k), v)
    })
  }
  const reduce = (...events: SignedSwapEvent[]) =>
    must(reduceNegotiationStandalone(events.map(encoded), context()))

  it('pins the v2 accept golden bytes and exposes both signed terms only after acceptance', async () => {
    const first = await offer(),
      second = await response(first)
    expect(hex(second.payload)).toBe(GOLDEN.acceptPayload)
    expect(hex(encoded(second))).toBe(GOLDEN.acceptEvent)
    const reduced = reduce(first, second)
    expect(reduced.violation).toBeNull()
    expect(reduced.usableAcceptance?.offer).toMatchObject(fixtureOfferFields())
    expect(reduced.usableAcceptance?.accept).toMatchObject(
      fixtureAccept().fields,
    )
    expect(reduced.history.accept?.event).toEqual(second)
    const rejected = reduce(first, await response(first, 'reject'))
    expect(rejected.history.accept).toBeNull()
    expect(rejected.usableAcceptance).toBeNull()
  })

  it('accepts the exact rule boundaries and the UI defaults', async () => {
    const rules = must(negotiationDeadlineRules(TESTNET_NEGOTIATION_POLICY))
    expect(rules).toMatchObject({
      evmFinality: 600,
      minRefundGap: 6 * 3600,
      minClaimWindow: 8 * 3600,
      maxSpan: 72 * 3600,
    })
    const defaults = must(
      defaultNegotiationDeadlines(TESTNET_NEGOTIATION_POLICY, E),
    )
    expect(defaults).toEqual({
      expiry: E + H,
      evmExpiry: E + 13n * H,
      xecRefundTime: E + 25n * H,
    })
    for (const deadlines of [
      defaults,
      // R2 and R1 exactly at their minimum.
      { expiry: E, evmExpiry: E + 8n * H, xecRefundTime: E + 14n * H },
      // R3 exactly at its maximum.
      { expiry: E, evmExpiry: E + 8n * H, xecRefundTime: E + 72n * H },
    ]) {
      const first = must(
        await buildNegotiationOffer(
          context(),
          fixtureOfferFields(deadlines),
          async d => signA(d),
        ),
      )
      expect(reduce(first).violation).toBeNull()
    }
  })

  it.each([
    ['R2: EVM expiry less than 8 h after E', { 13: E + 8n * H - 1n }],
    ['inverted: EVM expiry before E', { 13: E - 1n }],
    ['R1: XEC refund less than 6 h after T_B', { 12: E + 18n * H - 1n }],
    ['inverted: XEC refund before T_B', { 12: E + 11n * H }],
    ['R3: XEC refund more than 72 h after E', { 12: E + 72n * H + 1n }],
    ['T_A not a CLTV timestamp', { 8: 0n, 13: 9n * H, 12: 18n * H }],
    [
      'T_A beyond 32 bits',
      {
        8: 1n << 32n,
        13: (1n << 32n) + 9n * H,
        12: (1n << 32n) + 18n * H,
      },
    ],
    ['XEC principal under dust', { 6: 545n }],
    ['zero EVM recipient', { 11: new Uint8Array(20) }],
    ['zero HTLC contract', { 14: new Uint8Array(20) }],
  ] as [string, Record<number, Encodable>][])(
    'a signed offer with %s is a violation, never accepted, and is refused by the builder',
    async (_, changes) => {
      const bad = await signedOffer(changes)
      const decoded = must(
        decodeNegotiationEventStandalone(encoded(bad), context()),
      )
      if (decoded.kind !== 'offer') throw new Error('Expected offer')
      const alone = reduce(bad)
      expect(alone.violation?.code).toBe('transition-rejected')
      expect(alone.history.offer).toBeNull()
      expect(alone.usableAcceptance).toBeNull()
      expect(must(negotiationEligibility(alone, 1n)).reason).toBe('violation')
      // B's builder refuses to accept it; rejecting it stays possible.
      expect(
        (
          await buildNegotiationResponse(
            context(),
            encoded(bad),
            fixtureAccept(),
            async d => signB(d),
          )
        ).ok,
      ).toBe(false)
      expect(
        (
          await buildNegotiationResponse(
            context(),
            encoded(bad),
            { kind: 'reject' },
            async d => signB(d),
          )
        ).ok,
      ).toBe(true)
      expect(
        await buildNegotiationOffer(context(), decoded.terms, async d =>
          signA(d),
        ),
      ).toMatchObject({ ok: false, error: { code: 'transition-rejected' } })
      expect(validateOfferFields(context(), decoded.terms).ok).toBe(false)
    },
  )

  it.each([
    ['claim key equal to the refund key', 'xecClaimPublicKey', 5],
    ['zero EVM sender', 'evmSender', 6],
    ['EVM sender equal to the recipient', 'evmSender', 6],
  ] as const)(
    'an accept with %s is a violation and leaves no usable acceptance',
    async (name, field, key) => {
      const value =
        name === 'claim key equal to the refund key'
          ? fixtureOfferFields().xecRefundPublicKey
          : name === 'zero EVM sender'
          ? new Uint8Array(20)
          : fixtureOfferFields().evmRecipient
      const first = await offer()
      const accept = changePayload(await response(first), fields =>
        fields.set(BigInt(key), value),
      )
      const reduced = reduce(first, accept)
      expect(reduced.violation?.code).toBe('transition-rejected')
      expect(reduced.usableAcceptance).toBeNull()
      expect(
        (
          await buildNegotiationResponse(
            context(),
            encoded(first),
            fixtureAccept({ [field]: value }),
            async d => signB(d),
          )
        ).ok,
      ).toBe(false)
    },
  )

  it('rejects an accept that omits B fields and a reject that carries them', async () => {
    const first = await offer()
    const yes = await response(first),
      no = await response(first, 'reject')
    const stripped = changePayload(yes, fields => {
      fields.delete(5n)
      fields.delete(6n)
    })
    const padded = changePayload(no, fields => {
      fields.set(5n, FIXTURE_XEC_CLAIM_KEY)
      fields.set(6n, new Uint8Array(20).fill(0xbb))
    })
    for (const bad of [stripped, padded])
      expect(decodeNegotiationEventStandalone(encoded(bad), context()).ok).toBe(
        false,
      )
  })

  it('reports an old v1 payload as a version failure', async () => {
    const first = await offer()
    const old = changePayload(first, fields => {
      fields.set(0n, 1)
      fields.set(1n, 1)
    })
    expect(
      decodeNegotiationEventStandalone(encoded(old), context()),
    ).toMatchObject({ ok: false, error: { code: 'bad-version' } })
  })

  it('regtest proof policy uses the same rules with second margins', async () => {
    const rules = must(
      negotiationDeadlineRules(REGTEST_PROOF_NEGOTIATION_POLICY),
    )
    expect(rules).toMatchObject({
      evmFinality: 5,
      xecFinality: 30,
      xecTimeSkew: 0,
      watcherDowntime: 10,
      minRefundGap: 40,
      minClaimWindow: 60,
    })
    const local = { ...context(), policy: REGTEST_PROOF_NEGOTIATION_POLICY }
    const fields = fixtureOfferFields({
      evmExpiry: E + 60n,
      xecRefundTime: E + 100n,
    })
    expect(
      (await buildNegotiationOffer(local, fields, async d => signA(d))).ok,
    ).toBe(true)
    expect(
      (await buildNegotiationOffer(context(), fields, async d => signA(d))).ok,
    ).toBe(false)
    expect(
      (
        await buildNegotiationOffer(
          local,
          { ...fields, xecRefundTime: E + 99n },
          async d => signA(d),
        )
      ).ok,
    ).toBe(false)
  })
})

describe('A derives the v2 swapId from its private salt and the offer facts', () => {
  const salt = new Uint8Array(32).fill(0x5a)
  const keyed = (key: Uint8Array) => (t: Uint8Array) => hmac(sha256, key, t)
  const facts = () => ({ ...context(), ...fixtureOfferFields() })
  it('pins the transcript and the derived swapId', () => {
    expect(hex(must(offerSwapIdTranscript(facts())))).toBe(
      GOLDEN.swapIdTranscript,
    )
    expect(hex(must(deriveOfferSwapId(facts(), keyed(salt))))).toBe(
      GOLDEN.swapId,
    )
  })
  it('differs for another account salt and for every offer fact', () => {
    const base = hex(must(deriveOfferSwapId(facts(), keyed(salt))))
    expect(
      hex(
        must(deriveOfferSwapId(facts(), keyed(new Uint8Array(32).fill(0x5b)))),
      ),
    ).not.toBe(base)
    const variants = [
      { policy: REGTEST_PROOF_NEGOTIATION_POLICY },
      { conversationId: new Uint8Array(16).fill(0x23) },
      { parties: [context().parties[1], context().parties[0]] as const },
      { xecPrincipal: 12346n },
      { evmPrincipal: 2n },
      { expiry: FIXTURE_EXPIRY + 1n },
      { xecRefundTime: FIXTURE_EXPIRY + 86401n },
      { evmExpiry: FIXTURE_EXPIRY + 43201n },
      { evmRecipient: new Uint8Array(20).fill(0xab) },
      { evmHtlcContract: new Uint8Array(20).fill(0xcd) },
    ]
    const seen = new Set([base])
    for (const change of variants) {
      const id = hex(
        must(deriveOfferSwapId({ ...facts(), ...change }, keyed(salt))),
      )
      expect(seen.has(id)).toBe(false)
      seen.add(id)
    }
  })
  it('refuses a keyed hash that is not 32 bytes and malformed facts', () => {
    expect(deriveOfferSwapId(facts(), () => new Uint8Array(31)).ok).toBe(false)
    expect(
      offerSwapIdTranscript({ ...facts(), evmRecipient: new Uint8Array(19) })
        .ok,
    ).toBe(false)
    expect(
      offerSwapIdTranscript({
        ...facts(),
        policy: {
          ...TESTNET_NEGOTIATION_POLICY,
          name: 'xec-monad-testnet-v1' as never,
        },
      }).ok,
    ).toBe(false)
  })
})
