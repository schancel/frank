/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://signet.mx/"}
 */
import { flushPromises } from '@vue/test-utils'
import { TextDecoder, TextEncoder } from 'util'

Object.assign(globalThis, { TextEncoder, TextDecoder })

// Router diagnostics/devtools are ESM-only.
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
jest.mock('./utils/apply-locale', () => ({ applyLocale: jest.fn() }))
jest.mock('./utils/theme', () => ({ applyTheme: jest.fn() }))
jest.mock('./utils/notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('./components/dialogs/ContactBookDialog.vue', () => ({
  template: '<div />',
}))
const mockAccountStatus = { status: 'fresh' }
const mockGetWallet = jest.fn(async () => ({
  chainIdentifier: 'monad-regtest',
  getBalance: async () => 50n,
}))
const mockPersonaSigner = jest.fn(async () => ({
  addresses: async () => ['0x' + '11'.repeat(20)],
}))
jest.mock('./accounts/session', () => ({
  accountStatus: mockAccountStatus,
  accountSession: {
    state: { revision: 0, account: null },
    getWallet: () => mockGetWallet(),
    createDappPersonaSigner: () => mockPersonaSigner(),
  },
}))
jest.mock('./adapters/level-message-store', () => ({
  store: Promise.resolve({}),
}))
/* eslint-disable @typescript-eslint/no-var-requires */
const AppRuntime = require('./AppRuntime.vue').default
const {
  pageSyncSender,
  startPageSyncSender,
  cancelPageSyncSender,
} = require('src/utils/extension-account-sync')
const extensionAdapter = require('../src-bex/runtime-adapter')
const { FRANK_PWA_EXTENSION_SYNC_CHANNEL } = extensionAdapter
/* eslint-enable @typescript-eslint/no-var-requires */

const SHARES = ['ms12frankshareone', 'ms12franksharetwo']

function receive(init: { source: unknown; origin: string }) {
  const push = jest.fn(async () => undefined)
  const ctx = {
    $route: { path: '/forum' },
    $router: { push },
    setupConnections: jest.fn(),
  }
  AppRuntime.methods.handleGlobalExtensionSyncMessage.call(ctx, {
    ...init,
    data: {
      channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
      direction: 'to-pwa',
      type: 'pair-hello',
      id: 'sync-pair-1',
    },
  } as unknown as MessageEvent)
  return push
}

describe('AppRuntime account sync listener (PIN pairing)', () => {
  let postMessage: jest.SpyInstance
  beforeEach(() => {
    postMessage = jest.spyOn(window, 'postMessage').mockImplementation()
  })
  afterEach(() => {
    postMessage.mockRestore()
    cancelPageSyncSender()
  })

  it('ignores pairing messages from another window or origin', () => {
    startPageSyncSender({ backupShares: [...SHARES] })
    postMessage.mockClear()
    receive({ source: null, origin: window.location.origin })
    receive({ source: {}, origin: window.location.origin })
    receive({ source: window, origin: 'https://evil.example' })
    expect(postMessage).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'acknowledges only an actually opened sender route (opened=%s)',
    async opened => {
      mockAccountStatus.status = 'ready'
      const context = {
        $route: { path: '/forum' },
        $router: {
          push: jest.fn(async (path: string) => {
            context.$route.path = opened ? path : '/setup'
          }),
        },
      }
      postMessage.mockClear()
      AppRuntime.methods.handleGlobalExtensionSyncMessage.call(context, {
        source: window,
        origin: window.location.origin,
        data: {
          channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
          direction: 'to-pwa',
          type: 'open-sync-sender',
          id: 'navigation-only',
        },
      } as unknown as MessageEvent)
      await flushPromises()
      expect(context.$router.push).toHaveBeenCalledWith('/account-sync/send')
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'sync-navigation-reply',
          result: { ok: opened },
        }),
        window.location.origin,
      )
      expect(pageSyncSender.value).toBeNull()
      mockAccountStatus.status = 'fresh'
    },
  )

  it('answers the extension for the account this web app offers, without the account', () => {
    startPageSyncSender({ backupShares: [...SHARES] })
    postMessage.mockClear()
    const push = receive({ source: window, origin: window.location.origin })
    expect(push).not.toHaveBeenCalled()
    expect(postMessage).toHaveBeenCalledTimes(1)
    const [reply, target] = postMessage.mock.calls[0]
    expect(target).toBe(window.location.origin)
    expect(reply).toMatchObject({ type: 'pair-reply', result: { ok: true } })
    expect(JSON.stringify(reply)).not.toContain(SHARES[0])
  })
})

describe('AppRuntime extension persona observations', () => {
  it('tags the unlocked wallet network without persisting provider selection', async () => {
    const adapter = extensionAdapter
    const set = jest.fn(async (_value: Record<string, unknown>) => undefined)
    const runtime = jest
      .spyOn(adapter, 'isBrowserExtensionRuntime')
      .mockReturnValue(true)
    const send = jest
      .spyOn(adapter, 'sendRuntimeMessage')
      .mockResolvedValue({ result: {} })
    const api = jest
      .spyOn(adapter, 'getRawExtensionApi')
      .mockReturnValue({ storage: { local: { set } } })
    const priorURL = window.location.href
    try {
      window.history.replaceState({}, '', '/?extMode=popup')
      mockAccountStatus.status = 'ready'
      AppRuntime.methods.setupConnections.call({
        $status: {},
        hasExistingContacts: () => false,
        loadCuratedDefaults: () => undefined,
      })
      for (let i = 0; i < 10; i++) await Promise.resolve()
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'update-persona-state',
          chainIdentifier: 'monad-regtest',
          chainIdHex: '0x' + (20143).toString(16),
          poolBalanceWeiHex: '0x32',
        }),
      )
      expect(set).toHaveBeenCalledWith({
        frankDappPersonaAddress: '0x' + '11'.repeat(20),
      })
      expect(
        set.mock.calls.flatMap(call => Object.keys(call[0])),
      ).not.toContain('frankChainIdHex')
    } finally {
      mockAccountStatus.status = 'fresh'
      window.history.replaceState({}, '', priorURL)
      runtime.mockRestore()
      send.mockRestore()
      api.mockRestore()
    }
  })
})
