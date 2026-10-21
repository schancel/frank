/** @jest-environment jsdom */

jest.mock('../src/accounts/session', () => ({
  accountStatus: { status: 'fresh', account: null, pending: null },
  accountSession: {},
}))
jest.mock('../src/accounts/ceremony', () => ({
  createAccountCeremony: jest.fn(),
}))
jest.mock('../src/stores/persistent-storage', () => ({
  usePersistentStorageStore: jest.fn(),
}))
jest.mock('../src/utils/identity-session', () => ({
  nameOwnProfile: jest.fn(),
}))
jest.mock('@frank/wallet/chain', () => ({ setCustomRelayBaseUrl: jest.fn() }))

import { FRANK_PWA_EXTENSION_SYNC_CHANNEL } from './runtime-adapter'
import { installContentScriptBridge } from './content'
import {
  createBackgroundBridgeState,
  handleBackgroundMessage,
  installBackgroundBridge,
} from './background'
import {
  cancelPageSyncSender,
  handlePageSyncPairingRequest,
  pageSyncSender,
  receiveAccountOverBridge,
  startPageSyncSender,
} from '../src/utils/extension-account-sync'
import {
  receiveSyncBundle,
  SYNC_PAIRING_TTL_MS,
  type SyncPairingSend,
} from '../src/utils/sync-pairing'

/**
 * Account sync between the extension and the Frank web app, wired end to end:
 * the extension background, the content script in a Frank tab, and the page.
 * Everything posted on the page window is recorded: any script in that window
 * (another extension's content script, say) sees exactly that.
 */

const SHARES = ['ms12frankshareone', 'ms12franksharetwo']
const bundle = () => ({
  version: 1,
  displayName: 'Ann',
  backupShares: [...SHARES],
})

const EXT_PAGE = {
  id: 'frank-test-ext',
  url: 'chrome-extension://frank-test-ext/index.html?extMode=popup',
}
const FRANK_TAB = {
  id: 'frank-test-ext',
  url: 'https://signet.mx/#/welcome',
  origin: 'https://signet.mx',
  tab: { id: 2 },
}
const OTHER_TAB = {
  id: 'frank-test-ext',
  url: 'https://evil.example/',
  origin: 'https://evil.example',
  tab: { id: 1 },
}
const LOCALHOST_TAB = {
  id: 'frank-test-ext',
  url: 'http://localhost:9000/',
  origin: 'http://localhost:9000',
  tab: { id: 3 },
}

