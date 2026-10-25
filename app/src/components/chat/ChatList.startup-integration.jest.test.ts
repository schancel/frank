/** @jest-environment jsdom */
/** Real directory lifecycle -> real mailbox poller/store -> real ChatList; only external I/O
 * and UI-library/router boundaries are replaced. No readiness owner is written by this test. */
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { serialize, deserialize } from 'v8'
import { webcrypto } from 'crypto'
import { reactive, defineComponent, h, nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { getBytes } from 'ethers'
import { openBrowserDirectoryStore } from '@frank/directory-admission/browser'
import { createEvmChain } from '@frank/wallet/chain/evm-chain'
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle'
import { activeChain } from '@frank/wallet/chain'
import type { MonadRootBundle } from '@frank/wallet/evm-wallet-material'
import {
  parseCheckpoint,
  serializeCheckpoint,
} from '@frank/cashweb/relay/open-directory'
import {
  createFakeRelay,
  type FakeRelay,
} from '@frank/cashweb/relay/open-directory-fake-relay.testutil'
import rootsVector from '../../../../packages/domain-roots/vectors/domain-roots-v1.json'
import { fixedStampDefault } from '../../../../packages/wallet/oracle/stamp-policy.testutil'
import { discardUnenrolledDirectoryStore } from '../../utils/directory-store-reset'
import {
  configureMessagingForTest,
  initializeMonadIdentity,
  messagingState,
  type MessagingDeps,
} from '../../utils/identity-session'
import { startDirectMessagePolling } from '../../adapters/pinia-chain-adapter'
import { useMailboxStatusStore } from '../../stores/mailbox-status'
import { useChatStore } from '../../stores/chats'
import ChatList from './ChatList.vue'

const mockStatus = reactive({
  status: 'fresh',
  revision: 1,
  account: {} as unknown,
})
jest.mock('../../accounts/session', () => ({
  accountSession: {
    initialize: async () => undefined,
    get state() {
      return mockStatus
    },
    peekWallet: () => undefined,
  },
  get accountStatus() {
    return mockStatus
  },
}))
jest.mock('../../utils/own-profile', () => ({
  syncOwnProfileWithRelay: jest.fn(async () => 'unchanged'),
}))
jest.mock('../../utils/notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('axios', () => ({ __esModule: true, default: jest.fn() }))
jest.mock('vue-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    currentRoute: { value: { path: '/', fullPath: '/' } },
  }),
  useRoute: () => ({ params: {}, query: {} }),
}))
jest.mock('quasar', () => ({
  ...jest.requireActual('quasar'),
  useQuasar: () => ({ screen: { width: 1200 } }),
}))
jest.mock('../../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    relayCursor: jest.fn(async () => 0),
    mostRecentMessageTime: jest.fn(async () => 0),
    quarantineRelayReceipts: jest.fn(async () => undefined),
    suppressedRelayReceipts: jest.fn(async () => new Set<string>()),
    getIterator: async function* () {
      // Empty external message store; cached rows below enter through the public owner.
    },
  }),
}))
// Real directory admission needs platform crypto and cloning APIs omitted by jsdom.
Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
})
globalThis.structuredClone = value => deserialize(serialize(value))
jest.setTimeout(30000)
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

let relay: FakeRelay
const wallets: EvmChainWalletHandle[] = []
async function wallet(index: number) {
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
    walletStorageLocation: false,
  })
  const created = (await chain.createWallet(
    roots(index),
  )) as EvmChainWalletHandle
  wallets.push(created)
  return created
}
const drainDevices: Array<() => Promise<void>> = []
const releaseGates: Array<() => Promise<void>> = []

