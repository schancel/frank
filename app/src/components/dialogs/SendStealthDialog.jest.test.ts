/** @jest-environment jsdom */

import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import SendStealthDialog from './SendStealthDialog.vue'
import enUS from '../../i18n/en-us'
import { useWalletNames } from '../../composables/useWalletNames'

const mockBalance = ref(2500000000000000000n)
const mockFormattedBalance = ref('2.50 MON')
const mockLoaded = ref(true)

jest.mock('../../composables/useBalance', () => ({
  useBalance: () => ({
    balance: mockBalance,
    formattedBalance: mockFormattedBalance,
    loaded: mockLoaded,
  }),
}))

function translator(messages: unknown) {
  return (key: string, params?: Record<string, unknown>) => {
    let value: unknown = key
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], messages)
    if (typeof value === 'string' && params) {
      for (const [k, v] of Object.entries(params)) {
        value = value.replace(`{${k}}`, String(v))
      }
    }
    return typeof value === 'string' ? value : key
  }
}

describe('SendStealthDialog', () => {
  const mountDialog = (props = {}) => {
    return mount(SendStealthDialog, {
      props: {
        address: '0xAlice',
        contact: { name: 'Alice' },
        ...props,
      },
      global: {
        mocks: { $t: translator(enUS) },
        directives: { 'close-popup': {} },
        stubs: {
          QCard: { template: '<div><slot /></div>' },
          QCardSection: { template: '<div><slot /></div>' },
          QCardActions: { template: '<div><slot /></div>' },
          QSelect: {
            props: ['modelValue', 'options'],
            template:
              '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option></select>',
          },
          QInput: {
            props: ['modelValue', 'error', 'errorMessage', 'hint'],
            template:
              '<div><input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /><span v-if="error" class="error-text">{{ errorMessage }}</span></div>',
          },
          QBtn: {
            props: ['disable'],
            template: '<button :disabled="disable"><slot /></button>',
          },
        },
      },
    })
  }

  beforeEach(() => {
    const { clearAllCustomNames } = useWalletNames()
    clearAllCustomNames()
  })

  it('renders contact name and defaults to monad wallet', () => {
    const wrapper = mountDialog()
    expect(wrapper.text()).toContain('Alice')
    expect((wrapper.vm as any).selectedWalletId).toBe('monad')
    expect((wrapper.vm as any).currentUnit).toBe('MONT')
  })

  it('displays spendable balance for current wallet', () => {
    const wrapper = mountDialog()
    expect(wrapper.find('[data-testid="wallet-balance-value"]').text()).toBe(
      '2.50 MON',
    )
  })

  it('disables send button when amount is empty or non-positive', () => {
    const wrapper = mountDialog()
    expect((wrapper.vm as any).canSend).toBe(false)
  })

  it('switches wallet to solana and updates unit, curve, and keyType', async () => {
    const wrapper = mountDialog()
    await wrapper.setData({ selectedWalletId: 'solana' })

    expect((wrapper.vm as any).selectedWallet.chain).toBe('solana')
    expect((wrapper.vm as any).selectedWallet.curve).toBe('ed25519')
    expect((wrapper.vm as any).selectedWallet.keyType).toBe(2)
    expect((wrapper.vm as any).currentUnit).toBe('tSOL')
    expect((wrapper.vm as any).selectedWallet.minDust).toBe(0.00089)
  })

  it('enforces dust limit on Solana (< 0.00089 SOL)', async () => {
    const wrapper = mountDialog()
    await wrapper.setData({
      selectedWalletId: 'solana',
      amount: '0.0001',
    })

    expect((wrapper.vm as any).isBelowDustLimit).toBe(true)
    expect((wrapper.vm as any).canSend).toBe(false)
    expect(wrapper.text()).toContain(
      'Amount must be at least 0.00089 tSOL (dust limit)',
    )
  })

  it('allows valid amount above dust limit and enables send button', async () => {
    const wrapper = mountDialog()
    await wrapper.setData({
      selectedWalletId: 'solana',
      amount: '0.05',
    })

    expect((wrapper.vm as any).isBelowDustLimit).toBe(false)
    expect((wrapper.vm as any).canSend).toBe(true)
  })

  it('emits send with multi-chain payload when confirmed', async () => {
    const wrapper = mountDialog()
    await wrapper.setData({
      selectedWalletId: 'solana',
      amount: '2.5',
      memo: 'Secret bet cover',
    })
    expect((wrapper.vm as any).canSend).toBe(true)
    ;(wrapper.vm as any).sendStealth()

    const emitted = wrapper.emitted('send')
    expect(emitted).toHaveLength(1)
    expect(emitted![0][0]).toEqual({
      address: '0xAlice',
      chainId: 'solana-devnet',
      amount: 2.5,
      memo: 'Secret bet cover',
      wallet: 'solana',
      walletName: 'Solana Testnet',
      networkTag: 'solana-devnet',
      chain: 'solana',
      curve: 'ed25519',
      keyType: 2,
      unit: 'tSOL',
    })
  })

  it('reflects custom wallet names from useWalletNames', () => {
    const { setCustomName } = useWalletNames()
    setCustomName('solana', 'My Secret Solana Vault')

    const wrapper = mountDialog()
    const options = (wrapper.vm as any).walletOptions
    const solanaOption = options.find((o: any) => o.value === 'solana')
    expect(solanaOption.label).toBe('My Secret Solana Vault')
  })
})
