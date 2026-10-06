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

  it('sweeps message funds prior to relay delete and local delete', async () => {
    const mockRelayDelete = jest.fn().mockResolvedValue(undefined)
    const callOrder: string[] = []

    mockSweepMessageFundsOnDelete.mockImplementationOnce(async () => {
      callOrder.push('sweep')
      return { sweptCount: 1, sweptWei: 1000n, txHashes: ['0xtx1'] }
    })
    mockRelayDelete.mockImplementationOnce(async () => {
      callOrder.push('relayDelete')
    })
    mockDeleteMessage.mockImplementationOnce(async () => {
      callOrder.push('localDelete')
    })

    const wrapper = shallowMount(DeleteMessageDialog, {
      props: {
        address: '0xcontact1',
        payloadDigest: '0xmsg1',
        index: 0,
      },
      global: {
        mocks: {
          $t: (key: string) => key,
          $relayClient: {
            deleteMessage: mockRelayDelete,
          },
        },
      },
    })

    await (wrapper.vm as any).deleteMessageBoth()

    expect(callOrder).toEqual(['sweep', 'relayDelete', 'localDelete'])
    expect(mockSweepMessageFundsOnDelete).toHaveBeenCalledWith({
      message: mockMessages['0xmsg1'],
      relayClient: expect.any(Object),
    })
    expect(mockRelayDelete).toHaveBeenCalledWith('0xmsg1')
    expect(mockDeleteMessage).toHaveBeenCalledWith({
      address: '0xcontact1',
      payloadDigest: '0xmsg1',
    })
  })

  it('completes sweep and local delete when $relayClient is undefined (Monad mode)', async () => {
    const wrapper = shallowMount(DeleteMessageDialog, {
      props: {
        address: '0xcontact1',
        payloadDigest: '0xmsg1',
        index: 0,
      },
      global: {
        mocks: {
          $t: (key: string) => key,
          $relayClient: undefined,
        },
      },
    })

    await (wrapper.vm as any).deleteMessageBoth()

    expect(mockSweepMessageFundsOnDelete).toHaveBeenCalledWith({
      message: mockMessages['0xmsg1'],
      relayClient: undefined,
    })
    expect(mockDeleteMessage).toHaveBeenCalledWith({
      address: '0xcontact1',
      payloadDigest: '0xmsg1',
    })
  })

  it('completes local delete even if relay delete fails', async () => {
    const mockRelayDelete = jest.fn().mockRejectedValue(new Error('Relay 500'))

    const wrapper = shallowMount(DeleteMessageDialog, {
      props: {
        address: '0xcontact1',
        payloadDigest: '0xmsg1',
        index: 0,
      },
      global: {
        mocks: {
          $t: (key: string) => key,
          $relayClient: {
            deleteMessage: mockRelayDelete,
          },
        },
      },
    })

    await (wrapper.vm as any).deleteMessageBoth()

    expect(mockSweepMessageFundsOnDelete).toHaveBeenCalled()
    expect(mockRelayDelete).toHaveBeenCalledWith('0xmsg1')
    expect(mockDeleteMessage).toHaveBeenCalledWith({
      address: '0xcontact1',
      payloadDigest: '0xmsg1',
    })
  })
})
