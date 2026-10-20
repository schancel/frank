import {
  ExtensionLaunchMode,
  FRANK_EXT_LAUNCH_MODE_KEY,
  getRawExtensionApi,
  isBrowserExtensionRuntime,
  onRuntimeMessage,
  openCompanionPanel,
  openExtensionInWindow,
} from './runtime-adapter'
import { FRANK_DAPP_BRIDGE_CHANNEL } from './inpage'
import { FRANK_PWA_EXTENSION_SYNC_CHANNEL } from './content'

export interface PendingDappApproval {
  id: string
  origin: string
  href: string
  method: string
  params?: unknown
  createdAt: number
  requiresCompanionApproval: boolean
}

export interface SyncedExtensionState {
  sasCode: string
  deviceSyncBundle?: unknown
  syncedFromOrigin: string
  syncedAt: number
}

export interface BackgroundBridgeState {
  chainIdHex: string
  activePersonaAddress: string
  approvedOrigins: Set<string>
  pendingApprovals: Map<string, PendingDappApproval>
  syncedState: SyncedExtensionState | null
  openPanelOnActionClick: boolean
  launchMode: ExtensionLaunchMode
}

const APPROVAL_REQUIRED_METHODS = new Set([
  'personal_sign',
  'eth_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'eth_sendTransaction',
  'solana_connect',
  'solana_signMessage',
  'solana_signTransaction',
])

const CHAIN_RPC_URLS: Record<string, string> = {
  '0x1': 'https://eth.llamarpc.com',
  '0x279f': 'https://testnet-rpc.monad.xyz',
  '0x8f': 'https://rpc.monad.xyz',
  '0xa': 'https://mainnet.optimism.io',
  '0x89': 'https://polygon-rpc.com',
  '0x2105': 'https://mainnet.base.org',
  '0xa4b1': 'https://arb1.arbitrum.io/rpc',
  '0x38': 'https://bsc-dataseed.binance.org',
  '0xa86a': 'https://api.avax.network/ext/bc/C/rpc',
  '0xaa36a7': 'https://ethereum-sepolia-rpc.publicnode.com',
}

const READONLY_RPC_METHODS = new Set([
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getTransactionCount',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getLogs',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
])

function getReadOnlyRpcFallback(method: string): unknown {
  switch (method) {
    case 'eth_blockNumber':
      return '0x1'
    case 'eth_getBalance':
    case 'eth_getTransactionCount':
      return '0x0'
    case 'eth_getCode':
    case 'eth_getStorageAt':
    case 'eth_call':
      return '0x'
    case 'eth_estimateGas':
      return '0x5208'
    case 'eth_gasPrice':
      return '0x3b9aca00'
    case 'eth_maxPriorityFeePerGas':
      return '0x59682f00'
    case 'eth_feeHistory':
      return {
        oldestBlock: '0x1',
        baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'],
        gasUsedRatio: [0.5],
        reward: [['0x59682f00']],
      }
    case 'eth_getLogs':
      return []
    default:
      return null
  }
}

async function forwardReadOnlyRpc(
  chainIdHex: string,
  method: string,
  params: unknown,
): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }> {
  const rpcUrl =
    CHAIN_RPC_URLS[chainIdHex.toLowerCase()] ?? CHAIN_RPC_URLS['0x279f']
  if (rpcUrl && typeof fetch === 'function') {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: Array.isArray(params) ? params : [],
        }),
      })
      if (response && response.ok) {
        const json = await response.json()
        if (json && typeof json === 'object') {
          if ('result' in json) {
            return { result: json.result }
          }
          if (json.error && typeof json.error === 'object') {
            return {
              error: {
                code:
                  typeof json.error.code === 'number'
                    ? json.error.code
                    : -32603,
                message: String(json.error.message || 'RPC error'),
                data: json.error.data,
              },
            }
          }
        }
      }
    } catch {
      // Fall back to safe offline response below
    }
  }
  return { result: getReadOnlyRpcFallback(method) }
}

