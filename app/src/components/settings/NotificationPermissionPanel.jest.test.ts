/** @jest-environment jsdom */
jest.mock('quasar', () => ({
  ...jest.requireActual('quasar'),
  Notify: { create: jest.fn() },
}))
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { Notify } from 'quasar'
import Panel from './NotificationPermissionPanel.vue'
import { useNotificationPermissionOffer } from 'src/composables/useNotificationPermissionOffer'

const original = Object.getOwnPropertyDescriptor(globalThis, 'Notification')
let browserPermission: NotificationPermission
let requestPermission: jest.Mock
const options = {
  global: {
    mocks: { $t: (key: string) => key },
    stubs: {
      QBtn: {
        props: ['label', 'disable'],
        template: '<button :disabled="disable">{{ label }}</button>',
      },
    },
  },
}
beforeEach(() => {
  browserPermission = 'default'
  requestPermission = jest.fn(async () => {
    browserPermission = 'granted'
    return browserPermission
  })
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: {
      get permission() {
        return browserPermission
      },
      requestPermission,
    },
  })
})
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'Notification', original)
  else Reflect.deleteProperty(globalThis, 'Notification')
  jest.restoreAllMocks()
})

it.each(['default', 'granted', 'denied', 'unsupported'] as const)(
  'shows actual %s permission without requesting on mount or focus',
  async state => {
    if (state === 'unsupported')
      Reflect.deleteProperty(globalThis, 'Notification')
    else browserPermission = state
    const wrapper = mount(Panel, options)
    await nextTick()
    expect(wrapper.get('[data-test="notification-status"]').text()).toBe(
      `notificationPermission.${state}`,
    )
    expect(wrapper.find('[data-test="enable-notifications"]').exists()).toBe(
      state === 'default',
    )
    window.dispatchEvent(new Event('focus'))
    expect(requestPermission).not.toHaveBeenCalled()
    wrapper.unmount()
  },
)

it('requests only on Enable, invokes the browser within the click, and refreshes actual permission on focus', async () => {
  const wrapper = mount(Panel, options)
  wrapper.get('button').element.click()
  expect(requestPermission).toHaveBeenCalledTimes(1)
  await flushPromises()
  expect(wrapper.text()).toContain('notificationPermission.granted')
  browserPermission = 'denied'
  window.dispatchEvent(new Event('focus'))
  await nextTick()
  expect(wrapper.text()).toContain('notificationPermission.denied')
  expect(wrapper.find('button').exists()).toBe(false)
  expect(requestPermission).toHaveBeenCalledTimes(1)
  wrapper.unmount()
})

it('does not issue another prompt while a user request is pending', async () => {
  let finish!: (state: NotificationPermission) => void
  requestPermission.mockImplementationOnce(
    () =>
      new Promise<NotificationPermission>(resolve => {
        finish = resolve
      }),
  )
  const wrapper = mount(Panel, options)
  wrapper.get('button').element.click()
  wrapper.get('button').element.click()
  expect(requestPermission).toHaveBeenCalledTimes(1)
  browserPermission = 'granted'
  finish('granted')
  await flushPromises()
  expect(wrapper.find('button').exists()).toBe(false)
  wrapper.unmount()
})

it('reports a failed browser request without blocking the settings', async () => {
  requestPermission.mockRejectedValueOnce(new Error('browser failure'))
  const wrapper = mount(Panel, options)
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toBe(
    'notificationPermission.failed',
  )
  expect(wrapper.find('button').exists()).toBe(true)
  wrapper.unmount()
})

it('offers once after activation without requesting, and only the offer action enables notifications', async () => {
  const create = jest.spyOn(Notify, 'create').mockReturnValue(jest.fn())
  const ready = ref(false)
  const Host = defineComponent({
    setup() {
      useNotificationPermissionOffer(ready)
      return {}
    },
    template: '<div />',
  })
  const wrapper = mount(Host)
  expect(create).not.toHaveBeenCalled()
  ready.value = true
  await nextTick()
  expect(create).toHaveBeenCalledTimes(1)
  expect(requestPermission).not.toHaveBeenCalled()
  ready.value = false
  await nextTick()
  ready.value = true
  await nextTick()
  expect(create).toHaveBeenCalledTimes(1)
  const offer = create.mock.calls[0][0] as {
    actions: { handler?: () => void }[]
  }
  offer.actions[0].handler!()
  expect(requestPermission).toHaveBeenCalledTimes(1)
  await flushPromises()
  wrapper.unmount()
  browserPermission = 'default'
  const remount = mount(Host)
  await nextTick()
  expect(create).toHaveBeenCalledTimes(1)
  remount.unmount()
})
