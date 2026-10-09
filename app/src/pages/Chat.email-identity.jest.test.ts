/** @jest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { TextDecoder, TextEncoder } from 'util'

Object.assign(globalThis, { TextEncoder, TextDecoder })
const mockErrorNotify = jest.fn()
jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({ saveMessage: jest.fn(), deleteMessage: jest.fn() }),
}))
jest.mock('../accounts/session', () => ({
  accountStatus: { status: 'ready' },
  accountSession: { initialize: jest.fn(async () => undefined) },
}))
jest.mock('../router/routes', () => ({
  createRoutes: () => [
    { path: '/forum', component: { template: '<div />' } },
    {
      path: '/chat/:address',
      component: jest.requireActual('./Chat.vue').default,
    },
  ],
}))
jest.mock('nostics', () => ({
  createConsoleReporter: jest.fn(),
  defineDiagnostics: () => new Proxy({}, { get: () => jest.fn() }),
}))
jest.mock(
  require.resolve('@vue/devtools-api', {
    paths: [require.resolve('vue-router')],
  }),
  () => ({ setupDevtoolsPlugin: jest.fn() }),
)
jest.mock('vue-router', () => {
  const actual = jest.requireActual('vue-router')
  return {
    ...actual,
    createWebHashHistory: actual.createMemoryHistory,
    createWebHistory: actual.createMemoryHistory,
  }
})
jest.mock('quasar', () => ({
  ...jest.requireActual('quasar'),
  useQuasar: () => ({ screen: { width: 1024 }, dark: { isActive: false } }),
}))
jest.mock('../utils/directory-peer', () => ({
  fetchContactProfile: jest.fn(async () => undefined),
  contactLookupFailure: () => 'not-found',
}))
jest.mock('../utils/notifications', () => ({
  desktopNotify: jest.fn(),
  errorNotify: (error: Error) => mockErrorNotify(error),
}))
jest.mock('../utils/own-address', () => ({
  ...jest.requireActual('../utils/own-address'),
  getOwnCanonicalAddress: async () =>
    '0x1a1A1A1A1a1A1a1a1a1a1a1a1a1a1a1A1A1a1a1a',
  useReactiveOwnCanonicalAddress: () =>
    jest.requireActual('vue').ref('0x1a1A1A1A1a1A1a1a1a1a1a1a1a1a1a1A1A1a1a1a'),
}))

jest.mock('../utils/clients', () => ({
  useMonadWallet: () => ({
    identity: { displayAddress: '0x1111111111111111111111111111111111111111' },
  }),
}))
jest.mock('../composables/useBalance', () => ({
  useBalance: () => ({ refresh: jest.fn() }),
}))

/* eslint-disable @typescript-eslint/no-var-requires */
const { useChatStore } = require('../stores/chats')
const { setStartupRestoration } = require('../boot/startup-state')
const createAppRouter = require('../router').default
const Chat = require('./Chat.vue').default
const EmailThreadView =
  require('../components/chat/email/EmailThreadView.vue').default
