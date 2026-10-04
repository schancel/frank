import { reactive, nextTick } from 'vue'
import {
  configureMessagingForTest,
  initializeMonadIdentity,
  messagingState,
  messagingWallet,
  refreshMessaging,
  stopMessaging,
  type MessagingDeps,
} from './monad-identity-session'
import { useMonadWallet } from './clients'
import type { ReadinessResult } from './directory-readiness'

const mockInitialize = jest.fn(async () => undefined)
const mockStatus = reactive({
  status: 'fresh',
  revision: 1,
  account: { receipt: { context: { accountId: 'account-1' } } },
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
jest.mock('@frank/wallet/chain/monad-chain', () => ({
  installCanonicalDirectory: jest.fn(),
  loadMonadChainConfigFromEnv: () => ({ relayBaseUrl: 'https://relay.test' }),
}))
jest.mock('@frank/directory-admission/browser', () => ({
  openBrowserDirectoryStore: jest.fn(),
}))
const mockCheck = jest.fn()
jest.mock('./directory-readiness', () => ({
  ...jest.requireActual('./directory-readiness'),
  checkDirectoryReadiness: (...args: unknown[]) => mockCheck(...args),
}))

const participants = {
  'relay-a': 'matched',
  'relay-b': 'matched',
  'bot': 'matched',
} as const
function harness() {
  const wallet = { identity: {} }
  const directory = { network: 'monad-testnet' }
  const close = jest.fn(async () => undefined)
  const uninstall = jest.fn()
  const polling = { stop: jest.fn() }
  const reconcile = { stop: jest.fn() }
  const deps = {
    readiness: {},
    install: jest.fn(() => uninstall),
    startPolling: jest.fn(() => polling),
    startReconcile: jest.fn(() => reconcile),
  } as unknown as MessagingDeps & {
    install: jest.Mock
    startPolling: jest.Mock
    startReconcile: jest.Mock
  }
  const ready: ReadinessResult = {
    status: 'ready',
    participants: { ...participants },
    activation: {
      wallet: wallet as never,
      directory: directory as never,
      revision: 1,
      account: mockStatus.account,
      peerAddress: '0xBot',
      peerSubject: '02' + '11'.repeat(32),
      close,
    },
  }
  return {
    wallet,
    directory,
    close,
    uninstall,
    polling,
    reconcile,
    deps,
    ready,
  }
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await nextTick()
}

beforeEach(async () => {
  jest.clearAllMocks()
  mockStatus.status = 'fresh'
  mockStatus.revision = 1
  await configureMessagingForTest(undefined)
})

test('boot without a ready account checks nothing and exposes no messaging wallet', async () => {
  const h = harness()
  await configureMessagingForTest(h.deps)
  expect(await initializeMonadIdentity()).toBe('skipped')
  expect(mockCheck).not.toHaveBeenCalled()
  expect(messagingWallet()).toBeUndefined()
  expect(() => useMonadWallet()).toThrow(
    'Messaging is pending operator directory installation',
  )
})

test('a pending installation stays visibly pending and starts no poller or directory', async () => {
  const h = harness()
  await configureMessagingForTest(h.deps)
  mockStatus.status = 'ready'
  mockCheck.mockResolvedValue({
    status: 'pending',
    reason: 'participant-unavailable',
    participants: { ...participants, bot: 'unavailable' },
  })
  expect(await initializeMonadIdentity()).toBe('started')
  await settle()
  // Automatic start never enrolls.
  expect(mockCheck.mock.calls[0][1].allowEnrollment).toBe(false)
  expect(messagingState.status).toBe('pending')
  expect(messagingState.reason).toBe('participant-unavailable')
  expect(messagingState.participants.bot).toBe('unavailable')
  expect(h.deps.install).not.toHaveBeenCalled()
  expect(h.deps.startPolling).not.toHaveBeenCalled()
  expect(() => useMonadWallet()).toThrow('pending operator directory')
})

test('verified readiness installs the directory, starts messaging and stops when the account changes', async () => {
  const h = harness()
  await configureMessagingForTest(h.deps)
  mockStatus.status = 'ready'
  await initializeMonadIdentity()
  mockCheck.mockResolvedValue(h.ready)
  await refreshMessaging(true)
  expect(mockCheck.mock.calls.at(-1)![1].allowEnrollment).toBe(true)
  expect(h.deps.install).toHaveBeenCalledWith(h.wallet, h.directory)
  expect(h.deps.startPolling).toHaveBeenCalledWith({ wallet: h.wallet })
  expect(h.deps.startReconcile).toHaveBeenCalledWith({ wallet: h.wallet })
  expect(messagingState.status).toBe('ready')
  expect(messagingState.peerAddress).toBe('0xBot')
  expect(useMonadWallet()).toBe(h.wallet)

  mockCheck.mockResolvedValue({
    status: 'pending',
    reason: 'account-unavailable',
    participants: { ...participants },
  })
  mockStatus.status = 'loading'
  await settle()
  expect(h.polling.stop).toHaveBeenCalledTimes(1)
  expect(h.reconcile.stop).toHaveBeenCalledTimes(1)
  expect(h.uninstall).toHaveBeenCalledTimes(1)
  expect(h.close).toHaveBeenCalledTimes(1)
  expect(messagingState.status).not.toBe('ready')
  expect(() => useMonadWallet()).toThrow('pending operator directory')
})

test('a check superseded by a stop publishes nothing and closes what it opened', async () => {
  const h = harness()
  await configureMessagingForTest(h.deps)
  let release!: (result: ReadinessResult) => void
  mockCheck.mockReturnValue(
    new Promise<ReadinessResult>(resolve => (release = resolve)),
  )
  const running = refreshMessaging(true)
  await settle()
  expect(messagingState.status).toBe('checking')
  await stopMessaging()
  release(h.ready)
  await running
  expect(h.close).toHaveBeenCalledTimes(1)
  expect(h.deps.install).not.toHaveBeenCalled()
  expect(messagingWallet()).toBeUndefined()
})
