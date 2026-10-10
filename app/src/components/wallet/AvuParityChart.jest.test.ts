/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import { flushPromises } from '@vue/test-utils'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createPinia, setActivePinia } from 'pinia'
import AvuParityChart from './AvuParityChart.vue'
import en from '../../i18n/en-us'
import { useOracleStore } from '../../stores/oracle'
import * as oracleSdk from '@frank/wallet/oracle'

// The provider seam: no test here touches the network.
jest.mock('@frank/wallet/oracle', () => ({
  ...jest.requireActual('@frank/wallet/oracle'),
  fetchPriceHistory: jest.fn(),
  fetchOracleSnapshot: jest.fn(),
}))

const fetchPriceHistory = oracleSdk.fetchPriceHistory as jest.Mock
const BTC_USD = 80_000
const XEC_USD = 0.00001
const NOW = Date.now()
const HOUR = 3_600_000

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

function setPrice(
  asset: oracleSdk.SupportedAsset,
  usd: number,
  fetchedAt = NOW,
  sources = 4,
) {
  const oracle = useOracleStore()
  oracle.snapshot.prices[asset] = usd
  oracle.snapshot.fetchedAt[asset] = fetchedAt
  oracle.snapshot.priceSources[asset] = sources
  oracle.snapshot = oracleSdk.rateOracleSnapshot(oracle.snapshot)
}

const HASHES_PER_KWH = oracleSdk.latestHashingEfficiency('sha256')!.hashesPerKwh

function chainStats(
  chain: string,
  subsidyCoinsPerBlock: number,
  hashesPerBlock: number,
  circulatingCoins: number,
  fetchedAt: number,
) {
  return {
    chain,
    subsidyCoinsPerBlock,
    difficulty: hashesPerBlock / 2 ** 32,
    hashesPerBlock,
    circulatingCoins,
    fetchedAt,
  }
}

/**
 * Gives the oracle a bitcoin price and bitcoin chain statistics at which the real formula,
 * with the bundled efficiency, makes AVU_hash exactly `kwhPerDollar`:
 * kWh/$ = hashes per block / (price x subsidy x hashes per kWh).
 */
function setHash(kwhPerDollar = 12, fetchedAt = NOW) {
  const oracle = useOracleStore()
  oracle.snapshot.mining.bitcoin = chainStats(
    'bitcoin',
    3.125,
    kwhPerDollar * BTC_USD * 3.125 * HASHES_PER_KWH,
    20_000_000,
    fetchedAt,
  )
  setPrice('bitcoin', BTC_USD)
}

/** Adds eCash at `kwhPerDollar`; its miners receive 58% of the 3,125,000 XEC subsidy. */
function setEcashMining(kwhPerDollar: number) {
  const oracle = useOracleStore()
  oracle.snapshot.mining.ecash = chainStats(
    'ecash',
    3_125_000,
    kwhPerDollar * XEC_USD * 3_125_000 * 0.58 * HASHES_PER_KWH,
    20_000_000_000_000,
    NOW,
  )
  setPrice('ecash', XEC_USD, NOW, 1)
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  fetchPriceHistory.mockReset().mockResolvedValue({
    asset: '',
    range: '24h',
    provider: null,
    points: [],
  })
  // AVU_hash is 12 kWh per dollar unless a test says otherwise.
  setHash()
})

