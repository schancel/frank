/** @jest-environment jsdom */
/**
 * Back and Quasar's own overlays, with Quasar's real dialog, menu and Dialog plugin (its browser
 * build) on a real hash-mode router over jsdom's session history. Every one of them is closed
 * by the phone's Back, whether or not its component registered anything; a persistent dialog
 * stays and Back does nothing (phone web and the Android Back button alike); Forward never
 * closes anything.
 */
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import type { Router } from 'vue-router'
import type { ArticlePayload } from '@frank/wallet/message-item-plugins/article'

import ArticleReaderPane from '../components/chat/ArticleReaderPane.vue'

import {
  handleHardwareBack,
  resetNavigationForTests,
  useBackDismiss,
} from './navigation'
import {
  flushHistory,
  historyPosition,
  openApp,
  userBack,
  userForward,
} from '../../test/jest/navigation-harness'

jest.mock(
  require.resolve('@vue/devtools-api', {
    paths: [require.resolve('vue-router')],
  }),
  () => ({ setupDevtoolsPlugin: () => undefined }),
)
jest.mock('nostics', () => ({
  createConsoleReporter: () => ({}),
  defineDiagnostics: () => new Proxy({}, { get: () => () => undefined }),
}))

const runtime = globalThis as typeof globalThis & {
  Vue: typeof import('vue')
  Quasar: typeof import('quasar')
}
runtime.Vue = jest.requireActual('vue')
jest.requireActual('quasar/dist/quasar.umd.prod.js')
const quasar = runtime.Quasar
// jsdom lays nothing out and has no element scrolling; QSelect scrolls its popup to the option.
if (typeof Element.prototype.scrollTo !== 'function')
  Element.prototype.scrollTo = () => undefined
const { QDialog, QMenu, QBtn, QSelect } = quasar

let router: Router
let destroy: () => void = () => undefined
let wrapper: ReturnType<typeof mount> | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  destroy()
  resetNavigationForTests()
  document.body.innerHTML = ''
})

/** Lets Quasar's show/hide transitions finish. */
async function transitions() {
  await flushPromises()
  await new Promise(resolve => setTimeout(resolve, 400))
  await flushPromises()
}

const overlayShowing = () =>
  document.querySelector('.q-dialog--modal, .q-menu') !== null

async function page(overlay: 'dialog' | 'persistent' | 'menu') {
  ;({ router, destroy } = await openApp(['/chat', '/chat/:id'], '/chat'))
  await router.push('/chat/a')
  const open = ref(false)
  const Page = defineComponent({
    setup: () => () =>
      overlay === 'menu'
        ? h(QBtn, { label: 'more' }, () =>
            h(
              QMenu,
              {
                'modelValue': open.value,
                'onUpdate:modelValue': (v: boolean) => (open.value = v),
              },
              () => h('div', 'menu item'),
            ),
          )
        : h(
            QDialog,
            {
              'modelValue': open.value,
              'onUpdate:modelValue': (v: boolean) => (open.value = v),
              'persistent': overlay === 'persistent',
            },
            () => h('div', { class: 'q-card' }, 'Send again?'),
          ),
  })
  wrapper = mount(Page, {
    attachTo: document.body,
    global: { plugins: [router, quasar] },
  })
  open.value = true
  await nextTick()
  await transitions()
  expect(overlayShowing()).toBe(true)
  return open
}

describe('phone web Back', () => {
  it.each(['dialog', 'menu'] as const)(
    'closes an open Quasar %s that registered nothing, in the same entry',
    async overlay => {
      const open = await page(overlay)
      const position = historyPosition()
      await userBack(router)
      await transitions()
      expect(open.value).toBe(false)
      expect(router.currentRoute.value.path).toBe('/chat/a')
      expect(historyPosition()).toBe(position)
      // Nothing open: Back navigates again.
      await userBack(router)
      expect(router.currentRoute.value.path).toBe('/chat')
    },
  )

  it('leaves a persistent dialog open and goes nowhere', async () => {
    const open = await page('persistent')
    const position = historyPosition()
    await userBack(router)
    await transitions()
    expect(open.value).toBe(true)
    expect(overlayShowing()).toBe(true)
    expect(router.currentRoute.value.path).toBe('/chat/a')
    expect(historyPosition()).toBe(position)
  })

  it('a persistent $q.dialog (Dialog plugin) blocks Back too', async () => {
    ;({ router, destroy } = await openApp(['/chat', '/chat/:id'], '/chat'))
    await router.push('/chat/a')
    const position = historyPosition()
    wrapper = mount(defineComponent({ setup: () => () => h('div') }), {
      attachTo: document.body,
      global: {
        plugins: [router, [quasar, { plugins: { Dialog: quasar.Dialog } }]],
      },
    })
    quasar.Dialog.create({
      title: 'Discard?',
      persistent: true,
      cancel: true,
    })
    await transitions()
    expect(overlayShowing()).toBe(true)
    await userBack(router)
    await transitions()
    expect(overlayShowing()).toBe(true)
    expect(router.currentRoute.value.path).toBe('/chat/a')
    expect(historyPosition()).toBe(position)
  })
})