/** One device: its own IndexedDB and its own local storage. */
function device(live: EvmChainWalletHandle) {
  globalThis.indexedDB = new IDBFactory()
  const saved = new Map<string, string>()
  const uninstall = jest.fn()
  const reconcile = { stop: jest.fn() }
  const requests: Promise<unknown>[] = []
  const closes: Promise<void>[] = []
  const firstClose = deferred<void>(undefined, false)
  let acceptedPublication = false
  let closedStores = 0
  drainDevices.push(async () => {
    // A neutral release of a held PUT can open admission storage only after teardown starts.
    // Wait for its actual response and subsequent close, not only handles already open.
    await Promise.all(requests)
    if (acceptedPublication) await firstClose.promise
    await Promise.all(closes)
  })
  const deps: MessagingDeps = {
    session: { state: mockStatus, getWallet: async () => live },
    relayBaseUrl: RELAY,
    networkTag: 'MONT',
    chainId: 10143n,
    directory: {
      nowNs: () => BigInt(Date.now()) * 1_000_000n,
      fetch: (url, init) => {
        const request = Promise.resolve(relay.fetch(url, init)).then(answer => {
          if (init?.method === 'PUT' && answer.status === 200)
            acceptedPublication = true
          return answer
        })
        requests.push(request)
        return request
      },
      openStore: async options => {
        const closed = deferred<void>(undefined, false)
        closes.push(closed.promise)
        try {
          const store = await openBrowserDirectoryStore(options)
          return {
            ...store,
            close: async () => {
              await store.close()
              closedStores++
              closed.resolve()
              firstClose.resolve()
            },
          }
        } catch (error) {
          closed.reject(error)
          firstClose.reject(error)
          throw error
        }
      },
      discardUnenrolled: discardUnenrolledDirectoryStore,
      checkpoints: {
        load: key => {
          const value = saved.get('c:' + key)
          return value === undefined ? null : parseCheckpoint(value)
        },
        save: (key, checkpoint) =>
          void saved.set('c:' + key, serializeCheckpoint(checkpoint)),
      },
      pins: {
        load: key => saved.get('p:' + key) ?? null,
        save: (key, value) => void saved.set('p:' + key, value),
      },
    },
    // Custody installation is outside this lifecycle/UI characterization. The volatile
    // synthetic wallet cannot install a persistent canonical transport; fetchSince below
    // is the external mailbox boundary exercised by the real poller.
    install: jest.fn(() => uninstall),
    startPolling: options =>
      startDirectMessagePolling({ ...options, intervalMs: 20 }),
    startReconcile: jest.fn(() => reconcile),
    resumeLegacy: jest.fn(),
    retryDelayMs: () => 100,
  }
  return { deps, saved, uninstall, reconcile, closedStores: () => closedStores }
}
const until = async (condition: () => boolean, what: string) => {
  for (let i = 0; i < 1000; i++) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

function deferred<T>(neutral: T, register = true) {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  if (register)
    releaseGates.push(async () => {
      resolve(neutral)
      await promise.catch(() => undefined)
    })
  return { promise, resolve, reject }
}
const passthrough = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('div', slots.default?.()),
})
let view: VueWrapper | undefined
function rendered(): VueWrapper {
  if (!view) throw new Error('ChatList has not been mounted')
  return view
}
function render() {
  view = mount(ChatList, {
    props: { compact: false },
    global: {
      components: Object.fromEntries(
        [
          'QScrollArea',
          'QList',
          'QItem',
          'QItemSection',
          'QItemLabel',
          'QSeparator',
          'QSpace',
          'QBtn',
          'QTooltip',
          'QAvatar',
          'QBadge',
          'QIcon',
          'QSpinner',
          'QMenu',
        ].map(name => [name, passthrough]),
      ),
      stubs: { QDialog: { render: () => null } },
      directives: { 'close-popup': {} },
      mocks: {
        $route: { params: {}, query: {} },
        $i18n: { locale: 'en' },
        $status: { setup: true },
        $t: (key: string, params?: { text?: string }) =>
          params?.text ? `${key}: ${params.text}` : key,
      },
    },
  })
  return view
}
const loading = () =>
  rendered().find('[data-test="chat-list-initial-loading"]').exists()