function harness(options: { session?: boolean } = {}) {
  const state = createBackgroundBridgeState()
  const localSet = jest.fn()
  const held: Record<string, any> = {}
  const session = options.session
    ? {
        get: jest.fn(async (key: string) => ({ [key]: held[key] })),
        set: jest.fn(async (items: Record<string, unknown>) => {
          Object.assign(held, JSON.parse(JSON.stringify(items)))
        }),
        remove: jest.fn(async (key: string) => {
          delete held[key]
        }),
        setAccessLevel: jest.fn(async () => undefined),
      }
    : undefined
  // Background -> extension pages (runtime.sendMessage never reaches content scripts).
  const toExtensionPages = jest.fn(async () => undefined)
  // Background -> Frank tab's content script.
  const toTab = jest.fn(async (tabId: number, message: any, _options?: any) =>
    tabId === 2 ? deliverToContentScript(message) : undefined,
  )
  const tabUrls: Record<number, string> = { 2: 'https://signet.mx/#/profile' }
  const alarms: Array<(alarm: { name: string }) => void> = []
  const alarmsCreate = jest.fn()
  const bgScope = {
    chrome: {
      runtime: {
        id: 'frank-test-ext',
        getURL: (p: string) => `chrome-extension://frank-test-ext/${p}`,
        sendMessage: toExtensionPages,
      },
      storage: { local: { set: localSet }, ...(session ? { session } : {}) },
      tabs: {
        sendMessage: toTab,
        get: jest.fn(async (tabId: number) => ({
          id: tabId,
          url: tabUrls[tabId],
        })),
      },
      alarms: {
        create: alarmsCreate,
        onAlarm: { addListener: (fn: any) => alarms.push(fn) },
      },
    },
  }
  const fireAlarms = async () => {
    for (const [name] of alarmsCreate.mock.calls) {
      for (const fn of alarms) fn({ name })
    }
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  // The Frank web app window.
  const onWindow: Array<(event: any) => unknown> = []
  const pageWire: unknown[] = []
  const win: any = {
    location: {
      origin: 'https://signet.mx',
      protocol: 'https:',
      hostname: 'signet.mx',
      href: 'https://signet.mx/',
    },
    addEventListener: (type: string, fn: any) => {
      if (type === 'message') onWindow.push(fn)
    },
    removeEventListener: (type: string, fn: any) => {
      const i = onWindow.indexOf(fn)
      if (type === 'message' && i >= 0) onWindow.splice(i, 1)
    },
    dispatchEvent: jest.fn(),
    postMessage: (data: unknown) => {
      pageWire.push(data)
      const event = { source: win, origin: 'https://signet.mx', data }
      queueMicrotask(() => {
        for (const fn of [...onWindow]) void fn(event)
      })
    },
  }
  // The page's own listener (AppRuntime) answering for its sending session.
  onWindow.push(event => handlePageSyncPairingRequest(event, win))

  // The content script, sending to the background as the Frank tab.
  const contentListeners: Array<(m: any, s: any, r: any) => any> = []
  const toBackground = jest.fn(async (message: any) =>
    handleBackgroundMessage(message, FRANK_TAB, state, bgScope),
  )
  installContentScriptBridge(win, {
    chrome: {
      runtime: {
        id: 'frank-test-ext',
        getURL: (p: string) => `chrome-extension://frank-test-ext/${p}`,
        sendMessage: toBackground,
        onMessage: {
          addListener: (fn: any) => contentListeners.push(fn),
          removeListener: jest.fn(),
        },
      },
    },
  })
  function deliverToContentScript(message: any) {
    return new Promise(resolve => {
      const async = contentListeners[0](message, {}, resolve)
      if (async !== true) resolve(undefined)
    })
  }

  /** An extension page's pairing messages, through the background. */
  const fromExtensionPage: SyncPairingSend = async (type, payload) =>
    (
      await handleBackgroundMessage(
        { channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL, type, payload },
        EXT_PAGE,
        state,
        bgScope,
      )
    )?.result

  /** Everything that crossed a channel a web page or another script can see. */
  const observable = () =>
    JSON.stringify([pageWire, toTab.mock.calls, toBackground.mock.calls])

  return {
    state,
    tabUrls,
    fireAlarms,
    alarmsCreate,
    bgScope,
    session,
    held,
    localSet,
    toExtensionPages,
    toTab,
    win,
    fromExtensionPage,
    observable,
  }
}

describe('extension -> web app account sync by PIN pairing', () => {
  async function offer(h: ReturnType<typeof harness>) {
    // The extension page hands its bundle to its own background (not a web channel).
    const res = await handleBackgroundMessage(
      {
        channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
        type: 'extension-sync-offer',
        payload: { deviceSyncBundle: bundle(), offerId: 'offer-a' },
      },
      EXT_PAGE,
      h.state,
      h.bgScope,
    )
    expect(res.result.pin).toMatch(/^\d{6}$/)
    return res.result.pin as string
  }

  it('restores the account in the web app with the right PIN, and never shows the shares or PIN to the page window', async () => {
    const h = harness()
    const pin = await offer(h)

    const received = await receiveAccountOverBridge(pin, h.win)
    expect(received).toEqual({ ok: true, bundle: bundle() })

    expect(h.observable()).not.toContain(SHARES[0])
    expect(h.observable()).not.toContain(pin)
    expect(h.localSet).not.toHaveBeenCalled()
    expect(h.toExtensionPages).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sync-sender-update', status: 'sent' }),
    )
    // Take-once: the session is gone.
    expect(h.state.syncPairing.sender).toBeNull()
    expect(await receiveAccountOverBridge(pin, h.win)).toEqual({
      ok: false,
      reason: 'no-sender',
    })
  })

  it('sends no share material at all for a wrong PIN, and shows the extension a new PIN', async () => {
    const h = harness()
    const pin = await offer(h)
    const wrong = pin === '000000' ? '000001' : '000000'

    expect(await receiveAccountOverBridge(wrong, h.win)).toEqual({
      ok: false,
      reason: 'pin-mismatch',
    })
    expect(h.observable()).not.toContain(SHARES[0])
    expect(h.observable()).not.toContain('ciphertext')

    const update = (h.toExtensionPages.mock.calls as any[]).at(-1)[0]
    expect(update).toMatchObject({
      type: 'sync-sender-update',
      status: 'new-pin',
    })
    expect(update.pin).toMatch(/^\d{6}$/)
    expect(await receiveAccountOverBridge(update.pin, h.win)).toEqual({
      ok: true,
      bundle: bundle(),
    })
  })

  it('refuses an expired session, wiping it first', async () => {
    const h = harness()
    const pin = await offer(h)
    h.state.syncPairing.sender!.createdAt -= SYNC_PAIRING_TTL_MS + 1
    expect(await receiveAccountOverBridge(pin, h.win)).toEqual({
      ok: false,
      reason: 'no-sender',
    })
    expect(h.state.syncPairing.sender).toBeNull()
    expect(h.toExtensionPages).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'sync-sender-update',
        status: 'expired',
      }),
    )
    expect(h.observable()).not.toContain('ciphertext')
  })

  it('wipes an abandoned session from storage.session at expiry, with no further message', async () => {
    const h = harness({ session: true })
    installBackgroundBridge(h.bgScope, h.state).dispose()
    await offer(h)
    expect(h.alarmsCreate).toHaveBeenCalledWith(
      'frank-sync-pairing-expiry',
      expect.objectContaining({ when: expect.any(Number) }),
    )
    expect(h.held.frankSyncPairing.sender).toBeTruthy()
    h.held.frankSyncPairing.sender.createdAt -= SYNC_PAIRING_TTL_MS + 1
    await h.fireAlarms()
    expect(h.held).toEqual({})
  })

  it('wipes an expired session when the background starts again', async () => {
    const h = harness({ session: true })
    await offer(h)
    h.held.frankSyncPairing.sender.createdAt -= SYNC_PAIRING_TTL_MS + 1
    installBackgroundBridge(h.bgScope, createBackgroundBridgeState()).dispose()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.held).toEqual({})
  })

  it('Cancel ends the session at once and wipes it', async () => {
    const h = harness({ session: true })
    const pin = await offer(h)
    const cancel = (sender: unknown) =>
      handleBackgroundMessage(
        {
          channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
          type: 'extension-sync-cancel',
          payload: { offerId: 'offer-a' },
        },
        sender,
        h.state,
        h.bgScope,
      )
    expect((await cancel(FRANK_TAB)).ok).toBe(false)
    expect(h.held.frankSyncPairing.sender).toBeTruthy()
    expect((await cancel(EXT_PAGE)).ok).toBe(true)
    expect(h.held).toEqual({})
    expect(await receiveAccountOverBridge(pin, h.win)).toEqual({
      ok: false,
      reason: 'no-sender',
    })
  })

  it('tells a reopened extension page the current PIN after a wrong one', async () => {
    const h = harness()
    const pin = await offer(h)
    await receiveAccountOverBridge(
      pin === '000000' ? '000001' : '000000',
      h.win,
    )
    const status = await handleBackgroundMessage(
      {
        channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
        type: 'extension-sync-status',
      },
      EXT_PAGE,
      h.state,
      h.bgScope,
    )
    expect(status.result).toMatchObject({ ok: true, status: 'new-pin' })
    expect(status.result.pin).toBe(h.state.syncPairing.sender!.pin)
    expect(status.result.pin).not.toBe(pin)
    // A web page cannot read it.
    const fromTab = await handleBackgroundMessage(
      {
        channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
        type: 'extension-sync-status',
      },
      FRANK_TAB,
      h.state,
      h.bgScope,
    )
    expect(JSON.stringify(fromTab)).not.toContain(status.result.pin)
  })

  it('lets only one of two concurrent confirms through the background queue', async () => {
    const h = harness()
    const pin = await offer(h)
    const replies: any[] = []
    const send: SyncPairingSend = async (type, payload) => {
      const call = () =>
        handleBackgroundMessage(
          { channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL, type, payload },
          FRANK_TAB,
          h.state,
          h.bgScope,
        ).then(res => res?.result)
      if (type === 'pair-hello') return call()
      const both = await Promise.all([call(), call()])
      replies.push(...both)
      return both[0]
    }
    expect((await receiveSyncBundle(pin, send)).ok).toBe(true)
    expect(replies.filter(r => r?.ok === true)).toHaveLength(1)
    expect(replies.filter(r => r?.ok === false)).toEqual([
      { ok: false, reason: 'no-sender' },
    ])
  })

  it('a status query racing a successful confirm never writes the consumed sender back', async () => {
    const h = harness({ session: true })
    const pin = await offer(h)
    let status: Promise<any> | undefined
    const send: SyncPairingSend = async (type, payload) => {
      const call = () =>
        handleBackgroundMessage(
          { channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL, type, payload },
          FRANK_TAB,
          h.state,
          h.bgScope,
        ).then(res => res?.result)
      if (type === 'pair-hello') return call()
      // A stale offer is also held, so reading the pairing has something to prune.
      h.held.frankSyncPairing.offerTab = {
        tabId: 2,
        createdAt: Date.now() - SYNC_PAIRING_TTL_MS - 1,
      }
      // The reopened popup asks for the status just as the confirm arrives,
      // and its storage read is slow: it sees the sender, then lags behind.
      const get = h.session!.get.getMockImplementation()!
      let statusRead!: () => void
      const statusReading = new Promise<void>(resolve => (statusRead = resolve))
      h.session!.get.mockImplementationOnce(async (key: string) => {
        const seen = JSON.parse(JSON.stringify(await get(key)))
        statusRead()
        await new Promise(resolve => setTimeout(resolve, 50))
        return seen
      })
      status = handleBackgroundMessage(
        {
          channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
          type: 'extension-sync-status',
        },
        EXT_PAGE,
        h.state,
        h.bgScope,
      )
      // The confirm arrives once the status read is under way; a background
      // that serialises reads with confirms makes it wait its turn.
      await Promise.race([
        statusReading,
        new Promise(resolve => setTimeout(resolve, 100)),
      ])
      return call()
    }
    expect((await receiveSyncBundle(pin, send)).ok).toBe(true)
    await status
    // Take-once holds: neither the bundle nor the PIN is back in storage.session.
    expect(h.held).toEqual({})
    expect(JSON.stringify(h.held)).not.toContain(SHARES[0])
  })

  it('answers pairing messages only from the Frank web app or an extension page', async () => {
    const h = harness()
    await offer(h)
    for (const sender of [
      OTHER_TAB,
      LOCALHOST_TAB,
      { url: 'https://signet.mx.evil/' },
    ]) {
      for (const type of ['pair-hello', 'pair-confirm', 'pwa-sync-offer']) {
        const res = await handleBackgroundMessage(
          { channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL, type },
          sender,
          h.state,
          {},
        )
        expect(res.ok).toBe(false)
      }
    }
    // A web page cannot make the background hold an account.
    const planted = await handleBackgroundMessage(
      {
        channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
        type: 'extension-sync-offer',
        payload: { deviceSyncBundle: bundle(), offerId: 'offer-a' },
      },
      FRANK_TAB,
      h.state,
      {},
    )
    expect(planted.ok).toBe(false)
  })

  it('holds the session in storage.session only, so it outlives the service worker and never reaches storage.local', async () => {
    const h = harness({ session: true })
    installBackgroundBridge(h.bgScope, createBackgroundBridgeState()).dispose()
    expect(h.session!.setAccessLevel).toHaveBeenCalledWith({
      accessLevel: 'TRUSTED_CONTEXTS',
    })
    const pin = await offer(h)
    expect(h.state.syncPairing.sender).toBeNull()
    expect(h.held.frankSyncPairing.sender.pin).toBe(pin)
    expect(h.held.frankSyncPairing.senderOfferId).toBe('offer-a')

    // The service worker restarted: fresh background state, same session storage.
    const after = createBackgroundBridgeState()
    const status = await handleBackgroundMessage(
      {
        channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
        type: 'extension-sync-status',
      },
      EXT_PAGE,
      after,
      h.bgScope,
    )
    expect(status.result.offerId).toBe('offer-a')
    const send: SyncPairingSend = async (type, payload) =>
      (
        await handleBackgroundMessage(
          { channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL, type, payload },
          FRANK_TAB,
          after,
          h.bgScope,
        )
      )?.result
    expect(await receiveSyncBundle(pin, send)).toEqual({
      ok: true,
      bundle: bundle(),
    })
    expect(h.held).toEqual({})
    expect(h.localSet).not.toHaveBeenCalled()
  })
})

