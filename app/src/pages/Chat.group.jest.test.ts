/** @jest-environment jsdom */
// Mounted Chat.vue with the real chat and contact stores: what each bubble is told about its
// sender in a chat between two people and in a conversation a third person has posted into,
// and what the composer says about who receives a message sent from there.
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import * as quasar from 'quasar'
import { defineComponent, h } from 'vue'

jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    getIterator: async function* () {
      /* none */
    },
  }),
}))
jest.mock('../utils/clients', () => ({ useMonadWallet: () => ({}) }))
jest.mock('../utils/notifications', () => ({
  errorNotify: jest.fn(),
  insufficientStampNotify: jest.fn(),
  desktopNotify: jest.fn(),
}))
jest.mock('../composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))
const mockOwn = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
jest.mock('../utils/own-address', () => ({
  ...jest.requireActual('../utils/own-address'),
  getOwnCanonicalAddress: async () => mockOwn,
  useReactiveOwnCanonicalAddress: () => jest.requireActual('vue').ref(mockOwn),
}))

import { TextDecoder, TextEncoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })
/* eslint-disable @typescript-eslint/no-var-requires */
const ChatPage = require('./Chat.vue').default
const { useChatStore } = require('../stores/chats')
const { useContactStore } = require('../stores/contacts')
const { pubKeyToColor } = require('../utils/formatting')
const en = require('../i18n/en-us').default
const fr = require('../i18n/fr-fr').default

const ALICE = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'
const BOB = '0x3333333333333333333333333333333333333333'
const STRANGER = '0x5555555555555555555555555555555555555555'
const CONVERSATION = '11111111-1111-4111-8111-111111111111'
const keyOf = (fill: number) => new Uint8Array(33).fill(fill)

const stubs: Record<string, any> = Object.fromEntries(
  Object.keys(quasar)
    .filter(n => /^Q[A-Z]/.test(n))
    .map(n => [
      n,
      defineComponent({
        setup:
          (_, { slots, attrs }) =>
          () =>
            h('div', { class: attrs.class }, slots.default?.()),
      }),
    ]),
)
stubs.QScrollArea = defineComponent({
  methods: {
    getScrollTarget: () => ({ scrollTop: 0, scrollHeight: 900 }),
    setScrollPosition: () => undefined,
  },
  render() {
    return h('div', this.$slots.default?.())
  },
})
const Blank = defineComponent({ setup: () => () => h('div') })
// Shows what Chat.vue tells each bubble: `sender | name? | avatar?`, or `plain`.
const MessageStub = defineComponent({
  inheritAttrs: false,
  props: {
    payloadDigest: { type: String, required: true },
    name: { type: String, required: true },
    attribution: { type: Object, default: undefined },
  },
  emits: ['senderClicked'],
  setup:
    (props, { emit }) =>
    () =>
      h(
        'div',
        {
          'data-testid': 'chat-message',
          'data-name': props.name,
          'onClick': () =>
            props.attribution &&
            emit('senderClicked', props.attribution.sender.address),
        },
        props.attribution
          ? [
              props.attribution.sender.label,
              props.attribution.sender.inContacts ? '' : '(stranger)',
              props.attribution.showName ? 'name' : '',
              props.attribution.showAvatar ? 'avatar' : '',
            ]
              .filter(Boolean)
              .join(' | ')
          : 'plain',
      ),
})

const translator =
  (table: unknown) =>
  (key: string, params = {}) => {
    const text = key
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], table)
    return typeof text === 'string'
      ? text.replace(/\{(\w+)\}/g, (_m, name) =>
          String((params as Record<string, unknown>)[name]),
        )
      : key
  }

let time = 0
function received(sender: string, text: string, fill: number) {
  time += 1
  return {
    conversationId: CONVERSATION,
    outbound: false,
    senderAddress: sender,
    copartyAddress: sender,
    copartyPubKey: { toBuffer: () => keyOf(fill) },
    index: `digest-${time}`,
    stampValue: 0,
    message: {
      conversationId: CONVERSATION,
      outbound: false,
      status: 'confirmed',
      senderAddress: sender,
      destinationAddress: mockOwn,
      items: [{ type: 'text', text }],
      serverTime: time,
      receivedTime: time,
      outpoints: [],
    },
  }
}

async function openConversation(table: unknown = en) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const chats = useChatStore()
  const contacts = useContactStore()
  jest.spyOn(contacts, 'refresh').mockResolvedValue(undefined)
  for (const [address, name, fill] of [
    [ALICE, 'Alice', 1],
    [BOB, 'Bob', 2],
  ] as const) {
    contacts.addContact({
      address,
      contact: {
        lastUpdateTime: Date.now(),
        profile: {
          name,
          avatar: '',
          bio: '',
          pubKey: { toBuffer: () => keyOf(fill) },
        },
      },
    })
  }
  chats.createConversation({
    participants: [mockOwn, ALICE],
    address: ALICE,
    conversationId: CONVERSATION,
  })
  const push = jest.fn()
  const wrapper = mount(ChatPage as never, {
    global: {
      plugins: [pinia],
      components: stubs,
      stubs: {
        ChatInput: Blank,
        ChatMessageComponent: MessageStub,
        ChatMessageReply: Blank,
        ChatBannerStack: Blank,
        QResizeObserver: Blank,
      },
      mocks: {
        $route: { params: { address: CONVERSATION } },
        $router: { push },
        $q: { dark: { isActive: false } },
        $t: translator(table),
      },
    },
  })
  await flushPromises()
  const bubbles = () =>
    wrapper.findAll('[data-testid="chat-message"]').map(b => b.text())
  const receive = async (...wrappers: ReturnType<typeof received>[]) => {
    await chats.receiveMessages(wrappers as never)
    await flushPromises()
  }
  return { wrapper, chats, contacts, bubbles, receive, push }
}

