/** @jest-environment node */
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-empty-function */
/** Real SFCs, restored session signer, Level owner, canonical envelopes and authenticated journal.
 * DOM controls, chain RPC and relay HTTP are owned local stand-ins. */
const { JSDOM } = require('jsdom')
const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  SVGElement: dom.window.SVGElement,
  Node: dom.window.Node,
  localStorage: dom.window.localStorage,
})
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
})
const lockTails = new Map<string, Promise<unknown>>()
Object.defineProperty(globalThis.navigator, 'locks', {
  value: {
    request(
      name: string,
      options: unknown,
      callback?: (lock: object | null) => unknown,
    ) {
      const work =
        typeof options === 'function'
          ? (options as (lock: object) => unknown)
          : callback!
      if (
        typeof options === 'object' &&
        options &&
        (options as { ifAvailable?: boolean }).ifAvailable &&
        lockTails.has(name)
      )
        return Promise.resolve(work(null as unknown as object))
      const run = (lockTails.get(name) ?? Promise.resolve()).then(() =>
        work({ name }),
      )
      const tail = run.catch(() => undefined)
      lockTails.set(name, tail)
      return run.finally(() => {
        if (lockTails.get(name) === tail) lockTails.delete(name)
      })
    },
  },
})
jest.mock('@frank/wallet/evm-provider', () =>
  require('@frank/wallet/chain/canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('@frank/wallet/evm-http', () =>
  require('@frank/wallet/chain/canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/mailbox-client', () => ({
  ...require('@frank/wallet/chain/canonical-two-wallets.testutil').offlineMailboxModule(),
  fetchCanonicalMailboxPage: jest.fn(),
}))
let mockInvalidate: () => void, mockCustody: any
let mockSession: any, mockStore: any, mockWallet: any, mockJournalRoot: string
jest.mock('../accounts/session', () => {
  const a = jest.requireActual('../accounts/session')
  return {
    ...a,
    get accountSession() {
      return mockSession
    },
    get accountStatus() {
      return mockSession?.state ?? { status: 'loading', revision: 0 }
    },
  }
})
jest.mock('../adapters/level-message-store', () => ({
  get store() {
    return Promise.resolve(mockStore)
  },
}))
jest.mock('../utils/identity-session', () => ({
  messagingWallet: () => mockWallet,
  ensureConversationIdSalt: async () => undefined,
}))
jest.mock('../utils/clients', () => ({ useMonadWallet: () => mockWallet }))
jest.mock('../composables/useActiveWallet', () => ({
  useActiveWallet: async () => mockWallet,
}))
jest.mock('../utils/webpush-sync', () => ({
  ...jest.requireActual('../utils/webpush-sync'),
  syncRelayNotificationPolicy: jest.fn(),
}))
jest.mock('../utils/notifications', () => ({
  errorNotify: jest.fn(),
  insufficientStampNotify: jest.fn(),
  desktopNotify: jest.fn(),
}))
jest.mock('@frank/swap-protocol/src/storage/negotiation-browser', () => ({
  createBrowserNegotiationJournalStore: async (binding: object) =>
    require('@frank/swap-protocol/src/storage/negotiation-native').createNativeNegotiationJournalStore(
      { ...binding, rootLocation: mockJournalRoot },
    ),
}))
const { mount, flushPromises } = require('@vue/test-utils')
const { defineComponent, h } = require('vue')
const { createPinia, setActivePinia, getActivePinia } = require('pinia')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const {
  fixture,
  roots,
} = require('@frank/wallet/chain/canonical-two-wallets.testutil')
const { activeChain, setActiveChain } = require('@frank/wallet/chain')
const {
  installCanonicalDirectory,
  conversationIdSaltOf,
} = require('@frank/wallet/chain/evm-chain')
const {
  installMessageItemRegistry,
} = require('@frank/wallet/chain/canonical-dm')
const {
  restoreCanonicalRequest,
} = require('@frank/cashweb/relay/canonical-dm-transport')
const {
  LevelMessageStore,
} = require('@frank/cashweb/relay/storage/level-storage')
const { createAccountSession } = require('../accounts/session')
const { messageItems } = require('../utils/message-items')
const { setDirectoryLookup } = require('../utils/directory-peer')
const { messagingStateOwner } = require('../utils/messaging-state')
const {
  startAppNegotiationRecovery,
  negotiationRecoveryStatus,
} = require('../utils/negotiation-recovery')
const { negotiationCommandStatus } = require('./negotiation-commands')
const { useChatStore, setConversationIdSalt } = require('../stores/chats')
const { toHex, fromHex, standaloneItemBudget } = require('@frank/codec')
const Chat = require('../pages/Chat.vue').default
const Card = require('./SignedNegotiationCard.vue').default
const MessageBubble =
  require('../components/chat/messages/ChatMessage.vue').default
const Form = require('../components/dialogs/OfferSwapDialog.vue').default
const en = require('../i18n/en-us').default
const mailbox = require('@frank/cashweb/relay/mailbox-client')
jest.setTimeout(60000)
const pass = defineComponent({
  inheritAttrs: false,
  setup:
    (_: unknown, { slots, attrs }: any) =>
    () =>
      h('div', attrs, slots.default?.()),
})
const stubs: Record<string, unknown> = Object.fromEntries(
  Object.keys(require('quasar'))
    .filter(k => /^Q[A-Z]/.test(k))
    .map(k => [k, pass]),
)
stubs.QBtn = defineComponent({
  props: ['label', 'disable', 'loading'],
  setup:
    (p: any, { attrs, slots }: any) =>
    () =>
      h('button', { ...attrs, disabled: p.disable || p.loading }, [
        p.label,
        slots.default?.(),
      ]),
})
stubs.QInput = defineComponent({
  props: ['modelValue', 'label', 'type'],
  emits: ['update:modelValue'],
  setup:
    (p: any, { attrs, emit }: any) =>
    () =>
      h('input', {
        ...attrs,
        'type': p.type || 'text',
        'value': p.modelValue,
        'aria-label': p.label,
        'onInput': (e: any) => emit('update:modelValue', e.target.value),
      }),
})
stubs.QDialog = defineComponent({
  props: ['modelValue'],
  setup:
    (p: any, { slots }: any) =>
    () =>
      p.modelValue ? h('div', slots.default?.()) : null,
})
stubs.QScrollArea = defineComponent({
  methods: {
    getScrollTarget: () => ({ scrollTop: 0 }),
    setScrollPosition: () => undefined,
  },
  render(this: any) {
    return h('div', this.$slots.default?.())
  },
})
const translate = (key: string, params: Record<string, unknown> = {}) =>
  String(
    key.split('.').reduce((v: any, k: string) => v?.[k], en) ?? key,
  ).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m))
