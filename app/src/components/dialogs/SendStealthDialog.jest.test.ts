/** @jest-environment jsdom */
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import SendStealthDialog from './SendStealthDialog.vue'
const mockActiveBalance = ref<bigint | null>(null)
const mockBalanceLoaded = ref(false)
jest.mock('../../composables/useBalance', () => ({
  useBalance: () => ({
    balance: mockActiveBalance,
    loaded: mockBalanceLoaded,
    formattedSpendable: '',
  }),
}))
import enUS from '../../i18n/en-us'
import { stealthAssetKey } from '../../stealth-payments/options'
import type {
  StealthAssetOption,
  StealthDialogRequest,
} from '../../stealth-payments/options'

const assetMetadata: Omit<StealthAssetOption, 'key'>[] = [
  {
    chainIdentifier: 'monad-testnet',
    asset: { kind: 'native' },
    label: 'MONT · Monad Testnet',
    unit: 'MONT',
    decimals: 18,
    nativeUnit: 'MONT',
    nativeDecimals: 18,
    balanceAtomic: 50n * 10n ** 18n,
  },
  {
    chainIdentifier: 'xec-testnet',
    asset: { kind: 'native' },
    label: 'tXEC · eCash Testnet',
    unit: 'tXEC',
    decimals: 2,
    nativeUnit: 'tXEC',
    nativeDecimals: 2,
    balanceAtomic: 999800n,
  },
  {
    chainIdentifier: 'monad-testnet',
    asset: {
      kind: 'erc20',
      contractAddress: '0x534b2f3A21130d7a60830c2Df862319e593943A3',
    },
    label: 'USDC · Monad Testnet',
    unit: 'USDC',
    decimals: 6,
    nativeUnit: 'MONT',
    nativeDecimals: 18,
    balanceAtomic: 20000000n,
  },
]
const options: StealthAssetOption[] = assetMetadata.map(option => ({
  ...option,
  key: stealthAssetKey(option.chainIdentifier, option.asset),
}))
function translator(key: string) {
  const value = key
    .split('.')
    .reduce<unknown>(
      (object, part) => (object as Record<string, unknown>)?.[part],
      enUS,
    )
  return typeof value === 'string' ? value : key
}
function mountDialog(props = {}) {
  return mount(SendStealthDialog, {
    props: {
      address: 'recipient',
      contact: { name: 'Qwen' },
      options,
      ...props,
    },
    global: {
      mocks: { $t: translator },
      directives: { 'close-popup': {} },
      stubs: {
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
        QCardActions: { template: '<div><slot /></div>' },
        QForm: { template: '<form><slot /></form>' },
        QSelect: {
          props: ['modelValue', 'options', 'disable'],
          template:
            '<select :disabled="disable" :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option></select>',
        },
        QInput: {
          props: ['modelValue', 'disable', 'suffix', 'error', 'errorMessage'],
          template:
            '<label><input :disabled="disable" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /><span>{{ suffix }}</span><span v-if="error" class="error-msg">{{ errorMessage }}</span></label>',
        },
        QBtn: {
          props: ['disable', 'label'],
          template: '<button :disabled="disable">{{ label }}</button>',
        },
      },
    },
  })
}

describe('multiasset stealth send dialog', () => {
  it('offers the host supplied canonical native, tXEC and USDC options without a redundant review button', () => {
    const wrapper = mountDialog()
    expect(wrapper.text()).toContain('Qwen')
    expect(wrapper.findAll('option').map(option => option.text())).toEqual(
      options.map(option => option.label),
    )
    expect(wrapper.find('[data-testid="wallet-balance-value"]').text()).toBe(
      '50 MONT',
    )
    expect(wrapper.find('[data-testid="stealth-review-btn"]').exists()).toBe(
      false,
    )
    expect(
      wrapper
        .find('[data-testid="stealth-send-confirm-btn"]')
        .attributes('disabled'),
    ).toBeDefined()
  })

  it.each([
    [0, '1.000000000000000001', 1000000000000000001n],
    [1, '9998.01', 999801n],
    [2, '1.000001', 1000001n],
  ])(
    'sends exact atomic amount for option %s in one step',
    async (index, amount, expected) => {
      const wrapper = mountDialog({
        options: options.map(option => ({
          ...option,
          balanceAtomic: undefined,
        })),
      })
      await wrapper.find('select').setValue(options[index as number].key)
      await wrapper
        .find('[data-testid="stealth-amount-input"] input')
        .setValue(amount as string)
      expect(
        wrapper
          .find('[data-testid="stealth-send-confirm-btn"]')
          .attributes('disabled'),
      ).toBeUndefined()
      await wrapper.find('form').trigger('submit')
      const events = wrapper.emitted('send')!
      const request = events[events.length - 1][0] as StealthDialogRequest
      expect(request.amountAtomic).toBe(expected)
      expect(request.assetKey).toBe(options[index as number].key)
    },
  )

  it('rejects invalid, overprecision and uint256-overflow amounts', async () => {
    const wrapper = mountDialog()
    for (const amount of [
      '',
      '0',
      '-1',
      'NaN',
      '1e3',
      '1.0000000000000000001',
      (2n ** 256n).toString(),
    ]) {
      await wrapper
        .find('[data-testid="stealth-amount-input"] input')
        .setValue(amount)
      await wrapper.find('form').trigger('submit')
    }
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('displays inline validation error and disables send when amount exceeds available balance', async () => {
    const wrapper = mountDialog()
    await wrapper.find('select').setValue(options[0].key) // 50 MONT
    await wrapper
      .find('[data-testid="stealth-amount-input"] input')
      .setValue('51')
    expect(
      wrapper.find('[data-testid="stealth-amount-input"] .error-msg').text(),
    ).toBe('Amount exceeds available balance')
    expect(
      wrapper
        .find('[data-testid="stealth-send-confirm-btn"]')
        .attributes('disabled'),
    ).toBeDefined()
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('displays active wallet balance immediately when option balance is undefined', async () => {
    mockActiveBalance.value = 21699700000000000000n
    mockBalanceLoaded.value = true
    try {
      const unpopulatedOptions = options.map(o => ({
        ...o,
        balanceAtomic: undefined,
      }))
      const wrapper = mountDialog({ options: unpopulatedOptions })
      await wrapper.find('select').setValue(unpopulatedOptions[0].key) // MONT
      expect(wrapper.find('[data-testid="wallet-balance-value"]').text()).toBe(
        '21.6997 MONT',
      )
      await wrapper
        .find('[data-testid="stealth-amount-input"] input')
        .setValue('343214321')
      expect(
        wrapper.find('[data-testid="stealth-amount-input"] .error-msg').text(),
      ).toBe('Amount exceeds available balance')
      expect(
        wrapper
          .find('[data-testid="stealth-send-confirm-btn"]')
          .attributes('disabled'),
      ).toBeDefined()
    } finally {
      mockActiveBalance.value = null
      mockBalanceLoaded.value = false
    }
  })
})
