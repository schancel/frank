/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import ChatMessageReply from './ChatMessageReply.vue'
import ChatMessageText from './ChatMessageText.vue'
import ChatMessageImage from './ChatMessageImage.vue'
import ChatMessageStealth from './ChatMessageStealth.vue'
import type {
  MessageItem,
  UnsupportedItem,
} from '@frank/cashweb/types/messages'

const mockMessageStore: Record<
  string,
  { outbound: boolean; senderAddress: string; items: MessageItem[] } | undefined
> = {
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

const mockContacts: Record<string, { profile: { name: string } } | undefined> =
  {
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

describe('ChatMessageReply discriminated preview projection', () => {
  function mountPreview(items: MessageItem[]) {
    for (const item of items) Object.freeze(item)
    Object.freeze(items)
    mockMessageStore['digest-projection'] = {
      outbound: false,
      senderAddress: '0xAlice',
      items,
    }
    return shallowMount(ChatMessageReply, {
      props: { payloadDigest: 'digest-projection' },
      global: { mocks: { $q: { dark: { isActive: false } } } },
    })
  }

  it('passes text, image and stated payment fields unchanged to their actual children', async () => {
    const wrapper = mountPreview([
      { type: 'text', text: 'caption' },
      { type: 'image', image: 'data:image/png;base64,AAAA' },
      {
        type: 'stealth',
        amount: 7,
        amountWei: '7000000000000000001',
        chainId: 'MONT',
        networkTag: 'monad-testnet',
        ephemeralPubKey: '02' + '12'.repeat(32),
        transactions: ['signed-transaction'],
        memo: 'sender memo',
      },
    ])
    expect(wrapper.getComponent(ChatMessageText).props()).toEqual(
      expect.objectContaining({ text: 'caption', isReply: true }),
    )
    expect(wrapper.getComponent(ChatMessageImage).props()).toEqual(
      expect.objectContaining({
        image: 'data:image/png;base64,AAAA',
        isReply: true,
      }),
    )
    expect(wrapper.getComponent(ChatMessageStealth).props()).toEqual(
      expect.objectContaining({
        amount: 7,
        amountWei: '7000000000000000001',
        chainId: 'MONT',
        networkTag: 'monad-testnet',
        ephemeralPubKey: '02' + '12'.repeat(32),
        transactions: ['signed-transaction'],
        memo: 'sender memo',
      }),
    )
    await wrapper.trigger('click')
    expect(wrapper.emitted('replyDivClick')).toEqual([['digest-projection']])
  })

  it('keeps the last item of each preview type, including zero and absent optional fields', () => {
    const wrapper = mountPreview([
      { type: 'text', text: 'first' },
      { type: 'text', text: '' },
      { type: 'image', image: 'first-image' },
      { type: 'image', image: '' },
      { type: 'stealth', amount: 99, amountWei: '99', memo: 'first memo' },
      { type: 'stealth', amount: 0 },
    ])
    expect(wrapper.getComponent(ChatMessageText).props('text')).toBe('')
    expect(wrapper.getComponent(ChatMessageImage).props('image')).toBe('')
    expect(wrapper.getComponent(ChatMessageStealth).props()).toEqual(
      expect.objectContaining({
        amount: 0,
        amountWei: undefined,
        memo: undefined,
      }),
    )
  })

  it('retains the image caption fallback when there is no text item', () => {
    const wrapper = mountPreview([{ type: 'image', image: 'image-data' }])
    expect(wrapper.getComponent(ChatMessageText).props('text')).toBe('Image')
    expect(wrapper.getComponent(ChatMessageImage).props('image')).toBe(
      'image-data',
    )
  })

  const reasons: UnsupportedItem['reason'][] = ['unknown-type', 'malformed']
  it.each(reasons)(
    'keeps unsupported %s and non-preview items inert',
    reason => {
      const wrapper = mountPreview([
        {
          type: 'unsupported',
          reason,
          itemType: 'future-message',
          frame: '00',
        },
        { type: 'reply', payloadDigest: 'earlier-message' },
        { type: 'p2pkh', address: 'unused-address', amount: 1 },
      ])
      expect(wrapper.findComponent(ChatMessageText).exists()).toBe(false)
      expect(wrapper.findComponent(ChatMessageImage).exists()).toBe(false)
      expect(wrapper.findComponent(ChatMessageStealth).exists()).toBe(false)
      expect(wrapper.text()).toBe('Alice')
    },
  )

  it('retains the missing-message label and null reply navigation', async () => {
    const wrapper = shallowMount(ChatMessageReply, {
      props: { payloadDigest: 'missing-reply' },
      global: { mocks: { $q: { dark: { isActive: false } } } },
    })
    expect(wrapper.text()).toBe('Message not found')
    expect(wrapper.findComponent(ChatMessageText).exists()).toBe(false)
    expect(wrapper.findComponent(ChatMessageImage).exists()).toBe(false)
    expect(wrapper.findComponent(ChatMessageStealth).exists()).toBe(false)
    await wrapper.trigger('click')
    expect(wrapper.emitted('replyDivClick')).toEqual([[null]])
  })
})
