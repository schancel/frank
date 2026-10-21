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
  clearExtensionSyncOffer,
  offerExtensionSyncBundle,
  pendingExtensionSyncOffer,
  readExtensionSyncWindowMessage,
  syncTransferCheckCode,
} from './extension-account-sync'
import { FRANK_PWA_EXTENSION_SYNC_CHANNEL } from '../../src-bex/runtime-adapter'

const SHARES = ['ms12frankshareone', 'ms12franksharetwo']
const bundle = () => ({ displayName: 'Ann', backupShares: [...SHARES] })

function syncEvent(
  init: { source?: unknown; origin?: string },
  data: Record<string, unknown> = {},
): MessageEvent {
  return {
    source: 'source' in init ? init.source : window,
    origin: init.origin ?? window.location.origin,
    data: {
      channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
      direction: 'to-pwa',
      type: 'extension-sync-push',
      payload: { deviceSyncBundle: bundle() },
      ...data,
    },
  } as unknown as MessageEvent
}

describe('extension account sync in the web app (A1, A8)', () => {
  afterEach(() => clearExtensionSyncOffer())

  it('reads a sync bundle only from this window and this origin', () => {
    expect(readExtensionSyncWindowMessage(syncEvent({}))).toEqual(bundle())
    expect(
      readExtensionSyncWindowMessage(
        syncEvent(
          {},
          {
            type: 'sync-response',
            payload: undefined,
            result: { deviceSyncBundle: bundle() },
          },
        ),
      ),
    ).toEqual(bundle())

    // An opener, a frame, or another origin cannot plant an account.
    expect(readExtensionSyncWindowMessage(syncEvent({ source: {} }))).toBeNull()
    expect(
      readExtensionSyncWindowMessage(syncEvent({ source: null })),
    ).toBeNull()
    expect(
      readExtensionSyncWindowMessage(
        syncEvent({ origin: 'https://evil.example' }),
      ),
    ).toBeNull()
    expect(
      readExtensionSyncWindowMessage(
        syncEvent({}, { direction: 'to-extension' }),
      ),
    ).toBeNull()
  })

  it('holds an offered bundle in memory only, for the user to confirm', () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem')
    try {
      const offer = offerExtensionSyncBundle(bundle())
      expect(offer?.checkCode).toBe(syncTransferCheckCode(bundle()))
      expect(pendingExtensionSyncOffer.value).toEqual(offer)
      expect(setItem).not.toHaveBeenCalled()
      expect(
        JSON.stringify({ ...sessionStorage, ...localStorage }),
      ).not.toContain(SHARES[0])
    } finally {
      setItem.mockRestore()
    }
    clearExtensionSyncOffer()
    expect(pendingExtensionSyncOffer.value).toBeNull()
  })

  it('offers nothing for a bundle without two backup shares', () => {
    expect(offerExtensionSyncBundle({ backupShares: [SHARES[0]] })).toBeNull()
    expect(offerExtensionSyncBundle(null)).toBeNull()
    expect(pendingExtensionSyncOffer.value).toBeNull()
  })

  it('derives the check code from the shares that were sent', () => {
    const code = syncTransferCheckCode(bundle())
    expect(code).toMatch(/^\d{6}$/)
    expect(code).not.toBe('482910')
    expect(syncTransferCheckCode({ backupShares: [...SHARES] })).toBe(code)
    expect(
      syncTransferCheckCode({ backupShares: [SHARES[0], 'ms12attackershare'] }),
    ).not.toBe(code)
  })
})
