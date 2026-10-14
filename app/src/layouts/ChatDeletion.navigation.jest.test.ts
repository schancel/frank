/** @jest-environment jsdom */
import {
  enableAutoUnmount,
  shallowMount,
  mount,
  flushPromises,
} from '@vue/test-utils'
import { reactive, ref, defineComponent, nextTick } from 'vue'
import { Quasar, QDialog } from 'quasar'
import ChatLayout from './ChatLayout.vue'
import ChatListItem from '../components/chat/ChatListItem.vue'
import DeleteChatDialog from '../components/dialogs/DeleteChatDialog.vue'
// Use Quasar's browser bundle so this lifecycle test exercises Teleport, not SSR.
jest.mock('quasar', () => {
  const browser = window as unknown as { Vue: unknown; Quasar: unknown }
  browser.Vue = jest.requireActual('vue')
  jest.requireActual('quasar/dist/quasar.umd.js')
  return { ...(browser.Quasar as object), Quasar: browser.Quasar }
})
enableAutoUnmount(afterEach)
const mockSession = reactive({ revision: 1, account: null })
jest.mock('src/accounts/session', () => ({
  accountSession: {
    get state() {
      return mockSession
    },
  },
}))
const mockStore = reactive({
  conversations: {} as Record<
    string,
    { id: string; address: string; participants: string[]; deletedAt?: number }
  >,
  chats: {},
  activeConversationId: null as string | null,
  get activeConversation() {
    return this.activeConversationId
      ? this.conversations[this.activeConversationId]
      : null
  },
  get getSortedChatOrder() {
    return Object.values(this.conversations).filter(c => !c.deletedAt)
  },
  setActiveConversation: jest.fn((id: string) => {
    mockStore.activeConversationId = id
  }),
  getLatestMessage: () => null,
  deleteChat: jest.fn(async (id: string) => {
    mockStore.conversations[id].deletedAt = 1
    if (mockStore.activeConversationId === id)
      mockStore.activeConversationId = null
  }),
})
jest.mock('src/stores/chats', () => ({ useChatStore: () => mockStore }))
jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({
    getContact: () => undefined,
    getContactProfile: () => ({}),
    getNotify: () => true,
  }),
}))
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => ({ profile: {} }),
}))
jest.mock('src/utils/own-address', () => ({
  useReactiveOwnCanonicalAddress: () => ref(null),
  sameCanonicalAddress: () => false,
}))
jest.mock('src/utils/avatar', () => ({ profileAvatar: () => '' }))
jest.mock('../components/panels/ChatInfoView.vue', () => ({
  template: '<i />',
}))
jest.mock('../components/dialogs/ClearHistoryDialog.vue', () => ({
  template: '<i />',
}))
function mountMenu(menu: 'header' | 'row', target: string, active = target) {
  mockStore.activeConversationId = active
  const router = { replace: jest.fn(), push: jest.fn() }
  const route = reactive({
    params: { address: active },
    query: { info: 'true' },
  })
  const wrapper = shallowMount(menu === 'header' ? ChatLayout : ChatListItem, {
    props: menu === 'row' ? { conversationId: target, compact: false } : {},
    global: {
      renderStubDefaultSlot: true,
      mocks: {
        $route: route,
        $router: router,
        $t: (key: string) => key,
        $status: { setup: true },
      },
      stubs: { DeleteChatDialog: false },
    },
  })
  const dialog = wrapper.findComponent(DeleteChatDialog)
  return {
    router,
    route,
    deleteChat: () =>
      (dialog.vm as unknown as { onDelete(): Promise<void> }).onDelete(),
  }
}
beforeEach(() => {
  mockStore.conversations = Object.fromEntries(
    ['direct', 'group', 'email-same-peer'].map(id => [
      id,
      { id, address: 'same-peer', participants: [] },
    ]),
  )
  mockStore.setActiveConversation.mockClear()
  mockStore.deleteChat.mockClear()
})
for (const menu of ['header', 'row'] as const)
  describe(`${menu} deletion menu`, () => {
    it.each([
      ['direct', '/chat/group'],
      ['group', '/chat/email-same-peer'],
      ['email-same-peer', '/chat/group'],
    ])(
      'selects adjacent conversation after deleting %s',
      async (target, expected) => {
        const f = mountMenu(menu, target)
        await f.deleteChat()
        expect(f.router.replace).toHaveBeenCalledWith(expected)
        expect(f.router.push).not.toHaveBeenCalled()
      },
    )
    it('opens empty Chats when no conversations remain', async () => {
      delete mockStore.conversations.group
      delete mockStore.conversations['email-same-peer']
      const f = mountMenu(menu, 'direct')
      await f.deleteChat()
      expect(f.router.replace).toHaveBeenCalledWith('/chat')
    })
    it('keeps the route when deletion fails', async () => {
      const f = mountMenu(menu, 'direct')
      mockStore.deleteChat.mockRejectedValueOnce(
        new Error('storage unavailable'),
      )
      await expect(f.deleteChat()).rejects.toThrow('storage unavailable')
      expect(f.router.replace).not.toHaveBeenCalled()
    })
    it('ignores stale success after account switching', async () => {
      const f = mountMenu(menu, 'direct')
      let finish!: () => void
      mockStore.deleteChat.mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            finish = resolve
          }),
      )
      const deleting = f.deleteChat()
      mockSession.revision++
      finish()
      await deleting
      expect(f.router.replace).not.toHaveBeenCalled()
    })
    it('keeps another chat opened during pending deletion', async () => {
      const f = mountMenu(menu, 'direct')
      let finish!: () => void
      mockStore.deleteChat.mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            finish = resolve
          }),
      )
      const deleting = f.deleteChat()
      f.route.params.address = 'group'
      finish()
      await deleting
      expect(f.router.replace).not.toHaveBeenCalled()
    })
  })
