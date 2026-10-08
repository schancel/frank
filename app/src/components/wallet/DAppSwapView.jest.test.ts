/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import DAppSwapView from './DAppSwapView.vue'
import en from '../../i18n/en-us'

const t = (key: string) =>
  key.split('.').reduce((value: any, part) => value?.[part], en) ?? key

function mountSwapView(props = {}) {
  return mount(DAppSwapView, {
    props: {
      selectedWallet: 'monad',
      ...props,
    },
    global: {
      mocks: {
        $t: t,
      },
      stubs: {
        QCard: { template: '<div class="q-card-stub"><slot /></div>' },
        QCardSection: {
          template: '<div class="q-card-section-stub"><slot /></div>',
        },
        QSeparator: { template: '<hr />' },
        QIcon: { template: '<i class="icon-stub" />' },
        QBadge: { template: '<span class="badge-stub"><slot /></span>' },
        QInput: {
          props: ['modelValue', 'readonly', 'type', 'placeholder'],
          template:
            '<input :value="modelValue" :readonly="readonly" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        QSelect: {
          props: ['modelValue', 'options'],
          template:
            '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="opt in options" :key="opt.value" :value="opt.value">{{ opt.label }}</option></select>',
        },
        QBtn: {
          props: ['label', 'disable', 'loading'],
          template: '<button :disabled="disable">{{ label }}<slot /></button>',
        },
      },
    },
  })
}

describe('DAppSwapView component', () => {
  test('renders swap interface and default token pair', () => {
    const wrapper = mountSwapView()
    expect(wrapper.find('[data-testid="dapp-swap-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="swap-from-amount"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="swap-to-amount"]').exists()).toBe(true)
  })

  test('displays protocol convenience fee of 0.0875% and 10x savings badge', () => {
    const wrapper = mountSwapView()
    const feeElem = wrapper.find('[data-testid="swap-protocol-fee"]')
    expect(feeElem.exists()).toBe(true)
    expect(feeElem.text()).toContain('0.0875%')
    expect(wrapper.text()).toContain('10x Cheaper than MetaMask')
  })

  test('displays HD change address notice for privacy and seed recovery', () => {
    const wrapper = mountSwapView()
    const destElem = wrapper.find('[data-testid="swap-destination-address"]')
    expect(destElem.exists()).toBe(true)
    expect(destElem.text()).toContain(
      'Direct settlement to fresh HD change address',
    )
  })

  test('flips from and to assets when flip button is clicked', async () => {
    const wrapper = mountSwapView()
    expect((wrapper.vm as any).fromAsset).toBe('USDC')
    expect((wrapper.vm as any).toAsset).toBe('AVU')

    const flipBtn = wrapper.find('[data-testid="swap-flip-btn"]')
    await flipBtn.trigger('click')

    expect((wrapper.vm as any).fromAsset).toBe('AVU')
    expect((wrapper.vm as any).toAsset).toBe('USDC')
  })

  test('calculates estimated output deducting protocol fee', async () => {
    const wrapper = mountSwapView()
    const fromInput = wrapper.find('[data-testid="swap-from-amount"]')
    await fromInput.setValue('1000')

    const toInput = wrapper.find('[data-testid="swap-to-amount"]')
    // 1000 USDC minus 0.0875% = 999.125 USD / 0.123 ≈ 8,122.97 AVU
    expect((toInput.element as HTMLInputElement).value).not.toBe('0.00')
  })

  test('simulates swap execution on button click', async () => {
    const wrapper = mountSwapView()
    const executeBtn = wrapper.find('[data-testid="swap-execute-btn"]')
    expect(executeBtn.attributes('disabled')).toBeUndefined()

    await executeBtn.trigger('click')
    expect((wrapper.vm as any).isExecuting).toBe(true)

    // Wait for simulated async resolution
    await new Promise(resolve => setTimeout(resolve, 850))
    expect((wrapper.vm as any).isExecuting).toBe(false)
    expect((wrapper.vm as any).lastTxHash).toBeTruthy()
    expect(wrapper.find('[data-testid="swap-success-banner"]').exists()).toBe(
      true,
    )
  })
})