const globalOptions = {
  components: stubs,
  directives: { 'close-popup': {}, 'touch-swipe': {} },
  mocks: { $t: translate, $q: { dark: { isActive: false } } },
}
let f: any,
  root: string,
  recovery: any,
  directories: any[] = []
const mounted: any[] = [],
  reopenedWallets: any[] = []
const previousChain = { ...activeChain }
const receipt = (id: string) => ({
  schema: 1,
  policy: 'browser-preview-aes-gcm-v1',
  context: {
    accountId: id,
    creationId: id,
    recoveryFormat: 'frank-codex32-v1',
    registry: 'frank-domain-roots-v1',
    purposes: ['evm-wallet', 'identity-authentication', 'messaging-encryption'],
    custodyEpoch: 0,
    recoveryFingerprint: id,
    retirementContext: '',
  },
  previousRevision: 0,
  revision: 1,
  operationId: id,
})
async function useSession(index: number) {
  setActivePinia(createPinia())
  const wallet = index ? f.bob : f.alice
  const account = {
    descriptor: 'synthetic',
    displayName: 'Synthetic',
    receipt: receipt(index ? 'b' : 'a'),
  }
  const custody = {
    snapshot: async () => ({
      schema: 1,
      revision: 1,
      active: account,
      pending: null,
    }),
    reconcile: async () => 'ready',
    openActive: async () => ({
      account,
      takeRoots: () => Object.values(roots(index)),
      close() {},
    }),
    close() {},
  }
  mockCustody = custody
  mockSession = createAccountSession({
    open: async () => custody,
    createWallet: async () => wallet,
    listen: (invalidate: () => void) => {
      mockInvalidate = invalidate
      return () => undefined
    },
  })
  await mockSession.initialize()
  mockWallet = wallet
  messagingStateOwner.status = 'ready'
  messagingStateOwner.reason = null
  setDirectoryLookup(async () => ({
    subject: toHex((index ? f.alice : f.bob).identity.compressedPubKey),
  }))
  setConversationIdSalt(conversationIdSaltOf(wallet))
  recovery = startAppNegotiationRecovery({ wallet, revision: 1, account })
  await until(() => negotiationRecoveryStatus.snapshot?.state === 'ready')
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error(
    'Timed out: ' +
      negotiationRecoveryStatus.snapshot?.state +
      ' ' +
      negotiationCommandStatus.error,
  )
}
beforeEach(async () => {
  setActivePinia(createPinia())
  root = await mkdtemp(join(tmpdir(), 'signed-ui-'))
  mockJournalRoot = root
  mockStore = new LevelMessageStore(root)
  await mockStore.Open()
  f = await fixture()
  setActiveChain(f.chain)
  directories = [
    await f.directoryFor('alice', f.alice, f.bob),
    await f.directoryFor('bob', f.bob, f.alice),
  ]
  installCanonicalDirectory(f.alice, directories[0])
  installCanonicalDirectory(f.bob, directories[1])
  installMessageItemRegistry(f.alice, messageItems)
  installMessageItemRegistry(f.bob, messageItems)
  mailbox.fetchCanonicalMailboxPage.mockImplementation(
    async (auth: { subject: string; sinceMs: number }) => ({
      records: f.requests
        .map((request: unknown, i: number) => {
          const r = restoreCanonicalRequest(request)
          return {
            direction:
              toHex(
                require('@frank/codec').decodeDirectMessageCryptoContext(
                  r.parts.context,
                ).sender.keyBytes,
              ) === auth.subject
                ? 'out'
                : 'in',
            delivery: r.parts.delivery,
            context: r.parts.context,
            submissionIdentity: r.identity.submission_identity,
            timestampMs: 1000 + i,
          }
        })
        .filter((r: { timestampMs: number }) => r.timestampMs >= auth.sinceMs),
    }),
  )
  negotiationCommandStatus.error = ''
  negotiationCommandStatus.busy = false
  await useSession(0)
})
afterEach(async () => {
  mounted.splice(0).forEach(w => w.unmount())
  await recovery?.stop()
  recovery = undefined
  await mockStore.Close()
  await Promise.all(reopenedWallets.splice(0).map(w => w.close()))
  await f?.close()
  setActiveChain(previousChain)
  await rm(root, { recursive: true, force: true })
})
test.each([
  [0n, 'accept'],
  [1000n, 'accept'],
  [0n, 'reject'],
  [1000n, 'reject'],
])(
  'mounted composer signs exact offer and authenticated card signs response (stamp %s, %s)',
  async (stamp, decision) => {
    const chats = useChatStore(),
      address = f.bob.identity.displayAddress,
      conversationId = '01010101-0101-4101-8101-010101010101'
    chats.createConversation({
      participants: [f.alice.identity.displayAddress, address],
      address,
      conversationId,
    })
    chats.activeConversationId = conversationId
    const page = mount(Chat, {
      global: {
        ...globalOptions,
        plugins: [getActivePinia()],
        stubs: {
          ChatMessageComponent: true,
          ChatMessageReply: true,
          ChatBannerStack: true,
        },
        mocks: {
          ...globalOptions.mocks,
          $route: { params: { address: conversationId } },
        },
      },
    })
    mounted.push(page)
    await flushPromises()
    page.vm.defaultStampWei = stamp
    page.vm.defaultStampFailure = ''
    page.vm.minimumStampWei = 0n
    page.vm.stampAmount = f.chain.toDisplayAmount(stamp)
    await page.find('[data-testid="swap-menu-item"]').trigger('click')
    const form = page.findComponent(Form)
    expect(form.exists()).toBe(true)
    await form.find('[data-testid="swap-xec-amount"]').setValue('1.23')
    await form
      .find('[data-testid="swap-evm-amount"]')
      .setValue('0.000000000000000456')
    await form.find('[data-testid="swap-expiry"]').setValue('2030-01-01T12:00')
    await form.find('[data-testid="swap-review"]').trigger('click')
    await flushPromises()
    expect(form.find('[data-testid="swap-review-panel"]').exists()).toBe(true)
    expect(form.text()).toContain(conversationId)
    await form.find('[data-testid="swap-propose"]').trigger('click')
    await until(() => f.requests.length > 0 && !negotiationCommandStatus.busy)
    await flushPromises()
    expect(negotiationCommandStatus.error).toBe('')
    const records = await mockStore.outgoingApplicationMessages({
      accountId: 'a',
    })
    expect(records).toHaveLength(1)
    expect(records[0].phase).toBe('signed')
    const eventHex = records[0].signedPayloadHex
    // App-produced bytes also cross the production headless bot recovery composition.
    const {
      startBotNegotiationRecovery,
    } = require('@frank/bot-framework/negotiation-recovery')
    const bot = startBotNegotiationRecovery({
      chain: f.chain,
      wallet: f.bob,
      rootLocation: root,
      owner: {
        botId: 'synthetic-receiver',
        chainIdentifier: 'monad-testnet',
        subject: toHex(f.bob.identity.compressedPubKey),
        address: f.bob.identity.displayAddress,
      },
    })
    try {
      await until(() => bot.snapshot.state === 'ready')
      expect(bot.snapshot.journals[0].entries[0].eventBytes).toEqual(
        fromHex(eventHex),
      )
    } finally {
      await bot.stop()
    }
    const {
      decodeNegotiationEventSchema,
      TESTNET_NEGOTIATION_POLICY,
    } = require('@frank/swap-protocol/src/negotiation')
    const decoded = decodeNegotiationEventSchema(
      fromHex(eventHex),
      TESTNET_NEGOTIATION_POLICY,
      standaloneItemBudget(),
    )
    expect(decoded.ok).toBe(true)
    expect(decoded.value.terms.xecPrincipal).toBe(123n)
    expect(decoded.value.terms.evmPrincipal).toBe(456n)
    page.unmount()
    mounted.pop()
    await recovery.stop()
    await mockStore.Close()
    mockStore = new LevelMessageStore(root)
    await mockStore.Open()
    await useSession(1)
    expect(
      negotiationRecoveryStatus.snapshot.journals[0].reduction.history.offer,
    ).not.toBeNull()
    const received = await f.chain.directMessages.scanAuthenticatedMailbox({
      wallet: f.bob,
      sinceMs: 0,
    })
    const authenticated = received.records.find((r: any) =>
      r.items.some(
        (i: any) => i.type === 'application' && i.value.eventHex === eventHex,
      ),
    )
    expect(authenticated.messageId).toBe(records[0].messageId)
    const bubble = mount(MessageBubble, {
      props: {
        address: f.alice.identity.displayAddress,
        name: 'Alice',
        chatWidth: 500,
        payloadDigest: authenticated.payloadDigest,
        message: {
          outbound: false,
          status: 'confirmed',
          senderAddress: f.alice.identity.displayAddress,
          conversationId,
          receivedTime: 1000,
          serverTime: 1000,
          items: authenticated.items,
          outpoints: [],
          stampValueWei: stamp,
        },
      },
      global: {
        ...globalOptions,
        stubs: {
          ChatMessageSuffix: true,
          TransactionDialog: true,
          DeleteMessageDialog: true,
          ChatMessageMenu: true,
        },
      },
    })
    mounted.push(bubble)
    const card = bubble.findComponent(Card)
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('Authenticated offer')
    if (stamp === 0n && decision === 'accept') {
      const originalNow = card.vm.now
      await card.setData({ now: 3000000000n })
      expect(card.text()).toContain('Negotiation expired')
      expect(card.find('[data-testid="swap-response-review"]').exists()).toBe(
        false,
      )
      expect(card.findAll('button')).toHaveLength(0)
      await card.setData({ now: originalNow })
      await bubble.setProps({ address: f.bob.identity.displayAddress })
      expect(card.text()).toContain('awaiting authenticated admission')
      expect(card.findAll('button')).toHaveLength(0)
      await bubble.setProps({ address: f.alice.identity.displayAddress })
      await bubble.setProps({
        message: {
          ...bubble.props('message'),
          conversationId: '99999999-9999-4999-8999-999999999999',
        },
      })
      expect(card.findAll('button')).toHaveLength(0)
      await bubble.setProps({
        message: { ...bubble.props('message'), conversationId },
      })
    }
    const accept = card
      .findAll('button')
      .find(
        (b: any) => b.text() === (decision === 'accept' ? 'Accept' : 'Reject'),
      )
    expect(accept).toBeDefined()
    await accept.trigger('click')
    const confirmation = card.find(
      '[data-testid="swap-response-review"] button',
    )
    await Promise.all([
      confirmation.trigger('click'),
      confirmation.trigger('click'),
    ])
    await until(() => f.requests.length >= 2 && !negotiationCommandStatus.busy)
    await flushPromises()
    expect(negotiationCommandStatus.error).toBe('')
    expect(
      await mockStore.outgoingApplicationMessages({ accountId: 'b' }),
    ).toHaveLength(1)
    await recovery.stop()
    await useSession(1)
    expect(
      negotiationRecoveryStatus.snapshot.journals[0].reduction.history.decision,
    ).toBe(decision)
    expect(card.text()).toContain(
      decision === 'accept'
        ? 'Authenticated acceptance; principal execution is not authorized'
        : 'Authenticated rejection',
    )
    if (decision === 'accept') {
      await card.setData({ now: 3000000000n })
      expect(card.text()).toContain('Negotiation expired')
      expect(card.text()).toContain(
        'Authenticated acceptance; principal execution is not authorized',
      )
      expect(card.findAll('button')).toHaveLength(0)
    }
  },
)

