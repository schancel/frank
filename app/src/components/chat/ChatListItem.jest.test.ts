/** @jest-environment jsdom */

import { flushPromises, shallowMount } from '@vue/test-utils'
import { messages } from 'src/i18n'
import { ref } from 'vue'
import ChatListItem from './ChatListItem.vue'

let latest: { text: string; outbound: boolean } | null = null
jest.mock('src/stores/chats', () => ({
  useChatStore: () => ({ getLatestMessage: () => latest }),
}))
jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({
    getContactProfile: () => ({ name: 'Alice Profile', avatar: undefined }),
  }),
}))
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => ({ profile: { avatar: 'local-owner.png' } }),
}))
jest.mock('src/utils/avatar', () => ({
  profileAvatar: (avatar: string | undefined) => avatar ?? 'fallback.png',
}))
const mockOwnAddress = ref<string | null>(null)
jest.mock('src/utils/own-address', () => ({
  useReactiveOwnCanonicalAddress: () => mockOwnAddress,
  sameCanonicalAddress: (first: string | null, second: string | null) =>
    Boolean(first && second && first.toLowerCase() === second.toLowerCase()),
}))

const OWN_ADDRESS = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'

// vue-i18n's ESM browser build cannot load under this Jest config, so `$t` is a small lookup over
// the app's real message tables (same `{name}` interpolation).
function translator(locale: string) {
  const table = messages[locale as keyof typeof messages]
  return (key: string, params: Record<string, unknown> = {}) => {
    const text = key
      .split('.')
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown>)?.[part],
        table,
      )
    return String(text).replace(/\{(\w+)\}/g, (_m, name) =>
      String(params[name]),
    )
  }
}

function preview(locale: string) {
  const wrapper = shallowMount(ChatListItem, {
    props: { chatAddress: '0xabc', compact: false },
    global: {
      mocks: {
        $t: translator(locale),
        $status: { setup: true },
        $route: { params: {} },
      },
    },
  })
  return (wrapper.vm as unknown as { latestMessageBody: string })
    .latestMessageBody
}

describe('ChatListItem message preview (ticket #274)', () => {
  beforeEach(() => {
    mockOwnAddress.value = OWN_ADDRESS
  })

  it.each([
    ['en-us', true, 'You: after recovery'],
    ['fr-fr', true, 'Vous : after recovery'],
    ['en-us', false, 'Them: after recovery'],
    ['fr-fr', false, 'Contact : after recovery'],
  ])('%s outbound=%s reads %j', (locale, outbound, expected) => {
    latest = { text: 'after recovery', outbound }
    expect(preview(locale)).toBe(expected)
  })

  it('stays empty when there is no message yet', () => {
    latest = null
    expect(preview('fr-fr')).toBe('')
  })

  it.each([
    ['en-us', 'You'],
    ['fr-fr', 'Vous'],
  ])(
    'labels the own-address row %j and keeps the profile avatar',
    async (locale, label) => {
      const wrapper = shallowMount(ChatListItem, {
        props: { chatAddress: OWN_ADDRESS.toLowerCase(), compact: false },
        global: {
          mocks: {
            $t: translator(locale),
            $status: { setup: true },
            $route: { params: {} },
          },
        },
      })

      await flushPromises()
      expect(wrapper.text()).toContain(label)
      expect(wrapper.text()).not.toContain('Alice Profile')
      expect(wrapper.get('img').attributes('src')).toBe('local-owner.png')
    },
  )

  it('drops the old You/avatar presentation immediately during replacement', async () => {
    const wrapper = shallowMount(ChatListItem, {
      props: { chatAddress: OWN_ADDRESS, compact: false },
      global: {
        mocks: {
          $t: translator('en-us'),
          $status: { setup: true },
          $route: { params: {} },
        },
      },
    })
    expect(wrapper.text()).toContain('You')
    mockOwnAddress.value = null
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Alice Profile')
    expect(wrapper.get('img').attributes('src')).toBe('fallback.png')
  })
})

