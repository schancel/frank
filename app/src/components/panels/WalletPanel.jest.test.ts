/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import Panel from './WalletPanel.vue'
import en from '../../i18n/en-us'
const mockEnsure = jest.fn(async () => ({}))
const mockReceive = '0x1111111111111111111111111111111111111111'
const mockRefresh = jest.fn(async () => undefined)
jest.mock('@frank/bot/demo/demo-funding', () => ({
  ensureDemoBalance: (...args: unknown[]) => mockEnsure(...args),
}))
jest.mock('../../accounts/session', () => ({
  accountStatus: {
    status: 'ready',
    revision: 1,
    account: {
      descriptor: 'PUBLIC-DESCRIPTOR',
      fingerprint: 'PUBLIC-FINGERPRINT',
    },
  },
  accountSession: {
    getWallet: async () => ({
      identity: { address: { raw: 'AUTH-ADDRESS-DO-NOT-FUND' } },
      getReceiveAddress: async () => ({ raw: mockReceive }),
    }),
  },
}))
jest.mock('../../composables/useBalance', () => ({
  useBalance: () => ({
    loaded: ref(true),
    formattedBalance: ref('0 MON'),
    refresh: mockRefresh,
  }),
}))
const t = (key: string) =>
  key.split('.').reduce((value: any, part) => value[part], en)
function render() {
  return mount(Panel, {
    global: {
      mocks: { $t: t, $router: { push: jest.fn() } },
      stubs: {
        QList: { template: '<div><slot /></div>' },
        QItem: { template: '<button><slot /></button>' },
        QItemSection: { template: '<span><slot /></span>' },
        QItemLabel: { template: '<span><slot /></span>' },
        QBtn: { props: ['label'], template: '<button>{{label}}</button>' },
        QInput: true,
        QIcon: true,
      },
      directives: { ripple: {} },
    },
  })
}
afterEach(() => {
  delete process.env.QCLI_FRANK_FAKE_DEMO
  delete process.env.QCLI_FRANK_DEMO_CONTROL_URL
  mockEnsure.mockClear()
})
test('normal mode has no fake-funding action and accurately disables messaging', () => {
  const view = render()
  expect(view.find('[data-test="demo-fund"]').exists()).toBe(false)
  expect(view.text()).toContain('Messaging is unavailable')
  expect(view.text()).toContain('cannot recreate')
  expect(mockEnsure).not.toHaveBeenCalled()
})
test('explicit loopback fake mode funds only the distinct native receive address and refreshes balance', async () => {
  process.env.QCLI_FRANK_FAKE_DEMO = 'true'
  process.env.QCLI_FRANK_DEMO_CONTROL_URL = 'http://127.0.0.1:8545'
  const view = render()
  await view.get('[data-test="demo-fund"]').trigger('click')
  await flushPromises()
  expect(mockEnsure).toHaveBeenCalledWith(
    { fakeChain: true, rpcUrl: 'http://127.0.0.1:8545' },
    mockReceive,
  )
  expect(mockRefresh).toHaveBeenCalledTimes(1)
})
test('remote URLs cannot expose a funding action even with the fake flag', () => {
  process.env.QCLI_FRANK_FAKE_DEMO = 'true'
  process.env.QCLI_FRANK_DEMO_CONTROL_URL = 'https://example.invalid'
  expect(render().find('[data-test="demo-fund"]').exists()).toBe(false)
  expect(mockEnsure).not.toHaveBeenCalled()
})
test('an unavailable fake capability reports bounded failure without changing the account', async () => {
  process.env.QCLI_FRANK_FAKE_DEMO = 'true'
  process.env.QCLI_FRANK_DEMO_CONTROL_URL = 'http://127.0.0.1:8545'
  mockEnsure.mockRejectedValueOnce(new Error('PRIVATE-ERROR-SENTINEL'))
  const view = render()
  await view.get('[data-test="demo-fund"]').trigger('click')
  await flushPromises()
  expect(view.get('[data-test="fund-status"]').text()).toContain(
    'Your account remains active',
  )
  expect(view.text()).not.toContain('PRIVATE-ERROR-SENTINEL')
})
