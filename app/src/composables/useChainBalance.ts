/**
 * Read-only multichain balance composable.
 *
 * Provides shared, reactive balance polling for secondary chains (such as eCash)
 * by querying public indexers / relay reverse proxies based strictly on address.
 * Does NOT touch or mutate the Monad stamp wallet custody roots.
 */
import {
  computed,
  getCurrentInstance,
  onMounted,
  onUnmounted,
  readonly,
  ref,
  watch,
  type Ref,
} from 'vue'
import {
  activeChain,
  fetchEcashBalance,
  fetchSolanaBalance,
  fetchSolanaTokenAccounts,
  loadMonadChainConfigFromEnv,
  type SolanaTokenAccount,
} from '@frank/wallet/chain'
import { accountSession, accountStatus } from '../accounts/session'
import { useBalance, APP_STATE_EVENT, BALANCE_POLL_MS } from './useBalance'

export interface TokenItem {
  id: string
  symbol: string
  name: string
  mintOrAddress: string
  balanceFormatted: string
  numericBalance: number
  avuFormatted: string
  decimals?: number
  isNative?: boolean
}

export interface ChainBalanceState {
  balance: bigint | null
  formattedBalance: string
  loaded: boolean
  hasError: boolean
  tokens?: SolanaTokenAccount[]
}

export interface BalanceObservation {
  balance: bigint
  formattedBalance: string
}

export type BalancePresentation =
  | { status: 'loading' }
  | { status: 'available'; observation: BalanceObservation }
  | {
      status: 'unavailable'
      reason: 'unsupported' | 'fetch-error'
      lastKnown?: BalanceObservation
    }

// Derived presentation only: the existing readers remain the observation owners.
function getBalancePresentation(
  chain: string,
  monad: ReturnType<typeof useBalance>,
): BalancePresentation {
  let state: ChainBalanceState
  if (chain === 'monad') {
    state = {
      balance: monad.balance.value,
      formattedBalance: monad.formattedBalance.value,
      loaded: monad.loaded.value,
      hasError: monad.hasError.value,
    }
  } else if (chain === 'ecash') state = ecashState.value
  else if (chain === 'solana') state = solanaState.value
  else return { status: 'unavailable', reason: 'unsupported' }

  const observation =
    state.loaded && state.balance !== null
      ? { balance: state.balance, formattedBalance: state.formattedBalance }
      : undefined
  if (state.hasError) {
    return {
      status: 'unavailable',
      reason: 'fetch-error',
      lastKnown: observation,
    }
  }
  return observation
    ? { status: 'available', observation }
    : { status: 'loading' }
}

// Reactive store for non-monad chain balances
const ecashState = ref<ChainBalanceState>({
  balance: null,
  formattedBalance: '',
  loaded: false,
  hasError: false,
})

const solanaState = ref<ChainBalanceState>({
  balance: null,
  formattedBalance: '',
  loaded: false,
  hasError: false,
  tokens: [],
})

let multichainConsumers = 0
let multichainTimer: ReturnType<typeof setTimeout> | undefined
let ecashPending = false
let solanaPending = false
let multichainBackgrounded = false
let stopStatusWatch: (() => void) | undefined

function clearPollingTimer() {
  if (multichainTimer !== undefined) clearTimeout(multichainTimer)
  multichainTimer = undefined
}

function schedulePolling() {
  clearPollingTimer()
  if (
    multichainConsumers === 0 ||
    typeof document === 'undefined' ||
    !document ||
    document.hidden ||
    multichainBackgrounded
  )
    return
  multichainTimer = setTimeout(() => {
    multichainTimer = undefined
    if (ecashPending || solanaPending) schedulePolling()
    else {
      void fetchChainBalance('ecash', true)
      void fetchChainBalance('solana', true)
    }
  }, BALANCE_POLL_MS)
}

