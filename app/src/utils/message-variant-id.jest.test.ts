import { createHmac } from 'crypto'
import { encodeCanonical, fromHex, toHex } from '@frank/codec'
import {
  allocateOpeningConversationId,
  conversationIdSalt,
} from '@frank/cashweb/relay/conversation-id'
import protocolChains from '../../../docs/protocol/chains/v1.json'
import {
  deriveMessageVariantId,
  type AuthenticatedMessageVariantFacts,
} from './message-variant-id'

const DOMAIN = 'frank/app/message-variant/v1'
const SENDER =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const salt = () => Uint8Array.from({ length: 16 }, (_, n) => n)
const facts = (): AuthenticatedMessageVariantFacts => ({
  chainIdentifier: 'monad-testnet',
  sender: { keyType: 1, keyBytes: fromHex(SENDER) },
  wireConversation: { kind: 'absent' },
  claimedMessageId: salt(),
  contentDigest: Uint8Array.from({ length: 32 }, (_, n) => n),
})

// Independently generated with manually framed canonical CBOR and Python's standard-library
// hmac/sha256, before implementation. Pin exact bytes as well as the resulting local identities.
const vectors = [
  {
    conversation: undefined,
    transcript:
      '86781c6672616e6b2f6170702f6d6573736167652d76617269616e742f76316d6d6f6e61642d746573746e6574820158210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798810050000102030405060708090a0b0c0d0e0f5820000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    id: 'message-variant:v1:0ed232dd8ce2da943eff2eced1801c9a49213d1f7353f3f5b4167cbdd17eb3ee',
  },
  {
    conversation: new Uint8Array(16),
    transcript:
      '86781c6672616e6b2f6170702f6d6573736167652d76617269616e742f76316d6d6f6e61642d746573746e6574820158210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f817988201500000000000000000000000000000000050000102030405060708090a0b0c0d0e0f5820000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    id: 'message-variant:v1:06d510cb25a570d5347194d5b1b22111c8cbc24510fcec7ee3aa0f42bc0aa738',
  },
]

it.each(vectors)(
  'matches independent transcript and full-HMAC vector %#',
  vector => {
    const value = facts()
    const wireConversation =
      vector.conversation === undefined
        ? { kind: 'absent' as const }
        : { kind: 'present' as const, id: vector.conversation }
    const framed = encodeCanonical([
      DOMAIN,
      value.chainIdentifier,
      [1, value.sender.keyBytes],
      vector.conversation === undefined ? [0] : [1, vector.conversation],
      value.claimedMessageId,
      value.contentDigest,
    ])
    expect(toHex(framed)).toBe(vector.transcript)
    expect(
      'message-variant:v1:' +
        createHmac('sha256', salt())
          .update(fromHex(vector.transcript))
          .digest('hex'),
    ).toBe(vector.id)
    expect(deriveMessageVariantId(salt(), { ...value, wireConversation })).toBe(
      vector.id,
    )
  },
)

it('agrees across independent account copies and all variant arrival orders', () => {
  const root = new Uint8Array(32).fill(0x7e)
  const deviceA = conversationIdSalt(root)
  const deviceB = conversationIdSalt(Uint8Array.from(root))
  const variants = [0, 1, 2].map(n => ({
    ...facts(),
    contentDigest: new Uint8Array(32).fill(n),
  }))
  const expected = variants.map(value => deriveMessageVariantId(deviceA, value))
  for (const order of [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ]) {
    for (const n of order)
      expect(
        deriveMessageVariantId(deviceB, structuredClone(variants[n])),
      ).toBe(expected[n])
  }
  expect(new Set(expected).size).toBe(3)
})

