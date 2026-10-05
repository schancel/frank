/**
 * Explorer routing keyed by Frank's chain-and-network identifier.
 *
 * Keep this mapping explicit: inferring a network from an RPC URL can silently
 * produce links for the wrong chain when an operator changes providers.
 */
import { loadMonadChainConfigFromEnv } from '@frank/wallet/chain/monad-chain'

export const DEFAULT_NETWORK_TAG = 'MONT'

const transactionExplorerBases: Readonly<Record<string, string>> = {
  MONT: 'https://testnet.monadscan.com/tx/',
}

export interface ExplorerOptions {
  isLocal?: boolean
  rpcChain?: string
  relayBaseUrl?: string
  rpcUrl?: string
  localExplorerUrl?: string
}

function readEnv(key: string): string | undefined {
  if (typeof process !== 'undefined' && process.env) {
    return process.env[`QCLI_${key}`] ?? process.env[key]
  }
  return undefined
}

function isLocalAddress(url?: string): boolean {
  if (!url) return false
  return (
    url.includes('127.0.0.1') ||
    url.includes('localhost') ||
    url.includes('[::1]') ||
    url.includes(':18545') ||
    url.includes(':18546') ||
    url.includes(':18098') ||
    url.includes(':18099') ||
    url.includes(':18440') ||
    url.includes(':18441') ||
    url.includes(':18443') ||
    url.includes(':18444')
  )
}

/**
 * Checks if the RPC chain or stack is pointing to localhost, local development, or a chain shim/mock.
 */
export function isLocalRpcChain(options?: ExplorerOptions): boolean {
  if (options?.isLocal !== undefined) {
    return options.isLocal
  }

  // Explicit opt-in flags
  if (
    readEnv('FRANK_LOCAL_STACK') === 'true' ||
    readEnv('FRANK_FAKE_DEMO') === 'true'
  ) {
    return true
  }

  // Check explicit options
  const optRpcChain = options?.rpcChain ?? readEnv('MONAD_RPC_CHAIN')
  if (
    optRpcChain &&
    /^(local|localhost|local-stack|shim|chain-shim|hardhat|anvil|mock|dev)$/i.test(
      optRpcChain,
    )
  ) {
    return true
  }

  if (options?.relayBaseUrl && isLocalAddress(options.relayBaseUrl)) {
    return true
  }
  if (options?.rpcUrl && isLocalAddress(options.rpcUrl)) {
    return true
  }

  // Check local stack ports in window.location if running in browser
  if (typeof window !== 'undefined' && window.location) {
    const port = window.location.port
    if (
      port === '18440' ||
      port === '18441' ||
      port === '18545' ||
      port === '18546'
    ) {
      return true
    }
    // In non-test browser runtime, check if host is loopback/localhost
    if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'test') {
      const host = window.location.hostname
      if (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '[::1]' ||
        host.endsWith('.local')
      ) {
        return true
      }
    }
  }

  // Check configured chain environment if available
  try {
    const config = loadMonadChainConfigFromEnv()
    if (config.fakeDemo) {
      return true
    }
    if (
      config.rpcChain &&
      /^(local|localhost|local-stack|shim|chain-shim|hardhat|anvil|mock|dev)$/i.test(
        config.rpcChain,
      )
    ) {
      return true
    }
    // In non-test mode or when explicitly set, check relay base url for local stack ports
    if (
      config.relayBaseUrl &&
      /(18440|18441|18443|18444|18098|18099|18545|18546)/.test(
        config.relayBaseUrl,
      )
    ) {
      return true
    }
  } catch {
    // ignore
  }

  return false
}

export function hasTransactionExplorer(
  networkTag = DEFAULT_NETWORK_TAG,
  options?: ExplorerOptions,
): boolean {
  if (options?.localExplorerUrl ?? readEnv('MONAD_EXPLORER_URL')) {
    return true
  }
  if (isLocalRpcChain(options)) {
    return false
  }
  return Boolean(transactionExplorerBases[networkTag])
}

export function transactionExplorerUrl(
  txId: string,
  networkTag = DEFAULT_NETWORK_TAG,
  options?: ExplorerOptions,
): string | undefined {
  const localExplorerUrl =
    options?.localExplorerUrl ?? readEnv('MONAD_EXPLORER_URL')
  if (localExplorerUrl) {
    const base = localExplorerUrl.endsWith('/')
      ? localExplorerUrl
      : `${localExplorerUrl}/`
    return `${base}${encodeURIComponent(txId)}`
  }

  if (isLocalRpcChain(options)) {
    // On local stack or private test chain where monadscan doesn't exist, don't generate broken external link
    return undefined
  }

  const baseUrl = transactionExplorerBases[networkTag]
  if (!baseUrl) {
    throw new Error(
      `No transaction explorer configured for NetworkTag ${networkTag}`,
    )
  }
  return `${baseUrl}${encodeURIComponent(txId)}`
}
