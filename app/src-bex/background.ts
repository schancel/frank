import {
  ExtensionLaunchMode,
  FRANK_DAPP_APPROVALS_CHANGED,
  FRANK_DAPP_BRIDGE_CHANNEL,
  FRANK_DAPP_PROVISION_SITE_PERSONAS,
  FRANK_EXT_LAUNCH_MODE_KEY,
  FRANK_PWA_EXTENSION_SYNC_CHANNEL,
  FRANK_SYNC_NAVIGATION_TIMEOUT_MS,
  type SyncSenderNavigationResult,
  getRawExtensionApi,
  isBrowserExtensionRuntime,
  isFrankWebAppOrigin,
  onRuntimeMessage,
  focusOrOpenMainExtensionWindow,
  openCompanionPanel,
  parseExtensionLaunchMode,
} from './runtime-adapter'
import { EXTENSION_POPUP_PATH } from './manifests'
import {
  createSyncSender,
  syncSenderConfirm,
  syncSenderExpired,
  syncSenderHello,
  SYNC_PAIRING_TTL_MS,
  type SyncSenderState,
  type SyncHelloReply,
  type SyncConfirmReply,
} from '../src/utils/sync-pairing'
import { createApprovalWindow, type ApprovalWindow } from './approval-window'

export type DappProviderAnnounceMode = 'always' | 'connected-only' | 'stealth'

export interface OriginPersonaBinding {
  address: string
  index: number
  label: string
  isBurner: boolean
}

export interface PendingDappApproval {
  id: string
  kind?: 'connect' | 'sign' | 'transaction' | 'permissions'
  origin: string
  href: string
  method: string
  params?: unknown
  createdAt: number
  requiresCompanionApproval: boolean
  personaAddress?: string
  /** Frank's custody-derived per-site persona, once Frank has provided it. */
  suggestedBurnerAddress?: string
  primaryPersonaAddress?: string
}

export type PendingDappApprovalRecord = PendingDappApproval

/**
 * Account sync between the extension and the Frank web app (PIN pairing, see
 * src/utils/sync-pairing.ts). The background keeps, in memory only
 * (`storage.session` where the browser has it, so it outlives a stopped service
 * worker; otherwise the background's own state):
 *  - sender: the extension's own sending session (extension -> web app): the
 *    bundle and the PIN. It answers the web app tab's pairing messages and ends
 *    once the bundle is sent, after too many wrong PINs, or after
 *    SYNC_PAIRING_TTL_MS.
 *  - offerTab: the Frank web app tab offering its account (web app -> extension).
 *    It holds no secret; the background relays an extension page's pairing
 *    messages to that tab.
 */
export interface PendingSyncPairing {
  sender: SyncSenderState | null
  senderOfferId: string | null
  offerTab: { tabId: number; createdAt: number } | null
}

const SYNC_PAIRING_SESSION_KEY = 'frankSyncPairing'

export interface PendingRpcWaiter {
  resolve: (value: unknown) => void
  reject: (error: { code: number; message: string; data?: unknown }) => void
}

export interface BackgroundBridgeState {
  chainIdHex: string
  activePersonaAddress: string
  poolBalanceWeiHex?: string
  approvedOrigins: Set<string>
  connectedOrigins: Set<string>
  originPersonas: Record<string, OriginPersonaBinding>
  /** Custody-derived per-site persona addresses Frank provided, by canonical origin. */
  sitePersonaAddresses: Record<string, string>
  announceMode: DappProviderAnnounceMode
  pendingApprovals: Map<string, PendingDappApproval>
  pendingRpcWaiters: Map<string, PendingRpcWaiter>
  syncPairing: PendingSyncPairing
  /** The user's toolbar click choice (see FRANK_EXT_LAUNCH_MODE_KEY). */
  launchMode: ExtensionLaunchMode
  /** The approval window; created on the first request needing a decision. */
  approvalWindow?: ApprovalWindow
  /** Informational sync/unlock notice; never owns an approval request. */
  accountRequiredWindow?: ApprovalWindow
}

export type BackgroundDappState = BackgroundBridgeState

/** Methods that answer with the origin's persona address(es). */
const PERSONA_ADDRESS_METHODS = new Set([
  'eth_accounts',
  'eth_requestAccounts',
  'wallet_getPermissions',
  'wallet_requestPermissions',
])

const APPROVAL_REQUIRED_METHODS = new Set([
  'personal_sign',
  'eth_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'eth_sendTransaction',
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

export function normalizeBridgeOrigin(rawOrigin: string): string {
  if (typeof rawOrigin !== 'string') return ''
  const trimmed = rawOrigin.trim()
  if (!trimmed || trimmed.toLowerCase() === 'null') return ''
  try {
    const parsed = new URL(trimmed)
    const protocol = parsed.protocol.toLowerCase()
    if (
      protocol === 'https:' ||
      protocol === 'http:' ||
      protocol === 'chrome-extension:' ||
      protocol === 'moz-extension:' ||
      protocol === 'safari-web-extension:'
    ) {
      return parsed.origin.toLowerCase()
    }
    if (protocol === 'wc:') {
      return trimmed.toLowerCase()
    }
  } catch {
    // Fallback for custom scheme or test identifiers
  }
  return trimmed.toLowerCase()
}

export function isOriginConnected(
  state: BackgroundBridgeState,
  rawOrigin: string,
): boolean {
  const norm = normalizeBridgeOrigin(rawOrigin)
  if (!norm) return false
  return (
    state.approvedOrigins.has(norm) ||
    state.connectedOrigins.has(norm) ||
    Boolean(state.originPersonas[norm]) ||
    state.approvedOrigins.has(rawOrigin) ||
    state.connectedOrigins.has(rawOrigin)
  )
}

/**
 * The extension never derives persona keys or addresses: Frank's custody derives them and
 * provisions only the addresses. Until it has, persona requests fail with this error.
 */
export const DAPP_PERSONA_NOT_READY_ERROR = Object.freeze({
  code: 4900,
  message:
    'Sync or unlock Frank first. Your PWA login does not unlock the extension. Open Frank, sync or unlock your extension account, then retry connecting.',
})

function isPersonaAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value)
}

/** The persona address bound to an origin, else the shared persona; '' before provisioning. */
export function getOriginPersonaAddress(
  state: BackgroundBridgeState,
  rawOrigin: string,
): string {
  const norm = normalizeBridgeOrigin(rawOrigin)
  if (norm && isPersonaAddress(state.originPersonas[norm]?.address)) {
    return state.originPersonas[norm].address
  }
  if (rawOrigin && isPersonaAddress(state.originPersonas[rawOrigin]?.address)) {
    return state.originPersonas[rawOrigin].address
  }
  return isPersonaAddress(state.activePersonaAddress)
    ? state.activePersonaAddress
    : ''
}

/**
 * The address a connection would bind: the one Frank supplied with the decision, else the
 * provisioned per-site persona (burner) or shared persona. '' when Frank has not provided it.
 */
export function connectPersonaAddress(
  state: BackgroundBridgeState,
  normalizedOrigin: string,
  useBurner: boolean,
  suppliedAddress?: string,
): string {
  if (isPersonaAddress(suppliedAddress)) return suppliedAddress
  const address = useBurner
    ? state.sitePersonaAddresses[normalizedOrigin]
    : state.activePersonaAddress
  return isPersonaAddress(address) ? address : ''
}

export class DappPersonaNotReadyError extends Error {
  readonly code = DAPP_PERSONA_NOT_READY_ERROR.code
  constructor() {
    super(DAPP_PERSONA_NOT_READY_ERROR.message)
    this.name = 'DappPersonaNotReadyError'
  }
}

export function assignOriginPersona(
  state: BackgroundBridgeState,
  rawOrigin: string,
  options?: {
    useBurnerPersona?: boolean
    personaAddress?: string
    personaIndex?: number
    label?: string
  },
): OriginPersonaBinding {
  const norm =
    normalizeBridgeOrigin(rawOrigin) || rawOrigin.trim().toLowerCase()
  const useBurner =
    options?.personaIndex === 0
      ? false
      : options?.useBurnerPersona !== undefined
      ? Boolean(options.useBurnerPersona)
      : true

  let binding: OriginPersonaBinding
  if (!useBurner) {
    const address = connectPersonaAddress(
      state,
      norm,
      false,
      options?.personaAddress,
    )
    if (!address) throw new DappPersonaNotReadyError()
    binding = {
      address,
      index: 0,
      label: options?.label || 'Primary dApp Persona',
      isBurner: false,
    }
  } else {
    const existing = state.originPersonas[norm]
    const existingBurnerIdx =
      existing && existing.isBurner && existing.index > 0
        ? existing.index
        : undefined
    const maxExistingIdx = Object.values(state.originPersonas).reduce(
      (max, item) => (item.index > max ? item.index : max),
      0,
    )
    const index =
      typeof options?.personaIndex === 'number' && options.personaIndex > 0
        ? options.personaIndex
        : existingBurnerIdx ?? maxExistingIdx + 1
    // A per-site persona is a hardened custody derivation; only Frank can supply it.
    const address = connectPersonaAddress(
      state,
      norm,
      true,
      options?.personaAddress,
    )
    if (!address) throw new DappPersonaNotReadyError()
    let hostLabel = norm
    try {
      hostLabel = new URL(norm).hostname || norm
    } catch {
      // Keep norm
    }
    binding = {
      address,
      index,
      label: options?.label || `${hostLabel} Burner #${index}`,
      isBurner: true,
    }
  }

  if (norm) {
    state.approvedOrigins.add(norm)
    state.connectedOrigins.add(norm)
    state.originPersonas[norm] = binding
  }
  return binding
}

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