test.each([0n, 1000n])(
  'deleted presentation and full wallet/session restart reuse original paid/free attempt (%s)',
  async stampValue => {
    const {
      captureNegotiation,
      sendNegotiation,
    } = require('./negotiation-commands')
    const conversationId = '11111111-1111-4111-8111-111111111111'
    const capture = await captureNegotiation({
      address: f.bob.identity.displayAddress,
      conversationId,
      swapId: new Uint8Array(32).fill(7),
      stampValue,
    })
    const intent = {
      action: 'offer',
      context: capture.context,
      xecPrincipal: 100n,
      evmPrincipal: 500n,
      expiry: 2000000000n,
    }
    f.setPhase('retained')
    await expect(sendNegotiation(capture, intent)).rejects.toThrow(
      'delivery pending',
    )
    const record = (
      await mockStore.outgoingApplicationMessages({ accountId: 'a' })
    )[0]
    expect(record.phase).toBe('signed')
    const originalAttempt = await f.chain.directMessages.attemptOf({
      wallet: f.alice,
      messageId: record.messageId,
    })
    expect(originalAttempt.paid).toBe(stampValue > 0n)
    const original = restoreCanonicalRequest(f.requests[0])
    const chats = useChatStore()
    const row = Object.values(chats.messages).find(
      (m: any) => m.sealedMessageId === record.messageId,
    ) as any
    await chats.deleteMessage({
      address: f.bob.identity.displayAddress,
      payloadDigest: row.payloadDigest,
      wallet: f.alice,
    })
    expect(
      (await mockStore.outgoingApplicationMessages({ accountId: 'a' }))[0],
    ).toEqual(record)
    await recovery.stop()
    await mockSession.close()
    await mockStore.Close()
    f.alice = await f.chain.createWallet(roots(0))
    reopenedWallets.push(f.alice)
    installCanonicalDirectory(f.alice, directories[0])
    installMessageItemRegistry(f.alice, messageItems)
    mockStore = new LevelMessageStore(root)
    await mockStore.Open()
    f.setPhase('delivered')
    await useSession(0)
    expect(
      await f.chain.directMessages.attemptOf({
        wallet: f.alice,
        messageId: record.messageId,
      }),
    ).toEqual(originalAttempt)
    const recovered = await captureNegotiation({
      address: f.bob.identity.displayAddress,
      conversationId,
      swapId: intent.context.swapId,
      stampValue,
    })
    const derivation = jest.spyOn(mockSession, 'getActiveFamilyMaterial')
    await sendNegotiation(recovered, intent)
    expect(derivation).not.toHaveBeenCalled()
    expect(
      (await mockStore.outgoingApplicationMessages({ accountId: 'a' }))[0],
    ).toEqual(record)
    const matching = f.requests
      .map(restoreCanonicalRequest)
      .filter(
        (r: any) =>
          r.identity.submission_identity ===
          original.identity.submission_identity,
      )
    expect(matching.length).toBeGreaterThan(1)
    expect(
      matching.every(
        (r: any) =>
          toHex(r.parts.delivery) === toHex(original.parts.delivery) &&
          toHex(r.parts.context) === toHex(original.parts.context) &&
          r.parts.transactions.map(toHex).join(',') ===
            original.parts.transactions.map(toHex).join(','),
      ),
    ).toBe(true)
    const reconstructed = Object.values(useChatStore().messages).find(
      (m: any) => m.sealedMessageId === record.messageId,
    ) as any
    expect(reconstructed.items).toEqual([
      {
        type: 'application',
        itemType: 'swap-negotiation-v1',
        value: { eventHex: record.signedPayloadHex },
      },
    ])
  },
)