/** A page with whatever `render` draws, in an app with Quasar's Dialog and BottomSheet. */
async function mountPage(render: () => ReturnType<typeof h>) {
  ;({ router, destroy } = await openApp(['/chat', '/chat/:id'], '/chat'))
  await router.push('/chat/a')
  wrapper = mount(defineComponent({ setup: () => render }), {
    attachTo: document.body,
    global: {
      plugins: [
        router,
        [
          quasar,
          {
            plugins: {
              Dialog: quasar.Dialog,
              BottomSheet: quasar.BottomSheet,
            },
          },
        ],
      ],
    },
  })
  await transitions()
}

describe('phone web Back, every kind of Quasar overlay', () => {
  it('closes a dismissible Dialog.create in the same entry', async () => {
    await mountPage(() => h('div'))
    const position = historyPosition()
    quasar.Dialog.create({ title: 'Send again?', cancel: true })
    await transitions()
    expect(overlayShowing()).toBe(true)
    await userBack(router)
    await transitions()
    expect(overlayShowing()).toBe(false)
    expect(router.currentRoute.value.path).toBe('/chat/a')
    expect(historyPosition()).toBe(position)
  })

  it('closes a BottomSheet in the same entry', async () => {
    await mountPage(() => h('div'))
    const position = historyPosition()
    quasar.BottomSheet.create({
      message: 'Share',
      actions: [{ label: 'Copy', id: 'copy' }],
    })
    await transitions()
    expect(overlayShowing()).toBe(true)
    await userBack(router)
    await transitions()
    expect(overlayShowing()).toBe(false)
    expect(router.currentRoute.value.path).toBe('/chat/a')
    expect(historyPosition()).toBe(position)
  })

  it("closes a QSelect's popup in the same entry", async () => {
    const value = ref('English')
    const select = ref<{ showPopup: () => void } | null>(null)
    await mountPage(() =>
      h(QSelect, {
        'ref': select,
        'modelValue': value.value,
        'onUpdate:modelValue': (v: string) => (value.value = v),
        'options': ['English', 'Deutsch', 'Français'],
        'label': 'Language',
      }),
    )
    const position = historyPosition()
    select.value?.showPopup()
    await transitions()
    expect(overlayShowing()).toBe(true)
    await userBack(router)
    await transitions()
    expect(overlayShowing()).toBe(false)
    expect(value.value).toBe('English')
    expect(router.currentRoute.value.path).toBe('/chat/a')
    expect(historyPosition()).toBe(position)
  })

  /** A dialog with a menu open inside it. */
  async function menuInDialog(menuProps: Record<string, unknown> = {}) {
    const dialog = ref(true)
    const menu = ref(false)
    await mountPage(() =>
      h(
        QDialog,
        {
          'modelValue': dialog.value,
          'onUpdate:modelValue': (v: boolean) => (dialog.value = v),
        },
        () =>
          h('div', { class: 'q-card' }, [
            h(QBtn, { label: 'more' }, () =>
              h(
                QMenu,
                {
                  ...menuProps,
                  'modelValue': menu.value,
                  'onUpdate:modelValue': (v: boolean) => (menu.value = v),
                },
                () => h('div', 'menu item'),
              ),
            ),
          ]),
      ),
    )
    menu.value = true
    await transitions()
    expect(document.querySelector('.q-menu')).not.toBeNull()
    return { dialog, menu }
  }

  it('closes a menu inside a dialog first, then the dialog, then goes back', async () => {
    const { dialog, menu } = await menuInDialog()
    const position = historyPosition()
    await userBack(router)
    await transitions()
    expect(menu.value).toBe(false)
    expect(dialog.value).toBe(true)
    expect(historyPosition()).toBe(position)
    await userBack(router)
    await transitions()
    expect(dialog.value).toBe(false)
    expect(historyPosition()).toBe(position)
    await userBack(router)
    expect(router.currentRoute.value.path).toBe('/chat')
  })

  it.each([{ persistent: true }, { noEscDismiss: true }])(
    'a menu Escape does not close (%o) stays, and so does the dialog under it',
    async menuProps => {
      const { dialog, menu } = await menuInDialog(menuProps)
      const position = historyPosition()
      await userBack(router)
      await transitions()
      expect(menu.value).toBe(true)
      expect(dialog.value).toBe(true)
      expect(router.currentRoute.value.path).toBe('/chat/a')
      expect(historyPosition()).toBe(position)
    },
  )
})

