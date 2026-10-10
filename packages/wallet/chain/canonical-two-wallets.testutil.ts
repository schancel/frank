/**
 * Offline stand-ins and a two-wallet table for tests that play blackjack through real typed
 * wallets and the canonical direct-message path. Copied from the fixture of
 * `monad-chain-canonical-dm.jest.test.ts`: real typed custody, real Level journals, real directory
 * admission, real sealing/opening and real stamp funding; only the chain RPC and the relay's HTTP
 * surface are stand-ins.
 *
 * A test file mocks three modules with the factories below (Jest hoists `jest.mock`, so the calls
 * themselves must be in the test file):
 *
 *   jest.mock('<wallet>/monad-provider', () => require('<this file>').offlineProviderModule())
 *   jest.mock('<wallet>/monad-http', () => require('<this file>').offlineHttpModule())
 *   jest.mock('@frank/cashweb/relay/monad-mailbox-client', () =>
 *     require('<this file>').offlineMailboxModule())
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { computeAddress, getBytes, hexlify } from 'ethers'
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
  createEvmChain,
  installCanonicalDirectory,
  prepareMonadRevisionZeroExport,
  type CanonicalDirectory,
} from "./monad-chain";
import type { EvmChainConfig } from "./evm-chain-config";
import type { EvmChainWalletHandle } from "../evm-wallet-handle";
import { InMemoryNativeTransactionAttemptStore } from './chain-wallet'
import {
  foldHand,
  handEventsOf,
  type HandEvent,
  type HandItem,
  type HandState,
} from '../message-item-plugins/blackjack/hand'
import { withDefaultMessageItems } from './message-items.testutil'

export const START_BALANCE = 10n ** 18n
export const STAMP = 1_000n
export interface InboxRecord {
  delivery: Uint8Array
  context: Uint8Array
  submissionIdentity: string
  timestampMs: number
}

/** Offline chain state: the balance of every account, moved by submitted transfers. */
export const mockBalances = new Map<string, bigint>()
export const mockFunded: { from: string; to: string; value: bigint }[] = []
/** Every wallet's relay mailbox, by subject. */
export const mailboxes = new Map<string, InboxRecord[]>()
/**
 * Every request the offline stand-ins served, in order: JSON-RPC methods the wallet's provider
 * performed, and the calls its chain HTTP client made. A test that needs "zero requests" clears
 * these, acts, and compares; it also makes one real call to show the counters can move.
 */
export const providerRequests: string[] = []
export const chainHttpRequests: string[] = []
/** Raw transactions the wallet's provider broadcast itself (a native send), mined at once. */
export const providerBroadcasts: { from: string; to: string; value: bigint }[] = []
/**
 * OPT-IN provider stand-ins. A suite that sends native transactions through the wallet's own
 * provider calls `useProviderStandIns()` (in `beforeEach`) so `broadcastTransaction` and
 * `getBlockNumber` are answered. Without it those two calls throw "unexpected provider call",
 * which is what every other importer of this fixture relied on before they were added.
 */
const providerStandIns = { enabled: false }
export function useProviderStandIns(enabled = true) {
  providerStandIns.enabled = enabled
}
/**
 * The offline chain's transactions, shared by the wallet's provider stand-in and the relay
 * stand-in (a relay broadcasts the payments of a message it stores). `mined` holds what is in a
 * block: hash -> sender. A test turns the knobs:
 * - `nodeDown`: every broadcast and every read of a transaction or nonce fails (the node is
 *   unreachable); balances and fee reads still answer.
 * - `relayBroadcasts`: whether the relay stand-in broadcasts the payments of a delivered message.
 * - `walletBroadcasts`: raw transactions the WALLET's provider was asked to broadcast, in order.
 */
