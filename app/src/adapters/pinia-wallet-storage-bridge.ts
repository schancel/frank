/**
 * Pinia Wallet Storage Bridge (app/src/adapters/pinia-wallet-storage-bridge.ts).
 *
 * Bridges headless WalletStorageAdapter instances to Pinia and Vue reactivity.
 * When a wallet storage adapter persists balances, addresses, or transactions,
 * this bridge receives the notifications and updates reactive state and Pinia stores.
 */

import { reactive } from 'vue'
import {
  createWalletStorage,
  type WalletStorageAdapter,
  type WalletStorageOptions,
  type StorageChangeEvent,
} from '@frank/wallet/storage/wallet-storage-adapter'

// Shared reactive view of wallet storage keys across the app
const reactiveWalletStates = reactive<Record<string, Record<string, unknown>>>(
  {},
)

/**
 * Returns a reactive object representing the current stored state for a walletId.
 */
export function useWalletStorageState(
  walletId: string,
): Record<string, unknown> {
  if (!reactiveWalletStates[walletId]) {
    reactiveWalletStates[walletId] = {}
  }
  return reactiveWalletStates[walletId]
}

/**
 * Custom event name dispatched on globalThis when wallet storage changes.
 */
export const WALLET_STORAGE_CHANGE_EVENT = 'frank:wallet-storage-change'

/**
 * Attaches a Pinia / reactive bridge to an observable WalletStorageAdapter.
 * Returns an unsubscribe cleanup function.
 */
export function attachPiniaWalletStorageBridge<T = unknown>(
  storage: WalletStorageAdapter<T>,
  onBalanceChange?: (walletId: string, balance: bigint) => void,
): () => void {
  const walletState = useWalletStorageState(storage.walletId)

  // Seed initial keys from storage asynchronously
  void storage.listKeys().then(async keys => {
    for (const key of keys) {
      const val = await storage.get(key)
      if (val !== undefined) {
        walletState[key] = val
      }
    }
  })

  const unsubscribe = storage.subscribe((event: StorageChangeEvent<T>) => {
    // 1. Update reactive state for Vue components
    if (event.type === 'set') {
      walletState[event.key] = event.value
    } else if (event.type === 'delete') {
      delete walletState[event.key]
    } else if (event.type === 'clear') {
      for (const k of Object.keys(walletState)) {
        delete walletState[k]
      }
    }

    // 2. Specialized handling for balance updates
    if (event.key === 'balance' && event.type === 'set') {
      try {
        const raw = event.value
        const balanceBig =
          typeof raw === 'bigint'
            ? raw
            : typeof raw === 'string'
            ? BigInt(raw)
            : typeof raw === 'number'
            ? BigInt(raw)
            : 0n
        if (onBalanceChange) {
          onBalanceChange(event.walletId, balanceBig)
        }
      } catch {
        // ignore invalid balance formats
      }
    }

    // 3. Dispatch global window/process event if available
    if (
      typeof globalThis !== 'undefined' &&
      typeof globalThis.dispatchEvent === 'function'
    ) {
      try {
        const customEvent = new CustomEvent(WALLET_STORAGE_CHANGE_EVENT, {
          detail: event,
        })
        globalThis.dispatchEvent(customEvent)
      } catch {
        // Fallback for non-browser/test runtimes
      }
    }
  })

  return unsubscribe
}

/**
 * Factory helper: creates an isolated WalletStorageAdapter and automatically
 * attaches the reactive Pinia bridge.
 */
export function createObservableWalletStorage<T = unknown>(
  walletId: string,
  options?: WalletStorageOptions & {
    onBalanceChange?: (walletId: string, balance: bigint) => void
  },
): WalletStorageAdapter<T> {
  const storage = createWalletStorage<T>(walletId, options)
  attachPiniaWalletStorageBridge(storage, options?.onBalanceChange)
  return storage
}
