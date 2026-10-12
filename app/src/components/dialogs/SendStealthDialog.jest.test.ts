/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import SendStealthDialog from './SendStealthDialog.vue'
jest.mock('../../composables/useBalance', () => ({
  useBalance: () => ({ loaded: false, formattedSpendable: '' }),
}))
import enUS from '../../i18n/en-us'
import {
  stealthAssetKey,
  type StealthAssetOption,
  type StealthDialogRequest,
  type StealthDialogQuoteState,
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
          props: ['modelValue', 'disable', 'suffix'],
          template:
            '<label><input :disabled="disable" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /><span>{{ suffix }}</span></label>',
        },
        QBtn: {
          props: ['disable', 'label'],
          template: '<button :disabled="disable">{{ label }}</button>',
        },
      },
    },
  })
}
function quoteFor(
  request: StealthDialogRequest,
): Extract<StealthDialogQuoteState, { status: 'ready' }> {
  return {
    status: 'ready',
    request,
    maxNativeFeeAtomic: 20n,
    stampValueAtomic: 1000000000000n,
    stampFeeAtomic: 2000000000n,
    stampUnit: 'MONT',
    stampDecimals: 18,
    payment: {
      ...request,
      operationId: 'operation',
      recipientAddress: 'derived',
      recipientDestination: new Uint8Array([1]),
      recipientSpendPublicKey: new Uint8Array([2]),
      ephemeralPublicKey: new Uint8Array([3]),
      nativeBalanceAtomic: 100n * 10n ** 18n,
      assetBalanceAtomic: 50n * 10n ** 18n,
      estimatedNativeFeeAtomic: 10n,
    },
  }
}
async function review(
  wrapper: ReturnType<typeof mountDialog>,
  optionIndex = 0,
  amount = '1',
) {
  await wrapper.find('select').setValue(options[optionIndex].key)
  await wrapper
    .find('[data-testid="stealth-amount-input"] input')
    .setValue(amount)
  await wrapper.find('[data-testid="stealth-review-btn"]').trigger('click')
  const events = wrapper.emitted('review')!
  return events[events.length - 1][0] as StealthDialogRequest
}

