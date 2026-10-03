/** @jest-environment jsdom */

import { enableAutoUnmount, shallowMount } from '@vue/test-utils'
enableAutoUnmount(afterEach)
import { nextTick, ref } from 'vue'
import { accountStatus } from '../accounts/session'

jest.mock('../accounts/session', () => ({
  accountStatus: jest
    .requireActual('vue')
    .reactive({ status: 'ready', revision: 1 }),
}))
const session = accountStatus as { status: string; revision: number }

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
import { addressCopiedNotify, errorNotify } from 'src/utils/notifications'

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
        QBtn: {
          props: ['disable'],
          template: '<button :disabled="disable"><slot /></button>',
        },
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
    session.status = 'ready'
    session.revision = 1
    balance.formattedBalance.value = '1 MON'
    balance.loaded.value = true
    balance.hasError.value = false
    openPage.mockReset()
    mockCopyToClipboard.mockReset()
    mockCopyToClipboard.mockResolvedValue(undefined)
    mockUseActiveWallet.mockReset()
    mockUseActiveWallet.mockResolvedValue(mockWallet)
    jest.mocked(addressCopiedNotify).mockClear()
    jest.mocked(errorNotify).mockClear()
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

    const copyButton = wrapper.get('[data-testid="wallet-copy-address"]')
    expect(copyButton.attributes('aria-label')).toBe('a11y.copyAddress')
    await copyButton.trigger('click')
    await flush()
    expect(mockCopyToClipboard).toHaveBeenCalledWith('0xabc')
    expect(addressCopiedNotify).toHaveBeenCalledTimes(1)

    await wrapper.get('[data-testid="wallet-send-action"]').trigger('click')
    await wrapper.get('[data-testid="wallet-receive-action"]').trigger('click')
    expect(openPage).toHaveBeenNthCalledWith(1, expect.anything(), '/send')
    expect(openPage).toHaveBeenNthCalledWith(2, expect.anything(), '/receive')
    wrapper.unmount()
  })

  it('reports a clipboard failure instead of claiming success', async () => {
    mockCopyToClipboard.mockRejectedValueOnce(new Error('denied'))
    const wrapper = mountWallet()
    await flush()

    await wrapper.get('[data-testid="wallet-copy-address"]').trigger('click')
    await flush()
    expect(mockCopyToClipboard).toHaveBeenCalledWith('0xabc')
    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      fallbackKey: 'walletPanel.unableCopyAddress',
    })
    expect(addressCopiedNotify).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('clears and replaces the mounted identity address on session replacement', async () => {
    const wrapper = mountWallet()
    await flush()
    session.status = 'loading'
    expect(wrapper.vm.displayAddress).toBe('')
    await flush()
    const copy = wrapper.get('[data-testid="wallet-copy-address"]')
    expect(copy.attributes('disabled')).toBeDefined()
    await copy.trigger('click')
    expect(mockCopyToClipboard).not.toHaveBeenCalled()
    mockUseActiveWallet.mockResolvedValue({
      identity: { displayAddress: '0xauthB' },
      getReceiveAddress: async () => ({ raw: '0xreceiveB' }),
    })
    session.revision++
    session.status = 'ready'
    await flush()
    expect(wrapper.vm.displayAddress).toBe('0xauthB')
    await copy.trigger('click')
    expect(mockCopyToClipboard).toHaveBeenCalledWith('0xauthB')
    expect(mockCopyToClipboard).not.toHaveBeenCalledWith('0xreceiveB')
    wrapper.unmount()
  })

  it('ignores delayed acquisition of account A after account B is displayed', async () => {
    let finish!: (wallet: typeof mockWallet) => void
    mockUseActiveWallet.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        }),
    )
    const wrapper = mountWallet()
    mockUseActiveWallet.mockResolvedValue({
      identity: { displayAddress: '0xauthB' },
    })
    session.revision++
    await flush()
    expect(wrapper.vm.displayAddress).toBe('0xauthB')
    finish(mockWallet)
    await flush()
    expect(wrapper.vm.displayAddress).toBe('0xauthB')
    wrapper.unmount()
  })

  it('clears the old identity through unavailable and failed replacement acquisition', async () => {
    const wrapper = mountWallet()
    await flush()
    session.status = 'unavailable'
    expect(wrapper.vm.displayAddress).toBe('')
    mockUseActiveWallet.mockRejectedValueOnce(new Error('locked'))
    session.status = 'ready'
    await flush()
    expect(wrapper.vm.displayAddress).toBe('')
    expect(
      wrapper.get('[data-testid="wallet-copy-address"]').attributes('disabled'),
    ).toBeDefined()
    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      fallbackKey: 'walletPanel.failedLoadAddress',
    })
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
    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      fallbackKey: 'walletPanel.failedLoadAddress',
    })
    wrapper.unmount()
    spy.mockRestore()
  })
})
