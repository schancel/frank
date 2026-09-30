/** @jest-environment jsdom */

import { flushPromises, mount, VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'

import TopicInput from './TopicInput.vue'
import { processInput } from '../../utils/chat'

jest.mock('../../utils/chat', () => ({ processInput: jest.fn() }))

function loadQuasar() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any
  g.Vue = jest.requireActual('vue')
  g.ResizeObserver ??= class {
    observe = jest.fn()
    unobserve = jest.fn()
    disconnect = jest.fn()
  }
  jest.requireActual('quasar/dist/quasar.umd.prod.js')
  return g.Quasar
}

const mounted: VueWrapper[] = []

beforeEach(() => jest.clearAllMocks())
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
  document.body.innerHTML = ''
})

function mountInput(disabled = false) {
  const message = ref('topic reply')
  const busy = ref(disabled)
  const Parent = defineComponent({
    setup() {
      return () =>
        h(TopicInput, {
          'message': message.value,
          'disable': busy.value,
          'onUpdate:message': (value: string) => (message.value = value),
        })
    },
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const wrapper = mount(Parent, {
    attachTo: host,
    global: {
      plugins: [loadQuasar()],
      mocks: { $t: (key: string) => key },
    },
  })
  mounted.push(wrapper)
  return {
    wrapper,
    message,
    box: () => wrapper.element.querySelector('textarea') as HTMLTextAreaElement,
    send: () => wrapper.element.querySelector('button') as HTMLButtonElement,
  }
}

describe('TopicInput focus and in-flight guards (#408)', () => {
  it('lets keyboard focus leave the textarea instead of trapping Tab/Shift+Tab', async () => {
    const input = mountInput()
    const box = input.box()
    const send = input.send()
    box.focus()
    const focusCalls: Element[] = []
    const realFocus = HTMLElement.prototype.focus
    const focusSpy = jest
      .spyOn(HTMLElement.prototype, 'focus')
      .mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
        focusCalls.push(this)
        return realFocus.call(this, options)
      })

    const patchRelatedTarget = (event: Event) =>
      Object.defineProperty(event, 'relatedTarget', { value: send })
    window.addEventListener('blur', patchRelatedTarget, true)
    try {
      send.focus()
      await flushPromises()
    } finally {
      window.removeEventListener('blur', patchRelatedTarget, true)
      focusSpy.mockRestore()
    }

    expect(document.activeElement).toBe(send)
    expect(focusCalls).toEqual([send])
  })

  it('keeps the textarea editable but blocks send, paste, and drop while busy', async () => {
    ;(processInput as jest.Mock).mockResolvedValue({ blob: true })
    const input = mountInput(true)
    const box = input.box()
    box.focus()

    expect(box.disabled).toBe(false)
    expect(input.send().disabled).toBe(true)
    box.value += '!'
    box.dispatchEvent(new Event('input', { bubbles: true }))

    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    })
    box.dispatchEvent(enter)
    input
      .send()
      .dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
      )

    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [{ kind: 'file' }] },
    })
    box.dispatchEvent(paste)
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: { items: [{ kind: 'file' }] },
    })
    box.dispatchEvent(drop)
    await flushPromises()

    expect(input.message.value).toBe('topic reply!')
    expect(
      input.wrapper.findComponent(TopicInput).emitted('sendMessage'),
    ).toBeUndefined()
    expect(processInput).not.toHaveBeenCalled()
    expect(drop.defaultPrevented).toBe(true)
  })
})
