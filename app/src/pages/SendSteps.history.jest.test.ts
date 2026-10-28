/** @jest-environment jsdom */
/**
 * Finding 12: a send's Review is a step of its own in history, on a real router (hash mode, as
 * the app ships). Back from Review returns to the form, filled in; Forward reviews it again. A
 * send that went out leaves no step of its form for Back or Forward: Back lands where the form
 * was opened from and Forward shows a fresh form. A Review reached by its address alone (a
 * reload) shows the form, never a review of nothing.
 */
import { defineComponent, h } from 'vue'
import { RouterView, type Router } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { getAddress } from 'ethers'

import Send from './Send.vue'
import SendContact from './SendContact.vue'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { useContactStore } from 'src/stores/contacts'
import { errorNotify } from 'src/utils/notifications'
import { resetNavigationForTests } from '../utils/navigation'
import enUS from '../i18n/en-us'
import {
  afterNavigation,
  flushHistory,
  historyPosition,
  openApp,
  userBack,
  userForward,
} from '../../test/jest/navigation-harness'

jest.mock(
  require.resolve('@vue/devtools-api', {
    paths: [require.resolve('vue-router')],
  }),
  () => ({ setupDevtoolsPlugin: () => undefined }),
)
jest.mock('nostics', () => ({
  createConsoleReporter: () => ({}),
  defineDiagnostics: () => new Proxy({}, { get: () => () => undefined }),
}))

const mockSend = jest.fn()
const mockCaptureWallet = jest.fn()
const mockPrepare = jest.fn()
const mockSendMessage = jest.fn()
const mockEstimate = jest.fn()

