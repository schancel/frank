import * as canonicalOpen from "@frank/cashweb/relay/canonical-dm";
import * as syncDispatch from "@frank/cashweb/sync-dispatcher";
import * as legacyEnvelope from "@frank/cashweb/relay/monad-message-envelope";
import * as legacyFeed from "@frank/cashweb/relay/monad-message-feed";
import * as legacyProfile from "../monad-identity";
import * as legacyStamp from "../monad-stamp-client";
/**
 * #778: typed wallets created through the normal `createEvmChain().createWallet` composition send
 * and receive direct messages only through the canonical wallet client. Real typed custody, real
 * Level journals, real directory admission and real sealing/opening. The chain RPC and the relay's
 * HTTP surface are offline stand-ins: this proves the composition and wire bytes, not finality.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  JsonRpcProvider,
  Transaction,
  Wallet,
  computeAddress,
  getBytes,
} from 'ethers'
import level from 'level'
import {
  channelStateDigest,
  decodeCanonical,
  encodeCanonical,
  encodeFrame,
  decodeDiceGamePayload,
  encodeDiceGamePayload,
  fromHex,
  parseFrame,
  recipientPayloadDigest,
  toHex,
  verifyPreviewDirectoryEvidence,
  type FrankValue,
} from '@frank/codec'
import { secp256k1 } from '@noble/curves/secp256k1'
import type { ChannelUpdateItem } from '@frank/cashweb/types/messages'
import {
  directMessageText,
  openOwnDirectMessage,
  prepareDirectMessage,
} from '@frank/cashweb/relay/canonical-dm'
import {
  describeCanonicalParts,
  restoreCanonicalRequest,
  type CanonicalFetch,
} from '@frank/cashweb/relay/canonical-dm-transport'
import {
  OpenDirectoryError,
  openDirectory,
} from '@frank/cashweb/relay/open-directory'
import { nodeDirectoryStorage } from '@frank/cashweb/relay/open-directory-node'
import {
  createFakeRelay,
  testAccount,
} from '@frank/cashweb/relay/open-directory-fake-relay.testutil'
import { openNodeDirectoryStore } from '../../directory-admission/src/node'
import type { DirectoryStore } from '../../directory-admission/src'
import domainVectors from '../../domain-roots/vectors/domain-roots-v1.json'
import type { MonadRootBundle } from '../monad-wallet-material'
import type { PublicRevisionZeroInput } from '../monad-wallet-handle'
import {
  MonadCanonicalStampClient,
  MonadStampPendingAttemptError,
} from '../monad-stamp-client'
import {
  CanonicalMessagingHoldError,
  CanonicalMessagingPendingError,
  CanonicalRecipientNotPublishedError,
  CanonicalRelayCannotForwardError,
  createEvmChain,
  installCanonicalDirectory,
  canonicalMonadStampClient,
  createCanonicalMessageRoles,
  prepareCanonicalStampInventory,
  prepareMonadRevisionZeroExport,
  prepareMonadNextRevisionExport,
  type CanonicalDirectory,
} from "./monad-chain";
import type { EvmChainConfig } from "./evm-chain-config";
import { withDefaultMessageItems } from './message-items.testutil'
import type { EvmChainWalletHandle } from "../evm-wallet-handle";
import { InMemoryNativeTransactionAttemptStore } from './chain-wallet'
import {
  CanonicalRecipientUndeliverableError,
  CanonicalSenderUnpublishedError,
  LevelCanonicalLinkStore,
} from './monad-canonical-dm'
import {
  isDirectMessageNotAttempted,
  type DirectMessageClient,
} from './active-chain'
import type { CanonicalJournalAttempt } from '../storage/stamp-attempt-journal'

// Offline chain state: only these single-use sender accounts hold funds.
const mockBalances = new Map<string, bigint>()
jest.mock('../monad-provider', () => {
  const actual = jest.requireActual('../monad-provider')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ethers = require('ethers')
  return {
    ...actual,
    createMonadJsonRpcProvider: () => {
      const provider = new ethers.JsonRpcProvider(
        'http://127.0.0.1:1',
        10143n,
        {
          staticNetwork: true,
          cacheTimeout: -1,
        },
      )
      provider._perform = async (request: {
        method: string
        address?: string
      }) => {
        if (request.method === 'getBalance')
          return mockBalances.get(request.address!.toLowerCase()) ?? 0n
        if (request.method === 'getTransactionCount') return 0
        if (request.method === 'estimateGas') return 50_000n
        if (request.method === 'getGasPrice') return 2n
        if (request.method === 'getPriorityFee') return 1n
        if (request.method === 'getBlock')
          return {
            hash: '0x' + '11'.repeat(32),
            parentHash: '0x' + '22'.repeat(32),
            number: '0x1',
            timestamp: '0x64',
            nonce: '0x0000000000000000',
            difficulty: '0x0',
            gasLimit: '0x1c9c380',
            gasUsed: '0x0',
            miner: '0x' + '00'.repeat(20),
            extraData: '0x',
            baseFeePerGas: '0x1',
            transactions: [],
          }
        throw new Error(`unexpected provider call ${request.method}`)
      }
      return provider
    },
  }
})
// Offline chain: a submitted transfer is mined at once and moves its value.
jest.mock('../monad-http', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ethers = require('ethers')
  const mined = new Set<string>()
  return {
    ...jest.requireActual('../monad-http'),
    MonadHttpClient: class {
      async submitRawTransaction(raw: string) {
        const tx = ethers.Transaction.from(raw)
        const to = tx.to.toLowerCase()
        mockBalances.set(to, (mockBalances.get(to) ?? 0n) + tx.value)
        mockFunded.push({ from: tx.from.toLowerCase(), to, value: tx.value })
        mined.add(tx.hash)
        return tx.hash
      }
      async getTransactionReceipt(hash: string) {
        return mined.has(hash) ? { status: 'success' } : undefined
      }
      destroy() {
        return undefined
      }
    },
  }
})
const mockFunded: { from: string; to: string; value: bigint }[] = []
let mockStreamRecordHandler: ((record: any) => Promise<void>) | undefined
jest.mock('@frank/cashweb/relay/monad-mailbox-client', () => {
  const actual = jest.requireActual('@frank/cashweb/relay/monad-mailbox-client')
  return {
    ...actual,
    fetchCanonicalMailboxPage: jest.fn(actual.fetchCanonicalMailboxPage),
    fetchCanonicalInboxPage: jest.fn(),
    fetchCanonicalRecoveryPage: jest.fn(async () => ({ records: [] })),
    connectCanonicalMailboxStream: jest.fn(async (params: any) => {
      mockStreamRecordHandler = params.onRecord
      return { close: jest.fn() }
    }),
  }
})
import {
  connectCanonicalMailboxStream,
  fetchCanonicalInboxPage,
  fetchCanonicalMailboxPage,
  MonadMailboxChallengeCapacityError,
  MAILBOX_AUTH_DOMAIN,
  buildMailboxAuthPreimage,
  mailboxAuthDigest,
  type MailboxChallenge,
  type CanonicalMailboxRecord,
} from '@frank/cashweb/relay/monad-mailbox-client'
const inboxPage = fetchCanonicalInboxPage as jest.MockedFunction<
  typeof fetchCanonicalInboxPage
>
const mailboxPage = fetchCanonicalMailboxPage as jest.MockedFunction<
  typeof fetchCanonicalMailboxPage
>

const RELAY = 'https://relay-a.example'
const NOW = { seconds: 100n, nanoseconds: 0 }
function roots(index: number): MonadRootBundle {
  const outputs = domainVectors.vectors[index].outputs
  const root = <
    P extends 'evm-wallet' | 'identity-authentication' | 'messaging-encryption',
  >(
    purpose: P,
  ) => ({
    registry: 'frank-domain-roots-v1' as const,
    purpose,
    bytes: getBytes(`0x${outputs[purpose]}`),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  }
}

async function fixture(funded = true) {
  const directory = mkdtempSync(join(tmpdir(), 'chain-canonical-dm-'))
  const config: EvmChainConfig = {
    networkId: 'monad-testnet',
    rpcChain: 'monad-testnet',
    chainId: 10143,
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    relayBaseUrl: RELAY,
    networkTag: 'MONT',
    stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
    defaultStampValueWei: 1_000n,
    defaultTopicVoteValueWei: 1_000n,
    subAccountPoolSize: 0,
    walletStorageLocation: join(directory, 'wallet'),
  }
  const chain = withDefaultMessageItems(createEvmChain(config))
  const alice = (await chain.createWallet(roots(0))) as EvmChainWalletHandle,
    bob = (await chain.createWallet(roots(1))) as EvmChainWalletHandle
  // Stand-in for confirmed funding: single-use accounts the offline RPC reports as funded.
  // Each covers its own fee reserve plus 600 wei, so a 1000 wei stamp needs both.
  if (funded) {
    for (const record of alice.pool.ensureSize(2))
      mockBalances.set(record.address.toLowerCase(), 187_500n + 600n)
    await alice.pool.flush()
  }
  const tuple = {
    relayId: new Uint8Array(16).fill(1),
    endpoint: RELAY + '/',
    identity: { keyType: 1, keyBytes: getBytes('0x02' + '11'.repeat(32)) },
    expiry: { seconds: 3700n, nanoseconds: 0 },
    unknownFields: new Map(),
  }
  tuple.identity.keyBytes = new Uint8Array(alice.identity.compressedPubKey)
  const input: PublicRevisionZeroInput = {
    networkTag: 'MONT',
    network: 'monad-testnet',
    chainId: 10143n,
    issuedAt: NOW,
    expiresAt: { seconds: 3700n, nanoseconds: 0 },
    now: NOW,
    relay: tuple,
  }
  const stores: DirectoryStore[] = []
  // Each wallet admits both subjects through its own independent public store.
  const admit = async (owner: string, wallet: EvmChainWalletHandle) => {
    const exported = prepareMonadRevisionZeroExport(wallet, input)
    const store = await openNodeDirectoryStore({
      location: join(directory, `directory-${owner}-${toHex(exported.t1)}`),
      anchor: {
        network: 'monad-testnet',
        subject: { keyType: 1, keyBytes: exported.auth.compressedPoint },
        revisionZero: exported.t1,
      },
      mode: { kind: 'new' },
    })
    stores.push(store)
    await store.enroll(
      [{ statement: exported.statement, attestation: exported.attestation }],
      { now: NOW, relay: tuple },
    )
    return {
      subject: toHex(exported.auth.compressedPoint),
      current: () => store.current({ now: NOW, relay: tuple }),
    }
  }
  const requests: { body: Uint8Array; contentType: string }[] = []
  const broadcastPayments = new Map<string, bigint>()
  const broadcast = (requestIndex: number, members?: readonly number[]) => {
    const request = restoreCanonicalRequest(requests[requestIndex])
    for (const [index, raw] of request.parts.transactions.entries()) {
      if (members && !members.includes(index)) continue
      const tx = Transaction.from('0x' + toHex(raw))
      if (broadcastPayments.has(tx.hash!)) continue
      broadcastPayments.set(tx.hash!, tx.value)
      const to = tx.to!.toLowerCase()
      mockBalances.set(to, (mockBalances.get(to) ?? 0n) + tx.value)
    }
  }
  let phase:
    | 'delivered'
    | 'retained'
    | 'fail'
    | 'lost'
    | 'bad_request'
    | 'undeliverable'
    | 'sender_unpublished' = 'delivered'
  const fetch: CanonicalFetch = async (url, init) => {
    if (
      (url !== RELAY + '/message' && url !== RELAY + '/message/monad/cbor') ||
      (init.method !== 'POST' && init.method !== 'PUT')
    )
      throw new Error(`unexpected relay request ${init.method} ${url}`)
    if (phase === 'fail') throw new Error('relay unreachable')
    const body = new Uint8Array(init.body!)
    requests.push({ body, contentType: init.headers['Content-Type'] })
    if (phase === 'lost') throw new Error('relay response lost after acceptance')
    const identity = restoreCanonicalRequest({
      body,
      contentType: init.headers['Content-Type'],
    }).identity
    const answer = new TextEncoder().encode(
      JSON.stringify(
        phase === 'delivered'
          ? {
              version: 1,
              phase,
              identity,
              mailbox_committed_at_ms: 1234,
            }
          : phase === 'undeliverable'
          ? {
              version: 1,
              phase: 'dead',
              identity,
              reason: 'undeliverable',
            }
          : phase === 'sender_unpublished'
          ? {
              version: 1,
              phase: 'dead',
              identity,
              reason: 'sender_unpublished',
            }
          : { version: 1, phase, identity },
      ),
    )
    let read = false
    return {
      status: phase === 'bad_request' ? 400 : phase === 'retained' ? 202 : 200,
      url,
      headers: {
        get: name =>
          name.toLowerCase() === 'content-type' ? 'application/json' : null,
      },
      body: {
        getReader: () => ({
          read: async () =>
            read
              ? { done: true }
              : ((read = true), { done: false, value: answer }),
          cancel: async () => undefined,
          releaseLock: () => undefined,
        }),
      },
    }
  }
  const directoryFor = async (
    owner: string,
    self: EvmChainWalletHandle,
    peer: EvmChainWalletHandle,
  ): Promise<CanonicalDirectory> => {
    const own = await admit(owner, self),
      other = await admit(owner, peer)
    return {
      network: 'monad-testnet',
      homeEndpoint: RELAY + '/',
      selfCurrent: own.current,
      peerCurrent: async wanted => {
        const subject =
          'subject' in wanted
            ? wanted.subject
            : computeAddress('0x' + other.subject).toLowerCase() ===
              wanted.address.toLowerCase()
            ? other.subject
            : undefined
        return subject === other.subject
          ? { subject, endpoint: RELAY + '/', current: await other.current() }
          : undefined
      },
      fetch,
    }
  }
  const ret = {
    chain,
    alice,
    bob,
    root: directory,
    fetch,
    requests,
    broadcast,
    broadcastPayments,
    setPhase: (next: typeof phase) => (phase = next),
    directoryFor,
    close: async () => {
      await ret.alice.close().catch(() => undefined)
      await ret.bob.close().catch(() => undefined)
      for (const store of stores) await store.close().catch(() => undefined)
      rmSync(directory, { recursive: true, force: true })
    },
  }
  return ret
}

const text = (value: string) => [{ type: 'text' as const, text: value }]

describe('typed wallet direct messages use the canonical path (#778)', () => {
  jest.setTimeout(30_000)
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => {
    jest.clearAllMocks()
    mockBalances.clear()
    mockFunded.length = 0
    f = await fixture(!expect.getState().currentTestName!.includes('unfunded'))
  })
  afterEach(() => f.close())

  it('stays pending and makes no request until a verified directory is installed', async () => {
    const recipient = f.bob.identity.address
    await expect(
      f.chain.directMessages.send({
        wallet: f.alice,
        recipient,
        items: text('hello'),
      }),
    ).rejects.toBeInstanceOf(CanonicalMessagingPendingError)
    await expect(
      f.chain.directMessages.fetchSince({ wallet: f.alice, sinceMs: 0 }),
    ).rejects.toBeInstanceOf(CanonicalMessagingPendingError)
    expect(f.requests).toHaveLength(0)
    expect(inboxPage).not.toHaveBeenCalled()
    expect(f.alice.pool.records().map(r => r.status)).toEqual([
      'available',
      'available',
    ])
  })

  it('sends exact canonical bytes once and the recipient opens the same text', async () => {
    installCanonicalDirectory(
      f.alice,
      await f.directoryFor('alice', f.alice, f.bob),
    )
    installCanonicalDirectory(
      f.bob,
      await f.directoryFor('bob', f.bob, f.alice),
    )
    const created: string[] = []
    const sent = await f.chain.directMessages.send({
      wallet: f.alice,
      recipient: f.bob.identity.address,
      items: text('hello bob'),
      onAttemptCreated: digest => void created.push(digest),
    })
    expect(f.requests).toHaveLength(1)
    const request = restoreCanonicalRequest(f.requests[0])
    expect(request.identity.payload_hash).toBe(sent.payloadDigest)
    expect(created).toEqual([sent.payloadDigest])
    const delivery = parseFrame(request.parts.delivery)
    if (delivery.kind !== 'parsed' || delivery.typed?.type !== 1)
      throw new Error('type1 delivery expected')
    const payload = delivery.typed.payloadFrame
    expect(payload.typed?.type).toBe(5)
    expect(payload.schemaVersion).toBe(2)
    expect(toHex(recipientPayloadDigest('monad-testnet', payload.frame))).toBe(
      sent.payloadDigest,
    )
    // No plaintext and no legacy envelope in what the relay receives.
    expect(Buffer.from(f.requests[0].body).includes('hello bob')).toBe(false)
    expect(sent.stampValueWei).toBe(1_000n)
    expect(sent.stampPayments.reduce((n, p) => n + p.valueWei, 0n)).toBe(1_000n)
    expect(
      await f.chain.directMessages.reconcileAttempts({
        wallet: f.alice,
        payloadDigests: [sent.payloadDigest, 'ff'.repeat(32)],
      }),
    ).toEqual({
      [sent.payloadDigest]: 'delivered',
      ['ff'.repeat(32)]: 'unknown',
    })
    // Reconciling a delivered attempt re-sends nothing.
    expect(f.requests).toHaveLength(1)

    inboxPage.mockResolvedValue({
      records: [
        {
          delivery: request.parts.delivery,
          context: request.parts.context,
          submissionIdentity: request.identity.submission_identity,
          timestampMs: 1234,
        },
      ],
    })
    const received = await f.chain.directMessages.fetchSince({
      wallet: f.bob,
      sinceMs: 0,
    })
    expect(received).toHaveLength(1)
    expect(received[0].items).toEqual(text('hello bob'))
    expect(received[0].payloadDigest).toBe(sent.payloadDigest)
    expect(received[0].senderAddress.raw).toBe(f.alice.identity.address.raw)
    // The sender's key comes from the admitted directory, never from a display profile.
    expect(toHex(received[0].senderPublicKey!)).toBe(
      toHex(f.alice.identity.compressedPubKey),
    )
    expect(received[0].recipientAddress.raw).toBe(f.bob.identity.address.raw)
    expect(received[0].stampValueWei).toBe(1_000n)
    expect(received[0].stampPayments).toHaveLength(1)
    expect(received[0].stampPayments[0].valueWei).toBe(1_000n)
    expect(received[0].receivedTime).toBe(1234)
    const auth = inboxPage.mock.calls[0][0]
    expect(auth.relayBaseUrl).toBe(RELAY + '/')
    expect(auth.subject).toBe(toHex(f.bob.identity.compressedPubKey))
  })

  it('sends and receives a stealth item over canonical direct messages', async () => {
    installCanonicalDirectory(
      f.alice,
      await f.directoryFor('alice', f.alice, f.bob),
    )
    installCanonicalDirectory(
      f.bob,
      await f.directoryFor('bob', f.bob, f.alice),
    )
    const stealthItem = {
      type: 'stealth' as const,
      networkTag: 'MONT',
      keyType: 1 as const,
      ephemeralPubKey: '02' + '22'.repeat(32),
      transactions: ['1234abcd', '5678ef'],
      amount: 50_000,
      memo: 'stealth transfer',
    }
    const sent = await f.chain.directMessages.send({
      wallet: f.alice,
      recipient: f.bob.identity.address,
      items: [stealthItem],
    })
    expect(f.requests).toHaveLength(1)
    const request = restoreCanonicalRequest(f.requests[0])
    expect(request.identity.payload_hash).toBe(sent.payloadDigest)

    inboxPage.mockResolvedValue({
      records: [
        {
          delivery: request.parts.delivery,
          context: request.parts.context,
          submissionIdentity: request.identity.submission_identity,
          timestampMs: 1234,
        },
      ],
    })
    const received = await f.chain.directMessages.fetchSince({
      wallet: f.bob,
      sinceMs: 0,
    })
    expect(received).toHaveLength(1)
    expect(received[0].items).toEqual([
      {
        type: 'stealth',
        networkTag: 'MONT',
        keyType: 1,
        ephemeralPubKey: '02' + '22'.repeat(32),
        transactions: ['1234abcd', '5678ef'],
        amount: 50_000,
        memo: 'stealth transfer',
      },
    ])
    expect(f.bob.stealthKeyring.getAccounts()).toHaveLength(1)
    const bobStealthAcc = f.bob.stealthKeyring.getAccounts()[0]
    expect(bobStealthAcc.networkTag).toBe('MONT')
    expect(bobStealthAcc.initialAmountWei).toBe(50_000n)
    expect(bobStealthAcc.ephemeralPubKey).toBe('02' + '22'.repeat(32))
    expect(bobStealthAcc.privateKey).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('sends and receives a channel-update item over canonical direct messages', async () => {
    installCanonicalDirectory(
      f.alice,
      await f.directoryFor('alice', f.alice, f.bob),
    )
    installCanonicalDirectory(
      f.bob,
      await f.directoryFor('bob', f.bob, f.alice),
    )
    const channelId = '11'.repeat(32)
    const alicePriv = fromHex('01'.repeat(32))
    const alicePubHex = toHex(secp256k1.getPublicKey(alicePriv, true))
    const bobPubHex = toHex(
      secp256k1.getPublicKey(fromHex('02'.repeat(32)), true),
    )

    const allocations = [
      {
        networkTag: 'mont',
        token: '',
        balances: [
          {
            participant: { keyType: 1, pubKey: alicePubHex },
            balance: '1000000',
          },
          {
            participant: { keyType: 1, pubKey: bobPubHex },
            balance: '2000000',
          },
        ],
      },
    ]

    const dicePayload = encodeDiceGamePayload({
      round: 1n,
      action: 'roll',
      seedCommitment: fromHex('aa'.repeat(32)),
      targetRoll: 50,
      wager: 10000n,
    })

    const digest = channelStateDigest({
      channelId,
      appId: 'dice',
      sequenceNumber: 1,
      allocations,
      appState: dicePayload,
      settlementRef: 'ff'.repeat(32),
    })

    const aliceSig = new Uint8Array(
      secp256k1.sign(digest, alicePriv).toDERRawBytes(),
    )

    const channelItem: ChannelUpdateItem = {
      type: 'channel-update',
      channelId,
      appId: 'dice',
      sequenceNumber: 1,
      allocations,
      appState: dicePayload,
      signatures: [
        {
          algorithm: 1,
          signer: { keyType: 1, pubKey: alicePubHex },
          signature: toHex(aliceSig),
        },
      ],
      settlementRef: 'ff'.repeat(32),
    }

    const sent = await f.chain.directMessages.send({
      wallet: f.alice,
      recipient: f.bob.identity.address,
      items: [channelItem],
    })
    expect(f.requests).toHaveLength(1)
    const request = restoreCanonicalRequest(f.requests[0])
    expect(request.identity.payload_hash).toBe(sent.payloadDigest)

    inboxPage.mockResolvedValue({
      records: [
        {
          delivery: request.parts.delivery,
          context: request.parts.context,
          submissionIdentity: request.identity.submission_identity,
          timestampMs: 1234,
        },
      ],
    })
    const received = await f.chain.directMessages.fetchSince({
      wallet: f.bob,
      sinceMs: 0,
    })
    expect(received).toHaveLength(1)
    expect(received[0].items).toHaveLength(1)
    const item = received[0].items[0]
    expect(item.type).toBe('channel-update')
    if (item.type === 'channel-update') {
      expect(item.channelId).toBe(channelId)
      expect(item.appId).toBe('dice')
      expect(item.sequenceNumber).toBe(1)
      expect(item.allocations).toEqual(allocations)
      expect(toHex(item.appState as Uint8Array)).toBe(toHex(dicePayload))
      expect(item.signatures).toEqual(channelItem.signatures)
      expect(item.settlementRef).toBe('ff'.repeat(32))

      const decodedDice = decodeDiceGamePayload(item.appState as Uint8Array)
      expect(decodedDice.round).toBe(1n)
      expect(decodedDice.action).toBe('roll')
      expect(decodedDice.targetRoll).toBe(50)
      expect(decodedDice.wager).toBe(10000n)
    }
  })

  it('rethrows 429 challenge capacity error without falling back to inbox page', async () => {
    installCanonicalDirectory(
      f.alice,
      await f.directoryFor('alice', f.alice, f.bob),
    )
    mailboxPage.mockRejectedValueOnce(
      new MonadMailboxChallengeCapacityError('rate limited', 60_000),
    )
    inboxPage.mockClear()
    await expect(
      f.chain.directMessages.fetchSince({ wallet: f.alice, sinceMs: 0 }),
    ).rejects.toBeInstanceOf(MonadMailboxChallengeCapacityError)
    expect(inboxPage).not.toHaveBeenCalled()

    mailboxPage.mockRejectedValueOnce({
      status: 429,
      code: 'mailbox_challenge_capacity',
      message: 'rate limited',
    })
    inboxPage.mockClear()
    await expect(
      f.chain.directMessages.fetchSince({ wallet: f.alice, sinceMs: 0 }),
    ).rejects.toMatchObject({ status: 429, code: 'mailbox_challenge_capacity' })
    expect(inboxPage).not.toHaveBeenCalled()
  })

  it('does not display a tampered ciphertext or a sender with no published entry', async () => {
    installCanonicalDirectory(
      f.alice,
      await f.directoryFor('alice', f.alice, f.bob),
    )
    const bobDirectory = await f.directoryFor('bob', f.bob, f.alice)
    installCanonicalDirectory(f.bob, bobDirectory)
    await f.chain.directMessages.send({
      wallet: f.alice,
      recipient: f.bob.identity.address,
      items: text('exact'),
    })
    const request = restoreCanonicalRequest(f.requests[0])
    const context = new Uint8Array(request.parts.context)
    context[context.length - 1] ^= 1
    const record = {
      delivery: request.parts.delivery,
      context,
      submissionIdentity: request.identity.submission_identity,
      timestampMs: 5,
    }
    inboxPage.mockResolvedValue({ records: [record] })
    expect(
      await f.chain.directMessages.fetchSince({ wallet: f.bob, sinceMs: 0 }),
    ).toEqual([])
    // Same exact bytes, but the sender has no published entry.
    installCanonicalDirectory(f.bob, {
      ...bobDirectory,
      peerCurrent: async () => undefined,
    })
    const quarantined: number[] = []
    inboxPage.mockResolvedValue({
      records: [{ ...record, context: request.parts.context }],
    })
    expect(
      await f.chain.directMessages.fetchSince({
        wallet: f.bob,
        sinceMs: 0,
        onQuarantinedTimestamp: time => void quarantined.push(time),
      }),
    ).toEqual([])
    expect(quarantined).toEqual([5])
  })

  it('refuses unsupported items and unpublished recipients before any payment intent', async () => {
    installCanonicalDirectory(
      f.alice,
      await f.directoryFor('alice', f.alice, f.bob),
    )
    await expect(
      f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: [{ type: 'hologram' } as never],
      }),
    ).rejects.toThrow("cannot carry 'hologram' items")
    await expect(
      f.chain.directMessages.send({
        wallet: f.alice,
        recipient: { raw: '0x000000000000000000000000000000000000dEaD' },
        items: text('hello'),
      }),
    ).rejects.toBeInstanceOf(CanonicalRecipientNotPublishedError)
    expect(f.requests).toHaveLength(0)
    expect(
      await f.chain.directMessages.unattributedAttempts({
        wallet: f.alice,
        knownDigests: [],
      }),
    ).toEqual([])
  })

  it.each(["wallet-sync", "payment-transfer"])(
    "still refuses outgoing %s before preparation or submission",
    async (type) => {
      installCanonicalDirectory(
        f.alice,
        await f.directoryFor("alice", f.alice, f.bob)
      );
      const prepare = jest.spyOn(
        MonadCanonicalStampClient.prototype,
        "prepareIntent"
      );
      const finish = jest.spyOn(
        MonadCanonicalStampClient.prototype,
        "finishIntent"
      );
      try {
        await expect(
          f.chain.directMessages.send({
            wallet: f.alice,
            recipient: f.bob.identity.address,
            items: [{ type } as never],
          })
        ).rejects.toThrow(`cannot carry '${type}' items`);
        expect(prepare).not.toHaveBeenCalled();
        expect(finish).not.toHaveBeenCalled();
        expect(f.requests).toHaveLength(0);
      } finally {
        prepare.mockRestore();
        finish.mockRestore();
      }
    }
  );

  it('keeps one payment set across an unknown outcome and re-sends the same bytes', async () => {
    installCanonicalDirectory(
      f.alice,
      await f.directoryFor('alice', f.alice, f.bob),
    )
    f.setPhase('fail')
    let digest = ''
    await expect(
      f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: text('once'),
        onAttemptCreated: created => void (digest = created),
      }),
    ).rejects.toBeInstanceOf(MonadStampPendingAttemptError)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    // A second Send while the first is unresolved must not build another payment.
    f.setPhase('retained')
    await expect(
      f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: text('twice'),
      }),
    ).rejects.toBeInstanceOf(MonadStampPendingAttemptError)
    expect(f.requests).toHaveLength(1)
    expect(
      await f.chain.directMessages.unattributedAttempts({
        wallet: f.alice,
        knownDigests: [],
      }),
    ).toEqual([digest])
    f.setPhase('delivered')
    expect(
      await f.chain.directMessages.reconcileAttempts({
        wallet: f.alice,
        payloadDigests: [digest],
      }),
    ).toEqual({ [digest]: 'delivered' })
    const bodies = f.requests.map(r => toHex(r.body))
    expect(new Set(bodies).size).toBe(1)
    expect(restoreCanonicalRequest(f.requests[0]).identity.payload_hash).toBe(
      digest,
    )
  })

  it('holds with a typed error when a frozen intent cannot be finished, then finishes the same intent', async () => {
    installCanonicalDirectory(
      f.alice,
      await f.directoryFor('alice', f.alice, f.bob),
    )
    const failure = Object.assign(new Error('signer unavailable'), {
      kind: 'insufficient-funds',
    })
    const finish = jest
      .spyOn(MonadCanonicalStampClient.prototype, 'finishIntent')
      .mockRejectedValue(failure)
    let digest = ''
    try {
      await expect(
        f.chain.directMessages.send({
          wallet: f.alice,
          recipient: f.bob.identity.address,
          items: text('frozen'),
          onAttemptCreated: created => void (digest = created),
        }),
      ).rejects.toBeInstanceOf(MonadStampPendingAttemptError)
      const held = await f.chain.directMessages
        .reconcileAttempts({ wallet: f.alice, payloadDigests: [digest] })
        .catch((error: unknown) => error)
      expect(held).toBeInstanceOf(CanonicalMessagingHoldError)
      expect((held as { cause?: Error }).cause?.message).toBe(
        'signer unavailable',
      )
      // The next Send is held by the same earlier payment and is told the original failure
      // itself, so the app can still say "not enough funds" or "unreachable".
      const next = await f.chain.directMessages
        .send({
          wallet: f.alice,
          recipient: f.bob.identity.address,
          items: text('behind the hold'),
        })
        .catch((error: unknown) => error)
      expect(next).toBeInstanceOf(CanonicalMessagingHoldError)
      expect((next as Error).name).toBe('CanonicalMessagingHoldError')
      expect((next as { cause?: unknown }).cause).toBe(failure)
      expect((held as { cause?: unknown }).cause).toBe(failure)
      expect(f.requests).toHaveLength(0)
    } finally {
      finish.mockRestore()
    }
    expect(
      await f.chain.directMessages.reconcileAttempts({
        wallet: f.alice,
        payloadDigests: [digest],
      }),
    ).toEqual({ [digest]: 'delivered' })
    expect(restoreCanonicalRequest(f.requests[0]).identity.payload_hash).toBe(
      digest,
    )
  })

  // The app stopped after the wallet saved its link row but before the chat message recorded the
  // attempt: the message has no digest, and only the wallet can still account for the payment.
  async function interruptedSend(label: string) {
    const directory = await f.directoryFor('alice', f.alice, f.bob)
    installCanonicalDirectory(f.alice, directory)
    let digest = ''
    await expect(
      f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: text(label),
        onAttemptCreated: created => {
          digest = created
          throw new Error('app stopped')
        },
      }),
    ).rejects.toThrow()
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    await f.alice.close()
    return { directory, digest }
  }
  async function reopen(directory: CanonicalDirectory) {
    const wallet = (await f.chain.createWallet(
      roots(0),
    )) as EvmChainWalletHandle
    installCanonicalDirectory(wallet, directory)
    return wallet
  }
  const orphans = (
    wallet: EvmChainWalletHandle,
    knownDigests: string[] = [],
  ) => f.chain.directMessages.unattributedAttempts({ wallet, knownDigests })

  it('holds an uncorrelated link without declaring it dead or signing a new payment', async () => {
    const aliceAddr = (await f.alice.getReceiveAddress()).raw.toLowerCase()
    const storageLocation = `${join(f.root, 'wallet')}-evm-${aliceAddr}`
    const directory = await f.directoryFor('alice', f.alice, f.bob)
    await f.alice.close()
    const store = await LevelCanonicalLinkStore.open(storageLocation)
    const digest = 'ab'.repeat(32)
    const row = {
      attemptRef: 'orphaned-ref-999',
      consumerId: 'frank-dm:orphaned',
      digest,
      prepared: { payload: '00', context: '00', economicBinding: '00' },
    }
    await store.put(row)
    await store.close()
    f.alice = await reopen(directory)
    const prepare = jest.spyOn(
      MonadCanonicalStampClient.prototype,
      'prepareIntent',
    )
    try {
      await expect(
        f.chain.directMessages.reconcileAttempts({
          wallet: f.alice,
          payloadDigests: [digest],
        }),
      ).rejects.toBeInstanceOf(CanonicalMessagingHoldError)
      await f.chain.directMessages.discardAttempt({
        wallet: f.alice,
        payloadDigest: digest,
      })
      await expect(
        f.chain.directMessages.send({
          wallet: f.alice,
          recipient: f.bob.identity.address,
          items: text('behind missing evidence'),
        }),
      ).rejects.toBeInstanceOf(CanonicalMessagingHoldError)
      expect(prepare).not.toHaveBeenCalled()
      expect(f.requests).toHaveLength(0)
      await f.alice.close()
      const retained = await LevelCanonicalLinkStore.open(storageLocation)
      try {
        expect(retained.all()).toEqual([row])
      } finally {
        await retained.close()
      }
    } finally {
      prepare.mockRestore()
    }
  })

  // The public client lookup proves that the retained bytes, intended economics, and reservation
  // ownership survive. No test reaches into the live wallet's private persistence owner.
  async function exposedAttempt() {
    for (const record of f.alice.pool.records())
      mockBalances.set(record.address.toLowerCase(), 187_500n + 200_000n)
    const directory = await f.directoryFor('alice', f.alice, f.bob)
    installCanonicalDirectory(f.alice, directory)
    f.setPhase('lost')
    const finish = jest.spyOn(MonadCanonicalStampClient.prototype, 'finishIntent')
    let digest = ''
    try {
      await expect(
        f.chain.directMessages.send({
          wallet: f.alice,
          recipient: f.bob.identity.address,
          stampValue: 400_000n,
          items: text('original authorized operation'),
          onAttemptCreated: value => void (digest = value),
        }),
      ).rejects.toBeInstanceOf(MonadStampPendingAttemptError)
      expect(finish).toHaveBeenCalledTimes(1)
      const attempt: CanonicalJournalAttempt = await finish.mock.results[0].value
      expect(attempt.request.parts.transactions).toHaveLength(2)
      return { directory, digest, attempt }
    } finally {
      finish.mockRestore()
    }
  }

  async function compactedHistoricalAttempt() {
    const original = await exposedAttempt()
    const client = canonicalMonadStampClient(f.alice)
    // Produce the actual old baseline through its public terminal/cleanup/ack owners.
    await client.markAttemptTerminal(
      original.attempt.attemptRef,
      'attempts_exhausted',
    )
    await client.cleanupTerminal(
      original.attempt.attemptRef,
      original.attempt.consumerId,
    )
    await client.acknowledgeWorkflow(
      original.attempt.attemptRef,
      original.attempt.consumerId,
    )
    expect(client.lookup(original.attempt.prepared)).toBeUndefined()
    const address = (await f.alice.getReceiveAddress()).raw.toLowerCase()
    const storageLocation = `${join(f.root, 'wallet')}-evm-${address}`
    await f.alice.close()
    const store = await LevelCanonicalLinkStore.open(storageLocation)
    const row = {
      ...store.all()[0],
      outcome: 'dead' as const,
      reason: 'attempts_exhausted',
      acknowledged: true,
      accounted: true,
    }
    await store.put(row)
    await store.close()
    const record: CanonicalMailboxRecord = {
      direction: 'out',
      delivery: original.attempt.request.parts.delivery,
      context: original.attempt.request.parts.context,
      submissionIdentity: original.attempt.request.identity.submission_identity,
      timestampMs: 100_000,
    }
    return { ...original, row, record, storageLocation }
  }

  function noHistoricalExecution(wallet: EvmChainWalletHandle) {
    const calls = [
      jest.spyOn(MonadCanonicalStampClient.prototype, 'prepareIntent'),
      jest.spyOn(MonadCanonicalStampClient.prototype, 'finishIntent'),
      jest.spyOn(MonadCanonicalStampClient.prototype, 'submit'),
      jest.spyOn(MonadCanonicalStampClient.prototype, 'cleanupTerminal'),
      jest.spyOn(MonadCanonicalStampClient.prototype, 'acknowledgeWorkflow'),
      jest.spyOn(MonadCanonicalStampClient.prototype, 'markAttemptTerminal'),
      jest.spyOn(wallet.pool, 'getSigner'),
      jest.spyOn(wallet.pool, 'ensureSize'),
    ]
    const pool = structuredClone(wallet.pool.records())
    const funded = structuredClone(mockFunded)
    const balances = new Map(mockBalances)
    return {
      verify() {
        for (const spy of calls) expect(spy).not.toHaveBeenCalled()
        expect(wallet.pool.records()).toEqual(pool)
        expect(mockBalances).toEqual(balances)
        expect(mockFunded).toEqual(funded)
        expect(f.broadcastPayments.size).toBe(0)
        expect(f.requests).toHaveLength(1)
      },
      restore() {
        for (const spy of calls) spy.mockRestore()
      },
    }
  }

  async function storedHistoricalRow(location: string) {
    const store = await LevelCanonicalLinkStore.open(location)
    try {
      return store.all()[0]
    } finally {
      await store.close()
    }
  }

  describe('historical delivery recovery', () => {
    afterEach(() => {
      const actual = jest.requireActual<
        typeof import('@frank/cashweb/relay/monad-mailbox-client')
      >('@frank/cashweb/relay/monad-mailbox-client')
      mailboxPage
        .mockReset()
        .mockImplementation(actual.fetchCanonicalMailboxPage)
    })

    it('corrects a reopened compacted historical rejection through the authenticated sender mailbox without financial effects', async () => {
      const historical = await compactedHistoricalAttempt()
      // Exercise the production challenge, auth signing, bounded multipart reader and crypto opening.
      const actualMailbox = jest.requireActual<
        typeof import('@frank/cashweb/relay/monad-mailbox-client')
      >('@frank/cashweb/relay/monad-mailbox-client')
      mailboxPage.mockImplementation(actualMailbox.fetchCanonicalMailboxPage)
      let challenge: MailboxChallenge | undefined
      const reads: string[] = []
      const mailboxFetch: CanonicalFetch = async (url, input) => {
        expect(input.method).toBe(url.includes('/auth/') ? 'POST' : 'GET')
        reads.push(url)
        let bytes: Uint8Array
        let media: string
        if (url.includes('/auth/')) {
          const query = new URL(url).searchParams
          challenge = {
            epoch: '11'.repeat(32),
            nonce: '22'.repeat(32),
            token: '33'.repeat(32),
            expires_at_ms: Date.now() + 59_000,
            signing_domain: MAILBOX_AUTH_DOMAIN,
            resource: 'mailbox',
            since: Number(query.get('since')),
            cursor: query.get('cursor'),
            limit: Number(query.get('limit')),
            max_bytes: Number(query.get('max_bytes')),
            network_tag: '4d4f4e54',
            recovery_payload_hash: null,
            recovery_obligation_id: null,
          }
          bytes = Buffer.from(JSON.stringify(challenge))
          media = 'application/json'
        } else {
          if (!challenge) throw new Error('expected authenticated challenge')
          const subject = historical.attempt.prepared.senderSubject
          const address = computeAddress('0x' + subject).toLowerCase()
          expect(new URL(url).pathname).toBe(`/message/mailbox/${address}`)
          expect(input.headers['x-frank-mailbox-subject']).toBe(subject)
          expect(
            secp256k1.verify(
              fromHex(input.headers['x-frank-mailbox-signature']),
              mailboxAuthDigest(buildMailboxAuthPreimage(challenge, address)),
              fromHex(subject),
            ),
          ).toBe(true)
          const header = (value: string) => Buffer.from(value)
          bytes = Buffer.concat([
            header(
              `--page\r\nContent-Disposition: inline; name="record"\r\nContent-Type: multipart/mixed; boundary=record\r\nX-Frank-Submission-Identity: ${historical.record.submissionIdentity}\r\nX-Frank-Mailbox-Timestamp-Ms: 100000\r\nX-Frank-Mailbox-Direction: out\r\n\r\n`,
            ),
            header(
              '--record\r\nContent-Disposition: inline; name="delivery"\r\nContent-Type: application/vnd.frank.cbor\r\n\r\n',
            ),
            historical.record.delivery,
            header(
              '\r\n--record\r\nContent-Disposition: inline; name="context"\r\nContent-Type: application/cbor\r\n\r\n',
            ),
            historical.record.context,
            header('\r\n--record--\r\n\r\n--page--\r\n'),
          ])
          media = 'multipart/mixed; boundary=page'
        }
        let read = false
        return {
          url,
          status: 200,
          headers: {
            get: name => (name.toLowerCase() === 'content-type' ? media : null),
          },
          body: {
            getReader: () => ({
              read: async () =>
                read
                  ? { done: true }
                  : ((read = true), { done: false, value: bytes }),
              cancel: async () => undefined,
              releaseLock: () => undefined,
            }),
          },
        }
      }
      const wallet = await reopen({
        ...historical.directory,
        fetch: mailboxFetch,
      })
      const effects = noHistoricalExecution(wallet)
      try {
        expect(
          await f.chain.directMessages.reconcileAttempts({
            wallet,
            payloadDigests: [],
          }),
        ).toEqual({})
        expect(reads).toHaveLength(0)
        const params = { wallet, payloadDigests: [historical.digest] }
        expect(await f.chain.directMessages.reconcileAttempts(params)).toEqual({
          [historical.digest]: 'delivered',
        })
        expect(await f.chain.directMessages.reconcileAttempts(params)).toEqual({
          [historical.digest]: 'delivered',
        })
        expect(reads).toHaveLength(2)
        expect(new URL(reads[0]).searchParams.get('since')).toBe('0')
        expect(
          canonicalMonadStampClient(wallet).lookup(historical.attempt.prepared),
        ).toBeUndefined()
        expect(
          canonicalMonadStampClient(wallet).wasAcknowledged(
            historical.attempt.attemptRef,
          ),
        ).toBe(true)
        effects.verify()
      } finally {
        effects.restore()
        await wallet.close()
      }
      expect(await storedHistoricalRow(historical.storageLocation)).toEqual({
        ...historical.row,
        outcome: 'delivered',
        reason: undefined,
      })
      const again = await reopen(historical.directory)
      try {
        expect(
          await f.chain.directMessages.reconcileAttempts({
            wallet: again,
            payloadDigests: [historical.digest],
          }),
        ).toEqual({ [historical.digest]: 'delivered' })
        expect(reads).toHaveLength(2)
        expect(
          canonicalMonadStampClient(again).lookup(historical.attempt.prepared),
        ).toBeUndefined()
      } finally {
        await again.close()
      }
    })

    it.each([
      'missing',
      'inbound',
      'wrong wallet',
      'wrong network',
      'wrong recipient',
      'changed payload',
      'changed context',
      'swapped raw members',
      'missing raw member',
      'missing member',
      'wrong consumer',
      'wrong header',
      'changed economics',
      'changed member value',
    ])(
      'holds a compacted historical operation with %s evidence without changing it or paying again',
      async variation => {
        const historical = await compactedHistoricalAttempt()
        let row = historical.row
        const record = { ...historical.record }
        if (variation === 'wrong wallet')
          row = {
            ...row,
            prepared: { ...row.prepared, walletBindingId: 'foreign-wallet' },
          }
        if (variation === 'wrong network')
          row = {
            ...row,
            prepared: { ...row.prepared, network: 'monad-mainnet' },
          }
        if (variation === 'wrong recipient')
          row = {
            ...row,
            prepared: {
              ...row.prepared,
              recipientSubject: row.prepared.senderSubject,
            },
          }
        if (variation === 'changed economics') {
          const economics = decodeCanonical(
            fromHex(row.prepared.economicBinding),
          )
          if (!(economics instanceof Map))
            throw new Error('expected economic binding')
          economics.set(1n, '1')
          row = {
            ...row,
            prepared: {
              ...row.prepared,
              economicBinding: toHex(encodeCanonical(economics)),
            },
          }
        }
        if (variation === 'wrong consumer')
          row = { ...row, consumerId: 'frank-dm:' + '00'.repeat(16) }
        if (row !== historical.row) {
          const store = await LevelCanonicalLinkStore.open(
            historical.storageLocation,
          )
          await store.put(row)
          await store.close()
        }
        if (variation === 'inbound') record.direction = 'in'
        if (variation === 'wrong header')
          record.submissionIdentity = '00'.repeat(32)
        if (variation === 'changed context') {
          record.context = new Uint8Array(record.context)
          record.context[record.context.length - 1] ^= 1
        }
        if (
          [
            'changed payload',
            'swapped raw members',
            'missing raw member',
            'missing member',
            'changed member value',
          ].includes(variation)
        ) {
          const parsed = parseFrame(record.delivery)
          if (parsed.kind !== 'parsed' || !(parsed.payload instanceof Map))
            throw new Error('expected delivery')
          const payload = new Map<bigint, FrankValue>(parsed.payload)
          if (variation === 'changed payload') {
            const bytes = new Uint8Array(payload.get(2n) as Uint8Array)
            bytes[bytes.length - 1] ^= 1
            payload.set(2n, bytes)
          } else {
            const members = (
              payload.get(4n) as ReadonlyMap<bigint, FrankValue>[]
            ).map(value => new Map(value))
            if (variation === 'missing raw member') members[0].delete(6n)
            if (variation === 'missing member') members.pop()
            if (variation === 'swapped raw members') {
              const first = members[0].get(6n)!
              members[0].set(6n, members[1].get(6n)!)
              members[1].set(6n, first)
            }
            if (variation === 'changed member value')
              members[0].set(2n, new Uint8Array(32).fill(1))
            payload.set(4n, members)
          }
          record.delivery = encodeFrame(
            { typeId: 1, schemaVersion: 1, minReaderVersion: 1 },
            payload,
          )
          if (
            variation === 'changed member value' ||
            variation === 'missing member'
          )
            record.submissionIdentity = describeCanonicalParts({
              delivery: record.delivery,
              context: record.context,
              transactions:
                variation === 'missing member'
                  ? historical.attempt.request.parts.transactions.slice(0, 1)
                  : historical.attempt.request.parts.transactions,
            }).submission_identity
        }
        mailboxPage.mockResolvedValue({
          records: variation === 'missing' ? [] : [record],
        })
        const wallet = await reopen(historical.directory)
        const effects = noHistoricalExecution(wallet)
        try {
          await expect(
            f.chain.directMessages.reconcileAttempts({
              wallet,
              payloadDigests: [historical.digest],
            }),
          ).rejects.toBeInstanceOf(CanonicalMessagingHoldError)
          expect(
            canonicalMonadStampClient(wallet).lookup(
              historical.attempt.prepared,
            ),
          ).toBeUndefined()
          effects.verify()
        } finally {
          effects.restore()
          await wallet.close()
        }
        expect(await storedHistoricalRow(historical.storageLocation)).toEqual(
          row,
        )
      },
    )

    it.each([
      'page limit',
      'page failure',
      'persistence failure',
      'owner changed',
    ])(
      'retains the old historical link on %s and accepts a later complete proof',
      async variation => {
        const historical = await compactedHistoricalAttempt()
        const wallet = await reopen(historical.directory)
        mailboxPage.mockResolvedValue({ records: [historical.record] })
        if (variation === 'page limit')
          mailboxPage.mockResolvedValue({
            records: [historical.record],
            nextCursor: 'more',
          })
        if (variation === 'page failure')
          mailboxPage
            .mockResolvedValueOnce({
              records: [historical.record],
              nextCursor: 'more',
            })
            .mockRejectedValueOnce(new Error('offline'))
        if (variation === 'owner changed')
          mailboxPage.mockImplementationOnce(async () => {
            installCanonicalDirectory(wallet, { ...historical.directory })
            return { records: [historical.record] }
          })
        const persist =
          variation === 'persistence failure'
            ? jest
                .spyOn(LevelCanonicalLinkStore.prototype, 'put')
                .mockRejectedValueOnce(new Error('storage unavailable'))
            : undefined
        const effects = noHistoricalExecution(wallet)
        try {
          await expect(
            f.chain.directMessages.reconcileAttempts({
              wallet,
              payloadDigests: [historical.digest],
            }),
          ).rejects.toThrow()
          if (variation === 'page limit')
            expect(mailboxPage).toHaveBeenCalledTimes(8)
          effects.verify()
        } finally {
          persist?.mockRestore()
          effects.restore()
          await wallet.close()
        }
        expect(await storedHistoricalRow(historical.storageLocation)).toEqual(
          historical.row,
        )
        mailboxPage.mockResolvedValue({ records: [historical.record] })
        const again = await reopen(historical.directory)
        try {
          expect(
            await f.chain.directMessages.reconcileAttempts({
              wallet: again,
              payloadDigests: [historical.digest],
            }),
          ).toEqual({ [historical.digest]: 'delivered' })
        } finally {
          await again.close()
        }
      },
    )

    it.each([
      'complete',
      'missing sender',
      'missing recipient',
      'mismatched recipient',
    ])(
      'uses exact expired sender and recipient evidence (%s)',
      async scenario => {
        const historical = await compactedHistoricalAttempt()
        const wallet = await reopen(historical.directory)
        const old = await historical.directory.selfCurrent()
        const relay = verifyPreviewDirectoryEvidence(
          old.evidence.attestation,
          'monad-testnet',
        ).statement.relays[0]
        const now = { seconds: 4000n, nanoseconds: 0 }
        const renewedRelay = {
          ...relay,
          expiry: { seconds: 6600n, nanoseconds: 0 },
        }
        const store = await openNodeDirectoryStore({
          location: join(f.root, 'historical-delivery-renewal'),
          anchor: {
            network: 'monad-testnet',
            subject: {
              keyType: 1,
              keyBytes: fromHex(historical.attempt.prepared.senderSubject),
            },
            revisionZero: old.evidence.hash,
          },
          mode: { kind: 'new' },
        })
        const recipient = await historical.directory.peerCurrent({
          subject: historical.attempt.prepared.recipientSubject,
        })
        if (!recipient) throw Error('fixture recipient missing')
        const recipientStore = await openNodeDirectoryStore({
          location: join(f.root, 'hd1-expired-recipient'),
          anchor: {
            network: 'monad-testnet',
            subject: { keyType: 1, keyBytes: fromHex(recipient.subject) },
            revisionZero: recipient.current.evidence.hash,
          },
          mode: { kind: 'new' },
        })
        await recipientStore.enroll([recipient.current.evidence], {
          now: NOW,
          relay,
        })
        try {
          await store.enroll([old.evidence], { now: NOW, relay })
          const next = prepareMonadNextRevisionExport(wallet, {
            networkTag: 'MONT',
            network: 'monad-testnet',
            chainId: 10143n,
            issuedAt: { seconds: 3000n, nanoseconds: 0 },
            expiresAt: renewedRelay.expiry,
            now,
            relay: renewedRelay,
            revision: 1n,
            predecessor: old.evidence.hash,
          })
          const current = await store.advance(
            [{ statement: next.statement, attestation: next.attestation }],
            { now, relay: renewedRelay },
          )
          expect(current.revision).toBe(1n)
          expect(current.generations).toEqual(old.generations)
          expect(toHex(current.evidence.hash)).not.toBe(
            historical.attempt.prepared.senderT1,
          )
          expect(
            verifyPreviewDirectoryEvidence(
              old.evidence.attestation,
              'monad-testnet',
            ).statement.expiry.seconds,
          ).toBeLessThan(now.seconds)
          await expect(recipientStore.current({ now, relay })).rejects.toThrow()
          const recipientEvidence = await recipientStore.historicalEvidence(
            fromHex(historical.attempt.prepared.recipientT1),
          )
          if (!recipientEvidence)
            throw new Error('fixture recipient history missing')
          const archiveRoles = createCanonicalMessageRoles(wallet, current)
          try {
            const opened = openOwnDirectMessage({
              mode: 'archive',
              network: 'monad-testnet',
              payload: historical.attempt.prepared.payload,
              context: historical.attempt.prepared.context,
              roles: archiveRoles,
              senderEvidence: old.evidence,
              recipientEvidence,
            })
            expect(toHex(opened.recipientT1)).toBe(
              historical.attempt.prepared.recipientT1,
            )
            expect(toHex(opened.senderT1)).toBe(
              historical.attempt.prepared.senderT1,
            )
          } finally {
            archiveRoles.dispose()
          }
          const historicalRead = jest.fn(
            async (wanted: { subject: string; statementHash: string }) => {
              if (wanted.subject === recipient.subject) {
                if (scenario === 'missing recipient') return undefined
                if (scenario === 'mismatched recipient') return old.evidence
                return (
                  (await recipientStore.historicalEvidence(
                    fromHex(wanted.statementHash),
                  )) ?? undefined
                )
              }
              if (scenario === 'missing sender') return undefined
              return (
                (await store.historicalEvidence(
                  fromHex(wanted.statementHash),
                )) ?? undefined
              )
            },
          )
          const currentRead = jest.fn(async () => ({
            subject: recipient.subject,
            endpoint: recipient.endpoint,
            current: await recipientStore.current({ now, relay }),
          }))
          installCanonicalDirectory(wallet, {
            ...historical.directory,
            selfCurrent: () => store.current({ now, relay: renewedRelay }),
            peerCurrent: currentRead,
            peerHistorical: historicalRead,
          })
          mailboxPage.mockResolvedValue({ records: [historical.record] })
          const effects = noHistoricalExecution(wallet)
          try {
            const result = f.chain.directMessages.reconcileAttempts({
              wallet,
              payloadDigests: [historical.digest],
            })
            if (scenario === 'complete') {
              await expect(result).resolves.toEqual({
                [historical.digest]: 'delivered',
              })
              expect(currentRead).not.toHaveBeenCalled()
              expect(historicalRead).toHaveBeenCalledWith({
                subject: historical.attempt.prepared.recipientSubject,
                statementHash: historical.attempt.prepared.recipientT1,
              })
            } else {
              await expect(result).rejects.toBeInstanceOf(
                CanonicalMessagingHoldError,
              )
            }
            effects.verify()
          } finally {
            effects.restore()
          }
        } finally {
          await recipientStore.close()
          await store.close()
          await wallet.close()
        }
        expect(await storedHistoricalRow(historical.storageLocation)).toEqual(
          scenario === 'complete'
            ? { ...historical.row, outcome: 'delivered', reason: undefined }
            : historical.row,
        )
      },
    )

    it('admits concurrent complete historical proofs once without replaying the compacted operation', async () => {
      const historical = await compactedHistoricalAttempt()
      const wallet = await reopen(historical.directory)
      mailboxPage.mockResolvedValue({ records: [historical.record] })
      const persist = jest.spyOn(LevelCanonicalLinkStore.prototype, 'put')
      const effects = noHistoricalExecution(wallet)
      try {
        const params = { wallet, payloadDigests: [historical.digest] }
        expect(
          await Promise.all([
            f.chain.directMessages.reconcileAttempts(params),
            f.chain.directMessages.reconcileAttempts(params),
          ]),
        ).toEqual([
          { [historical.digest]: 'delivered' },
          { [historical.digest]: 'delivered' },
        ])
        expect(persist).toHaveBeenCalledTimes(1)
        effects.verify()
      } finally {
        persist.mockRestore()
        effects.restore()
        await wallet.close()
      }
    })

    it('does not hold the workflow queue during historical mailbox reads or publish a closed wallet result', async () => {
      const historical = await compactedHistoricalAttempt()
      const wallet = await reopen(historical.directory)
      let resolvePage!: (
        page: Awaited<ReturnType<typeof fetchCanonicalMailboxPage>>,
      ) => void
      let started!: () => void
      const scanning = new Promise<void>(resolve => {
        started = resolve
      })
      mailboxPage.mockImplementationOnce(() => {
        started()
        return new Promise(resolve => {
          resolvePage = resolve
        })
      })
      const reconciliation = f.chain.directMessages.reconcileAttempts({
        wallet,
        payloadDigests: [historical.digest],
      })
      await scanning
      await f.chain.directMessages.discardAttempt({
        wallet,
        payloadDigest: historical.digest,
      })
      await wallet.close()
      resolvePage({ records: [historical.record] })
      await expect(reconciliation).rejects.toBeInstanceOf(
        CanonicalMessagingHoldError,
      )
      expect(await storedHistoricalRow(historical.storageLocation)).toEqual(
        historical.row,
      )
    })
  })

  function retainedAttempt(
    wallet: EvmChainWalletHandle,
    original: CanonicalJournalAttempt,
  ) {
    const found = canonicalMonadStampClient(wallet).lookup(original.prepared)
    expect(found?.kind).toBe('attempt')
    if (!found || found.kind !== 'attempt')
      throw new Error('expected retained attempt')
    expect(found.record.request).toEqual(original.request)
    expect(found.record.prepared).toEqual(original.prepared)
    expect(found.record.reservations).toEqual(original.reservations)
    expect(found.record.cleanupComplete).toBe(false)
    expect(found.record.acknowledged).toBe(false)
    for (const reservation of original.reservations)
      expect(wallet.pool.getRecord(reservation.index)?.status).toBe('in-use')
    return found.record
  }

  it.each(['lost', 'bad_request'] as const)(
    'retains exact payments after %s responses, exhaustion, discard, partial broadcast and restart',
    async response => {
      const { directory, digest, attempt } = await exposedAttempt()
      // A relay has the exact signed bytes, and one member lands before the response is known.
      f.broadcast(0, [0])
      expect(f.broadcastPayments.size).toBe(1)
      f.setPhase(response)
      for (let retry = 0; retry < 6; retry++)
        expect(
          await f.chain.directMessages.reconcileAttempts({
            wallet: f.alice,
            payloadDigests: [digest],
          }),
        ).toEqual({ [digest]: 'live' })
      retainedAttempt(f.alice, attempt)
      await f.chain.directMessages.discardAttempt({
        wallet: f.alice,
        payloadDigest: digest,
      })
      retainedAttempt(f.alice, attempt)
      await f.alice.close()
      f.alice = await reopen(directory)
      retainedAttempt(f.alice, attempt)
      expect(
        await f.chain.directMessages.unattributedAttempts({
          wallet: f.alice,
          knownDigests: [],
        }),
      ).toEqual([digest])
      // The recipient can broadcast the remaining original bytes after exhaustion/discard.
      f.broadcast(0)
      f.broadcast(0)
      expect([...f.broadcastPayments.values()].reduce((a, b) => a + b, 0n)).toBe(
        400_000n,
      )
      f.setPhase('delivered')
      const finish = jest.spyOn(
        MonadCanonicalStampClient.prototype,
        'finishIntent',
      )
      try {
        for (let pass = 0; pass < 2; pass++)
          expect(
            await f.chain.directMessages.reconcileAttempts({
              wallet: f.alice,
              payloadDigests: [digest],
            }),
          ).toEqual({ [digest]: 'delivered' })
        expect(finish).not.toHaveBeenCalled()
      } finally {
        finish.mockRestore()
      }
      expect(new Set(f.requests.map(r => toHex(r.body))).size).toBe(1)
      const client = canonicalMonadStampClient(f.alice)
      expect(client.lookup(attempt.prepared)).toBeUndefined()
      expect(client.wasAcknowledged(attempt.attemptRef)).toBe(true)
      expect(f.alice.pool.records().map(r => r.status)).not.toContain('in-use')
      await f.alice.close()
      f.alice = await reopen(directory)
      const count = f.requests.length
      expect(
        await f.chain.directMessages.reconcileAttempts({
          wallet: f.alice,
          payloadDigests: [digest],
        }),
      ).toEqual({ [digest]: 'delivered' })
      expect(f.requests).toHaveLength(count)
      expect(f.broadcastPayments.size).toBe(2)
    },
  )

  it('retains a late relay rejection across discard, delayed broadcast and restart', async () => {
    const { directory, digest, attempt } = await exposedAttempt()
    f.setPhase('undeliverable')
    expect(
      await f.chain.directMessages.reconcileAttempts({
        wallet: f.alice,
        payloadDigests: [digest],
      }),
    ).toEqual({ [digest]: 'dead' })
    expect(retainedAttempt(f.alice, attempt).terminal).toMatchObject({
      phase: 'dead',
    })
    await f.chain.directMessages.discardAttempt({
      wallet: f.alice,
      payloadDigest: 'all',
    })
    await f.alice.close()
    f.alice = await reopen(directory)
    // Rejection did not revoke bytes already held by the relay or recipient.
    f.broadcast(0)
    for (let pass = 0; pass < 2; pass++) {
      expect(
        await f.chain.directMessages.reconcileAttempts({
          wallet: f.alice,
          payloadDigests: [digest],
        }),
      ).toEqual({ [digest]: 'dead' })
      retainedAttempt(f.alice, attempt)
    }
    expect([...f.broadcastPayments.values()].reduce((a, b) => a + b, 0n)).toBe(
      400_000n,
    )
    expect(f.requests).toHaveLength(2)
    // #1323: the ended attempt no longer refuses a later message as pending. This wallet has no
    // money outside the ended attempt's accounts, and those stay reserved, so the later message
    // stops at funding instead of reusing them. (A later message that is paid and delivered from
    // other accounts is proved in `monad-canonical-ended-attempt.jest.test.ts`.)
    await expect(
      f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: text('a later message'),
      }),
    ).rejects.toThrow(/Insufficient main account balance/)
    expect(f.requests).toHaveLength(2)
    retainedAttempt(f.alice, attempt)
  })

  it('holds a journaled payment with a missing workflow link over restart and discard', async () => {
    const { directory, digest, attempt } = await exposedAttempt()
    const aliceAddr = (await f.alice.getReceiveAddress()).raw.toLowerCase()
    const storageLocation = `${join(f.root, 'wallet')}-evm-${aliceAddr}`
    await f.alice.close()
    // Only this fixture's synthetic link is removed; its authoritative journal stays intact.
    const links = level(join(storageLocation, 'canonical-dm-workflow-links'))
    await links.del(attempt.attemptRef)
    await links.close()
    f.alice = await reopen(directory)
    const prepare = jest.spyOn(
      MonadCanonicalStampClient.prototype,
      'prepareIntent',
    )
    try {
      await expect(
        f.chain.directMessages.reconcileAttempts({
          wallet: f.alice,
          payloadDigests: [digest],
        }),
      ).rejects.toBeInstanceOf(CanonicalMessagingHoldError)
      await f.chain.directMessages.discardAttempt({
        wallet: f.alice,
        payloadDigest: 'all',
      })
      retainedAttempt(f.alice, attempt)
      await expect(
        f.chain.directMessages.send({
          wallet: f.alice,
          recipient: f.bob.identity.address,
          items: text('behind missing link'),
        }),
      ).rejects.toBeInstanceOf(CanonicalMessagingHoldError)
      expect(prepare).not.toHaveBeenCalled()
      expect(f.requests).toHaveLength(1)
      await f.alice.close()
      f.alice = await reopen(directory)
      retainedAttempt(f.alice, attempt)
    } finally {
      prepare.mockRestore()
    }
  })

  it('keeps sender_unpublished payment evidence reserved instead of claiming no financial effect', async () => {
    const directory = await f.directoryFor('alice', f.alice, f.bob)
    installCanonicalDirectory(f.alice, directory)
    f.setPhase('sender_unpublished')
    await expect(
      f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: text('unpublished sender'),
      }),
      // #1323: the send reports the relay's final answer; the accounts stay reserved.
    ).rejects.toBeInstanceOf(CanonicalSenderUnpublishedError)
    expect(f.alice.pool.records().map(r => r.status)).toContain('in-use')
  })

  it('keeps reporting a delivered attempt no message recorded across wallet reopens, and never pays for it twice', async () => {
    const { directory, digest } = await interruptedSend('orphan')
    expect(f.requests).toHaveLength(0)
    // Next session: the frozen payment is finished and delivered, and nobody points at it.
    let wallet = await reopen(directory)
    try {
      expect(await orphans(wallet)).toEqual([digest])
      expect(f.requests).toHaveLength(1)
      expect(restoreCanonicalRequest(f.requests[0]).identity.payload_hash).toBe(
        digest,
      )
      await wallet.close()
      // The user did not confirm. After a reload or lock/unlock it must still be reported, so the
      // app still has to ask before it builds another payment for the same message.
      for (let session = 0; session < 2; session++) {
        wallet = await reopen(directory)
        expect(await orphans(wallet)).toEqual([digest])
        expect(
          await f.chain.directMessages.reconcileAttempts({
            wallet,
            payloadDigests: [digest],
          }),
        ).toEqual({ [digest]: 'delivered' })
        await wallet.close()
      }
      // Nothing was paid or sent again by any of those sessions.
      expect(f.requests).toHaveLength(1)
    } finally {
      await wallet.close()
    }
  })

  it('stops reporting a delivered orphan once the user has resolved it, also after reopen', async () => {
    const { directory, digest } = await interruptedSend('resolved')
    let wallet = await reopen(directory)
    try {
      expect(await orphans(wallet)).toEqual([digest])
      await wallet.close()
      wallet = await reopen(directory)
      await f.chain.directMessages.resolveUnattributedAttempts({
        wallet,
        payloadDigests: [digest],
      })
      expect(await orphans(wallet)).toEqual([])
      await wallet.close()
      wallet = await reopen(directory)
      expect(await orphans(wallet)).toEqual([])
      // The durable outcome itself is still answerable.
      expect(
        await f.chain.directMessages.reconcileAttempts({
          wallet,
          payloadDigests: [digest],
        }),
      ).toEqual({ [digest]: 'delivered' })
      expect(f.requests).toHaveLength(1)
    } finally {
      await wallet.close()
    }
  })

  it('stops reporting a delivered attempt once a message pointed at it, also after that message is gone and the wallet reopened', async () => {
    const directory = await f.directoryFor('alice', f.alice, f.bob)
    installCanonicalDirectory(f.alice, directory)
    const sent = await f.chain.directMessages.send({
      wallet: f.alice,
      recipient: f.bob.identity.address,
      items: text('attributed'),
    })
    // Delivered and not yet accounted for by anyone.
    expect(await orphans(f.alice)).toEqual([sent.payloadDigest])
    // A saved message points at it.
    expect(await orphans(f.alice, [sent.payloadDigest])).toEqual([])
    await f.alice.close()
    const wallet = await reopen(directory)
    try {
      // The message was deleted since: the attempt was accounted for and must not block Retry.
      expect(await orphans(wallet)).toEqual([])
    } finally {
      await wallet.close()
    }
  })

  it('always reports an attempt with no outcome, even after a resolve request and a reopen', async () => {
    const directory = await f.directoryFor('alice', f.alice, f.bob)
    installCanonicalDirectory(f.alice, directory)
    f.setPhase('retained')
    let digest = ''
    await expect(
      f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: text('live'),
        onAttemptCreated: created => void (digest = created),
      }),
    ).rejects.toBeInstanceOf(MonadStampPendingAttemptError)
    expect(await orphans(f.alice)).toEqual([digest])
    // A live payment cannot be waved away: it may still be delivered.
    await f.chain.directMessages.resolveUnattributedAttempts({
      wallet: f.alice,
      payloadDigests: [digest],
    })
    expect(await orphans(f.alice)).toEqual([digest])
    await f.alice.close()
    const wallet = await reopen(directory)
    try {
      expect(await orphans(wallet)).toEqual([digest])
      // Once it is delivered it is reported as a delivered orphan; the early request did not stick.
      f.setPhase('delivered')
      expect(await orphans(wallet)).toEqual([digest])
      expect(
        await f.chain.directMessages.reconcileAttempts({
          wallet,
          payloadDigests: [digest],
        }),
      ).toEqual({ [digest]: 'delivered' })
      expect(new Set(f.requests.map(r => toHex(r.body))).size).toBe(1)
    } finally {
      await wallet.close()
    }
  })

  it('funds an unfunded typed wallet through the public bridge so a canonical intent can be paid', async () => {
    const main = (await f.alice.getReceiveAddress()).raw.toLowerCase()
    mockBalances.set(main, 10n ** 18n)
    expect(f.alice.pool.records()).toHaveLength(0)
    const aliceDirectory = await f.directoryFor('alice', f.alice, f.bob)
    const peer = (await aliceDirectory.peerCurrent({
      address: f.bob.identity.address.raw,
    }))!
    const hashes = await prepareCanonicalStampInventory(f.alice, {
      stampValueWei: 1_000n,
      recipientStampKey: peer.current.stampKey.keyBytes,
    })
    expect(hashes.length).toBeGreaterThan(0)
    expect(mockFunded.length).toBe(hashes.length)
    expect(mockFunded.every(tx => tx.from === main)).toBe(true)
    const available = f.alice.pool
      .records()
      .filter(record => record.status === 'available')
    expect(available.map(r => r.address.toLowerCase()).sort()).toEqual(
      mockFunded.map(tx => tx.to).sort(),
    )
    // A second call finds the inventory sufficient and funds nothing more.
    expect(
      await prepareCanonicalStampInventory(f.alice, {
        stampValueWei: 1_000n,
        recipientStampKey: peer.current.stampKey.keyBytes,
      }),
    ).toEqual([])
    // The bridged roles seal for the live wallet, and its own client can pay from the inventory.
    const senderCurrent = await aliceDirectory.selfCurrent()
    const roles = createCanonicalMessageRoles(f.alice, senderCurrent)
    const sealed = prepareDirectMessage({
      network: 'monad-testnet',
      senderCurrent,
      recipientCurrent: peer.current,
      messageId: new Uint8Array(16).fill(7),
      items: [directMessageText('funded')],
      roles,
    })
    roles.dispose()
    const client = canonicalMonadStampClient(f.alice)
    const intent = await client.prepareIntent({
      prepared: client.bindPrepared({
        payload: sealed.payload,
        context: sealed.context,
        stampValueWei: 1_000n,
        economicBinding: Uint8Array.of(1),
      }),
      consumerId: 'bridge-test',
      stampValueWei: 1_000n,
      senderCurrent,
      recipientCurrent: peer.current,
      onIntentDurable: async () => undefined,
    })
    expect(intent.members.length).toBeGreaterThan(0)
    await f.alice.close()
    expect(() =>
      prepareCanonicalStampInventory(f.alice, {
        stampValueWei: 1n,
        recipientStampKey: peer.current.stampKey.keyBytes,
      }),
    ).toThrow('live typed persistent custody')
    expect(() => createCanonicalMessageRoles(f.alice, senderCurrent)).toThrow(
      'live typed wallet custody',
    )
  })

  it('sends from an unfunded wallet by funding inventory first', async () => {
    mockBalances.set(
      (await f.alice.getReceiveAddress()).raw.toLowerCase(),
      10n ** 18n,
    )
    installCanonicalDirectory(
      f.alice,
      await f.directoryFor('alice', f.alice, f.bob),
    )
    const sent = await f.chain.directMessages.send({
      wallet: f.alice,
      recipient: f.bob.identity.address,
      items: text('paid from fresh inventory'),
    })
    expect(sent.preparationTxHashes.length).toBeGreaterThan(0)
    expect(sent.stampPayments.reduce((n, p) => n + p.valueWei, 0n)).toBe(1_000n)
    expect(f.requests).toHaveLength(1)
  })

  describe('labels the send refusals that attempted nothing (#1237)', () => {
    type Send = Parameters<DirectMessageClient['send']>[0]
    /** One refused send from Alice to Bob, with what it left behind. */
    async function refusal(overrides: Partial<Send> = {}) {
      const prepare = jest.spyOn(
        MonadCanonicalStampClient.prototype,
        'prepareIntent',
      )
      const pool = structuredClone(f.alice.pool.records())
      const funded = mockFunded.length
      const requests = f.requests.length
      const onAttemptCreated = jest.fn()
      try {
        const error: unknown = await f.chain.directMessages
          .send({
            wallet: f.alice,
            recipient: f.bob.identity.address,
            items: text('refused'),
            onAttemptCreated,
            ...overrides,
          })
          .then(
            () => new Error('the send was not refused'),
            (reason: unknown) => reason,
          )
        return {
          error,
          prepared: prepare.mock.calls.length,
          linked: onAttemptCreated.mock.calls.length,
          funded: mockFunded.length - funded,
          poolUnchanged: () => expect(f.alice.pool.records()).toEqual(pool),
          // Payload hashes of the relay requests made while this send ran.
          submitted: f.requests
            .slice(requests)
            .map(r => restoreCanonicalRequest(r).identity.payload_hash),
        }
      } finally {
        prepare.mockRestore()
      }
    }
    /** Labelled, and nothing was built, reserved, funded, linked or handed over for this send.
     * `resent` are earlier attempts whose own bytes went to the relay again meanwhile. */
    function expectNothingAttempted(
      refused: Awaited<ReturnType<typeof refusal>>,
      resent: string[] = [],
    ) {
      expect(isDirectMessageNotAttempted(refused.error)).toBe(true)
      expect(refused.prepared).toBe(0)
      expect(refused.linked).toBe(0)
      expect(refused.funded).toBe(0)
      expect(refused.submitted).toEqual(resent)
      refused.poolUnchanged()
    }
    const unlinked = () =>
      f.chain.directMessages.unattributedAttempts({
        wallet: f.alice,
        knownDigests: [],
      })

    it('reports a plain error and a value that is not an error as possibly attempted', () => {
      expect(isDirectMessageNotAttempted(new Error('plain'))).toBe(false)
      expect(
        isDirectMessageNotAttempted(new MonadStampPendingAttemptError(['00'])),
      ).toBe(false)
      for (const value of ['refused', 0, true, undefined, null, {}, []])
        expect(isDirectMessageNotAttempted(value)).toBe(false)
    })

    it('labels a send refused because no directory is installed', async () => {
      const refused = await refusal()
      expect(refused.error).toBeInstanceOf(CanonicalMessagingPendingError)
      expect((refused.error as Error).message).toBe(
        new CanonicalMessagingPendingError().message,
      )
      expectNothingAttempted(refused)
    })

    it('labels a send refused for its content', async () => {
      installCanonicalDirectory(
        f.alice,
        await f.directoryFor('alice', f.alice, f.bob),
      )
      // A type no installed plugin owns. (An image is a registered type and is carried now.)
      const unsupported = await refusal({
        items: [{ type: 'hologram' } as never],
      })
      expect(unsupported.error).toBeInstanceOf(Error)
      expect((unsupported.error as Error).message).toBe(
        "Canonical direct messages cannot carry 'hologram' items yet; nothing was paid or sent.",
      )
      expectNothingAttempted(unsupported)
      const empty = await refusal({ items: [] })
      expect((empty.error as Error).message).toBe(
        'A direct message needs content',
      )
      expectNothingAttempted(empty)
      expect(await unlinked()).toEqual([])
    })

    it('labels a send refused at the recipient lookup, and passes on what cannot carry a label', async () => {
      const directory = await f.directoryFor('alice', f.alice, f.bob)
      let thrown: unknown
      installCanonicalDirectory(f.alice, {
        ...directory,
        peerCurrent: async wanted => {
          if (thrown !== undefined) throw thrown
          return directory.peerCurrent(wanted)
        },
      })
      const stranger = '0x000000000000000000000000000000000000dEaD'
      const unpublished = await refusal({ recipient: { raw: stranger } })
      expect(unpublished.error).toBeInstanceOf(
        CanonicalRecipientNotPublishedError,
      )
      expect((unpublished.error as Error).message).toBe(
        new CanonicalRecipientNotPublishedError(stranger).message,
      )
      expectNothingAttempted(unpublished)

      // A failed directory read is the same object the directory threw, now labelled.
      const unreachable = (thrown = new OpenDirectoryError(
        'unreachable',
        stranger,
      ))
      const failed = await refusal()
      expect(failed.error).toBe(unreachable)
      expect(Object.keys(unreachable)).toEqual(
        Object.keys(new OpenDirectoryError('unreachable', stranger)),
      )
      expectNothingAttempted(failed)

      // Still refused exactly as before; these cannot carry a label, so they stay ambiguous.
      const frozen = (thrown = Object.freeze(new Error('frozen')))
      const sealed = await refusal()
      expect(sealed.error).toBe(frozen)
      expect(isDirectMessageNotAttempted(sealed.error)).toBe(false)
      thrown = 'not an error'
      const bare = await refusal()
      expect(bare.error).toBe('not an error')
      expect(isDirectMessageNotAttempted(bare.error)).toBe(false)
      expect(await unlinked()).toEqual([])
    })

    it('labels a send refused because the home relay does not forward', async () => {
      const directory = await f.directoryFor('alice', f.alice, f.bob)
      installCanonicalDirectory(f.alice, {
        ...directory,
        peerCurrent: async wanted => {
          const peer = await directory.peerCurrent(wanted)
          return peer && { ...peer, endpoint: 'https://relay-b.example/' }
        },
      })
      const refused = await refusal()
      expect(refused.error).toBeInstanceOf(CanonicalRelayCannotForwardError)
      expect((refused.error as Error).message).toBe(
        new CanonicalRelayCannotForwardError(
          f.bob.identity.address.raw,
          'https://relay-b.example/',
        ).message,
      )
      expectNothingAttempted(refused)
      expect(await unlinked()).toEqual([])
    })

    it('labels a send held behind an earlier payment, not the send that made that payment', async () => {
      installCanonicalDirectory(
        f.alice,
        await f.directoryFor('alice', f.alice, f.bob),
      )
      const failure = new Error('signer unavailable')
      const finish = jest
        .spyOn(MonadCanonicalStampClient.prototype, 'finishIntent')
        .mockRejectedValue(failure)
      try {
        // This send made a durable payment intent and linked it before it was refused.
        const first = await refusal()
        expect(first.error).toBeInstanceOf(MonadStampPendingAttemptError)
        expect(first.prepared).toBe(1)
        expect(first.linked).toBe(1)
        expect(isDirectMessageNotAttempted(first.error)).toBe(false)

        const held = await refusal()
        expect(held.error).toBeInstanceOf(CanonicalMessagingHoldError)
        expect((held.error as Error).message).toBe(
          'An earlier payment could not be finished yet. Its exact payment set is kept and nothing new is paid.',
        )
        expect((held.error as { cause?: unknown }).cause).toBe(failure)
        expectNothingAttempted(held)
        // The original failure it carries is not itself a statement about this send.
        expect(isDirectMessageNotAttempted(failure)).toBe(false)
      } finally {
        finish.mockRestore()
      }
    })

    it('labels a send refused while an earlier attempt is pending, not that attempt itself', async () => {
      installCanonicalDirectory(
        f.alice,
        await f.directoryFor('alice', f.alice, f.bob),
      )
      f.setPhase('fail')
      let digest = ''
      // Linked, signed and offered to the relay, with no answer: this one may have been paid.
      const first = await refusal({
        onAttemptCreated: created => void (digest = created),
      })
      expect(first.error).toBeInstanceOf(MonadStampPendingAttemptError)
      expect(first.prepared).toBe(1)
      expect(digest).toMatch(/^[0-9a-f]{64}$/)
      expect(isDirectMessageNotAttempted(first.error)).toBe(false)

      f.setPhase('retained')
      const behind = await refusal()
      expect(behind.error).toBeInstanceOf(MonadStampPendingAttemptError)
      expect((behind.error as Error).message).toBe(
        new MonadStampPendingAttemptError([digest]).message,
      )
      // Only the earlier attempt's own bytes went out again; nothing exists for this send.
      expectNothingAttempted(behind, [digest])
      expect(await unlinked()).toEqual([digest])
    })

    it('does not label a send refused while funding inventory from an unfunded wallet', async () => {
      installCanonicalDirectory(
        f.alice,
        await f.directoryFor('alice', f.alice, f.bob),
      )
      const refused = await refusal()
      expect((refused.error as Error).message).toMatch(
        /^Insufficient main account balance to prepare stamp accounts/,
      )
      expect(refused.prepared).toBe(0)
      expect(refused.linked).toBe(0)
      expect(isDirectMessageNotAttempted(refused.error)).toBe(false)
    })

    it('does not label a send refused inside intent preparation', async () => {
      installCanonicalDirectory(
        f.alice,
        await f.directoryFor('alice', f.alice, f.bob),
      )
      // The intent is durable and linked when the caller's own record of it fails.
      const stopped = new Error('app stopped')
      const interrupted = await refusal({
        onAttemptCreated: () => {
          throw stopped
        },
      })
      expect(interrupted.error).toBe(stopped)
      expect(interrupted.prepared).toBe(1)
      expect(interrupted.submitted).toEqual([])
      expect(isDirectMessageNotAttempted(interrupted.error)).toBe(false)
      expect(await unlinked()).toHaveLength(1)
    })

    it('answers only for the labelled error object itself, however often it is labelled', async () => {
      const directory = await f.directoryFor('alice', f.alice, f.bob)
      const reused = new Error('directory unreachable')
      installCanonicalDirectory(f.alice, {
        ...directory,
        peerCurrent: async () => {
          throw reused
        },
      })
      expectNothingAttempted(await refusal())
      // Refused the same way with the same object again: still that refusal, still labelled.
      const again = await refusal()
      expect(again.error).toBe(reused)
      expectNothingAttempted(again)
      expect(Object.keys(reused)).toEqual([])
      // Neither of these is the object the wallet rejected with, so neither is answered for.
      expect(isDirectMessageNotAttempted(Object.create(reused))).toBe(false)
      // A proxy that forwards everything still reads through itself, not as the labelled error.
      expect(isDirectMessageNotAttempted(new Proxy(reused, {}))).toBe(false)
      expect(isDirectMessageNotAttempted(reused)).toBe(true)
    })

    it('does not label a hold raised after inventory preparation, the same class as a labelled hold', async () => {
      installCanonicalDirectory(
        f.alice,
        await f.directoryFor('alice', f.alice, f.bob),
      )
      // Intent preparation returns without ever reporting a durable, linked intent.
      const prepare = jest
        .spyOn(MonadCanonicalStampClient.prototype, 'prepareIntent')
        .mockResolvedValueOnce(undefined as never)
      try {
        const held = await refusal()
        expect(held.error).toBeInstanceOf(CanonicalMessagingHoldError)
        expect((held.error as Error).message).toBe(
          new CanonicalMessagingHoldError().message,
        )
        expect(held.prepared).toBe(1)
        expect(isDirectMessageNotAttempted(held.error)).toBe(false)
      } finally {
        prepare.mockRestore()
      }
    })

    it('labels a send held by a payment record no saved message accounts for', async () => {
      const address = (await f.alice.getReceiveAddress()).raw.toLowerCase()
      const storageLocation = `${join(f.root, 'wallet')}-evm-${address}`
      const directory = await f.directoryFor('alice', f.alice, f.bob)
      await f.alice.close()
      const store = await LevelCanonicalLinkStore.open(storageLocation)
      const row = {
        attemptRef: 'orphaned-ref-999',
        consumerId: 'frank-dm:orphaned',
        digest: 'ab'.repeat(32),
        prepared: { payload: '00', context: '00', economicBinding: '00' },
      }
      await store.put(row)
      await store.close()
      f.alice = await reopen(directory)
      const held = await refusal()
      expect(held.error).toBeInstanceOf(CanonicalMessagingHoldError)
      expect((held.error as Error).message).toBe(
        new CanonicalMessagingHoldError().message,
      )
      expect((held.error as { cause?: unknown }).cause).toBeUndefined()
      expectNothingAttempted(held)
      await f.alice.close()
      const retained = await LevelCanonicalLinkStore.open(storageLocation)
      try {
        expect(retained.all()).toEqual([row])
      } finally {
        await retained.close()
      }
    })

    it('does not label a possibly attempted send whose cause an earlier call labelled', async () => {
      const directory = await f.directoryFor('alice', f.alice, f.bob)
      const unreachable = new Error('directory unreachable')
      let failing = true
      installCanonicalDirectory(f.alice, {
        ...directory,
        peerCurrent: async wanted => {
          if (failing) throw unreachable
          return directory.peerCurrent(wanted)
        },
      })
      expectNothingAttempted(await refusal())
      failing = false
      // This call has a durable, linked intent when the caller's own record of it fails.
      const outer = Object.assign(new Error('could not record the attempt'), {
        cause: unreachable,
      })
      const interrupted = await refusal({
        onAttemptCreated: () => {
          throw outer
        },
      })
      expect(interrupted.error).toBe(outer)
      expect(interrupted.prepared).toBe(1)
      expect(isDirectMessageNotAttempted(interrupted.error)).toBe(false)
      // The cause still carries the answer for the earlier call it was the rejection of. It is
      // not the rejection of this call, which is why a caller must never test a cause.
      expect(isDirectMessageNotAttempted(outer.cause)).toBe(true)
      expect(await unlinked()).toHaveLength(1)
    })

    it('never labels an error object again once it has left a send that may have attempted something', async () => {
      const directory = await f.directoryFor('alice', f.alice, f.bob)
      const reused = new Error('directory unreachable')
      let failing: 'address' | 'subject' = 'address'
      installCanonicalDirectory(f.alice, {
        ...directory,
        peerCurrent: async wanted => {
          if (failing in wanted) throw reused
          return directory.peerCurrent(wanted)
        },
      })
      const before = await refusal()
      expect(before.error).toBe(reused)
      expectNothingAttempted(before)

      // The same object now comes from the directory read that follows inventory preparation.
      failing = 'subject'
      const after = await refusal()
      expect(after.error).toBe(reused)
      expect(after.prepared).toBe(0)
      expect(isDirectMessageNotAttempted(after.error)).toBe(false)

      // A caller still holding it from the later send must not see it turn back.
      failing = 'address'
      const again = await refusal()
      expect(again.error).toBe(reused)
      expect(isDirectMessageNotAttempted(again.error)).toBe(false)
      expect(await unlinked()).toEqual([])
    })
  })
})

