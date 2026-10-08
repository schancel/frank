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
  isTestnet?: boolean
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
    url.includes(':18545') || url.includes(':18546') || url.includes(':8545')
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
  // Explicit local chain RPC URL checks
  if (options?.rpcUrl && isLocalAddress(options.rpcUrl)) {
    return true
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
    // In non-test mode or when explicitly set, check relay base url for local chain ports
    if (config.relayBaseUrl && /(18545|18546|8545)/.test(config.relayBaseUrl)) {
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

export function hasMultiChainExplorer(
  networkTagOrChain?: string,
  options?: ExplorerOptions,
): boolean {
  if (options?.localExplorerUrl ?? readEnv('MONAD_EXPLORER_URL')) {
    return true
  }
  if (isLocalRpcChain(options)) {
    return false
  }
  const tag = (networkTagOrChain || DEFAULT_NETWORK_TAG).toLowerCase()
  if (
    tag === 'mont' ||
    tag === 'monad-testnet' ||
    tag === 'mon1' ||
    tag === 'monad-mainnet' ||
    tag === 'monad' ||
    tag === 'sold' ||
    tag === 'solana-devnet' ||
    tag === 'solana-testnet' ||
    tag === 'sol1' ||
    tag === 'solana-mainnet' ||
    tag === 'solana' ||
    tag === 'xect' ||
    tag === 'xec-testnet' ||
    tag === 'ecash-testnet' ||
    tag === 'xec1' ||
    tag === 'xec-mainnet' ||
    tag === 'ecash-mainnet' ||
    tag === 'ecash' ||
    tag === 'btct' ||
    tag === 'btc-testnet' ||
    tag === 'bitcoin-testnet' ||
    tag === 'btc1' ||
    tag === 'btc-mainnet' ||
    tag === 'bitcoin-mainnet' ||
    tag === 'bitcoin' ||
    tag === 'bcht' ||
    tag === 'bch-testnet' ||
    tag === 'bitcoincash-testnet' ||
    tag === 'bch1' ||
    tag === 'bch-mainnet' ||
    tag === 'bitcoincash-mainnet' ||
    tag === 'bitcoincash' ||
    tag === 'doget' ||
    tag === 'doge-testnet' ||
    tag === 'dogecoin-testnet' ||
    tag === 'doge1' ||
    tag === 'doge-mainnet' ||
    tag === 'dogecoin-mainnet' ||
    tag === 'dogecoin' ||
    tag === 'etht' ||
    tag === 'ethereum-sepolia' ||
    tag === 'sepolia' ||
    tag === 'eth1' ||
    tag === 'ethereum-mainnet' ||
    tag === 'ethereum'
  ) {
    return true
  }
  return Boolean(
    transactionExplorerBases[networkTagOrChain || DEFAULT_NETWORK_TAG],
  )
}

export function multiChainExplorerUrl(
  txId: string,
  networkTagOrChain?: string,
  options?: ExplorerOptions,
): string | undefined {
  if (!txId) return undefined
  const localExplorerUrl =
    options?.localExplorerUrl ?? readEnv('MONAD_EXPLORER_URL')
  if (localExplorerUrl) {
    const base = localExplorerUrl.endsWith('/')
      ? localExplorerUrl
      : `${localExplorerUrl}/`
    return `${base}${encodeURIComponent(txId)}`
  }

  if (isLocalRpcChain(options)) {
    return undefined
  }

  const rawTag = networkTagOrChain || DEFAULT_NETWORK_TAG
  const tag = rawTag.toLowerCase()

  // Monad
  if (tag === 'mont' || tag === 'monad-testnet') {
    return `https://testnet.monadscan.com/tx/${encodeURIComponent(txId)}`
  }
  if (tag === 'mon1' || tag === 'monad-mainnet' || tag === 'monad') {
    return `https://monadscan.com/tx/${encodeURIComponent(txId)}`
  }

  // Solana
  if (tag === 'sold' || tag === 'solana-devnet' || tag === 'solana-testnet') {
    return `https://explorer.solana.com/tx/${encodeURIComponent(
      txId,
    )}?cluster=devnet`
  }
  if (tag === 'sol1' || tag === 'solana-mainnet' || tag === 'solana') {
    if (options?.isTestnet) {
      return `https://explorer.solana.com/tx/${encodeURIComponent(
        txId,
      )}?cluster=devnet`
    }
    return `https://explorer.solana.com/tx/${encodeURIComponent(txId)}`
  }

  // eCash
  if (tag === 'xect' || tag === 'xec-testnet' || tag === 'ecash-testnet') {
    return `https://testnet.blockchair.com/ecash/transaction/${encodeURIComponent(
      txId,
    )}`
  }
  if (
    tag === 'xec1' ||
    tag === 'xec-mainnet' ||
    tag === 'ecash-mainnet' ||
    tag === 'ecash'
  ) {
    return `https://blockchair.com/ecash/transaction/${encodeURIComponent(
      txId,
    )}`
  }

  // Bitcoin
  if (
    tag === 'btct' ||
    tag === 'btc-testnet' ||
    tag === 'bitcoin-testnet' ||
    (tag === 'bitcoin' && options?.isTestnet)
  ) {
    return `https://mempool.space/testnet/tx/${encodeURIComponent(txId)}`
  }
  if (
    tag === 'btc1' ||
    tag === 'btc-mainnet' ||
    tag === 'bitcoin-mainnet' ||
    tag === 'bitcoin'
  ) {
    return `https://mempool.space/tx/${encodeURIComponent(txId)}`
  }

  // Bitcoin Cash
  if (
    tag === 'bcht' ||
    tag === 'bch-testnet' ||
    tag === 'bitcoincash-testnet' ||
    (tag === 'bitcoincash' && options?.isTestnet)
  ) {
    return `https://chipnet.imaginary.cash/tx/${encodeURIComponent(txId)}`
  }
  if (
    tag === 'bch1' ||
    tag === 'bch-mainnet' ||
    tag === 'bitcoincash-mainnet' ||
    tag === 'bitcoincash'
  ) {
    return `https://blockchair.com/bitcoin-cash/transaction/${encodeURIComponent(
      txId,
    )}`
  }

  // Dogecoin
  if (
    tag === 'doget' ||
    tag === 'doge-testnet' ||
    tag === 'dogecoin-testnet' ||
    tag === 'doge1' ||
    tag === 'doge-mainnet' ||
    tag === 'dogecoin-mainnet' ||
    tag === 'dogecoin'
  ) {
    return `https://blockchair.com/dogecoin/transaction/${encodeURIComponent(
      txId,
    )}`
  }

  // Ethereum
  if (
    tag === 'etht' ||
    tag === 'ethereum-sepolia' ||
    tag === 'sepolia' ||
    (tag === 'ethereum' && options?.isTestnet)
  ) {
    return `https://sepolia.etherscan.io/tx/${encodeURIComponent(txId)}`
  }
  if (tag === 'eth1' || tag === 'ethereum-mainnet' || tag === 'ethereum') {
    return `https://etherscan.io/tx/${encodeURIComponent(txId)}`
  }

  const directBase = transactionExplorerBases[rawTag]
  if (directBase) {
    return `${directBase}${encodeURIComponent(txId)}`
  }

  return undefined
}

export const getExplorerUrl = multiChainExplorerUrl
