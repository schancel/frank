/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

import ChatList from './ChatList.vue'

const mockPush = jest.fn()
jest.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockPush,
    currentRoute: { value: { path: '/', fullPath: '/' } },
  }),
}))
jest.mock('pinia', () => ({
  storeToRefs: (store: object) => jest.requireActual('vue').toRefs(store),
}))
const mockChatStore = jest.requireActual('vue').reactive({
  getSortedChatOrder: [
    { id: 'thread1', address: 'addr1', totalUnreadMessages: 0 },
  ],
  setActiveConversation: jest.fn(),
  setActiveChat: jest.fn(),
})

jest.mock('../../stores/chats', () => ({
  useChatStore: () => mockChatStore,
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: { toDisplayAmount: (n: bigint) => n.toString(), unit: 'MON' },
}))
jest.mock('./ChatListItem.vue', () => ({
  template: '<div data-testid="chat-item" />',
}))
jest.mock('./MailboxStatusBanner.vue', () => ({
  template: '<div data-testid="mailbox-status" />',
}))

let mockWidth = 0
jest.mock('quasar', () => ({
  useQuasar: () => ({ screen: { width: mockWidth } }),
}))

const passthrough = defineComponent({
  setup:
    (_p, { slots }) =>
    () =>
      h('div', slots.default?.()),
})

async function selectChatAt(width: number) {
  mockWidth = width
  const wrapper = mount(ChatList, {
    props: { compact: false },
    global: {
      components: {
        QScrollArea: passthrough,
        QList: passthrough,
        QItem: passthrough,
        QItemSection: passthrough,
        QItemLabel: passthrough,
        QSeparator: passthrough,
        QSpace: passthrough,
        QBtn: passthrough,
      },
      mocks: { $status: { setup: true }, $t: (k: string) => k },
    },
  })
  await wrapper.find('[data-testid="chat-item"]').trigger('click')
  return wrapper
}

describe('ChatList closeDrawer', () => {
  beforeEach(() => {
    mockPush.mockClear()
    mockChatStore.setActiveConversation.mockClear()
    mockChatStore.getSortedChatOrder = [
      { id: 'thread1', address: 'addr1', totalUnreadMessages: 0 },
    ]
  })

  it.each([390, 800])('emits closeDrawer at %ipx (mobile)', async width => {
    const wrapper = await selectChatAt(width)
    expect(mockPush).toHaveBeenCalledWith('/chat/thread1')
    expect(wrapper.emitted('closeDrawer')).toHaveLength(1)
  })

  it.each([801, 1024])('does not emit at %ipx (desktop)', async width => {
    const wrapper = await selectChatAt(width)
    expect(mockPush).toHaveBeenCalledWith('/chat/thread1')
    expect(wrapper.emitted('closeDrawer')).toBeUndefined()
  })
})

describe('ChatList conversation selection (#943)', () => {
  beforeEach(() => {
    mockPush.mockClear()
    mockChatStore.setActiveConversation.mockClear()
  })

  it('activates conversation by id and navigates to /chat/:id', async () => {
    mockChatStore.getSortedChatOrder = [
      {
        id: 'conv-uuid-943',
        topic: 'Engineering',
        participants: ['0x1111111111111111111111111111111111111111'],
        totalUnreadMessages: 0,
      },
    ]
    mockWidth = 1024
    const wrapper = mount(ChatList, {
      props: { compact: false },
      global: {
        components: {
          QScrollArea: passthrough,
          QList: passthrough,
          QItem: passthrough,
          QItemSection: passthrough,
          QItemLabel: passthrough,
          QSeparator: passthrough,
          QSpace: passthrough,
          QBtn: passthrough,
        },
        mocks: { $status: { setup: true }, $t: (k: string) => k },
      },
    })
    await wrapper.find('[data-testid="chat-item"]').trigger('click')
    expect(mockChatStore.setActiveConversation).toHaveBeenCalledWith(
      'conv-uuid-943',
    )
    expect(mockPush).toHaveBeenCalledWith('/chat/conv-uuid-943')
  })
})

describe('ChatList compose email action', () => {
  beforeEach(() => {
    mockPush.mockClear()
  })

  it('renders compose email button and navigates to /add-contact?compose=email when clicked', async () => {
    mockWidth = 1024
    const wrapper = mount(ChatList, {
      props: { compact: false },
      global: {
        components: {
          QScrollArea: passthrough,
          QList: passthrough,
          QItem: passthrough,
          QItemSection: passthrough,
          QItemLabel: passthrough,
          QSeparator: passthrough,
          QSpace: passthrough,
          QBtn: passthrough,
        },
        mocks: { $status: { setup: true }, $t: (k: string) => k },
      },
    })
    const composeBtn = wrapper.find('[data-testid="compose-email-btn"]')
    expect(composeBtn.exists()).toBe(true)
    await composeBtn.trigger('click')
    expect(mockPush).toHaveBeenCalledWith('/add-contact?compose=email')
  })

  it('renders start conversation button and navigates to /add-contact?mode=conversation when clicked', async () => {
    mockWidth = 1024
    const wrapper = mount(ChatList, {
      props: { compact: false },
      global: {
        components: {
          QScrollArea: passthrough,
          QList: passthrough,
          QItem: passthrough,
          QItemSection: passthrough,
          QItemLabel: passthrough,
          QSeparator: passthrough,
          QSpace: passthrough,
          QBtn: passthrough,
        },
        mocks: { $status: { setup: true }, $t: (k: string) => k },
      },
    })
    const startConvBtn = wrapper.find('[data-testid="start-conversation-btn"]')
    expect(startConvBtn.exists()).toBe(true)
    expect(startConvBtn.attributes('aria-label')).toBe(
      'newContactDialog.startConversation',
    )
    await startConvBtn.trigger('click')
    expect(mockPush).toHaveBeenCalledWith('/add-contact?mode=conversation')
  })
})

describe('ChatList mailbox status', () => {
  it('carries the mailbox status banner, so an unreadable inbox is said where the chats are listed', async () => {
    mockChatStore.getSortedChatOrder = []
    mockWidth = 1200
    const wrapper = mount(ChatList, {
      props: { compact: false },
      global: {
        components: {
          QScrollArea: passthrough,
          QList: passthrough,
          QItem: passthrough,
          QItemSection: passthrough,
          QItemLabel: passthrough,
          QSeparator: passthrough,
          QSpace: passthrough,
          QBtn: passthrough,
        },
        mocks: { $status: { setup: true }, $t: (k: string) => k },
      },
    })
    expect(wrapper.find('[data-testid="mailbox-status"]').exists()).toBe(true)
  })
})
