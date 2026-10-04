/**
 * #778: typed wallets created through the normal `createMonadChain().createWallet` composition send
 * and receive direct messages only through the canonical wallet client. Real typed custody, real
 * Level journals, real directory admission and real sealing/opening. The chain RPC and the relay's
 * HTTP surface are offline stand-ins: this proves the composition and wire bytes, not finality.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonRpcProvider, computeAddress, getBytes } from 'ethers'
import { parseFrame, recipientPayloadDigest, toHex } from '@frank/codec'
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
import {
  CanonicalMessagingHoldError,
  CanonicalMessagingPendingError,
  CanonicalRecipientNotPublishedError,
  CanonicalRecipientUndeliverableError,
  CanonicalRelayCannotForwardError,
  createMonadChain,
  installCanonicalDirectory,
  canonicalMonadStampClient,
  createCanonicalMessageRoles,
  prepareCanonicalStampInventory,
  prepareMonadRevisionZeroExport,
  prepareMonadNextRevisionExport,
  type CanonicalDirectory,
  type MonadChainConfig,
  type MonadChainWalletHandle,
} from './monad-chain'
import { InMemoryNativeTransactionAttemptStore } from './chain-wallet'

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
jest.mock('@frank/cashweb/relay/monad-mailbox-client', () => ({
  ...jest.requireActual('@frank/cashweb/relay/monad-mailbox-client'),
  fetchCanonicalInboxPage: jest.fn(),
  fetchCanonicalRecoveryPage: jest.fn(async () => ({ records: [] })),
}))
import { fetchCanonicalInboxPage } from '@frank/cashweb/relay/monad-mailbox-client'
const inboxPage = fetchCanonicalInboxPage as jest.MockedFunction<
  typeof fetchCanonicalInboxPage
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
  const config: MonadChainConfig = {
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
  const chain = createMonadChain(config)
  const alice = (await chain.createWallet(roots(0))) as MonadChainWalletHandle,
    bob = (await chain.createWallet(roots(1))) as MonadChainWalletHandle
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
  const admit = async (owner: string, wallet: MonadChainWalletHandle) => {
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
  let phase: 'delivered' | 'retained' | 'fail' | 'undeliverable' = 'delivered'
  const fetch: CanonicalFetch = async (url, init) => {
    if (url !== RELAY + '/message/monad/cbor' || init.method !== 'PUT')
      throw new Error(`unexpected relay request ${init.method} ${url}`)
    if (phase === 'fail') throw new Error('relay unreachable')
    const body = new Uint8Array(init.body!)
    requests.push({ body, contentType: init.headers['Content-Type'] })
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
              reason: 'recipient_undeliverable',
            }
          : { version: 1, phase, identity },
      ),
    )
    let read = false
    return {
      status: phase === 'retained' ? 202 : 200,
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
    self: MonadChainWalletHandle,
    peer: MonadChainWalletHandle,
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
  return {
    chain,
    alice,
    bob,
    root: directory,
    fetch,
    requests,
    setPhase: (next: typeof phase) => (phase = next),
    directoryFor,
    close: async () => {
      await alice.close()
      await bob.close()
      for (const store of stores) await store.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
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
    expect(received[0].receivedTime).toBe(1234)
    const auth = inboxPage.mock.calls[0][0]
    expect(auth.relayBaseUrl).toBe(RELAY + '/')
    expect(auth.subject).toBe(toHex(f.bob.identity.compressedPubKey))
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
        items: [{ type: 'image', image: 'data:' } as never],
      }),
    ).rejects.toThrow("cannot carry 'image' items")
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
    )) as MonadChainWalletHandle
    installCanonicalDirectory(wallet, directory)
    return wallet
  }
  const orphans = (
    wallet: MonadChainWalletHandle,
    knownDigests: string[] = [],
  ) => f.chain.directMessages.unattributedAttempts({ wallet, knownDigests })

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
})

describe('two typed wallets on the open directory', () => {
  jest.setTimeout(60_000)
  const SECOND = 1_000_000_000n
  const CLOCK = 1_800_000_000n * SECOND
  let f: Awaited<ReturnType<typeof fixture>>
  let relay: ReturnType<typeof createFakeRelay>
  const directories: ReturnType<typeof openDirectory>[] = []
  beforeEach(async () => {
    jest.clearAllMocks()
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
    wallet: MonadChainWalletHandle,
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
      nowNs: () => CLOCK,
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
  async function online(name: string, wallet: MonadChainWalletHandle) {
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
  const fund = async (wallet: MonadChainWalletHandle) => {
    for (const record of wallet.pool.ensureSize(2))
      mockBalances.set(record.address.toLowerCase(), 187_500n + 600n)
    await wallet.pool.flush()
  }

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

    it('ends only that attempt when the relay finds it cannot deliver, and later sends go through', async () => {
      relay.infoOverride = { forwarding: true }
      await online('alice', f.alice)
      mockBalances.set(
        (await f.alice.getReceiveAddress()).raw.toLowerCase(),
        10n ** 18n,
      )
      f.setPhase('undeliverable')
      const failure = await f.chain.directMessages
        .send({
          wallet: f.alice,
          recipient: f.bob.identity.address,
          items: text('will not arrive'),
        })
        .catch(error => error)
      expect(failure).toBeInstanceOf(CanonicalRecipientUndeliverableError)
      // Nothing is left reserved or reported as possibly paid.
      expect(f.alice.pool.records().map(r => r.status)).not.toContain('in-use')
      expect(
        await f.chain.directMessages.unattributedAttempts({
          wallet: f.alice,
          knownDigests: [],
        }),
      ).toEqual([])
      f.setPhase('delivered')
      const sent = await f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: text('second try'),
      })
      expect(sent.stampPayments.length).toBeGreaterThan(0)
      expect(f.requests).toHaveLength(2)
    })
  })
})
