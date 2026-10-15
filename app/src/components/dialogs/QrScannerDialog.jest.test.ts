/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { reactive } from 'vue'
import QrScannerDialog, { isRawQrAddress } from './QrScannerDialog.vue'
const mockDecode = jest.fn()
jest.mock('@zxing/browser', () => ({
  BrowserQRCodeReader: jest.fn(() => ({ decodeFromStream: mockDecode })),
}))
const address = '0x1234567890123456789012345678901234567890'
const result = { getText: () => address }
const getUserMedia = jest.fn()
const makeStream = () => {
  const stop = jest.fn()
  return {
    stream: { getTracks: () => [{ stop }] } as unknown as MediaStream,
    stop,
  }
}
let wrappers: ReturnType<typeof mount>[] = []
function dialog(context = () => '1:monad-testnet') {
  const wrapper = mount(QrScannerDialog, {
    props: {
      modelValue: false,
      networkName: 'Monad Testnet',
      context,
      validateAddress: v => v === address,
    },
    global: {
      mocks: { $t: (key: string) => key },
      stubs: {
        QDialog: { template: '<div><slot /></div>' },
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
        QCardActions: { template: '<div><slot /></div>' },
        QBtn: {
          template: '<button @click="$emit(\'click\')"><slot /></button>',
        },
        QSpace: true,
      },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}
beforeEach(() => {
  jest.clearAllMocks()
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value: true,
  })
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    value: false,
  })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  })
})
afterEach(() => {
  wrappers.forEach(w => w.unmount())
  wrappers = []
})
it('requests camera only when opened, publishes once and stops tracks', async () => {
  const { stream, stop } = makeStream()
  const controls = { stop: jest.fn() }
  let callback: (r: unknown) => void = jest.fn()
  getUserMedia.mockResolvedValue(stream)
  mockDecode.mockImplementation(async (_s, _v, cb) => {
    callback = cb
    return controls
  })
  const w = dialog()
  await flushPromises()
  expect(getUserMedia).not.toHaveBeenCalled()
  await w.setProps({ modelValue: true })
  await flushPromises()
  callback(result)
  callback(result)
  expect(w.emitted('scan')).toEqual([[address]])
  expect(stop).toHaveBeenCalled()
  expect(controls.stop).toHaveBeenCalled()
})
it('stops a camera granted after close before decoding', async () => {
  const { stream, stop } = makeStream()
  let grant!: (s: MediaStream) => void
  getUserMedia.mockReturnValue(
    new Promise(resolve => {
      grant = resolve
    }),
  )
  const w = dialog()
  await w.setProps({ modelValue: true })
  await flushPromises()
  await w.setProps({ modelValue: false })
  grant(stream)
  await flushPromises()
  expect(stop).toHaveBeenCalled()
  expect(mockDecode).not.toHaveBeenCalled()
  expect(w.emitted('scan')).toBeUndefined()
})
it('isolates late decoder cleanup from a reopened camera', async () => {
  const first = makeStream(),
    second = makeStream()
  const controls = { stop: jest.fn() }
  let ready!: (c: typeof controls) => void
  let oldVideo: HTMLVideoElement | undefined
  getUserMedia
    .mockResolvedValueOnce(first.stream)
    .mockResolvedValueOnce(second.stream)
  mockDecode
    .mockImplementationOnce((_s, video) => {
      oldVideo = video
      return new Promise(resolve => {
        ready = resolve
      })
    })
    .mockResolvedValueOnce({ stop: jest.fn() })
  const w = dialog()
  await w.setProps({ modelValue: true })
  await flushPromises()
  await w.setProps({ modelValue: false })
  await w.setProps({ modelValue: true })
  await flushPromises()
  expect(w.find('video').element).not.toBe(oldVideo)
  ready(controls)
  await flushPromises()
  expect(first.stop).toHaveBeenCalled()
  expect(controls.stop).toHaveBeenCalled()
  expect(second.stop).not.toHaveBeenCalled()
  w.unmount()
  wrappers = []
  expect(second.stop).toHaveBeenCalled()
})
it.each(['session', 'chain'])(
  'discards scans after %s changes',
  async field => {
    const state = reactive({ session: 1, chain: 'monad-testnet' })
    const { stream, stop } = makeStream()
    let callback: (r: unknown) => void = jest.fn()
    getUserMedia.mockResolvedValue(stream)
    mockDecode.mockImplementation(async (_s, _v, cb) => {
      callback = cb
      return { stop: jest.fn() }
    })
    const w = dialog(() => `${state.session}:${state.chain}`)
    await w.setProps({ modelValue: true })
    await flushPromises()
    if (field === 'session') ++state.session
    else state.chain = 'ethereum-sepolia'
    await flushPromises()
    callback(result)
    expect(stop).toHaveBeenCalled()
    expect(w.emitted('scan')).toBeUndefined()
    expect(w.emitted('update:modelValue')).toContainEqual([false])
  },
)
it('rejects a payment URI and closes when hidden', async () => {
  const { stream, stop } = makeStream()
  let callback: (r: unknown) => void = jest.fn()
  getUserMedia.mockResolvedValue(stream)
  mockDecode.mockImplementation(async (_s, _v, cb) => {
    callback = cb
    return { stop: jest.fn() }
  })
  const w = dialog()
  await w.setProps({ modelValue: true })
  await flushPromises()
  callback({ getText: () => `ethereum:${address}?value=1` })
  expect(w.emitted('scan')).toBeUndefined()
  await flushPromises()
  expect(w.text()).toContain('qrScanner.invalid')
  Object.defineProperty(document, 'hidden', { configurable: true, value: true })
  document.dispatchEvent(new Event('visibilitychange'))
  expect(stop).toHaveBeenCalled()
})
it('reports permission denial and insecure context with manual fallback', async () => {
  getUserMedia.mockRejectedValueOnce(
    new DOMException('Denied', 'NotAllowedError'),
  )
  const w = dialog()
  await w.setProps({ modelValue: true })
  await flushPromises()
  expect(w.text()).toContain('qrScanner.denied')
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value: false,
  })
  await (w.vm as unknown as { start(): Promise<void> }).start()
  await flushPromises()
  expect(w.text()).toContain('qrScanner.unavailable')
  expect(getUserMedia).toHaveBeenCalledTimes(1)
})
it.each([
  'https://example.com',
  'javascript:alert(1)',
  '{"address":"abc"}',
  'bitcoin:abc?amount=1',
  'ethereum:0x123',
  'abc#memo',
  'abc def',
  ' abc',
  'abc\n',
  '',
])('rejects unsupported payload %p', value =>
  expect(isRawQrAddress(value)).toBe(false),
)
it.each([
  address,
  'So11111111111111111111111111111111111111112',
  'ecash:qq123',
  'bitcoincash:qq123',
  'bc1q123',
])('passes raw shape %p to consumer validation', value =>
  expect(isRawQrAddress(value)).toBe(true),
)
