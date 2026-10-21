/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'

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
const mockOwnAddress = ref<string | null>(null)
jest.mock('src/utils/own-address', () => ({
  useReactiveOwnCanonicalAddress: () => mockOwnAddress,
  sameCanonicalAddress: (first: string | null, second: string | null) =>
    Boolean(first && second && first.toLowerCase() === second.toLowerCase()),
}))

jest.mock('src/stores/chats', () => ({
  useChatStore: () => ({
    conversations: {},
    chats: {},
    getSortedChatOrder: [],
  }),
}))

const OWN_ADDRESS = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'

const passthrough = defineComponent({
  setup(_props, { slots }) {
    return () => h('div', slots.default?.())
  },
})

function mountAt(width: number, push = jest.fn()) {
  mockOwnAddress.value = null
  return mount(ChatLayout, {
    global: {
      mocks: {
        $route: { params: { address: OWN_ADDRESS.toLowerCase() } },
        $router: { push },
        $t: (key: string) => key,
        $q: { screen: { width } },
      },
      stubs: {
        QHeader: passthrough,
        QToolbar: passthrough,
        QToolbarTitle: passthrough,
        QAvatar: passthrough,
        QBtn: defineComponent({
          emits: ['click'],
          setup(_props, { emit, attrs }) {
            return () => h('button', { ...attrs, onClick: () => emit('click') })
          },
        }),
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
      },
    },
  })
}

describe('ChatLayout back arrow on phones', () => {
  it('an open conversation on a phone has a back arrow to the chat list', async () => {
    const push = jest.fn()
    const wrapper = mountAt(375, push)
    await flushPromises()
    const back = wrapper.get('[data-testid="chat-back"]')
    expect(back.attributes('aria-label')).toBe('a11y.backToChats')
    await back.trigger('click')
    expect(push).toHaveBeenCalledWith('/chat')
  })

  it('a wide layout keeps the list in the sidebar and shows no back arrow', async () => {
    const wrapper = mountAt(1280)
    await flushPromises()
    expect(wrapper.find('[data-testid="chat-back"]').exists()).toBe(false)
  })
})