describe('two typed wallets on the open directory', () => {
  jest.setTimeout(60_000)
  const SECOND = 1_000_000_000n
  const CLOCK = 1_800_000_000n * SECOND
  let clock = CLOCK
  let f: Awaited<ReturnType<typeof fixture>>
  let relay: ReturnType<typeof createFakeRelay>
  const directories: ReturnType<typeof openDirectory>[] = []
  beforeEach(async () => {
    jest.clearAllMocks()
    clock = CLOCK
    mockBalances.clear()
    mockFunded.length = 0
    f = await fixture()
    relay = createFakeRelay({ endpoint: RELAY })
  })
  afterEach(async () => {
    for (const directory of directories.splice(0)) await directory.close()
    await f.close()
  })
  /** One wallet's own directory: its own stores and pins, signing with its own typed custody. */
  function open(
    name: string,
    wallet: EvmChainWalletHandle,
    on: ReturnType<typeof createFakeRelay> = relay,
  ) {
    const descriptor = {
      networkTag: 'MONT' as const,
      network: 'monad-testnet',
      chainId: 10143n,
    }
    const directory = openDirectory({
      network: 'monad-testnet',
      relayBaseUrl: on.endpoint,
      nowNs: () => clock,
      fetch: on.fetch,
      ...nodeDirectoryStorage(join(f.root, `open-${name}`)),
      self: {
        subject: toHex(wallet.identity.compressedPubKey),
        signRevisionZero: input =>
          prepareMonadRevisionZeroExport(wallet, { ...descriptor, ...input })
            .attestation,
        signNextRevision: input =>
          prepareMonadNextRevisionExport(wallet, { ...descriptor, ...input })
            .attestation,
      },
    })
    directories.push(directory)
    return directory
  }
  async function online(name: string, wallet: EvmChainWalletHandle) {
    const directory = open(name, wallet)
    await directory.publish()
    installCanonicalDirectory(wallet, { ...directory, fetch: f.fetch })
    return directory
  }
  /** What the relay would put in the recipient's inbox for the n-th accepted submission. */
  const inboxRecord = (index: number, timestampMs: number) => {
    const request = restoreCanonicalRequest(f.requests[index])
    return {
      delivery: request.parts.delivery,
      context: request.parts.context,
      submissionIdentity: request.identity.submission_identity,
      timestampMs,
    }
  }
  /** What the relay would echo to the sender's mailbox for the n-th accepted submission. */
  const outboundRecord = (index: number, timestampMs: number) => {
    const request = restoreCanonicalRequest(f.requests[index])
    return {
      direction: 'out' as const,
      delivery: request.parts.delivery,
      context: request.parts.context,
      submissionIdentity: request.identity.submission_identity,
      timestampMs,
    }
  }
  const fund = async (wallet: EvmChainWalletHandle) => {
    for (const record of wallet.pool.ensureSize(2))
      mockBalances.set(record.address.toLowerCase(), 187_500n + 600n)
    await wallet.pool.flush()
  }

  it.each(["in", "out"] as const)(
    "keeps inert decoded text exact through fetch and stream (%s)",
    async (direction) => {
      await online("alice", f.alice);
      await online("bob", f.bob);
      // Seal only an ordinary control message. Synthetic decoded items are injected below;
      // no command-bearing envelope is created or sent, and the dispatcher is an inert spy.
      await f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: text("projection control"),
      });
      const texts = [
        "ordinary text",
        '{"note":"fixture"}',
        "[]",
        "{invalid JSON",
        '{"type":"digital-goods"}',
        '{"type":"wallet-sync"}',
        '[{"type":"payment-transfer"}]',
      ];
      const decoded = texts.map((value) =>
        parseFrame(directMessageText(value))
      );
      const originalIn = canonicalOpen.openDirectMessage;
      const originalOwn = canonicalOpen.openOwnDirectMessage;
      const inSpy = jest
        .spyOn(canonicalOpen, "openDirectMessage")
        .mockImplementation((params) => ({
          ...originalIn(params),
          items: decoded,
        }));
      const ownSpy = jest
        .spyOn(canonicalOpen, "openOwnDirectMessage")
        .mockImplementation((params) => ({
          ...originalOwn(params),
          items: decoded,
        }));
      const dispatch = jest
        .spyOn(syncDispatch, "applyWalletSyncItem")
        .mockResolvedValue({});
      const wallet = direction === "out" ? f.alice : f.bob;
      const record =
        direction === "out"
          ? outboundRecord(0, 10)
          : { ...inboxRecord(0, 10), direction: "in" as const };
      const before = wallet.pool.records().map((row) => ({ ...row }));
      let close: (() => void) | undefined;
      try {
        mailboxPage.mockResolvedValueOnce({ records: [record] });
        const fetched = await f.chain.directMessages.fetchSince({
          wallet,
          sinceMs: 0,
        });
        expect(fetched[0].items).toEqual(
          texts.map((text) => ({ type: "text", text }))
        );
        let streamed: unknown;
        mockStreamRecordHandler = undefined;
        close = f.chain.directMessages.subscribeMailboxStream!({
          wallet,
          onRecord: (value) => {
            streamed = value;
          },
        });
        for (let i = 0; i < 20 && !mockStreamRecordHandler; i++)
          await new Promise((resolve) => setImmediate(resolve));
        expect(mockStreamRecordHandler).toBeDefined();
        await mockStreamRecordHandler!(record);
        expect(streamed).toEqual(
          expect.objectContaining({
            items: texts.map((text) => ({ type: "text", text })),
          })
        );
        expect(dispatch).not.toHaveBeenCalled();
        expect(wallet.pool.records()).toEqual(before);
      } finally {
        close?.();
        inSpy.mockRestore();
        ownSpy.mockRestore();
        dispatch.mockRestore();
      }
    }
  );

  it.each(["wallet-sync", "payment-transfer"])(
    "rejects inert legacy decoded %s even with canonical service installed",
    async (type) => {
      await online("alice", f.alice);
      mailboxPage.mockResolvedValueOnce({ records: [] });
      const decode = jest
        .spyOn(legacyEnvelope, "decryptEnvelope")
        .mockReturnValue(JSON.stringify([{ type }]));
      const parse = jest
        .spyOn(legacyEnvelope, "parseEnvelope")
        .mockReturnValue({
          v: 1,
          networkTag: "MONT",
          from: f.bob.identity.address.raw,
          to: f.alice.identity.address.raw,
          salt: "",
          ciphertext: "",
        });
      const feed = jest
        .spyOn(legacyFeed, "fetchMonadMessagesSince")
        .mockResolvedValue([
          {
            timestamp: 20,
            networkTag: new Uint8Array(),
            message: {
              encryptedPayload: new Uint8Array(),
              payloadHash: new Uint8Array(32).fill(9),
              stampPayments: [],
            },
          },
        ]);
      const profile = jest
        .spyOn(legacyProfile, "fetchMonadProfile")
        .mockResolvedValue({
          address: f.bob.identity.address.raw,
          pubKey: f.bob.identity.compressedPubKey,
        } as Awaited<ReturnType<typeof legacyProfile.fetchMonadProfile>>);
      const recovery = jest
        .spyOn(legacyStamp, "recoverMonadStampPayments")
        .mockReturnValue([]);
      const dispatch = jest
        .spyOn(syncDispatch, "applyWalletSyncItem")
        .mockResolvedValue({});
      const before = f.alice.stampPaymentJournal?.getAll();
      try {
        await expect(
          f.chain.directMessages.fetchSince({ wallet: f.alice, sinceMs: 0 })
        ).rejects.toMatchObject({ code: "unsupported_incoming_wallet_sync" });
        expect(recovery).not.toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
        expect(f.alice.stampPaymentJournal?.getAll()).toEqual(before);
      } finally {
        for (const spy of [decode, parse, feed, profile, recovery, dispatch])
          spy.mockRestore();
      }
    }
  );

  it('message each other in both directions knowing only an address', async () => {
    await online('alice', f.alice)
    await online('bob', f.bob)
    await fund(f.bob)
    // Each account published exactly one self-signed entry; nobody installed anything.
    expect([...relay.subjects()].sort()).toEqual(
      [f.alice, f.bob].map(w => toHex(w.identity.compressedPubKey)).sort(),
    )
    await f.chain.directMessages.send({
      wallet: f.alice,
      recipient: f.bob.identity.address,
      items: text('hello bob'),
    })
    inboxPage.mockResolvedValue({ records: [inboxRecord(0, 7)] })
    // Bob has never looked Alice up: her entry is fetched and verified from the sending key.
    const atBob = await f.chain.directMessages.fetchSince({
      wallet: f.bob,
      sinceMs: 0,
    })
    expect(atBob).toHaveLength(1)
    expect(atBob[0].items).toEqual(text('hello bob'))
    expect(atBob[0].senderAddress.raw.toLowerCase()).toBe(
      f.alice.identity.address.raw.toLowerCase(),
    )
    await f.chain.directMessages.send({
      wallet: f.bob,
      recipient: atBob[0].senderAddress,
      items: text('hello alice'),
    })
    inboxPage.mockResolvedValue({ records: [inboxRecord(1, 9)] })
    const atAlice = await f.chain.directMessages.fetchSince({
      wallet: f.alice,
      sinceMs: 0,
    })
    expect(atAlice.map(m => m.items)).toEqual([text('hello alice')])
    expect(atAlice[0].senderAddress.raw.toLowerCase()).toBe(
      f.bob.identity.address.raw.toLowerCase(),
    )
  })

  it('bounces sent messages back to sender mailbox and decrypts own message via salt', async () => {
    await online('alice', f.alice)
    await online('bob', f.bob)
    await fund(f.alice)

    // Alice sends to Bob
    await f.chain.directMessages.send({
      wallet: f.alice,
      recipient: f.bob.identity.address,
      items: text('hello bob from alice'),
    })

    // Outbound message is echoed back to Alice's mailbox with direction: 'out'
    mailboxPage.mockResolvedValueOnce({ records: [outboundRecord(0, 10)] })
    const atAlice = await f.chain.directMessages.fetchSince({
      wallet: f.alice,
      sinceMs: 0,
    })
    expect(atAlice).toHaveLength(1)
    expect(atAlice[0].outbound).toBe(true)
    expect(atAlice[0].items).toEqual(text('hello bob from alice'))
    expect(atAlice[0].senderAddress.raw.toLowerCase()).toBe(
      f.alice.identity.address.raw.toLowerCase(),
    )
    expect(atAlice[0].recipientAddress.raw.toLowerCase()).toBe(
      f.bob.identity.address.raw.toLowerCase(),
    )
    expect(toHex(atAlice[0].senderPublicKey)).toBe(
      toHex(f.alice.identity.compressedPubKey),
    )
    expect(toHex(atAlice[0].recipientPublicKey)).toBe(
      toHex(f.bob.identity.compressedPubKey),
    )

    // Stream receives outbound record via WebSocket mailbox stream
    let streamedRecord: any
    const unsub = f.chain.directMessages.subscribeMailboxStream!({
      wallet: f.alice,
      onRecord: record => {
        streamedRecord = record
      },
    })
    // Give async connect time to resolve
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(mockStreamRecordHandler).toBeDefined()
    await mockStreamRecordHandler!(outboundRecord(0, 11))
    expect(streamedRecord).toBeDefined()
    expect(streamedRecord.outbound).toBe(true)
    expect(streamedRecord.items).toEqual(text('hello bob from alice'))
    expect(streamedRecord.senderAddress.raw.toLowerCase()).toBe(
      f.alice.identity.address.raw.toLowerCase(),
    )
    expect(streamedRecord.recipientAddress.raw.toLowerCase()).toBe(
      f.bob.identity.address.raw.toLowerCase(),
    )
    unsub()
  })

  it('decrypts own outbound message and recipient inbox message across directory statement rotation', async () => {
    const aliceDir = await online('alice', f.alice)
    const bobDir = await online('bob', f.bob)
    await fund(f.alice)

    // Alice sends to Bob when both are on revision 0
    await f.chain.directMessages.send({
      wallet: f.alice,
      recipient: f.bob.identity.address,
      items: text('pre-rotation message'),
    })

    // Advance clock into renewal window (345 days)
    clock += 345n * 24n * 3600n * SECOND

    // Bob rotates directory statement to revision 1
    const bobRenewed = await bobDir.publish()
    expect(bobRenewed.current.revision).toBe(1n)

    // Alice fetches her mailbox: Bob's statement has rotated, so Alice resolves Bob's
    // revision 0 statement via peerHistorical and decrypts her own outbound message
    mailboxPage.mockResolvedValueOnce({ records: [outboundRecord(0, 20)] })
    const atAliceOwn = await f.chain.directMessages.fetchSince({
      wallet: f.alice,
      sinceMs: 0,
    })
    expect(atAliceOwn).toHaveLength(1)
    expect(atAliceOwn[0].outbound).toBe(true)
    expect(atAliceOwn[0].items).toEqual(text('pre-rotation message'))

    // Bob fetches his inbox: Bob's own statement has rotated, so Bob resolves his
    // revision 0 statement via peerHistorical and decrypts Alice's incoming message
    mailboxPage.mockResolvedValueOnce({ records: [inboxRecord(0, 20)] })
    const atBob = await f.chain.directMessages.fetchSince({
      wallet: f.bob,
      sinceMs: 0,
    })
    expect(atBob).toHaveLength(1)
    expect(atBob[0].outbound).toBe(false)
    expect(atBob[0].items).toEqual(text('pre-rotation message'))

    // Alice also rotates her directory statement to revision 1
    const aliceRenewed = await aliceDir.publish()
    expect(aliceRenewed.current.revision).toBe(1n)

    // Now BOTH Alice and Bob have rotated. Alice fetches her mailbox again:
    // Alice resolves BOTH Alice and Bob revision 0 statements and decrypts
    mailboxPage.mockResolvedValueOnce({ records: [outboundRecord(0, 25)] })
    const atAliceBothRotated = await f.chain.directMessages.fetchSince({
      wallet: f.alice,
      sinceMs: 0,
    })
    expect(atAliceBothRotated).toHaveLength(1)
    expect(atAliceBothRotated[0].outbound).toBe(true)
    expect(atAliceBothRotated[0].items).toEqual(text('pre-rotation message'))
  })

  it('gives a typed "not published" error for an unknown address and pays nothing', async () => {
    await online('alice', f.alice)
    const stranger = testAccount(40)
    const failure = await f.chain.directMessages
      .send({
        wallet: f.alice,
        recipient: { raw: stranger.address },
        items: text('anyone there?'),
      })
      .catch(error => error)
    expect(failure).toBeInstanceOf(CanonicalRecipientNotPublishedError)
    expect(failure.address).toBe(stranger.address)
    expect(f.requests).toHaveLength(0)
    expect(mockFunded).toHaveLength(0)
    expect(f.alice.pool.records().map(r => r.status)).toEqual([
      'available',
      'available',
    ])
    expect(
      await f.chain.directMessages.unattributedAttempts({
        wallet: f.alice,
        knownDigests: [],
      }),
    ).toEqual([])
  })

  it('refuses a forged entry for the recipient and pays nothing', async () => {
    await online('alice', f.alice)
    const bobSubject = toHex(f.bob.identity.compressedPubKey)
    const bobAddress = f.bob.identity.address.raw.toLowerCase()
    const mallory = testAccount(41)
    const validity = {
      network: 'monad-testnet',
      revision: 0n,
      predecessor: null,
      issuedAt: { seconds: CLOCK / SECOND - 60n, nanoseconds: 0 },
      expiresAt: { seconds: CLOCK / SECOND + 86_400n, nanoseconds: 0 },
      relay: relay.binding,
    }
    // Mallory's own valid entry served for Bob's address, then one naming Bob's key signed by her.
    for (const forged of [
      mallory.sign(validity),
      mallory.sign({ ...validity, claimSubject: bobSubject }),
    ]) {
      relay.tamper = path =>
        path.endsWith(`/address/${bobAddress}`) ? forged : undefined
      const failure = await f.chain.directMessages
        .send({
          wallet: f.alice,
          recipient: f.bob.identity.address,
          items: text('for bob only'),
        })
        .catch(error => error)
      expect(failure).toBeInstanceOf(OpenDirectoryError)
      expect(failure.code).toBe('invalid')
    }
    expect(f.requests).toHaveLength(0)
    expect(mockFunded).toHaveLength(0)
  })

  it('refuses a rolled back recipient entry after first contact and pays nothing', async () => {
    const aliceDirectory = await online('alice', f.alice)
    const bobDirectory = open('bob', f.bob)
    await bobDirectory.publish()
    installCanonicalDirectory(f.bob, { ...bobDirectory, fetch: f.fetch })
    const bobSubject = toHex(f.bob.identity.compressedPubKey)
    const revisionZero = relay.chain(bobSubject)[0]
    // Bob renews: his chain is now two revisions long, and Alice accepts the newer one.
    const head = await bobDirectory.selfCurrent()
    relay.replicate([
      prepareMonadNextRevisionExport(f.bob, {
        networkTag: 'MONT',
        network: 'monad-testnet',
        chainId: 10143n,
        issuedAt: { seconds: CLOCK / SECOND - 30n, nanoseconds: 0 },
        expiresAt: { seconds: CLOCK / SECOND + 86_400n, nanoseconds: 0 },
        now: { seconds: CLOCK / SECOND, nanoseconds: 0 },
        relay: relay.binding,
        revision: 1n,
        predecessor: head.evidence.hash,
      }).attestation,
    ])
    expect(
      (await aliceDirectory.lookup(f.bob.identity.address.raw)).current
        .revision,
    ).toBe(1n)
    relay.tamper = path =>
      path.endsWith(`/${bobSubject}/head`) ? revisionZero : undefined
    const later = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    try {
      const failure = await f.chain.directMessages
        .send({
          wallet: f.alice,
          recipient: f.bob.identity.address,
          items: text('to the old key?'),
        })
        .catch(error => error)
      expect(failure).toBeInstanceOf(OpenDirectoryError)
      expect(failure.code).toBe('rollback')
      expect(f.requests).toHaveLength(0)
      expect(mockFunded).toHaveLength(0)
    } finally {
      later.mockRestore()
    }
  })

  it('does not show a message whose sender entry is forged', async () => {
    await online('alice', f.alice)
    await online('bob', f.bob)
    await f.chain.directMessages.send({
      wallet: f.alice,
      recipient: f.bob.identity.address,
      items: text('really from alice'),
    })
    const aliceSubject = toHex(f.alice.identity.compressedPubKey)
    const forged = testAccount(42).sign({
      network: 'monad-testnet',
      revision: 0n,
      predecessor: null,
      issuedAt: { seconds: CLOCK / SECOND - 60n, nanoseconds: 0 },
      expiresAt: { seconds: CLOCK / SECOND + 86_400n, nanoseconds: 0 },
      relay: relay.binding,
      claimSubject: aliceSubject,
    })
    relay.tamper = path =>
      path.endsWith(`/${aliceSubject}/head`) ? forged : undefined
    inboxPage.mockResolvedValue({ records: [inboxRecord(0, 7)] })
    const quarantined: number[] = []
    expect(
      await f.chain.directMessages.fetchSince({
        wallet: f.bob,
        sinceMs: 0,
        onQuarantinedTimestamp: time => void quarantined.push(time),
      }),
    ).toEqual([])
    expect(quarantined).toEqual([7])
  })

  it('keeps delivering other senders when one sender cannot be checked, and retries that one', async () => {
    await online('alice', f.alice)
    const bobDirectory = await online('bob', f.bob)
    await f.chain.directMessages.send({
      wallet: f.alice,
      recipient: f.bob.identity.address,
      items: text('first'),
    })
    mockBalances.set(
      (await f.alice.getReceiveAddress()).raw.toLowerCase(),
      10n ** 18n,
    )
    await f.chain.directMessages.send({
      wallet: f.alice,
      recipient: f.bob.identity.address,
      items: text('second'),
    })
    // The first message stands in for a sender whose entry cannot be read right now: only the
    // first directory lookup of each read fails.
    const stuck = inboxRecord(0, 5),
      good = inboxRecord(1, 9)
    inboxPage.mockResolvedValue({ records: [stuck, good] })
    const real = bobDirectory.peerCurrent
    let lookups = 0
    const failing = (code: string) => {
      lookups = 0
      installCanonicalDirectory(f.bob, {
        ...bobDirectory,
        fetch: f.fetch,
        peerCurrent: async wanted => {
          if (lookups++ === 0) throw new OpenDirectoryError(code as never)
          return real(wanted)
        },
      })
    }
    for (const code of ['unreachable', 'storage', 'expired', 'rollback']) {
      failing(code)
      const incomplete: number[] = [],
        quarantined: number[] = []
      const received = await f.chain.directMessages.fetchSince({
        wallet: f.bob,
        sinceMs: 0,
        onIncompleteTimestamp: time => void incomplete.push(time),
        onQuarantinedTimestamp: time => void quarantined.push(time),
      })
      // The read did not fail; the good sender's message arrived; the other is kept for later.
      expect(received.map(m => m.receivedTime)).toEqual([9])
      expect(incomplete).toEqual([5])
      expect(quarantined).toEqual([])
    }
    // After a day of failing, it is given up on so it cannot hold the inbox scan forever.
    const later = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 25 * 60 * 60_000)
    try {
      failing('unreachable')
      const incomplete: number[] = [],
        quarantined: number[] = []
      await f.chain.directMessages.fetchSince({
        wallet: f.bob,
        sinceMs: 0,
        onIncompleteTimestamp: time => void incomplete.push(time),
        onQuarantinedTimestamp: time => void quarantined.push(time),
      })
      expect(incomplete).toEqual([])
      expect(quarantined).toEqual([5])
    } finally {
      later.mockRestore()
    }
  })

  describe('a recipient that lives on another relay', () => {
    let other: ReturnType<typeof createFakeRelay>
    beforeEach(async () => {
      other = createFakeRelay({
        endpoint: 'https://relay-b.example',
        relayId: '0b'.repeat(16),
      })
      relay.peers.push(other)
      await open('bob', f.bob, other).publish()
    })

    it('is refused before funding or intent while the relay does not say it forwards', async () => {
      await online('alice', f.alice)
      const failure = await f.chain.directMessages
        .send({
          wallet: f.alice,
          recipient: f.bob.identity.address,
          items: text('across relays'),
        })
        .catch(error => error)
      expect(failure).toBeInstanceOf(CanonicalRelayCannotForwardError)
      expect(failure.recipientRelay).toBe('https://relay-b.example')
      expect(failure.message).toContain('cannot deliver')
      expect(f.requests).toHaveLength(0)
      expect(mockFunded).toHaveLength(0)
      expect(f.alice.pool.records().map(r => r.status)).toEqual([
        'available',
        'available',
      ])
      expect(
        await f.chain.directMessages.unattributedAttempts({
          wallet: f.alice,
          knownDigests: [],
        }),
      ).toEqual([])
    })

    it('is sent through the own relay once that relay says it forwards', async () => {
      relay.infoOverride = { forwarding: true }
      await online('alice', f.alice)
      await f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: text('across relays'),
      })
      // Submitted to Alice's own relay, sealed to the key in Bob's entry on the other relay.
      expect(f.requests).toHaveLength(1)
    })

    it('retains a rejected cross-relay attempt, its accounts still reserved', async () => {
      relay.infoOverride = { forwarding: true }
      await online('alice', f.alice)
      f.setPhase('undeliverable')
      let digest = ''
      await expect(f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: text('relay cannot deliver'),
        onAttemptCreated: value => void (digest = value),
        // #1323: the send reports the relay's final answer; the accounts stay reserved.
      })).rejects.toBeInstanceOf(CanonicalRecipientUndeliverableError)
      expect(f.alice.pool.records().map(r => r.status)).toContain('in-use')
      expect(await f.chain.directMessages.unattributedAttempts({
        wallet: f.alice, knownDigests: [],
      })).toEqual([digest])
      expect(f.requests).toHaveLength(1)
    })
  })
})