describe('the drawn lines are data, never a formula', () => {
  it('draws exactly the price points the provider published, each times AVU_hash', async () => {
    const points = [
      { timestamp: NOW - 3 * HOUR, price: 108.5 },
      { timestamp: NOW - 2 * HOUR, price: 111.25 },
      { timestamp: NOW - 1 * HOUR, price: 110.06 },
    ]
    fetchPriceHistory.mockResolvedValue({
      asset: 'SOL',
      range: '24h',
      provider: 'coinbase',
      points,
    })
    const wrapper = mountChart({ selectedWallet: 'solana' })
    await openRange(wrapper, '24h')

    expect(fetchPriceHistory).toHaveBeenCalledWith('SOL', '24h')
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(3)
    expect(wrapper.find('[data-test="chart-line-token"]').exists()).toBe(true)

    // Every plotted value is one published price times AVU_hash (12 kWh per dollar).
    const columns = wrapper.findAll('[data-test="chart-hover-point"]')
    expect(columns).toHaveLength(3)
    for (const [index, point] of points.entries()) {
      await columns[index].trigger('mouseenter')
      const expected = (point.price * 12).toLocaleString('en-US', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })
      expect(
        wrapper.find('[data-test="inspection-cell-token"]').text(),
      ).toContain(`${expected} AVU`)
    }
    const note = wrapper.find('[data-test="chart-data-note"]').text()
    expect(note).toContain('3 market prices published by coinbase')
    // The line uses today's AVU_hash throughout, and says so.
    expect(note).toContain(
      'Each point is that price times today’s AVU_hash (12.00 kWh/$); AVU_hash is not recomputed along the line.',
    )
  })

  it('moves every plotted value in step with AVU_hash: there is no fixed rate in the line', async () => {
    fetchPriceHistory.mockResolvedValue({
      asset: 'SOL',
      range: '24h',
      provider: 'coinbase',
      points: [{ timestamp: NOW - HOUR, price: 100 }],
    })
    const wrapper = mountChart({ selectedWallet: 'solana' })
    await openRange(wrapper, '24h')
    const cell = () =>
      wrapper.find('[data-test="inspection-cell-token"]').text()
    expect(cell()).toContain('1,200.0 AVU')
    setHash(24)
    await flushPromises()
    expect(cell()).toContain('2,400.0 AVU')
  })

  it('draws no price line while AVU_hash is unavailable, and says why', async () => {
    fetchPriceHistory.mockResolvedValue({
      asset: 'SOL',
      range: '24h',
      provider: 'coinbase',
      points: [{ timestamp: NOW - HOUR, price: 100 }],
    })
    useOracleStore().snapshot = oracleSdk.unavailableOracleSnapshot()
    const wrapper = mountChart({ selectedWallet: 'solana' })
    await openRange(wrapper, '24h')
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(0)
    expect(wrapper.find('[data-test="chart-data-note"]').text()).toContain(
      'AVU_hash is unavailable',
    )
  })

  it.each(['24h', '7d', '30d', '1y'])(
    'draws no %s line and no points when no history could be fetched, and says so',
    async range => {
      const wrapper = mountChart({ selectedWallet: 'ethereum' })
      setPrice('ethereum', 2496.78)
      await openRange(wrapper, range)

      expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(0)
      expect(wrapper.find('[data-test="chart-line-token"]').exists()).toBe(
        false,
      )
      expect(wrapper.find('[data-test="chart-data-note"]').text()).toContain(
        'No price history could be fetched for 1 ETH',
      )
    },
  )

  it('shows one published point as one point, with no line through invented neighbours', async () => {
    fetchPriceHistory.mockResolvedValue({
      asset: 'HYPE',
      range: '30d',
      provider: 'kraken',
      points: [{ timestamp: NOW - HOUR, price: 84.29 }],
    })
    const wrapper = mountChart({ selectedWallet: 'hyperliquid' })
    await openRange(wrapper, '30d')
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(1)
    expect(wrapper.find('[data-test="chart-line-token"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="chart-data-note"]').text()).toContain(
      '1 market prices published by kraken',
    )
  })

  it('falls back to the prices this app recorded itself, and shows only as many as exist', async () => {
    const wrapper = mountChart({ selectedWallet: 'ecash' })
    const oracle = useOracleStore()
    oracle.observations = [
      { timestamp: NOW - 5 * HOUR, prices: { ecash: 7.3e-6 } },
      { timestamp: NOW - 4 * HOUR, prices: { solana: 110 } },
      { timestamp: NOW - 3 * HOUR, prices: { ecash: 7.24e-6 } },
      { timestamp: NOW - 400 * 24 * HOUR, prices: { ecash: 9e-6 } },
    ]
    await openRange(wrapper, '7d')
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(2)
    expect(wrapper.find('[data-test="chart-data-note"]').text()).toContain(
      '2 prices this app fetched itself',
    )
  })

  it('contains no curve generator: the component computes no sine, cosine or random points', () => {
    const source = readFileSync(join(__dirname, 'AvuParityChart.vue'), 'utf8')
    expect(source).not.toMatch(/Math\.(sin|cos|random)/)
    expect(source).not.toMatch(/interpolate/i)
  })
})

