/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import { defineComponent } from 'vue'

jest.mock('vue-router', () => ({
  useRoute: () => ({ path: '/' }),
  useRouter: () => ({ push: jest.fn() }),
}))
jest.mock('src/stores/chats', () => ({
  useChatStore: () => ({ totalUnread: 0, getSortedChatOrder: [] }),
}))
jest.mock('src/stores/topics', () => ({
  useTopicStore: () => ({ topics: {}, refreshDiscoveredTopics: jest.fn() }),
}))
jest.mock('src/stores/forum', () => ({
  useForumStore: () => ({ selectedTopic: '' }),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(() => Promise.resolve({})),
}))
jest.mock('src/composables/useBalance', () => ({
  useBalance: () => ({
    formattedBalance: { value: '1 MON' },
    loaded: { value: true },
  }),
}))
jest.mock('src/utils/runtime-mode', () => ({
  legacyLotusModeEnabled: () => false,
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

function mountDrawer() {
  return shallowMount(LeftDrawer, {
    global: {
      mocks: {
        $status: { setup: true },
        $t: (key: string) => key,
        $relay: { connected: true },
      },
      stubs: {
        QDialog: true,
        QTabs: { template: '<div role="tablist"><slot /></div>' },
        QTab: QTabStub,
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
}

describe('LeftDrawer Wallet rail tab (#399)', () => {
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
})
