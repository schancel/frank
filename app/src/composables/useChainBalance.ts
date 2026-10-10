/**
 * Balances for every wallet row, read by the chain's family.
 *
 * The registry's `wallet` setting decides whether a row has a balance at all. Bitcoin-family
 * rows (eCash, Bitcoin, Bitcoin Cash) ask the session's wallet for that chain, which sums every
 * address it owns through the relay. Solana reads its address over the relay's RPC proxy. Monad
 * keeps its own reader (./useBalance). Anything else is explicitly unsupported.
 */
import {
  computed,
  getCurrentInstance,
  onMounted,
  onUnmounted,
  reactive,
  readonly,
  ref,
  watch,
  type Ref,
} from 'vue'
import {
  activeChain,
  fetchSolanaBalance,
  fetchSolanaTokenAccounts,
  loadMonadChainConfigFromEnv,
  type SolanaTokenAccount,
} from '@frank/wallet/chain'
import { getChainRegistryEntry } from '@frank/wallet/chain/chains-registry'
import { accountSession, accountStatus } from '../accounts/session'
import { openUtxoWallet } from '../accounts/utxo-wallets'
import { useBalance, APP_STATE_EVENT, BALANCE_POLL_MS } from './useBalance'
import { useSafeOracleStore } from '../stores/oracle'
import { walletSupport } from '../utils/wallet-support'
import { WALLET_CONFIGS } from '../utils/wallet-configs'

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
}

export interface BalanceObservation {
  /** The balance shown for the chain, in base units. For Monad it is `useBalance().total`. */
  balance: bigint
  formattedBalance: string
  /** Every digit of `balance`, for a title; absent where the formatted text is already exact. */
  exactBalance?: string
}

export type BalancePresentation =
  | { status: 'loading' }
  | { status: 'available'; observation: BalanceObservation }
  | {
      status: 'unavailable'
      reason: 'unsupported' | 'fetch-error'
      lastKnown?: BalanceObservation
    }

export type TokenObservation =
  | { status: 'loading'; lastKnown?: SolanaTokenAccount[] }
  | { status: 'available'; tokens: SolanaTokenAccount[] }
  | { status: 'unavailable'; lastKnown?: SolanaTokenAccount[] }

function observedTokens(observation: TokenObservation) {
  return observation.status === 'available'
    ? observation.tokens
    : observation.lastKnown
}

/**
 * THE Monad balance figure the app shows, as a raw amount: `useBalance().total`, the one
 * shown-balance figure there is. Every place that shows the Monad balance or converts it
 * (to AVU, to anything) reads it here, so two figures for one balance cannot appear side
 * by side (2026-10-10: the wallet list valued the balance without the profile address's
 * money and the Wallet page valued it with). null while not loaded.
 */
function shownMonadBalance(
  monad: ReturnType<typeof useBalance>,
): bigint | null {
  return monad.loaded.value ? monad.total.value : null
}

// Derived presentation only: the existing readers remain the observation owners.
function getBalancePresentation(
  chain: string,
  monad: ReturnType<typeof useBalance>,
): BalancePresentation {
  let state: ChainBalanceState
  let exactBalance: string | undefined
  if (chain === 'monad') {
    exactBalance = monad.exactBalance?.value
    state = {
      balance: shownMonadBalance(monad),
      formattedBalance: monad.formattedBalance.value,
      loaded: monad.loaded.value,
      hasError: monad.hasError.value,
    }
  } else if (chain === 'solana') state = solanaState.value
  else if (utxoChainIdentifier(chain)) state = utxoState(chain)
  else return { status: 'unavailable', reason: 'unsupported' }

  const observation =
    state.loaded && state.balance !== null
      ? {
          balance: state.balance,
          formattedBalance: state.formattedBalance,
          ...(exactBalance ? { exactBalance } : {}),
        }
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

const EMPTY_STATE: ChainBalanceState = {
  balance: null,
  formattedBalance: '',
  loaded: false,
  hasError: false,
}

// One state per Bitcoin-family wallet row, keyed by the row's id (`ecash`, `bitcoin`, ...).
const utxoStates = reactive<Record<string, ChainBalanceState>>({})
const utxoPending = new Set<string>()

function utxoState(chain: string): ChainBalanceState {
  return utxoStates[chain] ?? EMPTY_STATE
}

/** The canonical chain a row reads as a Bitcoin-family wallet, if the registry gives it one. */
function utxoChainIdentifier(chain: string): string | undefined {
  const support = walletSupport(chain, activeChain.isTestnet ?? false)
  return support.status !== 'unsupported' && support.entry.family === 'bitcoin'
    ? support.entry.id
    : undefined
}

function utxoRows(): string[] {
  return WALLET_CONFIGS.map(wallet => wallet.id).filter(
    id => utxoChainIdentifier(id) !== undefined,
  )
}

function fetchSecondaryBalances(force: boolean) {
  for (const chain of utxoRows()) void fetchChainBalance(chain, force)
  void fetchChainBalance('solana', force)
}

const solanaState = ref<ChainBalanceState>({
  balance: null,
  formattedBalance: '',
  loaded: false,
  hasError: false,
})

// SPL observations have one owner and never share native SOL's success/failure state.
const solanaTokenObservation = ref<TokenObservation>({ status: 'loading' })
let solanaRequestGeneration = 0
let solanaScope: { revision: number; networkId: string } | undefined

function solanaNetworkId() {
  return activeChain.isTestnet ? 'solana-devnet' : 'solana-mainnet'
}

function resetSolanaObservations() {
  solanaState.value = {
    balance: null,
    formattedBalance: '',
    loaded: false,
    hasError: false,
  }
  solanaTokenObservation.value = { status: 'loading' }
}

function getTokenObservation(chain: string): TokenObservation | undefined {
  return chain === 'solana' ? solanaTokenObservation.value : undefined
}

let multichainConsumers = 0
let multichainTimer: ReturnType<typeof setTimeout> | undefined
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
    if (utxoPending.size > 0 || solanaPending) schedulePolling()
    else fetchSecondaryBalances(true)
  }, BALANCE_POLL_MS)
}