describe('dragging across the chart zooms to that stretch', () => {
  it('keeps only the published points inside the dragged stretch, and Reset shows all again', async () => {
    fetchPriceHistory.mockResolvedValue({
      asset: 'SOL',
      range: '24h',
      provider: 'coinbase',
      points: [5, 4, 3, 2, 1].map(h => ({
        timestamp: NOW - h * HOUR,
        price: 100 + h,
      })),
    })
    const wrapper = mountChart({ selectedWallet: 'solana' })
    await openRange(wrapper, '24h')
    const columns = wrapper.findAll('[data-test="chart-hover-point"]')
    expect(columns).toHaveLength(5)
    expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(false)

    await columns[1].trigger('mousedown')
    await columns[3].trigger('mouseenter')
    expect(wrapper.find('[data-test="zoom-selection"]').exists()).toBe(true)
    await columns[3].trigger('mouseup')

    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(3)
    expect(wrapper.find('[data-test="zoom-selection"]').exists()).toBe(false)

    await wrapper.get('[data-test="reset-zoom-btn"]').trigger('click')
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(5)
  })

  it('a click without a drag does not zoom', async () => {
    const wrapper = mountChart()
    const columns = wrapper.findAll('[data-test="chart-hover-point"]')
    await columns[2].trigger('mousedown')
    await columns[2].trigger('mouseup')
    expect(wrapper.find('[data-test="reset-zoom-btn"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-test="chart-hover-point"]')).toHaveLength(
      columns.length,
    )
  })
})

describe('the one-year view also draws the bundled monthly AVU_spot and AVU_hash', () => {
  it('shows only the published months that fall inside the last year, and none on shorter ranges', async () => {
    const wrapper = mountChart({ selectedWallet: 'solana' })
    await openRange(wrapper, '1y')
    const yearAgo = NOW - 366 * 24 * HOUR
    const published = oracleSdk.US_MONTHLY_INDUSTRIAL_ELECTRICITY.filter(
      m =>
        Date.UTC(
          Number(m.month.slice(0, 4)),
          Number(m.month.slice(5, 7)) - 1,
          15,
        ) >= yearAgo,
    )
    expect(wrapper.findAll('[data-test="chart-point-usd"]')).toHaveLength(
      published.length,
    )
    // AVU_hash by month, from the bundled Bitcoin inputs, over the same year.
    const hashMonths = oracleSdk.BTC_MONTHLY_AVU_HASH.filter(
      m =>
        Date.UTC(
          Number(m.month.slice(0, 4)),
          Number(m.month.slice(5, 7)) - 1,
          15,
        ) >= yearAgo,
    )
    expect(hashMonths.length).toBeGreaterThan(0)
    expect(wrapper.findAll('[data-test="chart-point-hash"]')).toHaveLength(
      hashMonths.length,
    )
    await openRange(wrapper, '30d')
    expect(wrapper.findAll('[data-test="chart-point-usd"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-test="chart-point-hash"]')).toHaveLength(0)
  })
})

