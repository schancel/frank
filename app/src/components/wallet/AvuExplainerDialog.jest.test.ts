/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import AvuExplainerDialog from './AvuExplainerDialog.vue'
import en from '../../i18n/en-us'
import { createPinia, setActivePinia } from 'pinia'
import { useOracleStore } from '../../stores/oracle'
import { mergeFeed, oracleInputs } from '../../stores/oracle-series'
import { testFeed } from '../../stores/oracle-test-feed'
import { computeOracleRates } from '@frank/wallet/oracle'

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

  test('with nothing received every coin row says unavailable: nothing stands in for a rate', () => {
    setActivePinia(createPinia())
    const wrapper = mountDialog()
    for (const asset of ['monad', 'solana', 'ethereum', 'ecash', 'bitcoin']) {
      expect(
        wrapper.find(`[data-test="avu-rate-row-${asset}"]`).text(),
      ).toContain('Unavailable')
    }
  })

  test('shows what one coin is worth in AVU, and no dollar figure anywhere in the table', () => {
    setActivePinia(createPinia())
    const oracle = useOracleStore()
    const now = Math.floor(Date.now() / 1000)
    // AVU_hash 10 kWh per unit of value; SOL priced 110, XEC 0.00001.
    const cache = mergeFeed(
      oracle.cache,
      testFeed([now], {
        prices: { 'solana-mainnet': 110, 'xec-mainnet': 0.00001 },
      }),
      now,
    )
    oracle.$patch({
      cache,
      current: computeOracleRates(oracleInputs(cache)!, now),
    })
    const wrapper = mountDialog()
    expect(wrapper.find('[data-test="avu-rate-row-solana"]').text()).toContain(
      '1 SOL ≈ 1.1 kAVU · testnet',
    )
    // eCash is quoted per million coins: 1,000,000 x 0.00001 x 10 = 100 AVU.
    expect(wrapper.find('[data-test="avu-rate-row-ecash"]').text()).toContain(
      '1M XEC ≈ 100 AVU · testnet',
    )
    expect(
      wrapper.find('[data-test="avu-rate-row-ethereum"]').text(),
    ).toContain('Unavailable')
    const table = wrapper.find('[data-test="avu-rates-table"]').text()
    // ("1 TUSD" is the Tempo test coin's own unit, not a dollar valuation.)
    expect(table).not.toMatch(/\$|\bUSD\b/)
    expect(wrapper.find('[data-test="avu-rate-row-usd"]').exists()).toBe(false)
  })

  test('emits update:modelValue when closed', async () => {
    const wrapper = mountDialog()
    const close = wrapper
      .findAll('button')
      .find(button => button.text().includes('Close'))
    await close?.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
  })
})
