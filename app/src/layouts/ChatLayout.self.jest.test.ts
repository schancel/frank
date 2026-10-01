/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

import ChatLayout from './ChatLayout.vue'

jest.mock('../components/panels/ChatInfoView.vue', () => ({
  template: '<i />',
}))
jest.mock('../components/dialogs/ClearHistoryDialog.vue', () => ({
  template: '<i />',
}))
jest.mock('../components/dialogs/DeleteChatDialog.vue', () => ({
  template: '<i />',
}))
jest.mock('../components/dialogs/SendFileDialog.vue', () => ({
  template: '<i />',
}))
jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({
    getContact: () => ({
      profile: { name: 'Alice Profile', avatar: undefined, pubKey: null },
    }),
    setNotify: jest.fn(),
    getNotify: () => true,
  }),
}))
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => ({ profile: { avatar: 'local-owner.png' } }),
}))
jest.mock('src/utils/avatar', () => ({
  profileAvatar: (avatar: string | undefined) => avatar ?? 'fallback.png',
}))
const mockOwnAddress = jest.fn()
jest.mock('src/utils/own-address', () => ({
  getOwnCanonicalAddress: () => mockOwnAddress(),
  sameCanonicalAddress: (first: string | null, second: string | null) =>
    Boolean(first && second && first.toLowerCase() === second.toLowerCase()),
}))

const OWN_ADDRESS = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'

const passthrough = defineComponent({
  setup(_props, { slots }) {
    return () => h('div', slots.default?.())
  },
})

describe('ChatLayout self-chat identity (#420)', () => {
  it.each([
    ['en-us', 'You'],
    ['fr-fr', 'Vous'],
  ])(
    'uses the localized own label in %s while retaining the profile avatar',
    async (_locale, label) => {
      mockOwnAddress.mockResolvedValue(OWN_ADDRESS)
      const wrapper = mount(ChatLayout, {
        global: {
          mocks: {
            $route: { params: { address: OWN_ADDRESS.toLowerCase() } },
            $router: { push: jest.fn() },
            $t: (key: string) => (key === 'selfChat.you' ? label : key),
          },
          stubs: {
            QHeader: passthrough,
            QToolbar: passthrough,
            QToolbarTitle: passthrough,
            QAvatar: passthrough,
            QBtn: true,
            QSpace: true,
            QMenu: true,
            QList: true,
            QItem: true,
            QItemSection: true,
            QIcon: true,
            QSeparator: true,
            QDialog: true,
            RouterView: true,
            ChatInfoView: true,
            ClearHistoryDialog: true,
            DeleteChatDialog: true,
            SendFileDialog: true,
          },
        },
      })

      await flushPromises()
      expect(wrapper.text()).toContain(label)
      expect(wrapper.text()).not.toContain('Alice Profile')
      expect(wrapper.get('img').attributes('src')).toBe('local-owner.png')
    },
  )
})
