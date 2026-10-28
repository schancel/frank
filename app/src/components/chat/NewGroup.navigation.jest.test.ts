/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import {
  createRouter,
  createMemoryHistory,
  createWebHashHistory,
  RouterView,
} from 'vue-router'
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
import NewGroupForm from './NewGroupForm.vue'
const mockDiscover = jest.fn(async () => ['https://foreign.example'])
jest.mock('@frank/cashweb/relay/relay-discovery', () => ({
  ...jest.requireActual('@frank/cashweb/relay/relay-discovery'),
  discoverRelayOrigins: (...args: unknown[]) => mockDiscover(...args),
}))

const mockCreate = jest.fn()
const mockSelect = jest.fn()
const mockRelay = jest.fn(() => 'https://relay.example')
// The hosting relay's least price per write (`GET /groups/:id/write-policy`).
const MIN_PRICE = 1_000_000_000_000n
const mockTerms = jest.fn(async (_relay: string) => ({
  network: 'monad-testnet',
  minPriceWei: MIN_PRICE,
}))
const mockStore = reactive({
  groupRelayWriteTerms: mockTerms,
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
const mockSession = reactive({ status: 'ready', revision: 1, account: null })
jest.mock('../../accounts/session', () => ({
  accountSession: {
    get state() {
      return mockSession
    },
  },
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
  receivedValueRevision: jest.requireActual('vue').ref(0),
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

async function start(path = '/chat', history = createMemoryHistory()) {
  setActivePinia(createPinia())
  const router = createRouter({
    history,
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
  mockDiscover.mockReset().mockResolvedValue(['https://foreign.example'])
  mockTerms.mockReset().mockResolvedValue({
    network: 'monad-testnet',
    minPriceWei: MIN_PRICE,
  })
  mockSession.revision = 1
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
      // The relay's minimum, which the form starts from.
      writePriceWei: MIN_PRICE,
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

it.each(['new-group-back', 'cancel-create-group'])(
  '%s returns to the chat list it was opened from, leaving no second list entry',
  async control => {
    // Real session history: Back after Cancel must leave the list, not show it again.
    window.history.pushState(null, '', '#/before-the-app')
    window.history.pushState(null, '', '#/chat')
    const history = createWebHashHistory()
    const { wrapper, router } = await start('/chat', history)
    try {
      const listPosition = (window.history.state as { position: number })
        .position
      await wrapper.get('[data-testid="new-group-btn"]').trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.path).toBe('/new-group')
      await wrapper.get(`[data-test="${control}"]`).trigger('click')
      for (let i = 0; i < 5; i++) {
        await flushPromises()
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(router.currentRoute.value.path).toBe('/chat')
      expect((window.history.state as { position: number }).position).toBe(
        listPosition,
      )
    } finally {
      wrapper.unmount()
      history.destroy()
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

it('prefers the installed home, offers discovered hosts, and selecting a foreign host never changes home', async () => {
  const { wrapper } = await start('/new-group')
  try {
    const form = wrapper.getComponent(NewGroupForm)
    expect(form.vm.relayBaseUrl).toBe('https://relay.example')
    expect(form.vm.relayOptions).toEqual([
      'https://relay.example',
      'https://foreign.example',
    ])
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://relay.example',
        signal: expect.any(AbortSignal),
      }),
    )
    await form.getComponent(quasar.QSelect).setValue('https://foreign.example')
    expect(mockRelay()).toBe('https://relay.example')
    mockCreate.mockResolvedValueOnce({ id: 'foreign-group' })
    await wrapper.get('[data-test="group-name-input"]').setValue('Foreign team')
    await wrapper.get('[data-test="create-group-submit"]').trigger('click')
    await flushPromises()
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ relayUrl: 'https://foreign.example' }),
    )
  } finally {
    wrapper.unmount()
  }
})

it('loads other relays from a home relay on loopback HTTP (a local lab)', async () => {
  const { discoverRelayOrigins } = jest.requireActual(
    '@frank/cashweb/relay/relay-discovery',
  )
  // The lab relay's `GET /peers` answer (jsdom has no fetch Response).
  const peersBody = new TextEncoder().encode(
    JSON.stringify({ relays: ['http://127.0.0.1:18180'] }),
  )
  const peersFetch = jest.fn(async () => {
    let read = false
    return {
      ok: true,
      url: '',
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () =>
            read
              ? { done: true, value: undefined }
              : ((read = true), { done: false, value: peersBody }),
          cancel: async () => undefined,
        }),
      },
    } as unknown as Response
  })
  // The real discovery, against the lab's `/peers` answer.
  mockDiscover.mockImplementationOnce((options: object) =>
    discoverRelayOrigins({ ...options, fetch: peersFetch }),
  )
  mockRelay.mockReturnValue('http://127.0.0.1:8080')
  const { wrapper } = await start('/new-group')
  try {
    const form = wrapper.getComponent(NewGroupForm)
    // The real discovery reads the response body as a stream.
    for (let i = 0; i < 10; i += 1) await flushPromises()
    expect(peersFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/peers',
      expect.anything(),
    )
    expect(form.vm.relayOptions).toEqual([
      'http://127.0.0.1:8080',
      'http://127.0.0.1:18180',
    ])
    expect(
      wrapper.find('[data-test="group-relay-discovery-error"]').exists(),
    ).toBe(false)
  } finally {
    wrapper.unmount()
    mockRelay.mockReturnValue('https://relay.example')
  }
})

it('keeps the current home usable when relay discovery fails', async () => {
  mockDiscover.mockRejectedValueOnce(new Error('offline'))
  const { wrapper } = await start('/new-group')
  try {
    const form = wrapper.getComponent(NewGroupForm)
    expect(form.vm.relayBaseUrl).toBe('https://relay.example')
    expect(form.vm.relayOptions).toEqual(['https://relay.example'])
    expect(
      wrapper.get('[data-test="group-relay-discovery-error"]').text(),
    ).toBe('groupChat.discoveryFailed')
  } finally {
    wrapper.unmount()
  }
})

it.each(['leave', 'session'])(
  'cancels relay discovery and ignores stale hints on %s',
  async change => {
    let finish!: (value: string[]) => void
    mockDiscover.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        }),
    )
    const { wrapper, router } = await start('/new-group')
    try {
      const signal = mockDiscover.mock.calls[0][0].signal as AbortSignal
      const form = wrapper.getComponent(NewGroupForm)
      if (change === 'leave') await router.push('/chat')
      else mockSession.revision += 1
      await flushPromises()
      expect(signal.aborted).toBe(true)
      finish(['https://late.example'])
      await flushPromises()
      if (change === 'session') {
        expect(form.vm.relayOptions).toEqual([])
        expect(wrapper.get('[role="alert"]').text()).toBe(
          'groupChat.sessionChanged',
        )
        await wrapper.get('[data-test="create-group-submit"]').trigger('click')
        expect(mockCreate).not.toHaveBeenCalled()
      }
    } finally {
      wrapper.unmount()
    }
  },
)