describe('bundled long-range data is loaded as data', () => {
  it('draws one point per published year, straight from the bundled table', async () => {
    const wrapper = mountChart()
    await flushPromises()
    const annual = oracleSdk.US_ANNUAL_ELECTRICITY_AND_GOLD
    expect(wrapper.findAll('[data-test="chart-point-usd"]')).toHaveLength(
      annual.length,
    )
    // Gold is absent for a year the source does not publish; no point is made up for it.
    expect(wrapper.findAll('[data-test="chart-point-gold"]')).toHaveLength(
      annual.filter(p => p.goldUsd !== undefined).length,
    )
    expect(wrapper.find('[data-test="chart-data-note"]').text()).toContain(
      `Yearly published figures, ${annual[0].year} to ${
        annual[annual.length - 1].year
      }`,
    )
  })

  it('shows the table’s own figure for a year: 1990 at 4.74 cents is 21.1 kWh per dollar', async () => {
    const wrapper = mountChart()
    await flushPromises()
    const annual = oracleSdk.US_ANNUAL_ELECTRICITY_AND_GOLD
    const index = annual.findIndex(p => p.year === 1990)
    await wrapper
      .findAll('[data-test="chart-hover-point"]')
      [index].trigger('mouseenter')
    expect(wrapper.find('[data-test="inspection-date"]').text()).toContain(
      '1990',
    )
    expect(wrapper.find('[data-test="inspection-cell-usd"]').text()).toContain(
      '21.1 kWh/$',
    )
  })

  it('draws AVU_hash beside AVU_spot for every year the bundled Bitcoin months cover in full', async () => {
    const wrapper = mountChart()
    await flushPromises()
    const months = oracleSdk.BTC_MONTHLY_AVU_HASH
    const fullYears = Array.from(
      new Set(months.map(m => m.month.slice(0, 4))),
    ).filter(year => months.filter(m => m.month.startsWith(year)).length === 12)
    expect(fullYears.length).toBeGreaterThan(10)
    expect(wrapper.findAll('[data-test="chart-point-hash"]')).toHaveLength(
      fullYears.length,
    )
    expect(wrapper.find('[data-test="chart-data-note"]').text()).toContain(
      `AVU_hash is drawn for ${fullYears[0]} to ${
        fullYears[fullYears.length - 1]
      }`,
    )
    // 2024: the mean of that year's twelve monthly values.
    const year2024 = months.filter(m => m.month.startsWith('2024'))
    const mean = year2024.reduce((sum, m) => sum + m.kwhPerDollar, 0) / 12
    const annual = oracleSdk.US_ANNUAL_ELECTRICITY_AND_GOLD
    await wrapper
      .findAll('[data-test="chart-hover-point"]')
      [annual.findIndex(p => p.year === 2024)].trigger('mouseenter')
    expect(wrapper.find('[data-test="inspection-cell-hash"]').text()).toContain(
      `${mean.toFixed(1)} kWh/$`,
    )
  })

  it('5Y is the last five bundled years', async () => {
    const wrapper = mountChart()
    await openRange(wrapper, '5y')
    expect(wrapper.findAll('[data-test="chart-point-usd"]')).toHaveLength(5)
  })

  it('names the published sources', () => {
    const text = mountChart().find('[data-test="chart-sources"]').text()
    expect(text).toContain('EIA Monthly Energy Review Table 9.8')
    expect(text).toContain('World Bank Commodity Price Data')
    expect(text).toContain('blockchain.com charts API')
    // The efficiency series is named as the one curated input, with its source and date.
    const efficiency = mountChart()
      .find('[data-test="source-efficiency"]')
      .text()
    expect(efficiency).toContain('curated, not a live reading')
    expect(efficiency).toContain('Cambridge Bitcoin Electricity Consumption')
    expect(efficiency).toContain(oracleSdk.BTC_MINING_SOURCES.retrieved)
  })
})

