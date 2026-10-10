/** @jest-environment jsdom */

/**
 * ChatMessage's Retry / Discard wiring for outgoing messages (#269, #270). The store is mocked at
 * its action boundary; the rules those actions follow (same bytes when the earlier payment is
 * live, new payments only when it is dead) are proven in `stores/chats.outgoing.jest.test.ts`.
 */
import { shallowMount } from '@vue/test-utils'

import ChatMessage from './ChatMessage.vue'
import enUS from '../../../i18n/en-us'

const retryOutgoing = jest.fn()
const deleteMessage = jest.fn(async () => undefined)
jest.mock('../../../stores/chats', () => ({
  useChatStore: () => ({
    deleteMessage,
    getStampAmount: () => 0,
    sendMessage: jest.fn(),
    retryOutgoing,
  }),
}))
// The real dialogs pull in modules that open on-disk Level stores at import time.
jest.mock('../../dialogs/DeleteMessageDialog.vue', () => ({
  template: '<i />',
}))
jest.mock('../../dialogs/TransactionDialog.vue', () => ({ template: '<i />' }))
jest.mock('../../../utils/clients', () => ({
  useMonadWallet: () => ({ wallet: true }),
}))
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

const t = (key: string) =>
  key
    .split('.')
    .reduce<unknown>(
      (o, k) => (o as Record<string, unknown>)?.[k],
      enUS,
    ) as string

const focusStatus = jest.fn()

function mountFailed() {
  const dialogs: Array<{ message: string; onOk: () => void }> = []
  const wrapper = shallowMount(ChatMessage, {
    props: {
      address: '0xPEER',
      name: 'peer',
      chatWidth: 500,
      payloadDigest: 'pending:1:1:abc',
      message: {
        outbound: true,
        status: 'error',
        receivedTime: 1,
        serverTime: 1,
        items: [{ type: 'text', text: 'hi' }],
        outpoints: [],
        senderAddress: '0xME',
        stampValueWei: 5n,
        delivery: { failureReason: 'unverified' },
      },
    },
    global: {
      stubs: {
        QChatMessage: {
          template: '<div><slot /><slot name="stamp" /></div>',
        },
        ChatMessageSuffix: { template: '<i />', methods: { focusStatus } },
      },
      mocks: {
        $t: t,
        $q: {
          dialog: (options: { message: string }) => ({
            onOk: (cb: () => void) => {
              dialogs.push({ message: options.message, onOk: cb })
            },
          }),
        },
      },
    },
  })
  return { wrapper, dialogs }
}

describe('ChatMessage Retry and Discard', () => {
  beforeEach(() => jest.clearAllMocks())

  it('Retry goes to the store without deleting the message first', async () => {
    retryOutgoing.mockResolvedValue({ state: 'payment-pending' })
    const { wrapper } = mountFailed()
    await (wrapper.vm as unknown as { resend: () => Promise<void> }).resend()
    expect(retryOutgoing).toHaveBeenCalledWith(
      expect.objectContaining({
        address: '0xPEER',
        payloadDigest: 'pending:1:1:abc',
        confirmed: false,
      }),
    )
    expect(deleteMessage).not.toHaveBeenCalled()
  })

  it('Retry of a message with no recorded stamp also goes to the store and deletes nothing', async () => {
    retryOutgoing.mockResolvedValue({ state: 'busy' })
    const { wrapper } = mountFailed()
    const message = { ...wrapper.props('message') } as Record<string, unknown>
    delete message.stampValueWei
    await wrapper.setProps({ message: message as never })
    await (wrapper.vm as unknown as { resend: () => Promise<void> }).resend()
    expect(retryOutgoing).toHaveBeenCalledTimes(1)
    expect(deleteMessage).not.toHaveBeenCalled()
  })

  it('moves focus to the message status before the Retry button unmounts', async () => {
    let focusedBeforeRetry = false
    retryOutgoing.mockImplementation(async () => {
      focusedBeforeRetry = focusStatus.mock.calls.length > 0
      return { state: 'payment-pending' }
    })
    const { wrapper } = mountFailed()
    await (wrapper.vm as unknown as { resend: () => Promise<void> }).resend()
    expect(focusedBeforeRetry).toBe(true)
  })

  it('asks before a retry that could pay a second time, and retries only once confirmed', async () => {
    retryOutgoing.mockResolvedValueOnce({
      state: 'needs-confirmation',
      reason: 'unverified',
    })
    retryOutgoing.mockResolvedValueOnce({ state: 'sent', payloadDigest: 'x' })
    const { wrapper, dialogs } = mountFailed()
    await (wrapper.vm as unknown as { resend: () => Promise<void> }).resend()
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0].message).toMatch(/charge you a second time/)
    expect(retryOutgoing).toHaveBeenCalledTimes(1)

    dialogs[0].onOk()
    await Promise.resolve()
    expect(retryOutgoing).toHaveBeenCalledTimes(2)
    expect(retryOutgoing).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmed: true }),
    )
  })

  it('Discard confirms, then deletes the message durably', () => {
    const { wrapper, dialogs } = mountFailed()
    ;(wrapper.vm as unknown as { confirmDiscard: () => void }).confirmDiscard()
    expect(deleteMessage).not.toHaveBeenCalled()
    dialogs[0].onOk()
    expect(deleteMessage).toHaveBeenCalledWith({
      address: '0xPEER',
      payloadDigest: 'pending:1:1:abc',
    })
  })

  it('emits replyClicked when suffix emits replyClick', () => {
    const { wrapper } = mountFailed()
    const suffix = wrapper.findComponent({ ref: 'suffix' })
    suffix.vm.$emit('replyClick')
    expect(wrapper.emitted('replyClicked')).toEqual([
      [{ address: '0xPEER', payloadDigest: 'pending:1:1:abc' }],
    ])
  })

  it('emits forwardClicked when suffix emits forwardClick', () => {
    const { wrapper } = mountFailed()
    const suffix = wrapper.findComponent({ ref: 'suffix' })
    suffix.vm.$emit('forwardClick')
    expect(wrapper.emitted('forwardClicked')).toEqual([
      [{ address: '0xPEER', payloadDigest: 'pending:1:1:abc' }],
    ])
  })
})
