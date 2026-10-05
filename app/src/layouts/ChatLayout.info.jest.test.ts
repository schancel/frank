/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'

import ChatLayout from './ChatLayout.vue'

const mockContact = {
  profile: {
    name: 'Alice',
    avatar: 'alice.png',
    pubKey: null,
    bio: 'Hello world',
  },
}

jest.mock('../components/panels/ChatInfoView.vue', () => ({
  name: 'ChatInfoView',
  props: ['address', 'contact'],
  emits: ['deleted', 'chat'],
  template:
    '<div data-testid="chat-info-view"><button data-testid="info-chat-btn" @click="$emit(\'chat\')" /></div>',
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
    getContact: () => mockContact,
    setNotify: jest.fn(),
    getNotify: () => true,
  }),
}))
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => ({ profile: { avatar: 'owner.png' } }),
}))
jest.mock('src/utils/avatar', () => ({
  profileAvatar: (avatar: string | undefined) => avatar ?? 'fallback.png',
}))
const mockOwnAddress = ref<string | null>(
  '0x9999999999999999999999999999999999999999',
)
jest.mock('src/utils/own-address', () => ({
  useReactiveOwnCanonicalAddress: () => mockOwnAddress,
  sameCanonicalAddress: (first: string | null, second: string | null) =>
    Boolean(first && second && first.toLowerCase() === second.toLowerCase()),
}))

const passthrough = defineComponent({
  setup(_props, { slots }) {
    return () => h('div', slots.default?.())
  },
})

describe('ChatLayout info mode with ?info=true query', () => {
  it('opens ChatInfoView directly when route has ?info=true', async () => {
    const mockReplace = jest.fn()
    const wrapper = mount(ChatLayout, {
      global: {
        mocks: {
          $route: {
            params: { address: '0x1111111111111111111111111111111111111111' },
            query: { info: 'true' },
          },
          $router: { push: jest.fn(), replace: mockReplace },
          $t: (key: string) => key,
        },
        stubs: {
          QHeader: passthrough,
          QToolbar: passthrough,
          QToolbarTitle: passthrough,
          QAvatar: passthrough,
          QBtn: passthrough,
          QSpace: passthrough,
          QMenu: passthrough,
          QList: passthrough,
          QItem: passthrough,
          QItemSection: passthrough,
          QIcon: passthrough,
          QSeparator: passthrough,
          QDialog: true,
          RouterView: { template: '<div data-testid="chat-view" />' },
          ClearHistoryDialog: true,
          DeleteChatDialog: true,
          SendFileDialog: true,
        },
      },
    })

    await flushPromises()
    expect(wrapper.find('[data-testid="chat-info-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chat-view"]').exists()).toBe(false)

    // Clicking chat on ChatInfoView closes info and removes ?info=true
    await wrapper.find('[data-testid="info-chat-btn"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="chat-view"]').exists()).toBe(true)
    expect(mockReplace).toHaveBeenCalledWith({ query: {} })
  })

  it('defaults to chat router-view when route has no info query', async () => {
    const wrapper = mount(ChatLayout, {
      global: {
        mocks: {
          $route: {
            params: { address: '0x1111111111111111111111111111111111111111' },
            query: {},
          },
          $router: { push: jest.fn(), replace: jest.fn() },
          $t: (key: string) => key,
        },
        stubs: {
          QHeader: passthrough,
          QToolbar: passthrough,
          QToolbarTitle: passthrough,
          QAvatar: passthrough,
          QBtn: passthrough,
          QSpace: passthrough,
          QMenu: passthrough,
          QList: passthrough,
          QItem: passthrough,
          QItemSection: passthrough,
          QIcon: passthrough,
          QSeparator: passthrough,
          QDialog: true,
          RouterView: { template: '<div data-testid="chat-view" />' },
          ClearHistoryDialog: true,
          DeleteChatDialog: true,
          SendFileDialog: true,
        },
      },
    })

    await flushPromises()
    expect(wrapper.find('[data-testid="chat-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chat-info-view"]').exists()).toBe(false)
  })
})
