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
    fromDisplayAmount: (val: string) => BigInt(val),
    toDisplayAmount: (raw: bigint) => String(raw),
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
          QSlider: {
            props: ['modelValue'],
            template:
              '<input type="range" class="q-slider-stub" :value="modelValue" />',
          },
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

  it('computes percentile cutoffs and updates voteThreshold on preset selection', async () => {
    const forum = useForumStore()
    forum.setSelectedTopic('crypto')
    forum.messages = [
      {
        topic: 'crypto',
        voteWeightWei: '10',
        payloadDigest: '0x1',
        replies: [],
      } as any,
      {
        topic: 'crypto',
        voteWeightWei: '20',
        payloadDigest: '0x2',
        replies: [],
      } as any,
      {
        topic: 'crypto',
        voteWeightWei: '30',
        payloadDigest: '0x3',
        replies: [],
      } as any,
      {
        topic: 'crypto',
        voteWeightWei: '40',
        payloadDigest: '0x4',
        replies: [],
      } as any,
    ]

    const wrapper = mountDrawer()
    const vm = wrapper.vm as any

    // Initial state: threshold '0' means 0 percentile cutoff (All posts)
    expect(vm.currentPercentile).toBe(0)
    expect(vm.percentileLabel).toBe('forum.allPosts')

    // Select 50% cutoff -> 50th percentile (median) -> weight '30'
    vm.onSelectPercentile(50)
    await wrapper.vm.$nextTick()
    expect(forum.voteThreshold).toBe('30')
    expect(vm.currentPercentile).toBe(50)
    expect(vm.percentileLabel).toBe('Top 50%')

    // Select 75% cutoff -> 75th percentile -> weight '40'
    vm.onSelectPercentile(75)
    await wrapper.vm.$nextTick()
    expect(forum.voteThreshold).toBe('40')
    expect(vm.currentPercentile).toBe(75)
    expect(vm.percentileLabel).toBe('Top 25%')

    // Select All (0%) -> resets threshold to '0'
    vm.onSelectPercentile(0)
    await wrapper.vm.$nextTick()
    expect(forum.voteThreshold).toBe('0')
    expect(vm.currentPercentile).toBe(0)
    expect(vm.percentileLabel).toBe('forum.allPosts')
  })

  it('updates percentile and slider position when threshold is entered directly', async () => {
    const forum = useForumStore()
    forum.setSelectedTopic('tech')
    forum.messages = [
      {
        topic: 'tech',
        voteWeightWei: '100',
        payloadDigest: '0xa',
        replies: [],
      } as any,
      {
        topic: 'tech',
        voteWeightWei: '200',
        payloadDigest: '0xb',
        replies: [],
      } as any,
      {
        topic: 'tech',
        voteWeightWei: '300',
        payloadDigest: '0xc',
        replies: [],
      } as any,
      {
        topic: 'tech',
        voteWeightWei: '400',
        payloadDigest: '0xd',
        replies: [],
      } as any,
    ]

    const wrapper = mountDrawer()
    const vm = wrapper.vm as any

    // Typing '300' means 2 out of 4 items are below 300 -> 50th percentile
    vm.threshold = '300'
    await wrapper.vm.$nextTick()

    expect(forum.voteThreshold).toBe('300')
    expect(vm.currentPercentile).toBe(50)
    expect(vm.sliderPercentile).toBe(50)
    expect(vm.percentileLabel).toBe('Top 50%')

    // Typing '400' means 3 out of 4 items are below 400 -> 75th percentile
    vm.threshold = '400'
    await wrapper.vm.$nextTick()

    expect(vm.currentPercentile).toBe(75)
    expect(vm.sliderPercentile).toBe(75)
    expect(vm.percentileLabel).toBe('Top 25%')
  })
})
