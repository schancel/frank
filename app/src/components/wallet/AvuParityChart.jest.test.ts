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

const NOW = Math.floor(Date.now() / 1000)
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
  setActivePinia(createPinia())
  const oracle = useOracleStore()
  // No test here asks anyone for anything.
  oracle.useFeedSource(async () => undefined)
})

describe('with nothing received from the oracle', () => {
  it('says every figure is unavailable and draws nothing: no placeholder value', () => {
    const wrapper = mountChart()
    for (const id of ['token-rate', 'avu-hash', 'avu-spot', 'hash-vs-spot']) {
      expect(wrapper.find(`[data-test="metric-value-${id}"]`).text()).toBe(
        'Unavailable',
      )
    }
    expect(wrapper.findAll('[data-test^="chart-line-"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-test^="chart-point-"]')).toHaveLength(0)
    expect(wrapper.find('[data-test="chart-data-note"]').text()).toBe(
      en.walletPanel.chartNoteNoFeed,
    )
  })
})

describe('the figures', () => {
  it('state the coin in AVU, the basket used, and the grid kWh in AVU', () => {
    receive(twoEntryFeed())
    const wrapper = mountChart()
    const value = (id: string) =>
      wrapper.find(`[data-test="metric-value-${id}"]`).text()
    // Equal market caps: Bitcoin 50%, Monero 50%. AVU_hash = (10 + 5) / 2 = 7.5.
    // 1 MON = 0.025 x 7.5 = 0.1875 AVU.
    expect(value('token-rate')).toBe('1 MON ≈ 187.5 mAVU · testnet')
    expect(value('avu-hash')).toBe('2 of 2 basket entries')
    const basket = wrapper.find('[data-test="metric-card-avu-hash"]').text()
    expect(basket).toContain('BTC 50%')
    expect(basket).toContain('XMR 50%')
    // A wholesale kWh costs 0.05; valued by mining: 0.05 x 7.5 = 0.375 AVU.
    expect(value('avu-spot')).toBe('A wholesale kWh costs 0.38 AVU')
    // A kWh of mining pays 1 / 0.375 = 2.667 times its wholesale price: +166.7%.
    expect(value('hash-vs-spot')).toBe('+166.7%')
    expect(
      wrapper.find('[data-test="metric-card-hash-vs-spot"]').text(),
    ).toContain('Mining pays 167% more per kWh than the grid charges.')
    // The tile says how the price was built and which regions are in it.
    const spot = wrapper.find('[data-test="metric-card-avu-spot"]').text()
    expect(spot).toContain('over the 30 days to')
    expect(spot).toContain('regions weighted equally: Test region day-ahead.')
    expect(spot).not.toContain('Not in this figure')
    expect(value('avu-unit')).toBe('1 AVU = 1 kWh')
  })

  it('say "N of 5"-style how many entries were used and why each other was left out', () => {
    const feed = twoEntryFeed()
    delete feed.series['price/xmr-mainnet']
    receive(feed)
    const wrapper = mountChart()
    expect(wrapper.find('[data-test="metric-value-avu-hash"]').text()).toBe(
      '1 of 2 basket entries',
    )
    const basket = wrapper.find('[data-test="metric-card-avu-hash"]').text()
    expect(basket).toContain('BTC 100%')
    expect(basket).toContain('Left out: XMR (no price).')
  })

  it('give the reason when AVU_spot has no inverse', () => {
    const feed = twoEntryFeed()
    feed.series['electricity/aggregate'].points = electricity(-0.01)
    receive(feed)
    const wrapper = mountChart()
    expect(wrapper.find('[data-test="metric-value-avu-spot"]').text()).toBe(
      'Unavailable',
    )
    expect(wrapper.find('[data-test="metric-card-avu-spot"]').text()).toContain(
      en.walletPanel.avuSpotNotPositive,
    )
  })

  it('say "less" when mining pays under the grid price, and name a region that is no longer counted', () => {
    const feed = twoEntryFeed()
    // A wholesale kWh at 0.2: 0.2 x 7.5 = 1.5 AVU; mining pays 1 / 1.5 - 1 = -33.3%.
    feed.series['electricity/aggregate'].points = electricity(0.2)
    feed.electricity = {
      ...feed.electricity,
      regions: [
        { ...feed.electricity.regions[0], lastContributed: TODAY },
        {
          id: 'gone',
          label: 'Quiet region',
          attribution: 'Quiet market',
          lastContributed: Date.UTC(2026, 8, 30) / 1000,
        },
      ],
    }
    receive(feed)
    const wrapper = mountChart()
    expect(wrapper.find('[data-test="metric-value-avu-spot"]').text()).toBe(
      'A wholesale kWh costs 1.50 AVU',
    )
    expect(wrapper.find('[data-test="metric-value-hash-vs-spot"]').text()).toBe(
      '-33.3%',
    )
    expect(
      wrapper.find('[data-test="metric-card-hash-vs-spot"]').text(),
    ).toContain('Mining pays 33% less per kWh than the grid charges.')
    const spot = wrapper.find('[data-test="metric-card-avu-spot"]').text()
    expect(spot).toContain('regions weighted equally: Test region day-ahead.')
    expect(spot).toMatch(
      /Not in this figure, too few recent prices: Quiet region \(last counted .*2026\)\./,
    )
  })

  it('mark an electricity price that was not refreshed with its age', () => {
    const feed = twoEntryFeed()
    feed.series['electricity/aggregate'].stale = true
    receive(feed)
    const wrapper = mountChart()
    expect(wrapper.find('[data-test="metric-card-avu-spot"]').text()).toMatch(
      /Not refreshed: latest price is \d+ (h|d) old\./,
    )
  })

  it('say so when an entry rests on an estimated hardware figure', () => {
    const feed = twoEntryFeed()
    feed.series['efficiency/randomx'].estimatedBefore = NOW + 1
    receive(feed)
    const wrapper = mountChart()
    expect(wrapper.find('[data-test="metric-card-avu-hash"]').text()).toContain(
      en.walletPanel.avuHashEstimated,
    )
  })
})

