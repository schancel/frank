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
  accountSession: { initialize: jest.fn(async () => undefined) },
}))
const mockLegacyWallet = { setXPrivKey: jest.fn() }
const mockLegacyWalletConstructor = jest.fn(() => mockLegacyWallet)

jest.mock('quasar/wrappers', () => ({
  boot: (callback: unknown) => callback,
}))
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

import setupApis from './setup-apis'
import { accountSession } from '../accounts/session'
import { startupRestoration } from './startup-state'

describe('setup-apis in Monad mode', () => {
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
})
