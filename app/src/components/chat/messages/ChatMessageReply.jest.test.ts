/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import ChatMessageReply from './ChatMessageReply.vue'

const mockMessageStore: Record<string, any> = {
  'digest-outbound': {
    outbound: true,
    senderAddress: '0xMe',
    items: [{ type: 'text', text: 'My message' }],
  },
  'digest-inbound': {
    outbound: false,
    senderAddress: '0xAlice',
    items: [{ type: 'text', text: 'Alice message' }],
  },
  'digest-unknown': {
    outbound: false,
    senderAddress: '0xUnknown',
    items: [{ type: 'text', text: 'Unknown message' }],
  },
}

const mockContacts: Record<string, any> = {
  '0xAlice': {
    profile: { name: 'Alice' },
  },
}

jest.mock('src/stores/chats', () => ({
  useChatStore: () => ({
    getMessageByPayload: (digest: string) => mockMessageStore[digest],
  }),
}))

jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({
    getContact: (address: string) => mockContacts[address],
  }),
}))

describe('ChatMessageReply', () => {
  const mountReply = (payloadDigest: string) => {
    return shallowMount(ChatMessageReply, {
      props: {
        payloadDigest,
      },
      global: {
        mocks: {
          $q: { dark: { isActive: false } },
        },
      },
    })
  }

  it('renders "You" for outbound messages without accessing $wallet', () => {
    const wrapper = mountReply('digest-outbound')
    expect(wrapper.text()).toContain('You')
    expect(wrapper.classes()).toContain('message-color-sent')
  })

  it('renders contact name for inbound messages', () => {
    const wrapper = mountReply('digest-inbound')
    expect(wrapper.text()).toContain('Alice')
    expect(wrapper.classes()).toContain('message-color')
  })

  it('renders "Not Found" for unknown contacts without throwing', () => {
    const wrapper = mountReply('digest-unknown')
    expect(wrapper.text()).toContain('Not Found')
  })
})

describe('ChatMessageReply quoting a message with pictures', () => {
  it('names a referenced picture and fetches nothing the quoted text asks for', () => {
    mockMessageStore['digest-pictures'] = {
      outbound: false,
      senderAddress: '0xAlice',
      items: [
        {
          type: 'text',
          text: 'see ![cat](attachment:1) <img src="https://evil.example/t.png">',
        },
        { type: 'image', image: 'data:image/png;base64,AAAA' },
      ],
    }
    const wrapper = shallowMount(ChatMessageReply, {
      props: { payloadDigest: 'digest-pictures' },
      global: {
        stubs: { ChatMessageText: false },
        mocks: { $q: { dark: { isActive: false } } },
      },
    })
    const quoted = wrapper.get('.chat-message-text')
    expect(quoted.text()).toBe('see cat')
    expect(quoted.findAll('img')).toHaveLength(0)
  })
})
