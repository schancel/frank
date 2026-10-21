/** @jest-environment jsdom */

const mockAccountStatus: Record<string, unknown> = {
  status: 'fresh',
  account: null,
  pending: null,
}
jest.mock('../accounts/session', () => ({
  accountStatus: mockAccountStatus,
  accountSession: {},
}))
const mockCreateCeremony = jest.fn()
jest.mock('../accounts/ceremony', () => ({
  createAccountCeremony: () => mockCreateCeremony(),
}))
jest.mock('../stores/persistent-storage', () => ({
  usePersistentStorageStore: jest.fn(),
}))
jest.mock('./identity-session', () => ({ nameOwnProfile: jest.fn() }))
jest.mock('@frank/wallet/chain', () => ({ setCustomRelayBaseUrl: jest.fn() }))

import {
  handlePageSyncPairingRequest,
  pageSyncSender,
  receiveAccountOverBridge,
  restoreAccountFromExtensionBundle,
  startPageSyncSender,
} from './extension-account-sync'
import { FRANK_PWA_EXTENSION_SYNC_CHANNEL } from '../../src-bex/runtime-adapter'

const SHARES = ['ms12frankshareone', 'ms12franksharetwo']
const bundle = () => ({ displayName: 'Ann', backupShares: [...SHARES] })

function pairEvent(init: { source?: unknown; origin?: string }): MessageEvent {
  return {
    source: 'source' in init ? init.source : window,
    origin: init.origin ?? window.location.origin,
    data: {
      channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
      direction: 'to-pwa',
      type: 'pair-hello',
      id: 'sync-pair-1',
    },
  } as unknown as MessageEvent
}

describe('web app account sync session (PIN pairing)', () => {
  let postMessage: jest.SpyInstance
  beforeEach(() => {
    postMessage = jest.spyOn(window, 'postMessage').mockImplementation()
  })
  afterEach(() => {
    postMessage.mockRestore()
    pageSyncSender.value = null
  })

  it('shows a PIN and tells the extension it offers an account, without sending the account or the PIN', () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem')
    try {
      const view = startPageSyncSender(bundle())
      expect(view.pin).toMatch(/^\d{6}$/)
      expect(pageSyncSender.value).toEqual({ pin: view.pin, status: 'waiting' })
      expect(postMessage).toHaveBeenCalledTimes(1)
      const [offer, target] = postMessage.mock.calls[0]
      expect(offer).toMatchObject({ type: 'pwa-sync-offer' })
      expect(target).toBe(window.location.origin)
      expect(JSON.stringify(offer)).not.toContain(SHARES[0])
      expect(JSON.stringify(offer)).not.toContain(view.pin)
      expect(setItem).not.toHaveBeenCalled()
    } finally {
      setItem.mockRestore()
    }
  })

  it('answers pairing requests only from this window and this origin', () => {
    startPageSyncSender(bundle())
    postMessage.mockClear()
    expect(handlePageSyncPairingRequest(pairEvent({ source: {} }))).toBe(false)
    expect(handlePageSyncPairingRequest(pairEvent({ source: null }))).toBe(
      false,
    )
    expect(
      handlePageSyncPairingRequest(
        pairEvent({ origin: 'https://evil.example' }),
      ),
    ).toBe(false)
    expect(postMessage).not.toHaveBeenCalled()

    expect(handlePageSyncPairingRequest(pairEvent({}))).toBe(true)
    const [reply, target] = postMessage.mock.calls[0]
    expect(target).toBe(window.location.origin)
    expect(reply).toMatchObject({ type: 'pair-reply', id: 'sync-pair-1' })
    expect(reply.result).toEqual({
      ok: true,
      sid: expect.any(String),
      Ya: expect.any(String),
    })
  })
})

describe('a device that already has an account takes none from sync', () => {
  const ACCOUNT = { receipt: { context: { accountId: 'existing' } } }
  const PENDING = { account: { receipt: { operationId: 'signup-1' } } }
  afterEach(() => {
    Object.assign(mockAccountStatus, {
      status: 'fresh',
      account: null,
      pending: null,
    })
    mockCreateCeremony.mockReset()
  })

  it.each([
    ['locked', { status: 'locked', account: ACCOUNT, pending: null }],
    ['pending', { status: 'pending', account: null, pending: PENDING }],
    ['unavailable', { status: 'unavailable', account: ACCOUNT, pending: null }],
    ['ready', { status: 'ready', account: ACCOUNT, pending: null }],
    ['loading', { status: 'loading', account: null, pending: null }],
  ])(
    '%s: neither pairs nor restores, so the existing account or signup survives',
    async (_name, status) => {
      Object.assign(mockAccountStatus, status)
      const postMessage = jest.spyOn(window, 'postMessage').mockImplementation()
      try {
        expect(await receiveAccountOverBridge('123456')).toEqual({
          ok: false,
          reason: 'has-account',
        })
        expect(postMessage).not.toHaveBeenCalled()
      } finally {
        postMessage.mockRestore()
      }
      expect(await restoreAccountFromExtensionBundle(bundle())).toBe(false)
      // No restore ceremony began, so nothing was staged or cancelled.
      expect(mockCreateCeremony).not.toHaveBeenCalled()
    },
  )
})

