/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import { flushPromises } from '@vue/test-utils'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createPinia, setActivePinia } from 'pinia'
import AvuParityChart from './AvuParityChart.vue'
import en from '../../i18n/en-us'
import { useOracleStore } from '../../stores/oracle'
import { mergeFeed, oracleInputs } from '../../stores/oracle-series'
import { testFeed } from '../../stores/oracle-test-feed'
import {
  computeOracleRates,
  type OracleFeed,
  type SeriesPoint,
} from '@frank/wallet/oracle'

// Noon UTC keeps the daily electricity point outside the two recent hourly inputs.
const NOW = Date.UTC(2026, 9, 10, 12) / 1000
const DAY = 86_400

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
              str = str.replaceAll(`{${k}}`, String(v))
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

async function dragRange(
  wrapper: ReturnType<typeof mountChart>,
  from = 55,
  to = 625,
  pointerType = 'mouse',
  endEvent = 'pointerup',
) {
  const svg = wrapper.get('[data-test="macro-chart-svg"]')
    .element as SVGSVGElement
  Object.defineProperty(svg, 'getScreenCTM', {
    configurable: true,
    value: () => ({ inverse: () => ({}) }),
  })
  Object.defineProperty(svg, 'createSVGPoint', {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      matrixTransform() {
        return { x: this.x, y: this.y }
      },
    }),
  })
  const area = wrapper.get('[data-test="chart-range-interaction"]')
  Object.assign(area.element, {
    setPointerCapture: jest.fn(),
    releasePointerCapture: jest.fn(),
  })
  await area.trigger('pointerdown', {
    clientX: from,
    clientY: 100,
    pointerId: 1,
    isPrimary: true,
    button: 0,
    pointerType,
  })
  await area.trigger('pointermove', {
    clientX: to,
    clientY: 100,
    pointerId: 1,
    isPrimary: true,
    pointerType,
  })
  await area.trigger(endEvent, {
    clientX: to,
    clientY: 100,
    pointerId: 1,
    isPrimary: true,
    pointerType,
  })
}

async function openRange(
  wrapper: ReturnType<typeof mountChart>,
  range: string,
) {
  await wrapper.find(`[data-test-option="${range}"]`).trigger('click')
  await flushPromises()
}

/** Puts a feed into the store as a latest answer would, without any request. */
function receive(feed: OracleFeed) {
  const oracle = useOracleStore()
  const cache = mergeFeed(oracle.cache, feed, NOW)
  oracle.$patch({
    cache,
    current: computeOracleRates(oracleInputs(cache)!, NOW),
  })
  return oracle
}

const TODAY = Math.floor(NOW / DAY) * DAY

/** The aggregate wholesale price, one point a day for five days up to today. */
function electricity(price: number): SeriesPoint[] {
  return Array.from({ length: 5 }, (_, i) => [TODAY - (4 - i) * DAY, price])
}

