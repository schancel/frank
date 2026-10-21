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

import {
  FRANK_MAIN_WINDOW_ID_KEY,
  findMainExtensionWindow,
  focusOrOpenMainExtensionWindow,
  focusOwnExtensionView,
  hasOtherExtensionViews,
  openExtensionInWindow,
} from './runtime-adapter'
import {
  createBackgroundBridgeState,
  handleBackgroundMessage,
  openApprovalCompanionPopup,
} from './background'
import { FRANK_DAPP_BRIDGE_CHANNEL } from './inpage'

const BASE = 'chrome-extension://frank-ext/'

/** A browser with real window bookkeeping: windows exist until removed. */
function makeBrowser(options: { sessionStorage?: boolean } = {}) {
  const windows = new Map<number, { id: number; tabs: { url: string }[] }>()
  let nextId = 100
  const sessionData: Record<string, unknown> = {}
  const localData: Record<string, unknown> = {}
  const area = (data: Record<string, unknown>) => ({
    get: jest.fn(async (key: string) =>
      key in data ? { [key]: data[key] } : {},
    ),
    set: jest.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, items)
    }),
    remove: jest.fn(async (key: string) => {
      delete data[key]
    }),
  })
  const create = jest.fn(async ({ url }: { url: string }) => {
    const id = nextId++
    windows.set(id, { id, tabs: [{ url }] })
    return { id }
  })
  const update = jest.fn(async (id: number) => {
    if (!windows.has(id)) throw new Error(`No window with id: ${id}.`)
    return windows.get(id)
  })
  const get = jest.fn(async (id: number) => {
    const win = windows.get(id)
    if (!win) throw new Error(`No window with id: ${id}.`)
    return win
  })
  const openPopup = jest.fn(async () => undefined)
  const scope: Record<string, any> = {
    chrome: {
      runtime: { id: 'frank-ext', getURL: (p: string) => `${BASE}${p}` },
      windows: { create, update, get },
      action: { openPopup },
      storage: {
        ...(options.sessionStorage === false
          ? {}
          : { session: area(sessionData) }),
        local: area(localData),
      },
    },
  }
  return {
    scope,
    windows,
    create,
    update,
    openPopup,
    sessionData,
    localData,
    close: (id: number) => windows.delete(id),
  }
}

