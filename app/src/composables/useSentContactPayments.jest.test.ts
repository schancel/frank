/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { useSentContactPayments } from './useSentContactPayments'
import { accountStatus } from 'src/accounts/session'
import { useActiveWallet } from './useActiveWallet'

jest.mock('src/accounts/session', () => ({
  accountStatus: jest.requireActual('vue').reactive({ revision: 0 }),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: { chainIdentifier: 'monad-testnet' },
}))
jest.mock('./useActiveWallet', () => ({ useActiveWallet: jest.fn() }))

it('reads the existing owner snapshot without recovery effects and rejects a wallet returned after a session switch', async () => {
  let release!: (wallet: unknown) => void
  jest.mocked(useActiveWallet).mockImplementation(
    () =>
      new Promise(resolve => {
        release = resolve
      }) as never,
  )
  const wrapper = mount(
    defineComponent({
      setup: () => useSentContactPayments(() => true),
      template: '<div />',
    }),
  )
  accountStatus.revision++
  const read = jest.fn(() => [{ state: 'paid' }])
  release({ chainIdentifier: 'monad-testnet', getContactPayments: read })
  await flushPromises()
  expect(read).not.toHaveBeenCalled()
  expect(wrapper.vm.sentContactPayments).toEqual([])
  wrapper.unmount()
})
