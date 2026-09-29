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
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Transaction, Wallet, getBytes, hexlify } from 'ethers'

import { MonadIdentity } from '../monad-identity'
import {
  buildMonadStampCalldata,
  computeMonadStampCommitment,
  computeMonadStampPaymentCommitment,
  StoredMonadMessageProto,
  encodeMonadStampedMessage,
} from '../monad-stamp-client'
import { MonadTopicPostProto } from '../monad-topic-post-client'
import { buildTopicPostPayload } from '../monad-topic-post-client'
import { MessageItem, TextItem } from '@frank/cashweb/types/messages'

import {
  MonadChainConfig,
  MonadChainWalletHandle,
  createMonadChain,
  deserializeMessageItems,
  resolveLegacyAttemptRecipientFromEnvelope,
  serializeMessageItems,
  viewToForumMessage,
} from './monad-chain'
import { WalletHandle } from './active-chain'
import {
  deriveMonadStampChildPrivate,
  deriveMonadStampChildPublic,
} from '../monad-stamp-stealth'
import {
  InMemoryStampPaymentJournal,
  LevelStampPaymentJournal,
} from '../storage/stamp-payment-journal'
import { buildEnvelope } from '@frank/cashweb/relay/monad-message-envelope'
import { MonadRpcError } from '../monad-http'
import { openMonadWalletBundle } from '../storage/monad-wallet-bundle'

jest.mock('../storage/monad-wallet-bundle', () => {
  const actual = jest.requireActual('../storage/monad-wallet-bundle')
  return { ...actual, assertMonadWalletBundleProvenance: jest.fn() }
})

jest.mock('../monad-stamp-client', () => {
  const actual = jest.requireActual('../monad-stamp-client')
  return {
    ...actual,
    MonadStampClient: jest.fn().mockImplementation(() => ({
      submitStampedMessage: jest.fn(),
      resumePendingAttempts: jest.fn().mockResolvedValue([]),
      reconcileOrThrow: jest.fn().mockResolvedValue(undefined),
    })),
    quoteMonadStampPaymentGasReserve: jest.fn().mockResolvedValue(100n),
  }
})
jest.mock('../monad-topic-post-client', () => {
  const actual = jest.requireActual('../monad-topic-post-client')
  return {
    ...actual,
    MonadTopicPostClient: jest.fn().mockImplementation(() => ({
      submitTopicPost: jest.fn(),
    })),
  }
})
jest.mock('../monad-topic-vote-client', () => {
  const actual = jest.requireActual('../monad-topic-vote-client')
  return {
    ...actual,
    MonadTopicVoteClient: jest.fn().mockImplementation(() => ({
      castVote: jest.fn(),
    })),
  }
})
jest.mock('@frank/cashweb/relay/monad-message-feed')
jest.mock('../monad-topic-tally-client')
jest.mock('../monad-identity', () => {
  const actual = jest.requireActual('../monad-identity')
  return {
    ...actual,
    fetchMonadProfile: jest.fn(),
  }
})
jest.mock('../monad-account-tx', () => {
  const actual = jest.requireActual('../monad-account-tx')
  return {
    ...actual,
    MonadAccountTxSigner: jest.fn(),
  }
})

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MonadStampClient } = jest.requireMock('../monad-stamp-client')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MonadTopicPostClient } = jest.requireMock('../monad-topic-post-client')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MonadTopicVoteClient } = jest.requireMock('../monad-topic-vote-client')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MonadAccountTxSigner } = jest.requireMock('../monad-account-tx')
import { fetchMonadMessagesSince } from '@frank/cashweb/relay/monad-message-feed'
import {
  fetchDiscoveredTopics,
  fetchMonadTopicPostView,
  fetchMonadTopicPostsSince,
} from '../monad-topic-tally-client'
import { fetchMonadProfile } from '../monad-identity'

const mockedFetchMonadMessagesSince =
  fetchMonadMessagesSince as jest.MockedFunction<typeof fetchMonadMessagesSince>
const mockedFetchMonadTopicPostsSince =
  fetchMonadTopicPostsSince as jest.MockedFunction<
    typeof fetchMonadTopicPostsSince
  >
const mockedFetchMonadTopicPostView =
  fetchMonadTopicPostView as jest.MockedFunction<typeof fetchMonadTopicPostView>
const mockedFetchDiscoveredTopics =
  fetchDiscoveredTopics as jest.MockedFunction<typeof fetchDiscoveredTopics>
const mockedFetchMonadProfile = fetchMonadProfile as jest.MockedFunction<
  typeof fetchMonadProfile
>

const TEST_CONFIG: MonadChainConfig = {
  rpcUrl: 'http://127.0.0.1:1',
  relayBaseUrl: 'http://relay.test',
  networkTag: 'MONT',
  stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
  defaultStampValueWei: 1_000_000_000_000n,
  defaultTopicVoteValueWei: 1_000_000_000_000n,
  subAccountPoolSize: 3,
  walletStorageLocation: false,
}

const ALICE_PRIVATE_KEY_HEX = '0x' + '11'.repeat(31) + '1a' // 32 bytes, distinct from Bob/Eve below
const BOB_PRIVATE_KEY_HEX = '0x' + '22'.repeat(31) + '2b'
const EVE_PRIVATE_KEY_HEX = '0x' + '33'.repeat(31) + '3c'

function makeWallet(identity: MonadIdentity): MonadChainWalletHandle {
  const wallet = {
    identity,
    // These are never dereferenced by real logic in this test file: every client that would
    // actually use them (`MonadStampClient`/`MonadTopicPostClient`/`MonadTopicVoteClient`) is
    // mocked above, so `MonadChain` only ever passes this bundle through to a mock constructor.
    pool: {
      prepareStampInventory: jest.fn().mockResolvedValue({
        fundingTxHashes: [],
        selectedAccountCount: 2,
      }),
    } as unknown as MonadChainWalletHandle['pool'],
    leaseManager: {} as MonadChainWalletHandle['leaseManager'],
    provider: {} as MonadChainWalletHandle['provider'],
    httpClient: {} as MonadChainWalletHandle['httpClient'],
    relayBaseUrl: 'http://relay.test',
  } as MonadChainWalletHandle
  wallet.walletState = {
    durability: 'persistent',
    assertOpen: jest.fn(),
    runOperation: jest.fn(<T>(operation: () => Promise<T>) => operation()),
  } as MonadChainWalletHandle['walletState']
  return wallet
}

async function signedChildSweep(params: {
  identity: MonadIdentity
  payloadDigest: string
  childIndex: number
  destination: string
  valueWei: bigint
  nonce?: number
}) {
  const child = deriveMonadStampChildPrivate({
    payloadHash: getBytes(`0x${params.payloadDigest}`),
    recipientPrivateKey: getBytes(params.identity.toPrivateKeyHex()),
    paymentIndex: params.childIndex,
  })
  const rawTx = await new Wallet(hexlify(child.privateKey)).signTransaction({
    to: params.destination,
    value: params.valueWei,
    nonce: params.nonce ?? 0,
    gasLimit: 21_000n,
    gasPrice: 1n,
    chainId: 1,
  })
  return {
    to: params.destination,
    value: params.valueWei,
    rawTx,
    txHash: Transaction.from(rawTx).hash as string,
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
    expect(chain.defaultTopicVoteValue).toBe(
      TEST_CONFIG.defaultTopicVoteValueWei
    )
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
      '0x000000000000000000000000000000000000dead'
    )
    expect(parsed?.raw).toBe('0x000000000000000000000000000000000000dEaD')
  })

  it('parseAddress returns undefined for garbage input', () => {
    expect(chain.parseAddress('not-an-address')).toBeUndefined()
  })
})