export async function fetchChainBalance(
  chain: string,
  force = false,
): Promise<void> {
  if (chain === 'monad') return
  if (chain !== 'solana') {
    const chainIdentifier = utxoChainIdentifier(chain)
    if (!chainIdentifier) return
    if (utxoPending.has(chain) && !force) return
    utxoPending.add(chain)
    schedulePolling()
    const revision = accountStatus.revision
    const isCurrent = () =>
      accountStatus.status === 'ready' &&
      accountStatus.revision === revision &&
      utxoChainIdentifier(chain) === chainIdentifier
    try {
      if (accountStatus.status !== 'ready') {
        utxoStates[chain] = { ...EMPTY_STATE }
        return
      }
      const { chain: network, wallet } = await openUtxoWallet(chainIdentifier)
      // Every address the wallet owns, not one address.
      const balance = await wallet.getBalance()
      if (!isCurrent()) return
      utxoStates[chain] = {
        balance,
        formattedBalance: `${network.toDisplayAmount(balance)} ${network.unit}`,
        loaded: true,
        hasError: false,
      }
    } catch (err) {
      if (!isCurrent()) return
      console.error(`Failed to fetch ${chainIdentifier} balance`, err)
      utxoStates[chain] = { ...utxoState(chain), hasError: true }
    } finally {
      utxoPending.delete(chain)
      schedulePolling()
    }
  } else if (chain === 'solana') {
    if (solanaPending && !force) return
    const generation = ++solanaRequestGeneration
    const scope = {
      revision: accountStatus.revision,
      networkId: solanaNetworkId(),
    }
    const isCurrent = () =>
      generation === solanaRequestGeneration &&
      accountStatus.status === 'ready' &&
      accountStatus.revision === scope.revision &&
      solanaNetworkId() === scope.networkId
    solanaPending = true
    schedulePolling()
    try {
      if (accountStatus.status !== 'ready') {
        solanaScope = undefined
        resetSolanaObservations()
        return
      }
      if (
        solanaScope?.revision !== scope.revision ||
        solanaScope?.networkId !== scope.networkId
      ) {
        resetSolanaObservations()
        solanaScope = scope
      }
      const lastKnown = observedTokens(solanaTokenObservation.value)
      solanaTokenObservation.value = { status: 'loading', lastKnown }
      let address = accountSession.getCachedChainAddress?.('solana')
      if (!address) address = await accountSession.getChainAddress?.('solana')
      if (!isCurrent()) return
      if (!address) throw new Error('Solana address unavailable')
      const options = {
        address,
        networkId: scope.networkId,
        relayBaseUrl: loadMonadChainConfigFromEnv().relayBaseUrl,
      }
      // Each reader publishes independently; neither wait nor failure hides the other result.
      await Promise.all([
        fetchSolanaBalance(options).then(
          result => {
            if (!isCurrent()) return
            solanaState.value = {
              balance: result.lamports,
              formattedBalance: result.formatted,
              loaded: true,
              hasError: false,
            }
          },
          err => {
            if (!isCurrent()) return
            console.error('Failed to fetch Solana balance', err)
            solanaState.value = { ...solanaState.value, hasError: true }
          },
        ),
        fetchSolanaTokenAccounts(options).then(
          tokens => {
            if (isCurrent())
              solanaTokenObservation.value = { status: 'available', tokens }
          },
          err => {
            if (!isCurrent()) return
            console.error('Failed to fetch Solana token accounts', err)
            solanaTokenObservation.value = { status: 'unavailable', lastKnown }
          },
        ),
      ])
    } catch (err) {
      if (!isCurrent()) return
      console.error('Failed to acquire Solana balance address', err)
      solanaState.value = { ...solanaState.value, hasError: true }
      solanaTokenObservation.value = {
        status: 'unavailable',
        lastKnown: observedTokens(solanaTokenObservation.value),
      }
    } finally {
      if (generation === solanaRequestGeneration) {
        solanaPending = false
        schedulePolling()
      }
    }
  }
}