function getKnownPersonaAddressesLower(
  state: BackgroundBridgeState,
): Set<string> {
  const set = new Set<string>()
  const primary = (state.activePersonaAddress || '').toLowerCase()
  if (/^0x[0-9a-f]{40}$/.test(primary)) {
    set.add(primary)
  }
  for (const binding of Object.values(state.originPersonas || {})) {
    const addr = (binding?.address || '').toLowerCase()
    if (/^0x[0-9a-f]{40}$/.test(addr)) {
      set.add(addr)
    }
  }
  return set
}

function applySpendablePoolFallback(
  chainIdHex: string,
  method: string,
  params: unknown,
  rpcResult: unknown,
  state?: BackgroundBridgeState,
): unknown {
  if (!state) return rpcResult
  const normChain = chainIdHex.toLowerCase()
  if (normChain !== '0x279f' && normChain !== '0x8f') {
    return rpcResult
  }
  const knownAddrs = getKnownPersonaAddressesLower(state)
  if (knownAddrs.size === 0) {
    return rpcResult
  }
  let poolWei = 0n
  try {
    if (
      state.poolBalanceWeiHex &&
      /^0x[0-9a-fA-F]+$/.test(state.poolBalanceWeiHex)
    ) {
      poolWei = BigInt(state.poolBalanceWeiHex)
    }
  } catch {
    poolWei = 0n
  }
  if (poolWei <= 0n) return rpcResult

  if (method === 'eth_getBalance') {
    const queriedAddr = Array.isArray(params)
      ? String(params[0] ?? '').toLowerCase()
      : ''
    if (knownAddrs.has(queriedAddr)) {
      let onChainWei = 0n
      try {
        if (
          typeof rpcResult === 'string' &&
          /^0x[0-9a-fA-F]+$/.test(rpcResult)
        ) {
          onChainWei = BigInt(rpcResult)
        }
      } catch {
        onChainWei = 0n
      }
      if (onChainWei === 0n) {
        return '0x' + poolWei.toString(16)
      }
    }
  } else if (method === 'eth_call') {
    const callObj = (Array.isArray(params) ? params[0] : params) as
      | Record<string, unknown>
      | undefined
    const callData = String(callObj?.data ?? callObj?.input ?? '').toLowerCase()
    // Multicall3.getEthBalance(address) selector is 0x4d2301cc
    if (
      callData.startsWith('0x4d2301cc') &&
      (typeof rpcResult !== 'string' || /^0x0*$/.test(rpcResult))
    ) {
      for (const addr of knownAddrs) {
        const addrNoPrefix = addr.slice(2)
        if (callData.includes(addrNoPrefix)) {
          return '0x' + poolWei.toString(16).padStart(64, '0')
        }
      }
    }
  }
  return rpcResult
}

async function forwardReadOnlyRpc(
  chainIdHex: string,
  method: string,
  params: unknown,
  state?: BackgroundBridgeState,
): Promise<{
  ok: boolean
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}> {
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
            return {
              ok: true,
              result: applySpendablePoolFallback(
                chainIdHex,
                method,
                params,
                json.result,
                state,
              ),
            }
          }
          if (json.error && typeof json.error === 'object') {
            return {
              ok: false,
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
  return {
    ok: true,
    result: applySpendablePoolFallback(
      chainIdHex,
      method,
      params,
      getReadOnlyRpcFallback(method),
      state,
    ),
  }
}

export function createBackgroundBridgeState(
  overrides: Partial<BackgroundBridgeState> = {},
): BackgroundBridgeState {
  const originPersonas: Record<string, OriginPersonaBinding> = {
    ...(overrides.originPersonas ?? {}),
  }
  const sharedOriginsSet =
    overrides.approvedOrigins ?? overrides.connectedOrigins ?? new Set<string>()
  for (const raw of Array.from(sharedOriginsSet)) {
    const norm = normalizeBridgeOrigin(raw)
    if (norm && norm !== raw) {
      sharedOriginsSet.add(norm)
    }
  }
  if (
    overrides.connectedOrigins &&
    overrides.connectedOrigins !== sharedOriginsSet
  ) {
    for (const raw of Array.from(overrides.connectedOrigins)) {
      const norm = normalizeBridgeOrigin(raw) || raw
      if (norm) sharedOriginsSet.add(norm)
    }
  }
  for (const key of Object.keys(originPersonas)) {
    const norm = normalizeBridgeOrigin(key) || key
    if (norm) sharedOriginsSet.add(norm)
  }

  return {
    chainIdHex: overrides.chainIdHex ?? '0x279f',
    // Empty until Frank provisions the custody-derived shared persona.
    activePersonaAddress: overrides.activePersonaAddress ?? '',
    poolBalanceWeiHex: overrides.poolBalanceWeiHex ?? '0x0',
    approvedOrigins: sharedOriginsSet,
    connectedOrigins: sharedOriginsSet,
    originPersonas,
    sitePersonaAddresses: { ...(overrides.sitePersonaAddresses ?? {}) },
    announceMode: overrides.announceMode ?? 'always',
    pendingApprovals:
      overrides.pendingApprovals ?? new Map<string, PendingDappApproval>(),
    pendingRpcWaiters:
      overrides.pendingRpcWaiters ?? new Map<string, PendingRpcWaiter>(),
    syncPairing: overrides.syncPairing ?? {
      sender: null,
      senderOfferId: null,
      offerTab: null,
    },
    launchMode: overrides.launchMode ?? 'popup',
  }
}

const USER_REJECTED = { code: 4001, message: 'User rejected the request.' }

/**
 * Answer every waiting dApp request with `error` and empty the queue. Used when
 * the user closes the approval window without deciding.
 */
export function rejectAllPendingApprovals(
  state: BackgroundBridgeState,
  runtimeScope: Record<string, any> | undefined,
  error: { code: number; message: string } = USER_REJECTED,
): void {
  const ids = Array.from(state.pendingApprovals.keys())
  state.pendingApprovals.clear()
  for (const id of ids) {
    const waiter = state.pendingRpcWaiters.get(id)
    state.pendingRpcWaiters.delete(id)
    waiter?.reject(error)
  }
  if (ids.length > 0) notifyExtensionViewsOfApprovals(runtimeScope)
}

function approvalWindowFor(
  state: BackgroundBridgeState,
  runtimeScope: Record<string, any> | undefined,
): ApprovalWindow {
  if (!state.approvalWindow) {
    state.approvalWindow = createApprovalWindow({
      api: getRawExtensionApi(runtimeScope),
      onClosedByUser: () => rejectAllPendingApprovals(state, runtimeScope),
    })
  }
  return state.approvalWindow
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
        maybePromise.catch(() => {
          // Browser capabilities and tab broadcasts are best effort.
        })
      }
      return true
    } catch {
      return false
    }
  }
  return false
}

/**
 * Make the browser's toolbar click do what the user chose. The browser keeps
 * neither `action.setPopup` nor (across an update or reload) the side panel
 * behaviour on its own terms, so the background calls this at every start,
 * install and update with the stored choice. It never writes the choice.
 *
 * - popup: the manifest popup, no side panel on click.
 * - sidepanel: Chrome opens the side panel itself; elsewhere the click reaches
 *   `action.onClicked` (no popup), which opens the sidebar or a window.
 * - window: no popup; `action.onClicked` opens the pop-out window.
 */
export function applyToolbarClickBehavior(
  runtimeScope: Record<string, any> | undefined,
  mode: ExtensionLaunchMode,
): void {
  const api = getRawExtensionApi(runtimeScope)
  configureSidePanelBehavior(runtimeScope, mode === 'sidepanel')
  if (typeof api?.action?.setPopup !== 'function') return
  try {
    void Promise.resolve(
      api.action.setPopup({
        popup: mode === 'popup' ? EXTENSION_POPUP_PATH : '',
      }),
    ).catch(() => undefined)
  } catch {
    // Ignore action errors in restricted environments
  }
}