describe('legacy attempt recipient authority', () => {
  it('resolves only the profile key bound to the retained envelope recipient', async () => {
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)
    const envelope = buildEnvelope({
      fromAddress: alice.address.raw,
      fromPrivateKey: alice.toBitcorePrivateKey(),
      toAddress: bob.address.raw,
      toPubKey: bob.compressedPubKey,
      plaintext: 'legacy',
      networkTag: TEST_CONFIG.networkTag,
    })
    const messageBytes = encodeMonadStampedMessage({
      stampPayments: [],
      encryptedPayload: envelope,
      payloadHash: getBytes(`0x${'ab'.repeat(32)}`),
    })
    mockedFetchMonadProfile.mockResolvedValueOnce({
      address: bob.address,
      pubKey: new Uint8Array(bob.compressedPubKey),
    })
    await expect(
      resolveLegacyAttemptRecipientFromEnvelope({
        relayBaseUrl: TEST_CONFIG.relayBaseUrl,
        messageBytes,
      })
    ).resolves.toEqual(new Uint8Array(bob.compressedPubKey))

    await expect(
      resolveLegacyAttemptRecipientFromEnvelope({
        relayBaseUrl: TEST_CONFIG.relayBaseUrl,
        messageBytes,
      })
    ).rejects.toThrow(/does not match/i)
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
    expect(walletB).toBe(walletA)
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

  it('pre-derives unfunded accounts without moving funds on wallet open', async () => {
    const wallet = (await chain.createWallet(seed)) as MonadChainWalletHandle
    const records = wallet.pool.ensureSize(0)
    expect(records).toHaveLength(TEST_CONFIG.subAccountPoolSize)
    expect(records.every((record) => record.status === 'unfunded')).toBe(true)
    expect(MonadAccountTxSigner).not.toHaveBeenCalled()
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
      await chain.fetchProfile({ raw: '0x' + '00'.repeat(20) })
    ).toBeUndefined()
  })

  it('uses opts.relayBaseUrl instead of the chain default when given (ticket #78)', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const addr = { raw: '0x000000000000000000000000000000000000dEaD' }
    const profile = { address: addr, pubKey: new Uint8Array([1, 2, 3]) }
    mockedFetchMonadProfile.mockResolvedValueOnce(profile)

    const result = await chain.fetchProfile(addr, {
      relayBaseUrl: 'https://someone-elses-relay.example',
    })

    expect(result).toBe(profile)
    expect(mockedFetchMonadProfile).toHaveBeenCalledWith({
      relayBaseUrl: 'https://someone-elses-relay.example',
      address: addr,
    })
  })
})