describe('figures are fetched, bundled or the stated unit; a failure is never a price', () => {
  it('shows "Unavailable" for the coin rate when no price was fetched', async () => {
    const wrapper = mountChart({ selectedWallet: 'solana' })
    await flushPromises()
    const value = wrapper.find('[data-test="metric-value-token-rate"]').text()
    expect(value).toBe('Unavailable')
    expect(wrapper.text()).not.toMatch(/≈ [\d,.]+ AVU/)
  })

  it('shows the fetched price in AVU once there is one', async () => {
    const wrapper = mountChart({ selectedWallet: 'solana' })
    setPrice('solana', 110.06)
    await flushPromises()
    expect(wrapper.find('[data-test="metric-value-token-rate"]').text()).toBe(
      '1 SOL ≈ 1,320.72 AVU',
    )
    const card = wrapper.find('[data-test="metric-card-token-rate"]').text()
    expect(card).toContain('Market price $110.060')
    expect(card).toContain('Median of 4 providers.')
  })

  it('says when a price rests on a single provider', async () => {
    const wrapper = mountChart({ selectedWallet: 'ecash' })
    setPrice('ecash', 7.2e-6, NOW, 1)
    await flushPromises()
    expect(
      wrapper.find('[data-test="metric-card-token-rate"]').text(),
    ).toContain('One provider only.')
  })

  it('shows a fetched price as "Unavailable" in AVU while AVU_hash is unavailable', async () => {
    useOracleStore().snapshot = oracleSdk.unavailableOracleSnapshot()
    const wrapper = mountChart({ selectedWallet: 'solana' })
    setPrice('solana', 110.06)
    await flushPromises()
    expect(wrapper.find('[data-test="metric-value-token-rate"]').text()).toBe(
      'Unavailable',
    )
    expect(
      wrapper.find('[data-test="metric-card-token-rate"]').text(),
    ).toContain('AVU_hash could not be computed')
  })

  it('marks an old price as stale with its age instead of showing it as current', async () => {
    const wrapper = mountChart({ selectedWallet: 'solana' })
    setPrice('solana', 110.06, NOW - 3 * HOUR)
    await flushPromises()
    expect(wrapper.find('[data-test="metric-value-token-rate"]').text()).toBe(
      '1 SOL ≈ 1,320.72 AVU (3 h old)',
    )
    expect(
      wrapper.find('[data-test="metric-card-token-rate"]').text(),
    ).toContain('Stale: last market price')
  })

  it('gives a coin no provider prices (Tempo test dollar) no AVU value and no line', async () => {
    const wrapper = mountChart({ selectedWallet: 'tempo' })
    await openRange(wrapper, '7d')
    expect(wrapper.find('[data-test="metric-value-token-rate"]').text()).toBe(
      'Unavailable',
    )
    expect(
      wrapper.find('[data-test="metric-card-token-rate"]').text(),
    ).toContain('No provider publishes a market price for this coin')
    expect(fetchPriceHistory).not.toHaveBeenCalled()
    expect(wrapper.findAll('[data-test="chart-point-token"]')).toHaveLength(0)
  })

  it('labels the MON price as the mainnet coin’s: testnet MON has no market value', async () => {
    const wrapper = mountChart({ selectedWallet: 'monad' })
    setPrice('monad', 0.025)
    await flushPromises()
    const oracle = useOracleStore()
    expect(wrapper.find('[data-test="metric-value-token-rate"]').text()).toBe(
      '1 MON ≈ 0.30 AVU (mainnet price; testnet coins have no market value)',
    )
    expect(oracle.formatAvuAmount('monad', 5_000_000_000_000_000_000n)).toBe('')
    expect(oracle.getAvu('monad', 5_000_000_000_000_000_000n)).toBe(0)
  })

  it('states the unit as 1 kWh and its dollar value as the inverse of AVU_hash', () => {
    const wrapper = mountChart()
    expect(wrapper.find('[data-test="metric-card-avu-unit"]').text()).toContain(
      '1 AVU = 1 kWh',
    )
    // AVU_hash is 12 kWh per dollar, so one kWh is 1/12 of a dollar.
    expect(wrapper.find('[data-test="metric-value-avu-unit"]').text()).toBe(
      '1 AVU = $0.0833',
    )
    expect(wrapper.find('[data-test="metric-card-avu-unit"]').text()).toContain(
      'not a coin or token',
    )
  })

  it('reads the grid figure from the newest bundled EIA month', () => {
    const months = oracleSdk.US_MONTHLY_INDUSTRIAL_ELECTRICITY
    const latest = months[months.length - 1]
    const card = mountChart().find('[data-test="metric-card-avu-spot"]').text()
    expect(card).toContain(`${(100 / latest.centsPerKwh).toFixed(2)} kWh/$`)
    expect(card).toContain(latest.month)
  })

  it('no longer shows the typed-in figures', async () => {
    const wrapper = mountChart({ selectedWallet: 'ecash' })
    await flushPromises()
    const text = wrapper.text()
    for (const literal of [
      '+67.8%',
      '12.20',
      '41.67',
      'Yield Premium',
      'TPI',
    ]) {
      expect(text).not.toContain(literal)
    }
    expect(wrapper.find('[data-test="metric-card-tpi"]').exists()).toBe(false)
  })
})

