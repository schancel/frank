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

function mountAt(
  width: number,
  router: Record<string, jest.Mock> = { push: jest.fn() },
) {
  mockOwnAddress.value = null
  return mount(ChatLayout, {
    global: {
      mocks: {
        $route: { params: { address: OWN_ADDRESS.toLowerCase() } },
        $router: router,
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
  afterEach(() => {
    window.history.replaceState(null, '')
  })

  function phoneRouter() {
    return { push: jest.fn(), back: jest.fn(), replace: jest.fn() }
  }

  it('opened from the chat list, the back arrow goes back in history', async () => {
    window.history.replaceState({ back: '/chat' }, '')
    const router = phoneRouter()
    const wrapper = mountAt(375, router)
    await flushPromises()
    const back = wrapper.get('[data-testid="chat-back"]')
    expect(back.attributes('aria-label')).toBe('a11y.backToChats')
    await back.trigger('click')
    expect(router.back).toHaveBeenCalledTimes(1)
    expect(router.replace).not.toHaveBeenCalled()
    expect(router.push).not.toHaveBeenCalled()
  })

  it('opened from elsewhere (a deep link), the back arrow replaces with the chat list', async () => {
    window.history.replaceState({ back: '/forum' }, '')
    const router = phoneRouter()
    const wrapper = mountAt(375, router)
    await flushPromises()
    await wrapper.get('[data-testid="chat-back"]').trigger('click')
    expect(router.replace).toHaveBeenCalledWith('/chat')
    expect(router.back).not.toHaveBeenCalled()
    expect(router.push).not.toHaveBeenCalled()

    window.history.replaceState(null, '')
    await wrapper.get('[data-testid="chat-back"]').trigger('click')
    expect(router.replace).toHaveBeenCalledTimes(2)
    expect(router.back).not.toHaveBeenCalled()
  })

  it('a wide layout keeps the list in the sidebar and shows no back arrow', async () => {
    const wrapper = mountAt(1280)
    await flushPromises()
    expect(wrapper.find('[data-testid="chat-back"]').exists()).toBe(false)
  })
})
