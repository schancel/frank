/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import { nextTick } from 'vue'

import ChatPage from './Chat.vue'
import { errorNotify } from '../utils/notifications'

const PEER = '0x3e3e3e3e3e3E3E3E3e3e3E3E3e3e3E3E3e3E3E3e'
const BOB = '0x4f4f4f4f4f4F4F4F4f4f4F4F4f4f4F4F4f4F4F4f'

const mockSendMessage = jest.fn(async () => ({ state: 'sent' }))
const mockOpenChat = jest.fn()

// Chat.vue reads the own address reactively; these tests have no wallet to resolve it from.
jest.mock('../utils/own-address', () => ({
  ...jest.requireActual('../utils/own-address'),
  useReactiveOwnCanonicalAddress: () => jest.requireActual('vue').ref(null),
}))
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
    getStampWei: () => 1n,
    readAll: jest.fn(),
  }),
}))

let mockAcceptancePrice = 0
let mockStampWei = 1n
jest.mock('../stores/contacts', () => ({
  useContactStore: () => ({
    getAcceptancePrice: () => mockAcceptancePrice,
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
    fromDisplayAmount: () => mockStampWei,
    toDisplayAmount: () => '1',
    unit: 'MON',
  },
}))

const { insufficientStampNotify } = jest.requireMock('../utils/notifications')

describe('Chat Reply and Forward flows', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAcceptancePrice = 0
    mockStampWei = 1n
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

  it('a free message to a contact with a price is sent without the short-stamp notice', async () => {
    mockAcceptancePrice = 100
    mockStampWei = 0n
    const { wrapper } = mountChat()
    await (wrapper.vm as any).sendMessage('free on purpose')
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ stampValue: 0n }),
    )
    expect(insufficientStampNotify).not.toHaveBeenCalled()
  })

  it('a stamp that is paid but below the contact’s price still gets the notice', async () => {
    mockAcceptancePrice = 100
    mockStampWei = 50n
    const { wrapper } = mountChat()
    await (wrapper.vm as any).sendMessage('paid, but short')
    expect(insufficientStampNotify).toHaveBeenCalledTimes(1)
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

  // Pictures go the way text does: the composer's one send, through the store's sendMessage.
  const pictures = [
    {
      id: '3',
      name: 'a.png',
      dataUrl: 'data:image/png;base64,AAAA',
      sizeBytes: 3,
    },
    {
      id: '7',
      name: 'b.png',
      dataUrl: 'data:image/png;base64,BBBB',
      sizeBytes: 3,
    },
  ]

  it('sendMessage sends the reply, the text, then the pictures it refers to by position', async () => {
    const { wrapper } = mountChat()
    const vm = wrapper.vm as any

    vm.setReply('msg-1')
    vm.attachments = pictures
    await vm.sendMessage('see ![b](attachment:7) and ![a](attachment:3)')

    expect(mockSendMessage).toHaveBeenCalledTimes(1)
    expect(mockSendMessage.mock.calls[0][0]).toMatchObject({
      address: PEER,
      items: [
        { type: 'reply', payloadDigest: 'msg-1' },
        { type: 'text', text: 'see ![b](attachment:2) and ![a](attachment:1)' },
        { type: 'image', image: 'data:image/png;base64,AAAA' },
        { type: 'image', image: 'data:image/png;base64,BBBB' },
      ],
    })
    expect(vm.attachments).toEqual([])
    expect(vm.message).toBe('')
  })

  it('sendMessage sends just the pictures when there is no text', async () => {
    const { wrapper } = mountChat()
    const vm = wrapper.vm as any

    vm.attachments = pictures
    await vm.sendMessage('')

    expect(mockSendMessage.mock.calls[0][0].items).toEqual([
      { type: 'image', image: 'data:image/png;base64,AAAA' },
      { type: 'image', image: 'data:image/png;base64,BBBB' },
    ])
  })

  it('sendMessage sends nothing when there is neither text nor a picture', async () => {
    const { wrapper } = mountChat()
    await (wrapper.vm as any).sendMessage('  ')
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('sendMessage refuses a message too large for one message before anything is sent, and keeps it', async () => {
    const { wrapper } = mountChat()
    const vm = wrapper.vm as any
    const huge = [
      { id: '1', name: 'a.png', dataUrl: 'A'.repeat(300_000), sizeBytes: 1 },
      { id: '2', name: 'b.png', dataUrl: 'B'.repeat(300_000), sizeBytes: 1 },
    ]
    vm.attachments = huge
    vm.message = 'hello'
    await vm.sendMessage('hello')

    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(errorNotify).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'chatInput.messageTooLarge' }),
    )
    expect(vm.attachments).toEqual(huge)
    expect(vm.message).toBe('hello')
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