describe('ChatListItem conversation-oriented display (#943)', () => {
  beforeEach(() => {
    mockOwnAddress.value = OWN_ADDRESS
  })

  it('renders conversation topic/name when provided', () => {
    const wrapper = shallowMount(ChatListItem, {
      props: {
        conversation: {
          id: 'conv-uuid-1',
          topic: 'Token Engineering Working Group',
          participants: ['0x1111111111111111111111111111111111111111'],
        },
        compact: false,
      },
      global: {
        mocks: {
          $t: translator('en-us'),
          $status: { setup: true },
          $route: { params: {} },
        },
      },
    })
    expect(wrapper.text()).toContain('Token Engineering Working Group')
  })

  it('displays participant badges up to 3 and calculates remaining overflow, excluding own address', () => {
    const participants = [
      OWN_ADDRESS,
      '0x2222222222222222222222222222222222222222',
      '0x3333333333333333333333333333333333333333',
      '0x4444444444444444444444444444444444444444',
      '0x5555555555555555555555555555555555555555',
    ]
    const wrapper = shallowMount(ChatListItem, {
      props: {
        conversation: {
          id: 'conv-uuid-2',
          topic: 'Multi-party Chat',
          participants,
        },
        compact: false,
      },
      global: {
        mocks: {
          $t: translator('en-us'),
          $status: { setup: true },
          $route: { params: {} },
        },
      },
    })
    const vm = wrapper.vm as any
    expect(vm.displayParticipants).toHaveLength(3)
    expect(vm.displayParticipants).not.toContain(OWN_ADDRESS)
    expect(vm.remainingParticipantsCount).toBe(1)
    expect(vm.formatParticipant(OWN_ADDRESS)).toBe('You')
  })

  it('omits participant badges for 1-on-1 direct messages without separate topic', () => {
    const wrapper = shallowMount(ChatListItem, {
      props: {
        conversation: {
          id: 'conv-1on1',
          participants: [
            OWN_ADDRESS,
            '0x2222222222222222222222222222222222222222',
          ],
        },
        compact: false,
      },
      global: {
        mocks: {
          $t: translator('en-us'),
          $status: { setup: true },
          $route: { params: {} },
        },
      },
    })
    const vm = wrapper.vm as any
    expect(vm.displayParticipants).toHaveLength(0)
    expect(vm.remainingParticipantsCount).toBe(0)
    expect(wrapper.find('.participant-badges').exists()).toBe(false)
  })

  it('formats conversation timestamp properly', () => {
    const timestamp = 1717171717000
    const wrapper = shallowMount(ChatListItem, {
      props: {
        conversation: {
          id: 'conv-uuid-3',
          topic: 'Timestamped Conversation',
          participants: [OWN_ADDRESS],
          lastReceived: timestamp,
        },
        compact: false,
      },
      global: {
        mocks: {
          $t: translator('en-us'),
          $status: { setup: true },
          $route: { params: {} },
        },
      },
    })
    const vm = wrapper.vm as any
    expect(vm.formattedTimestamp).toBeTruthy()
    expect(typeof vm.formattedTimestamp).toBe('string')
  })

  it('does not highlight an independent thread merely because it shares the active peer', () => {
    const isActive = (ChatListItem as any).computed.isActive
    const context = {
      chatStore: {
        activeConversationId: 'selected',
        activeChatAddr: OWN_ADDRESS,
      },
      effectiveId: 'independent',
      effectiveAddress: OWN_ADDRESS,
      $route: { params: { address: OWN_ADDRESS } },
    }
    expect(isActive.call(context)).toBe(false)
    expect(isActive.call({ ...context, effectiveId: 'selected' })).toBe(true)
  })

  it('marks item as active when matching route params address or id', () => {
    const wrapper = shallowMount(ChatListItem, {
      props: {
        conversation: {
          id: 'conv-active-id',
          topic: 'Active Chat',
          participants: [OWN_ADDRESS],
        },
        compact: false,
      },
      global: {
        mocks: {
          $t: translator('en-us'),
          $status: { setup: true },
          $route: { params: { address: 'conv-active-id' } },
        },
      },
    })
    const vm = wrapper.vm as any
    expect(vm.isActive).toBe(true)
  })
})

describe('ChatListItem title line', () => {
  it('keeps the name and its badge in one wrapping group, apart from the time and unread count', () => {
    mockOwnAddress.value = OWN_ADDRESS
    const wrapper = shallowMount(ChatListItem, {
      props: {
        chatAddress: '0x1111111111111111111111111111111111111111',
        timestamp: Date.now(),
        numUnread: 2,
        compact: false,
      },
      global: {
        mocks: {
          $t: translator('en-us'),
          $status: { setup: true },
          $route: { params: {} },
        },
      },
    })
    const title = wrapper.find('[data-testid="chat-list-title"]')
    expect(title.exists()).toBe(true)
    // The badge may wrap under the name: the group must not force a single clipped line.
    expect(title.classes()).not.toContain('no-wrap')
    expect(title.text()).toContain('Alice Profile')
    expect(title.findComponent({ name: 'AccountBadge' }).exists()).toBe(true)
    expect(title.find('[data-testid="chat-timestamp"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="chat-timestamp"]').exists()).toBe(true)
  })
})

