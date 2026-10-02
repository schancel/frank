/** @jest-environment jsdom */

import { createPinia, setActivePinia } from 'pinia'
import { nextTick, ref } from 'vue'
import { shallowMount } from '@vue/test-utils'

import { fetchCuratedDefaultContacts } from '@frank/wallet/monad-identity'
import { isSetupComplete } from 'src/utils/account-state'
import { useWalletStore } from 'src/stores/wallet'
import { useProfileStore } from 'src/stores/my-profile'
import { useContactStore } from 'src/stores/contacts'
import { useTopicStore } from 'src/stores/topics'

jest.mock('@frank/wallet/monad-identity', () => ({
  fetchCuratedDefaultContacts: jest.fn(() => Promise.resolve([])),
}))
jest.mock('@frank/wallet/chain/monad-chain', () => ({
  loadMonadChainConfigFromEnv: () => ({
    relayBaseUrl: 'http://127.0.0.1:18091',
    chainId: 1440000,
  }),
}))
jest.mock('src/utils/runtime-mode', () => ({
  monadModeEnabled: () => true,
  legacyLotusModeEnabled: () => false,
}))
jest.mock('src/utils/notifications', () => ({
  errorNotify: jest.fn(),
}))
jest.mock('src/utils/apply-locale', () => ({
  applyLocale: jest.fn(),
}))
jest.mock('src/utils/routes', () => ({
  openChat: jest.fn(),
  openPage: jest.fn(),
}))
jest.mock('src/utils/clients', () => ({
  useWallet: () => ({}),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(() => Promise.resolve({})),
}))
jest.mock('src/composables/useBalance', () => ({
  useBalance: () => ({
    formattedBalance: ref('1 MON'),
    loaded: ref(true),
    hasError: ref(false),
  }),
}))

const mockRoute = { path: '/setup' }
const mockRouter = { push: jest.fn() }
jest.mock('vue-router', () => ({
  useRoute: () => mockRoute,
  useRouter: () => mockRouter,
}))

// Stub child components of LeftDrawer
jest.mock('src/components/chat/ChatList.vue', () => ({ template: '<div />' }))
jest.mock('src/components/chat/ChatListLink.vue', () => ({
  template: '<div />',
}))
jest.mock('src/components/panels/SettingsPanel.vue', () => ({
  template: '<div />',
}))
jest.mock('src/components/panels/WalletPanel.vue', () => ({
  template: '<div />',
}))
jest.mock('src/components/dialogs/RelayConnectDialog.vue', () => ({
  template: '<div />',
}))
jest.mock('src/components/dialogs/ContactBookDialog.vue', () => ({
  template: '<div />',
}))

import App from 'src/App.vue'
import LeftDrawer from 'src/components/panels/LeftDrawer.vue'