export const offlineChain = {
  mined: new Map<string, string>(),
  nodeDown: false,
  /** Only broadcasts fail; reads answer. */
  broadcastDown: false,
  relayBroadcasts: true,
  walletBroadcasts: [] as string[],
  /** The next transaction mined is included and REVERTED: nonce consumed, value not moved. */
  revertNext: false,
  reverted: new Set<string>(),
  /** What the node answers for `eth_gasPrice`: what a transfer is charged per gas. Zero by
   * default, so a suite's stamps of a few wei are not below the fee floor; a test of the floor
   * sets it. The fee CAP (2 x base fee 1 + tip 1 = 3) is separate and unchanged. */
  gasPrice: 0n,
  reset() {
    this.gasPrice = 0n
    this.revertNext = false
    this.reverted.clear()
    this.mined.clear()
    this.nodeDown = false
    this.broadcastDown = false
    this.relayBroadcasts = true
    this.walletBroadcasts.length = 0
  },
  /** Puts a signed transfer in a block, once: moves its value and consumes its nonce. */
  mine(raw: string): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const tx = require('ethers').Transaction.from(raw)
    if (this.mined.has(tx.hash)) return tx.hash
    const to = tx.to.toLowerCase(),
      from = tx.from.toLowerCase()
    // One nonce, one transaction: a second transaction at a used nonce never lands.
    if ([...this.mined.values()].filter(a => a === from).length > tx.nonce)
      throw new Error('nonce too low')
    if (this.revertNext) {
      this.revertNext = false
      this.reverted.add(tx.hash)
    } else {
      mockBalances.set(to, (mockBalances.get(to) ?? 0n) + tx.value)
      mockBalances.set(from, (mockBalances.get(from) ?? 0n) - tx.value)
    }
    this.mined.set(tx.hash, from)
    return tx.hash
  },
}

export function offlineProviderModule() {
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
        providerRequests.push(request.method)
        if (request.method === 'getBalance')
          return mockBalances.get(request.address!.toLowerCase()) ?? 0n
        if (request.method === 'broadcastTransaction') {
          const raw = (request as unknown as { signedTransaction: string })
            .signedTransaction
          const tx = ethers.Transaction.from(raw)
          offlineChain.walletBroadcasts.push(raw)
          if (offlineChain.nodeDown || offlineChain.broadcastDown)
            throw new Error('node unreachable')
          if (offlineChain.mined.has(tx.hash)) throw new Error('already known')
          offlineChain.mine(raw)
          providerBroadcasts.push({
            from: tx.from.toLowerCase(),
            to: tx.to.toLowerCase(),
            value: tx.value,
          })
          return tx.hash
        }
        if (request.method === 'getTransactionReceipt') {
          if (offlineChain.nodeDown) throw new Error('node unreachable')
          const hash = (request as unknown as { hash: string }).hash
          const from = offlineChain.mined.get(hash)
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
            status: offlineChain.reverted.has(hash) ? '0x0' : '0x1',
            type: '0x2',
          }
        }
        if (request.method === 'getBlockNumber') return 1
        // The offline node keeps no transaction bodies: one it has not mined it does not know.
        if (request.method === 'getTransaction') {
          if (offlineChain.nodeDown) throw new Error('node unreachable')
          return null
        }
        if (request.method === 'getTransactionCount') {
          if (offlineChain.nodeDown) throw new Error('node unreachable')
          const address = request.address!.toLowerCase()
          return [...offlineChain.mined.values()].filter(a => a === address)
            .length
        }
        if (request.method === 'estimateGas') return 50_000n
        if (request.method === 'getGasPrice') return offlineChain.gasPrice
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
}

/** Offline chain: a submitted transfer is mined at once and moves its value. */
export function offlineHttpModule() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ethers = require('ethers')
  const mined = new Set<string>()
  return {
    ...jest.requireActual('../monad-http'),
    MonadHttpClient: class {
      async submitRawTransaction(raw: string) {
        chainHttpRequests.push('submitRawTransaction')
        const tx = ethers.Transaction.from(raw)
        const to = tx.to.toLowerCase()
        mockBalances.set(to, (mockBalances.get(to) ?? 0n) + tx.value)
        const from = tx.from.toLowerCase()
        mockBalances.set(from, (mockBalances.get(from) ?? 0n) - tx.value)
        mockFunded.push({ from: tx.from.toLowerCase(), to, value: tx.value })
        mined.add(tx.hash)
        return tx.hash
      }
      async getTransactionReceipt(hash: string) {
        chainHttpRequests.push('getTransactionReceipt')
        return mined.has(hash) ? { status: 'success' } : undefined
      }
      destroy() {
        return undefined
      }
    },
  }
}

