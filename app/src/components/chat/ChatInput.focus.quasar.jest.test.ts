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
import enUS from '../../i18n/en-us'
import { MAX_SENT_MESSAGE_BYTES } from '../../utils/image-data-uri'
import { png } from '../../utils/image-data-uri.fixtures'
import type { PostAttachment } from '../../utils/post-editor'

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    defaultStampValue: 10n ** 16n,
    toDisplayAmount: (n: bigint) => n.toString(),
    fromDisplayAmount: (s: string) => BigInt(s),
  },
}))

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

  it('ignores paste and drop of a picture while a send is in flight, attaches it otherwise', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const w = mount(ChatInput, {
      attachTo: host,
      props: { disable: true },
      global: { plugins: [loadQuasar()], mocks: { $t: translate } },
    })
    mounted.push(w as unknown as VueWrapper)
    const box = w.element.querySelector('textarea') as HTMLTextAreaElement
    const dropped = fire(box, 'drop', [pictureFile('a.png')])
    fire(box, 'paste', [pictureFile('a.png')])
    await settle()
    expect(w.emitted('update:attachments')).toBeUndefined()
    expect(dropped.defaultPrevented).toBe(true) // the browser must not navigate to the file
    await w.setProps({ disable: false })
    fire(box, 'paste', [pictureFile('a.png')])
    await settle()
    expect(w.emitted('update:attachments')).toHaveLength(1)
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

/** A file whose bytes are a real PNG header declaring the given size. */
function pictureFile(name: string, width = 2, height = 2) {
  const bytes = Buffer.from(png(width, height).split(',')[1], 'base64')
  return new File([bytes], name, { type: 'image/png' })
}
/** A paste or drop carrying files, as the browser delivers it to the text box. */
function fire(box: Element, type: 'paste' | 'drop', files: File[]) {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(
    ev,
    type === 'paste' ? 'clipboardData' : 'dataTransfer',
    { value: { files } },
  )
  box.dispatchEvent(ev)
  return ev
}
/** Lets the file reads (FileReader) and the re-renders after them finish. */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    await flushPromises()
  }
}

