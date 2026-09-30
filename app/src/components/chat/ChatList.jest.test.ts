/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

import ChatList from './ChatList.vue'

const mockPush = jest.fn()
jest.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockPush,
    currentRoute: { value: { path: '/' } },
  }),
}))
jest.mock('pinia', () => ({
  storeToRefs: (store: object) => jest.requireActual('vue').toRefs(store),
}))
jest.mock('../../stores/chats', () => ({
  useChatStore: () =>
    jest.requireActual('vue').reactive({
      getSortedChatOrder: [{ address: 'addr1', totalUnreadMessages: 0 }],
    }),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: { toDisplayAmount: (n: bigint) => n.toString(), unit: 'MON' },
}))
jest.mock('./ChatListItem.vue', () => ({
  template: '<div data-testid="chat-item" />',
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
  beforeEach(() => mockPush.mockClear())

  it.each([390, 800])('emits closeDrawer at %ipx (mobile)', async width => {
    const wrapper = await selectChatAt(width)
    expect(mockPush).toHaveBeenCalledWith('/chat/addr1')
    expect(wrapper.emitted('closeDrawer')).toHaveLength(1)
  })

  it.each([801, 1024])('does not emit at %ipx (desktop)', async width => {
    const wrapper = await selectChatAt(width)
    expect(mockPush).toHaveBeenCalledWith('/chat/addr1')
    expect(wrapper.emitted('closeDrawer')).toBeUndefined()
  })
})
