/**
 * Unit tests for `monad-chain.ts` (ticket #41): verifies `MonadChain` (via `createMonadChain`)
 * wires the real Monad wallet clients together correctly. Per the ticket's own instructions, this
 * mocks the underlying Monad clients (`MonadStampClient`, `MonadTopicPostClient`,
 * `MonadTopicVoteClient`, `monad-message-feed.ts`, `monad-topic-tally-client.ts`, and
 * `monad-identity.ts`'s HTTP-touching `fetchMonadProfile`) rather than `axios` directly -- those
 * clients already have their own tested HTTP layer (see each client's own `*.jest.test.ts`); this
 * file only tests that `MonadChain` calls them with the right arguments and adapts their results
 * correctly.
 *
 * `monad-message-envelope.ts`'s ECDH/AES functions are used for real (not mocked) -- they're pure
 * crypto with no network dependency, and exercising them for real is a stronger check that
 * `directMessages.send`/`fetchSince` actually encrypt/decrypt, not merely pass a plaintext through.
 */
import { getBytes, hexlify } from 'ethers'

import { MonadIdentity } from '../wallet/monad-identity'
import { StoredMonadMessageProto } from '../wallet/monad-stamp-client'
import { MonadTopicPostProto } from '../wallet/monad-topic-post-client'
import { buildTopicPostPayload } from '../wallet/monad-topic-post-client'
import { MessageItem, TextItem } from '../types/messages'

import {
  MonadChainConfig,
  MonadChainWalletHandle,
  createMonadChain,
  deserializeMessageItems,
  serializeMessageItems,
  viewToForumMessage,
} from './monad-chain'
import { WalletHandle } from './active-chain'

jest.mock('../wallet/monad-stamp-client', () => {
  const actual = jest.requireActual('../wallet/monad-stamp-client')
  return {
    ...actual,
    MonadStampClient: jest.fn().mockImplementation(() => ({
      submitStampedMessage: jest.fn(),
    })),
  }
})
jest.mock('../wallet/monad-topic-post-client', () => {
  const actual = jest.requireActual('../wallet/monad-topic-post-client')
  return {
    ...actual,
    MonadTopicPostClient: jest.fn().mockImplementation(() => ({
      submitTopicPost: jest.fn(),
    })),
  }
})
jest.mock('../wallet/monad-topic-vote-client', () => {
  const actual = jest.requireActual('../wallet/monad-topic-vote-client')
  return {
    ...actual,
    MonadTopicVoteClient: jest.fn().mockImplementation(() => ({
      castVote: jest.fn(),
    })),
  }
})
jest.mock('../wallet/monad-message-feed')
jest.mock('../wallet/monad-topic-tally-client')
jest.mock('../wallet/monad-identity', () => {
  const actual = jest.requireActual('../wallet/monad-identity')
  return {
    ...actual,
    fetchMonadProfile: jest.fn(),
  }
})

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MonadStampClient } = jest.requireMock('../wallet/monad-stamp-client')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MonadTopicPostClient } = jest.requireMock(
  '../wallet/monad-topic-post-client',
)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MonadTopicVoteClient } = jest.requireMock(
  '../wallet/monad-topic-vote-client',
)
import { fetchMonadMessagesSince } from '../wallet/monad-message-feed'
import {
  fetchMonadTopicPostView,
  fetchMonadTopicPostsSince,
} from '../wallet/monad-topic-tally-client'
import { fetchMonadProfile } from '../wallet/monad-identity'

const mockedFetchMonadMessagesSince =
  fetchMonadMessagesSince as jest.MockedFunction<typeof fetchMonadMessagesSince>
const mockedFetchMonadTopicPostsSince =
  fetchMonadTopicPostsSince as jest.MockedFunction<
    typeof fetchMonadTopicPostsSince
  >
const mockedFetchMonadTopicPostView =
  fetchMonadTopicPostView as jest.MockedFunction<typeof fetchMonadTopicPostView>
