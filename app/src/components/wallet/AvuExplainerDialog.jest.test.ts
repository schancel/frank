/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import AvuExplainerDialog from './AvuExplainerDialog.vue'
import en from '../../i18n/en-us'
import { createPinia, setActivePinia } from 'pinia'
import { useOracleStore } from '../../stores/oracle'

const t = (key: string) =>
  key.split('.').reduce((value: any, part) => value?.[part], en) ?? key

function mountDialog(props = {}) {
  return mount(AvuExplainerDialog, {
    props: {
      modelValue: true,
      ...props,
    },
    global: {
      mocks: { $t: t },
      stubs: {
        QDialog: {
          props: ['modelValue'],
          template:
            '<div v-if="modelValue" data-test="dialog-stub"><slot /></div>',
        },
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
        QCardActions: { template: '<div><slot /></div>' },
        QAvatar: { template: '<div class="avatar-stub"><slot /></div>' },
        QIcon: { template: '<i class="icon-stub" />' },
        QSpace: { template: '<span />' },
        QMarkupTable: { template: '<table><slot /></table>' },
        QBtn: {
          props: ['label', 'disable'],
          template:
            '<button :disabled="disable" @click="$emit(\'click\')">{{ label }}<slot /></button>',
        },
      },
    },
  })
}

describe('AvuExplainerDialog component', () => {
  test('renders dialog when modelValue is true and displays core concepts', () => {
    const wrapper = mountDialog()
    expect(wrapper.find('[data-test="avu-explainer-card"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Arbitrary Value Unit (AVU)')
    expect(wrapper.text()).toContain('1 AVU ≡ 1 Kilowatt-Hour (kWh)')
    expect(wrapper.text()).toContain('Refusing the USD Meme')
    expect(wrapper.text()).toContain('The Root of Every Supply Chain')
    expect(wrapper.text()).toContain('Bypassing the CPI')
    expect(wrapper.text()).toContain('Truly "Oracle-Less"')
  })

  test('with no fetched prices every coin row says unavailable: nothing stands in for a price', () => {
    setActivePinia(createPinia())
    const wrapper = mountDialog()
    for (const asset of [
      'monad',
      'solana',
      'ethereum',
      'hyperliquid',
      'ecash',
      'bitcoin',
    ]) {
      const row = wrapper.find(`[data-test="avu-rate-row-${asset}"]`).text()
      expect(row).toContain('Unavailable')
      expect(row).not.toContain('≈')
      expect(row).not.toContain('$')
    }
  })

  test('shows the fetched price of each coin, in AVU and in dollars', () => {
    setActivePinia(createPinia())
    const oracle = useOracleStore()
    oracle.snapshot.prices.solana = 110.06
    oracle.snapshot.rates.solana = 110.06 / 0.084
    oracle.snapshot.fetchedAt.solana = Date.now()
    const row = mountDialog().find('[data-test="avu-rate-row-solana"]').text()
    expect(row).toContain('1 SOL ≈ 1,310.24 AVU')
    expect(row).toContain('$110.060')
  })

  test('lists no row for a coin without a price source, and none for AVU itself', () => {
    setActivePinia(createPinia())
    const wrapper = mountDialog()
    expect(wrapper.find('[data-test="avu-rate-row-tempo"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('[data-test="avu-rate-row-avu"]').exists()).toBe(false)
    // The dollar row states the unit: a fixed number, not a market price.
    expect(wrapper.find('[data-test="avu-rate-row-usd"]').text()).toContain(
      '1 USD = 11.90 AVU',
    )
  })

  test('does not render when modelValue is false', () => {
    const wrapper = mountDialog({ modelValue: false })
    expect(wrapper.find('[data-test="avu-explainer-card"]').exists()).toBe(
      false,
    )
  })

  test('emits update:modelValue with false when close button is clicked', async () => {
    const wrapper = mountDialog()
    const closeBtn = wrapper.find('[data-test="avu-dialog-close-btn"]')
    expect(closeBtn.exists()).toBe(true)
    await closeBtn.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
  })
})
