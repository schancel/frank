/** @jest-environment jsdom */

import { mount, VueWrapper } from '@vue/test-utils'
import { createApp, defineComponent, h } from 'vue'
import type { Pinia } from 'pinia'
import type { Router } from 'vue-router'
import { generateMnemonic } from 'bip39'
import { initialSetupSeed } from '../utils/setup-account'

type PersistedState = Record<string, string>

class MemoryLevel {
  private readonly values: Map<string, string>

  constructor(initialValues: PersistedState) {
    this.values = new Map(Object.entries(initialValues))
  }

  async get(key: string): Promise<string> {
    const value = this.values.get(key)
    if (value === undefined) {
      throw new Error(`Key not found: ${key}`)
    }
    return value
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }
}

let mockStorage: MemoryLevel
const mockSetActiveChat = jest.fn()
const mockForumLayoutSetup = jest.fn()
const mockSetupPageSetup = jest.fn()
// Mirrors what Setup.vue does when it opens (draft seed offered to the New
// Account step); must never write the wallet store.
const mockSetupOpen = jest.fn()

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
jest.mock('level', () => jest.fn(() => mockStorage))
jest.mock('../adapters/level-utxo-store', () => ({
  store: Promise.resolve({}),
}))
jest.mock('src/utils/runtime-mode', () => ({
  monadModeEnabled: () => true,
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
      mockSetupOpen()
      return () => h('div', { 'data-test': 'setup' }, 'Set up wallet')
    },
  }),
)

let RouterView: typeof import('vue-router').RouterView
let createAppRouter: typeof import('./index').default
let installPinia: typeof import('../boot/pinia').default
let useProfileStore: typeof import('../stores/my-profile').useProfileStore
let useWalletStore: typeof import('../stores/wallet').useWalletStore

beforeAll(async () => {
  RouterView = (await import('vue-router')).RouterView
  installPinia = (await import('../boot/pinia')).default
  useProfileStore = (await import('../stores/my-profile')).useProfileStore
  useWalletStore = (await import('../stores/wallet')).useWalletStore
  createAppRouter = (await import('./index')).default
})

const AppRoot = defineComponent({
  name: 'AppRoot',
  setup: () => () => h(RouterView),
})

async function renderRoute(
  path: string,
  persistedState: {
    seedPhrase?: string
    profileName?: string
    seedConfirmedAt?: number
  } = {},
): Promise<{
  router: Router
  wrapper: VueWrapper
  walletStore: ReturnType<typeof useWalletStore>
  storedWallet: () => Promise<{
    seedPhrase: string | null
    seedConfirmedAt?: number | null
  }>
}> {
  mockStorage = new MemoryLevel({
    wallet: JSON.stringify({
      xPrivKey: null,
      seedPhrase: persistedState.seedPhrase ?? null,
      ...(persistedState.seedConfirmedAt !== undefined
        ? { seedConfirmedAt: persistedState.seedConfirmedAt }
        : {}),
      utxos: {},
      feePerByte: 2,
      balance: 0,
    }),
    myProfile: JSON.stringify({
      profile: { name: persistedState.profileName ?? '' },
      inbox: {},
    }),
  })

  const persistenceApp = createApp(AppRoot)
  await installPinia({ app: persistenceApp } as never)
  const pinia = persistenceApp.config.globalProperties.$pinia as Pinia
  const walletStore = useWalletStore(pinia)
  await walletStore.restored
  const profileStore = useProfileStore(pinia)
  await profileStore.restored

  const router = createAppRouter()
  await router.push(path)
  await router.isReady()
  const wrapper = mount(AppRoot, { global: { plugins: [router] } })
  await wrapper.vm.$nextTick()
  return {
    router,
    wrapper,
    walletStore,
    storedWallet: async () => {
      await walletStore.flushPersistence()
      return JSON.parse(await mockStorage.get('wallet'))
    },
  }
}