const mockedFetchMonadProfile = fetchMonadProfile as jest.MockedFunction<
  typeof fetchMonadProfile
>

const TEST_CONFIG: MonadChainConfig = {
  rpcUrl: 'http://127.0.0.1:1',
  relayBaseUrl: 'http://relay.test',
  stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
  defaultStampBurnValueWei: 1_000_000_000_000n,
  subAccountPoolSize: 3,
}

const ALICE_PRIVATE_KEY_HEX = '0x' + '11'.repeat(31) + '1a' // 32 bytes, distinct from Bob/Eve below
const BOB_PRIVATE_KEY_HEX = '0x' + '22'.repeat(31) + '2b'
const EVE_PRIVATE_KEY_HEX = '0x' + '33'.repeat(31) + '3c'

function makeWallet(identity: MonadIdentity): MonadChainWalletHandle {
  return {
    identity,
    // These are never dereferenced by real logic in this test file: every client that would
    // actually use them (`MonadStampClient`/`MonadTopicPostClient`/`MonadTopicVoteClient`) is
    // mocked above, so `MonadChain` only ever passes this bundle through to a mock constructor.
    pool: {} as MonadChainWalletHandle['pool'],
    leaseManager: {} as MonadChainWalletHandle['leaseManager'],
    provider: {} as MonadChainWalletHandle['provider'],
    httpClient: {} as MonadChainWalletHandle['httpClient'],
    relayBaseUrl: 'http://relay.test',
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('createMonadChain: basic chain properties', () => {
  const chain = createMonadChain(TEST_CONFIG)

  it('exposes the Monad name/unit', () => {
    expect(chain.name).toBe('monad')
    expect(chain.unit).toBe('MON')
  })

  it('round-trips display <-> raw amounts', () => {
    const raw = 1_500_000_000_000_000_000n // 1.5 MON
    const display = chain.toDisplayAmount(raw)
    expect(chain.fromDisplayAmount(display)).toBe(raw)
  })

  it('formatAddress returns the canonical address string as-is', () => {
    const addr = { raw: '0x000000000000000000000000000000000000dEaD' }
    expect(chain.formatAddress(addr)).toBe(addr.raw)
  })

  it('parseAddress checksums a valid address and normalizes case', () => {
    const parsed = chain.parseAddress(
      '0x000000000000000000000000000000000000dead',
    )
    expect(parsed?.raw).toBe('0x000000000000000000000000000000000000dEaD')
  })

  it('parseAddress returns undefined for garbage input', () => {
    expect(chain.parseAddress('not-an-address')).toBeUndefined()
  })
})

describe('createMonadChain: createWallet', () => {
  const chain = createMonadChain(TEST_CONFIG)
  const seed = {
    mnemonic: 'test test test test test test test test test test test junk',
  }

  it('derives a deterministic, EIP-55-checksummed identity address from the seed', async () => {
    const walletA = await chain.createWallet(seed)
    const walletB = await chain.createWallet(seed)
    expect(walletA.identity.address.raw).toBe(walletB.identity.address.raw)
    expect(walletA.identity.address.raw).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('produces a different identity for a different seed', async () => {
    const walletA = await chain.createWallet(seed)
    const walletB = await chain.createWallet({
      mnemonic:
        'legal winner thank year wave sausage worth useful legal winner thank yellow',
    })
    expect(walletA.identity.address.raw).not.toBe(walletB.identity.address.raw)
  })

  it('pre-derives subAccountPoolSize sub-accounts into the pool', async () => {
    const wallet = (await chain.createWallet(seed)) as MonadChainWalletHandle
    const records = wallet.pool.ensureSize(0)
    expect(records).toHaveLength(TEST_CONFIG.subAccountPoolSize)
  })
})

describe('createMonadChain: fetchProfile', () => {
  it('delegates to monad-identity.fetchMonadProfile with the chain relayBaseUrl', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const addr = { raw: '0x000000000000000000000000000000000000dEaD' }
    const profile = { address: addr, pubKey: new Uint8Array([1, 2, 3]) }
    mockedFetchMonadProfile.mockResolvedValueOnce(profile)

    const result = await chain.fetchProfile(addr)

    expect(result).toBe(profile)
    expect(mockedFetchMonadProfile).toHaveBeenCalledWith({
      relayBaseUrl: TEST_CONFIG.relayBaseUrl,
      address: addr,
    })
  })

  it('returns undefined when nothing is registered', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    mockedFetchMonadProfile.mockResolvedValueOnce(undefined)
    expect(
      await chain.fetchProfile({ raw: '0x' + '00'.repeat(20) }),
    ).toBeUndefined()
  })
})

describe('serializeMessageItems / deserializeMessageItems', () => {
  it('round-trips text/reply/image items', () => {
    const items: MessageItem[] = [
      { type: 'text', text: 'hello' },
      { type: 'reply', payloadDigest: 'ab'.repeat(32) },
    ]
    const plaintext = serializeMessageItems(items)
    expect(deserializeMessageItems(plaintext)).toEqual(items)
  })

  it('rejects stealth items -- no Monad UTXO-payment equivalent exists', () => {
    expect(() =>
      serializeMessageItems([{ type: 'stealth', amount: 1000 }]),
    ).toThrow(/stealth/)
  })

  it('rejects p2pkh items for the same reason', () => {
    expect(() =>
      serializeMessageItems([
        { type: 'p2pkh', address: '0xabc', amount: 1000 },
      ]),
    ).toThrow(/p2pkh/)
  })
})

describe('createMonadChain: directMessages.send', () => {
  it('encrypts the items and submits a real stamped message via MonadStampClient', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)
    const wallet = makeWallet(alice)

    mockedFetchMonadProfile.mockResolvedValueOnce({
      address: bob.address,
      pubKey: new Uint8Array(bob.compressedPubKey),
    })

    const submitStampedMessage = jest.fn().mockResolvedValue({
      stored: {} as StoredMonadMessageProto,
      payloadHashHex: 'deadbeef',
      txHash: '0xtx',
      leaseIndex: 0,
    })
    ;(MonadStampClient as jest.Mock).mockImplementation(() => ({
      submitStampedMessage,
    }))

    const items: MessageItem[] = [{ type: 'text', text: 'hi bob' } as TextItem]
    const result = await chain.directMessages.send({
      wallet,
      recipient: bob.address,
      items,
    })

    expect(result).toEqual({
      payloadDigest: 'deadbeef',
      burnValueWei: TEST_CONFIG.defaultStampBurnValueWei,
    })
    expect(mockedFetchMonadProfile).toHaveBeenCalledWith({
      relayBaseUrl: wallet.relayBaseUrl,
      address: bob.address,
    })
    expect(MonadStampClient).toHaveBeenCalledWith(wallet)
    expect(submitStampedMessage).toHaveBeenCalledTimes(1)
    const call = submitStampedMessage.mock.calls[0][0]
    expect(call.burnAddress).toBe(TEST_CONFIG.stampBurnAddress)
    expect(call.burnValueWei).toBe(TEST_CONFIG.defaultStampBurnValueWei)
    // The envelope is real, encrypted JSON -- not the plaintext items themselves.
    const envelopeJson = JSON.parse(
      new TextDecoder().decode(call.encryptedPayload),
    )
    expect(envelopeJson.from).toBe(alice.address.raw)
    expect(envelopeJson.to).toBe(bob.address.raw)
    expect(typeof envelopeJson.ciphertext).toBe('string')
    expect(JSON.stringify(items)).not.toContain(envelopeJson.ciphertext)
  })

  it('throws if no profile/pubkey is registered for the recipient', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)
    mockedFetchMonadProfile.mockResolvedValueOnce(undefined)

    await expect(
      chain.directMessages.send({
        wallet: makeWallet(alice),
        recipient: bob.address,
        items: [{ type: 'text', text: 'hi' }],
      }),
    ).rejects.toThrow(/No registered profile/)
  })

  it('rejects unsupported item kinds before ever calling fetchProfile/MonadStampClient', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)

    await expect(
      chain.directMessages.send({
        wallet: makeWallet(alice),
        recipient: bob.address,
        items: [{ type: 'stealth', amount: 1 }],
      }),
    ).rejects.toThrow(/stealth/)
    expect(mockedFetchMonadProfile).not.toHaveBeenCalled()
  })
})

