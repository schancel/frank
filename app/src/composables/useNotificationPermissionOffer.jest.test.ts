/** @jest-environment jsdom */
jest.mock('quasar', () => ({ Notify: { create: jest.fn(() => jest.fn()) } }))
jest.mock('src/i18n', () => ({ translateMessage: (key: string) => key }))

const original = Object.getOwnPropertyDescriptor(globalThis, 'Notification')
let browserPermission: NotificationPermission
let request: jest.Mock

function boot(initialReady = true) {
  // A fresh module graph models a new installed-app process, retaining browser storage.
  jest.resetModules()
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mount, flushPromises } = require('@vue/test-utils')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { defineComponent, ref, nextTick } = require('vue')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Notify } = require('quasar')
  const {
    useNotificationPermissionOffer,
    // eslint-disable-next-line @typescript-eslint/no-var-requires
  } = require('./useNotificationPermissionOffer')
  const ready = ref(initialReady)
  const Host = defineComponent({
    setup() {
      useNotificationPermissionOffer(ready)
      return () => null
    },
  })
  const wrapper = mount(Host)
  return {
    wrapper,
    ready,
    nextTick,
    flushPromises,
    offer: Notify.create as jest.Mock,
    mountAgain: () => mount(Host),
  }
}

beforeEach(() => {
  localStorage.clear()
  browserPermission = 'default'
  request = jest.fn(async () => {
    browserPermission = 'granted'
    return browserPermission
  })
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: {
      get permission() {
        return browserPermission
      },
      requestPermission: request,
    },
  })
})
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'Notification', original)
  else Reflect.deleteProperty(globalThis, 'Notification')
  jest.restoreAllMocks()
})

test('Not now survives a fresh app process without persisting a permission grant', () => {
  const first = boot()
  expect(first.offer).toHaveBeenCalledTimes(1)
  expect(localStorage.length).toBe(0)
  first.offer.mock.calls[0][0].actions[1].handler()
  expect(Notification.permission).toBe('default')
  first.wrapper.unmount()
  const restarted = boot()
  expect(restarted.offer).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
  restarted.wrapper.unmount()
})

test.each(['granted', 'denied'] as const)(
  '%s permission suppresses offers after restart',
  state => {
    browserPermission = state
    const app = boot()
    expect(app.offer).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
    expect(request).not.toHaveBeenCalled()
    app.wrapper.unmount()
  },
)

test('permission changing outside the app dismisses the offer on focus', async () => {
  const app = boot()
  const dismiss = app.offer.mock.results[0].value
  browserPermission = 'denied'
  window.dispatchEvent(new Event('focus'))
  await app.nextTick()
  expect(dismiss).toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
  app.wrapper.unmount()
})

test('Enable invokes the browser synchronously only from the action', async () => {
  const app = boot()
  expect(request).not.toHaveBeenCalled()
  app.offer.mock.calls[0][0].actions[0].handler()
  expect(request).toHaveBeenCalledTimes(1)
  await Promise.resolve()
  app.wrapper.unmount()
  const restarted = boot()
  expect(restarted.offer).not.toHaveBeenCalled()
  restarted.wrapper.unmount()
})

test('blocked preference storage still allows dismissal and prevents remount spam', () => {
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw Error('blocked')
  })
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('blocked')
  })
  const app = boot()
  expect(() => app.offer.mock.calls[0][0].actions[1].handler()).not.toThrow()
  app.wrapper.unmount()
  const remount = app.mountAgain()
  expect(app.offer).toHaveBeenCalledTimes(1)
  expect(request).not.toHaveBeenCalled()
  remount.unmount()
})

test('a failed Enable request reports failure without saving dismissal', async () => {
  request.mockRejectedValueOnce(new Error('permission unavailable'))
  const app = boot()
  app.offer.mock.calls[0][0].actions[0].handler()
  await app.flushPromises()
  expect(app.offer).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'negative',
      message: 'notificationPermission.failed',
    }),
  )
  expect(localStorage.length).toBe(0)
  app.wrapper.unmount()
  const restarted = boot()
  expect(restarted.offer).toHaveBeenCalledTimes(1)
  restarted.wrapper.unmount()
})

test('account readiness gates the offer without writing storage or requesting permission', async () => {
  const app = boot(false)
  expect(app.offer).not.toHaveBeenCalled()
  expect(localStorage.length).toBe(0)
  app.ready.value = true
  await app.nextTick()
  expect(app.offer).toHaveBeenCalledTimes(1)
  expect(localStorage.length).toBe(0)
  expect(request).not.toHaveBeenCalled()
  app.wrapper.unmount()
})

test('Enable in an extension popup persists dismissal and enabled state even if Notification.permission stays default across popup opens', async () => {
  ;(globalThis as Record<string, any>).chrome = { runtime: { id: 'ext-123' } }
  try {
    // Simulate transient extension popup where requestPermission resolves to 'default'
    request.mockImplementation(async () => 'default')
    const firstPopup = boot()
    expect(firstPopup.offer).toHaveBeenCalledTimes(1)
    firstPopup.offer.mock.calls[0][0].actions[0].handler()
    await firstPopup.flushPromises()
    expect(localStorage.getItem('frank:notifications-enabled')).toBe('1')
    expect(localStorage.getItem('frank:notification-prompt-dismissed')).toBe(
      '1',
    )
    firstPopup.wrapper.unmount()

    // Reopening the extension popup (fresh module graph, Notification.permission still 'default')
    const secondPopup = boot()
    expect(secondPopup.offer).not.toHaveBeenCalled()
    secondPopup.wrapper.unmount()
  } finally {
    delete (globalThis as Record<string, any>).chrome
  }
})
