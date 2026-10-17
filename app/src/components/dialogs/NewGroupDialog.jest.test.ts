/** @jest-environment jsdom */
import { flushPromises, shallowMount } from '@vue/test-utils'
import NewGroupDialog from './NewGroupDialog.vue'

const mockCreate = jest.fn()
const mockOpenChat = jest.fn()
const mockErrorNotify = jest.fn()
jest.mock('../../stores/chats', () => ({
  useChatStore: () => ({
    getGroupHomeRelay: () => 'https://relay.example',
    createGroupConversation: (...args: unknown[]) => mockCreate(...args),
  }),
}))
jest.mock('../../stores/contacts', () => ({
  useContactStore: () => ({ contacts: {} }),
}))
jest.mock('vue-router', () => ({ useRouter: () => ({}) }))
jest.mock('../../utils/routes', () => ({
  openChat: (...args: unknown[]) => mockOpenChat(...args),
}))
jest.mock('../../utils/notifications', () => ({
  errorNotify: (...args: unknown[]) => mockErrorNotify(...args),
}))
jest.mock('../../utils/chain-address', () => ({
  isChainAddress: () => false,
  toChainDisplayAddress: (address: string) => address,
}))
jest.mock('../../utils/own-address', () => ({
  sameCanonicalAddress: (a: string, b: string) => a === b,
}))
jest.mock('../../utils/short-address', () => ({
  shortAddress: (address: string) => address,
}))

beforeEach(() => jest.clearAllMocks())

it.each(['success', 'failure'])(
  'keeps a reopened draft isolated from pending creation %s',
  async outcome => {
    let resolve!: (value: { id: string }) => void
    let reject!: (error: Error) => void
    mockCreate.mockImplementationOnce(
      () =>
        new Promise((res, rej) => {
          resolve = res
          reject = rej
        }),
    )
    const wrapper = shallowMount(NewGroupDialog, {
      props: { modelValue: false },
      global: {
        mocks: { $t: (key: string) => key },
        stubs: Object.fromEntries(
          [
            'QDialog',
            'QCard',
            'QCardSection',
            'QBtn',
            'QInput',
            'QChip',
            'QList',
            'QItem',
            'QItemSection',
            'QCheckbox',
            'QItemLabel',
            'QCardActions',
          ].map(name => [name, true]),
        ),
        renderStubDefaultSlot: true,
      },
    })
    try {
      await wrapper.setProps({ modelValue: true })
      const vm = wrapper.vm
      vm.groupName = 'Original group'
      const pending = vm.submitCreateGroup()
      expect(mockCreate).toHaveBeenCalledTimes(1)
      vm.closeDialog()
      await wrapper.setProps({ modelValue: false })
      await wrapper.setProps({ modelValue: true })
      vm.groupName = 'New draft'
      expect(vm.creating).toBe(true)
      expect(
        wrapper.get('[data-test="create-group-submit"]').attributes('disable'),
      ).toBe('true')
      await vm.submitCreateGroup()
      expect(mockCreate).toHaveBeenCalledTimes(1)
      const closeCount = wrapper.emitted('update:modelValue')?.length
      if (outcome === 'success') resolve({ id: 'original-id' })
      else reject(new Error('Creation failed'))
      await pending
      await flushPromises()
      expect(vm.creating).toBe(false)
      expect(vm.groupName).toBe('New draft')
      expect(wrapper.emitted('update:modelValue')?.length).toBe(closeCount)
      expect(wrapper.emitted('created')).toBeUndefined()
      expect(mockOpenChat).not.toHaveBeenCalled()
      expect(mockErrorNotify).toHaveBeenCalledTimes(
        outcome === 'failure' ? 1 : 0,
      )

      mockCreate.mockResolvedValueOnce({ id: 'new-id' })
      await vm.submitCreateGroup()
      expect(mockCreate).toHaveBeenCalledTimes(2)
      expect(mockCreate.mock.calls[1][0].groupName).toBe('New draft')
      expect(wrapper.emitted('created')).toEqual([[{ id: 'new-id' }]])
      expect(mockOpenChat).toHaveBeenCalledTimes(1)
      expect(wrapper.emitted('update:modelValue')?.length).toBe(
        (closeCount ?? 0) + 1,
      )
    } finally {
      wrapper.unmount()
    }
  },
)