test.each(['peer', 'claim', 'sign', 'completion', 'send'] as const)(
  'actual account invalidation during %s await prevents a new message',
  async phase => {
    const {
      captureNegotiation,
      sendNegotiation,
    } = require('./negotiation-commands')
    let entered!: () => void, release!: () => void
    const enteredGate = new Promise<void>(r => {
        entered = r
      }),
      gate = new Promise<void>(r => {
        release = r
      })
    const request = {
      address: f.bob.identity.displayAddress,
      conversationId: '11111111-1111-4111-8111-111111111111',
      swapId: new Uint8Array(32).fill(9),
      stampValue: 0n,
    }
    if (phase === 'peer') {
      setDirectoryLookup(async () => {
        entered()
        await gate
        return { subject: toHex(f.bob.identity.compressedPubKey) }
      })
      const capturing = captureNegotiation(request)
      await enteredGate
      mockInvalidate()
      release()
      await expect(capturing).rejects.toThrow()
    } else {
      const captured = await captureNegotiation(request)
      const intent = {
        action: 'offer',
        context: captured.context,
        xecPrincipal: 100n,
        evmPrincipal: 500n,
        expiry: 2000000000n,
      }
      if (phase === 'claim') {
        const original =
          mockStore.claimOutgoingApplicationMessage.bind(mockStore)
        jest
          .spyOn(mockStore, 'claimOutgoingApplicationMessage')
          .mockImplementation(async (claim: unknown) => {
            const r = await original(claim)
            entered()
            await gate
            return r
          })
      } else if (phase === 'sign') {
        const original = mockCustody.openActive.bind(mockCustody)
        jest
          .spyOn(mockCustody, 'openActive')
          .mockImplementationOnce(async () => {
            entered()
            await gate
            return original()
          })
      }
      let relay: any
      if (phase === 'completion') {
        const original =
          mockStore.completeOutgoingApplicationMessage.bind(mockStore)
        jest
          .spyOn(mockStore, 'completeOutgoingApplicationMessage')
          .mockImplementation(async (value: unknown) => {
            const result = await original(value)
            entered()
            await gate
            return result
          })
      }
      if (phase === 'send') {
        relay = f.holdNextRelayRequest()
        void relay.entered.then(entered)
      }
      const sending = sendNegotiation(captured, intent)
      await enteredGate
      mockInvalidate()
      release()
      relay?.release('retained')
      await expect(sending).rejects.toThrow()
      const rows = await mockStore.outgoingApplicationMessages({
        accountId: 'a',
      })
      expect(rows).toHaveLength(1)
      expect(rows[0].phase).toBe(
        phase === 'completion' || phase === 'send' ? 'signed' : 'claimed',
      )
    }
    expect(f.requests).toHaveLength(phase === 'send' ? 1 : 0)
  },
)

