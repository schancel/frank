/** @jest-environment node */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1'
import { encodeCanonical, fromHex, toHex } from '@frank/codec'
import { hmacSha256 } from '@frank/crypto-box'
import {
  formatConversationId,
  uuidv5Bytes,
} from '@frank/cashweb/relay/conversation-id'
import { LevelMessageStore } from '@frank/cashweb/relay/storage/level-storage'
import { MonadIdentity } from '@frank/wallet/evm-identity'
import {
  authorizeNegotiation,
  encodeLocalNegotiationIntent,
  decodeLocalNegotiationIntent,
  negotiationMessageTranscript,
  negotiationSlotTranscript,
  parseNegotiationAmount,
  type LocalNegotiationIntent,
  type NegotiationAuthorization,
  type NegotiationRecord,
  type OutgoingNegotiationOwner,
} from '@frank/swap-protocol/src/outgoing-negotiation'
import {
  TESTNET_NEGOTIATION_POLICY,
  decodeNegotiationEventStandalone,
  deriveOfferSwapId,
} from '@frank/swap-protocol/src/negotiation'
import {
  FIXTURE_EXPIRY,
  fixtureAcceptFields,
  fixtureOfferFields,
} from '@frank/swap-protocol/src/negotiation-fixtures.testutil'
import vectors from '../../../reviews/signed-negotiation-ui/fixtures/negotiation-id-vectors.json'
jest.setTimeout(30000)
const alice = MonadIdentity.fromPrivateKeyHex('0x' + '01'.padStart(64, '0'))
const bob = MonadIdentity.fromPrivateKeyHex('0x' + '02'.padStart(64, '0'))
const salt = new Uint8Array(16).fill(8)
const offerSwapId = (transcript: Uint8Array) => hmacSha256(transcript, salt)
const base = {
  conversationId: new Uint8Array(16).fill(2),
  parties: [alice.compressedPubKey, bob.compressedPubKey] as const,
  policy: TESTNET_NEGOTIATION_POLICY,
}
const fields = fixtureOfferFields({ xecPrincipal: 1230n, evmPrincipal: 456n })
const derived = deriveOfferSwapId({ ...base, ...fields }, offerSwapId)
if (!derived.ok) throw new Error('swapId derivation')
const context = { ...base, swapId: derived.value }
const intent: LocalNegotiationIntent = {
  action: 'offer',
  context,
  ...fields,
}
/** Clock `n` seconds around the acceptance deadline: at(200n) is the expiry E itself. */
const at = (n: bigint) => FIXTURE_EXPIRY - 200n + n
let digests: string[] = []
let location: string,
  storage: LevelMessageStore,
  owner: OutgoingNegotiationOwner,
  current: boolean,
  signatures: number
function auth(role = 0): {
  -readonly [K in keyof NegotiationAuthorization]: NegotiationAuthorization[K]
} {
  const identity = role ? bob : alice
  return {
    accountId: role ? 'b' : 'a',
    publicKey: identity.compressedPubKey,
    recipientPublicKey: (role ? alice : bob).compressedPubKey,
    conversationId: formatConversationId(context.conversationId),
    messagingChainIdentifier: 'monad-testnet',
    assertCurrent() {
      if (!current) throw new Error('Session revoked')
    },
    assertAdmittedOffer: jest.fn(),
    intentKey: bytes => toHex(hmacSha256(bytes, salt)),
    offerSwapId,
    messageId: bytes => formatConversationId(uuidv5Bytes(salt, toHex(bytes))),
    async signDigest(digest) {
      signatures++
      digests.push(toHex(digest))
      return identity.signHash(Buffer.from(digest))
    },
  }
}
const run = (
  value = intent,
  authorization = auth(),
  clock = () => at(100n),
  stampValueWei = '0',
) =>
  authorizeNegotiation({
    intent: value,
    auth: authorization,
    owner,
    now: clock,
    stampValueWei,
  })
