/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import AvuParityChart from './AvuParityChart.vue'
import en from '../../i18n/en-us'

const t = (key: string) =>
  key.split('.').reduce((value: any, part) => value?.[part], en) ?? key

function mountChart(options: { isDark?: boolean } = {}) {
  const isDarkVal = options.isDark ?? false
  return mount(AvuParityChart, {
    global: {
      mocks: {
        $t: t,
        $q: {
          dark: { isActive: isDarkVal },
        },
      },
      provide: {
        _q_: {
          dark: { isActive: isDarkVal },
        },
      },
      stubs: {
        QCard: {
          template: '<div class="q-card-stub"><slot /></div>',
        },
        QCardSection: {
          template: '<div class="q-card-section-stub"><slot /></div>',
        },
        QIcon: {
          props: ['name'],
          template: '<i :class="name" class="q-icon-stub" />',
        },
        QTooltip: {
          template: '<div class="q-tooltip-stub"><slot /></div>',
        },
        QBtnToggle: {
          props: ['modelValue', 'options'],
          emits: ['update:modelValue'],
          template: `
            <div class="q-btn-toggle-stub">
              <button
                v-for="opt in options"
                :key="opt.value"
                :data-test-option="opt.value"
                :class="{ active: modelValue === opt.value }"
                @click="$emit('update:modelValue', opt.value)"
              >
                {{ opt.label }}
              </button>
            </div>
          `,
        },
      },
    },
  })
}

