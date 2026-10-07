/** @jest-environment node */
/**
 * The messaging session with real typed wallets, the real open directory, the real browser
 * admission store (on fake IndexedDB) and a stand-in relay. Only custody's account session, the
 * poller and the reconciler are mocked.
 */
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { reactive } from 'vue'
import { getBytes } from 'ethers'
import { toHex } from '@frank/codec'
import { openBrowserDirectoryStore } from '@frank/directory-admission/browser'
import * as monadChain from '@frank/wallet/chain/monad-chain'
import {
  createMonadChain,
  type MonadChainWalletHandle,
} from '@frank/wallet/chain/monad-chain'
import { activeChain } from '@frank/wallet/chain'
import type { MonadRootBundle } from '@frank/wallet/monad-wallet-material'
import {
  parseCheckpoint,
  serializeCheckpoint,
} from '@frank/cashweb/relay/open-directory'
import {
  createFakeRelay,
  testAccount,
  type FakeRelay,
} from '@frank/cashweb/relay/open-directory-fake-relay.testutil'
import rootsVector from '../../../packages/domain-roots/vectors/domain-roots-v1.json'
import { discardUnenrolledDirectoryStore } from './directory-store-reset'
import { contactLookupFailure, fetchContactProfile } from './directory-peer'
import {
  configureMessagingForTest,
  initializeMonadIdentity,
  messagingState,
  messagingWallet,
  stopMessaging,
  type MessagingDeps,
} from './monad-identity-session'
import { useMonadWallet } from './clients'

jest.setTimeout(30000)

const mockInitialize = jest.fn(async () => undefined)
const mockStatus = reactive({
  status: 'fresh',
  revision: 1,
  account: { receipt: { context: { accountId: 'account-1' } } } as unknown,
})
jest.mock('../accounts/session', () => ({
  accountSession: { initialize: () => mockInitialize() },
  get accountStatus() {
    return mockStatus
  },
}))
jest.mock('../adapters/pinia-chain-adapter', () => ({
  startDirectMessagePolling: jest.fn(),
  startOutgoingReconciliation: jest.fn(),
}))
jest.mock('@frank/wallet/chain/monad-chain', () => {
  const actual = jest.requireActual('@frank/wallet/chain/monad-chain')
  return {
    ...actual,
    prepareMonadRevisionZeroExport: jest.fn(
      actual.prepareMonadRevisionZeroExport,
    ),
    prepareMonadNextRevisionExport: jest.fn(
      actual.prepareMonadNextRevisionExport,
    ),
  }
})
// The only operations that sign with the account's authentication key.
const signedZero = monadChain.prepareMonadRevisionZeroExport as jest.Mock
const signedNext = monadChain.prepareMonadNextRevisionExport as jest.Mock