test('same peer in independent conversations retains separate authenticated state and cannot cross-render an offer', async () => {
  const {
    captureNegotiation,
    sendNegotiation,
  } = require('./negotiation-commands')
  const conversations = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ]
  for (let i = 0; i < 2; i++) {
    const capture = await captureNegotiation({
      address: f.bob.identity.displayAddress,
      conversationId: conversations[i],
      swapId: new Uint8Array(32).fill(21 + i),
      stampValue: 0n,
    })
    await sendNegotiation(capture, {
      action: 'offer',
      context: capture.context,
      xecPrincipal: 100n + BigInt(i),
      evmPrincipal: 500n,
      expiry: 2000000000n,
    })
  }
  const records = await mockStore.outgoingApplicationMessages({
    accountId: 'a',
  })
  expect(records).toHaveLength(2)
  expect(records[0].messageId).not.toBe(records[1].messageId)
  await recovery.stop()
  await useSession(1)
  expect(negotiationRecoveryStatus.snapshot.journals).toHaveLength(2)
  const props = {
    item: {
      type: 'application',
      itemType: 'swap-negotiation-v1',
      value: {
        eventHex: records.find(
          (r: any) => r.conversationId === conversations[0],
        ).signedPayloadHex,
      },
    },
    address: f.alice.identity.displayAddress,
    senderAddress: f.alice.identity.displayAddress,
    outbound: false,
    conversationId: conversations[0],
    deliveryStatus: 'confirmed',
  }
  const card = mount(Card, { props, global: globalOptions })
  mounted.push(card)
  expect(card.text()).toContain('Authenticated offer')
  await card.setProps({ conversationId: conversations[1] })
  expect(card.findAll('button')).toHaveLength(0)
  await card.setProps({ conversationId: conversations[0] })
  await card
    .findAll('button')
    .find((b: any) => b.text() === 'Accept')
    .trigger('click')
  await card
    .find('[data-testid="swap-response-review"] button')
    .trigger('click')
  await until(() => f.requests.length >= 3 && !negotiationCommandStatus.busy)
  await recovery.stop()
  await useSession(1)
  const journals = negotiationRecoveryStatus.snapshot.journals
  expect(
    journals.find(
      (j: any) =>
        toHex(j.context.conversationId) === conversations[0].replace(/-/g, ''),
    ).reduction.history.decision,
  ).toBe('accept')
  expect(
    journals.find(
      (j: any) =>
        toHex(j.context.conversationId) === conversations[1].replace(/-/g, ''),
    ).reduction.history.decision,
  ).toBeNull()
})

