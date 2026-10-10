import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { readTokenBalance } from '@frank/wallet/swap/evm-swap'
import { evmSwapVenues, openEvmSwapSession } from 'src/swap/evm-swap-session'
import { exactTokenAmount, readableTokenAmount } from 'src/swap/amounts'

export interface EvmTokenRow {
  symbol: string
  name: string
  address: string
  /** Shortened for reading; `exact` has every digit. */
  balance: string
  exact: string
}

const REFRESH_MS = 20_000
/** Without any input for this long, the balances are not read until the page is touched. */
const IDLE_AFTER_MS = 120_000

/**
 * The ERC-20 balances of the wallet's main account on one EVM chain, read from the chain
 * (`balanceOf`) for the tokens that chain's swap deployment lists. Narrow on purpose: it is what
 * a swap needs to show, not a token inventory.
 */
export function useEvmTokenBalances(chainIdentifier: Ref<string | undefined>) {
  const rows = ref<EvmTokenRow[]>([])
  const status = ref<'none' | 'loading' | 'available' | 'unavailable'>('none')
  let timer: ReturnType<typeof setInterval> | undefined
  let generation = 0

  async function refresh(): Promise<void> {
    const id = chainIdentifier.value
    const mine = ++generation
    if (!id || evmSwapVenues(id).length === 0) {
      rows.value = []
      status.value = 'none'
      return
    }
    if (status.value !== 'available') status.value = 'loading'
    try {
      const session = await openEvmSwapSession(id)
      const balances = await Promise.all(
        session.dex.tokens.map(token =>
          readTokenBalance(session.reader, token, session.account),
        ),
      )
      if (mine !== generation) return
      rows.value = session.dex.tokens.flatMap((token, index) =>
        token.address === null
          ? []
          : [
              {
                symbol: token.symbol,
                name: token.name,
                address: token.address,
                balance: readableTokenAmount(balances[index]!, token.decimals),
                exact: exactTokenAmount(balances[index]!, token.decimals),
              },
            ],
      )
      status.value = 'available'
    } catch {
      if (mine !== generation) return
      // Balances already shown stay; with none to show, say they could not be read.
      if (rows.value.length === 0) status.value = 'unavailable'
    }
  }

  watch(chainIdentifier, () => {
    rows.value = []
    status.value = 'none'
    void refresh()
  })
  // The timer only reads while someone is looking: not in a hidden tab, and not after two
  // minutes without any input. It reads again at once when either ends.
  let lastInputAt = Date.now()
  const watching = () =>
    !document.hidden && Date.now() - lastInputAt < IDLE_AFTER_MS
  const touched = () => {
    const wasWatching = watching()
    lastInputAt = Date.now()
    if (!wasWatching && watching()) void refresh()
  }
  const onVisibility = () => {
    if (watching()) void refresh()
  }
  onMounted(() => {
    void refresh()
    timer = setInterval(() => {
      if (watching()) void refresh()
    }, REFRESH_MS)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pointerdown', touched)
    window.addEventListener('keydown', touched)
  })
  onBeforeUnmount(() => {
    generation++
    if (timer) clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pointerdown', touched)
    window.removeEventListener('keydown', touched)
  })

  return { rows, status, refresh }
}
