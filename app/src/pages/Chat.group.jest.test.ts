/** @jest-environment jsdom */
// Mounted Chat.vue with the real chat and contact stores: what each bubble is told about its
// sender in closed direct conversations, and the actions offered for third-party references.
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia, getActivePinia } from 'pinia'
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
jest.mock('vue-router', () => ({ useRouter: () => ({ push: jest.fn() }) }))
jest.mock('../utils/clients', () => {
  const wallet = {}
  return { useMonadWallet: () => wallet }
})
jest.mock('../composables/useBalance', () => ({
  useBalance: () => ({ refresh: jest.fn() }),
}))
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
const { useChatStore, setConversationIdSalt } = require('../stores/chats')
const { conversationIdSalt } = require('@frank/cashweb/relay/conversation-id')
const { useContactStore } = require('../stores/contacts')
const en = require('../i18n/en-us').default
const {
  encodeGroupItems,
  decodeGroupItems,
} = require('../utils/group-message-items')
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
stubs.QBanner = defineComponent({
  setup:
    (_, { attrs, slots }) =>
    () =>
      h('div', attrs, [slots.default?.(), slots.action?.()]),
})
stubs.QBtn = defineComponent({
  props: ['label'],
  setup:
    (props, { attrs, slots }) =>
    () =>
      h('button', attrs, [props.label, slots.default?.()]),
})
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

