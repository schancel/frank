import { fixedStampDefault } from '../../../packages/wallet/oracle/stamp-policy.testutil'
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
import { parseCheckpoint } from '@frank/cashweb/relay/open-directory'
import { openBrowserDirectoryStore } from '@frank/directory-admission/browser'
import * as monadChain from '@frank/wallet/chain/monad-chain'
import { createEvmChain } from '@frank/wallet/chain/monad-chain'
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle'
import { activeChain } from '@frank/wallet/chain'
import type { MonadRootBundle } from '@frank/wallet/monad-wallet-material'
import {
  createFakeRelay,
  testAccount,
} from '@frank/cashweb/relay/open-directory-fake-relay.testutil'
import type { FakeRelay } from '@frank/cashweb/relay/open-directory-fake-relay.testutil'
import rootsVector from '../../../packages/domain-roots/vectors/domain-roots-v1.json'
import { browserDirectoryPersistence } from './directory-persistence'
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
import { hasConversationIdSalt } from '../stores/chats'

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
const wallets: EvmChainWalletHandle[] = []
async function wallet(index: number, name: string) {
  const chain = createEvmChain({
    networkId: 'monad-testnet',
    rpcChain: 'monad-testnet',
    chainId: 10143,
    relayBaseUrl: RELAY,
    networkTag: 'MONT',
    stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
    resolveDefaultStamp: fixedStampDefault(1000n),
    defaultTopicVoteValueWei: 1000n,
    subAccountPoolSize: 0,
    walletStorageLocation: join(dir, name),
  })
  const created = (await chain.createWallet(
    roots(index),
  )) as EvmChainWalletHandle
  wallets.push(created)
  return created
}
/** One device: its own IndexedDB and its own local storage. */
function device(live: EvmChainWalletHandle) {
  globalThis.indexedDB = new IDBFactory()
  const saved = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return saved.size
    },
    clear: () => saved.clear(),
    key: index => [...saved.keys()][index] ?? null,
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => {
      saved.set(key, value)
    },
    removeItem: key => {
      saved.delete(key)
    },
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
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
      ...browserDirectoryPersistence(),
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
    resumeLegacy: jest.fn(),
    retryDelayMs: () => 20,
  }
  return { deps, saved, storage, uninstall, polling, reconcile }
}
const until = async (condition: () => boolean, what: string) => {
  for (let i = 0; i < 1000; i++) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}
const subjectOf = (w: EvmChainWalletHandle) =>
  toHex(w.identity.compressedPubKey)