describe('createMonadChain: nativeTransfers', () => {
  it('reads the stable identity EOA balance from the Monad provider', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const identity = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const wallet = makeWallet(identity)
    const getBalance = jest.fn().mockResolvedValue(123n)
    wallet.provider = { getBalance } as MonadChainWalletHandle['provider']

    await expect(chain.nativeTransfers.getBalance({ wallet })).resolves.toBe(
      123n
    )
    expect(getBalance).toHaveBeenCalledWith(identity.address.raw)
  })

  it('builds and submits a plain transfer from the stable identity EOA', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const identity = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const wallet = makeWallet(identity)
    const recipient = chain.parseAddress(
      '0x000000000000000000000000000000000000dead'
    )
    expect(recipient).toBeDefined()

    const signed = { txHash: '0xsigned' }
    const buildAndSignTransfer = jest.fn().mockResolvedValue(signed)
    const submit = jest.fn().mockResolvedValue('0xbroadcast')
    ;(MonadAccountTxSigner as jest.Mock).mockImplementation(() => ({
      buildAndSignTransfer,
      submit,
    }))

    await expect(
      chain.nativeTransfers.send({
        wallet,
        recipient: recipient!,
        value: 1_500_000_000_000_000_000n,
      })
    ).resolves.toEqual({ txHash: '0xbroadcast' })

    expect(MonadAccountTxSigner).toHaveBeenCalledWith({
      privateKey: identity.toPrivateKeyHex(),
      provider: wallet.provider,
      httpClient: wallet.httpClient,
    })
    expect(buildAndSignTransfer).toHaveBeenCalledWith(
      recipient!.raw,
      1_500_000_000_000_000_000n
    )
    expect(submit).toHaveBeenCalledWith(signed)
    expect(wallet.walletState?.runOperation).toHaveBeenCalledTimes(1)
  })

  it('rejects zero-value transfers before constructing a signer', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const identity = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)

    await expect(
      chain.nativeTransfers.send({
        wallet: makeWallet(identity),
        recipient: identity.address,
        value: 0n,
      })
    ).rejects.toThrow('Transfer value must be greater than zero')
    expect(MonadAccountTxSigner).not.toHaveBeenCalled()
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
      serializeMessageItems([{ type: 'stealth', amount: 1000 }])
    ).toThrow(/stealth/)
  })

  it('rejects p2pkh items for the same reason', () => {
    expect(() =>
      serializeMessageItems([{ type: 'p2pkh', address: '0xabc', amount: 1000 }])
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
      txHashes: ['0xtx'],
      leaseIndices: [0],
    })
    ;(MonadStampClient as jest.Mock).mockImplementation(() => ({
      submitStampedMessage,
      reconcileOrThrow: jest.fn().mockResolvedValue(undefined),
    }))

    const items: MessageItem[] = [{ type: 'text', text: 'hi bob' } as TextItem]
    const onPreparationProgress = jest.fn()
    const requestedStampValue = TEST_CONFIG.defaultStampValueWei * 2n
    const result = await chain.directMessages.send({
      wallet,
      recipient: bob.address,
      items,
      stampValue: requestedStampValue,
      onPreparationProgress,
    })

    expect(result).toEqual({
      payloadDigest: 'deadbeef',
      stampValueWei: requestedStampValue,
      stampPayments: [],
      preparationTxHashes: [],
    })
    expect(mockedFetchMonadProfile).toHaveBeenCalledWith({
      relayBaseUrl: wallet.relayBaseUrl,
      address: bob.address,
    })
    expect(MonadStampClient).toHaveBeenCalledWith(
      expect.objectContaining({
        walletState: wallet.walletState,
        provider: wallet.provider,
        httpClient: wallet.httpClient,
        relayBaseUrl: wallet.relayBaseUrl,
      })
    )
    expect(wallet.pool.prepareStampInventory).toHaveBeenCalledWith(
      expect.objectContaining({
        stampValueWei: requestedStampValue,
        onProgress: onPreparationProgress,
      })
    )
    expect(submitStampedMessage).toHaveBeenCalledTimes(1)
    const call = submitStampedMessage.mock.calls[0][0]
    // Ticket #57: a DM's stamp pays the recipient -- it must NOT be the fixed
    // `stampBurnAddress` (that's `topics.post`/`vote`'s job, no single recipient there).
    expect(call.recipientPublicKey).toEqual(
      new Uint8Array(bob.compressedPubKey)
    )
    expect(call.stampValueWei).toBe(requestedStampValue)
    // The envelope is real, encrypted JSON -- not the plaintext items themselves.
    const envelopeJson = JSON.parse(
      new TextDecoder().decode(call.encryptedPayload)
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
      })
    ).rejects.toThrow(/No registered profile/)
  })

  it('rejects a profile key not bound to the requested recipient before funding or signing', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)
    const eve = MonadIdentity.fromPrivateKeyHex(EVE_PRIVATE_KEY_HEX)
    const wallet = makeWallet(alice)
    mockedFetchMonadProfile.mockResolvedValueOnce({
      address: bob.address,
      pubKey: new Uint8Array(eve.compressedPubKey),
    })

    await expect(
      chain.directMessages.send({
        wallet,
        recipient: bob.address,
        items: [{ type: 'text', text: 'must not fund' }],
      })
    ).rejects.toThrow(/profile key does not match recipient/i)

    expect(wallet.pool.prepareStampInventory).not.toHaveBeenCalled()
    expect(MonadAccountTxSigner).not.toHaveBeenCalled()
  })

  it('rejects an uncompressed recipient key before funding or signing', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)
    const wallet = makeWallet(alice)
    mockedFetchMonadProfile.mockResolvedValueOnce({
      address: bob.address,
      pubKey: getBytes(new Wallet(BOB_PRIVATE_KEY_HEX).signingKey.publicKey),
    })

    await expect(
      chain.directMessages.send({
        wallet,
        recipient: bob.address,
        items: [{ type: 'text', text: 'must not fund' }],
      })
    ).rejects.toThrow(/compressed 33-byte/i)
    expect(wallet.pool.prepareStampInventory).not.toHaveBeenCalled()
    expect(MonadAccountTxSigner).not.toHaveBeenCalled()
  })

  it('runs the client-owned reconciliation preflight before profile lookup or inventory preparation', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)
    const wallet = makeWallet(alice)
    const failure = new Error('retained exact set')
    ;(MonadStampClient as jest.Mock).mockImplementation(() => ({
      reconcileOrThrow: jest.fn().mockRejectedValue(failure),
      submitStampedMessage: jest.fn(),
    }))

    await expect(
      chain.directMessages.send({
        wallet,
        recipient: bob.address,
        items: [{ type: 'text', text: 'must wait' }],
      })
    ).rejects.toBe(failure)

    expect(mockedFetchMonadProfile).not.toHaveBeenCalled()
    expect(wallet.pool.prepareStampInventory).not.toHaveBeenCalled()
  })

  it('serializes concurrent sends through preparation, payment, and relay submission', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)
    const wallet = makeWallet(alice)
    mockedFetchMonadProfile.mockResolvedValue({
      address: bob.address,
      pubKey: new Uint8Array(bob.compressedPubKey),
    })

    let finishFirst!: (value: unknown) => void
    const firstPending = new Promise((resolve) => {
      finishFirst = resolve
    })
    const submitStampedMessage = jest
      .fn()
      .mockImplementationOnce(() => firstPending)
      .mockResolvedValueOnce({ payloadHashHex: 'second' })
    ;(MonadStampClient as jest.Mock).mockImplementation(() => ({
      submitStampedMessage,
      reconcileOrThrow: jest.fn().mockResolvedValue(undefined),
    }))

    const first = chain.directMessages.send({
      wallet,
      recipient: bob.address,
      items: [{ type: 'text', text: 'first' }],
    })
    await new Promise((resolve) => setImmediate(resolve))
    const second = chain.directMessages.send({
      wallet,
      recipient: bob.address,
      items: [{ type: 'text', text: 'second' }],
    })
    await new Promise((resolve) => setImmediate(resolve))

    expect(submitStampedMessage).toHaveBeenCalledTimes(1)
    expect(mockedFetchMonadProfile).toHaveBeenCalledTimes(1)

    finishFirst({ payloadHashHex: 'first' })
    await expect(first).resolves.toEqual(
      expect.objectContaining({ payloadDigest: 'first' })
    )
    await expect(second).resolves.toEqual(
      expect.objectContaining({ payloadDigest: 'second' })
    )
    expect(submitStampedMessage).toHaveBeenCalledTimes(2)
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
      })
    ).rejects.toThrow(/stealth/)
    expect(mockedFetchMonadProfile).not.toHaveBeenCalled()
  })
})

