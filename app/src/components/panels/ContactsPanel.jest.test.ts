/** @jest-environment jsdom */

import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'

import ContactsPanel from './ContactsPanel.vue'

const mockPush = jest.fn()
const mockReplace = jest.fn()
jest.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
    currentRoute: { value: { path: '/forum' } },
  }),
}))

const mockDeleteContact = jest.fn()
const mockAddContact = jest.fn()
const mockContacts = ref<Record<string, any>>({
  '0x1111111111111111111111111111111111111111': {
    profile: { name: 'Alice', avatar: 'alice.png' },
  },
  '0x2222222222222222222222222222222222222222': {
    profile: { name: 'Bob', avatar: 'bob.png' },
  },
})

const mockSearchMonadProfiles = jest.fn()
const mockDecodeProfileBytes = jest.fn()
jest.mock('@frank/wallet/monad-identity', () => ({
  searchMonadProfiles: (...args: any[]) => mockSearchMonadProfiles(...args),
  decodeProfileBytes: (...args: any[]) => mockDecodeProfileBytes(...args),
}))

jest.mock('@frank/wallet/chain/monad-chain', () => ({
  loadMonadChainConfigFromEnv: () => ({ relayBaseUrl: 'http://relay.test' }),
}))

jest.mock('src/utils/own-address', () => ({
  isOwnAddress: jest.fn(async () => false),
}))

const mockAxiosGet = jest.fn(async () => ({ data: null }))
jest.mock('axios', () => ({
  get: (...args: any[]) => mockAxiosGet(...args),
}))

jest.mock('pinia', () => ({
  storeToRefs: () => ({
    getContacts: mockContacts,
  }),
}))

jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({
    getContacts: mockContacts,
    deleteContact: mockDeleteContact,
    addContact: mockAddContact,
    isContact: (addr: string) => Boolean(mockContacts.value[addr]),
    refresh: jest.fn(),
  }),
  pendingRelayData: {
    profile: { name: '', bio: '', avatar: null, pubKey: null },
  },
}))

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    parseAddress: (addr: string) => addr,
    formatAddress: (addr: string) => addr,
  },
}))

jest.mock('src/utils/avatar', () => ({
  profileAvatar: (avatar: string | undefined) => avatar ?? 'avatar.png',
}))

const passthrough = defineComponent({
  setup(_props, { slots }) {
    return () => h('div', slots.default?.())
  },
})

