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

  test('supports turning metrics on and off on the overlay and dynamically auto-scales to avoid distortion', async () => {
    const wrapper = mountChart()

    // Initially, all metrics are on
    const goldToggle = wrapper.find('[data-test="toggle-metric-gold"]')
    const usdToggle = wrapper.find('[data-test="toggle-metric-usd"]')
    const powToggle = wrapper.find('[data-test="toggle-metric-pow"]')
    const tokenToggle = wrapper.find('[data-test="chart-legend-token"]')
    const milestoneToggle = wrapper.find(
      '[data-test="toggle-metric-milestones"]',
    )

    expect(goldToggle.exists()).toBe(true)
    expect(usdToggle.exists()).toBe(true)
    expect(powToggle.exists()).toBe(true)
    expect(tokenToggle.exists()).toBe(true)
    expect(milestoneToggle.exists()).toBe(true)

    // Verify Gold and right axis are initially visible
    expect((wrapper.vm as any).showGold).toBe(true)
    expect((wrapper.vm as any).hasRightAxis).toBe(true)

    // 1. Toggle Gold OFF
    await goldToggle.trigger('click')
    expect((wrapper.vm as any).showGold).toBe(false)
    expect((wrapper.vm as any).hasRightAxis).toBe(false)

    // Hover last point (2026): Tooltip should NOT contain Gold
    const points = wrapper.findAll('[data-test="chart-hover-point"]')
    const point2026 = points[points.length - 1]
    await point2026.trigger('mouseenter')

    const tooltip = wrapper.find('[data-test="chart-tooltip"]')
    expect(tooltip.exists()).toBe(true)
    expect(tooltip.text()).not.toContain('Gold:')
    expect(tooltip.text()).toContain('USD: 12.0 kWh/$')
    expect(tooltip.text()).toContain('PoW: 11.9 kWh/$')

    // 2. Toggle Gold back ON
    await goldToggle.trigger('click')
    expect((wrapper.vm as any).showGold).toBe(true)
    expect((wrapper.vm as any).hasRightAxis).toBe(true)
    await point2026.trigger('mouseenter')
    expect(wrapper.find('[data-test="chart-tooltip"]').text()).toContain(
      'Gold:',
    )

    // 3. Toggle Token OFF
    expect(wrapper.find('[data-test="macro-token-line"]').exists()).toBe(true)
    await tokenToggle.trigger('click')
    expect((wrapper.vm as any).showToken).toBe(false)
    expect(wrapper.find('[data-test="macro-token-line"]').exists()).toBe(false)

    // 4. Toggle Milestones OFF
    expect(
      wrapper.findAll('[data-test="hardware-milestone-marker"]').length,
    ).toBeGreaterThan(0)
    await milestoneToggle.trigger('click')
    expect((wrapper.vm as any).showMilestones).toBe(false)
    expect(
      wrapper.findAll('[data-test="hardware-milestone-marker"]').length,
    ).toBe(0)

    // 5. Dynamic auto-scaling: In 5Y view with USD + PoW active, scale adapts to 20 instead of 150
    await wrapper.find('button[data-test-option="5y"]').trigger('click')
    // With token toggled off, max scales to 20!
    expect((wrapper.vm as any).usdMaxLimit).toBe(20)
  })

  test('provides dense sub-annual monthly resolution when zooming into recent years (2024-2026) for Solana, USD, Gold, and PoW', async () => {
    const wrapper = mountChart({ selectedWallet: 'solana' })
    const vm = wrapper.vm as any

    // Verify 2025 historical rate is defined for Solana
    expect(vm.activeTokenInfo.history[2025]).toBe(1950.0)

    // Trigger custom drag-zoom into recent years (2024 to 2026)
    vm.customZoomRange = {
      startIndex: 94,
      endIndex: 96,
      startYear: 2024,
      endYear: 2026,
    }
    await wrapper.vm.$nextTick()

    // Sub-annual monthly resolution produces 28 monthly data points instead of 3 coarse 1-year points
    const points = wrapper.findAll('[data-test="chart-hover-point"]')
    expect(points.length).toBe(28)

    // Check November 2024 data point (index 10)
    const nov2024Point = points[10]
    await nov2024Point.trigger('mouseenter')

    const tooltip = wrapper.find('[data-test="chart-tooltip"]')
    expect(tooltip.exists()).toBe(true)
    expect(tooltip.text()).toContain('Nov 2024')
    expect(tooltip.text()).toContain('SOL: 3,000 AVU (kWh)')
    expect(tooltip.text()).toContain('USD: 12.6 kWh/$')
    expect(tooltip.text()).toContain('Gold: 33,500 AVU/oz')
    expect(tooltip.text()).toContain('PoW: 11.7 kWh/$')

    // Check January 2025 point (index 12)
    const jan2025Point = points[12]
    await jan2025Point.trigger('mouseenter')
    expect(tooltip.text()).toContain('Jan 2025')
    expect(tooltip.text()).toContain('SOL: 2,770 AVU (kWh)')

    // Check latest point (index 27)
    const apr2026Point = points[27]
    await apr2026Point.trigger('mouseenter')
    expect(tooltip.text()).toContain('Apr 2026')
    expect(tooltip.text()).toContain('SOL: 1,785.7 AVU (kWh)')
    expect(tooltip.text()).toContain('USD: 12.0 kWh/$')
    expect(tooltip.text()).toContain('Gold: 31,547 AVU/oz')
    expect(tooltip.text()).toContain('PoW: 11.9 kWh/$')
  })

  test('dynamically recalibrates right axis scale for Solana when Gold is toggled off', async () => {
    const wrapper = mountChart({ selectedWallet: 'solana' })
    const vm = wrapper.vm as any

    // Zoom into 2024-2026
    vm.customZoomRange = {
      startIndex: 94,
      endIndex: 96,
      startYear: 2024,
      endYear: 2026,
    }
    await wrapper.vm.$nextTick()

    // Initially with Gold ON, right axis limit is Gold ceiling (35,000)
    expect(vm.showGold).toBe(true)
    expect(vm.goldMaxLimit).toBe(35000)

    // Toggle Gold OFF: scale recalibrates down to Solana's actual range (~3,500)
    const goldToggle = wrapper.find('[data-test="toggle-metric-gold"]')
    await goldToggle.trigger('click')

    expect(vm.showGold).toBe(false)
    expect(vm.hasRightAxis).toBe(true) // right axis stays visible for Solana
    expect(vm.goldMaxLimit).toBeLessThanOrEqual(4000)
    expect(vm.goldMaxLimit).toBeGreaterThanOrEqual(3000)
    expect(vm.goldMaxLabel).toContain('3.') // e.g. 3.5k
  })

  test('renders stable inspection table above chart and dynamically maps asset prices to the hovered date', async () => {
    const wrapper = mountChart()

    // 1. Stable inspection table exists
    const table = wrapper.find('[data-test="chart-inspection-table"]')
    expect(table.exists()).toBe(true)

    // 2. Defaults to latest values when not hovering
    const dateBadge = wrapper.find('[data-test="inspection-date-badge"]')
    expect(dateBadge.exists()).toBe(true)
    expect(dateBadge.text()).toContain('2026')

    const usdVal = wrapper.find('[data-test="inspection-usd-value"]')
    const goldVal = wrapper.find('[data-test="inspection-gold-value"]')
    const powVal = wrapper.find('[data-test="inspection-pow-value"]')
    const tokenVal = wrapper.find('[data-test="inspection-token-value"]')

    expect(usdVal.text()).toBe('12.0 kWh/$')
    expect(goldVal.text()).toBe('31,547 AVU/oz')
    expect(powVal.text()).toBe('11.9 kWh/$')
    expect(tokenVal.text()).toBe('41.7 AVU (kWh)')

    // 3. Hovering over point (e.g. index 0: 1930) updates table values
    const points = wrapper.findAll('[data-test="chart-hover-point"]')
    await points[0].trigger('mouseenter')

    expect(
      wrapper.find('[data-test="inspection-date-badge"]').text(),
    ).toContain('1930')
    expect(wrapper.find('[data-test="inspection-usd-value"]').text()).toBe(
      '142.9 kWh/$',
    )
    expect(wrapper.find('[data-test="inspection-gold-value"]').text()).toBe(
      '2,953 AVU/oz',
    )

    // 4. In Networks view, displays coin, energy cost, and yield
    const networksBtn = wrapper.find('button[data-test-option="networks"]')
    await networksBtn.trigger('click')

    expect(
      wrapper.find('[data-test="inspection-cell-network-coin"]').text(),
    ).toContain('XEC (SHA-256)')
    expect(
      wrapper.find('[data-test="inspection-cell-network-cost"]').text(),
    ).toContain('$0.141/kWh')
    expect(
      wrapper.find('[data-test="inspection-cell-network-yield"]').text(),
    ).toContain('+67.8%')
  })
})
