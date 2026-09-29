/** @jest-environment jsdom */

import { mount, VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import type { Router } from 'vue-router'

const mockProfileStore = { profile: { name: '' } }
const mockWalletStore: { seedPhrase?: string } = {}
const mockSetActiveChat = jest.fn()
const mockForumLayoutSetup = jest.fn()
const mockSetupPageSetup = jest.fn()

Object.defineProperty(window, 'scrollTo', { value: jest.fn(), writable: true })

// vue-router's CommonJS build requires nostics' ESM-only entrypoint. Keep this
// boundary test on Jest's existing CommonJS setup by replacing diagnostics only.
jest.mock('nostics', () => ({
  createConsoleReporter: () => jest.fn(),
  defineDiagnostics: () => new Proxy({}, { get: () => jest.fn() }),
}))
jest.mock('@vue/devtools-api', () => ({ setupDevtoolsPlugin: jest.fn() }))
const nestedDevtoolsApiPath = require
  .resolve('@vue/devtools-api', { paths: [require.resolve('vue-router')] })
  .replace('index-node.cjs', 'index.cjs')
jest.doMock(nestedDevtoolsApiPath, () => ({
  setupDevtoolsPlugin: jest.fn(),
}))
jest.mock('src/utils/runtime-mode', () => ({
  monadModeEnabled: () => true,
}))
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => mockProfileStore,
}))
jest.mock('src/stores/wallet', () => ({
  useWalletStore: () => mockWalletStore,
}))
jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({ fetchAndAddContact: jest.fn() }),
}))
jest.mock('src/stores/chats', () => ({
  useChatStore: () => ({ setActiveChat: mockSetActiveChat }),
}))
jest.mock('layouts/MainLayout.vue', () =>
  defineComponent({
    name: 'MainLayoutStub',
    setup: () => () => h(RouterView),
  }),
)
jest.mock('layouts/ForumLayout.vue', () =>
  defineComponent({
    name: 'ForumLayoutBoundary',
    setup() {
      mockForumLayoutSetup()
      return () => h(RouterView)
    },
  }),
)
jest.mock('pages/Forum.vue', () =>
  defineComponent({
    name: 'ForumPageStub',
    setup: () => () => h('div', { 'data-test': 'forum' }),
  }),
)
jest.mock('pages/ForumPost.vue', () =>
  defineComponent({
    name: 'ForumPostStub',
    setup: () => () => h('div', { 'data-test': 'forum-post' }),
  }),
)
jest.mock('pages/CreatePost.vue', () =>
  defineComponent({
    name: 'CreatePostStub',
    setup: () => () => h('div', { 'data-test': 'create-post' }),
  }),
)
jest.mock('pages/Setup.vue', () =>
  defineComponent({
    name: 'SetupPageBoundary',
    setup() {
      mockSetupPageSetup()
      return () => h('div', { 'data-test': 'setup' }, 'Set up wallet')
    },
  }),
)

let RouterView: typeof import('vue-router').RouterView
let createAppRouter: typeof import('./index').default

beforeAll(async () => {
  RouterView = (await import('vue-router')).RouterView
  createAppRouter = (await import('./index')).default
})

const AppRoot = defineComponent({
  name: 'AppRoot',
  setup: () => () => h(RouterView),
})

async function renderRoute(path: string): Promise<{
  router: Router
  wrapper: VueWrapper
}> {
  const router = createAppRouter()
  await router.push(path)
  await router.isReady()
  const wrapper = mount(AppRoot, { global: { plugins: [router] } })
  await wrapper.vm.$nextTick()
  return { router, wrapper }
}

describe('wallet onboarding router boundary', () => {
  beforeEach(() => {
    mockProfileStore.profile.name = ''
    mockWalletStore.seedPhrase = undefined
    mockForumLayoutSetup.mockClear()
    mockSetupPageSetup.mockClear()
    mockSetActiveChat.mockClear()
  })

  it.each(['/', '/forum', '/forum/post-digest', '/new-post'])(
    'settles walletless navigation from %s on setup before Forum mounts',
    async path => {
      const { router, wrapper } = await renderRoute(path)

      expect(router.currentRoute.value.fullPath).toBe('/setup')
      expect(wrapper.get('[data-test="setup"]').text()).toBe('Set up wallet')
      expect(mockSetupPageSetup).toHaveBeenCalledTimes(1)
      expect(mockForumLayoutSetup).not.toHaveBeenCalled()

      wrapper.unmount()
    },
  )

  it('does not redirect setup to itself', async () => {
    const { router, wrapper } = await renderRoute('/setup')

    expect(router.currentRoute.value.fullPath).toBe('/setup')
    expect(mockSetupPageSetup).toHaveBeenCalledTimes(1)
    expect(mockForumLayoutSetup).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('does not let stale profile state open Forum without a wallet', async () => {
    mockProfileStore.profile.name = 'stale profile'

    const { router, wrapper } = await renderRoute('/forum')

    expect(router.currentRoute.value.fullPath).toBe('/setup')
    expect(mockForumLayoutSetup).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('keeps Forum reachable for a configured wallet', async () => {
    mockWalletStore.seedPhrase = 'configured wallet seed'

    const { router, wrapper } = await renderRoute('/forum')

    expect(router.currentRoute.value.fullPath).toBe('/forum')
    expect(wrapper.get('[data-test="forum"]').exists()).toBe(true)
    expect(mockForumLayoutSetup).toHaveBeenCalledTimes(1)
    expect(mockSetupPageSetup).not.toHaveBeenCalled()

    wrapper.unmount()
  })
})
