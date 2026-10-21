/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://signet.mx/"}
 */
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import enUS from '../i18n/en-us'

const mockStatus = reactive({
  status: 'ready',
  revision: 1,
  account: { id: 'account-a' },
})
const mockBackup = jest.fn(async () => [
  'ms12frankshareone',
  'ms12franksharetwo',
  'unused-share',
])
let mockLeaveGuard: (() => Promise<boolean>) | null = null
jest.mock('vue-router', () => ({
  onBeforeRouteLeave: (guard: () => Promise<boolean>) => {
    mockLeaveGuard = guard
  },
}))
jest.mock('../accounts/session', () => ({
  accountStatus: mockStatus,
  accountSession: {
    backupCodex32: (...args: unknown[]) => mockBackup(...args),
  },
}))
jest.mock('../accounts/ceremony', () => ({ createAccountCeremony: jest.fn() }))
jest.mock('../stores/persistent-storage', () => ({
  usePersistentStorageStore: jest.fn(),
}))
jest.mock('../utils/identity-session', () => ({ nameOwnProfile: jest.fn() }))
jest.mock('../stores/my-profile', () => ({
  useProfileStore: () => ({ profile: { name: 'Ann' } }),
}))
jest.mock('../utils/own-address', () => ({
  getOwnCanonicalAddress: async () =>
    '0x1111111111111111111111111111111111111111',
}))
jest.mock('@frank/wallet/chain', () => ({ setCustomRelayBaseUrl: jest.fn() }))

import AccountSyncSend from './AccountSyncSend.vue'
import {
  cancelPageSyncSender,
  handlePageSyncPairingRequest,
  pageSyncSender,
} from '../utils/extension-account-sync'
import { receiveSyncBundle, SYNC_PAIRING_TTL_MS } from '../utils/sync-pairing'
import {
  createBackgroundBridgeState,
  handleBackgroundMessage,
} from '../../src-bex/background'

export function translate(key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>(
      (value, part) => (value as Record<string, unknown> | undefined)?.[part],
      enUS,
    )
  return typeof value === 'string' ? value : key
}
function renderSender() {
  return mount(AccountSyncSend, {
    global: {
      mocks: { $t: translate },
      stubs: {
        QPageContainer: { template: '<main><slot /></main>' },
        QPage: { template: '<section><slot /></section>' },
        QBtn: {
          props: ['disable', 'label'],
          template: '<button :disabled="disable"><slot />{{ label }}</button>',
        },
        QIcon: true,
      },
    },
  })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
let post: jest.SpyInstance
beforeEach(() => {
  document.documentElement.setAttribute('data-ext-mode', 'tab')
  mockLeaveGuard = null
  mockStatus.status = 'ready'
  mockStatus.revision = 1
  mockBackup
    .mockReset()
    .mockResolvedValue([
      'ms12frankshareone',
      'ms12franksharetwo',
      'unused-share',
    ])
  post = jest.spyOn(window, 'postMessage').mockImplementation()
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    value: jest.fn(() => 'b5d03eef-2efb-40d1-b91f-2768e5da988d'),
  })
})
afterEach(() => {
  cancelPageSyncSender()
  post.mockRestore()
  document.documentElement.removeAttribute('data-ext-mode')
  Reflect.deleteProperty(globalThis, 'chrome')
  jest.useRealTimers()
})
async function start() {
  const wrapper = renderSender()
  await wrapper.get('[data-test="sync-show-pin"]').trigger('click')
  await flushPromises()
  return wrapper
}
async function receive(pin: string) {
  return receiveSyncBundle(pin, async (type, payload) => {
    handlePageSyncPairingRequest({
      source: window,
      origin: window.location.origin,
      data: {
        channel: 'frank-pwa-extension-sync-v1',
        direction: 'to-pwa',
        type,
        payload,
        id: `pair-${type}`,
      },
    } as unknown as MessageEvent)
    return post.mock.calls.at(-1)?.[0].result
  })
}

