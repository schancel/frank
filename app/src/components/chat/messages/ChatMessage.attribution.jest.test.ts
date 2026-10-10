/** @jest-environment jsdom */

/**
 * The bubble wrapper in its two modes: a chat between two people is drawn exactly as before;
 * with more than two people a message that is not ours carries its sender.
 */
import { shallowMount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

import ChatMessage from './ChatMessage.vue'
import enUS from '../../../i18n/en-us'
import frFR from '../../../i18n/fr-fr'

jest.mock('../../../stores/chats', () => ({
  useChatStore: () => ({
    deleteMessage: jest.fn(),
    getStampAmount: () => 0,
    sendMessage: jest.fn(),
    retryOutgoing: jest.fn(),
  }),
}))
jest.mock('../../dialogs/DeleteMessageDialog.vue', () => ({
  template: '<i />',
}))
jest.mock('../../dialogs/TransactionDialog.vue', () => ({ template: '<i />' }))
jest.mock('../../../utils/clients', () => ({ useMonadWallet: () => ({}) }))
jest.mock('../../../composables/useActiveWallet', () => ({
  useActiveWallet: () => ({}),
}))
jest.mock('../../../utils/notifications', () => ({ errorNotify: jest.fn() }))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: { toDisplayAmount: () => '0', unit: 'MON' },
}))
jest.mock('../../../utils/message-items', () => ({
  messageItems: { previewText: () => '' },
}))
jest.mock('../../../utils/message-item-renderers', () => ({
  getMessageItemRenderer: () => undefined,
}))
jest.mock('../../../utils/avatar', () => ({
  profileAvatar: (avatar: string | undefined, identity: string) =>
    avatar ?? `generated:${identity}`,
}))

const translator =
  (table: unknown) =>
  (key: string, params = {}) =>
    String(
      key
        .split('.')
        .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], table),
    ).replace(/\{(\w+)\}/g, (_m, name) =>
      String((params as Record<string, unknown>)[name]),
    )

// Renders the avatar slot before the body, as QChatMessage does, and says whether it got one.
const ChatMessageFrame = defineComponent({
  setup:
    (_props, { slots }) =>
    () =>
      h('div', { 'data-avatar-slot': String(slots.avatar !== undefined) }, [
        slots.avatar?.(),
        slots.default?.(),
      ]),
})
const Avatar = defineComponent({
  setup:
    (_props, { slots, attrs }) =>
    () =>
      h('span', { style: attrs.style }, slots.default?.()),
})

const ALICE = '0x2222222222222222222222222222222222222222'
const alice = {
  address: ALICE,
  label: 'Alice',
  avatar: 'alice.png',
  color: 'rgb(1, 2, 3)',
  inContacts: true,
}

function mountBubble(
  attribution?: Record<string, unknown>,
  { outbound = false, table = enUS as unknown, item = 'text' } = {},
) {
  return shallowMount(ChatMessage, {
    props: {
      address: ALICE,
      name: 'Alice',
      chatWidth: 500,
      payloadDigest: 'digest-1',
      attribution: attribution as never,
      message: {
        outbound,
        status: 'confirmed',
        receivedTime: 1,
        serverTime: 1,
        items:
          item === 'text'
            ? [{ type: 'text', text: 'hi' }]
            : [{ type: item, gameId: 'g' }],
        outpoints: [],
        senderAddress: ALICE,
      } as never,
    },
    global: {
      stubs: { QChatMessage: ChatMessageFrame, QAvatar: Avatar },
      mocks: { $t: translator(table), $q: {} },
    },
  })
}

describe('a chat between two people', () => {
  it.each([false, true])(
    'has no sender, avatar slot or extra class on a bubble (outbound: %s)',
    outbound => {
      const wrapper = mountBubble(undefined, { outbound })
      expect(wrapper.attributes()).toEqual({ style: 'width: 100%;' })
      expect(
        wrapper.get('[data-avatar-slot]').attributes('data-avatar-slot'),
      ).toBe('false')
      expect(wrapper.find('[class*="chat-sender"]').exists()).toBe(false)
      // The body starts with what it always started with.
      const body = wrapper.get('[data-testid="chat-message-body"]')
      expect(body.element.firstElementChild?.tagName.toLowerCase()).toBe(
        'chat-message-menu-stub',
      )
      expect(
        Array.from(body.element.children).map(c => c.tagName.toLowerCase()),
      ).toEqual([
        'chat-message-menu-stub',
        'chat-message-text-stub',
        'chat-message-suffix-stub',
      ])
    },
  )
})