describe('multiasset stealth review dialog', () => {
  it('offers the host supplied canonical native, tXEC and USDC options without opening a wallet', () => {
    const wrapper = mountDialog()
    expect(wrapper.text()).toContain('Qwen')
    expect(wrapper.findAll('option').map(option => option.text())).toEqual(
      options.map(option => option.label),
    )
    expect(wrapper.find('[data-testid="wallet-balance-value"]').text()).toBe(
      '50 MONT',
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
    'reviews exact atomic amount for option %s',
    async (index, amount, expected) => {
      const wrapper = mountDialog({
        options: options.map(option => ({
          ...option,
          balanceAtomic: undefined,
        })),
      })
      const request = await review(wrapper, index as number, amount as string)
      expect(request.amountAtomic).toBe(expected)
      expect(request.assetKey).toBe(options[index as number].key)
      expect(wrapper.emitted('send')).toBeUndefined()
    },
  )
  it('separates recipient token amount, native fee ceiling and the message stamp before confirmation', async () => {
    const wrapper = mountDialog()
    const request = await review(wrapper, 2, '1.000001')
    const quote = quoteFor(request)
    await wrapper.setProps({ quote })
    expect(wrapper.find('[data-testid="stealth-reviewed-amount"]').text()).toBe(
      '1.000001 USDC',
    )
    expect(wrapper.find('[data-testid="stealth-native-fee"]').text()).toBe(
      '0.00000000000000001 MONT',
    )
    expect(wrapper.find('[data-testid="stealth-fee-ceiling"]').text()).toBe(
      '0.00000000000000002 MONT',
    )
    expect(
      wrapper.find('[data-testid="stealth-message-stamp-fee"]').text(),
    ).toBe('0.000000002 MONT')
    expect(wrapper.find('[data-testid="stealth-message-stamp"]').text()).toBe(
      '0.000001 MONT',
    )
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('send')![0][0]).toEqual({
      ...request,
      quote: quote.payment,
      maxNativeFeeAtomic: 20n,
      stampValue: 1000000000000n,
    })
  })
  it.each(['asset', 'amount', 'memo', 'recipient'])(
    'invalidates approval when %s changes, even if switched back',
    async field => {
      const wrapper = mountDialog()
      const request = await review(wrapper)
      await wrapper.setProps({ quote: quoteFor(request) })
      if (field === 'asset') {
        await wrapper.find('select').setValue(options[1].key)
        await wrapper.find('select').setValue(options[0].key)
        await wrapper
          .find('[data-testid="stealth-amount-input"] input')
          .setValue('1')
      }
      if (field === 'amount') {
        await wrapper
          .find('[data-testid="stealth-amount-input"] input')
          .setValue('2')
        await wrapper
          .find('[data-testid="stealth-amount-input"] input')
          .setValue('1')
      }
      if (field === 'memo') {
        await wrapper
          .find('[data-testid="stealth-memo-input"] input')
          .setValue('changed')
        await wrapper
          .find('[data-testid="stealth-memo-input"] input')
          .setValue('')
      }
      if (field === 'recipient') {
        await wrapper.setProps({ address: 'other' })
        await wrapper.setProps({ address: 'recipient' })
      }
      await wrapper.find('form').trigger('submit')
      expect(wrapper.emitted('send')).toBeUndefined()
      expect(
        wrapper
          .find('[data-testid="stealth-send-confirm-btn"]')
          .attributes('disabled'),
      ).toBeDefined()
    },
  )
  it('rejects stale, mismatched, unavailable and busy quotes without inventing a balance', async () => {
    const wrapper = mountDialog({
      options: options.map(option => ({ ...option, balanceAtomic: undefined })),
    })
    expect(wrapper.find('[data-testid="wallet-balance-value"]').text()).toBe(
      '…',
    )
    const request = await review(wrapper, 2)
    for (const quote of [
      { status: 'pending' },
      { status: 'error', message: 'RPC unavailable' },
      quoteFor({ ...request, amountAtomic: request.amountAtomic + 1n }),
      {
        ...quoteFor(request),
        payment: {
          ...quoteFor(request).payment,
          chainIdentifier: 'xec-testnet',
        },
      },
    ] as StealthDialogQuoteState[]) {
      await wrapper.setProps({ quote })
      await wrapper.find('form').trigger('submit')
    }
    expect(wrapper.emitted('send')).toBeUndefined()
    await wrapper.setProps({ quote: quoteFor(request), busy: true })
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('send')).toBeUndefined()
  })
  it('requires a new quote object after another review instead of approving an old cached quote', async () => {
    const wrapper = mountDialog(),
      request = await review(wrapper)
    await wrapper.setProps({ quote: quoteFor(request) })
    await wrapper.find('[data-testid="stealth-review-btn"]').trigger('click')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('send')).toBeUndefined()
  })
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
      await wrapper.find('[data-testid="stealth-review-btn"]').trigger('click')
    }
    expect(wrapper.emitted('review')).toBeUndefined()
  })
  it('copies confirmed quote public facts and rejects unaffordable fees', async () => {
    const wrapper = mountDialog(),
      request = await review(wrapper, 2)
    const quote = quoteFor(request)
    await wrapper.setProps({
      quote: {
        ...quote,
        payment: { ...quote.payment, nativeBalanceAtomic: 19n },
      },
    })
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('send')).toBeUndefined()
    expect(
      wrapper.find('[data-testid="stealth-insufficient-funds"]').exists(),
    ).toBe(true)
    expect(wrapper.find('[data-testid="stealth-native-balance"]').text()).toBe(
      '0.000000000000000019 MONT',
    )
    await wrapper.setProps({
      quote: {
        ...quote,
        payment: { ...quote.payment, assetBalanceAtomic: 0n },
      },
    })
    expect(wrapper.find('[data-testid="wallet-balance-value"]').text()).toBe(
      '0 USDC',
    )
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('send')).toBeUndefined()
    await wrapper.setProps({ quote })
    await wrapper.find('form').trigger('submit')
    const sent = wrapper.emitted('send')![0][0] as {
      quote: typeof quote.payment
    }
    quote.payment.recipientDestination[0] = 9
    quote.payment.recipientSpendPublicKey[0] = 9
    quote.payment.ephemeralPublicKey[0] = 9
    expect(Array.from(sent.quote.recipientDestination)).toEqual([1])
    expect(Array.from(sent.quote.recipientSpendPublicKey)).toEqual([2])
    expect(Array.from(sent.quote.ephemeralPublicKey)).toEqual([3])
  })
  it('uses selected asset balance and the new uint256 amount boundary', async () => {
    const wrapper = mountDialog()
    const request = await review(wrapper, 0, '19')
    expect(request.amountAtomic).toBe(19n * 10n ** 18n)
    await wrapper.find('select').setValue(options[2].key)
    await wrapper
      .find('[data-testid="stealth-amount-input"] input')
      .setValue('21')
    await wrapper.find('[data-testid="stealth-review-btn"]').trigger('click')
    expect(wrapper.emitted('review')).toHaveLength(1)
  })
})