const RELAY = 'https://relay-a.example'
function roots(index: number): MonadRootBundle {
  const outputs = rootsVector.vectors[index].outputs
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

let dir: string
let relay: FakeRelay
const wallets: MonadChainWalletHandle[] = []
async function wallet(index: number, name: string) {
  const chain = createMonadChain({
    networkId: 'monad-testnet',
    rpcChain: 'monad-testnet',
    chainId: 10143,
    relayBaseUrl: RELAY,
    networkTag: 'MONT',
    stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
    defaultStampValueWei: 1000n,
    defaultTopicVoteValueWei: 1000n,
    subAccountPoolSize: 0,
    walletStorageLocation: join(dir, name),
  })
  const created = (await chain.createWallet(
    roots(index),
  )) as MonadChainWalletHandle
  wallets.push(created)
  return created
}
/** One device: its own IndexedDB and its own local storage. */
function device(live: MonadChainWalletHandle) {
  globalThis.indexedDB = new IDBFactory()
  const saved = new Map<string, string>()
  const uninstall = jest.fn()
  const polling = { stop: jest.fn() },
    reconcile = { stop: jest.fn() }
  const actual = jest.requireActual(
    '@frank/wallet/chain/monad-chain',
  ) as typeof monadChain
  const deps: MessagingDeps = {
    session: { state: mockStatus, getWallet: async () => live },
    relayBaseUrl: RELAY,
    networkTag: 'MONT',
    chainId: 10143n,
    directory: {
      nowNs: () => BigInt(Date.now()) * 1_000_000n,
      fetch: relay.fetch,
      openStore: options => openBrowserDirectoryStore(options),
      discardUnenrolled: discardUnenrolledDirectoryStore,
      checkpoints: {
        load: key =>
          saved.has('c:' + key)
            ? parseCheckpoint(saved.get('c:' + key)!)
            : null,
        save: (key, checkpoint) =>
          void saved.set('c:' + key, serializeCheckpoint(checkpoint)),
      },
      pins: {
        load: key => saved.get('p:' + key) ?? null,
        save: (key, value) => void saved.set('p:' + key, value),
      },
    },
    install: jest.fn((w, d) => {
      const remove = actual.installCanonicalDirectory(w, d)
      return () => {
        uninstall()
        remove()
      }
    }),
    startPolling: jest.fn(() => polling),
    startReconcile: jest.fn(() => reconcile),
    retryDelayMs: () => 20,
  }
  return { deps, saved, uninstall, polling, reconcile }
}
const until = async (condition: () => boolean, what: string) => {
  for (let i = 0; i < 1000; i++) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}
const subjectOf = (w: MonadChainWalletHandle) =>
  toHex(w.identity.compressedPubKey)

beforeEach(async () => {
  jest.clearAllMocks()
  dir = mkdtempSync(join(tmpdir(), 'messaging-session-'))
  relay = createFakeRelay({ endpoint: RELAY })
  mockStatus.status = 'fresh'
  mockStatus.revision = 1
  mockStatus.account = { receipt: { context: { accountId: 'account-1' } } }
  await configureMessagingForTest(undefined)
})
afterEach(async () => {
  await stopMessaging()
  for (const w of wallets.splice(0)) await w.close()
  rmSync(dir, { recursive: true, force: true })
})

test('without a ready account nothing is published and there is no messaging wallet', async () => {
  const alice = await wallet(0, 'alice')
  await configureMessagingForTest(device(alice).deps)
  expect(await initializeMonadIdentity()).toBe('skipped')
  expect(relay.requests).toEqual([])
  expect(messagingWallet()).toBeUndefined()
  expect(() => useMonadWallet()).toThrow('Messaging is not available yet')
})

test('a ready account publishes its own entry and starts messaging with no user action', async () => {
  const alice = await wallet(0, 'alice')
  const d = device(alice)
  const registerProfile = jest.fn(async () => undefined)
  d.deps.registerProfile = registerProfile
  await configureMessagingForTest(d.deps)
  mockStatus.status = 'ready'
  expect(await initializeMonadIdentity()).toBe('started')
  await until(() => messagingState.status === 'ready', 'messaging')
  expect(registerProfile).toHaveBeenCalledWith({
    relayBaseUrl: RELAY,
    wallet: alice,
  })
  // Exactly one self-signed revision zero, on the configured relay.
  expect(signedZero).toHaveBeenCalledTimes(1)
  expect(signedNext).not.toHaveBeenCalled()
  expect(relay.chain(subjectOf(alice))).toHaveLength(1)
  expect(d.deps.install).toHaveBeenCalledTimes(1)
  expect(d.deps.startPolling).toHaveBeenCalledWith({ wallet: alice })
  expect(d.deps.startReconcile).toHaveBeenCalledWith({ wallet: alice })
  expect(messagingState.reason).toBeNull()
  expect(useMonadWallet()).toBe(alice)
})

test('restoring the account on a second device adopts the published entry instead of signing another', async () => {
  const phone = await wallet(0, 'phone')
  await configureMessagingForTest(device(phone).deps)
  mockStatus.status = 'ready'
  await initializeMonadIdentity()
  await until(() => messagingState.status === 'ready', 'phone messaging')
  const published = relay.chain(subjectOf(phone))
  expect(published).toHaveLength(1)
  signedZero.mockClear()

  // Same roots, a different device: empty IndexedDB, empty local storage. One process cannot
  // hold the same account twice, so the phone is closed first; the relay keeps its entry.
  await configureMessagingForTest(undefined)
  await wallets.pop()!.close()
  const laptop = await wallet(0, 'laptop')
  await configureMessagingForTest(device(laptop).deps)
  await initializeMonadIdentity()
  await until(() => messagingState.status === 'ready', 'laptop messaging')
  expect(signedZero).not.toHaveBeenCalled()
  expect(signedNext).not.toHaveBeenCalled()
  expect(relay.requests.filter(r => r.method === 'PUT')).toHaveLength(1)
  expect(relay.chain(subjectOf(laptop))).toEqual(published)
  expect(useMonadWallet()).toBe(laptop)
})

test('a relay that is down leaves messaging off with a plain reason, and the retry publishes', async () => {
  const alice = await wallet(0, 'alice')
  const d = device(alice)
  await configureMessagingForTest(d.deps)
  relay.down = true
  mockStatus.status = 'ready'
  await initializeMonadIdentity()
  await until(() => messagingState.reason !== null, 'the failure')
  expect(messagingState.status).not.toBe('ready')
  expect(messagingState.reason).toBe('relay-unreachable')
  expect(d.deps.install).not.toHaveBeenCalled()
  expect(d.deps.startPolling).not.toHaveBeenCalled()
  expect(signedZero).not.toHaveBeenCalled()
  // No legacy path: there is simply no messaging wallet.
  expect(() => useMonadWallet()).toThrow('Messaging is not available yet')
  expect(await fetchContactProfile(alice.identity.address)).toBeUndefined()
  expect(contactLookupFailure(alice.identity.address)).toBe('messaging-off')

  relay.down = false
  await until(() => messagingState.status === 'ready', 'the retry')
  expect(messagingState.reason).toBeNull()
  expect(relay.chain(subjectOf(alice))).toHaveLength(1)
  expect(d.deps.install).toHaveBeenCalledTimes(1)
})

test('any published address can be added as a contact, with its key from the directory only', async () => {
  const alice = await wallet(0, 'alice'),
    bob = await wallet(1, 'bob')
  // Bob is just another account that published itself (here: from his own device).
  await configureMessagingForTest(device(bob).deps)
  mockStatus.status = 'ready'
  await initializeMonadIdentity()
  await until(() => messagingState.status === 'ready', 'bob')
  mockStatus.account = { receipt: { context: { accountId: 'account-2' } } }
  await configureMessagingForTest(device(alice).deps)
  await initializeMonadIdentity()
  await until(() => messagingState.status === 'ready', 'alice')

  // A relay-served display profile claims some other key: only its name is used.
  const profile = jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
    address: bob.identity.address,
    pubKey: new Uint8Array(33).fill(7),
    name: 'Bob',
  } as never)
  try {
    const found = await fetchContactProfile(bob.identity.address)
    expect(found?.name).toBe('Bob')
    expect(toHex(found!.pubKey)).toBe(subjectOf(bob))
    expect(contactLookupFailure(bob.identity.address)).toBeNull()

    // No display profile at all: still a contact, from the directory alone.
    profile.mockResolvedValue(undefined as never)
    const bare = await fetchContactProfile(bob.identity.address)
    expect(toHex(bare!.pubKey)).toBe(subjectOf(bob))

    // An address nobody published.
    const stranger = { raw: testAccount(50).address }
    expect(await fetchContactProfile(stranger as never)).toBeUndefined()
    expect(contactLookupFailure(stranger as never)).toBe('not-published')

    // An entry signed by a key that does not hash to the address is refused, whatever the
    // display profile says.
    const victim = testAccount(51),
      mallory = testAccount(52)
    const forged = mallory.sign({
      network: 'monad-testnet',
      revision: 0n,
      predecessor: null,
      issuedAt: {
        seconds: BigInt(Math.floor(Date.now() / 1000) - 60),
        nanoseconds: 0,
      },
      expiresAt: {
        seconds: BigInt(Math.floor(Date.now() / 1000) + 86_400),
        nanoseconds: 0,
      },
      relay: relay.binding,
    })
    relay.tamper = path =>
      path.endsWith(`/address/${victim.address}`) ? forged : undefined
    profile.mockResolvedValue({
      address: { raw: victim.address },
      pubKey: new Uint8Array(33).fill(7),
      name: 'Victim',
    } as never)
    expect(
      await fetchContactProfile({ raw: victim.address } as never),
    ).toBeUndefined()
    expect(contactLookupFailure({ raw: victim.address } as never)).toBe(
      'refused',
    )
  } finally {
    profile.mockRestore()
  }
}, 10000)

