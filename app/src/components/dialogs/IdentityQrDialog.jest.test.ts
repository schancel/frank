/** @jest-environment jsdom */

import { mount, flushPromises } from '@vue/test-utils'
import IdentityQrDialog from './IdentityQrDialog.vue'
import { setOwnUsername } from 'src/utils/own-username'
import enUS from '../../i18n/en-us'

const mockCopy = jest.fn()
jest.mock('quasar', () => ({
  copyToClipboard: (...args: unknown[]) => mockCopy(...args),
}))

const mockCopiedNotify = jest.fn()
const mockErrorNotify = jest.fn()
jest.mock('src/utils/notifications', () => ({
  addressCopiedNotify: () => mockCopiedNotify(),
  errorNotify: (...args: unknown[]) => mockErrorNotify(...args),
}))

jest.mock('qrcode.vue', () => ({
  name: 'QrcodeVue',
  props: ['value'],
  template: '<div data-test="mock-qrcode" :data-value="value" />',
}))

const mockCanonicalAddress = jest
  .fn()
  .mockResolvedValue('0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3')
jest.mock('src/utils/own-address', () => ({
  getOwnCanonicalAddress: () => mockCanonicalAddress(),
}))

const mockBackupCodex32 = jest.fn(async () => [
  'ms12frankshareone',
  'ms12franksharetwo',
  'ms12franksharethree',
])
jest.mock('src/accounts/session', () => ({
  accountStatus: { status: 'ready' },
  accountSession: {
    initialize: jest.fn(async () => undefined),
    backupCodex32: (...args: unknown[]) => mockBackupCodex32(...args),
  },
}))

function translator(messages: unknown) {
  return (key: string, params?: Record<string, unknown>) => {
    let value: unknown = key
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], messages)
    if (typeof value === 'string' && params) {
      for (const [k, v] of Object.entries(params)) {
        value = value.replace(`{${k}}`, String(v))
      }
    }
    return typeof value === 'string' ? value : key
  }
}

