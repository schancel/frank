/** @jest-environment jsdom */

import { reactive, ref } from 'vue'
import { includedNativeTransfer } from '../../test/jest/utils/native-operation'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Send from './Send.vue'
import {
  activeChain,
  NativeTransactionRefusedError,
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
enableAutoUnmount(afterEach)
const mockSend = jest.fn()
const mockCaptureWallet = jest.fn()
const mockAssertCurrent = jest.fn()
const mockRoute = reactive({
  fullPath: '/send',
  query: {} as Record<string, string | string[] | null>,
})
const mockCurrent = ref(true)
let mockSelectedChain: NativeAssetChain | undefined
const mockGetBalance = jest.fn()
const mockGetTransactionStatus = jest.fn()

jest.mock('@frank/wallet/chain', () => ({
  ...jest.requireActual('@frank/wallet/chain/evm-native-operation-status'),
  NativeTransactionSubmissionError: jest.requireActual(
    '@frank/wallet/chain/chain-wallet',
  ).NativeTransactionSubmissionError,
  NativeTransactionRefusedError: jest.requireActual(
    '@frank/wallet/chain/chain-wallet',
  ).NativeTransactionRefusedError,
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

jest.mock('src/accounts/session', () => ({ accountSession: {} }))
jest.mock('src/accounts/native-transfer', () => ({
  ...jest.requireActual('src/accounts/native-transfer'),
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
    mockRoute.fullPath = '/send'
    mockCurrent.value = true
    mockSelectedChain = undefined
    mockCaptureWallet.mockReset().mockResolvedValue({
      wallet: mockWallet,
      assertCurrent: mockAssertCurrent,
      isCurrent: () => mockCurrent.value,
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

    // Amount plus network fee notice
    const total = reviewCard.get('[data-test="review-total"]')
    expect(total.text()).toBe('2.5 MON (+ network fee)')

    // Irreversible action warning with role="alert"
    const warning = reviewCard.get('[data-test="review-warning"]')
    expect(warning.attributes('role')).toBe('alert')
    expect(warning.text()).toContain('Blockchain transactions are irreversible')
  })

  describe.each([
    {
      language: 'English',
      messages: enUS,
      label: 'Amount + network fee',
      unavailable: 'Unavailable',
      network: 'Monad Testnet',
      total: '0.01 MON (+ network fee)',
    },
    {
      language: 'French',
      messages: frFR,
      label: 'Montant + frais de réseau',
      unavailable: 'Indisponible',
      network: 'Testnet Monad',
      total: '0.01 MON (+ frais de réseau)',
    },
  ])(
    '$language fee disclosure (#1283)',
    ({ messages, label, unavailable, network, total }) => {
      it.each([true, false])(
        'describes amount plus network fee without a maximum claim (estimate available: %s)',
        async available => {
          mockSelectedChain = {
            ...activeChain,
            nativeTransfers: {
              ...activeChain.nativeTransfers,
              ...(available
                ? {
                    estimateLegacyFee: jest.fn().mockResolvedValue({
                      totalFee: 4_242_000_000_000_000n,
                      deliveryFee: 4_242_000_000_000_000n,
                      inputCount: 1,
                    }),
                  }
                : {}),
            },
          }
          const wrapper = mountSend(messages)
          await wrapper
            .get('[data-test="send-address-input"]')
            .setValue('0x000000000000000000000000000000000000dead')
          await wrapper.get('[data-test="send-amount-input"]').setValue('0.01')
          await wrapper.get('[data-test="send-review-button"]').trigger('click')
          await flushPromises()
          const card = wrapper.get('[data-test="send-review-card"]')
          expect(card.text()).toContain(label)
          expect(card.text()).not.toMatch(/Maximum Total|Total maximal/)
          expect(card.text()).toContain(messages.sendAddressDialog.estimatedFee)
          expect(card.get('[data-test="review-fee"]').text()).toBe(
            available ? '0.004242 MON' : unavailable,
          )
          expect(card.get('[data-test="review-total"]').text()).toBe(total)
          expect(card.get('[data-test="review-amount"]').text()).toBe(
            '0.01 MON',
          )
          expect(card.get('[data-test="review-recipient"]').text()).toBe(
            '0x000000000000000000000000000000000000dEaD',
          )
          expect(card.get('[data-test="review-network"]').text()).toBe(network)
          expect(mockSend).not.toHaveBeenCalled()
          await wrapper
            .get('[data-test="review-cancel-button"]')
            .trigger('click')
          await flushPromises()
          expect(mockSend).not.toHaveBeenCalled()
          expect(wrapper.find('[data-test="send-edit-card"]').exists()).toBe(
            true,
          )
          wrapper.unmount()
        },
      )
    },
  )

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

    expect(
      wrapper.get('[data-test="native-operation-outcome"]').text(),
    ).toContain('0xsignedtx999')
    expect(
      wrapper.get('[data-test="native-operation-outcome"]').text(),
    ).toContain('Funds may have moved')
    expect(wrapper.find('[data-test="review-confirm-button"]').exists()).toBe(
      false,
    )
    expect(errorNotify).not.toHaveBeenCalled()
  })

  it('shows the node reason when the network refuses, and lets the same review be confirmed again', async () => {
    mockSend.mockRejectedValueOnce(
      new NativeTransactionRefusedError('min relay fee not met'),
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

    const refused = wrapper.get('[data-test="send-refused"]').text()
    expect(refused).toContain('Nothing was sent')
    expect(refused).toContain('min relay fee not met')
    // Not presented as a payment that may have moved funds.
    expect(
      wrapper.find('[data-test="native-operation-outcome"]').exists(),
    ).toBe(false)
    expect(sentTransactionNotify).not.toHaveBeenCalled()
    // Nothing was sent, so confirming again is offered and clears the notice.
    await wrapper.get('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()
    expect(mockSend).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-test="send-refused"]').exists()).toBe(false)
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
      isCurrent: () => mockCurrent.value,
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
    expect(mockAssertCurrent).toHaveBeenCalledTimes(2)
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
    expect(
      wrapper.get('[data-test="native-operation-outcome"]').text(),
    ).toContain('original-solana-signature')
    expect(wrapper.find('[data-test="review-confirm-button"]').exists()).toBe(
      false,
    )
    expect(sentTransactionNotify).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  async function reviewNative(wrapper: ReturnType<typeof mountSend>) {
    await wrapper
      .get('[data-test="send-address-input"]')
      .setValue('0x000000000000000000000000000000000000dead')
    await wrapper.get('[data-test="send-amount-input"]').setValue('0.01')
    await wrapper.get('[data-test="send-review-button"]').trigger('click')
    await flushPromises()
  }

  it.each(
    [enUS, frFR].flatMap(messages =>
      (['not-shared', 'failed', 'shared'] as const).map(
        sharing => [messages, sharing] as const,
      ),
    ),
  )(
    'holds the original included payment after sync rejection with localized public evidence (%#)',
    async (messages, sharing) => {
      const fixture = await includedNativeTransfer()
      if (sharing === 'shared')
        for (const [index] of fixture.journal.list()[0]!.members.entries())
          await fixture.journal.markSyncApplied(fixture.operationId, index)
      const getNativeOperations = jest.fn(() => fixture.journal.list())
      mockCaptureWallet.mockResolvedValue({
        wallet: {
          family: 'evm',
          chainIdentifier: 'monad-testnet',
          getNativeOperations,
          nativeOperationSyncFailed: () => sharing === 'failed',
        },
        assertCurrent: mockAssertCurrent,
        isCurrent: () => mockCurrent.value,
      })
      mockSend.mockImplementation(async ({ onSigned }) => {
        await onSigned({ txHash: fixture.hash })
        throw new Error('private internal callback failure')
      })
      const wrapper = mountSend(messages)
      try {
        await reviewNative(wrapper)
        await wrapper
          .get('[data-test="review-confirm-button"]')
          .trigger('click')
        await flushPromises()
        const outcome = wrapper.get('[data-test="native-operation-outcome"]')
        expect(outcome.text()).toContain(
          t(messages, 'nativeOperation.included', {
            network: messages.setup.networkTitle,
          }),
        )
        expect(outcome.text()).toContain(fixture.hash)
        expect(outcome.text()).toContain(fixture.operationId)
        expect(outcome.text()).toContain('69526794')
        expect(outcome.text()).toContain('0.002142 MON')
        // The payment is included: the outcome reads as sent. Whether the wallet's other devices
        // were told (yes, not yet, or the last try failed and is repeated) is a muted note in
        // every case, and nothing speaks of recovery.
        const sync = wrapper.get('[data-test="native-operation-sync"]')
        expect(sync.text()).toBe(
          {
            'not-shared': messages.nativeOperation.syncNotShared,
            'failed': messages.nativeOperation.syncFailed,
            'shared': messages.nativeOperation.syncShared,
          }[sharing],
        )
        expect(sync.classes()).toEqual(
          expect.arrayContaining(['text-caption', 'text-grey-7']),
        )
        expect(outcome.text()).not.toContain(
          messages.nativeOperation.recoveryUnavailable,
        )
        expect(
          wrapper.find('[data-test="native-operation-recovery"]').exists(),
        ).toBe(false)
        expect(outcome.text()).not.toContain('private internal')
        expect(wrapper.get('[data-test="review-amount"]').text()).toBe(
          '0.01 MON',
        )
        expect(
          wrapper.find('[data-test="review-confirm-button"]').exists(),
        ).toBe(false)
        const vm = wrapper.vm as unknown as {
          confirmSend(): Promise<void>
          cancelReview(): void
          reviewTransfer(): Promise<void>
        }
        vm.cancelReview()
        await vm.reviewTransfer()
        await vm.confirmSend()
        expect(mockSend).toHaveBeenCalledTimes(1)
        expect(navigateBack).not.toHaveBeenCalled()
        expect(errorNotify).not.toHaveBeenCalled()
        expect(
          JSON.stringify(
            (wrapper.vm as unknown as { operation: unknown }).operation,
          ),
        ).not.toContain('rawTransaction')
      } finally {
        wrapper.unmount()
        await fixture.close()
      }
    },
  )

  it.each(['no-hash', 'unmatched', 'ambiguous', 'wrong-chain'])(
    'keeps a dispatched %s outcome held without recipient/amount association',
    async mode => {
      const fixture = await includedNativeTransfer()
      const rows = fixture.journal.list()
      const getNativeOperations = jest.fn(() =>
        mode === 'ambiguous'
          ? [...rows, ...rows]
          : mode === 'wrong-chain'
          ? rows.map(row => ({
              ...row,
              binding: { ...row.binding, chainIdentifier: 'monad-mainnet' },
            }))
          : rows,
      )
      mockCaptureWallet.mockResolvedValue({
        wallet: {
          family: 'evm',
          chainIdentifier: 'monad-testnet',
          getNativeOperations,
        },
        assertCurrent: mockAssertCurrent,
        isCurrent: () => true,
      })
      mockSend.mockImplementation(async ({ onSigned }) => {
        if (mode !== 'no-hash')
          await onSigned({
            txHash:
              mode === 'unmatched' ? '0x' + 'ab'.repeat(32) : fixture.hash,
          })
        throw new Error('dispatch failed')
      })
      const wrapper = mountSend()
      try {
        await reviewNative(wrapper)
        await wrapper
          .get('[data-test="review-confirm-button"]')
          .trigger('click')
        await flushPromises()
        expect(
          wrapper.get('[data-test="native-operation-outcome"]').text(),
        ).toContain('Payment outcome is unresolved')
        expect(wrapper.find('[data-test="native-operation-id"]').exists()).toBe(
          false,
        )
        expect(
          wrapper.find('[data-test="review-confirm-button"]').exists(),
        ).toBe(false)
        await (
          wrapper.vm as unknown as { confirmSend(): Promise<void> }
        ).confirmSend()
        expect(mockSend).toHaveBeenCalledTimes(1)
        expect(errorNotify).not.toHaveBeenCalled()
      } finally {
        wrapper.unmount()
        await fixture.close()
      }
    },
  )

  it.each(['unmount', 'route', 'account', 'wallet'])(
    'ignores completion after %s replacement',
    async change => {
      let finish!: (result: { txHash: string }) => void
      mockSend.mockImplementation(
        () =>
          new Promise(resolve => {
            finish = resolve
          }),
      )
      const wrapper = mountSend()
      await reviewNative(wrapper)
      await wrapper.get('[data-test="review-confirm-button"]').trigger('click')
      await flushPromises()
      if (change === 'unmount') wrapper.unmount()
      if (change === 'route')
        mockRoute.fullPath = '/send?chainIdentifier=solana-devnet'
      if (change === 'account') mockCurrent.value = false
      if (change === 'wallet')
        mockAssertCurrent.mockRejectedValueOnce(new Error('wallet replaced'))
      finish({ txHash: 'original-result' })
      await flushPromises()
      expect(sentTransactionNotify).not.toHaveBeenCalled()
      expect(navigateBack).not.toHaveBeenCalled()
      expect(errorNotify).not.toHaveBeenCalled()
      if (change !== 'unmount') {
        expect(wrapper.find('[data-test="send-stale-card"]').exists()).toBe(
          true,
        )
        expect(
          wrapper.find('[data-test="review-confirm-button"]').exists(),
        ).toBe(false)
        wrapper.unmount()
      }
    },
  )
  describe.each([enUS, frFR])('localized unsettled outcomes', messages => {
    it.each([
      'unknown',
      'missing',
      'pending',
      'included-revert',
      'partial',
    ] as const)(
      'keeps %s recipient evidence and fees distinct',
      async state => {
        const fixture = await includedNativeTransfer(state === 'partial')
        const index = state === 'partial' ? 1 : 0
        await fixture.journal.recordObservation(
          fixture.journal.beginCapture(fixture.operationId, index),
          state === 'included-revert'
            ? {
                state,
                transactionHash: fixture.hash,
                blockHash: '0x' + '12'.repeat(32),
                blockNumber: 69526794,
                transactionIndex: index,
                feeWei: '2142000000000000',
              }
            : { state: state === 'partial' ? 'missing' : state },
          null,
        )
        mockCaptureWallet.mockResolvedValue({
          wallet: {
            family: 'evm',
            chainIdentifier: 'monad-testnet',
            getNativeOperations: () => fixture.journal.list(),
          },
          assertCurrent: mockAssertCurrent,
          isCurrent: () => true,
        })
        mockSend.mockImplementation(async ({ onSigned }) => {
          await onSigned({ txHash: fixture.hash })
          throw new Error('outcome unresolved')
        })
        const wrapper = mountSend(messages)
        try {
          await reviewNative(wrapper)
          await wrapper
            .get('[data-test="review-confirm-button"]')
            .trigger('click')
          await flushPromises()
          const outcome = wrapper.get('[data-test="native-operation-outcome"]')
          const payment =
            state === 'included-revert'
              ? 'reverted'
              : state === 'missing'
              ? 'unknown'
              : state
          expect(outcome.text()).toContain(
            t(messages, `nativeOperation.${payment}`, {
              network: messages.setup.networkTitle,
            }),
          )
          expect(outcome.text()).not.toContain(
            t(messages, 'nativeOperation.included', {
              network: messages.setup.networkTitle,
            }),
          )
          const coverage =
            state === 'partial'
              ? 'partial'
              : state === 'included-revert'
              ? 'complete'
              : 'unknown'
          expect(wrapper.get('[data-test="native-operation-fee"]').text()).toBe(
            t(messages, `nativeOperation.fee${coverage}`, {
              amount: '0.002142',
              unit: 'MON',
            }),
          )
          expect(
            wrapper.find('[data-test="review-confirm-button"]').exists(),
          ).toBe(false)
        } finally {
          wrapper.unmount()
          await fixture.close()
        }
      },
    )
  })
  it.each([
    'complete',
    'unrecorded',
    'unmatched',
    'ambiguous',
    'unavailable',
    'unsupported',
  ])(
    'checks original owner evidence before treating a returned EVM result as successful (%s)',
    async evidence => {
      const fixture = await includedNativeTransfer()
      if (evidence === 'complete')
        await fixture.journal.markSyncApplied(fixture.operationId, 0)
      mockCaptureWallet.mockResolvedValue({
        wallet: {
          family: 'evm',
          chainIdentifier: 'monad-testnet',
          getNativeOperations:
            evidence === 'unsupported'
              ? undefined
              : () => {
                  if (evidence === 'unavailable')
                    throw new Error('owner closed')
                  const rows = fixture.journal.list()
                  return evidence === 'ambiguous' ? [...rows, ...rows] : rows
                },
        },
        assertCurrent: mockAssertCurrent,
        isCurrent: () => true,
      })
      mockSend.mockResolvedValue({
        txHash:
          evidence === 'unmatched' ? '0x' + 'ab'.repeat(32) : fixture.hash,
      })
      const wrapper = mountSend()
      try {
        await reviewNative(wrapper)
        await wrapper
          .get('[data-test="review-confirm-button"]')
          .trigger('click')
        await flushPromises()
        expect(
          wrapper.find('[data-test="review-confirm-button"]').exists(),
        ).toBe(false)
        // An included payment is a completed send whether or not the wallet has recorded telling
        // its other devices ('unrecorded'): notify and go back, as for 'complete'.
        if (evidence === 'complete' || evidence === 'unrecorded') {
          expect(sentTransactionNotify).toHaveBeenCalledWith(fixture.hash)
          expect(navigateBack).toHaveBeenCalledTimes(1)
        } else {
          expect(sentTransactionNotify).not.toHaveBeenCalled()
          expect(navigateBack).not.toHaveBeenCalled()
          expect(
            wrapper.get('[data-test="native-operation-outcome"]').text(),
          ).toContain(enUS.nativeOperation.recoveryUnavailable)
        }
        await (
          wrapper.vm as unknown as { confirmSend(): Promise<void> }
        ).confirmSend()
        expect(mockSend).toHaveBeenCalledTimes(1)
      } finally {
        wrapper.unmount()
        await fixture.close()
      }
    },
  )
})
