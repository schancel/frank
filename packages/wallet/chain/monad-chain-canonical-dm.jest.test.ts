import { DefaultStampUnavailableError } from '../oracle/stamp-policy'
import { ChainUnreachableError } from '../evm-block-watcher'
import { EvmStampPayer } from '../evm-stamp-payer'
import { fixedStampDefault } from '../oracle/stamp-policy.testutil'
import * as canonicalOpen from "@frank/cashweb/relay/canonical-dm";
import * as syncDispatch from "@frank/cashweb/sync-dispatcher";
import * as legacyEnvelope from "@frank/cashweb/relay/monad-message-envelope";
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
  Transaction,
  Wallet,
  computeAddress,
  getBytes,
} from 'ethers'
import {
  channelStateDigest,
  decodeDiceGamePayload,
  encodeDiceGamePayload,
  fromHex,
  parseFrame,
  recipientPayloadDigest,
  toHex,
  encodeFrame,
  type FrankValue,
} from '@frank/codec'
import { secp256k1 } from '@noble/curves/secp256k1'
import type { ChannelUpdateItem } from '@frank/cashweb/types/messages'
import {
  directMessageText,
  prepareDirectMessage,
} from '@frank/cashweb/relay/canonical-dm'
import {
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
import { EvmStampPayer, InsufficientStampFundsError } from '../evm-stamp-payer'
import {
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
  LevelOutgoingMessageStore,
  UnpaidDirectMessageNotDeliveredError,
  type UnpaidEnvelope,
  type StoredMessage,
} from './monad-canonical-dm'
import {
  isDirectMessageNotAttempted,
  type DirectMessageClient,
} from './active-chain'

// Offline chain state: only these single-use sender accounts hold funds.
const mockBalances = new Map<string, bigint>()
/** Payments in a block, hash -> sender: what the wallet reads back as "the chain shows it". */
const mockMined = new Map<string, string>()
/** Raw transactions the wallet's own provider was asked to broadcast, in order. */
const mockWalletBroadcasts: string[] = []
/** Puts a signed transfer in a block, once: moves its value and consumes its nonce. */
function mockMine(raw: string): string {
  const tx = Transaction.from(raw)
  if (mockMined.has(tx.hash!)) return tx.hash!
  const to = tx.to!.toLowerCase(),
    from = tx.from!.toLowerCase()
  if ([...mockMined.values()].filter(a => a === from).length > tx.nonce)
    throw new Error('nonce too low')
  mockBalances.set(to, (mockBalances.get(to) ?? 0n) + tx.value)
  mockBalances.set(from, (mockBalances.get(from) ?? 0n) - tx.value)
  mockMined.set(tx.hash!, from)
  return tx.hash!
}
function mockChainReset() {
  mockBalances.clear()
  mockMined.clear()
  mockWalletBroadcasts.length = 0
}
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
        if (request.method === 'broadcastTransaction') {
          const raw = (request as unknown as { signedTransaction: string })
            .signedTransaction
          mockWalletBroadcasts.push(raw)
          if (mockMined.has(ethers.Transaction.from(raw).hash))
            throw new Error('already known')
          return mockMine(raw)
        }
        if (request.method === 'getTransactionReceipt') {
          const hash = (request as unknown as { hash: string }).hash
          const from = mockMined.get(hash)
          if (from === undefined) return null
          return {
            transactionHash: hash,
            transactionIndex: '0x0',
            blockHash: '0x' + '11'.repeat(32),
            blockNumber: '0x1',
            from,
            to: '0x' + '00'.repeat(20),
            contractAddress: null,
            cumulativeGasUsed: '0x5208',
            gasUsed: '0x5208',
            effectiveGasPrice: '0x2',
            logs: [],
            logsBloom: '0x' + '00'.repeat(256),
            status: '0x1',
            type: '0x2',
          }
        }
        if (request.method === 'getBlockNumber') return 1
        // This node keeps no transaction bodies: one it has not mined it does not know.
        if (request.method === 'getTransaction') return null
        if (request.method === 'getTransactionCount') {
          const address = request.address!.toLowerCase()
          return [...mockMined.values()].filter(a => a === address).length
        }
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
  type MailboxChallenge,
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
    resolveDefaultStamp: fixedStampDefault(1_000n),
    defaultTopicVoteValueWei: 1_000n,
    subAccountPoolSize: 0,
    // The stub node never mines on its own: a native send looks once and returns.
    nativeInclusionWaitMs: 0,
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
      mockMine('0x' + toHex(raw))
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
    config,
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
/** What the offline chain charges to move one payment: 21,000 gas at its gas price of 2 wei. A
 * stamp is never smaller, so the configured default of 1,000 wei is raised to it. */
const DEFAULT_STAMP = 21_000n * 2n

type ServedRecord = {
  delivery: Uint8Array
  context: Uint8Array
  submissionIdentity: string
  timestampMs: number
  direction?: 'in' | 'out'
}
/** The relay's authenticated mailbox and inbox reads over `records`, framed as the relay frames
 * them, so the production challenge, signing and bounded page reader run. `cut` drops bytes off
 * the end of every page: a page that fails as a whole. */
function relayMailbox(
  records: readonly ServedRecord[],
  cut = 0,
): CanonicalFetch & { reads: string[] } {
  const reads: string[] = []
  const serve: CanonicalFetch = async (url, input) => {
    let bytes: Uint8Array
    let media: string
    const query = new URL(url).searchParams
    if (url.includes('/auth/')) {
      expect(input.method).toBe('POST')
      bytes = Buffer.from(
        JSON.stringify({
          epoch: '11'.repeat(32),
          nonce: '22'.repeat(32),
          token: '33'.repeat(32),
          expires_at_ms: Date.now() + 59_000,
          signing_domain: MAILBOX_AUTH_DOMAIN,
          resource: query.get('resource'),
          since: Number(query.get('since')),
          cursor: query.get('cursor'),
          limit: Number(query.get('limit')),
          max_bytes: Number(query.get('max_bytes')),
          network_tag: '4d4f4e54',
        } satisfies MailboxChallenge),
      )
      media = 'application/json'
    } else {
      expect(input.method).toBe('GET')
      reads.push(url)
      const combined = new URL(url).pathname.startsWith('/message/mailbox/')
      const line = (value: string) => Buffer.from(value)
      const page = Buffer.concat([
        ...records
          .filter(record => record.timestampMs >= Number(query.get('since')))
          .flatMap(record => [
            line(
              `--page\r\nContent-Disposition: inline; name="record"\r\nContent-Type: multipart/mixed; boundary=record\r\nX-Frank-Submission-Identity: ${
                record.submissionIdentity
              }\r\nX-Frank-Mailbox-Timestamp-Ms: ${record.timestampMs}\r\n${
                combined
                  ? `X-Frank-Mailbox-Direction: ${record.direction ?? 'in'}\r\n`
                  : ''
              }\r\n`,
            ),
            line(
              '--record\r\nContent-Disposition: inline; name="delivery"\r\nContent-Type: application/vnd.frank.cbor\r\n\r\n',
            ),
            record.delivery,
            line(
              '\r\n--record\r\nContent-Disposition: inline; name="context"\r\nContent-Type: application/cbor\r\n\r\n',
            ),
            record.context,
            line('\r\n--record--\r\n\r\n'),
          ]),
        line('--page--\r\n'),
      ])
      bytes = page.subarray(0, page.length - cut)
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
  return Object.assign(serve, { reads })
}
/** Both page readers as production runs them, for one test. */
function productionPageReaders() {
  const actual = jest.requireActual<
    typeof import('@frank/cashweb/relay/monad-mailbox-client')
  >('@frank/cashweb/relay/monad-mailbox-client')
  mailboxPage.mockReset().mockImplementation(actual.fetchCanonicalMailboxPage)
  inboxPage.mockReset().mockImplementation(actual.fetchCanonicalInboxPage)
  return () => {
    mailboxPage.mockReset().mockImplementation(actual.fetchCanonicalMailboxPage)
    inboxPage.mockReset()
  }
}

describe('typed wallet direct messages use the canonical path (#778)', () => {
  jest.setTimeout(30_000)
  let f: Awaited<ReturnType<typeof fixture>>
  let openMessages: jest.SpyInstance
  beforeEach(async () => {
    jest.clearAllMocks()
    mockChainReset()
    mockFunded.length = 0
    openMessages = jest.spyOn(LevelOutgoingMessageStore, 'open')
    f = await fixture(!expect.getState().currentTestName!.includes('unfunded'))
  })
  afterEach(() => f.close())
  /** The open wallet's sent-message rows, as its own store holds them. */
  async function rowsOf(wallet: EvmChainWalletHandle): Promise<StoredMessage[]> {
    const address = (await wallet.getReceiveAddress()).raw.toLowerCase()
    const index = openMessages.mock.calls
      .map(call => String(call[0]).endsWith(`-evm-${address}`))
      .lastIndexOf(true)
    const store: LevelOutgoingMessageStore = await openMessages.mock.results[
      index
    ].value
    return store.all()
  }
  /** Pool accounts an operation holds right now. */
  const claimedIndices = (wallet: EvmChainWalletHandle) =>
    wallet.pool
      .records()
      .map(record => record.index)
      .filter(index => wallet.pool.claimedBy(index) !== undefined)
  const paymentStates = (wallet: EvmChainWalletHandle, payloadDigest: string) =>
    f.chain.directMessages.paymentsOf!({ wallet, payloadDigest })

  it('shares the host quote with new implicit sends, while free and explicit sends need no oracle', async () => {
    installCanonicalDirectory(f.alice, await f.directoryFor('alice', f.alice, f.bob))
    const resolver = jest.fn(fixedStampDefault(50_000n))
    f.config.resolveDefaultStamp = resolver
    expect(await f.chain.directMessages.defaultStampQuote!({ wallet: f.alice })).toMatchObject({ status: 'available', amount: 50_000n, minimumStamp: DEFAULT_STAMP })
    const sent = await f.chain.directMessages.send({ wallet: f.alice, recipient: f.bob.identity.address, items: text('quoted default') })
    expect(sent.stampValueWei).toBe(50_000n)
    expect(resolver).toHaveBeenLastCalledWith({ chainIdentifier: 'monad-testnet', minimumStamp: DEFAULT_STAMP })
    const offline = jest.fn(async () => ({ status: 'unavailable' as const, chainIdentifier: 'monad-testnet', reason: 'missing-rate' as const }))
    f.config.resolveDefaultStamp = offline
    const claims = structuredClone(f.alice.pool.records())
    await expect(f.chain.directMessages.send({ wallet: f.alice, recipient: f.bob.identity.address, items: text('no quote') })).rejects.toBeInstanceOf(DefaultStampUnavailableError)
    expect(f.alice.pool.records()).toEqual(claims)
    expect(f.requests).toHaveLength(1)
    offline.mockClear()
    await f.chain.directMessages.send({ wallet: f.alice, recipient: f.bob.identity.address, items: text('free'), stampValue: 0n })
    await f.chain.directMessages.send({ wallet: f.alice, recipient: f.bob.identity.address, items: text('explicit'), stampValue: DEFAULT_STAMP })
    expect(offline).not.toHaveBeenCalled()
  })

  it('reports unavailable fees for a new implicit default before claiming or signing', async () => {
    installCanonicalDirectory(f.alice, await f.directoryFor('alice', f.alice, f.bob))
    const floor = jest.spyOn(EvmStampPayer.prototype, 'minimumPaymentWei').mockRejectedValue(new ChainUnreachableError(new Error('offline')))
    const claim = jest.spyOn(EvmStampPayer.prototype, 'claim')
    const sign = jest.spyOn(EvmStampPayer.prototype, 'sign')
    try {
      expect(await f.chain.directMessages.defaultStampQuote!({ wallet: f.alice })).toMatchObject({ status: 'unavailable', reason: 'missing-fee' })
      await expect(f.chain.directMessages.send({ wallet: f.alice, recipient: f.bob.identity.address, items: text('no fee') })).rejects.toMatchObject({ quote: { reason: 'missing-fee' } })
      expect(claim).not.toHaveBeenCalled()
      expect(sign).not.toHaveBeenCalled()
      expect(f.requests).toHaveLength(0)
    } finally { floor.mockRestore(); claim.mockRestore(); sign.mockRestore() }
  })

  it('reopens an existing attempt and reconciles it with the default oracle offline', async () => {
    const directory = await f.directoryFor('alice', f.alice, f.bob)
    installCanonicalDirectory(f.alice, directory)
    f.setPhase('retained')
    const messageId = '00000000-0000-4000-8000-0000000000fa'
    let digest = ''
    await expect(f.chain.directMessages.send({ wallet: f.alice, recipient: f.bob.identity.address, items: text('original'), messageId,
      onAttemptCreated: value => { digest = value } })).rejects.toBeInstanceOf(MonadStampPendingAttemptError)
    await f.alice.close()
    const offline = jest.fn(async () => { throw new Error('oracle offline') })
    f.config.resolveDefaultStamp = offline
    f.alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    installCanonicalDirectory(f.alice, directory)
    await expect(f.chain.directMessages.send({ wallet: f.alice, recipient: f.bob.identity.address, items: text('original'), messageId }))
      .rejects.toMatchObject({ payloadDigest: digest })
    f.setPhase('delivered')
    expect(await f.chain.directMessages.reconcileAttempts({ wallet: f.alice, payloadDigests: [digest] })).toEqual({ [digest]: 'delivered' })
    expect(offline).not.toHaveBeenCalled()
  })

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
    expect(sent.stampValueWei).toBe(DEFAULT_STAMP)
    expect(sent.stampPayments.reduce((n, p) => n + p.valueWei, 0n)).toBe(
      DEFAULT_STAMP,
    )
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
    expect(received[0].stampValueWei).toBe(DEFAULT_STAMP)
    expect(received[0].stampPayments).toHaveLength(1)
    expect(received[0].stampPayments[0].valueWei).toBe(DEFAULT_STAMP)
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
        amountWei: '50000',
        memo: 'stealth transfer',
      },
    ])
    // The one-time account is a coin of bob's wallet. The sender's figure is only a claim: the
    // coin is pending and counts for nothing until the chain shows money there.
    const all = f.bob.getReceivedPayments!()
    const coins = all.filter(coin => coin.origin === 'stealth')
    expect(coins).toHaveLength(1)
    expect(coins[0]).toMatchObject({
      origin: 'stealth',
      status: 'pending',
      amountWei: 0n,
      claimedAmountWei: 50_000n,
      spendable: false,
      payloadDigest: sent.payloadDigest,
    })
    // The message's stamp is a coin too, as unverified as the stealth claim.
    expect(all.filter(coin => coin.origin === 'stamp')).toEqual([
      expect.objectContaining({
        status: 'pending',
        // The stamp the message carried: the default, raised to the chain's fee floor.
        claimedAmountWei: sent.stampValueWei,
        spendable: false,
        payloadDigest: sent.payloadDigest,
        childIndex: 0,
      }),
    ])
    // Reading the same message again changes nothing.
    await f.chain.directMessages.fetchSince({ wallet: f.bob, sinceMs: 0 })
    expect(
      f.bob.getReceivedPayments!().map(coin => coin.address).sort(),
    ).toEqual(all.map(coin => coin.address).sort())
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
      const prepare = jest.spyOn(EvmStampPayer.prototype, "claim");
      const finish = jest.spyOn(EvmStampPayer.prototype, "sign");
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
    const sign = jest.spyOn(EvmStampPayer.prototype, 'sign')
    f.setPhase('lost')
    let digest = ''
    const pending = await f.chain.directMessages
      .send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: text('once'),
        onAttemptCreated: created => void (digest = created),
      })
      .catch((error: unknown) => error)
    expect(pending).toBeInstanceOf(MonadStampPendingAttemptError)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    // The error is about this message only.
    expect((pending as MonadStampPendingAttemptError).payloadHashes).toEqual([
      digest,
    ])
    expect(f.requests).toHaveLength(1)
    // No answer from the relay: this wallet broadcast nothing, and the account stays held.
    expect(mockWalletBroadcasts).toHaveLength(0)
    expect(paymentStates(f.alice, digest)).toEqual(['pending'])
    const [held] = claimedIndices(f.alice)
    expect(held).toBeDefined()
    // A second Send while the first is unresolved is its own message: it is not refused for the
    // first one's sake, pays from another account, and does not re-send the first.
    f.setPhase('delivered')
    const second = await f.chain.directMessages.send({
      wallet: f.alice,
      recipient: f.bob.identity.address,
      items: text('twice'),
    })
    expect(second.payloadDigest).not.toBe(digest)
    expect(
      f.requests.map(r => restoreCanonicalRequest(r).identity.payload_hash),
    ).toEqual([digest, second.payloadDigest])
    const payer = (index: number) =>
      restoreCanonicalRequest(f.requests[index]).parts.transactions.map(raw =>
        Transaction.from('0x' + toHex(raw)).from!.toLowerCase(),
      )
    expect(payer(1)).not.toEqual(payer(0))
    expect(
      await f.chain.directMessages.unattributedAttempts({
        wallet: f.alice,
        knownDigests: [second.payloadDigest],
      }),
    ).toEqual([digest])
    expect(
      await f.chain.directMessages.reconcileAttempts({
        wallet: f.alice,
        payloadDigests: [digest],
      }),
    ).toEqual({ [digest]: 'delivered' })
    // One payment set per message, signed once each; the first went out twice, the same bytes.
    expect(sign).toHaveBeenCalledTimes(2)
    const firstBodies = f.requests
      .filter(r => restoreCanonicalRequest(r).identity.payload_hash === digest)
      .map(r => toHex(r.body))
    expect(firstBodies).toHaveLength(2)
    expect(new Set(firstBodies).size).toBe(1)
    expect(f.requests).toHaveLength(3)
    sign.mockRestore()
  })

  // The app stopped after the wallet saved its record of the send but before the chat message recorded the
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

  // The wallet's own stored row proves that the exact request, the signed payments and the
  // accounts they hold survive. A stamp of 400,000 wei needs both funded accounts.
  async function exposedAttempt() {
    for (const record of f.alice.pool.records())
      mockBalances.set(record.address.toLowerCase(), 187_500n + 200_000n)
    const directory = await f.directoryFor('alice', f.alice, f.bob)
    installCanonicalDirectory(f.alice, directory)
    f.setPhase('lost')
    const sign = jest.spyOn(EvmStampPayer.prototype, 'sign')
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
      expect(sign).toHaveBeenCalledTimes(1)
    } finally {
      sign.mockRestore()
    }
    const stored = await rowsOf(f.alice)
    expect(stored).toHaveLength(1)
    const row = structuredClone(stored[0])
    expect(row.digest).toBe(digest)
    expect(row.outcome).toBeUndefined()
    expect(row.payments.map(payment => payment.state)).toEqual([
      'pending',
      'pending',
    ])
    // What the relay was handed is exactly what is stored.
    expect(row.request).toEqual({
      body: toHex(f.requests[0].body),
      contentType: f.requests[0].contentType,
    })
    expect(
      restoreCanonicalRequest(f.requests[0]).parts.transactions.map(
        raw => '0x' + toHex(raw),
      ),
    ).toEqual(row.payments.map(payment => payment.rawTx))
    return { directory, digest, row }
  }

  /** The stored message still holds the original signed payments, byte for byte (and the exact
   * request for as long as the relay has not answered for it), and every payment the chain has
   * not shown still holds its account: nothing else can select it. */
  async function retainedAttempt(
    wallet: EvmChainWalletHandle,
    original: StoredMessage,
  ) {
    const found = (await rowsOf(wallet)).find(
      row => row.digest === original.digest,
    )
    if (!found) throw new Error('expected the stored message')
    expect(found.consumerId).toBe(original.consumerId)
    expect(found.recipientSubject).toBe(original.recipientSubject)
    expect(
      found.payments.map(({ index, address, rawTx }) => [index, address, rawTx]),
    ).toEqual(
      original.payments.map(({ index, address, rawTx }) => [
        index,
        address,
        rawTx,
      ]),
    )
    if (found.outcome === undefined)
      expect(found.request).toEqual(original.request)
    else expect(found.request).toBeUndefined()
    for (const payment of found.payments) {
      const record = wallet.pool.getRecord(payment.index)!
      if (payment.state === 'pending') {
        expect(wallet.pool.claimedBy(payment.index)).toBeDefined()
        expect(wallet.pool.isSpendReserved(payment.index)).toBe(true)
        expect(record.status).toBe('available')
      } else {
        expect(payment.state).toBe('spent')
        expect(wallet.pool.claimedBy(payment.index)).toBeUndefined()
        expect(record.status).toBe('spent')
      }
    }
    return found
  }

  // A 400 answer is no longer in this table: the relay refuses such a request before it stores
  // or broadcasts anything, so the message is failed and its coins are freed (see
  // monad-parallel-send.jest.test.ts).
  it.each(['lost'] as const)(
    'retains exact payments after %s responses, exhaustion, discard, partial broadcast and restart',
    async response => {
      const { directory, digest, row } = await exposedAttempt()
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
      // The chain showed one payment: that account is spent. The other is still held.
      expect(paymentStates(f.alice, digest)).toEqual(['spent', 'pending'])
      await retainedAttempt(f.alice, row)
      await f.chain.directMessages.discardAttempt({
        wallet: f.alice,
        payloadDigest: digest,
      })
      await retainedAttempt(f.alice, row)
      await f.alice.close()
      f.alice = await reopen(directory)
      await retainedAttempt(f.alice, row)
      expect(paymentStates(f.alice, digest)).toEqual(['spent', 'pending'])
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
      const sign = jest.spyOn(EvmStampPayer.prototype, 'sign')
      try {
        for (let pass = 0; pass < 2; pass++)
          expect(
            await f.chain.directMessages.reconcileAttempts({
              wallet: f.alice,
              payloadDigests: [digest],
            }),
          ).toEqual({ [digest]: 'delivered' })
        // Nothing was signed again: the stored bytes were re-sent.
        expect(sign).not.toHaveBeenCalled()
      } finally {
        sign.mockRestore()
      }
      expect(new Set(f.requests.map(r => toHex(r.body))).size).toBe(1)
      // Finished: delivered, both payments seen on chain, both accounts spent and let go.
      const finished = await retainedAttempt(f.alice, row)
      expect(finished.outcome).toBe('delivered')
      expect(paymentStates(f.alice, digest)).toEqual(['spent', 'spent'])
      expect(claimedIndices(f.alice)).toEqual([])
      expect(f.alice.pool.records().map(r => r.status)).toEqual([
        'spent',
        'spent',
      ])
      // The relay's broadcasts paid: this wallet never had to broadcast.
      expect(mockWalletBroadcasts).toHaveLength(0)
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
      expect(mockMined.size).toBe(2)
    },
  )



  it('keeps reporting a delivered attempt no message recorded across wallet reopens, and never pays for it twice', async () => {
    const { directory, digest } = await interruptedSend('orphan')
    expect(f.requests).toHaveLength(0)
    // Next session: nobody points at the stored message. Asking what is unaccounted for makes
    // no request; the background pass sends the stored message, and it is delivered.
    let wallet = await reopen(directory)
    try {
      expect(await orphans(wallet)).toEqual([digest])
      expect(f.requests).toHaveLength(0)
      expect(
        await f.chain.directMessages.reconcileAttempts({
          wallet,
          payloadDigests: [digest],
        }),
      ).toEqual({ [digest]: 'delivered' })
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
      // Not delivered yet: an answer for it does not stick (it may still be delivered).
      await f.chain.directMessages.resolveUnattributedAttempts({
        wallet,
        payloadDigests: [digest],
      })
      expect(await orphans(wallet)).toEqual([digest])
      // The background pass delivers the stored message.
      expect(
        await f.chain.directMessages.reconcileAttempts({
          wallet,
          payloadDigests: [digest],
        }),
      ).toEqual({ [digest]: 'delivered' })
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

  describe('a message sent with no stamp', () => {
    /** Everything of the payment machinery a send could touch, counted around one call. */
    function paymentMachinery(wallet: EvmChainWalletHandle) {
      const spies = (
        ['bindPrepared', 'prepareIntent', 'finishIntent', 'submit'] as const
      ).map(method => jest.spyOn(MonadCanonicalStampClient.prototype, method))
      const pool = structuredClone(wallet.pool.records())
      const journal = structuredClone(wallet.stampPaymentJournal?.getAll())
      const funded = mockFunded.length
      return {
        expectUntouched: async () => {
          try {
            for (const spy of spies) expect(spy).not.toHaveBeenCalled()
            expect(wallet.pool.records()).toEqual(pool)
            expect(wallet.stampPaymentJournal?.getAll()).toEqual(journal)
            expect(mockFunded).toHaveLength(funded)
          } finally {
            for (const spy of spies) spy.mockRestore()
          }
        },
      }
    }
    const directories = async () => {
      installCanonicalDirectory(
        f.alice,
        await f.directoryFor('alice', f.alice, f.bob),
      )
      installCanonicalDirectory(
        f.bob,
        await f.directoryFor('bob', f.bob, f.alice),
      )
    }
    const record = (index: number, timestampMs: number) => {
      const request = restoreCanonicalRequest(f.requests[index])
      return {
        delivery: request.parts.delivery,
        context: request.parts.context,
        submissionIdentity: request.identity.submission_identity,
        timestampMs,
      }
    }

    it.each(['alice', 'bob'] as const)(
      'is sealed and delivered with an empty payment list, and %s pays, funds, reserves and records nothing',
      async from => {
        await directories()
        // Bob has no funded account at all: an unpaid message needs none.
        const [sender, recipient] =
          from === 'alice' ? [f.alice, f.bob] : [f.bob, f.alice]
        const machinery = paymentMachinery(sender)
        const onAttemptCreated = jest.fn()
        const sent = await f.chain.directMessages.send({
          wallet: sender,
          recipient: recipient.identity.address,
          items: text('no stamp'),
          stampValue: 0n,
          onAttemptCreated,
        })
        await machinery.expectUntouched()
        expect(onAttemptCreated).not.toHaveBeenCalled()
        expect(sent).toEqual({
          payloadDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          stampValueWei: 0n,
          stampPayments: [],
          paymentTransfers: [],
          preparationTxHashes: [],
        })
        // One request: a schema-2 delivery with no payment member and no transaction.
        expect(f.requests).toHaveLength(1)
        const request = restoreCanonicalRequest(f.requests[0])
        expect(request.parts.transactions).toEqual([])
        expect(request.identity.payload_hash).toBe(sent.payloadDigest)
        const delivery = parseFrame(request.parts.delivery)
        if (delivery.kind !== 'parsed' || delivery.typed?.type !== 1)
          throw new Error('not a delivery')
        expect(delivery.schemaVersion).toBe(2)
        expect(delivery.minReaderVersion).toBe(1)
        expect(delivery.typed.payments).toEqual([])
        expect([...(delivery.payload as Map<bigint, FrankValue>).keys()]).toEqual(
          [0n, 1n, 2n, 3n, 4n, 5n, 6n],
        )
        // Nothing for the attempt machinery to know or do.
        expect(
          await f.chain.directMessages.unattributedAttempts({
            wallet: sender,
            knownDigests: [],
          }),
        ).toEqual([])
        expect(
          await f.chain.directMessages.reconcileAttempts({
            wallet: sender,
            payloadDigests: [sent.payloadDigest],
          }),
        ).toEqual({ [sent.payloadDigest]: 'unknown' })
        expect(f.requests).toHaveLength(1)

        inboxPage.mockResolvedValue({ records: [record(0, 7)] })
        const received = await f.chain.directMessages.fetchSince({
          wallet: recipient,
          sinceMs: 0,
        })
        expect(received).toHaveLength(1)
        expect(received[0].items).toEqual(text('no stamp'))
        expect(received[0].payloadDigest).toBe(sent.payloadDigest)
        expect(received[0].stampValueWei).toBe(0n)
        expect(received[0].stampPayments).toEqual([])
        expect(received[0].paymentTransfers).toEqual([])
      },
    )

    it('is not held by a pending paid message, does not clear it, and does not hold the next paid one', async () => {
      await directories()
      f.setPhase('retained')
      let pending = ''
      await expect(
        f.chain.directMessages.send({
          wallet: f.alice,
          recipient: f.bob.identity.address,
          items: text('paid, pending'),
          onAttemptCreated: digest => void (pending = digest),
        }),
      ).rejects.toBeInstanceOf(MonadStampPendingAttemptError)
      expect(f.requests).toHaveLength(1)

      // Unpaid while the paid one is pending: goes out, and re-sends nothing of the paid one.
      f.setPhase('delivered')
      const machinery = paymentMachinery(f.alice)
      const unpaid = await f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: text('unpaid meanwhile'),
        stampValue: 0n,
      })
      await machinery.expectUntouched()
      expect(f.requests).toHaveLength(2)
      expect(restoreCanonicalRequest(f.requests[1]).identity.payload_hash).toBe(
        unpaid.payloadDigest,
      )

      // The paid message is still the one pending attempt, and still holds a second paid one.
      f.setPhase('retained')
      await expect(
        f.chain.directMessages.send({
          wallet: f.alice,
          recipient: f.bob.identity.address,
          items: text('paid, held'),
        }),
      ).rejects.toBeInstanceOf(MonadStampPendingAttemptError)
      f.setPhase('delivered')
      expect(
        await f.chain.directMessages.reconcileAttempts({
          wallet: f.alice,
          payloadDigests: [pending, unpaid.payloadDigest],
        }),
      ).toEqual({ [pending]: 'delivered', [unpaid.payloadDigest]: 'unknown' })

      // A paid send right after an unpaid one is an ordinary paid send.
      await f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: text('unpaid again'),
        stampValue: 0n,
      })
      mockBalances.set(
        (await f.alice.getReceiveAddress()).raw.toLowerCase(),
        10n ** 18n,
      )
      const paid = await f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: text('paid after unpaid'),
      })
      // The default stamp (1,000 wei) is raised to what one transfer costs here: 21,000 gas at
      // this fixture's gas price of 2.
      expect(paid.stampPayments.reduce((n, p) => n + p.valueWei, 0n)).toBe(
        42_000n,
      )
      const last = restoreCanonicalRequest(f.requests[f.requests.length - 1])
      expect(last.identity.payload_hash).toBe(paid.payloadDigest)
      expect(last.parts.transactions.length).toBeGreaterThan(0)
      const paidDelivery = parseFrame(last.parts.delivery)
      expect(paidDelivery.kind === 'parsed' && paidDelivery.schemaVersion).toBe(1)
    })

    it.each([
      ['fail', Error],
      ['lost', Error],
      ['retained', UnpaidDirectMessageNotDeliveredError],
      ['undeliverable', CanonicalRecipientUndeliverableError],
      ['sender_unpublished', CanonicalSenderUnpublishedError],
    ] as const)(
      'when the relay answers "%s" it is an error to the caller, no payment record is kept, and the named message sent again is the same bytes unless the relay ended it',
      async (phase, error) => {
        await directories()
        f.setPhase(phase)
        const machinery = paymentMachinery(f.alice)
        const messageId = '00000000-0000-4000-8000-0000000000aa'
        const refused: unknown = await f.chain.directMessages
          .send({
            wallet: f.alice,
            recipient: f.bob.identity.address,
            items: text('unpaid, refused'),
            stampValue: 0n,
            messageId,
          })
          .then(
            () => undefined,
            (reason: unknown) => reason,
          )
        expect(refused).toBeInstanceOf(error)
        // The relay may hold it: the refusal is never labelled "not attempted".
        expect(isDirectMessageNotAttempted(refused)).toBe(false)
        await machinery.expectUntouched()
        expect(
          await f.chain.directMessages.unattributedAttempts({
            wallet: f.alice,
            knownDigests: [],
          }),
        ).toEqual([])
        // The caller may simply send the same message again.
        f.setPhase('delivered')
        const requests = f.requests.length
        const again = await f.chain.directMessages.send({
          wallet: f.alice,
          recipient: f.bob.identity.address,
          items: text('unpaid, refused'),
          stampValue: 0n,
          messageId,
        })
        expect(again.stampPayments).toEqual([])
        expect(f.requests).toHaveLength(requests + 1)
        const last = f.requests[f.requests.length - 1]
        expect(restoreCanonicalRequest(last).identity.payload_hash).toBe(
          again.payloadDigest,
        )
        if (phase === 'retained') {
          // The relay already held the first copy: the repeat is byte for byte the same
          // request, so both copies have one payload digest.
          expect(requests).toBe(1)
          const first = restoreCanonicalRequest(f.requests[0])
          const repeat = restoreCanonicalRequest(last)
          expect(toHex(repeat.parts.delivery)).toBe(toHex(first.parts.delivery))
          expect(toHex(repeat.parts.context)).toBe(toHex(first.parts.context))
          expect(repeat.identity.payload_hash).toBe(first.identity.payload_hash)
        }
        if (phase === 'undeliverable' || phase === 'sender_unpublished') {
          // The relay ended the first: what is sent afterwards is a new message.
          expect(restoreCanonicalRequest(last).identity.payload_hash).not.toBe(
            restoreCanonicalRequest(f.requests[0]).identity.payload_hash,
          )
        }
        // Delivered: nothing is kept, and the same name later is a fresh envelope.
        const later = await f.chain.directMessages.send({
          wallet: f.alice,
          recipient: f.bob.identity.address,
          items: text('unpaid, refused'),
          stampValue: 0n,
          messageId,
        })
        expect(later.payloadDigest).not.toBe(again.payloadDigest)
      },
    )

    it('an unpaid message the relay retained is repeated byte for byte, conversation ID and subject included', async () => {
      await directories()
      const sealing = jest.spyOn(canonicalOpen, 'prepareDirectMessage')
      const messageId = '00000000-0000-4000-8000-0000000000ab'
      const conversationId = '11111111-2222-4333-8444-555555555555'
      f.setPhase('retained')
      await expect(
        f.chain.directMessages.send({
          wallet: f.alice,
          recipient: f.bob.identity.address,
          items: text('unpaid, with a subject'),
          stampValue: 0n,
          messageId,
          conversationId,
          conversationName: 'Weekend plans',
        }),
      ).rejects.toBeInstanceOf(UnpaidDirectMessageNotDeliveredError)
      // What was sealed into the kept envelope.
      expect(sealing).toHaveBeenCalledTimes(1)
      expect(toHex(sealing.mock.calls[0][0].conversationId!)).toBe(
        conversationId.replace(/-/g, ''),
      )
      expect(sealing.mock.calls[0][0].conversationName).toBe('Weekend plans')

      // The repeat, even asked with another conversation and subject, is the kept envelope:
      // nothing is sealed again and the bytes, with their ID and subject, are the same.
      f.setPhase('delivered')
      const requests = f.requests.length
      const again = await f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: text('unpaid, with a subject'),
        stampValue: 0n,
        messageId,
        conversationName: 'Another subject',
      })
      expect(sealing).toHaveBeenCalledTimes(1)
      expect(f.requests).toHaveLength(requests + 1)
      const first = restoreCanonicalRequest(f.requests[requests - 1])
      const repeat = restoreCanonicalRequest(f.requests[requests])
      expect(toHex(repeat.parts.delivery)).toBe(toHex(first.parts.delivery))
      expect(toHex(repeat.parts.context)).toBe(toHex(first.parts.context))
      expect(repeat.identity.payload_hash).toBe(again.payloadDigest)
      sealing.mockRestore()
    })

    it('an unpaid named message whose answer was lost is repeated as the very same request body, byte for byte, also after a restart', async () => {
      // The relay recognises a repeat by the whole request: content type and body. The same
      // envelope under another multipart boundary is answered 409, never `delivered`.
      const directory = await f.directoryFor('alice', f.alice, f.bob)
      installCanonicalDirectory(f.alice, directory)
      const unpaid = (wallet: EvmChainWalletHandle) =>
        f.chain.directMessages.send({
          wallet,
          recipient: f.bob.identity.address,
          items: text('unpaid, answer lost'),
          stampValue: 0n,
          messageId: '00000000-0000-4000-8000-0000000000ac',
        })
      // What the transport handed to fetch, as the relay would compare it.
      const handed = () =>
        f.requests.map(r => ({ contentType: r.contentType, body: toHex(r.body) }))
      // The relay stores the message and its answer never arrives.
      f.setPhase('lost')
      await expect(unpaid(f.alice)).rejects.toThrow('outcome is unknown')
      await expect(unpaid(f.alice)).rejects.toThrow('outcome is unknown')
      expect(handed()).toHaveLength(2)
      expect(handed()[1]).toEqual(handed()[0])
      // The kept envelope carries its boundary across a restart.
      await f.alice.close()
      const wallet = (await f.chain.createWallet(
        roots(0),
      )) as EvmChainWalletHandle
      f.alice = wallet
      installCanonicalDirectory(wallet, directory)
      f.setPhase('delivered')
      const sent = await unpaid(wallet)
      expect(sent.stampPayments).toEqual([])
      expect(handed()).toHaveLength(3)
      expect(handed()[2]).toEqual(handed()[0])
      expect(handed()[0].contentType).toMatch(
        /^multipart\/form-data; boundary=frank-[0-9a-f]{48}$/,
      )
    })

    it('an unpaid envelope kept by earlier code, without its boundary, is not used: the message is sealed again', async () => {
      const address = (await f.alice.getReceiveAddress()).raw.toLowerCase()
      const storageLocation = `${join(f.root, 'wallet')}-evm-${address}`
      const directory = await f.directoryFor('alice', f.alice, f.bob)
      installCanonicalDirectory(f.alice, directory)
      const messageId = '00000000-0000-4000-8000-0000000000ad'
      const unpaid = (wallet: EvmChainWalletHandle) =>
        f.chain.directMessages.send({
          wallet,
          recipient: f.bob.identity.address,
          items: text('unpaid, kept by earlier code'),
          stampValue: 0n,
          messageId,
        })
      f.setPhase('lost')
      await expect(unpaid(f.alice)).rejects.toThrow('outcome is unknown')
      await f.alice.close()
      // The record as the earlier code wrote it: the same fields, no boundary.
      const name = messageId.replace(/-/g, '')
      const store = await LevelOutgoingMessageStore.open(storageLocation)
      const kept = store.unpaid(name)!
      expect(kept.digest).toMatch(/^[0-9a-f]{64}$/)
      await store.setUnpaid(name, {
        digest: kept.digest,
        delivery: kept.delivery,
        context: kept.context,
        recipientSubject: kept.recipientSubject,
      } as UnpaidEnvelope)
      await store.close()
      const wallet = (await f.chain.createWallet(
        roots(0),
      )) as EvmChainWalletHandle
      f.alice = wallet
      installCanonicalDirectory(wallet, directory)
      // Its request cannot be rebuilt, so it is a new envelope with a new digest; the relay
      // may then hold two copies of this one message.
      await expect(unpaid(wallet)).rejects.toThrow('outcome is unknown')
      const [first, second] = f.requests.map(
        r => restoreCanonicalRequest(r).identity.payload_hash,
      )
      expect(second).not.toBe(first)
      // The new envelope replaced the old record and is repeated exactly.
      f.setPhase('delivered')
      await unpaid(wallet)
      expect(f.requests).toHaveLength(3)
      expect(toHex(f.requests[2].body)).toBe(toHex(f.requests[1].body))
      expect(f.requests[2].contentType).toBe(f.requests[1].contentType)
    })
  })

  it('sends from an unfunded wallet (no funded accounts) with one payment from the main account, funding nothing', async () => {
    const main = (await f.alice.getReceiveAddress()).raw.toLowerCase()
    mockBalances.set(main, 10n ** 18n)
    installCanonicalDirectory(
      f.alice,
      await f.directoryFor('alice', f.alice, f.bob),
    )
    const sent = await f.chain.directMessages.send({
      wallet: f.alice,
      recipient: f.bob.identity.address,
      items: text('paid from the main account'),
    })
    // A send never funds an account to pay from: no funding transfer, one whole payment.
    expect(sent.preparationTxHashes).toEqual([])
    expect(mockFunded).toEqual([])
    expect(sent.stampPayments.map(p => p.valueWei)).toEqual([DEFAULT_STAMP])
    expect(f.requests).toHaveLength(1)
    expect(
      restoreCanonicalRequest(f.requests[0]).parts.transactions.map(raw =>
        Transaction.from('0x' + toHex(raw)).from!.toLowerCase(),
      ),
    ).toEqual([main])
    expect(f.alice.pool.records()).toEqual([])
  })

  describe('labels the send refusals that attempted nothing (#1237)', () => {
    type Send = Parameters<DirectMessageClient['send']>[0]
    /** One refused send from Alice to Bob, with what it left behind. */
    async function refusal(overrides: Partial<Send> = {}) {
      // One call signs one message's payment set.
      const prepare = jest.spyOn(EvmStampPayer.prototype, 'sign')
      const pool = structuredClone(f.alice.pool.records())
      const claimedBefore = claimedIndices(f.alice)
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
          poolUnchanged: () => {
            expect(f.alice.pool.records()).toEqual(pool)
            expect(claimedIndices(f.alice)).toEqual(claimedBefore)
          },
          // Payload hashes of the relay requests made while this send ran.
          submitted: f.requests
            .slice(requests)
            .map(r => restoreCanonicalRequest(r).identity.payload_hash),
        }
      } finally {
        prepare.mockRestore()
      }
    }
    /** Labelled, and nothing was signed, claimed, funded, recorded or handed over for this send. */
    function expectNothingAttempted(
      refused: Awaited<ReturnType<typeof refusal>>,
    ) {
      expect(isDirectMessageNotAttempted(refused.error)).toBe(true)
      expect(refused.prepared).toBe(0)
      expect(refused.linked).toBe(0)
      expect(refused.funded).toBe(0)
      expect(refused.submitted).toEqual([])
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

    it('does not label a send whose own attempt is pending, and a later send is not refused for it', async () => {
      installCanonicalDirectory(
        f.alice,
        await f.directoryFor('alice', f.alice, f.bob),
      )
      f.setPhase('fail')
      let digest = ''
      // Recorded, signed and offered to the relay, with no answer: this one may have been paid.
      const first = await refusal({
        onAttemptCreated: created => void (digest = created),
      })
      expect(first.error).toBeInstanceOf(MonadStampPendingAttemptError)
      expect(first.prepared).toBe(1)
      expect(digest).toMatch(/^[0-9a-f]{64}$/)
      expect(
        (first.error as MonadStampPendingAttemptError).payloadHashes,
      ).toEqual([digest])
      expect(isDirectMessageNotAttempted(first.error)).toBe(false)

      // The next message is not held behind it: it is sent, and only its own bytes go out.
      f.setPhase('delivered')
      const next = await f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: text('not behind anything'),
      })
      expect(
        f.requests.map(r => restoreCanonicalRequest(r).identity.payload_hash),
      ).toEqual([next.payloadDigest])
      expect(await unlinked()).toEqual([digest, next.payloadDigest])
    })

    it('does not label a send refused for lack of funds in an unfunded wallet', async () => {
      installCanonicalDirectory(
        f.alice,
        await f.directoryFor('alice', f.alice, f.bob),
      )
      const refused = await refusal()
      expect(refused.error).toBeInstanceOf(InsufficientStampFundsError)
      expect((refused.error as Error).message).toMatch(
        /^No funds cover a stamp of/,
      )
      expect(refused.funded).toBe(0)
      expect(refused.submitted).toEqual([])
      expect(refused.prepared).toBe(0)
      expect(refused.linked).toBe(0)
      expect(isDirectMessageNotAttempted(refused.error)).toBe(false)
    })

    it('does not label a send refused after its payment was signed and recorded', async () => {
      installCanonicalDirectory(
        f.alice,
        await f.directoryFor('alice', f.alice, f.bob),
      )
      // The message is signed and stored when the caller's own record of it fails.
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
      // This call has a signed, stored message when the caller's own record of it fails.
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

      // The same object now comes from the directory read that follows the claim of accounts.
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
    mockChainReset()
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
        // The stream connects once the wallet's own directory entry is read (disk): wait for
        // that, bounded by time. (A fixed count of 20 event-loop turns was measured to be
        // too few for the receiving wallet: 26 turns, 15 ms.)
        for (
          const deadline = Date.now() + 2_000;
          !mockStreamRecordHandler && Date.now() < deadline;

        )
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
    // Bob's wallet notes the stamp it received to itself (a free message of its own) before
    // his reply goes out; the reply is the last request the relay served.
    await f.bob.noteReceivedCoins!()
    await f.chain.directMessages.send({
      wallet: f.bob,
      recipient: atBob[0].senderAddress,
      items: text('hello alice'),
    })
    inboxPage.mockResolvedValue({
      records: [inboxRecord(f.requests.length - 1, 9)],
    })
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
      // The wallet's own note about the stamp it received looks itself up in the directory:
      // finished here, so it does not use up the next read's failing lookup.
      await f.bob.noteReceivedCoins!()
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

  it('delivers a message that carries no payment as a normal message with no stamp', async () => {
    await online('alice', f.alice)
    const bobDirectory = await online('bob', f.bob)
    await f.chain.directMessages.send({
      wallet: f.alice,
      recipient: f.bob.identity.address,
      items: text('free of charge'),
    })
    // The same sealed message as the relay stores an unpaid one: schema 2, empty payment list.
    const paid = inboxRecord(0, 7)
    const parsed = parseFrame(paid.delivery)
    if (parsed.kind !== 'parsed' || !(parsed.payload instanceof Map))
      throw new Error('fixture')
    const payload = new Map(parsed.payload)
    payload.set(4n, [])
    const unpaid = {
      ...paid,
      delivery: encodeFrame(
        { typeId: 1, schemaVersion: 2, minReaderVersion: 1 },
        payload,
      ),
      submissionIdentity: 'cd'.repeat(32),
    }
    const restore = productionPageReaders()
    try {
      installCanonicalDirectory(f.bob, {
        ...bobDirectory,
        fetch: relayMailbox([unpaid]),
      })
      const quarantined: number[] = []
      const received = await f.chain.directMessages.fetchSince({
        wallet: f.bob,
        sinceMs: 0,
        onQuarantinedTimestamp: time => void quarantined.push(time),
      })
      expect(quarantined).toEqual([])
      expect(received).toHaveLength(1)
      expect(received[0].items).toEqual(text('free of charge'))
      expect(received[0].outbound).toBe(false)
      expect(received[0].receivedTime).toBe(7)
      // Nothing about it is a received payment.
      expect(received[0].stampValueWei).toBe(0n)
      expect(received[0].stampPayments).toEqual([])
      expect(received[0].paymentTransfers).toEqual([])
    } finally {
      restore()
    }
  })

  it('reports a forged ciphertext as terminal so the read position passes it, and still delivers the next message', async () => {
    await online('alice', f.alice)
    await online('bob', f.bob)
    for (const body of ['forged over', 'genuine']) {
      mockBalances.set(
        (await f.alice.getReceiveAddress()).raw.toLowerCase(),
        10n ** 18n,
      )
      await f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: text(body),
      })
    }
    // Everything a forger can copy is right (sender, recipient, entries, context); only the
    // ciphertext is not what the key holders sealed, so it cannot be opened now or later.
    const original = inboxRecord(0, 5)
    const delivery = parseFrame(original.delivery)
    if (delivery.kind !== 'parsed' || delivery.typed?.type !== 1)
      throw new Error('fixture')
    const sealed = delivery.typed.payloadFrame
    if (!(sealed.payload instanceof Map)) throw new Error('fixture')
    const box = new Uint8Array(sealed.payload.get(4n) as Uint8Array)
    box[box.length - 1] ^= 1
    const forgedPayload = encodeFrame(
      { typeId: 5, schemaVersion: 2, minReaderVersion: 2 },
      new Map(sealed.payload).set(4n, box),
    )
    const forgedDigest = recipientPayloadDigest(
      delivery.typed.network,
      forgedPayload,
    )
    const forged = {
      ...original,
      delivery: encodeFrame(
        { typeId: 1, schemaVersion: 1, minReaderVersion: 1 },
        new Map(delivery.payload as Map<bigint, FrankValue>)
          .set(2n, forgedPayload)
          .set(3n, forgedDigest),
      ),
    }
    // A record whose context does not match is not known to be unopenable: it is left alone.
    const mismatched = inboxRecord(0, 6)
    const context = new Uint8Array(mismatched.context)
    context[context.length - 1] ^= 1
    inboxPage.mockResolvedValue({
      records: [forged, { ...mismatched, context }, inboxRecord(1, 9)],
    })
    const quarantined: [number, string][] = []
    const received = await f.chain.directMessages.fetchSince({
      wallet: f.bob,
      sinceMs: 0,
      onQuarantinedTimestamp: (time, id) => void quarantined.push([time, id]),
    })
    expect(received.map(m => [m.receivedTime, m.items])).toEqual([
      [9, text('genuine')],
    ])
    expect(quarantined).toEqual([[5, toHex(forgedDigest)]])
  })

  describe('a mailbox record the client cannot decode', () => {
    /** Three paid messages from Alice in Bob's mailbox; the middle one is replaced. */
    async function mailboxWithOneUnreadable(
      spoil: (record: ServedRecord) => Partial<ServedRecord>,
    ) {
      await online('alice', f.alice)
      const bobDirectory = await online('bob', f.bob)
      for (const body of ['first', 'second', 'third']) {
        mockBalances.set(
          (await f.alice.getReceiveAddress()).raw.toLowerCase(),
          10n ** 18n,
        )
        await f.chain.directMessages.send({
          wallet: f.alice,
          recipient: f.bob.identity.address,
          items: text(body),
        })
      }
      const original = inboxRecord(1, 7)
      const delivered = parseFrame(original.delivery)
      if (delivered.kind !== 'parsed' || delivered.typed?.type !== 1)
        throw new Error('fixture')
      const records: ServedRecord[] = [
        inboxRecord(0, 5),
        { ...original, ...spoil(original), submissionIdentity: 'ab'.repeat(32) },
        inboxRecord(2, 9),
      ]
      return {
        records,
        /** The payments the replaced message was sent with. */
        spoiledPayments: delivered.typed.payments.map(
          member => '0x' + toHex(member.transactionId),
        ),
        serve: (mailbox: CanonicalFetch) =>
          installCanonicalDirectory(f.bob, { ...bobDirectory, fetch: mailbox }),
      }
    }
    const read = async (sinceMs: number) => {
      const incomplete: number[] = [],
        quarantined: [number, string][] = [],
        truncated: Error[] = []
      const received = await f.chain.directMessages.fetchSince({
        wallet: f.bob,
        sinceMs,
        onTruncated: reason => void truncated.push(reason),
        onIncompleteTimestamp: time => void incomplete.push(time),
        onQuarantinedTimestamp: (time, id) => void quarantined.push([time, id]),
      })
      return { received, incomplete, quarantined, truncated }
    }

    it.each([
      [
        'its payments and a corrupt context',
        (record: ServedRecord) => ({ context: record.context.slice(0, -1) }),
      ],
      [
        'bytes that are not a frame',
        () => ({ delivery: new Uint8Array(Buffer.from('not a frame')) }),
      ],
    ] as const)(
      'with %s is skipped and reported once; the messages around it arrive and no stamp is counted from it',
      async (_name, spoil) => {
        const restore = productionPageReaders()
        try {
          const mailbox = await mailboxWithOneUnreadable(spoil)
          const relay = relayMailbox(mailbox.records)
          mailbox.serve(relay)

          const first = await read(0)
          expect(first.received.map(m => [m.receivedTime, m.items])).toEqual([
            [5, text('first')],
            [9, text('third')],
          ])
          expect(first.quarantined).toEqual([[7, 'ab'.repeat(32)]])
          expect(first.incomplete).toEqual([])
          expect(first.truncated).toEqual([])
          // One request: the combined mailbox answered, nothing fell back or was retried.
          expect(relay.reads).toHaveLength(1)
          // Nothing of the skipped record is a message, a payment or a received stamp.
          const counted = first.received.flatMap(m => [
            ...(m.stampPayments ?? []).map(p => p.txHash.toLowerCase()),
            ...(m.paymentTransfers ?? []).flatMap(t =>
              JSON.stringify(t).toLowerCase(),
            ),
          ])
          expect(mailbox.spoiledPayments).toHaveLength(1)
          for (const txHash of mailbox.spoiledPayments)
            expect(counted.some(entry => entry.includes(txHash.slice(2)))).toBe(
              false,
            )
          expect(first.received.every(m => m.stampPayments?.length === 1)).toBe(
            true,
          )

          // The host moves its read position past what was delivered and what was reported
          // terminal; the record is then neither read nor reported again.
          const next = await read(10)
          expect(next.received).toEqual([])
          expect(next.quarantined).toEqual([])
          expect(new URL(relay.reads[1]).searchParams.get('since')).toBe('10')
        } finally {
          restore()
        }
      },
    )

    it('still fails the whole read when the page itself is broken, and reports nothing', async () => {
      const restore = productionPageReaders()
      try {
        const mailbox = await mailboxWithOneUnreadable(record => ({
          context: record.context.slice(0, -1),
        }))
        mailbox.serve(relayMailbox(mailbox.records, 3))
        const quarantined: number[] = []
        await expect(
          f.chain.directMessages.fetchSince({
            wallet: f.bob,
            sinceMs: 0,
            onQuarantinedTimestamp: time => void quarantined.push(time),
          }),
        ).rejects.toThrow()
        expect(quarantined).toEqual([])
      } finally {
        restore()
      }
    })
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
    mockChainReset()
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
    '%s: a direct message that would need the reserved account is paid from the main account instead, funding nothing',
    async window => {
      const r = await reserved(window)
      const sent = await r.message(f.alice, 'paid around the reserved account')
      expect(sent.stampPayments.reduce((n, p) => n + p.valueWei, 0n)).toBe(
        STAMP,
      )
      expect(f.requests).toHaveLength(1)
      // The free funded account alone does not cover the stamp, and the reserved one is not
      // taken: the whole stamp is one payment from the main account. A send funds nothing.
      expect(r.payers(0)).toEqual([r.main])
      expect(sent.preparationTxHashes).toEqual([])
      expect(mockFunded).toEqual([])
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
      // The host's tick: the chain shows the message's payment, so the coin it spent is let go.
      await f.chain.directMessages.reconcileAttempts({
        wallet: f.alice,
        payloadDigests: [sent.payloadDigest],
      })
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
      await f.chain.directMessages.reconcileAttempts({
        wallet: f.alice,
        payloadDigests: [again.payloadDigest],
      })
      r.broadcasts.length = 0
      await f.alice.sendNative({ recipient: r.recipient, value: 1n })
      expect(r.broadcasts.map(tx => tx.from!.toLowerCase())).toEqual([r.main])
      expect(await admission()).toMatchObject({ status: 'ready' })
    },
  )
})
