/**
 * @jest-environment jsdom
 */
import { shallowMount } from '@vue/test-utils'
import DeleteMessageDialog from './DeleteMessageDialog.vue'
import { errorNotify } from 'src/utils/notifications'

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
jest.mock('src/utils/notifications', () => ({
  errorNotify: jest.fn(),
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

  it('deletes through the store, and asks nothing else of anyone', async () => {
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
    expect(errorNotify).not.toHaveBeenCalled()
  })

  it('shows an error when the store could not delete the message', async () => {
    const refusal = new Error('the message store is closed')
    mockDeleteMessage.mockRejectedValueOnce(refusal)
    const wrapper = mountDialog()
    await (
      wrapper.vm as unknown as { deleteMessageBoth(): Promise<void> }
    ).deleteMessageBoth()
    expect(errorNotify).toHaveBeenCalledWith(refusal)
  })
})