export async function fetchChainBalance(
  chain: string,
  force = false,
): Promise<void> {
  if (chain === 'monad') return
  if (chain === 'ecash') {
    if (ecashPending && !force) return
    ecashPending = true
    schedulePolling()
    try {
      if (accountStatus.status !== 'ready') {
        ecashState.value = {
          balance: null,
          formattedBalance: '',
          loaded: false,
          hasError: false,
        }
        return
      }
      let address = accountSession.getCachedChainAddress?.('ecash')
      if (!address) {
        address = await accountSession.getChainAddress?.('ecash')
      }
      if (!address) {
        return
      }
      const relayBaseUrl = loadMonadChainConfigFromEnv().relayBaseUrl
      const networkId = activeChain.isTestnet ? 'xec-testnet' : 'xec-mainnet'
      const result = await fetchEcashBalance({
        address,
        networkId,
        relayBaseUrl,
      })
      ecashState.value = {
        balance: result.sats,
        formattedBalance: result.formatted,
        loaded: true,
        hasError: false,
      }
    } catch (err) {
      console.error('Failed to fetch eCash balance', err)
      ecashState.value = {
        ...ecashState.value,
        hasError: true,
      }
    } finally {
      ecashPending = false
      schedulePolling()
    }
  } else if (chain === 'solana') {
    if (solanaPending && !force) return
    solanaPending = true
    schedulePolling()
    try {
      if (accountStatus.status !== 'ready') {
        solanaState.value = {
          balance: null,
          formattedBalance: '',
          loaded: false,
          hasError: false,
        }
        return
      }
      let address = accountSession.getCachedChainAddress?.('solana')
      if (!address) {
        address = await accountSession.getChainAddress?.('solana')
      }
      if (!address) {
        return
      }
      const relayBaseUrl = loadMonadChainConfigFromEnv().relayBaseUrl
      const networkId = activeChain.isTestnet
        ? 'solana-devnet'
        : 'solana-mainnet'
      const [result, tokensResult] = await Promise.all([
        fetchSolanaBalance({
          address,
          networkId,
          relayBaseUrl,
        }),
        fetchSolanaTokenAccounts({
          address,
          networkId,
          relayBaseUrl,
        }).catch(() => []),
      ])
      solanaState.value = {
        balance: result.lamports,
        formattedBalance: result.formatted,
        loaded: true,
        hasError: false,
        tokens: tokensResult,
      }
    } catch (err) {
      console.error('Failed to fetch Solana balance', err)
      solanaState.value = {
        ...solanaState.value,
        hasError: true,
      }
    } finally {
      solanaPending = false
      schedulePolling()
    }
  }
}

function onVisibilityChange() {
  if (document.hidden) {
    clearPollingTimer()
  } else {
    multichainBackgrounded = false
    void fetchChainBalance('ecash', true)
    void fetchChainBalance('solana', true)
  }
}

function onAppState(event: Event) {
  const isActive = (event as CustomEvent<{ isActive: boolean }>).detail
    ?.isActive
  if (isActive) {
    multichainBackgrounded = false
    void fetchChainBalance('ecash', true)
    void fetchChainBalance('solana', true)
  } else {
    multichainBackgrounded = true
    clearPollingTimer()
  }
}

function acquireMultichain() {
  multichainConsumers++
  if (multichainConsumers === 1) {
    stopStatusWatch = watch(
      () => [accountStatus.status, accountStatus.revision],
      () => {
        void fetchChainBalance('ecash', true)
        void fetchChainBalance('solana', true)
      },
      { flush: 'sync' },
    )
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
      window.addEventListener(APP_STATE_EVENT, onAppState)
    }
  }
  void fetchChainBalance('ecash', false)
  void fetchChainBalance('solana', false)
}

function releaseMultichain() {
  multichainConsumers = Math.max(0, multichainConsumers - 1)
  if (multichainConsumers > 0) return
  clearPollingTimer()
  stopStatusWatch?.()
  stopStatusWatch = undefined
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener(APP_STATE_EVENT, onAppState)
  }
  multichainBackgrounded = false
}

/**
 * Accesses balance state for any chain ('monad', 'ecash', 'solana', etc.).
 */
export function useChainBalance(chainRef: Ref<string> | string) {
  const monad = useBalance()

  if (getCurrentInstance()) {
    onMounted(acquireMultichain)
    onUnmounted(releaseMultichain)
  }

  const chain = computed(() =>
    typeof chainRef === 'string' ? chainRef : chainRef.value,
  )

  const balance = computed<bigint | null>(() => {
    if (chain.value === 'monad') return monad.balance.value
    if (chain.value === 'ecash') return ecashState.value.balance
    if (chain.value === 'solana') return solanaState.value.balance
    return null
  })

  const formattedBalance = computed<string>(() => {
    if (chain.value === 'monad') return monad.formattedBalance.value
    if (chain.value === 'ecash') return ecashState.value.formattedBalance
    if (chain.value === 'solana') return solanaState.value.formattedBalance
    return ''
  })

  const loaded = computed<boolean>(() => {
    if (chain.value === 'monad') return monad.loaded.value
    if (chain.value === 'ecash') return ecashState.value.loaded
    if (chain.value === 'solana') return solanaState.value.loaded
    return false
  })

  const hasError = computed<boolean>(() => {
    if (chain.value === 'monad') return monad.hasError.value
    if (chain.value === 'ecash') return ecashState.value.hasError
    if (chain.value === 'solana') return solanaState.value.hasError
    return false
  })

  const tokens = computed<TokenItem[]>(() => getChainTokens(chain.value))

  const presentation = computed(() =>
    getBalancePresentation(chain.value, monad),
  )

  return {
    presentation,
    balance,
    formattedBalance,
    tokens,
    loaded,
    hasError,
    refresh: () => {
      if (chain.value === 'monad') return monad.refresh()
      return fetchChainBalance(chain.value, true)
    },
  }
}