describe('createMonadChain: directMessages.fetchSince', () => {
  it('decrypts envelopes addressed to the wallet and skips everything else', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)
    const wallet = makeWallet(bob)

    // Build a real envelope from Alice to Bob, exactly the way `directMessages.send` would.
    const { buildEnvelope } = jest.requireActual(
      '../wallet/monad-message-envelope',
    )
    const items: MessageItem[] = [{ type: 'text', text: 'hi bob' }]
    const envelopeBytes: Uint8Array = buildEnvelope({
      fromAddress: alice.address.raw,
      fromPrivateKey: alice.toBitcorePrivateKey(),
      toAddress: bob.address.raw,
      toPubKey: bob.compressedPubKey,
      plaintext: serializeMessageItems(items),
    })

    // A signed raw burn tx isn't needed for `parseEnvelope`/filtering, but `fetchSince` reads
    // `burnValueWei` back from it -- use an empty rawBurnTx here (the documented `0n` fallback) to
    // keep this test focused on the envelope/decrypt wiring; the burn-value read-back is exercised
    // in registered wallet client tests (`monad-stamp-client.jest.test.ts`) and the field's own
    // `Transaction.from` behavior is standard ethers.
    const addressedToBob: StoredMonadMessageProto = {
      message: {
        rawBurnTx: new Uint8Array(0),
        encryptedPayload: envelopeBytes,
        payloadHash: getBytes('0x' + 'ab'.repeat(32)),
      },
      senderAddress: getBytes('0x' + '11'.repeat(20)),
      txHash: getBytes('0x' + '22'.repeat(32)),
      timestamp: 1_700_000_000_000,
      networkTag: new Uint8Array(0),
    }
    const notAnEnvelope: StoredMonadMessageProto = {
      message: {
        rawBurnTx: new Uint8Array(0),
        encryptedPayload: new TextEncoder().encode(
          JSON.stringify({ hello: 'world' }),
        ),
        payloadHash: getBytes('0x' + 'cd'.repeat(32)),
      },
      senderAddress: getBytes('0x' + '33'.repeat(20)),
      txHash: getBytes('0x' + '44'.repeat(32)),
      timestamp: 1_700_000_001_000,
      networkTag: new Uint8Array(0),
    }

    mockedFetchMonadMessagesSince.mockResolvedValueOnce([
      addressedToBob,
      notAnEnvelope,
    ])
    mockedFetchMonadProfile.mockResolvedValueOnce({
      address: alice.address,
      pubKey: new Uint8Array(alice.compressedPubKey),
    })

    const received = await chain.directMessages.fetchSince({
      wallet,
      sinceMs: 0,
    })

    expect(mockedFetchMonadMessagesSince).toHaveBeenCalledWith({
      relayBaseUrl: wallet.relayBaseUrl,
      sinceMs: 0,
    })
    expect(received).toHaveLength(1)
    expect(received[0].senderAddress.raw).toBe(alice.address.raw)
    expect(received[0].recipientAddress.raw).toBe(bob.address.raw)
    expect(received[0].items).toEqual(items)
    expect(received[0].payloadDigest).toBe('ab'.repeat(32))
    expect(received[0].burnValueWei).toBe(0n)
    expect(received[0].receivedTime).toBe(1_700_000_000_000)
  })

  it('skips envelopes addressed to someone else', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)
    const eve = MonadIdentity.fromPrivateKeyHex(EVE_PRIVATE_KEY_HEX)

    const { buildEnvelope } = jest.requireActual(
      '../wallet/monad-message-envelope',
    )
    const envelopeBytes: Uint8Array = buildEnvelope({
      fromAddress: alice.address.raw,
      fromPrivateKey: alice.toBitcorePrivateKey(),
      toAddress: eve.address.raw,
      toPubKey: eve.compressedPubKey,
      plaintext: serializeMessageItems([{ type: 'text', text: 'not for bob' }]),
    })

    mockedFetchMonadMessagesSince.mockResolvedValueOnce([
      {
        message: {
          rawBurnTx: new Uint8Array(0),
          encryptedPayload: envelopeBytes,
          payloadHash: getBytes('0x' + 'ef'.repeat(32)),
        },
        senderAddress: getBytes('0x' + '11'.repeat(20)),
        txHash: getBytes('0x' + '22'.repeat(32)),
        timestamp: 1_700_000_000_000,
        networkTag: new Uint8Array(0),
      },
    ])

    const received = await chain.directMessages.fetchSince({
      wallet: makeWallet(bob),
      sinceMs: 0,
    })

    expect(received).toHaveLength(0)
    expect(mockedFetchMonadProfile).not.toHaveBeenCalled()
  })
})