it('uses a manually typed relay origin even when Create is clicked without pressing Enter', async () => {
  mockCreate.mockResolvedValueOnce({ id: 'manual-host' })
  const { wrapper } = await start('/new-group')
  try {
    await wrapper.get('[data-test="group-name-input"]').setValue('Manual host')
    await wrapper
      .getComponent(NewGroupForm)
      .getComponent(quasar.QSelect)
      .get('input')
      .setValue('https://manual.example/')
    await wrapper.get('[data-test="create-group-submit"]').trigger('click')
    await flushPromises()
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ relayUrl: 'https://manual.example' }),
    )
  } finally {
    wrapper.unmount()
  }
})

it("starts the price at the relay's minimum, refuses a lower one, and creates the group at the creator's price", async () => {
  mockCreate.mockResolvedValueOnce({ id: 'priced-group' })
  const { wrapper } = await start('/new-group')
  try {
    expect(mockTerms).toHaveBeenCalledWith('https://relay.example')
    const price = wrapper.get('[data-testid="group-write-price-input"]')
    expect((price.element as HTMLInputElement).value).toBe('0.000001')
    await wrapper.get('[data-test="group-name-input"]').setValue('Priced')
    await price.setValue('0.0000005')
    await flushPromises()
    expect(
      wrapper.get('[data-test="create-group-submit"]').attributes('disabled'),
    ).toBeDefined()
    expect(wrapper.text()).toContain('groupChat.writePriceInvalid')
    await price.setValue('0.003')
    await flushPromises()
    await wrapper.get('[data-test="create-group-submit"]').trigger('click')
    await flushPromises()
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ writePriceWei: 3_000_000_000_000_000n }),
    )
  } finally {
    wrapper.unmount()
  }
})

it("does not create a group while the relay's price terms are unknown", async () => {
  mockTerms.mockRejectedValue(new Error('offline'))
  const { wrapper } = await start('/new-group')
  try {
    await wrapper.get('[data-test="group-name-input"]').setValue('No terms')
    await flushPromises()
    expect(
      wrapper.get('[data-test="create-group-submit"]').attributes('disabled'),
    ).toBeDefined()
    expect(wrapper.text()).toContain('groupChat.writePriceTermsFailed')
  } finally {
    wrapper.unmount()
  }
})

it('tells the creator when the group was created but its relay refused the price', async () => {
  mockCreate.mockResolvedValueOnce({
    id: 'refused-price',
    groupState: { writePriceRefusal: { reason: 'refused' } },
  })
  const { errorNotify } = jest.requireMock('../../utils/notifications')
  const { wrapper, router } = await start('/new-group')
  try {
    await wrapper.get('[data-test="group-name-input"]').setValue('Refused')
    await flushPromises()
    await wrapper.get('[data-test="create-group-submit"]').trigger('click')
    await flushPromises()
    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      fallbackKey: 'groupChat.writePriceRefusedAtCreation',
    })
    // The group exists: it opens.
    expect(router.currentRoute.value.path).toBe('/chat/refused-price')
  } finally {
    wrapper.unmount()
  }
})
