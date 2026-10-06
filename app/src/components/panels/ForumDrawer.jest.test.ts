/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ForumDrawer from './ForumDrawer.vue'
import { useForumStore } from 'src/stores/forum'
import { useTopicStore } from 'src/stores/topics'

const mockRoute = { path: '/forum' }
const mockRouterPush = jest.fn()

jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(() => Promise.resolve({})),
}))

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    defaultTopicVoteValue: 100_000_000n,
    fromDisplayAmount: (val: string) => val,
  },
}))

describe('ForumDrawer.vue thread navigation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    jest.clearAllMocks()
    mockRoute.path = '/forum'
  })

  function mountDrawer(options?: { routePath?: string }) {
    if (options?.routePath) {
      mockRoute.path = options.routePath
    }
    return mount(ForumDrawer, {
      global: {
        mocks: {
          $route: mockRoute,
          $router: { push: mockRouterPush },
          $t: (key: string) => key,
        },
        stubs: {
          QScrollArea: { template: '<div><slot /></div>' },
          QList: { template: '<div><slot /></div>' },
          QItem: { template: '<div><slot /></div>' },
          QItemSection: { template: '<div><slot /></div>' },
          QItemLabel: { template: '<div><slot /></div>' },
          QInput: {
            props: ['modelValue'],
            template: '<input :value="modelValue" />',
          },
          QSelect: { template: '<div />' },
          QBtn: { template: '<button><slot /></button>' },
          QSeparator: { template: '<hr />' },
        },
      },
    })
  }

  it('navigates to /forum when selecting a topic while on a thread route', async () => {
    const forum = useForumStore()
    const refreshSpy = jest.spyOn(forum, 'refreshMessages').mockResolvedValue()
    const wrapper = mountDrawer({ routePath: '/forum/0x1234567890abcdef' })

    const vm = wrapper.vm as any
    await vm.setTopic('news')

    expect(mockRouterPush).toHaveBeenCalledWith('/forum')
    expect(forum.selectedTopic).toBe('news')
    expect(refreshSpy).toHaveBeenCalled()
  })

  it('navigates to /forum when clearing topic while on a thread route', async () => {
    const forum = useForumStore()
    forum.setSelectedTopic('news')
    const refreshSpy = jest.spyOn(forum, 'refreshMessages').mockResolvedValue()
    const wrapper = mountDrawer({ routePath: '/forum/0x1234567890abcdef' })

    const vm = wrapper.vm as any
    await vm.onTopicClear()

    expect(mockRouterPush).toHaveBeenCalledWith('/forum')
    expect(forum.selectedTopic).toBe('')
    expect(refreshSpy).toHaveBeenCalled()
  })

  it('does not push /forum when already on /forum', async () => {
    const wrapper = mountDrawer({ routePath: '/forum' })
    const forum = useForumStore()
    jest.spyOn(forum, 'refreshMessages').mockResolvedValue()

    const vm = wrapper.vm as any
    await vm.setTopic('memes')

    expect(mockRouterPush).not.toHaveBeenCalled()
    expect(forum.selectedTopic).toBe('memes')
  })
})