test('an authenticated response before its offer remains incomplete and never enables a response action', async () => {
  const {
    buildNegotiationOffer,
    buildNegotiationResponse,
    TESTNET_NEGOTIATION_POLICY,
  } = require('@frank/swap-protocol/src/negotiation')
  const { encodeSignedSwapEvent } = require('@frank/swap-protocol/src')
  const context = {
    swapId: new Uint8Array(32).fill(30),
    conversationId: new Uint8Array(16).fill(31),
    parties: [
      f.alice.identity.compressedPubKey,
      f.bob.identity.compressedPubKey,
    ],
    policy: TESTNET_NEGOTIATION_POLICY,
  }
  const offer = await buildNegotiationOffer(
    context,
    { xecPrincipal: 100n, evmPrincipal: 500n, expiry: 2000000000n },
    async (d: Uint8Array) => f.alice.identity.signHash(Buffer.from(d)),
  )
  const offerBytes = encodeSignedSwapEvent(offer.value).value
  const response = await buildNegotiationResponse(
    context,
    offerBytes,
    'accept',
    async (d: Uint8Array) => f.bob.identity.signHash(Buffer.from(d)),
  )
  const eventHex = toHex(encodeSignedSwapEvent(response.value).value)
  const conversationId =
    require('@frank/cashweb/relay/conversation-id').formatConversationId(
      context.conversationId,
    )
  await f.chain.directMessages.send({
    wallet: f.bob,
    recipient: f.alice.identity.address,
    conversationId,
    messageId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    stampValue: 0n,
    items: [
      {
        type: 'application',
        itemType: 'swap-negotiation-v1',
        value: { eventHex },
      },
    ],
  })
  await recovery.stop()
  await useSession(0)
  const card = mount(Card, {
    props: {
      item: {
        type: 'application',
        itemType: 'swap-negotiation-v1',
        value: { eventHex },
      },
      address: f.bob.identity.displayAddress,
      senderAddress: f.bob.identity.displayAddress,
      outbound: false,
      conversationId,
      deliveryStatus: 'confirmed',
    },
    global: globalOptions,
  })
  mounted.push(card)
  expect(card.text()).toContain('Authenticated evidence is incomplete')
  expect(card.findAll('button')).toHaveLength(0)
  expect(
    negotiationRecoveryStatus.snapshot.journals[0].reduction.history.offer,
  ).toBeNull()
})