describe('createMonadChain: directMessages.fetchSince', () => {
  it('enforces the shared 1..64 payment bound before processing a feed row', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const wallet = makeWallet(
      MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)
    )
    const recordWithCount = (count: number): StoredMonadMessageProto => ({
      message: {
        stampPayments: Array.from({ length: count }, (_, childIndex) => ({
          childIndex,
          rawTx: new Uint8Array([1]),
        })),
        encryptedPayload: new Uint8Array([1]),
        payloadHash: getBytes(`0x${'ab'.repeat(32)}`),
      },
      timestamp: 1,
      networkTag: new Uint8Array(),
    })
    for (const count of [0, 65]) {
      mockedFetchMonadMessagesSince.mockResolvedValueOnce([
        recordWithCount(count),
      ])
      await expect(
        chain.directMessages.fetchSince({ wallet, sinceMs: 0 })
      ).resolves.toEqual([])
    }
    mockedFetchMonadMessagesSince.mockResolvedValueOnce([recordWithCount(64)])
    await expect(
      chain.directMessages.fetchSince({ wallet, sinceMs: 0 })
    ).resolves.toEqual([])
  })
  it('rejects bad payload hashes and calldata before journaling incoming payments', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)
    const wallet = makeWallet(bob)
    const journal = new InMemoryStampPaymentJournal()
    wallet.stampPaymentJournal = journal
    const envelope = buildEnvelope({
      fromAddress: alice.address.raw,
      fromPrivateKey: alice.toBitcorePrivateKey(),
      toAddress: bob.address.raw,
      toPubKey: bob.compressedPubKey,
      plaintext: serializeMessageItems([{ type: 'text', text: 'poison' }]),
      networkTag: TEST_CONFIG.networkTag,
    })
    const payloadHash = computeMonadStampCommitment(envelope)
    const destination = deriveMonadStampChildPublic({
      payloadHash,
      recipientPublicKey: new Uint8Array(bob.compressedPubKey),
      paymentIndex: 0,
    }).address
    const sign = (data: string) =>
      new Wallet(ALICE_PRIVATE_KEY_HEX).signTransaction({
        to: destination,
        value: 1n,
        data,
        nonce: 0,
        gasLimit: 50_000n,
        gasPrice: 1n,
        chainId: 1,
      })
    const record = async (hash: Uint8Array, data: string) => ({
      message: {
        stampPayments: [{ childIndex: 0, rawTx: getBytes(await sign(data)) }],
        encryptedPayload: envelope,
        payloadHash: hash,
      },
      timestamp: 1,
      networkTag: new Uint8Array(),
    })

    mockedFetchMonadMessagesSince.mockResolvedValueOnce([
      await record(getBytes(`0x${'ff'.repeat(32)}`), '0x'),
    ])
    await expect(
      chain.directMessages.fetchSince({ wallet, sinceMs: 0 })
    ).resolves.toEqual([])
    expect(journal.getAll()).toEqual([])

    mockedFetchMonadMessagesSince.mockResolvedValueOnce([
      await record(payloadHash, '0x1234'),
    ])
    await expect(
      chain.directMessages.fetchSince({ wallet, sinceMs: 0 })
    ).resolves.toEqual([])
    expect(journal.getAll()).toEqual([])

    const validData = buildMonadStampCalldata(
      computeMonadStampPaymentCommitment(payloadHash, 0)
    )
    mockedFetchMonadMessagesSince.mockResolvedValueOnce([
      await record(payloadHash, '0x1234'),
      await record(payloadHash, validData),
    ])
    mockedFetchMonadProfile.mockResolvedValueOnce({
      address: alice.address,
      pubKey: new Uint8Array(alice.compressedPubKey),
    })
    await expect(
      chain.directMessages.fetchSince({ wallet, sinceMs: 0 })
    ).resolves.toHaveLength(1)
    expect(journal.getAll()).toHaveLength(1)

    for (const pubKey of [
      getBytes(new Wallet(ALICE_PRIVATE_KEY_HEX).signingKey.publicKey),
      new Uint8Array(
        MonadIdentity.fromPrivateKeyHex(EVE_PRIVATE_KEY_HEX).compressedPubKey
      ),
    ]) {
      mockedFetchMonadMessagesSince.mockResolvedValueOnce([
        await record(payloadHash, validData),
      ])
      mockedFetchMonadProfile.mockResolvedValueOnce({
        address: alice.address,
        pubKey,
      })
      await expect(
        chain.directMessages.fetchSince({ wallet, sinceMs: 0 })
      ).resolves.toEqual([])
      expect(journal.getAll()).toHaveLength(1)
    }
  })
  it('isolates a paid envelope with malformed addresses before journaling or profile lookup', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)
    const wallet = makeWallet(bob)
    const journal = new InMemoryStampPaymentJournal()
    wallet.stampPaymentJournal = journal

    const validEnvelope = buildEnvelope({
      fromAddress: alice.address.raw,
      fromPrivateKey: alice.toBitcorePrivateKey(),
      toAddress: bob.address.raw,
      toPubKey: bob.compressedPubKey,
      plaintext: serializeMessageItems([{ type: 'text', text: 'valid' }]),
      networkTag: TEST_CONFIG.networkTag,
    })
    const malformedObject = JSON.parse(
      new TextDecoder().decode(validEnvelope)
    ) as Record<string, unknown>
    malformedObject.from = 'not-an-evm-address'
    const malformedEnvelope = new TextEncoder().encode(
      JSON.stringify(malformedObject)
    )
    const makeRecord = async (
      envelope: Uint8Array,
      nonce: number
    ): Promise<StoredMonadMessageProto> => {
      const payloadHash = computeMonadStampCommitment(envelope)
      const destination = deriveMonadStampChildPublic({
        payloadHash,
        recipientPublicKey: new Uint8Array(bob.compressedPubKey),
        paymentIndex: 0,
      }).address
      const rawTx = await new Wallet(ALICE_PRIVATE_KEY_HEX).signTransaction({
        to: destination,
        value: 1n,
        data: buildMonadStampCalldata(
          computeMonadStampPaymentCommitment(payloadHash, 0)
        ),
        nonce,
        gasLimit: 50_000n,
        gasPrice: 1n,
        chainId: 1,
      })
      return {
        message: {
          stampPayments: [{ childIndex: 0, rawTx: getBytes(rawTx) }],
          encryptedPayload: envelope,
          payloadHash,
        },
        timestamp: nonce + 1,
        networkTag: new Uint8Array(),
      }
    }
    mockedFetchMonadMessagesSince.mockResolvedValueOnce([
      await makeRecord(malformedEnvelope, 0),
      await makeRecord(validEnvelope, 1),
    ])
    mockedFetchMonadProfile.mockResolvedValueOnce({
      address: alice.address,
      pubKey: new Uint8Array(alice.compressedPubKey),
    })

    await expect(
      chain.directMessages.fetchSince({ wallet, sinceMs: 0 })
    ).resolves.toHaveLength(1)
    expect(mockedFetchMonadProfile).toHaveBeenCalledTimes(1)
    expect(mockedFetchMonadProfile).toHaveBeenCalledWith(
      expect.objectContaining({ address: alice.address })
    )
    expect(journal.getAll()).toHaveLength(1)
    expect(journal.getAll()[0].payloadHashHex).toBe(
      hexlify(computeMonadStampCommitment(validEnvelope)).slice(2)
    )
  })
  it('durably journals only rows whose profile, decryption, and items fully validate', async () => {
    const location = mkdtempSync(join(tmpdir(), 'monad-incoming-preflight-'))
    const chain = createMonadChain(TEST_CONFIG)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)
    const eve = MonadIdentity.fromPrivateKeyHex(EVE_PRIVATE_KEY_HEX)
    const wallet = makeWallet(bob)
    const journal = new LevelStampPaymentJournal(location)
    await journal.Open()
    wallet.stampPaymentJournal = journal
    let journalClosed = false

    const paidRecord = async (
      plaintext: string,
      nonce: number,
      corruptCiphertext = false
    ): Promise<StoredMonadMessageProto> => {
      let encryptedPayload = buildEnvelope({
        fromAddress: alice.address.raw,
        fromPrivateKey: alice.toBitcorePrivateKey(),
        toAddress: bob.address.raw,
        toPubKey: bob.compressedPubKey,
        plaintext,
        networkTag: TEST_CONFIG.networkTag,
      })
      if (corruptCiphertext) {
        const parsed = JSON.parse(
          new TextDecoder().decode(encryptedPayload)
        ) as Record<string, unknown>
        parsed.ciphertext = '00'
        encryptedPayload = new TextEncoder().encode(JSON.stringify(parsed))
      }
      const payloadHash = computeMonadStampCommitment(encryptedPayload)
      const child = deriveMonadStampChildPublic({
        payloadHash,
        recipientPublicKey: new Uint8Array(bob.compressedPubKey),
        paymentIndex: 0,
      })
      const rawTx = await new Wallet(ALICE_PRIVATE_KEY_HEX).signTransaction({
        to: child.address,
        value: 1n,
        data: buildMonadStampCalldata(
          computeMonadStampPaymentCommitment(payloadHash, 0)
        ),
        nonce,
        gasLimit: 50_000n,
        gasPrice: 1n,
        chainId: 1,
      })
      return {
        message: {
          stampPayments: [{ childIndex: 0, rawTx: getBytes(rawTx) }],
          encryptedPayload,
          payloadHash,
        },
        timestamp: nonce + 1,
        networkTag: new Uint8Array(),
      }
    }

    try {
      const cases = [
        {
          record: await paidRecord(
            serializeMessageItems([{ type: 'text', text: 'missing' }]),
            10
          ),
          profile: undefined,
        },
        {
          record: await paidRecord(
            serializeMessageItems([{ type: 'text', text: 'wrong key' }]),
            11
          ),
          profile: {
            address: alice.address,
            pubKey: new Uint8Array(eve.compressedPubKey),
          },
        },
        {
          record: await paidRecord(
            serializeMessageItems([{ type: 'text', text: 'bad cipher' }]),
            12,
            true
          ),
          profile: {
            address: alice.address,
            pubKey: new Uint8Array(alice.compressedPubKey),
          },
        },
        {
          record: await paidRecord(
            JSON.stringify([{ type: 'not-supported', value: 'poison' }]),
            13
          ),
          profile: {
            address: alice.address,
            pubKey: new Uint8Array(alice.compressedPubKey),
          },
        },
      ]
      for (const candidate of cases) {
        mockedFetchMonadMessagesSince.mockResolvedValueOnce([candidate.record])
        mockedFetchMonadProfile.mockResolvedValueOnce(candidate.profile)
        await expect(
          chain.directMessages.fetchSince({ wallet, sinceMs: 0 })
        ).resolves.toEqual([])
        expect(journal.getAll()).toEqual([])
      }

      const valid = await paidRecord(
        serializeMessageItems([{ type: 'text', text: 'valid' }]),
        14
      )
      mockedFetchMonadMessagesSince.mockResolvedValueOnce([valid])
      mockedFetchMonadProfile.mockResolvedValueOnce({
        address: alice.address,
        pubKey: new Uint8Array(alice.compressedPubKey),
      })
      await expect(
        chain.directMessages.fetchSince({ wallet, sinceMs: 0 })
      ).resolves.toHaveLength(1)
      expect(journal.getAll()).toHaveLength(1)
      await journal.Close()
      journalClosed = true

      const reopened = new LevelStampPaymentJournal(location)
      await reopened.Open()
      expect(reopened.getAll()).toHaveLength(1)
      await reopened.Close()
    } finally {
      if (!journalClosed) await journal.Close().catch(() => undefined)
      rmSync(location, { recursive: true, force: true })
    }
  })

  it('decrypts envelopes addressed to the wallet and skips everything else', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)
    const wallet = makeWallet(bob)
    const stampPaymentJournal = new InMemoryStampPaymentJournal()
    wallet.stampPaymentJournal = stampPaymentJournal
    wallet.provider = {
      getBalance: jest.fn().mockResolvedValue(0n),
      getFeeData: jest.fn().mockResolvedValue({ maxFeePerGas: 1n }),
    } as unknown as MonadChainWalletHandle['provider']

    // Build a real envelope from Alice to Bob, exactly the way `directMessages.send` would.
    const { buildEnvelope } = jest.requireActual(
      '@frank/cashweb/relay/monad-message-envelope'
    )
    const items: MessageItem[] = [{ type: 'text', text: 'hi bob' }]
    const envelopeBytes: Uint8Array = buildEnvelope({
      fromAddress: alice.address.raw,
      fromPrivateKey: alice.toBitcorePrivateKey(),
      toAddress: bob.address.raw,
      toPubKey: bob.compressedPubKey,
      plaintext: serializeMessageItems(items),
      networkTag: TEST_CONFIG.networkTag,
    })

    const payloadHash = computeMonadStampCommitment(envelopeBytes)
    const payloadHashHex = hexlify(payloadHash).slice(2)
    const stampDestination = deriveMonadStampChildPublic({
      payloadHash,
      recipientPublicKey: new Uint8Array(bob.compressedPubKey),
      paymentIndex: 0,
    })
    const rawStampPayment = await new Wallet(
      ALICE_PRIVATE_KEY_HEX
    ).signTransaction({
      type: 2,
      chainId: 10143,
      nonce: 0,
      to: stampDestination.address,
      value: 123n,
      data: buildMonadStampCalldata(
        computeMonadStampPaymentCommitment(payloadHash, 0)
      ),
      gasLimit: 60_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    })
    const addressedToBob: StoredMonadMessageProto = {
      message: {
        stampPayments: [{ childIndex: 0, rawTx: getBytes(rawStampPayment) }],
        encryptedPayload: envelopeBytes,
        payloadHash,
      },
      timestamp: 1_700_000_000_000,
      networkTag: new Uint8Array(0),
    }
    const notAnEnvelope: StoredMonadMessageProto = {
      message: {
        stampPayments: [{ childIndex: 0, rawTx: getBytes(rawStampPayment) }],
        encryptedPayload: new TextEncoder().encode(
          JSON.stringify({ hello: 'world' })
        ),
        payloadHash: getBytes('0x' + 'cd'.repeat(32)),
      },
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
    expect(received[0].payloadDigest).toBe(payloadHashHex)
    expect(received[0].stampValueWei).toBe(123n)
    expect(received[0].receivedTime).toBe(1_700_000_000_000)
    expect(stampPaymentJournal.get(payloadHashHex, 0)).toMatchObject({
      payloadHashHex,
      childIndex: 0,
      address: stampDestination.address,
      valueWei: '123',
      status: 'discovered',
    })
    expect(stampPaymentJournal.get(payloadHashHex, 0)).not.toHaveProperty(
      'privateKey'
    )
    await expect(
      chain.directMessages.listRecoveredStampPayments({ wallet })
    ).resolves.toEqual([
      expect.objectContaining({
        payloadDigest: payloadHashHex,
        childIndex: 0,
        address: { raw: stampDestination.address },
        valueWei: 123n,
        status: 'discovered',
      }),
    ])

    const discovered = stampPaymentJournal.get(payloadHashHex, 0)!
    const retainedSweep = await signedChildSweep({
      identity: bob,
      payloadDigest: payloadHashHex,
      childIndex: 0,
      destination: alice.address.raw,
      valueWei: 1n,
    })
    await stampPaymentJournal.put({
      ...discovered,
      status: 'sweep-pending',
      sweepTxHash: retainedSweep.txHash,
      sweepRawTx: retainedSweep.rawTx,
      sweepValueWei: '1',
      sweepDestinationAddress: alice.address.raw,
    })
    mockedFetchMonadMessagesSince.mockResolvedValueOnce([addressedToBob])
    mockedFetchMonadProfile.mockResolvedValueOnce({
      address: alice.address,
      pubKey: new Uint8Array(alice.compressedPubKey),
    })
    await chain.directMessages.fetchSince({ wallet, sinceMs: 0 })
    expect(stampPaymentJournal.get(payloadHashHex, 0)?.status).toBe(
      'sweep-pending'
    )

    const conflictingRaw = await new Wallet(
      ALICE_PRIVATE_KEY_HEX
    ).signTransaction({
      type: 2,
      chainId: 10143,
      nonce: 1,
      to: stampDestination.address,
      value: 124n,
      data: buildMonadStampCalldata(
        computeMonadStampPaymentCommitment(payloadHash, 0)
      ),
      gasLimit: 60_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    })
    mockedFetchMonadMessagesSince.mockResolvedValueOnce([
      {
        ...addressedToBob,
        message: {
          ...addressedToBob.message!,
          stampPayments: [{ childIndex: 0, rawTx: getBytes(conflictingRaw) }],
        },
      },
    ])
    await expect(
      chain.directMessages.fetchSince({ wallet, sinceMs: 0 })
    ).rejects.toThrow(/conflicting stamp-payment recovery authority/i)
    expect(stampPaymentJournal.get(payloadHashHex, 0)?.status).toBe(
      'sweep-pending'
    )

    mockedFetchMonadMessagesSince.mockResolvedValueOnce([addressedToBob])
    mockedFetchMonadProfile.mockRejectedValueOnce(
      new Error('sender profile transport failed')
    )
    await expect(
      chain.directMessages.fetchSince({ wallet, sinceMs: 0 })
    ).rejects.toThrow(/transport failed/i)
  })

  it('skips envelopes addressed to someone else', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)
    const eve = MonadIdentity.fromPrivateKeyHex(EVE_PRIVATE_KEY_HEX)

    const { buildEnvelope } = jest.requireActual(
      '@frank/cashweb/relay/monad-message-envelope'
    )
    const envelopeBytes: Uint8Array = buildEnvelope({
      fromAddress: alice.address.raw,
      fromPrivateKey: alice.toBitcorePrivateKey(),
      toAddress: eve.address.raw,
      toPubKey: eve.compressedPubKey,
      plaintext: serializeMessageItems([{ type: 'text', text: 'not for bob' }]),
      networkTag: TEST_CONFIG.networkTag,
    })

    mockedFetchMonadMessagesSince.mockResolvedValueOnce([
      {
        message: {
          stampPayments: [
            {
              childIndex: 0,
              rawTx: getBytes(
                await new Wallet(ALICE_PRIVATE_KEY_HEX).signTransaction({
                  to: eve.address.raw,
                  value: 1n,
                })
              ),
            },
          ],
          encryptedPayload: envelopeBytes,
          payloadHash: getBytes('0x' + 'ef'.repeat(32)),
        },
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

  it('explicitly sweeps a journaled recipient child and marks it swept', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)
    const eve = MonadIdentity.fromPrivateKeyHex(EVE_PRIVATE_KEY_HEX)
    const wallet = makeWallet(bob)
    const journal = new InMemoryStampPaymentJournal()
    wallet.stampPaymentJournal = journal
    const payloadDigest = 'ab'.repeat(32)
    const child = deriveMonadStampChildPublic({
      payloadHash: getBytes(`0x${payloadDigest}`),
      recipientPublicKey: new Uint8Array(bob.compressedPubKey),
      paymentIndex: 0,
    })
    await journal.put({
      payloadHashHex: payloadDigest,
      childIndex: 0,
      txHash: `0x${'12'.repeat(32)}`,
      rawTx: `0x01`,
      recipientPublicKeyHex: hexlify(bob.compressedPubKey),
      envelopeRecipientAddress: bob.address.raw,
      address: child.address,
      valueWei: '10000',
      status: 'discovered',
    })
    wallet.provider = {
      getBalance: jest.fn().mockResolvedValue(100_000n),
      getFeeData: jest.fn().mockResolvedValue({ maxFeePerGas: 1n }),
    } as unknown as MonadChainWalletHandle['provider']
    const signedSweep = await signedChildSweep({
      identity: bob,
      payloadDigest,
      childIndex: 0,
      destination: eve.address.raw,
      valueWei: 58_000n,
    })
    const sweepTxHash = signedSweep.txHash
    MonadAccountTxSigner.mockImplementationOnce(() => ({
      address: child.address,
      buildAndSignTransfer: jest.fn().mockResolvedValue(signedSweep),
      submit: jest.fn().mockResolvedValue(sweepTxHash),
      getStatus: jest.fn().mockResolvedValue('pending'),
    }))

    await expect(
      chain.directMessages.sweepRecoveredStampPayment({
        wallet,
        payloadDigest,
        childIndex: 0,
        destination: eve.address,
      })
    ).resolves.toEqual({
      swept: false,
      reason: 'pending',
      txHash: sweepTxHash,
      valueWei: 58_000n,
      destinationAddress: eve.address.raw,
    })
    expect(journal.get(payloadDigest, 0)).toMatchObject({
      status: 'sweep-pending',
      sweepTxHash,
      sweepRawTx: signedSweep.rawTx,
    })

    MonadAccountTxSigner.mockImplementationOnce(() => ({
      address: child.address,
      getStatus: jest.fn().mockResolvedValue('confirmed'),
    }))

    await expect(
      chain.directMessages.sweepRecoveredStampPayment({
        wallet,
        payloadDigest,
        childIndex: 0,
        destination: eve.address,
      })
    ).resolves.toEqual({
      swept: true,
      txHash: sweepTxHash,
      valueWei: 58_000n,
    })
    expect(journal.get(payloadDigest, 0)).toMatchObject({
      status: 'swept',
      sweepTxHash,
    })
  })

  it('serializes concurrent sweeps across handles at the journal boundary', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)
    const eve = MonadIdentity.fromPrivateKeyHex(EVE_PRIVATE_KEY_HEX)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const wallet = makeWallet(bob)
    const journal = new InMemoryStampPaymentJournal()
    wallet.stampPaymentJournal = journal
    const payloadDigest = 'cd'.repeat(32)
    const child = deriveMonadStampChildPublic({
      payloadHash: getBytes(`0x${payloadDigest}`),
      recipientPublicKey: new Uint8Array(bob.compressedPubKey),
      paymentIndex: 0,
    })
    await journal.put({
      payloadHashHex: payloadDigest,
      childIndex: 0,
      txHash: `0x${'12'.repeat(32)}`,
      rawTx: '0x01',
      recipientPublicKeyHex: hexlify(bob.compressedPubKey),
      envelopeRecipientAddress: bob.address.raw,
      address: child.address,
      valueWei: '10000',
      status: 'discovered',
    })
    wallet.provider = {
      getBalance: jest.fn().mockResolvedValue(100_000n),
      getFeeData: jest.fn().mockResolvedValue({ maxFeePerGas: 1n }),
    } as unknown as MonadChainWalletHandle['provider']
    const signed = await signedChildSweep({
      identity: bob,
      payloadDigest,
      childIndex: 0,
      destination: eve.address.raw,
      valueWei: 58_000n,
    })
    const buildAndSignTransfer = jest.fn().mockResolvedValue(signed)
    const submit = jest.fn().mockResolvedValue(signed.txHash)
    const submitRaw = jest.fn().mockResolvedValue(signed.txHash)
    MonadAccountTxSigner.mockImplementationOnce(() => ({
      address: child.address,
      buildAndSignTransfer,
      submit,
      getStatus: jest.fn().mockResolvedValue('pending'),
    }))
    MonadAccountTxSigner.mockImplementationOnce(() => ({
      address: child.address,
      getStatus: jest.fn().mockResolvedValue('pending'),
      submitRaw,
    }))

    const otherHandle = { ...wallet } as MonadChainWalletHandle

    const first = chain.directMessages.sweepRecoveredStampPayment({
      wallet,
      payloadDigest,
      childIndex: 0,
      destination: eve.address,
    })
    const second = chain.directMessages.sweepRecoveredStampPayment({
      wallet: otherHandle,
      payloadDigest,
      childIndex: 0,
      destination: alice.address,
    })
    await expect(first).resolves.toMatchObject({
      swept: false,
      txHash: signed.txHash,
      destinationAddress: eve.address.raw,
    })
    await expect(second).resolves.toMatchObject({
      swept: false,
      txHash: signed.txHash,
    })
    expect(buildAndSignTransfer).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submitRaw).toHaveBeenCalledWith(signed.rawTx, signed.txHash)
    expect(journal.get(payloadDigest, 0)).toMatchObject({
      status: 'sweep-pending',
      sweepRawTx: signed.rawTx,
      sweepDestinationAddress: eve.address.raw,
    })
  })

  it('tombstones a mined failed sweep and signs a fresh next-nonce intent without replaying it', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)
    const eve = MonadIdentity.fromPrivateKeyHex(EVE_PRIVATE_KEY_HEX)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const wallet = makeWallet(bob)
    const journal = new InMemoryStampPaymentJournal()
    wallet.stampPaymentJournal = journal
    const payloadDigest = 'de'.repeat(32)
    const child = deriveMonadStampChildPrivate({
      payloadHash: getBytes(`0x${payloadDigest}`),
      recipientPrivateKey: getBytes(bob.toPrivateKeyHex()),
      paymentIndex: 0,
    })
    const childWallet = new Wallet(hexlify(child.privateKey))
    const oldRawTx = await childWallet.signTransaction({
      to: eve.address.raw,
      value: 58_000n,
      nonce: 0,
      gasLimit: 21_000n,
      gasPrice: 1n,
      chainId: 1,
    })
    const oldTxHash = Transaction.from(oldRawTx).hash as string
    await journal.put({
      payloadHashHex: payloadDigest,
      childIndex: 0,
      txHash: `0x${'12'.repeat(32)}`,
      rawTx: '0x01',
      recipientPublicKeyHex: hexlify(bob.compressedPubKey),
      envelopeRecipientAddress: bob.address.raw,
      address: child.address,
      valueWei: '10000',
      status: 'sweep-pending',
      sweepTxHash: oldTxHash,
      sweepRawTx: oldRawTx,
      sweepValueWei: '58000',
      sweepDestinationAddress: eve.address.raw,
    })
    wallet.provider = {
      getBalance: jest.fn().mockResolvedValue(100_000n),
      getFeeData: jest.fn().mockResolvedValue({ maxFeePerGas: 1n }),
    } as unknown as MonadChainWalletHandle['provider']
    const newRawTx = await childWallet.signTransaction({
      to: alice.address.raw,
      value: 58_000n,
      nonce: 1,
      gasLimit: 21_000n,
      gasPrice: 1n,
      chainId: 1,
    })
    const newTxHash = Transaction.from(newRawTx).hash as string
    const submitRaw = jest.fn()
    MonadAccountTxSigner.mockImplementationOnce(() => ({
      address: child.address,
      getStatus: jest
        .fn()
        .mockResolvedValueOnce('failed')
        .mockResolvedValueOnce('pending'),
      submitRaw,
      buildAndSignTransfer: jest.fn().mockResolvedValue({
        to: alice.address.raw,
        value: 58_000n,
        txHash: newTxHash,
        rawTx: newRawTx,
        nonce: 1,
      }),
      submit: jest.fn().mockResolvedValue(newTxHash),
    }))

    await expect(
      chain.directMessages.sweepRecoveredStampPayment({
        wallet,
        payloadDigest,
        childIndex: 0,
        destination: alice.address,
      })
    ).resolves.toMatchObject({
      swept: false,
      reason: 'pending',
      txHash: newTxHash,
    })
    expect(submitRaw).not.toHaveBeenCalled()
    const recovered = journal.get(payloadDigest, 0)!
    expect(recovered).toMatchObject({
      status: 'sweep-pending',
      sweepTxHash: newTxHash,
      sweepRawTx: newRawTx,
      failedSweeps: [
        {
          txHash: oldTxHash,
          rawTx: oldRawTx,
          valueWei: '58000',
          destinationAddress: eve.address.raw,
        },
      ],
    })
    expect(Transaction.from(recovered.failedSweeps![0].rawTx).nonce).toBe(0)
    expect(Transaction.from(recovered.sweepRawTx!).nonce).toBe(1)
  })

  it.each([
    ['already-known', 'confirmed'],
    ['already-known', 'pending'],
    ['already-known', 'failed'],
    ['nonce-too-low', 'confirmed'],
    ['nonce-too-low', 'pending'],
    ['nonce-too-low', 'failed'],
  ] as const)(
    'requeries the exact hash after %s and honors only its %s receipt',
    async (rpcKind, exactStatus) => {
      const chain = createMonadChain(TEST_CONFIG)
      const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX)
      const eve = MonadIdentity.fromPrivateKeyHex(EVE_PRIVATE_KEY_HEX)
      const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
      const wallet = makeWallet(bob)
      const journal = new InMemoryStampPaymentJournal()
      wallet.stampPaymentJournal = journal
      const payloadDigest = 'ef'.repeat(32)
      const child = deriveMonadStampChildPrivate({
        payloadHash: getBytes(`0x${payloadDigest}`),
        recipientPrivateKey: getBytes(bob.toPrivateKeyHex()),
        paymentIndex: 0,
      })
      const childWallet = new Wallet(hexlify(child.privateKey))
      const oldRawTx = await childWallet.signTransaction({
        to: eve.address.raw,
        value: 58_000n,
        nonce: 0,
        gasLimit: 21_000n,
        gasPrice: 1n,
        chainId: 1,
      })
      const oldTxHash = Transaction.from(oldRawTx).hash as string
      await journal.put({
        payloadHashHex: payloadDigest,
        childIndex: 0,
        txHash: `0x${'12'.repeat(32)}`,
        rawTx: '0x01',
        recipientPublicKeyHex: hexlify(bob.compressedPubKey),
        envelopeRecipientAddress: bob.address.raw,
        address: child.address,
        valueWei: '10000',
        status: 'sweep-pending',
        sweepTxHash: oldTxHash,
        sweepRawTx: oldRawTx,
        sweepValueWei: '58000',
        sweepDestinationAddress: eve.address.raw,
      })
      wallet.provider = {
        getBalance: jest.fn().mockResolvedValue(100_000n),
        getFeeData: jest.fn().mockResolvedValue({ maxFeePerGas: 1n }),
      } as unknown as MonadChainWalletHandle['provider']
      const freshRawTx = await childWallet.signTransaction({
        to: alice.address.raw,
        value: 58_000n,
        nonce: 1,
        gasLimit: 21_000n,
        gasPrice: 1n,
        chainId: 1,
      })
      const freshTxHash = Transaction.from(freshRawTx).hash as string
      const getStatus = jest
        .fn()
        .mockResolvedValueOnce('pending')
        .mockResolvedValueOnce(exactStatus)
      if (exactStatus === 'failed') getStatus.mockResolvedValueOnce('pending')
      const buildAndSignTransfer = jest.fn().mockResolvedValue({
        to: alice.address.raw,
        value: 58_000n,
        txHash: freshTxHash,
        rawTx: freshRawTx,
        nonce: 1,
      })
      MonadAccountTxSigner.mockImplementationOnce(() => ({
        address: child.address,
        getStatus,
        submitRaw: jest
          .fn()
          .mockRejectedValue(
            new MonadRpcError(rpcKind, rpcKind, new Error(rpcKind))
          ),
        buildAndSignTransfer,
        submit: jest.fn().mockResolvedValue(freshTxHash),
      }))

      const result = await chain.directMessages.sweepRecoveredStampPayment({
        wallet,
        payloadDigest,
        childIndex: 0,
        destination: alice.address,
      })
      if (exactStatus === 'confirmed') {
        expect(result).toMatchObject({ swept: true, txHash: oldTxHash })
        expect(journal.get(payloadDigest, 0)?.status).toBe('swept')
      } else if (exactStatus === 'pending') {
        expect(result).toMatchObject({
          swept: false,
          reason: 'pending',
          txHash: oldTxHash,
        })
        expect(buildAndSignTransfer).not.toHaveBeenCalled()
        expect(journal.get(payloadDigest, 0)?.sweepTxHash).toBe(oldTxHash)
      } else {
        expect(result).toMatchObject({
          swept: false,
          reason: 'pending',
          txHash: freshTxHash,
        })
        expect(buildAndSignTransfer).toHaveBeenCalledTimes(1)
        expect(journal.get(payloadDigest, 0)?.failedSweeps).toEqual([
          expect.objectContaining({ txHash: oldTxHash, rawTx: oldRawTx }),
        ])
      }
    }
  )
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
    expect(wallet.walletState?.runOperation).toHaveBeenCalledTimes(1)
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
    expect(wallet.walletState?.runOperation).toHaveBeenCalledTimes(1)
  })
})

