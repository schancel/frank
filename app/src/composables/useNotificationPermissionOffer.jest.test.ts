/** @jest-environment jsdom */

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
  const {
    useNotificationPermissionOffer,
    // eslint-disable-next-line @typescript-eslint/no-var-requires
  } = require('./useNotificationPermissionOffer')
  const ready = ref(initialReady)
  let offer!: ReturnType<typeof useNotificationPermissionOffer>
  const Host = defineComponent({
    setup() {
      offer = useNotificationPermissionOffer(ready)
      return () => null
    },
  })
  const wrapper = mount(Host)
  return {
    wrapper,
    ready,
    nextTick,
    flushPromises,
    get offer() {
      return offer
    },
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

test('Not now survives a fresh process without persisting permission', () => {
  const first = boot()
  expect(first.offer.visible.value).toBe(true)
  expect(localStorage.length).toBe(0)
  first.offer.dismiss()
  expect(first.offer.visible.value).toBe(false)
  expect(Notification.permission).toBe('default')
  expect(localStorage.getItem('frank.notification-offer-dismissed.v1')).toBe(
    '1',
  )
  expect(localStorage.getItem('frank:notification-prompt-dismissed')).toBe('1')
  first.wrapper.unmount()
  const restarted = boot()
  expect(restarted.offer.visible.value).toBe(false)
  expect(request).not.toHaveBeenCalled()
  restarted.wrapper.unmount()
})

test.each(['granted', 'denied', 'unsupported'] as const)(
  '%s permission suppresses the offer without writes or requests',
  state => {
    if (state === 'unsupported')
      Reflect.deleteProperty(globalThis, 'Notification')
    else browserPermission = state
    const app = boot()
    expect(app.offer.visible.value).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(request).not.toHaveBeenCalled()
    app.wrapper.unmount()
  },
)

test.each([
  'frank.notification-offer-dismissed.v1',
  'frank:notification-prompt-dismissed',
  'frank:notifications-enabled',
])('%s retains its existing suppression meaning', key => {
  localStorage.setItem(key, '1')
  const app = boot()
  expect(app.offer.visible.value).toBe(false)
  expect(request).not.toHaveBeenCalled()
  app.wrapper.unmount()
})

test('permission changing outside the app hides the offer on focus', async () => {
  const app = boot()
  browserPermission = 'denied'
  window.dispatchEvent(new Event('focus'))
  await app.nextTick()
  expect(app.offer.visible.value).toBe(false)
  expect(request).not.toHaveBeenCalled()
  app.wrapper.unmount()
})

test('Enable invokes the browser synchronously only from the action', async () => {
  const app = boot()
  expect(request).not.toHaveBeenCalled()
  const enabling = app.offer.enableNotifications()
  expect(request).toHaveBeenCalledTimes(1)
  await enabling
  expect(app.offer.visible.value).toBe(false)
  app.wrapper.unmount()
  const restarted = boot()
  expect(restarted.offer.visible.value).toBe(false)
  restarted.wrapper.unmount()
})

test('blocked storage permits dismissal without remount spam', () => {
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw Error('blocked')
  })
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('blocked')
  })
  const app = boot()
  expect(app.offer.visible.value).toBe(true)
  expect(() => app.offer.dismiss()).not.toThrow()
  app.wrapper.unmount()
  const remount = app.mountAgain()
  expect(app.offer.visible.value).toBe(false)
  expect(request).not.toHaveBeenCalled()
  remount.unmount()
})

test('failed Enable stays visibly retryable and clears dismissal preferences', async () => {
  request.mockRejectedValueOnce(new Error('permission unavailable'))
  const app = boot()
  await app.offer.enableNotifications()
  expect(app.offer.visible.value).toBe(true)
  expect(app.offer.failed.value).toBe(true)
  expect(localStorage.length).toBe(0)
  const retry = app.offer.enableNotifications()
  expect(request).toHaveBeenCalledTimes(2)
  expect(app.offer.failed.value).toBe(false)
  await retry
  expect(app.offer.visible.value).toBe(false)
  app.wrapper.unmount()
})

test('readiness gates the offer and reactivation does not repeat it', async () => {
  const app = boot(false)
  expect(app.offer.visible.value).toBe(false)
  expect(localStorage.length).toBe(0)
  await app.offer.enableNotifications()
  expect(request).not.toHaveBeenCalled()
  app.ready.value = true
  await app.nextTick()
  expect(app.offer.visible.value).toBe(true)
  expect(localStorage.length).toBe(0)
  app.ready.value = false
  await app.nextTick()
  expect(app.offer.visible.value).toBe(false)
  app.ready.value = true
  await app.nextTick()
  expect(app.offer.visible.value).toBe(false)
  expect(request).not.toHaveBeenCalled()
  app.wrapper.unmount()
})

test('pending Enable cannot issue a second request', async () => {
  let finish!: (state: NotificationPermission) => void
  request.mockImplementationOnce(
    () =>
      new Promise<NotificationPermission>(resolve => {
        finish = resolve
      }),
  )
  const app = boot()
  const first = app.offer.enableNotifications()
  expect(app.offer.requesting.value).toBe(true)
  await app.offer.enableNotifications()
  expect(request).toHaveBeenCalledTimes(1)
  browserPermission = 'granted'
  finish('granted')
  await first
  expect(app.offer.requesting.value).toBe(false)
  app.wrapper.unmount()
})

test('extension Enable retains preferences when native permission stays default', async () => {
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: { runtime: { id: 'ext-123' } },
  })
  try {
    request.mockImplementation(async () => 'default')
    const first = boot()
    await first.offer.enableNotifications()
    expect(localStorage.getItem('frank:notifications-enabled')).toBe('1')
    expect(localStorage.getItem('frank:notification-prompt-dismissed')).toBe(
      '1',
    )
    first.wrapper.unmount()
    const reopened = boot()
    expect(reopened.offer.visible.value).toBe(false)
    reopened.wrapper.unmount()
  } finally {
    Reflect.deleteProperty(globalThis, 'chrome')
  }
})