it('separates every authenticated scope fact and the private account salt', () => {
  const original = deriveMessageVariantId(salt(), facts())
  for (const changed of [
    { ...facts(), chainIdentifier: 'monad-mainnet' },
    {
      ...facts(),
      sender: {
        keyType: 1 as const,
        keyBytes: fromHex('03' + SENDER.slice(2)),
      },
    },
    {
      ...facts(),
      wireConversation: { kind: 'present' as const, id: new Uint8Array(16) },
    },
    {
      ...facts(),
      wireConversation: {
        kind: 'present' as const,
        id: new Uint8Array(16).fill(1),
      },
    },
    { ...facts(), claimedMessageId: new Uint8Array(16).fill(1) },
    { ...facts(), contentDigest: new Uint8Array(32).fill(1) },
  ])
    expect(deriveMessageVariantId(salt(), changed)).not.toBe(original)
  expect(deriveMessageVariantId(new Uint8Array(16).fill(1), facts())).not.toBe(
    original,
  )
  expect(deriveMessageVariantId(salt(), facts())).toMatch(
    /^message-variant:v1:[0-9a-f]{64}$/,
  )
})

it.each(protocolChains.chains.map(chain => chain.id))(
  'accepts exact protocol network %s across all families',
  chainIdentifier => {
    expect(
      deriveMessageVariantId(salt(), { ...facts(), chainIdentifier }),
    ).toMatch(/^message-variant:v1:[0-9a-f]{64}$/)
  },
)

it.each([
  '',
  'evm',
  'monad',
  'MONT',
  '10143',
  'eip155:10143',
  'ecash-testnet',
  'ecash-mainnet',
  'MONAD-TESTNET',
  'monad-testnet ',
  '__proto__',
  'unknown-network',
])(
  'rejects noncanonical chain %s without selecting a default',
  chainIdentifier => {
    expect(() =>
      deriveMessageVariantId(salt(), { ...facts(), chainIdentifier }),
    ).toThrow(/chainIdentifier/)
  },
)

it.each([
  ['missing facts', (): unknown => undefined],
  ['missing sender', () => ({ ...facts(), sender: undefined })],
  [
    'wrong sender type',
    () => ({ ...facts(), sender: { keyType: 2, keyBytes: fromHex(SENDER) } }),
  ],
  [
    'sender address',
    () => ({
      ...facts(),
      sender: { keyType: 1, keyBytes: '0x' + '11'.repeat(20) },
    }),
  ],
  [
    'uncompressed sender',
    () => ({
      ...facts(),
      sender: { keyType: 1, keyBytes: new Uint8Array(65).fill(4) },
    }),
  ],
  [
    'invalid sender point',
    () => ({
      ...facts(),
      sender: { keyType: 1, keyBytes: fromHex('02' + 'ff'.repeat(32)) },
    }),
  ],
  [
    'implicit conversation absence',
    () => ({ ...facts(), wireConversation: undefined }),
  ],
  [
    'UI default conversation',
    () => ({
      ...facts(),
      wireConversation: '01010101-0101-0101-0101-010101010101',
    }),
  ],
  [
    'unknown conversation tag',
    () => ({ ...facts(), wireConversation: { kind: 'default' } }),
  ],
  [
    'absent with an ID',
    () => ({
      ...facts(),
      wireConversation: { kind: 'absent', id: new Uint8Array(16) },
    }),
  ],
  [
    'present without an ID',
    () => ({ ...facts(), wireConversation: { kind: 'present' } }),
  ],
  [
    'short conversation ID',
    () => ({
      ...facts(),
      wireConversation: { kind: 'present', id: new Uint8Array(15) },
    }),
  ],
  ['missing claimed ID', () => ({ ...facts(), claimedMessageId: undefined })],
  [
    'short claimed ID',
    () => ({ ...facts(), claimedMessageId: new Uint8Array(15) }),
  ],
  [
    'long claimed ID',
    () => ({ ...facts(), claimedMessageId: new Uint8Array(17) }),
  ],
  ['missing digest', () => ({ ...facts(), contentDigest: undefined })],
  ['short digest', () => ({ ...facts(), contentDigest: new Uint8Array(31) })],
  ['long digest', () => ({ ...facts(), contentDigest: new Uint8Array(33) })],
  [
    'digest text instead of bytes',
    () => ({ ...facts(), contentDigest: '11'.repeat(32) }),
  ],
] as const)(
  'rejects %s instead of inferring authenticated facts',
  (_label, make) => {
    expect(() =>
      deriveMessageVariantId(
        salt(),
        make() as AuthenticatedMessageVariantFacts,
      ),
    ).toThrow(/Invalid message variant identity/)
  },
)

