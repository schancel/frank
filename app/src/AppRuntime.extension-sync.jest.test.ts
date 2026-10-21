/** @jest-environment jsdom */
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
jest.mock('./accounts/session', () => ({
  accountStatus: mockAccountStatus,
  accountSession: { state: { revision: 0, account: null } },
}))
jest.mock('./adapters/level-message-store', () => ({
  store: Promise.resolve({}),
}))
const mockRestore = jest.fn(async () => true)
jest.mock('src/utils/extension-account-sync', () => ({
  ...jest.requireActual('src/utils/extension-account-sync'),
  restoreAccountFromExtensionBundle: (...args: unknown[]) =>
    mockRestore(...args),
}))

/* eslint-disable @typescript-eslint/no-var-requires */
const AppRuntime = require('./AppRuntime.vue').default
const {
  clearExtensionSyncOffer,
  pendingExtensionSyncOffer,
} = require('src/utils/extension-account-sync')
const {
  FRANK_PWA_EXTENSION_SYNC_CHANNEL,
} = require('../src-bex/runtime-adapter')
/* eslint-enable @typescript-eslint/no-var-requires */

const syncBundle = {
  displayName: 'Ann',
  backupShares: ['ms12frankshareone', 'ms12franksharetwo'],
}

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
      type: 'extension-sync-push',
      id: 'sync-push-1',
      payload: { deviceSyncBundle: syncBundle },
    },
  } as unknown as MessageEvent)
  return push
}

describe('AppRuntime account sync listener (A8)', () => {
  beforeEach(() => {
    mockAccountStatus.status = 'fresh'
    mockRestore.mockClear()
    clearExtensionSyncOffer()
  })

  it('ignores sync messages from another window or origin', () => {
    receive({ source: null, origin: window.location.origin })
    receive({ source: {}, origin: window.location.origin })
    receive({ source: window, origin: 'https://evil.example' })
    expect(pendingExtensionSyncOffer.value).toBeNull()
    expect(mockRestore).not.toHaveBeenCalled()
  })

  it('offers a same-window account for confirmation instead of restoring it', () => {
    const push = receive({ source: window, origin: window.location.origin })
    expect(mockRestore).not.toHaveBeenCalled()
    expect(pendingExtensionSyncOffer.value?.deviceSyncBundle).toEqual(
      syncBundle,
    )
    expect(push).toHaveBeenCalledWith('/welcome')
  })

  it('offers nothing when an account already exists', () => {
    mockAccountStatus.status = 'ready'
    receive({ source: window, origin: window.location.origin })
    expect(pendingExtensionSyncOffer.value).toBeNull()
    expect(mockRestore).not.toHaveBeenCalled()
  })

  it('tells the extension whether the account was offered, so it never reports a false delivery', () => {
    const postMessage = jest.spyOn(window, 'postMessage').mockImplementation()
    try {
      const replies = () =>
        postMessage.mock.calls.map(([msg, target]) => [
          (msg as { type: string; offered: boolean }).type,
          (msg as { offered: boolean }).offered,
          target,
        ])

      mockAccountStatus.status = 'ready'
      receive({ source: window, origin: window.location.origin })
      mockAccountStatus.status = 'fresh'
      receive({ source: window, origin: window.location.origin })
      // An unauthenticated message gets no reply at all.
      receive({ source: null, origin: 'https://evil.example' })

      expect(replies()).toEqual([
        ['sync-offer-result', false, window.location.origin],
        ['sync-offer-result', true, window.location.origin],
      ])
    } finally {
      postMessage.mockRestore()
    }
  })
})