describe('AVU_hash is computed from fetched prices and chain statistics', () => {
  it('shows "Unavailable" everywhere and draws no bars when it cannot be computed', async () => {
    useOracleStore().snapshot = oracleSdk.unavailableOracleSnapshot()
    const wrapper = mountChart()
    await openRange(wrapper, 'networks')
    for (const tile of ['avu-hash', 'avu-unit', 'hash-vs-spot', 'arbitrage']) {
      expect(wrapper.find(`[data-test="metric-value-${tile}"]`).text()).toBe(
        'Unavailable',
      )
    }
    expect(wrapper.find('[data-test="metric-card-avu-hash"]').text()).toContain(
      'AVU_hash could not be computed',
    )
    expect(wrapper.findAll('[data-test="chart-hover-bar"]')).toHaveLength(0)
    expect(wrapper.find('[data-test="chart-data-note"]').text()).toContain(
      'AVU_hash could not be computed',
    )
    // AVU_spot does not depend on mining and is still shown.
    expect(
      wrapper.find('[data-test="metric-value-avu-spot"]').text(),
    ).toContain('kWh/$')
  })

  it('shows AVU_hash beside AVU_spot, the coins used with their weights, and those left out', async () => {
    // Bitcoin at 12 kWh/$ and eCash at 6 kWh/$. Bitcoin's market cap dwarfs eCash's, so
    // it is capped at 60%: AVU_hash = 0.6 x 12 + 0.4 x 6 = 9.6 kWh/$.
    setEcashMining(6)
    const wrapper = mountChart()
    await openRange(wrapper, 'networks')
    expect(wrapper.find('[data-test="metric-value-avu-hash"]').text()).toBe(
      '9.60 kWh/$',
    )
    const note = wrapper.find('[data-test="metric-card-avu-hash"]').text()
    expect(note).toContain('2 of 5 basket entries')
    expect(note).toContain('BTC 60%, XEC 40%')
    expect(note).toContain(
      `Cambridge estimate for ${
        oracleSdk.latestHashingEfficiency('sha256')!.month
      }`,
    )
    expect(note).toContain(
      'Left out: BCH (no fetched price), LTC+DOGE (no hardware efficiency data), XMR (no hardware efficiency data).',
    )
    expect(note).not.toContain('Stale')

    // Side by side with AVU_spot, and how far apart the two are.
    const spot = oracleSdk.latestAvuSpot()!
    expect(wrapper.find('[data-test="metric-value-avu-spot"]').text()).toBe(
      `${spot.kwhPerDollar.toFixed(2)} kWh/$`,
    )
    const gap = (9.6 / spot.kwhPerDollar - 1) * 100
    expect(wrapper.find('[data-test="metric-value-hash-vs-spot"]').text()).toBe(
      `${gap >= 0 ? '+' : ''}${gap.toFixed(1)}%`,
    )

    // eCash mining earns 1/6 $ per kWh against Bitcoin's 1/12: twice as much.
    expect(wrapper.find('[data-test="metric-value-arbitrage"]').text()).toBe(
      '+100.0%',
    )
    const bars = wrapper.findAll('[data-test="chart-hover-bar"]')
    expect(bars).toHaveLength(2)
    expect(bars[0].text()).toContain('BTC · 60%')
    expect(bars[0].text()).toContain('$0.083/kWh')
    expect(bars[1].text()).toContain('XEC · 40%')
    expect(bars[1].text()).toContain('$0.167/kWh')
    expect(bars[1].text()).toContain('+100.0%')
  })

  it('marks AVU_hash and every value with the age of chain statistics that have gone stale', async () => {
    setHash(12, NOW - 3 * HOUR)
    const wrapper = mountChart({ selectedWallet: 'solana' })
    setPrice('solana', 110.06)
    await flushPromises()
    expect(wrapper.find('[data-test="metric-value-avu-hash"]').text()).toBe(
      '12.00 kWh/$',
    )
    expect(wrapper.find('[data-test="metric-card-avu-hash"]').text()).toContain(
      'Stale: oldest input fetched 3 h ago.',
    )
    expect(wrapper.find('[data-test="metric-value-token-rate"]').text()).toBe(
      '1 SOL ≈ 1,320.72 AVU (3 h old)',
    )
  })

  it('contains no typed-in rate or efficiency', () => {
    const source = readFileSync(join(__dirname, 'AvuParityChart.vue'), 'utf8')
    expect(source).not.toMatch(/0\.084|11\.9|17\.5|POW_BASELINE|joulesPerHash/)
  })
})