describe('Setup discovery privacy (#545)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    jest.clearAllMocks()
    mockRoute.path = '/setup'
  })

  describe('Curated contact discovery deferral (App.vue)', () => {
    it('does not contact relay for curated defaults on fresh setup page before onboarding', () => {
      const walletStore = useWalletStore()
      const profileStore = useProfileStore()

      // Fresh state: no seed phrase, no profile name
      walletStore.seedPhrase = null
      profileStore.profile.name = ''

      expect(
        isSetupComplete({
          seedPhrase: walletStore.seedPhrase,
          name: profileStore.profile.name,
          seedConfirmedAt: walletStore.seedConfirmedAt,
        }),
      ).toBe(false)

      const status = { setup: false }
      const mockContext = {
        $status: status,
        loadCuratedDefaults: jest.fn(),
      }

      // Invoke setupConnections as called on created() hook
      App.methods.setupConnections.call(mockContext)

      expect(mockContext.loadCuratedDefaults).not.toHaveBeenCalled()
      expect(fetchCuratedDefaultContacts).not.toHaveBeenCalled()
      expect(status.setup).toBe(false)
    })

    it('contacts relay for curated defaults once setup completes', async () => {
      const walletStore = useWalletStore()
      const profileStore = useProfileStore()
      const contactStore = useContactStore()

      // Completed account state
      walletStore.seedPhrase = 'abandon '.repeat(11) + 'about'
      walletStore.seedConfirmedAt = 123456
      profileStore.profile.name = 'Alice'

      expect(
        isSetupComplete({
          seedPhrase: walletStore.seedPhrase,
          name: profileStore.profile.name,
          seedConfirmedAt: walletStore.seedConfirmedAt,
        }),
      ).toBe(true)

      const status = { setup: false }
      let loadCuratedDefaultsCalled = false

      const mockContext = {
        $status: status,
        loadCuratedDefaults() {
          loadCuratedDefaultsCalled = true
          App.methods.loadCuratedDefaults.call(this)
        },
        replaceCuratedDefaults: jest.fn(contacts =>
          contactStore.replaceCuratedDefaults(contacts),
        ),
        addDefaultContact: jest.fn(contact =>
          contactStore.addDefaultContact(contact),
        ),
        refreshContacts: jest.fn(() => contactStore.refreshContacts()),
        clearCuratedDefaults: jest.fn(() =>
          contactStore.clearCuratedDefaults(),
        ),
      }

      App.methods.setupConnections.call(mockContext)

      expect(loadCuratedDefaultsCalled).toBe(true)
      expect(status.setup).toBe(true)
      expect(fetchCuratedDefaultContacts).toHaveBeenCalledWith({
        relayBaseUrl: 'http://127.0.0.1:18091',
      })
    })

    it('fails soft without throwing when relay is blocked or unreachable during curated discovery', async () => {
      jest
        .mocked(fetchCuratedDefaultContacts)
        .mockRejectedValueOnce(new Error('Network error: Relay unreachable'))
      const consoleErrorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)

      const clearCuratedDefaults = jest.fn()
      const mockContext = {
        replaceCuratedDefaults: jest.fn(),
        addDefaultContact: jest.fn(),
        refreshContacts: jest.fn(),
        clearCuratedDefaults,
      }

      expect(() => {
        App.methods.loadCuratedDefaults.call(mockContext)
      }).not.toThrow()

      await nextTick()
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(clearCuratedDefaults).toHaveBeenCalled()
      consoleErrorSpy.mockRestore()
    })
  })

  describe('Forum topic discovery deferral (LeftDrawer.vue)', () => {
    it('defers topic discovery while on setup route and no account exists', async () => {
      const walletStore = useWalletStore()
      const profileStore = useProfileStore()
      const topicStore = useTopicStore()
      const refreshSpy = jest.spyOn(topicStore, 'refreshDiscoveredTopics')

      walletStore.seedPhrase = null
      profileStore.profile.name = ''
      mockRoute.path = '/setup'

      shallowMount(LeftDrawer, {
        global: {
          mocks: {
            $status: { setup: false },
            $t: (key: string) => key,
            $relay: { connected: false },
          },
          stubs: {
            QDialog: true,
            QTabs: true,
            QTab: true,
            QTooltip: true,
            QBadge: true,
            QScrollArea: true,
            QList: true,
            QItem: true,
            QItemLabel: true,
            QItemSection: true,
            QBtn: true,
            QSeparator: true,
          },
        },
      })

      await nextTick()

      expect(refreshSpy).not.toHaveBeenCalled()
    })

    it('triggers topic discovery after onboarding completes', async () => {
      const walletStore = useWalletStore()
      const profileStore = useProfileStore()
      const topicStore = useTopicStore()
      const refreshSpy = jest
        .spyOn(topicStore, 'refreshDiscoveredTopics')
        .mockResolvedValue()

      walletStore.seedPhrase = null
      profileStore.profile.name = ''
      mockRoute.path = '/setup'

      shallowMount(LeftDrawer, {
        global: {
          mocks: {
            $status: { setup: false },
            $t: (key: string) => key,
            $relay: { connected: false },
          },
          stubs: {
            QDialog: true,
            QTabs: true,
            QTab: true,
            QTooltip: true,
            QBadge: true,
            QScrollArea: true,
            QList: true,
            QItem: true,
            QItemLabel: true,
            QItemSection: true,
            QBtn: true,
            QSeparator: true,
          },
        },
      })

      expect(refreshSpy).not.toHaveBeenCalled()

      // User finishes onboarding
      walletStore.seedPhrase = 'test phrase '.repeat(4).trim()
      profileStore.profile.name = 'Bob'
      await nextTick()

      expect(refreshSpy).toHaveBeenCalled()
    })
  })
})
