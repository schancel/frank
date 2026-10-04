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
import { openNodeDirectoryStore } from '../../directory-admission/src/node'
import type { DirectoryStore } from '../../directory-admission/src'
import domainVectors from '../../domain-roots/vectors/domain-roots-v1.json'
import type { MonadRootBundle } from '../monad-wallet-material'
import type { PublicRevisionZeroInput } from '../monad-wallet-handle'
import { MonadStampPendingAttemptError } from '../monad-stamp-client'
import {
  CanonicalMessagingPendingError,
  createMonadChain,
  installCanonicalDirectory,
  canonicalMonadStampClient,
  createCanonicalMessageRoles,
  prepareCanonicalStampInventory,
  prepareMonadRevisionZeroExport,
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
    relayA: { processId: 'relay-a', origin: RELAY, tuple },
    relayB: { processId: 'relay-b', origin: RELAY, tuple },
    subjectBinding: 'A',
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
  let phase: 'delivered' | 'retained' | 'fail' = 'delivered'
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
          : { version: 1, phase, identity },
      ),
    )
    let read = false
    return {
      status: phase === 'delivered' ? 200 : 202,
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
    expect(received[0].recipientAddress.raw).toBe(f.bob.identity.address.raw)
    expect(received[0].stampValueWei).toBe(1_000n)
    expect(received[0].receivedTime).toBe(1234)
    const auth = inboxPage.mock.calls[0][0]
    expect(auth.relayBaseUrl).toBe(RELAY + '/')
    expect(auth.subject).toBe(toHex(f.bob.identity.compressedPubKey))
  })

  it('does not display a tampered ciphertext or a sender outside the installed directory', async () => {
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
    // Same exact bytes, but the sender is no longer an installed peer.
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

  it('refuses unsupported items and uninstalled recipients before any payment intent', async () => {
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
    ).rejects.toThrow('not in the operator-installed directory')
    expect(f.requests).toHaveLength(0)
    expect(
      await f.chain.directMessages.unattributedAttempts({
        wallet: f.alice,
        knownDigests: [],
      }),
    ).toEqual([])
  })

  it('carries closed type-18 blackjack items both ways and still refuses other structured kinds', async () => {
    installCanonicalDirectory(
      f.alice,
      await f.directoryFor('alice', f.alice, f.bob),
    )
    installCanonicalDirectory(
      f.bob,
      await f.directoryFor('bob', f.bob, f.alice),
    )
    const wagerTxHash = '0x' + 'ab'.repeat(32)
    // Not the closed bet shape: refused by the writer before any inventory or intent.
    for (const items of [
      [{ type: 'blackjack-move', gameId: 'g1', action: 'bet' }],
      [
        {
          type: 'blackjack-move',
          gameId: 'g1',
          action: 'bet',
          wagerTxHash,
          amount: '5',
        },
      ],
      [{ type: 'raffle', raffleId: 'r', action: 'enter' }],
      [{ type: 'digital-goods', action: 'request', itemId: 'x' }],
      [{ type: 'reply', payloadDigest: 'ff'.repeat(32) }],
    ])
      await expect(
        f.chain.directMessages.send({
          wallet: f.alice,
          recipient: f.bob.identity.address,
          items: items as never,
        }),
      ).rejects.toThrow()
    expect(f.requests).toHaveLength(0)
    expect(f.alice.pool.records().map(r => r.status)).toEqual([
      'available',
      'available',
    ])

    const bet = [
      {
        type: 'blackjack-move' as const,
        gameId: 'g1',
        action: 'bet' as const,
        wagerTxHash,
      },
      { type: 'text' as const, text: 'good luck' },
    ]
    const sent = await f.chain.directMessages.send({
      wallet: f.alice,
      recipient: f.bob.identity.address,
      items: bet,
    })
    expect(f.requests).toHaveLength(1)
    const request = restoreCanonicalRequest(f.requests[0])
    // Sealed: neither the game id nor a JSON item is visible to the relay.
    expect(Buffer.from(f.requests[0].body).includes('blackjack')).toBe(false)
    expect(Buffer.from(f.requests[0].body).includes('g1')).toBe(false)
    inboxPage.mockResolvedValue({
      records: [
        {
          delivery: request.parts.delivery,
          context: request.parts.context,
          submissionIdentity: request.identity.submission_identity,
          timestampMs: 77,
        },
      ],
    })
    const received = await f.chain.directMessages.fetchSince({
      wallet: f.bob,
      sinceMs: 0,
    })
    expect(received).toHaveLength(1)
    expect(received[0].payloadDigest).toBe(sent.payloadDigest)
    expect(received[0].items).toEqual(bet)
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