describe('the article reader and Back', () => {
  const article: ArticlePayload = {
    schemaVersion: 1,
    articleId: 'article-001',
    title: 'Reader',
    summary: 'A summary.',
    markdownBody: '# Heading\n\nText.',
    authorName: 'Grace Hopper',
    publishedAtIso: '2026-10-17T12:30:00.000Z',
    tags: [],
  }

  it('a Back that closes a menu over the reader leaves the reader open', async () => {
    const menu = ref(false)
    const closed = jest.fn()
    await mountPage(() =>
      h('div', [
        h(ArticleReaderPane, { article, onClose: closed }),
        h(QBtn, { label: 'more' }, () =>
          h(
            QMenu,
            {
              'modelValue': menu.value,
              'onUpdate:modelValue': (v: boolean) => (menu.value = v),
            },
            () => h('div', 'menu item'),
          ),
        ),
      ]),
    )
    expect(
      document.querySelector('[data-testid="article-reader-pane"]'),
    ).not.toBeNull()
    menu.value = true
    await transitions()
    await userBack(router)
    await transitions()
    expect(menu.value).toBe(false)
    expect(closed).not.toHaveBeenCalled()
    // With nothing above it, Escape still closes the reader.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(closed).toHaveBeenCalledTimes(1)
  })
})

describe('phone web Forward', () => {
  it('navigates, with a Quasar dialog or a drawer open', async () => {
    ;({ router, destroy } = await openApp(['/chat', '/chat/:id'], '/chat'))
    await router.push('/chat/a')
    await userBack(router)
    const dialog = ref(false)
    const drawer = ref(false)
    wrapper = mount(
      defineComponent({
        setup() {
          useBackDismiss(
            () => drawer.value,
            () => {
              drawer.value = false
            },
          )
          return () =>
            h(
              QDialog,
              {
                'modelValue': dialog.value,
                'onUpdate:modelValue': (v: boolean) => (dialog.value = v),
              },
              () => h('div', 'image'),
            )
        },
      }),
      { attachTo: document.body, global: { plugins: [router, quasar] } },
    )
    dialog.value = true
    drawer.value = true
    await transitions()
    const position = historyPosition()
    await userForward(router)
    expect(router.currentRoute.value.path).toBe('/chat/a')
    expect(historyPosition()).toBe(position + 1)
    // Forward is not a dismissal: the drawer was not closed by it.
    expect(drawer.value).toBe(true)
  })
})

describe('Android Back button', () => {
  it('closes a Quasar dialog first', async () => {
    const open = await page('dialog')
    const exitApp = jest.fn()
    handleHardwareBack(router, exitApp)
    await transitions()
    await flushHistory()
    expect(open.value).toBe(false)
    expect(router.currentRoute.value.path).toBe('/chat/a')
    expect(exitApp).not.toHaveBeenCalled()
  })

  it('does nothing while a persistent dialog is open', async () => {
    const open = await page('persistent')
    const position = historyPosition()
    const exitApp = jest.fn()
    handleHardwareBack(router, exitApp)
    await transitions()
    await flushHistory()
    expect(open.value).toBe(true)
    expect(router.currentRoute.value.path).toBe('/chat/a')
    expect(historyPosition()).toBe(position)
    expect(exitApp).not.toHaveBeenCalled()
  })
})