beforeEach(async () => {
  location = await mkdtemp(join(tmpdir(), 'negotiation-intent-'))
  storage = new LevelMessageStore(location)
  await storage.Open()
  current = true
  signatures = 0
  digests = []
  owner = {
    claimOutgoingApplicationMessage: claim =>
      storage.claimOutgoingApplicationMessage(claim),
    completeOutgoingApplicationMessage: input =>
      storage.completeOutgoingApplicationMessage(input),
    getOutgoingApplicationMessage: intentKey =>
      storage.outgoingApplicationMessage({ intentKey, accountId: 'a' }),
  }
})
afterEach(async () => {
  await storage.Close()
  await rm(location, { recursive: true, force: true })
})
async function reopen() {
  await storage.Close()
  storage = new LevelMessageStore(location)
  await storage.Open()
}
test('pins every independently computed slot/HMAC/wire UUID vector', () => {
  for (const v of vectors) {
    const slot = negotiationSlotTranscript(
      fromHex(v.swapIdHex),
      fromHex(v.senderKeyIdHex),
    )
    expect(toHex(slot)).toBe(v.slotTranscriptHex)
    expect(toHex(hmacSha256(slot, fromHex(v.saltHex)))).toBe(v.intentKey)
    const transcript = negotiationMessageTranscript(
      v.messagingChainIdentifier,
      fromHex(v.conversationIdHex),
      fromHex(v.recipientPublicKeyHex),
      fromHex(v.eventIdHex),
    )
    expect(toHex(transcript)).toBe(v.messageTranscriptHex)
    expect(
      formatConversationId(uuidv5Bytes(fromHex(v.saltHex), toHex(transcript))),
    ).toBe(v.messageId)
  }
})
test('canonical local format roundtrips exact terms and rejects trailing/noncanonical bytes', () => {
  const bytes = encodeLocalNegotiationIntent(intent)
  expect(
    toHex(encodeLocalNegotiationIntent(decodeLocalNegotiationIntent(bytes))),
  ).toBe(toHex(bytes))
  expect(() =>
    decodeLocalNegotiationIntent(new Uint8Array([...bytes, 0])),
  ).toThrow()
  expect(() =>
    decodeLocalNegotiationIntent(
      encodeCanonical(['frank/swap-negotiation-local-intent/v2', 0]),
    ),
  ).toThrow()
})
test.each([
  '1e3',
  '1.001',
  '0',
  '-1',
  '+1',
  '.1',
  '01',
  '184467440737095516.16',
])('rejects imprecise/overflow XEC amount %s', value => {
  expect(() => parseNegotiationAmount(value, 2, 64)).toThrow()
})
test('parses exact configured principal boundaries without floating point', () => {
  expect(parseNegotiationAmount('1.23', 2, 64)).toBe(123n)
  expect(parseNegotiationAmount('0.000000000000000456', 18, 256)).toBe(456n)
  expect(parseNegotiationAmount('184467440737095516.15', 2, 64)).toBe(
    (1n << 64n) - 1n,
  )
  expect(() =>
    parseNegotiationAmount((1n << 256n).toString(), 0, 256),
  ).toThrow()
})
test.each(['claim', 'sign', 'completion'] as const)(
  'restart after %s resumes the same authorization and exact winning bytes',
  async phase => {
    if (phase === 'claim') {
      const original = owner.claimOutgoingApplicationMessage
      owner.claimOutgoingApplicationMessage = async claim => {
        await original(claim)
        throw new Error('Interrupted after claim')
      }
    } else if (phase === 'completion') {
      const original = owner.completeOutgoingApplicationMessage
      owner.completeOutgoingApplicationMessage = async input => {
        await original(input)
        throw new Error('Interrupted after completion')
      }
    }
    const authorization = auth()
    if (phase === 'sign') {
      const original = authorization.signDigest
      authorization.signDigest = async d => {
        await original(d)
        throw new Error('Interrupted after signing')
      }
    }
    if (phase === 'completion')
      expect((await run(intent, authorization)).phase).toBe('signed')
    else await expect(run(intent, authorization)).rejects.toThrow()
    await reopen()
    owner.claimOutgoingApplicationMessage = claim =>
      storage.claimOutgoingApplicationMessage(claim)
    owner.completeOutgoingApplicationMessage = input =>
      storage.completeOutgoingApplicationMessage(input)
    const result = await run()
    const count = signatures
    await reopen()
    expect(await run(intent, auth(), () => at(300n))).toEqual(result)
    expect(signatures).toBe(count)
    expect(new Set(digests).size).toBe(1)
    expect(
      decodeNegotiationEventStandalone(
        fromHex(result.signedPayloadHex),
        context,
      ).ok,
    ).toBe(true)
  },
)
test('expired authorization cannot newly claim/sign, while persisted signed delivery retains expiry', async () => {
  await expect(run(intent, auth(), () => at(200n))).rejects.toThrow('expired')
  expect(signatures).toBe(0)
  const result = await run()
  await reopen()
  expect(await run(intent, auth(), () => at(999n))).toEqual(result)
})
test('an offer is signed only for the swapId this account derives from its facts', async () => {
  for (const swapId of [
    new Uint8Array(32).fill(1),
    // A swapId derived from other facts (a peer's, or another offer's) is not this offer's.
    (() => {
      const other = deriveOfferSwapId(
        { ...base, ...fields, xecPrincipal: 1231n },
        offerSwapId,
      )
      if (!other.ok) throw new Error('swapId derivation')
      return other.value
    })(),
  ])
    await expect(
      run({ ...intent, context: { ...context, swapId } }),
    ).rejects.toThrow('Offer swap ID was not derived by this account')
  const otherSalt = auth()
  otherSalt.offerSwapId = t => hmacSha256(t, new Uint8Array(16).fill(9))
  await expect(run(intent, otherSalt)).rejects.toThrow(
    'Offer swap ID was not derived by this account',
  )
  expect(signatures).toBe(0)
  expect(
    await storage.outgoingApplicationMessages({ accountId: 'a' }),
  ).toHaveLength(0)
  expect((await run()).phase).toBe('signed')
})
test('offer terms that break the deadline rules are refused before any claim', async () => {
  const bad = fixtureOfferFields({
    xecPrincipal: 1230n,
    evmPrincipal: 456n,
    xecRefundTime: fields.evmExpiry + 3600n,
  })
  const swapId = deriveOfferSwapId({ ...base, ...bad }, offerSwapId)
  if (!swapId.ok) throw new Error('swapId derivation')
  await expect(
    run({
      action: 'offer',
      context: { ...base, swapId: swapId.value },
      ...bad,
    }),
  ).rejects.toThrow('R1')
  expect(signatures).toBe(0)
  expect(
    await storage.outgoingApplicationMessages({ accountId: 'a' }),
  ).toHaveLength(0)
})
test.each(['conversation', 'party', 'chain', 'account', 'stamp'] as const)(
  'immutable %s change refuses before any additional signing',
  async changed => {
    await run()
    const a = auth()
    let value = intent
    if (changed === 'conversation') {
      a.conversationId = '03030303-0303-0303-0303-030303030303' as never
      value = {
        ...intent,
        context: { ...context, conversationId: new Uint8Array(16).fill(3) },
      }
    }
    if (changed === 'party')
      a.recipientPublicKey = alice.compressedPubKey as never
    if (changed === 'chain')
      a.messagingChainIdentifier = 'monad-mainnet' as never
    if (changed === 'account')
      a.accountId = 'recovered-account-replacement' as never
    await expect(
      run(value, a, () => at(100n), changed === 'stamp' ? '1' : '0'),
    ).rejects.toThrow()
    expect(signatures).toBe(1)
  },
)
test.each(['claim', 'sign', 'completion'] as const)(
  'revocation during %s await fences all later effects',
  async phase => {
    if (phase === 'claim') {
      const original = owner.claimOutgoingApplicationMessage
      owner.claimOutgoingApplicationMessage = async v => {
        const r = await original(v)
        current = false
        return r
      }
    }
    if (phase === 'completion') {
      const original = owner.completeOutgoingApplicationMessage
      owner.completeOutgoingApplicationMessage = async v => {
        const r = await original(v)
        current = false
        return r
      }
    }
    const a = auth()
    if (phase === 'sign') {
      const original = a.signDigest
      a.signDigest = async d => {
        const r = await original(d)
        current = false
        return r
      }
    }
    await expect(run(intent, a)).rejects.toThrow()
    expect(signatures).toBe(phase === 'claim' ? 0 : 1)
    current = true
    await reopen()
    owner.claimOutgoingApplicationMessage = c =>
      storage.claimOutgoingApplicationMessage(c)
    owner.completeOutgoingApplicationMessage = c =>
      storage.completeOutgoingApplicationMessage(c)
    expect((await run()).phase).toBe('signed')
  },
)
test('two valid concurrent DER signatures converge on durable winner and stable wire identity', async () => {
  const a = auth(),
    b = auth()
  b.signDigest = async digest => {
    signatures++
    return secp256k1
      .sign(digest, fromHex('01'.padStart(64, '0')), {
        extraEntropy: new Uint8Array(32).fill(9),
      })
      .toDERRawBytes()
  }
  const [left, right] = await Promise.all([run(intent, a), run(intent, b)])
  expect(left).toEqual(right)
  expect(signatures).toBe(2)
  expect(await run()).toEqual(left)
  expect(signatures).toBe(2)
})
test('claims exact admitted response before signing; opposite choice and response-before-offer are refused', async () => {
  const offer = await run()
  owner.getOutgoingApplicationMessage = key =>
    storage.outgoingApplicationMessage({ intentKey: key, accountId: 'b' })
  const response: LocalNegotiationIntent = {
    action: 'accept',
    context,
    offerBytes: fromHex(offer.signedPayloadHex),
    ...fixtureAcceptFields(),
  }
  const a = auth(1)
  a.assertAdmittedOffer = () => {
    throw new Error('Not admitted')
  }
  await expect(run(response, a)).rejects.toThrow('Not admitted')
  expect(signatures).toBe(1)
  const accepted = await run(response, auth(1))
  expect(accepted.phase).toBe('signed')
  await expect(run({ ...response, action: 'reject' }, auth(1))).rejects.toThrow(
    'conflict',
  )
  expect(signatures).toBe(2)
})
test.each([
  'intentHex',
  'signedPayloadHex',
  'messageId',
  'signerKeyId',
  'recipientPublicKey',
] as const)(
  'opaque read corruption in %s blocks recovery before another signature',
  async field => {
    const result = await run()
    const broken = {
      ...result,
      [field]:
        field === 'messageId'
          ? '11111111-1111-4111-8111-111111111111'
          : field === 'recipientPublicKey'
          ? toHex(alice.compressedPubKey)
          : '00',
    }
    owner.getOutgoingApplicationMessage = async () =>
      broken as NegotiationRecord
    await expect(run()).rejects.toThrow()
    expect(signatures).toBe(1)
  },
)

