/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import Panel from './WalletPanel.vue'
import { accountSession } from '../../accounts/session'

jest.mock('../../composables/useBalance', () => ({
  useBalance: () => ({
    loaded: ref(true),
    hasError: ref(false),
    formattedBalance: ref('10 MON'),
    refresh: jest.fn(),
  }),
}))

jest.mock('../../accounts/session', () => ({
  accountSession: {
    backupCodex32: jest.fn(async () => [
      'ms12frnkqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq99w7f0n3p0e2v',
      'ms12frnkpqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq9w4f87m27vx5q',
      'ms12frnkzqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7f8s2j9k30l8p',
    ]),
  },
  accountStatus: { status: 'ready', revision: 1 },
}))

function render() {
  return mount(Panel, {
    global: {
      mocks: {
        $t: (key: string) => key,
        $router: { push: jest.fn() },
      },
      stubs: {
        QScrollArea: { template: '<div><slot /></div>' },
        QList: { template: '<div><slot /></div>' },
        QItem: { template: '<button><slot /></button>' },
        QItemSection: { template: '<span><slot /></span>' },
        QItemLabel: { template: '<span><slot /></span>' },
        QSeparator: { template: '<hr />' },
        QIcon: true,
        QDialog: {
          props: ['modelValue'],
          template: '<div v-if="modelValue" data-test="dialog-stub"><slot /></div>',
        },
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
        QCardActions: { template: '<div><slot /></div>' },
        QBtn: {
          props: ['label', 'disable'],
          template: '<button :disabled="disable" @click="$emit(\'click\')">{{ label }}<slot /></button>',
        },
        QSpinner: true,
      },
      directives: { ripple: {} },
    },
  })
}

describe('WalletPanel Backup Account (Codex32) (Issue #848)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('renders Backup account (Codex32) button', () => {
    const view = render()
    const btn = view.find('[data-test="backup-codex32-button"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('Backup account (Codex32)')
  })

  test('clicking Backup button opens dialog and displays 2-of-3 paper shares', async () => {
    const view = render()
    expect(view.find('[data-test="backup-codex32-dialog"]').exists()).toBe(false)

    await view.find('[data-test="backup-codex32-button"]').trigger('click')
    await flushPromises()

    expect(accountSession.backupCodex32).toHaveBeenCalledWith(2, 3)
    expect(view.find('[data-test="backup-codex32-dialog"]').exists()).toBe(true)

    const shares = view.findAll('[data-test="codex32-share"]')
    expect(shares).toHaveLength(3)
    expect(shares[0].text()).toContain('ms12frnkq')
    expect(shares[1].text()).toContain('ms12frnkp')
    expect(shares[2].text()).toContain('ms12frnkz')

    // Close dialog
    await view.find('[data-test="close-backup-dialog"]').trigger('click')
    await flushPromises()
    expect(view.find('[data-test="backup-codex32-dialog"]').exists()).toBe(false)
  })
})
