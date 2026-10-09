/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Send from './Send.vue'
import {
  activeChain,
  NativeTransactionSubmissionError,
} from '@frank/wallet/chain'
import { createSolanaChain } from '@frank/wallet/chain/solana-chain'
import type { NativeAssetChain } from '@frank/wallet/chain'
import { sentTransactionNotify, errorNotify } from 'src/utils/notifications'
import { navigateBack } from 'src/utils/navigate-back'
import type { WalletHandle } from '@frank/wallet/chain'
import enUS from '../i18n/en-us'
import frFR from '../i18n/fr-fr'

import { getAddress } from 'ethers'
const mockSend = jest.fn()
const mockCaptureWallet = jest.fn()
const mockAssertCurrent = jest.fn()
const mockRoute = { query: {} as Record<string, string | string[] | null> }
let mockSelectedChain: NativeAssetChain | undefined
const mockGetBalance = jest.fn()
const mockGetTransactionStatus = jest.fn()

jest.mock('@frank/wallet/chain', () => ({
  NativeTransactionSubmissionError: jest.requireActual(
    '@frank/wallet/chain/chain-wallet',
  ).NativeTransactionSubmissionError,
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
      if (frac.length > 18) throw new Error('too many decimals')
      return BigInt((whole || '0') + frac.padEnd(18, '0'))
    },
    formatAddress: (addr: { raw: string }) => getAddress(addr.raw),
    parseAddress: (input: string) => {
      try {
        return { raw: getAddress(input.trim()) }
      } catch {
        return undefined
      }
    },
    nativeTransfers: {
      send: (args: unknown) => mockSend(args),
      getBalance: (args: unknown) => mockGetBalance(args),
      getTransactionStatus: (args: unknown) => mockGetTransactionStatus(args),
    },
  },
}))

jest.mock('src/accounts/native-transfer', () => ({
  createNativeTransferContext: jest.fn(async (id: string) => {
    const chain = mockSelectedChain ?? activeChain
    if (id !== chain.chainIdentifier)
      throw new Error('Unknown native Send network')
    return { chain: { ...chain }, captureWallet: mockCaptureWallet }
  }),
}))

jest.mock('src/utils/notifications', () => ({
  sentTransactionNotify: jest.fn(),
  errorNotify: jest.fn(),
}))

jest.mock('src/utils/navigate-back', () => ({
  navigateBack: jest.fn(),
}))

jest.mock('vue-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useRoute: () => mockRoute,
}))

function t(
  messages: unknown,
  key: string,
  params: Record<string, unknown> = {},
): string {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], messages)
  if (typeof value === 'string') {
    let res = value
    for (const [k, v] of Object.entries(params)) {
      res = res.replaceAll(`{${k}}`, String(v))
    }
    return res
  }
  return key
}

const mockWallet = {
  identity: {
    address: { raw: '0x1111111111111111111111111111111111111111' },
    displayAddress: '0x1111111111111111111111111111111111111111',
  },
} as unknown as WalletHandle

function mountSend(messages: unknown = enUS) {
  return mount(Send, {
    global: {
      mocks: {
        $t: (key: string, params?: Record<string, unknown>) =>
          t(messages, key, params ?? {}),
      },
      stubs: {
        QPageContainer: { template: '<div><slot /></div>' },
        QPage: { template: '<div><slot /></div>' },
        QCard: { template: '<div class="q-card"><slot /></div>' },
        QCardSection: {
          template: '<div class="q-card-section"><slot /></div>',
        },
        QCardActions: {
          template: '<div class="q-card-actions"><slot /></div>',
        },
        QInput: {
          props: ['modelValue', 'placeholder', 'disable'],
          emits: ['update:modelValue'],
          template:
            '<input :value="modelValue" :placeholder="placeholder" :disabled="disable" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        QBtn: {
          props: ['label', 'disable', 'loading'],
          template:
            '<button :disabled="disable || loading">{{ label }}<slot /></button>',
        },
        QBanner: {
          template:
            '<div class="q-banner" role="alert"><slot name="avatar" /><slot /></div>',
        },
        QIcon: {
          props: ['name'],
          template: '<i :data-icon="name">{{ name }}</i>',
        },
        QSeparator: { template: '<hr />' },
      },
    },
  })
}

