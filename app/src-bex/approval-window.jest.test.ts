/** @jest-environment jsdom */

import { FRANK_DAPP_BRIDGE_CHANNEL, installInpageProvider } from './inpage'
import { installContentScriptBridge } from './content'
import {
  createBackgroundBridgeState,
  handleBackgroundMessage,
  installBackgroundBridge,
  type BackgroundBridgeState,
} from './background'
import { mountApprovalPage } from './approval'

const PRIMARY = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F'

/**
 * A fake extension API: one runtime message bus shared by the content script,
 * the background and the approval page, plus a windows API that records the
 * approval window's lifecycle.
 */
function createExtensionScope() {
  const listeners: Array<
    (msg: any, sender: any, sendResponse: (res: any) => void) => any
  > = []
  const removedListeners: Array<(windowId: number) => void> = []
  let nextWindowId = 100
  const openWindows = new Set<number>()
  const windows = {
    create: jest.fn(async (_opts: Record<string, unknown>) => {
      const id = nextWindowId++
      openWindows.add(id)
      return { id }
    }),
    update: jest.fn(async (id: number) => {
      if (!openWindows.has(id)) throw new Error(`No window with id: ${id}`)
      return { id }
    }),
    remove: jest.fn(async (id: number) => {
      openWindows.delete(id)
      for (const fn of removedListeners) fn(id)
    }),
    onRemoved: {
      addListener: (fn: (windowId: number) => void) =>
        removedListeners.push(fn),
    },
  }
  const scope = {
    chrome: {
      runtime: {
        id: 'frank-test-ext',
        getURL: (p: string) => `chrome-extension://frank-test-ext/${p}`,
        sendMessage: (msg: any, cb?: (res: any) => void) => {
          let answered = false
          for (const fn of [...listeners]) {
            const keepOpen = fn(msg, { tab: { id: 1, windowId: 2 } }, res => {
              if (answered) return
              answered = true
              cb?.(res)
            })
            void keepOpen
          }
        },
        onMessage: {
          addListener: (fn: any) => listeners.push(fn),
          removeListener: (fn: any) => {
            const idx = listeners.indexOf(fn)
            if (idx >= 0) listeners.splice(idx, 1)
          },
        },
      },
      windows,
    },
  }
  /** The user closes the window with the browser's close button. */
  const userCloses = (id: number) => {
    openWindows.delete(id)
    for (const fn of removedListeners) fn(id)
  }
  return { scope, windows, openWindows, userCloses }
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

function rpc(
  state: BackgroundBridgeState,
  scope: Record<string, any>,
  id: string,
  method: string,
  origin = 'https://app.uniswap.org',
  params?: unknown,
) {
  return handleBackgroundMessage(
    {
      channel: FRANK_DAPP_BRIDGE_CHANNEL,
      type: 'dapp-rpc-request',
      id,
      origin,
      payload: { method, params },
    },
    { tab: { id: 7, windowId: 3 } },
    state,
    scope,
  )
}

function decide(
  state: BackgroundBridgeState,
  scope: Record<string, any>,
  approvalId: string,
  approved: boolean,
  extra: Record<string, unknown> = {},
) {
  return handleBackgroundMessage(
    {
      channel: FRANK_DAPP_BRIDGE_CHANNEL,
      type: 'resolve-approval',
      approvalId,
      approved,
      ...extra,
    },
    {},
    state,
    scope,
  )
}

describe('dApp approval window lifecycle', () => {
  it('opens one focused popup window, resolves the dApp on approve with the per-site persona, then closes it', async () => {
    const { scope, windows, openWindows } = createExtensionScope()
    const state = createBackgroundBridgeState({ activePersonaAddress: PRIMARY })

    const pending = rpc(
      state,
      scope,
      'r1',
      'wallet_requestPermissions',
      undefined,
      [{ eth_accounts: {} }],
    )
    await tick()
    expect(windows.create).toHaveBeenCalledTimes(1)
    expect(windows.create).toHaveBeenCalledWith({
      url: 'chrome-extension://frank-test-ext/approval.html',
      type: 'popup',
      width: 400,
      height: 620,
      focused: true,
    })
    const burner = state.pendingApprovals.get('r1')!.suggestedBurnerAddress!
    expect(burner).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(burner).not.toBe(PRIMARY)

    await decide(state, scope, 'r1', true, { useBurnerPersona: true })
    const res = await pending
    expect(res).toEqual({
      ok: true,
      result: [
        {
          invoker: 'https://app.uniswap.org',
          parentCapability: 'eth_accounts',
          caveats: [{ type: 'restrictReturnedAccounts', value: [burner] }],
        },
      ],
    })
    await tick()
    expect(windows.remove).toHaveBeenCalledWith(100)
    expect(openWindows.size).toBe(0)

    // The site now gets its persona without another prompt.
    expect(await rpc(state, scope, 'r2', 'eth_requestAccounts')).toEqual({
      ok: true,
      result: [burner],
    })
    expect(windows.create).toHaveBeenCalledTimes(1)
  })

  it('answers 4001 when the user rejects', async () => {
    const { scope, windows } = createExtensionScope()
    const state = createBackgroundBridgeState({ activePersonaAddress: PRIMARY })
    const pending = rpc(state, scope, 'r1', 'eth_requestAccounts')
    await tick()
    await decide(state, scope, 'r1', false)
    expect(await pending).toEqual({
      ok: false,
      error: { code: 4001, message: 'User rejected the request.' },
    })
    await tick()
    expect(windows.remove).toHaveBeenCalledWith(100)
    expect(state.approvedOrigins.has('https://app.uniswap.org')).toBe(false)
  })

  it('rejects every waiting request with 4001 when the user closes the window', async () => {
    const { scope, windows, userCloses } = createExtensionScope()
    const state = createBackgroundBridgeState({ activePersonaAddress: PRIMARY })
    const first = rpc(state, scope, 'r1', 'eth_requestAccounts')
    const second = rpc(
      state,
      scope,
      'r2',
      'personal_sign',
      'https://other.example',
      ['0x68656c6c6f', PRIMARY],
    )
    await tick()
    expect(state.pendingApprovals.size).toBe(2)

    userCloses(100)
    const rejected = {
      ok: false,
      error: { code: 4001, message: 'User rejected the request.' },
    }
    expect(await first).toEqual(rejected)
    expect(await second).toEqual(rejected)
    expect(state.pendingApprovals.size).toBe(0)
    expect(state.pendingRpcWaiters.size).toBe(0)
    expect(windows.remove).not.toHaveBeenCalled()

    // A later request opens a fresh window.
    void rpc(state, scope, 'r3', 'eth_requestAccounts')
    await tick()
    expect(windows.create).toHaveBeenCalledTimes(2)
  })

  it('queues requests in one shared window and keeps it open until the last is answered', async () => {
    const { scope, windows } = createExtensionScope()
    const state = createBackgroundBridgeState({ activePersonaAddress: PRIMARY })
    const a = rpc(state, scope, 'a', 'eth_requestAccounts', 'https://a.example')
    const b = rpc(state, scope, 'b', 'eth_requestAccounts', 'https://b.example')
    await tick()
    const c = rpc(state, scope, 'c', 'eth_requestAccounts', 'https://c.example')
    await tick()
    expect(windows.create).toHaveBeenCalledTimes(1)
    // A request arriving later focuses the open window instead of opening one.
    expect(windows.update).toHaveBeenCalledWith(100, { focused: true })

    await decide(state, scope, 'a', true)
    await decide(state, scope, 'b', false)
    await tick()
    expect(windows.remove).not.toHaveBeenCalled()
    await decide(state, scope, 'c', true, { useBurnerPersona: false })
    await tick()
    expect(windows.remove).toHaveBeenCalledWith(100)

    expect((await a).ok).toBe(true)
    expect((await b).error.code).toBe(4001)
    expect(await c).toEqual({ ok: true, result: [PRIMARY] })
  })
})

describe('approval window page', () => {
  it('shows the request with its site and persona choice, and Connect resolves the dApp with the chosen persona', async () => {
    const { scope, windows } = createExtensionScope()
    const state = createBackgroundBridgeState({ activePersonaAddress: PRIMARY })
    const bg = installBackgroundBridge(scope, state)

    const pending = rpc(state, scope, 'r1', 'eth_requestAccounts')
    await tick()
    expect(windows.create).toHaveBeenCalledTimes(1)

    const root = document.createElement('main')
    document.body.append(root)
    const closeWindow = jest.fn()
    const page = mountApprovalPage(root, { globalScope: scope, closeWindow })
    await tick(5)

    expect(root.textContent).toContain('app.uniswap.org')
    expect(root.textContent).toContain('Connect to this site')
    const burner = state.pendingApprovals.get('r1')!.suggestedBurnerAddress!
    expect(root.textContent).toContain(burner)
    expect(root.textContent).toContain(PRIMARY)

    const primary = root.querySelector<HTMLInputElement>(
      '[data-testid="approval-persona-primary"]',
    )!
    primary.checked = true
    primary.dispatchEvent(new Event('change'))
    root
      .querySelector<HTMLButtonElement>('[data-testid="approval-approve"]')!
      .click()

    expect(await pending).toEqual({ ok: true, result: [PRIMARY] })
    await tick(5)
    expect(closeWindow).toHaveBeenCalled()
    page.dispose()
    bg.dispose()
    root.remove()
  })

  it('offers no approval for signing and rejects it with 4001', async () => {
    const { scope } = createExtensionScope()
    const state = createBackgroundBridgeState({ activePersonaAddress: PRIMARY })
    const bg = installBackgroundBridge(scope, state)
    const pending = rpc(state, scope, 's1', 'personal_sign', undefined, [
      '0x68656c6c6f',
      PRIMARY,
    ])
    await tick()

    const root = document.createElement('main')
    const page = mountApprovalPage(root, {
      globalScope: scope,
      closeWindow: () => undefined,
    })
    await tick(5)
    expect(root.textContent).toContain('Sign a message')
    expect(root.querySelector('[data-testid="approval-approve"]')).toBeNull()

    root
      .querySelector<HTMLButtonElement>('[data-testid="approval-reject"]')!
      .click()
    expect((await pending).error.code).toBe(4001)
    page.dispose()
    bg.dispose()
  })

  it('renders site-supplied text as text, never markup', async () => {
    const { scope } = createExtensionScope()
    const state = createBackgroundBridgeState({ activePersonaAddress: PRIMARY })
    const bg = installBackgroundBridge(scope, state)
    void rpc(state, scope, 'x1', 'personal_sign', 'https://evil.example', [
      '<img src=x onerror=alert(1)>',
    ])
    await tick()
    const root = document.createElement('main')
    const page = mountApprovalPage(root, {
      globalScope: scope,
      closeWindow: () => undefined,
    })
    await tick(5)
    expect(root.querySelector('img')).toBeNull()
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>')
    page.dispose()
    bg.dispose()
  })
})

describe('dApp provider end to end (inpage -> content -> background -> approval window)', () => {
  it('eth_requestAccounts resolves with the per-site persona once the user approves in the window', async () => {
    const { scope, windows } = createExtensionScope()
    const state = createBackgroundBridgeState({ activePersonaAddress: PRIMARY })
    const bg = installBackgroundBridge(scope, state)
    const cleanupContent = installContentScriptBridge(window as any, scope)
    const provider = installInpageProvider(window as any)!

    const accounts = provider.request<string[]>({
      method: 'eth_requestAccounts',
    })
    await tick(10)
    expect(windows.create).toHaveBeenCalledTimes(1)

    const root = document.createElement('main')
    const page = mountApprovalPage(root, {
      globalScope: scope,
      closeWindow: () => undefined,
    })
    await tick(5)
    const burner = Array.from(state.pendingApprovals.values())[0]!
      .suggestedBurnerAddress!
    root
      .querySelector<HTMLButtonElement>('[data-testid="approval-approve"]')!
      .click()

    expect(await accounts).toEqual([burner])
    expect(await provider.request({ method: 'eth_accounts' })).toEqual([burner])
    page.dispose()
    cleanupContent()
    bg.dispose()
  })

  it('does not register a Solana wallet, which Frank cannot back with a Solana account', async () => {
    const registered: unknown[] = []
    window.addEventListener('wallet-standard:register-wallet', event => {
      registered.push((event as CustomEvent).detail)
    })
    const win = window as any
    delete win.__FRANK_INPAGE_PROVIDER_INSTALLED__
    delete win.frankEthereum
    installInpageProvider(win)
    expect(registered).toEqual([])
    expect(win.frankSolana).toBeUndefined()

    const { scope } = createExtensionScope()
    const state = createBackgroundBridgeState({ activePersonaAddress: PRIMARY })
    state.approvedOrigins.add('https://app.uniswap.org')
    // Even for a connected site, Solana methods are unsupported, never an EVM
    // address dressed up as a Solana key.
    expect(await rpc(state, scope, 's', 'solana_connect')).toEqual({
      ok: false,
      error: { code: 4200, message: 'Unsupported method: solana_connect' },
    })
  })
})
