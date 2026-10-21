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
/* eslint-disable @typescript-eslint/no-var-requires */
const AppRuntime = require('./AppRuntime.vue').default
const {
  pageSyncSender,
  startPageSyncSender,
} = require('src/utils/extension-account-sync')
const {
  FRANK_PWA_EXTENSION_SYNC_CHANNEL,
} = require('../src-bex/runtime-adapter')
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
    pageSyncSender.value = null
  })

  it('ignores pairing messages from another window or origin', () => {
    startPageSyncSender({ backupShares: [...SHARES] })
    postMessage.mockClear()
    receive({ source: null, origin: window.location.origin })
    receive({ source: {}, origin: window.location.origin })
    receive({ source: window, origin: 'https://evil.example' })
    expect(postMessage).not.toHaveBeenCalled()
  })

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