describe('IdentityQrDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCopy.mockResolvedValue(undefined)
  })

  const mountDialog = (props = {}, options = {}) => {
    return mount(IdentityQrDialog, {
      props: {
        modelValue: true,
        address: '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3',
        name: 'Shammah',
        avatar: 'shammah.png',
        ...props,
      },
      global: {
        mocks: { $t: translator(enUS) },
        directives: { 'close-popup': {} },
        stubs: {
          QDialog: {
            props: ['modelValue'],
            template:
              '<div v-if="modelValue" data-test="q-dialog"><slot /></div>',
          },
          QCard: { template: '<div><slot /></div>' },
          QCardSection: { template: '<div><slot /></div>' },
          QCardActions: { template: '<div><slot /></div>' },
          QAvatar: { template: '<div><slot /></div>' },
          QBanner: { template: '<div><slot name="avatar" /><slot /></div>' },
          QIcon: { template: '<i />' },
          QSpace: { template: '<div />' },
          QInput: {
            props: ['modelValue'],
            template:
              '<div><input :value="modelValue" readonly /><slot name="append" /></div>',
          },
          QBtn: {
            props: ['disable'],
            template: '<button :disabled="disable"><slot /></button>',
          },
          QSkeleton: { template: '<div data-test="skeleton" />' },
        },
        ...options,
      },
    })
  }

  it('shows no username when the relay has not confirmed one, whatever the profile has saved', async () => {
    setOwnUsername(null)
    const wrapper = mountDialog()
    await flushPromises()
    expect(wrapper.find('[data-test="identity-qr-username"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('[data-test="identity-qr-name"]').text()).toBe(
      'Shammah',
    )
  })

  it('renders user identity, name, username, and scannable QR code', async () => {
    // The username shown is the one the relay confirms this account holds.
    setOwnUsername('shammah')
    const wrapper = mountDialog()
    await flushPromises()

    expect(wrapper.find('[data-test="identity-qr-name"]').text()).toBe(
      'Shammah',
    )
    expect(wrapper.find('[data-test="identity-qr-username"]').text()).toBe(
      'shammah',
    )
    expect(
      wrapper.find('[data-test="identity-qr-code"]').attributes('data-value'),
    ).toBe('0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3')
  })

  it('resolves own canonical address when address prop is not passed', async () => {
    const wrapper = mountDialog({ address: '' })
    await flushPromises()

    expect(mockCanonicalAddress).toHaveBeenCalled()
    expect(
      wrapper.find('[data-test="identity-qr-code"]').attributes('data-value'),
    ).toBe('0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3')
  })

  it('copies address to clipboard and fires notification', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    const copyBtn = wrapper.find('[data-test="copy-identity-address-btn"]')
    expect(copyBtn.exists()).toBe(true)

    await copyBtn.trigger('click')
    expect(mockCopy).toHaveBeenCalledWith(
      '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3',
    )
    expect(mockCopiedNotify).toHaveBeenCalled()
  })

  it('emits go-to-wallet and update:modelValue false on clicking Go to Wallet button', async () => {
    const mockRouterPush = jest.fn()
    const wrapper = mountDialog(
      {},
      {
        mocks: {
          $t: translator(enUS),
          $router: { push: mockRouterPush },
        },
      },
    )
    await flushPromises()

    const walletBtn = wrapper.find('[data-test="identity-dialog-goto-wallet"]')
    expect(walletBtn.exists()).toBe(true)

    await walletBtn.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
    expect(wrapper.emitted('go-to-wallet')).toBeTruthy()
    expect(mockRouterPush).toHaveBeenCalledWith('/wallet')
  })

  it('renders both the live camera QR scanner and own QR code on the same screen', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    expect(wrapper.find('[data-test="identity-qr-scanner"]').exists()).toBe(
      true,
    )
    expect(
      wrapper.find('[data-test="identity-qr-scanner-video"]').exists(),
    ).toBe(true)
    expect(wrapper.find('[data-test="identity-qr-code"]').exists()).toBe(true)
  })

  it('renders inline without a modal dialog wrapper when inline is true and does not auto-open camera until requested', async () => {
    const wrapper = mountDialog({ inline: true })
    await flushPromises()

    expect(wrapper.find('.identity-qr-inline-wrapper').exists()).toBe(true)
    expect(wrapper.find('.identity-qr-card--inline').exists()).toBe(true)
    expect(wrapper.find('[data-test="identity-qr-scanner"]').exists()).toBe(
      true,
    )
    expect(
      wrapper.find('[data-test="identity-qr-scanner-video"]').exists(),
    ).toBe(false)
    expect(wrapper.find('[data-test="start-qr-camera-btn"]').exists()).toBe(
      true,
    )
    expect(wrapper.find('[data-test="identity-qr-code"]').exists()).toBe(true)

    await wrapper.find('[data-test="start-qr-camera-btn"]').trigger('click')
    await flushPromises()
    expect(
      wrapper.find('[data-test="identity-qr-scanner-video"]').exists(),
    ).toBe(true)

    await wrapper.find('[data-test="stop-qr-camera-btn"]').trigger('click')
    await flushPromises()
    expect(
      wrapper.find('[data-test="identity-qr-scanner-video"]').exists(),
    ).toBe(false)
  })

  it('renders 1-click account sync without cluttered Extension View bar when in extension mode', async () => {
    const sendMessage = jest.fn(async () => ({
      ok: true,
      result: { ok: true, deliveredToTabCount: 1 },
    }))
    const g = globalThis as Record<string, unknown>
    g.chrome = { runtime: { id: 'frank-test-ext', sendMessage } }
    try {
      const wrapper = mountDialog({
        inline: true,
        runtimeKindOverride: 'chrome-extension',
      })
      await flushPromises()

      expect(wrapper.find('[data-test="extension-view-bar"]').exists()).toBe(
        false,
      )

      await wrapper
        .find('[data-test="sync-account-bridge-btn"]')
        .trigger('click')
      await flushPromises()

      // The push names no target origin and carries no constant SAS code.
      expect(sendMessage).toHaveBeenCalledTimes(1)
      const sent = (sendMessage.mock.calls[0] as unknown[])[0] as Record<
        string,
        any
      >
      expect(sent.type).toBe('extension-push-sync-to-tab')
      expect(sent.payload).toEqual({
        deviceSyncBundle: expect.objectContaining({
          backupShares: ['ms12frankshareone', 'ms12franksharetwo'],
        }),
      })
      expect(JSON.stringify(sent)).not.toContain('482910')

      const { syncTransferCheckCode } = await import(
        '../../utils/extension-account-sync'
      )
      const code = syncTransferCheckCode(sent.payload.deviceSyncBundle)
      expect(code).toMatch(/^\d{6}$/)
      const status = wrapper
        .find('[data-test="identity-qr-sync-status"]')
        .text()
      expect(status).toContain('Sent to your https://signet.mx tab')
      expect(status).toContain(`Check code: ${code}`)

      expect(wrapper.find('.identity-qr-action-grid').exists()).toBe(true)
      expect(wrapper.find('.identity-qr-sync-grid').exists()).toBe(true)
    } finally {
      delete g.chrome
    }
  })
})