test('real outgoing capacity refuses before signer and retains all prior authorizations', async () => {
  const { numberedClaim } = await import(
    '@frank/cashweb/relay/storage/outgoing-application-intent.testutil'
  )
  for (let i = 0; i < 128; i++)
    await storage.claimOutgoingApplicationMessage({
      ...numberedClaim(i),
      accountId: 'a',
    })
  await expect(run()).rejects.toThrow('capacity')
  expect(signatures).toBe(0)
  expect(
    await storage.outgoingApplicationMessages({ accountId: 'a' }),
  ).toHaveLength(128)
}, 120_000)
test('feature-corrupt opaque intent survives reopen and refuses before signer', async () => {
  const result = await run()
  await storage.metadataDb.put(
    'outgoingApplicationIntent:' + result.intentKey,
    JSON.stringify({ ...result, intentHex: '00' }),
  )
  await reopen()
  await expect(run()).rejects.toThrow()
  expect(signatures).toBe(1)
  expect(
    (await storage.outgoingApplicationMessages({ accountId: 'a' }))[0]
      .intentHex,
  ).toBe('00')
})

test('expiry crossed during durable claim preserves unsigned claim and refuses signing', async () => {
  let now = at(100n)
  const original = owner.claimOutgoingApplicationMessage
  owner.claimOutgoingApplicationMessage = async claim => {
    const result = await original(claim)
    now = at(200n)
    return result
  }
  await expect(run(intent, auth(), () => now)).rejects.toThrow()
  expect(signatures).toBe(0)
  expect(
    (await storage.outgoingApplicationMessages({ accountId: 'a' }))[0].phase,
  ).toBe('claimed')
})
test('an offer or accept whose MON lock GenericHTLC would refuse (T_B over 30 days less 1 h ahead) is never signed', async () => {
  const window = 30n * 86400n - 3600n
  const tooEarly = () => fields.evmExpiry - window - 1n
  await expect(run(intent, auth(), tooEarly)).rejects.toThrow(
    'would refuse the lock',
  )
  expect(signatures).toBe(0)
  expect(
    await storage.outgoingApplicationMessages({ accountId: 'a' }),
  ).toHaveLength(0)
  expect(
    (await run(intent, auth(), () => fields.evmExpiry - window)).phase,
  ).toBe('signed')
  const offer = (
    await storage.outgoingApplicationMessages({ accountId: 'a' })
  )[0]
  owner.getOutgoingApplicationMessage = key =>
    storage.outgoingApplicationMessage({ intentKey: key, accountId: 'b' })
  const response: LocalNegotiationIntent = {
    action: 'accept',
    context,
    offerBytes: fromHex(
      (offer as NegotiationRecord & { signedPayloadHex: string })
        .signedPayloadHex,
    ),
    ...fixtureAcceptFields(),
  }
  await expect(run(response, auth(1), tooEarly)).rejects.toThrow(
    'would refuse the lock',
  )
  expect(signatures).toBe(1)
  // A reject commits to no lock, so the window does not apply to it.
  expect(
    (await run({ ...response, action: 'reject' }, auth(1), tooEarly)).phase,
  ).toBe('signed')
})