describe('createMonadChain: topics.post', () => {
  it('submits a topic post via MonadTopicPostClient and returns its payloadDigest', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const wallet = makeWallet(alice)

    const submitTopicPost = jest.fn().mockResolvedValue({
      stored: {},
      payloadHashHex: 'feedface',
      txHash: '0xtx',
      leaseIndex: 0,
    })
    ;(MonadTopicPostClient as jest.Mock).mockImplementation(() => ({
      submitTopicPost,
    }))

    const result = await chain.topics.post({
      wallet,
      topic: 'general',
      entries: [{ kind: 'post', message: 'hello world' }],
      direction: 'up',
      voteWeightWei: 5_000n,
      parentDigest: 'aa'.repeat(32),
    })

    expect(result).toEqual({ payloadDigest: 'feedface' })
    expect(MonadTopicPostClient).toHaveBeenCalledWith(wallet)
    expect(submitTopicPost).toHaveBeenCalledTimes(1)
    const call = submitTopicPost.mock.calls[0][0]
    expect(call.topic).toBe('general')
    expect(call.direction).toBe('up')
    expect(call.voteWeightWei).toBe(5_000n)
    expect(call.burnAddress).toBe(TEST_CONFIG.stampBurnAddress)
    expect(hexlify(call.parentPostHash)).toBe('0x' + 'aa'.repeat(32))
  })
})

