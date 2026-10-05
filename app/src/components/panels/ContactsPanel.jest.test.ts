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
const mockContacts = ref({
  '0x1111111111111111111111111111111111111111': {
    profile: { name: 'Alice', avatar: 'alice.png' },
  },
  '0x2222222222222222222222222222222222222222': {
    profile: { name: 'Bob', avatar: 'bob.png' },
  },
})

jest.mock('pinia', () => ({
  storeToRefs: () => ({
    getContacts: mockContacts,
  }),
}))

jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({
    getContacts: mockContacts,
    deleteContact: mockDeleteContact,
  }),
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

  function mountPanel() {
    return mount(ContactsPanel, {
      global: {
        components: {
          QScrollArea: passthrough,
          QList: passthrough,
          QItem: passthrough,
          QItemSection: passthrough,
          QItemLabel: passthrough,
          QSeparator: passthrough,
          QSpace: passthrough,
          QAvatar: passthrough,
          QInput: passthrough,
          QIcon: passthrough,
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
})