const error = () =>
  rendered().find('[data-test="chat-list-initial-error"]').text()
beforeEach(async () => {
  setActivePinia(createPinia())
  relay = createFakeRelay({ endpoint: RELAY })
  mockStatus.status = 'fresh'
  mockStatus.revision++
  mockStatus.account = { receipt: { context: { accountId: 'test-account' } } }
  await configureMessagingForTest(undefined)
  jest
    .spyOn(activeChain.directMessages, 'subscribeMailboxStream')
    .mockImplementation(() => () => undefined)
})
async function cleanup() {
  view?.unmount()
  view = undefined
  // Invalidate first so releasing a request cannot install or project an old session.
  mockStatus.status = 'fresh'
  await nextTick()
  await configureMessagingForTest(undefined)
  await Promise.all(releaseGates.splice(0).map(release => release()))
  await Promise.all(drainDevices.splice(0).map(drain => drain()))
  jest.restoreAllMocks()
  for (const w of wallets.splice(0)) await w.close()
}
afterEach(cleanup)

test.each([false, true])(
  'publication failure/retry keeps cached=%s rows and waits for first mailbox success',
  async cached => {
    const alice = await wallet(0)
    const d = device(alice)
    const publication = deferred<void>(undefined)
    const retry = deferred<void>(undefined)
    let publications = 0
    const fetch = d.deps.directory.fetch
    d.deps.directory.fetch = async (url, init) => {
      if (init?.method === 'PUT') {
        publications++
        if (publications === 1) await publication.promise
        else if (publications === 2) await retry.promise
      }
      return fetch(url, init)
    }
    const mailbox = deferred<[]>([])
    const read = jest
      .spyOn(activeChain.directMessages, 'fetchSince')
      .mockImplementation(() => mailbox.promise)
    await configureMessagingForTest(d.deps)
    await initializeMonadIdentity() // installs the real account watcher while custody is fresh
    render()
    mockStatus.status = 'ready'
    await until(() => publications === 1, 'held publication')
    if (cached) {
      useChatStore().sendMessageLocal({
        address: '0x1111111111111111111111111111111111111111',
        senderAddress: activeChain.formatAddress(alice.identity.address),
        index: 'cached-row',
        items: [{ type: 'text', text: 'Cached conversation survives' }],
        outpoints: [],
        status: 'confirmed',
        previousHash: null,
      })
      await until(
        () => rendered().text().includes('Cached conversation survives'),
        'cached row visible',
      )
    }
    expect(loading()).toBe(!cached)
    expect(read).not.toHaveBeenCalled()
    expect(rendered().text()).not.toContain('chatList.noContactMessage')
    publication.reject(new TypeError('directory connection interrupted'))
    await until(
      () => messagingState.reason === 'relay-unreachable',
      'publication failure',
    )
    expect(error()).toContain('mailboxStatus.directory.relay-unreachable')
    if (cached)
      expect(rendered().text()).toContain('Cached conversation survives')
    expect(read).not.toHaveBeenCalled()
    await until(() => publications === 2, 'retry publication')
    retry.resolve()
    await until(() => read.mock.calls.length === 1, 'first mailbox read')
    expect(messagingState.status).toBe('ready')
    expect(useMailboxStatusStore().initialPoll).toBe('pending')
    expect(loading()).toBe(!cached)
    if (cached)
      expect(rendered().text()).toContain('Cached conversation survives')
    expect(rendered().text()).not.toContain('chatList.noContactMessage')
    mailbox.resolve([])
    await until(
      () => useMailboxStatusStore().initialPoll === 'ready',
      'successful mailbox',
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(rendered().text().includes('chatList.noContactMessage')).toBe(
      !cached,
    )
    if (cached)
      expect(rendered().text()).toContain('Cached conversation survives')
    expect(loading()).toBe(false)
  },
)

test('first mailbox failure is visible and a later successful poll clears the error', async () => {
  const d = device(await wallet(0))
  const first = deferred<[]>([]),
    recovery = deferred<[]>([])
  const read = jest
    .spyOn(activeChain.directMessages, 'fetchSince')
    .mockImplementationOnce(() => first.promise)
    .mockImplementation(() => recovery.promise)
  await configureMessagingForTest(d.deps)
  await initializeMonadIdentity() // installs the real account watcher while custody is fresh
  render()
  mockStatus.status = 'ready'
  await until(() => read.mock.calls.length === 1, 'first fetch')
  expect(loading()).toBe(true)
  first.reject(new TypeError('mailbox disconnected'))
  await until(
    () => useMailboxStatusStore().initialPoll === 'error',
    'fetch error',
  )
  expect(error()).toContain('chatList.initialConversationsFailed')
  expect(rendered().text()).not.toContain('chatList.noContactMessage')
  await until(() => read.mock.calls.length === 2, 'recovery fetch')
  expect(error()).toContain('chatList.initialConversationsFailed')
  recovery.resolve([])
  await until(
    () => rendered().text().includes('chatList.noContactMessage'),
    'fetch recovery UI',
  )
  expect(
    rendered().find('[data-test="chat-list-initial-error"]').exists(),
  ).toBe(false)
})

test.each(['resolve', 'reject'] as const)(
  'replaced session ignores old mailbox %s while the new initial poll is held',
  async completion => {
    const d = device(await wallet(0))
    const old = deferred<[]>([]),
      current = deferred<[]>([])
    const read = jest
      .spyOn(activeChain.directMessages, 'fetchSince')
      .mockImplementationOnce(() => old.promise)
      .mockImplementation(() => current.promise)
    await configureMessagingForTest(d.deps)
    await initializeMonadIdentity() // installs the real account watcher while custody is fresh
    render()
    mockStatus.status = 'ready'
    await until(() => read.mock.calls.length === 1, 'old fetch')
    mockStatus.revision++
    mockStatus.account = {
      receipt: { context: { accountId: 'replacement-session' } },
    }
    await until(() => read.mock.calls.length === 2, 'replacement fetch')
    expect(d.uninstall).toHaveBeenCalledTimes(1)
    if (completion === 'resolve') old.resolve([])
    else old.reject(new TypeError('old request failed'))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(useMailboxStatusStore().initialPoll).toBe('pending')
    expect(loading()).toBe(true)
    expect(rendered().text()).not.toContain('chatList.noContactMessage')
    expect(
      rendered().find('[data-test="chat-list-initial-error"]').exists(),
    ).toBe(false)
    current.resolve([])
    await until(
      () => rendered().text().includes('chatList.noContactMessage'),
      'current session completion',
    )
  },
)

test('cleanup drains held publication through its actual admission close without installing stale messaging', async () => {
  const d = device(await wallet(0))
  const held = deferred<void>(undefined)
  const entered = deferred<void>(undefined, false)
  const fetch = d.deps.directory.fetch
  d.deps.directory.fetch = async (url, init) => {
    if (init?.method === 'PUT') {
      entered.resolve()
      await held.promise
    }
    return fetch(url, init)
  }
  const read = jest
    .spyOn(activeChain.directMessages, 'fetchSince')
    .mockResolvedValue([])
  await configureMessagingForTest(d.deps)
  await initializeMonadIdentity()
  render()
  mockStatus.status = 'ready'
  await entered.promise
  expect(loading()).toBe(true)
  // Models the unconditional afterEach path after an assertion interrupts this scenario.
  // No manual gate release, timeout, or sleep is needed to close the real admission owner.
  await cleanup()
  expect(d.closedStores()).toBeGreaterThan(0)
  expect(d.deps.install).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
  expect(messagingState.status).toBe('pending')
})