/** A toolbar click that the browser did not handle with a popup or panel. */
export async function handleToolbarClick(
  tab: { windowId?: number } | undefined,
  state: BackgroundBridgeState,
  runtimeScope?: Record<string, any>,
): Promise<void> {
  const api = getRawExtensionApi(runtimeScope)
  if (
    state.launchMode === 'popup' &&
    typeof api?.action?.openPopup === 'function'
  ) {
    await api.action.openPopup()
    return
  }
  if (state.launchMode === 'sidepanel') {
    if (
      typeof api?.sidePanel?.open === 'function' &&
      typeof tab?.windowId === 'number'
    ) {
      await api.sidePanel.open({ windowId: tab.windowId })
      return
    }
    if (typeof api?.sidebarAction?.toggle === 'function') {
      // Called before any await: Firefox opens the sidebar only within the
      // click's user gesture.
      try {
        await api.sidebarAction.toggle()
        return
      } catch {
        // Fall back to the pop-out window
      }
    }
  }
  await focusOrOpenMainExtensionWindow({}, runtimeScope)
}

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
    scope.document ?? (typeof document !== 'undefined' ? document : undefined)
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
          iframe.setAttribute('style', 'display:none;width:0;height:0;border:0')
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
        ).catch(() => {
          // Browser capabilities and tab broadcasts are best effort.
        })
        await Promise.resolve(
          api.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['inpage.js'],
            world: 'MAIN',
          }),
        ).catch(() => {
          // Browser capabilities and tab broadcasts are best effort.
        })
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

function broadcastToTabs(
  runtimeScope: Record<string, any> | undefined,
  messageBuilder: (tab: Record<string, any>) => Record<string, any> | null,
) {
  const extApi = getRawExtensionApi(runtimeScope)
  if (
    extApi?.tabs &&
    typeof extApi.tabs.query === 'function' &&
    typeof extApi.tabs.sendMessage === 'function'
  ) {
    try {
      void Promise.resolve(extApi.tabs.query({}))
        .then(tabs => {
          if (!Array.isArray(tabs)) return
          for (const tab of tabs) {
            if (tab && typeof tab.id === 'number') {
              const msg = messageBuilder(tab)
              if (msg) {
                void Promise.resolve(
                  extApi.tabs.sendMessage(tab.id, msg),
                ).catch(() => {
                  // Browser capabilities and tab broadcasts are best effort.
                })
              }
            }
          }
        })
        .catch(() => {
          // Browser capabilities and tab broadcasts are best effort.
        })
    } catch {
      // Ignore tab broadcast errors
    }
  }
}

function notifyExtensionViewsOfApprovals(
  runtimeScope: Record<string, any> | undefined,
) {
  const extApi = getRawExtensionApi(runtimeScope)
  if (typeof extApi?.runtime?.sendMessage !== 'function') return
  try {
    // Rejects with "Receiving end does not exist" when no view is open.
    void Promise.resolve(
      extApi.runtime.sendMessage({
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: FRANK_DAPP_APPROVALS_CHANGED,
      }),
    ).catch(() => undefined)
  } catch {
    // No open extension view
  }
}

async function persistOriginStateToStorage(
  state: BackgroundBridgeState,
  runtimeScope?: Record<string, any>,
) {
  const extApi = getRawExtensionApi(runtimeScope)
  if (extApi?.storage?.local?.set) {
    try {
      await extApi.storage.local.set({
        frankDappApprovedOrigins: Array.from(state.approvedOrigins),
        frankDappOriginPersonas: { ...state.originPersonas },
      })
    } catch {
      // Ignore storage errors
    }
  }
}

/** True when the runtime message came from one of this extension's own pages. */
function isExtensionPageSender(
  sender: any,
  extApi: Record<string, any> | null,
): boolean {
  const base =
    typeof extApi?.runtime?.getURL === 'function'
      ? String(extApi.runtime.getURL(''))
      : ''
  const url = typeof sender?.url === 'string' ? sender.url : ''
  return Boolean(base) && url.startsWith(base)
}

/** The web origin a content-script sender runs in, as reported by the browser. */
function senderWebOrigin(sender: any): string {
  if (typeof sender?.origin === 'string' && sender.origin) return sender.origin
  return urlOrigin(sender?.url)
}

function urlOrigin(url: unknown): string {
  if (typeof url !== 'string' || !url) return ''
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function isSyncOfferId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
}

/** Navigation is an extension UI capability, never a web-page sync command. */
function isSyncNavigationRequester(
  sender: any,
  api: Record<string, any> | null,
): boolean {
  if (
    !isExtensionPageSender(sender, api) ||
    sender?.id !== api?.runtime?.id ||
    (sender?.frameId !== undefined && sender.frameId !== 0)
  )
    return false
  try {
    const actual = new URL(sender.url)
    const expected = new URL(api!.runtime.getURL(EXTENSION_POPUP_PATH))
    return (
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname
    )
  } catch {
    return false
  }
}

const syncNavigationRequests = new WeakMap<
  BackgroundBridgeState,
  {
    pending: Promise<SyncSenderNavigationResult>
    until: number
  }
>()