function onVisibilityChange() {
  if (document.hidden) {
    clearPollingTimer()
  } else {
    multichainBackgrounded = false
    fetchSecondaryBalances(true)
  }
}

function onAppState(event: Event) {
  const isActive = (event as CustomEvent<{ isActive: boolean }>).detail
    ?.isActive
  if (isActive) {
    multichainBackgrounded = false
    fetchSecondaryBalances(true)
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
      () => fetchSecondaryBalances(true),
      { flush: 'sync' },
    )
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
      window.addEventListener(APP_STATE_EVENT, onAppState)
    }
  }
  fetchSecondaryBalances(false)
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
    if (chain.value === 'monad') return shownMonadBalance(monad)
    if (chain.value === 'solana') return solanaState.value.balance
    return utxoState(chain.value).balance
  })

  const formattedBalance = computed<string>(() => {
    if (chain.value === 'monad') return monad.formattedBalance.value
    if (chain.value === 'solana') return solanaState.value.formattedBalance
    return utxoState(chain.value).formattedBalance
  })

  const loaded = computed<boolean>(() => {
    if (chain.value === 'monad') return monad.loaded.value
    if (chain.value === 'solana') return solanaState.value.loaded
    return utxoState(chain.value).loaded
  })

  const hasError = computed<boolean>(() => {
    if (chain.value === 'monad') return monad.hasError.value
    if (chain.value === 'solana') return solanaState.value.hasError
    return utxoState(chain.value).hasError
  })

  const tokens = computed<TokenItem[]>(() => getChainTokens(chain.value))

  const presentation = computed(() =>
    getBalancePresentation(chain.value, monad),
  )

  return {
    tokenObservation: computed(() => getTokenObservation(chain.value)),
    presentation,
    balance,
    formattedBalance,
    tokens,
    loaded,
    hasError,
    /** Reads the cordoned (profile address) amount now instead of at its slow cadence. */
    refreshCordoned: () =>
      chain.value === 'monad' ? monad.refreshCordoned?.() : undefined,
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
    const items: TokenItem[] = []
    const metadata = solanaScope && getChainRegistryEntry(solanaScope.networkId)
    if (
      solanaState.value.loaded &&
      solanaState.value.balance !== null &&
      metadata?.family === 'solana'
    ) {
      const nativeSymbol = metadata.unit
      const nativeBal = solanaState.value.formattedBalance
      const nativeNum = solanaState.value.balance
        ? Number(solanaState.value.balance) / 1e9
        : 0
      items.push({
        id: 'solana-native',
        symbol: nativeSymbol,
        name: 'Solana',
        mintOrAddress: accountSession.getCachedChainAddress?.('solana') || '',
        balanceFormatted: nativeBal,
        numericBalance: nativeNum,
        avuFormatted: useSafeOracleStore().formatAvuAmount(
          'solana',
          solanaState.value.balance,
        ),
        decimals: 9,
        isNative: true,
      })
    }
    const splTokens = observedTokens(solanaTokenObservation.value) ?? []
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
    getTokenObservation,
    getPresentation: (chain: string) => getBalancePresentation(chain, monad),
    monad,
    solana: readonly(solanaState),
    getTokens: (chain: string) => getChainTokens(chain),
    getFormattedBalance(chain: string): string | undefined {
      if (chain === 'monad') {
        return monad.loaded.value ? monad.formattedBalance.value : undefined
      }
      if (chain === 'solana') {
        return solanaState.value.loaded
          ? solanaState.value.formattedBalance
          : undefined
      }
      const state = utxoState(chain)
      return state.loaded ? state.formattedBalance : undefined
    },
    getRawBalance(chain: string): bigint | null {
      if (chain === 'monad') return shownMonadBalance(monad)
      if (chain === 'solana') {
        return solanaState.value.loaded ? solanaState.value.balance : null
      }
      const state = utxoState(chain)
      return state.loaded ? state.balance : null
    },
    isChainLoaded(chain: string): boolean {
      if (chain === 'monad') return monad.loaded.value
      if (chain === 'solana') return solanaState.value.loaded
      return utxoState(chain).loaded
    },
    hasChainError(chain: string): boolean {
      if (chain === 'monad') return monad.hasError.value
      if (chain === 'solana') return solanaState.value.hasError
      return utxoState(chain).hasError
    },
    refreshAll: async () => {
      await Promise.all([
        monad.refresh(),
        ...utxoRows().map(chain => fetchChainBalance(chain, true)),
        fetchChainBalance('solana', true),
      ])
    },
  }
}