test('legacy unsigned swap presentation is inert through the actual generic bubble', () => {
  const bubble = mount(MessageBubble, {
    props: {
      address: f.bob.identity.displayAddress,
      name: 'Bob',
      chatWidth: 500,
      payloadDigest: 'aa'.repeat(32),
      message: {
        outbound: false,
        status: 'confirmed',
        senderAddress: f.bob.identity.displayAddress,
        conversationId: '11111111-1111-4111-8111-111111111111',
        receivedTime: 1000,
        serverTime: 1000,
        items: [
          {
            type: 'swap-offer',
            swapId: 'legacy',
            status: 'accepted',
            hashLock: 'legacy',
            preimage: 'legacy',
          },
        ],
        outpoints: [],
      },
    },
    global: {
      ...globalOptions,
      stubs: {
        ChatMessageSuffix: true,
        TransactionDialog: true,
        DeleteMessageDialog: true,
        ChatMessageMenu: true,
      },
    },
  })
  mounted.push(bubble)
  expect(bubble.text()).toContain('Unsupported unsigned swap history')
  expect(bubble.findComponent(Card).exists()).toBe(false)
  expect(bubble.findAll('button')).toHaveLength(0)
  expect(bubble.emitted('sendFollowUp')).toBeUndefined()
})

test.each([false, true])(
  'generic retry preserves persisted application stamp authority (automatic=%s)',
  async automatic => {
    const {
      captureNegotiation,
      sendNegotiation,
    } = require('./negotiation-commands')
    const { DirectMessageStampBelowFeeError } = require('@frank/wallet/chain')
    const capture = await captureNegotiation({
      address: f.bob.identity.displayAddress,
      conversationId: '11111111-1111-4111-8111-111111111111',
      swapId: new Uint8Array(32).fill(7),
      stampValue: 1000n,
    })
    const intent = {
      action: 'offer',
      context: capture.context,
      xecPrincipal: 100n,
      evmPrincipal: 500n,
      expiry: 2000000000n,
    }
    const send = jest
      .spyOn(f.chain.directMessages, 'send')
      .mockImplementation(async p => {
        throw new DirectMessageStampBelowFeeError(p.stampValue!, 5000n)
      })
    const minimum = jest
      .spyOn(f.chain.directMessages, 'minimumStamp')
      .mockResolvedValue(5000n)
    try {
      await expect(sendNegotiation(capture, intent)).rejects.toThrow(
        'delivery pending',
      )
      const record = (
        await mockStore.outgoingApplicationMessages({ accountId: 'a' })
      )[0]
      expect(record.stampValueWei).toBe('1000')
      expect(record.phase).toBe('signed')
      expect(
        await f.chain.directMessages.attemptOf({
          wallet: f.alice,
          messageId: record.messageId,
        }),
      ).toBeUndefined()
      const chats = useChatStore()
      const row = Object.values(chats.messages).find(
        m => m.sealedMessageId === record.messageId,
      )!
      expect(row.delivery?.failureReason).toBe('stamp-below-fee')
      if (automatic)
        await chats.setOutgoingState(
          f.bob.identity.displayAddress,
          row.payloadDigest,
          'error',
          { failureReason: 'interrupted' },
        )
      await chats.retryOutgoing({
        wallet: f.alice,
        address: f.bob.identity.displayAddress,
        payloadDigest: row.payloadDigest,
        automatic,
      })
      expect(row.stampValueWei).toBe(1000n)
      expect(send).toHaveBeenCalledTimes(2)
      expect(
        send.mock.calls.every(
          ([p]) => p.stampValue === 1000n && p.messageId === record.messageId,
        ),
      ).toBe(true)
      expect(minimum).not.toHaveBeenCalled()
      expect(
        (await mockStore.outgoingApplicationMessages({ accountId: 'a' }))[0],
      ).toEqual(record)
      send.mockRestore()
      minimum.mockRestore()
      await sendNegotiation(capture, intent)
      expect(f.requests).toHaveLength(1)
      expect(
        await f.chain.directMessages.attemptOf({
          wallet: f.alice,
          messageId: record.messageId,
        }),
      ).toBeDefined()
      expect(
        (await mockStore.outgoingApplicationMessages({ accountId: 'a' }))[0],
      ).toEqual(record)
    } finally {
      send.mockRestore()
      minimum.mockRestore()
    }
  },
)

