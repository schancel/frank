import { computed, ref } from 'vue'
import { getActivePinia } from 'pinia'
import { useSwapStore, type SwapRecord } from '../stores/swaps'

export type { SwapRecord }

const STORAGE_KEY = 'frank_swap_history'
const fallbackSwaps = ref<SwapRecord[]>([])

function loadFallbackHistory(): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    fallbackSwaps.value = []
    return
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    fallbackSwaps.value = raw ? JSON.parse(raw) : []
  } catch {
    fallbackSwaps.value = []
  }
}

function saveFallbackHistory(): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(fallbackSwaps.value.slice(0, 100)),
    )
  } catch {
    // ignore
  }
}

export function useSwapHistory() {
  try {
    if (typeof getActivePinia === 'function' && getActivePinia()) {
      const swapStore = useSwapStore()
      return {
        allSwaps: computed(() => swapStore.allSwaps),
        getSwapsForChain: (chainName: string, chainIdentifier?: string) =>
          computed(() =>
            swapStore.getSwapsForChain(chainName, chainIdentifier),
          ),
        saveLocal: (record: SwapRecord) => swapStore.saveLocal(record),
        logSwap: (params: Parameters<typeof swapStore.recordSwap>[0]) =>
          swapStore.recordSwap(params),
      }
    }
  } catch {
    // Pinia not active or uninitialized
  }

  // Fallback for non-pinia test harnesses
  loadFallbackHistory()

  return {
    allSwaps: computed(() => fallbackSwaps.value),
    getSwapsForChain: (chainName: string, chainIdentifier?: string) => {
      const c = chainName.toLowerCase()
      return computed(() =>
        fallbackSwaps.value.filter(
          s =>
            (s.chain === c || (c === 'solana' && s.chain.includes('solana'))) &&
            (!chainIdentifier ||
              !s.chainIdentifier ||
              s.chainIdentifier === chainIdentifier),
        ),
      )
    },
    saveLocal: (record: SwapRecord) => {
      fallbackSwaps.value = [
        record,
        ...fallbackSwaps.value.filter(s => s.id !== record.id).slice(0, 99),
      ]
      saveFallbackHistory()
    },
    logSwap: async (params: any) => {
      const record: SwapRecord = {
        id:
          params.id ||
          'swap-' +
            Date.now() +
            '-' +
            Math.random().toString(36).substring(2, 7),
        timestamp: params.timestamp || Date.now(),
        chain: (params.chain || 'solana').toLowerCase(),
        fromAsset: params.fromAsset,
        toAsset: params.toAsset,
        fromAmount: params.fromAmount,
        toAmount: params.toAmount,
        txHash: params.txHash,
        route: params.route,
        feeDisplay: params.feeDisplay,
        destinationAddress: params.destinationAddress,
        status: params.status || 'confirmed',
      }
      fallbackSwaps.value = [record, ...fallbackSwaps.value.slice(0, 99)]
      saveFallbackHistory()
      return record
    },
  }
}
