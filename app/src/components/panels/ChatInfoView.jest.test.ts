/** @jest-environment jsdom */

import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

import ChatInfoView from './ChatInfoView.vue'

const mockCopy = jest.fn().mockResolvedValue(undefined)
jest.mock('quasar', () => ({
  copyToClipboard: (text: string) => mockCopy(text),
}))

const mockAddressCopiedNotify = jest.fn()
jest.mock('../../utils/notifications', () => ({
  addressCopiedNotify: () => mockAddressCopiedNotify(),
}))

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    parseAddress: (addr: string) => addr,
    formatAddress: (addr: string) => (addr ? `formatted-${addr}` : addr),
  },
}))

jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({
    setNotify: jest.fn(),
    getNotify: () => true,
  }),
}))

jest.mock('src/utils/avatar', () => ({
  profileAvatar: (avatar: string | undefined) => avatar ?? 'default-avatar.png',
}))

jest.mock('src/utils/formatting', () => ({
  pubKeyToColor: () => '#123456',
}))

jest.mock('../dialogs/ClearHistoryDialog.vue', () => ({
  name: 'ClearHistoryDialog',
  template: '<div />',
}))
jest.mock('../dialogs/DeleteChatDialog.vue', () => ({
  name: 'DeleteChatDialog',
  template: '<div />',
}))

const passthrough = defineComponent({
  setup(_props, { slots }) {
    return () => h('div', slots.default?.())
  },
})

const QBtnStub = defineComponent({
  props: {
    icon: { type: String, default: '' },
    label: { type: String, default: '' },
    href: { type: String, default: '' },
  },
  emits: ['click'],
  setup(props, { emit, slots }) {
    return () =>
      h(
        'button',
        {
          'data-icon': props.icon,
          'data-label': props.label,
          'data-href': props.href,
          'onClick': (e: MouseEvent) => emit('click', e),
        },
        slots.default ? slots.default() : props.label,
      )
  },
})

