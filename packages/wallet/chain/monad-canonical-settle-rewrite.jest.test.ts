/**
 * #1322: a link whose relay ended delivery stays unacknowledged, so every reconcile reaches it
 * again. It is written when what is stored differs from the wallet's terminal record, and not
 * otherwise. Real typed custody, real Level journals and the real link store; the chain RPC and
 * the relay's HTTP surface are offline stand-ins, as in the composed canonical suite.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { computeAddress, getBytes } from 'ethers'
import level from 'level'
import { toHex } from '@frank/codec'
import {
  restoreCanonicalRequest,
  type CanonicalFetch,
} from '@frank/cashweb/relay/canonical-dm-transport'
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
  canonicalMonadStampClient,
  createEvmChain,
  installCanonicalDirectory,
  prepareMonadRevisionZeroExport,
  type CanonicalDirectory,
} from './monad-chain'
import type { EvmChainConfig } from './evm-chain-config'
import { withDefaultMessageItems } from './message-items.testutil'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import { InMemoryNativeTransactionAttemptStore } from './chain-wallet'
import { LevelCanonicalLinkStore } from './monad-canonical-dm'
import * as durability from '../storage/level-durability'
import type { CanonicalJournalAttempt } from '../storage/stamp-attempt-journal'

// The real durable write runs; it is only wrapped so the suite can count what reaches Level.
jest.mock('../storage/level-durability', () => {
  const actual = jest.requireActual<
    typeof import('../storage/level-durability')
  >('../storage/level-durability')
  return { ...actual, durablePut: jest.fn(actual.durablePut) }
})
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
        { staticNetwork: true, cacheTimeout: -1 },
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
// No mailbox is read by anything this suite drives; a read would fail the test.
jest.mock('@frank/cashweb/relay/monad-mailbox-client', () => {
  const refuse = (name: string) =>
    jest.fn(async () => {
      throw new Error(`unexpected mailbox call ${name}`)
    })
  return {
    ...jest.requireActual('@frank/cashweb/relay/monad-mailbox-client'),
    fetchCanonicalMailboxPage: refuse('fetchCanonicalMailboxPage'),
    fetchCanonicalInboxPage: refuse('fetchCanonicalInboxPage'),
    fetchCanonicalRecoveryPage: jest.fn(async () => ({ records: [] })),
    connectCanonicalMailboxStream: jest.fn(async () => ({ close: jest.fn() })),
  }
})

const RELAY = 'https://relay-a.example'
const NOW = { seconds: 100n, nanoseconds: 0 }
const LINK_NAMESPACE = 'canonical-dm-workflow-links'
type StoredRow = Parameters<LevelCanonicalLinkStore['put']>[0]

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

/** Two typed wallets from the normal composition and a relay stand-in that answers one phase. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'canonical-settle-rewrite-'))
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
    walletStorageLocation: join(root, 'wallet'),
  }
  const chain = withDefaultMessageItems(createEvmChain(config))
  const alice = (await chain.createWallet(roots(0))) as EvmChainWalletHandle
  const bob = (await chain.createWallet(roots(1))) as EvmChainWalletHandle
  // Stand-in for confirmed funding: each account covers its fee reserve plus half the stamp.
  for (const record of alice.pool.ensureSize(2))
    mockBalances.set(record.address.toLowerCase(), 187_500n + 200_000n)
  await alice.pool.flush()
  const tuple = {
    relayId: new Uint8Array(16).fill(1),
    endpoint: RELAY + '/',
    identity: {
      keyType: 1,
      keyBytes: new Uint8Array(alice.identity.compressedPubKey),
    },
    expiry: { seconds: 3700n, nanoseconds: 0 },
    unknownFields: new Map(),
  }
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
  const admit = async (wallet: EvmChainWalletHandle) => {
    const exported = prepareMonadRevisionZeroExport(wallet, input)
    const store = await openNodeDirectoryStore({
      location: join(root, `directory-${toHex(exported.t1)}`),
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
  const requests: Uint8Array[] = []
  let phase: 'lost' | 'undeliverable' = 'lost'
  const fetch: CanonicalFetch = async (url, init) => {
    if (url !== RELAY + '/message' && url !== RELAY + '/message/monad/cbor')
      throw new Error(`unexpected relay request ${init.method} ${url}`)
    const body = new Uint8Array(init.body!)
    requests.push(body)
    if (phase === 'lost') throw new Error('relay response lost after acceptance')
    const { identity } = restoreCanonicalRequest({
      body,
      contentType: init.headers['Content-Type'],
    })
    const answer = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        phase: 'dead',
        identity,
        reason: 'undeliverable',
      }),
    )
    let read = false
    return {
      status: 200,
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
  const own = await admit(alice)
  const other = await admit(bob)
  const directory: CanonicalDirectory = {
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
  installCanonicalDirectory(alice, directory)
  const address = (await alice.getReceiveAddress()).raw.toLowerCase()
  const ret = {
    chain,
    alice,
    bob,
    requests,
    storageLocation: `${join(root, 'wallet')}-evm-${address}`,
    setPhase: (next: typeof phase) => (phase = next),
    /** Closes the live wallet, runs `between` on its closed storage, and opens it again. */
    restart: async (between?: () => Promise<void>) => {
      await ret.alice.close()
      await between?.()
      ret.alice = (await chain.createWallet(roots(0))) as EvmChainWalletHandle
      installCanonicalDirectory(ret.alice, directory)
    },
    close: async () => {
      await ret.alice.close().catch(() => undefined)
      await ret.bob.close().catch(() => undefined)
      for (const store of stores) await store.close().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    },
  }
  return ret
}

