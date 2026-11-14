/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import { computed, readonly, ref } from 'vue'
import { useNotificationPermissionOffer } from '../../composables/useNotificationPermissionOffer'
import Banner from './NotificationPermissionOfferBanner.vue'

jest.mock('../../composables/useNotificationPermissionOffer')

function mountBanner({
  visible = true,
  failed = false,
  requesting = false,
} = {}) {
  const enableNotifications = jest.fn(async () => undefined)
  const dismiss = jest.fn()
  jest.mocked(useNotificationPermissionOffer).mockReturnValue({
    visible: computed(() => visible),
    requesting: readonly(ref(requesting)),
    failed: readonly(ref(failed)),
    enableNotifications,
    dismiss,
  })
  const wrapper = mount(Banner, {
    props: { ready: true },
    global: {
      mocks: { $t: (key: string) => key },
      stubs: {
        QBanner: {
          template:
            '<section><slot /><div><slot name="action" /></div></section>',
        },
        QBtn: {
          props: ['label', 'disable'],
          template: '<button :disabled="disable">{{ label }}</button>',
        },
      },
    },
  })
  return { wrapper, enableNotifications, dismiss }
}

test('offer stays in normal flow with explicit localized actions', () => {
  const { wrapper, enableNotifications, dismiss } = mountBanner()
  const offer = wrapper.get('[data-testid="notification-permission-offer"]')
  expect(offer.classes().join(' ')).not.toMatch(/fixed|absolute|fullscreen/)
  expect(offer.text()).toContain('notificationPermission.offerHint')
  expect(enableNotifications).not.toHaveBeenCalled()
  wrapper
    .get('[data-testid="notification-permission-enable"]')
    .element.dispatchEvent(new MouseEvent('click'))
  expect(enableNotifications).toHaveBeenCalledTimes(1)
  wrapper
    .get('[data-testid="notification-permission-dismiss"]')
    .element.dispatchEvent(new MouseEvent('click'))
  expect(dismiss).toHaveBeenCalledTimes(1)
  wrapper.unmount()
})

test('hidden offer has no controls', () => {
  const { wrapper } = mountBanner({ visible: false })
  expect(
    wrapper.find('[data-testid="notification-permission-offer"]').exists(),
  ).toBe(false)
  wrapper.unmount()
})

test('failed request remains localized and retryable in the banner', () => {
  const { wrapper, enableNotifications } = mountBanner({ failed: true })
  expect(wrapper.get('[role="alert"]').text()).toBe(
    'notificationPermission.failed',
  )
  const button = wrapper.get<HTMLButtonElement>(
    '[data-testid="notification-permission-enable"]',
  )
  expect(button.element.disabled).toBe(false)
  button.element.click()
  expect(enableNotifications).toHaveBeenCalledTimes(1)
  wrapper.unmount()
})

test('both actions are disabled during the native request', () => {
  const { wrapper } = mountBanner({ requesting: true })
  for (const button of wrapper.findAll('button')) {
    expect((button.element as HTMLButtonElement).disabled).toBe(true)
  }
  wrapper.unmount()
})
