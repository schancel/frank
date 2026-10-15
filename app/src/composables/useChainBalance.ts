/**
 * Balances for every wallet row, read by the chain's family.
 *
 * The registry's `wallet` setting decides whether a row has a balance at all. Bitcoin-family
 * rows (eCash, Bitcoin, Bitcoin Cash) and secondary native EVM networks ask the session's wallet
 * for that chain. Solana reads its address over the relay's RPC proxy. Tempo reads the PathUSD
 * TIP-20 balance through its verified relay route; it has no native coin. The active Monad
 * network keeps its own reader (./useBalance). Anything else is explicitly unsupported.
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
  createChainAdapter,
  fetchSolanaBalance,
  fetchSolanaTokenAccounts,
  getPrimaryWallet,
  isCanonicalChainId,
  isChainUnreachableError,
  loadMonadChainConfigFromEnv,
  type ChainId,
  type SolanaTokenAccount,
} from '@frank/wallet/chain'
import { getChainRegistryEntry } from '@frank/wallet/chain/chains-registry'
import { accountSession, accountStatus } from '../accounts/session'
import { openUtxoWallet } from '../accounts/utxo-wallets'
import { openEvmWallet } from '../accounts/evm-wallets'
import {
  requireRelayWalletRoute,
  RelayWalletRouteUnavailableError,
} from '../accounts/relay-wallet-route'
import { readTempoPathUsdBalance } from '../accounts/tempo-wallets'
import { formatUnits } from 'ethers'
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
  /** Display observation metadata; never a spend authorization. */
  observedAt?: number
  stale?: boolean
  unavailableReason?: 'relay-unavailable'
}

export interface BalanceObservation {
  observedAt?: number
  stale?: boolean
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
      reason: 'unsupported' | 'fetch-error' | 'relay-unavailable'
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
 * The wallet's complete `getBalance()` figure, exposed by `useBalance().total`.
 * It already includes the profile address and sending accounts; every displayed balance
 * and AVU conversion reads it once. Null until the wallet's first successful read.
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
  if (isPrimaryChain(chain)) {
    exactBalance = monad.exactBalance?.value
    state = {
      balance: shownMonadBalance(monad),
      formattedBalance: monad.formattedBalance.value,
      loaded: monad.loaded.value,
      hasError: monad.hasError.value,
    }
  } else if (isSolanaChain(chain)) state = solanaState.value
  else if (secondaryChainIdentifier(chain)) state = secondaryState(chain)
  else return { status: 'unavailable', reason: 'unsupported' }

