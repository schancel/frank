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
        QBtnToggle: { props: ['modelValue', 'options'], template: '<div />' },
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