describe('createMonadChain: topics.vote', () => {
  it('casts a vote via MonadTopicVoteClient', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const wallet = makeWallet(alice)

    const castVote = jest.fn().mockResolvedValue({
      stored: {},
      targetPayloadHashHex: 'aa'.repeat(32),
      txHash: '0xtx',
      leaseIndex: 0,
    })
    ;(MonadTopicVoteClient as jest.Mock).mockImplementation(() => ({
      castVote,
    }))

    await chain.topics.vote({
      wallet,
      payloadDigest: 'bb'.repeat(32),
      voteWeightWei: 7_000n,
      direction: 'down',
    })

    expect(MonadTopicVoteClient).toHaveBeenCalledWith(wallet)
    expect(castVote).toHaveBeenCalledTimes(1)
    const call = castVote.mock.calls[0][0]
    expect(hexlify(call.targetPayloadHash)).toBe('0x' + 'bb'.repeat(32))
    expect(call.direction).toBe('down')
    expect(call.voteWeightWei).toBe(7_000n)
    expect(call.burnAddress).toBe(TEST_CONFIG.stampBurnAddress)
  })
})

function makeTopicPostProto(payloadHashByte: number): MonadTopicPostProto {
  return {
    topic: 'general',
    parentPostHash: new Uint8Array(0),
    rawBurnTx: new Uint8Array([1, 2, 3]),
    encryptedPayload: buildTopicPostPayload({
      topic: 'general',
      entries: [{ kind: 'post', title: 'Hi', message: 'Hello, topic!' }],
      timestampMs: 1_700_000_000_000,
    }),
    payloadHash: new Uint8Array(32).fill(payloadHashByte),
  }
}