  const observation =
    state.loaded && state.balance !== null
      ? {
          balance: state.balance,
          formattedBalance: state.formattedBalance,
          ...(exactBalance ? { exactBalance } : {}),
          ...(state.observedAt !== undefined
            ? { observedAt: state.observedAt }
            : {}),
          ...(state.stale ? { stale: true } : {}),
        }
      : undefined
  if (state.hasError) {
    return {
      status: 'unavailable',
      reason: state.unavailableReason ?? 'fetch-error',
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

// Derived owner observations, keyed by canonical network, never an inventory.
const secondaryStates = reactive<
  Record<string, ChainBalanceState & { revision: number }>
>({})
const secondaryPending = new Map<string, number>()
let secondaryRequestGeneration = 0
// Mounted balance consumers only; read-only getters never acquire a context.
const requestedChains = new Set<Readonly<Ref<string>>>()

function supportedEntry(chain: string) {
  const support = walletSupport(chain, activeChain.isTestnet ?? false)
  return support.status === 'unsupported' ? undefined : support.entry
}
function isPrimaryChain(chain: string): boolean {
  const entry = supportedEntry(chain)
  return entry?.kind !== 'tempo' && entry?.id === activeChain.chainIdentifier
}
function isSolanaChain(chain: string): boolean {
  const entry = supportedEntry(chain)
  return entry?.family === 'solana' && entry.id === solanaNetworkId()
}
function secondaryState(chain: string): ChainBalanceState {
  const id = secondaryChainIdentifier(chain)
  const state = id && secondaryStates[id]
  return state &&
    accountStatus.status === 'ready' &&
    state.revision === accountStatus.revision
    ? state
    : EMPTY_STATE
}
function secondaryChainIdentifier(chain: string): string | undefined {
  const entry = supportedEntry(chain)
  return entry &&
    (entry.family === 'bitcoin' ||
      (entry.family === 'evm' && entry.kind !== 'tempo') ||
      entry.kind === 'tempo') &&
    !isPrimaryChain(chain)
    ? entry.id
    : undefined
}
function secondaryRows(): string[] {
  return [
    ...new Set([
      ...WALLET_CONFIGS.map(wallet => wallet.id),
      ...[...requestedChains].map(chain => chain.value),
    ]),
  ].filter(id => secondaryChainIdentifier(id) !== undefined)
}

function fetchSecondaryBalances(force: boolean) {
  for (const chain of secondaryRows()) void fetchChainBalance(chain, force)
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
  return isSolanaChain(chain) ? solanaTokenObservation.value : undefined
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
    if (secondaryPending.size > 0 || solanaPending) schedulePolling()
    else fetchSecondaryBalances(true)
  }, BALANCE_POLL_MS)
}

export async function fetchChainBalance(
  chain: string,
  force = false,
): Promise<void> {
  if (isPrimaryChain(chain)) return
  if (!isSolanaChain(chain)) {
    const chainIdentifier = secondaryChainIdentifier(chain)
    if (!chainIdentifier) return
    if (secondaryPending.has(chainIdentifier) && !force) return
    const generation = ++secondaryRequestGeneration
    secondaryPending.set(chainIdentifier, generation)
    schedulePolling()
    const revision = accountStatus.revision
    const isCurrent = () =>
      secondaryPending.get(chainIdentifier) === generation &&
      accountStatus.status === 'ready' &&
      accountStatus.revision === revision &&
      secondaryChainIdentifier(chain) === chainIdentifier
    try {
      if (accountStatus.status !== 'ready') {
        secondaryStates[chainIdentifier] = { ...EMPTY_STATE, revision }
        return
      }
      const entry = supportedEntry(chainIdentifier)
      if (!entry) throw new Error(`Wallet unavailable for ${chainIdentifier}`)
      await requireRelayWalletRoute(
        loadMonadChainConfigFromEnv().relayBaseUrl,
        chainIdentifier,
      )
      if (!isCurrent()) return
      const adapter = isCanonicalChainId(chainIdentifier)
        ? createChainAdapter(chainIdentifier)
        : undefined
      if (entry.kind === 'tempo') {
        const balance = await readTempoPathUsdBalance(
          entry.id as 'tempo-testnet' | 'tempo-mainnet',
        )
        if (!isCurrent()) return
        adapter?.getWallet().setCachedBalance(balance)
        const formattedBalance = adapter
          ? `${adapter.toDisplayAmount(balance)} ${adapter.unit}`
          : `${formatUnits(balance, 6)} PathUSD`
        secondaryStates[chainIdentifier] = {
          revision,
          balance,
          formattedBalance,
          loaded: true,
          hasError: false,
        }
        return
      }
      const { chain: network, wallet } = await (entry.family === 'evm'
        ? openEvmWallet(chainIdentifier)
        : openUtxoWallet(chainIdentifier))
      if (!isCurrent()) return
      const formatter = adapter ?? network
      const observed = await wallet.getBalanceObservation?.()
      if (!isCurrent()) return
      if (observed) {
        secondaryStates[chainIdentifier] = {
          revision,
          balance: observed.balance,
          formattedBalance: `${formatter.toDisplayAmount(observed.balance)} ${
            formatter.unit
          }`,
          loaded: true,
          hasError: false,
          observedAt: observed.observedAt,
          stale: true,
        }
      }
      // Publish the local observation first; the network read refreshes it in the background.
      // Every address the wallet owns, not one address.
      const balance = await wallet.getBalance()
      if (!isCurrent()) return
      const refreshedObservation = await wallet.getBalanceObservation?.()
      if (!isCurrent()) return
      adapter?.getWallet().setCachedBalance(balance)
      secondaryStates[chainIdentifier] = {
        revision,
        balance,
        formattedBalance: `${formatter.toDisplayAmount(balance)} ${
          formatter.unit
        }`,
        loaded: true,
        hasError: false,
        ...(wallet.getBalanceObservation
          ? { observedAt: refreshedObservation?.observedAt }
          : {}),
      }
    } catch (err) {
      if (!isCurrent()) return
      if (isChainUnreachableError(err)) {
        console.warn(
          `Failed to fetch ${chainIdentifier} balance (chain unreachable)`,
          err,
        )
      } else {
        console.error(`Failed to fetch ${chainIdentifier} balance`, err)
      }
      secondaryStates[chainIdentifier] = {
        ...secondaryState(chain),
        revision,
        hasError: true,
        unavailableReason:
          err instanceof RelayWalletRouteUnavailableError
            ? 'relay-unavailable'
            : undefined,
      }
    } finally {
      if (secondaryPending.get(chainIdentifier) === generation)
        secondaryPending.delete(chainIdentifier)
      schedulePolling()
    }
  } else if (isSolanaChain(chain)) {
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
      await requireRelayWalletRoute(
        loadMonadChainConfigFromEnv().relayBaseUrl,
        scope.networkId,
      )
      if (!isCurrent()) return
      const lastKnown = observedTokens(solanaTokenObservation.value)
      solanaTokenObservation.value = { status: 'loading', lastKnown }
      let address = accountSession.getCachedChainAddress?.('solana')
      if (!address) address = await accountSession.getChainAddress?.('solana')
      if (!isCurrent()) return
      if (!address) throw new Error('Solana address unavailable')
      const solanaAdapter = createChainAdapter(scope.networkId as ChainId)
      const formattedAddress = solanaAdapter.formatAddress(address)
      const solanaWallet = solanaAdapter.getWallet(formattedAddress)
      const options = {
        address: formattedAddress,
        networkId: scope.networkId,
        relayBaseUrl: loadMonadChainConfigFromEnv().relayBaseUrl,
      }
      // Each reader publishes independently; neither wait nor failure hides the other result.
      await Promise.all([
        fetchSolanaBalance(options).then(
          res => {
            if (!isCurrent()) return
            solanaWallet.setCachedBalance(res.lamports)
            solanaState.value = {
              balance: res.lamports,
              formattedBalance:
                res.formatted ??
                `${solanaAdapter.toDisplayAmount(res.lamports)} ${
                  solanaAdapter.unit
                }`,
              loaded: true,
              hasError: false,
            }
          },
          err => {
            if (!isCurrent()) return
            console.error('Failed to fetch Solana balance', err)
            solanaState.value = {
              ...solanaState.value,
              hasError: true,
              unavailableReason: undefined,
            }
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
      solanaState.value = {
        ...solanaState.value,
        hasError: true,
        unavailableReason:
          err instanceof RelayWalletRouteUnavailableError
            ? 'relay-unavailable'
            : undefined,
      }
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
  const chain = computed(() =>
    typeof chainRef === 'string' ? chainRef : chainRef.value,
  )
  if (getCurrentInstance()) {
    let stopChainWatch: (() => void) | undefined
    onMounted(() => {
      requestedChains.add(chain)
      acquireMultichain()
      void fetchChainBalance(chain.value)
      stopChainWatch = watch(chain, value => {
        void fetchChainBalance(value)
      })
    })
    onUnmounted(() => {
      requestedChains.delete(chain)
      stopChainWatch?.()
      releaseMultichain()
    })
  }

  const balance = computed<bigint | null>(() => {
    if (isPrimaryChain(chain.value)) return shownMonadBalance(monad)
    if (isSolanaChain(chain.value)) return solanaState.value.balance
    return secondaryState(chain.value).balance
  })

  const formattedBalance = computed<string>(() => {
    if (isPrimaryChain(chain.value)) return monad.formattedBalance.value
    if (isSolanaChain(chain.value)) return solanaState.value.formattedBalance
    return secondaryState(chain.value).formattedBalance
  })

  const loaded = computed<boolean>(() => {
    if (isPrimaryChain(chain.value)) return monad.loaded.value
    if (isSolanaChain(chain.value)) return solanaState.value.loaded
    return secondaryState(chain.value).loaded
  })

  const hasError = computed<boolean>(() => {
    if (isPrimaryChain(chain.value)) return monad.hasError.value
    if (isSolanaChain(chain.value)) return solanaState.value.hasError
    return secondaryState(chain.value).hasError
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
      isPrimaryChain(chain.value) ? monad.refreshCordoned?.() : undefined,
    refresh: () => {
      if (isPrimaryChain(chain.value)) return monad.refresh()
      return fetchChainBalance(chain.value, true)
    },
  }
}

/**
 * Returns available native and sub-token assets for a given chain.
 */
export function getChainTokens(chainName: string): TokenItem[] {
  if (isSolanaChain(chainName)) {
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
      if (isPrimaryChain(chain)) {
        return monad.loaded.value ? monad.formattedBalance.value : undefined
      }
      if (isSolanaChain(chain)) {
        return solanaState.value.loaded
          ? solanaState.value.formattedBalance
          : undefined
      }
      const state = secondaryState(chain)
      return state.loaded ? state.formattedBalance : undefined
    },
    getRawBalance(chain: string): bigint | null {
      if (isPrimaryChain(chain)) return shownMonadBalance(monad)
      if (isSolanaChain(chain)) {
        return solanaState.value.loaded ? solanaState.value.balance : null
      }
      const state = secondaryState(chain)
      return state.loaded ? state.balance : null
    },
    isChainLoaded(chain: string): boolean {
      if (isPrimaryChain(chain)) return monad.loaded.value
      if (isSolanaChain(chain)) return solanaState.value.loaded
      return secondaryState(chain).loaded
    },
    hasChainError(chain: string): boolean {
      if (isPrimaryChain(chain)) return monad.hasError.value
      if (isSolanaChain(chain)) return solanaState.value.hasError
      return secondaryState(chain).hasError
    },
    refreshAll: async () => {
      await Promise.all([
        monad.refresh(),
        ...secondaryRows().map(chain => fetchChainBalance(chain, true)),
        fetchChainBalance('solana', true),
      ])
    },
  }
}
