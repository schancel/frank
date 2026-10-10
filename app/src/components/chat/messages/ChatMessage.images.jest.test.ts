/** @jest-environment jsdom */

/**
 * A message's pictures in its bubble: the text shows each one where it refers to it
 * (`![name](attachment:N)`, the Nth image item of the same message), the rest follow the text,
 * and nothing in a message makes the browser fetch anything. The real ChatMessage,
 * ChatMessageText and ChatMessageImage render; the store and the other item renderers are not
 * the subject.
 */
import { shallowMount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

import ChatMessage from './ChatMessage.vue'
import { gif, png } from '../../../utils/image-data-uri.fixtures'
import type { MessageItem } from '@frank/cashweb/types/messages'

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

const first = png(2, 2)
const second = gif(3, 3)
const third = png(4, 4)
const refused = png(9000, 9000)

// Quasar's image as a plain <img>, marked so a picture shown after the text can be told from
// one shown inside it.
const QImg = defineComponent({
  props: ['src'],
  setup: props => () => h('img', { 'src': props.src, 'data-after-text': '' }),
})

function bubble(items: MessageItem[]) {
  const wrapper = shallowMount(ChatMessage, {
    props: {
      address: '0xPEER',
      name: 'peer',
      chatWidth: 500,
      payloadDigest: 'digest',
      message: {
        outbound: false,
        status: 'confirmed',
        receivedTime: 1,
        serverTime: 1,
        items,
        outpoints: [],
        senderAddress: '0xPEER',
        stampValueWei: 5n,
      } as never,
    },
    global: {
      stubs: {
        QChatMessage: { template: '<div><slot /></div>' },
        ChatMessageText: false,
        ChatMessageImage: false,
        QImg,
        QDialog: { template: '<i />' },
      },
      mocks: {
        $t: (key: string) => key,
        $q: { dark: { isActive: false } },
      },
    },
  })
  const body = wrapper.get('[data-testid="chat-message-body"]')
  const images = body.findAll('img').map(img => ({
    src: img.attributes('src'),
    inText: img.element.closest('.chat-message-text') !== null,
  }))
  return { wrapper, body, images }
}

describe('pictures in a received message', () => {
  it('two referenced pictures show inside the text, in the order the text has them, and only once', () => {
    const { body, images } = bubble([
      {
        type: 'text',
        text: 'first ![b](attachment:2) then ![a](attachment:1) done',
      },
      { type: 'image', image: first },
      { type: 'image', image: second },
    ])
    expect(images).toEqual([
      { src: second, inText: true },
      { src: first, inText: true },
    ])
    const html = body.html()
    expect(html.indexOf('first')).toBeLessThan(html.indexOf(second))
    expect(html.indexOf(second)).toBeLessThan(html.indexOf('then'))
    expect(html.indexOf('then')).toBeLessThan(html.indexOf(first))
    expect(html.indexOf(first)).toBeLessThan(html.indexOf('done'))
  })

  it('a picture the text does not refer to shows after the text', () => {
    const { images } = bubble([
      { type: 'text', text: 'see ![a](attachment:1)' },
      { type: 'image', image: first },
      { type: 'image', image: third },
    ])
    expect(images).toEqual([
      { src: first, inText: true },
      { src: third, inText: false },
    ])
  })

  it('a message of pictures alone shows them', () => {
    const { images } = bubble([
      { type: 'image', image: first },
      { type: 'image', image: second },
    ])
    expect(images).toEqual([
      { src: first, inText: false },
      { src: second, inText: false },
    ])
  })

  it('a reference to a picture that is not there stays the text it was', () => {
    const { body, images } = bubble([
      { type: 'text', text: 'see ![a](attachment:2) and ![b](attachment:0)' },
      { type: 'image', image: first },
    ])
    expect(body.text()).toContain(
      'see ![a](attachment:2) and ![b](attachment:0)',
    )
    expect(images).toEqual([{ src: first, inText: false }])
  })

  it('a reference to a refused picture stays text, and the picture is reported, not decoded', () => {
    const { body, images } = bubble([
      { type: 'text', text: 'see ![a](attachment:1)' },
      { type: 'image', image: refused },
    ])
    expect(body.text()).toContain('see ![a](attachment:1)')
    expect(body.text()).toContain('chatImage.notShown')
    expect(images).toEqual([])
  })

  it('a reference reaches only the pictures of its own message', () => {
    const { images } = bubble([{ type: 'text', text: '![a](attachment:1)' }])
    expect(images).toEqual([])
  })

  it.each([
    'look ![cat](https://evil.example/t.png)',
    '<img src="https://evil.example/t.png">',
    '<div style="background:url(https://evil.example/t.png)">x</div>',
    `![x](${third})`,
  ])(
    'content that names another picture fetches and shows nothing: %s',
    text => {
      const { images } = bubble([
        { type: 'text', text: `${text}\n\n![a](attachment:1)` },
        { type: 'image', image: first },
      ])
      expect(images).toEqual([{ src: first, inText: true }])
    },
  )

  it('a click on a picture in the text opens it', async () => {
    const { wrapper, body } = bubble([
      { type: 'text', text: '![a](attachment:1)' },
      { type: 'image', image: first },
    ])
    await body.get('.chat-message-text img').trigger('click')
    const vm = wrapper.vm as unknown as {
      imageDialog: boolean
      openedImage: string
    }
    expect(vm.imageDialog).toBe(true)
    expect(vm.openedImage).toBe(first)
  })
})
