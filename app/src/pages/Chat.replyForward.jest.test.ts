/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import { nextTick } from 'vue'

import ChatPage from './Chat.vue'

const PEER = '0x3e3e3e3e3e3E3E3E3e3e3E3E3e3e3E3E3e3E3E3e'
const BOB = '0x4f4f4f4f4f4F4F4F4f4f4F4F4f4f4F4F4f4F4F4f'

const mockSendMessage = jest.fn(async () => ({ state: 'sent' }))
const mockOpenChat = jest.fn()

jest.mock('../utils/routes', () => ({
  openChat: (...args: any[]) => mockOpenChat(...args),
}))

jest.mock('../stores/chats', () => ({
  useChatStore: () => ({
    conversations: {},
    chats: {
      [PEER]: {
        messages: [
          {
            payloadDigest: 'msg-1',
            outbound: false,
            senderAddress: PEER,
            items: [{ type: 'text', text: 'Original message' }],
          },
        ],
      },
    },
    messages: {
      'msg-1': {
        payloadDigest: 'msg-1',
        outbound: false,
        senderAddress: PEER,
        items: [{ type: 'text', text: 'Original message' }],
      },
    },
    sendMessage: mockSendMessage,
    getStampAmount: () => 0,
    readAll: jest.fn(),
  }),
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
jest.mock('../utils/notifications', () => ({
  errorNotify: jest.fn(),
  insufficientStampNotify: jest.fn(),
}))

jest.mock('../composables/useActiveWallet', () => ({
  useActiveWallet: () => ({}),
}))

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    defaultStampValue: 1n,
    fromDisplayAmount: () => 1n,
    toDisplayAmount: () => '1',
    unit: 'MON',
  },
}))

describe('Chat Reply and Forward flows', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  function mountChat() {
    const focus = jest.fn()
    const wrapper = shallowMount(ChatPage, {
      global: {
        mocks: {
          $route: { params: { address: PEER } },
          $router: { push: jest.fn() },
          $t: (k: string) => k,
          $q: {
            platform: { is: { mobile: false } },
            dark: { isActive: false },
          },
        },
        stubs: {
          QScrollArea: {
            template: '<div><slot /></div>',
            methods: {
              getScrollTarget: () => ({ scrollTop: 0, scrollHeight: 0 }),
              setScrollPosition: () => undefined,
            },
          },
          ChatInput: {
            template: '<div />',
            methods: { focus },
          },
          ChatMessageReply: { template: '<div />' },
          ForwardMessageDialog: { template: '<div />' },
        },
      },
    })
    return { wrapper, focus }
  }

  it('setReply sets replyDigest and focuses the chat input', async () => {
    const { wrapper, focus } = mountChat()
    const vm = wrapper.vm as any

    vm.setReply('msg-1')
    expect(vm.replyDigest).toBe('msg-1')

    await nextTick()
    expect(focus).toHaveBeenCalled()
  })

  it('sendMessage includes reply item and clears replyDigest', async () => {
    const { wrapper } = mountChat()
    const vm = wrapper.vm as any

    vm.setReply('msg-1')
    await vm.sendMessage('My reply text')

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        address: PEER,
        items: [
          { type: 'reply', payloadDigest: 'msg-1' },
          { type: 'text', text: 'My reply text' },
        ],
      }),
    )
    expect(vm.replyDigest).toBeNull()
  })

  it('handleForwardClicked opens dialog with the selected message', () => {
    const { wrapper } = mountChat()
    const vm = wrapper.vm as any

    expect(vm.forwardDialogOpen).toBe(false)
    vm.handleForwardClicked({ address: PEER, payloadDigest: 'msg-1' })

    expect(vm.forwardDialogOpen).toBe(true)
    expect(vm.messageToForward).toEqual(
      expect.objectContaining({ payloadDigest: 'msg-1' }),
    )
  })

  it('handleForwardToContact sends forwarded items and opens target chat', async () => {
    const { wrapper } = mountChat()
    const vm = wrapper.vm as any

    vm.handleForwardClicked({ address: PEER, payloadDigest: 'msg-1' })
    await vm.handleForwardToContact(BOB)

    expect(vm.forwardDialogOpen).toBe(false)
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        address: BOB,
        items: [{ type: 'text', text: 'Original message' }],
      }),
    )
    expect(mockOpenChat).toHaveBeenCalledWith(expect.anything(), BOB)
    expect(vm.messageToForward).toBeNull()
  })
})
