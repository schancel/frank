/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://signet.mx/"}
 */

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

  it('extension: shows the PIN from its background session, follows PIN changes, and puts no account on any web channel', async () => {
    const runtimeListeners: Array<
      (msg: any, sender: any, respond: any) => any
    > = []
    const sendMessage = jest.fn(async () => ({
      ok: true,
      result: { ok: true, pin: '123456' },
    }))
    const postMessage = jest.spyOn(window, 'postMessage')
    const g = globalThis as Record<string, unknown>
    g.chrome = {
      runtime: {
        id: 'frank-test-ext',
        sendMessage,
        onMessage: {
          addListener: (fn: any) => runtimeListeners.push(fn),
          removeListener: jest.fn(),
        },
      },
    }
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

      // The bundle goes only to this extension's own background.
      expect(sendMessage).toHaveBeenCalledTimes(1)
      const sent = (sendMessage.mock.calls[0] as unknown[])[0] as Record<
        string,
        any
      >
      expect(sent.type).toBe('extension-sync-offer')
      expect(sent.payload.deviceSyncBundle.backupShares).toEqual([
        'ms12frankshareone',
        'ms12franksharetwo',
      ])
      expect(JSON.stringify(postMessage.mock.calls)).not.toContain(
        'ms12frankshare',
      )
      expect(wrapper.get('[data-test="identity-qr-sync-pin"]').text()).toBe(
        '123456',
      )
      expect(
        wrapper.get('[data-test="identity-qr-sync-pin-block"]').text(),
      ).toContain(enUS.accountSync.showPin)
      expect(wrapper.text()).not.toContain('Check code')

      const update = async (msg: Record<string, unknown>) => {
        for (const fn of runtimeListeners) {
          fn(
            {
              channel: 'frank-pwa-extension-sync-v1',
              type: 'sync-sender-update',
              ...msg,
            },
            {},
            jest.fn(),
          )
        }
        await flushPromises()
      }
      await update({ status: 'new-pin', pin: '654321' })
      expect(wrapper.get('[data-test="identity-qr-sync-pin"]').text()).toBe(
        '654321',
      )
      expect(
        wrapper.get('[data-test="identity-qr-sync-pin-block"]').text(),
      ).toContain(enUS.accountSync.newPinAfterMismatch)

      await update({ status: 'sent' })
      expect(wrapper.find('[data-test="identity-qr-sync-pin"]').exists()).toBe(
        false,
      )
      expect(wrapper.get('[data-test="identity-qr-sync-status"]').text()).toBe(
        enUS.accountSync.sent,
      )
      expect(wrapper.find('.identity-qr-action-grid').exists()).toBe(true)
      expect(wrapper.find('.identity-qr-sync-grid').exists()).toBe(true)
    } finally {
      delete g.chrome
      postMessage.mockRestore()
    }
  })

  describe('web app (https://signet.mx) handing its account to the extension', () => {
    const SHARES = ['ms12frankshareone', 'ms12franksharetwo']
    let postMessage: jest.SpyInstance

    beforeEach(() => {
      postMessage = jest.spyOn(window, 'postMessage').mockImplementation()
    })
    afterEach(async () => {
      postMessage.mockRestore()
      const { pageSyncSender } = await import(
        '../../utils/extension-account-sync'
      )
      pageSyncSender.value = null
    })

    /** The extension's side: its content script delivers pairing messages to the page. */
    async function extensionSide() {
      const { handlePageSyncPairingRequest } = await import(
        '../../utils/extension-account-sync'
      )
      const { receiveSyncBundle } = await import('../../utils/sync-pairing')
      const send = async (type: string, payload?: unknown) => {
        handlePageSyncPairingRequest({
          source: window,
          origin: window.location.origin,
          data: {
            channel: 'frank-pwa-extension-sync-v1',
            direction: 'to-pwa',
            type,
            id: `pair-${type}`,
            payload,
          },
        } as unknown as MessageEvent)
        return (postMessage.mock.calls.at(-1)![0] as { result: unknown }).result
      }
      return (pin: string) => receiveSyncBundle(pin, send as any)
    }

    async function startSync() {
      const wrapper = mountDialog({ inline: true, runtimeKindOverride: 'pwa' })
      await flushPromises()
      await wrapper
        .find('[data-test="sync-account-bridge-btn"]')
        .trigger('click')
      await flushPromises()
      return wrapper
    }

    it('with the right PIN the extension gets the account; the page window only ever carries ciphertext', async () => {
      const wrapper = await startSync()
      const pin = wrapper.get('[data-test="identity-qr-sync-pin"]').text()
      expect(pin).toMatch(/^\d{6}$/)
      expect(
        wrapper.get('[data-test="identity-qr-sync-pin-block"]').text(),
      ).toContain(enUS.accountSync.showPin)

      const receive = await extensionSide()
      const result = await receive(pin)
      expect(result.ok).toBe(true)
      expect(result.ok && result.bundle.backupShares).toEqual(SHARES)
      await flushPromises()
      expect(wrapper.get('[data-test="identity-qr-sync-status"]').text()).toBe(
        enUS.accountSync.sent,
      )
      const onWindow = JSON.stringify(postMessage.mock.calls)
      expect(onWindow).not.toContain(SHARES[0])
      expect(onWindow).not.toContain(pin)
    })

    it('with a wrong PIN nothing derived from the shares is posted, and a new PIN is shown', async () => {
      const wrapper = await startSync()
      const pin = wrapper.get('[data-test="identity-qr-sync-pin"]').text()
      const receive = await extensionSide()
      const result = await receive(pin === '000000' ? '000001' : '000000')
      expect(result).toEqual({ ok: false, reason: 'pin-mismatch' })
      await flushPromises()

      const onWindow = JSON.stringify(postMessage.mock.calls)
      expect(onWindow).not.toContain(SHARES[0])
      expect(onWindow).not.toContain('ciphertext')
      expect(
        wrapper.get('[data-test="identity-qr-sync-pin-block"]').text(),
      ).toContain(enUS.accountSync.newPinAfterMismatch)
      const newPin = wrapper.get('[data-test="identity-qr-sync-pin"]').text()
      expect(newPin).toMatch(/^\d{6}$/)
      expect((await receive(newPin)).ok).toBe(true)
    })
  })
})