async function openExistingSyncSender(
  api: Record<string, any> | null,
  deadline: number,
): Promise<SyncSenderNavigationResult> {
  if (
    typeof api?.tabs?.query !== 'function' ||
    typeof api.tabs.get !== 'function' ||
    typeof api.tabs.sendMessage !== 'function'
  )
    return { ok: false, reason: 'unavailable' }
  try {
    const tabs: Array<{ id?: number; url?: string; active?: boolean }> =
      await api.tabs.query({ url: 'https://signet.mx/*' })
    if (Date.now() >= deadline) return { ok: false, reason: 'timeout' }
    const candidates = tabs
      .filter(
        tab =>
          Number.isInteger(tab.id) && isFrankWebAppOrigin(urlOrigin(tab.url)),
      )
      .sort((a, b) => Number(!!b.active) - Number(!!a.active) || a.id! - b.id!)
    let unavailable = false
    for (const candidate of candidates) {
      if (Date.now() >= deadline) return { ok: false, reason: 'timeout' }
      try {
        // Browser query results can already be stale; never relay to a navigated tab.
        const tab = await api.tabs.get(candidate.id)
        if (Date.now() >= deadline) return { ok: false, reason: 'timeout' }
        if (!isFrankWebAppOrigin(urlOrigin(tab?.url))) continue
        const id =
          'sync-navigation-' +
          Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
            byte.toString(16).padStart(2, '0'),
          ).join('')
        const response = await api.tabs.sendMessage(
          candidate.id,
          {
            channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
            type: 'open-sync-sender',
            id,
          },
          { frameId: 0 },
        )
        if (response?.ok === true) return { ok: true }
        if (response?.ok === false && response.reason === 'not-ready') continue
        return {
          ok: false,
          reason: response?.reason === 'timeout' ? 'timeout' : 'unavailable',
        }
      } catch {
        // A closed tab or missing content listener does not rule out the next verified tab.
        unavailable = true
      }
    }
    return {
      ok: false,
      reason: unavailable
        ? 'unavailable'
        : candidates.length
        ? 'not-ready'
        : 'no-tab',
    }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

function requestSyncSenderNavigation(
  state: BackgroundBridgeState,
  api: Record<string, any> | null,
): Promise<SyncSenderNavigationResult> {
  const prior = syncNavigationRequests.get(state)
  if (prior && prior.until > Date.now()) return prior.pending
  let timer: ReturnType<typeof setTimeout>
  const entry: { until: number; pending: Promise<SyncSenderNavigationResult> } =
    {
      until: Infinity,
      pending: Promise.race([
        openExistingSyncSender(
          api,
          Date.now() + FRANK_SYNC_NAVIGATION_TIMEOUT_MS,
        ),
        new Promise<SyncSenderNavigationResult>(resolve => {
          timer = setTimeout(
            () => resolve({ ok: false, reason: 'timeout' }),
            FRANK_SYNC_NAVIGATION_TIMEOUT_MS,
          )
        }),
      ]).then(result => {
        clearTimeout(timer)
        // Concurrent requests share one navigation; a short successful cooldown prevents clicks
        // from repeatedly navigating the page. Failures may be retried after the user fixes them.
        if (result.ok) entry.until = Date.now() + 1_000
        else if (syncNavigationRequests.get(state) === entry)
          syncNavigationRequests.delete(state)
        return result
      }),
    }
  syncNavigationRequests.set(state, entry)
  return entry.pending
}

/**
 * Memory-only extension storage that survives the MV3 service worker stopping.
 * Chrome has it; where it is missing the pairing stays in the background state.
 */
function syncSessionStorage(
  extApi: Record<string, any> | null,
): Record<string, any> | null {
  const session = extApi?.storage?.session
  return typeof session?.get === 'function' &&
    typeof session?.set === 'function' &&
    typeof session?.remove === 'function'
    ? session
    : null
}

/** Drops an expired sending session or offer, so no seed outlives its PIN. */
function pruneSyncPairing(
  pairing: PendingSyncPairing,
  now = Date.now(),
): PendingSyncPairing {
  const sender =
    pairing.sender &&
    isSyncOfferId(pairing.senderOfferId) &&
    !syncSenderExpired(pairing.sender, now)
      ? pairing.sender
      : null
  return {
    sender,
    senderOfferId: sender ? pairing.senderOfferId : null,
    offerTab:
      pairing.offerTab &&
      now - pairing.offerTab.createdAt <= SYNC_PAIRING_TTL_MS
        ? pairing.offerTab
        : null,
  }
}

/**
 * Reads the pairing and drops anything expired. It never writes: only
 * `withSyncPairing` saves, under its lock, so a read cannot write back a
 * sender that a concurrent confirm has just consumed.
 */
async function readSyncPairing(
  state: BackgroundBridgeState,
  extApi: Record<string, any> | null,
): Promise<{ pairing: PendingSyncPairing; expiredOfferId: string | null }> {
  const session = syncSessionStorage(extApi)
  const held = session
    ? (await session.get(SYNC_PAIRING_SESSION_KEY))?.[SYNC_PAIRING_SESSION_KEY]
    : state.syncPairing
  const sender = held?.sender ?? null
  const pairing = pruneSyncPairing({
    sender,
    senderOfferId: held?.senderOfferId ?? null,
    offerTab: held?.offerTab ?? null,
  })
  return {
    pairing,
    expiredOfferId:
      sender && !pairing.sender && isSyncOfferId(held?.senderOfferId)
        ? held.senderOfferId
        : null,
  }
}

async function saveSyncPairing(
  state: BackgroundBridgeState,
  extApi: Record<string, any> | null,
  pairing: PendingSyncPairing,
): Promise<void> {
  const session = syncSessionStorage(extApi)
  if (!session) {
    state.syncPairing = pairing
  } else if (pairing.sender || pairing.offerTab) {
    await session.set({ [SYNC_PAIRING_SESSION_KEY]: pairing })
  } else {
    await session.remove(SYNC_PAIRING_SESSION_KEY)
  }
}

// Pairing steps run one at a time, so two confirms cannot both get the bundle.
let syncPairingSteps: Promise<unknown> = Promise.resolve()

function withSyncPairing<T>(
  state: BackgroundBridgeState,
  extApi: Record<string, any> | null,
  step: (pairing: PendingSyncPairing) => Promise<[PendingSyncPairing, T]>,
): Promise<T> {
  const run = syncPairingSteps.then(async () => {
    const { pairing, expiredOfferId } = await readSyncPairing(state, extApi)
    if (expiredOfferId) announceSyncSender(extApi, 'expired', expiredOfferId)
    // Whatever the step returns is saved, so expired entries are wiped here too.
    const [next, result] = await step(pairing)
    await saveSyncPairing(state, extApi, next)
    return result
  })
  syncPairingSteps = run.catch(() => null)
  return run
}

/** The current pairing, read in turn with every other pairing step. */
function currentSyncPairing(
  state: BackgroundBridgeState,
  extApi: Record<string, any> | null,
): Promise<PendingSyncPairing> {
  return withSyncPairing(state, extApi, async pairing => [pairing, pairing])
}

const SYNC_PAIRING_ALARM = 'frank-sync-pairing-expiry'

/** Wipes whatever has expired. Runs at expiry and when the background starts. */
function purgeExpiredSyncPairing(
  state: BackgroundBridgeState,
  extApi: Record<string, any> | null,
): Promise<void> {
  return withSyncPairing(state, extApi, async pairing => [pairing, undefined])
}

/**
 * Wipes the session at `at` even if nothing else happens. The alarm survives a
 * stopped service worker; the timer covers a browser without alarms.
 */
function scheduleSyncPairingPurge(
  state: BackgroundBridgeState,
  extApi: Record<string, any> | null,
  at: number,
): void {
  try {
    if (typeof extApi?.alarms?.create === 'function') {
      void Promise.resolve(
        extApi.alarms.create(SYNC_PAIRING_ALARM, { when: at + 1_000 }),
      ).catch(() => undefined)
    }
  } catch {
    // Fall back to the timer
  }
  const timer = setTimeout(
    () => void purgeExpiredSyncPairing(state, extApi).catch(() => undefined),
    Math.max(0, at - Date.now()) + 1_000,
  )
  ;(timer as unknown as { unref?: () => void }).unref?.()
}

/** Tells open extension pages how the extension's sending session is going. */
function announceSyncSender(
  extApi: Record<string, any> | null,
  status: 'new-pin' | 'sent' | 'ended' | 'expired',
  offerId: string,
  pin = '',
): void {
  if (typeof extApi?.runtime?.sendMessage !== 'function') return
  try {
    void Promise.resolve(
      extApi.runtime.sendMessage({
        channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
        type: 'sync-sender-update',
        offerId,
        status,
        pin,
      }),
    ).catch(() => undefined)
  } catch {
    // No extension page is listening
  }
}

/** Relays an extension page's pairing message to the Frank tab offering its account. */
async function relayPairingToOfferTab(
  state: BackgroundBridgeState,
  extApi: Record<string, any> | null,
  type: 'pair-hello' | 'pair-confirm',
  payload: unknown,
): Promise<unknown> {
  const offer = (await currentSyncPairing(state, extApi)).offerTab
  if (
    !offer ||
    typeof extApi?.tabs?.get !== 'function' ||
    typeof extApi.tabs.sendMessage !== 'function'
  ) {
    return { ok: false, reason: 'no-sender' }
  }
  try {
    // The tab may have navigated since it offered: check its origin now, and
    // talk only to its top frame.
    const tab = await extApi.tabs.get(offer.tabId)
    if (!isFrankWebAppOrigin(urlOrigin(tab?.url))) {
      return { ok: false, reason: 'no-sender' }
    }
    const reply = await extApi.tabs.sendMessage(
      offer.tabId,
      { channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL, type, payload },
      { frameId: 0 },
    )
    return reply && typeof reply === 'object'
      ? reply
      : { ok: false, reason: 'no-sender' }
  } catch {
    return { ok: false, reason: 'no-sender' }
  }
}

/**
 * Account sync between the extension and the Frank web app. Pairing messages
 * from the Frank web app tab go to the extension's sending session; pairing
 * messages from an extension page go to the tab offering its account. Only
 * extension pages and the Frank origin's tabs take part.
 */
async function handleAccountSyncMessage(
  message: any,
  sender: any,
  state: BackgroundBridgeState,
  runtimeScope?: Record<string, any>,
): Promise<any> {
  const extApi = getRawExtensionApi(runtimeScope)
  const fromExtensionPage = isExtensionPageSender(sender, extApi)
  const fromFrankTab =
    !fromExtensionPage && isFrankWebAppOrigin(senderWebOrigin(sender))
  const rejected = (reason: string) => ({
    ok: false,
    error: { code: 4100, message: reason },
  })

  switch (message.type) {
    case 'request-sync-sender': {
      if (!isSyncNavigationRequester(sender, extApi))
        return rejected('Sender is not a trusted extension view')
      if (Object.keys(message).some(key => key !== 'channel' && key !== 'type'))
        return rejected('Unexpected navigation payload')
      return {
        ok: true,
        result: await requestSyncSenderNavigation(state, extApi),
      }
    }
    case 'extension-sync-offer': {
      if (!fromExtensionPage) return rejected('Sender is not an extension page')
      const offerId = message.payload?.offerId
      if (!isSyncOfferId(offerId))
        return rejected('Missing sync offer identity')
      const bundle = message.payload?.deviceSyncBundle
      if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
        return rejected('Missing sync bundle')
      }
      const created = createSyncSender(bundle)
      await withSyncPairing(state, extApi, async pairing => [
        { ...pairing, sender: created, senderOfferId: offerId },
        null,
      ])
      scheduleSyncPairingPurge(
        state,
        extApi,
        created.createdAt + SYNC_PAIRING_TTL_MS,
      )
      return {
        ok: true,
        result: {
          ok: true,
          pin: created.pin,
          offerId,
          expiresAt: created.createdAt + SYNC_PAIRING_TTL_MS,
        },
      }
    }
    case 'extension-sync-status': {
      // An extension page reopened: show the session's current PIN, if any.
      if (!fromExtensionPage) return rejected('Sender is not an extension page')
      const pairing = await currentSyncPairing(state, extApi)
      const current = pairing.sender
      return {
        ok: true,
        result: current
          ? {
              ok: true,
              pin: current.pin,
              offerId: pairing.senderOfferId,
              status: current.failures > 0 ? 'new-pin' : 'waiting',
              expiresAt: current.createdAt + SYNC_PAIRING_TTL_MS,
            }
          : { ok: false },
      }
    }
    case 'extension-sync-cancel': {
      if (!fromExtensionPage) return rejected('Sender is not an extension page')
      const offerId = message.payload?.offerId
      if (!isSyncOfferId(offerId))
        return rejected('Missing sync offer identity')
      const cancelled = await withSyncPairing(state, extApi, async pairing => [
        pairing.senderOfferId === offerId
          ? { ...pairing, sender: null, senderOfferId: null }
          : pairing,
        pairing.senderOfferId === offerId,
      ])
      return { ok: true, result: { ok: cancelled, offerId } }
    }
    case 'pwa-sync-offer': {
      const tabId = sender?.tab?.id
      if (!fromFrankTab || typeof tabId !== 'number') {
        return rejected('Sender is not the Frank web app')
      }
      const createdAt = Date.now()
      await withSyncPairing(state, extApi, async pairing => [
        { ...pairing, offerTab: { tabId, createdAt } },
        null,
      ])
      scheduleSyncPairingPurge(state, extApi, createdAt + SYNC_PAIRING_TTL_MS)
      return { ok: true, result: { ok: true } }
    }
    case 'pwa-sync-cancel': {
      const tabId = sender?.tab?.id
      if (!fromFrankTab || typeof tabId !== 'number') {
        return rejected('Sender is not the Frank web app')
      }
      await withSyncPairing(state, extApi, async pairing => [
        pairing.offerTab?.tabId === tabId
          ? { ...pairing, offerTab: null }
          : pairing,
        null,
      ])
      return { ok: true, result: { ok: true } }
    }
    case 'pair-hello':
    case 'pair-confirm': {
      if (fromExtensionPage) {
        const result = await relayPairingToOfferTab(
          state,
          extApi,
          message.type,
          message.payload,
        )
        return { ok: true, result }
      }
      if (!fromFrankTab) return rejected('Sender is not the Frank web app')
      const result = await withSyncPairing<SyncHelloReply | SyncConfirmReply>(
        state,
        extApi,
        async pairing => {
          if (!pairing.sender) {
            return [pairing, { ok: false, reason: 'no-sender' }]
          }
          if (message.type === 'pair-hello') {
            const next = syncSenderHello(pairing.sender)
            if (!next.state)
              announceSyncSender(extApi, 'expired', pairing.senderOfferId!)
            return [
              {
                ...pairing,
                sender: next.state,
                senderOfferId: next.state ? pairing.senderOfferId : null,
              },
              next.reply,
            ]
          }
          const next = syncSenderConfirm(pairing.sender, message.payload)
          if (next.outcome === 'new-pin' && next.state) {
            announceSyncSender(
              extApi,
              'new-pin',
              pairing.senderOfferId!,
              next.state.pin,
            )
          } else if (next.outcome !== 'stale') {
            announceSyncSender(
              extApi,
              next.outcome as 'sent' | 'ended' | 'expired',
              pairing.senderOfferId!,
            )
          }
          return [
            {
              ...pairing,
              sender: next.state,
              senderOfferId: next.state ? pairing.senderOfferId : null,
            },
            next.reply,
          ]
        },
      )
      return { ok: true, result }
    }
    default:
      return rejected('Unsupported sync message')
  }
}

