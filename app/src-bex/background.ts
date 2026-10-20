import {
  getRawExtensionApi,
  isBrowserExtensionRuntime,
  onRuntimeMessage,
  openCompanionPanel,
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
}

const APPROVAL_REQUIRED_METHODS = new Set([
  'eth_requestAccounts',
  'personal_sign',
  'eth_signTypedData_v4',
  'eth_sendTransaction',
  'solana_connect',
  'solana_signMessage',
  'solana_signTransaction',
])

export function createBackgroundBridgeState(
  overrides: Partial<BackgroundBridgeState> = {},
): BackgroundBridgeState {
  return {
    chainIdHex: overrides.chainIdHex ?? '0x279f',
    activePersonaAddress:
      overrides.activePersonaAddress ??
      '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    approvedOrigins: overrides.approvedOrigins ?? new Set<string>(),
    pendingApprovals:
      overrides.pendingApprovals ?? new Map<string, PendingDappApproval>(),
    syncedState: overrides.syncedState ?? null,
    openPanelOnActionClick: overrides.openPanelOnActionClick ?? false,
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

export function installBackgroundBridge(
  runtimeScope?: Record<string, any>,
  state: BackgroundBridgeState = createBackgroundBridgeState(),
): {
  state: BackgroundBridgeState
  dispose: () => void
} {
  configureSidePanelBehavior(runtimeScope, state.openPanelOnActionClick)

  const api = getRawExtensionApi(runtimeScope)
  if (api?.storage?.local?.get) {
    try {
      const maybeStored = api.storage.local.get([
        'frankOpenPanelOnActionClick',
        'frankSyncedState',
      ])
      if (maybeStored && typeof maybeStored.then === 'function') {
        maybeStored
          .then((stored: Record<string, any> | undefined) => {
            if (
              stored &&
              typeof stored.frankOpenPanelOnActionClick === 'boolean'
            ) {
              state.openPanelOnActionClick = stored.frankOpenPanelOnActionClick
              configureSidePanelBehavior(
                runtimeScope,
                state.openPanelOnActionClick,
              )
            }
            if (stored?.frankSyncedState && !state.syncedState) {
              state.syncedState = stored.frankSyncedState
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
      message.type === 'set-sidepanel-behavior'
    ) {
      const enabled = Boolean(message.openPanelOnActionClick)
      state.openPanelOnActionClick = enabled
      const configured = configureSidePanelBehavior(runtimeScope, enabled)
      const extApi = getRawExtensionApi(runtimeScope)
      if (extApi?.storage?.local?.set) {
        try {
          await extApi.storage.local.set({
            frankOpenPanelOnActionClick: enabled,
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
        },
      }
    }

    if (
      message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
      message.type === 'dapp-rpc-request'
    ) {
      const method = String(message.payload?.method ?? '')
      const origin = String(message.origin ?? sender?.origin ?? '')
      const href = String(message.href ?? sender?.url ?? '')
      const id = String(message.id ?? `req-${Date.now()}`)

      if (method === 'eth_chainId') {
        return { result: state.chainIdHex }
      }

      if (method === 'net_version') {
        return { result: String(parseInt(state.chainIdHex, 16)) }
      }

      if (method === 'eth_accounts') {
        return {
          result: state.approvedOrigins.has(origin)
            ? [state.activePersonaAddress]
            : [],
        }
      }

      if (APPROVAL_REQUIRED_METHODS.has(method)) {
        if (
          method === 'eth_requestAccounts' &&
          state.approvedOrigins.has(origin)
        ) {
          return { result: [state.activePersonaAddress] }
        }

        const pending: PendingDappApproval = {
          id,
          origin,
          href,
          method,
          params: message.payload?.params,
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
        typeof extApi.tabs.query === 'function' &&
        typeof extApi.tabs.sendMessage === 'function'
      ) {
        try {
          const tabs = await extApi.tabs.query({ currentWindow: true })
          if (Array.isArray(tabs)) {
            for (const tab of tabs) {
              if (tab && typeof tab.id === 'number') {
                try {
                  await extApi.tabs.sendMessage(tab.id, {
                    channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
                    type: 'extension-sync-push',
                    payload: state.syncedState,
                  })
                  pushedToTabCount += 1
                } catch {
                  // Tab may not have content script loaded
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

