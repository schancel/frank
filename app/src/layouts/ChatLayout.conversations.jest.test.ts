/** @jest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { TextDecoder, TextEncoder } from 'util'
import type { MessageWrapper } from '@frank/cashweb/types/messages'

Object.assign(globalThis, { TextEncoder, TextDecoder })
const mockRows = new Map<string, MessageWrapper>()
const mockClone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async (row: MessageWrapper) =>
      mockRows.set(row.index, mockClone(row)),
    ),
    deleteMessage: jest.fn(async (id: string) => mockRows.delete(id)),
    getIterator: async () => [...mockRows.values()].map(mockClone),
    mostRecentMessageTime: async () => 0,
    suppressedRelayReceipts: async () => new Set(),
  }),
}))
jest.mock('../accounts/session', () => ({
  accountStatus: { status: 'ready' },
  accountSession: { initialize: jest.fn(async () => undefined) },
}))
jest.mock('../router/routes', () => ({
  createRoutes: () => [
    { path: '/forum', component: { template: '<div />' } },
    {
      path: '/add-contact',
      component: jest.requireActual('../pages/AddContact.vue').default,
    },
    {
      path: '/chat/:address',
      component: jest.requireActual('./ChatLayout.vue').default,
      children: [{ path: '', component: { template: '<div />' } }],
    },
  ],
}))
jest.mock('nostics', () => ({
  createConsoleReporter: jest.fn(),
  defineDiagnostics: () => new Proxy({}, { get: () => jest.fn() }),
}))
jest.mock(
  require.resolve('@vue/devtools-api', {
    paths: [require.resolve('vue-router')],
  }),
  () => ({ setupDevtoolsPlugin: jest.fn() }),
)
jest.mock('vue-router', () => {
  const actual = jest.requireActual('vue-router')
  return {
    ...actual,
    createWebHashHistory: actual.createMemoryHistory,
    createWebHistory: actual.createMemoryHistory,
  }
})
jest.mock('quasar', () => ({
  ...jest.requireActual('quasar'),
  useQuasar: () => ({ screen: { width: 1024 }, dark: { isActive: false } }),
}))
jest.mock('../utils/directory-peer', () => ({
  fetchContactProfile: jest.fn(async () => undefined),
  contactLookupFailure: () => 'not-found',
}))
jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('../utils/own-address', () => ({
  ...jest.requireActual('../utils/own-address'),
  getOwnCanonicalAddress: async () =>
    '0x1a1A1A1A1a1A1a1a1a1a1a1a1a1a1a1A1A1a1a1a',
  useReactiveOwnCanonicalAddress: () =>
    jest.requireActual('vue').ref('0x1a1A1A1A1a1A1a1a1a1a1a1a1a1a1a1A1A1a1a1a'),
}))
jest.mock('../components/dialogs/IdentityQrDialog.vue', () => ({
  template: '<i />',
}))

/* eslint-disable @typescript-eslint/no-var-requires */
const { useChatStore, rehydrateState } = require('../stores/chats')
const { useContactStore } = require('../stores/contacts')
const { setStartupRestoration } = require('../boot/startup-state')
const createAppRouter = require('../router').default
const ChatList = require('../components/chat/ChatList.vue').default
const ChatListItem = require('../components/chat/ChatListItem.vue').default
const ChatLayout = require('./ChatLayout.vue').default
const AddContact = require('../pages/AddContact.vue').default
const quasar = require('quasar')
const en = require('../i18n/en-us').default
/* eslint-enable @typescript-eslint/no-var-requires */
const PEER = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'
const OTHER = '0x3333333333333333333333333333333333333333'
const SELF = '0x1a1A1A1A1a1A1a1a1a1a1a1a1a1a1a1A1A1a1a1a'
const simple = { template: '<div><slot /></div>' }
const controls = Object.fromEntries(
  Object.keys(quasar)
    .filter(name => /^Q[A-Z]/.test(name))
    .map(name => [name, simple]),
)
controls.QBtn = defineComponent({
  props: { label: String, disable: Boolean },
  setup:
    (props, { slots }) =>
    () =>
      h('button', { disabled: props.disable }, [
        props.label,
        slots.default?.(),
      ]),
})
controls.QInput = defineComponent({
  props: { modelValue: String, label: String },
  emits: ['update:modelValue'],
  methods: {
    focus() {
      ;(this.$el as HTMLInputElement).focus()
    },
  },
  setup:
    (props, { emit }) =>
    () =>
      h('input', {
        'value': props.modelValue,
        'aria-label': props.label,
        'onInput': (event: Event) =>
          emit('update:modelValue', (event.target as HTMLInputElement).value),
      }),
})
controls.QDialog = defineComponent({
  props: { modelValue: Boolean },
  setup:
    (props, { slots }) =>
    () =>
      props.modelValue ? h('div', slots.default?.()) : null,
})
const translate = (key: string) =>
  key.split('.').reduce((value, part) => value?.[part], en) ?? key