it('deleting a nonactive row keeps the active chat', async () => {
  const f = mountMenu('row', 'direct', 'group')
  await f.deleteChat()
  expect(f.router.replace).not.toHaveBeenCalled()
  expect(mockStore.activeConversationId).toBe('group')
})

const FilteredChatList = defineComponent({
  components: { ChatListItem },
  setup: () => ({ mockStore }),
  template:
    '<div><ChatListItem v-for="c in mockStore.getSortedChatOrder" :key="c.id" :conversation-id="c.id" :compact="false" /></div>',
})

it('reactively removes the real row before deletion notification', async () => {
  mockStore.activeConversationId = 'direct'
  const router = { replace: jest.fn(), push: jest.fn() }
  const route = reactive({ params: { address: 'direct' }, query: {} })
  const wrapper = shallowMount(FilteredChatList, {
    global: {
      renderStubDefaultSlot: true,
      mocks: {
        $route: route,
        $router: router,
        $t: (k: string) => k,
        $status: { setup: true },
      },
      stubs: { ChatListItem: false, DeleteChatDialog: false },
    },
  })
  const row = wrapper.findAllComponents(ChatListItem)[0]
  const dialog = row.findComponent(DeleteChatDialog)
  await (dialog.vm as unknown as { onDelete(): Promise<void> }).onDelete()
  await nextTick()
  expect(mockStore.conversations.direct.deletedAt).toBe(1)
  expect(wrapper.findAllComponents(ChatListItem)).toHaveLength(2)
  expect(
    (dialog.vm as unknown as { $: { isUnmounted: boolean } }).$.isUnmounted,
  ).toBe(true)
  expect(router.replace).toHaveBeenCalledWith('/chat/group')
})

it('real Quasar dialog is unmounted with its deleted row', async () => {
  mockStore.activeConversationId = 'direct'
  const router = { replace: jest.fn(), push: jest.fn() }
  const route = reactive({ params: { address: 'direct' }, query: {} })
  const wrapper = mount(FilteredChatList, {
    attachTo: document.body,
    global: {
      plugins: [[Quasar, { components: { QDialog } }]],
      renderStubDefaultSlot: true,
      mocks: {
        $route: route,
        $router: router,
        $t: (k: string) => k,
        $status: { setup: true },
      },
      stubs: { ChatListItem: false, DeleteChatDialog: false, QDialog: false },
    },
  })
  const row = wrapper.findAllComponents(ChatListItem)[0]
  ;(row.vm as unknown as { deleteDialogOpen: boolean }).deleteDialogOpen = true
  await nextTick()
  await flushPromises()
  const dialog = row.findComponent(DeleteChatDialog)
  await (dialog.vm as unknown as { onDelete(): Promise<void> }).onDelete()
  await nextTick()
  expect(mockStore.conversations.direct.deletedAt).toBe(1)
  expect(wrapper.findAllComponents(ChatListItem)).toHaveLength(2)
  expect(
    (dialog.vm as unknown as { $: { isUnmounted: boolean } }).$.isUnmounted,
  ).toBe(true)
  expect(router.replace).toHaveBeenCalledWith('/chat/group')
})
