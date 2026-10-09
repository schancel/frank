/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import Panel from './WalletPanel.vue'
import { accountSession } from '../../accounts/session'
import en from '../../i18n/en-us'

const t = (key: string) =>
  key.split('.').reduce((v: any, p) => v?.[p], en) ?? key

const mockRouterPush = jest.fn()
const mockRouterReplace = jest.fn()

jest.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: mockRouterReplace,
    currentRoute: { value: { path: '/wallet' } },
  }),
  useRoute: () => ({ path: '/wallet', query: {} }),
}))

jest.mock('../../composables/useBalance', () => ({
  useBalance: () => ({
    loaded: ref(true),
    hasError: ref(false),
    formattedBalance: ref('10 MON'),
    balance: ref(10n),
    refresh: jest.fn(),
  }),
}))

// Backup navigation does not need balance readers or RPC polling.
jest.mock('../../composables/useChainBalance', () => ({
  useMultichainBalance: () => ({
    monad: jest.requireMock('../../composables/useBalance').useBalance(),
    getPresentation: () => ({ status: 'loading' }),
    getRawBalance: () => null,
    getTokens: () => [],
  }),
}))

jest.mock('../../accounts/session', () => ({
  accountSession: {
    getChainAddress: jest.fn(async () => '0x0'),
  },
  accountStatus: { status: 'ready', revision: 1 },
}))

function render() {
  return mount(Panel, {
    global: {
      mocks: {
        $t: t,
        $router: {
          push: mockRouterPush,
          replace: mockRouterReplace,
          currentRoute: { value: { path: '/wallet' } },
        },
      },
      stubs: {
        QScrollArea: { template: '<div><slot /></div>' },
        QList: { template: '<div><slot /></div>' },
        QItem: { template: '<button><slot /></button>' },
        QItemSection: { template: '<span><slot /></span>' },
        QItemLabel: { template: '<span><slot /></span>' },
        QSeparator: { template: '<hr />' },
        QIcon: true,
        QTooltip: true,
        QBadge: true,
        QBtn: {
          props: ['label', 'disable'],
          template: '<button :disabled="disable">{{ label }}<slot /></button>',
        },
        RenameWalletDialog: true,
      },
      directives: { ripple: {} },
    },
  })
}

describe('WalletPanel Backup Account (Codex32) (Issue #848, #1042)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('renders Backup account (Codex32) button', () => {
    const view = render()
    const btn = view.find('[data-test="backup-codex32-button"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('Backup account (Codex32)')
  })

  test('clicking Backup button navigates to /backup instead of opening a dialog', async () => {
    const view = render()
    expect(view.find('[data-test="backup-codex32-dialog"]').exists()).toBe(
      false,
    )

    await view.find('[data-test="backup-codex32-button"]').trigger('click')
    await flushPromises()

    expect(mockRouterPush).toHaveBeenCalledWith('/backup')
    expect(view.find('[data-test="backup-codex32-dialog"]').exists()).toBe(
      false,
    )
  })
})
