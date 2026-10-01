/** @jest-environment jsdom */

// Ticket #396: the FIRST character typed into the compose box was lost (Safari, macOS).
// Chromium reproduces the underlying loss (disabled textarea during a send); the Safari-specific
// mechanism is reasoned, not observed. Real
// Quasar components (QInput/QBtn/...) in an attached DOM, driving the focus/disable sequence the
// browser produces. `import 'quasar'` resolves to the SSR build under this Jest config, so the UMD
// build is loaded directly (same approach as MainLayout.quasar.jest.test.ts).

import { flushPromises, mount, VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'

import ChatInput from './ChatInput.vue'
import { processInput } from '../../utils/chat'
import enUS from '../../i18n/en-us'

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    defaultStampValue: 10n ** 16n,
    toDisplayAmount: (n: bigint) => n.toString(),
    fromDisplayAmount: (s: string) => BigInt(s),
  },
}))
jest.mock('../../utils/chat', () => ({ processInput: jest.fn() }))

const translate = (k: string) =>
  k
    .split('.')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .reduce((o: any, p) => o?.[p], enUS as Record<string, any>) ?? k

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

/** Mirrors Chat.vue: v-model:message, :disable="sendingMessage", sendMessage clears the box and
 * blocks until `finishSend()` (the awaited network send). */
function mountCompose() {
  const sent: string[] = []
  const message = ref('')
  const sending = ref(false)
  const renders = ref(0)
  const Parent = defineComponent({
    setup() {
      return () => {
        void renders.value // a re-render, like a poll or a new message
        return h(ChatInput, {
          'message': message.value,
          'onUpdate:message': (v: string) => (message.value = v),
          'disable': sending.value,
          'onSendMessage': (text: string) => {
            if (sending.value || !text) return
            sent.push(text)
            sending.value = true
            message.value = ''
          },
        })
      }
    },
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const wrapper = mount(Parent, {
    attachTo: host,
    global: {
      plugins: [loadQuasar()],
      mocks: { $t: translate },
    },
  })
  mounted.push(wrapper)
  return {
    wrapper,
    sent,
    message,
    finishSend: async () => {
      sending.value = false
      await flushPromises()
    },
    rerender: async () => {
      renders.value++
      await flushPromises()
    },
    box: () => wrapper.element.querySelector('textarea') as HTMLTextAreaElement,
  }
}

/** One keystroke as a browser delivers it to the focused element: keydown, then (unless the
 * element is disabled or not the focus target) the value change + input event. */
function type(ch: string) {
  const target = document.activeElement as HTMLTextAreaElement
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }),
  )
  if (target.tagName !== 'TEXTAREA' || target.disabled || target.readOnly) {
    return
  }
  target.value += ch
  target.dispatchEvent(new Event('input', { bubbles: true }))
}
const typeAll = async (s: string) => {
  for (const ch of s) {
    type(ch)
    await flushPromises()
  }
}
// Returns the dispatched event so a test can check `defaultPrevented` (Enter must not insert a
// newline; Shift+Enter must).
const enter = (opts: KeyboardEventInit = {}) => {
  const ev = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...opts,
  })
  document.activeElement?.dispatchEvent(ev)
  return ev
}

