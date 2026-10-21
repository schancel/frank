/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { readFileSync } from 'fs'
import { parse } from '@vue/compiler-sfc'
import { transpileModule, ModuleKind } from 'typescript'

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
const mockContactStore = {
  isContact: (address: string) => address === 'known-contact',
  getContact: () => undefined,
}
jest.mock('../../stores/contacts', () => ({
  useContactStore: () => mockContactStore,
}))

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    chainIdentifier: 'monad-testnet',
    toDisplayAmount: (n: bigint) => n.toString(),
    unit: 'MON',
  },
}))
jest.mock('../../stores/settings', () => ({ useSettingsStore: () => ({}) }))
// Prices: 1 MON = 2 AVU, 1 SOL = 300 AVU; no price for anything else.
jest.mock('src/utils/stamp-display', () => ({
  nativeAmountAvu: (chain: string, units: bigint) =>
    chain === 'monad-testnet'
      ? (Number(units) / 1e18) * 2
      : chain === 'solana-devnet'
      ? (Number(units) / 1e9) * 300
      : undefined,
}))
const mockReceipts: Record<
  string,
  Array<{ chainIdentifier: string; baseUnits: bigint }>
> = {}
jest.mock('src/utils/message-receipts', () => ({
  verifiedReceiptsReader: () => (digest: string) => mockReceipts[digest] ?? [],
}))
jest.mock('./ChatListItem.vue', () => ({
  props: ['valueUnread', 'numUnread', 'screenerStamp'],
  template:
    '<div data-testid="chat-item"><span data-testid="unread-value">{{ valueUnread }}</span><span v-if="screenerStamp" data-testid="chat-screener-stamp">{{ screenerStamp }}</span></div>',
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

/** A received message whose stealth item claims 1000 MON. */
function unreadClaim(payloadDigest: string, stampValueWei: bigint) {
  return {
    outbound: false,
    status: 'confirmed',
    serverTime: 100,
    receivedTime: 100,
    senderAddress: '0xPEER',
    destinationAddress: '0xME',
    payloadDigest,
    outpoints: [],
    stampValueWei,
    items: [{ type: 'stealth', networkTag: 'monad-testnet', amount: 1e21 }],
  }
}

describe('ChatList closeDrawer', () => {
  beforeEach(() => {
    mockPush.mockClear()
    mockChatStore.setActiveConversation.mockClear()
    mockChatStore.getSortedChatOrder = [
      { id: 'thread1', address: 'addr1', totalUnreadMessages: 0 },
    ]
  })

  it.each([390, 1024])(
    'preserves mounted alias dispatch at %ipx',
    async width => {
      const wrapper = await selectChatAt(width)
      mockPush.mockClear()
      mockChatStore.setActiveConversation.mockClear()
      const previousEvents = wrapper.emitted('closeDrawer')?.length ?? 0
      expect(wrapper.vm.setActiveChat('other-thread')).toBeUndefined()
      expect(
        wrapper.vm.setActiveChat(mockChatStore.getSortedChatOrder[0]),
      ).toBeUndefined()
      expect(mockChatStore.setActiveConversation.mock.calls).toEqual([
        ['other-thread'],
        ['thread1'],
      ])
      expect(mockPush.mock.calls).toEqual([
        ['/chat/other-thread'],
        ['/chat/thread1'],
      ])
      expect(
        (wrapper.emitted('closeDrawer')?.length ?? 0) - previousEvents,
      ).toBe(width === 390 ? 2 : 0)
      const selectConversation = jest.fn()
      expect(
        wrapper.vm.setActiveChat.call({ selectConversation }, 'rebound-thread'),
      ).toBeUndefined()
      expect(selectConversation).toHaveBeenCalledWith('rebound-thread')
      expect(mockPush).toHaveBeenCalledTimes(2)
      wrapper.unmount()
    },
  )

  it('passes no unread value when unread messages brought nothing', async () => {
    mockChatStore.getSortedChatOrder = [
      {
        id: 'free-unread',
        address: 'addr1',
        totalUnreadMessages: 2,
        totalUnreadValue: 0,
        lastRead: 0,
        messages: [unreadClaim('free', 0n)],
      },
    ]
    const wrapper = await selectChatAt(390)
    expect(wrapper.get('[data-testid="unread-value"]').text()).toBe('')
    wrapper.unmount()
  })

  it('shows the unread value in AVU: stamps plus verified receipts, never the claim', async () => {
    // 0.5 MON stamp = 1 AVU; the wallet saw 0.01 SOL arrive for the message = 3 AVU. The
    // stealth item's claimed 1000 MON is not counted.
    mockReceipts.paid = [
      { chainIdentifier: 'solana-devnet', baseUnits: 10n ** 7n },
    ]
    mockChatStore.getSortedChatOrder = [
      {
        id: 'paid-unread',
        address: 'addr1',
        totalUnreadMessages: 1,
        lastRead: 0,
        messages: [unreadClaim('paid', 5n * 10n ** 17n)],
      },
    ]
    try {
      const wrapper = await selectChatAt(390)
      expect(wrapper.get('[data-testid="unread-value"]').text()).toBe('≈ 4 AVU')
      wrapper.unmount()
    } finally {
      delete mockReceipts.paid
    }
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

describe('ChatList new conversation action', () => {
  beforeEach(() => {
    mockPush.mockClear()
  })

  it('renders start conversation button and navigates to /new-conversation when clicked', async () => {
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
    expect(wrapper.find('[data-testid="compose-email-btn"]').exists()).toBe(
      false,
    )
    expect(startConvBtn.exists()).toBe(true)
    expect(startConvBtn.attributes('aria-label')).toBe(
      'newContactDialog.startConversation',
    )
    await startConvBtn.trigger('click')
    expect(mockPush).toHaveBeenCalledWith('/new-conversation')
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
    expect(wrapper.find('[data-testid="mailbox-status"]').exists()).toBe(false)
  })
})

// Jest supplies CommonJS require even though Vite's browser modules do not.
// Resolve static imports while loading the component, then prohibit require in
// setup, where the browser has only the already-loaded ESM imports available.
function loadBrowserChatList() {
  const source = readFileSync(`${__dirname}/ChatList.vue`, 'utf8')
  const script = parse(source).descriptor.script?.content
  if (!script) throw new Error('ChatList script is missing')
  const compiled = transpileModule(script, {
    compilerOptions: { module: ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  let loadingImports = true
  const exports: { default?: typeof ChatList } = {}
  const browserRequire = (id: string) => {
    if (!loadingImports) throw new ReferenceError('require is not defined')
    return require(id)
  }
  new Function('require', 'exports', compiled)(browserRequire, exports)
  loadingImports = false
  if (!exports.default) throw new Error('ChatList export is missing')
  return { ...exports.default, render: ChatList.render }
}

describe('ChatList browser screener contact classification', () => {
  it('excludes paid inbound contacts from the queue and in:screener search, and displays per-row screener stamps (#1696)', async () => {
    mockChatStore.getSortedChatOrder = [
      {
        id: 'known-thread',
        address: 'known-contact',
        totalUnreadMessages: 1,
        messages: [
          {
            outbound: false,
            senderAddress: 'known-contact',
            stampValueWei: 100n,
          },
        ],
      },
      {
        id: 'stranger-thread',
        address: 'unknown-stranger',
        totalUnreadMessages: 0,
        messages: [
          {
            outbound: false,
            senderAddress: 'unknown-stranger',
            stampValueWei: 7n,
          },
        ],
      },
      {
        id: 'another-stranger-thread',
        address: 'another-stranger',
        totalUnreadMessages: 1,
        messages: [
          {
            outbound: false,
            senderAddress: 'another-stranger',
            stampValueWei: 5n,
          },
          {
            outbound: true,
            senderAddress: 'self',
            stampValueWei: 0n,
          },
          {
            outbound: false,
            senderAddress: 'another-stranger',
            stampValueWei: 3n,
          },
        ],
      },
    ]
    const wrapper = mount(loadBrowserChatList(), {
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
        mocks: { $status: { setup: true }, $t: (key: string) => key },
      },
    })
    const vm = wrapper.vm as unknown as {
      activeFilter: string
      searchQuery: string
      displayedConversations: Array<{ id: string }>
      screenerSummary: { count: number; totalValueWei: bigint }
    }
    expect(vm.screenerSummary.count).toBe(2)
    // The chip amount is the aggregate value of the pending queue (7n + 3n after historical reply).
    expect(vm.screenerSummary.totalValueWei).toBe(10n)
    vm.activeFilter = 'screener'
    await wrapper.vm.$nextTick()
    expect(vm.displayedConversations.map(c => c.id)).toEqual([
      'stranger-thread',
      'another-stranger-thread',
    ])
    const stampBadges = wrapper.findAll('[data-testid="chat-screener-stamp"]')
    expect(stampBadges).toHaveLength(2)
    expect(stampBadges[0].text()).toContain('7 MON')
    expect(stampBadges[1].text()).toContain('3 MON')
    vm.activeFilter = 'all'
    vm.searchQuery = 'in:screener'
    await wrapper.vm.$nextTick()
    expect(vm.displayedConversations.map(c => c.id).sort()).toEqual([
      'another-stranger-thread',
      'stranger-thread',
    ])
    wrapper.unmount()
  })
})