test.each(['missing', 'unreadable', 'conflicting', 'revoked'])(
  'rekeyed application retry fails closed on %s authority',
  async failure => {
    const {
      captureNegotiation,
      sendNegotiation,
    } = require('./negotiation-commands')
    const capture = await captureNegotiation({
      address: f.bob.identity.displayAddress,
      conversationId: '11111111-1111-4111-8111-111111111111',
      swapId: new Uint8Array(32).fill(8),
      stampValue: 0n,
    })
    const intent = {
      action: 'offer',
      context: capture.context,
      xecPrincipal: 100n,
      evmPrincipal: 500n,
      expiry: 2000000000n,
    }
    // Substitute delivery only to get a rekeyed presentation without creating an attempt.
    const send = jest.spyOn(f.chain.directMessages, 'send').mockResolvedValue({
      payloadDigest: 'ab'.repeat(32),
      stampValueWei: 0n,
      stampPayments: [],
      preparationTxHashes: [],
    })
    await sendNegotiation(capture, intent)
    const record = (
      await mockStore.outgoingApplicationMessages({ accountId: 'a' })
    )[0]
    const chats = useChatStore()
    const id = 'ab'.repeat(32)
    const reference = {
      accountId: record.accountId,
      intentKey: record.intentKey,
    }
    expect(chats.messages[id].applicationAuthorization).toEqual(reference)
    expect(
      (await mockStore.getMessage(id)).message.applicationAuthorization,
    ).toEqual(reference)
    await chats.setOutgoingState(f.bob.identity.displayAddress, id, 'error', {
      failureReason: 'stamp-below-fee',
    })
    send.mockClear()
    const minimum = jest
      .spyOn(f.chain.directMessages, 'minimumStamp')
      .mockResolvedValue(5000n)
    const lookup = jest
      .spyOn(mockStore, 'outgoingApplicationMessage')
      .mockImplementation(async () => {
        if (failure === 'missing') return undefined
        if (failure === 'unreadable') throw new Error('store unavailable')
        if (failure === 'revoked') {
          mockInvalidate()
          return record
        }
        return { ...record, stampValueWei: '5000' }
      })
    try {
      await expect(
        chats.retryOutgoing({
          wallet: f.alice,
          address: f.bob.identity.displayAddress,
          payloadDigest: id,
        }),
      ).rejects.toThrow()
      expect(send).not.toHaveBeenCalled()
      expect(minimum).not.toHaveBeenCalled()
      expect(chats.messages[id].stampValueWei).toBe(0n)
      expect(
        (await mockStore.outgoingApplicationMessages({ accountId: 'a' }))[0],
      ).toEqual(record)
      if (failure !== 'revoked') {
        // Missing feature authority cannot strand an already exposed original payment.
        await chats.setOutgoingState(
          f.bob.identity.displayAddress,
          id,
          'error',
          { attemptDigest: id },
        )
        const reconcile = jest
          .spyOn(f.chain.directMessages, 'reconcileAttempts')
          .mockResolvedValue({ [id]: 'delivered' })
        lookup.mockClear()
        expect(
          (
            await chats.retryOutgoing({
              wallet: f.alice,
              address: f.bob.identity.displayAddress,
              payloadDigest: id,
            })
          ).state,
        ).toBe('sent')
        expect(reconcile).toHaveBeenCalled()
        expect(lookup).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
        reconcile.mockRestore()
      }
    } finally {
      lookup.mockRestore()
      minimum.mockRestore()
      send.mockRestore()
    }
  },
)