async function settle() {
  await nextTick()
  await flushPromises()
}

async function mountedConversations(bot = false) {
  const pinia = createPinia()
  let persistence: { save: (...args: unknown[]) => Promise<void> }
  pinia.use(({ store, options }) => {
    if (store.$id === 'chats')
      persistence = options.storage as typeof persistence
  })
  createApp({}).use(pinia)
  setActivePinia(pinia)
  setStartupRestoration({ phase: 'restored' })
  const router = createAppRouter()
  await router.push('/forum')
  await router.isReady()
  const root = mount(
    defineComponent({
      components: { ChatList },
      template: '<div><ChatList :compact="false" /><router-view /></div>',
    }),
    {
      global: {
        plugins: [pinia, router],
        components: controls,
        mocks: {
          $t: translate,
          $q: { dark: { isActive: false } },
          $status: { setup: true },
        },
      },
    },
  )
  const chats = useChatStore()
  const contacts = useContactStore()
  for (const [address, name] of [
    [PEER, bot ? 'Helper bot' : 'Alice'],
    [OTHER, 'Other peer'],
  ]) {
    contacts.addContact({
      address,
      contact: {
        lastUpdateTime: Date.now(),
        profile: {
          name,
          signedName: name,
          isBot: bot,
          avatar: '',
          bio: '',
          pubKey: null,
        },
      },
    })
  }
  await settle()
  const create = async (address: string, subject: string, explicit = true) => {
    if (explicit)
      await root.get('[data-testid="start-conversation-btn"]').trigger('click')
    else await router.push('/add-contact')
    await settle()
    const page = root.getComponent(AddContact)
    await page.get('[data-test="address-input"]').setValue(address)
    await settle()
    if (explicit) await page.get('[data-test="topic-input"]').setValue(subject)
    await page
      .get(
        explicit
          ? '[data-test="start-conversation-btn"]'
          : '[data-test="add-and-chat-btn"]',
      )
      .trigger('click')
    await settle()
    return chats.activeConversationId as string
  }
  const select = async (id: string) => {
    const item = root
      .findAllComponents(ChatListItem)
      .find(item => item.props('conversationId') === id)
    expect(item).toBeDefined()
    await item!.trigger('click')
    await settle()
    expect(router.currentRoute.value.params.address).toBe(id)
    expect(chats.activeConversationId).toBe(id)
  }
  return {
    root,
    chats,
    contacts,
    router,
    create,
    select,
    persistence: () => persistence,
  }
}

beforeEach(() => {
  mockRows.clear()
  jest.clearAllMocks()
  jest.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
})
afterEach(() => jest.restoreAllMocks())

it.each([false, true])(
  'creates a fresh blank-subject thread for a peer (bot: %s)',
  async bot => {
    const app = await mountedConversations(bot)
    try {
      const defaultId = await app.create(PEER, '', false)
      const first = await app.create(PEER, '')
      const second = await app.create(PEER, '')
      expect(new Set([defaultId, first, second]).size).toBe(3)
      expect(app.router.currentRoute.value.params.address).toBe(second)
      expect(app.chats.chats[PEER].id).toBe(defaultId)
    } finally {
      app.root.unmount()
    }
  },
)

it('renders an explicit subject in the header and provides its editor', async () => {
  const app = await mountedConversations()
  try {
    const id = await app.create(PEER, 'Project plan')
    const layout = app.root.getComponent(ChatLayout)
    expect(layout.get('.h6').text()).toContain('Project plan')
    expect(
      layout.find('[data-testid="edit-conversation-subject"]').exists(),
    ).toBe(true)
    expect(
      app.root
        .findAllComponents(ChatListItem)
        .find(item => item.props('conversationId') === id)
        ?.text(),
    ).toContain('Project plan')
  } finally {
    app.root.unmount()
  }
})