describe('ChatInput compose box focus and first character (#396)', () => {
  it('types normally into a focused box', async () => {
    const c = mountCompose()
    c.box().focus()
    await typeAll('hi?')
    expect(c.box().value).toBe('hi?')
    expect(c.message.value).toBe('hi?')
  })

  it('keeps focus and keystrokes through a send: text typed while sending is not lost', async () => {
    const c = mountCompose()
    c.box().focus()
    await typeAll('first')
    expect(enter().defaultPrevented).toBe(true) // Enter never inserts a newline
    await flushPromises()
    expect(c.sent).toEqual(['first'])
    // The owner starts the next message while the send is still in flight.
    expect(document.activeElement).toBe(c.box())
    expect(c.box().disabled).toBe(false)
    await typeAll('h')
    await c.finishSend()
    await typeAll('i?')
    expect(document.activeElement).toBe(c.box())
    expect(c.box().value).toBe('hi?')
    expect(c.message.value).toBe('hi?')
  })

  it('still blocks a second send while one is in flight, and keeps the typed text', async () => {
    const c = mountCompose()
    c.box().focus()
    await typeAll('first')
    enter()
    await flushPromises()
    await typeAll('second')
    enter()
    await flushPromises()
    expect(c.sent).toEqual(['first'])
    expect(c.box().value).toBe('second')
    await c.finishSend()
    enter()
    await flushPromises()
    expect(c.sent).toEqual(['first', 'second'])
  })

  it('ChatInput itself emits no sendMessage while disabled (Enter or the send button)', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const w = mount(ChatInput, {
      attachTo: host,
      props: { disable: true, message: 'pending text' },
      global: { plugins: [loadQuasar()], mocks: { $t: translate } },
    })
    mounted.push(w as unknown as VueWrapper)
    const box = w.element.querySelector('textarea') as HTMLTextAreaElement
    box.focus()
    expect(enter().defaultPrevented).toBe(true)
    const send = Array.from(w.element.querySelectorAll('button')).find(b =>
      b.textContent?.includes('send'),
    )
    send?.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    )
    await flushPromises()
    expect(w.emitted('sendMessage')).toBeUndefined()
    await w.setProps({ disable: false })
    enter()
    await flushPromises()
    expect(w.emitted('sendMessage')).toEqual([['pending text']])
  })

  it('ignores paste and drop of a file while a send is in flight, handles them otherwise', async () => {
    ;(processInput as jest.Mock).mockResolvedValue({ blob: true })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const w = mount(ChatInput, {
      attachTo: host,
      props: { disable: true },
      global: { plugins: [loadQuasar()], mocks: { $t: translate } },
    })
    mounted.push(w as unknown as VueWrapper)
    const box = w.element.querySelector('textarea') as HTMLTextAreaElement
    const fire = (type: 'paste' | 'drop') => {
      const ev = new Event(type, { bubbles: true, cancelable: true })
      const data = { items: [{ kind: 'file' }] }
      Object.defineProperty(
        ev,
        type === 'paste' ? 'clipboardData' : 'dataTransfer',
        { value: data },
      )
      box.dispatchEvent(ev)
      return ev
    }
    const dropped = fire('drop')
    fire('paste')
    await flushPromises()
    expect(processInput).not.toHaveBeenCalled()
    expect(w.emitted('sendFileClicked')).toBeUndefined()
    expect(dropped.defaultPrevented).toBe(true) // the browser must not navigate to the file
    await w.setProps({ disable: false })
    fire('paste')
    await flushPromises()
    expect(w.emitted('sendFileClicked')).toEqual([[{ blob: true }]])
  })

  it('keeps the attach and stamp buttons disabled during a send', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const w = mount(ChatInput, {
      attachTo: host,
      props: { disable: true },
      global: { plugins: [loadQuasar()], mocks: { $t: translate } },
    })
    mounted.push(w as unknown as VueWrapper)
    const buttons = Array.from(w.element.querySelectorAll('button'))
    expect(buttons.length).toBeGreaterThanOrEqual(3)
    expect(buttons.every(b => b.disabled)).toBe(true)
  })

  it('Shift+Enter does not send', async () => {
    const c = mountCompose()
    c.box().focus()
    await typeAll('a')
    const ev = enter({ shiftKey: true })
    await flushPromises()
    expect(c.sent).toEqual([])
    expect(ev.defaultPrevented).toBe(false) // the newline is inserted
  })

  it('does not replace the textarea across a send, re-enable and parent re-renders', async () => {
    const c = mountCompose()
    const before = c.box()
    before.focus()
    await typeAll('x')
    enter()
    await c.rerender()
    await c.finishSend()
    await c.rerender()
    await nextTick()
    expect(c.box()).toBe(before)
    expect(document.activeElement).toBe(before)
  })

  /** jsdom leaves FocusEvent.relatedTarget null for a real focus move; browsers set it to the
   * element receiving focus (Chromium always, Safari only for focusable non-button targets). */
  const withRelatedTarget = (related: Element | null, move: () => void) => {
    const patch = (e: Event) =>
      Object.defineProperty(e, 'relatedTarget', { value: related })
    window.addEventListener('blur', patch, true)
    try {
      move()
    } finally {
      window.removeEventListener('blur', patch, true)
    }
  }

  it('lets focus leave the box for a button (Tab / Shift+Tab are not trapped)', async () => {
    const c = mountCompose()
    c.box().focus()
    const button = c.wrapper.element.querySelector('button') as HTMLElement
    expect(button).toBeTruthy()
    withRelatedTarget(button, () => button.focus())
    await flushPromises()
    expect(document.activeElement).toBe(button)
  })

  it('never re-focuses the box from a blur handler (Chromium cancels the focus move when it does)', async () => {
    const c = mountCompose()
    const box = c.box()
    box.focus()
    const button = c.wrapper.element.querySelector('button') as HTMLElement
    const focusCalls: Element[] = []
    const realFocus = HTMLElement.prototype.focus
    const spy = jest
      .spyOn(HTMLElement.prototype, 'focus')
      .mockImplementation(function (this: HTMLElement, o?: FocusOptions) {
        focusCalls.push(this)
        return realFocus.call(this, o)
      })
    try {
      withRelatedTarget(button, () => button.focus())
      await flushPromises()
    } finally {
      spy.mockRestore()
    }
    expect(focusCalls).toEqual([button])
  })

  it('does not pull focus back when a blur has no relatedTarget (as Safari reports for a button click)', async () => {
    const c = mountCompose()
    const other = document.createElement('div')
    other.tabIndex = 0
    document.body.appendChild(other)
    c.box().focus()
    withRelatedTarget(null, () => other.focus())
    await flushPromises()
    expect(document.activeElement).toBe(other)
  })

  it('does not steal focus when the user clicks away to a page element', async () => {
    const c = mountCompose()
    const other = document.createElement('div')
    other.tabIndex = 0
    document.body.appendChild(other)
    c.box().focus()
    other.focus()
    await flushPromises()
    expect(document.activeElement).toBe(other)
  })

  it('emits the typed text on Enter and via the send button', async () => {
    const c = mountCompose()
    c.box().focus()
    await typeAll('hello')
    const send = Array.from(
      c.wrapper.element.querySelectorAll<HTMLElement>('button'),
    ).find(b => b.textContent?.includes('send'))
    expect(send).toBeDefined()
    const down = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    })
    send?.dispatchEvent(down)
    await flushPromises()
    expect(c.sent).toEqual(['hello'])
    // Pressing Send must not move focus out of the box (mousedown default is prevented).
    expect(down.defaultPrevented).toBe(true)
  })
})
