/** @jest-environment jsdom */

import { buildExtensionManifest } from './manifests'
import {
  FRANK_EXT_LAUNCH_MODE_KEY,
  getExtensionRuntime,
  isBrowserExtensionRuntime,
  onRuntimeMessage,
  openCompanionPanel,
  focusOrOpenMainExtensionWindow,
  sendRuntimeMessage,
} from './runtime-adapter'
import {
  FRANK_DAPP_BRIDGE_CHANNEL,
  FRANK_EIP6963_INFO,
  installInpageProvider,
} from './inpage'
import {
  ensureSafariFallbackInpageScript,
  installContentScriptBridge,
  isAllowedSyncOrigin,
} from './content'
import {
  createBackgroundBridgeState,
  ensureOffscreenWarmup,
  handleBackgroundMessage,
  installBackgroundBridge,
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

describe('Multi-target WebExtension manifests & runtime adapter (#1707, #1709, #1710)', () => {
  it('builds Chrome MV3 manifest with sidePanel, service_worker, and MAIN + ISOLATED content scripts', () => {
    const manifest = buildExtensionManifest('chrome', '0.3.0')
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.permissions).toEqual([
      'storage',
      'sidePanel',
      'activeTab',
      'scripting',
      'offscreen',
      'alarms',
    ])
    expect(manifest.background).toEqual({
      service_worker: 'background.js',
      type: 'module',
    })
    expect(manifest.side_panel).toEqual({
      default_path: 'index.html?extMode=sidepanel',
    })
    // Bare index.html: Safari will not load a popup path with a query string;
    // extension-boot.js adds ?extMode=popup before the app boots.
    expect(manifest.action).toEqual({
      default_popup: 'index.html',
      default_title: 'Frank',
      default_icon: {
        '16': 'icons/extension-16x16.png',
        '32': 'icons/extension-32x32.png',
        '64': 'icons/extension-64x64.png',
        '128': 'icons/extension-128x128.png',
      },
    })
    expect(manifest.icons).toEqual(manifest.action.default_icon)
    expect(manifest.content_scripts).toEqual([
      {
        matches: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
        js: ['inpage.js'],
        run_at: 'document_start',
        world: 'MAIN',
      },
      {
        matches: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
        js: ['content.js'],
        run_at: 'document_start',
        world: 'ISOLATED',
      },
    ])
  })

  it('builds Firefox MV3 manifest with gecko settings and sidebar_action', () => {
    const manifest = buildExtensionManifest('firefox', '0.3.0')
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.browser_specific_settings).toEqual({
      gecko: {
        id: 'frank@signet.mx',
        strict_min_version: '128.0',
      },
    })
    expect(manifest.permissions).toEqual([
      'storage',
      'activeTab',
      'scripting',
      'alarms',
    ])
    expect(manifest.background).toEqual({
      scripts: ['background.js'],
      type: 'module',
    })
    expect(manifest.sidebar_action).toEqual({
      default_panel: 'index.html?extMode=sidebar',
      default_title: 'Frank',
      default_icon: {
        '16': 'icons/extension-16x16.png',
        '32': 'icons/extension-32x32.png',
        '64': 'icons/extension-64x64.png',
        '128': 'icons/extension-128x128.png',
      },
    })
  })

  it('builds Safari MV3 manifest with service_worker background and web_accessible_resources for inpage.js fallback', () => {
    const manifest = buildExtensionManifest('safari', '0.3.0')
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.permissions).toEqual([
      'storage',
      'activeTab',
      'scripting',
      'alarms',
    ])
    expect(manifest.background).toEqual({
      service_worker: 'background.js',
    })
    expect(manifest.content_security_policy).toEqual({
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    })
    expect(manifest.content_scripts).toEqual([
      {
        matches: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
        js: ['content.js'],
        run_at: 'document_start',
      },
    ])
    expect(manifest.web_accessible_resources).toEqual([
      {
        resources: ['inpage.js'],
        matches: ['<all_urls>'],
      },
    ])
  })

  it('normalizes runtime detection and safe no-ops in Standalone PWA mode', async () => {
    const pwaScope = { navigator: { userAgent: 'Mozilla/5.0' } }
    expect(isBrowserExtensionRuntime(pwaScope)).toBe(false)
    expect(getExtensionRuntime(pwaScope)).toEqual({
      isExtension: false,
      kind: 'pwa',
      hasSidePanel: false,
      hasSidebarAction: false,
    })
    expect(await openCompanionPanel({}, pwaScope)).toEqual({
      opened: false,
      mode: 'noop',
    })
    expect(await sendRuntimeMessage({ ping: true }, pwaScope)).toBeNull()
    const off = onRuntimeMessage(() => ({ pong: true }), pwaScope)
    expect(typeof off).toBe('function')
  })

  it('detects Chrome, Firefox, and Safari WebExtension runtimes and opens the companion surface', async () => {
    const sidePanelOpen = jest.fn().mockResolvedValue(undefined)
    const chromeScope = {
      chrome: {
        runtime: {
          id: 'chrome-ext-id',
          getURL: (p: string) => `chrome-extension://chrome-ext-id/${p}`,
        },
        sidePanel: {
          open: sidePanelOpen,
        },
      },
    }
    expect(getExtensionRuntime(chromeScope).kind).toBe('chrome-extension')
    expect(await openCompanionPanel({ windowId: 7 }, chromeScope)).toEqual({
      opened: true,
      mode: 'sidePanel',
    })
    expect(sidePanelOpen).toHaveBeenCalledWith({ windowId: 7 })

    const sidebarOpen = jest.fn().mockResolvedValue(undefined)
    const firefoxScope = {
      browser: {
        runtime: {
          id: 'frank@signet.mx',
          getURL: (p: string) => `moz-extension://uuid/${p}`,
        },
        sidebarAction: {
          open: sidebarOpen,
        },
      },
    }
    expect(getExtensionRuntime(firefoxScope).kind).toBe('firefox-extension')
    expect(await openCompanionPanel({}, firefoxScope)).toEqual({
      opened: true,
      mode: 'sidebarAction',
    })

    const safariScope = {
      browser: {
        runtime: {
          id: 'safari-ext-id',
          getURL: (p: string) => `safari-web-extension://uuid/${p}`,
        },
        action: {
          openPopup: jest.fn().mockResolvedValue(undefined),
        },
      },
    }
    expect(getExtensionRuntime(safariScope).kind).toBe('safari-extension')
    expect(await openCompanionPanel({}, safariScope)).toEqual({
      opened: true,
      mode: 'popup',
    })
  })

  it('injects idempotent EIP-1193 + EIP-6963 provider and routes RPC + PWA sync end-to-end', async () => {
    const listeners: Array<
      (msg: any, sender: any, sendResponse: (res: any) => void) => any
    > = []
    const setPanelBehavior = jest.fn().mockResolvedValue(undefined)
    const sidePanelOpen = jest.fn().mockResolvedValue(undefined)
    const storageSet = jest.fn().mockResolvedValue(undefined)
    const windowsCreate = jest.fn().mockResolvedValue({ id: 31 })

    const mockExtensionScope = {
      chrome: {
        runtime: {
          id: 'frank-test-ext',
          getURL: (p: string) => `chrome-extension://frank-test-ext/${p}`,
          sendMessage: (msg: any, cb?: (res: any) => void) => {
            for (const fn of listeners) {
              fn(msg, mockSenderFor(msg), (res: any) => {
                if (cb) cb(res)
              })
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
        sidePanel: {
          setPanelBehavior,
          open: sidePanelOpen,
        },
        windows: {
          create: windowsCreate,
          update: jest.fn().mockResolvedValue({}),
          remove: jest.fn().mockResolvedValue(undefined),
          onRemoved: { addListener: jest.fn() },
        },
        storage: {
          local: {
            set: storageSet,
          },
        },
      },
    }

    const bgState = createBackgroundBridgeState({
      chainIdHex: '0x279f',
      activePersonaAddress: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    })
    const bg = installBackgroundBridge(mockExtensionScope, bgState)
    await new Promise(r => setTimeout(r, 0))
    expect(setPanelBehavior).toHaveBeenCalledWith({
      openPanelOnActionClick: false,
    })

    const cleanupContent = installContentScriptBridge(
      window as any,
      mockExtensionScope,
    )

    const announced: any[] = []
    window.addEventListener('eip6963:announceProvider', (ev: Event) => {
      announced.push((ev as CustomEvent).detail)
    })

    const p1 = installInpageProvider(window as any)
    const p2 = installInpageProvider(window as any)
    expect(p1).toBe(p2)
    expect(p1?.isFrank).toBe(true)

    window.dispatchEvent(new Event('eip6963:requestProvider'))
    expect(announced.length).toBeGreaterThanOrEqual(1)
    expect(announced[0].info).toEqual({
      ...FRANK_EIP6963_INFO,
      uuid: expect.any(String),
    })

    const chainId = await p1!.request({ method: 'eth_chainId' })
    expect(chainId).toBe('0x279f')

    // Before approval, eth_accounts strictly returns []
    const preAccounts = await p1!.request<string[]>({ method: 'eth_accounts' })
    expect(preAccounts).toEqual([])

    // EIP-1193 eth_requestAccounts queues interactive approval and holds RPC promise open
    const connectEvents: any[] = []
    const accountsChangedEvents: any[] = []
    p1!.on('connect', (info: any) => connectEvents.push(info))
    p1!.on('accountsChanged', (accs: any) => accountsChangedEvents.push(accs))

    const connectPromise = p1!.request<string[]>({
      method: 'eth_requestAccounts',
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    // The request opens the dedicated approval window, not a side panel.
    expect(windowsCreate).toHaveBeenCalledWith({
      url: 'chrome-extension://frank-test-ext/approval.html',
      type: 'popup',
      width: 400,
      height: 620,
      focused: true,
    })
    expect(sidePanelOpen).not.toHaveBeenCalled()
    expect(bgState.pendingApprovals.size).toBe(1)
    const connectApproval = Array.from(bgState.pendingApprovals.values())[0]!
    expect(connectApproval.kind).toBe('connect')

    await sendRuntimeMessage<any, any>(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'companion-resolve-approval',
        requestId: connectApproval.id,
        approved: true,
        useBurnerPersona: false,
      },
      mockExtensionScope,
    )

    const accounts = await connectPromise
    expect(accounts).toEqual(['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'])
    expect(p1!.selectedAddress).toBe(
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    )
    expect(connectEvents).toEqual([{ chainId: '0x279f' }])
    expect(accountsChangedEvents).toEqual([
      ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
    ])

    // Subsequent eth_accounts returns the approved account list
    const ethAccounts = await p1!.request<string[]>({ method: 'eth_accounts' })
    expect(ethAccounts).toEqual([
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    ])

    // wallet_switchEthereumChain and read-only RPC methods succeed for dApp compatibility
    const switchRes = await p1!.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x1' }],
    })
    expect(switchRes).toBeNull()
    expect(p1!.chainId).toBe('0x1')

    const perms = await p1!.request<any[]>({ method: 'wallet_getPermissions' })
    expect(perms[0]?.parentCapability).toBe('eth_accounts')

    // Signing is not implemented: approving it never hands the dApp a made-up signature.
    const signPromise = p1!.request<string>({
      method: 'personal_sign',
      params: ['0x48656c6c6f', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
    })
    const signOutcome = signPromise.then(
      () => 'resolved',
      (err: { code?: number }) => err.code,
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(bgState.pendingApprovals.size).toBe(1)
    const signApproval = Array.from(bgState.pendingApprovals.values())[0]!

    const resolved = await sendRuntimeMessage<any, any>(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'companion-resolve-approval',
        requestId: signApproval.id,
        approved: true,
        result: '0xdeadbeefcafebabe1b',
      },
      mockExtensionScope,
    )
    expect(resolved.ok).toBe(false)
    expect(resolved.error.code).toBe(4200)
    expect(await signOutcome).toBe(4200)

    // Updating active persona from logged-in Frank wallet updates eth_requestAccounts
    await sendRuntimeMessage<any, any>(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'set-active-persona',
        address: '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3',
      },
      mockExtensionScope,
    )
    expect(bgState.activePersonaAddress).toBe(
      '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3',
    )

    // Test Safari fallback script injection when provider not yet installed
    const safariScope = {
      browser: {
        runtime: {
          id: 'safari-id',
          getURL: (p: string) => `safari-web-extension://safari-id/${p}`,
        },
      },
    }
    const fakeDocWindow: any = {
      __FRANK_INPAGE_PROVIDER_INSTALLED__: false,
      document: document,
    }
    const injectedScript = ensureSafariFallbackInpageScript(
      fakeDocWindow,
      safariScope,
    )
    expect(injectedScript).not.toBeNull()
    expect(injectedScript?.src).toBe(
      'safari-web-extension://safari-id/inpage.js',
    )
    injectedScript?.remove()

    // Account sync is limited to the exact Frank web app origin (A1).
    expect(isAllowedSyncOrigin({ origin: 'https://signet.mx' })).toBe(true)
    expect(isAllowedSyncOrigin({ origin: 'http://localhost:9000' })).toBe(false)
    expect(isAllowedSyncOrigin({ origin: 'https://evil.example.com' })).toBe(
      false,
    )

    // Choosing the side panel for the toolbar click
    const toggleSidePanelRes = await sendRuntimeMessage<any, any>(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'set-launch-mode',
        launchMode: 'sidepanel',
      },
      mockExtensionScope,
    )
    expect(toggleSidePanelRes.result).toEqual({
      ok: true,
      launchMode: 'sidepanel',
    })
    expect(storageSet).toHaveBeenLastCalledWith({
      [FRANK_EXT_LAUNCH_MODE_KEY]: 'sidepanel',
    })
    expect(setPanelBehavior).toHaveBeenLastCalledWith({
      openPanelOnActionClick: true,
    })

    cleanupContent()
    bg.dispose()
  })

  it('copyDirectoryFiltered excludes .map source maps and service workers from extension bundles', async () => {
    const { execFileSync } = await import('node:child_process')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const { pathToFileURL } = await import('node:url')
    const scriptUrl = pathToFileURL(
      path.resolve(__dirname, '../scripts/build-extension.mjs'),
    ).href
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frank-bex-copy-'))
    const srcDir = path.join(tmpRoot, 'src')
    const destDir = path.join(tmpRoot, 'dest')
    try {
      fs.mkdirSync(path.join(srcDir, 'js'), { recursive: true })
      fs.writeFileSync(path.join(srcDir, 'index.html'), '<html></html>')
      fs.writeFileSync(path.join(srcDir, 'sw.js'), '// sw')
      fs.writeFileSync(
        path.join(srcDir, 'js', 'app.js'),
        'console.log(1)\n//# sourceMappingURL=app.js.map\n',
      )
      fs.writeFileSync(path.join(srcDir, 'js', 'app.js.map'), '{}')
      fs.writeFileSync(path.join(srcDir, 'js', 'vendor.js.map'), '{}')

      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { copyDirectoryFiltered } from ${JSON.stringify(
            scriptUrl,
          )}; copyDirectoryFiltered(${JSON.stringify(srcDir)}, ${JSON.stringify(
            destDir,
          )});`,
        ],
        { stdio: 'pipe' },
      )

      expect(fs.existsSync(path.join(destDir, 'index.html'))).toBe(true)
      expect(fs.existsSync(path.join(destDir, 'js', 'app.js'))).toBe(true)
      expect(
        fs.readFileSync(path.join(destDir, 'js', 'app.js'), 'utf8'),
      ).not.toContain('sourceMappingURL=')
      expect(fs.existsSync(path.join(destDir, 'sw.js'))).toBe(false)
      expect(fs.existsSync(path.join(destDir, 'js', 'app.js.map'))).toBe(false)
      expect(fs.existsSync(path.join(destDir, 'js', 'vendor.js.map'))).toBe(
        false,
      )
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('transforms extension index.html to strip modulepreload, set 400x600 popup CSS, and defer entry module import until after load + requestAnimationFrame', async () => {
    const { execFileSync } = await import('node:child_process')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const { pathToFileURL } = await import('node:url')
    const scriptUrl = pathToFileURL(
      path.resolve(__dirname, '../scripts/build-extension.mjs'),
    ).href
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frank-bex-html-'))
    try {
      const sampleViteHtml = `<!DOCTYPE html>
<html>
  <head>
    <title>Frank</title>
    <link rel="manifest" href="manifest.json" />
    <script type="module" crossorigin src="/assets/index-AbCd1234.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-vue-1111.js">
    <link rel="modulepreload" crossorigin href="/assets/vendor-ethers-2222.js">
    <link rel="stylesheet" crossorigin href="/assets/index-9999.css">
  </head>
  <body>
    <div id="q-app"></div>
  </body>
</html>`

      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import fs from 'node:fs'; import path from 'node:path'; import { transformExtensionIndexHtml } from ${JSON.stringify(
            scriptUrl,
          )}; const out = transformExtensionIndexHtml(${JSON.stringify(
            sampleViteHtml,
          )}, ${JSON.stringify(
            tmpDir,
          )}); fs.writeFileSync(path.join(${JSON.stringify(
            tmpDir,
          )}, 'index.html'), out, 'utf8');`,
        ],
        { stdio: 'pipe' },
      )

      const transformedHtml = fs.readFileSync(
        path.join(tmpDir, 'index.html'),
        'utf8',
      )
      const bootScript = fs.readFileSync(
        path.join(tmpDir, 'extension-boot.js'),
        'utf8',
      )

      expect(transformedHtml).not.toContain('rel="modulepreload"')
      expect(transformedHtml).not.toContain('rel="manifest"')
      expect(transformedHtml).not.toContain('src="/assets/index-AbCd1234.js"')
      // The popup's size comes from the document alone (browsers size an
      // action popup from it, starting from a tiny viewport): a fixed
      // 400x600 box, no viewport-relative clamp on the root.
      const sizing =
        /<style id="frank-extension-popup-sizing">([\s\S]*?)<\/style>/.exec(
          transformedHtml,
        )?.[1]
      expect(sizing).toBeDefined()
      const rootRule =
        /html:not\(\[data-ext-mode\]\), html\[data-ext-mode='popup'\] \{([^}]*)\}/.exec(
          sizing!,
        )?.[1]
      expect(rootRule).toContain(
        '--frank-vw: calc(400px / var(--frank-ui-zoom, 1)) !important;',
      )
      expect(rootRule).toContain(
        '--frank-vh: calc(600px / var(--frank-ui-zoom, 1)) !important;',
      )
      expect(rootRule).toContain('width: var(--frank-vw) !important;')
      expect(rootRule).toContain('height: var(--frank-vh) !important;')
      expect(rootRule).toContain('max-width: none !important;')
      expect(rootRule).toContain('max-height: none !important;')
      expect(rootRule).not.toMatch(/\d+(vw|vh|dvh)|100%/)
      expect(transformedHtml).not.toContain('extension-popup.css')
      expect(transformedHtml).toContain('requestAnimationFrame')
      expect(transformedHtml).toContain("import('./assets/index-AbCd1234.js')")
      expect(bootScript).toContain("window.addEventListener('load'")
      expect(bootScript).toContain('requestAnimationFrame')
      expect(bootScript).toContain("import('./assets/index-AbCd1234.js')")
      // The manifest popup is bare index.html; boot records the mode in the URL
      // before the app reads location.search.
      expect(bootScript).toContain("params.set('extMode', extMode)")
      expect(bootScript).toContain('history.replaceState(')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('ships every manifest icon, falling back to the 128px app icon when the brand publishes no extension icon', async () => {
    const { execFileSync } = await import('node:child_process')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const { pathToFileURL } = await import('node:url')
    const scriptUrl = pathToFileURL(
      path.resolve(__dirname, '../scripts/build-extension.mjs'),
    ).href
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frank-bex-icons-'))
    try {
      fs.mkdirSync(path.join(tmpDir, 'icons'))
      fs.writeFileSync(path.join(tmpDir, 'icons', 'icon-128x128.png'), 'app')
      fs.writeFileSync(
        path.join(tmpDir, 'icons', 'extension-16x16.png'),
        'transparent',
      )
      const manifest = buildExtensionManifest('firefox', '0.3.0')
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { ensureManifestIcons } from ${JSON.stringify(
            scriptUrl,
          )}; ensureManifestIcons(${JSON.stringify(tmpDir)}, ${JSON.stringify(
            manifest,
          )});`,
        ],
        { stdio: 'pipe' },
      )
      const read = (rel: string) =>
        fs.readFileSync(path.join(tmpDir, rel), 'utf8')
      expect(read('icons/extension-16x16.png')).toBe('transparent')
      expect(read('icons/extension-128x128.png')).toBe('app')
      expect(read('icons/extension-64x64.png')).toBe('app')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('opens a standalone extension window (with tab fallback) or the side panel without changing the toolbar click choice', async () => {
    const windowsCreate = jest.fn().mockResolvedValue({ id: 99 })
    const storageSet = jest.fn().mockResolvedValue(undefined)
    const setPanelBehavior = jest.fn().mockResolvedValue(undefined)
    const sidePanelOpen = jest.fn().mockResolvedValue(undefined)

    const chromeScope = {
      chrome: {
        runtime: {
          id: 'frank-ext',
          getURL: (p: string) => `chrome-extension://frank-ext/${p}`,
        },
        windows: {
          create: windowsCreate,
          getCurrent: jest.fn().mockResolvedValue({ id: 42 }),
        },
        sidePanel: {
          open: sidePanelOpen,
          setPanelBehavior,
        },
        storage: {
          local: {
            set: storageSet,
          },
        },
      },
    }

    const winRes = await focusOrOpenMainExtensionWindow({}, chromeScope)
    expect(winRes).toEqual({
      opened: true,
      focused: false,
      mode: 'window',
      url: 'chrome-extension://frank-ext/index.html?extMode=window',
    })
    expect(windowsCreate).toHaveBeenCalledWith({
      url: 'chrome-extension://frank-ext/index.html?extMode=window',
      type: 'popup',
      width: 440,
      height: 740,
    })
    // Opening the side panel leaves the toolbar click choice alone
    const panelRes = await openCompanionPanel({}, chromeScope)
    expect(panelRes).toEqual({
      opened: true,
      mode: 'sidePanel',
    })
    expect(sidePanelOpen).toHaveBeenCalledWith({ windowId: 42 })
    expect(setPanelBehavior).not.toHaveBeenCalled()
    for (const [items] of storageSet.mock.calls) {
      expect(items).not.toHaveProperty(FRANK_EXT_LAUNCH_MODE_KEY)
    }

    // Fallback to chrome.tabs.create when chrome.windows.create is unavailable
    const tabsCreate = jest.fn().mockResolvedValue({ id: 101 })
    const tabFallbackScope = {
      chrome: {
        runtime: {
          id: 'frank-ext',
          getURL: (p: string) => `chrome-extension://frank-ext/${p}`,
        },
        tabs: {
          create: tabsCreate,
        },
      },
    }
    const tabRes = await focusOrOpenMainExtensionWindow({}, tabFallbackScope)
    expect(tabRes).toEqual({
      opened: true,
      focused: false,
      mode: 'tab',
      url: 'chrome-extension://frank-ext/index.html?extMode=tab',
    })
    expect(tabsCreate).toHaveBeenCalledWith({
      url: 'chrome-extension://frank-ext/index.html?extMode=tab',
    })
  })

  it('splits large vendor dependencies into parallel-parseable chunks via resolveManualChunk', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveManualChunk } = require('../config/manual-chunks.cjs')
    expect(
      resolveManualChunk(
        '/repo/node_modules/vue/dist/vue.runtime.esm-bundler.js',
      ),
    ).toBe('vendor-vue')
    expect(resolveManualChunk('/repo/node_modules/pinia/dist/pinia.mjs')).toBe(
      'vendor-vue',
    )
    expect(
      resolveManualChunk(
        '/repo/node_modules/quasar/src/components/btn/QBtn.js',
      ),
    ).toBe('vendor-quasar')
    expect(
      resolveManualChunk('/repo/node_modules/ethers/lib.esm/index.js'),
    ).toBe('vendor-ethers')
    expect(
      resolveManualChunk('/repo/node_modules/@noble/curves/secp256k1.js'),
    ).toBe('vendor-noble')
    expect(resolveManualChunk('/repo/node_modules/level-js/index.js')).toBe(
      'vendor-storage',
    )
    expect(
      resolveManualChunk(
        '/repo/node_modules/@solana/web3.js/lib/index.browser.esm.js',
      ),
    ).toBe('vendor-solana')
    expect(resolveManualChunk('/repo/packages/bitcore-lib-xpi/index.js')).toBe(
      'vendor-utxo',
    )
    expect(resolveManualChunk('/repo/app/src/pages/Chat.vue')).toBeUndefined()
  })

  it('exposes ext-popout-window-btn in ExtensionPopoutBtn.vue across extension toolbars', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const popoutBtnSource = fs.readFileSync(
      path.resolve(
        __dirname,
        '../src/components/navigation/ExtensionPopoutBtn.vue',
      ),
      'utf8',
    )
    expect(popoutBtnSource).toContain('data-testid="ext-popout-window-btn"')
    expect(popoutBtnSource).toContain('popOutExtensionWindow')
  })

  it('keeps extension renderer process and JS module cache warm via chrome.offscreen (Chromium) and hidden #frank-warmup-frame iframe (Safari/Firefox)', async () => {
    const hasDocument = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const createDocument = jest.fn().mockResolvedValue(undefined)
    const chromeScope = {
      chrome: {
        runtime: {
          id: 'frank-ext',
        },
        offscreen: {
          hasDocument,
          createDocument,
        },
      },
    }

    expect(await ensureOffscreenWarmup(chromeScope)).toBe(true)
    expect(createDocument).toHaveBeenCalledWith({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification:
        'Keep extension renderer process and V8 module cache warm for instant popup open',
    })

    // Second call when document already exists is a no-op
    expect(await ensureOffscreenWarmup(chromeScope)).toBe(true)
    expect(createDocument).toHaveBeenCalledTimes(1)

    // Safari / Firefox background DOM page fallback (no chrome.offscreen, uses hidden iframe)
    document.getElementById('frank-warmup-frame')?.remove()
    const safariDomScope = {
      browser: {
        runtime: {
          id: 'safari-ext',
          getURL: (p: string) => `safari-web-extension://safari-ext/${p}`,
        },
      },
      document,
    }
    try {
      expect(await ensureOffscreenWarmup(safariDomScope)).toBe(true)
      const frame = document.getElementById(
        'frank-warmup-frame',
      ) as HTMLIFrameElement | null
      expect(frame).not.toBeNull()
      expect(frame?.src).toBe(
        'safari-web-extension://safari-ext/offscreen.html',
      )
      expect(frame?.getAttribute('aria-hidden')).toBe('true')

      // Idempotent on second call
      expect(await ensureOffscreenWarmup(safariDomScope)).toBe(true)
      expect(document.querySelectorAll('#frank-warmup-frame').length).toBe(1)
    } finally {
      document.getElementById('frank-warmup-frame')?.remove()
    }
  })

  it('advertises Monad Testnet (0x279f) in wallet_getCapabilities and reports spendable Frank Pool balance when persona EOA balance is 0 on Monad', async () => {
    const listeners: Array<
      (msg: any, sender: any, sendResponse: (res: any) => void) => any
    > = []
    const mockScope = {
      chrome: {
        runtime: {
          id: 'frank-test-ext',
          getURL: (p: string) => `chrome-extension://frank-test-ext/${p}`,
          sendMessage: (msg: any, cb?: (res: any) => void) => {
            for (const fn of listeners) {
              fn(msg, mockSenderFor(msg), (res: any) => {
                if (cb) cb(res)
              })
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
      },
    }
    const state = createBackgroundBridgeState()
    installBackgroundBridge(mockScope, state)

    const personaAddr = '0x1111111111111111111111111111111111111111'
    await sendRuntimeMessage(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'set-active-persona',
        address: personaAddr,
        poolBalanceWeiHex: '0x4d8c55aefb8c05b5c0', // ~89.38 MON
        chainIdHex: '0x279f',
      },
      mockScope,
    )

    const capsRes = await sendRuntimeMessage<any, any>(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'dapp-rpc-request',
        origin: 'https://app.uniswap.org',
        payload: {
          method: 'wallet_getCapabilities',
          params: [personaAddr],
        },
      },
      mockScope,
    )
    expect(
      (capsRes.result as Record<string, unknown>)?.['0x279f'],
    ).toBeDefined()

    const origFetch = globalThis.fetch
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: '0x0',
      }),
    }) as unknown as typeof fetch

    try {
      const balRes = await sendRuntimeMessage<any, any>(
        {
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          type: 'dapp-rpc-request',
          origin: 'https://app.uniswap.org',
          payload: {
            method: 'eth_getBalance',
            params: [personaAddr, 'latest'],
          },
        },
        mockScope,
      )
      expect(balRes.result).toBe('0x4d8c55aefb8c05b5c0')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('persists and restores the last visited route when reopening the extension', async () => {
    const {
      EXT_LAST_ROUTE_STORAGE_KEY,
      isExtensionContext,
      isPersistableExtensionRoute,
      resolveSavedExtensionRoute,
    } = await import('../src/router/extension-route-persistence')

    expect(
      isExtensionContext({
        location: { search: '?extMode=popup', protocol: 'https:' },
      } as unknown as Window),
    ).toBe(true)
    expect(
      isExtensionContext({
        location: { search: '', protocol: 'chrome-extension:' },
      } as unknown as Window),
    ).toBe(true)
    expect(
      isExtensionContext({
        location: { search: '', protocol: 'safari-web-extension:' },
      } as unknown as Window),
    ).toBe(true)
    expect(
      isExtensionContext({
        location: { search: '', protocol: 'https:' },
      } as unknown as Window),
    ).toBe(false)

    expect(isPersistableExtensionRoute('/wallet')).toBe(true)
    expect(isPersistableExtensionRoute('/chat/0x1234')).toBe(true)
    expect(isPersistableExtensionRoute('/settings')).toBe(true)
    expect(isPersistableExtensionRoute('/')).toBe(false)
    expect(isPersistableExtensionRoute('/welcome')).toBe(false)
    expect(isPersistableExtensionRoute('/setup')).toBe(false)
    expect(isPersistableExtensionRoute('/onboard/claim/abc')).toBe(false)

    localStorage.setItem(EXT_LAST_ROUTE_STORAGE_KEY, '/wallet?tab=pool')
    const extWin = {
      location: { search: '?extMode=popup', protocol: 'chrome-extension:' },
    } as unknown as Window
    const webWin = {
      location: { search: '', protocol: 'https:' },
    } as unknown as Window
    try {
      expect(resolveSavedExtensionRoute(extWin)).toBe('/wallet?tab=pool')
      expect(resolveSavedExtensionRoute(webWin)).toBeNull()
    } finally {
      localStorage.removeItem(EXT_LAST_ROUTE_STORAGE_KEY)
    }
  })

  it('prevents isolated extension content-script world from dispatching null-detail EIP-6963 events on Safari and mounts main-world inpage.js', () => {
    document
      .querySelectorAll('script[data-frank-safari-inpage="true"]')
      .forEach(el => el.remove())

    const announced: CustomEvent[] = []
    const isolatedWin: any = {
      browser: {
        runtime: {
          id: 'safari-ext-id',
          getURL: (p: string) => `safari-web-extension://safari-ext-id/${p}`,
        },
      },
      document,
      addEventListener: jest.fn(),
      dispatchEvent: jest.fn((ev: CustomEvent) => {
        announced.push(ev)
        return true
      }),
    }

    const res = installInpageProvider(isolatedWin)
    expect(res).toBeNull()
    expect(isolatedWin.__FRANK_INPAGE_PROVIDER_INSTALLED__).toBeUndefined()
    expect(announced).toHaveLength(0)

    const injected = document.querySelector(
      'script[data-frank-safari-inpage="true"]',
    ) as HTMLScriptElement | null
    expect(injected).not.toBeNull()
    expect(injected?.src).toBe('safari-web-extension://safari-ext-id/inpage.js')
    injected?.remove()

    // Also verify deferred mount when document.head and document.documentElement are initially null at document_start
    const docListeners: Record<string, Array<() => void>> = {}
    const container = document.createElement('head')
    const earlyDoc: any = {
      head: null,
      documentElement: null,
      querySelector: () => null,
      createElement: (tag: string) => document.createElement(tag),
      addEventListener: (type: string, cb: () => void) => {
        docListeners[type] = docListeners[type] || []
        docListeners[type].push(cb)
      },
      removeEventListener: jest.fn(),
    }
    const earlyWin: any = {
      document: earlyDoc,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    }
    const scriptEl = ensureSafariFallbackInpageScript(earlyWin, {
      browser: {
        runtime: {
          id: 'safari-ext-id',
          getURL: (p: string) => `safari-web-extension://safari-ext-id/${p}`,
        },
      },
    })
    expect(scriptEl).not.toBeNull()
    expect(container.contains(scriptEl)).toBe(false)

    earlyDoc.documentElement = container
    docListeners.readystatechange?.[0]?.()
    expect(container.contains(scriptEl)).toBe(true)
  })

  it('answers persona requests with an explicit not-ready error until Frank provisions a persona', async () => {
    const { DAPP_PERSONA_NOT_READY_ERROR } = await import('./background')
    const listeners: Array<
      (msg: any, sender: any, sendResponse: (res: any) => void) => any
    > = []
    const mockScope = {
      chrome: {
        runtime: {
          id: 'frank-test-ext',
          getURL: (p: string) => `chrome-extension://frank-test-ext/${p}`,
          sendMessage: (msg: any, cb?: (res: any) => void) => {
            for (const fn of listeners) {
              fn(msg, mockSenderFor(msg), (res: any) => {
                if (cb) cb(res)
              })
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
      },
    }
    // A fresh extension has no persona at all: no well-known placeholder address.
    const state = createBackgroundBridgeState({
      approvedOrigins: new Set(['https://app.uniswap.org']),
    })
    expect(state.activePersonaAddress).toBe('')
    const bg = installBackgroundBridge(mockScope, state)
    const rpc = (origin: string, method: string, params?: unknown) =>
      sendRuntimeMessage<any, any>(
        {
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          type: 'dapp-rpc-request',
          origin,
          payload: { method, params },
        },
        mockScope,
      )
    const notReady = { ok: false, error: { ...DAPP_PERSONA_NOT_READY_ERROR } }
    expect(DAPP_PERSONA_NOT_READY_ERROR.code).toBe(4900)
    // Connected origin, nothing provisioned.
    expect(await rpc('https://app.uniswap.org', 'eth_accounts')).toEqual(notReady)
    expect(await rpc('https://app.uniswap.org', 'eth_requestAccounts')).toEqual(
      notReady,
    )
    // New origins cannot even queue a connect or signing request.
    expect(await rpc('https://opensea.io', 'eth_requestAccounts')).toEqual(
      notReady,
    )
    expect(
      await rpc('https://opensea.io', 'personal_sign', ['0x00', '0x00']),
    ).toEqual(notReady)
    expect(state.pendingApprovals.size).toBe(0)
    // Unconnected origins still learn nothing.
    expect((await rpc('https://tracker.example.com', 'eth_accounts')).result).toEqual(
      [],
    )

    // Once Frank provisions the shared persona, a connect is queued; approving a per-site
    // persona without a custody-supplied address still fails explicitly.
    await sendRuntimeMessage<any, any>(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'update-persona-state',
        address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      },
      mockScope,
    )
    expect(
      (await rpc('https://app.uniswap.org', 'eth_accounts')).result,
    ).toEqual(['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'])
    const pendingConnect = rpc('https://opensea.io', 'eth_requestAccounts')
    await new Promise(resolve => setTimeout(resolve, 10))
    const approval = Array.from(state.pendingApprovals.values())[0]!
    const approveBurner = () =>
      sendRuntimeMessage<any, any>(
        {
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          type: 'companion-resolve-approval',
          requestId: approval.id,
          approved: true,
          useBurnerPersona: true,
        },
        mockScope,
      )
    expect((await approveBurner()).error).toEqual(DAPP_PERSONA_NOT_READY_ERROR)
    expect(state.originPersonas['https://opensea.io']).toBeUndefined()
    expect(state.pendingApprovals.has(approval.id)).toBe(true)
    // A web page cannot choose a site's persona address.
    const forged = await handleBackgroundMessage(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'provision-site-personas',
        sitePersonas: {
          'https://opensea.io': '0x000000000000000000000000000000000000dEaD',
        },
      },
      { tab: { id: 1, windowId: 2 }, url: 'https://opensea.io/' },
      state,
      mockScope,
    )
    expect(forged.error.code).toBe(4100)
    expect(state.sitePersonaAddresses['https://opensea.io']).toBeUndefined()
    // Frank provides the custody-derived site persona; the same request now connects.
    await sendRuntimeMessage<any, any>(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'provision-site-personas',
        sitePersonas: {
          'https://opensea.io': '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
        },
      },
      mockScope,
    )
    await approveBurner()
    expect((await pendingConnect).result).toEqual([
      '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    ])
    bg.dispose()
  })

  it('binds per-origin personas only to custody-supplied addresses and rejects with 4001 on user denial', async () => {
    // Frank's custody derives these (hardened, keyed by an account-private HMAC of the origin);
    // the extension only ever receives the addresses.
    const rootAddr = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
    const uniswapBurner = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359'
    const openseaBurner = '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB'

    const listeners: Array<
      (msg: any, sender: any, sendResponse: (res: any) => void) => any
    > = []
    const mockScope = {
      chrome: {
        runtime: {
          id: 'frank-test-ext',
          getURL: (p: string) => `chrome-extension://frank-test-ext/${p}`,
          sendMessage: (msg: any, cb?: (res: any) => void) => {
            for (const fn of listeners) {
              fn(msg, mockSenderFor(msg), (res: any) => {
                if (cb) cb(res)
              })
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
      },
    }
    const state = createBackgroundBridgeState({
      activePersonaAddress: rootAddr,
    })
    installBackgroundBridge(mockScope, state)

    // Site A connects with default per-origin burner persona (useBurnerPersona: true)
    const siteAConnectPromise = sendRuntimeMessage<any, any>(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'dapp-rpc-request',
        origin: 'https://app.uniswap.org',
        payload: { method: 'eth_requestAccounts' },
      },
      mockScope,
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    const siteAApproval = Array.from(state.pendingApprovals.values())[0]!
    // The background no longer computes a burner from public data.
    expect(siteAApproval.personaAddress).toBeUndefined()

    await sendRuntimeMessage<any, any>(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'companion-resolve-approval',
        requestId: siteAApproval.id,
        approved: true,
        useBurnerPersona: true,
        personaAddress: uniswapBurner,
      },
      mockScope,
    )
    const siteARes = await siteAConnectPromise
    expect(siteARes.result).toEqual([uniswapBurner])

    // Site B connects with default per-origin burner persona -> gets completely distinct EOA
    const siteBConnectPromise = sendRuntimeMessage<any, any>(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'dapp-rpc-request',
        origin: 'https://opensea.io',
        payload: { method: 'eth_requestAccounts' },
      },
      mockScope,
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    const siteBApproval = Array.from(state.pendingApprovals.values())[0]!
    await sendRuntimeMessage<any, any>(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'companion-resolve-approval',
        requestId: siteBApproval.id,
        approved: true,
        personaAddress: openseaBurner,
      },
      mockScope,
    )
    const siteBRes = await siteBConnectPromise
    expect(siteBRes.result).toEqual([openseaBurner])

    // Unapproved Site C continues to receive [] from eth_accounts
    const siteCAccounts = await sendRuntimeMessage<any, any>(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'dapp-rpc-request',
        origin: 'https://tracker.example.com',
        payload: { method: 'eth_accounts' },
      },
      mockScope,
    )
    expect(siteCAccounts.result).toEqual([])

    // Site C requests accounts and user REJECTS -> returns EIP-1193 4001 error
    const siteCConnectPromise = sendRuntimeMessage<any, any>(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'dapp-rpc-request',
        origin: 'https://tracker.example.com',
        payload: { method: 'eth_requestAccounts' },
      },
      mockScope,
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    const siteCApproval = Array.from(state.pendingApprovals.values())[0]!
    await sendRuntimeMessage<any, any>(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'companion-resolve-approval',
        requestId: siteCApproval.id,
        approved: false,
      },
      mockScope,
    )
    const siteCRes = await siteCConnectPromise
    expect(siteCRes.error).toEqual({
      code: 4001,
      message: 'User rejected the request.',
    })

    // Disconnect Site A -> subsequent eth_accounts for Site A returns []
    await sendRuntimeMessage<any, any>(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'disconnect-origin',
        origin: 'https://app.uniswap.org',
      },
      mockScope,
    )
    const siteAAfterDisconnect = await sendRuntimeMessage<any, any>(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'dapp-rpc-request',
        origin: 'https://app.uniswap.org',
        payload: { method: 'eth_accounts' },
      },
      mockScope,
    )
    expect(siteAAfterDisconnect.result).toEqual([])
  })

  it('enforces EIP-6963 announceMode privacy controls and generates ephemeral UUIDv4 per page load', async () => {
    const { shouldAnnounceEip6963Provider } = await import('./inpage')

    expect(shouldAnnounceEip6963Provider('always', false)).toBe(true)
    expect(shouldAnnounceEip6963Provider('always', true)).toBe(true)
    expect(shouldAnnounceEip6963Provider('connected-only', false)).toBe(false)
    expect(shouldAnnounceEip6963Provider('connected-only', true)).toBe(true)
    expect(shouldAnnounceEip6963Provider('stealth', false)).toBe(false)
    expect(shouldAnnounceEip6963Provider('stealth', true)).toBe(false)

    // Verify ephemeral UUIDv4 per page load (not a static cross-site fingerprint UUID)
    const makeFakeWin = (privacyConfig?: {
      announceMode: 'always' | 'connected-only' | 'stealth'
      originApproved: boolean
    }) => {
      const announced: any[] = []
      const win: any = {
        __FRANK_PRIVACY_CONFIG__: privacyConfig,
        addEventListener: jest.fn(),
        postMessage: jest.fn(),
        dispatchEvent: jest.fn((ev: Event) => {
          if (ev.type === 'eip6963:announceProvider') {
            announced.push((ev as CustomEvent).detail)
          }
          return true
        }),
      }
      return { win, announced }
    }

    const page1 = makeFakeWin({ announceMode: 'always', originApproved: false })
    const page2 = makeFakeWin({ announceMode: 'always', originApproved: false })
    installInpageProvider(page1.win)
    installInpageProvider(page2.win)

    expect(page1.announced).toHaveLength(1)
    expect(page2.announced).toHaveLength(1)
    expect(page1.announced[0].info.uuid).not.toBe(page2.announced[0].info.uuid)

    // Stealth mode suppresses EIP-6963 announcement completely
    const stealthPage = makeFakeWin({
      announceMode: 'stealth',
      originApproved: true,
    })
    installInpageProvider(stealthPage.win)
    expect(stealthPage.announced).toHaveLength(0)

    // Connected-only mode suppresses announcement on unapproved origins, allows on approved origins
    const unapprovedConnectedOnly = makeFakeWin({
      announceMode: 'connected-only',
      originApproved: false,
    })
    installInpageProvider(unapprovedConnectedOnly.win)
    expect(unapprovedConnectedOnly.announced).toHaveLength(0)

    const approvedConnectedOnly = makeFakeWin({
      announceMode: 'connected-only',
      originApproved: true,
    })
    installInpageProvider(approvedConnectedOnly.win)
    expect(approvedConnectedOnly.announced).toHaveLength(1)
  })

  it('registers no Bitcoin or Cashtab wallet, which Frank cannot back with an account', async () => {

    const listeners: Array<
      (msg: any, sender: any, sendResponse: (res: any) => void) => any
    > = []
    const mockScope = {
      chrome: {
        runtime: {
          id: 'frank-test-ext',
          getURL: (p: string) => `chrome-extension://frank-test-ext/${p}`,
          sendMessage: (msg: any, cb?: (res: any) => void) => {
            for (const fn of listeners) {
              fn(msg, mockSenderFor(msg), (res: any) => {
                if (cb) cb(res)
              })
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
      },
    }
    const bgState = createBackgroundBridgeState({
      activePersonaAddress: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    })
    const bg = installBackgroundBridge(mockScope, bgState)
    const cleanupContent = installContentScriptBridge(window as any, mockScope)

    const win = window as any
    delete win.__FRANK_INPAGE_PROVIDER_INSTALLED__
    delete win.frankEthereum
    delete win.frankBitcoin
    delete win.unisat
    delete win.wbip_providers
    installInpageProvider(win)
    expect(win.frankBitcoin).toBeUndefined()
    expect(win.unisat).toBeUndefined()
    expect(win.wbip_providers).toBeUndefined()

    // A Cashtab page request gets no answer and queues nothing.
    const cashtabResponses: any[] = []
    const cashtabListener = (ev: MessageEvent) => {
      if (ev.data?.type === 'FROM_CASHTAB') cashtabResponses.push(ev.data)
    }
    window.addEventListener('message', cashtabListener)
    window.postMessage({ type: 'FROM_PAGE', text: 'Cashtab', addressRequest: true }, '*')
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(cashtabResponses).toEqual([])
    expect(bgState.pendingApprovals.size).toBe(0)

    window.removeEventListener('message', cashtabListener)
    cleanupContent()
    bg.dispose()
  })
})
