/** @jest-environment jsdom */

import fs from 'fs'
import path from 'path'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'

import { openContactProfile } from '../utils/routes'
import ChatInfoView from '../components/panels/ChatInfoView.vue'
import ChatLayout from '../layouts/ChatLayout.vue'

const mockCopy = jest.fn().mockResolvedValue(undefined)
jest.mock('quasar', () => ({
  copyToClipboard: (text: string) => mockCopy(text),
}))

jest.mock('src/utils/notifications', () => ({
  addressCopiedNotify: jest.fn(),
}))

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    parseAddress: (addr: string) => addr,
    formatAddress: (addr: string) => (addr ? `formatted-${addr}` : addr),
  },
}))

jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({
    getContact: () => ({
      profile: {
        name: 'Alice',
        username: 'alice_w',
        bio: 'Hello world',
        avatar: 'alice.png',
        links: [
          { type: 'website', url: 'https://alice.dev', label: 'Portfolio' },
        ],
      },
    }),
    setNotify: jest.fn(),
    getNotify: () => true,
  }),
}))

jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => ({ profile: { avatar: 'owner.png' } }),
}))

jest.mock('src/utils/avatar', () => ({
  profileAvatar: (avatar: string | undefined) => avatar ?? 'default-avatar.png',
}))

jest.mock('src/utils/formatting', () => ({
  pubKeyToColor: () => '#123456',
}))

const mockOwnAddress = ref('0x9999999999999999999999999999999999999999')
jest.mock('src/utils/own-address', () => ({
  useReactiveOwnCanonicalAddress: () => mockOwnAddress,
  sameCanonicalAddress: (first: string | null, second: string | null) =>
    Boolean(first && second && first.toLowerCase() === second.toLowerCase()),
}))

