/** @jest-environment jsdom */

import { FRANK_DAPP_BRIDGE_CHANNEL, installInpageProvider } from './inpage'
import { installContentScriptBridge } from './content'
import {
  MessageV0,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from '@solana/web3.js'
import { ed25519 } from '@noble/curves/ed25519'
import {
  DAPP_PERSONA_NOT_READY_ERROR,
  createBackgroundBridgeState,
  handleBackgroundMessage,
  installBackgroundBridge,
  type BackgroundBridgeState,
} from './background'

/** Approval decisions and persona provisioning come from extension pages; other messages from a site tab. */
function mockSenderFor(msg: any): Record<string, unknown> {
  return String(msg?.type).includes('resolve-approval') ||
    msg?.type === 'provision-site-personas' ||
    msg?.type === 'update-persona-state' ||
    msg?.type === 'set-active-persona'
    ? { url: 'chrome-extension://frank-test-ext/approval.html' }
    : { tab: { id: 1, windowId: 2 } }
}
import { mountApprovalPage } from './approval'
import { FRANK_DAPP_PROVISION_SITE_PERSONAS } from './runtime-adapter'

// Custody-derived addresses Frank provides; the extension never derives personas itself.
const PRIMARY = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const SITE = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359'

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
          let pending = false
          for (const fn of [...listeners]) {
            const keepOpen = fn(msg, mockSenderFor(msg), res => {
              if (answered) return
              answered = true
              cb?.(res)
            })
            if (keepOpen) pending = true
          }
          if (!answered && !pending) cb?.(null)
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
    { url: 'chrome-extension://frank-test-ext/approval.html' },
    state,
    scope,
  )
}

