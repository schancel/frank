/** @jest-environment jsdom */
/**
 * Finding 5: the forum's back arrow and breadcrumb, and the AVU page's back arrow, are Back.
 * They used to push their parent, so Back after them returned to the page they had left. Real
 * hash-mode router on jsdom's session history; `history.state.position` is the entry's index.
 */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Router } from 'vue-router'

import ForumLayout from './ForumLayout.vue'
import AvuDetails from '../pages/AvuDetails.vue'
import enUS from '../i18n/en-us'
import { resetNavigationForTests } from '../utils/navigation'
import {
  flushHistory,
  historyPosition,
  openApp,
  userBack,
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
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    defaultTopicVoteValue: 100_000_000n,
    unit: 'MON',
    toDisplayAmount: (amount: bigint) => String(amount),
    fromDisplayAmount: (amount: string) => BigInt(amount),
    topics: {
      post: jest.fn(),
      fetchOne: jest.fn(),
      fetchByTopic: jest.fn(async () => []),
      discoverTopics: jest.fn(async () => []),
      vote: jest.fn(),
    },
  },
}))
jest.mock('src/composables/useActiveWallet', () => ({
  peekActiveWallet: () => undefined,
  useActiveWallet: jest.fn(),
}))

const t = (key: string) =>
  key.split('.').reduce((value: any, part) => value?.[part], enUS) ?? key
const box = { template: '<div><slot /></div>' }
// Like QBtn: `to` is a router link (push, or replace with `replace`).
const button = {
  props: ['icon', 'label', 'to', 'replace'],
  emits: ['click'],
  methods: {
    press(this: any) {
      this.$emit('click')
      if (this.to) void this.$router[this.replace ? 'replace' : 'push'](this.to)
    },
  },
  template:
    '<button :data-icon="icon" @click="press">{{ label }}<slot /></button>',
}

let router: Router
let destroy: () => void = () => undefined

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  destroy()
  resetNavigationForTests()
})

function mountForum() {
  return mount(ForumLayout, {
    global: {
      plugins: [router],
      mocks: { $t: t, $q: { screen: { width: 1280 } } },
      stubs: {
        ForumDrawer: true,
        RouterView: true,
        QDrawer: box,
        QHeader: box,
        QToolbar: box,
        QToolbarTitle: box,
        QSpace: true,
        QPageContainer: box,
        QPage: box,
        QScrollArea: box,
        QPullToRefresh: box,
        QIcon: true,
        QSpinner: true,
        QCircularProgress: true,
        QChip: box,
        QBtn: button,
      },
    },
  })
}

describe('forum thread back arrow and breadcrumb', () => {
  it.each(['forum-back', 'forum-breadcrumb'])(
    '%s goes back to the forum, and Back then leaves it',
    async control => {
      ;({ router, destroy } = await openApp(
        ['/forum', '/forum/:payloadDigest', '/chat'],
        '/chat',
      ))
      await router.push('/forum')
      const forumPosition = historyPosition()
      await router.push('/forum/abc')
      const wrapper = mountForum()
      await flushPromises()
      await wrapper.get(`[data-test="${control}"]`).trigger('click')
      await flushHistory()
      expect(router.currentRoute.value.path).toBe('/forum')
      expect(historyPosition()).toBe(forumPosition)
      await userBack(router)
      expect(router.currentRoute.value.path).toBe('/chat')
      wrapper.unmount()
    },
  )

  it('opened directly, the arrow replaces the thread with the forum', async () => {
    ;({ router, destroy } = await openApp(
      ['/forum', '/forum/:payloadDigest'],
      '/forum/abc',
    ))
    const threadPosition = historyPosition()
    const wrapper = mountForum()
    await flushPromises()
    await wrapper.get('[data-test="forum-back"]').trigger('click')
    await flushHistory()
    expect(router.currentRoute.value.path).toBe('/forum')
    expect(historyPosition()).toBe(threadPosition)
    wrapper.unmount()
  })
})

describe('AVU details back arrow', () => {
  function mountAvu() {
    return mount(AvuDetails, {
      global: {
        plugins: [router],
        mocks: { $t: t },
        stubs: {
          QHeader: box,
          QToolbar: box,
          QToolbarTitle: box,
          QPageContainer: box,
          QPage: box,
          QCard: box,
          QCardSection: box,
          QCardActions: box,
          QAvatar: box,
          QIcon: true,
          QSpace: true,
          QMarkupTable: box,
          QBtnToggle: true,
          QBtn: button,
        },
      },
    })
  }

  it('goes back to the wallet it was opened from', async () => {
    ;({ router, destroy } = await openApp(['/wallet', '/avu'], '/wallet'))
    const walletPosition = historyPosition()
    await router.push('/avu')
    const wrapper = mountAvu()
    await wrapper.get('[data-icon="arrow_back"]').trigger('click')
    await flushHistory()
    expect(router.currentRoute.value.path).toBe('/wallet')
    expect(historyPosition()).toBe(walletPosition)
    wrapper.unmount()
  })

  it('opened directly, replaces itself with the wallet', async () => {
    ;({ router, destroy } = await openApp(['/wallet', '/avu'], '/avu'))
    const avuPosition = historyPosition()
    const wrapper = mountAvu()
    await wrapper.get('[data-icon="arrow_back"]').trigger('click')
    await flushHistory()
    expect(router.currentRoute.value.path).toBe('/wallet')
    expect(historyPosition()).toBe(avuPosition)
    wrapper.unmount()
  })
})