describe('the lines', () => {
  it('are today’s functions evaluated at the times the series hold, one point each', async () => {
    receive(twoEntryFeed())
    const wrapper = mountChart()
    await openRange(wrapper, '24h')
    // Two times held in the range (an hour ago, a minute ago): two points per line.
    expect(wrapper.findAll('[data-test="chart-point-grid"]')).toHaveLength(2)
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(2)
    expect(wrapper.find('[data-test="chart-line-grid"]').exists()).toBe(true)
    const cells = wrapper.find('[data-test="chart-inspection-table"]').text()
    expect(cells).toContain('0.38 AVU')
    expect(cells).toContain('187.5 mAVU')
    expect(wrapper.find('[data-test="chart-data-note"]').text()).toContain(
      '2 points from',
    )
  })

  it('have no point where an input is missing: the first value is not extended backwards', async () => {
    const feed = twoEntryFeed()
    // Monad's price exists only from a minute ago.
    feed.series['price/monad-mainnet'].points = [[NOW - 60, 0.025]]
    receive(feed)
    const wrapper = mountChart()
    await openRange(wrapper, '24h')
    expect(wrapper.findAll('[data-test="chart-point-grid"]')).toHaveLength(2)
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(1)
  })

  it('say so when the open coin has no price history', async () => {
    receive(twoEntryFeed())
    const wrapper = mountChart({ selectedWallet: 'tempo' })
    await openRange(wrapper, '24h')
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(0)
    expect(wrapper.find('[data-test="chart-data-note"]').text()).toContain(
      'There is no price history for 1 TUSD in this range.',
    )
  })

  it('ask the oracle for the history of the range shown', async () => {
    const oracle = receive(twoEntryFeed())
    const ensure = jest
      .spyOn(oracle, 'ensureHistory')
      .mockImplementation(async () => undefined)
    const wrapper = mountChart()
    await flushPromises()
    await openRange(wrapper, '7d')
    const last = ensure.mock.calls[ensure.mock.calls.length - 1]
    expect(last[1]).toBe(3600)
    expect(NOW - last[0]).toBeGreaterThanOrEqual(7 * DAY - 5)
    expect(NOW - last[0]).toBeLessThanOrEqual(7 * DAY + 5)
    await openRange(wrapper, 'networks')
    expect(ensure.mock.calls[ensure.mock.calls.length - 1]).toBe(last)
  })
})

describe('the networks view', () => {
  it('shows what a kWh of mining earns on each entry, in AVU, against the basket', async () => {
    receive(twoEntryFeed())
    const wrapper = mountChart()
    await openRange(wrapper, 'networks')
    const text = wrapper.find('[data-test="networks-chart-svg"]').text()
    // Bitcoin: 0.1 x 7.5 = 0.75 AVU per kWh (-25% against the basket).
    // Monero: 0.2 x 7.5 = 1.50 AVU per kWh (+50%).
    expect(text).toContain('0.75 AVU/kWh')
    expect(text).toContain('-25.0%')
    expect(text).toContain('1.50 AVU/kWh')
    expect(text).toContain('+50.0%')
    expect(text).toContain('BTC · 50%')
    expect(wrapper.findAll('[data-test="chart-hover-bar"]')).toHaveLength(2)
  })
})

describe('what is on screen', () => {
  it('names where each kind of input comes from, as the feed says', () => {
    receive(twoEntryFeed())
    const wrapper = mountChart()
    expect(wrapper.find('[data-test="source-prices"]').text()).toContain(
      'test prices',
    )
    const chains = wrapper.find('[data-test="source-chains"]').text()
    expect(chains).toContain('test chain statistics')
    // The eCash split is read from the dated steps, not typed into the text.
    expect(chains).toMatch(/eCash miners receive 58% .* \(92% before\)/)
    expect(en.walletPanel.sourceEcashShare).not.toMatch(/\d/)
    expect(wrapper.find('[data-test="source-efficiency"]').text()).toContain(
      'curated',
    )
    expect(wrapper.find('[data-test="source-electricity"]').text()).toContain(
      'Test region day-ahead (Test market)',
    )
  })

  it('never shows a dollar sign, "USD", or an undefined term', async () => {
    receive(twoEntryFeed())
    const wrapper = mountChart()
    for (const range of ['all', '5y', '1y', '30d', '7d', '24h', 'networks']) {
      await openRange(wrapper, range)
      const text = wrapper.text()
      expect(text).not.toMatch(/\$|USD|dollar/i)
      expect(text).not.toContain('TPI')
    }
  })

  it('has no typed-in rate in its source: every number is read from the feed', () => {
    const source = readFileSync(join(__dirname, 'AvuParityChart.vue'), 'utf8')
    expect(source).not.toMatch(/kwhPerDollar|centsPerKwh|goldUsd \* \d/)
  })
})
