/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node", "node-addons"]}
 */

const mockRelayClient = { setToken: jest.fn() }
const mockGetRelayClient = jest.fn(async () => ({
  client: mockRelayClient,
  observables: { connected: false },
}))
const mockUseRelayClientStore = jest.fn(() => ({
  restored: Promise.resolve(true),
  token: '',
}))
let mockProfileName: string | undefined = 'Monad user'
const mockAccountStatus = { status: 'ready' }
jest.mock('../accounts/session', () => ({
  accountStatus: mockAccountStatus,
  accountSession: {
    initialize: jest.fn(async () => undefined),
    setStandby: jest.fn(),
  },
}))
const mockHasOtherExtensionViews = jest.fn(
  async (): Promise<boolean | null> => null,
)
jest.mock('../../src-bex/runtime-adapter', () => ({
  hasOtherExtensionViews: () => mockHasOtherExtensionViews(),
}))
const mockLegacyWallet = { setXPrivKey: jest.fn() }
const mockLegacyWalletConstructor = jest.fn(() => mockLegacyWallet)

jest.mock('../utils/constants', () => ({
  defaultRelayUrl: 'http://legacy.invalid',
  chronikServers: [],
}))
jest.mock(
  'src/utils/runtime-mode',
  () => ({
    monadModeEnabled: () => true,
  }),
  { virtual: true },
)
jest.mock('@frank/cashweb/legacy-wallet', () => ({
  Wallet: mockLegacyWalletConstructor,
}))
jest.mock('../adapters/pinia-relay-adapter', () => ({
  getRelayClient: mockGetRelayClient,
}))
jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({}),
}))
jest.mock('../adapters/level-utxo-store', () => ({
  store: Promise.resolve({}),
}))
jest.mock('src/utils/clients', () => ({
  useWallet: (wallet: unknown) => wallet,
  useRelayClient: (client: unknown) => client,
}))
jest.mock('src/stores/relay-client', () => ({
  useRelayClientStore: mockUseRelayClientStore,
}))

const restoredStore = () => ({ restored: Promise.resolve(true) })
jest.mock('src/stores/wallet', () => ({
  useWalletStore: () => ({
    ...restoredStore(),
    seedPhrase: 'test seed',
    xPrivKey: undefined,
  }),
}))
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => ({
    ...restoredStore(),
    profile: { name: mockProfileName },
  }),
}))
jest.mock('src/stores/contacts', () => ({
  useContactStore: restoredStore,
}))
jest.mock('src/stores/appearance', () => ({
  useAppearanceStore: restoredStore,
}))
jest.mock('src/stores/forum', () => ({ useForumStore: restoredStore }))
jest.mock('src/stores/chats', () => ({ useChatStore: restoredStore }))
jest.mock('src/stores/topics', () => ({ useTopicStore: restoredStore }))
jest.mock('src/stores/settings', () => ({ useSettingsStore: restoredStore }))
const mockTabCoordinatorInit = jest.fn(async () => undefined)
const mockTabCoordinator = {
  init: mockTabCoordinatorInit,
  otherTabActive: false,
  deferToActiveExtensionView: jest.fn(async () => false),
}
jest.mock('../stores/tab-coordinator', () => ({
  useTabCoordinatorStore: () => mockTabCoordinator,
}))

import { Quasar } from 'quasar'
import setupApis from './setup-apis'
import { accountSession } from '../accounts/session'
import { startupRestoration } from './startup-state'

