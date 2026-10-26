/** @jest-environment jsdom */

/**
 * A group message's bubble shows what this device's write paid its hosting relay, in the unit of
 * the network that payment names, and no amount at all when there is no such payment: never a
 * zero in some default network's unit (it read "0.00 XPI" on Monad groups).
 */
import { shallowMount } from '@vue/test-utils'
import type { Message } from '@frank/cashweb/types/messages'

import ChatMessage from './ChatMessage.vue'

jest.mock('../../../stores/chats', () => ({
  useChatStore: () => ({
    deleteMessage: jest.fn(async () => undefined),
    getStampAmount: () => 0,
    sendMessage: jest.fn(),
    retryOutgoing: jest.fn(),
  }),
}))
jest.mock('../../dialogs/DeleteMessageDialog.vue', () => ({
  template: '<i />',
}))
jest.mock('../../dialogs/TransactionDialog.vue', () => ({ template: '<i />' }))
jest.mock('../../../utils/clients', () => ({
  useMonadWallet: () => ({
    getMessagePayment: () => undefined,
    refreshReceivedPayments: async () => [],
  }),
}))
jest.mock('../../../composables/useActiveWallet', () => ({
  useActiveWallet: () => ({}),
}))
jest.mock('../../../utils/notifications', () => ({ errorNotify: jest.fn() }))
// The selected network is deliberately not the group payment's: the bubble must not use it.
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    chainIdentifier: 'xpi-mainnet',
    toDisplayAmount: () => '0',
    unit: 'XPI',
  },
}))
jest.mock('../../../utils/message-items', () => ({
  messageItems: { previewText: () => '' },
}))
jest.mock('../../../utils/message-item-renderers', () => ({
  getMessageItemRenderer: () => undefined,
  messageSystemLine: () => undefined,
}))

function mountGroupMessage(extra: Partial<Message>) {
  return shallowMount(ChatMessage, {
    props: {
      address: 'group:' + 'a'.repeat(64),
      name: 'First Group',
      chatWidth: 500,
      payloadDigest: 'ab'.repeat(32),
      message: {
        outbound: true,
        status: 'confirmed',
        receivedTime: 1,
        serverTime: 1,
        items: [{ type: 'text', text: 'hi' }],
        outpoints: [],
        senderAddress: '0xME',
        ...extra,
      } as Message,
    },
    global: { mocks: { $t: (key: string) => key } },
  })
}
const shown = (wrapper: ReturnType<typeof mountGroupMessage>) =>
  wrapper.vm as unknown as { stampAmount: string; stampAmountExact: string }

const payment = {
  network: 'monad-testnet',
  destination: '0x' + '1'.repeat(40),
  amountWei: '1500000000000000',
  calldata: '',
  operationId: 'op',
}

it('shows no amount for a group message that carries no payment', () => {
  const vm = shown(mountGroupMessage({ outbound: false }))
  expect(vm.stampAmount).toBe('')
  expect(vm.stampAmountExact).toBe('')
})

it("shows its own write's payment in the unit of the network it names", () => {
  const vm = shown(mountGroupMessage({ groupWritePayment: payment }))
  expect(vm.stampAmount).toBe('0.0015 MONT')
  expect(vm.stampAmountExact).toBe('0.0015 MONT')
})

it('shows no amount once the payment was released (nothing was paid)', () => {
  const vm = shown(
    mountGroupMessage({ groupWritePayment: { ...payment, released: true } }),
  )
  expect(vm.stampAmount).toBe('')
})

it('shows no amount for a payment on a network unknown here, never a guessed unit', () => {
  const vm = shown(
    mountGroupMessage({
      groupWritePayment: { ...payment, network: 'not-a-network' },
    }),
  )
  expect(vm.stampAmount).toBe('')
})