jest.mock('@frank/wallet/chain', () => {
  const chainWallet = jest.requireActual('@frank/wallet/chain/chain-wallet')
  const { getAddress: checksum } = jest.requireActual('ethers')
  return {
    onActiveChainChange: () => jest.fn(),
    isChainUnreachableError: () => false,
    ...jest.requireActual('@frank/wallet/chain/evm-native-operation-status'),
    NativeTransactionSubmissionError:
      chainWallet.NativeTransactionSubmissionError,
    NativeTransactionRefusedError: chainWallet.NativeTransactionRefusedError,
    NativeFeeExceededError: chainWallet.NativeFeeExceededError,
    ContactPaymentBelowFloorError: chainWallet.ContactPaymentBelowFloorError,
    ContactPaymentPendingError: chainWallet.ContactPaymentPendingError,
    MAX_STEALTH_ITEM_AMOUNT: 2n ** 64n - 1n,
    activeChain: {
      chainIdentifier: 'monad-testnet',
      name: 'monad',
      unit: 'MON',
      toDisplayAmount: (raw: bigint) => {
        const s = raw.toString().padStart(19, '0')
        return `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/\.?0+$/, '')
      },
      fromDisplayAmount: (display: string) => {
        const [whole, frac = ''] = display.split('.')
        return BigInt((whole || '0') + frac.padEnd(18, '0'))
      },
      formatAddress: (addr: { raw: string }) => checksum(addr.raw),
      parseAddress: (input: string) => {
        try {
          return { raw: checksum(input.trim()) }
        } catch {
          return undefined
        }
      },
      directMessages: { minimumStamp: async () => 0n },
      nativeTransfers: {
        send: (args: unknown) => mockSend(args),
        estimateLegacyFee: (args: unknown) => mockEstimate(args),
        getBalance: async () => 0n,
      },
    },
  }
})
jest.mock('src/accounts/session', () => ({ accountSession: {} }))
jest.mock('src/accounts/native-transfer', () => ({
  ...jest.requireActual('src/accounts/native-transfer'),
  createNativeTransferContext: jest.fn(async () => {
    const { activeChain } = jest.requireMock('@frank/wallet/chain')
    return { chain: { ...activeChain }, captureWallet: mockCaptureWallet }
  }),
}))
jest.mock('src/utils/notifications', () => ({
  sentTransactionNotify: jest.fn(),
  errorNotify: jest.fn(),
  infoNotify: jest.fn(),
}))
jest.mock('src/utils/clients', () => ({
  useMonadWallet: () => ({ identity: { displayAddress: '0xmessaging' } }),
}))
jest.mock('src/stores/chats', () => ({
  useChatStore: () => ({
    sendMessage: mockSendMessage,
    getStampWei: () => 0n,
  }),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))
jest.mock('src/composables/useBalance', () => ({
  useBalance: () => ({
    formattedBalance: { value: '10 MON' },
    formattedSpendable: { value: '10 MON' },
    exactSpendable: { value: '10 MON' },
    availableLoaded: { value: true },
    availableError: { value: false },
    availableSupported: { value: true },
    loaded: { value: true },
  }),
}))

const Blank = { render: () => null }
const RECIPIENT = '0x000000000000000000000000000000000000dEaD'
const CONTACT = '0x2222222222222222222222222222222222222222'

const stubs = {
  QHeader: { template: '<header><slot /></header>' },
  QToolbar: { template: '<div><slot /></div>' },
  QToolbarTitle: { template: '<div><slot /></div>' },
  QPageContainer: { template: '<div><slot /></div>' },
  QPage: { template: '<div><slot /></div>' },
  QCard: { template: '<div class="q-card"><slot /></div>' },
  QCardSection: { template: '<div><slot /></div>' },
  QCardActions: { template: '<div><slot /></div>' },
  QList: { template: '<div><slot /></div>' },
  QItem: { template: '<div @click="$emit(\'click\')"><slot /></div>' },
  QItemSection: { template: '<div><slot /></div>' },
  QItemLabel: { template: '<div><slot /></div>' },
  QAvatar: { template: '<div><slot /></div>' },
  QInput: {
    props: ['modelValue', 'disable'],
    emits: ['update:modelValue'],
    inheritAttrs: false,
    template:
      '<input v-bind="$attrs" :value="modelValue" :disabled="disable" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  QBtn: {
    props: ['label', 'disable', 'loading'],
    template:
      '<button :disabled="disable || loading" @click="$emit(\'click\')">{{ label }}<slot /></button>',
  },
  QBanner: { template: '<div><slot /></div>' },
  QIcon: { template: '<i />' },
  QSeparator: { template: '<hr />' },
  QSpinner: { template: '<i />' },
  QrScannerDialog: { template: '<div />' },
}

function t(key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], enUS)
  return typeof value === 'string' ? value : key
}

let router: Router
let destroy: () => void = () => undefined
let wrapper: VueWrapper | undefined

function mountApp() {
  wrapper = mount(defineComponent({ render: () => h(RouterView) }), {
    global: {
      plugins: [router],
      mocks: { $t: t },
      stubs,
    },
  })
  return wrapper
}

const ROUTES = [
  '/wallet',
  '/settings',
  { path: '/send', component: Send },
  { path: '/send-contact', component: SendContact },
]

beforeEach(() => {
  setActivePinia(createPinia())
  jest.clearAllMocks()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  destroy()
  resetNavigationForTests()
})

function entry() {
  return window.history.state as {
    back: string | null
    forward: string | null
    position: number
  }
}

function input(selector: string) {
  return wrapper!.get(selector).element as HTMLInputElement
}

describe('Send to Address: Review is a step', () => {
  const binding = {
    wallet: {
      family: 'evm',
      chainIdentifier: 'monad-testnet',
      getNativeOperations: () => [],
    },
    assertCurrent: jest.fn(async () => undefined),
    isCurrent: () => true,
  }

  async function fillAndReview() {
    await wrapper!.get('[data-test="send-address-input"]').setValue(RECIPIENT)
    await wrapper!.get('[data-test="send-amount-input"]').setValue('0.01')
    await wrapper!.get('[data-test="send-review-button"]').trigger('click')
    await flushPromises()
    await flushHistory()
  }

  beforeEach(() => {
    mockCaptureWallet.mockResolvedValue(binding)
    mockSend.mockResolvedValue({ txHash: '0xsent' })
    mockEstimate.mockResolvedValue(undefined)
  })

  it('Back from Review shows the form filled in; Forward reviews it again', async () => {
    ;({ router, destroy } = await openApp(ROUTES, '/wallet'))
    await router.push('/send')
    mountApp()
    await flushPromises()
    const form = historyPosition()

    await fillAndReview()
    expect(router.currentRoute.value.fullPath).toBe('/send?step=review')
    expect(historyPosition()).toBe(form + 1)
    expect(wrapper!.find('[data-test="send-review-card"]').exists()).toBe(true)

    await userBack(router)
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/send')
    expect(wrapper!.find('[data-test="send-edit-card"]').exists()).toBe(true)
    expect(input('[data-test="send-address-input"]').value).toBe(RECIPIENT)
    expect(input('[data-test="send-amount-input"]').value).toBe('0.01')

    await userForward(router)
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/send?step=review')
    expect(wrapper!.find('[data-test="send-review-card"]').exists()).toBe(true)
    // Reviewed again: a fresh quote, nothing sent.
    expect(mockCaptureWallet).toHaveBeenCalledTimes(2)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('an amount refused below the payment floor stays on the form: no step to go Back or Forward to', async () => {
    const { ContactPaymentBelowFloorError } = jest.requireMock(
      '@frank/wallet/chain',
    )
    mockEstimate.mockRejectedValue(
      new ContactPaymentBelowFloorError(10n ** 16n, 2n * 10n ** 16n),
    )
    ;({ router, destroy } = await openApp(ROUTES, '/wallet'))
    await router.push('/send')
    mountApp()
    await flushPromises()
    const form = historyPosition()
    const entries = window.history.length

    await fillAndReview()
    expect(router.currentRoute.value.fullPath).toBe('/send')
    expect(historyPosition()).toBe(form)
    expect(window.history.length).toBe(entries)
    expect(wrapper!.find('[data-test="send-below-floor"]').exists()).toBe(true)
    expect(wrapper!.find('[data-test="send-edit-card"]').exists()).toBe(true)
  })

  it('Back while a Forward re-quote is on its way stays on the form when the quote lands', async () => {
    ;({ router, destroy } = await openApp(ROUTES, '/wallet'))
    await router.push('/send')
    mountApp()
    await flushPromises()
    const form = historyPosition()
    await fillAndReview()
    await userBack(router)
    await flushPromises()

    let land!: (value: unknown) => void
    mockEstimate.mockReturnValueOnce(new Promise(resolve => (land = resolve)))
    await userForward(router)
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/send?step=review')
    await userBack(router)
    await flushPromises()
    land({ totalFee: 10n ** 15n })
    await flushPromises()
    await flushHistory()
    expect(router.currentRoute.value.fullPath).toBe('/send')
    expect(historyPosition()).toBe(form)
    expect(wrapper!.find('[data-test="send-edit-card"]').exists()).toBe(true)
  })

  it('the review Edit button is Back to the form', async () => {
    ;({ router, destroy } = await openApp(ROUTES, '/wallet'))
    await router.push('/send')
    mountApp()
    await flushPromises()
    const form = historyPosition()
    await fillAndReview()
    const done = afterNavigation(router)
    await wrapper!.get('[data-test="send-header-back"]').trigger('click')
    await done
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/send')
    expect(historyPosition()).toBe(form)
    expect(input('[data-test="send-amount-input"]').value).toBe('0.01')
  })

  it('a send that went out leaves no step behind: Back lands on the wallet, Forward shows a fresh form', async () => {
    ;({ router, destroy } = await openApp(ROUTES, '/wallet'))
    const walletPosition = historyPosition()
    await router.push('/send')
    mountApp()
    await flushPromises()
    await fillAndReview()
    await wrapper!.get('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()
    await flushHistory()
    expect(mockSend).toHaveBeenCalledTimes(1)
    // The outcome took the form's place, right above the wallet; nothing after it.
    expect(router.currentRoute.value.fullPath).toBe('/send')
    expect(historyPosition()).toBe(walletPosition + 1)
    expect((window.history.state as { forward: unknown }).forward).toBeNull()

    await userBack(router)
    expect(router.currentRoute.value.path).toBe('/wallet')
    await userForward(router)
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/send')
    expect(wrapper!.find('[data-test="send-edit-card"]').exists()).toBe(true)
    expect(input('[data-test="send-address-input"]').value).toBe('')
    expect((window.history.state as { forward: unknown }).forward).toBeNull()
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['the fee rose above the reviewed one', 'fee'],
    ['the network refused it', 'refused'],
  ])(
    'a send refused before anything was signed (%s) stays on Review, and Back still reaches the form',
    async (_why, kind) => {
      const chain = jest.requireMock('@frank/wallet/chain')
      mockSend.mockRejectedValueOnce(
        kind === 'fee'
          ? new chain.NativeFeeExceededError(10n ** 15n)
          : new chain.NativeTransactionRefusedError('nonce too low'),
      )
      ;({ router, destroy } = await openApp(ROUTES, '/wallet'))
      await router.push('/send')
      mountApp()
      await flushPromises()
      const form = historyPosition()
      await fillAndReview()
      await wrapper!.get('[data-test="review-confirm-button"]').trigger('click')
      await flushPromises()
      await flushHistory()
      expect(router.currentRoute.value.fullPath).toBe('/send?step=review')
      expect(historyPosition()).toBe(form + 1)
      expect(wrapper!.find('[data-test="send-review-card"]').exists()).toBe(
        true,
      )

      await userBack(router)
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/send')
      expect(historyPosition()).toBe(form)
      expect(input('[data-test="send-amount-input"]').value).toBe('0.01')
      expect(mockSend).toHaveBeenCalledTimes(1)
    },
  )

  it('a send signed and then refused by the network (its coins freed, nothing sent) stays on Review, and Back still reaches the form', async () => {
    const chain = jest.requireMock('@frank/wallet/chain')
    mockSend.mockImplementationOnce(
      async (params: { onSigned?: (s: { txHash: string }) => unknown }) => {
        await params.onSigned?.({ txHash: '0xsigned' })
        throw new chain.NativeTransactionRefusedError('nonce too low')
      },
    )
    ;({ router, destroy } = await openApp(ROUTES, '/wallet'))
    await router.push('/send')
    mountApp()
    await flushPromises()
    const form = historyPosition()
    await fillAndReview()
    await wrapper!.get('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()
    await flushHistory()
    expect(router.currentRoute.value.fullPath).toBe('/send?step=review')
    expect(historyPosition()).toBe(form + 1)
    expect(wrapper!.find('[data-test="send-review-card"]').exists()).toBe(true)

    await userBack(router)
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/send')
    expect(historyPosition()).toBe(form)
    expect(input('[data-test="send-amount-input"]').value).toBe('0.01')
  })

  it('a send opened first (nothing in the app under it) leaves no step to go Forward to; Back is the wallet', async () => {
    ;({ router, destroy } = await openApp(ROUTES, '/send'))
    mountApp()
    await flushPromises()
    await fillAndReview()
    expect(router.currentRoute.value.fullPath).toBe('/send?step=review')
    await wrapper!.get('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()
    await flushHistory()
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.fullPath).toBe('/send')
    expect((window.history.state as { forward: unknown }).forward).toBeNull()

    await userBack(router)
    expect(router.currentRoute.value.path).toBe('/wallet')
    await userForward(router)
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/send')
    expect((window.history.state as { forward: unknown }).forward).toBeNull()
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('a non-EVM send opened first ends on one wallet entry: Back leaves the app, nothing to go Forward to but a fresh form', async () => {
    mockCaptureWallet.mockResolvedValue({
      ...binding,
      wallet: { ...binding.wallet, family: 'bitcoin' },
    })
    ;({ router, destroy } = await openApp(ROUTES, '/send'))
    const first = historyPosition()
    mountApp()
    await flushPromises()
    await fillAndReview()
    const done = afterNavigation(router)
    await wrapper!.get('[data-test="review-confirm-button"]').trigger('click')
    await done
    await flushPromises()
    await flushHistory()
    expect(mockSend).toHaveBeenCalledTimes(1)
    // The wallet, once, on the app's first entry: Back from it leaves the app.
    expect(router.currentRoute.value.fullPath).toBe('/wallet')
    expect(historyPosition()).toBe(first)
    expect(entry().back).toBeNull()
    expect(entry().forward).toBe('/send')
    await userForward(router)
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/send')
    expect(input('[data-test="send-address-input"]').value).toBe('')
    expect(entry().back).toBe('/wallet')
    expect(entry().forward).toBeNull()
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['opened from the wallet', '/wallet'],
    ['opened first', '/send'],
  ])(
    'a send whose user went Back to the form while it was out (%s) leaves no Review to go Forward to',
    async (_how, opened) => {
      let finish!: (value: unknown) => void
      mockSend.mockReturnValueOnce(new Promise(resolve => (finish = resolve)))
      ;({ router, destroy } = await openApp(ROUTES, opened))
      if (opened !== '/send') await router.push('/send')
      mountApp()
      await flushPromises()
      const form = historyPosition()
      await fillAndReview()
      await wrapper!.get('[data-test="review-confirm-button"]').trigger('click')
      await flushPromises()
      await userBack(router)
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/send')
      expect(entry().forward).toBe('/send?step=review')
      finish({ txHash: '0xsent' })
      await flushPromises()
      await flushHistory()
      await flushPromises()
      expect(mockSend).toHaveBeenCalledTimes(1)
      expect(router.currentRoute.value.fullPath).toBe('/send')
      expect(entry().forward).toBeNull()
      expect(entry().back).toBe('/wallet')
      expect(historyPosition()).toBe(opened === '/send' ? form + 1 : form)
    },
  )

  it('a reload on Review shows the form in its place', async () => {
    ;({ router, destroy } = await openApp(ROUTES, '/wallet'))
    await router.push('/send?step=review')
    const position = historyPosition()
    mountApp()
    await flushPromises()
    await flushHistory()
    expect(router.currentRoute.value.fullPath).toBe('/send')
    expect(historyPosition()).toBe(position)
    expect(wrapper!.find('[data-test="send-edit-card"]').exists()).toBe(true)
    expect(mockCaptureWallet).not.toHaveBeenCalled()
  })
})

describe('Send to Contact: Review is a step', () => {
  const wallet = {
    chainIdentifier: 'monad-testnet',
    prepareContactPayment: (params: unknown) => mockPrepare(params),
    identity: { address: { raw: '0x1111' }, displayAddress: '0x1111' },
  }

  beforeEach(() => {
    ;(useActiveWallet as jest.Mock).mockResolvedValue(wallet)
    mockPrepare.mockResolvedValue({
      stampValue: 0n,
      item: { type: 'stealth' },
      txHash: '0xabc',
    })
    mockSendMessage.mockResolvedValue({ state: 'sent', payloadDigest: 'dd' })
    useContactStore().contacts = {
      [CONTACT]: {
        lastUpdateTime: Date.now(),
        notify: true,
        relayURL: null,
        profile: { name: 'Alice', signedName: 'Alice', bio: '', avatar: '' },
        inbox: {},
      },
    } as never
  })

  async function fillAndReview() {
    await wrapper!.get('[data-test="contact-item"]').trigger('click')
    await wrapper!
      .get('[data-test="send-contact-amount-input"]')
      .setValue('1.5')
    await wrapper!
      .get('[data-test="send-contact-review-button"]')
      .trigger('click')
    await flushPromises()
    await flushHistory()
  }

  it('Back from Review shows the form filled in; the payment leaves no step for Back or Forward', async () => {
    ;({ router, destroy } = await openApp(ROUTES, '/wallet'))
    const walletPosition = historyPosition()
    await router.push('/send-contact')
    mountApp()
    await flushPromises()
    await fillAndReview()
    expect(router.currentRoute.value.query.step).toBe('review')
    expect(historyPosition()).toBe(walletPosition + 2)

    await userBack(router)
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/send-contact')
    expect(wrapper!.find('[data-test="send-contact-edit-card"]').exists()).toBe(
      true,
    )
    expect(input('[data-test="send-contact-amount-input"]').value).toBe('1.5')

    await userForward(router)
    await flushPromises()
    expect(router.currentRoute.value.query.step).toBe('review')
    const done = afterNavigation(router)
    await wrapper!.get('[data-test="review-confirm-button"]').trigger('click')
    await done
    await flushPromises()
    expect(mockPrepare).toHaveBeenCalledTimes(1)
    // Done: back on the wallet in one step, past the form and its review.
    expect(router.currentRoute.value.path).toBe('/wallet')
    expect(historyPosition()).toBe(walletPosition)

    // Forward: a fresh form, never the payment again.
    await userForward(router)
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/send-contact')
    expect(wrapper!.find('[data-test="send-contact-edit-card"]').exists()).toBe(
      true,
    )
    expect(input('[data-test="send-contact-amount-input"]').value).toBe('')
    // The payment's form and review are gone: nothing further forward.
    expect((window.history.state as { forward: unknown }).forward).toBeNull()
    expect(mockPrepare).toHaveBeenCalledTimes(1)
  })

  it('a payment signed and held whose message then fails to send is never offered again: one payment, the form is left', async () => {
    ;({ router, destroy } = await openApp(ROUTES, '/wallet'))
    const walletPosition = historyPosition()
    await router.push('/send-contact')
    mountApp()
    await flushPromises()
    await fillAndReview()
    // The wallet signed and held the payment; the message's send then fails (its row may be
    // saved, its bytes may have reached a relay).
    mockSendMessage.mockRejectedValueOnce(new Error('relay unreachable'))
    const done = afterNavigation(router)
    await wrapper!.get('[data-test="review-confirm-button"]').trigger('click')
    await done
    await flushPromises()
    await flushHistory()
    expect(mockPrepare).toHaveBeenCalledTimes(1)
    // Told where that one payment is, never "nothing was sent".
    expect(errorNotify).toHaveBeenLastCalledWith(expect.any(Error), {
      safeMessage: enUS.sendContactDialog.heldAfterError,
    })
    // The form is left as after any other outcome: no Confirm to pay with again.
    expect(router.currentRoute.value.path).toBe('/wallet')
    expect(historyPosition()).toBe(walletPosition)
    expect(wrapper!.find('[data-test="review-confirm-button"]').exists()).toBe(
      false,
    )
    expect((window.history.state as { forward: unknown }).forward).toBe(
      '/send-contact',
    )
    expect(mockPrepare).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['sent', 'sent'],
    ['held: its message failed after the payment was signed', 'held'],
    ['held: the wallet saved it and could not finish preparing it', 'pending'],
  ])(
    'a payment opened first ends on one wallet entry (%s): Back leaves the app, no Confirm to pay again',
    async (_how, kind) => {
      const chain = jest.requireMock('@frank/wallet/chain')
      if (kind === 'held')
        mockSendMessage.mockRejectedValueOnce(new Error('relay unreachable'))
      if (kind === 'pending')
        mockPrepare.mockRejectedValueOnce(
          new chain.ContactPaymentPendingError('m1', '0xabc', new Error('x')),
        )
      ;({ router, destroy } = await openApp(ROUTES, '/send-contact'))
      const first = historyPosition()
      mountApp()
      await flushPromises()
      await fillAndReview()
      const done = afterNavigation(router)
      await wrapper!.get('[data-test="review-confirm-button"]').trigger('click')
      await done
      await flushPromises()
      await flushHistory()
      expect(mockPrepare).toHaveBeenCalledTimes(1)
      if (kind !== 'sent')
        expect(errorNotify).toHaveBeenLastCalledWith(expect.any(Error), {
          safeMessage: enUS.sendContactDialog.heldAfterError,
        })
      expect(router.currentRoute.value.fullPath).toBe('/wallet')
      expect(historyPosition()).toBe(first)
      expect(entry().back).toBeNull()
      expect(entry().forward).toBe('/send-contact')
      expect(
        wrapper!.find('[data-test="review-confirm-button"]').exists(),
      ).toBe(false)
    },
  )

  it('a payment the wallet released before its message went out is said as cancelled and unpaid, not as saved', async () => {
    // Finish under the wallet's payments in progress released it before the send began: the
    // message ends, and the wallet's own record says released.
    mockPrepare.mockResolvedValueOnce({
      stampValue: 0n,
      item: { type: 'stealth', ephemeralPubKey: '0x02AB' },
      txHash: '0xabc',
    })
    mockSendMessage.mockResolvedValueOnce({ state: 'failed', reason: 'error' })
    ;(useActiveWallet as jest.Mock).mockResolvedValue({
      ...wallet,
      getContactPayments: () => [
        { ephemeralPubKey: '02ab', state: 'released', holdsFunds: false },
      ],
    })
    ;({ router, destroy } = await openApp(ROUTES, '/wallet'))
    await router.push('/send-contact')
    mountApp()
    await flushPromises()
    await fillAndReview()
    const done = afterNavigation(router)
    await wrapper!.get('[data-test="review-confirm-button"]').trigger('click')
    await done
    await flushPromises()
    expect(errorNotify).toHaveBeenLastCalledWith(expect.any(Error), {
      safeMessage: enUS.sendContactDialog.released,
    })
    expect(enUS.sendContactDialog.released).toMatch(/Nothing was paid/)
    expect(mockPrepare).toHaveBeenCalledTimes(1)
  })

  it('a failed message whose payment the wallet still holds is told as saved, to retry', async () => {
    mockSendMessage.mockResolvedValueOnce({ state: 'failed', reason: 'error' })
    ;(useActiveWallet as jest.Mock).mockResolvedValue({
      ...wallet,
      getContactPayments: () => [
        { ephemeralPubKey: '02ab', state: 'prepared', holdsFunds: true },
      ],
    })
    mockPrepare.mockResolvedValueOnce({
      stampValue: 0n,
      item: { type: 'stealth', ephemeralPubKey: '02ab' },
      txHash: '0xabc',
    })
    ;({ router, destroy } = await openApp(ROUTES, '/wallet'))
    await router.push('/send-contact')
    mountApp()
    await flushPromises()
    await fillAndReview()
    const done = afterNavigation(router)
    await wrapper!.get('[data-test="review-confirm-button"]').trigger('click')
    await done
    await flushPromises()
    expect(errorNotify).toHaveBeenLastCalledWith(expect.any(Error), {
      fallbackKey: 'sendContactDialog.messageEnded',
    })
  })

  it('a payment finishing after the user went elsewhere does not pull them back', async () => {
    ;({ router, destroy } = await openApp(ROUTES, '/wallet'))
    await router.push('/send-contact')
    mountApp()
    await flushPromises()
    await fillAndReview()
    let deliver!: (value: unknown) => void
    mockSendMessage.mockReturnValueOnce(
      new Promise(resolve => (deliver = resolve)),
    )
    await wrapper!.get('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()
    await flushHistory()
    await router.push('/settings')
    await flushPromises()
    deliver({ state: 'sent', payloadDigest: 'dd' })
    await flushPromises()
    await flushHistory()
    expect(router.currentRoute.value.path).toBe('/settings')
  })
})
