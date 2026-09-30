/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

import ForumLayout from './ForumLayout.vue'
import TopicLayout from './TopicLayout.vue'

// A sentinel that differs from the real 800, so a leftover hard-coded literal cannot pass.
jest.mock('src/utils/layout', () => ({ DRAWER_BREAKPOINT: 777 }))
jest.mock('pinia', () => ({
  storeToRefs: (store: object) => jest.requireActual('vue').toRefs(store),
}))
jest.mock('vue-router', () => ({
  useRouter: () => ({
    currentRoute: { value: { params: { topic: 'alpha' } } },
  }),
}))
jest.mock('src/stores/forum', () => ({
  useForumStore: () =>
    jest.requireActual('vue').reactive({
      topics: [],
      selectedTopic: '',
      setSelectedTopic: jest.fn(),
      refreshMessages: jest.fn(),
    }),
}))
jest.mock('src/stores/topics', () => ({
  useTopicStore: () => ({
    putMessage: jest.fn(),
    refreshDiscoveredTopics: jest.fn(),
  }),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(async () => ({})),
}))
jest.mock('src/utils/notifications', () => ({ errorNotify: jest.fn() }))
jest.mock('../components/panels/ForumDrawer.vue', () => ({
  template: '<div />',
}))
jest.mock('../components/topic/TopicDrawer.vue', () => ({
  template: '<div />',
}))
jest.mock('../components/topic/TopicInput.vue', () => ({
  template: '<div />',
}))

// Records the breakpoint the layout hands to QDrawer (Quasar's own resize logic is not under test).
const DrawerStub = defineComponent({
  props: { breakpoint: Number },
  setup(props) {
    return () =>
      h('aside', {
        'data-testid': 'drawer',
        'data-breakpoint': String(props.breakpoint),
      })
  },
})
const Passthrough = defineComponent({
  setup(_p, { slots }) {
    return () => h('div', slots.default?.())
  },
})

function breakpointOf(layout: object): string | undefined {
  const wrapper = mount(layout, {
    global: {
      components: {
        QDrawer: DrawerStub,
        QHeader: Passthrough,
        QToolbar: Passthrough,
        QToolbarTitle: Passthrough,
        QBtn: Passthrough,
        QSpace: Passthrough,
        QPageContainer: Passthrough,
        QPage: Passthrough,
        QScrollArea: Passthrough,
        QFooter: Passthrough,
      },
      stubs: { RouterView: true },
      mocks: { $status: { setup: true } },
    },
  })
  const value = wrapper
    .find('[data-testid="drawer"]')
    .attributes('data-breakpoint')
  wrapper.unmount()
  return value
}

describe('side drawers share the single breakpoint constant', () => {
  it.each([
    ['ForumLayout', ForumLayout],
    ['TopicLayout', TopicLayout],
  ])('%s passes DRAWER_BREAKPOINT to QDrawer', (_name, layout) => {
    expect(breakpointOf(layout)).toBe('777')
  })
})