/**
 * #1235 Stage R, at the canonical boundary: typed wallets, real journals, pool and admission. Two
 * stamp accounts are funded through the production on-demand path for a stamp that needs both, so
 * a send that may select the reserved one does. A native send then spends from the larger one, X,
 * because main cannot pay. `pending`: the broadcast reply is lost, so the member is signed and
 * exposed but unobserved. `included`: it is mined and observed only by a fee estimate. In both,
 * nothing has recorded X as spent.
 */
describe('a stamp account a native send spends from (#1235)', () => {
  const STAMP = 1_000_000n
  const blockHash = '0x' + '11'.repeat(32)
  let f: Awaited<ReturnType<typeof fixture>>
  let bundles: Array<{
    runLifetime: <T>(task: (lifetime: never) => Promise<T>) => Promise<T>
    inputAdmission: { inspect(lifetime: never): { status: string } }
  }>
  beforeEach(async () => {
    jest.clearAllMocks()
    mockBalances.clear()
    mockFunded.length = 0
    bundles = []
    const bundleModule = jest.requireActual(
      '../storage/monad-wallet-bundle',
    ) as typeof import('../storage/monad-wallet-bundle')
    const originalOpen = bundleModule.openExistingPoolMonadTopicOwner
    jest
      .spyOn(bundleModule, 'openExistingPoolMonadTopicOwner')
      .mockImplementation(async params => {
        const bundle = await originalOpen(params)
        bundles.push(bundle as never)
        return bundle
      })
    f = await fixture(false)
  })
  afterEach(async () => {
    await f.close()
    jest.restoreAllMocks()
  })

  /** Alice's admission snapshot: the fixture opens Alice then Bob; a reopen of Alice is last. */
  const admission = () => {
    const bundle = bundles.length > 2 ? bundles[bundles.length - 1]! : bundles[0]!
    return bundle.runLifetime(lifetime =>
      Promise.resolve(bundle.inputAdmission.inspect(lifetime)),
    )
  }

  async function reserved(
    window: 'pending' | 'included',
    /** A node whose pending nonce shows the broadcast transaction although its reply was lost. */
    pendingVisible = false,
  ) {
    const main = (await f.alice.getReceiveAddress()).raw.toLowerCase()
    mockBalances.set(main, 10n ** 18n)
    const directory = await f.directoryFor('alice', f.alice, f.bob)
    installCanonicalDirectory(f.alice, directory)
    const peer = (await directory.peerCurrent({
      address: f.bob.identity.address.raw,
    }))!
    await prepareCanonicalStampInventory(f.alice, {
      stampValueWei: STAMP,
      recipientStampKey: peer.current.stampKey.keyBytes,
    })
    const funded = f.alice.pool
      .records()
      .filter(record => record.status === 'available')
    expect(funded).toHaveLength(2)
    const x = funded.reduce((a, b) =>
      mockBalances.get(a.address.toLowerCase())! >=
      mockBalances.get(b.address.toLowerCase())!
        ? a
        : b,
    )
    const xAddress = x.address.toLowerCase()
    const recipient = { raw: (await f.bob.getReceiveAddress()).raw }

    const mined = new Map<string, Transaction>()
    const lostButSeen = new Set<string>()
    const broadcasts: Transaction[] = []
    let replyLost = false
    /** The native RPC surface the offline provider lacks; state is shared across a reopen. */
    const installRpc = (wallet: EvmChainWalletHandle) => {
      jest
        .spyOn(wallet.provider, 'broadcastTransaction')
        .mockImplementation(async raw => {
          const tx = Transaction.from(raw)
          broadcasts.push(tx)
          const from = tx.from!.toLowerCase()
          if (replyLost) {
            if (pendingVisible) lostButSeen.add(from)
            throw new Error('Submission acknowledgment lost (test)')
          }
          mined.set(tx.hash!, tx)
          mockBalances.set(from, mockBalances.get(from)! - tx.value - 150_000n)
          return { hash: tx.hash! } as never
        })
      jest
        .spyOn(wallet.provider, 'getTransaction')
        .mockImplementation(async hash =>
          mined.has(hash)
            ? (Object.assign(Transaction.from(mined.get(hash)!.serialized), {
                blockHash,
                blockNumber: 1,
                index: 0,
              }) as never)
            : null,
        )
      jest
        .spyOn(wallet.provider, 'getTransactionReceipt')
        .mockImplementation(async hash =>
          mined.has(hash)
            ? ({
                hash,
                from: mined.get(hash)!.from,
                to: mined.get(hash)!.to,
                blockHash,
                blockNumber: 1,
                index: 0,
                status: 1,
                gasPrice: 3n,
                gasUsed: 50_000n,
              } as never)
            : null,
        )
      jest
        .spyOn(wallet.provider, 'getTransactionCount')
        .mockImplementation(async (address, tag) => {
          const from = String(address).toLowerCase()
          // Only natively broadcast transactions count; funding goes through the HTTP stand-in.
          return (
            [...mined.values()].filter(tx => tx.from!.toLowerCase() === from)
              .length + (tag === 'pending' && lostButSeen.has(from) ? 1 : 0)
          )
        })
    }
    installRpc(f.alice)

    mockBalances.set(main, 0n)
    replyLost = window === 'pending'
    const send = f.alice.sendNative({ recipient, value: 100n })
    if (window === 'pending') await expect(send).rejects.toThrow()
    else await send
    replyLost = false
    mockBalances.set(main, 10n ** 18n)
    if (window === 'included')
      await f.alice.estimateLegacyFee!({ recipient, value: 1n })
    const operation = f.alice.getNativeOperations!()[0]!
    const member = operation.members[0]!
    expect(member.source).toEqual({
      kind: 'spend',
      address: xAddress,
      index: x.index,
    })
    expect(member.exposed).toBe(true)
    expect(member.observation.state).toBe(
      window === 'pending' ? 'missing' : 'included-success',
    )
    expect(f.alice.pool.getRecord(x.index)!.status).toBe('available')
    expect(await admission()).toMatchObject({ status: 'ready' })
    mockFunded.length = 0
    const message = (wallet: EvmChainWalletHandle, words: string) =>
      f.chain.directMessages.send({
        wallet,
        recipient: f.bob.identity.address,
        items: text(words),
        stampValue: STAMP,
      })
    /** Senders of the payment transactions in the request at `index`. */
    const payers = (index: number) =>
      restoreCanonicalRequest(f.requests[index]).parts.transactions.map(raw =>
        Transaction.from('0x' + toHex(raw)).from!.toLowerCase(),
      )
    return {
      main,
      directory,
      peer,
      x,
      xAddress,
      recipient,
      operation,
      broadcasts,
      installRpc,
      message,
      payers,
    }
  }

  it.each(['pending', 'included'] as const)(
    '%s: a direct message that would need the reserved account is paid from other accounts, funding a fresh one',
    async window => {
      const r = await reserved(window)
      const sent = await r.message(f.alice, 'paid around the reserved account')
      expect(sent.stampPayments.reduce((n, p) => n + p.valueWei, 0n)).toBe(
        STAMP,
      )
      expect(f.requests).toHaveLength(1)
      expect(r.payers(0).length).toBeGreaterThan(0)
      expect(r.payers(0)).not.toContain(r.xAddress)
      // Inventory was topped up from main with a fresh account, never by funding the reserved one.
      expect(sent.preparationTxHashes.length).toBeGreaterThan(0)
      expect(mockFunded.length).toBe(sent.preparationTxHashes.length)
      expect(mockFunded.map(tx => tx.to)).not.toContain(r.xAddress)
      expect(f.alice.pool.getRecord(r.x.index)!.status).toBe('available')
      expect(f.alice.getNativeOperations!()).toEqual([r.operation])
      expect(await admission()).toMatchObject({ status: 'ready' })
    },
  )

  // The wallet-wide lock this stage removes. Preparation's reconciliation used to retire any
  // `available` account whose pending nonce the chain reports as used, with no checkpoint. For an
  // account a native member spends from, the admission then held the address for the pool against
  // the native claim: `conflicting-authorization` for every send, also after reopen.
  it.each(['pending', 'included'] as const)(
    '%s: inventory preparation leaves the reserved account alone, so admission stays ready and native and canonical sends still work, also after reopen',
    async window => {
      const r = await reserved(window, true)
      // The canonical send's own preparation, for a stamp the current inventory cannot cover.
      const funding = await prepareCanonicalStampInventory(f.alice, {
        stampValueWei: 4n * STAMP,
        recipientStampKey: r.peer.current.stampKey.keyBytes,
      })
      expect(funding.length).toBeGreaterThan(0)
      expect(mockFunded.map(tx => tx.to)).not.toContain(r.xAddress)
      expect(f.alice.pool.getRecord(r.x.index)).toEqual({
        index: r.x.index,
        address: r.x.address,
        status: 'available',
      })
      expect(await admission()).toMatchObject({ status: 'ready' })

      const sent = await r.message(f.alice, 'after preparation')
      expect(sent.stampPayments.reduce((n, p) => n + p.valueWei, 0n)).toBe(
        STAMP,
      )
      expect(r.payers(0)).not.toContain(r.xAddress)
      r.broadcasts.length = 0
      await f.alice.sendNative({ recipient: r.recipient, value: 1n })
      expect(r.broadcasts.map(tx => tx.from!.toLowerCase())).toEqual([r.main])
      expect(await admission()).toMatchObject({ status: 'ready' })

      await f.alice.close()
      f.alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
      installCanonicalDirectory(f.alice, r.directory)
      r.installRpc(f.alice)
      expect(bundles).toHaveLength(3)
      expect(await admission()).toMatchObject({ status: 'ready' })
      // Stage 1 of #1235 changed this assertion on purpose. It was `available` for both windows:
      // nothing recorded the spend. The native send from main above now ends with the local pass,
      // which records every member the journal has observed included, so in the `included` window
      // the account is `spent` with that member's own transaction. Pending: nothing to record.
      expect(f.alice.pool.getRecord(r.x.index)).toEqual(
        window === 'included'
          ? {
              index: r.x.index,
              address: r.x.address,
              status: 'spent',
              lifecycle: {
                spend: {
                  rawTx: r.operation.members[0]!.signed!.rawTransaction,
                  txHash: r.operation.members[0]!.signed!.transactionHash,
                  valueWei: Transaction.from(
                    r.operation.members[0]!.signed!.rawTransaction,
                  ).value.toString(),
                },
              },
            }
          : { index: r.x.index, address: r.x.address, status: 'available' },
      )
      expect(f.alice.pool.isSpendReserved(r.x.index)).toBe(true)
      const again = await r.message(f.alice, 'after reopen')
      expect(again.stampPayments.reduce((n, p) => n + p.valueWei, 0n)).toBe(
        STAMP,
      )
      expect(r.payers(1)).not.toContain(r.xAddress)
      r.broadcasts.length = 0
      await f.alice.sendNative({ recipient: r.recipient, value: 1n })
      expect(r.broadcasts.map(tx => tx.from!.toLowerCase())).toEqual([r.main])
      expect(await admission()).toMatchObject({ status: 'ready' })
    },
  )

  // Pins what the reservation relies on and does not replace: with selection bypassed, the
  // admission still refuses the signature. Pending: the native member holds the whole address.
  // Included: the canonical client signs nonce 0, the pair the native member already consumed.
  it.each(['pending', 'included'] as const)(
    '%s, pins: with the reservation bypassed, a direct message that needs the reserved account is refused before any signature and the wallet stays usable',
    async window => {
      const r = await reserved(window)
      const bypass = jest
        .spyOn(f.alice.pool, 'isSpendReserved')
        .mockReturnValue(false)
      const sign = jest.spyOn(Wallet.prototype, 'signTransaction')
      await expect(r.message(f.alice, 'forced onto X')).rejects.toThrow(
        'evm-input-admission:conflicting-authorization',
      )
      expect(sign).not.toHaveBeenCalled()
      expect(f.requests).toHaveLength(0)
      expect(mockFunded).toHaveLength(0)
      expect(f.alice.pool.getRecord(r.x.index)!.status).toBe('available')
      expect(await admission()).toMatchObject({ status: 'ready' })
      bypass.mockRestore()
      const sent = await r.message(f.alice, 'around X')
      expect(sent.stampPayments.reduce((n, p) => n + p.valueWei, 0n)).toBe(
        STAMP,
      )
      expect(r.payers(0)).not.toContain(r.xAddress)
    },
  )
})