export function createBackgroundBridgeState(
  overrides: Partial<BackgroundBridgeState> = {},
): BackgroundBridgeState {
  const launchMode: ExtensionLaunchMode =
    overrides.launchMode ??
    (overrides.openPanelOnActionClick ? 'sidepanel' : 'popup')
  return {
    chainIdHex: overrides.chainIdHex ?? '0x279f',
    activePersonaAddress:
      overrides.activePersonaAddress ??
      '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    approvedOrigins: overrides.approvedOrigins ?? new Set<string>(),
    pendingApprovals:
      overrides.pendingApprovals ?? new Map<string, PendingDappApproval>(),
    syncedState: overrides.syncedState ?? null,
    openPanelOnActionClick:
      overrides.openPanelOnActionClick ?? launchMode === 'sidepanel',
    launchMode,
  }
}

export function configureSidePanelBehavior(
  runtimeScope?: Record<string, any>,
  openPanelOnActionClick = false,
): boolean {
  const api = getRawExtensionApi(runtimeScope)
  if (
    api &&
    api.sidePanel &&
    typeof api.sidePanel.setPanelBehavior === 'function'
  ) {
    try {
      const maybePromise = api.sidePanel.setPanelBehavior({
        openPanelOnActionClick: Boolean(openPanelOnActionClick),
      })
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {})
      }
      return true
    } catch {
      return false
    }
  }
  return false
}

/**
 * Cross-Browser Extension Renderer Process & JS Bytecode Cache Keepalive
 *
 * Why extension popups (such as MetaMask or Phantom) traditionally suffer from 1–2s open latency:
 * 1. When the user closes an extension popup (`index.html?extMode=popup`) and no other HTML
 *    document from the extension origin is open, the browser's reference count for the extension
 *    renderer process drops to `0`. Chromium immediately terminates the `chrome-extension://<id>`
 *    renderer process (`SiteInstance`) and discards its `Blink::MemoryCache` and V8 Isolate;
 *    Safari (WebKit) and Firefox (Gecko) similarly evict transient popup documents and their
 *    compiled script caches. On the next toolbar click, the browser has to cold-spawn a renderer
 *    process and re-parse/re-compile several megabytes of JS from scratch.
 * 2. In addition, synchronous `<script type="module">` tags in `<head>` block `window.onload`
 *    until the entire static import graph finishes evaluating, preventing the browser from even
 *    painting the popup rectangle until JS execution completes.
 *
 * How we keep popup opens instantaneous across Chrome, Safari, and Firefox:
 * - `build-extension.mjs` transforms `index.html` so the 400x600 popup shell paints in `< 10ms`
 *   and defers the entry `import()` until after `window.onload` + `requestAnimationFrame`.
 * - `ensureOffscreenWarmup()` pins a lightweight `offscreen.html` document (which preloads all
 *   split `./assets/*.js` and `./assets/*.css` chunks without mounting `#q-app`) in the shared
 *   extension renderer process:
 *     a) Chromium (Chrome / Brave / Edge): `background.js` runs in a Service Worker without a DOM,
 *        so we use `chrome.offscreen.createDocument({ url: 'offscreen.html', ... })` to keep an
 *        offscreen document alive in the exact same `SiteInstance`, V8 Isolate, and `MemoryCache`
 *        as the popup.
 *     b) Safari (WebKit / JavaScriptCore) & Firefox (Gecko / SpiderMonkey): when `chrome.offscreen`
 *        is unavailable and a background DOM document exists (`_generated_background_page.html`),
 *        we append a hidden `<iframe id="frank-warmup-frame" src="offscreen.html">` into
 *        `document.body`. Because the background page shares the `safari-web-extension://<id>` /
 *        `moz-extension://<id>` WebContent process, preloading `offscreen.html` inside it keeps
 *        all parsed ES modules and JSC/SpiderMonkey bytecode warm in RAM between popup clicks.
 */