const quasar = require('quasar')
/* eslint-enable @typescript-eslint/no-var-requires */
const PEER = '0x3333333333333333333333333333333333333333'
const simple = { template: '<div><slot /></div>' }
const controls = Object.fromEntries(
  Object.keys(quasar)
    .filter(name => /^Q[A-Z]/.test(name))
    .map(name => [name, simple]),
)
controls.QBtn = defineComponent({
  props: { icon: String, label: String, disable: Boolean },
  setup:
    (props, { slots }) =>
    () =>
      h('button', { 'data-icon': props.icon, 'disabled': props.disable }, [
        props.label,
        slots.default?.(),
      ]),
})
controls.QInput = defineComponent({
  props: { modelValue: String, type: String, disable: Boolean },
  emits: ['update:modelValue'],
  setup:
    (props, { emit }) =>
    () =>
      h(props.type === 'textarea' ? 'textarea' : 'input', {
        value: props.modelValue,
        disabled: props.disable,
        onInput: (event: Event) =>
          emit('update:modelValue', (event.target as HTMLInputElement).value),
      }),
})
controls.QChip = defineComponent({
  props: { removable: Boolean },
  emits: ['remove'],
  setup:
    (props, { slots, emit }) =>
    () =>
      h('span', { 'data-chip': '' }, [
        slots.default?.(),
        props.removable
          ? h(
              'button',
              { 'data-remove-recipient': '', 'onClick': () => emit('remove') },
              'Remove',
            )
          : null,
      ]),
})
async function selectFile(root: ReturnType<typeof mount>, file: File) {
  const input = root.get('input[type="file"]')
  Object.defineProperty(input.element, 'files', {
    value: [file],
    configurable: true,
  })
  await input.trigger('change')
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
async function settle() {
  await nextTick()
  await flushPromises()
}
async function mountedEmails() {
  const pinia = createPinia()
  setActivePinia(pinia)
  setStartupRestoration({ phase: 'restored' })
  const chats = useChatStore()
  const roots = [
    'alice@example.com',
    'bob@example.com',
    'fresh@example.com',
  ].map(emailRecipient =>
    chats.createConversation({
      kind: 'email',
      address: PEER,
      participants: [PEER],
      name: emailRecipient,
      emailRecipient,
      verifiedGateway: true,
    }),
  )
  for (const [i, root] of roots.slice(0, 2).entries()) {
    root.messages = [
      {
        conversationId: root.id,
        payloadDigest: `digest-${i}`,
        outbound: false,
        status: 'confirmed',
        receivedTime: i + 1,
        senderAddress: PEER,
        outpoints: [],
        items: [
          {
            type: 'email',
            messageId: `<parent-${i}@example.com>`,
            from: { address: root.emailRecipient },
            to: [{ address: 'me@example.com' }],
            subject: `Thread ${i}`,
            textBody: 'Received body',
          },
        ],
      },
    ]
  }
  const send = jest
    .spyOn(chats, 'sendMessage')
    .mockResolvedValue({ status: 'confirmed' } as never)
  const router = createAppRouter()
  await router.push(`/chat/${roots[0].id}`)
  await router.isReady()
  const root = mount(defineComponent({ template: '<router-view />' }), {
    global: {
      plugins: [pinia, router],
      components: controls,
      stubs: {
        ChatMessageComponent: simple,
        ChatInput: simple,
        ChatMessageReply: simple,
        ChatBannerStack: simple,
      },
      mocks: {
        $q: { dark: { isActive: false } },
        $t: (key: string) => key,
        $status: { setup: true },
      },
    },
  })
  await settle()
  const select = async (id: string) => {
    await router.push(`/chat/${id}`)
    await settle()
  }
  return {
    root,
    chats,
    roots,
    send,
    select,
    page: () => root.getComponent(Chat).vm,
    composer: () => root.getComponent(EmailThreadView).vm,
  }
}
beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
})
afterEach(() => jest.restoreAllMocks())

it('isolates the actual routed composer for populated siblings and a fresh root', async () => {
  const app = await mountedEmails()
  try {
    const first = app.composer()
    first.replyText = 'Private draft'
    first.stagedFiles = [new File(['a'], 'a.txt')]
    await app.select(app.roots[1].id)
    expect(app.composer().activeInReplyTo).toBe('<parent-1@example.com>')
    expect(app.composer().toList).toEqual(['bob@example.com'])
    expect(app.composer().replyText).toBe('')
    expect(app.composer().stagedFiles).toEqual([])
    await app.select(app.roots[2].id)
    expect(app.composer().activeInReplyTo).toBeUndefined()
    expect(app.composer().activeReferences).toBeUndefined()
    expect(app.composer().toList).toEqual(['fresh@example.com'])
    expect(app.composer().subject).toBe('')
  } finally {
    app.root.unmount()
  }
})

it('cancels unsubmitted attachment preparation when its routed owner is left', async () => {
  const app = await mountedEmails()
  try {
    const composer = app.composer()
    const file = deferred<string>()
    jest.spyOn(composer, 'readFileAsBase64').mockReturnValue(file.promise)
    composer.replyText = 'Original body'
    composer.stagedFiles = [new File(['a'], 'a.txt')]
    const preparing = composer.handleSend()
    await app.select(app.roots[1].id)
    app.composer().replyText = 'New owner draft'
    file.resolve('data:text/plain;base64,YQ==')
    await preparing
    await settle()
    expect(app.send).not.toHaveBeenCalled()
    expect(app.composer().replyText).toBe('New owner draft')
  } finally {
    app.root.unmount()
  }
})