/** The relay's mailbox read: whatever was delivered to the asking subject since `sinceMs`. */
export function offlineMailboxModule() {
  const getInbox = async (auth: { subject: string; sinceMs?: number }) => ({
    records: (mailboxes.get(auth.subject) ?? []).filter(
      record => record.timestampMs > (auth.sinceMs ?? 0),
    ),
  })
  return {
    ...jest.requireActual('@frank/cashweb/relay/monad-mailbox-client'),
    fetchCanonicalInboxPage: jest.fn(getInbox),
    fetchMonadMailboxInboxPage: jest.fn(getInbox),
    fetchMonadMailboxInbox: jest.fn(async (params: any) => {
      const records = (mailboxes.get(params.subject) ?? []).filter(
        record => record.timestampMs > (params.sinceMs ?? 0),
      )
      return { messages: records }
    }),
    fetchCanonicalRecoveryPage: jest.fn(async () => ({ records: [] })),
  }
}

const RELAY = 'https://relay-a.example'
const NOW = { seconds: 100n, nanoseconds: 0 }
export function roots(index: number): MonadRootBundle {
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

/** `overrides` replaces fields of the chain configuration both wallets are opened with. */
export async function fixture(overrides: Partial<EvmChainConfig> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'chain-blackjack-'))
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
    // The stub node never mines on its own: a native send looks once and returns.
    nativeInclusionWaitMs: 0,
    walletStorageLocation: join(directory, 'wallet'),
    ...overrides,
  }
  const chain = withDefaultMessageItems(createEvmChain(config))
  const alice = (await chain.createWallet(roots(0))) as EvmChainWalletHandle,
    bob = (await chain.createWallet(roots(1))) as EvmChainWalletHandle
  // Both players hold spendable money in their own account; stamps are funded from it.
  for (const wallet of [alice, bob])
    mockBalances.set(
      (await wallet.getReceiveAddress()).raw.toLowerCase(),
      START_BALANCE,
    )
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
  /** The mailbox the relay stores the next delivered message in. */
  let deliverTo: InboxRecord[] | undefined
  let clock = 1_000
  let phase: 'delivered' | 'retained' | 'fail' = 'delivered'
  /** Opt-in barrier armed by `holdNextRelayRequest`: the next request waits here. */
  let gate: { entered: () => void; opened: Promise<void> } | undefined
  const fetch: CanonicalFetch = async (url, init) => {
    if (gate && (init.method === 'POST' || init.method === 'PUT')) {
      const held = gate
      gate = undefined
      held.entered()
      await held.opened
    }
    if (
      (url !== RELAY + '/message' && url !== RELAY + '/message/monad/cbor') ||
      (init.method !== 'POST' && init.method !== 'PUT')
    )
      throw new Error(`unexpected relay request ${init.method} ${url}`)
    if (phase === 'fail') throw new Error('relay unreachable')
    const body = new Uint8Array(init.body!)
    requests.push({ body, contentType: init.headers['Content-Type'] })
    const restored = restoreCanonicalRequest({
      body,
      contentType: init.headers['Content-Type'],
    })
    // A relay that stores a message broadcasts its payments, once each.
    if (phase === 'delivered' && offlineChain.relayBroadcasts)
      for (const raw of restored.parts.transactions) {
        try {
          offlineChain.mine(hexlify(raw))
        } catch {
          // The relay only logs a broadcast it could not make.
        }
      }
    if (phase === 'delivered' && deliverTo)
      deliverTo.push({
        delivery: restored.parts.delivery,
        context: restored.parts.context,
        submissionIdentity: restored.identity.submission_identity,
        timestampMs: ++clock,
      })
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
  return {
    chain,
    /** The configuration both wallets were opened with. */
    config,
    alice,
    bob,
    /** The temp directory holding the wallets' storage (`<root>/wallet-evm-<address>`). */
    root: directory,
    requests,
    setPhase: (next: typeof phase) => (phase = next),
    /**
     * Makes the NEXT message relay request (a POST or PUT) stay unanswered until the test lets it
     * go: the request is in flight from the wallet's point of view. `entered` resolves when the
     * relay stand-in has been asked; `release(answer)` lets that one request proceed and answer
     * as `answer` (the phase it should see; default: the phase in force at release). No timers.
     * Nothing changes for a test that never calls this.
     */
    holdNextRelayRequest: () => {
      let entered!: () => void
      let open!: () => void
      const hold = {
        entered: new Promise<void>(resolve => (entered = resolve)),
        opened: new Promise<void>(resolve => (open = resolve)),
        isEntered: false,
      }
      void hold.entered.then(() => (hold.isEntered = true))
      gate = { entered, opened: hold.opened }
      return {
        entered: hold.entered,
        hasEntered: () => hold.isEntered,
        release: (answer?: typeof phase) => {
          if (answer) phase = answer
          open()
        },
      }
    },
    setMailbox: (next: InboxRecord[] | undefined) => (deliverTo = next),
    directoryFor,
    close: async () => {
      await alice.close()
      await bob.close()
      for (const store of stores) await store.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

export type Fixture = Awaited<ReturnType<typeof fixture>>

/** One wallet at the table. It knows only what it sent and what its mailbox delivered. */
export class Seat {
  readonly events: HandEvent[] = []
  readonly seeds = new Map<string, string>()
  readonly mailbox: InboxRecord[] = []
  private readonly seen = new Set<string>()
  peer!: Seat
  since = 0
  /** Every stamp this wallet paid, in order. */
  readonly paid: bigint[] = []
  /** Money this wallet received as stamps, per payload digest, as its own wallet verified it. */
  readonly received = new Map<string, bigint>()
  constructor(
    private readonly f: Fixture,
    readonly wallet: EvmChainWalletHandle,
  ) {
    mailboxes.set(toHex(wallet.identity.compressedPubKey), this.mailbox)
  }
  get address(): string {
    return this.wallet.identity.address.raw
  }
  balance(): Promise<bigint> {
    return this.wallet.getBalance()
  }
  private record(event: HandEvent) {
    if (this.seen.has(event.digest)) return
    this.seen.add(event.digest)
    this.events.push(event)
  }
  async send(item: HandItem, stampWei = STAMP) {
    this.f.setMailbox(this.peer.mailbox)
    const sent = await this.f.chain.directMessages.send({
      wallet: this.wallet,
      recipient: this.peer.wallet.identity.address,
      items: [item],
      stampValue: stampWei,
    })
    this.f.setMailbox(undefined)
    this.paid.push(sent.stampPayments.reduce((sum, p) => sum + p.valueWei, 0n))
    for (const event of handEventsOf({
      items: [item],
      senderAddress: this.address,
      recipientAddress: this.peer.address,
      stampValueWei: sent.stampValueWei,
      payloadDigest: sent.payloadDigest,
    }))
      this.record(event)
    return sent
  }
  async poll() {
    const messages = await this.f.chain.directMessages.fetchSince({
      wallet: this.wallet,
      sinceMs: this.since,
    })
    for (const message of messages) {
      this.since = Math.max(this.since, message.receivedTime)
      this.received.set(message.payloadDigest, message.stampValueWei)
      for (const event of handEventsOf({
        items: message.items,
        senderAddress: message.senderAddress.raw,
        recipientAddress: message.recipientAddress.raw,
        stampValueWei: message.stampValueWei,
        payloadDigest: message.payloadDigest,
      }))
        this.record(event)
    }
  }
  hand(gameId: string): HandState | undefined {
    return foldHand(this.events.filter(e => e.item.gameId === gameId)).state
  }
  totalReceived(): bigint {
    return [...this.received.values()].reduce((a, b) => a + b, 0n)
  }
}

/** Two funded wallets that have admitted each other, seated at one table. */
export async function table() {
  offlineChain.reset()
  mockBalances.clear()
  mockFunded.length = 0
  mailboxes.clear()
  const f = await fixture()
  installCanonicalDirectory(
    f.alice,
    await f.directoryFor('alice', f.alice, f.bob),
  )
  installCanonicalDirectory(f.bob, await f.directoryFor('bob', f.bob, f.alice))
  const alice = new Seat(f, f.alice)
  const bob = new Seat(f, f.bob)
  alice.peer = bob
  bob.peer = alice
  return { f, alice, bob }
}
