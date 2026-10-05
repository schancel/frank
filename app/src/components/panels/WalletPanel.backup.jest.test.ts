/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import Panel from './WalletPanel.vue'
import { accountSession } from '../../accounts/session'
import en from '../../i18n/en-us'

const t = (key: string) =>
  key.split('.').reduce((v: any, p) => v?.[p], en) ?? key

jest.mock('vue-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useRoute: () => ({ path: '/wallet', query: {} }),
}))

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
        $t: t,
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
        QTooltip: true,
        QBadge: true,
        QInput: {
          props: ['modelValue', 'label'],
          template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', Number($event.target.value))" />',
        },
        QDialog: {
          props: ['modelValue'],
          template: '<div v-if="modelValue" data-test="dialog-stub"><slot /></div>',
        },
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
        QCardActions: { template: '<div><slot /></div>' },
        QBtn: {
          props: ['label', 'disable'],
          template: '<button :disabled="disable">{{ label }}<slot /></button>',
        },
        QSpinner: true,
        RenameWalletDialog: true,
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

  test('clicking Backup button opens dialog and displays 2-of-3 paper shares by default', async () => {
    const view = render()
    expect(view.find('[data-test="backup-codex32-dialog"]').exists()).toBe(false)

    await view.find('[data-test="backup-codex32-button"]').trigger('click')
    await flushPromises()

    expect(accountSession.backupCodex32).toHaveBeenCalledWith(2, 3)
    expect(view.find('[data-test="backup-codex32-dialog"]').exists()).toBe(true)

    const schemeBtn = view.find('[data-test="codex32-scheme-btn"]')
    expect(schemeBtn.exists()).toBe(true)
    expect(schemeBtn.text()).toContain('2 of 3')

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

  test('clicking scheme button cycles: 2 of 3 -> 3 of 5 -> 6 of 10 -> back to 2 of 3', async () => {
    const view = render()
    await view.find('[data-test="backup-codex32-button"]').trigger('click')
    await flushPromises()

    const schemeBtn = view.find('[data-test="codex32-scheme-btn"]')
    expect(schemeBtn.text()).toContain('2 of 3')
    expect(accountSession.backupCodex32).toHaveBeenLastCalledWith(2, 3)

    // Click 1: 2 of 3 -> 3 of 5
    await schemeBtn.trigger('click')
    await flushPromises()
    expect(accountSession.backupCodex32).toHaveBeenLastCalledWith(3, 5)
    expect(schemeBtn.text()).toContain('3 of 5')

    // Click 2: 3 of 5 -> 6 of 10
    await schemeBtn.trigger('click')
    await flushPromises()
    expect(accountSession.backupCodex32).toHaveBeenLastCalledWith(6, 10)
    expect(schemeBtn.text()).toContain('6 of 10')

    // Click 3: 6 of 10 -> 2 of 3
    await schemeBtn.trigger('click')
    await flushPromises()
    expect(accountSession.backupCodex32).toHaveBeenLastCalledWith(2, 3)
    expect(schemeBtn.text()).toContain('2 of 3')
  })

  test('custom configuration allows setting custom threshold and count (e.g. 2 of 10)', async () => {
    const view = render()
    await view.find('[data-test="backup-codex32-button"]').trigger('click')
    await flushPromises()

    // Initially custom section is hidden
    expect(view.find('[data-test="custom-scheme-section"]').exists()).toBe(false)

    // Click custom config tune button to open section
    await view.find('[data-test="codex32-custom-scheme-btn"]').trigger('click')
    await flushPromises()
    expect(view.find('[data-test="custom-scheme-section"]').exists()).toBe(true)

    // Update threshold to 2, count to 10
    const thresholdInput = view.find('[data-test="input-threshold"]')
    const countInput = view.find('[data-test="input-count"]')

    await thresholdInput.setValue(2)
    await countInput.setValue(10)

    // Apply custom scheme
    await view.find('[data-test="apply-custom-scheme"]').trigger('click')
    await flushPromises()

    expect(accountSession.backupCodex32).toHaveBeenLastCalledWith(2, 10)
    const schemeBtn = view.find('[data-test="codex32-scheme-btn"]')
    expect(schemeBtn.text()).toContain('2 of 10')
    expect(view.find('[data-test="custom-scheme-section"]').exists()).toBe(false)
  })
})
