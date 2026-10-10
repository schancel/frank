/**
 * @jest-environment jsdom
 */
import { shallowMount } from '@vue/test-utils'
import DeleteMessageDialog from './DeleteMessageDialog.vue'

const mockDeleteMessage = jest.fn().mockResolvedValue(undefined)
const mockSweepMessageFundsOnDelete = jest.fn().mockResolvedValue({
  sweptCount: 1,
  sweptWei: 1000n,
  txHashes: ['0xtx1'],
})

const mockMessages: Record<string, any> = {
  '0xmsg1': {
    outbound: false,
    payloadDigest: '0xmsg1',
    stampPayments: [
      {
        txHash: '0xtx1',
        destinationAddress: '0xchild1',
        valueWei: 1000n,
      },
    ],
  },
}

jest.mock('src/stores/chats', () => ({
  useChatStore: () => ({
    deleteMessage: mockDeleteMessage,
    messages: mockMessages,
  }),
}))

jest.mock('src/utils/sweep-on-delete', () => ({
  sweepMessageFundsOnDelete: (args: any) => mockSweepMessageFundsOnDelete(args),
}))

describe('DeleteMessageDialog.vue', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  const mountDialog = () =>
    shallowMount(DeleteMessageDialog, {
      props: { address: '0xcontact1', payloadDigest: '0xmsg1', index: 0 },
      global: { mocks: { $t: (key: string) => key } },
    })

  it('sweeps the message funds, then deletes locally', async () => {
    const callOrder: string[] = []
    mockSweepMessageFundsOnDelete.mockImplementationOnce(async () => {
      callOrder.push('sweep')
      return { sweptCount: 1, sweptWei: 1000n, txHashes: ['0xtx1'] }
    })
    mockDeleteMessage.mockImplementationOnce(async () => {
      callOrder.push('localDelete')
    })

    await (mountDialog().vm as any).deleteMessageBoth()

    expect(callOrder).toEqual(['sweep', 'localDelete'])
    expect(mockSweepMessageFundsOnDelete).toHaveBeenCalledWith({
      message: mockMessages['0xmsg1'],
    })
    expect(mockDeleteMessage).toHaveBeenCalledWith({
      address: '0xcontact1',
      payloadDigest: '0xmsg1',
    })
  })

  it('still deletes locally when the sweep fails', async () => {
    mockSweepMessageFundsOnDelete.mockRejectedValueOnce(new Error('rpc down'))
    const logged = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    await (mountDialog().vm as any).deleteMessageBoth()

    expect(mockDeleteMessage).toHaveBeenCalledWith({
      address: '0xcontact1',
      payloadDigest: '0xmsg1',
    })
    logged.mockRestore()
  })
})
