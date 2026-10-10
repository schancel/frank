import { computed, onBeforeUnmount, onMounted, watch, type Ref } from 'vue'
import { useSwapHistory } from 'src/composables/useSwapHistory'
import { exactTokenAmount, readableTokenAmount } from './amounts'
import { evmSwapVenues, openEvmSwapSession } from './evm-swap-session'

export interface SwapActivityRow {
  id: string
  timestamp: number
  chainIdentifier: string
  txHash: string
  fromAmount: string
  fromAsset: string
  /** What arrived when the chain has been read; until then the least that may arrive. */
  toAmount: string
  toAsset: string
  route: string
  status: 'confirmed' | 'pending' | 'failed'
}

const RETRY_MS = 20_000
/** Outcomes read from the chain in one pass: a long history is not asked about all at once. */
const MAX_PER_PASS = 5

/**
 * A chain's swaps for display: the account's swap records (from its notes to self, and on this
 * device from the wallet's journal) with what each did, read from the chain by its transaction
 * and remembered. A record whose outcome is not known yet shows as pending and is asked about
 * again, a few at a time, while the page is visible.
 */
export function useSwapActivity(chainIdentifier: Ref<string | undefined>) {
  const history = useSwapHistory()
  const swaps = history.swapsForChain(() => chainIdentifier.value)
  const rows = computed<SwapActivityRow[]>(() =>
    swaps.value.map(({ record, outcome }) => ({
      id: record.swapId,
      timestamp: record.timestamp,
      chainIdentifier: record.chainIdentifier,
      txHash: record.txHash,
      fromAmount: exactTokenAmount(
        BigInt(record.amountIn),
        record.assetIn.decimals,
      ),
      fromAsset: record.assetIn.symbol,
      toAmount:
        outcome?.status === 'failed'
          ? '0'
          : outcome?.amountOut !== undefined
          ? readableTokenAmount(
              BigInt(outcome.amountOut),
              record.assetOut.decimals,
            )
          : exactTokenAmount(
              BigInt(record.minimumAmountOut),
              record.assetOut.decimals,
            ),
      toAsset: record.assetOut.symbol,
      route:
        evmSwapVenues(record.chainIdentifier).find(
          venue => venue.id === record.venueId,
        )?.displayName ?? record.venueId,
      status: outcome?.status ?? 'pending',
    })),
  )

  let alive = true
  let reading = false
  let timer: ReturnType<typeof setInterval> | undefined
  /** Reads from the chain what the swaps with no known outcome did. Sends nothing. */
  async function readOutcomes(): Promise<void> {
    const chain = chainIdentifier.value
    if (reading || !chain || document.hidden) return
    const unknown = swaps.value
      .filter(entry => !entry.outcome && entry.record.route)
      .slice(0, MAX_PER_PASS)
    if (unknown.length === 0) return
    reading = true
    try {
      for (const { record } of unknown) {
        try {
          const session = await openEvmSwapSession(chain, record.venueId)
          const result = await session.dex.observe({
            transactionId: record.txHash,
            account: record.account,
            route: JSON.parse(record.route as string),
          })
          if (!alive) return
          if (result.status === 'confirmed')
            history.cacheOutcome(record.swapId, {
              status: 'confirmed',
              ...(result.amountOut === undefined
                ? {}
                : { amountOut: result.amountOut.toString() }),
              feeWei: result.feeWei.toString(),
            })
          else if (result.status === 'reverted')
            history.cacheOutcome(record.swapId, {
              status: 'failed',
              feeWei: result.feeWei.toString(),
              reason: 'reverted',
            })
        } catch {
          /* Not readable now: it stays pending and is asked about again. */
        }
      }
    } finally {
      reading = false
    }
  }

  watch(
    () => swaps.value.filter(entry => !entry.outcome).length,
    () => void readOutcomes(),
  )
  onMounted(() => {
    void readOutcomes()
    timer = setInterval(() => void readOutcomes(), RETRY_MS)
  })
  onBeforeUnmount(() => {
    alive = false
    if (timer) clearInterval(timer)
  })

  return { rows, readOutcomes }
}