describe('ChatListItem email thread indicator (ticket-unverified-peer-email-frames)', () => {
  beforeEach(() => {
    mockOwnAddress.value = OWN_ADDRESS
  })

  it('renders blue mail icon and no warning badge for verified gateway email thread', () => {
    const wrapper = shallowMount(ChatListItem, {
      props: {
        conversation: {
          id: 'conv-verified-email',
          kind: 'email',
          topic: 'Verified Newsletter',
          participants: [
            OWN_ADDRESS,
            '0x1111111111111111111111111111111111111111',
          ],
          verifiedGateway: true,
        },
        compact: false,
      },
      global: {
        mocks: {
          $t: translator('en-us'),
          $status: { setup: true },
          $route: { params: {} },
        },
      },
    })
    const vm = wrapper.vm as any
    expect(vm.isEmail).toBe(true)
    expect(vm.isVerifiedGateway).toBe(true)
    expect(wrapper.find('[data-testid="verified-email-icon"]').exists()).toBe(
      true,
    )
    expect(wrapper.find('[data-testid="unverified-email-icon"]').exists()).toBe(
      false,
    )
    expect(
      wrapper.find('[data-testid="unverified-email-badge"]').exists(),
    ).toBe(false)
  })

  it('renders warning icon and P2P badge for unverified peer email thread', () => {
    const wrapper = shallowMount(ChatListItem, {
      props: {
        conversation: {
          id: 'conv-unverified-email',
          kind: 'email',
          topic: 'Peer Author Email',
          participants: [
            OWN_ADDRESS,
            '0x9999999999999999999999999999999999999999',
          ],
          verifiedGateway: false,
        },
        compact: false,
      },
      global: {
        mocks: {
          $t: translator('en-us'),
          $status: { setup: true },
          $route: { params: {} },
        },
      },
    })
    const vm = wrapper.vm as any
    expect(vm.isEmail).toBe(true)
    expect(vm.isVerifiedGateway).toBe(false)
    expect(wrapper.find('[data-testid="verified-email-icon"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('[data-testid="unverified-email-icon"]').exists()).toBe(
      true,
    )
    expect(
      wrapper.find('[data-testid="unverified-email-badge"]').exists(),
    ).toBe(true)
  })
})

describe('ChatListItem subject', () => {
  const PEER = '0x2222222222222222222222222222222222222222'
  const mountRow = (conversation: Record<string, unknown>) =>
    shallowMount(ChatListItem, {
      props: { conversation: conversation as never, compact: false },
      global: {
        mocks: {
          $t: translator('en-us'),
          $status: { setup: true },
          $route: { params: {} },
        },
      },
    })

  beforeEach(() => {
    mockOwnAddress.value = OWN_ADDRESS
  })

  it('shows the peer as the title and the subject on its own line', () => {
    const wrapper = mountRow({
      id: 'conv-subject',
      name: 'Project plan',
      address: PEER,
      participants: [OWN_ADDRESS, PEER],
    })
    expect(wrapper.get('[data-testid="chat-list-title"]').text()).toBe(
      'Alice Profile',
    )
    expect(wrapper.get('[data-testid="chat-list-subject"]').text()).toBe(
      'Project plan',
    )
  })

  it('shows only the peer when the conversation has no subject', () => {
    for (const name of [undefined, '', '   ']) {
      const wrapper = mountRow({
        id: 'conv-plain',
        name,
        address: PEER,
        participants: [OWN_ADDRESS, PEER],
      })
      expect(wrapper.get('[data-testid="chat-list-title"]').text()).toBe(
        'Alice Profile',
      )
      expect(wrapper.find('[data-testid="chat-list-subject"]').exists()).toBe(
        false,
      )
    }
  })

  it('keeps an email thread titled by its subject', () => {
    const wrapper = mountRow({
      id: 'conv-email',
      kind: 'email',
      name: 'Invoice 12',
      address: PEER,
      participants: [PEER],
      verifiedGateway: true,
    })
    expect(wrapper.get('[data-testid="chat-list-title"]').text()).toContain(
      'Invoice 12',
    )
    expect(wrapper.find('[data-testid="chat-list-subject"]').exists()).toBe(
      false,
    )
  })
})