describe('createMonadChain: economic operation lifecycle', () => {
  it.each(['post', 'vote'] as const)(
    'drains a paused topic %s before close and persists its terminal write',
    async (kind) => {
      const parent = mkdtempSync(join(tmpdir(), 'monad-chain-topic-gate-'))
      const storagePrefix = join(parent, 'wallet')
      const seed = {
        mnemonic: 'test test test test test test test test test test test junk',
      }
      const chain = createMonadChain({
        ...TEST_CONFIG,
        walletStorageLocation: storagePrefix,
      })
      const wallet = (await chain.createWallet(seed)) as MonadChainWalletHandle
      if (wallet.walletState === undefined) {
        throw new Error('persistent wallet state was not created')
      }
      const location = `${storagePrefix}-${wallet.identity.address.raw.toLowerCase()}`
      let entered!: () => void
      let resume!: () => void
      const putStarted = new Promise<void>((resolve) => {
        entered = resolve
      })
      const pausedPut = new Promise<void>((resolve) => {
        resume = resolve
      })
      const completeTerminalWrite = async () => {
        entered()
        await pausedPut
        const record = wallet.pool.getRecord(0)
        if (record === undefined) throw new Error('missing topic funding row')
        wallet.pool.restoreTerminalEvidence({ ...record, status: 'retired' })
        await wallet.pool.flush()
      }
      const submitTopicPost = jest.fn(async () => {
        await completeTerminalWrite()
        return {
          stored: {},
          payloadHashHex: 'feedface',
          txHash: '0xtx',
          leaseIndex: 0,
        }
      })
      const castVote = jest.fn(async () => {
        await completeTerminalWrite()
        return {
          stored: {},
          targetPayloadHashHex: 'aa'.repeat(32),
          txHash: '0xtx',
          leaseIndex: 0,
        }
      })
      ;(MonadTopicPostClient as jest.Mock).mockImplementation(() => ({
        submitTopicPost,
      }))
      ;(MonadTopicVoteClient as jest.Mock).mockImplementation(() => ({
        castVote,
      }))

      const operation =
        kind === 'post'
          ? chain.topics.post({
              wallet,
              topic: 'gated',
              entries: [{ kind: 'post', message: 'paused relay put' }],
              direction: 'up',
              voteWeightWei: 1n,
            })
          : chain.topics.vote({
              wallet,
              payloadDigest: 'bb'.repeat(32),
              direction: 'down',
              voteWeightWei: 1n,
            })
      await putStarted
      let closed = false
      const closing = wallet.walletState.close().then(() => {
        closed = true
      })

      const newOperation =
        kind === 'post'
          ? chain.topics.post({
              wallet,
              topic: 'rejected',
              entries: [{ kind: 'post', message: 'after closing' }],
              direction: 'up',
              voteWeightWei: 1n,
            })
          : chain.topics.vote({
              wallet,
              payloadDigest: 'cc'.repeat(32),
              direction: 'up',
              voteWeightWei: 1n,
            })
      await expect(newOperation).rejects.toThrow(/closing or closed/i)
      await expect(
        openMonadWalletBundle({ location, seed })
      ).rejects.toThrow(/already open/i)
      expect(closed).toBe(false)

      resume()
      await operation
      await closing
      expect(closed).toBe(true)
      expect(kind === 'post' ? submitTopicPost : castVote).toHaveBeenCalledTimes(
        1
      )

      const successor = await openMonadWalletBundle({ location, seed })
      expect(successor.pool.getRecord(0)?.status).toBe('retired')
      await successor.close()
      rmSync(parent, { recursive: true, force: true })
    },
    20_000
  )
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
      viewToForumMessage({ post: undefined, voteWeight: 0 })
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

  it('discoverTopics reads via the chain-level relayBaseUrl (no wallet needed)', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    mockedFetchDiscoveredTopics.mockResolvedValueOnce([
      { topic: 'general', postCount: 3, lastActivityMs: 500 },
    ])

    const result = await chain.topics.discoverTopics()

    expect(mockedFetchDiscoveredTopics).toHaveBeenCalledWith({
      relayBaseUrl: TEST_CONFIG.relayBaseUrl,
    })
    expect(result).toEqual([
      { topic: 'general', postCount: 3, lastActivityMs: 500 },
    ])
  })
})

describe('asMonadWallet guard (exercised indirectly via directMessages/topics)', () => {
  it('throws a clear error when handed a bare WalletHandle missing the wallet-client bundle', async () => {
    const chain = createMonadChain(TEST_CONFIG)
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    const bareWallet: WalletHandle = { identity: alice }

    await expect(
      chain.directMessages.fetchSince({ wallet: bareWallet, sinceMs: 0 })
    ).rejects.toThrow(/MonadChainWalletHandle/)
  })
})
