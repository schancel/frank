import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { SwapRecordMismatchError } from '@frank/wallet/swap/evm-dex'
import { observeSwapCancellation } from '@frank/wallet/swap/swap-execution'
import {
  solanaSwapActivity,
  SolanaSwapRecordMismatchError,
} from 'src/composables/useSolanaSwap'
import { useSwapHistory } from 'src/composables/useSwapHistory'
import { exactTokenAmount, readableTokenAmount } from './amounts'
import { swapAssetSymbol } from './asset-symbol'
import {
  evmRecordedSwapVenues,
  openRecordedEvmSwapSession,
} from './evm-swap-session'

export interface SwapActivityRow {
  id: string
  timestamp: number
  chainIdentifier: string
  txHash: string
  /** The cancellation that gave the swap up past its deadline, when its record names one. */
  cancelTxHash?: string
  fromAmount: string
  fromAsset: string
  /** What arrived when the chain has been read; until then the least that may arrive. */
  toAmount: string
  toAsset: string
  route: string
  /** `cancelled`: given up past its deadline; nothing was swapped, only the cancellation's
   * fee was paid. */
  status: 'confirmed' | 'pending' | 'failed' | 'cancelled'
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
      if (!solana && evmRecordedSwapVenues(chain).length === 0) return
      const own = solana
        ? await solana.account()
        : (await openRecordedEvmSwapSession(chain)).account
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
      ...(record.cancelTxHash ? { cancelTxHash: record.cancelTxHash } : {}),
      fromAmount: exactTokenAmount(
        BigInt(record.amountIn),
        record.assetIn.decimals,
      ),
      fromAsset: swapAssetSymbol(record.chainIdentifier, record.assetIn),
      toAmount:
        outcome?.status === 'failed' || outcome?.status === 'cancelled'
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
        evmRecordedSwapVenues(record.chainIdentifier).find(
          venue => venue.id === record.venueId,
        )?.displayName ??
        record.venueId,
      // A record the chain disowned is not listed at all (the store leaves it out). A swap
      // given up past its deadline reads "Cancelled" once the chain shows its cancellation.
      status:
        outcome && outcome.status !== 'foreign' ? outcome.status : 'pending',
    })),
  )

  let alive = true
  let reading = false
  let timer: ReturnType<typeof setInterval> | undefined
  /** Per record: how often the chain had nothing to say, and when to ask again. A record that
   * comes to name its cancellation is asked about afresh: it is a new question. */
  const waiting = new Map<string, { misses: number; notBefore: number }>()
  const waitKey = (record: { swapId: string; cancelTxHash?: string }) =>
    `${record.swapId}:${record.cancelTxHash ?? ''}`
  const missed = (record: { swapId: string; cancelTxHash?: string }): void => {
    const key = waitKey(record)
    const misses = (waiting.get(key)?.misses ?? 0) + 1
    waiting.set(key, {
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
          (entry.record.route || entry.record.cancelTxHash) &&
          (waiting.get(waitKey(entry.record))?.notBefore ?? 0) <= Date.now(),
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
            if (!seen) missed(record)
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
          const session = await openRecordedEvmSwapSession(
            chain,
            record.venueId,
          )
          // The swap's own transaction first: what the chain shows of it stands. A record
          // without its route can only be read by its cancellation.
          const result = record.route
            ? await session.dex.observe({
                transactionId: record.txHash,
                account: record.account,
                route: JSON.parse(record.route),
              })
            : undefined
          if (!alive) return
          if (
            record.cancelTxHash &&
            (result === undefined || result.status === 'pending')
          ) {
            // Given up past its deadline by a cancellation of the account's: the chain must show
            // it, a transfer of nothing from the account to itself, in a block.
            const cancelled = await observeSwapCancellation(session.reader, {
              cancelTxHash: record.cancelTxHash,
              account: record.account,
            })
            if (!alive) return
            if (cancelled.status === 'cancelled')
              history.cacheOutcome(record.swapId, {
                status: 'cancelled',
                feeWei: cancelled.feeWei.toString(),
                reason: 'cancelled',
              })
            else missed(record)
          } else if (result === undefined) missed(record)
          else if (result.status === 'confirmed')
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
          else missed(record)
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
          else missed(record)
        }
      }
    } finally {
      reading = false
    }
  }

  watch(
    () =>
      swaps.value
        .filter(entry => !entry.outcome)
        .map(entry => waitKey(entry.record))
        .join(','),
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