describe('AvuParityChart component', () => {
  test('renders top metrics cards with values and universal AVU tooltips', () => {
    const wrapper = mountChart()
    expect(wrapper.find('[data-test="avu-parity-chart"]').exists()).toBe(true)

    // 1. AVU Hash
    const avuHashCard = wrapper.find('[data-test="metric-card-avu-hash"]')
    expect(avuHashCard.exists()).toBe(true)
    expect(avuHashCard.text()).toContain('AVU (Hash-Derived)')
    expect(avuHashCard.text()).toContain('11.90 AVU/$')
    expect(avuHashCard.text()).toContain('11.90 kWh/$')
    expect(avuHashCard.find('.q-tooltip-stub').text()).toContain(
      '1 AVU ≡ 1 kWh (3.6 MJ) of physical compute',
    )

    // 2. AVU Spot
    const avuSpotCard = wrapper.find('[data-test="metric-card-avu-spot"]')
    expect(avuSpotCard.exists()).toBe(true)
    expect(avuSpotCard.text()).toContain('AVU (Grid Spot)')
    expect(avuSpotCard.text()).toContain('12.20 AVU/$')
    expect(avuSpotCard.text()).toContain('12.20 kWh/$')
    expect(avuSpotCard.find('.q-tooltip-stub').text()).toContain(
      '1 AVU ≡ 1 kWh (3.6 MJ) of physical compute',
    )

    // 3. TPI
    const tpiCard = wrapper.find('[data-test="metric-card-tpi"]')
    expect(tpiCard.exists()).toBe(true)
    expect(tpiCard.text()).toContain('Thermodynamic Parity Index (TPI)')
    expect(tpiCard.text()).toContain('1.02')
    expect(tpiCard.text()).toContain('TPI ≈ 1.00')

    // 4. Arbitrage Margin
    const arbCard = wrapper.find('[data-test="metric-card-arbitrage"]')
    expect(arbCard.exists()).toBe(true)
    expect(arbCard.text()).toContain('Mining Arbitrage Spread')
    expect(arbCard.text()).toContain('+67.8%')
    expect(arbCard.text()).toContain('eCash Yield Premium')
  })

  test('defaults to all-time view and renders time-series SVG with interactive points', async () => {
    const wrapper = mountChart()
    expect(wrapper.find('[data-test="macro-chart-container"]').exists()).toBe(
      true,
    )
    expect(wrapper.find('[data-test="macro-chart-svg"]').exists()).toBe(true)
    expect(
      wrapper.find('[data-test="networks-chart-container"]').exists(),
    ).toBe(false)

    // Verify macro data points rendered
    const points = wrapper.findAll('[data-test="chart-hover-point"]')
    expect(points.length).toBeGreaterThan(5)

    // Hover tooltip initially absent
    expect(wrapper.find('[data-test="chart-tooltip"]').exists()).toBe(false)

    // Trigger hover on last data point (2026)
    const point2026 = points[points.length - 1]
    await point2026.trigger('mouseenter')

    const tooltip = wrapper.find('[data-test="chart-tooltip"]')
    expect(tooltip.exists()).toBe(true)
    expect(tooltip.text()).toContain('2026')
    expect(tooltip.text()).toContain('USD: 12.0 kWh/$')
    expect(tooltip.text()).toContain('Gold: 31,547 AVU/oz')
    expect(tooltip.text()).toContain('PoW: 11.9 kWh/$')
  })

  test('supports PoW Era and Modern ASIC time range selections with milestone markers', async () => {
    const wrapper = mountChart()

    // Switch to 'pow' range
    const powBtn = wrapper.find('button[data-test-option="pow"]')
    expect(powBtn.exists()).toBe(true)
    await powBtn.trigger('click')

    // Verify milestones rendered
    const milestones = wrapper.findAll(
      '[data-test="hardware-milestone-marker"]',
    )
    expect(milestones.length).toBe(6) // CPU, GPU, Early ASIC, Mature 16nm, 7nm, 3nm

    // Hover on first milestone (CPU)
    await milestones[0].trigger('mouseenter')
    const milestoneTooltip = wrapper.find('[data-test="milestone-tooltip"]')
    expect(milestoneTooltip.exists()).toBe(true)
    expect(milestoneTooltip.text()).toContain('2009: CPU Mining')
    expect(milestoneTooltip.text()).toContain('~10 MJ/GH')

    // Switch to 'asic' range (>= 2020)
    const asicBtn = wrapper.find('button[data-test-option="asic"]')
    expect(asicBtn.exists()).toBe(true)
    await asicBtn.trigger('click')

    const asicMilestones = wrapper.findAll(
      '[data-test="hardware-milestone-marker"]',
    )
    expect(asicMilestones.length).toBe(2) // 7nm in 2020 and 3nm in 2024
  })

  test('toggles to network parity view and renders comparison bar chart with arbitrage spread', async () => {
    const wrapper = mountChart()

    // Switch view to 'networks'
    const networksBtn = wrapper.find('button[data-test-option="networks"]')
    expect(networksBtn.exists()).toBe(true)
    await networksBtn.trigger('click')

    expect(wrapper.find('[data-test="macro-chart-container"]').exists()).toBe(
      false,
    )
    expect(
      wrapper.find('[data-test="networks-chart-container"]').exists(),
    ).toBe(true)
    expect(wrapper.find('[data-test="networks-chart-svg"]').exists()).toBe(true)

    // Verify 5 network bars
    const bars = wrapper.findAll('[data-test="chart-hover-bar"]')
    expect(bars.length).toBe(5) // BTC, XEC, BCH, LTC, KAS

    // Check XEC bar highlight & yield
    const barTexts = bars.map(b => b.text())
    expect(barTexts.some(t => t.includes('XEC') && t.includes('+67.8%'))).toBe(
      true,
    )
    expect(barTexts.some(t => t.includes('BTC') && t.includes('$0.084'))).toBe(
      true,
    )

    // Hover over XEC bar
    const xecBar = bars[1]
    await xecBar.trigger('mouseenter')

    const tooltip = wrapper.find('[data-test="chart-tooltip"]')
    expect(tooltip.exists()).toBe(true)
    expect(tooltip.text()).toContain('XEC (SHA-256)')
    expect(tooltip.text()).toContain('Energy Cost: $0.141/kWh')
    expect(tooltip.text()).toContain('Arbitrage Yield: +67.8%')
  })

  test('renders methodology & data sources citations card', () => {
    const wrapper = mountChart()
    const sourcesCard = wrapper.find('[data-test="chart-sources"]')
    expect(sourcesCard.exists()).toBe(true)
    expect(sourcesCard.text()).toContain('Methodology & Data Sources')
    expect(sourcesCard.text()).toContain(
      'Energy Information Administration (EIA)',
    )
    expect(sourcesCard.text()).toContain('PoW Hashrate')
    expect(sourcesCard.text()).toContain('CBECI')
  })

  test('supports dark mode and applies dark styling', () => {
    const darkWrapper = mountChart({ isDark: true })
    expect(
      darkWrapper.find('[data-test="metric-card-avu-hash"]').classes(),
    ).toContain('bg-dark')

    const lightWrapper = mountChart({ isDark: false })
    expect(
      lightWrapper.find('[data-test="metric-card-avu-hash"]').classes(),
    ).toContain('bg-white')
  })
})
