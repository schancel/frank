/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { useSentContactPayments } from './useSentContactPayments'
import { accountStatus } from 'src/accounts/session'
import { setActiveChain } from '@frank/wallet/chain'
import { useActiveWallet } from './useActiveWallet'

jest.mock('src/accounts/session', () => ({
  accountStatus: jest.requireActual('vue').reactive({ revision: 0 }),
}))
jest.mock('@frank/wallet/chain', () => {
  const chain = { chainIdentifier: 'monad-testnet' }
  const listeners = new Set<(next: typeof chain) => void>()
  return {
    activeChain: chain,
    onActiveChainChange: (listener: (next: typeof chain) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setActiveChain: (next: typeof chain) => {
      Object.assign(chain, next)
      for (const listener of listeners) listener(chain)
    },
  }
})
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
  const releaseA = release
  accountStatus.revision++
  const read = jest.fn(() => [{ state: 'paid' }])
  releaseA({ chainIdentifier: 'monad-testnet', getContactPayments: read })
  await flushPromises()
  expect(read).not.toHaveBeenCalled()
  expect(wrapper.vm.sentContactPayments).toEqual([])
  wrapper.unmount()
})

it('clears a paid cache immediately on a chain-only switch and rejects an old A read after A to B to A', async () => {
  let releaseOld!: (wallet: unknown) => void
  const paid = { state: 'paid' }
  const currentWallet = {
    chainIdentifier: 'monad-testnet',
    getContactPayments: () => [paid],
  }
  jest.mocked(useActiveWallet).mockResolvedValue(currentWallet as never)
  const wrapper = mount(
    defineComponent({
      setup: () => useSentContactPayments(() => true),
      template: '<div />',
    }),
  )
  try {
    await flushPromises()
    expect(wrapper.vm.sentContactPayments).toEqual([paid])
    jest.mocked(useActiveWallet).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseOld = resolve
        }) as never,
    )
    // Both changes use the same account revision; the configured chain owner is authoritative.
    setActiveChain({ chainIdentifier: 'monad-testnet' } as never)
    setActiveChain({ chainIdentifier: 'solana-devnet' } as never)
    expect(wrapper.vm.sentContactPayments).toEqual([])
    setActiveChain({ chainIdentifier: 'monad-testnet' } as never)
    const staleRead = jest.fn(() => [{ state: 'failed' }])
    releaseOld({
      chainIdentifier: 'monad-testnet',
      getContactPayments: staleRead,
    })
    await flushPromises()
    expect(staleRead).not.toHaveBeenCalled()
    expect(wrapper.vm.sentContactPayments).toEqual([paid])
  } finally {
    wrapper.unmount()
  }
})