describe('one main pop-out window', () => {
  it('focuses the open pop-out instead of opening another', async () => {
    const b = makeBrowser()
    const first = await focusOrOpenMainExtensionWindow({}, b.scope)
    expect(first).toMatchObject({ opened: true, focused: false })
    expect(b.create).toHaveBeenCalledTimes(1)
    expect(b.sessionData[FRANK_MAIN_WINDOW_ID_KEY]).toBe(100)

    const second = await focusOrOpenMainExtensionWindow({}, b.scope)
    expect(second).toMatchObject({ opened: true, focused: true })
    expect(b.create).toHaveBeenCalledTimes(1)
    expect(b.update).toHaveBeenCalledWith(100, { focused: true })
    expect(b.windows.size).toBe(1)
  })

  it('opens one window for a double click', async () => {
    const b = makeBrowser()
    await Promise.all([
      focusOrOpenMainExtensionWindow({}, b.scope),
      focusOrOpenMainExtensionWindow({}, b.scope),
    ])
    expect(b.create).toHaveBeenCalledTimes(1)
  })

  it('still focuses the pop-out after the service worker restarts', async () => {
    const b = makeBrowser()
    await focusOrOpenMainExtensionWindow({}, b.scope)
    // A restarted worker loads fresh module state; only extension storage carries over.
    let restarted: typeof import('./runtime-adapter') | undefined
    jest.isolateModules(() => {
      restarted = require('./runtime-adapter')
    })
    const res = await restarted!.focusOrOpenMainExtensionWindow({}, b.scope)
    expect(res.focused).toBe(true)
    expect(b.create).toHaveBeenCalledTimes(1)

    // The background's own open path, with a fresh state, also focuses it.
    const viaBackground = await handleBackgroundMessage(
      { channel: FRANK_DAPP_BRIDGE_CHANNEL, type: 'open-extension-window' },
      {},
      createBackgroundBridgeState(),
      b.scope,
    )
    expect(viaBackground.ok).toBe(true)
    expect(b.create).toHaveBeenCalledTimes(1)
    expect(b.windows.size).toBe(1)
  })

  it('keeps the record in local storage where the browser has no session storage', async () => {
    const b = makeBrowser({ sessionStorage: false })
    await focusOrOpenMainExtensionWindow({}, b.scope)
    expect(b.localData[FRANK_MAIN_WINDOW_ID_KEY]).toBe(100)
    expect((await focusOrOpenMainExtensionWindow({}, b.scope)).focused).toBe(
      true,
    )
  })

  it('opens a new pop-out once the recorded one was closed', async () => {
    const b = makeBrowser()
    await focusOrOpenMainExtensionWindow({}, b.scope)
    b.close(100)
    expect(await findMainExtensionWindow(b.scope)).toBeNull()
    expect(b.sessionData[FRANK_MAIN_WINDOW_ID_KEY]).toBeUndefined()
    const res = await focusOrOpenMainExtensionWindow({}, b.scope)
    expect(res.focused).toBe(false)
    expect(b.create).toHaveBeenCalledTimes(2)
    expect(b.sessionData[FRANK_MAIN_WINDOW_ID_KEY]).toBe(101)
  })

  it('does not count a recorded window that no longer shows the main Frank page', async () => {
    const b = makeBrowser()
    await focusOrOpenMainExtensionWindow({}, b.scope)
    b.windows.get(100)!.tabs = [{ url: 'https://example.com/' }]
    expect(await findMainExtensionWindow(b.scope)).toBeNull()
  })

  it('does not count a dApp approval window as the main instance', async () => {
    const b = makeBrowser()
    await openExtensionInWindow(
      { path: 'index.html?extMode=window#/dapp-bridge' },
      b.scope,
    )
    expect(await findMainExtensionWindow(b.scope)).toBeNull()
    const res = await focusOrOpenMainExtensionWindow({}, b.scope)
    expect(res.focused).toBe(false)
    expect(b.create).toHaveBeenCalledTimes(2)
  })

  it('a dApp request raises the open pop-out instead of opening another view', async () => {
    const b = makeBrowser()
    await focusOrOpenMainExtensionWindow({}, b.scope)
    const res = await openApprovalCompanionPopup(
      {},
      b.scope,
      createBackgroundBridgeState(),
    )
    expect(res).toEqual({ opened: true, mode: 'window' })
    expect(b.openPopup).not.toHaveBeenCalled()
    expect(b.create).toHaveBeenCalledTimes(1)
  })

  it('switching the launch mode to window focuses the open pop-out', async () => {
    const b = makeBrowser()
    await focusOrOpenMainExtensionWindow({}, b.scope)
    await handleBackgroundMessage(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'set-launch-mode',
        launchMode: 'window',
        openNow: true,
      },
      {},
      createBackgroundBridgeState(),
      b.scope,
    )
    expect(b.update).toHaveBeenCalledTimes(1)
    expect(b.create).toHaveBeenCalledTimes(1)
  })
})

describe('raising an extension view', () => {
  it('raises the tab and window of a pop-out or extension tab', async () => {
    const tabsUpdate = jest.fn(async () => undefined)
    const windowsUpdate = jest.fn(async () => undefined)
    const scope = {
      chrome: {
        runtime: { id: 'frank-ext' },
        tabs: {
          getCurrent: async () => ({ id: 7, windowId: 3 }),
          update: tabsUpdate,
        },
        windows: { update: windowsUpdate },
      },
    }
    expect(await focusOwnExtensionView(scope)).toBe(true)
    expect(tabsUpdate).toHaveBeenCalledWith(7, { active: true })
    expect(windowsUpdate).toHaveBeenCalledWith(3, { focused: true })
  })

  it('raises the browser window hosting a side panel', async () => {
    const windowsUpdate = jest.fn(async () => undefined)
    const scope = {
      chrome: {
        runtime: { id: 'frank-ext' },
        tabs: { getCurrent: async () => undefined },
        windows: { update: windowsUpdate, getCurrent: async () => ({ id: 9 }) },
      },
    }
    expect(await focusOwnExtensionView(scope)).toBe(true)
    expect(windowsUpdate).toHaveBeenCalledWith(9, { focused: true })
  })

  it('reports failure outside an extension', async () => {
    expect(await focusOwnExtensionView({})).toBe(false)
  })

  it('tells whether another extension view is open', async () => {
    const withContexts = (n: number) => ({
      chrome: {
        runtime: {
          id: 'frank-ext',
          getContexts: async () => Array.from({ length: n }, () => ({})),
        },
      },
    })
    expect(await hasOtherExtensionViews(withContexts(1))).toBe(false)
    expect(await hasOtherExtensionViews(withContexts(2))).toBe(true)
    const self = {}
    expect(
      await hasOtherExtensionViews({
        window: self,
        chrome: {
          runtime: { id: 'frank-ext' },
          extension: { getViews: () => [self, {}] },
        },
      }),
    ).toBe(true)
    expect(await hasOtherExtensionViews({})).toBeNull()
  })
})
