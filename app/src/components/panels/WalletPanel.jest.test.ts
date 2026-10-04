/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import Panel from './WalletPanel.vue'
import en from '../../i18n/en-us'

const mockLoaded = ref(true)
const mockError = ref(false)
const mockFormattedBalance = ref('0 MON')

jest.mock('../../composables/useBalance', () => ({
  useBalance: () => ({
    loaded: mockLoaded,
    hasError: mockError,
    formattedBalance: mockFormattedBalance,
    refresh: jest.fn(),
  }),
}))

const t = (key: string) =>
  key.split('.').reduce((value: any, part) => value[part], en)

function render() {
  return mount(Panel, {
    global: {
      mocks: { $t: t, $router: { push: jest.fn() } },
      stubs: {
        QScrollArea: { template: '<div><slot /></div>' },
        QList: { template: '<div><slot /></div>' },
        QItem: { template: '<button><slot /></button>' },
        QItemSection: { template: '<span><slot /></span>' },
        QItemLabel: { template: '<span><slot /></span>' },
        QSeparator: { template: '<hr />' },
        QIcon: true,
      },
      directives: { ripple: {} },
    },
  })
}

afterEach(() => {
  mockLoaded.value = true
  mockError.value = false
  mockFormattedBalance.value = '0 MON'
})

test('renders list of wallets without recovery banners or demo buttons', () => {
  const view = render()
  expect(view.find('[data-test="wallet-row"]').exists()).toBe(true)
  expect(view.find('[data-test="ecash-wallet-row"]').exists()).toBe(true)
  expect(view.find('[data-test="solana-wallet-row"]').exists()).toBe(true)
  expect(view.text()).toContain('Wallets')
  expect(view.text()).toContain('Main wallet')
  expect(view.text()).toContain('eCash')
  expect(view.text()).toContain('Solana')
  // No informative text walls or demo buttons
  expect(view.text()).not.toContain('Messaging is unavailable')
  expect(view.find('[data-test="demo-fund"]').exists()).toBe(false)
  expect(view.find('[data-test="recovery-descriptor"]').exists()).toBe(false)
})

test('displays formatted live balance and handles loading and stale states', async () => {
  const view = render()
  expect(view.find('[data-test="balance-stale"]').exists()).toBe(false)
  expect(view.get('[data-test="wallet-balance"]').text()).toBe('0 MON')

  mockError.value = true
  await flushPromises()
  expect(view.get('[data-test="wallet-balance"]').text()).toBe('0 MON')
  expect(view.get('[data-test="balance-stale"]').text()).toContain('out of date')

  mockLoaded.value = false
  await flushPromises()
  expect(view.get('[data-test="wallet-balance"]').text()).toContain('unavailable')

  mockError.value = false
  await flushPromises()
  expect(view.get('[data-test="wallet-balance"]').text()).toContain('Loading')
})
