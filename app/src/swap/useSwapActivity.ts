import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { SwapRecordMismatchError } from '@frank/wallet/swap/evm-dex'
import {
  solanaSwapActivity,
  SolanaSwapRecordMismatchError,
} from 'src/composables/useSolanaSwap'
import { useSwapHistory } from 'src/composables/useSwapHistory'
import { exactTokenAmount, readableTokenAmount } from './amounts'
import { swapAssetSymbol } from './asset-symbol'
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
/**
 * A record whose transaction the chain does not show is asked about less and less often: after
 * 20 s, 40 s, 80 s and so on, up to once in ten minutes. A swap that will never appear (its
 * transaction was replaced or dropped) then costs a read every ten minutes, not three a minute.
 */
const MAX_RETRY_MS = 10 * 60_000
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
  // Whose swaps: the wallet's main account on this chain. Until it is known the list is empty.
  const account = ref<string>()
  let accountFor = 0
  async function readAccount(): Promise<void> {
    const chain = chainIdentifier.value
    const mine = ++accountFor
    account.value = undefined
    if (!chain) return
    try {
      // Each chain family says whose swaps its network's are.
      const solana = solanaSwapActivity(chain)
      if (!solana && evmSwapVenues(chain).length === 0) return
      const own = solana
        ? await solana.account()
        : (await openEvmSwapSession(chain)).account
      if (mine === accountFor) account.value = own
    } catch {
      /* No wallet for this chain now: nothing to list. */
    }
  }
  const swaps = history.swapsFor(
    () => chainIdentifier.value,
    () => account.value,
  )
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
      fromAsset: swapAssetSymbol(record.chainIdentifier, record.assetIn),
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
      toAsset: swapAssetSymbol(record.chainIdentifier, record.assetOut),
      route:
        solanaSwapActivity(record.chainIdentifier)?.venueName(record.venueId) ??
        evmSwapVenues(record.chainIdentifier).find(
          venue => venue.id === record.venueId,
        )?.displayName ??
        record.venueId,
      // A record the chain disowned is not listed at all (the store leaves it out).
      status:
        outcome && outcome.status !== 'foreign' ? outcome.status : 'pending',
    })),
  )

  let alive = true
  let reading = false
  let timer: ReturnType<typeof setInterval> | undefined
  /** Per record: how often the chain had nothing to say, and when to ask again. */
  const waiting = new Map<string, { misses: number; notBefore: number }>()
  const missed = (swapId: string): void => {
    const misses = (waiting.get(swapId)?.misses ?? 0) + 1
    waiting.set(swapId, {
      misses,
      notBefore:
        Date.now() + Math.min(RETRY_MS * 2 ** (misses - 1), MAX_RETRY_MS),
    })
  }
  /** Reads from the chain what the swaps with no known outcome did. Sends nothing. */
  async function readOutcomes(): Promise<void> {
    const chain = chainIdentifier.value
    if (reading || !chain || document.hidden) return
    const unknown = swaps.value
      .filter(
        entry =>
          !entry.outcome &&
          entry.record.route &&
          (waiting.get(entry.record.swapId)?.notBefore ?? 0) <= Date.now(),
      )
      .slice(0, MAX_PER_PASS)
    if (unknown.length === 0) return
    reading = true
    try {
      const solana = solanaSwapActivity(chain)
      for (const { record } of unknown) {
        try {
          if (solana) {
            // Solana: the finalized transaction must be this account's call to the exchange.
            const seen = await solana.observe(record)
            if (!alive) return
            if (!seen) missed(record.swapId)
            else
              history.cacheOutcome(
                record.swapId,
                seen.status === 'confirmed'
                  ? {
                      status: 'confirmed',
                      amountOut: seen.amountOut.toString(),
                      feeWei: seen.fee.toString(),
                    }
                  : {
                      status: 'failed',
                      feeWei: seen.fee.toString(),
                      reason: 'reverted',
                    },
              )
            continue
          }
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
          else missed(record.swapId)
        } catch (error) {
          if (!alive) return
          // The chain says this transaction is someone else's, or not a swap here: the record
          // is not shown as this account's, and is not asked about again.
          if (
            error instanceof SwapRecordMismatchError ||
            error instanceof SolanaSwapRecordMismatchError
          )
            history.cacheOutcome(record.swapId, { status: 'foreign' })
          // Not readable now: it stays pending and is asked about again, later each time.
          else missed(record.swapId)
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
  watch(chainIdentifier, () => void readAccount())
  onMounted(() => {
    void readAccount()
    void readOutcomes()
    timer = setInterval(() => void readOutcomes(), RETRY_MS)
  })
  onBeforeUnmount(() => {
    alive = false
    if (timer) clearInterval(timer)
  })

  return { rows, readOutcomes }
}