it.each([false, true])(
  'keeps equal subjects, edits and recovered attempts independent (bot: %s)',
  async bot => {
    const app = await mountedConversations(bot)
    try {
      const defaultId = await app.create(PEER, '', false)
      const first = await app.create(PEER, 'Same subject')
      const second = await app.create(PEER, 'Same subject')
      const blank = await app.create(PEER, '')
      const other = await app.create(OTHER, 'Same subject')
      expect(new Set([defaultId, first, second, blank, other]).size).toBe(5)
      expect(
        app.root
          .findAllComponents(ChatListItem)
          .map(item => item.props('conversationId'))
          .sort(),
      ).toEqual([defaultId, first, second, blank, other].sort())
      expect(app.chats.conversations[first].topic).toBeUndefined()
      for (const [id, peer] of [
        [first, PEER],
        [second, PEER],
        [other, OTHER],
      ]) {
        await app.chats.receiveMessages([
          {
            index: `received-${id}`,
            conversationId: id,
            outbound: false,
            senderAddress: peer,
            copartyAddress: peer,
            copartyPubKey: { toBuffer: () => new Uint8Array(33) },
            stampValue: 0,
            message: {
              conversationId: id,
              outbound: false,
              senderAddress: peer,
              status: 'confirmed',
              receivedTime: 100,
              serverTime: 100,
              outpoints: [],
              items: [{ type: 'text', text: `Only ${id}` }],
            },
          },
        ])
      }
      expect(app.chats.conversations[first].totalUnreadMessages).toBe(1)
      expect(app.chats.conversations[second].totalUnreadMessages).toBe(1)
      await app.select(first)
      expect(
        app.chats.activeConversation.messages.map(
          message => message.payloadDigest,
        ),
      ).toEqual([`received-${first}`])
      expect(app.chats.conversations[first].totalUnreadMessages).toBe(0)
      expect(app.chats.conversations[second].totalUnreadMessages).toBe(1)
      app.chats.sendMessageLocal({
        address: PEER,
        conversationId: first,
        senderAddress: SELF,
        index: 'pending-ui-test',
        logicalMessageId: 'logical-ui-test',
        status: 'payment-pending',
        items: [{ type: 'text', text: 'Existing pending message' }],
        outpoints: [],
        previousHash: null,
        timestamp: 101,
        delivery: { attemptDigest: 'original-funded-attempt' },
      })
      await app.chats.saveOutgoing(PEER, 'pending-ui-test', { strict: true })
      const original = mockClone(app.chats.conversations[first])
      const sibling = mockClone(app.chats.conversations[second])
      const edit = async (subject: string, save: boolean) => {
        await app.root
          .get('[data-testid="edit-conversation-subject"]')
          .trigger('click')
        await app.root
          .get('[data-testid="conversation-subject-input"]')
          .setValue(subject)
        await app.root
          .get(
            `[data-testid="conversation-subject-${save ? 'save' : 'cancel'}"]`,
          )
          .trigger('click')
        await settle()
      }
      await edit('  Renamed subject  ', true)
      expect(app.chats.conversations[first].name).toBe('Renamed subject')
      expect(app.root.getComponent(ChatLayout).get('.h6').text()).toContain(
        'Renamed subject',
      )
      expect(
        app.root
          .findAllComponents(ChatListItem)
          .find(item => item.props('conversationId') === first)
          ?.text(),
      ).toContain('Renamed subject')
      expect(app.router.currentRoute.value.params.address).toBe(first)
      await edit('Same subject', true)
      const {
        name: _name,
        updatedAt: _updatedAt,
        ...unchanged
      } = mockClone(app.chats.conversations[first])
      const { name: _oldName, updatedAt: _oldTime, ...before } = original
      expect(unchanged).toEqual(before)
      expect(app.chats.conversations[second]).toEqual(sibling)
      await edit('Canceled subject', false)
      expect(app.chats.conversations[first].name).toBe('Same subject')
      await app.root
        .get('[data-testid="edit-conversation-subject"]')
        .trigger('click')
      await app.root
        .get('[data-testid="conversation-subject-input"]')
        .setValue('   ')
      expect(
        (
          app.root.get('[data-testid="conversation-subject-save"]')
            .element as HTMLButtonElement
        ).disabled,
      ).toBe(true)
      await app.root
        .get('[data-testid="conversation-subject-cancel"]')
        .trigger('click')
      await app.root
        .get('[data-testid="edit-conversation-subject"]')
        .trigger('click')
      await app.root
        .get('[data-testid="conversation-subject-input"]')
        .setValue('Wrong thread')
      const delayedSave = app.root.getComponent(ChatLayout).vm.saveSubject
      await app.select(second)
      expect(
        app.root.find('[data-testid="conversation-subject-save"]').exists(),
      ).toBe(false)
      delayedSave()
      expect(app.chats.conversations[first].name).toBe('Same subject')
      expect(app.chats.conversations[second].name).toBe('Same subject')
      expect(
        app.chats.activeConversation.messages.map(
          message => message.payloadDigest,
        ),
      ).toEqual([`received-${second}`])
      expect(await app.create(PEER, '', false)).toBe(defaultId)
      let metadata = ''
      await app.persistence().save(
        {
          put: async (_key: string, value: string) => {
            metadata = value
          },
        },
        null,
        app.chats.$state,
      )
      const restored = await rehydrateState(JSON.parse(metadata))
      expect(Object.keys(restored.conversations).sort()).toEqual(
        [defaultId, first, second, blank, other].sort(),
      )
      expect(restored.conversations[first].name).toBe('Same subject')
      expect(restored.conversations[second].name).toBe('Same subject')
      expect(restored.messages['pending-ui-test']).toMatchObject({
        conversationId: first,
        logicalMessageId: 'logical-ui-test',
        delivery: { attemptDigest: 'original-funded-attempt' },
      })
    } finally {
      app.root.unmount()
    }
  },
)