/**
 * Returns available native and sub-token assets for a given chain.
 */
export function getChainTokens(chainName: string): TokenItem[] {
  if (chainName === 'solana') {
    if (!solanaState.value.loaded || solanaState.value.balance === null)
      return []
    const isTestnet = activeChain.isTestnet
    const nativeSymbol = isTestnet ? 'tSOL' : 'SOL'
    const nativeBal = solanaState.value.formattedBalance
    const nativeNum = solanaState.value.balance
      ? Number(solanaState.value.balance) / 1e9
      : 0
    const avuVal = nativeNum * 145.0 * 11.90476
    const nativeAvu =
      avuVal > 0
        ? `≈ ${avuVal.toLocaleString('en-US', {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          })} AVU`
        : ''

    const items: TokenItem[] = [
      {
        id: 'solana-native',
        symbol: nativeSymbol,
        name: 'Solana',
        mintOrAddress: accountSession.getCachedChainAddress?.('solana') || '',
        balanceFormatted: nativeBal,
        numericBalance: nativeNum,
        avuFormatted: nativeAvu,
        decimals: 9,
        isNative: true,
      },
    ]

    const splTokens = solanaState.value.tokens || []
    for (const t of splTokens) {
      items.push({
        id: t.mint,
        symbol: t.symbol,
        name: t.name,
        mintOrAddress: t.mint,
        balanceFormatted: t.formatted,
        numericBalance: t.uiAmount,
        avuFormatted: t.avuFormatted,
        decimals: t.decimals,
        isNative: false,
      })
    }

    return items
  }

  return []
}

/**
 * Registry-wide multichain balance hook for drawer / multi-wallet views.
 */
export function useMultichainBalance() {
  const monad = useBalance()

  if (getCurrentInstance()) {
    onMounted(acquireMultichain)
    onUnmounted(releaseMultichain)
  }

  return {
    getPresentation: (chain: string) => getBalancePresentation(chain, monad),
    monad,
    ecash: readonly(ecashState),
    solana: readonly(solanaState),
    getTokens: (chain: string) => getChainTokens(chain),
    getFormattedBalance(chain: string): string | undefined {
      if (chain === 'monad') {
        return monad.loaded.value ? monad.formattedBalance.value : undefined
      }
      if (chain === 'ecash') {
        return ecashState.value.loaded
          ? ecashState.value.formattedBalance
          : undefined
      }
      if (chain === 'solana') {
        return solanaState.value.loaded
          ? solanaState.value.formattedBalance
          : undefined
      }
      return undefined
    },
    getRawBalance(chain: string): bigint | null {
      if (chain === 'monad') {
        return monad.loaded.value ? monad.balance.value : null
      }
      if (chain === 'ecash') {
        return ecashState.value.loaded ? ecashState.value.balance : null
      }
      if (chain === 'solana') {
        return solanaState.value.loaded ? solanaState.value.balance : null
      }
      return null
    },
    isChainLoaded(chain: string): boolean {
      if (chain === 'monad') return monad.loaded.value
      if (chain === 'ecash') return ecashState.value.loaded
      if (chain === 'solana') return solanaState.value.loaded
      return false
    },
    hasChainError(chain: string): boolean {
      if (chain === 'monad') return monad.hasError.value
      if (chain === 'ecash') return ecashState.value.hasError
      if (chain === 'solana') return solanaState.value.hasError
      return false
    },
    refreshAll: async () => {
      await Promise.all([
        monad.refresh(),
        fetchChainBalance('ecash', true),
        fetchChainBalance('solana', true),
      ])
    },
  }
}