/** A feed whose two basket entries both have their inputs. */
function twoEntryFeed(): OracleFeed {
  // Bitcoin: AVU_hash term 10 kWh per unit of value (value per kWh 0.1).
  const feed = testFeed([NOW - 3600, NOW - 60], {
    kwhPerValue: 10,
    prices: { 'monad-mainnet': 0.025, 'xmr-mainnet': 500 },
    electricity: electricity(0.05),
  })
  const at = (value: number): SeriesPoint[] => [
    [NOW - 3600, value],
    [NOW - 60, value],
  ]
  const series = (points: SeriesPoint[]) => ({
    unit: 'test',
    source: 'test',
    asOf: NOW - 60,
    stale: false,
    points,
  })
  // Monero: 500 x 0.6 / 1500 x 1 = 0.2 value per kWh, 5 kWh per unit of value.
  feed.series['marketCap/xmr-mainnet'] = series(at(1e12))
  feed.series['hashrate/xmr-mainnet'] = series(at(1500))
  feed.series['minerRevenue/xmr-mainnet'] = series(at(0.6))
  feed.series['efficiency/randomx'] = series(at(1))
  return feed
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000)
  setActivePinia(createPinia())
  const oracle = useOracleStore()
  // No test here asks anyone for anything.
  oracle.useFeedSource(async () => undefined)
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('selected coin price history', () => {
  it.each(['1y', '30d', '7d', '24h', 'all'])(
    'labels short available history precisely within the requested %s window',
    async range => {
      const times = Array.from({ length: 132 }, (_, i) => NOW - (132 - i) * 600)
      receive(testFeed(times, { prices: { 'monad-mainnet': 0.025 } }))
      const wrapper = mountChart()
      await openRange(wrapper, range)
      expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(
        132,
      )
      const ticks = wrapper.get('[data-test="macro-chart-svg"]').findAll('text')
      expect(ticks.length).toBeGreaterThanOrEqual(2)
      expect(ticks.length).toBeLessThanOrEqual(3)
      expect(new Set(ticks.map(tick => tick.text())).size).toBe(ticks.length)
      expect(ticks.every(tick => /\d+:\d+/.test(tick.text()))).toBe(true)
      expect(ticks[0].attributes('text-anchor')).toBe('start')
      expect(ticks[ticks.length - 1].attributes('text-anchor')).toBe('end')
      const note = wrapper.get('[data-test="chart-data-note"]').text()
      expect(note).toContain('132 price observations available from')
      expect(note).toContain('Requested window:')
      expect(note).toContain(
        wrapper.get(`[data-test-option="${range}"]`).text(),
      )
      wrapper.unmount()
    },
  )

  it('keeps time ticks apart when most observations cluster at one end', () => {
    const times = [
      NOW - DAY,
      ...Array.from({ length: 20 }, (_, i) => NOW - 3600 + i * 60),
    ]
    receive(testFeed(times, { prices: { 'monad-mainnet': 0.025 } }))
    const wrapper = mountChart()
    const ticks = wrapper.get('[data-test="macro-chart-svg"]').findAll('text')
    const xs = ticks.map(tick => Number(tick.attributes('x')))
    expect(xs.every((x, i) => i === 0 || x - xs[i - 1] >= 170)).toBe(true)
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(21)
    wrapper.unmount()
  })

  it('refines recent ALL history beyond a single monthly bucket through the real store query', async () => {
    const oracle = receive(
      testFeed([NOW - 60], { prices: { 'monad-mainnet': 0.025 } }),
    )
    const times = [NOW - 7200, NOW - 3600, NOW - 60]
    const source = jest.fn(async () =>
      testFeed(times, { prices: { 'monad-mainnet': 0.025 } }),
    )
    oracle.useFeedSource(source)
    const wrapper = mountChart()
    await flushPromises()
    expect(source).toHaveBeenCalledWith(
      { since: NOW - 30 * DAY, until: NOW, step: 3600 },
      expect.any(Function),
    )
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(3)
    wrapper.unmount()
  })

  it('shows an unavailable current value and no substitute curve before any feed', () => {
    const wrapper = mountChart()
    expect(wrapper.get('[data-test="metric-value-token-rate"]').text()).toBe(
      'Unavailable',
    )
    expect(wrapper.findAll('[data-test^="chart-point-"]')).toHaveLength(0)
    expect(wrapper.get('[data-test="chart-data-note"]').text()).toBe(
      en.walletPanel.chartNoteNoFeed,
    )
  })

  it('opens on the selected coin valued by AVU_hash, with the graph first and no lecture cards', () => {
    receive(twoEntryFeed())
    const wrapper = mountChart()
    expect(wrapper.get('[data-test="price-history-title"]').text()).toBe(
      'MON price history',
    )
    expect(wrapper.get('[data-test="price-history-axis"]').text()).toBe(
      'AVU (Hash) per MON',
    )
    expect(wrapper.get('[data-test="metric-value-token-rate"]').text()).toBe(
      '1 MON ≈ 187.5 mAVU · testnet',
    )
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(2)
    expect(
      wrapper.findAll(
        '[data-test="chart-point-grid"], [data-test="chart-point-gold"]',
      ),
    ).toHaveLength(0)
    expect(wrapper.find('[data-test="metric-card-avu-hash"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('[data-test="chart-sources"]').exists()).toBe(false)
    expect(wrapper.find('[data-test-option="networks"]').exists()).toBe(false)
    const svg = wrapper.get('[data-test="macro-chart-svg"]').element
    const inspection = wrapper.get(
      '[data-test="chart-inspection-table"]',
    ).element
    expect(
      svg.compareDocumentPosition(inspection) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('ALL retains every available shorter-range observation and newly received finer history', async () => {
    receive(twoEntryFeed())
    const wrapper = mountChart()
    const timestamps = () =>
      wrapper.findAll('[data-test="chart-hover-point"]').length
    const allCount = timestamps()
    expect(allCount).toBe(2)
    for (const range of ['1y', '30d', '7d', '24h']) {
      await openRange(wrapper, range)
      expect(timestamps()).toBe(allCount)
    }
    // A later history answer merges another genuine timestamp into the production cache.
    receive(testFeed([NOW - 1800], { prices: { 'monad-mainnet': 0.03 } }))
    await flushPromises()
    expect(timestamps()).toBe(3)
    await openRange(wrapper, 'all')
    expect(timestamps()).toBe(3)
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(3)
    const oracle = useOracleStore()
    const held = oracle.cache
    wrapper.unmount()
    setActivePinia(createPinia())
    useOracleStore().$patch({ cache: held })
    const reopened = mountChart()
    expect(reopened.findAll('[data-test="chart-point-token"]')).toHaveLength(3)
    reopened.unmount()
  })

  it('values the selected coin using AVU_spot instead of plotting the electricity price', async () => {
    receive(twoEntryFeed())
    const wrapper = mountChart()
    await openRange(wrapper, '24h')
    await wrapper
      .get('[data-test="denomination-toggle"] [data-test-option="spot"]')
      .trigger('click')
    expect(wrapper.get('[data-test="price-history-axis"]').text()).toBe(
      'AVU (Spot) per MON',
    )
    // MON 0.025 times the inverse of the 0.05 wholesale price = 0.5 AVU_spot.
    expect(wrapper.get('[data-test="metric-value-token-rate"]').text()).toBe(
      '1 MON ≈ 500 mAVU · testnet',
    )
    expect(wrapper.get('[data-test="inspection-cell-token"]').text()).toContain(
      '500 mAVU',
    )
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(2)
    expect(wrapper.find('[data-test="chart-point-grid"]').exists()).toBe(false)
  })

  it('aligns endpoint labels to the plot bounds and uses readable benchmark names', () => {
    receive(twoEntryFeed())
    const wrapper = mountChart()
    const scale = wrapper.get('[data-test="chart-scale"]')
    expect(scale.attributes('style')).toContain(
      'grid-template-rows: 30fr 200fr 60fr',
    )
    expect(scale.get('[data-test="chart-max-label-right"]').text()).toContain(
      'AVU',
    )
    expect(scale.get('[data-test="chart-min-label-right"]').text()).toContain(
      'AVU',
    )
    expect(
      wrapper
        .get('[data-test="macro-chart-svg"]')
        .find('[data-test="chart-scale"]')
        .exists(),
    ).toBe(false)
    expect(wrapper.get('[data-test="denomination-toggle"]').text()).toContain(
      'AVU (Hash)',
    )
    expect(wrapper.get('[data-test="denomination-toggle"]').text()).toContain(
      'AVU (Spot)',
    )
  })

  it('values the coin in dated troy ounces, never AVU or an annual average', async () => {
    const feed = twoEntryFeed()
    feed.series['price/gold'] = {
      unit: 'USD/troy ounce',
      source: 'Chainlink XAU/USD',
      asOf: NOW - 3600,
      stale: false,
      points: [[NOW - 3600, 4000]],
    }
    receive(feed)
    const wrapper = mountChart()
    await wrapper.get('[data-test-option="gold"]').trigger('click')
    expect(
      wrapper.get('[data-test="metric-value-token-rate"]').text(),
    ).toContain('0.00000625 oz')
    expect(
      wrapper.get('[data-test="metric-value-token-rate"]').text(),
    ).not.toContain('AVU')
    expect(wrapper.findAll('[data-test^="chart-point-"]')).toHaveLength(2)
    expect(wrapper.get('[data-test="chart-data-note"]').text()).not.toContain(
      en.walletPanel.priceHistoryGoldUnavailable,
    )
    wrapper.unmount()
  })

  it.each([
    { at: NOW + 1, unit: 'USD/troy ounce' },
    { at: NOW - 8 * DAY, unit: 'USD/troy ounce' },
    { at: NOW - 3600, unit: 'USD' },
  ])(
    'leaves unsupported or uncovered Gold dates unavailable (%s)',
    async ({ at, unit }) => {
      const feed = twoEntryFeed()
      feed.series['price/gold'] = {
        unit,
        source: 'test',
        asOf: at,
        stale: false,
        points: [[at, 4000]],
      }
      receive(feed)
      const wrapper = mountChart()
      await wrapper.get('[data-test-option="gold"]').trigger('click')
      expect(wrapper.get('[data-test="metric-value-token-rate"]').text()).toBe(
        'Unavailable',
      )
      expect(wrapper.findAll('[data-test^="chart-point-"]')).toHaveLength(0)
      wrapper.unmount()
    },
  )

  it('does not price observations before the first dated Gold round', async () => {
    const feed = twoEntryFeed()
    feed.series['price/gold'] = {
      unit: 'USD/troy ounce',
      source: 'test',
      asOf: NOW - 60,
      stale: false,
      points: [[NOW - 60, 4000]],
    }
    receive(feed)
    const wrapper = mountChart()
    await wrapper.get('[data-test-option="gold"]').trigger('click')
    expect(wrapper.findAll('[data-test^="chart-point-"]')).toHaveLength(1)
    expect(wrapper.findAll('path[data-test="chart-path-token"]')).toHaveLength(
      0,
    )
    wrapper.unmount()
  })

  it('does not claim dated gold valuation from an old annual average', async () => {
    receive(twoEntryFeed())
    const wrapper = mountChart()
    await wrapper
      .get('[data-test="denomination-toggle"] [data-test-option="gold"]')
      .trigger('click')
    expect(wrapper.get('[data-test="price-history-axis"]').text()).toBe(
      'Troy ounces of gold per MON',
    )
    expect(wrapper.get('[data-test="metric-value-token-rate"]').text()).toBe(
      'Unavailable',
    )
    expect(wrapper.get('[data-test="chart-data-note"]').text()).toBe(
      en.walletPanel.priceHistoryGoldUnavailable,
    )
    expect(wrapper.findAll('[data-test^="chart-point-"]')).toHaveLength(0)
  })

  it('reports missing MON history even when other coin and electricity observations exist', async () => {
    const feed = twoEntryFeed()
    delete feed.series['price/monad-mainnet']
    receive(feed)
    const wrapper = mountChart()
    await openRange(wrapper, '24h')
    expect(wrapper.findAll('[data-test^="chart-point-"]')).toHaveLength(0)
    expect(wrapper.get('[data-test="chart-data-note"]').text()).toContain(
      'There is no price history for 1 MON in this range.',
    )
  })

  it('samples only real selected coin timestamps, without extending its first price backwards or inventing later prices', async () => {
    const feed = twoEntryFeed()
    feed.series['price/monad-mainnet'].points = [[NOW - 1800, 0.025]]
    receive(feed)
    const wrapper = mountChart()
    await openRange(wrapper, '24h')
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(1)
    expect(wrapper.find('[data-test="chart-line-token"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="chart-data-note"]').text()).toContain(
      en.walletPanel.priceHistorySinglePoint,
    )
  })

  it('omits future coin points and points whose benchmark did not yet exist', async () => {
    const feed = twoEntryFeed()
    feed.series['price/monad-mainnet'].points = [
      [NOW - 7200, 0.025],
      [NOW - 60, 0.025],
      [NOW + 60, 0.025],
    ]
    receive(feed)
    const wrapper = mountChart()
    await openRange(wrapper, '24h')
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(1)
  })

  it.each(['all', '24h'])(
    'breaks the selected coin line across unavailable spot inputs in %s',
    async range => {
      const times = [NOW - 3600, NOW - 1800, NOW - 60]
      receive(
        testFeed(times, {
          prices: { 'monad-mainnet': 0.025 },
          electricity: [
            [times[0], 0.05],
            [times[1], -0.01],
            [times[2], 0.05],
          ],
        }),
      )
      const wrapper = mountChart()
      await openRange(wrapper, range)
      await wrapper
        .get('[data-test="denomination-toggle"] [data-test-option="spot"]')
        .trigger('click')
      expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(2)
      expect(wrapper.find('[data-test="chart-line-token"]').exists()).toBe(
        false,
      )
    },
  )

  it('retains the warning when historical hash valuation uses estimated hardware efficiency', async () => {
    const feed = twoEntryFeed()
    feed.series['efficiency/randomx'].estimatedBefore = NOW + 1
    receive(feed)
    const wrapper = mountChart()
    await openRange(wrapper, '24h')
    expect(wrapper.get('[data-test="chart-data-note"]').text()).toContain(
      en.walletPanel.avuHashEstimated,
    )
  })

  it('keeps eCash quote units at one million coins', async () => {
    receive(
      testFeed([NOW - 3600, NOW - 60], { prices: { 'xec-mainnet': 0.00001 } }),
    )
    const wrapper = mountChart({ selectedWallet: 'ecash' })
    await openRange(wrapper, '24h')
    expect(wrapper.get('[data-test="price-history-axis"]').text()).toBe(
      'AVU (Hash) per 1M XEC',
    )
    expect(wrapper.get('[data-test="inspection-cell-token"]').text()).toContain(
      '100 AVU',
    )
  })

  it('keeps fetched intraday detail visible when zooming history older than the persistent cache cutoff', async () => {
    const start = NOW - 20 * DAY
    const end = start + DAY
    const oracle = receive(
      testFeed([start, end], { prices: { 'monad-mainnet': 0.025 } }),
    )
    const times = [start, start + 600, start + 1200, end]
    oracle.useFeedSource(async request =>
      !('latest' in request) && request.step === 600
        ? testFeed(times, { prices: { 'monad-mainnet': 0.03 } })
        : undefined,
    )
    const wrapper = mountChart()
    await flushPromises()
    const columns = wrapper.findAll('[data-test="chart-hover-point"]')
    expect(columns).toHaveLength(2)
    await dragRange(wrapper)
    await flushPromises()
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(4)
    expect(oracle.cache.series['price/monad-mainnet'].points).toHaveLength(2)
    expect(
      oracle.cache.coverage.some(one => one.step < DAY && one.from <= start),
    ).toBe(false)
    await wrapper.get('[data-test="reset-zoom-btn"]').trigger('click')
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(2)
    wrapper.unmount()
  })

  it.each(['reset', 'range', 'coin'])(
    'ignores late old-history detail after %s',
    async change => {
      const start = NOW - 20 * DAY
      const end = start + DAY
      const oracle = receive(
        testFeed([start, end], { prices: { 'monad-mainnet': 0.025 } }),
      )
      let resolve!: (feed: OracleFeed) => void
      const pending = new Promise<OracleFeed>(done => {
        resolve = done
      })
      oracle.useFeedSource(async request =>
        !('latest' in request) && request.step === 600 ? pending : undefined,
      )
      const wrapper = mountChart()
      await flushPromises()
      await dragRange(wrapper)
      await flushPromises()
      if (change === 'reset')
        await wrapper.get('[data-test="reset-zoom-btn"]').trigger('click')
      else if (change === 'range') await openRange(wrapper, '1y')
      else await wrapper.setProps({ selectedWallet: 'ecash' })
      resolve(
        testFeed([start, start + 600, start + 1200, end], {
          prices: { 'monad-mainnet': 0.03 },
        }),
      )
      await flushPromises()
      expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(false)
      expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(
        change === 'coin' ? 0 : 2,
      )
      wrapper.unmount()
    },
  )

  it.each(['all', '5y', '1y', '30d', '7d', '24h'])(
    'zooms %s to finer bounded history and clears selection on reset/range/coin changes',
    async range => {
      const oracle = receive(twoEntryFeed())
      const ensure = jest
        .spyOn(oracle, 'ensureHistory')
        .mockResolvedValue(undefined)
      const wrapper = mountChart()
      await openRange(wrapper, range)
      const select = async () => {
        await dragRange(wrapper)
        await flushPromises()
      }
      await select()
      expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(true)
      expect(ensure).toHaveBeenLastCalledWith(NOW - 3600, 600, NOW - 60)
      await wrapper.get('[data-test="reset-zoom-btn"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(false)
      expect(ensure.mock.calls[ensure.mock.calls.length - 1]).toHaveLength(2)
      await select()
      await openRange(wrapper, range === '7d' ? '30d' : '7d')
      expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(false)
      await select()
      await wrapper.setProps({ selectedWallet: 'ecash' })
      expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(false)
      expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(0)
      // A late answer for the old coin must not restore its zoom or appear as eCash.
      receive(testFeed([NOW - 1800], { prices: { 'monad-mainnet': 0.03 } }))
      await flushPromises()
      expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(false)
      expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(0)
      wrapper.unmount()
    },
  )

  it('preserves hover, drag zoom and range-driven history requests', async () => {
    const oracle = receive(twoEntryFeed())
    const ensure = jest
      .spyOn(oracle, 'ensureHistory')
      .mockImplementation(async () => undefined)
    const wrapper = mountChart()
    await flushPromises()
    await openRange(wrapper, '7d')
    const last = ensure.mock.calls[ensure.mock.calls.length - 1]
    expect(last[1]).toBe(3600)
    expect(last[0]).toBe(NOW - 7 * DAY)
    await openRange(wrapper, '24h')
    const columns = wrapper.findAll('[data-test="chart-hover-point"]')
    await columns[0].trigger('mouseenter')
    expect(wrapper.get('[data-test="inspection-date"]').text()).toContain(
      'Inspecting',
    )
    await dragRange(wrapper)
    expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(true)
    await wrapper.get('[data-test="reset-zoom-btn"]').trigger('click')
    expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(false)
  })

  it.each(['mouse', 'touch', 'pen'])(
    'selects a time window between sparse observations with %s and rerenders/reset',
    async pointerType => {
      const oracle = receive(
        testFeed([NOW - DAY, NOW - DAY + 60, NOW - 60], {
          prices: { 'monad-mainnet': 0.025 },
        }),
      )
      const ensure = jest
        .spyOn(oracle, 'ensureHistory')
        .mockResolvedValue(undefined)
      const wrapper = mountChart()
      await flushPromises()
      // Both ends are in empty SVG space, away from the tightly clustered first samples.
      await dragRange(wrapper, 200, 500, pointerType)
      expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(true)
      expect(ensure.mock.calls.at(-1)?.[0]).toBeGreaterThan(NOW - DAY)
      expect(ensure.mock.calls.at(-1)?.[2]).toBeLessThan(NOW - 60)
      await wrapper.setProps({ selectedWallet: 'solana' })
      expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(false)
      expect(wrapper.find('[data-test="zoom-selection"]').exists()).toBe(false)
      wrapper.unmount()
    },
  )

  it.each(['pointercancel', 'lostpointercapture'])(
    'clears selection without zoom after %s',
    async endEvent => {
      receive(twoEntryFeed())
      const wrapper = mountChart()
      await flushPromises()
      await dragRange(wrapper, 100, 500, 'touch', endEvent)
      expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(false)
      expect(wrapper.find('[data-test="zoom-selection"]').exists()).toBe(false)
      await dragRange(wrapper, 200, 202)
      expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(false)
      wrapper.unmount()
    },
  )

  it('reserves a separate scale column and keeps presentation containers shrinkable', () => {
    receive(twoEntryFeed())
    const wrapper = mountChart()
    const svg = wrapper.get('[data-test="macro-chart-svg"]')
    expect(svg.find('[data-test="chart-max-label-right"]').exists()).toBe(false)
    expect(
      wrapper.get('[data-test="chart-scale"]').element.previousElementSibling,
    ).toBe(svg.element)
    const source = readFileSync(join(__dirname, 'AvuParityChart.vue'), 'utf8')
    expect(source).toContain('min-width: 0;')
    expect(source).toContain(
      'grid-template-columns: repeat(2, minmax(0, 1fr));',
    )
    expect(source).toContain('overflow-wrap: anywhere;')
  })
})

it('discloses omitted fees on subsidy-only price history', () => {
  const feed = testFeed([NOW - 60], { prices: { 'monad-mainnet': 0.025 } })
  feed.series['minerSubsidy/btc-mainnet'] =
    feed.series['minerRevenue/btc-mainnet']
  delete feed.series['minerRevenue/btc-mainnet']
  receive(feed)
  const wrapper = mountChart()
  expect(wrapper.text()).toContain(en.walletPanel.avuFeesExcluded)
  wrapper.unmount()
})