describe('full-page account sender', () => {
  it('promotes the toolbar popup before any export; only the persistent tab can create a pairable PIN', async () => {
    document.documentElement.setAttribute('data-ext-mode', 'popup')
    const state = createBackgroundBridgeState()
    type Message = { type?: string; [key: string]: unknown }
    type Listener = (
      message: Message,
      sender: unknown,
      reply: (value: unknown) => void,
    ) => unknown
    const listeners: Listener[] = []
    const extensionSender = {
      id: 'frank-test-ext',
      url: 'chrome-extension://frank-test-ext/index.html?extMode=tab',
      frameId: 0,
    }
    const frankSender = {
      id: 'frank-test-ext',
      url: 'https://signet.mx/',
      origin: 'https://signet.mx',
      tab: { id: 2 },
      frameId: 0,
    }
    const tabs = {
      create: jest.fn(async (_options: { url: string }) => ({ id: 99 })),
    }
    const runtime = {
      id: 'frank-test-ext',
      getURL: (path: string) => `chrome-extension://frank-test-ext/${path}`,
      sendMessage: jest.fn(async (message: Message): Promise<unknown> => {
        if (message.type === 'sync-sender-update') {
          listeners.forEach(listener =>
            listener(message, extensionSender, jest.fn()),
          )
          return undefined
        }
        return handleBackgroundMessage(message, extensionSender, state, scope)
      }),
      onMessage: {
        addListener: (listener: Listener) => listeners.push(listener),
        removeListener: jest.fn(),
      },
    }
    const scope = { chrome: { runtime, tabs } }
    Object.assign(globalThis, scope)
    const close = jest
      .spyOn(window, 'close')
      .mockImplementation(() => undefined)
    const popup = renderSender()
    try {
      await flushPromises()
      expect(tabs.create).toHaveBeenCalledWith({
        url: 'chrome-extension://frank-test-ext/index.html?extMode=tab#/account-sync/send',
      })
      expect(close).toHaveBeenCalledTimes(1)
      expect(popup.find('[data-test="sync-show-pin"]').exists()).toBe(false)
      expect(mockBackup).not.toHaveBeenCalled()
      expect(state.syncPairing.sender).toBeNull()
      window.dispatchEvent(new Event('pagehide'))
      const hello = await handleBackgroundMessage(
        { channel: 'frank-pwa-extension-sync-v1', type: 'pair-hello' },
        frankSender,
        state,
        scope,
      )
      expect(hello.result).toEqual({ ok: false, reason: 'no-sender' })
    } finally {
      popup.unmount()
      close.mockRestore()
    }
    document.documentElement.setAttribute('data-ext-mode', 'tab')
    const persistent = renderSender()
    try {
      await flushPromises()
      expect(mockBackup).not.toHaveBeenCalled()
      expect(state.syncPairing.sender).toBeNull()
      await persistent.get('[data-test="sync-show-pin"]').trigger('click')
      await flushPromises()
      expect(mockBackup).toHaveBeenCalledTimes(1)
      const pin = persistent.get('[data-test="sync-sender-pin"]').text()
      const result = await receiveSyncBundle(pin, async (type, payload) => {
        const response = await handleBackgroundMessage(
          { channel: 'frank-pwa-extension-sync-v1', type, payload },
          frankSender,
          state,
          scope,
        )
        return response.result
      })
      expect(result.ok && result.bundle.backupShares).toEqual([
        'ms12frankshareone',
        'ms12franksharetwo',
      ])
      await flushPromises()
      expect(persistent.findAll('button').map(button => button.text())).toEqual(
        [enUS.accountSync.done],
      )
      expect(tabs.create).toHaveBeenCalledTimes(1)
    } finally {
      persistent.unmount()
    }
  })

  it('shows failed popup promotion with retry and usable back/cancel, without any PIN session', async () => {
    document.documentElement.setAttribute('data-ext-mode', 'popup')
    const create = jest.fn(async () => {
      throw new Error('Browser refused the tab')
    })
    Object.assign(globalThis, {
      chrome: {
        runtime: {
          id: 'extension',
          getURL: (path: string) => `chrome-extension://extension/${path}`,
        },
        tabs: { create },
      },
    })
    const wrapper = renderSender()
    try {
      await flushPromises()
      expect(wrapper.get('[role="alert"]').text()).toBe(
        enUS.accountSync.promotionFailed,
      )
      expect(wrapper.find('[data-test="sync-show-pin"]').exists()).toBe(false)
      expect(mockBackup).not.toHaveBeenCalled()
      expect(wrapper.find('[data-test="sync-back"]').exists()).toBe(true)
      expect(wrapper.find('[data-test="sync-cancel"]').exists()).toBe(true)
      expect(await mockLeaveGuard?.()).toBe(true)
      await wrapper.get('[data-test="sync-promotion-retry"]').trigger('click')
      await flushPromises()
      expect(create).toHaveBeenCalledTimes(2)
      expect(mockBackup).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })

  it.each(['tab', 'window', 'sidepanel', 'sidebar'])(
    'does not promote the persistent %s surface',
    async mode => {
      document.documentElement.setAttribute('data-ext-mode', mode)
      const create = jest.fn()
      Object.assign(globalThis, {
        chrome: { runtime: { id: 'extension' }, tabs: { create } },
      })
      const wrapper = renderSender()
      await flushPromises()
      expect(create).not.toHaveBeenCalled()
      expect(wrapper.find('[data-test="sync-show-pin"]').exists()).toBe(true)
      expect(mockBackup).not.toHaveBeenCalled()
      wrapper.unmount()
    },
  )

  it('opens without a dialog or account export until Show PIN is chosen', async () => {
    const wrapper = renderSender()
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(mockBackup).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
    await wrapper.get('[data-test="sync-show-pin"]').trigger('click')
    await flushPromises()
    expect(mockBackup).toHaveBeenCalledWith(2, 3)
    expect(wrapper.get('[data-test="sync-sender-pin"]').text()).toMatch(
      /^\d{6}$/,
    )
    wrapper.unmount()
  })
  it('transfers encrypted shares with the right PIN and finishes with only Done', async () => {
    const wrapper = await start()
    const pin = wrapper.get('[data-test="sync-sender-pin"]').text()
    const result = await receive(pin)
    expect(result.ok && result.bundle.backupShares).toEqual([
      'ms12frankshareone',
      'ms12franksharetwo',
    ])
    await flushPromises()
    expect(wrapper.text()).toContain(enUS.accountSync.sent)
    expect(wrapper.findAll('button').map(button => button.text())).toEqual([
      enUS.accountSync.done,
    ])
    expect(wrapper.find('[data-test="sync-show-pin"]').exists()).toBe(false)
    expect(JSON.stringify(post.mock.calls)).not.toContain('ms12frankshare')
    expect(JSON.stringify(post.mock.calls)).not.toContain(pin)
    wrapper.unmount()
  })
  it('rotates a wrong PIN without exposing shares, then completes the original pairing', async () => {
    const wrapper = await start()
    const pin = wrapper.get('[data-test="sync-sender-pin"]').text()
    expect(await receive(pin === '000000' ? '000001' : '000000')).toEqual({
      ok: false,
      reason: 'pin-mismatch',
    })
    await flushPromises()
    expect(wrapper.text()).toContain(enUS.accountSync.newPinAfterMismatch)
    expect(JSON.stringify(post.mock.calls)).not.toContain('ms12frankshare')
    expect(JSON.stringify(post.mock.calls)).not.toContain('ciphertext')
    expect(
      (await receive(wrapper.get('[data-test="sync-sender-pin"]').text())).ok,
    ).toBe(true)
    wrapper.unmount()
  })
  it('wipes the offer on route unmount so its previous PIN cannot pair', async () => {
    const wrapper = await start()
    const pin = wrapper.get('[data-test="sync-sender-pin"]').text()
    wrapper.unmount()
    expect(pageSyncSender.value).toBeNull()
    expect(post.mock.calls.at(-1)?.[0].type).toBe('pwa-sync-cancel')
    expect(await receive(pin)).toEqual({ ok: false, reason: 'no-sender' })
  })
  it('expires the PIN and allows only a new explicit Show PIN attempt', async () => {
    let expire: (() => void) | undefined
    const originalTimeout = globalThis.setTimeout
    const timer = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === SYNC_PAIRING_TTL_MS) expire = callback
      return originalTimeout(callback, delay, ...args)
    }) as typeof setTimeout)
    const wrapper = await start()
    const pin = wrapper.get('[data-test="sync-sender-pin"]').text()
    expect(expire).toBeDefined()
    expire?.()
    await flushPromises()
    timer.mockRestore()
    expect(wrapper.find('[data-test="sync-sender-pin"]').exists()).toBe(false)
    expect(wrapper.text()).toContain(enUS.accountSync.expired)
    expect(mockBackup).toHaveBeenCalledTimes(1)
    expect(await receive(pin)).toEqual({ ok: false, reason: 'no-sender' })
    wrapper.unmount()
  })
  it('does not publish an unseen offer when navigation happens during custody export', async () => {
    const backup = deferred<string[]>()
    mockBackup.mockReturnValueOnce(backup.promise)
    const wrapper = renderSender()
    await wrapper.get('[data-test="sync-show-pin"]').trigger('click')
    wrapper.unmount()
    backup.resolve(['ms12frankshareone', 'ms12franksharetwo'])
    await flushPromises()
    expect(post).not.toHaveBeenCalled()
    expect(pageSyncSender.value).toBeNull()
  })
  it('clears the PIN on session change and never exports the replacement account', async () => {
    const wrapper = await start()
    mockStatus.revision = 2
    await flushPromises()
    expect(pageSyncSender.value).toBeNull()
    expect(wrapper.find('[data-test="sync-sender-pin"]').exists()).toBe(false)
    await wrapper.get('[data-test="sync-show-pin"]').trigger('click')
    expect(mockBackup).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
  it('uses a request-owned extension offer, follows only its updates, and cancels that exact offer', async () => {
    const listeners: Array<
      (
        message: unknown,
        sender: unknown,
        respond: (value: unknown) => void,
      ) => unknown
    > = []
    let offerId = ''
    const sendMessage = jest.fn(
      async (message: {
        type: string
        payload: {
          offerId: string
          deviceSyncBundle?: { backupShares: string[] }
        }
      }) => {
        if (message.type === 'extension-sync-offer') {
          offerId = message.payload.offerId
          return { result: { ok: true, pin: '123456', offerId } }
        }
        return { result: { ok: true } }
      },
    )
    Object.assign(globalThis, {
      chrome: {
        runtime: {
          id: 'extension',
          sendMessage,
          onMessage: {
            addListener: (
              fn: (
                message: unknown,
                sender: unknown,
                respond: (value: unknown) => void,
              ) => unknown,
            ) => listeners.push(fn),
            removeListener: jest.fn(),
          },
        },
      },
    })
    const wrapper = await start()
    expect(offerId).toMatch(/^[\w-]+$/)
    const offer = sendMessage.mock.calls.find(
      call => call[0].type === 'extension-sync-offer',
    )?.[0]
    expect(offer?.payload.deviceSyncBundle?.backupShares).toEqual([
      'ms12frankshareone',
      'ms12franksharetwo',
    ])
    expect(post).not.toHaveBeenCalled()
    const update = async (data: object) => {
      listeners.forEach(fn =>
        fn(
          {
            channel: 'frank-pwa-extension-sync-v1',
            type: 'sync-sender-update',
            ...data,
          },
          {},
          jest.fn(),
        ),
      )
      await flushPromises()
    }
    await update({ offerId: 'different-operation', status: 'sent' })
    expect(wrapper.find('[data-test="sync-sender-pin"]').exists()).toBe(true)
    await update({ offerId, status: 'new-pin', pin: '654321' })
    expect(wrapper.get('[data-test="sync-sender-pin"]').text()).toBe('654321')
    await update({ offerId, status: 'sent' })
    expect(wrapper.findAll('button').map(button => button.text())).toEqual([
      enUS.accountSync.done,
    ])
    wrapper.unmount()
    await flushPromises()
    expect(
      sendMessage.mock.calls.filter(
        call => call[0].type === 'extension-sync-cancel',
      ),
    ).toHaveLength(0)
  })
  it('keeps the offer visible after failed cancellation and retries with the same token', async () => {
    let failCancellation = true
    const sendMessage = jest.fn(
      async (message: { type: string; payload: { offerId: string } }) => {
        if (message.type === 'extension-sync-offer')
          return {
            ok: true,
            result: {
              ok: true,
              pin: '123456',
              offerId: message.payload.offerId,
            },
          }
        if (failCancellation) throw new Error('Extension unavailable')
        return { ok: true, result: { ok: true } }
      },
    )
    Object.assign(globalThis, {
      chrome: {
        runtime: {
          id: 'extension',
          sendMessage,
          onMessage: { addListener: jest.fn(), removeListener: jest.fn() },
        },
      },
    })
    const wrapper = await start()
    expect(await mockLeaveGuard?.()).toBe(false)
    await flushPromises()
    expect(wrapper.get('[data-test="sync-sender-pin"]').text()).toBe('123456')
    expect(wrapper.get('[role="alert"]').text()).toBe(
      enUS.accountSync.cancelFailed,
    )
    const firstCancel = sendMessage.mock.calls.at(-1)?.[0]
    failCancellation = false
    expect(await mockLeaveGuard?.()).toBe(true)
    await flushPromises()
    expect(sendMessage.mock.calls.at(-1)?.[0]).toEqual(firstCancel)
    expect(wrapper.find('[data-test="sync-sender-pin"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('bounds a never-answering cancellation and keeps retry available', async () => {
    let respond = false
    const never = new Promise<null>(() => {
      /* Model an extension runtime that never replies. */
    })
    const sendMessage = jest.fn(
      async (message: { type: string; payload: { offerId: string } }) => {
        if (message.type === 'extension-sync-offer')
          return {
            ok: true,
            result: {
              ok: true,
              pin: '123456',
              offerId: message.payload.offerId,
            },
          }
        return respond ? { ok: true, result: { ok: true } } : never
      },
    )
    Object.assign(globalThis, {
      chrome: {
        runtime: {
          id: 'extension',
          sendMessage,
          onMessage: { addListener: jest.fn(), removeListener: jest.fn() },
        },
      },
    })
    const wrapper = await start()
    expect(await mockLeaveGuard?.()).toBe(false)
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe(
      enUS.accountSync.cancelFailed,
    )
    respond = true
    expect(await mockLeaveGuard?.()).toBe(true)
    wrapper.unmount()
  })

  it('cancels a late extension offer by its original token without publishing its PIN', async () => {
    const offer = deferred<{
      result: { ok: boolean; offerId: string; pin: string }
    }>()
    let offerId = ''
    const sendMessage = jest.fn(
      async (message: {
        type: string
        payload: {
          offerId: string
          deviceSyncBundle?: { backupShares: string[] }
        }
      }) => {
        if (message.type === 'extension-sync-offer') {
          offerId = message.payload.offerId
          return offer.promise
        }
        return { result: { ok: true } }
      },
    )
    Object.assign(globalThis, {
      chrome: {
        runtime: {
          id: 'extension',
          sendMessage,
          onMessage: { addListener: jest.fn(), removeListener: jest.fn() },
        },
      },
    })
    const wrapper = renderSender()
    await wrapper.get('[data-test="sync-show-pin"]').trigger('click')
    await flushPromises()
    wrapper.unmount()
    offer.resolve({ result: { ok: true, offerId, pin: '123456' } })
    await flushPromises()
    expect(sendMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'extension-sync-cancel',
      payload: { offerId },
    })
  })
})
