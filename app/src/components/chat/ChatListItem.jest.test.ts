/** @jest-environment jsdom */

import { flushPromises, shallowMount } from '@vue/test-utils'
import { messages } from 'src/i18n'
import ChatListItem from './ChatListItem.vue'

let latest: { text: string; outbound: boolean } | null = null
jest.mock('src/stores/chats', () => ({
  useChatStore: () => ({ getLatestMessage: () => latest }),
}))
jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({
    getContactProfile: () => ({ name: 'Alice Profile', avatar: 'alice.png' }),
  }),
}))
jest.mock('src/utils/avatar', () => ({ profileAvatar: () => '' }))
const mockOwnAddress = jest.fn()
jest.mock('src/utils/own-address', () => ({
  getOwnCanonicalAddress: () => mockOwnAddress(),
}))

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
    mockOwnAddress.mockReset()
    mockOwnAddress.mockResolvedValue('0xme')
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
        props: { chatAddress: '0xme', compact: false },
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
      expect(
        (wrapper.vm as unknown as { contact: { avatar: string } }).contact
          .avatar,
      ).toBe('alice.png')
    },
  )
})