describe('a conversation with more than two people', () => {
  it('shows the name in the key colour at the top of the first bubble of a run, with no avatar yet', () => {
    const wrapper = mountBubble({
      sender: alice,
      showName: true,
      showAvatar: false,
    })
    const body = wrapper.get('[data-testid="chat-message-body"]')
    const name = body.get('[data-testid="chat-sender-name"]')
    expect(body.element.firstElementChild).toBe(name.element)
    const label = name.get('button')
    expect(label.text()).toBe('Alice')
    expect((label.element as HTMLElement).style.color).toBe('rgb(1, 2, 3)')
    expect(wrapper.find('[data-testid="chat-sender-unknown"]').exists()).toBe(
      false,
    )
    // The avatar's place is kept, so the bubbles of a run line up.
    expect(wrapper.find('[data-testid="chat-sender-avatar"]').exists()).toBe(
      false,
    )
    expect(
      wrapper.find('[data-testid="chat-sender-avatar-spacer"]').exists(),
    ).toBe(true)
    // Not the last of its run: it sits close to the next one.
    expect(wrapper.classes()).toContain('chat-message--in-run')
  })

  it('shows the avatar with the key-colour ring beside the last bubble of a run, without repeating the name', () => {
    const wrapper = mountBubble({
      sender: alice,
      showName: false,
      showAvatar: true,
    })
    expect(wrapper.find('[data-testid="chat-sender-name"]').exists()).toBe(
      false,
    )
    const avatar = wrapper.get('[data-testid="chat-sender-avatar"]')
    expect(avatar.get('img').attributes('src')).toBe('alice.png')
    expect(avatar.get('span').attributes('style')).toContain(
      'box-shadow: 0 0 0 2px rgb(1, 2, 3)',
    )
    expect(avatar.attributes('aria-label')).toBe("Open Alice's profile")
    expect(wrapper.classes()).not.toContain('chat-message--in-run')
  })

  it('marks someone who is not a contact, with a generated avatar and no colour when no key is known', () => {
    const wrapper = mountBubble({
      sender: {
        address: ALICE,
        label: '0x2222...2222',
        inContacts: false,
      },
      showName: true,
      showAvatar: true,
    })
    expect(wrapper.get('[data-testid="chat-sender-name"] button').text()).toBe(
      '0x2222...2222',
    )
    expect(wrapper.get('[data-testid="chat-sender-unknown"]').text()).toBe(
      'Not in your contacts',
    )
    const avatar = wrapper.get('[data-testid="chat-sender-avatar"]')
    expect(avatar.get('img').attributes('src')).toBe(`generated:${ALICE}`)
    expect(avatar.get('span').attributes('style')).toBeUndefined()
    expect(
      mountBubble(
        {
          sender: { address: ALICE, label: 'x', inContacts: false },
          showName: true,
          showAvatar: true,
        },
        { table: frFR },
      )
        .get('[data-testid="chat-sender-unknown"]')
        .text(),
    ).toBe('Pas dans vos contacts')
  })

  it.each([
    [false, 'rgb(117, 117, 117)'],
    [true, 'rgb(153, 153, 153)'],
  ])(
    'shades a pale key colour for the name only; the ring keeps it (dark: %s)',
    (dark, shaded) => {
      const wrapper = shallowMount(ChatMessage, {
        props: {
          address: ALICE,
          name: 'Alice',
          chatWidth: 500,
          payloadDigest: 'digest-1',
          attribution: {
            sender: { ...alice, color: 'hsl(0, 0%, 60%)' },
            showName: true,
            showAvatar: true,
          } as never,
          message: {
            outbound: false,
            status: 'confirmed',
            receivedTime: 1,
            serverTime: 1,
            items: [{ type: 'text', text: 'hi' }],
            outpoints: [],
            senderAddress: ALICE,
          } as never,
        },
        global: {
          stubs: { QChatMessage: ChatMessageFrame, QAvatar: Avatar },
          mocks: { $t: translator(enUS), $q: { dark: { isActive: dark } } },
        },
      })
      expect(
        wrapper
          .get('[data-testid="chat-sender-name"] button')
          .attributes('style'),
      ).toContain(shaded)
      // The ring is the key colour itself (60% lightness), whatever the theme.
      expect(
        wrapper
          .get('[data-testid="chat-sender-avatar"] span')
          .attributes('style'),
      ).toMatch(/hsl\(0, 0%, 60%\)|rgb\(153, 153, 153\)/)
    },
  )

  it('asks to open the sender when the name or the avatar is used', async () => {
    const wrapper = mountBubble({
      sender: alice,
      showName: true,
      showAvatar: true,
    })
    await wrapper
      .get('[data-testid="chat-sender-name"] button')
      .trigger('click')
    await wrapper.get('[data-testid="chat-sender-avatar"]').trigger('click')
    expect(wrapper.emitted('senderClicked')).toEqual([[ALICE], [ALICE]])
  })

  it.each(['blackjack-hand', 'raffle', 'dice', 'poker', 'liars-dice', 'rps'])(
    'frames a %s item the same way, leaving the item itself alone',
    item => {
      const wrapper = mountBubble(
        { sender: alice, showName: true, showAvatar: true },
        { item },
      )
      const body = wrapper.get('[data-testid="chat-message-body"]')
      expect(
        Array.from(body.element.children).map(
          c => c.getAttribute('data-testid') ?? c.tagName.toLowerCase(),
        ),
      ).toEqual([
        'chat-sender-name',
        'chat-message-menu-stub',
        expect.stringMatching(/^chat-message-.*-stub$/),
        'chat-message-suffix-stub',
      ])
      expect(wrapper.find('[data-testid="chat-sender-avatar"]').exists()).toBe(
        true,
      )
    },
  )
})
