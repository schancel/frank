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

import { FRANK_PWA_EXTENSION_SYNC_CHANNEL as channel } from './runtime-adapter'
import {
  createBackgroundBridgeState,
  handleBackgroundMessage,
} from './background'
import { installContentScriptBridge } from './content'

const extensionSender = {
  id: 'frank-test-ext',
  url: 'chrome-extension://frank-test-ext/index.html?extMode=popup',
  frameId: 0,
}

test('a trusted extension view requests navigation only in an existing exact-origin top frame', async () => {
  const sendMessage = jest.fn(async () => ({ ok: true }))
  const scope = {
    chrome: {
      runtime: {
        id: 'frank-test-ext',
        getURL: (path: string) => 'chrome-extension://frank-test-ext/' + path,
      },
      tabs: {
        query: jest.fn(async () => [
          { id: 2, url: 'https://signet.mx/#/welcome' },
        ]),
        get: jest.fn(async () => ({
          id: 2,
          url: 'https://signet.mx/#/welcome',
        })),
        sendMessage,
      },
    },
  }
  const result = await handleBackgroundMessage(
    { channel, type: 'request-sync-sender' },
    extensionSender,
    createBackgroundBridgeState(),
    scope,
  )
  expect(result).toEqual({ ok: true, result: { ok: true } })
  expect(sendMessage).toHaveBeenCalledWith(
    2,
    { channel, type: 'open-sync-sender', id: expect.any(String) },
    { frameId: 0 },
  )
})

function backgroundHarness() {
  const state = createBackgroundBridgeState()
  const tabs = {
    query: jest.fn(async () => [
      { id: 2, url: 'https://signet.mx/#/welcome', active: true },
    ]),
    get: jest.fn(async (_id: number) => ({
      id: 2,
      url: 'https://signet.mx/#/welcome',
    })),
    sendMessage: jest.fn(
      async (
        _id: number,
        _message: unknown,
        _options: unknown,
      ): Promise<unknown> => ({ ok: true }),
    ),
    create: jest.fn(),
    update: jest.fn(),
  }
  const scope = {
    chrome: {
      runtime: {
        id: 'frank-test-ext',
        getURL: (path: string) => 'chrome-extension://frank-test-ext/' + path,
      },
      tabs,
    },
  }
  const request = (sender: unknown = extensionSender, extra = {}) =>
    handleBackgroundMessage(
      { channel, type: 'request-sync-sender', ...extra },
      sender,
      state,
      scope,
    )
  return { state, tabs, scope, request }
}

// The app test bootstrap installs the `promise` polyfill, whose scheduler is not driven
// by Jest's modern fake timers. Exercise this browser bridge with the platform Promise.
const testPromise = global.Promise
const browserPromise = (async () => undefined)()
  .constructor as PromiseConstructor
beforeEach(() => {
  global.Promise = browserPromise
})
afterEach(() => {
  jest.useRealTimers()
  global.Promise = testPromise
})

test.each([
  { id: 'foreign', url: extensionSender.url, frameId: 0 },
  { ...extensionSender, url: 'chrome-extension://foreign/index.html' },
  { ...extensionSender, frameId: 2 },
  { ...extensionSender, url: 'https://signet.mx/', tab: { id: 2 } },
  { ...extensionSender, url: 'chrome-extension://frank-test-ext/content.js' },
])('rejects a caller outside the trusted extension UI: %j', async sender => {
  const h = backgroundHarness()
  expect((await h.request(sender)).ok).toBe(false)
  expect(h.tabs.query).not.toHaveBeenCalled()
})

test('navigation never forwards arbitrary routes or export payloads and creates no pairing offer', async () => {
  const h = backgroundHarness()
  expect(
    (
      await h.request(extensionSender, {
        payload: { route: '/backup', export: true },
      })
    ).ok,
  ).toBe(false)
  expect(h.tabs.sendMessage).not.toHaveBeenCalled()
  expect(await h.request()).toEqual({ ok: true, result: { ok: true } })
  const message = h.tabs.sendMessage.mock.calls[0]![1]
  expect(Object.keys(message as object).sort()).toEqual([
    'channel',
    'id',
    'type',
  ])
  expect(h.state.syncPairing).toEqual({
    sender: null,
    senderOfferId: null,
    offerTab: null,
  })
  expect(h.tabs.create).not.toHaveBeenCalled()
  expect(h.tabs.update).not.toHaveBeenCalled()
})

test('validates tab URLs again and skips foreign or navigated results', async () => {
  const h = backgroundHarness()
  h.tabs.query.mockResolvedValue([
    { id: 2, url: 'https://signet.mx/', active: true },
    { id: 3, url: 'https://signet.mx.evil/', active: false },
  ])
  h.tabs.get.mockResolvedValue({ id: 2, url: 'https://evil.example/' })
  expect((await h.request()).result.ok).toBe(false)
  expect(h.tabs.sendMessage).not.toHaveBeenCalled()
  expect(h.tabs.get).toHaveBeenCalledTimes(1)
})

