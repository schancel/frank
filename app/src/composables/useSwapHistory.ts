import { computed, ref } from 'vue'
import { getActivePinia } from 'pinia'
import { useChatStore } from '../stores/chats'

export interface SwapRecord {
  id: string
  timestamp: number
  chain: string
  fromAsset: string
  toAsset: string
  fromAmount: string
  toAmount: string
  txHash: string
  route: string
  feeDisplay: string
  destinationAddress?: string
  status: 'confirmed' | 'pending' | 'failed'
}

const STORAGE_KEY = 'frank_swap_history'
const swapHistory = ref<SwapRecord[]>([])
let isInitialized = false

function loadHistory(): void {
  if (isInitialized || typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      swapHistory.value = JSON.parse(raw)
    }
  } catch {
    // Ignore storage parse errors
  }
  isInitialized = true
}

function saveHistory(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(swapHistory.value.slice(0, 100)),
    )
  } catch {
    //
  }
}

export function useSwapHistory() {
  loadHistory()

  async function logSwap(
    params: Omit<SwapRecord, 'id' | 'timestamp' | 'status'> & {
      id?: string
      timestamp?: number
      status?: 'confirmed' | 'pending' | 'failed'
    },
  ): Promise<SwapRecord> {
    const record: SwapRecord = {
      id:
        params.id ||
        'swap-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7),
      timestamp: params.timestamp || Date.now(),
      chain: params.chain.toLowerCase(),
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

    swapHistory.value = [record, ...swapHistory.value.slice(0, 99)]
    saveHistory()

    // Self-send message to log the swap in durable local chat storage
    try {
      if (typeof getActivePinia === 'function' && getActivePinia()) {
        const chats = useChatStore()
        if (typeof chats?.selfSendMessage === 'function') {
          const text = `[Instant Swap] ${record.fromAmount} ${
            record.fromAsset
          } → ${record.toAmount} ${
            record.toAsset
          }\nChain: ${record.chain.toUpperCase()} · Route: ${
            record.route
          }\nTx: ${record.txHash}\nFee: ${record.feeDisplay}`
          await chats.selfSendMessage({
            items: [{ type: 'text', text }],
            type: 'swap',
            meta: {
              swapId: record.id,
              chain: record.chain,
              txHash: record.txHash,
            },
          })
        }
      }
    } catch (err) {
      console.warn('Failed to log swap to selfSendMessage:', err)
    }

    return record
  }

  function getSwapsForChain(chainName: string) {
    const c = chainName.toLowerCase()
    return computed(() =>
      swapHistory.value.filter(
        s => s.chain === c || (c === 'solana' && s.chain.includes('solana')),
      ),
    )
  }

  return {
    allSwaps: computed(() => swapHistory.value),
    getSwapsForChain,
    logSwap,
  }
}