describe('restoring a synced account never cancels a pending signup', () => {
  afterEach(() => mockCreateCeremony.mockReset())

  it('starts the restore with keepPending and gives up when custody refuses', async () => {
    const ceremony = {
      beginRestore: jest.fn(async () => {
        // Durable custody holds another tab's signup: the restore is refused.
        throw Object.assign(new Error('Account custody: conflict'), {
          name: 'CustodyError',
          code: 'conflict',
        })
      }),
      confirm: jest.fn(),
      cancel: jest.fn(),
    }
    mockCreateCeremony.mockReturnValue(ceremony)
    expect(await restoreAccountFromExtensionBundle(bundle())).toBe(false)
    expect(ceremony.beginRestore).toHaveBeenCalledWith(undefined, {
      keepPending: true,
    })
    expect(ceremony.confirm).not.toHaveBeenCalled()
  })
})

describe('navigation-only account sync request', () => {
  const navigate = jest.fn(async () => true)
  const good = (win: Window, changes: Record<string, unknown> = {}) =>
    ({
      source: win,
      origin: 'https://signet.mx',
      data: {
        channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
        direction: 'to-pwa',
        type: 'open-sync-sender',
        id: 'navigation-only-1',
      },
      ...changes,
    } as unknown as MessageEvent)
  const webWindow = () => {
    const win = {
      location: { origin: 'https://signet.mx' },
      postMessage: jest.fn(),
    } as unknown as Window
    Object.assign(win, { top: win })
    return win
  }
  beforeEach(() => {
    navigate.mockClear()
    mockAccountStatus.status = 'ready'
  })
  it('navigates only a ready top-level Frank page and acknowledges no account payload', async () => {
    const { handlePageSyncNavigationRequest } = await import(
      './extension-account-sync'
    )
    const win = webWindow()
    expect(
      await handlePageSyncNavigationRequest(good(win), navigate, win),
    ).toBe(true)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(win.postMessage).toHaveBeenCalledWith(
      {
        channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
        direction: 'to-extension',
        type: 'sync-navigation-reply',
        id: 'navigation-only-1',
        result: { ok: true },
      },
      'https://signet.mx',
    )
    expect(pageSyncSender.value).toBeNull()
  })
  it.each(['fresh', 'locked', 'standby', 'pending'])(
    'does not navigate or export an account in %s state',
    async status => {
      const { handlePageSyncNavigationRequest } = await import(
        './extension-account-sync'
      )
      mockAccountStatus.status = status
      const win = webWindow()
      await handlePageSyncNavigationRequest(good(win), navigate, win)
      expect(navigate).not.toHaveBeenCalled()
      expect(win.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ result: { ok: false } }),
        'https://signet.mx',
      )
    },
  )
  it('does not acknowledge a refused or redirected navigation as opened', async () => {
    const { handlePageSyncNavigationRequest } = await import(
      './extension-account-sync'
    )
    const win = webWindow()
    await handlePageSyncNavigationRequest(good(win), async () => false, win)
    expect(win.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ result: { ok: false } }),
      'https://signet.mx',
    )
  })
  it('ignores another origin, another window, subframes and malformed messages', async () => {
    const { handlePageSyncNavigationRequest } = await import(
      './extension-account-sync'
    )
    const win = webWindow()
    for (const event of [
      good(win, { origin: 'https://evil.example' }),
      good(win, { source: {} }),
      good(win, {
        data: {
          channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
          direction: 'to-pwa',
          type: 'open-sync-sender',
          id: 7,
        },
      }),
    ]) {
      expect(await handlePageSyncNavigationRequest(event, navigate, win)).toBe(
        false,
      )
    }
    Object.assign(win, { top: {} })
    expect(
      await handlePageSyncNavigationRequest(good(win), navigate, win),
    ).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
    expect(win.postMessage).not.toHaveBeenCalled()
  })
})