test('uses an existing ready tab after an unready one, without opening or focusing tabs', async () => {
  const h = backgroundHarness()
  h.tabs.query.mockResolvedValue([
    { id: 2, url: 'https://signet.mx/', active: true },
    { id: 3, url: 'https://signet.mx/#/forum', active: false },
  ])
  h.tabs.get.mockImplementation(async id => ({ id, url: 'https://signet.mx/' }))
  h.tabs.sendMessage
    .mockResolvedValueOnce({ ok: false, reason: 'not-ready' })
    .mockResolvedValueOnce({ ok: true, pin: 'never forward' })
  expect(await h.request()).toEqual({ ok: true, result: { ok: true } })
  expect(h.tabs.sendMessage.mock.calls.map(call => call[0])).toEqual([2, 3])
  for (const call of h.tabs.sendMessage.mock.calls)
    expect(call[2]).toEqual({ frameId: 0 })
  expect(h.tabs.create).not.toHaveBeenCalled()
  expect(h.tabs.update).not.toHaveBeenCalled()
})

test('coalesces repeated clicks and briefly reuses successful navigation', async () => {
  const h = backgroundHarness()
  expect(await Promise.all([h.request(), h.request(), h.request()])).toEqual(
    Array(3).fill({ ok: true, result: { ok: true } }),
  )
  await h.request()
  expect(h.tabs.query).toHaveBeenCalledTimes(1)
  expect(h.tabs.sendMessage).toHaveBeenCalledTimes(1)
})

test('times out a stalled browser API and prevents a late query from triggering navigation', async () => {
  jest.useFakeTimers()
  const h = backgroundHarness()
  let release!: (tabs: Awaited<ReturnType<typeof h.tabs.query>>) => void
  h.tabs.query.mockImplementation(
    () =>
      new Promise(resolve => {
        release = resolve
      }),
  )
  const result = h.request()
  await jest.advanceTimersByTimeAsync(5_000)
  expect(await result).toEqual({
    ok: true,
    result: { ok: false, reason: 'timeout' },
  })
  release([{ id: 2, url: 'https://signet.mx/', active: true }])
  await Promise.resolve()
  expect(h.tabs.sendMessage).not.toHaveBeenCalled()
})

function contentHarness() {
  const listeners = new Set<(event: MessageEvent) => void>()
  let runtimeListener: (
    message: unknown,
    sender: unknown,
    reply: (result: unknown) => void,
  ) => boolean
  const win = {
    location: {
      origin: 'https://signet.mx',
      href: 'https://signet.mx/#/forum',
    },
    top: undefined as unknown,
    addEventListener: (
      _type: string,
      listener: (event: MessageEvent) => void,
    ) => listeners.add(listener),
    removeEventListener: (
      _type: string,
      listener: (event: MessageEvent) => void,
    ) => listeners.delete(listener),
    postMessage: jest.fn(),
  }
  win.top = win
  const cleanup = installContentScriptBridge(
    win as unknown as Window & Record<string, unknown>,
    {
      chrome: {
        runtime: {
          id: 'frank-test-ext',
          getURL: (path: string) => 'chrome-extension://frank-test-ext/' + path,
          sendMessage: jest.fn(async () => undefined),
          onMessage: {
            addListener: (listener: typeof runtimeListener) => {
              runtimeListener = listener
            },
            removeListener: jest.fn(),
          },
        },
      },
    },
  )
  const message = { channel, type: 'open-sync-sender', id: 'navigation-1' }
  const deliver = (
    payload: unknown = message,
    sender: unknown = { id: 'frank-test-ext' },
  ) =>
    new Promise(resolve => {
      const held = runtimeListener(payload, sender, resolve)
      if (held !== true) resolve(undefined)
    })
  const reply = (
    data: unknown,
    source: unknown = win,
    origin = win.location.origin,
  ) => {
    for (const listener of listeners)
      listener({ data, source, origin } as MessageEvent)
  }
  return { win, cleanup, message, deliver, reply }
}

test('content forwards only the fixed navigation event and accepts a correlated own-window reply', async () => {
  const h = contentHarness()
  const result = h.deliver()
  expect(h.win.postMessage).toHaveBeenCalledWith(
    { ...h.message, direction: 'to-pwa' },
    'https://signet.mx',
  )
  h.reply({
    channel,
    direction: 'to-extension',
    type: 'sync-navigation-reply',
    id: h.message.id,
    result: { ok: true, backupShares: ['never forward'], pin: 'never forward' },
  })
  expect(await result).toEqual({ ok: true })
  h.cleanup()
})

test('content ignores spoofed replies, wrong IDs and pairing replies and finishes with a bounded timeout', async () => {
  jest.useFakeTimers()
  const h = contentHarness()
  const result = h.deliver()
  const reply = {
    channel,
    direction: 'to-extension',
    type: 'sync-navigation-reply',
    id: h.message.id,
    result: { ok: true },
  }
  h.reply(reply, {}, 'https://signet.mx')
  h.reply(reply, h.win, 'https://evil.example')
  h.reply({ ...reply, id: 'wrong-id' })
  h.reply({ ...reply, type: 'pair-reply' })
  h.reply({ ...reply, result: { ok: 'true' } })
  await jest.advanceTimersByTimeAsync(5_000)
  expect(await result).toEqual({ ok: false, reason: 'timeout' })
  h.cleanup()
})