jest.mock('../components/dialogs/ClearHistoryDialog.vue', () => ({
  template: '<div />',
}))
jest.mock('../components/dialogs/DeleteChatDialog.vue', () => ({
  template: '<div />',
}))
jest.mock('../components/dialogs/SendFileDialog.vue', () => ({
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

describe('Chat page bottom bar alignment and message bubble styling (#1043)', () => {
  const sfc = fs.readFileSync(path.join(__dirname, 'Chat.vue'), 'utf8')

  it('aligns chat input bar container min-height (64px) with sidebar balance footer', () => {
    expect(sfc).toMatch(/<q-footer[^>]*:height-hint="64"/)
    expect(sfc).toMatch(/<q-footer[^>]*class="[^"]*chat-footer/)
    expect(sfc).toMatch(
      /\.chat-footer,\s*\.chat-input-bar\s*\{[^}]*min-height:\s*64px/,
    )
    expect(sfc).toMatch(
      /\.chat-footer,\s*\.chat-input-bar\s*\{[^}]*box-sizing:\s*border-box/,
    )
  })

  it('prevents send button clipping with overflow visible and vertical centering', () => {
    expect(sfc).toMatch(
      /:deep\(\.chat-input-toolbar\)\s*\{[^}]*min-height:\s*64px/,
    )
    expect(sfc).toMatch(
      /:deep\(\.chat-input-toolbar\)\s*\{[^}]*align-items:\s*center/,
    )
    expect(sfc).toMatch(
      /:deep\(\.chat-input-toolbar\)\s*\{[^}]*overflow:\s*visible/,
    )
    expect(sfc).toMatch(
      /:deep\(\.chat-send-btn\)\s*\{[^}]*align-self:\s*center/,
    )
  })

  it('refines chat message bubbles corner radius matching the signet theme preview', () => {
    expect(sfc).toMatch(
      /:deep\(\)\s*\.q-message-text--sent\s*\{[^}]*border-radius:\s*18px 18px 4px 18px\s*!important/,
    )
    expect(sfc).toMatch(
      /:deep\(\)\s*\.q-message-text--received\s*\{[^}]*border-radius:\s*18px 18px 18px 4px\s*!important/,
    )
  })
})

describe('Contact profile view navigation and profile details (#1044)', () => {
  it('navigates with ?info=true when openContactProfile is called', () => {
    const mockPush = jest.fn()
    const router = {
      push: mockPush,
      replace: jest.fn(),
      currentRoute: { value: { path: '/forum' } },
    } as any

    openContactProfile(router, '0x1111111111111111111111111111111111111111')
    expect(mockPush).toHaveBeenCalledWith(
      '/chat/0x1111111111111111111111111111111111111111?info=true',
    )
  })

  it('renders contact profile card with avatar, name, username, address, bio, and links in ChatInfoView', async () => {
    const wrapper = mount(ChatInfoView, {
      props: {
        address: '0x1111111111111111111111111111111111111111',
        contact: {
          profile: {
            name: 'Alice Wonderland',
            username: 'alice_w',
            bio: 'Cypherpunk & dev',
            avatar: 'alice.png',
            pubKey: null,
            links: [
              { type: 'website', url: 'https://alice.dev', label: 'Portfolio' },
              {
                type: 'github',
                url: 'https://github.com/alice',
                label: 'GitHub',
              },
            ],
          },
        },
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
        },
        mocks: {
          $t: (k: string) => {
            const translations: Record<string, string> = {
              'chat.sendMessage': 'Send Message',
              'chatList.directMessages': 'Direct Messages',
              'chatRightDrawer.unknownContact': 'Unknown Contact',
              'a11y.copyAddress': 'Copy Address',
            }
            return translations[k] ?? k
          },
        },
      },
    })

    await flushPromises()
    expect(wrapper.find('[data-test="contact-profile-card"]').exists()).toBe(
      true,
    )
    expect(wrapper.find('[data-test="info-contact-avatar"]').exists()).toBe(
      true,
    )
    expect(wrapper.find('[data-test="info-contact-name"]').text()).toBe(
      'Alice Wonderland',
    )
    expect(wrapper.find('[data-test="info-contact-username"]').text()).toBe(
      '@alice_w',
    )
    expect(wrapper.find('[data-test="info-contact-bio"]').text()).toBe(
      'Cypherpunk & dev',
    )
    expect(wrapper.find('[data-test="info-contact-address"]').exists()).toBe(
      true,
    )
    expect(wrapper.find('[data-test="info-contact-links"]').exists()).toBe(true)

    // Action button triggers transition
    const startChatBtn = wrapper.find('[data-test="info-start-chat"]')
    expect(startChatBtn.exists()).toBe(true)
    await startChatBtn.trigger('click')
    expect(wrapper.emitted('chat')).toHaveLength(1)
  })

  it('allows transitioning from contact profile to conversation by clearing ?info=true', async () => {
    const mockReplace = jest.fn()
    const wrapper = mount(ChatLayout, {
      global: {
        mocks: {
          $route: {
            params: { address: '0x1111111111111111111111111111111111111111' },
            query: { info: 'true' },
          },
          $router: { push: jest.fn(), replace: mockReplace },
          $t: (key: string) => key,
        },
        stubs: {
          QHeader: passthrough,
          QToolbar: passthrough,
          QToolbarTitle: passthrough,
          QAvatar: passthrough,
          QBtn: passthrough,
          QSpace: passthrough,
          QMenu: passthrough,
          QList: passthrough,
          QItem: passthrough,
          QItemSection: passthrough,
          QIcon: passthrough,
          QSeparator: passthrough,
          QDialog: true,
          RouterView: {
            template: '<div data-testid="chat-conversation-view" />',
          },
          ChatInfoView: defineComponent({
            emits: ['chat'],
            template:
              '<button data-testid="send-msg-btn" @click="$emit(\'chat\')">Send Message</button>',
          }),
          ClearHistoryDialog: true,
          DeleteChatDialog: true,
          SendFileDialog: true,
        },
      },
    })

    await flushPromises()
    expect(wrapper.find('[data-testid="send-msg-btn"]').exists()).toBe(true)
    expect(
      wrapper.find('[data-testid="chat-conversation-view"]').exists(),
    ).toBe(false)

    // Click Send Message / transition to conversation
    await wrapper.find('[data-testid="send-msg-btn"]').trigger('click')
    await flushPromises()

    expect(mockReplace).toHaveBeenCalledWith({ query: {} })
    expect(
      wrapper.find('[data-testid="chat-conversation-view"]').exists(),
    ).toBe(true)
  })
})