test('messaging stops when the account changes and restarts for the new account', async () => {
  const alice = await wallet(0, 'alice')
  const d = device(alice)
  await configureMessagingForTest(d.deps)
  mockStatus.status = 'ready'
  await initializeMonadIdentity()
  await until(() => messagingState.status === 'ready', 'messaging')

  mockStatus.status = 'loading'
  await until(() => d.polling.stop.mock.calls.length === 1, 'the stop')
  expect(d.reconcile.stop).toHaveBeenCalledTimes(1)
  expect(d.uninstall).toHaveBeenCalledTimes(1)
  expect(messagingState.status).not.toBe('ready')
  expect(() => useMonadWallet()).toThrow('Messaging is not available yet')

  mockStatus.status = 'ready'
  await until(() => messagingState.status === 'ready', 'the restart')
  // Reopened from this device's own stores: nothing new is signed or stored at the relay.
  expect(signedZero).toHaveBeenCalledTimes(1)
  expect(relay.requests.filter(r => r.method === 'PUT')).toHaveLength(1)
})

test('an attempt overtaken by a stop installs nothing', async () => {
  const alice = await wallet(0, 'alice')
  const d = device(alice)
  await configureMessagingForTest(d.deps)
  let release!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  const original = relay.fetch
  d.deps.directory.fetch = async (url, init) => {
    await held
    return original(url, init)
  }
  mockStatus.status = 'ready'
  await initializeMonadIdentity()
  await until(() => messagingState.status === 'publishing', 'the attempt')
  mockStatus.status = 'loading'
  await stopMessaging()
  release()
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(d.deps.install).not.toHaveBeenCalled()
  expect(messagingWallet()).toBeUndefined()
  expect(messagingState.status).toBe('pending')
})

test('wiping local storage while IndexedDB holds records triggers automated rebuilding without error', async () => {
  const alice = await wallet(0, 'alice')
  const d = device(alice)
  await configureMessagingForTest(d.deps)
  mockStatus.status = 'ready'
  await initializeMonadIdentity()
  await until(() => messagingState.status === 'ready', 'initial messaging ready')

  // Stop messaging
  mockStatus.status = 'loading'
  await stopMessaging()

  // Simulate wiping localStorage (clear checkpoints and pins) while leaving indexedDB intact
  d.saved.clear()

  // Restart messaging - must automatically rebuild without getting stuck in storage error
  mockStatus.status = 'ready'
  await initializeMonadIdentity()
  await until(() => messagingState.status === 'ready', 'rebuilt messaging ready')
  expect(messagingState.status).toBe('ready')
  expect(messagingState.reason).toBeNull()
})