export async function ensureOffscreenWarmup(
  runtimeScope?: Record<string, any>,
): Promise<boolean> {
  const scope =
    runtimeScope ??
    (typeof globalThis !== 'undefined'
      ? (globalThis as Record<string, any>)
      : {})
  const api = getRawExtensionApi(scope)

  // 1. Chromium MV3 Offscreen Document API (Service Worker background context)
  if (
    api &&
    api.offscreen &&
    typeof api.offscreen.createDocument === 'function'
  ) {
    try {
      if (typeof api.offscreen.hasDocument === 'function') {
        const exists = await api.offscreen.hasDocument()
        if (exists) {
          return true
        }
      }
      await api.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_PARSER'],
        justification:
          'Keep extension renderer process and V8 module cache warm for instant popup open',
      })
      return true
    } catch {
      return false
    }
  }

  // 2. Safari (WebKit) & Firefox (Gecko) background DOM window fallback (<iframe id="frank-warmup-frame">)
  const doc =
    scope.document ??
    (typeof document !== 'undefined' ? document : undefined)
  if (doc && typeof doc.createElement === 'function') {
    const container = doc.body ?? doc.documentElement
    if (container && typeof container.appendChild === 'function') {
      try {
        const existing =
          typeof doc.getElementById === 'function'
            ? doc.getElementById('frank-warmup-frame')
            : null
        if (existing) {
          return true
        }
        const iframe = doc.createElement('iframe')
        iframe.id = 'frank-warmup-frame'
        const warmupUrl =
          api && typeof api.runtime?.getURL === 'function'
            ? String(api.runtime.getURL('offscreen.html'))
            : 'offscreen.html'
        iframe.src = warmupUrl
        if (iframe.style) {
          iframe.style.display = 'none'
          iframe.style.width = '0'
          iframe.style.height = '0'
          iframe.style.border = '0'
        }
        if (typeof iframe.setAttribute === 'function') {
          iframe.setAttribute(
            'style',
            'display:none;width:0;height:0;border:0',
          )
          iframe.setAttribute('aria-hidden', 'true')
        }
        container.appendChild(iframe)
        return true
      } catch {
        return false
      }
    }
  }

  return false
}

export async function reinjectContentScriptsIntoOpenTabs(
  runtimeScope?: Record<string, any>,
): Promise<number> {
  const api = getRawExtensionApi(runtimeScope)
  if (
    !api?.tabs ||
    typeof api.tabs.query !== 'function' ||
    typeof api?.scripting?.executeScript !== 'function'
  ) {
    return 0
  }
  let reinjectedCount = 0
  try {
    const tabs = await api.tabs.query({})
    if (!Array.isArray(tabs)) return 0
    for (const tab of tabs) {
      if (!tab || typeof tab.id !== 'number') continue
      const url = typeof tab.url === 'string' ? tab.url : ''
      if (
        url &&
        !url.startsWith('https://') &&
        !url.startsWith('http://localhost') &&
        !url.startsWith('http://127.0.0.1')
      ) {
        continue
      }
      try {
        await Promise.resolve(
          api.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js'],
          }),
        ).catch(() => {})
        await Promise.resolve(
          api.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['inpage.js'],
            world: 'MAIN',
          }),
        ).catch(() => {})
        reinjectedCount += 1
      } catch {
        // Ignore tabs where scripting is restricted
      }
    }
  } catch {
    // Ignore tab query errors
  }
  return reinjectedCount
}

