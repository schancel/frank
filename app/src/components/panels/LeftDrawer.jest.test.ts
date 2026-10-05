/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'

const runtime = { legacy: false }
const mockAccountStatus = { status: 'ready' }
jest.mock('../../accounts/session', () => ({
  accountStatus: mockAccountStatus,
}))
const mockRoute = { path: '/' }
const balance = {
  formattedBalance: ref('1 MON'),
  loaded: ref(true),
  hasError: ref(false),
}

const mockWalletStore = {
  seedPhrase:
    'apple banana cherry dinosaur elephant fox grape hat ice joke kite lemon' as
      | string
      | null,
  seedConfirmedAt: 123456789 as number | null,
}
const mockProfileStore = {
  profile: {
    name: 'Alice',
  },
}
const mockRefreshDiscoveredTopics = jest.fn()

jest.mock('vue-router', () => ({
  useRoute: () => mockRoute,
  useRouter: () => ({ push: jest.fn() }),
}))
jest.mock('src/stores/chats', () => ({
  useChatStore: () => ({ totalUnread: 0, getSortedChatOrder: [] }),
}))
jest.mock('src/stores/wallet', () => ({
  useWalletStore: () => mockWalletStore,
}))
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => mockProfileStore,
}))
jest.mock('src/stores/topics', () => ({
  useTopicStore: () => ({
    topics: {},
    refreshDiscoveredTopics: mockRefreshDiscoveredTopics,
  }),
}))
jest.mock('src/stores/forum', () => ({
  useForumStore: () => ({ selectedTopic: '' }),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(() => Promise.resolve({})),
}))
jest.mock('src/composables/useBalance', () => ({
  useBalance: () => balance,
}))
jest.mock('src/utils/runtime-mode', () => ({
  legacyLotusModeEnabled: () => runtime.legacy,
}))
jest.mock('../chat/ChatList.vue', () => ({ template: '<div />' }))
jest.mock('../chat/ChatListLink.vue', () => ({ template: '<div />' }))
jest.mock('../panels/SettingsPanel.vue', () => ({
  template: '<div data-test="settings-panel" />',
}))
jest.mock('../panels/WalletPanel.vue', () => ({
  template: '<div data-test="wallet-panel" />',
}))
jest.mock('../dialogs/RelayConnectDialog.vue', () => ({ template: '<div />' }))

import LeftDrawer from './LeftDrawer.vue'

const QTabStub = defineComponent({
  inheritAttrs: false,
  template: '<button v-bind="$attrs"><slot /></button>',
})

function mountDrawer(setup = true, relayConnected?: boolean) {
  return shallowMount(LeftDrawer, {
    global: {
      mocks: {
        $status: { setup },
        $t: (key: string) => key,
        ...(relayConnected !== undefined
          ? { $relay: { connected: relayConnected } }
          : {}),
      },
      stubs: {
        QDialog: true,
        QTabs: { template: '<div role="tablist"><slot /></div>' },
        QTab: QTabStub,
        QTooltip: true,
        QBadge: true,
        QScrollArea: true,
        QList: { template: '<div><slot /></div>' },
        QItem: { template: '<div><slot /></div>' },
        QItemLabel: { template: '<span v-bind="$attrs"><slot /></span>' },
        QItemSection: { template: '<div><slot /></div>' },
        QBtn: { template: '<button data-testid="relay-reconnect" />' },
        QSeparator: true,
      },
    },
  })
}

