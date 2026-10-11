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
  feed.series['difficulty/xmr-mainnet'] = series(at(1500))
  feed.series['blockReward/xmr-mainnet'] = series(at(0.6))
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
      'AVU_hash per MON',
    )
    expect(wrapper.get('[data-test="metric-value-token-rate"]').text()).toBe(
      '1 MON ≈ 187.5 mAVU · testnet',
    )
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(1)
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

  it('values the selected coin using AVU_spot instead of plotting the electricity price', async () => {
    receive(twoEntryFeed())
    const wrapper = mountChart()
    await openRange(wrapper, '24h')
    await wrapper
      .get('[data-test="denomination-toggle"] [data-test-option="spot"]')
      .trigger('click')
    expect(wrapper.get('[data-test="price-history-axis"]').text()).toBe(
      'AVU_spot per MON',
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

  it('breaks the selected coin line across unavailable spot inputs', async () => {
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
    await openRange(wrapper, '24h')
    await wrapper
      .get('[data-test="denomination-toggle"] [data-test-option="spot"]')
      .trigger('click')
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(2)
    expect(wrapper.find('[data-test="chart-line-token"]').exists()).toBe(false)
  })

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
      'AVU_hash per 1M XEC',
    )
    expect(wrapper.get('[data-test="inspection-cell-token"]').text()).toContain(
      '100 AVU',
    )
  })

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
    await columns[0].trigger('mousedown')
    await columns[1].trigger('mouseup')
    expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(true)
    await wrapper.get('[data-test="reset-zoom-btn"]').trigger('click')
    expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(false)
  })

  it('keeps scale labels inside the SVG and presentation containers shrinkable', () => {
    receive(twoEntryFeed())
    const wrapper = mountChart()
    const svg = wrapper.get('[data-test="macro-chart-svg"]')
    for (const label of svg.findAll(
      '[data-test^="chart-max-label-"], [data-test^="chart-min-label-"]',
    )) {
      expect(Number(label.attributes('x'))).toBeLessThanOrEqual(680)
      expect(label.attributes('text-anchor')).toBe('end')
    }
    const source = readFileSync(join(__dirname, 'AvuParityChart.vue'), 'utf8')
    expect(source).toContain('min-width: 0;')
    expect(source).toContain(
      'grid-template-columns: repeat(2, minmax(0, 1fr));',
    )
    expect(source).toContain('overflow-wrap: anywhere;')
  })
})
