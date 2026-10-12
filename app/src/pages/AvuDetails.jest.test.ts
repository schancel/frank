/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import AvuDetails from './AvuDetails.vue'
import en from '../i18n/en-us'
import { createPinia, setActivePinia } from 'pinia'
import { useOracleStore } from '../stores/oracle'
import { mergeFeed, oracleInputs } from '../stores/oracle-series'
import { testFeed } from '../stores/oracle-test-feed'
import { computeOracleRates, type OracleFeed } from '@frank/wallet/oracle'

const t = (key: string) =>
  key.split('.').reduce((value: any, part) => value?.[part], en) ?? key

function mountPage() {
  return mount(AvuDetails, {
    global: {
      mocks: { $t: t },
      stubs: {
        QHeader: { template: '<header><slot /></header>' },
        QToolbar: { template: '<div><slot /></div>' },
        QToolbarTitle: { template: '<h1><slot /></h1>' },
        QPageContainer: { template: '<main><slot /></main>' },
        QPage: { template: '<section><slot /></section>' },
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
        QCardActions: { template: '<div><slot /></div>' },
        QAvatar: { template: '<div class="avatar-stub"><slot /></div>' },
        QIcon: { template: '<i class="icon-stub" />' },
        QSpace: { template: '<span />' },
        QMarkupTable: { template: '<table><slot /></table>' },
        QBtnToggle: {
          props: ['modelValue', 'options'],
          template: `<div><button v-for="option in options" :key="option.value"
            :data-range="option.value" @click="$emit('update:modelValue', option.value)">{{ option.label }}</button></div>`,
        },
        QBtn: {
          props: ['label', 'disable', 'to'],
          template:
            '<button :data-route="to" :disabled="disable" @click="$emit(\'click\')">{{ label }}<slot /></button>',
        },
      },
    },
  })
}

const NOW = Date.UTC(2026, 9, 10, 12) / 1000
const DAY = 86400
function receive(feed: OracleFeed) {
  const oracle = useOracleStore()
  const cache = mergeFeed(oracle.cache, feed, NOW)
  oracle.$patch({
    cache,
    current: computeOracleRates(oracleInputs(cache)!, NOW),
  })
  return oracle
}
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000)
  setActivePinia(createPinia())
  useOracleStore().useFeedSource(async () => undefined)
})
afterEach(() => {
  jest.restoreAllMocks()
})

