/** @jest-environment node */

/**
 * The toolbar click choice is the user's: it lives in storage.local, survives
 * a background restart or an extension update, is applied to the browser again
 * every time, and only the user's choice (set-launch-mode) ever writes it.
 */
import {
  FRANK_DAPP_BRIDGE_CHANNEL,
  FRANK_EXT_LAUNCH_MODE_KEY,
  openCompanionPanel,
  openExtensionInWindow,
} from './runtime-adapter'
import {
  createBackgroundBridgeState,
  handleToolbarClick,
  installBackgroundBridge,
} from './background'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

type Listener = (...args: any[]) => any

/** storage.local outlives the background; everything else is per start. */
function makeStorage() {
  const data: Record<string, unknown> = {}
  const set = jest.fn(async (items: Record<string, unknown>) => {
    Object.assign(data, items)
  })
  const get = jest.fn(async (keys: string[]) => {
    const out: Record<string, unknown> = {}
    for (const k of keys) if (k in data) out[k] = data[k]
    return out
  })
  return { data, set, get }
}

/** One background start: fresh browser toolbar state and event listeners. */
function startBrowser(storage: ReturnType<typeof makeStorage>) {
  const listeners: Record<string, Listener[]> = {}
  const event = (name: string) => ({
    addListener: (fn: Listener) => {
      ;(listeners[name] ??= []).push(fn)
    },
    removeListener: () => undefined,
  })
  const chrome = {
    runtime: {
      id: 'frank-ext',
      getURL: (p: string) => `chrome-extension://frank-ext/${p}`,
      onMessage: event('message'),
      onInstalled: event('installed'),
      onStartup: event('startup'),
    },
    action: {
      setPopup: jest.fn(async () => undefined),
      openPopup: jest.fn(async () => undefined),
      onClicked: event('clicked'),
    },
    sidePanel: {
      setPanelBehavior: jest.fn(async () => undefined),
      open: jest.fn(async () => undefined),
    },
    windows: { create: jest.fn(async () => ({ id: 9 })) },
    storage: { local: storage },
  }
  const scope = { chrome }
  const bg = installBackgroundBridge(scope, createBackgroundBridgeState())
  const send = (message: Record<string, unknown>) =>
    new Promise<any>(resolve => {
      const ret = listeners.message[0](
        { channel: FRANK_DAPP_BRIDGE_CHANNEL, ...message },
        {},
        resolve,
      )
      expect(ret).toBe(true)
    })
  const fire = (name: string, ...args: unknown[]) => {
    for (const fn of listeners[name] ?? []) fn(...args)
  }
  return { chrome, scope, bg, send, fire }
}

const settle = () => new Promise(r => setTimeout(r, 0))