describe('ContactsPanel navigation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  function mountPanel(width = 1024) {
    return mount(ContactsPanel, {
      global: {
        provide: {
          _q_: { screen: { width } },
        },
        components: {
          QScrollArea: passthrough,
          QList: passthrough,
          QItem: passthrough,
          QItemSection: passthrough,
          QItemLabel: passthrough,
          QSeparator: passthrough,
          QSpace: passthrough,
          QAvatar: passthrough,
          QInput: defineComponent({
            props: ['modelValue'],
            emits: ['update:modelValue'],
            setup(props, { emit }) {
              return () =>
                h('input', {
                  value: props.modelValue,
                  onInput: (e: any) =>
                    emit('update:modelValue', e.target.value),
                })
            },
          }),
          QIcon: passthrough,
          QBadge: defineComponent({
            props: ['label'],
            setup(props, { slots }) {
              return () => h('span', props.label || slots.default?.())
            },
          }),
          QSpinner: passthrough,
          QBtn: defineComponent({
            props: {
              icon: { type: String, default: '' },
              ariaLabel: { type: String, default: '' },
            },
            emits: ['click'],
            setup(props, { emit, slots }) {
              return () =>
                h(
                  'button',
                  {
                    'data-icon': props.icon,
                    'onClick': (e: MouseEvent) => emit('click', e),
                  },
                  slots.default?.(),
                )
            },
          }),
        },
        directives: {
          ripple: () => undefined,
        },
        mocks: {
          $t: (k: string) => k,
        },
      },
    })
  }

  it('clicking a contact row opens the contact profile instead of chat directly', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    const rows = wrapper.findAll('[data-test="contact-list-row"]')
    expect(rows.length).toBe(2)

    await rows[0].trigger('click')
    expect(mockPush).toHaveBeenCalledWith(
      '/chat/0x1111111111111111111111111111111111111111?info=true',
    )
  })

  it('emits closeDrawer when clicking a contact on a narrow viewport', async () => {
    const wrapper = mountPanel(500)
    await flushPromises()

    const rows = wrapper.findAll('[data-test="contact-list-row"]')
    await rows[0].trigger('click')

    expect(wrapper.emitted('closeDrawer')).toBeTruthy()
  })

  it('does not emit closeDrawer when clicking a contact on a desktop viewport', async () => {
    const wrapper = mountPanel(1024)
    await flushPromises()

    const rows = wrapper.findAll('[data-test="contact-list-row"]')
    await rows[0].trigger('click')

    expect(wrapper.emitted('closeDrawer')).toBeFalsy()
  })

  it('clicking the chat icon button opens chat directly', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    const chatButtons = wrapper.findAll('button[data-icon="chat"]')
    expect(chatButtons.length).toBe(2)

    await chatButtons[0].trigger('click')
    expect(mockPush).toHaveBeenCalledWith(
      '/chat/0x1111111111111111111111111111111111111111',
    )
  })

  it('clicking delete icon removes the contact', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    const deleteButtons = wrapper.findAll('button[data-icon="delete"]')
    expect(deleteButtons.length).toBe(2)

    await deleteButtons[0].trigger('click')
    expect(mockDeleteContact).toHaveBeenCalledWith(
      '0x1111111111111111111111111111111111111111',
    )
  })

  it('clicking My QR button opens IdentityQrDialog', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    const qrBtn = wrapper.find('[data-test="panel-my-qr"]')
    expect(qrBtn.exists()).toBe(true)

    expect((wrapper.vm as any).showMyQrDialog).toBe(false)
    await qrBtn.trigger('click')
    expect((wrapper.vm as any).showMyQrDialog).toBe(true)
  })

  describe('Network Directory Search', () => {
    beforeEach(() => {
      jest.useFakeTimers({
        doNotFake: ['setImmediate', 'nextTick'],
      })
    })
    afterEach(() => {
      jest.useRealTimers()
    })

    it('searches the relay directory when input is >= 2 characters', async () => {
      mockSearchMonadProfiles.mockResolvedValueOnce([
        {
          address: '0x3333333333333333333333333333333333333333',
          rawBytes: new Uint8Array([1, 2, 3]),
        },
      ])
      mockDecodeProfileBytes.mockReturnValueOnce({
        name: 'Qwen Bot',
        avatar: 'qwen.png',
        bio: 'AI Assistant',
        bot: true,
      })

      const wrapper = mountPanel()
      await flushPromises()

      const input = wrapper.find('input')
      await input.setValue('qw')
      jest.advanceTimersByTime(350)
      await flushPromises()

      expect(mockSearchMonadProfiles).toHaveBeenCalledWith({
        relayBaseUrl: 'http://relay.test',
        prefix: 'qw',
        limit: 10,
      })

      const results = wrapper.findAll('[data-test="directory-search-result"]')
      expect(results.length).toBe(1)
      expect(results[0].text()).toContain('Qwen Bot')
      expect(results[0].text()).toContain('BOT')
    })

    it('clicking a directory search result adds the contact and navigates to chat', async () => {
      mockSearchMonadProfiles.mockResolvedValueOnce([
        {
          address: '0x3333333333333333333333333333333333333333',
          rawBytes: new Uint8Array([1, 2, 3]),
        },
      ])
      mockDecodeProfileBytes.mockReturnValueOnce({
        name: 'Qwen Bot',
        avatar: 'qwen.png',
        bot: true,
      })

      const wrapper = mountPanel()
      await flushPromises()

      const input = wrapper.find('input')
      await input.setValue('qwen')
      jest.advanceTimersByTime(350)
      await flushPromises()

      const result = wrapper.find('[data-test="directory-search-result"]')
      await result.trigger('click')

      expect(mockAddContact).toHaveBeenCalledWith(
        expect.objectContaining({
          address: '0x3333333333333333333333333333333333333333',
          contact: expect.objectContaining({
            profile: expect.objectContaining({
              name: 'Qwen Bot',
              isBot: true,
            }),
          }),
        }),
      )
      expect(mockPush).toHaveBeenCalledWith(
        '/chat/0x3333333333333333333333333333333333333333',
      )
    })

    it('searches by exact username handle and displays handle alongside name', async () => {
      mockSearchMonadProfiles.mockResolvedValueOnce([])
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          username: 'charlie',
          address: '0x4444444444444444444444444444444444444444',
          status: 'active',
          entry: null,
        },
      })

      const wrapper = mountPanel()
      await flushPromises()

      const input = wrapper.find('input')
      await input.setValue('@charlie')
      jest.advanceTimersByTime(350)
      await flushPromises()

      expect(mockAxiosGet).toHaveBeenCalledWith(
        'http://relay.test/directory/user/charlie',
      )

      const results = wrapper.findAll('[data-test="directory-search-result"]')
      expect(results.length).toBe(1)
      expect(results[0].text()).toContain('@charlie')
    })
  })
})