describe('ChatInfoView contact profile display and actions', () => {
  const contactWithProfile = {
    profile: {
      name: 'Alice Wonderland',
      username: 'alicew',
      bio: 'Decentralized systems builder and Frank enthusiast.',
      avatar: 'https://example.com/alice.png',
      pubKey: null,
      links: [
        { type: 'website', url: 'https://alice.example.com', label: 'Website' },
        { type: 'github', url: 'https://github.com/alice', label: 'GitHub' },
        { type: 'x', url: 'https://x.com/alice', label: 'Twitter' },
      ],
    },
  }

  function mountView(props = {}) {
    return mount(ChatInfoView, {
      props: {
        address: '0x1111111111111111111111111111111111111111',
        contact: contactWithProfile,
        ...props,
      },
      global: {
        components: {
          QPageContainer: passthrough,
          QPage: passthrough,
          QAvatar: passthrough,
          QBtn: QBtnStub,
          QSeparator: passthrough,
          QList: passthrough,
          QItem: passthrough,
          QItemSection: passthrough,
          QIcon: passthrough,
          QToggle: passthrough,
          QDialog: passthrough,
          QBanner: passthrough,
        },
        mocks: {
          $t: (key: string) => {
            const translations: Record<string, string> = {
              'chat.sendMessage': 'Send Message',
              'chatList.directMessages': 'Direct Messages',
              'chatRightDrawer.unknownContact': 'Unknown Contact',
              'a11y.copyAddress': 'Copy Address',
            }
            return translations[key] ?? key
          },
        },
      },
    })
  }

  it('targets the selected thread for clearing and deletion while displaying the peer address', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const wrapper = mountView({ conversationId: id })
    const clear = wrapper.findComponent({ name: 'ClearHistoryDialog' })
    const remove = wrapper.findComponent({ name: 'DeleteChatDialog' })
    expect(clear.attributes('address')).toBe(id)
    expect(remove.attributes('address')).toBe(id)
    expect(wrapper.get('[data-test="info-contact-address"]').text()).toContain(
      'formatted-0x1111',
    )
  })

  it('renders avatar, name, username, formatted address, bio, and links', async () => {
    const wrapper = mountView()
    await flushPromises()

    // Profile card container
    expect(wrapper.find('[data-test="contact-profile-card"]').exists()).toBe(
      true,
    )

    // Avatar
    const avatar = wrapper.find('[data-test="info-contact-avatar"]')
    expect(avatar.exists()).toBe(true)
    expect(avatar.find('img').attributes('src')).toBe(
      'https://example.com/alice.png',
    )

    // Name
    const nameEl = wrapper.find('[data-test="info-contact-name"]')
    expect(nameEl.text()).toBe('Alice Wonderland')

    // Username with @ prefix
    const usernameEl = wrapper.find('[data-test="info-contact-username"]')
    expect(usernameEl.exists()).toBe(true)
    expect(usernameEl.text()).toBe('@alicew')

    // Bio
    const bioEl = wrapper.find('[data-test="info-contact-bio"]')
    expect(bioEl.exists()).toBe(true)
    expect(bioEl.text()).toBe(
      'Decentralized systems builder and Frank enthusiast.',
    )

    // Address button
    const addressEl = wrapper.find('[data-test="info-contact-address"]')
    expect(addressEl.exists()).toBe(true)
    expect(addressEl.attributes('data-label')).toBe(
      'formatted-0x1111111111111111111111111111111111111111',
    )

    // Links & Socials
    const linksContainer = wrapper.find('[data-test="info-contact-links"]')
    expect(linksContainer.exists()).toBe(true)
    const linkItems = wrapper.findAll('[data-test="info-contact-link-item"]')
    expect(linkItems.length).toBe(3)
    expect(linkItems[0].attributes('data-label')).toBe('Website')
    expect(linkItems[0].attributes('data-href')).toBe(
      'https://alice.example.com',
    )
    expect(linkItems[1].attributes('data-label')).toBe('GitHub')
    expect(linkItems[2].attributes('data-label')).toBe('Twitter')
  })

  it('copies formatted address when address button is clicked', async () => {
    const wrapper = mountView()
    await flushPromises()

    const addressBtn = wrapper.find('[data-test="info-contact-address"]')
    await addressBtn.trigger('click')
    await flushPromises()

    expect(mockCopy).toHaveBeenCalledWith(
      'formatted-0x1111111111111111111111111111111111111111',
    )
    expect(mockAddressCopiedNotify).toHaveBeenCalled()
  })

  it('emits chat event when Send Message action button is clicked', async () => {
    const wrapper = mountView()
    await flushPromises()

    const startChatBtn = wrapper.find('[data-test="info-start-chat"]')
    expect(startChatBtn.exists()).toBe(true)
    expect(startChatBtn.attributes('data-label')).toBe('Send Message')

    await startChatBtn.trigger('click')
    expect(wrapper.emitted('chat')).toHaveLength(1)
  })

  it('handles contacts without username, bio, or links gracefully', async () => {
    const wrapper = mountView({
      contact: {
        profile: {
          name: 'Bob',
          avatar: null,
          pubKey: null,
        },
      },
    })
    await flushPromises()

    expect(wrapper.find('[data-test="info-contact-name"]').text()).toBe('Bob')
    expect(wrapper.find('[data-test="info-contact-username"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('[data-test="info-contact-bio"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="info-contact-links"]').exists()).toBe(
      false,
    )
  })

  it('shows the handle as the confirmed-username pill, which a display name starting with @ does not get', async () => {
    const wrapper = mountView({
      contact: {
        profile: { name: '@qwen', avatar: null, pubKey: null },
      },
    })
    await flushPromises()
    // The name is plain text; there is no handle element at all.
    expect(wrapper.find('[data-test="info-contact-name"]').text()).toBe('@qwen')
    expect(wrapper.find('[data-test="username-handle"]').exists()).toBe(false)

    const real = mountView({
      contact: {
        profile: { name: 'Qwen', username: 'qwen', avatar: null, pubKey: null },
      },
    })
    await flushPromises()
    expect(real.find('[data-test="username-handle"]').text()).toBe('@qwen')
  })

  it('tells the user when the username a contact was added by now belongs to a different account', async () => {
    const wrapper = mountView({
      contact: {
        profile: {
          name: 'Alice',
          username: null,
          addedByUsername: 'alice',
          usernameReassigned: true,
          avatar: null,
          pubKey: null,
        },
      },
    })
    await flushPromises()
    expect(
      wrapper.find('[data-test="info-contact-username-reassigned"]').text(),
    ).toBe('chatRightDrawer.usernameReassigned')
    // The handle it no longer holds is not shown.
    expect(wrapper.find('[data-test="username-handle"]').exists()).toBe(false)

    const pinned = mountView({
      contact: {
        profile: {
          name: 'Alice',
          username: 'alice',
          addedByUsername: 'alice',
          usernameReassigned: false,
          avatar: null,
          pubKey: null,
        },
      },
    })
    await flushPromises()
    expect(
      pinned.find('[data-test="info-contact-username-reassigned"]').exists(),
    ).toBe(false)
  })
})
