/** @jest-environment jsdom */

import { buildExtensionManifest } from './manifests'
import {
  getExtensionRuntime,
  isBrowserExtensionRuntime,
  onRuntimeMessage,
  openCompanionPanel,
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

  it('builds Safari MV3 manifest with non-persistent background and web_accessible_resources for inpage.js fallback', () => {
    const manifest = buildExtensionManifest('safari', '0.3.0')
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.permissions).toEqual(['storage', 'activeTab', 'scripting'])
    expect(manifest.background).toEqual({
      service_worker: 'background.js',
      scripts: ['background.js'],
      type: 'module',
      persistent: false,
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

    // Request requiring approval queues in background and opens companion panel
    const connectRes = await p1!.request<any>({
      method: 'eth_requestAccounts',
    })
    expect(connectRes.status).toBe('pending_approval')
    expect(sidePanelOpen).toHaveBeenCalled()
    expect(bgState.pendingApprovals.size).toBe(1)

    // Approve request via companion message
    const resolved = await sendRuntimeMessage<any, any>(
      {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'companion-resolve-approval',
        requestId: connectRes.requestId,
        approved: true,
      },
      mockExtensionScope,
    )
    expect(resolved.result.approved).toBe(true)
    expect(resolved.result.accounts).toEqual([
      '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    ])

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

    cleanupContent()
    bg.dispose()
  })
})
