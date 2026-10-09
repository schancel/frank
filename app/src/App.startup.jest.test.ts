/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node", "node-addons"]}
 */
import { mount, flushPromises } from '@vue/test-utils'
import { createApp, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { LevelDB } from 'level'
import type { MessageWrapper } from '@frank/cashweb/types/messages'

// Match browser scheduling; the shared Jest setup replaces Promise with an older polyfill.
const previousPromise = globalThis.Promise
const NativePromise = (async () => undefined)()
  .constructor as PromiseConstructor
beforeAll(() => {
  globalThis.Promise = NativePromise
})
afterAll(() => {
  globalThis.Promise = previousPromise
})

function deferred() {
  let resolve!: () => void
  const promise = new NativePromise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
const mockReadGates = new Map<string, ReturnType<typeof deferred>>()
const mockReadStarted = new Map<string, ReturnType<typeof deferred>>()
function memoryDatabase() {
  const data = new Map<string, string>()
  return {
    data,
    get: jest.fn(async (key: string) => {
      mockReadStarted.get(key)?.resolve()
      await mockReadGates.get(key)?.promise
      if (!data.has(key))
        throw Object.assign(new Error('not found'), {
          notFound: true,
          type: 'NotFoundError',
        })
      return data.get(key)!
    }),
    put: jest.fn(async (key: string, value: string) => {
      data.set(key, value)
    }),
    del: jest.fn(async (key: string) => {
      data.delete(key)
    }),
    batch: jest.fn(async () => undefined),
    clear: jest.fn(async () => {
      data.clear()
    }),
    close: jest.fn(async () => undefined),
    iterator: () => {
      const entries = [...data.entries()][Symbol.iterator]()
      return {
        next(
          callback: (error: undefined, key?: string, value?: string) => void,
        ) {
          const entry = entries.next()
          callback(undefined, entry.value?.[0], entry.value?.[1])
        },
        end(callback: () => void) {
          callback()
        },
      }
    },
  }
}
const mockDatabases = new Map<string, ReturnType<typeof memoryDatabase>>()
function mockDatabase(path: string) {
  let db = mockDatabases.get(path)
  if (!db) {
    db = memoryDatabase()
    // Existing current-format message storage. Fresh/unsupported Open behavior is a separate predecessor.
    if (path.endsWith('/metadata')) db.data.set('schemaVersion', '2')
    if (path.endsWith('/messages')) db.data.set('lastServerTime', '100')
    mockDatabases.set(path, db)
  }
  return db
}
jest.mock(
  'level',
  () =>
    (
      path: string,
      optionsOrCallback?: unknown,
      callback?: (error: null, db: ReturnType<typeof mockDatabase>) => void,
    ) => {
      const db = mockDatabase(path)
      const opened =
        typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
      // Match level-packager/LevelUP construction while keeping real Open validation.
      void NativePromise.resolve().then(() => opened?.(null, db))
      return db
    },
)
jest.mock('quasar/wrappers', () => ({ boot: (callback: unknown) => callback }))
const mockInitialize = jest.fn(async () => undefined)
jest.mock('./accounts/session', () => ({
  accountStatus: { status: 'fresh' },
  accountSession: {
    initialize: (...args: unknown[]) => mockInitialize(...args),
    getWallet: async () => {
      await mockInitialize()
      throw new Error('custody must stay closed')
    },
  },
}))
const mockIdentity = jest.fn(async () => undefined)
jest.mock('./utils/monad-identity-session', () => ({
  initializeMonadIdentity: () => mockIdentity(),
}))
const mockTabInit = jest.fn(async () => undefined)
jest.mock('./stores/tab-coordinator', () => ({
  useTabCoordinatorStore: () => ({
    init: mockTabInit,
    isYielded: false,
    otherTabActive: false,
  }),
}))
const mockPersistent = jest.fn(async () => undefined)
jest.mock('./stores/persistent-storage', () => ({
  usePersistentStorageStore: () => ({ ensureForAccount: mockPersistent }),
}))
jest.mock('./stores/relay-client', () => ({
  useRelayClientStore: () => ({ token: '' }),
}))
jest.mock('./utils/apply-locale', () => ({ applyLocale: jest.fn() }))
jest.mock('./utils/theme', () => ({
  ...jest.requireActual('./utils/theme'),
  applyTheme: jest.fn(),
}))
jest.mock('./components/dialogs/ContactBookDialog.vue', () => ({
  template: '<div />',
}))
const mockRouteSetup = jest.fn()
jest.mock('./router/routes', () => ({
  createRoutes: () =>
    ['/setup', '/wallet', '/docs', '/chat/:address', '/welcome'].map(path => ({
      path,
      component: {
        setup: () => {
          mockRouteSetup()
          return {}
        },
        template: '<div data-test="route-content">Route content</div>',
      },
    })),
}))
jest.mock('nostics', () => ({
  createConsoleReporter: jest.fn(),
  defineDiagnostics: () => new Proxy({}, { get: () => jest.fn() }),
}))
jest.mock(
  require.resolve('@vue/devtools-api', {
    paths: [require.resolve('vue-router')],
  }),
  () => ({ setupDevtoolsPlugin: jest.fn() }),
)
jest.mock('vue-router', () => {
  const actual = jest.requireActual('vue-router')
  return {
    ...actual,
    createWebHistory: actual.createMemoryHistory,
    createWebHashHistory: actual.createMemoryHistory,
  }
})

/* eslint-disable @typescript-eslint/no-var-requires */
const App = require('./App.vue').default
const setupApis = require('./boot/setup-apis').default
const messagingBoot = require('./boot/monad-direct-messages').default
const createRouter = require('./router').default
const { createStoragePlugin, STORE_SCHEMA_VERSION } = require('./boot/pinia')
const {
  startupRestoration,
  setStartupRestoration,
} = require('./boot/startup-state')
const { i18n } = require('./boot/i18n')
const { useChatStore } = require('./stores/chats')
const { useContactStore } = require('./stores/contacts')
const { useAppearanceStore } = require('./stores/appearance')
const { useProfileStore } = require('./stores/my-profile')
const { store: messageStorePromise } = require('./adapters/level-message-store')
const {
  serializeMessageWrapper,
} = require('@frank/cashweb/relay/storage/level-storage')
/* eslint-enable @typescript-eslint/no-var-requires */
const PEER = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2B2b2B2B2B'
const SELF = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
function message(index: string): MessageWrapper {
  return {
    index,
    outbound: true,
    senderAddress: SELF,
    copartyAddress: PEER,
    message: {
      conversationId: '11111111-2222-4333-8444-555555555555',
      outbound: true,
      status: 'confirmed',
      receivedTime: 100,
      serverTime: 100,
      items: [{ type: 'text', text: 'PRIVATE SYNTHETIC CONTENT' }],
      outpoints: [],
      senderAddress: SELF,
    },
  }
}
function assertNoWrites(snapshot: Map<string, string>[]) {
  for (const [index, db] of [...mockDatabases.values()].entries()) {
    expect(db.put).not.toHaveBeenCalled()
    expect(db.del).not.toHaveBeenCalled()
    expect(db.batch).not.toHaveBeenCalled()
    expect(db.clear).not.toHaveBeenCalled()
    expect(db.data).toEqual(snapshot[index])
  }
}
async function fixture(
  locale = 'en-us',
  metadata = { networkName: 'livenet', version: STORE_SCHEMA_VERSION },
) {
  await messageStorePromise
  for (const db of mockDatabases.values()) db.data.clear()
  mockDatabase('MessageStore/metadata').data.set('schemaVersion', '2')
  mockDatabase('MessageStore/messages').data.set('lastServerTime', '100')
  const storage = mockDatabase('synthetic-app')
  storage.data.set('appearance', JSON.stringify({ locale, darkMode: false }))
  storage.data.set(
    'myProfile',
    JSON.stringify({ profile: { name: 'Synthetic' } }),
  )
  storage.data.set('chats', '{}')
  const pinia = createPinia()
  pinia.use(
    createStoragePlugin(
      storage as unknown as LevelDB,
      NativePromise.resolve(metadata),
    ),
  )
  const app = createApp({}).use(pinia).use(i18n)
  setActivePinia(pinia)
  return {
    pinia,
    app,
    storage,
    messages: mockDatabase('MessageStore/messages'),
  }
}
function mountedRoot(
  pinia: ReturnType<typeof createPinia>,
  router: ReturnType<typeof createRouter>,
  status: unknown,
) {
  return mount(App, {
    global: {
      plugins: [pinia, router, i18n],
      mocks: { $status: status, $q: { dark: { set: jest.fn() } } },
      stubs: {
        QBtn: true,
        QDialog: true,
        QCard: true,
        QCardSection: true,
        QAvatar: true,
        QCardActions: true,
      },
    },
  })
}

describe('visible read-only startup failure', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReadGates.clear()
    mockReadStarted.clear()
    setStartupRestoration({ phase: 'restoring' })
    jest.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  })
  afterEach(() => jest.restoreAllMocks())

  it.each([
    ['en-us', false, 'Saved data could not be loaded', 'status'],
    [
      'fr-fr',
      false,
      'Impossible de charger les données enregistrées',
      'status',
    ],
    ['fr-fr', true, 'Saved data could not be loaded', 'status'],
    ['en-us', false, 'Saved data could not be loaded', 'conversationId'],
  ])(
    'mounts safe localized failure with real malformed chat restore (%s, appearance failure: %s, heading: %s, missing: %s)',
    async (locale, badAppearance, heading, missingField) => {
      const { app, pinia, storage, messages } = await fixture(locale as string)
      if (badAppearance)
        storage.data.set('appearance', '{PRIVATE INVALID APPEARANCE')
      const invalid = message('malformed')
      Object.assign(invalid.message, { [missingField as string]: undefined })
      messages.data.set(invalid.index, serializeMessageWrapper(invalid))
      const snapshot = [...mockDatabases.values()].map(db => new Map(db.data))
      await expect(setupApis({ app })).resolves.toBeUndefined()
      await expect(useChatStore().restored).rejects.toThrow(
        missingField === 'conversationId'
          ? /explicit conversation ID required/
          : /Invalid stored message envelope/,
      )
      await messagingBoot({ app })
      const chats = useChatStore()
      const contacts = useContactStore()
      const select = jest.spyOn(chats, 'setActiveConversation')
      const fetch = jest.spyOn(contacts, 'fetchAndAddContact')
      const router = createRouter()
      await router.push('/wallet')
      await router.isReady()
      const wrapper = mountedRoot(
        pinia,
        router,
        app.config.globalProperties.$status,
      )
      for (const route of ['/setup', `/chat/${PEER}`, '/docs']) {
        await router.push(route)
        await flushPromises()
        await nextTick()
        expect(router.currentRoute.value.path).toBe(route)
        expect(wrapper.get('main h1').text()).toBe(heading)
        expect(wrapper.get('[role="alert"]').text()).not.toContain(
          'startupFailure.',
        )
        expect(wrapper.text()).not.toMatch(/PRIVATE|status is not defined/)
        expect(wrapper.find('[data-test="route-content"]').exists()).toBe(false)
        expect(wrapper.find('button,input').exists()).toBe(false)
      }
      expect(app.config.globalProperties.$status.setup).toBe(false)
      expect(mockInitialize).not.toHaveBeenCalled()
      expect(mockTabInit).not.toHaveBeenCalled()
      expect(mockIdentity).not.toHaveBeenCalled()
      expect(mockPersistent).not.toHaveBeenCalled()
      expect(mockRouteSetup).not.toHaveBeenCalled()
      expect(select).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
      assertNoWrites(snapshot)
      wrapper.unmount()
    },
  )

  it.each(['chat first', 'failure first'])(
    'settles all siblings and preserves real pending/confirmed twins (%s)',
    async order => {
      const { app, pinia, storage, messages } = await fixture('fr-fr')
      storage.data.set('myProfile', '{PRIVATE INVALID PROFILE')
      const pending = message('pending-local')
      pending.message.status = 'pending'
      pending.message.delivery = { attemptDigest: 'confirmed' }
      messages.data.set(pending.index, serializeMessageWrapper(pending))
      messages.data.set(
        'confirmed',
        serializeMessageWrapper(message('confirmed')),
      )
      const blockedKey = order === 'chat first' ? 'myProfile' : 'chats'
      const gate = deferred()
      mockReadGates.set(blockedKey, gate)
      const started = deferred()
      mockReadStarted.set(blockedKey, started)
      const snapshot = [...mockDatabases.values()].map(db => new Map(db.data))
      let complete = false
      const boot = setupApis({ app }).then(() => {
        complete = true
      })
      await started.promise
      if (order === 'chat first') await useChatStore().restored
      else await expect(useProfileStore().restored).rejects.toThrow()
      await nextTick()
      expect(complete).toBe(false)
      expect(startupRestoration.value.phase).toBe('restoring')
      const router = createRouter()
      await router.push('/wallet')
      await router.isReady()
      const wrapper = mountedRoot(
        pinia,
        router,
        app.config.globalProperties.$status,
      )
      expect(wrapper.get('main').attributes('aria-busy')).toBe('true')
      gate.resolve()
      await boot
      await messagingBoot({ app })
      await flushPromises()
      expect(wrapper.get('h1').text()).toBe(
        'Impossible de charger les données enregistrées',
      )
      expect(Object.keys(useChatStore().messages)).toEqual(['confirmed'])
      expect(mockInitialize).not.toHaveBeenCalled()
      expect(mockIdentity).not.toHaveBeenCalled()
      expect(mockTabInit).not.toHaveBeenCalled()
      expect(mockPersistent).not.toHaveBeenCalled()
      assertNoWrites(snapshot)
      wrapper.unmount()
    },
  )

  it('observes an eager actual Open failure and presents it through rejected chat restoration', async () => {
    const { app, pinia } = await fixture()
    const failure = new Error('PRIVATE MESSAGE DATABASE IO FAILURE')
    mockDatabase('MessageStore/metadata').get.mockRejectedValueOnce(failure)
    let failedOpen!: Promise<unknown>
    jest.isolateModules(() => {
      failedOpen = jest.requireActual('./adapters/level-message-store').store
    })
    // Let eager Open reject before the boot consumer attaches. The adapter must observe it.
    await flushPromises()
    const openFailure = await failedOpen.then(
      () => undefined,
      error => error as Error,
    )
    expect(openFailure).toBeInstanceOf(Error)
    const adapter = jest.requireActual('./adapters/level-message-store')
    const priorStore = adapter.store
    adapter.store = failedOpen
    const snapshot = [...mockDatabases.values()].map(db => new Map(db.data))
    try {
      await expect(setupApis({ app })).resolves.toBeUndefined()
      await expect(useChatStore().restored).rejects.toBe(openFailure)
      await messagingBoot({ app })
      const router = createRouter()
      await router.push('/wallet')
      await router.isReady()
      const wrapper = mountedRoot(
        pinia,
        router,
        app.config.globalProperties.$status,
      )
      expect(wrapper.get('h1').text()).toBe('Saved data could not be loaded')
      expect(wrapper.text()).not.toContain('PRIVATE')
      expect(mockInitialize).not.toHaveBeenCalled()
      expect(mockIdentity).not.toHaveBeenCalled()
      expect(mockTabInit).not.toHaveBeenCalled()
      expect(mockPersistent).not.toHaveBeenCalled()
      assertNoWrites(snapshot)
      wrapper.unmount()
    } finally {
      adapter.store = priorStore
    }
  })

  it.each(['network mismatch', 'version mismatch', 'null chats'])(
    'requires actual message-store admission when chat hydration skips Open via %s',
    async route => {
      const metadata = {
        networkName: route === 'network mismatch' ? 'other-network' : 'livenet',
        version:
          route === 'version mismatch'
            ? STORE_SCHEMA_VERSION - 1
            : STORE_SCHEMA_VERSION,
      }
      const { app, pinia, storage, messages } = await fixture('en-us', metadata)
      if (route === 'null chats') storage.data.set('chats', 'null')
      messages.data.set(
        'retained',
        serializeMessageWrapper(message('retained')),
      )
      mockDatabase('MessageStore/metadata').data.set('schemaVersion', '1')
      const snapshot = [...mockDatabases.values()].map(db => new Map(db.data))
      const unhandled = jest.fn()
      process.on('unhandledRejection', unhandled)
      const adapter = jest.requireActual('./adapters/level-message-store')
      const priorStore = adapter.store
      let wrapper: ReturnType<typeof mountedRoot> | undefined
      try {
        let failedOpen!: Promise<unknown>
        jest.isolateModules(() => {
          failedOpen = jest.requireActual(
            './adapters/level-message-store',
          ).store
        })
        // The real adapter observes eager failure before boot consumes the original promise.
        await flushPromises()
        const openFailure = await failedOpen.then(
          () => undefined,
          error => error,
        )
        expect(openFailure).toMatchObject({ code: 'unsupported-schema' })
        adapter.store = failedOpen
        const gate = deferred()
        const started = deferred()
        if (route === 'null chats') {
          mockReadGates.set('myProfile', gate)
          mockReadStarted.set('myProfile', started)
        }
        const boot = setupApis({ app })
        if (route === 'null chats') {
          await started.promise
          await expect(useChatStore().restored).resolves.toBe(true)
          expect(startupRestoration.value.phase).toBe('restoring')
          expect(mockInitialize).not.toHaveBeenCalled()
          gate.resolve()
        }
        await expect(boot).resolves.toBeUndefined()
        // These chat paths intentionally keep their existing fresh-state policy. Database
        // admission is independently required even when the chat promise resolves.
        await expect(useChatStore().restored).resolves.toBe(true)
        await expect(failedOpen).rejects.toBe(openFailure)
        await messagingBoot({ app })
        expect(startupRestoration.value.phase).toBe('failed')
        expect(app.config.globalProperties.$status.setup).toBe(false)
        const chats = useChatStore()
        const select = jest.spyOn(chats, 'setActiveConversation')
        const fetch = jest.spyOn(useContactStore(), 'fetchAndAddContact')
        const router = createRouter()
        await router.push('/wallet')
        await router.isReady()
        wrapper = mountedRoot(
          pinia,
          router,
          app.config.globalProperties.$status,
        )
        for (const path of ['/setup', `/chat/${PEER}`, '/docs']) {
          await router.push(path)
          await flushPromises()
          await nextTick()
          expect(wrapper.get('h1').text()).toBe(
            'Saved data could not be loaded',
          )
          expect(wrapper.get('[role="alert"]').text()).not.toContain(
            'startupFailure.',
          )
          expect(wrapper.text()).not.toContain('PRIVATE')
          expect(wrapper.find('[data-test="route-content"]').exists()).toBe(
            false,
          )
        }
        for (const effect of [
          mockInitialize,
          mockTabInit,
          mockIdentity,
          mockPersistent,
          mockRouteSetup,
          select,
          fetch,
          unhandled,
        ]) {
          expect(effect).not.toHaveBeenCalled()
        }
        assertNoWrites(snapshot)
      } finally {
        wrapper?.unmount()
        adapter.store = priorStore
        process.removeListener('unhandledRejection', unhandled)
      }
    },
  )

  it('restores a fresh valid profile, starts normal services and mounts the unchanged runtime', async () => {
    const { app, pinia } = await fixture()
    await setupApis({ app })
    await messagingBoot({ app })
    expect(startupRestoration.value.phase).toBe('restored')
    expect(mockInitialize).toHaveBeenCalledTimes(1)
    expect(mockTabInit).toHaveBeenCalledTimes(1)
    expect(mockIdentity).toHaveBeenCalledTimes(1)
    const router = createRouter()
    await router.push('/wallet')
    await router.isReady()
    expect(router.currentRoute.value.path).toBe('/setup')
    const wrapper = mountedRoot(
      pinia,
      router,
      app.config.globalProperties.$status,
    )
    await flushPromises()
    await nextTick()
    expect(wrapper.find('[data-test="route-content"]').exists()).toBe(true)
    expect(mockPersistent).toHaveBeenCalledTimes(1)
    expect(useAppearanceStore().locale).toBe('en-us')
    wrapper.unmount()
  })
})