describe('web app -> extension account sync by PIN pairing', () => {
  afterEach(() => {
    pageSyncSender.value = null
  })

  it('restores the account in the extension with the right PIN; the page offers it without sending any secret', async () => {
    const h = harness()
    const view = startPageSyncSender(bundle(), h.win)
    await new Promise(resolve => setTimeout(resolve, 0))
    // The offer told the background which tab to pair with, and nothing else.
    expect(h.state.syncPairing.offerTab?.tabId).toBe(2)
    expect(h.observable()).not.toContain(SHARES[0])

    const received = await receiveSyncBundle(view.pin, h.fromExtensionPage)
    expect(received).toEqual({ ok: true, bundle: bundle() })
    expect(pageSyncSender.value?.status).toBe('sent')
    expect(h.observable()).not.toContain(SHARES[0])
    expect(h.observable()).not.toContain(view.pin)

    // Take-once.
    expect(await receiveSyncBundle(view.pin, h.fromExtensionPage)).toEqual({
      ok: false,
      reason: 'no-sender',
    })
  })

  it('sends no share material at all for a wrong PIN, and the page shows a new PIN', async () => {
    const h = harness()
    const view = startPageSyncSender(bundle(), h.win)
    await new Promise(resolve => setTimeout(resolve, 0))
    const wrong = view.pin === '000000' ? '000001' : '000000'

    expect(await receiveSyncBundle(wrong, h.fromExtensionPage)).toEqual({
      ok: false,
      reason: 'pin-mismatch',
    })
    expect(h.observable()).not.toContain(SHARES[0])
    expect(h.observable()).not.toContain('ciphertext')
    expect(pageSyncSender.value?.status).toBe('new-pin')
    expect(pageSyncSender.value?.pin).toMatch(/^\d{6}$/)

    expect(
      await receiveSyncBundle(pageSyncSender.value!.pin, h.fromExtensionPage),
    ).toEqual({ ok: true, bundle: bundle() })
  })

  it('refuses an expired offer', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    })
    try {
      const h = harness()
      const view = startPageSyncSender(bundle(), h.win)
      jest.advanceTimersByTime(SYNC_PAIRING_TTL_MS + 1)
      expect(pageSyncSender.value?.status).toBe('expired')
      const result = await receiveSyncBundle(view.pin, h.fromExtensionPage)
      expect(result.ok).toBe(false)
      expect(h.observable()).not.toContain('ciphertext')
    } finally {
      jest.useRealTimers()
    }
  })

  it('relays only to the top frame of the offering tab, and only while it is still on the Frank origin', async () => {
    const h = harness()
    const view = startPageSyncSender(bundle(), h.win)
    await new Promise(resolve => setTimeout(resolve, 0))
    await receiveSyncBundle(view.pin, h.fromExtensionPage)
    for (const call of h.toTab.mock.calls)
      expect(call[2]).toEqual({ frameId: 0 })

    const again = startPageSyncSender(bundle(), h.win)
    await new Promise(resolve => setTimeout(resolve, 0))
    h.toTab.mockClear()
    // The tab navigated away after offering.
    h.tabUrls[2] = 'https://evil.example/'
    expect(await receiveSyncBundle(again.pin, h.fromExtensionPage)).toEqual({
      ok: false,
      reason: 'no-sender',
    })
    expect(h.toTab).not.toHaveBeenCalled()
  })

  it('Cancel in the web app wipes its session and withdraws the offer', async () => {
    const h = harness()
    const view = startPageSyncSender(bundle(), h.win)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.state.syncPairing.offerTab).not.toBeNull()
    cancelPageSyncSender(h.win)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(pageSyncSender.value).toBeNull()
    expect(h.state.syncPairing.offerTab).toBeNull()
    expect(await receiveSyncBundle(view.pin, h.fromExtensionPage)).toEqual({
      ok: false,
      reason: 'no-sender',
    })
  })

  it('has nothing to relay when no Frank tab offered an account', async () => {
    const h = harness()
    expect(await receiveSyncBundle('123456', h.fromExtensionPage)).toEqual({
      ok: false,
      reason: 'no-sender',
    })
    expect(h.toTab).not.toHaveBeenCalled()
  })
})

