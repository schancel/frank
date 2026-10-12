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
const mockSetActiveChat = jest.fn()
const mockSetActiveConversation = jest.fn()
jest.mock('src/stores/chats', () => ({
  useChatStore: () => ({
    conversations: {},
    chats: {},
    activeConversation: null,
    setActiveChat: mockSetActiveChat,
    setActiveConversation: mockSetActiveConversation,
  }),
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
        },
      },
    })

    await flushPromises()
    expect(wrapper.find('[data-testid="chat-info-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chat-view"]').exists()).toBe(false)

    expect(wrapper.get('[data-testid="info-header-name"]').text()).toBe('Alice')
    expect(
      wrapper.get('[data-testid="info-header-avatar"] img').attributes('src'),
    ).toBe('alice.png')
    expect(
      wrapper.get('[data-testid="info-header-close"]').attributes('aria-label'),
    ).toBe('a11y.closeInfo')
    // The explicit Close remains accessible after replacing the back icon with identity.
    await wrapper.get('[data-testid="info-header-close"]').trigger('click')
    await flushPromises()
    expect(mockReplace).toHaveBeenCalledWith({ query: {} })
    ;(wrapper.vm as unknown as { openInfo(): void }).openInfo()
    await flushPromises()
    // Clicking chat on ChatInfoView closes info and activates chat for address
    await wrapper.find('[data-testid="info-chat-btn"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="chat-view"]').exists()).toBe(true)
    expect(mockReplace).toHaveBeenCalledWith({ query: {} })
    expect(mockSetActiveChat).toHaveBeenCalledWith(
      '0x1111111111111111111111111111111111111111',
    )
  })

  it('allocates and activates target chat when ChatInfoView emits chat with address', async () => {
    mockSetActiveChat.mockClear()
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
        },
      },
    })
    await flushPromises()
    ;(wrapper.vm as any).onStartChatFromInfo(
      '0xf4482A16DC05A4fDBa94592B19fbD40e6953d063',
    )
    await flushPromises()
    expect(mockSetActiveChat).toHaveBeenCalledWith(
      '0xf4482A16DC05A4fDBa94592B19fbD40e6953d063',
    )
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
        },
      },
    })

    await flushPromises()
    expect(wrapper.find('[data-testid="chat-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chat-info-view"]').exists()).toBe(false)
  })

  it('reactively switches to ChatInfoView when $route.query.info changes to true', async () => {
    const route = {
      params: { address: '0x1111111111111111111111111111111111111111' },
      query: {} as Record<string, string>,
    }
    const wrapper = mount(ChatLayout, {
      global: {
        mocks: {
          $route: route,
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
        },
      },
    })

    await flushPromises()
    expect(wrapper.find('[data-testid="chat-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chat-info-view"]').exists()).toBe(false)

    // Simulate route query watcher firing on navigation
    await (wrapper.vm as any).$options.watch['$route.query.info'].call(
      wrapper.vm,
      'true',
    )
    await wrapper.vm.$nextTick()
    await flushPromises()

    expect(wrapper.find('[data-testid="chat-info-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chat-view"]').exists()).toBe(false)
  })
})

describe('ChatLayout header name', () => {
  afterEach(() => {
    mockContact.profile.pubKey = null
  })

  it('is in the header’s own text colour; the per-key colour is only the avatar ring', async () => {
    ;(mockContact.profile as { pubKey: unknown }).pubKey = {
      toBuffer: () => new Uint8Array(33).fill(7),
    }
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
          QAvatar: {
            template: '<div data-testid="header-avatar"><slot /></div>',
          },
          QBtn: passthrough,
          QSpace: passthrough,
          QMenu: passthrough,
          QList: passthrough,
          QItem: passthrough,
          QItemSection: passthrough,
          QIcon: passthrough,
          QSeparator: passthrough,
          QDialog: true,
          AccountBadge: true,
          RouterView: { template: '<div data-testid="chat-view" />' },
          ClearHistoryDialog: true,
          DeleteChatDialog: true,
        },
      },
    })
    await flushPromises()

    const name = wrapper.find('[data-testid="chat-header-name"]')
    expect(name.text()).toBe('Alice')
    // Nothing from the name up to the header sets a text colour inline.
    for (
      let el: Element | null = name.element;
      el && el !== wrapper.element;
      el = el.parentElement
    )
      expect((el as HTMLElement).style.color).toBe('')
    // The key colour is still shown, as the ring around the avatar.
    expect(
      wrapper.find<HTMLElement>('[data-testid="header-avatar"]').element.style
        .boxShadow,
    ).toContain('hsl(')
  })
})
