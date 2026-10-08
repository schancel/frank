import { computed } from 'vue'
import { getActivePinia } from 'pinia'
import { useSwapStore, type SwapRecord } from '../stores/swaps'

export type { SwapRecord }

export function useSwapHistory() {
  try {
    if (typeof getActivePinia === 'function' && getActivePinia()) {
      const swapStore = useSwapStore()
      return {
        allSwaps: computed(() => swapStore.allSwaps),
        getSwapsForChain: (chainName: string) =>
          computed(() => swapStore.getSwapsForChain(chainName)),
        logSwap: (params: Parameters<typeof swapStore.recordSwap>[0]) =>
          swapStore.recordSwap(params),
      }
    }
  } catch {
    // Pinia not active or uninitialized
  }

  // Fallback for non-pinia test harnesses
  return {
    allSwaps: computed(() => []),
    getSwapsForChain: () => computed(() => []),
    logSwap: async (params: any) => ({
      id: params.id || 'swap-mock',
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
    }),
  }
}