export function installBackgroundBridge(
  runtimeScope?: Record<string, any>,
  state: BackgroundBridgeState = createBackgroundBridgeState(),
): {
  state: BackgroundBridgeState
  dispose: () => void
} {
  configureSidePanelBehavior(runtimeScope, state.openPanelOnActionClick)
  void ensureOffscreenWarmup(runtimeScope)
  void reinjectContentScriptsIntoOpenTabs(runtimeScope)

  const api = getRawExtensionApi(runtimeScope)
  if (api?.storage?.local?.get) {
    try {
      const maybeStored = api.storage.local.get([
        'frankOpenPanelOnActionClick',
        FRANK_EXT_LAUNCH_MODE_KEY,
        'frankSyncedState',
        'frankActivePersonaAddress',
        'frankApprovedOrigins',
        'frankChainIdHex',
      ])
      if (maybeStored && typeof maybeStored.then === 'function') {
        maybeStored
          .then((stored: Record<string, any> | undefined) => {
            if (!stored) return
            const storedMode = stored[FRANK_EXT_LAUNCH_MODE_KEY]
            if (
              storedMode === 'popup' ||
              storedMode === 'sidepanel' ||
              storedMode === 'window'
            ) {
              state.launchMode = storedMode
            }
            if (typeof stored.frankOpenPanelOnActionClick === 'boolean') {
              state.openPanelOnActionClick = stored.frankOpenPanelOnActionClick
              if (stored.frankOpenPanelOnActionClick && !storedMode) {
                state.launchMode = 'sidepanel'
              }
              configureSidePanelBehavior(
                runtimeScope,
                state.openPanelOnActionClick,
              )
            } else if (storedMode === 'sidepanel') {
              state.openPanelOnActionClick = true
              configureSidePanelBehavior(runtimeScope, true)
            }
            if (stored.frankSyncedState && !state.syncedState) {
              state.syncedState = stored.frankSyncedState
              const syncedAddr =
                (stored.frankSyncedState.deviceSyncBundle as any)
                  ?.activePersonaAddress ||
                (stored.frankSyncedState.deviceSyncBundle as any)
                  ?.accountAddress
              if (
                typeof syncedAddr === 'string' &&
                /^0x[a-fA-F0-9]{40}$/.test(syncedAddr)
              ) {
                state.activePersonaAddress = syncedAddr
              }
            }
            if (
              typeof stored.frankActivePersonaAddress === 'string' &&
              /^0x[a-fA-F0-9]{40}$/.test(stored.frankActivePersonaAddress)
            ) {
              state.activePersonaAddress = stored.frankActivePersonaAddress
            }
            if (Array.isArray(stored.frankApprovedOrigins)) {
              for (const orig of stored.frankApprovedOrigins) {
                if (typeof orig === 'string' && orig) {
                  state.approvedOrigins.add(orig)
                }
              }
            }
            if (
              typeof stored.frankChainIdHex === 'string' &&
              /^0x[0-9a-fA-F]+$/.test(stored.frankChainIdHex)
            ) {
              state.chainIdHex = stored.frankChainIdHex.toLowerCase()
            }
          })
          .catch(() => {})
      }
    } catch {
      // Ignore storage read errors in restricted environments
    }
  }

  const unsubscribe = onRuntimeMessage(async (message: any, sender: any) => {
    if (!message || typeof message !== 'object') {
      return undefined
    }

    if (
      message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
      message.type === 'get-bridge-state'
    ) {
      return {
        result: {
          ok: true,
          chainIdHex: state.chainIdHex,
          activePersonaAddress: state.activePersonaAddress,
          approvedOrigins: Array.from(state.approvedOrigins),
          pendingApprovals: Array.from(state.pendingApprovals.values()),
          launchMode: state.launchMode,
          openPanelOnActionClick: state.openPanelOnActionClick,
        },
      }
    }

    if (
      message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
      message.type === 'set-active-persona'
    ) {
      const nextAddr = String(message.address ?? '').trim()
      if (/^0x[a-fA-F0-9]{40}$/.test(nextAddr)) {
        state.activePersonaAddress = nextAddr
        const extApi = getRawExtensionApi(runtimeScope)
        if (extApi?.storage?.local?.set) {
          try {
            await extApi.storage.local.set({
              frankActivePersonaAddress: nextAddr,
            })
          } catch {
            // Ignore storage errors
          }
        }
      }
      return {
        result: {
          ok: true,
          activePersonaAddress: state.activePersonaAddress,
        },
      }
    }

    if (
      message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
      message.type === 'set-sidepanel-behavior'
    ) {
      const enabled = Boolean(message.openPanelOnActionClick)
      state.openPanelOnActionClick = enabled
      state.launchMode = enabled ? 'sidepanel' : 'popup'
      const configured = configureSidePanelBehavior(runtimeScope, enabled)
      const extApi = getRawExtensionApi(runtimeScope)
      if (extApi?.storage?.local?.set) {
        try {
          await extApi.storage.local.set({
            frankOpenPanelOnActionClick: enabled,
            [FRANK_EXT_LAUNCH_MODE_KEY]: state.launchMode,
          })
        } catch {
          // Ignore storage errors
        }
      }
      return {
        result: {
          ok: true,
          configured,
          openPanelOnActionClick: enabled,
          launchMode: state.launchMode,
        },
      }
    }

    if (
      message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
      message.type === 'get-sidepanel-behavior'
    ) {
      return {
        result: {
          ok: true,
          openPanelOnActionClick: state.openPanelOnActionClick,
          launchMode: state.launchMode,
        },
      }
    }

    if (
      message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
      message.type === 'set-launch-mode'
    ) {
      const mode: ExtensionLaunchMode =
        message.launchMode === 'sidepanel' || message.launchMode === 'window'
          ? message.launchMode
          : 'popup'
      state.launchMode = mode
      state.openPanelOnActionClick = mode === 'sidepanel'
      const configured = configureSidePanelBehavior(
        runtimeScope,
        state.openPanelOnActionClick,
      )
      const extApi = getRawExtensionApi(runtimeScope)
      if (extApi?.storage?.local?.set) {
        try {
          await extApi.storage.local.set({
            [FRANK_EXT_LAUNCH_MODE_KEY]: mode,
            frankOpenPanelOnActionClick: state.openPanelOnActionClick,
          })
        } catch {
          // Ignore storage errors
        }
      }
      if (message.openNow) {
        if (mode === 'sidepanel') {
          await openCompanionPanel(
            {
              windowId: message.windowId ?? sender?.tab?.windowId,
              tabId: message.tabId ?? sender?.tab?.id,
            },
            runtimeScope,
          )
        } else if (mode === 'window') {
          await openExtensionInWindow(message.options ?? {}, runtimeScope)
        }
      }
      return {
        result: {
          ok: true,
          configured,
          launchMode: state.launchMode,
          openPanelOnActionClick: state.openPanelOnActionClick,
        },
      }
    }

    if (
      message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
      message.type === 'open-extension-window'
    ) {
      state.launchMode = 'window'
      const res = await openExtensionInWindow(
        message.options ?? {},
        runtimeScope,
      )
      return {
        result: {
          ok: res.opened,
          ...res,
          launchMode: state.launchMode,
        },
      }
    }

    if (
      message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
      message.type === 'dapp-rpc-request'
    ) {
      const method = String(message.payload?.method ?? '')
      const params = message.payload?.params
      const origin = String(message.origin ?? sender?.origin ?? '')
      const href = String(message.href ?? sender?.url ?? '')
      const id = String(message.id ?? `req-${Date.now()}`)

      if (method === 'eth_chainId') {
        return { result: state.chainIdHex }
      }

      if (method === 'net_version') {
        return { result: String(parseInt(state.chainIdHex, 16)) }
      }

      if (method === 'web3_clientVersion') {
        return { result: 'FrankWallet/0.3.0' }
      }

      if (method === 'eth_accounts') {
        return {
          result: state.approvedOrigins.has(origin)
            ? [state.activePersonaAddress]
            : [],
        }
      }

      if (
        method === 'eth_requestAccounts' &&
        !message.payload?.requireExplicitCompanionApproval
      ) {
        if (origin) {
          state.approvedOrigins.add(origin)
          const extApi = getRawExtensionApi(runtimeScope)
          if (extApi?.storage?.local?.set) {
            try {
              await extApi.storage.local.set({
                frankApprovedOrigins: Array.from(state.approvedOrigins),
              })
            } catch {
              // Ignore storage errors
            }
          }
        }
        return { result: [state.activePersonaAddress] }
      }

      if (method === 'wallet_requestPermissions') {
        if (origin) {
          state.approvedOrigins.add(origin)
          const extApi = getRawExtensionApi(runtimeScope)
          if (extApi?.storage?.local?.set) {
            try {
              await extApi.storage.local.set({
                frankApprovedOrigins: Array.from(state.approvedOrigins),
              })
            } catch {
              // Ignore storage errors
            }
          }
        }
        return {
          result: [
            {
              invoker: origin,
              parentCapability: 'eth_accounts',
              caveats: [
                {
                  type: 'restrictReturnedAccounts',
                  value: [state.activePersonaAddress],
                },
              ],
            },
          ],
        }
      }

      if (method === 'wallet_getPermissions') {
        return {
          result: state.approvedOrigins.has(origin)
            ? [
                {
                  invoker: origin,
                  parentCapability: 'eth_accounts',
                  caveats: [
                    {
                      type: 'restrictReturnedAccounts',
                      value: [state.activePersonaAddress],
                    },
                  ],
                },
              ]
            : [],
        }
      }

      if (method === 'wallet_revokePermissions') {
        if (origin) {
          state.approvedOrigins.delete(origin)
        }
        return { result: null }
      }

      if (
        method === 'wallet_switchEthereumChain' ||
        method === 'wallet_addEthereumChain'
      ) {
        const rawChainId = Array.isArray(params)
          ? (params[0] as any)?.chainId
          : (params as any)?.chainId
        if (
          typeof rawChainId === 'string' &&
          /^0x[0-9a-fA-F]+$/.test(rawChainId.trim())
        ) {
          const normalized =
            '0x' + parseInt(rawChainId.trim(), 16).toString(16)
          state.chainIdHex = normalized
          const extApi = getRawExtensionApi(runtimeScope)
          if (extApi?.storage?.local?.set) {
            try {
              await extApi.storage.local.set({
                frankChainIdHex: normalized,
              })
            } catch {
              // Ignore storage errors
            }
          }
          return { result: null }
        }
        return {
          error: {
            code: -32602,
            message: 'Invalid chainId parameter',
          },
        }
      }

      if (method === 'wallet_watchAsset') {
        return { result: true }
      }

      if (READONLY_RPC_METHODS.has(method)) {
        return await forwardReadOnlyRpc(state.chainIdHex, method, params)
      }

      if (
        APPROVAL_REQUIRED_METHODS.has(method) ||
        method === 'eth_requestAccounts'
      ) {
        const pending: PendingDappApproval = {
          id,
          origin,
          href,
          method,
          params,
          createdAt: Date.now(),
          requiresCompanionApproval: true,
        }
        state.pendingApprovals.set(id, pending)

        await openCompanionPanel(
          {
            windowId: sender?.tab?.windowId,
            tabId: sender?.tab?.id,
          },
          runtimeScope,
        )

        return {
          result: {
            status: 'pending_approval',
            requestId: id,
            origin,
            method,
          },
        }
      }

      return {
        error: {
          code: 4200,
          message: `Unsupported method: ${method}`,
        },
      }
    }

    if (
      message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
      message.type === 'companion-resolve-approval'
    ) {
      const requestId = String(message.requestId ?? '')
      const pending = state.pendingApprovals.get(requestId)
      if (!pending) {
        return {
          error: {
            code: 4004,
            message: `Unknown approval request: ${requestId}`,
          },
        }
      }
      state.pendingApprovals.delete(requestId)
      if (message.approved) {
        if (
          pending.method === 'eth_requestAccounts' ||
          pending.method === 'solana_connect'
        ) {
          state.approvedOrigins.add(pending.origin)
        }
        return {
          result: {
            requestId,
            approved: true,
            origin: pending.origin,
            accounts: [state.activePersonaAddress],
          },
        }
      }
      return {
        error: {
          code: 4001,
          message: 'User rejected the request in Frank Companion',
        },
      }
    }

    if (message.channel === FRANK_PWA_EXTENSION_SYNC_CHANNEL) {
      const extApi = getRawExtensionApi(runtimeScope)

      if (
        message.type === 'get-synced-state' ||
        message.type === 'pwa-request-sync'
      ) {
        if (!state.syncedState && extApi?.storage?.local?.get) {
          try {
            const stored = await extApi.storage.local.get('frankSyncedState')
            if (stored?.frankSyncedState) {
              state.syncedState = stored.frankSyncedState
            }
          } catch {
            // Ignore storage errors
          }
        }
        return {
          result: {
            ok: Boolean(state.syncedState),
            syncedState: state.syncedState,
            sasCode: state.syncedState?.sasCode ?? null,
            deviceSyncBundle: state.syncedState?.deviceSyncBundle ?? null,
          },
        }
      }

      const sasCode = String(message.payload?.sasCode ?? '482910')
      const origin = String(
        message.origin ??
          (message.type === 'extension-push-sync-to-tab'
            ? 'frank-extension'
            : 'https://signet.mx'),
      )
      state.syncedState = {
        sasCode,
        deviceSyncBundle: message.payload?.deviceSyncBundle,
        syncedFromOrigin: origin,
        syncedAt: Date.now(),
      }

      if (extApi?.storage?.local?.set) {
        try {
          await extApi.storage.local.set({
            frankSyncedState: state.syncedState,
          })
        } catch {
          // Ignore storage errors in ephemeral environments
        }
      }

      let pushedToTabCount = 0
      if (
        message.type === 'extension-push-sync-to-tab' &&
        extApi?.tabs &&
        typeof extApi.tabs.query === 'function'
      ) {
        try {
          let tabs = await extApi.tabs.query({})
          if (!Array.isArray(tabs) || tabs.length === 0) {
            tabs = await extApi.tabs.query({ currentWindow: true })
          }
          if (Array.isArray(tabs)) {
            for (const tab of tabs) {
              if (tab && typeof tab.id === 'number') {
                let sendMessageSucceeded = false
                let contentAcked = false
                if (typeof extApi.tabs.sendMessage === 'function') {
                  try {
                    const res = await extApi.tabs.sendMessage(tab.id, {
                      channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
                      type: 'extension-sync-push',
                      payload: state.syncedState,
                    })
                    sendMessageSucceeded = true
                    if (res && typeof res === 'object' && res.ok) {
                      contentAcked = true
                    }
                  } catch {
                    // Tab may have been opened before extension reload (no content script listening yet)
                  }
                }
                let scriptInjected = false
                if (
                  !contentAcked &&
                  typeof extApi?.scripting?.executeScript === 'function'
                ) {
                  try {
                    await Promise.resolve(
                      extApi.scripting.executeScript({
                        target: { tabId: tab.id },
                        files: ['content.js'],
                      }),
                    ).catch(() => {})
                    await extApi.scripting.executeScript({
                      target: { tabId: tab.id },
                      func: (msg: unknown) => {
                        window.postMessage(msg, '*')
                      },
                      args: [
                        {
                          channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
                          direction: 'to-pwa',
                          type: 'extension-sync-push',
                          payload: state.syncedState,
                        },
                      ],
                    })
                    scriptInjected = true
                  } catch {
                    // Scripting not permitted on restricted URLs (e.g. chrome://)
                  }
                }
                if (contentAcked || scriptInjected || sendMessageSucceeded) {
                  pushedToTabCount += 1
                }
              }
            }
          }
        } catch {
          // Ignore tab query errors
        }
      }

      return {
        result: {
          ok: true,
          sasCode,
          syncedFromOrigin: origin,
          syncedAt: state.syncedState.syncedAt,
          syncedState: state.syncedState,
          pushedToTabCount,
        },
      }
    }

    return undefined
  }, runtimeScope)

  return {
    state,
    dispose: unsubscribe,
  }
}

if (typeof globalThis !== 'undefined' && isBrowserExtensionRuntime()) {
  installBackgroundBridge(globalThis as Record<string, any>)
}