describe('settle and a link whose relay ended delivery (#1322)', () => {
  jest.setTimeout(30_000)
  const durablePut = jest.mocked(durability.durablePut)
  let f: Awaited<ReturnType<typeof fixture>>
  let digest: string
  let attempt: CanonicalJournalAttempt

  /** The values the real durable write put under this attempt's link key since the last reset. */
  const linkWrites = () =>
    durablePut.mock.calls
      .filter(call => call[1] === attempt.attemptRef)
      .map(call => call[2] as string)

  const reconcile = () =>
    f.chain.directMessages.reconcileAttempts({
      wallet: f.alice,
      payloadDigests: [digest],
    })

  /** What is on disk for this attempt's link; the wallet must be closed. */
  async function storedLinkBytes(): Promise<string | undefined> {
    const database = level(join(f.storageLocation, LINK_NAMESPACE))
    try {
      return await database.get(attempt.attemptRef)
    } catch {
      return undefined
    } finally {
      await database.close()
    }
  }

  /** Rewrites the stored link through the real store while the wallet is closed. */
  async function rewriteStoredLink(
    change: (row: StoredRow) => StoredRow,
  ): Promise<void> {
    const store = await LevelCanonicalLinkStore.open(f.storageLocation)
    try {
      const row = store.all().find(r => r.attemptRef === attempt.attemptRef)
      if (!row) throw new Error('expected the stored link')
      await store.put(change(row))
    } finally {
      await store.close()
    }
  }

  // The retention assertions of the composed suite's dead-outcome tests, unchanged.
  function expectRetained() {
    const found = canonicalMonadStampClient(f.alice).lookup(attempt.prepared)
    if (!found || found.kind !== 'attempt')
      throw new Error('expected retained attempt')
    expect(found.record.request).toEqual(attempt.request)
    expect(found.record.prepared).toEqual(attempt.prepared)
    expect(found.record.reservations).toEqual(attempt.reservations)
    expect(found.record.terminal).toMatchObject({
      phase: 'dead',
      reason: 'undeliverable',
    })
    expect(found.record.cleanupComplete).toBe(false)
    expect(found.record.acknowledged).toBe(false)
    expect(attempt.reservations.length).toBeGreaterThan(0)
    for (const reservation of attempt.reservations)
      expect(f.alice.pool.getRecord(reservation.index)?.status).toBe('in-use')
  }

  beforeEach(async () => {
    mockBalances.clear()
    f = await fixture()
    // One exposed attempt: the relay has the exact signed bytes and its answer was lost.
    const finish = jest.spyOn(MonadCanonicalStampClient.prototype, 'finishIntent')
    try {
      await expect(
        f.chain.directMessages.send({
          wallet: f.alice,
          recipient: f.bob.identity.address,
          stampValue: 400_000n,
          items: [{ type: 'text', text: 'original authorized operation' }],
          onAttemptCreated: value => void (digest = value),
        }),
      ).rejects.toBeInstanceOf(MonadStampPendingAttemptError)
      attempt = await finish.mock.results[0].value
    } finally {
      finish.mockRestore()
    }
    expect(f.requests).toHaveLength(1)
    // From here the relay ends delivery of whatever it is handed.
    f.setPhase('undeliverable')
    durablePut.mockClear()
  })
  afterEach(() => f.close())

  it('writes a link once when it first becomes dead and never again while nothing changes', async () => {
    expect(await reconcile()).toEqual({ [digest]: 'dead' })
    const written = linkWrites()
    expect(written).toHaveLength(1)
    const first = JSON.parse(written[0]) as StoredRow
    expect(first).toMatchObject({
      attemptRef: attempt.attemptRef,
      digest,
      // The final status and the relay's reason are saved in the same write (#1323).
      outcome: 'dead',
      reason: 'undeliverable',
    })
    expect(first).not.toHaveProperty('acknowledged')
    expectRetained()

    // Later reconciles in the same session reach the same dead row and change nothing.
    expect(await reconcile()).toEqual({ [digest]: 'dead' })
    expect(
      await f.chain.directMessages.unattributedAttempts({
        wallet: f.alice,
        knownDigests: [],
      }),
    ).toEqual([digest])
    expect(linkWrites()).toEqual(written)
    expectRetained()

    // After a restart the row is the one read back from disk; it still equals the terminal record.
    let afterOne: string | undefined
    await f.restart(async () => {
      afterOne = await storedLinkBytes()
    })
    expect(afterOne).toBe(written[0])
    for (let pass = 0; pass < 3; pass++)
      expect(await reconcile()).toEqual({ [digest]: 'dead' })
    expect(linkWrites()).toEqual(written)
    expectRetained()
    let afterMany: string | undefined
    await f.restart(async () => {
      afterMany = await storedLinkBytes()
    })
    expect(afterMany).toBe(afterOne)

    // The dead attempt was handed to the relay once more, when it was ended, and never after.
    expect(f.requests).toHaveLength(2)
    expect(new Set(f.requests.map(toHex)).size).toBe(1)
    expectRetained()
    // That it no longer holds a later message, which is sent from other accounts, is proved in
    // `monad-canonical-ended-attempt.jest.test.ts` (#1323).
    expect(linkWrites()).toEqual(written)
  })

  it.each([
    [
      'another reason',
      (row: StoredRow): StoredRow => ({ ...row, reason: 'sender_unpublished' }),
    ],
    [
      'no reason',
      (row: StoredRow): StoredRow => ({ ...row, reason: undefined }),
    ],
    [
      'no outcome, as written before the final status existed (#1323)',
      (row: StoredRow): StoredRow => ({ ...row, outcome: undefined }),
    ],
  ])(
    'rewrites a stored link holding %s to the terminal record, once',
    async (_name, change) => {
      expect(await reconcile()).toEqual({ [digest]: 'dead' })
      const settled = linkWrites()
      expect(settled).toHaveLength(1)
      await f.restart(() => rewriteStoredLink(change))
      const stale = linkWrites()[1]
      expect(stale).not.toBe(settled[0])
      durablePut.mockClear()

      expect(await reconcile()).toEqual({ [digest]: 'dead' })
      // The row is written again, once, and what is written is the terminal record's own
      // status and reason. Compared as rows: a removed key is written back in another position.
      const rows = (writes: string[]) => writes.map(value => JSON.parse(value))
      expect(rows(linkWrites())).toEqual(rows(settled))
      expect(await reconcile()).toEqual({ [digest]: 'dead' })
      expect(rows(linkWrites())).toEqual(rows(settled))
      expectRetained()
      expect(f.requests).toHaveLength(2)
    },
  )

  it('still holds, without writing, when the dead attempt loses its link', async () => {
    expect(await reconcile()).toEqual({ [digest]: 'dead' })
    await f.restart(async () => {
      // Only this fixture's link is removed; the authoritative journal stays intact.
      const links = level(join(f.storageLocation, LINK_NAMESPACE))
      await links.del(attempt.attemptRef)
      await links.close()
    })
    durablePut.mockClear()

    await expect(reconcile()).rejects.toBeInstanceOf(CanonicalMessagingHoldError)
    await expect(
      f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: [{ type: 'text', text: 'behind missing link' }],
      }),
    ).rejects.toBeInstanceOf(CanonicalMessagingHoldError)
    expect(linkWrites()).toEqual([])
    expect(f.requests).toHaveLength(2)
    expectRetained()
  })
})