describe('LeftDrawer Wallet rail tab (#399)', () => {
  beforeEach(() => {
    runtime.legacy = false
    mockRoute.path = '/'
    balance.formattedBalance.value = '1 MON'
    balance.loaded.value = true
    balance.hasError.value = false
  })

  it('wires Wallet to its tabpanel and pins Settings after the main tabs', () => {
    const wrapper = mountDrawer()
    const html = wrapper.html()
    const wallet = wrapper.get('#rail-tab-wallet')
    const settings = wrapper.get('#rail-tab-settings')

    expect(wallet.attributes('aria-controls')).toBe('rail-panel-wallet')
    expect(wrapper.get('#rail-panel-wallet').attributes()).toMatchObject({
      'role': 'tabpanel',
      'aria-labelledby': 'rail-tab-wallet',
    })
    expect(settings.classes()).toContain('settings-rail-tab')
    expect(wrapper.get('[role="tablist"]').attributes('content-class')).toBe(
      'settings-pin-content',
    )
    expect(html.indexOf('rail-tab-contacts')).toBeLessThan(
      html.indexOf('rail-tab-wallet'),
    )
    expect(html.indexOf('rail-tab-wallet')).toBeLessThan(
      html.indexOf('rail-tab-forum'),
    )
    expect(html.indexOf('rail-tab-wallet')).toBeLessThan(
      html.indexOf('rail-tab-settings'),
    )
  })

  it('forces the rail highlight onto the picked page on navigation (#570)', () => {
    const vm = (w: ReturnType<typeof mountDrawer>) =>
      w.vm as unknown as { tab: string }

    mockRoute.path = '/wallet'
    expect(vm(mountDrawer()).tab).toBe('wallet')
    mockRoute.path = '/forum'
    expect(vm(mountDrawer()).tab).toBe('forum')
    // Other routes never override the highlight (a later direct click must win).
    mockRoute.path = '/chat/addr1'
    expect(vm(mountDrawer()).tab).toBe('contacts')
  })

  it('hides the legacy footer until setup is complete', () => {
    runtime.legacy = true

    const signedOut = mountDrawer(false, false)
    expect(signedOut.find('[data-testid="drawer-balance"]').exists()).toBe(
      false,
    )
    expect(signedOut.find('[data-testid="relay-reconnect"]').exists()).toBe(
      false,
    )

    const signedIn = mountDrawer(true, false)
    expect(signedIn.find('[data-testid="drawer-balance"]').exists()).toBe(true)
    expect(signedIn.find('[data-testid="relay-reconnect"]').exists()).toBe(true)
  })

  it('renders drawer balance without relay reconnect button in Monad mode', () => {
    runtime.legacy = false
    const wrapper = mountDrawer(true)
    expect(wrapper.find('[data-testid="drawer-balance"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="relay-reconnect"]').exists()).toBe(false)
  })

  it('announces unavailable and retained last-known legacy balances', async () => {
    runtime.legacy = true
    balance.loaded.value = false
    balance.hasError.value = true
    const wrapper = mountDrawer()
    const value = () => wrapper.get('[data-testid="drawer-balance"]')

    expect(value().text()).toBe('\u2014')
    expect(value().attributes('aria-label')).toBe(
      'receiveBitcoinDialog.balanceUnavailable',
    )

    balance.formattedBalance.value = '5 MON'
    balance.loaded.value = true
    await nextTick()
    expect(value().text()).toBe('5 MON chatList.balanceStale')
    expect(value().attributes('aria-label')).toBeUndefined()

    balance.hasError.value = false
    await nextTick()
    expect(value().text()).toBe('5 MON')
  })

  describe('topic discovery privacy (#545)', () => {
    beforeEach(() => {
      mockRefreshDiscoveredTopics.mockClear()
    })

    it('defers topic discovery when account setup is not complete', () => {
      mockRoute.path = '/setup'
      mockAccountStatus.status = 'fresh'
      mockProfileStore.profile.name = ''

      mountDrawer(false, false)

      expect(mockRefreshDiscoveredTopics).not.toHaveBeenCalled()
    })

    it('triggers topic discovery when account setup is complete', () => {
      mockAccountStatus.status = 'ready'
      mockProfileStore.profile.name = 'Alice'

      mountDrawer(true, true)

      expect(mockRefreshDiscoveredTopics).toHaveBeenCalledTimes(1)
    })
  })
})
