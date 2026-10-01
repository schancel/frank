/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'

const balance = {
  formattedBalance: ref('1 MON'),
  loaded: ref(true),
  hasError: ref(false),
}
const openPage = jest.fn()
const mockCopyToClipboard = jest.fn()
const mockUseActiveWallet = jest.fn()

jest.mock('src/composables/useBalance', () => ({
  useBalance: () => balance,
}))
// The real vue-router CJS entry pulls in the ESM-only `nostics` package, which Jest's CommonJS
// setup cannot parse (see router/index.jest.test.ts's own boundary comment); Wallet.vue only
// needs the composable to exist.
jest.mock('vue-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}))
jest.mock('src/utils/routes', () => ({
  openPage: (...args: unknown[]) => openPage(...args),
}))
jest.mock('quasar', () => ({ copyToClipboard: mockCopyToClipboard }))
jest.mock('src/utils/notifications', () => ({
  addressCopiedNotify: jest.fn(),
  errorNotify: jest.fn(),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: (...args: unknown[]) => mockUseActiveWallet(...args),
}))

import Wallet from './Wallet.vue'
import { addressCopiedNotify } from 'src/utils/notifications'

const mockWallet = { identity: { displayAddress: '0xabc' } }

async function flush() {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve()
  }
  await nextTick()
}

function mountWallet() {
  return shallowMount(Wallet, {
    global: {
      mocks: {
        $t: (key: string, params?: { balance?: string }) =>
          params?.balance ? `${key}:${params.balance}` : key,
      },
      stubs: {
        // The copy button lives in q-input's named #after slot; a generic stub drops it.
        QInput: { template: '<div><slot /><slot name="after" /></div>' },
        QBtn: { template: '<button><slot /></button>' },
        ...Object.fromEntries(
          [
            'q-page-container',
            'q-page',
            'q-card',
            'q-card-section',
            'q-card-actions',
            'q-separator',
          ].map(n => [n, { template: '<div><slot /></div>' }]),
        ),
      },
    },
  })
}

describe('Wallet detail page (#570)', () => {
  beforeEach(() => {
    balance.formattedBalance.value = '1 MON'
    balance.loaded.value = true
    balance.hasError.value = false
    openPage.mockReset()
    mockCopyToClipboard.mockReset()
    mockCopyToClipboard.mockResolvedValue(undefined)
    mockUseActiveWallet.mockReset()
    mockUseActiveWallet.mockResolvedValue(mockWallet)
  })

  it('shows the wallet, its chain, balance and address', async () => {
    const wrapper = mountWallet()
    await flush()
    expect(wrapper.get('[data-testid="wallet-name"]').text()).toBe(
      'walletPanel.mainWallet',
    )
    expect(wrapper.get('[data-testid="wallet-chain"]').text()).toBe(
      'walletPanel.monad',
    )
    const region = wrapper.get('[data-testid="wallet-balance"]')
    expect(region.text()).toBe('1 MON')
    expect(region.attributes()).toMatchObject({
      'role': 'status',
      'aria-live': 'polite',
    })
    expect(
      (wrapper.vm as unknown as { displayAddress: string }).displayAddress,
    ).toBe('0xabc')
    wrapper.unmount()
  })

  it('shows a dash, not 0, until the balance loads, and an inline error on failure', async () => {
    balance.loaded.value = false
    balance.hasError.value = false
    const wrapper = mountWallet()
    await nextTick()
    const region = wrapper.get('[data-testid="wallet-balance"]')
    expect(region.text()).toBe('\u2014')
    balance.loaded.value = true
    await nextTick()
    expect(region.text()).toBe('1 MON') // a real zero or value is shown as such
    balance.hasError.value = true
    await nextTick()
    expect(region.text()).toBe('1 MON') // the last known value stays visible
    expect(wrapper.get('[data-testid="wallet-balance-error"]').text()).toBe(
      'walletPanel.balanceUnavailable',
    )
    wrapper.unmount()
  })

  it('copies the address and keeps Send/Receive reachable', async () => {
    const wrapper = mountWallet()
    await flush()

    await wrapper.get('[data-testid="wallet-copy-address"]').trigger('click')
    await flush()
    expect(mockCopyToClipboard).toHaveBeenCalledWith('0xabc')
    expect(addressCopiedNotify).toHaveBeenCalledTimes(1)

    await wrapper.get('[data-testid="wallet-send-action"]').trigger('click')
    await wrapper.get('[data-testid="wallet-receive-action"]').trigger('click')
    expect(openPage).toHaveBeenNthCalledWith(1, expect.anything(), '/send')
    expect(openPage).toHaveBeenNthCalledWith(2, expect.anything(), '/receive')
    wrapper.unmount()
  })

  it('does not copy an address that never loaded', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    mockUseActiveWallet.mockRejectedValueOnce(new Error('no wallet'))
    const wrapper = mountWallet()
    await flush()

    await wrapper.get('[data-testid="wallet-copy-address"]').trigger('click')
    await flush()
    expect(mockCopyToClipboard).not.toHaveBeenCalled()
    wrapper.unmount()
    spy.mockRestore()
  })
})
