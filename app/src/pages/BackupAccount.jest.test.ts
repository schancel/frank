/** @jest-environment jsdom */

import { mount, flushPromises } from '@vue/test-utils'
import BackupAccount from './BackupAccount.vue'

const mockRouterBack = jest.fn()
const mockRouterPush = jest.fn()
jest.mock('vue-router', () => ({
  useRouter: () => ({
    back: mockRouterBack,
    push: mockRouterPush,
  }),
}))

const mockShares = [
  'ms12frnkqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq99w7f0n3p0e2v',
  'ms12frnkpqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq9w4f87m27vx5q',
  'ms12frnkzqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7f8s2j9k30l8p',
]

const mockBackupCodex32 = jest.fn(async () => mockShares)

jest.mock('../accounts/session', () => ({
  accountSession: {
    backupCodex32: (t: number, c: number) => mockBackupCodex32(t, c),
  },
}))

function mountPage() {
  return mount(BackupAccount, {
    global: {
      mocks: {
        $t: (key: string, values?: Record<string, unknown>) => {
          if (values) {
            return `${key}:${JSON.stringify(values)}`
          }
          return key
        },
      },
      stubs: {
        QHeader: { template: '<header><slot /></header>' },
        QToolbar: { template: '<div><slot /></div>' },
        QToolbarTitle: { template: '<h1><slot /></h1>' },
        QPageContainer: { template: '<main><slot /></main>' },
        QPage: { template: '<section><slot /></section>' },
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
        QCardActions: { template: '<div><slot /></div>' },
        QBtn: {
          props: ['label', 'disable'],
          template: '<button :disabled="disable">{{ label }}<slot /></button>',
        },
        QInput: {
          props: ['modelValue', 'label'],
          template:
            '<input :value="modelValue" @input="$emit(\'update:modelValue\', Number($event.target.value))" />',
        },
        QSpinner: { template: '<span data-test="spinner" />' },
        QTooltip: { template: '<span />' },
      },
    },
  })
}

describe('BackupAccount page', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    Object.assign(navigator, {
      clipboard: {
        writeText: jest.fn().mockResolvedValue(undefined),
      },
    })
  })

  it('renders header, back button, and generates shares on mount', async () => {
    const wrapper = mountPage()
    await flushPromises()

    expect(wrapper.find('[data-test="backup-back"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="backup-menu"]').exists()).toBe(true)
    expect(mockBackupCodex32).toHaveBeenCalledWith(2, 3)

    const shares = wrapper.findAll('[data-test="codex32-share"]')
    expect(shares.length).toBe(3)
    expect(shares[0].text()).toBe(mockShares[0])
    expect(shares[1].text()).toBe(mockShares[1])
    expect(shares[2].text()).toBe(mockShares[2])
  })

  it('cycles preset schemes when clicking scheme button', async () => {
    const wrapper = mountPage()
    await flushPromises()

    const schemeBtn = wrapper.find('[data-test="codex32-scheme-btn"]')
    expect(schemeBtn.exists()).toBe(true)

    await schemeBtn.trigger('click')
    await flushPromises()
    expect(mockBackupCodex32).toHaveBeenCalledWith(3, 5)

    await schemeBtn.trigger('click')
    await flushPromises()
    expect(mockBackupCodex32).toHaveBeenCalledWith(6, 10)
  })

  it('allows configuring and applying custom threshold and share count', async () => {
    const wrapper = mountPage()
    await flushPromises()

    expect(wrapper.find('[data-test="custom-scheme-section"]').exists()).toBe(
      false,
    )
    await wrapper
      .find('[data-test="codex32-custom-scheme-btn"]')
      .trigger('click')
    expect(wrapper.find('[data-test="custom-scheme-section"]').exists()).toBe(
      true,
    )

    const thresholdInput = wrapper.find('[data-test="input-threshold"]')
    const countInput = wrapper.find('[data-test="input-count"]')

    await thresholdInput.setValue(4)
    await countInput.setValue(7)

    const applyBtn = wrapper.find('[data-test="apply-custom-scheme"]')
    await applyBtn.trigger('click')
    await flushPromises()

    expect(mockBackupCodex32).toHaveBeenCalledWith(4, 7)
    expect(wrapper.find('[data-test="custom-scheme-section"]').exists()).toBe(
      false,
    )
  })

  it('copies share to clipboard when copy button clicked', async () => {
    const wrapper = mountPage()
    await flushPromises()

    const copyBtns = wrapper.findAll('[data-test="copy-share"]')
    expect(copyBtns.length).toBe(3)

    await copyBtns[0].trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(mockShares[0])

    await flushPromises()
    expect(wrapper.find('[data-test="copy-status"]').text()).toContain(
      'Share 1 copied.',
    )
  })

  it('navigates back when cancel/done is clicked', async () => {
    const wrapper = mountPage()
    await flushPromises()

    const backBtn = wrapper.find('[data-test="backup-back"]')
    await backBtn.trigger('click')
    // navigateBack checks history.state.back; if unset, it pushes '/'
    expect(mockRouterPush).toHaveBeenCalledWith('/')
  })
})
