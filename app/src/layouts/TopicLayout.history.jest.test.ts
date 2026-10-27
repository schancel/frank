/** @jest-environment jsdom */
/**
 * The topic drawer is an overlay on a narrow screen only, by the same width the drawer and the
 * router go by (Quasar's screen width, scaled): one that becomes narrow while the drawer is open
 * (a resize, a rotation) is then closed by Back.
 */
import { flushPromises, shallowMount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'

import TopicLayout from './TopicLayout.vue'
import { dismissTopOverlay, resetNavigationForTests } from '../utils/navigation'

jest.mock('vue-router', () => ({
  useRouter: () => ({
    currentRoute: { value: { params: { topic: 'help' } } },
  }),
}))
jest.mock('src/stores/topics', () => ({
  useTopicStore: () => ({ putMessage: jest.fn() }),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: async () => ({ identity: {} }),
}))
jest.mock('src/components/topic/TopicInput.vue', () => ({
  template: '<div />',
}))
jest.mock('src/components/topic/TopicDrawer.vue', () => ({
  template: '<div />',
}))

afterEach(() => resetNavigationForTests())

it('a drawer left open on a wide screen is closed by Back once the screen is narrow', async () => {
  const $q = reactive({ screen: { width: 1280 }, dark: { isActive: false } })
  const wrapper = shallowMount(TopicLayout, {
    global: {
      provide: { _q_: $q },
      mocks: { $q, $t: (key: string) => key, $status: { setup: true } },
    },
  })
  const vm = wrapper.vm as unknown as { showTopicDrawer: boolean }
  vm.showTopicDrawer = true
  await flushPromises()
  // Wide: the drawer sits beside the page, Back is not for it.
  expect(dismissTopOverlay()).toBe(false)
  $q.screen.width = 390
  await nextTick()
  expect(dismissTopOverlay()).toBe(true)
  expect(vm.showTopicDrawer).toBe(false)
  wrapper.unmount()
})