test('content rejects foreign senders, web senders, subframes, wrong origins and payload-bearing navigation', async () => {
  const h = contentHarness()
  for (const sender of [
    { id: 'foreign' },
    { id: 'frank-test-ext', tab: { id: 2 } },
  ]) {
    expect(await h.deliver(h.message, sender)).toEqual({
      ok: false,
      reason: 'unavailable',
    })
  }
  expect(await h.deliver({ ...h.message, payload: { export: true } })).toEqual({
    ok: false,
    reason: 'unavailable',
  })
  h.win.top = {}
  expect(await h.deliver()).toEqual({ ok: false, reason: 'unavailable' })
  h.win.top = h.win
  h.win.location.origin = 'https://signet.mx.evil'
  expect(await h.deliver()).toEqual({ ok: false, reason: 'unavailable' })
  expect(h.win.postMessage).not.toHaveBeenCalled()
  h.cleanup()
})

test('repeated delivery of one navigation ID posts once and cleanup settles pending replies', async () => {
  const h = contentHarness()
  const first = h.deliver()
  const duplicate = h.deliver()
  expect(h.win.postMessage).toHaveBeenCalledTimes(1)
  h.cleanup()
  expect(await first).toEqual({ ok: false, reason: 'unavailable' })
  expect(await duplicate).toEqual({ ok: false, reason: 'unavailable' })
})

test('a late cancellation cannot wipe the extension sender belonging to a newer offer', async () => {
  const h = backgroundHarness()
  const command = (type: string, payload?: unknown) =>
    handleBackgroundMessage(
      { channel, type, payload },
      extensionSender,
      h.state,
      h.scope,
    )
  const bundle = {
    version: 1,
    displayName: 'Test',
    backupShares: ['test-share-one', 'test-share-two'],
  }
  const first = await command('extension-sync-offer', {
    offerId: 'offer-a',
    deviceSyncBundle: bundle,
  })
  expect(first.result.offerId).toBe('offer-a')
  const next = await command('extension-sync-offer', {
    offerId: 'offer-b',
    deviceSyncBundle: bundle,
  })
  expect(next.result.offerId).toBe('offer-b')
  expect(
    (await command('extension-sync-cancel', { offerId: 'offer-a' })).result,
  ).toEqual({ ok: false, offerId: 'offer-a' })
  expect(h.state.syncPairing.senderOfferId).toBe('offer-b')
  expect((await command('extension-sync-status')).result).toMatchObject({
    ok: true,
    offerId: 'offer-b',
    pin: next.result.pin,
  })
  expect((await command('extension-sync-cancel')).ok).toBe(false)
  expect(h.state.syncPairing.senderOfferId).toBe('offer-b')
  expect(
    (await command('extension-sync-cancel', { offerId: 'offer-b' })).result,
  ).toEqual({ ok: true, offerId: 'offer-b' })
  expect(h.state.syncPairing.sender).toBeNull()
})

test('sender expiry updates identify the precise expired offer', async () => {
  const h = backgroundHarness()
  const updates = jest.fn(async () => undefined)
  Object.assign(h.scope.chrome.runtime, { sendMessage: updates })
  await handleBackgroundMessage(
    {
      channel,
      type: 'extension-sync-offer',
      payload: {
        offerId: 'offer-expiring',
        deviceSyncBundle: {
          version: 1,
          backupShares: ['test-one', 'test-two'],
        },
      },
    },
    extensionSender,
    h.state,
    h.scope,
  )
  h.state.syncPairing.sender!.createdAt = 0
  await handleBackgroundMessage(
    { channel, type: 'extension-sync-status' },
    extensionSender,
    h.state,
    h.scope,
  )
  expect(updates).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'sync-sender-update',
      status: 'expired',
      offerId: 'offer-expiring',
    }),
  )
  expect(h.state.syncPairing.senderOfferId).toBeNull()
})

test('the existing-tab navigation round trip crosses background, content and page reply without creating account sync state', async () => {
  const background = backgroundHarness()
  const content = contentHarness()
  background.tabs.sendMessage.mockImplementation((_id, message) =>
    content.deliver(message),
  )
  const result = background.request()
  for (let turn = 0; turn < 6; turn++) await Promise.resolve()
  expect(content.win.postMessage).toHaveBeenCalledTimes(1)
  const forwarded = content.win.postMessage.mock.calls[0]![0]
  expect(forwarded).toEqual({
    channel,
    type: 'open-sync-sender',
    direction: 'to-pwa',
    id: expect.any(String),
  })
  content.reply({
    channel,
    direction: 'to-extension',
    type: 'sync-navigation-reply',
    id: forwarded.id,
    result: { ok: true },
  })
  expect(await result).toEqual({ ok: true, result: { ok: true } })
  expect(background.state.syncPairing).toEqual({
    sender: null,
    senderOfferId: null,
    offerTab: null,
  })
  content.cleanup()
})