beforeEach(async () => {
  Reflect.deleteProperty(globalThis, 'localStorage')
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
  // The username is claimed only once the entry it points to has been published.
  const claimUsername = jest.fn(async () => {
    expect(relay.chain(subjectOf(alice))).toHaveLength(1)
  })
  d.deps.claimUsername = claimUsername
  await configureMessagingForTest(d.deps)
  mockStatus.status = 'ready'
  expect(await initializeMonadIdentity()).toBe('started')
  await until(() => messagingState.status === 'ready', 'messaging')
  expect(registerProfile).toHaveBeenCalledWith({
    relayBaseUrl: RELAY,
    wallet: alice,
  })
  expect(claimUsername).toHaveBeenCalledTimes(1)
  expect(claimUsername).toHaveBeenCalledWith({
    relayBaseUrl: RELAY,
    network: 'monad-testnet',
    wallet: alice,
  })
  await claimUsername.mock.results[0].value
  // Exactly one self-signed revision zero, on the configured relay.
  expect(signedZero).toHaveBeenCalledTimes(1)
  expect(signedNext).not.toHaveBeenCalled()
  expect(relay.chain(subjectOf(alice))).toHaveLength(1)
  expect(d.deps.install).toHaveBeenCalledTimes(1)
  expect(d.deps.startPolling).toHaveBeenCalledWith({ wallet: alice })
  expect(d.deps.startReconcile).toHaveBeenCalledWith({ wallet: alice })
  // The account is open and can send its notes: transactions the wallet signed earlier and
  // did not finish are picked up now, whatever screen is showing.
  expect(d.deps.resumeLegacy).toHaveBeenCalledTimes(1)
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
  expect(d.deps.resumeLegacy).not.toHaveBeenCalled()
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

test('the conversation-ID salt comes with the wallet, not with the relay, and goes only with the account', async () => {
  const alice = await wallet(0, 'alice')
  const d = device(alice)
  // The relay never answers: messaging cannot become ready.
  d.deps.directory.fetch = () => new Promise<never>(() => undefined)
  d.deps.registerProfile = () => new Promise<never>(() => undefined)
  await configureMessagingForTest(d.deps)
  expect(hasConversationIdSalt()).toBe(false)
  mockStatus.status = 'ready'
  void initializeMonadIdentity()
  // Installed as soon as the wallet is at hand, so a chat opened now gets its real ID.
  await until(() => hasConversationIdSalt(), 'the salt')
  expect(messagingState.status).not.toBe('ready')
  expect(d.deps.install).not.toHaveBeenCalled()

  // A messaging restart keeps it: the account is still there.
  await stopMessaging()
  expect(hasConversationIdSalt()).toBe(true)

  // It goes when the account does.
  mockStatus.status = 'loading'
  await stopMessaging()
  expect(hasConversationIdSalt()).toBe(false)
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

test('missing local continuity while IndexedDB holds records fails visibly without rebuilding', async () => {
  const alice = await wallet(0, 'alice')
  const d = device(alice)
  await configureMessagingForTest(d.deps)
  mockStatus.status = 'ready'
  await initializeMonadIdentity()
  await until(
    () => messagingState.status === 'ready',
    'initial messaging ready',
  )

  // Stop messaging
  mockStatus.status = 'loading'
  await stopMessaging()

  // Simulate wiping localStorage (clear checkpoints and pins) while leaving indexedDB intact
  d.saved.clear()

  // Reopen must preserve the existing IndexedDB records and report missing continuity.
  mockStatus.status = 'ready'
  await initializeMonadIdentity()
  await until(
    () => messagingState.reason === 'storage',
    'visible restoration failure',
  )
  expect(messagingState.reason).toBe('storage')
  expect(messagingWallet()).toBeUndefined()
})

test('missing IndexedDB while local storage retains checkpoint fails visibly without rebuilding', async () => {
  const alice = await wallet(0, 'alice')
  const d = device(alice)
  await configureMessagingForTest(d.deps)
  mockStatus.status = 'ready'
  await initializeMonadIdentity()
  await until(
    () => messagingState.status === 'ready',
    'initial messaging ready',
  )

  // Stop messaging
  mockStatus.status = 'loading'
  await stopMessaging()

  // Wipe IndexedDB while leaving localStorage (checkpoints and pins) intact
  globalThis.indexedDB = new IDBFactory()

  // Reopen must preserve the checkpoint and report the missing admission database.
  mockStatus.status = 'ready'
  await initializeMonadIdentity()
  await until(
    () => messagingState.reason === 'storage',
    'visible restoration failure',
  )
  expect(messagingState.reason).toBe('storage')
  expect(messagingWallet()).toBeUndefined()
})
test('directory installation starts independent feature lifetime and stop retains its cleanup', async () => {
  const alice = await wallet(0, 'feature-owner')
  const d = device(alice)
  let release!: () => void
  const pending = new Promise<void>(resolve => {
    release = resolve
  })
  const stop = jest.fn(() => pending)
  const start = jest.fn(() => ({ stop }))
  d.deps.startNegotiation = start
  await configureMessagingForTest(d.deps)
  mockStatus.status = 'ready'
  await initializeMonadIdentity()
  await until(() => messagingState.status === 'ready', 'installed feature')
  expect(start).toHaveBeenCalledWith({
    wallet: alice,
    revision: 1,
    account: mockStatus.account,
  })
  let closed = false
  const cleanup = stopMessaging().then(() => {
    closed = true
  })
  expect(stop).toHaveBeenCalledTimes(1)
  expect(d.polling.stop).toHaveBeenCalledTimes(1)
  await new Promise(resolve => setImmediate(resolve))
  expect(closed).toBe(false)
  release()
  await cleanup
  expect(closed).toBe(true)
})

test.each([
  'pin-read',
  'pin-write',
  'checkpoint-read',
  'checkpoint-write',
  'malformed-checkpoint',
])(
  'production persistence %s failure prevents messaging installation and preserves evidence',
  async fault => {
    const alice = await wallet(0, 'alice')
    const d = device(alice)
    await configureMessagingForTest(d.deps)
    mockStatus.status = 'ready'
    await initializeMonadIdentity()
    await until(() => messagingState.status === 'ready', 'initial entry')
    mockStatus.status = 'loading'
    await stopMessaging()
    const before = new Map(d.saved)
    const checkpointKey = [...d.saved.keys()].find(key =>
      key.startsWith('frank-directory-checkpoint:'),
    )!
    if (fault === 'malformed-checkpoint') d.saved.set(checkpointKey, '{broken')
    if (fault === 'pin-write') {
      // The required write is pending clearing after a valid, already accepted relay head.
      const head = relay.chain(subjectOf(alice))[0]
      d.saved.set(
        `frank-directory-pin:pending:monad-testnet:${alice.identity.address.raw.toLowerCase()}`,
        toHex(head),
      )
    }
    const reads = d.storage.getItem.bind(d.storage)
    const writes = d.storage.setItem.bind(d.storage)
    jest.spyOn(d.storage, 'getItem').mockImplementation(key => {
      if (
        (fault === 'pin-read' && key.startsWith('frank-directory-pin:')) ||
        (fault === 'checkpoint-read' &&
          key.startsWith('frank-directory-checkpoint:'))
      )
        throw new Error('owned storage read failure')
      return reads(key)
    })
    jest.spyOn(d.storage, 'setItem').mockImplementation((key, value) => {
      if (
        fault === 'checkpoint-write' &&
        key.startsWith('frank-directory-checkpoint:')
      )
        throw new Error('owned storage write failure')
      writes(key, value)
    })
    jest.spyOn(d.storage, 'removeItem').mockImplementation(key => {
      if (fault === 'pin-write') throw new Error('owned pin write failure')
      d.saved.delete(key)
    })
    const remove = jest.spyOn(indexedDB, 'deleteDatabase')
    jest.clearAllMocks()
    mockStatus.status = 'ready'
    await initializeMonadIdentity()
    await until(
      () => messagingState.reason === 'storage',
      'visible storage failure',
    )
    expect(messagingWallet()).toBeUndefined()
    expect(d.deps.install).not.toHaveBeenCalled()
    expect(d.deps.startPolling).not.toHaveBeenCalled()
    expect(d.deps.startReconcile).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    for (const [key, value] of before) {
      if (fault === 'pin-write' && key === checkpointKey) {
        const prior = parseCheckpoint(value)
        const current = parseCheckpoint(d.saved.get(key)!)
        expect({ ...current, checkedTime: prior.checkedTime }).toEqual(prior)
        expect(current.checkedTime.seconds >= prior.checkedTime.seconds).toBe(
          true,
        )
      } else if (fault !== 'malformed-checkpoint' || key !== checkpointKey) {
        expect(d.saved.get(key)).toBe(value)
      }
    }
  },
)

test.each(['pin', 'checkpoint'] as const)(
  'first-contact production %s save failure retains interruption evidence across restart',
  async fault => {
    const alice = await wallet(0, 'alice')
    const d = device(alice)
    const set = d.storage.setItem.bind(d.storage)
    const fail = jest
      .spyOn(d.storage, 'setItem')
      .mockImplementation((key, value) => {
        if (
          key.startsWith(
            fault === 'pin'
              ? 'frank-directory-pin:monad-testnet:'
              : 'frank-directory-checkpoint:',
          )
        )
          throw new Error('owned first-contact write failure')
        set(key, value)
      })
    await configureMessagingForTest(d.deps)
    mockStatus.status = 'ready'
    await initializeMonadIdentity()
    await until(
      () => messagingState.reason === 'storage',
      'required save failure',
    )
    expect(d.deps.install).not.toHaveBeenCalled()
    expect(
      [...d.saved.keys()].some(key =>
        key.startsWith('frank-directory-pin:pending:'),
      ),
    ).toBe(true)
    mockStatus.status = 'loading'
    await stopMessaging()
    const evidence = new Map(d.saved)
    fail.mockRestore()
    mockStatus.status = 'ready'
    await initializeMonadIdentity()
    await until(
      () =>
        fault === 'pin'
          ? messagingState.status === 'ready'
          : messagingState.reason === 'storage',
      'safe reopen outcome',
    )
    if (fault === 'checkpoint') {
      expect(d.saved).toEqual(evidence)
      expect(d.deps.install).not.toHaveBeenCalled()
      expect(messagingWallet()).toBeUndefined()
    }
    expect(signedZero).toHaveBeenCalledTimes(1)
  },
)

test('entry refusal attempts no pin or pending clearing and installs no messaging effects', async () => {
  const alice = await wallet(0, 'alice')
  const d = device(alice)
  await configureMessagingForTest(d.deps)
  mockStatus.status = 'ready'
  await initializeMonadIdentity()
  await until(() => messagingState.status === 'ready', 'initial entry')
  mockStatus.status = 'loading'
  await stopMessaging()
  const pinKey = [...d.saved.keys()].find(key =>
    key.startsWith('frank-directory-pin:monad-testnet:'),
  )!
  d.saved.set(
    pinKey.replace('frank-directory-pin:', 'frank-directory-pin:pending:'),
    toHex(relay.chain(subjectOf(alice))[0]),
  )
  const before = new Map(d.saved)
  const save = jest.spyOn(d.deps.directory.pins, 'save')
  relay.tamper = path =>
    path.endsWith('/head') ? new Uint8Array([1, 2, 3]) : undefined
  jest.clearAllMocks()
  mockStatus.status = 'ready'
  await initializeMonadIdentity()
  await until(
    () => messagingState.reason === 'entry-refused',
    'visible refusal',
  )
  expect(d.saved).toEqual(before)
  expect(save).not.toHaveBeenCalled()
  expect(d.deps.install).not.toHaveBeenCalled()
  expect(d.deps.startPolling).not.toHaveBeenCalled()
  expect(d.deps.startReconcile).not.toHaveBeenCalled()
  expect(messagingWallet()).toBeUndefined()
})