describe('setup-apis in Monad mode', () => {
  beforeEach(() => {
    mockTabCoordinatorInit.mockClear()
    mockTabCoordinator.otherTabActive = false
    mockTabCoordinator.deferToActiveExtensionView.mockReset()
    mockTabCoordinator.deferToActiveExtensionView.mockResolvedValue(false)
    mockHasOtherExtensionViews.mockReset()
    mockHasOtherExtensionViews.mockResolvedValue(null)
    jest.mocked(accountSession.initialize).mockClear()
    jest.mocked(accountSession.setStandby).mockClear()
    // This browser boot fixture resolves Quasar's SSR build under Jest.
    jest.spyOn(Quasar.lang, 'set').mockImplementation(() => undefined)
  })
  afterEach(() => jest.restoreAllMocks())

  it('propagates account initialization errors after successful restoration', async () => {
    const failure = new Error('account initialization failed')
    jest.mocked(accountSession.initialize).mockRejectedValueOnce(failure)
    await expect(
      setupApis({ app: { config: { globalProperties: {} } } } as never),
    ).rejects.toBe(failure)
    expect(startupRestoration.value.phase).toBe('restored')
  })

  it('restores shared state without constructing or exposing the Lotus stack', async () => {
    const globalProperties: Record<string, unknown> = {}

    await setupApis({
      app: { config: { globalProperties } },
    } as never)

    expect(globalProperties.$status).toMatchObject({
      loaded: true,
      setup: true,
    })
    expect(globalProperties).not.toHaveProperty('$wallet')
    expect(globalProperties).not.toHaveProperty('$indexer')
    expect(globalProperties).not.toHaveProperty('$relayClient')
    expect(globalProperties).not.toHaveProperty('$relay')
    expect(mockLegacyWalletConstructor).not.toHaveBeenCalled()
    expect(mockGetRelayClient).not.toHaveBeenCalled()
    expect(mockUseRelayClientStore).not.toHaveBeenCalled()
  })

  it('a stored seed with no display name is not set up (#284, the old #267 bug)', async () => {
    mockProfileName = undefined
    mockAccountStatus.status = 'locked'
    try {
      const globalProperties: Record<string, unknown> = {}
      await setupApis({
        app: { config: { globalProperties } },
      } as never)
      expect(globalProperties.$status).toMatchObject({ setup: false })
    } finally {
      mockProfileName = 'Monad user'
      mockAccountStatus.status = 'ready'
    }
  })

  it('uses a fast tab-coordinator ping timeout when booting in extension popup mode (extMode=popup)', async () => {
    const originalUrl = window.location.href
    window.history.replaceState({}, '', '/index.html?extMode=popup')
    try {
      const globalProperties: Record<string, unknown> = {}
      await setupApis({
        app: { config: { globalProperties } },
      } as never)
      expect(mockTabCoordinatorInit).toHaveBeenCalledWith({
        pingTimeoutMs: 4,
      })
      expect(globalProperties.$status).toMatchObject({
        loaded: true,
        setup: true,
      })
    } finally {
      window.history.replaceState({}, '', originalUrl)
    }
  })

  describe('extension popup opened from the toolbar', () => {
    let originalUrl: string
    beforeEach(() => {
      originalUrl = window.location.href
      window.history.replaceState({}, '', '/index.html?extMode=popup')
    })
    afterEach(() => window.history.replaceState({}, '', originalUrl))

    it('waits for an already open extension view to answer before taking the account', async () => {
      mockHasOtherExtensionViews.mockResolvedValue(true)
      await setupApis({ app: { config: { globalProperties: {} } } } as never)
      expect(mockTabCoordinatorInit).toHaveBeenCalledWith({
        pingTimeoutMs: 300,
      })
    })

    it('raises the open pop-out and never opens the account or the lock screen here', async () => {
      mockHasOtherExtensionViews.mockResolvedValue(true)
      mockTabCoordinator.otherTabActive = true
      mockTabCoordinator.deferToActiveExtensionView.mockResolvedValue(true)
      await setupApis({ app: { config: { globalProperties: {} } } } as never)
      expect(accountSession.setStandby).toHaveBeenCalled()
      expect(mockTabCoordinator.deferToActiveExtensionView).toHaveBeenCalled()
      expect(accountSession.initialize).not.toHaveBeenCalled()
    })

    it('stays on standby when the open view cannot be raised', async () => {
      mockTabCoordinator.otherTabActive = true
      await setupApis({ app: { config: { globalProperties: {} } } } as never)
      expect(accountSession.setStandby).toHaveBeenCalled()
      // initialize() on a standby session does not acquire custody.
      expect(
        jest.mocked(accountSession.setStandby).mock.invocationCallOrder[0],
      ).toBeLessThan(
        jest.mocked(accountSession.initialize).mock.invocationCallOrder[0],
      )
    })
  })
})