async function openConversation(
  table: unknown = en,
  peer: string | null = ALICE,
) {
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
  if (peer)
    chats.createConversation({
      participants: [mockOwn, peer],
      address: peer,
      conversationId: CONVERSATION,
    })
  // With no peer given, the conversation is opened by a stranger's first message.
  else await chats.receiveMessages([received(STRANGER, 'first', 9)] as never)
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
        $route: {
          params: { address: CONVERSATION },
          fullPath: `/chat/${CONVERSATION}`,
        },
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
  setConversationIdSalt(conversationIdSalt(new Uint8Array(32).fill(0x7e)))
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

describe('a closed direct conversation referenced by a third party', () => {
  it('keeps direct bubbles and the reply peer unchanged while offering all three reference actions', async () => {
    const chat = await openConversation()
    await chat.receive(
      received(ALICE, 'one', 1),
      received(BOB, 'outside claim', 2),
    )
    expect(chat.bubbles()).toEqual(['plain'])
    expect(chat.chats.conversations[CONVERSATION].participants).toEqual(
      [mockOwn, ALICE].sort(),
    )
    expect(
      (chat.wrapper.vm as unknown as { recipientAddress: string })
        .recipientAddress,
    ).toBe(ALICE)
    expect(
      chat.wrapper.get('[data-testid="participant-request-banner"]').text(),
    ).toContain('0x3333')
    for (const action of ['view', 'group', 'dismiss'])
      expect(
        chat.wrapper
          .find(`[data-testid="participant-request-${action}"]`)
          .exists(),
      ).toBe(true)
    expect(
      chat.wrapper.find('[data-testid="chat-group-recipient"]').exists(),
    ).toBe(false)
    const request =
      chat.chats.conversations[CONVERSATION].pendingParticipantRequests[BOB]
    expect(
      chat.chats.conversations[request.senderConversationId].messages[0]
        .senderAddress,
    ).toBe(BOB)
    await chat.wrapper
      .get('[data-testid="participant-request-view"]')
      .trigger('click')
    expect(chat.push).toHaveBeenCalledWith(
      `/chat/${request.senderConversationId}`,
    )
  })

  it.each([
    [
      en,
      'Their message is in a separate 1:1 conversation.',
      'View 1:1',
      'Dismiss',
    ],
    [
      fr,
      'Son message reste dans une conversation individuelle distincte.',
      'Voir la conversation',
      'Ignorer',
    ],
  ])(
    'localizes the reference and its actions',
    async (table, explanation, view, dismiss) => {
      const chat = await openConversation(table)
      await chat.receive(received(BOB, 'outside claim', 2))
      expect(
        chat.wrapper.get('[data-testid="participant-request-banner"]').text(),
      ).toContain(explanation)
      expect(
        chat.wrapper.get('[data-testid="participant-request-view"]').text(),
      ).toBe(view)
      expect(
        chat.wrapper.get('[data-testid="participant-request-dismiss"]').text(),
      ).toBe(dismiss)
    },
  )

  it('preselects the peer and requester for a separate group without altering the direct participants', async () => {
    const chat = await openConversation()
    await chat.receive(received(BOB, 'outside claim', 2))
    const before = [...chat.chats.conversations[CONVERSATION].participants]
    await chat.wrapper
      .get('[data-testid="participant-request-group"]')
      .trigger('click')
    expect(chat.push).toHaveBeenCalledWith({
      path: '/new-group',
      query: { member: [ALICE, BOB], from: `/chat/${CONVERSATION}` },
    })
    expect(chat.chats.conversations[CONVERSATION].participants).toEqual(before)
    expect(chat.chats.conversations[CONVERSATION].kind).toBe('direct')
  })

  it('dismisses the reference while retaining the original sender message', async () => {
    const chat = await openConversation()
    await chat.receive(received(STRANGER, 'outside claim', 9))
    const request =
      chat.chats.conversations[CONVERSATION].pendingParticipantRequests[
        STRANGER
      ]
    await chat.wrapper
      .get('[data-testid="participant-request-dismiss"]')
      .trigger('click')
    expect(
      chat.wrapper.find('[data-testid="participant-request-banner"]').exists(),
    ).toBe(false)
    expect(
      chat.chats.conversations[CONVERSATION].dismissedParticipantRequests[
        STRANGER
      ],
    ).toBe(request.receivedAt)
    expect(
      chat.chats.conversations[request.senderConversationId].messages,
    ).toHaveLength(1)
    expect(chat.contacts.isContact(STRANGER)).toBe(false)
  })
})

describe('notes to self that someone else posts into', () => {
  it('shows nothing extra while only this user has written', async () => {
    const chat = await openConversation(en, mockOwn)
    const note = received(mockOwn, 'remember milk', 3)
    note.message.destinationAddress = mockOwn
    await chat.receive(note)
    expect(chat.bubbles()).toEqual(['plain'])
    expect(
      chat.wrapper.find('[data-testid="chat-group-recipient"]').exists(),
    ).toBe(false)
  })

  it('keeps a stranger outside notes and offers a reference instead', async () => {
    const chat = await openConversation(en, mockOwn)
    await chat.receive(received(STRANGER, 'I am in your notes', 9))
    expect(chat.bubbles()).toEqual([])
    expect(
      chat.wrapper.find('[data-testid="participant-request-banner"]').exists(),
    ).toBe(true)
    expect(
      (chat.wrapper.vm as unknown as { recipientAddress: string })
        .recipientAddress,
    ).toBe(mockOwn)
  })
})

describe('an email item sent by a third person', () => {
  it('keeps email payloads outside the claimed direct thread', async () => {
    const chat = await openConversation()
    const hello = received(ALICE, 'hello', 1)
    const email = received(STRANGER, '', 9)
    email.message.items = [
      {
        type: 'email',
        subject: 'From your bank',
        from: { name: 'Alice', address: 'alice@example.com' },
        to: [],
        body: 'x',
      } as never,
    ]
    await chat.receive(hello, email)
    expect(
      (chat.wrapper.vm as unknown as { isEmailThread: boolean }).isEmailThread,
    ).toBe(false)
    expect(chat.bubbles()).toEqual(['plain'])
    const request =
      chat.chats.conversations[CONVERSATION].pendingParticipantRequests[
        STRANGER
      ]
    expect(
      chat.chats.conversations[request.senderConversationId].messages[0].items,
    ).toEqual(email.message.items)
    expect(chat.chats.conversations[CONVERSATION].kind).toBe('direct')
    expect(chat.chats.conversations[CONVERSATION].name).toBeUndefined()
  })
})

describe('a direct conversation opened by a stranger', () => {
  it('keeps its original stranger peer when a contact references the same ID', async () => {
    const chat = await openConversation(en, null)
    await chat.receive(received(ALICE, 'second', 1))
    expect(chat.chats.conversations[CONVERSATION].address).toBe(STRANGER)
    expect(
      (chat.wrapper.vm as unknown as { recipientAddress: string })
        .recipientAddress,
    ).toBe(STRANGER)
    expect(chat.bubbles()).toEqual(['plain'])
    expect(
      chat.chats.conversations[CONVERSATION].pendingParticipantRequests[ALICE],
    ).toBeDefined()
  })
})

describe('a shared group invitation', () => {
  it('shows Accept and Decline, hides the composer until accepted, and uses group content mode', async () => {
    const { wrapper, chats } = await openConversation()
    const conversation = chats.conversations[CONVERSATION]
    conversation.kind = 'group'
    conversation.address = 'group:' + '11'.repeat(32)
    conversation.membershipStatus = 'invited'
    conversation.name = 'Protocol Team'
    const sync = jest.spyOn(chats, 'syncGroupConversation').mockResolvedValue(0)
    await flushPromises()
    expect(wrapper.get('[data-testid="group-invite-banner"]').text()).toContain(
      'Protocol Team',
    )
    expect(wrapper.findComponent({ name: 'ChatInput' }).exists()).toBe(false)
    await wrapper.get('[data-testid="accept-group-invite"]').trigger('click')
    await flushPromises()
    expect(conversation.membershipStatus).toBe('joined')
    expect(sync).toHaveBeenCalledWith(CONVERSATION)
    expect(wrapper.find('[data-testid="group-invite-banner"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('[data-testid="chat-group-recipient"]').exists()).toBe(
      false,
    )
    conversation.membershipStatus = 'invited'
    await flushPromises()
    await wrapper.get('[data-testid="decline-group-invite"]').trigger('click')
    expect(conversation.membershipStatus).toBe('declined')
    expect(chats.shouldPollGroupMailbox(CONVERSATION)).toBe(false)
  })
})

describe('a membership change another device superseded', () => {
  for (const [locale, table, text] of [
    ['en-us', en, "Removing 0x3333...3333 didn't apply"],
    ['fr-fr', fr, "Le retrait de 0x3333...3333 n'a pas été appliqué"],
  ] as const)
    it(`says so in ${locale} and retries or dismisses it only when asked`, async () => {
      const { wrapper, chats } = await openConversation(table)
      const conversation = chats.conversations[CONVERSATION]
      conversation.kind = 'group'
      conversation.address = 'group:' + '11'.repeat(32)
      conversation.membershipStatus = 'joined'
      conversation.groupState = {
        roster: [],
        supersededMemberChange: { action: 'remove-member', address: BOB },
      }
      const retry = jest
        .spyOn(chats, 'retrySupersededMemberChange')
        .mockResolvedValue(conversation)
      await flushPromises()
      const banner = wrapper.get(
        '[data-testid="group-member-change-superseded"]',
      )
      expect(banner.text()).toContain(text)
      expect(retry).not.toHaveBeenCalled()
      await wrapper
        .get('[data-testid="retry-group-member-change"]')
        .trigger('click')
      expect(retry).toHaveBeenCalledWith(CONVERSATION)
      // A failed dismissal is reported like a failed retry, never left unhandled.
      const { errorNotify } = require('../utils/notifications')
      errorNotify.mockClear()
      jest
        .spyOn(chats, 'dismissSupersededMemberChange')
        .mockRejectedValueOnce(new Error('persistence failed'))
      await wrapper
        .get('[data-testid="dismiss-group-member-change"]')
        .trigger('click')
      await flushPromises()
      expect(errorNotify).toHaveBeenCalledWith(new Error('persistence failed'))
      await wrapper
        .get('[data-testid="dismiss-group-member-change"]')
        .trigger('click')
      await flushPromises()
      expect(conversation.groupState.supersededMemberChange).toBeUndefined()
      expect(
        wrapper.find('[data-testid="group-member-change-superseded"]').exists(),
      ).toBe(false)
    })
})

describe('the group composer', () => {
  it('sends calendar/vCard follow-ups and articles as stamp-free group messages', async () => {
    const { wrapper, chats } = await openConversation()
    const conversation = chats.conversations[CONVERSATION]
    conversation.kind = 'group'
    conversation.address = 'group:' + '11'.repeat(32)
    conversation.membershipStatus = 'joined'
    conversation.name = 'Protocol Team'
    await flushPromises()
    const { errorNotify } = require('../utils/notifications')
    errorNotify.mockClear()
    const sent: unknown[][] = []
    jest
      .spyOn(chats, 'sendGroupMessage')
      .mockImplementation(async ({ items }: { items: unknown[] }) => {
        // What the group send seals: every item must have a group codec.
        decodeGroupItems(encodeGroupItems(items as never))
        sent.push(items)
        return { state: 'sent', payloadDigest: 'group-digest' }
      })
    const vm = wrapper.vm as any
    // A direct-message stamp chosen earlier must not turn a group send into a payment.
    vm.stampAmount = '0.5'
    const card = {
      type: 'contact-card',
      uid: 'bob-example',
      fullName: 'Bob Example',
      emails: ['bob@example.com'],
    }
    const first = await vm.sendFollowUpItems({ items: [card] })
    expect(errorNotify.mock.calls).toEqual([])
    expect(first).toBe(true)
    vm.articleDialog = true
    await vm.sendArticle({
      schemaVersion: 1,
      articleId: 'group-article-1',
      title: 'Notes',
      markdownBody: 'Hello group',
      publishedAtIso: '2026-10-20T00:00:00.000Z',
    })
    await flushPromises()
    expect(errorNotify).not.toHaveBeenCalled()
    expect(sent).toHaveLength(2)
    expect((sent[0][0] as { type: string }).type).toBe('contact-card')
    expect((sent[1][0] as { type: string }).type).toBe('application')
    // A follow-up that is itself a payment is refused, never sent free.
    await expect(
      vm.sendFollowUpItems({ items: [card], stampValueWei: 5n }),
    ).resolves.toBe(false)
    expect(errorNotify).toHaveBeenCalledWith(
      new Error('Group payments are unsupported'),
    )
    expect(sent).toHaveLength(2)
  })
})

describe('thread navigation through the authoritative conversation order', () => {
  const NEWER = '22222222-2222-4222-8222-222222222222'
  const OLDER = '33333333-3333-4333-8333-333333333333'
  const DISMISSED = '44444444-4444-4444-8444-444444444444'
  const DELETED = '55555555-5555-4555-8555-555555555555'
  let chat: Awaited<ReturnType<typeof openConversation>>

  async function openOrderedThreads() {
    chat = await openConversation()
    chat.chats.conversations[CONVERSATION].lastReceived = 200
    for (const [id, lastReceived] of [
      [OLDER, 100],
      [NEWER, 300],
      [DISMISSED, 250],
      [DELETED, 225],
    ] as const) {
      const thread = chat.chats.createConversation({
        participants: [mockOwn, ALICE],
        address: ALICE,
        conversationId: id,
      })
      thread.lastReceived = lastReceived
    }
    chat.chats.conversations[DISMISSED].screenerStatus = 'dismissed'
    chat.chats.conversations[DELETED].deletedAt = 1
    await flushPromises()
    chat.push.mockClear()
    return chat
  }

  afterEach(() => chat?.wrapper.unmount())

  it('routes numeric navigation to distinct same-peer IDs without changing records', async () => {
    const { wrapper, chats, push } = await openOrderedThreads()
    const before = JSON.stringify(chats.conversations)
    expect(chats.getSortedChatOrder.map(thread => thread.id)).toEqual([
      NEWER,
      DISMISSED,
      CONVERSATION,
      OLDER,
    ])
    wrapper.vm.navigateThread(1)
    wrapper.vm.navigateThread(-1)
    expect(push.mock.calls).toEqual([[`/chat/${OLDER}`], [`/chat/${NEWER}`]])
    expect(JSON.stringify(chats.conversations)).toBe(before)
  })

  it('maps actual email child next/prev emissions onto numeric navigation', async () => {
    const { wrapper, chats, push } = await openOrderedThreads()
    chats.conversations[CONVERSATION].kind = 'email'
    await flushPromises()
    const email = wrapper.getComponent({ ref: 'emailThreadView' })
    email.vm.$emit('navigateThread', 'next')
    email.vm.$emit('navigateThread', 'prev')
    expect(push.mock.calls).toEqual([[`/chat/${OLDER}`], [`/chat/${NEWER}`]])
    email.vm.$emit('archiveThread')
    expect(push).toHaveBeenLastCalledWith(`/chat/${OLDER}`)
  })

  it('preserves numeric keyboard and archive callers', async () => {
    const { wrapper, push } = await openOrderedThreads()
    wrapper.vm.handleTriageKeydown(new KeyboardEvent('keydown', { key: 'j' }))
    wrapper.vm.handleTriageKeydown(new KeyboardEvent('keydown', { key: 'k' }))
    wrapper.vm.archiveCurrentThread()
    expect(push.mock.calls).toEqual([
      [`/chat/${OLDER}`],
      [`/chat/${NEWER}`],
      [`/chat/${OLDER}`],
    ])
  })

  it('does not wrap and retains first-item fallback and empty behavior', async () => {
    const { wrapper, chats, push } = await openOrderedThreads()
    chats.conversations[NEWER].lastReceived = 150
    await flushPromises()
    wrapper.vm.navigateThread(-1)
    expect(push).not.toHaveBeenCalled()
    chats.conversations[CONVERSATION].lastReceived = 50
    await flushPromises()
    wrapper.vm.navigateThread(1)
    expect(push).not.toHaveBeenCalled()
    chats.conversations[CONVERSATION].deletedAt = 1
    await flushPromises()
    wrapper.vm.navigateThread(-1)
    expect(push).toHaveBeenLastCalledWith(`/chat/${NEWER}`)
    push.mockClear()
    chats.conversations[NEWER].deletedAt = 1
    chats.conversations[OLDER].deletedAt = 1
    await flushPromises()
    wrapper.vm.navigateThread(1)
    expect(push).not.toHaveBeenCalled()
  })
})

describe('group decision persistence in mounted UI', () => {
  it.each(['accept', 'decline'])('reports a failed %s write', async action => {
    const { wrapper, chats } = await openConversation()
    const conv = chats.conversations[CONVERSATION]
    conv.kind = 'group'
    conv.membershipStatus = 'invited'
    let reject!: (error: Error) => void
    chats.flushPersistence = jest.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail
        }),
    )
    const sync = jest.spyOn(chats, 'syncGroupConversation').mockResolvedValue(0)
    const { errorNotify } = require('../utils/notifications')
    errorNotify.mockClear()
    await flushPromises()
    await wrapper.get(`[data-testid="${action}-group-invite"]`).trigger('click')
    expect(errorNotify).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
    const error = new Error('decision write failed')
    reject(error)
    await flushPromises()
    expect(errorNotify).toHaveBeenCalledWith(error)
    expect(conv.membershipStatus).toBe(
      action === 'accept' ? 'joined' : 'declined',
    )
    wrapper.unmount()
  })

  it.each([true, false])(
    'only completes leave after a successful barrier (%s)',
    async succeeds => {
      const { wrapper: chat, chats } = await openConversation()
      const conv = chats.conversations[CONVERSATION]
      conv.kind = 'group'
      conv.membershipStatus = 'joined'
      let resolve!: () => void
      let reject!: (error: Error) => void
      chats.flushPersistence = jest.fn(
        () =>
          new Promise<void>((done, fail) => {
            resolve = done
            reject = fail
          }),
      )
      const { errorNotify } = require('../utils/notifications')
      errorNotify.mockClear()
      const GroupInfoDialog =
        require('../components/chat/GroupInfoDialog.vue').default
      const wrapper = mount(GroupInfoDialog, {
        props: { modelValue: true, conversationId: CONVERSATION },
        global: {
          plugins: [getActivePinia()!],
          components: stubs,
          mocks: { $t: translator(en) },
        },
      })
      await wrapper.get('[data-test="leave-group-btn"]').trigger('click')
      expect(conv.membershipStatus).toBe('left')
      expect(chats.shouldPollGroupMailbox(CONVERSATION)).toBe(false)
      expect(wrapper.emitted('left')).toBeUndefined()
      expect(wrapper.emitted('update:modelValue')).toBeUndefined()
      const error = new Error('leave write failed')
      if (succeeds) resolve()
      else reject(error)
      await flushPromises()
      expect(conv.membershipStatus).toBe('left')
      if (succeeds) {
        expect(wrapper.emitted('left')).toEqual([[CONVERSATION]])
        expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
        expect(errorNotify).not.toHaveBeenCalled()
      } else {
        expect(errorNotify).toHaveBeenCalledWith(error)
        expect(wrapper.emitted('left')).toBeUndefined()
        expect(wrapper.emitted('update:modelValue')).toBeUndefined()
      }
      wrapper.unmount()
      chat.unmount()
    },
  )
})