it.each([
  undefined,
  null,
  [],
  '11'.repeat(16),
  new Uint8Array(15),
  new Uint8Array(17),
])('rejects missing/malformed salt %#', value => {
  expect(() => deriveMessageVariantId(value as Uint8Array, facts())).toThrow(
    /accountSalt/,
  )
})

function truncatedCopy(length: number): Uint8Array {
  const value = new Uint8Array(length)
  Object.defineProperty(value, Symbol.iterator, {
    value: function* () {
      for (let n = 0; n < length - 1; n++) yield n
    },
  })
  return value
}

it('validates the copied byte lengths rather than the original advertised lengths', () => {
  expect(truncatedCopy(16).length).toBe(16)
  expect(() => deriveMessageVariantId(truncatedCopy(16), facts())).toThrow(
    /accountSalt/,
  )
  for (const changed of [
    {
      ...facts(),
      sender: { keyType: 1 as const, keyBytes: truncatedCopy(33) },
    },
    {
      ...facts(),
      wireConversation: { kind: 'present' as const, id: truncatedCopy(16) },
    },
    { ...facts(), claimedMessageId: truncatedCopy(16) },
    { ...facts(), contentDigest: truncatedCopy(32) },
  ])
    expect(() => deriveMessageVariantId(salt(), changed)).toThrow(
      /Invalid message variant identity/,
    )
})

it('uses an isolated domain and leaves existing conversation derivation and input bytes unchanged', () => {
  const accountSalt = salt(),
    value = facts()
  const before = structuredClone({ accountSalt, value })
  const opening = allocateOpeningConversationId(accountSalt, SENDER)
  const id = deriveMessageVariantId(accountSalt, value)
  const fields = [
    value.chainIdentifier,
    [1, value.sender.keyBytes],
    [0],
    value.claimedMessageId,
    value.contentDigest,
  ]
  for (const framed of [
    encodeCanonical(fields),
    encodeCanonical(['frank/app/other/v1', ...fields]),
  ]) {
    expect(id).not.toBe(
      'message-variant:v1:' +
        createHmac('sha256', accountSalt).update(framed).digest('hex'),
    )
  }
  expect(
    id.slice('message-variant:v1:'.length, 'message-variant:v1:'.length + 32),
  ).not.toBe(toHex(opening))
  expect(allocateOpeningConversationId(accountSalt, SENDER)).toEqual(opening)
  expect({ accountSalt, value }).toEqual(before)
})

it('does not depend on receipt/payment metadata, clocks or entropy', () => {
  const original = facts()
  const withReceipt = {
    ...original,
    payloadDigest: 'receipt-a',
    attemptDigest: 'attempt-a',
    serverTime: 1,
    alias: 'first',
  }
  const changedReceipt = {
    ...original,
    payloadDigest: 'receipt-b',
    attemptDigest: 'attempt-b',
    serverTime: 2,
    alias: 'later',
  }
  const expected = deriveMessageVariantId(salt(), original)
  const noClock = jest.spyOn(Date, 'now').mockImplementation(() => {
    throw new Error('clock forbidden')
  })
  const noRandom = jest.spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('entropy forbidden')
  })
  const noCrypto = globalThis.crypto
    ? jest
        .spyOn(globalThis.crypto, 'getRandomValues')
        .mockImplementation(() => {
          throw new Error('entropy forbidden')
        })
    : undefined
  try {
    expect(deriveMessageVariantId(salt(), withReceipt)).toBe(expected)
    expect(deriveMessageVariantId(salt(), changedReceipt)).toBe(expected)
  } finally {
    noClock.mockRestore()
    noRandom.mockRestore()
    noCrypto?.mockRestore()
  }
  expect(withReceipt.payloadDigest).toBe('receipt-a')
  expect(changedReceipt.attemptDigest).toBe('attempt-b')
})
