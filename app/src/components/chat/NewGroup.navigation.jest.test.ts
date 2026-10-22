/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, reactive } from 'vue'
import { createRouter, createMemoryHistory, RouterView } from 'vue-router'
const runtime = globalThis as typeof globalThis & {
  Vue: typeof import('vue')
  Quasar: typeof import('quasar')
}
runtime.Vue = jest.requireActual('vue')
runtime.ResizeObserver = class {
  observe = jest.fn()
  unobserve = jest.fn()
  disconnect = jest.fn()
}
jest.requireActual('quasar/dist/quasar.umd.prod.js')
const quasar = runtime.Quasar
const { QLayout, QInput, QBtn } = quasar
import ChatList from './ChatList.vue'
import NewGroup from '../../pages/NewGroup.vue'

const mockCreate = jest.fn()
const mockSelect = jest.fn()
const mockRelay = jest.fn(() => 'https://relay.example')
const mockStore = reactive({
  getSortedChatOrder: [],
  getGroupHomeRelay: mockRelay,
  createGroupConversation: mockCreate,
  setActiveConversation: mockSelect,
})
jest.mock('../../stores/chats', () => ({ useChatStore: () => mockStore }))
jest.mock('pinia', () => ({
  ...jest.requireActual('pinia'),
  storeToRefs: (store: object) => jest.requireActual('vue').toRefs(store),
}))
jest.mock('../../stores/contacts', () => ({
  useContactStore: () => ({
    contacts: {
      '0x1111111111111111111111111111111111111111': {
        profile: { name: 'Alice' },
      },
    },
    isContact: () => true,
    getContact: () => undefined,
    refreshPeerProfiles: jest.fn(),
  }),
}))
jest.mock('../../accounts/session', () => ({
  accountSession: { state: { status: 'ready', revision: 1 } },
}))
const mockMessaging = reactive({ status: 'ready' })
jest.mock('../../utils/messaging-state', () => ({
  get messagingState() {
    return mockMessaging
  },
}))
const mockCapabilities = reactive({ directMessages: true })
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    get capabilities() {
      return mockCapabilities
    },
    chainIdentifier: 'monad-testnet',
  },
}))
jest.mock('src/utils/stamp-display', () => ({
  nativeAmountAvu: () => undefined,
}))
jest.mock('src/utils/message-receipts', () => ({
  verifiedReceiptsReader: () => () => [],
}))
jest.mock('../../utils/notifications', () => ({ errorNotify: jest.fn() }))
jest.mock('../../utils/chain-address', () => ({
  isChainAddress: (value: string) => /^0x[0-9a-f]{40}$/i.test(value),
  toChainDisplayAddress: (value: string) => value.toLowerCase(),
}))
jest.mock('../../utils/own-address', () => ({
  sameCanonicalAddress: (a: string, b: string) =>
    a.toLowerCase() === b.toLowerCase(),
}))
jest.mock('./ChatListItem.vue', () => ({ render: () => null }))

async function start(path = '/chat') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/chat', component: ChatList, props: { compact: false } },
      { path: '/new-group', component: NewGroup },
      {
        path: '/chat/:address',
        component: {
          template: '<div data-test="opened-group">Created group</div>',
        },
      },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(
    defineComponent({ render: () => h(QLayout, () => h(RouterView)) }),
    {
      attachTo: document.body,
      global: {
        plugins: [
          router,
          [
            quasar,
            {
              components: Object.fromEntries(
                Object.entries(quasar).filter(([key]) => /^Q[A-Z]/.test(key)),
              ),
            },
          ],
        ],
        mocks: { $status: { setup: true }, $t: (key: string) => key },
      },
    },
  )
  await flushPromises()
  return { wrapper, router }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockCreate.mockReset()
  mockRelay.mockReturnValue('https://relay.example')
  mockCapabilities.directMessages = true
  mockMessaging.status = 'ready'
})