describe('Send.vue review boundary and signing protection (#535)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    jest.clearAllMocks()
    mockRoute.query = {}
    mockSelectedChain = undefined
    mockCaptureWallet.mockReset().mockResolvedValue({
      wallet: mockWallet,
      assertCurrent: mockAssertCurrent,
    })
    mockAssertCurrent.mockReset().mockResolvedValue(undefined)
  })

  it('initial form action performs no signing or broadcast and opens review state', async () => {
    const wrapper = mountSend()

    // Edit card is initially visible
    expect(wrapper.find('[data-test="send-edit-card"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="send-review-card"]').exists()).toBe(false)

    // Fill valid recipient and amount
    const addressInput = wrapper.get('[data-test="send-address-input"]')
    await addressInput.setValue('0x000000000000000000000000000000000000dead')
    const amountInput = wrapper.get('[data-test="send-amount-input"]')
    await amountInput.setValue('1.5')

    const reviewBtn = wrapper.get('[data-test="send-review-button"]')
    expect(reviewBtn.attributes('disabled')).toBeUndefined()
    expect(reviewBtn.text()).toContain('Review')

    // Click Review: opens review state
    await reviewBtn.trigger('click')
    await flushPromises()

    // Must transition to review state
    expect(wrapper.find('[data-test="send-edit-card"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="send-review-card"]').exists()).toBe(true)

    // Acceptance criterion: No signing or RPC broadcast calls before final confirmation
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockCaptureWallet).toHaveBeenCalledTimes(1)
  })

  it('review displays full/checksummed recipient, amount, network, fee unavailability, total, and warning', async () => {
    const wrapper = mountSend()

    await wrapper
      .get('[data-test="send-address-input"]')
      .setValue('0x000000000000000000000000000000000000dead')
    await wrapper.get('[data-test="send-amount-input"]').setValue('2.5')
    await wrapper.get('[data-test="send-review-button"]').trigger('click')
    await flushPromises()

    const reviewCard = wrapper.get('[data-test="send-review-card"]')

    // Recipient: full/checksummed address
    const recipient = reviewCard.get('[data-test="review-recipient"]')
    expect(recipient.text()).toBe('0x000000000000000000000000000000000000dEaD')

    // Amount: value and unit
    const amount = reviewCard.get('[data-test="review-amount"]')
    expect(amount.text()).toBe('2.5 MON')

    // Network / testnet identity
    const network = reviewCard.get('[data-test="review-network"]')
    expect(network.text()).toBe('Monad Testnet')

    // Estimated fee honest unavailability
    const fee = reviewCard.get('[data-test="review-fee"]')
    expect(fee.text()).toBe('Unavailable')

    // Maximum total with fee notice
    const total = reviewCard.get('[data-test="review-total"]')
    expect(total.text()).toBe('2.5 MON (+ network fee)')

    // Irreversible action warning with role="alert"
    const warning = reviewCard.get('[data-test="review-warning"]')
    expect(warning.attributes('role')).toBe('alert')
    expect(warning.text()).toContain('Blockchain transactions are irreversible')
  })

  it('cancel returns to editing without network mutation and preserves draft', async () => {
    const wrapper = mountSend()

    await wrapper
      .get('[data-test="send-address-input"]')
      .setValue('0x000000000000000000000000000000000000dead')
    await wrapper.get('[data-test="send-amount-input"]').setValue('3.75')
    await wrapper.get('[data-test="send-review-button"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="send-review-card"]').exists()).toBe(true)

    // Click Edit / Cancel in review mode
    const cancelReviewBtn = wrapper.get('[data-test="review-cancel-button"]')
    expect(cancelReviewBtn.text()).toContain('Edit')
    await cancelReviewBtn.trigger('click')
    await flushPromises()

    // Must return to edit card
    expect(wrapper.find('[data-test="send-edit-card"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="send-review-card"]').exists()).toBe(false)

    // Draft inputs must be completely preserved
    const addressInput = wrapper.get<HTMLInputElement>(
      '[data-test="send-address-input"]',
    )
    const amountInput = wrapper.get<HTMLInputElement>(
      '[data-test="send-amount-input"]',
    )
    expect(addressInput.element.value).toBe(
      '0x000000000000000000000000000000000000dead',
    )
    expect(amountInput.element.value).toBe('3.75')

    // Zero signer/network calls
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockCaptureWallet).toHaveBeenCalledTimes(1)
  })

  it('final confirmation is single-flight and executes transfer upon confirm', async () => {
    let resolveSend!: (val: { txHash: string }) => void
    mockSend.mockImplementation(
      () =>
        new Promise<{ txHash: string }>(res => {
          resolveSend = res
        }),
    )

    const wrapper = mountSend()
    await wrapper
      .get('[data-test="send-address-input"]')
      .setValue('0x000000000000000000000000000000000000dead')
    await wrapper.get('[data-test="send-amount-input"]').setValue('1.0')
    await wrapper.get('[data-test="send-review-button"]').trigger('click')
    await flushPromises()

    const confirmBtn = wrapper.get('[data-test="review-confirm-button"]')
    expect(confirmBtn.text()).toContain('Confirm & Send')

    // Click confirm: initiates in-flight send
    await confirmBtn.trigger('click')
    expect(mockSend).toHaveBeenCalledTimes(1)

    // Rapid double click while in-flight: ignored (single-flight)
    await confirmBtn.trigger('click')
    expect(mockSend).toHaveBeenCalledTimes(1)

    // Complete the transfer
    resolveSend({ txHash: '0xhash123' })
    await flushPromises()

    expect(sentTransactionNotify).toHaveBeenCalledWith('0xhash123')
    expect(navigateBack).toHaveBeenCalled()
  })

  it('distinguishes definitely-not-broadcast when failure occurs before signing/broadcast', async () => {
    // Wallet or pre-signing failure
    mockAssertCurrent.mockRejectedValueOnce(new Error('wallet locked'))

    const wrapper = mountSend()
    await wrapper
      .get('[data-test="send-address-input"]')
      .setValue('0x000000000000000000000000000000000000dead')
    await wrapper.get('[data-test="send-amount-input"]').setValue('0.5')
    await wrapper.get('[data-test="send-review-button"]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()

    // Must notify definitely not broadcast
    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      fallbackKey: 'sendAddressDialog.definitelyNotBroadcast',
    })
    expect(sentTransactionNotify).not.toHaveBeenCalled()
  })

  it('distinguishes potentially-broadcast when failure occurs during or after onSigned broadcast', async () => {
    mockSend.mockImplementation(
      async ({
        onSigned,
      }: {
        onSigned?: (signed: { txHash: string }) => Promise<void>
      }) => {
        // Signing completed
        await onSigned?.({ txHash: '0xsignedtx999' })
        // RPC broadcast drops connection
        throw new Error('RPC network timeout during broadcast')
      },
    )

    const wrapper = mountSend()
    await wrapper
      .get('[data-test="send-address-input"]')
      .setValue('0x000000000000000000000000000000000000dead')
    await wrapper.get('[data-test="send-amount-input"]').setValue('0.5')
    await wrapper.get('[data-test="send-review-button"]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()

    // Must notify potentially broadcast with txHash
    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      safeMessage:
        'Transaction was signed (0xsignedtx999) and may have been broadcast. Check your balance or transaction status before retrying.',
    })
  })

  it('renders review state and warnings in French (fr-FR parity)', async () => {
    const wrapper = mountSend(frFR)

    await wrapper
      .get('[data-test="send-address-input"]')
      .setValue('0x000000000000000000000000000000000000dead')
    await wrapper.get('[data-test="send-amount-input"]').setValue('10')

    const reviewBtn = wrapper.get('[data-test="send-review-button"]')
    expect(reviewBtn.text()).toContain('Vérifier')
    await reviewBtn.trigger('click')
    await flushPromises()

    const reviewCard = wrapper.get('[data-test="send-review-card"]')
    expect(reviewCard.get('[data-test="review-title"]').text()).toContain(
      'Vérifier le transfert',
    )
    expect(reviewCard.get('[data-test="review-network"]').text()).toBe(
      'Testnet Monad',
    )
    expect(reviewCard.get('[data-test="review-fee"]').text()).toBe(
      'Indisponible',
    )
    expect(reviewCard.get('[data-test="review-total"]').text()).toBe(
      '10 MON (+ frais de réseau)',
    )
    expect(reviewCard.get('[data-test="review-warning"]').text()).toContain(
      'Les transactions sur la blockchain sont irréversibles',
    )
    expect(
      reviewCard.get('[data-test="review-cancel-button"]').text(),
    ).toContain('Modifier')
    expect(
      reviewCard.get('[data-test="review-confirm-button"]').text(),
    ).toContain('Confirmer et envoyer')

    // Test definitely-not-broadcast in French
    mockAssertCurrent.mockRejectedValueOnce(new Error('fail'))
    await reviewCard.get('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()

    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      fallbackKey: 'sendAddressDialog.definitelyNotBroadcast',
    })
  })

  it('keeps the reviewed primary adapter when the global network changes', async () => {
    mockSend.mockResolvedValue({ txHash: 'original-network-hash' })
    const wrapper = mountSend()
    await wrapper
      .get('[data-test="send-address-input"]')
      .setValue('0x000000000000000000000000000000000000dead')
    await wrapper.get('[data-test="send-amount-input"]').setValue('1')
    await wrapper.get('[data-test="send-review-button"]').trigger('click')
    await flushPromises()
    const original = { ...activeChain }
    const otherSend = jest.fn()
    try {
      Object.assign(activeChain, {
        chainIdentifier: 'monad-mainnet',
        unit: 'OTHER',
        nativeTransfers: { send: otherSend },
      })
      await wrapper.get('[data-test="review-confirm-button"]').trigger('click')
      await flushPromises()
      expect(mockSend).toHaveBeenCalledTimes(1)
      expect(otherSend).not.toHaveBeenCalled()
      expect(wrapper.get('[data-test="review-amount"]').text()).toBe('1 MON')
    } finally {
      Object.assign(activeChain, original)
      wrapper.unmount()
    }
  })

  function selectSolana() {
    mockRoute.query = { chainIdentifier: 'solana-devnet' }
    mockSelectedChain = createSolanaChain({
      networkId: 'solana-devnet',
      chainIdentifier: 'solana-devnet',
      genesisHash: 'test-genesis',
      connection: {
        getGenesisHash: jest.fn(),
        getBalance: jest.fn(),
        getLatestBlockhash: jest.fn(),
        getSignatureStatus: jest.fn(),
        sendRawTransaction: jest.fn(),
      },
      deriveSigner: () => {
        throw new Error('unused')
      },
    })
    const wallet = {
      family: 'solana',
      networkId: 'solana-devnet',
      chainIdentifier: 'solana-devnet',
      sendNative: mockSend,
    }
    mockCaptureWallet.mockResolvedValue({
      wallet,
      assertCurrent: mockAssertCurrent,
    })
    return wallet
  }

  it('reviews Solana units, canonical address and fee, then sends the captured amount through the Solana adapter', async () => {
    selectSolana()
    mockSend.mockResolvedValue({ txHash: 'solana-signature' })
    const wrapper = mountSend()
    const recipient = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9'
    await wrapper.get('[data-test="send-address-input"]').setValue(recipient)
    await wrapper.get('[data-test="send-amount-input"]').setValue('0.001')
    await wrapper.get('[data-test="send-review-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-test="review-network"]').text()).toBe(
      'Solana Devnet',
    )
    expect(wrapper.get('[data-test="review-recipient"]').text()).toBe(recipient)
    expect(wrapper.get('[data-test="review-amount"]').text()).toBe('0.001 dSOL')
    expect(wrapper.get('[data-test="review-fee"]').text()).toBe('0.000005 dSOL')
    expect(mockSend).not.toHaveBeenCalled()
    // A route selection or draft change cannot change the reviewed authorization.
    mockRoute.query = { chainIdentifier: 'monad-testnet' }
    Object.assign(wrapper.vm, {
      amount: '9',
      address: '11111111111111111111111111111111',
    })
    await wrapper.get('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()
    expect(mockAssertCurrent).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledWith({
      recipient: { raw: recipient },
      value: 1_000_000n,
      onSigned: expect.any(Function),
    })
    expect(sentTransactionNotify).toHaveBeenCalledWith('solana-signature')
    wrapper.unmount()
  })

  it.each([
    ['0x000000000000000000000000000000000000dead', '1'],
    ['11111111111111111111111111111111', '0.0000000001'],
    ['11111111111111111111111111111111', '-1'],
  ])(
    'does not review invalid Solana input %s / %s',
    async (address, amount) => {
      selectSolana()
      const wrapper = mountSend()
      await wrapper.get('[data-test="send-address-input"]').setValue(address)
      await wrapper.get('[data-test="send-amount-input"]').setValue(amount)
      expect(
        wrapper.get('[data-test="send-review-button"]').attributes('disabled'),
      ).toBeDefined()
      expect(mockCaptureWallet).not.toHaveBeenCalled()
      wrapper.unmount()
    },
  )

  it.each(['made-up-network', null, ['solana-devnet', 'monad-testnet']])(
    'rejects invalid route network %s without silently selecting Monad',
    async chainIdentifier => {
      mockRoute.query = { chainIdentifier }
      const wrapper = mountSend()
      await wrapper
        .get('[data-test="send-address-input"]')
        .setValue('0x000000000000000000000000000000000000dead')
      await wrapper.get('[data-test="send-amount-input"]').setValue('1')
      await flushPromises()
      expect(
        wrapper.get('[data-test="send-review-button"]').attributes('disabled'),
      ).toBeDefined()
      expect(mockCaptureWallet).not.toHaveBeenCalled()
      expect(errorNotify).toHaveBeenCalled()
      wrapper.unmount()
    },
  )

  it('blocks Solana signing when the reviewed session changes before confirmation', async () => {
    selectSolana()
    const wrapper = mountSend()
    await wrapper
      .get('[data-test="send-address-input"]')
      .setValue('11111111111111111111111111111111')
    await wrapper.get('[data-test="send-amount-input"]').setValue('1')
    await wrapper.get('[data-test="send-review-button"]').trigger('click')
    await flushPromises()
    mockAssertCurrent.mockRejectedValueOnce(new Error('Account changed'))
    await wrapper.get('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()
    expect(mockSend).not.toHaveBeenCalled()
    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      fallbackKey: 'sendAddressDialog.definitelyNotBroadcast',
    })
    wrapper.unmount()
  })

  it('reports a recovered uncertain submission hash even without a new signing callback', async () => {
    selectSolana()
    mockSend.mockRejectedValue(
      new NativeTransactionSubmissionError({
        transaction: { txHash: 'original-solana-signature' },
        reason: new Error('still unknown'),
      }),
    )
    const wrapper = mountSend()
    await wrapper
      .get('[data-test="send-address-input"]')
      .setValue('11111111111111111111111111111111')
    await wrapper.get('[data-test="send-amount-input"]').setValue('1')
    await wrapper.get('[data-test="send-review-button"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()
    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      safeMessage: expect.stringContaining('original-solana-signature'),
    })
    expect(sentTransactionNotify).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