beforeEach(() => {
  time = 0
})

describe('a chat between two people', () => {
  it('gives no bubble a sender and shows no note above the composer', async () => {
    const chat = await openConversation()
    await chat.receive(received(ALICE, 'hello', 1), received(ALICE, 'there', 1))
    chat.chats.sendMessageLocal({
      address: ALICE,
      conversationId: CONVERSATION,
      senderAddress: mockOwn,
      index: 'mine',
      items: [{ type: 'text', text: 'hi' }],
      outpoints: [],
      status: 'confirmed',
      previousHash: null,
      timestamp: 10,
    })
    await flushPromises()
    expect(chat.bubbles()).toEqual(['plain', 'plain', 'plain'])
    expect(
      chat.wrapper.find('[data-testid="chat-group-recipient"]').exists(),
    ).toBe(false)
  })
})

describe('a conversation a third person has posted into', () => {
  it('tells every bubble that is not ours who sent it, grouped in runs', async () => {
    const chat = await openConversation()
    await chat.receive(
      received(ALICE, 'one', 1),
      received(ALICE, 'two', 1),
      received(BOB, 'three', 2),
    )
    chat.chats.sendMessageLocal({
      address: ALICE,
      conversationId: CONVERSATION,
      senderAddress: mockOwn,
      index: 'mine',
      items: [{ type: 'text', text: 'four' }],
      outpoints: [],
      status: 'confirmed',
      previousHash: null,
      timestamp: 10,
    })
    time = 20
    await chat.receive(received(BOB, 'five', 2), received(ALICE, 'six', 1))
    expect(chat.bubbles()).toEqual([
      'Alice | name',
      'Alice | avatar',
      'Bob | name | avatar',
      'plain',
      'Bob | name | avatar',
      'Alice | name | avatar',
    ])
    // The name handed to item components is the message's own sender, not the chat's peer.
    expect(
      chat.wrapper
        .findAll('[data-testid="chat-message"]')
        .map(b => b.attributes('data-name')),
    ).toEqual(['Alice', 'Alice', 'Bob', 'unknown', 'Bob', 'Alice'])
  })

  it('colours each sender by their key, as everywhere else', async () => {
    const chat = await openConversation()
    await chat.receive(received(ALICE, 'one', 1), received(BOB, 'two', 2))
    const colours = (
      chat.wrapper.vm as unknown as {
        attributions: Array<{ sender: { color?: string } } | undefined>
      }
    ).attributions.map(a => a?.sender.color)
    expect(colours).toEqual([pubKeyToColor(keyOf(1)), pubKeyToColor(keyOf(2))])
  })

  it('shows a newcomer who is not a contact by address, marked, with the colour of the key they wrote with', async () => {
    const chat = await openConversation()
    await chat.receive(received(ALICE, 'one', 1), received(STRANGER, 'two', 9))
    expect(chat.bubbles()).toEqual([
      'Alice | name | avatar',
      '0x5555...5555 | (stranger) | name | avatar',
    ])
    expect(chat.contacts.isContact(STRANGER)).toBe(false)
    expect(
      (
        chat.wrapper.vm as unknown as {
          attributions: Array<{ sender: { color?: string } } | undefined>
        }
      ).attributions[1]?.sender.color,
    ).toBe(pubKeyToColor(keyOf(9)))
  })

  it('tells two participants with one display name apart', async () => {
    const chat = await openConversation()
    chat.contacts.getContact(BOB).profile.name = 'Alice'
    await chat.receive(received(ALICE, 'one', 1), received(BOB, 'two', 2))
    expect(chat.bubbles()).toEqual([
      'Alice (0x2b2B...2B2B) | name | avatar',
      'Alice (0x3333...3333) | name | avatar',
    ])
  })

  it.each([
    [
      en,
      'Your messages here go to Alice only, not to everyone in this conversation.',
    ],
    [
      fr,
      'Vos messages ici sont envoyés uniquement à Alice, et non à tous les participants de cette conversation.',
    ],
  ])(
    'says above the composer that a message goes to the one peer only',
    async (table, text) => {
      const chat = await openConversation(table)
      await chat.receive(received(ALICE, 'one', 1), received(BOB, 'two', 2))
      expect(
        chat.wrapper.get('[data-testid="chat-group-recipient"]').text(),
      ).toBe(text)
      expect(
        (chat.wrapper.vm as unknown as { recipientAddress: string })
          .recipientAddress,
      ).toBe(ALICE)
    },
  )

  it('opens the profile of the sender whose name or avatar was used', async () => {
    const chat = await openConversation()
    await chat.receive(received(ALICE, 'one', 1), received(BOB, 'two', 2))
    await chat.wrapper
      .findAll('[data-testid="chat-message"]')[1]
      .trigger('click')
    expect(chat.push).toHaveBeenCalledWith(`/chat/${BOB}?info=true`)
  })
})