it('opens the real group form from the toolbar, validates, selects a member, and opens the returned group', async () => {
  mockCreate.mockResolvedValueOnce({ id: 'returned-group' })
  const { wrapper, router } = await start()
  try {
    await wrapper.get('[data-testid="screener-filter-chip"]').trigger('click')
    expect(wrapper.get('[data-test="screener-empty"]').exists()).toBe(true)
    await wrapper.get('[data-test="all-chats-filter-chip"]').trigger('click')
    await wrapper.get('[data-testid="new-group-btn"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/new-group')
    expect(wrapper.get('[data-test="new-group-form"]').isVisible()).toBe(true)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(wrapper.getComponent(QBtn).exists()).toBe(true)
    expect(
      wrapper.get('[data-test="create-group-submit"]').attributes('disabled'),
    ).toBeDefined()
    await wrapper
      .getComponent(NewGroup)
      .getComponent(QInput)
      .get('input')
      .setValue(' Team ')
    await wrapper.get('[data-test="group-contact-item"]').trigger('click')
    expect(
      wrapper.get('[data-test="selected-group-members"]').text(),
    ).toContain('Alice')
    await wrapper.get('[data-test="create-group-submit"]').trigger('click')
    await flushPromises()
    expect(mockCreate).toHaveBeenCalledWith({
      groupName: 'Team',
      memberAddresses: ['0x1111111111111111111111111111111111111111'],
      relayUrl: 'https://relay.example',
    })
    expect(mockSelect).toHaveBeenCalledWith('returned-group')
    expect(router.currentRoute.value.path).toBe('/chat/returned-group')
  } finally {
    wrapper.unmount()
  }
})

it.each(['new-group-back', 'cancel-create-group'])(
  'allows %s without creating',
  async control => {
    const { wrapper, router } = await start('/new-group?from=/chat/peer')
    try {
      await wrapper.get(`[data-test="${control}"]`).trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.path).toBe('/chat/peer')
      expect(mockCreate).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  },
)

it('keeps creation failures visible on the form', async () => {
  mockCreate.mockRejectedValueOnce(new Error('Relay unavailable'))
  const { wrapper, router } = await start('/new-group')
  try {
    await wrapper.get('[data-test="group-name-input"]').setValue('Team')
    await wrapper.get('[data-test="create-group-submit"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Relay unavailable')
    expect(router.currentRoute.value.path).toBe('/new-group')
    expect(mockSelect).not.toHaveBeenCalled()
  } finally {
    wrapper.unmount()
  }
})

it('shows missing relay configuration instead of failing to render', async () => {
  mockRelay.mockImplementationOnce(() => {
    throw new Error('Group messaging is not configured')
  })
  const { wrapper } = await start('/new-group')
  try {
    expect(wrapper.get('[role="alert"]').text()).toBe(
      'Group messaging is not configured',
    )
    expect(wrapper.get('[data-test="group-relay-input"]').exists()).toBe(true)
  } finally {
    wrapper.unmount()
  }
})

it('validates initial members at the route boundary and rejects external return locations', async () => {
  const { wrapper, router } = await start(
    '/new-group?member=invalid&from=//example.com',
  )
  try {
    expect(wrapper.get('[role="alert"]').text()).toBe(
      'groupChat.invalidMembers',
    )
    expect(wrapper.find('[data-test="new-group-form"]').exists()).toBe(false)
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/chat')
    expect(mockCreate).not.toHaveBeenCalled()
  } finally {
    wrapper.unmount()
  }
})

it('does not redirect after leaving an in-flight creation', async () => {
  let finish!: (value: { id: string }) => void
  mockCreate.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      }),
  )
  const { wrapper, router } = await start(
    '/new-group?member=0x1111111111111111111111111111111111111111',
  )
  try {
    expect(
      wrapper.getComponent({ name: 'NewGroupForm' }).props('initialMembers'),
    ).toEqual(['0x1111111111111111111111111111111111111111'])
    await wrapper.get('[data-test="group-name-input"]').setValue('Team')
    await wrapper.get('[data-test="create-group-submit"]').trigger('click')
    await router.push('/chat')
    await flushPromises()
    finish({ id: 'late-group' })
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/chat')
    expect(mockSelect).not.toHaveBeenCalled()
  } finally {
    wrapper.unmount()
  }
})

it.each(['unsupported', 'loading'])(
  'shows %s group entry with Back and no creation form',
  async state => {
    if (state === 'unsupported') mockCapabilities.directMessages = false
    else mockMessaging.status = 'pending'
    const { wrapper, router } = await start('/new-group')
    try {
      expect(wrapper.get('[role="alert"]').text()).toBe(
        state === 'unsupported'
          ? 'groupChat.unavailableNetwork'
          : 'groupChat.messagingNotReady',
      )
      expect(wrapper.find('[data-test="new-group-form"]').exists()).toBe(false)
      await wrapper.get('button').trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.path).toBe('/chat')
      expect(mockCreate).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  },
)