it.each(['unchanged', 'renamed', 'deleted'])(
  'binds submitted send and completion metadata to its original owner (%s)',
  async disposition => {
    const app = await mountedEmails()
    try {
      const delivery = deferred<never>()
      app.send.mockReturnValueOnce(delivery.promise)
      app.composer().replyText = 'Original response'
      await app.composer().handleSend()
      expect(app.send).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: app.roots[0].id,
          address: PEER,
          items: expect.arrayContaining([
            expect.objectContaining({ inReplyTo: '<parent-0@example.com>' }),
          ]),
        }),
      )
      if (disposition === 'renamed')
        app.chats.renameConversation(app.roots[0].id, 'User subject')
      if (disposition === 'deleted') app.roots[0].deletedAt = 7
      await app.select(app.roots[1].id)
      delivery.resolve({ status: 'confirmed' } as never)
      await settle()
      expect(app.roots[1].name).toBe('bob@example.com')
      expect(app.roots[0].name).toBe(
        disposition === 'renamed'
          ? 'User subject'
          : disposition === 'deleted'
          ? 'alice@example.com'
          : 'Re: Thread 0',
      )
    } finally {
      app.root.unmount()
    }
  },
)

it.each(['missing', 'foreign', 'deleted'])(
  'refuses an unavailable email owner before any send (%s)',
  async kind => {
    const app = await mountedEmails()
    try {
      const id =
        kind === 'missing'
          ? '00000000-0000-4000-8000-000000000000'
          : kind === 'foreign'
          ? app.roots[1].id
          : app.roots[0].id
      if (kind === 'deleted') app.roots[0].deletedAt = 1
      await app
        .page()
        .sendEmailReply({ conversationId: id, items: [], fallbackText: '' })
      expect(app.send).not.toHaveBeenCalled()
      expect(mockErrorNotify).toHaveBeenCalledTimes(1)
      expect(Object.keys(app.chats.conversations)).toHaveLength(3)
    } finally {
      app.root.unmount()
    }
  },
)

it('sends the older clicked RFC parent after newer mail and snapshots attachment preparation', async () => {
  const app = await mountedEmails()
  try {
    const original = app.roots[0].messages[0]
    app.roots[0].messages.push({
      ...original,
      payloadDigest: 'newer',
      receivedTime: 2,
      items: [
        {
          ...original.items[0],
          messageId: '<newer@example.com>',
          from: { address: 'newer@example.com' },
        },
      ],
    })
    await settle()
    await app.root.findAll('button[data-icon="reply"]')[0].trigger('click')
    const composer = app.composer()
    composer.replyText = 'Snapshot body'
    composer.subject = 'Snapshot subject'
    const file = deferred<string>()
    jest.spyOn(composer, 'readFileAsBase64').mockReturnValue(file.promise)
    composer.stagedFiles = [new File(['a'], 'a.txt')]
    const preparing = composer.handleSend()
    composer.activeInReplyTo = '<later-choice@example.com>'
    composer.activeReferences = ['<later-choice@example.com>']
    composer.subject = 'Later subject'
    composer.replyText = 'Later body'
    file.resolve('data:text/plain;base64,YQ==')
    await preparing
    expect(app.send).toHaveBeenCalledTimes(1)
    expect(app.send.mock.calls[0][0]).toMatchObject({
      conversationId: app.roots[0].id,
      items: [
        {
          type: 'email',
          inReplyTo: '<parent-0@example.com>',
          references: ['<parent-0@example.com>'],
          to: [{ address: 'alice@example.com' }],
          subject: 'Snapshot subject',
          textBody: 'Snapshot body',
        },
        { type: 'text' },
      ],
    })
  } finally {
    app.root.unmount()
  }
})

it('preserves the real store recipient-affinity refusal without a replacement root', async () => {
  const app = await mountedEmails()
  try {
    app.send.mockRestore()
    app.page().sendDirectMessage = app.chats.sendMessage
    const before = JSON.stringify(app.chats.$state)
    await app.page().sendEmailReply({
      conversationId: app.roots[0].id,
      targetAddress: '0x4444444444444444444444444444444444444444',
      items: [],
      fallbackText: '',
    })
    expect(mockErrorNotify).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(app.chats.$state)).toBe(before)
  } finally {
    app.root.unmount()
  }
})