describe('AVU dollar reference details', () => {
  function chartWithHistory(times = [NOW - 3600, NOW - 2400, NOW - 1200, NOW]) {
    const oracle = receive(
      testFeed(times, { electricity: times.map(at => [at, 0.05]) }),
    )
    const ensure = jest
      .spyOn(oracle, 'ensureHistory')
      .mockImplementation(async () => undefined)
    const wrapper = mountPage()
    const chart = wrapper.get('[data-test="avu-reference-chart"]')
    jest.spyOn(chart.element, 'getBoundingClientRect').mockReturnValue({
      left: 10,
      width: 300,
      top: 0,
      height: 130,
      right: 310,
      bottom: 130,
      x: 10,
      y: 0,
      toJSON: () => ({}),
    })
    return { wrapper, chart, ensure }
  }

  test.each(['mouse', 'touch'])(
    'zooms both references by %s drag at mobile width and resets',
    async pointerType => {
      const { wrapper, chart, ensure } = chartWithHistory()
      const current = wrapper
        .get('[data-test="avu-reference-current-hash"]')
        .text()
      const pointer = { pointerId: 1, pointerType, button: 0 }
      await chart.trigger('pointerdown', { ...pointer, clientX: 40 })
      await chart.trigger('pointermove', { ...pointer, clientX: 124 })
      expect(
        wrapper.find('[data-test="avu-reference-selection"]').exists(),
      ).toBe(true)
      await chart.trigger('pointerup', { ...pointer, clientX: 124 })
      for (const id of ['hash', 'spot'])
        expect(
          wrapper.findAll(`[data-test="avu-reference-point-${id}"]`),
        ).toHaveLength(2)
      expect(
        wrapper.get('[data-test="avu-reference-current-hash"]').text(),
      ).toBe(current)
      await wrapper.vm.$nextTick()
      expect(ensure).toHaveBeenCalledWith(NOW - 3600, 60, NOW - 2400)
      await wrapper.get('[data-test="avu-reference-reset"]').trigger('click')
      expect(
        wrapper.findAll('[data-test="avu-reference-point-hash"]'),
      ).toHaveLength(4)
      expect(wrapper.find('[data-test="avu-reference-reset"]').exists()).toBe(
        false,
      )
      wrapper.unmount()
    },
  )

  test('reverse drag clamps to plot bounds and range changes clear zoom', async () => {
    const { wrapper, chart } = chartWithHistory()
    const pointer = { pointerId: 2, pointerType: 'touch' }
    await chart.trigger('pointerdown', { ...pointer, clientX: 207 })
    await chart.trigger('pointerup', { ...pointer, clientX: -100 })
    expect(
      wrapper.findAll('[data-test="avu-reference-point-hash"]'),
    ).toHaveLength(3)
    await wrapper.get('[data-range="7d"]').trigger('click')
    expect(wrapper.find('[data-test="avu-reference-reset"]').exists()).toBe(
      false,
    )
    expect(
      wrapper.findAll('[data-test="avu-reference-point-hash"]'),
    ).toHaveLength(4)
    wrapper.unmount()
  })

  test('cancelled and single-point selections cannot zoom', async () => {
    const { wrapper, chart } = chartWithHistory()
    await chart.trigger('pointerdown', { pointerId: 1, clientX: 40 })
    await chart.trigger('pointermove', { pointerId: 1, clientX: 200 })
    await chart.trigger('pointercancel', { pointerId: 1 })
    await chart.trigger('pointerup', { pointerId: 1, clientX: 200 })
    expect(wrapper.find('[data-test="avu-reference-reset"]').exists()).toBe(
      false,
    )
    wrapper.unmount()
    setActivePinia(createPinia())
    useOracleStore().useFeedSource(async () => undefined)
    const single = chartWithHistory([NOW])
    await single.chart.trigger('pointerdown', { pointerId: 1, clientX: 40 })
    await single.chart.trigger('pointerup', { pointerId: 1, clientX: 200 })
    expect(
      single.wrapper.find('[data-test="avu-reference-reset"]').exists(),
    ).toBe(false)
    single.wrapper.unmount()
  })

  test('labels actual short history with times and keeps endpoint text inside the plot', () => {
    const { wrapper, chart } = chartWithHistory()
    const labels = chart
      .findAll('text')
      .filter(label => label.attributes('y') === '246')
    expect(labels).toHaveLength(2)
    expect(labels[0].text()).toMatch(/:/)
    expect(labels[1].text()).toMatch(/:/)
    expect(labels[0].attributes('x')).toBe('60')
    expect(labels[1].attributes('text-anchor')).toBe('end')
    wrapper.unmount()
  })

  test('puts the shared USD-per-AVU chart before collapsed neutral methodology', () => {
    const wrapper = mountPage()
    expect(wrapper.get('[data-test="avu-explainer-card"]').text()).toContain(
      en.walletPanel.avuReferenceTitle,
    )
    expect(wrapper.get('[data-test="avu-reference-axis"]').text()).toBe(
      'USD per AVU',
    )
    const chart = wrapper.get('[data-test="avu-reference-chart"]').element
    const method = wrapper.get('[data-test="avu-reference-methodology"]')
    expect(
      chart.compareDocumentPosition(method.element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(method.attributes('open')).toBeUndefined()
    expect(wrapper.text()).not.toMatch(
      /Refusing the USD Meme|Bypassing the CPI|Oracle-Less/,
    )
  })

  test('with no feed both references and coin rows are unavailable, with no invented curve', () => {
    const wrapper = mountPage()
    for (const id of ['hash', 'spot'])
      expect(
        wrapper.get(`[data-test="avu-reference-current-${id}"]`).text(),
      ).toContain('Unavailable')
    for (const asset of [
      'monad',
      'solana',
      'ethereum',
      'ecash',
      'bitcoin',
      'usd',
    ])
      expect(
        wrapper.get(`[data-test="avu-rate-row-${asset}"]`).text(),
      ).toContain('Unavailable')
    expect(wrapper.findAll('circle')).toHaveLength(0)
    expect(wrapper.get('[data-test="avu-reference-note"]').text()).toBe(
      en.walletPanel.avuReferenceNoHistory,
    )
  })

  test('plots both inverse energy valuations on one shared USD axis and keeps coin amounts unchanged', () => {
    const times = [NOW - 3600, NOW - 60]
    receive(
      testFeed(times, {
        prices: { 'solana-mainnet': 110, 'xec-mainnet': 0.00001 },
        electricity: times.map(at => [at, 0.05]),
      }),
    )
    const wrapper = mountPage()
    expect(
      wrapper.get('[data-test="avu-reference-current-hash"]').text(),
    ).toContain('$0.10')
    expect(
      wrapper.get('[data-test="avu-reference-current-spot"]').text(),
    ).toContain('$0.05')
    for (const id of ['hash', 'spot']) {
      expect(
        wrapper.findAll(`[data-test="avu-reference-point-${id}"]`),
      ).toHaveLength(2)
      expect(
        wrapper.find(`[data-test="avu-reference-line-${id}"]`).exists(),
      ).toBe(true)
    }
    const hashY = Number(
      wrapper.get('[data-test="avu-reference-point-hash"]').attributes('cy'),
    )
    const spotY = Number(
      wrapper.get('[data-test="avu-reference-point-spot"]').attributes('cy'),
    )
    // Both series share a scale: the larger USD/AVU value is higher.
    expect(hashY).toBeLessThan(spotY)
    expect(wrapper.get('[data-test="avu-rate-row-solana"]').text()).toContain(
      '1 SOL ≈ 1.1 kAVU · testnet',
    )
    expect(wrapper.get('[data-test="avu-rate-row-ecash"]').text()).toContain(
      '1M XEC ≈ 100 AVU · testnet',
    )
    expect(wrapper.get('[data-test="avu-rate-row-ethereum"]').text()).toContain(
      'Unavailable',
    )
  })

  test('shows a single observation as a point and never invents missing spot history or future points', () => {
    receive(testFeed([NOW - 60, NOW + 60]))
    const wrapper = mountPage()
    expect(
      wrapper.findAll('[data-test="avu-reference-point-hash"]'),
    ).toHaveLength(1)
    expect(
      wrapper.findAll('[data-test="avu-reference-point-spot"]'),
    ).toHaveLength(0)
    expect(wrapper.findAll('[data-test^="avu-reference-line-"]')).toHaveLength(
      0,
    )
    expect(wrapper.get('[data-test="avu-reference-note"]').text()).toContain(
      en.walletPanel.avuReferenceSinglePoint,
    )
  })

  test('does not connect a spot curve across a non-positive electricity observation', () => {
    const times = [NOW - 3600, NOW - 1800, NOW - 60]
    receive(
      testFeed(times, {
        electricity: [
          [times[0], 0.05],
          [times[1], -0.01],
          [times[2], 0.05],
        ],
      }),
    )
    const wrapper = mountPage()
    expect(
      wrapper.findAll('[data-test="avu-reference-point-spot"]'),
    ).toHaveLength(2)
    expect(wrapper.find('[data-test="avu-reference-line-spot"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('[data-test="avu-reference-line-hash"]').exists()).toBe(
      true,
    )
  })

  test('marks old benchmark inputs and requests history while the page is mounted', async () => {
    const oracle = receive(
      testFeed([NOW - 4 * DAY], { electricity: [[NOW - 4 * DAY, 0.05]] }),
    )
    const ensure = jest
      .spyOn(oracle, 'ensureHistory')
      .mockImplementation(async () => undefined)
    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(
      wrapper.get('[data-test="avu-reference-current-hash"]').text(),
    ).toContain('Stale')
    expect(
      wrapper.get('[data-test="avu-reference-current-spot"]').text(),
    ).toContain('Stale')
    expect(ensure).toHaveBeenCalled()
    wrapper.unmount()
  })

  test('provides a wallet route, explicit legend and a USD row consistent with the inverse chart', () => {
    const oracle = receive(
      testFeed([NOW - 60], { electricity: [[NOW - 60, 0.05]] }),
    )
    const wrapper = mountPage()
    expect(
      wrapper.get('[data-test="avu-back-wallet"]').attributes('data-route'),
    ).toBe('/wallet')
    expect(wrapper.get('[data-test="avu-reference-legend"]').text()).toContain(
      'AVU (Hash)',
    )
    expect(wrapper.get('[data-test="avu-reference-legend"]').text()).toContain(
      'AVU (Spot)',
    )
    const kwhPerUsd = oracle.current.avuHash!.kwhPerValue
    expect(wrapper.get('[data-test="avu-rate-row-usd"]').text()).toContain(
      `${kwhPerUsd} AVU`,
    )
    const inverse = 1 / kwhPerUsd
    expect(
      wrapper.get('[data-test="avu-reference-current-hash"]').text(),
    ).toContain(
      inverse.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }),
    )
    expect(wrapper.find('[data-test="avu-rate-row-usdc"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="avu-rate-row-tusd"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="avu-rate-row-tempo"]').exists()).toBe(
      false,
    )
    expect(wrapper.text()).not.toMatch(/USDC|USDT|TUSD/)
    expect(wrapper.text()).not.toMatch(/AVU_hash|AVU_spot/)
  })
})

test('discloses subsidy-only mining basis on the reference page', () => {
  const feed = testFeed([NOW - 60])
  feed.series['minerSubsidy/btc-mainnet'] =
    feed.series['minerRevenue/btc-mainnet']
  delete feed.series['minerRevenue/btc-mainnet']
  receive(feed)
  const wrapper = mountPage()
  expect(wrapper.get('[data-test="avu-fees-excluded"]').text()).toBe(
    en.walletPanel.avuFeesExcluded,
  )
  wrapper.unmount()
})
