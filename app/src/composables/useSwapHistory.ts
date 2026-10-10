import { computed } from 'vue'
import { getActivePinia } from 'pinia'
import type { SwapRecordItem } from '@frank/cashweb/types/messages'
import {
  useSwapStore,
  type SwapOutcome,
  type SwapRecord,
} from '../stores/swaps'

export type { SwapOutcome, SwapRecord }

/** The account's swaps on one chain, each with the outcome read from the chain when known. */
export function useSwapHistory() {
  // A component mounted without the app's stores (a narrow test) has no history to show.
  if (!getActivePinia())
    return {
      swapsForChain: (_chainIdentifier: () => string | undefined) =>
        computed<{ record: SwapRecord; outcome: SwapOutcome | undefined }[]>(
          () => [],
        ),
      handleSwapItem: (_item: SwapRecordItem) => undefined,
      cacheOutcome: (_swapId: string, _outcome: SwapOutcome) => undefined,
    }
  const store = useSwapStore()
  return {
    swapsForChain: (chainIdentifier: () => string | undefined) =>
      computed(() =>
        store.getSwapsForChain(chainIdentifier()).map(record => ({
          record,
          outcome: store.outcomes[record.swapId] as SwapOutcome | undefined,
        })),
      ),
    handleSwapItem: (item: SwapRecordItem) => store.handleSwapItem(item),
    cacheOutcome: (swapId: string, outcome: SwapOutcome) =>
      store.cacheOutcome(swapId, outcome),
  }
}
