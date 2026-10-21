/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { copyToClipboard } from 'quasar'
import AddressText from './AddressText.vue'
import { addressCopiedNotify } from '../utils/notifications'

jest.mock('quasar', () => ({
  copyToClipboard: jest.fn(() => Promise.resolve()),
}))
jest.mock('../utils/notifications', () => ({
  addressCopiedNotify: jest.fn(),
  errorNotify: jest.fn(),
}))

const address = '0x1234567890abcdef1234567890abcdef12345678'
let resize: ResizeObserverCallback
const disconnect = jest.fn()
const originalObserver = global.ResizeObserver
let frames: FrameRequestCallback[] = []
function runFrames() {
  const pending = frames
  frames = []
  for (const cb of pending) cb(0)
}
beforeEach(() => {
  jest.clearAllMocks()
  frames = []
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
    frames.push(cb)
    return frames.length
  })
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  global.ResizeObserver = jest.fn().mockImplementation(callback => {
    resize = callback
    return { observe: jest.fn(), disconnect }
  })
})
afterEach(() => {
  global.ResizeObserver = originalObserver
})

function mountAddress() {
  const wrapper = mount(AddressText, {
    props: { address, copyable: true },
    global: {
      mocks: { $t: (key: string) => key },
      stubs: {
        QTooltip: { template: '<div><slot /></div>' },
        QBtn: { template: '<button />' },
      },
    },
  })
  let width = 400
  const box = wrapper.get('.address-value').element
  const probe = wrapper.get('.address-measure').element
  Object.defineProperty(box, 'clientWidth', { get: () => width })
  jest
    .spyOn(probe, 'getBoundingClientRect')
    .mockImplementation(
      () => ({ width: (probe.textContent?.length ?? 0) * 8 } as DOMRect),
    )
  return {
    wrapper,
    async setWidth(value: number) {
      width = value
      resize([], {} as ResizeObserver)
      runFrames()
      await nextTick()
    },
    notifyResize(value: number) {
      width = value
      resize([], {} as ResizeObserver)
    },
  }
}

it('shows the complete address when it fits, preserves both ends when narrowed, and expands again', async () => {
  const { wrapper, setWidth } = mountAddress()
  await setWidth(400)
  expect(wrapper.get('[data-test="address-text"]').text()).toBe(address)
  await setWidth(112)
  const shortened = wrapper.get('[data-test="address-text"]').text()
  const [prefix, suffix] = shortened.split('…')
  expect(prefix.length).toBeGreaterThan(0)
  expect(suffix.length).toBeGreaterThan(0)
  expect(address.startsWith(prefix)).toBe(true)
  expect(address.endsWith(suffix)).toBe(true)
  expect(shortened.length * 8).toBeLessThanOrEqual(112)
  expect(wrapper.get('.address-value').attributes('title')).toBe(address)
  await setWidth(400)
  expect(wrapper.get('[data-test="address-text"]').text()).toBe(address)
  wrapper.unmount()
  expect(disconnect).toHaveBeenCalledTimes(1)
})

it('refits on the next frame, not inside the ResizeObserver callback', async () => {
  const { wrapper, notifyResize } = mountAddress()
  notifyResize(112)
  await nextTick()
  // Changing the text inside the callback resizes the observed box again in the
  // same frame, which the browser reports as a ResizeObserver loop error.
  expect(wrapper.get('[data-test="address-text"]').text()).toBe(address)
  expect(frames).toHaveLength(1)
  notifyResize(112)
  expect(frames).toHaveLength(1)
  runFrames()
  await nextTick()
  expect(wrapper.get('[data-test="address-text"]').text()).toContain('…')
  wrapper.unmount()
})

it('copies the full current address even when displayed in shortened form', async () => {
  const { wrapper, setWidth } = mountAddress()
  await setWidth(96)
  const replacement = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
  await wrapper.setProps({ address: replacement })
  await nextTick()
  expect(wrapper.get('[data-test="address-text"]').text()).toContain('…')
  expect(wrapper.get('.address-value').attributes('title')).toBe(replacement)
  await wrapper.get('[data-test="address-copy"]').trigger('click')
  await flushPromises()
  expect(copyToClipboard).toHaveBeenCalledWith(replacement)
  expect(addressCopiedNotify).toHaveBeenCalledTimes(1)
  wrapper.unmount()
})
