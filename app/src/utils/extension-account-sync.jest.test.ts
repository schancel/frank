/** @jest-environment jsdom */

jest.mock('../accounts/session', () => ({
  accountStatus: { status: 'empty' },
  accountSession: {},
}))
jest.mock('../accounts/ceremony', () => ({ createAccountCeremony: jest.fn() }))
jest.mock('../stores/persistent-storage', () => ({
  usePersistentStorageStore: jest.fn(),
}))
jest.mock('./identity-session', () => ({ nameOwnProfile: jest.fn() }))
jest.mock('@frank/wallet/chain', () => ({ setCustomRelayBaseUrl: jest.fn() }))

import {
  handlePageSyncPairingRequest,
  pageSyncSender,
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
