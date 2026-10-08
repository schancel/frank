/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import ChatMessageMenu from './ChatMessageMenu.vue'
import * as Quasar from 'quasar'

jest.mock('quasar', () => {
  const actual = jest.requireActual('quasar')
  return {
    ...actual,
    copyToClipboard: jest.fn().mockResolvedValue(undefined),
  }
})

jest.mock('src/utils/notifications', () => ({
  infoNotify: jest.fn(),
}))

describe('ChatMessageMenu.vue', () => {
  const defaultProps = {
    address: '0x1234567890123456789012345678901234567890',
    payloadDigest: 'digest-abc',
    index: 0,
    message: {
      status: 'confirmed',
      outbound: false,
      items: [{ type: 'text', text: 'Hello World' }],
      stampPayments: [{ amount: 100 }],
      outpoints: [],
    } as any,
  }

  const mountMenu = (props = {}) => {
    return shallowMount(ChatMessageMenu, {
      props: {
        ...defaultProps,
        ...props,
      },
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    })
  }

  it('computes canReply, canForward, canCopy, and hasStamp correctly for confirmed message with text and stamp', () => {
    const wrapper = mountMenu()
    const vm = wrapper.vm as any

    expect(vm.canReply).toBe(true)
    expect(vm.canForward).toBe(true)
    expect(vm.canCopy).toBe(true)
    expect(vm.hasStamp).toBe(true)
    expect(vm.isError).toBe(false)
  })

  it('computes isError correctly for outbound error message', () => {
    const wrapper = mountMenu({
      message: {
        status: 'error',
        outbound: true,
        items: [{ type: 'text', text: 'Failed message' }],
      },
    })
    const vm = wrapper.vm as any

    expect(vm.isError).toBe(true)
    expect(vm.canReply).toBe(false)
    expect(vm.canForward).toBe(false)
  })

  it('copies message text to clipboard when copyMessage is called', async () => {
    const wrapper = mountMenu()
    const vm = wrapper.vm as any

    await vm.copyMessage()
    expect(Quasar.copyToClipboard).toHaveBeenCalledWith('Hello World')
  })

  it('copies stealth memo if no text item exists', async () => {
    const wrapper = mountMenu({
      message: {
        status: 'confirmed',
        items: [{ type: 'stealth', memo: 'Payment Memo' }],
      },
    })
    const vm = wrapper.vm as any

    await vm.copyMessage()
    expect(Quasar.copyToClipboard).toHaveBeenCalledWith('Payment Memo')
  })

  it('falls back to payloadDigest if items have no text or memo', async () => {
    const wrapper = mountMenu({
      message: {
        status: 'confirmed',
        items: [],
      },
      payloadDigest: 'digest-xyz',
    })
    const vm = wrapper.vm as any

    await vm.copyMessage()
    expect(Quasar.copyToClipboard).toHaveBeenCalledWith('digest-xyz')
  })
})
