/**
 * @jest-environment jsdom
 */
import { shallowMount } from '@vue/test-utils'
import DeleteMessageDialog from './DeleteMessageDialog.vue'
import { notifyDeleteFailure } from 'src/utils/sweep-on-delete'

const mockDeleteMessage = jest.fn()
const mockMessages: Record<string, unknown> = {
  '0xmsg1': {
    outbound: false,
    payloadDigest: '0xmsg1',
    delivery: { attemptDigest: '0xattempt1' },
  },
}

jest.mock('src/stores/chats', () => ({
  useChatStore: () => ({
    deleteMessage: mockDeleteMessage,
    messages: mockMessages,
  }),
}))
jest.mock('src/utils/sweep-on-delete', () => ({
  notifyDeleteFailure: jest.fn(),
}))

const mountDialog = (payloadDigest = '0xmsg1') =>
  shallowMount(DeleteMessageDialog, {
    props: { address: '0xcontact1', payloadDigest, index: 0 },
    global: { mocks: { $t: (key: string) => key } },
  })

describe('DeleteMessageDialog.vue', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockDeleteMessage.mockResolvedValue(undefined)
  })

  it('deletes through the store, which is what sweeps the message money first', async () => {
    const wrapper = mountDialog()
    await (
      wrapper.vm as unknown as { deleteMessageBoth(): Promise<void> }
    ).deleteMessageBoth()
    expect(mockDeleteMessage).toHaveBeenCalledTimes(1)
    expect(mockDeleteMessage).toHaveBeenCalledWith({
      address: '0xcontact1',
      payloadDigest: '0xmsg1',
      attemptDigest: '0xattempt1',
    })
    expect(notifyDeleteFailure).not.toHaveBeenCalled()
  })

  it('shows why when the store kept the message because its money could not be moved', async () => {
    const refusal = new Error('The message was not deleted: node unreachable')
    mockDeleteMessage.mockRejectedValueOnce(refusal)
    const wrapper = mountDialog()
    await (
      wrapper.vm as unknown as { deleteMessageBoth(): Promise<void> }
    ).deleteMessageBoth()
    expect(notifyDeleteFailure).toHaveBeenCalledWith(refusal)
  })
})
