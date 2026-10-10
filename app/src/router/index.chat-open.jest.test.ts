/** @jest-environment jsdom */

// Opening a conversation from the list, through the real router (memory history) and the real
// guards. The pages are stand-ins whose code "loads" when the test says so, which is what a
// lazily loaded page does.
import { defineComponent, h, nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { RouteRecordRaw, Router } from 'vue-router'

// vue-router's warning printer and its devtools hook are published as ES modules this Jest setup
// cannot load. Neither takes part in navigation: warnings are dropped, devtools is not installed.
// (The devtools hook is vue-router's own nested copy, which only a file path names.)
jest.mock(
  '../../../node_modules/vue-router/node_modules/@vue/devtools-api',
  () => ({
    setupDevtoolsPlugin: () => undefined,
  }),
)
jest.mock('nostics', () => ({
  createConsoleReporter: () => () => undefined,
  defineDiagnostics: () =>
    new Proxy({}, { get: () => () => undefined }) as Record<string, unknown>,
}))

const CHAT = '/chat/11111111-2222-5333-8444-555555555555'
const mockStatus = { status: 'ready' }
jest.mock('../accounts/session', () => ({
  accountStatus: mockStatus,
  accountSession: { initialize: jest.fn(async () => undefined) },
}))
const mockSetActiveConversation = jest.fn()
jest.mock('src/stores/chats', () => ({
  hasConversationIdSalt: () => true,
  resolveConversation: () => ({ id: 'known' }),
  useChatStore: () => ({
    conversations: {},
    setActiveConversation: mockSetActiveConversation,
    setActiveChat: jest.fn(),
  }),
}))
jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({ fetchAndAddContact: jest.fn() }),
}))

const page = (name: string) =>
  defineComponent({ name, render: () => h('div', { 'data-page': name }) })
// The chat page's code: asked for at the first navigation to it, delivered by `deliver()`.
let mockChatPageLoad: {
  promise: Promise<unknown>
  deliver: () => void
  requested: boolean
}
function resetChatPage() {
  let deliver!: () => void
  const promise = new Promise(resolve => {
    deliver = () => resolve(page('Chat'))
  })
  mockChatPageLoad = { promise, deliver, requested: false }
}
jest.mock('./routes', () => ({
  createRoutes: (): RouteRecordRaw[] => [
    { path: '/wallet', component: page('Wallet') },
    { path: '/chat', component: page('Placeholder') },
    {
      path: '/chat/:address',
      component: () => {
        mockChatPageLoad.requested = true
        return mockChatPageLoad.promise as Promise<never>
      },
    },
  ],
}))

import createAppRouter from './index'
import { PENDING_CHAT_ROUTE_KEY, pendingChatRoute } from './pending-chat'
import ChatPlaceholder from '../pages/ChatPlaceholder.vue'
import { setStartupRestoration } from '../boot/startup-state'

/** The app as it starts in a tab: a new router, at `path`. */
async function startApp(path: string): Promise<Router> {
  const router = createAppRouter()
  void router.push(path)
  await router.isReady()
  await flushPromises()
  return router
}

beforeEach(() => {
  // jsdom has no scrolling; the router scrolls to the top after each navigation.
  window.scrollTo = () => undefined
  process.env.SERVER = 'true' // memory history: there is no address bar in this test
  sessionStorage.clear()
  pendingChatRoute.value = null
  resetChatPage()
  mockSetActiveConversation.mockClear()
  setStartupRestoration({ phase: 'restored' })
})
afterEach(() => {
  delete process.env.SERVER
})

describe('opening a conversation from the list', () => {
  it('opens it once the chat page has loaded, and says it is opening meanwhile', async () => {
    const router = await startApp('/chat')
    const placeholder = mount(ChatPlaceholder, {
      global: {
        mocks: { $t: (key: string) => key, $router: router },
        stubs: {
          QPageContainer: { template: '<div><slot /></div>' },
          QPage: { template: '<div><slot /></div>' },
          QSpinner: true,
          QIcon: true,
          QBtn: true,
        },
      },
    })
    expect(placeholder.find('[data-testid="chat-opening"]').exists()).toBe(
      false,
    )
    expect(placeholder.text()).toContain('chatList.selectChatOrAddContact')

    const opened = router.push(CHAT) // the click
    await flushPromises()
    // Still on the list page while the chat page's code is on its way: not the empty
    // "select a conversation" text, which reads as if the click had been ignored.
    expect(mockChatPageLoad.requested).toBe(true)
    expect(router.currentRoute.value.path).toBe('/chat')
    await nextTick()
    expect(placeholder.find('[data-testid="chat-opening"]').exists()).toBe(true)
    expect(placeholder.text()).not.toContain('chatList.selectChatOrAddContact')

    mockChatPageLoad.deliver()
    await opened
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe(CHAT)
    expect(mockSetActiveConversation).toHaveBeenLastCalledWith(
      '11111111-2222-5333-8444-555555555555',
    )
    expect(pendingChatRoute.value).toBeNull()
    expect(sessionStorage.getItem(PENDING_CHAT_ROUTE_KEY)).toBeNull()
    placeholder.unmount()
  })

  // What the browser run hit: the dev server reloaded the page while the first chat was
  // opening. The address bar still said /chat, so the app came back to "Select a conversation"
  // and the click was lost (its unread badge had already been cleared).
  it('still opens it when the page is reloaded before the navigation finished', async () => {
    const before = await startApp('/chat')
    void before.push(CHAT) // the click; the chat page's code never arrives in this document
    await flushPromises()
    expect(before.currentRoute.value.path).toBe('/chat')

    // The reload: a new document, a new router, the same tab, the address bar still at /chat.
    pendingChatRoute.value = null
    resetChatPage()
    mockChatPageLoad.deliver()
    const after = await startApp('/chat')
    await flushPromises()
    expect(after.currentRoute.value.fullPath).toBe(CHAT)
    expect(sessionStorage.getItem(PENDING_CHAT_ROUTE_KEY)).toBeNull()
  })

  it('does not reopen a chat after a reload when the user had gone somewhere else', async () => {
    const before = await startApp('/chat')
    void before.push(CHAT)
    await flushPromises()

    pendingChatRoute.value = null
    resetChatPage()
    mockChatPageLoad.deliver()
    // The tab comes back at another page than the one the click was made on.
    const after = await startApp('/wallet')
    await flushPromises()
    expect(after.currentRoute.value.path).toBe('/wallet')
  })

  it('a click on another page replaces the note of the chat that was opening', async () => {
    const router = await startApp('/chat')
    void router.push(CHAT)
    await flushPromises()
    expect(pendingChatRoute.value).toBe(CHAT)
    await router.push('/wallet')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/wallet')
    expect(pendingChatRoute.value).toBeNull()
    expect(sessionStorage.getItem(PENDING_CHAT_ROUTE_KEY)).toBeNull()
  })
})
