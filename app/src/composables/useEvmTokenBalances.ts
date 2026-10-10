import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { readTokenBalances } from '@frank/wallet/swap/evm-swap'
import { evmSwapDeployment, openEvmSwapSession } from 'src/swap/evm-swap-session'
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
    if (!id || !evmSwapDeployment(id)) {
      rows.value = []
      status.value = 'none'
      return
    }
    if (status.value !== 'available') status.value = 'loading'
    try {
      const session = await openEvmSwapSession(id)
      const balances = await readTokenBalances(
        session.reader,
        session.deployment,
        session.account,
      )
      if (mine !== generation) return
      rows.value = session.deployment.tokens.flatMap((token, index) =>
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
  onMounted(() => {
    void refresh()
    timer = setInterval(() => void refresh(), REFRESH_MS)
  })
  onBeforeUnmount(() => {
    generation++
    if (timer) clearInterval(timer)
  })

  return { rows, status, refresh }
}
