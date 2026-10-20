/** @jest-environment jsdom */

import { buildExtensionManifest } from './manifests'
import {
  FRANK_EXT_LAUNCH_MODE_KEY,
  getExtensionRuntime,
  isBrowserExtensionRuntime,
  onRuntimeMessage,
  openCompanionPanel,
  openExtensionInWindow,
  sendRuntimeMessage,
} from './runtime-adapter'
import {
  FRANK_DAPP_BRIDGE_CHANNEL,
  FRANK_EIP6963_INFO,
  installInpageProvider,
} from './inpage'
import {
  ensureSafariFallbackInpageScript,
  FRANK_PWA_EXTENSION_SYNC_CHANNEL,
  installContentScriptBridge,
  isAllowedSyncOrigin,
} from './content'
import {
  createBackgroundBridgeState,
  ensureOffscreenWarmup,
  installBackgroundBridge,
} from './background'

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
    ])
    expect(manifest.background).toEqual({
      service_worker: 'background.js',
      type: 'module',
    })
    expect(manifest.side_panel).toEqual({
      default_path: 'index.html?extMode=sidepanel',
    })
    expect(manifest.action).toEqual({
      default_popup: 'index.html?extMode=popup',
      default_title: 'Frank',
    })
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
    expect(manifest.permissions).toEqual(['storage', 'activeTab', 'scripting'])
    expect(manifest.background).toEqual({
      scripts: ['background.js'],
      type: 'module',
    })
    expect(manifest.sidebar_action).toEqual({
      default_panel: 'index.html?extMode=sidebar',
      default_title: 'Frank',
      default_icon: 'icons/icon-128x128.png',
    })
  })

  it('builds Safari MV3 manifest with service_worker background and web_accessible_resources for inpage.js fallback', () => {
    const manifest = buildExtensionManifest('safari', '0.3.0')
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.permissions).toEqual(['storage', 'activeTab', 'scripting'])
    expect(manifest.background).toEqual({
      service_worker: 'background.js',
    })
    expect(manifest.content_security_policy).toEqual({
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    })
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

  it('injects idempotent EIP-1193 + EIP-6963 + Solana Wallet Standard provider and routes RPC + PWA sync end-to-end', async () => {
    const listeners: Array<
      (msg: any, sender: any, sendResponse: (res: any) => void) => any
    > = []
    const setPanelBehavior = jest.fn().mockResolvedValue(undefined)
    const sidePanelOpen = jest.fn().mockResolvedValue(undefined)
    const storageSet = jest.fn().mockResolvedValue(undefined)

    const mockExtensionScope = {
      chrome: {
        runtime: {
          id: 'frank-test-ext',
          getURL: (p: string) => `chrome-extension://frank-test-ext/${p}`,
          sendMessage: (msg: any, cb?: (res: any) => void) => {
            for (const fn of listeners) {
              fn(msg, { tab: { id: 1, windowId: 2 } }, (res: any) => {
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
        storage: {
          local: {
            set: storageSet,
          },
        },
      },
    }

    const bgState = createBackgroundBridgeState({
      chainIdHex: '0x279f',
      activePersonaAddress: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    })
    const bg = installBackgroundBridge(mockExtensionScope, bgState)
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
    expect(announced[0].info).toEqual(FRANK_EIP6963_INFO)

    const chainId = await p1!.request({ method: 'eth_chainId' })
    expect(chainId).toBe('0x279f')

    // EIP-1193 eth_requestAccounts resolves directly to string[] for Uniswap/wagmi compatibility
    const connectEvents: any[] = []
    const accountsChangedEvents: any[] = []
    p1!.on('connect', (info: any) => connectEvents.push(info))
    p1!.on('accountsChanged', (accs: any) => accountsChangedEvents.push(accs))

    const accounts = await p1!.request<string[]>({
      method: 'eth_requestAccounts',
    })
    expect(accounts).toEqual(['0x71C7656EC7ab88b098defB751B7401B5f6d8976F'])
    expect(p1!.selectedAddress).toBe(
      '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    )
    expect(connectEvents).toEqual([{ chainId: '0x279f' }])
    expect(accountsChangedEvents).toEqual([
      ['0x71C7656EC7ab88b098defB751B7401B5f6d8976F'],
    ])

    // Subsequent eth_accounts returns the approved account list
    const ethAccounts = await p1!.request<string[]>({ method: 'eth_accounts' })
    expect(ethAccounts).toEqual([
      '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
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

    // Signing requests queue in background and open companion panel
    const signRes = await p1!.request<any>({
      method: 'personal_sign',
      params: ['0x48656c6c6f', '0x71C7656EC7ab88b098defB751B7401B5f6d8976F'],
    })
    expect(signRes.status).toBe('pending_approval')
    expect(sidePanelOpen).toHaveBeenCalled()
    expect(bgState.pendingApprovals.size).toBe(1)

    // Approve request via companion message
    const resolved = await sendRuntimeMessage<any, any>(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'companion-resolve-approval',
        requestId: signRes.requestId,
        approved: true,
      },
      mockExtensionScope,
    )
    expect(resolved.result.approved).toBe(true)
    expect(resolved.result.accounts).toEqual([
      '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    ])

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

    // Test PWA <-> Extension sync origin validation and handshake (#1710)
    expect(
      isAllowedSyncOrigin({ protocol: 'https:', hostname: 'signet.mx' }),
    ).toBe(true)
    expect(
      isAllowedSyncOrigin({ protocol: 'http:', hostname: 'localhost' }),
    ).toBe(true)
    expect(
      isAllowedSyncOrigin({ protocol: 'https:', hostname: 'evil.example.com' }),
    ).toBe(false)

    const syncRes = await sendRuntimeMessage<any, any>(
      {
        channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
        type: 'pwa-sync-handshake',
        origin: 'https://signet.mx',
        payload: {
          sasCode: '918273',
          deviceSyncBundle: { version: 1 },
        },
      },
      mockExtensionScope,
    )
    expect(syncRes.result.ok).toBe(true)
    expect(bgState.syncedState?.sasCode).toBe('918273')
    expect(storageSet).toHaveBeenCalled()

    // Test pulling synced state via pwa-request-sync
    const pulled = await sendRuntimeMessage<any, any>(
      {
        channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
        type: 'pwa-request-sync',
      },
      mockExtensionScope,
    )
    expect(pulled.result.ok).toBe(true)
    expect(pulled.result.sasCode).toBe('918273')

    // Test toggling sidePanel action click behavior
    const toggleSidePanelRes = await sendRuntimeMessage<any, any>(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'set-sidepanel-behavior',
        openPanelOnActionClick: true,
      },
      mockExtensionScope,
    )
    expect(toggleSidePanelRes.result.ok).toBe(true)
    expect(toggleSidePanelRes.result.openPanelOnActionClick).toBe(true)
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
      expect(transformedHtml).toContain(
        'html, body { width: 400px; height: 600px; margin: 0; padding: 0; }',
      )
      expect(transformedHtml).toContain('requestAnimationFrame')
      expect(transformedHtml).toContain("import('./assets/index-AbCd1234.js')")
      expect(bootScript).toContain("window.addEventListener('load'")
      expect(bootScript).toContain('requestAnimationFrame')
      expect(bootScript).toContain("import('./assets/index-AbCd1234.js')")
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('opens persistent standalone extension window (with tab fallback) and persists launch mode preference', async () => {
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

    const winRes = await openExtensionInWindow({}, chromeScope)
    expect(winRes).toEqual({
      opened: true,
      mode: 'window',
      url: 'chrome-extension://frank-ext/index.html?extMode=window',
    })
    expect(windowsCreate).toHaveBeenCalledWith({
      url: 'chrome-extension://frank-ext/index.html?extMode=window',
      type: 'popup',
      width: 440,
      height: 740,
    })
    expect(storageSet).toHaveBeenCalledWith({
      [FRANK_EXT_LAUNCH_MODE_KEY]: 'window',
    })

    // SidePanel open persists sidepanel launch mode and enables openPanelOnActionClick
    const panelRes = await openCompanionPanel({}, chromeScope)
    expect(panelRes).toEqual({
      opened: true,
      mode: 'sidePanel',
    })
    expect(setPanelBehavior).toHaveBeenCalledWith({
      openPanelOnActionClick: true,
    })
    expect(sidePanelOpen).toHaveBeenCalledWith({ windowId: 42 })
    expect(storageSet).toHaveBeenCalledWith({
      [FRANK_EXT_LAUNCH_MODE_KEY]: 'sidepanel',
      frankOpenPanelOnActionClick: true,
    })

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
    const tabRes = await openExtensionInWindow({}, tabFallbackScope)
    expect(tabRes).toEqual({
      opened: true,
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
      resolveManualChunk('/repo/node_modules/vue/dist/vue.runtime.esm-bundler.js'),
    ).toBe('vendor-vue')
    expect(
      resolveManualChunk('/repo/node_modules/pinia/dist/pinia.mjs'),
    ).toBe('vendor-vue')
    expect(
      resolveManualChunk('/repo/node_modules/quasar/src/components/btn/QBtn.js'),
    ).toBe('vendor-quasar')
    expect(
      resolveManualChunk('/repo/node_modules/ethers/lib.esm/index.js'),
    ).toBe('vendor-ethers')
    expect(
      resolveManualChunk('/repo/node_modules/@noble/curves/secp256k1.js'),
    ).toBe('vendor-noble')
    expect(
      resolveManualChunk('/repo/node_modules/level-js/index.js'),
    ).toBe('vendor-storage')
    expect(
      resolveManualChunk('/repo/node_modules/@solana/web3.js/lib/index.browser.esm.js'),
    ).toBe('vendor-solana')
    expect(
      resolveManualChunk('/repo/packages/bitcore-lib-xpi/index.js'),
    ).toBe('vendor-utxo')
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
          sendMessage: (msg: any, cb?: (res: any) => void) => {
            for (const fn of listeners) {
              fn(msg, { tab: { id: 1, windowId: 2 } }, (res: any) => {
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
})


