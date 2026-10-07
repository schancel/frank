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
  loadMonadChainConfigFromEnv,
} from '@frank/wallet/chain'
import { accountSession, accountStatus } from '../accounts/session'
import { useBalance, APP_STATE_EVENT, BALANCE_POLL_MS } from './useBalance'

export interface ChainBalanceState {
  balance: bigint | null
  formattedBalance: string
  loaded: boolean
  hasError: boolean
}

// Reactive store for non-monad chain balances
const ecashState = ref<ChainBalanceState>({
  balance: null,
  formattedBalance: '',
  loaded: false,
  hasError: false,
})

let ecashConsumers = 0
let ecashTimer: ReturnType<typeof setTimeout> | undefined
let ecashPending = false
let ecashBackgrounded = false
let stopStatusWatch: (() => void) | undefined

function clearEcashTimer() {
  if (ecashTimer !== undefined) clearTimeout(ecashTimer)
  ecashTimer = undefined
}

function scheduleEcash() {
  clearEcashTimer()
  if (
    ecashConsumers === 0 ||
    typeof document === 'undefined' ||
    !document ||
    document.hidden ||
    ecashBackgrounded
  )
    return
  ecashTimer = setTimeout(() => {
    ecashTimer = undefined
    if (ecashPending) scheduleEcash()
    else void fetchChainBalance('ecash', true)
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
    scheduleEcash()
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
      scheduleEcash()
    }
  }
}

function onVisibilityChange() {
  if (document.hidden) {
    clearEcashTimer()
  } else {
    ecashBackgrounded = false
    void fetchChainBalance('ecash', true)
  }
}

function onAppState(event: Event) {
  const isActive = (event as CustomEvent<{ isActive: boolean }>).detail
    ?.isActive
  if (isActive) {
    ecashBackgrounded = false
    void fetchChainBalance('ecash', true)
  } else {
    ecashBackgrounded = true
    clearEcashTimer()
  }
}

function acquireEcash() {
  ecashConsumers++
  if (ecashConsumers === 1) {
    stopStatusWatch = watch(
      () => [accountStatus.status, accountStatus.revision],
      () => {
        void fetchChainBalance('ecash', true)
      },
      { flush: 'sync' },
    )
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
      window.addEventListener(APP_STATE_EVENT, onAppState)
    }
  }
  void fetchChainBalance('ecash', false)
}

function releaseEcash() {
  ecashConsumers = Math.max(0, ecashConsumers - 1)
  if (ecashConsumers > 0) return
  clearEcashTimer()
  stopStatusWatch?.()
  stopStatusWatch = undefined
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener(APP_STATE_EVENT, onAppState)
  }
  ecashBackgrounded = false
}

/**
 * Accesses balance state for any chain ('monad', 'ecash', etc.).
 */
export function useChainBalance(chainRef: Ref<string> | string) {
  const monad = useBalance()

  if (getCurrentInstance()) {
    onMounted(acquireEcash)
    onUnmounted(releaseEcash)
  }

  const chain = computed(() =>
    typeof chainRef === 'string' ? chainRef : chainRef.value,
  )

  const balance = computed<bigint | null>(() => {
    if (chain.value === 'monad') return monad.balance.value
    if (chain.value === 'ecash') return ecashState.value.balance
    return null
  })

  const formattedBalance = computed<string>(() => {
    if (chain.value === 'monad') return monad.formattedBalance.value
    if (chain.value === 'ecash') return ecashState.value.formattedBalance
    return ''
  })

  const loaded = computed<boolean>(() => {
    if (chain.value === 'monad') return monad.loaded.value
    if (chain.value === 'ecash') return ecashState.value.loaded
    return false
  })

  const hasError = computed<boolean>(() => {
    if (chain.value === 'monad') return monad.hasError.value
    if (chain.value === 'ecash') return ecashState.value.hasError
    return false
  })

  return {
    balance,
    formattedBalance,
    loaded,
    hasError,
    refresh: () => {
      if (chain.value === 'monad') return monad.refresh()
      return fetchChainBalance(chain.value, true)
    },
  }
}

/**
 * Registry-wide multichain balance hook for drawer / multi-wallet views.
 */
export function useMultichainBalance() {
  const monad = useBalance()

  if (getCurrentInstance()) {
    onMounted(acquireEcash)
    onUnmounted(releaseEcash)
  }

  return {
    monad,
    ecash: readonly(ecashState),
    getFormattedBalance(chain: string): string | undefined {
      if (chain === 'monad') {
        return monad.loaded.value ? monad.formattedBalance.value : undefined
      }
      if (chain === 'ecash') {
        return ecashState.value.loaded
          ? ecashState.value.formattedBalance
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
      return null
    },
    isChainLoaded(chain: string): boolean {
      if (chain === 'monad') return monad.loaded.value
      if (chain === 'ecash') return ecashState.value.loaded
      return false
    },
    hasChainError(chain: string): boolean {
      if (chain === 'monad') return monad.hasError.value
      if (chain === 'ecash') return ecashState.value.hasError
      return false
    },
    refreshAll: async () => {
      await Promise.all([monad.refresh(), fetchChainBalance('ecash', true)])
    },
  }
}