describe('wallet onboarding router boundary', () => {
  beforeEach(() => {
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
    const { router, wrapper } = await renderRoute('/forum', {
      profileName: 'stale profile',
    })

    expect(router.currentRoute.value.fullPath).toBe('/setup')
    expect(mockForumLayoutSetup).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('keeps Forum reachable for a completed wallet (seed and name)', async () => {
    const { router, wrapper } = await renderRoute('/forum', {
      seedPhrase: 'configured wallet seed',
      profileName: 'Alice',
    })

    expect(router.currentRoute.value.fullPath).toBe('/forum')
    expect(wrapper.get('[data-test="forum"]').exists()).toBe(true)
    expect(mockForumLayoutSetup).toHaveBeenCalledTimes(1)
    expect(mockSetupPageSetup).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  describe('existing accounts without the confirmation marker (#284)', () => {
    it.each(['/', '/forum'])(
      'completed-old (seed + name, no marker) is grandfathered on %s: not sent to onboarding, storage untouched',
      async path => {
        const seed = generateMnemonic()
        const { router, walletStore, storedWallet, wrapper } =
          await renderRoute(path, { seedPhrase: seed, profileName: 'Alice' })

        expect(router.currentRoute.value.fullPath).toBe('/forum')
        expect(mockSetupPageSetup).not.toHaveBeenCalled()
        expect(walletStore.seedPhrase).toBe(seed)
        expect(walletStore.seedConfirmedAt).toBeNull()
        expect((await storedWallet()).seedPhrase).toBe(seed)
        wrapper.unmount()
      },
    )

    it.each(['/', '/forum'])(
      'affected-by-#267 (seed, no name) is routed to setup from %s with the seed intact',
      async path => {
        const seed = generateMnemonic()
        const { router, walletStore, storedWallet, wrapper } =
          await renderRoute(path, { seedPhrase: seed })

        expect(router.currentRoute.value.fullPath).toBe('/setup')
        expect(mockForumLayoutSetup).not.toHaveBeenCalled()
        expect(walletStore.seedPhrase).toBe(seed)
        expect((await storedWallet()).seedPhrase).toBe(seed)
        wrapper.unmount()
      },
    )

    it('confirmed accounts stay on Forum and keep their marker', async () => {
      const seed = generateMnemonic()
      const { router, walletStore, wrapper } = await renderRoute('/forum', {
        seedPhrase: seed,
        profileName: 'Alice',
        seedConfirmedAt: 1700000000000,
      })
      expect(router.currentRoute.value.fullPath).toBe('/forum')
      expect(walletStore.seedConfirmedAt).toBe(1700000000000)
      wrapper.unmount()
    })
  })

  describe('opening setup does not persist a wallet (#267)', () => {
    beforeEach(() => {
      mockSetupOpen.mockImplementation(() => {
        const store = useWalletStore()
        initialSetupSeed(store.seedPhrase, generateMnemonic)
      })
    })

    it('reload during onboarding lands back on setup with no seed stored', async () => {
      const first = await renderRoute('/setup')
      expect(mockSetupPageSetup).toHaveBeenCalledTimes(1)
      expect(first.walletStore.seedPhrase).toBeNull()
      const persisted = await first.storedWallet()
      expect(persisted.seedPhrase).toBeNull()
      first.wrapper.unmount()

      // "Reload": new app boot over the same storage.
      for (const path of ['/', '/forum']) {
        const reloaded = await renderRoute(path, {
          seedPhrase: persisted.seedPhrase ?? undefined,
        })
        expect(reloaded.router.currentRoute.value.fullPath).toBe('/setup')
        expect(reloaded.walletStore.seedPhrase).toBeNull()
        reloaded.wrapper.unmount()
      }
    })

    it('never touches an existing stored account when setup is opened', async () => {
      const seed = generateMnemonic()
      const { walletStore, storedWallet, wrapper } = await renderRoute(
        '/setup',
        { seedPhrase: seed, profileName: 'Alice' },
      )
      expect(walletStore.seedPhrase).toBe(seed)
      expect((await storedWallet()).seedPhrase).toBe(seed)
      wrapper.unmount()
    })

    it('leaves a completed-setup user on Forum, seed intact', async () => {
      const seed = generateMnemonic()
      const { router, walletStore, wrapper } = await renderRoute('/forum', {
        seedPhrase: seed,
        profileName: 'Alice',
      })
      expect(router.currentRoute.value.fullPath).toBe('/forum')
      expect(walletStore.seedPhrase).toBe(seed)
      wrapper.unmount()
    })
  })
})