describe('createMonadChain: topics.fetchByTopic / fetchOne / viewToForumMessage', () => {
  it('viewToForumMessage decodes a real BroadcastMessage payload into ForumMessage', () => {
    const post = makeTopicPostProto(0x11)
    const view = {
      post: {
        post,
        senderAddress: getBytes('0x' + '55'.repeat(20)),
        txHash: getBytes('0x' + '66'.repeat(32)),
        timestamp: 1_700_000_005_000,
        networkTag: new Uint8Array(0),
      },
      voteWeight: 12_345,
    }

    const message = viewToForumMessage(view)

    expect(message).toBeDefined()
    expect(message?.topic).toBe('general')
    expect(message?.satoshis).toBe(12_345)
    expect(message?.payloadDigest).toBe('11'.repeat(32))
    expect(message?.parentDigest).toBeUndefined()
    expect(message?.poster).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(message?.entries).toEqual([
      { kind: 'post', title: 'Hi', url: '', message: 'Hello, topic!' },
    ])
    expect(message?.timestamp).toEqual(new Date(1_700_000_005_000))
  })

  it('viewToForumMessage returns undefined for a view with no stored post', () => {
    expect(
      viewToForumMessage({ post: undefined, voteWeight: 0 }),
    ).toBeUndefined()
  })

  it('fetchByTopic maps every returned view via viewToForumMessage', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const wallet = makeWallet(alice)
    const post = makeTopicPostProto(0x22)

    mockedFetchMonadTopicPostsSince.mockResolvedValueOnce([
      {
        post: {
          post,
          senderAddress: getBytes('0x' + '77'.repeat(20)),
          txHash: getBytes('0x' + '88'.repeat(32)),
          timestamp: 1_700_000_010_000,
          networkTag: new Uint8Array(0),
        },
        voteWeight: 999,
      },
    ])

    const messages = await chain.topics.fetchByTopic({
      wallet,
      topic: 'general',
      sinceMs: 42,
    })

    expect(mockedFetchMonadTopicPostsSince).toHaveBeenCalledWith({
      relayBaseUrl: wallet.relayBaseUrl,
      topic: 'general',
      sinceMs: 42,
    })
    expect(messages).toHaveLength(1)
    expect(messages[0].payloadDigest).toBe('22'.repeat(32))
  })

  it('fetchOne reads via the chain-level relayBaseUrl (no wallet needed)', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const post = makeTopicPostProto(0x33)

    mockedFetchMonadTopicPostView.mockResolvedValueOnce({
      post: {
        post,
        senderAddress: getBytes('0x' + '99'.repeat(20)),
        txHash: getBytes('0x' + 'aa'.repeat(32)),
        timestamp: 1_700_000_020_000,
        networkTag: new Uint8Array(0),
      },
      voteWeight: 1,
    })

    const message = await chain.topics.fetchOne('33'.repeat(32))

    expect(mockedFetchMonadTopicPostView).toHaveBeenCalledWith({
      relayBaseUrl: TEST_CONFIG.relayBaseUrl,
      payloadHashHex: '33'.repeat(32),
    })
    expect(message?.payloadDigest).toBe('33'.repeat(32))
  })

  it('fetchOne returns undefined when nothing is stored under that hash', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    mockedFetchMonadTopicPostView.mockResolvedValueOnce(undefined)
    expect(await chain.topics.fetchOne('00'.repeat(32))).toBeUndefined()
  })
})

describe('asMonadWallet guard (exercised indirectly via directMessages/topics)', () => {
  it('throws a clear error when handed a bare WalletHandle missing the wallet-client bundle', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const bareWallet: WalletHandle = { identity: alice }

    await expect(
      chain.directMessages.fetchSince({ wallet: bareWallet, sinceMs: 0 }),
    ).rejects.toThrow(/MonadChainWalletHandle/)
  })
})
