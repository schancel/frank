/** @jest-environment jsdom */

import { mount, flushPromises } from '@vue/test-utils'
import IdentityQrDialog from './IdentityQrDialog.vue'
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
        username: 'shammah',
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

  it('renders user identity, name, username, and scannable QR code', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    expect(wrapper.find('[data-test="identity-qr-name"]').text()).toBe(
      'Shammah',
    )
    expect(wrapper.find('[data-test="identity-qr-username"]').text()).toBe(
      '@shammah',
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
})
