/** @jest-environment jsdom */

// The account's active device sends a chat's free automatic game steps; another device of the
// account does not (`stores/leader.ts`, `utils/automatic-game-steps.ts`). A step owed while this
// device was not the active one is sent when it becomes the active one, and only once.
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, reactive } from 'vue'
import {
  diceCommitment,
  diceRoll,
} from '@frank/wallet/message-item-plugins/dice/fair'

import ChatPage from './Chat.vue'
import { saveDiceSecret } from '../utils/p2p-games'

const OWN = '0x1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a'

jest.mock('../utils/own-address', () => ({
  ...jest.requireActual('../utils/own-address'),
  getOwnCanonicalAddress: async () =>
    '0x1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a',
  useReactiveOwnCanonicalAddress: () => jest.requireActual('vue').ref(null),
  // This test's chain stand-in parses no address.
  sameCanonicalAddress: (a?: string, b?: string) =>
    !!a && !!b && a.toLowerCase() === b.toLowerCase(),
}))
jest.mock('quasar', () => {
  const actual = jest.requireActual<Record<string, unknown>>('quasar')
  return {
    ...actual,
    useQuasar: () => ({ platform: { is: { mobile: false } } }),
  }
})

const PEER = '0x3e3e3e3e3e3E3E3E3e3e3E3E3e3e3E3E3e3E3E3e'

let mockChatStore: ReturnType<typeof storeFor>
const mockLeader: { isActiveMaster: boolean } = jest
  .requireActual('vue')
  .reactive({ isActiveMaster: false })

jest.mock('../stores/chats', () => ({
  useChatStore: () => mockChatStore,
}))
jest.mock('../stores/contacts', () => ({
  useContactStore: () => ({
    getAcceptancePrice: () => 0,
    getContact: () => ({ profile: { name: 'Peer' } }),
  }),
}))
jest.mock('../stores/my-profile', () => ({
  useProfileStore: () => ({ profile: { name: 'Me' } }),
}))
jest.mock('../utils/clients', () => ({ useMonadWallet: () => ({}) }))
jest.mock('../stores/leader', () => ({
  useLeaderStore: () => mockLeader,
}))
jest.mock('../utils/notifications', () => ({
  errorNotify: jest.fn(),
  insufficientStampNotify: jest.fn(),
}))
jest.mock('../composables/useActiveWallet', () => ({
  useActiveWallet: () => ({}),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    fromDisplayAmount: () => 1n,
    toDisplayAmount: () => '1',
    unit: 'MON',
  },
}))

const passthrough = (tag = 'div') =>
  defineComponent({
    inheritAttrs: false,
    setup:
      (_, { attrs, slots }) =>
      () =>
        h(tag, attrs, slots.default?.()),
  })

const QScrollArea = defineComponent({
  methods: {
    getScrollTarget: () => ({ scrollTop: 0, scrollHeight: 0 }),
    setScrollPosition: () => undefined,
  },
  render() {
    return h('div', this.$slots.default?.())
  },
})

const InputStub = defineComponent({
  methods: {
    focus() {
      ;(this.$refs.box as HTMLTextAreaElement | undefined)?.focus()
    },
  },
  render() {
    return h('textarea', { 'ref': 'box', 'data-testid': 'compose-box' })
  },
})

const Blank = defineComponent({ render: () => h('i') })

const ROLL = 'roll-1'
const SECRET = 'ab'.repeat(32)
const CLIENT_SEED = 'c3'.repeat(16)

/** The account deals a dice table; the peer rolled and lost, so the reveal is owed and free. */
function diceMessages() {
  const commitment = diceCommitment(SECRET)
  return [
    {
      outbound: true,
      status: 'confirmed',
      senderAddress: OWN,
      payloadDigest: 'table',
      serverTime: 1,
      items: [{ type: 'dice', action: 'table', rollId: ROLL, commitment }],
    },
    {
      outbound: false,
      status: 'confirmed',
      senderAddress: PEER,
      payloadDigest: 'roll',
      serverTime: 2,
      items: [
        {
          type: 'dice',
          action: 'roll',
          rollId: ROLL,
          commitment,
          clientSeed: CLIENT_SEED,
          target: Math.max(1, diceRoll(SECRET, CLIENT_SEED)),
          wagerWei: (10n ** 16n).toString(),
        },
      ],
    },
  ]
}

function storeFor() {
  const chat = { id: PEER, address: PEER, messages: diceMessages() }
  return reactive({
    conversations: {},
    chats: { [PEER]: chat },
    // The chat is found as the open conversation (this test's chain stand-in parses no address).
    activeConversation: chat,
    messages: {},
    activeConversationId: PEER,
    composeFocusRequest: null,
    getAcceptancePrice: () => 0,
    getStampWei: () => 1n,
    setStampWei: jest.fn(),
    getMessageByPayload: () => null,
    sendMessage: jest.fn(),
    requestComposeFocus: jest.fn(),
    setActiveConversation: jest.fn(),
  })
}

function setPointer() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
      onchange: null,
    }),
  })
}

function mountChat(host: HTMLElement = document.body) {
  mockChatStore = storeFor()
  return mount(ChatPage, {
    attachTo: host,
    global: {
      components: {
        QPageContainer: passthrough(),
        QPage: passthrough(),
        QScrollArea,
        QPageSticky: passthrough(),
        QInnerLoading: passthrough(),
        QFooter: passthrough(),
        QBtn: passthrough('button'),
      },
      directives: { 'touch-swipe': {} },
      stubs: {
        ChatInput: InputStub,
        ChatBannerStack: Blank,
        ChatMessageReply: Blank,
        ChatMessageComponent: Blank,
      },
      mocks: {
        $route: { params: { address: PEER } },
        $q: { dark: { isActive: false } },
        $t: (key: string) => key,
      },
    },
  })
}

async function settle() {
  for (let i = 0; i < 10; i++) {
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

describe('a chat on a device that is not the active one', () => {
  let sendFollowUp: jest.SpyInstance
  beforeEach(() => {
    setPointer()
    saveDiceSecret(OWN, PEER, ROLL, SECRET)
    mockLeader.isActiveMaster = false
    sendFollowUp = jest
      .spyOn(
        (ChatPage as unknown as { methods: Record<string, () => unknown> })
          .methods,
        'sendFollowUpItems',
      )
      .mockResolvedValue(true)
  })
  afterEach(() => {
    sendFollowUp.mockRestore()
    document.body.innerHTML = ''
  })

  it('sends the owed automatic step once it becomes the active device, and only once', async () => {
    const wrapper = mountChat()
    await settle()
    // Another device of the account is the active one: nothing is sent here.
    expect(sendFollowUp).not.toHaveBeenCalled()

    mockLeader.isActiveMaster = true
    await settle()
    expect(sendFollowUp).toHaveBeenCalledTimes(1)
    const sent = sendFollowUp.mock.calls[0][0] as {
      items: { type: string; action: string; rollId: string }[]
      stampValueWei: bigint
      operationId: string
    }
    expect(sent.items[0]).toMatchObject({
      type: 'dice',
      action: 'result',
      rollId: ROLL,
    })
    expect(sent.stampValueWei).toBe(0n)
    expect(sent.operationId).toBe(`pending:automatic-step:${PEER}:dice:${ROLL}`)

    // It goes back to standby and becomes active again: the step is not sent twice.
    mockLeader.isActiveMaster = false
    await settle()
    mockLeader.isActiveMaster = true
    await settle()
    expect(sendFollowUp).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})
