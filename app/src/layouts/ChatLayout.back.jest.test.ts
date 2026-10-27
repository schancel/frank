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

const mockConversations: Record<string, unknown> = {}
jest.mock('src/stores/chats', () => ({
  useChatStore: () => ({
    conversations: mockConversations,
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
  address = OWN_ADDRESS.toLowerCase(),
) {
  mockOwnAddress.value = null
  return mount(ChatLayout, {
    global: {
      mocks: {
        $route: { params: { address } },
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
    return { push: jest.fn(), go: jest.fn(), replace: jest.fn() }
  }

  it('opened from the chat list, the back arrow goes back in history', async () => {
    window.history.replaceState({ back: '/chat' }, '')
    const router = phoneRouter()
    const wrapper = mountAt(375, router)
    await flushPromises()
    const back = wrapper.get('[data-testid="chat-back"]')
    expect(back.attributes('aria-label')).toBe('a11y.backToChats')
    await back.trigger('click')
    expect(router.go).toHaveBeenCalledWith(-1)
    expect(router.replace).not.toHaveBeenCalled()
    expect(router.push).not.toHaveBeenCalled()
  })

  it("opened from Contacts (or anywhere in the app), the back arrow is Back, as the phone's is", async () => {
    window.history.replaceState({ back: '/contacts' }, '')
    const router = phoneRouter()
    const wrapper = mountAt(375, router)
    await flushPromises()
    await wrapper.get('[data-testid="chat-back"]').trigger('click')
    expect(router.go).toHaveBeenCalledWith(-1)
    expect(router.replace).not.toHaveBeenCalled()
    expect(router.push).not.toHaveBeenCalled()
  })

  it('opened directly (a deep link, nothing before it), the back arrow replaces with the chat list', async () => {
    window.history.replaceState(null, '')
    const router = phoneRouter()
    const wrapper = mountAt(375, router)
    await flushPromises()
    await wrapper.get('[data-testid="chat-back"]').trigger('click')
    expect(router.replace).toHaveBeenCalledWith('/chat')
    expect(router.go).not.toHaveBeenCalled()
    expect(router.push).not.toHaveBeenCalled()
  })

  it('a wide layout keeps the list in the sidebar and shows no back arrow', async () => {
    const wrapper = mountAt(1280)
    await flushPromises()
    expect(wrapper.find('[data-testid="chat-back"]').exists()).toBe(false)
  })
})

describe('ChatLayout conversation header', () => {
  const PEER = '0x2b2B2B2B2b2B2B2b2B2b2b2b2b2b2b2B2B2b2b2b'
  const OTHER = '0x3c3C3C3C3c3C3C3c3C3c3c3c3c3c3c3C3C3c3c3c'
  const GROUP_ID = 'g'.repeat(32)

  afterEach(() => {
    for (const key of Object.keys(mockConversations))
      delete mockConversations[key]
  })

  it('on a phone, a conversation has back and no navigation menu', async () => {
    const wrapper = mountAt(390)
    await flushPromises()
    expect(wrapper.find('[data-testid="chat-back"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chat-open-navigation"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('[icon="menu"]').exists()).toBe(false)
  })

  it('on a wide layout, a conversation keeps the navigation menu and has no back', async () => {
    const wrapper = mountAt(1280)
    await flushPromises()
    expect(wrapper.find('[data-testid="chat-open-navigation"]').exists()).toBe(
      true,
    )
    expect(wrapper.find('[data-testid="chat-back"]').exists()).toBe(false)
  })

  it('a direct conversation offers voice and video calls', async () => {
    const wrapper = mountAt(390, { push: jest.fn() }, PEER.toLowerCase())
    await flushPromises()
    expect(wrapper.find('[data-testid="webrtc-audio-call-btn"]').exists()).toBe(
      true,
    )
    expect(wrapper.find('[data-testid="webrtc-video-call-btn"]').exists()).toBe(
      true,
    )
  })

  it.each([390, 1280])(
    'a group conversation offers no call at %ipx: group calls are unsupported',
    async width => {
      mockConversations[GROUP_ID] = {
        id: GROUP_ID,
        kind: 'group',
        name: 'First Group',
        address: `group:${'a'.repeat(64)}`,
        participants: [OWN_ADDRESS, PEER, OTHER],
      }
      const wrapper = mountAt(width, { push: jest.fn() }, GROUP_ID)
      mockOwnAddress.value = OWN_ADDRESS
      await flushPromises()
      expect(wrapper.get('[data-testid="chat-header-name"]').text()).toBe(
        'First Group',
      )
      expect(
        wrapper.find('[data-testid="webrtc-audio-call-btn"]').exists(),
      ).toBe(false)
      expect(
        wrapper.find('[data-testid="webrtc-video-call-btn"]').exists(),
      ).toBe(false)
    },
  )
})