export async function handleBackgroundMessage(
  message: any,
  sender: any = {},
  state: BackgroundBridgeState = createBackgroundBridgeState(),
  runtimeScope?: Record<string, any>,
): Promise<any> {
  if (!message || typeof message !== 'object') {
    return undefined
  }

  function broadcastProviderEventToTabs(
    event: string,
    payload: unknown,
    targetOrigin?: string,
  ) {
    const normTarget = targetOrigin ? normalizeBridgeOrigin(targetOrigin) : ''
    broadcastToTabs(runtimeScope, tab => {
      if (normTarget && typeof tab?.url === 'string' && tab.url) {
        const tabOrigin = normalizeBridgeOrigin(tab.url)
        if (tabOrigin && tabOrigin !== normTarget) {
          return null
        }
      }
      return {
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'provider-event',
        event,
        payload,
      }
    })
  }

  function broadcastPrivacyConfigToTabs(triggerAnnounce = false) {
    const connectedOrigins = Array.from(state.approvedOrigins)
    broadcastToTabs(runtimeScope, () => ({
      channel: FRANK_DAPP_BRIDGE_CHANNEL,
      type: 'provider-privacy-config',
      announceMode: state.announceMode,
      connectedOrigins,
      triggerAnnounce,
    }))
  }

  if (
    message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
    message.type === 'get-bridge-state'
  ) {
    return {
      ok: true,
      result: {
        ok: true,
        chainIdHex: state.chainIdHex,
        activePersonaAddress: state.activePersonaAddress,
        poolBalanceWeiHex: state.poolBalanceWeiHex ?? '0x0',
        approvedOrigins: Array.from(state.approvedOrigins),
        connectedOrigins: Array.from(state.approvedOrigins),
        originPersonas: { ...state.originPersonas },
        announceMode: state.announceMode,
        pendingApprovals: Array.from(state.pendingApprovals.values()),
        launchMode: state.launchMode,
      },
    }
  }

  if (
    message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
    message.type === 'get-provider-privacy'
  ) {
    const origin = normalizeBridgeOrigin(
      String(message.origin ?? sender?.origin ?? sender?.url ?? ''),
    )
    const approved = isOriginConnected(state, origin)
    const shouldAnnounce =
      state.announceMode === 'always' ||
      (state.announceMode === 'connected-only' && approved)
    return {
      ok: true,
      result: {
        ok: true,
        announceMode: state.announceMode,
        isOriginApproved: approved,
        shouldAnnounce,
      },
    }
  }

  if (
    message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
    (message.type === 'set-announce-mode' ||
      message.type === 'set-provider-privacy')
  ) {
    const rawMode = String(
      message.announceMode ?? message.payload?.announceMode ?? 'always',
    )
    const mode: DappProviderAnnounceMode =
      rawMode === 'connected-only' || rawMode === 'stealth' ? rawMode : 'always'
    state.announceMode = mode
    const extApi = getRawExtensionApi(runtimeScope)
    if (extApi?.storage?.local?.set) {
      try {
        await extApi.storage.local.set({ frankAnnounceMode: mode })
      } catch {
        // Ignore storage errors
      }
    }
    broadcastPrivacyConfigToTabs(mode === 'always')
    return {
      ok: true,
      result: {
        ok: true,
        announceMode: state.announceMode,
      },
    }
  }

  if (
    message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
    message.type === 'disconnect-origin'
  ) {
    const rawOrigin = String(
      message.origin ?? message.payload?.origin ?? '',
    ).trim()
    const norm = normalizeBridgeOrigin(rawOrigin) || rawOrigin
    if (norm) {
      state.approvedOrigins.delete(norm)
      state.connectedOrigins.delete(norm)
      state.approvedOrigins.delete(rawOrigin)
      delete state.originPersonas[norm]
      delete state.originPersonas[rawOrigin]
      await persistOriginStateToStorage(state, runtimeScope)
      broadcastProviderEventToTabs('accountsChanged', [], norm)
      broadcastPrivacyConfigToTabs(false)
    }
    return {
      ok: true,
      result: {
        ok: true,
        origin: norm,
        approvedOrigins: Array.from(state.approvedOrigins),
        connectedOrigins: Array.from(state.approvedOrigins),
        originPersonas: { ...state.originPersonas },
      },
    }
  }

  // Frank provides custody-derived per-site persona addresses (never keys) for origins
  // that are waiting on a decision; the approval window then shows them.
  if (
    message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
    message.type === FRANK_DAPP_PROVISION_SITE_PERSONAS
  ) {
    // Only Frank's own pages provide personas; a web page never chooses a site's address.
    if (!isExtensionPageSender(sender, getRawExtensionApi(runtimeScope))) {
      return {
        ok: false,
        error: { code: 4100, message: 'Unauthorized persona sender.' },
      }
    }
    const provided =
      message.sitePersonas && typeof message.sitePersonas === 'object'
        ? (message.sitePersonas as Record<string, unknown>)
        : {}
    let pendingChanged = false
    for (const [rawOrigin, address] of Object.entries(provided)) {
      const norm =
        normalizeBridgeOrigin(rawOrigin) || rawOrigin.trim().toLowerCase()
      if (!norm || !isPersonaAddress(address)) continue
      state.sitePersonaAddresses[norm] = address
      for (const pending of state.pendingApprovals.values()) {
        if (
          pending.origin === norm &&
          pending.suggestedBurnerAddress !== address
        ) {
          pending.suggestedBurnerAddress = address
          pendingChanged = true
        }
      }
    }
    const extApi = getRawExtensionApi(runtimeScope)
    if (extApi?.storage?.local?.set) {
      try {
        await extApi.storage.local.set({
          frankDappSitePersonas: { ...state.sitePersonaAddresses },
        })
      } catch {
        // Ignore storage errors
      }
    }
    if (pendingChanged) notifyExtensionViewsOfApprovals(runtimeScope)
    return { ok: true, result: { ok: true } }
  }

  if (
    message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
    (message.type === 'set-active-persona' ||
      message.type === 'update-persona-state')
  ) {
    // Only Frank's own pages set the shared persona; a web page never chooses it.
    if (!isExtensionPageSender(sender, getRawExtensionApi(runtimeScope))) {
      return {
        ok: false,
        error: { code: 4100, message: 'Unauthorized persona sender.' },
      }
    }
    const payload =
      message.payload && typeof message.payload === 'object'
        ? message.payload
        : message
    const nextAddr = String(
      payload.activePersonaAddress ?? payload.address ?? message.address ?? '',
    ).trim()
    const rawPool =
      payload.poolBalanceWeiHex ??
      payload.poolBalanceWei ??
      message.poolBalanceWeiHex ??
      message.poolBalanceWei ??
      ''
    let nextPoolHex = ''
    if (typeof rawPool === 'bigint' && rawPool >= 0n) {
      nextPoolHex = '0x' + rawPool.toString(16)
    } else if (
      typeof rawPool === 'number' &&
      Number.isFinite(rawPool) &&
      rawPool >= 0
    ) {
      nextPoolHex = '0x' + BigInt(Math.floor(rawPool)).toString(16)
    } else if (typeof rawPool === 'string') {
      const trimmedPool = rawPool.trim()
      if (/^0x[0-9a-fA-F]+$/.test(trimmedPool)) {
        nextPoolHex = trimmedPool.toLowerCase()
      } else if (/^\d+$/.test(trimmedPool)) {
        nextPoolHex = '0x' + BigInt(trimmedPool).toString(16)
      }
    }
    const nextChainHex = String(
      payload.chainIdHex ?? message.chainIdHex ?? '',
    ).trim()
    const storageUpdates: Record<string, unknown> = {}

    if (/^0x[a-fA-F0-9]{40}$/.test(nextAddr)) {
      state.activePersonaAddress = nextAddr
      storageUpdates.frankDappPersonaAddress = nextAddr
      for (const [origKey, binding] of Object.entries(state.originPersonas)) {
        if (!binding.isBurner) {
          state.originPersonas[origKey] = {
            ...binding,
            address: nextAddr,
          }
          broadcastProviderEventToTabs('accountsChanged', [nextAddr], origKey)
        }
      }
      storageUpdates.frankDappOriginPersonas = { ...state.originPersonas }
    }
    if (/^0x[0-9a-fA-F]+$/.test(nextPoolHex)) {
      state.poolBalanceWeiHex = nextPoolHex.toLowerCase()
      storageUpdates.frankPoolBalanceWeiHex = state.poolBalanceWeiHex
    }
    if (/^0x[0-9a-fA-F]+$/.test(nextChainHex)) {
      const normalizedChain = '0x' + parseInt(nextChainHex, 16).toString(16)
      if (state.chainIdHex !== normalizedChain) {
        state.chainIdHex = normalizedChain
        storageUpdates.frankChainIdHex = normalizedChain
        broadcastProviderEventToTabs('chainChanged', normalizedChain)
      }
    }

    if (Object.keys(storageUpdates).length > 0) {
      const extApi = getRawExtensionApi(runtimeScope)
      if (extApi?.storage?.local?.set) {
        try {
          await extApi.storage.local.set(storageUpdates)
        } catch {
          // Ignore storage errors
        }
      }
    }
    return {
      ok: true,
      result: {
        ok: true,
        activePersonaAddress: state.activePersonaAddress,
        poolBalanceWeiHex: state.poolBalanceWeiHex ?? '0x0',
        chainIdHex: state.chainIdHex,
      },
    }
  }

  if (
    message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
    message.type === 'set-dapp-chain'
  ) {
    const rawChain = String(message.chainIdHex ?? '').trim()
    if (/^0x[0-9a-fA-F]+$/.test(rawChain)) {
      const normalized = '0x' + parseInt(rawChain, 16).toString(16)
      state.chainIdHex = normalized
      const extApi = getRawExtensionApi(runtimeScope)
      if (extApi?.storage?.local?.set) {
        try {
          await extApi.storage.local.set({ frankChainIdHex: normalized })
        } catch {
          // Ignore storage errors
        }
      }
      broadcastProviderEventToTabs('chainChanged', normalized)
    }
    return {
      ok: true,
      result: {
        ok: true,
        chainIdHex: state.chainIdHex,
      },
    }
  }

  if (
    message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
    message.type === 'get-launch-mode'
  ) {
    return {
      ok: true,
      result: { ok: true, launchMode: state.launchMode },
    }
  }

  if (
    message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
    message.type === 'set-launch-mode'
  ) {
    const mode = parseExtensionLaunchMode(message.launchMode)
    if (!mode) {
      return {
        ok: false,
        error: {
          code: -32602,
          message: `Unknown launch mode: ${String(message.launchMode)}`,
        },
      }
    }
    const extApi = getRawExtensionApi(runtimeScope)
    if (typeof extApi?.storage?.local?.set === 'function') {
      try {
        await extApi.storage.local.set({ [FRANK_EXT_LAUNCH_MODE_KEY]: mode })
      } catch (err) {
        // Not saved: keep the previous choice and say so to Settings.
        return {
          ok: false,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        }
      }
    }
    state.launchMode = mode
    applyToolbarClickBehavior(runtimeScope, mode)
    // The choice is saved and applied; opening the view now is a convenience
    // (it can need a user gesture this message no longer carries).
    let openError: string | undefined
    if (message.openNow) {
      try {
        if (mode === 'sidepanel') {
          await openCompanionPanel(
            {
              windowId: message.windowId ?? sender?.tab?.windowId,
              tabId: message.tabId ?? sender?.tab?.id,
            },
            runtimeScope,
          )
        } else if (mode === 'window') {
          await focusOrOpenMainExtensionWindow(
            message.options ?? {},
            runtimeScope,
          )
        }
      } catch (err) {
        openError = err instanceof Error ? err.message : String(err)
      }
    }
    return {
      ok: true,
      result: {
        ok: true,
        launchMode: state.launchMode,
        ...(openError ? { openError } : {}),
      },
    }
  }

  if (
    message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
    message.type === 'open-extension-window'
  ) {
    const res = await focusOrOpenMainExtensionWindow(
      message.options ?? {},
      runtimeScope,
    )
    return {
      ok: res.opened,
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
    const rawOrigin = String(
      message.origin ?? sender?.origin ?? sender?.url ?? '',
    )
    const normalizedOrigin = normalizeBridgeOrigin(rawOrigin)
    const href = String(message.href ?? sender?.url ?? rawOrigin)
    const id = String(
      message.id ??
        `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    )

    if (method === 'eth_chainId') {
      return { ok: true, result: state.chainIdHex }
    }

    if (method === 'net_version') {
      return { ok: true, result: String(parseInt(state.chainIdHex, 16)) }
    }

    if (method === 'web3_clientVersion') {
      return { ok: true, result: 'FrankWallet/0.3.0' }
    }

    // A website's connect action needs the extension's account, independently
    // of the PWA login. Show an actionable notice before answering it.
    if (
      (method === 'eth_requestAccounts' ||
        method === 'wallet_requestPermissions') &&
      !isPersonaAddress(state.activePersonaAddress)
    ) {
      try {
        state.accountRequiredWindow ??= createApprovalWindow({
          api: getRawExtensionApi(runtimeScope),
          pagePath: 'approval.html?notice=account-required',
          onClosedByUser: () => undefined,
        })
        await state.accountRequiredWindow.show()
      } catch {
        return {
          ok: false,
          error: {
            code: DAPP_PERSONA_NOT_READY_ERROR.code,
            message: `${DAPP_PERSONA_NOT_READY_ERROR.message} Frank could not open automatically; open it from the browser toolbar.`,
          },
        }
      }
      return { ok: false, error: { ...DAPP_PERSONA_NOT_READY_ERROR } }
    }

    // A connected origin's persona requests need a provisioned persona address.
    if (
      PERSONA_ADDRESS_METHODS.has(method) &&
      normalizedOrigin &&
      isOriginConnected(state, normalizedOrigin) &&
      !getOriginPersonaAddress(state, normalizedOrigin)
    ) {
      return { ok: false, error: { ...DAPP_PERSONA_NOT_READY_ERROR } }
    }

    // Strict Origin Permission Gating: eth_accounts returns [] unless origin is already approved
    if (method === 'eth_accounts') {
      if (!normalizedOrigin || !isOriginConnected(state, normalizedOrigin)) {
        return { ok: true, result: [] }
      }
      return {
        ok: true,
        result: [getOriginPersonaAddress(state, normalizedOrigin)],
      }
    }

    if (method === 'wallet_getPermissions') {
      if (!normalizedOrigin || !isOriginConnected(state, normalizedOrigin)) {
        return { ok: true, result: [] }
      }
      const personaAddr = getOriginPersonaAddress(state, normalizedOrigin)
      return {
        ok: true,
        result: [
          {
            invoker: normalizedOrigin,
            parentCapability: 'eth_accounts',
            caveats: [
              {
                type: 'restrictReturnedAccounts',
                value: [personaAddr],
              },
            ],
          },
        ],
      }
    }

    if (method === 'wallet_revokePermissions') {
      if (normalizedOrigin) {
        state.approvedOrigins.delete(normalizedOrigin)
        state.connectedOrigins.delete(normalizedOrigin)
        state.approvedOrigins.delete(rawOrigin)
        delete state.originPersonas[normalizedOrigin]
        delete state.originPersonas[rawOrigin]
        await persistOriginStateToStorage(state, runtimeScope)
        broadcastProviderEventToTabs('accountsChanged', [], normalizedOrigin)
      }
      return { ok: true, result: null }
    }

    // Already-approved origin calling eth_requestAccounts or wallet_requestPermissions.
    // Frank has no Bitcoin or eCash account for dApps: btc_* and xec_* fall through to 4200.
    if (
      (method === 'eth_requestAccounts' ||
        method === 'wallet_requestPermissions') &&
      normalizedOrigin &&
      isOriginConnected(state, normalizedOrigin) &&
      !message.payload?.requireExplicitCompanionApproval
    ) {
      const personaAddr = getOriginPersonaAddress(state, normalizedOrigin)
      if (method === 'wallet_requestPermissions') {
        return {
          ok: true,
          result: [
            {
              invoker: normalizedOrigin,
              parentCapability: 'eth_accounts',
              caveats: [
                {
                  type: 'restrictReturnedAccounts',
                  value: [personaAddr],
                },
              ],
            },
          ],
        }
      }
      return { ok: true, result: [personaAddr] }
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
        const normalized = '0x' + parseInt(rawChainId.trim(), 16).toString(16)
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
        broadcastProviderEventToTabs('chainChanged', normalized)
        return { ok: true, result: null }
      }
      return {
        ok: false,
        error: {
          code: -32602,
          message: 'Invalid chainId parameter',
        },
      }
    }

    if (method === 'wallet_getCapabilities') {
      return {
        ok: true,
        result: {
          '0x279f': { atomicBatch: { supported: false } },
          '0x8f': { atomicBatch: { supported: false } },
          '0x1': { atomicBatch: { supported: false } },
          '0xaa36a7': { atomicBatch: { supported: false } },
        },
      }
    }

    if (method === 'wallet_watchAsset') {
      return { ok: true, result: true }
    }

    if (READONLY_RPC_METHODS.has(method)) {
      return await forwardReadOnlyRpc(state.chainIdHex, method, params, state)
    }

    if (
      method === 'eth_requestAccounts' ||
      method === 'wallet_requestPermissions' ||
      APPROVAL_REQUIRED_METHODS.has(method)
    ) {
      const effectiveOrigin =
        normalizedOrigin || rawOrigin || 'https://dapp.local'
      const isConnectMethod =
        method === 'eth_requestAccounts' ||
        method === 'wallet_requestPermissions'

      // Require origin to be connected before signing or sending transactions
      if (
        !isConnectMethod &&
        normalizedOrigin &&
        !isOriginConnected(state, normalizedOrigin) &&
        message.payload?.enforceConnectedOriginForSigning === true
      ) {
        return {
          ok: false,
          error: {
            code: 4100,
            message:
              'The requested method and/or account has not been authorized by the user.',
          },
        }
      }

      const kind: PendingDappApproval['kind'] =
        method === 'wallet_requestPermissions'
          ? 'permissions'
          : isConnectMethod
          ? 'connect'
          : method === 'eth_sendTransaction'
          ? 'transaction'
          : 'sign'

      // Nothing to approve with until Frank has provisioned the shared persona.
      if (!isPersonaAddress(state.activePersonaAddress)) {
        return { ok: false, error: { ...DAPP_PERSONA_NOT_READY_ERROR } }
      }

      const pending: PendingDappApproval = {
        id,
        kind,
        origin: effectiveOrigin,
        href,
        method,
        params,
        createdAt: Date.now(),
        requiresCompanionApproval: true,
        personaAddress: state.originPersonas[effectiveOrigin]?.address,
        suggestedBurnerAddress: state.sitePersonaAddresses[effectiveOrigin],
        primaryPersonaAddress: state.activePersonaAddress,
      }
      state.pendingApprovals.set(id, pending)
      // Hold the RPC Promise open until resolved/rejected via resolve-approval.
      // The waiter is registered before any UI work so a fast decision, or a
      // failure to open a view, cannot strand the dApp's request.
      const decision = new Promise<unknown>((resolve, reject) => {
        state.pendingRpcWaiters.set(id, { resolve, reject })
      })

      // The approval window shows the request (opening it, or focusing it
      // when earlier requests are already waiting there).
      notifyExtensionViewsOfApprovals(runtimeScope)
      void approvalWindowFor(state, runtimeScope)
        .show()
        .catch(() => {
          // A failed view must answer the RPC instead of stranding the site.
          const waiter = state.pendingRpcWaiters.get(id)
          if (!waiter) return
          state.pendingApprovals.delete(id)
          state.pendingRpcWaiters.delete(id)
          waiter.reject({
            code: 4900,
            message:
              'Frank could not open the connection approval. Open the extension and try again.',
          })
          notifyExtensionViewsOfApprovals(runtimeScope)
        })

      try {
        const resolvedResult = await decision
        return {
          ok: true,
          result: resolvedResult,
        }
      } catch (err: any) {
        return {
          ok: false,
          error: {
            code: typeof err?.code === 'number' ? err.code : USER_REJECTED.code,
            message: String(err?.message || USER_REJECTED.message),
            ...(err?.data !== undefined ? { data: err.data } : {}),
          },
        }
      }
    }

    return {
      ok: false,
      error: {
        code: 4200,
        message: `Unsupported method: ${method}`,
      },
    }
  }

  if (
    message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
    (message.type === 'resolve-approval' ||
      message.type === 'companion-resolve-approval')
  ) {
    // Only Frank's own pages decide; a web page or content script never answers for the user.
    if (!isExtensionPageSender(sender, getRawExtensionApi(runtimeScope))) {
      return {
        ok: false,
        error: { code: 4100, message: 'Unauthorized approval sender.' },
      }
    }
    const decision =
      message.payload && typeof message.payload === 'object'
        ? message.payload
        : message
    const requestId = String(
      decision.approvalId ??
        decision.requestId ??
        message.approvalId ??
        message.requestId ??
        '',
    )
    const pending = state.pendingApprovals.get(requestId)
    const waiter = state.pendingRpcWaiters.get(requestId)
    if (!pending) {
      return {
        ok: false,
        error: {
          code: 4004,
          message: `Unknown approval request: ${requestId}`,
        },
      }
    }
    const approved = Boolean(decision.approved ?? message.approved)
    const isConnectMethod =
      pending.kind === 'connect' ||
      pending.kind === 'permissions' ||
      pending.method === 'eth_requestAccounts' ||
      pending.method === 'wallet_requestPermissions'

    const rawUseBurner = decision.useBurnerPersona ?? message.useBurnerPersona
    const useBurnerPersona =
      decision.personaIndex === 0 || message.personaIndex === 0
        ? false
        : rawUseBurner !== undefined
        ? Boolean(rawUseBurner)
        : true
    const suppliedPersonaAddress =
      decision.personaAddress ?? message.personaAddress
    // Approving a connection needs a custody-derived address for the chosen persona. Until
    // Frank provides it the request stays queued and the decision fails explicitly.
    if (
      approved &&
      isConnectMethod &&
      !connectPersonaAddress(
        state,
        normalizeBridgeOrigin(pending.origin) ||
          pending.origin.trim().toLowerCase(),
        useBurnerPersona,
        suppliedPersonaAddress,
      )
    ) {
      return { ok: false, error: { ...DAPP_PERSONA_NOT_READY_ERROR } }
    }

    state.pendingApprovals.delete(requestId)
    state.pendingRpcWaiters.delete(requestId)
    notifyExtensionViewsOfApprovals(runtimeScope)
    if (state.pendingApprovals.size === 0) {
      void approvalWindowFor(state, runtimeScope)
        .close()
        .catch(() => undefined)
    }

    if (!approved) {
      const rejectionError = { ...USER_REJECTED }
      if (waiter) {
        waiter.reject(rejectionError)
      }
      return {
        ok: false,
        error: rejectionError,
        result: {
          ok: false,
          requestId,
          approvalId: requestId,
          approved: false,
          origin: pending.origin,
        },
      }
    }

    if (isConnectMethod) {
      const binding = assignOriginPersona(state, pending.origin, {
        useBurnerPersona,
        personaAddress: suppliedPersonaAddress,
        personaIndex: decision.personaIndex ?? message.personaIndex,
        label: decision.label ?? message.label,
      })

      await persistOriginStateToStorage(state, runtimeScope)
      broadcastProviderEventToTabs(
        'accountsChanged',
        [binding.address],
        pending.origin,
      )
      broadcastPrivacyConfigToTabs(true)

      const rpcValue =
        pending.method === 'wallet_requestPermissions'
          ? [
              {
                invoker: pending.origin,
                parentCapability: 'eth_accounts',
                caveats: [
                  {
                    type: 'restrictReturnedAccounts',
                    value: [binding.address],
                  },
                ],
              },
            ]
          : [binding.address]

      if (waiter) {
        waiter.resolve(rpcValue)
      }

      return {
        ok: true,
        result: {
          ok: true,
          requestId,
          approvalId: requestId,
          approved: true,
          origin: pending.origin,
          accounts: [binding.address],
          persona: binding,
          result: rpcValue,
        },
      }
    }

    // Signing and transactions are not implemented: approving one must never hand the dApp a
    // made-up signature or transaction hash. Answer it as unsupported instead.
    const unsupported = {
      code: 4200,
      message: `Frank cannot complete ${pending.method} yet.`,
    }
    waiter?.reject(unsupported)
    return {
      ok: false,
      error: unsupported,
      result: {
        ok: false,
        requestId,
        approvalId: requestId,
        approved: false,
        origin: pending.origin,
      },
    }
  }

  if (message.channel === FRANK_PWA_EXTENSION_SYNC_CHANNEL) {
    return await handleAccountSyncMessage(message, sender, state, runtimeScope)
  }

  return undefined
}

/**
 * Reads the bridge state persisted in `storage.local` into `state`. Only
 * values present and valid in storage replace the defaults; nothing is written.
 */
export async function restoreStoredBridgeState(
  state: BackgroundBridgeState,
  api: any,
): Promise<void> {
  if (typeof api?.storage?.local?.get !== 'function') return
  const stored: Record<string, any> | undefined = await api.storage.local.get([
    FRANK_EXT_LAUNCH_MODE_KEY,
    'frankDappPersonaAddress',
    'frankPoolBalanceWeiHex',
    'frankDappApprovedOrigins',
    'frankDappOriginPersonas',
    'frankDappSitePersonas',
    'frankAnnounceMode',
    'frankChainIdHex',
  ])
  if (!stored) return
  const storedMode = parseExtensionLaunchMode(stored[FRANK_EXT_LAUNCH_MODE_KEY])
  if (storedMode) state.launchMode = storedMode
  if (
    typeof stored.frankDappPersonaAddress === 'string' &&
    /^0x[a-fA-F0-9]{40}$/.test(stored.frankDappPersonaAddress)
  ) {
    state.activePersonaAddress = stored.frankDappPersonaAddress
  }
  if (
    typeof stored.frankPoolBalanceWeiHex === 'string' &&
    /^0x[0-9a-fA-F]+$/.test(stored.frankPoolBalanceWeiHex)
  ) {
    state.poolBalanceWeiHex = stored.frankPoolBalanceWeiHex
  }
  if (Array.isArray(stored.frankDappApprovedOrigins)) {
    for (const orig of stored.frankDappApprovedOrigins) {
      if (typeof orig === 'string' && orig) {
        const norm = normalizeBridgeOrigin(orig) || orig
        state.approvedOrigins.add(norm)
        state.connectedOrigins.add(norm)
      }
    }
  }
  if (
    stored.frankDappSitePersonas &&
    typeof stored.frankDappSitePersonas === 'object'
  ) {
    for (const [orig, address] of Object.entries(
      stored.frankDappSitePersonas,
    )) {
      if (isPersonaAddress(address)) {
        state.sitePersonaAddresses[normalizeBridgeOrigin(orig) || orig] =
          address
      }
    }
  }
  if (
    stored.frankDappOriginPersonas &&
    typeof stored.frankDappOriginPersonas === 'object'
  ) {
    for (const [orig, binding] of Object.entries(
      stored.frankDappOriginPersonas,
    )) {
      if (binding && typeof binding === 'object') {
        const norm = normalizeBridgeOrigin(orig) || orig
        state.originPersonas[norm] = binding as OriginPersonaBinding
        state.approvedOrigins.add(norm)
        state.connectedOrigins.add(norm)
      }
    }
  }
  if (
    stored.frankAnnounceMode === 'always' ||
    stored.frankAnnounceMode === 'connected-only' ||
    stored.frankAnnounceMode === 'stealth'
  ) {
    state.announceMode = stored.frankAnnounceMode
  }
  if (
    typeof stored.frankChainIdHex === 'string' &&
    /^0x[0-9a-fA-F]+$/.test(stored.frankChainIdHex)
  ) {
    state.chainIdHex = stored.frankChainIdHex.toLowerCase()
  }
}

export function installBackgroundBridge(
  runtimeScope?: Record<string, any>,
  state: BackgroundBridgeState = createBackgroundBridgeState(),
): {
  state: BackgroundBridgeState
  dispose: () => void
} {
  void ensureOffscreenWarmup(runtimeScope)
  void reinjectContentScriptsIntoOpenTabs(runtimeScope)

  const api = getRawExtensionApi(runtimeScope)
  // Only extension pages and the background may read a held sync bundle
  // (this is the browser default; set it so nothing else can widen it).
  const syncSession = syncSessionStorage(api)
  if (typeof syncSession?.setAccessLevel === 'function') {
    try {
      void Promise.resolve(
        syncSession.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
      ).catch(() => undefined)
    } catch {
      // Ignore storage errors in restricted environments
    }
  }
  // Wipe an account-sync session that expired while the worker was stopped,
  // and at each expiry alarm.
  void purgeExpiredSyncPairing(state, api).catch(() => undefined)
  if (typeof api?.alarms?.onAlarm?.addListener === 'function') {
    api.alarms.onAlarm.addListener((alarm: { name?: string }) => {
      if (alarm?.name === SYNC_PAIRING_ALARM) {
        void purgeExpiredSyncPairing(state, api).catch(() => undefined)
      }
    })
  }
  // Earlier builds kept the last sync bundle, backup shares included, here.
  if (typeof api?.storage?.local?.remove === 'function') {
    try {
      void Promise.resolve(api.storage.local.remove('frankSyncedState')).catch(
        () => undefined,
      )
    } catch {
      // Ignore storage errors in restricted environments
    }
  }
  // Restore persisted state before answering anything: a message or click can
  // be what woke this worker, and answering it from defaults would show (and
  // apply) a choice the user did not make.
  const restored = restoreStoredBridgeState(state, api)
    .catch(() => undefined)
    .then(() => applyToolbarClickBehavior(runtimeScope, state.launchMode))
  let restoreDone = false
  void restored.then(() => {
    restoreDone = true
  })
  // An update, reload or browser start resets the browser's toolbar state;
  // the stored choice is applied again (never replaced by the default).
  const reapplyToolbarClick = () => {
    void restored.then(() =>
      applyToolbarClickBehavior(runtimeScope, state.launchMode),
    )
  }
  if (typeof api?.runtime?.onInstalled?.addListener === 'function') {
    api.runtime.onInstalled.addListener(reapplyToolbarClick)
  }
  if (typeof api?.runtime?.onStartup?.addListener === 'function') {
    api.runtime.onStartup.addListener(reapplyToolbarClick)
  }
  if (typeof api?.action?.onClicked?.addListener === 'function') {
    api.action.onClicked.addListener((tab: { windowId?: number }) => {
      // Once restored, act within the click (Firefox's sidebar needs the
      // user gesture); a click that woke the worker waits for the choice.
      const click = () =>
        handleToolbarClick(tab, state, runtimeScope).catch(() => undefined)
      if (restoreDone) void click()
      else void restored.then(click)
    })
  }

  const unsubscribe = onRuntimeMessage(async (message: any, sender: any) => {
    await restored
    return await handleBackgroundMessage(message, sender, state, runtimeScope)
  }, runtimeScope)

  return {
    state,
    dispose: unsubscribe,
  }
}

/**
 * Whether this script runs as the extension's background (service worker, or Firefox's
 * background page). Extension pages import this module for its helpers; they must not
 * install a second background bridge, or every open Frank page would answer background
 * messages too (each "open window" request then opened one window per page).
 */
export function isExtensionBackgroundContext(
  scope: Record<string, any> = globalThis as Record<string, any>,
): boolean {
  const workerScope = scope.ServiceWorkerGlobalScope
  if (typeof workerScope === 'function' && scope instanceof workerScope) {
    return true
  }
  try {
    const page = getRawExtensionApi(scope)?.extension?.getBackgroundPage?.()
    return Boolean(page) && page === (scope.window ?? scope)
  } catch {
    return false
  }
}

if (
  typeof globalThis !== 'undefined' &&
  isBrowserExtensionRuntime() &&
  isExtensionBackgroundContext()
) {
  installBackgroundBridge(globalThis as Record<string, any>)
}