describe('content script relays account sync only on the Frank origin', () => {
  it('neither forwards pairing messages nor relays them into pages of other origins', async () => {
    for (const origin of ['http://localhost:9000', 'https://evil.example']) {
      let onMessage: ((event: any) => Promise<void>) | undefined
      const listeners: any[] = []
      const url = new URL(origin)
      const win: any = {
        location: {
          origin,
          protocol: url.protocol,
          hostname: url.hostname,
          href: `${origin}/`,
        },
        addEventListener: (type: string, fn: any) => {
          if (type === 'message') onMessage = fn
        },
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
        postMessage: jest.fn(),
      }
      const sendMessage = jest.fn()
      const cleanup = installContentScriptBridge(win, {
        chrome: {
          runtime: {
            id: 'frank-test-ext',
            getURL: (p: string) => `chrome-extension://frank-test-ext/${p}`,
            sendMessage,
            onMessage: {
              addListener: (fn: any) => listeners.push(fn),
              removeListener: jest.fn(),
            },
          },
        },
      })
      win.postMessage.mockClear()
      sendMessage.mockClear()
      for (const type of ['pair-hello', 'pair-confirm', 'pwa-sync-offer']) {
        await onMessage!({
          source: win,
          origin,
          data: {
            channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
            direction: 'to-extension',
            type,
            id: 'x',
          },
        })
      }
      expect(sendMessage).not.toHaveBeenCalled()
      for (const fn of listeners) {
        expect(
          fn(
            { channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL, type: 'pair-hello' },
            {},
            jest.fn(),
          ),
        ).not.toBe(true)
      }
      expect(win.postMessage).not.toHaveBeenCalled()
      cleanup()
    }
  })
})