/** What an open Frank view does on approvals-changed: provide the site's persona address. */
function provideSitePersona(
  state: BackgroundBridgeState,
  scope: Record<string, any>,
  origin = 'https://app.uniswap.org',
  address = SITE,
) {
  return handleBackgroundMessage(
    {
      channel: FRANK_DAPP_BRIDGE_CHANNEL,
      type: FRANK_DAPP_PROVISION_SITE_PERSONAS,
      sitePersonas: { [origin]: address },
    },
    { url: 'chrome-extension://frank-test-ext/index.html' },
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
    // No site persona until Frank's custody provides one: approving fails explicitly and
    // the request stays queued.
    expect(
      state.pendingApprovals.get('r1')!.suggestedBurnerAddress,
    ).toBeUndefined()
    expect(
      await decide(state, scope, 'r1', true, { useBurnerPersona: true }),
    ).toEqual({ ok: false, error: { ...DAPP_PERSONA_NOT_READY_ERROR } })
    expect(state.pendingApprovals.has('r1')).toBe(true)

    await provideSitePersona(state, scope)
    const burner = state.pendingApprovals.get('r1')!.suggestedBurnerAddress!
    expect(burner).toBe(SITE)

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

  it('ignores a decision that does not come from an extension page', async () => {
    const { scope } = createExtensionScope()
    const state = createBackgroundBridgeState({ activePersonaAddress: PRIMARY })
    const pending = rpc(state, scope, 'r1', 'eth_requestAccounts')
    await tick()
    for (const sender of [
      { tab: { id: 7, windowId: 3 }, url: 'https://app.uniswap.org/' },
      { url: 'https://evil.example/approval.html' },
      {},
    ]) {
      const res = await handleBackgroundMessage(
        {
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          type: 'resolve-approval',
          approvalId: 'r1',
          approved: true,
        },
        sender,
        state,
        scope,
      )
      expect(res).toMatchObject({ ok: false, error: { code: 4100 } })
    }
    // The request still waits for the user.
    expect(state.pendingApprovals.has('r1')).toBe(true)
    expect(state.approvedOrigins.has('https://app.uniswap.org')).toBe(false)
    await decide(state, scope, 'r1', false)
    await pending
  })

  it.each([
    ['personal_sign', ['0x68656c6c6f', PRIMARY]],
    ['eth_signTypedData_v4', [PRIMARY, '{}']],
    ['eth_sendTransaction', [{ from: PRIMARY, to: PRIMARY, value: '0x1' }]],
  ])(
    'returns an explicit unavailable-session error for approved %s instead of caller-supplied fake output',
    async (method, params) => {
      const { scope } = createExtensionScope()
      const state = createBackgroundBridgeState({
        activePersonaAddress: PRIMARY,
        approvedOrigins: new Set(['https://app.uniswap.org']),
      })
      const pending = rpc(
        state,
        scope,
        'r1',
        method,
        'https://app.uniswap.org',
        params,
      )
      await tick()
      const res = await decide(state, scope, 'r1', true, {
        result: '0xdeadbeef',
        signature: '0xdeadbeef',
        txHash: '0xdeadbeef',
      })
      expect(res).toMatchObject({ ok: false, error: { code: 4900 } })
      const answer = await pending
      expect(answer.ok).toBe(false)
      expect(answer.error.code).toBe(4900)
      expect(JSON.stringify(answer)).not.toContain('deadbeef')
    },
  )

  it.each([
    'btc_requestAccounts',
    'btc_getAccounts',
    'btc_getPublicKey',
    'btc_getNetwork',
    'btc_signMessage',
    'btc_signPsbt',
    'btc_signPsbts',
    'xec_cashtabRequest',
  ])(
    'answers %s as unsupported: Frank has no Bitcoin or eCash account for dApps',
    async method => {
      const { scope, windows } = createExtensionScope()
      const state = createBackgroundBridgeState({
        activePersonaAddress: PRIMARY,
        approvedOrigins: new Set(['https://app.uniswap.org']),
      })
      expect(await rpc(state, scope, 'b1', method, undefined, [{}])).toEqual({
        ok: false,
        error: { code: 4200, message: `Unsupported method: ${method}` },
      })
      expect(state.pendingApprovals.size).toBe(0)
      expect(windows.create).not.toHaveBeenCalled()
    },
  )

  it('returns only a custody-backed Solana account after explicit approval', async () => {
    const { scope } = createExtensionScope()
    const publicKey = new Uint8Array(32).fill(7)
    const address = new PublicKey(publicKey).toBase58()
    scope.chrome.runtime.onMessage.addListener(
      (message: any, _sender: any, respond: (value: unknown) => void) => {
        if (message.type === 'preview-dapp-account') {
          respond({ ok: true, account: { address } })
          return
        }
        if (message.type === 'execute-approved-dapp-request') {
          respond({
            ok: true,
            result: { address, publicKey: Array.from(publicKey) },
          })
        }
      },
    )
    const state = createBackgroundBridgeState()
    const pending = rpc(state, scope, 'solana-connect', 'solana_connect')
    await tick()
    expect(
      (
        await rpc(
          state,
          scope,
          'solana-sign-blocked',
          'solana_signMessage',
          undefined,
          {
            message: [1, 2, 3],
            account: address,
          },
        )
      ).error.code,
    ).toBe(4100)
    expect(
      state.pendingApprovals.get('solana-connect')?.solanaAccountAddress,
    ).toBe(address)
    const result = await decide(state, scope, 'solana-connect', true)
    expect(result.ok).toBe(true)
    expect(await pending).toMatchObject({
      result: { address, publicKey: Array.from(publicKey) },
    })
    expect(
      (await rpc(state, scope, 'evm-accounts', 'eth_accounts')).result,
    ).toEqual([])
  })

  it('rejects every waiting request with 4001 when the user closes the window', async () => {
    const { scope, windows, userCloses } = createExtensionScope()
    const state = createBackgroundBridgeState({ activePersonaAddress: PRIMARY })
    state.approvedOrigins.add('https://other.example')
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

    await provideSitePersona(state, scope, 'https://a.example')
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
  it.each(['eth_requestAccounts', 'wallet_requestPermissions'])(
    'opens Frank with actionable signed-out error for %s without queuing or approving the site',
    async method => {
      const { scope, windows } = createExtensionScope()
      const state = createBackgroundBridgeState()
      const [response] = await Promise.all([
        rpc(state, scope, 'signed-out', method),
        rpc(state, scope, 'signed-out-again', method),
      ])
      expect(windows.create).toHaveBeenCalledTimes(1)
      expect(response.ok).toBe(false)
      expect(response.error.code).toBe(4900)
      expect(response.error.message).toContain('Sync or unlock Frank first')
      expect(response.error.message).toContain(
        'PWA login does not unlock the extension',
      )
      expect(windows.create).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'chrome-extension://frank-test-ext/approval.html?notice=account-required',
        }),
      )
      expect(state.pendingApprovals.size).toBe(0)
      expect(state.originPersonas['https://app.uniswap.org']).toBeUndefined()
    },
  )

  it('tells the signed-out site to use the toolbar when Frank cannot open', async () => {
    const { scope, windows } = createExtensionScope()
    windows.create.mockRejectedValueOnce(new Error('Safari refused the window'))
    const state = createBackgroundBridgeState()
    const response = await rpc(
      state,
      scope,
      'signed-out-refused',
      'eth_requestAccounts',
    )
    expect(response.error.message).toContain('open it from the browser toolbar')
    expect(state.pendingApprovals.size).toBe(0)
  })

  it('shows the signed-out notice visibly with Open Frank and never fetches or approves a request', async () => {
    window.history.replaceState({}, '', '/?notice=account-required')
    const { scope, windows } = createExtensionScope()
    const state = createBackgroundBridgeState()
    const bg = installBackgroundBridge(scope, state)
    const root = document.createElement('main')
    const closeWindow = jest.fn()
    const page = mountApprovalPage(root, { globalScope: scope, closeWindow })
    expect(root.textContent).toContain('Sync or unlock Frank first')
    expect(root.textContent).toContain('then retry connecting from the website')
    expect(root.querySelector('[data-testid="approval-approve"]')).toBeNull()
    root
      .querySelector<HTMLButtonElement>('[data-testid="approval-open-frank"]')!
      .click()
    await tick(5)
    expect(windows.create).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining('index.html?extMode=window'),
      }),
    )
    expect(closeWindow).not.toHaveBeenCalled()
    expect(state.pendingApprovals.size).toBe(0)
    expect(state.approvedOrigins.size).toBe(0)
    page.dispose()
    bg.dispose()
    window.history.replaceState({}, '', '/')
  })

  it('reports approval-window failure to the site and removes the unanswered request', async () => {
    const { scope, windows } = createExtensionScope()
    windows.create.mockRejectedValueOnce(new Error('Safari refused the window'))
    const state = createBackgroundBridgeState({ activePersonaAddress: PRIMARY })
    const response = await rpc(
      state,
      scope,
      'cannot-open',
      'eth_requestAccounts',
    )
    expect(response).toEqual({
      ok: false,
      error: {
        code: 4900,
        message:
          'Frank could not open the connection approval. Open the extension and try again.',
      },
    })
    expect(state.pendingApprovals.size).toBe(0)
    expect(state.pendingRpcWaiters.size).toBe(0)
    expect(state.originPersonas['https://app.uniswap.org']).toBeUndefined()
  })

  it('shows approval decision failures instead of silently ignoring them', async () => {
    const { scope } = createExtensionScope()
    const state = createBackgroundBridgeState({ activePersonaAddress: PRIMARY })
    const bg = installBackgroundBridge(scope, state)
    const pending = rpc(state, scope, 'decision-error', 'eth_requestAccounts')
    await tick()
    const root = document.createElement('main')
    const page = mountApprovalPage(root, {
      globalScope: scope,
      closeWindow: jest.fn(),
    })
    await tick(5)
    // Exercise a stale view: custody has not provided its selected site address.
    const approve = root.querySelector<HTMLButtonElement>(
      '[data-testid="approval-approve"]',
    )!
    approve.disabled = false
    approve.click()
    await tick(5)
    expect(root.querySelector('[role="alert"]')!.textContent).toContain(
      'Sync or unlock Frank first',
    )
    expect(state.pendingApprovals.has('decision-error')).toBe(true)
    expect(state.originPersonas['https://app.uniswap.org']).toBeUndefined()
    await decide(state, scope, 'decision-error', false)
    await pending
    page.dispose()
    bg.dispose()
  })

  it('shows the request with its site and persona choice, and Connect resolves the dApp with the chosen persona', async () => {
    const { scope, windows } = createExtensionScope()
    const state = createBackgroundBridgeState({ activePersonaAddress: PRIMARY })
    const bg = installBackgroundBridge(scope, state)

    const pending = rpc(state, scope, 'r1', 'eth_requestAccounts')
    await tick()
    expect(windows.create).toHaveBeenCalledTimes(1)
    await provideSitePersona(state, scope)

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

  it('cannot connect a per-site persona Frank has not provided yet, and shows it once provided', async () => {
    const { scope } = createExtensionScope()
    const state = createBackgroundBridgeState({ activePersonaAddress: PRIMARY })
    const bg = installBackgroundBridge(scope, state)
    void rpc(state, scope, 'r1', 'eth_requestAccounts')
    await tick()
    const root = document.createElement('main')
    const page = mountApprovalPage(root, {
      globalScope: scope,
      closeWindow: () => undefined,
    })
    await tick(5)
    const approve = () =>
      root.querySelector<HTMLButtonElement>('[data-testid="approval-approve"]')!
    expect(root.textContent).toContain('Open Frank and unlock it')
    root
      .querySelector<HTMLButtonElement>('[data-testid="approval-open-frank"]')!
      .click()
    await tick(5)
    expect(scope.chrome.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining('index.html?extMode=window'),
      }),
    )
    expect(approve().disabled).toBe(true)
    const primary = root.querySelector<HTMLInputElement>(
      '[data-testid="approval-persona-primary"]',
    )!
    primary.checked = true
    primary.dispatchEvent(new Event('change'))
    expect(approve().disabled).toBe(false)

    await provideSitePersona(state, scope)
    await tick(5)
    expect(root.textContent).toContain(SITE)
    expect(approve().disabled).toBe(false)
    page.dispose()
    bg.dispose()
  })

  it('shows explicit review and rejection for signing requests', async () => {
    const { scope } = createExtensionScope()
    const state = createBackgroundBridgeState({ activePersonaAddress: PRIMARY })
    state.approvedOrigins.add('https://app.uniswap.org')
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
    expect(root.textContent).toContain(`Account: ${PRIMARY}`)
    expect(root.textContent).toContain('Message UTF-8: hello')
    expect(root.textContent).toContain('Message bytes (hex): 0x68656c6c6f')
    expect(
      root.querySelector('[data-testid="approval-approve"]'),
    ).not.toBeNull()

    root
      .querySelector<HTMLButtonElement>('[data-testid="approval-reject"]')!
      .click()
    expect((await pending).error.code).toBe(4001)
    page.dispose()
    bg.dispose()
  })

  it('shows the complete EVM transaction review before enabling approval', async () => {
    const { scope } = createExtensionScope()
    const origin = 'https://app.uniswap.org'
    const state = createBackgroundBridgeState({
      activePersonaAddress: PRIMARY,
      approvedOrigins: new Set([origin]),
      originPersonas: {
        [origin]: {
          address: PRIMARY,
          index: 0,
          label: 'Shared',
          isBurner: false,
        },
      },
    })
    const bg = installBackgroundBridge(scope, state)
    const pending = rpc(
      state,
      scope,
      'review-tx',
      'eth_sendTransaction',
      origin,
      [
        {
          from: PRIMARY,
          to: SITE,
          value: '0xde0b6b3a7640000',
          gas: '0x5208',
          maxFeePerGas: '0x3b9aca00',
          maxPriorityFeePerGas: '0x1',
          data: '0xdeadbeef00112233',
        },
      ],
    )
    await tick()
    const root = document.createElement('main')
    const page = mountApprovalPage(root, {
      globalScope: scope,
      closeWindow: () => undefined,
    })
    await page.refresh()
    const summary = root.querySelector('.approval-review-summary')
    expect(summary?.textContent).toContain(
      'Monad Testnet (monad-testnet, chain ID 0x279f)',
    )
    expect(summary?.textContent).toContain(`Account: ${PRIMARY}`)
    expect(summary?.textContent).toContain(`Recipient: ${SITE}`)
    expect(summary?.textContent).toContain('Value: 1.0 MONT')
    expect(summary?.textContent).toContain('Gas limit: 0x5208')
    expect(summary?.textContent).toContain('Gas price: 0x3b9aca00')
    expect(summary?.textContent).toContain('Calldata: 0xdeadbeef00112233')
    expect(summary?.textContent).toContain('Calldata interpretation: undecoded')
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="approval-approve"]')
        ?.disabled,
    ).toBe(false)
    root
      .querySelector<HTMLButtonElement>('[data-testid="approval-reject"]')!
      .click()
    expect((await pending).error.code).toBe(4001)
    page.dispose()
    bg.dispose()
  })

  it('shows the Solana chain, account, program, and complete unknown instruction data', async () => {
    const { scope } = createExtensionScope()
    const account = new PublicKey(new Uint8Array(32).fill(8)).toBase58()
    const instructionData = new Uint8Array([1, 2, 3, 4, 5, 6])
    const transaction = new VersionedTransaction(
      new MessageV0({
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 1,
        },
        staticAccountKeys: [new PublicKey(account), SystemProgram.programId],
        recentBlockhash: PublicKey.default.toBase58(),
        compiledInstructions: [
          {
            programIdIndex: 1,
            accountKeyIndexes: Uint8Array.of(0),
            data: instructionData,
          },
        ],
        addressTableLookups: [],
      }),
    ).serialize()
    const request = {
      id: 'sol-review',
      kind: 'sign' as const,
      chainFamily: 'solana' as const,
      origin: 'https://solana.example',
      href: 'https://solana.example',
      method: 'solana_signTransaction',
      params: {
        account,
        chain: 'solana:devnet',
        transaction: Array.from(transaction),
      },
      chainIdentifier: 'solana-devnet',
      solanaAccountAddress: account,
      createdAt: Date.now(),
      requiresCompanionApproval: true,
    }
    const state = createBackgroundBridgeState({
      pendingApprovals: new Map([[request.id, request]]),
    })
    const bg = installBackgroundBridge(scope, state)
    const root = document.createElement('main')
    const page = mountApprovalPage(root, {
      globalScope: scope,
      closeWindow: () => undefined,
    })
    await page.refresh()
    const summary =
      root.querySelector('.approval-review-summary')?.textContent ?? ''
    expect(summary).toContain('solana:devnet')
    expect(summary).toContain(`Solana account: ${account}`)
    expect(summary).toContain(`Program: ${SystemProgram.programId.toBase58()}`)
    expect(summary).toContain('Data (hex): 0x010203040506')
    expect(summary).toContain(
      'Unknown instruction; review the full program and data.',
    )
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="approval-approve"]')
        ?.disabled,
    ).toBe(false)
    root
      .querySelector<HTMLButtonElement>('[data-testid="approval-reject"]')!
      .click()
    page.dispose()
    bg.dispose()
  })

  it('renders site-supplied text as text, never markup', async () => {
    const { scope } = createExtensionScope()
    const state = createBackgroundBridgeState({ activePersonaAddress: PRIMARY })
    const bg = installBackgroundBridge(scope, state)
    state.approvedOrigins.add('https://evil.example')
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
    await provideSitePersona(
      state,
      scope,
      Array.from(state.pendingApprovals.values())[0]!.origin,
    )

    const root = document.createElement('main')
    const page = mountApprovalPage(root, {
      globalScope: scope,
      closeWindow: () => undefined,
    })
    await tick(5)
    const burner = Array.from(state.pendingApprovals.values())[0]!
      .suggestedBurnerAddress!
    expect(burner).toBe(SITE)
    root
      .querySelector<HTMLButtonElement>('[data-testid="approval-approve"]')!
      .click()

    expect(await accounts).toEqual([burner])
    expect(await provider.request({ method: 'eth_accounts' })).toEqual([burner])
    page.dispose()
    cleanupContent()
    bg.dispose()
  })

  it('connects and signs Solana through page, content, approval, and the session executor bridge', async () => {
    const { scope, windows } = createExtensionScope()
    const state = createBackgroundBridgeState()
    const secretKey = new Uint8Array(32).fill(33)
    const publicKeyBytes = ed25519.getPublicKey(secretKey)
    const address = new PublicKey(publicKeyBytes).toBase58()
    scope.chrome.runtime.onMessage.addListener(
      (message: any, _sender: any, respond: (value: unknown) => void) => {
        if (message.type === 'preview-dapp-account') {
          respond({ ok: true, account: { address } })
          return
        }
        if (message.type !== 'execute-approved-dapp-request') return
        if (message.request.method === 'solana_connect') {
          respond({
            ok: true,
            result: {
              address,
              publicKey: Array.from(publicKeyBytes),
            },
          })
        } else if (message.request.method === 'solana_signMessage') {
          const content = Uint8Array.from(message.request.params.message)
          respond({
            ok: true,
            result: {
              signature: Array.from(ed25519.sign(content, secretKey)),
            },
          })
        }
      },
    )
    const bg = installBackgroundBridge(scope, state)
    const cleanupContent = installContentScriptBridge(window as any, scope)
    const provider = installInpageProvider(window as any)!
    const root = document.createElement('main')
    const page = mountApprovalPage(root, {
      globalScope: scope,
      closeWindow: () => undefined,
    })

    const connecting = provider.request<any>({ method: 'solana_connect' })
    await tick(10)
    expect(windows.create).toHaveBeenCalledTimes(1)
    await page.refresh()
    expect(root.textContent).toContain('Connect a Solana account')
    expect(root.textContent).toContain(`Solana account: ${address}`)
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="approval-approve"]')
        ?.disabled,
    ).toBe(false)
    root
      .querySelector<HTMLButtonElement>('[data-testid="approval-approve"]')!
      .click()
    const account = await connecting
    expect(account.address).toBe(address)
    expect(account.publicKey).toEqual(Array.from(publicKeyBytes))

    const message = new Uint8Array([2, 4, 6, 8])
    const signing = provider.request<any>({
      method: 'solana_signMessage',
      params: { message: Array.from(message), account: account.address },
    })
    await tick(10)
    await page.refresh()
    expect(root.textContent).toContain('Sign a Solana message')
    root
      .querySelector<HTMLButtonElement>('[data-testid="approval-approve"]')!
      .click()
    const result = await signing
    expect(
      ed25519.verify(
        Uint8Array.from(result.signature),
        message,
        publicKeyBytes,
      ),
    ).toBe(true)
    page.dispose()
    cleanupContent()
    bg.dispose()
  })

  it('discovers Frank through Wallet Standard without exposing an account before approval', async () => {
    const registered: unknown[] = []
    window.addEventListener('wallet-standard:register-wallet', event => {
      ;(event as CustomEvent<(wallet: unknown) => void>).detail(wallet =>
        registered.push(wallet),
      )
    })
    const win = window as any
    delete win.__FRANK_INPAGE_PROVIDER_INSTALLED__
    delete win.frankEthereum
    installInpageProvider(win)
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({
      name: 'Frank',
      chains: ['solana:mainnet', 'solana:devnet'],
      features: expect.objectContaining({
        'standard:connect': expect.any(Object),
        'solana:signMessage': expect.any(Object),
        'solana:signTransaction': expect.any(Object),
        'solana:signAndSendTransaction': expect.any(Object),
      }),
    })
    expect(win.frankSolana).toBeUndefined()
  })
})