it('preserves postclick body and attachment edits made through enabled authoring controls', async () => {
  const app = await mountedEmails()
  try {
    const composer = app.composer()
    const fileRead = deferred<string>()
    jest.spyOn(composer, 'readFileAsBase64').mockReturnValue(fileRead.promise)
    const handleSend = jest.spyOn(composer, 'handleSend')
    const originalFile = new File(['old'], 'submitted.txt')
    const laterFile = new File(['new'], 'later.txt')
    await app.root.get('textarea').setValue('Submitted body')
    await selectFile(app.root, originalFile)
    await app.root.get('button[data-icon="send"]').trigger('click')
    const preparing = handleSend.mock.results[0].value
    expect(
      (app.root.get('textarea').element as HTMLTextAreaElement).disabled,
    ).toBe(false)
    await app.root.get('textarea').setValue('Newer unsent body')
    await selectFile(app.root, laterFile)
    fileRead.resolve('data:text/plain;base64,b2xk')
    await preparing
    await settle()
    expect(app.send).toHaveBeenCalledTimes(1)
    expect(app.send.mock.calls[0][0].items[0]).toMatchObject({
      textBody: 'Submitted body',
      attachments: [{ filename: 'submitted.txt' }],
    })
    expect(
      (app.root.get('textarea').element as HTMLTextAreaElement).value,
    ).toBe('Newer unsent body')
    expect(app.composer().stagedFiles).toEqual([laterFile])
  } finally {
    app.root.unmount()
  }
})

it('retains the explicitly selected parent and Bcc-only attachment draft when new mail arrives', async () => {
  const app = await mountedEmails()
  try {
    const original = app.roots[0].messages[0]
    original.items[0].references = ['<ancestor@example.com>']
    await settle()
    await app.root.findAll('button[data-icon="reply"]')[0].trigger('click')
    await app.root.get('[data-remove-recipient]').trigger('click')
    await app.root.get('textarea').setValue('')
    await app.root
      .findAll('button')
      .find(button => button.text() === 'emailThread.showBcc')!
      .trigger('click')
    const bcc = app.root.get('[data-testid="composer-bcc-row"] input')
    await bcc.setValue('private@example.com')
    await bcc.trigger('keydown.enter')
    await app.root
      .get('input[placeholder="emailThread.subjectPlaceholder"]')
      .setValue('Deliberate subject')
    const attachment = new File(['data'], 'only.txt')
    await selectFile(app.root, attachment)
    expect(app.composer().canSend).toBe(true)
    app.roots[0].messages.push({
      ...original,
      payloadDigest: 'new-arrival',
      receivedTime: 2,
      items: [
        {
          ...original.items[0],
          messageId: '<new-arrival@example.com>',
          from: { address: 'new-sender@example.com' },
          subject: 'New incoming subject',
        },
      ],
    })
    await settle()
    expect(app.composer().activeInReplyTo).toBe('<parent-0@example.com>')
    expect(app.composer().activeReferences).toEqual([
      '<ancestor@example.com>',
      '<parent-0@example.com>',
    ])
    expect(app.composer().toList).toEqual([])
    expect(app.composer().bccList).toEqual(['private@example.com'])
    expect(app.composer().subject).toBe('Deliberate subject')
    expect(app.composer().stagedFiles).toEqual([attachment])
    jest
      .spyOn(app.composer(), 'readFileAsBase64')
      .mockResolvedValue('data:text/plain;base64,ZGF0YQ==')
    await app.composer().handleSend()
    expect(app.send.mock.calls[0][0].items[0]).toMatchObject({
      inReplyTo: '<parent-0@example.com>',
      references: ['<ancestor@example.com>', '<parent-0@example.com>'],
      to: [],
      bcc: [{ address: 'private@example.com' }],
      subject: 'Deliberate subject',
    })
  } finally {
    app.root.unmount()
  }
})

it('keeps an initially empty root draft independent of arriving mail until explicit Reply', async () => {
  const app = await mountedEmails()
  try {
    await app.select(app.roots[2].id)
    expect(app.composer().toList).toEqual(['fresh@example.com'])
    expect(app.composer().activeInReplyTo).toBeUndefined()
    await app.root.get('[data-remove-recipient]').trigger('click')
    await app.root
      .get('input[placeholder="emailThread.subjectPlaceholder"]')
      .setValue('Fresh subject')
    const original = app.roots[0].messages[0]
    app.roots[2].messages.push({
      ...original,
      conversationId: app.roots[2].id,
      payloadDigest: 'first-arrival',
      items: [
        { ...original.items[0], messageId: '<first-arrival@example.com>' },
      ],
    })
    await settle()
    expect(app.composer().activeInReplyTo).toBeUndefined()
    expect(app.composer().activeReferences).toBeUndefined()
    expect(app.composer().toList).toEqual([])
    expect(app.composer().subject).toBe('Fresh subject')
    await app.root.findAll('button[data-icon="reply"]')[0].trigger('click')
    expect(app.composer().activeInReplyTo).toBe('<first-arrival@example.com>')
    expect(app.composer().toList).toEqual(['alice@example.com'])
  } finally {
    app.root.unmount()
  }
})