/** Mirrors Chat.vue: the page owns the text and the attachments. */
function mountWithAttachments(text = '') {
  const message = ref(text)
  const attachments = ref<PostAttachment[]>([])
  const sent: string[] = []
  const Parent = defineComponent({
    setup() {
      return () =>
        h(ChatInput, {
          'message': message.value,
          'onUpdate:message': (v: string) => (message.value = v),
          'attachments': attachments.value,
          'onUpdate:attachments': (v: PostAttachment[]) =>
            (attachments.value = v),
          'onSendMessage': (v: string) => sent.push(v),
        })
    },
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const wrapper = mount(Parent, {
    attachTo: host,
    global: {
      plugins: [loadQuasar()],
      mocks: {
        $t: (key: string, named: Record<string, string> = {}) =>
          String(translate(key)).replace(
            /\{(\w+)\}/g,
            (whole, name: string) => named[name] ?? whole,
          ),
      },
    },
  })
  mounted.push(wrapper)
  const box = () =>
    wrapper.element.querySelector('textarea') as HTMLTextAreaElement
  return { wrapper, message, attachments, sent, box }
}

describe('ChatInput holds pictures for the message', () => {
  it('a pasted picture becomes an attachment, referenced in the text at the cursor', async () => {
    const c = mountWithAttachments('before after')
    await flushPromises()
    c.box().focus()
    c.box().setSelectionRange(7, 7)
    const ev = fire(c.box(), 'paste', [pictureFile('cat.png')])
    await settle()
    expect(ev.defaultPrevented).toBe(true)
    expect(c.attachments.value).toEqual([
      expect.objectContaining({ id: '1', name: 'cat.png', dataUrl: png(2, 2) }),
    ])
    expect(c.message.value).toBe('before \n![cat](attachment:1)\nafter')
    const chips = c.wrapper.findAll('[data-testid="chat-attachment-chip"]')
    expect(chips).toHaveLength(1)
    expect(chips[0].text()).toContain('cat.png')
  })

  it('pasted text is left to the text box', async () => {
    const c = mountWithAttachments()
    const ev = fire(c.box(), 'paste', [])
    await settle()
    expect(ev.defaultPrevented).toBe(false)
    expect(c.attachments.value).toEqual([])
  })

  it('several pictures dropped or picked are each attached and referenced, in order', async () => {
    const c = mountWithAttachments('hi')
    fire(c.box(), 'drop', [pictureFile('a.png'), pictureFile('b.png', 3, 3)])
    await settle()
    const picker = c.wrapper.element.querySelector(
      '[data-testid="chat-attachment-picker"]',
    ) as HTMLInputElement
    Object.defineProperty(picker, 'files', {
      value: [pictureFile('c.png', 4, 4)],
      configurable: true,
    })
    picker.dispatchEvent(new Event('change'))
    await settle()
    expect(c.attachments.value.map(a => [a.id, a.name, a.dataUrl])).toEqual([
      ['1', 'a.png', png(2, 2)],
      ['2', 'b.png', png(3, 3)],
      ['3', 'c.png', png(4, 4)],
    ])
    const order = ['attachment:1', 'attachment:2', 'attachment:3'].map(r =>
      c.message.value.indexOf(r),
    )
    expect(order.every(i => i > 0)).toBe(true)
    expect([...order].sort((x, y) => x - y)).toEqual(order)
  })

  it('removing an attachment removes its reference and leaves the others', async () => {
    const c = mountWithAttachments('hi')
    fire(c.box(), 'drop', [pictureFile('a.png'), pictureFile('b.png', 3, 3)])
    await settle()
    const remove = c.wrapper.element.querySelector(
      '[data-attachment-id="1"] .q-chip__icon--remove',
    ) as HTMLElement
    remove.click()
    await flushPromises()
    expect(c.attachments.value.map(a => a.id)).toEqual(['2'])
    expect(c.message.value).not.toContain('attachment:1')
    expect(c.message.value).toContain('![b](attachment:2)')
  })

  it('refuses a picture it cannot bring within bounds, with the reason, and attaches nothing', async () => {
    // No canvas here, so nothing is downscaled: the picture stays 9000 pixels wide.
    const c = mountWithAttachments('hi')
    fire(c.box(), 'paste', [pictureFile('huge.png', 9000, 9000)])
    await settle()
    expect(c.attachments.value).toEqual([])
    expect(c.message.value).toBe('hi')
    expect(
      c.wrapper.get('[data-testid="chat-attachment-refused"]').text(),
    ).toBe('huge.png cannot be sent: dimensions too large.')
  })

  it('does not send a message too large for one message, and says so', async () => {
    const c = mountWithAttachments('hi')
    c.attachments.value = [
      {
        id: '1',
        name: 'a.png',
        dataUrl: 'A'.repeat(MAX_SENT_MESSAGE_BYTES),
        sizeBytes: 1,
      },
    ]
    await flushPromises()
    expect(c.wrapper.get('[data-testid="chat-message-too-large"]').text()).toBe(
      enUS.chatInput.messageTooLarge,
    )
    c.box().focus()
    enter()
    await flushPromises()
    expect(c.sent).toEqual([])
    c.attachments.value = []
    await flushPromises()
    enter()
    await flushPromises()
    expect(c.sent).toEqual(['hi'])
  })

  it('sends a message that is only pictures', async () => {
    const c = mountWithAttachments('')
    fire(c.box(), 'drop', [pictureFile('a.png')])
    await settle()
    c.box().focus()
    enter()
    await flushPromises()
    expect(c.sent).toHaveLength(1)
    expect(c.sent[0]).toContain('attachment:1')
  })
})
