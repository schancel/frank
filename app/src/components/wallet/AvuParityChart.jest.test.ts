/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import AvuParityChart from './AvuParityChart.vue'
import en from '../../i18n/en-us'

const t = (key: string) =>
  key.split('.').reduce((value: any, part) => value?.[part], en) ?? key

function mountChart(
  options: { isDark?: boolean; selectedWallet?: string } = {},
) {
  const isDarkVal = options.isDark ?? false
  return mount(AvuParityChart, {
    props: {
      selectedWallet: options.selectedWallet ?? 'monad',
    },
    global: {
      mocks: {
        $t: (key: string, params?: Record<string, string>) => {
          let str = t(key)
          if (params) {
            for (const [k, v] of Object.entries(params)) {
              str = str.replace(`{${k}}`, v)
            }
          }
          return str
        },
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
        QBtn: {
          props: ['label', 'icon'],
          emits: ['click'],
          template:
            '<button class="q-btn-stub" @click="$emit(\'click\')"><slot />{{ label }}</button>',
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

    // 0. Active Token Rate (default Monad)
    const tokenCard = wrapper.find('[data-test="metric-card-token-rate"]')
    expect(tokenCard.exists()).toBe(true)
    expect(tokenCard.text()).toContain('Monad (MON) Parity')
    expect(tokenCard.text()).toContain('41.67 AVU')
    expect(tokenCard.text()).toContain('1 MON ≈ 41.67 kWh')
    expect(tokenCard.find('.q-tooltip-stub').text()).toContain(
      '1 AVU ≡ 1 kWh (3.6 MJ) of physical compute',
    )

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

  test('specializes active token card and legend when selectedWallet prop changes', () => {
    const ethWrapper = mountChart({ selectedWallet: 'ethereum' })
    const tokenCard = ethWrapper.find('[data-test="metric-card-token-rate"]')
    expect(tokenCard.text()).toContain('Ethereum (ETH) Parity')
    expect(tokenCard.text()).toContain('30,952.38 AVU')
    expect(tokenCard.text()).toContain('1 ETH ≈ 30952.38 kWh')

    const legend = ethWrapper.find('[data-test="chart-legend-token"]')
    expect(legend.text()).toContain('Ethereum (AVU / kWh)')
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
    expect(wrapper.find('[data-test="macro-token-line"]').exists()).toBe(true)

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
    expect(tooltip.text()).toContain('MON: 41.7 AVU (kWh)')
  })

  test('renders standard timeframe preset options (all, 5y, 1y, 30d, 7d, 24h, networks)', () => {
    const wrapper = mountChart()
    const options = ['all', '5y', '1y', '30d', '7d', '24h', 'networks']
    for (const opt of options) {
      expect(wrapper.find(`button[data-test-option="${opt}"]`).exists()).toBe(
        true,
      )
    }
  })

  test('supports 5Y timeframe selection and displays modern hardware milestones', async () => {
    const wrapper = mountChart()

    // Switch to '5y' range
    const btn5Y = wrapper.find('button[data-test-option="5y"]')
    expect(btn5Y.exists()).toBe(true)
    await btn5Y.trigger('click')

    // Points from 2021 to 2026 (6 points)
    const points = wrapper.findAll('[data-test="chart-hover-point"]')
    expect(points.length).toBe(6)

    // Verify 2024 3nm milestone rendered
    const milestones = wrapper.findAll(
      '[data-test="hardware-milestone-marker"]',
    )
    expect(milestones.length).toBe(1) // 3nm Ultra in 2024

    await milestones[0].trigger('mouseenter')
    const milestoneTooltip = wrapper.find('[data-test="milestone-tooltip"]')
    expect(milestoneTooltip.exists()).toBe(true)
    expect(milestoneTooltip.text()).toContain('2024: 3nm Ultra')
    expect(milestoneTooltip.text()).toContain('16 J/TH')
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

  test('supports 24H fine-grained hourly view, validates tooltips, and verifies PoW green line does not clip below axis', async () => {
    const wrapper = mountChart()

    // Switch to '24h' view
    const btn24h = wrapper.find('button[data-test-option="24h"]')
    expect(btn24h.exists()).toBe(true)
    await btn24h.trigger('click')

    // Milestones are suppressed in fine-grained view
    expect(
      wrapper.findAll('[data-test="hardware-milestone-marker"]').length,
    ).toBe(0)

    // Exactly 24 hourly data points are rendered
    const points = wrapper.findAll('[data-test="chart-hover-point"]')
    expect(points.length).toBe(24)

    // Hover over the final (current hour / "Now") point
    const nowPoint = points[points.length - 1]
    await nowPoint.trigger('mouseenter')

    const tooltip = wrapper.find('[data-test="chart-tooltip"]')
    expect(tooltip.exists()).toBe(true)
    expect(tooltip.text()).toContain('Now')
    expect(tooltip.text()).toContain('MON: 41.7 AVU (kWh)')
    expect(tooltip.text()).toContain('USD: 12.0 kWh/$')
    expect(tooltip.text()).toContain('Gold: 31,547 AVU/oz')
    expect(tooltip.text()).toContain('PoW: 11.9 kWh/$')

    // Hover over an intermediate point (e.g. 11 hours ago)
    const midPoint = points[12]
    await midPoint.trigger('mouseenter')
    expect(tooltip.text()).toContain('-11h')

    // Verify PoW green line and USD line stay strictly within chart boundaries (y between 20 and 230)
    // This directly regression tests the fix for the PoW line clipping below the bottom axis
    const vm = wrapper.vm as any
    const mappedPts = vm.macroPointsMapped
    expect(mappedPts.length).toBe(24)
    for (const pt of mappedPts) {
      if (pt.powY !== null) {
        expect(pt.powY).toBeGreaterThanOrEqual(20)
        expect(pt.powY).toBeLessThanOrEqual(230)
      }
      expect(pt.usdY).toBeGreaterThanOrEqual(20)
      expect(pt.usdY).toBeLessThanOrEqual(230)
    }
  })

  test('supports 7D, 30D, and 1Y sub-annual resolution timeframes', async () => {
    const wrapper = mountChart()

    // 7D view: 28 points
    await wrapper.find('button[data-test-option="7d"]').trigger('click')
    expect(wrapper.findAll('[data-test="chart-hover-point"]').length).toBe(28)

    // 30D view: 30 points
    await wrapper.find('button[data-test-option="30d"]').trigger('click')
    expect(wrapper.findAll('[data-test="chart-hover-point"]').length).toBe(30)

    // 1Y view: 12 points
    await wrapper.find('button[data-test-option="1y"]').trigger('click')
    expect(wrapper.findAll('[data-test="chart-hover-point"]').length).toBe(12)
  })

  test('supports click-and-drag box zoom on SVG canvas and reset zoom controls', async () => {
    const wrapper = mountChart()

    // Switch to 24h view with 24 points
    await wrapper.find('button[data-test-option="24h"]').trigger('click')
    expect(wrapper.findAll('[data-test="chart-hover-point"]').length).toBe(24)

    const svg = wrapper.find('[data-test="macro-chart-svg"]')
    expect(svg.exists()).toBe(true)

    // Mock getBoundingClientRect in jsdom
    ;(svg.element as any).getBoundingClientRect = () => ({
      width: 680,
      height: 290,
      top: 0,
      left: 0,
      bottom: 290,
      right: 680,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    })

    // Initially, no drag selection box and no reset button
    expect(wrapper.find('[data-test="drag-selection-box"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(false)

    // 1. Mouse down at x=150, y=100
    await svg.trigger('mousedown', { clientX: 150, clientY: 100 })

    // 2. Mouse move to x=400, y=100
    await svg.trigger('mousemove', { clientX: 400, clientY: 100 })
    const box = wrapper.find('[data-test="drag-selection-box"]')
    expect(box.exists()).toBe(true)
    expect(box.attributes('x')).toBe('150')
    expect(box.attributes('width')).toBe('250')

    // 3. Mouse up to apply zoom
    await svg.trigger('mouseup')
    expect(wrapper.find('[data-test="drag-selection-box"]').exists()).toBe(
      false,
    )

    // Reset Zoom button should now be visible
    const resetBtn = wrapper.find('[data-test="reset-zoom-btn"]')
    expect(resetBtn.exists()).toBe(true)
    expect(resetBtn.text()).toContain('Reset Zoom')

    // Zoomed points count should be less than the full 24 points
    const zoomedCount = wrapper.findAll(
      '[data-test="chart-hover-point"]',
    ).length
    expect(zoomedCount).toBeLessThan(24)
    expect(zoomedCount).toBeGreaterThanOrEqual(2)

    // 4. Click Reset Zoom button
    await resetBtn.trigger('click')
    expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-test="chart-hover-point"]').length).toBe(24)

    // 5. Test double click resets zoom
    await svg.trigger('mousedown', { clientX: 150, clientY: 100 })
    await svg.trigger('mousemove', { clientX: 350, clientY: 100 })
    await svg.trigger('mouseup')
    expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(true)

    await svg.trigger('dblclick')
    expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-test="chart-hover-point"]').length).toBe(24)

    // 6. Test switching timeframe preset resets zoom
    await svg.trigger('mousedown', { clientX: 150, clientY: 100 })
    await svg.trigger('mousemove', { clientX: 350, clientY: 100 })
    await svg.trigger('mouseup')
    expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(true)

    await wrapper.find('button[data-test-option="7d"]').trigger('click')
    expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-test="chart-hover-point"]').length).toBe(28)
  })

  test('renders methodology & data sources citations card with live feeds references', () => {
    const wrapper = mountChart()
    const sourcesCard = wrapper.find('[data-test="chart-sources"]')
    expect(sourcesCard.exists()).toBe(true)
    expect(sourcesCard.text()).toContain('Methodology & Data Sources')
    expect(sourcesCard.text()).toContain('CoinGecko & Pyth Network')
    expect(sourcesCard.text()).toContain('Historical & Intraday Resolution')
    expect(sourcesCard.text()).toContain(
      'Energy Information Administration (EIA)',
    )
    expect(sourcesCard.text()).toContain('PoW Baseline')
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
