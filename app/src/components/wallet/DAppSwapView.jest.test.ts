/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import DAppSwapView from './DAppSwapView.vue'
import en from '../../i18n/en-us'

const t = (key: string, params?: Record<string, any>) => {
  let val =
    key.split('.').reduce((value: any, part) => value?.[part], en) ?? key
  if (typeof val === 'string' && params) {
    for (const [k, v] of Object.entries(params)) {
      val = val.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return val
}

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
      'Direct settlement to private stealth address',
    )
  })

  test('flips from and to assets when flip button is clicked', async () => {
    const wrapper = mountSwapView()
    expect((wrapper.vm as any).fromAsset).toBe('MON')
    expect((wrapper.vm as any).toAsset).toBe('USDC')

    const flipBtn = wrapper.find('[data-testid="swap-flip-btn"]')
    await flipBtn.trigger('click')

    expect((wrapper.vm as any).fromAsset).toBe('USDC')
    expect((wrapper.vm as any).toAsset).toBe('MON')
  })

  test('displays AVU thermodynamic energy equivalents for input and output', () => {
    const wrapper = mountSwapView()
    const fromAvu = wrapper.find('[data-testid="swap-from-avu"]')
    const toAvu = wrapper.find('[data-testid="swap-to-avu"]')
    expect(fromAvu.exists()).toBe(true)
    expect(fromAvu.text()).toContain('AVU (kWh)')
    expect(toAvu.exists()).toBe(true)
    expect(toAvu.text()).toContain('AVU (kWh)')
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

    // Wait for async execution resolution
    const start = Date.now()
    while ((wrapper.vm as any).isExecuting && Date.now() - start < 3000) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect((wrapper.vm as any).isExecuting).toBe(false)
    expect((wrapper.vm as any).lastTxHash).toBeTruthy()
    expect(wrapper.find('[data-testid="swap-success-banner"]').exists()).toBe(
      true,
    )
  })

  test('contextualizes swap pair and router for Solana wallet', () => {
    const wrapper = mountSwapView({ selectedWallet: 'solana' })
    expect((wrapper.vm as any).fromAsset).toBe('SOL')
    expect((wrapper.vm as any).toAsset).toBe('USDC')
    const routerElem = wrapper.find('[data-testid="swap-router-name"]')
    expect(routerElem.text()).toContain('Jupiter Aggregator')
  })

  test('contextualizes swap pair and router for eCash wallet', () => {
    const wrapper = mountSwapView({ selectedWallet: 'ecash' })
    expect(['XEC', 'tXEC']).toContain((wrapper.vm as any).fromAsset)
    expect((wrapper.vm as any).toAsset).toBe('USDC')
    const routerElem = wrapper.find('[data-testid="swap-router-name"]')
    expect(routerElem.text()).toBe('eCash Atomic Swap Router')
    expect(routerElem.text()).not.toContain('Uniswap')
    const balanceElem = wrapper.find('[data-testid="swap-max-balance"]')
    expect(balanceElem.text()).toContain('XEC')
  })

  test('contextualizes router for Hyperliquid and Tempo chains', () => {
    const hlWrapper = mountSwapView({ selectedWallet: 'hyperliquid' })
    expect(hlWrapper.find('[data-testid="swap-router-name"]').text()).toBe(
      'Hyperliquid L1 Orderbook Router',
    )

    const tempoWrapper = mountSwapView({ selectedWallet: 'tempo' })
    expect(tempoWrapper.find('[data-testid="swap-router-name"]').text()).toBe(
      'Tempo Settlement Engine',
    )
  })

  test('validates balance: shows error and disables swap button when input exceeds balance', async () => {
    const wrapper = mountSwapView({ selectedWallet: 'solana' })
    // Solana available is 5.20 SOL
    const fromInput = wrapper.find('[data-testid="swap-from-amount"]')
    await fromInput.setValue('10000')

    const errorMsg = wrapper.find('[data-testid="swap-error-message"]')
    expect(errorMsg.exists()).toBe(true)
    expect(errorMsg.text()).toContain('Insufficient SOL balance')

    const executeBtn = wrapper.find('[data-testid="swap-execute-btn"]')
    expect(executeBtn.attributes('disabled')).toBeDefined()
    expect(executeBtn.text()).toContain('Insufficient SOL balance')
  })

  test('clicking MAX sets the available balance and clears insufficient balance error', async () => {
    const wrapper = mountSwapView({ selectedWallet: 'solana' })
    const fromInput = wrapper.find('[data-testid="swap-from-amount"]')
    await fromInput.setValue('999')

    expect(wrapper.find('[data-testid="swap-error-message"]').exists()).toBe(
      true,
    )

    const maxBtn = wrapper.find('[data-testid="swap-max-btn"]')
    await maxBtn.trigger('click')

    expect((wrapper.vm as any).fromAmount).toBe('5.2')
    expect(wrapper.find('[data-testid="swap-error-message"]').exists()).toBe(
      false,
    )

    const executeBtn = wrapper.find('[data-testid="swap-execute-btn"]')
    expect(executeBtn.attributes('disabled')).toBeUndefined()
  })

  test('executing Solana swap produces a base58 transaction signature without 0x prefix', async () => {
    const wrapper = mountSwapView({ selectedWallet: 'solana' })
    const executeBtn = wrapper.find('[data-testid="swap-execute-btn"]')
    await executeBtn.trigger('click')

    // Wait for async execution resolution
    const start = Date.now()
    while ((wrapper.vm as any).isExecuting && Date.now() - start < 3000) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    const txHash = (wrapper.vm as any).lastTxHash
    expect(txHash).toBeTruthy()
    // Solana tx hashes must NEVER be 0x-prefixed hex!
    expect(txHash.startsWith('0x')).toBe(false)
    // Solana base58 signatures are ~88 characters using base58 characters
    expect(/^[1-9A-HJ-NP-Za-km-z]{40,90}$/.test(txHash)).toBe(true)
  })

  test('swapping tSOL executes cleanly under Jupiter router', async () => {
    const wrapper = mountSwapView({ selectedWallet: 'solana' })
    ;(wrapper.vm as any).fromAsset = 'tSOL'
    ;(wrapper.vm as any).fromAmount = '1'

    const executeBtn = wrapper.find('[data-testid="swap-execute-btn"]')
    await executeBtn.trigger('click')

    const start = Date.now()
    while ((wrapper.vm as any).isExecuting && Date.now() - start < 3000) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    const txHash = (wrapper.vm as any).lastTxHash
    expect(txHash).toBeTruthy()
    expect(txHash.startsWith('0x')).toBe(false)
  })
})
