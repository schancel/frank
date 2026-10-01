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