describe('toolbar click choice', () => {
  it('survives a background restart and an update, and is applied again each time', async () => {
    const storage = makeStorage()
    const first = startBrowser(storage)
    const res = await first.send({
      type: 'set-launch-mode',
      launchMode: 'window',
    })
    expect(res.result).toEqual({ ok: true, launchMode: 'window' })
    expect(storage.data[FRANK_EXT_LAUNCH_MODE_KEY]).toBe('window')
    first.bg.dispose()

    // Restart (worker woken by the settings page asking): the answer is the
    // stored choice, not the default, even before the read has settled.
    const second = startBrowser(storage)
    const got = await second.send({ type: 'get-launch-mode' })
    expect(got.result.launchMode).toBe('window')
    // The browser forgot the popup override; it is cleared again so the click
    // reaches the background, and a click opens the pop-out window.
    expect(second.chrome.action.setPopup).toHaveBeenLastCalledWith({
      popup: '',
    })
    second.fire('clicked', { windowId: 3 })
    await settle()
    expect(second.chrome.windows.create).toHaveBeenCalledTimes(1)
    expect(second.chrome.action.openPopup).not.toHaveBeenCalled()

    // An update fires onInstalled: re-applied, the stored choice untouched.
    second.chrome.action.setPopup.mockClear()
    second.fire('installed', { reason: 'update' })
    await settle()
    expect(second.chrome.action.setPopup).toHaveBeenCalledWith({ popup: '' })
    second.fire('startup')
    await settle()
    expect(storage.set).toHaveBeenCalledTimes(1)
    expect(storage.data[FRANK_EXT_LAUNCH_MODE_KEY]).toBe('window')
  })

  it('restores the side panel without first switching it off', async () => {
    const storage = makeStorage()
    storage.data[FRANK_EXT_LAUNCH_MODE_KEY] = 'sidepanel'
    const b = startBrowser(storage)
    const got = await b.send({ type: 'get-launch-mode' })
    expect(got.result.launchMode).toBe('sidepanel')
    const calls = b.chrome.sidePanel.setPanelBehavior.mock.calls.map(
      (c: any[]) => c[0],
    )
    expect(calls).toEqual([{ openPanelOnActionClick: true }])
    expect(storage.set).not.toHaveBeenCalled()
  })

  it('applies the popup when nothing is stored, without writing a default', async () => {
    const storage = makeStorage()
    const b = startBrowser(storage)
    const got = await b.send({ type: 'get-launch-mode' })
    expect(got.result.launchMode).toBe('popup')
    expect(b.chrome.action.setPopup).toHaveBeenLastCalledWith({
      popup: 'index.html',
    })
    expect(b.chrome.sidePanel.setPanelBehavior).toHaveBeenLastCalledWith({
      openPanelOnActionClick: false,
    })
    expect(storage.set).not.toHaveBeenCalled()
  })

  it('rejects an unknown mode and keeps the stored choice', async () => {
    const storage = makeStorage()
    storage.data[FRANK_EXT_LAUNCH_MODE_KEY] = 'sidepanel'
    const b = startBrowser(storage)
    const res = await b.send({ type: 'set-launch-mode', launchMode: 'menu' })
    expect(res.ok).toBe(false)
    expect(storage.data[FRANK_EXT_LAUNCH_MODE_KEY]).toBe('sidepanel')
    const got = await b.send({ type: 'get-launch-mode' })
    expect(got.result.launchMode).toBe('sidepanel')
  })

  it('opening a window or the side panel does not change the choice', async () => {
    const storage = makeStorage()
    storage.data[FRANK_EXT_LAUNCH_MODE_KEY] = 'popup'
    const { scope, chrome } = startBrowser(storage)
    await settle()
    chrome.sidePanel.setPanelBehavior.mockClear()
    await openExtensionInWindow({}, scope)
    await openCompanionPanel({ windowId: 1 }, scope)
    expect(storage.set).not.toHaveBeenCalled()
    expect(chrome.sidePanel.setPanelBehavior).not.toHaveBeenCalled()
    expect(storage.data[FRANK_EXT_LAUNCH_MODE_KEY]).toBe('popup')
  })

  it('reports a failed save and keeps the previous choice', async () => {
    const storage = makeStorage()
    storage.data[FRANK_EXT_LAUNCH_MODE_KEY] = 'sidepanel'
    const b = startBrowser(storage)
    await settle()
    storage.set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'))
    const res = await b.send({ type: 'set-launch-mode', launchMode: 'window' })
    expect(res.ok).toBe(false)
    expect(res.error.message).toContain('quota')
    const got = await b.send({ type: 'get-launch-mode' })
    expect(got.result.launchMode).toBe('sidepanel')
  })

  it('keeps a saved choice when opening the view right away fails', async () => {
    const storage = makeStorage()
    const b = startBrowser(storage)
    await settle()
    b.chrome.windows.create.mockRejectedValueOnce(
      new Error('needs a user gesture'),
    )
    const res = await b.send({
      type: 'set-launch-mode',
      launchMode: 'window',
      openNow: true,
    })
    expect(res.ok).toBe(true)
    expect(res.result.launchMode).toBe('window')
    expect(res.result.openError).toContain('user gesture')
    expect(storage.data[FRANK_EXT_LAUNCH_MODE_KEY]).toBe('window')
    expect(b.chrome.action.setPopup).toHaveBeenLastCalledWith({ popup: '' })
    const got = await b.send({ type: 'get-launch-mode' })
    expect(got.result.launchMode).toBe('window')
  })

  it('opens the Firefox sidebar within the click, and a window if that fails', async () => {
    const toggle = jest.fn(async () => undefined)
    const create = jest.fn(async () => ({ id: 1 }))
    const scope = {
      browser: {
        runtime: { id: 'frank@signet.mx', getURL: (p: string) => p },
        sidebarAction: { toggle },
        windows: { create },
      },
    }
    const state = createBackgroundBridgeState({ launchMode: 'sidepanel' })
    const pending = handleToolbarClick({ windowId: 1 }, state, scope)
    // Synchronously, before any await, so the user gesture still holds.
    expect(toggle).toHaveBeenCalledTimes(1)
    await pending
    expect(create).not.toHaveBeenCalled()

    toggle.mockRejectedValueOnce(new Error('needs user input'))
    await handleToolbarClick({ windowId: 1 }, state, scope)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('only the Settings choice sends set-launch-mode', () => {
    // Opening a window or panel must never change what the toolbar opens.
    const appDir = path.resolve(__dirname, '..')
    const hits = execFileSync(
      'git',
      ['grep', '-l', "type: 'set-launch-mode'", '--', 'src', 'src-bex'],
      { cwd: appDir, encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(f => !/\.test\.ts$/.test(f))
    expect(hits).toEqual(['src/pages/Settings.vue'])
  })
})
