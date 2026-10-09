import { formatBaseUnit } from './base-unit'

export interface FetchSolanaBalanceOptions {
  /** The base58 Solana public key address. */
  address: string
  /** Explicit network ID override. Defaults to 'solana-devnet'. */
  networkId?: 'solana-devnet' | 'solana-mainnet' | 'solana-testnet' | string
  /** Custom RPC URL override. If omitted, uses default upstream RPC. */
  rpcUrl?: string
  /** Relay base URL to route via the relay's Solana reverse proxy (`/chain-rpc/<networkId>/rpc`). */
  relayBaseUrl?: string
  /** Direct Solana RPC endpoints override for failover. */
  rpcUrls?: string[]
  /** Injected fetch implementation for unit testing or custom environments. */
  fetchImpl?: typeof fetch
}

export interface SolanaBalanceResult {
  lamports: bigint
  formatted: string
  unit: string
  networkId: 'solana-devnet' | 'solana-mainnet'
}

export interface SolanaTokenAccount {
  mint: string
  symbol: string
  name: string
  balanceRaw: bigint
  decimals: number
  uiAmount: number
  formatted: string
  avuFormatted: string
  tokenAccountAddress?: string
}

export const KNOWN_SOLANA_DEVNET_TOKENS: Record<
  string,
  { symbol: string; name: string; decimals: number; priceUsd: number }
> = {
  // Official Circle USDC devnet mint
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': {
    symbol: 'tUSDC',
    name: 'USD Coin (Devnet)',
    decimals: 6,
    priceUsd: 1.0,
  },
  // Mainnet USDC
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': {
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    priceUsd: 1.0,
  },
  // Mainnet USDT
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': {
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    priceUsd: 1.0,
  },
}

export const DEFAULT_SOLANA_RPC_URLS: Record<
  'solana-devnet' | 'solana-mainnet',
  string
> = {
  'solana-devnet': 'https://api.devnet.solana.com',
  'solana-mainnet': 'https://api.mainnet-beta.solana.com',
}

/**
 * Resolves failover Solana RPC URLs.
 * Places the local/configured relay reverse proxy first (when relayBaseUrl is given),
 * followed by the default public upstream RPC endpoints.
 */
export function getSolanaRpcUrls(params: {
  networkId: 'solana-devnet' | 'solana-mainnet'
  relayBaseUrl?: string
  rpcUrl?: string
  rpcUrls?: string[]
}): string[] {
  if (params.rpcUrls && params.rpcUrls.length > 0) {
    return params.rpcUrls
  }
  if (params.rpcUrl) {
    return [params.rpcUrl]
  }
  const urls: string[] = []
  if (params.relayBaseUrl) {
    const cleanRelay = params.relayBaseUrl.replace(/\/+$/, '')
    urls.push(`${cleanRelay}/chain-rpc/${params.networkId}/rpc`)
    // Public Solana RPC endpoints do not provide CORS headers for web app origins.
    // In browser environments with a relay reverse proxy configured, do not fail over to
    // endpoints that are guaranteed to trigger WebKit/Chromium CORS access control errors.
    if (typeof window === 'undefined') {
      urls.push(DEFAULT_SOLANA_RPC_URLS[params.networkId])
    }
    return urls
  }
  urls.push(DEFAULT_SOLANA_RPC_URLS[params.networkId])
  return urls
}

/**
 * Public, read-only Solana balance fetcher by address via standard JSON-RPC.
 * Supports multi-endpoint failover through relay reverse proxies and upstream RPCs.
 * Does not require private keys, custody initialization, or heavy SDK initialization.
 */
export async function fetchSolanaBalance(
  options: FetchSolanaBalanceOptions,
): Promise<SolanaBalanceResult> {
  const isTestnet =
    options.networkId === undefined ||
    options.networkId === 'solana-devnet' ||
    options.networkId === 'solana-testnet' ||
    options.networkId.includes('testnet') ||
    options.networkId.includes('devnet')

  const canonicalNetwork: 'solana-devnet' | 'solana-mainnet' = isTestnet
    ? 'solana-devnet'
    : 'solana-mainnet'

  const rpcUrls = getSolanaRpcUrls({
    networkId: canonicalNetwork,
    relayBaseUrl: options.relayBaseUrl,
    rpcUrl: options.rpcUrl,
    rpcUrls: options.rpcUrls,
  })

  const unit = isTestnet ? 'tSOL' : 'SOL'
  const fetchFn = options.fetchImpl ?? globalThis.fetch

  if (!fetchFn) {
    throw new Error('fetch is not available in the current environment')
  }

  let lastError: unknown = null

  for (const rpcUrl of rpcUrls) {
    try {
      const response = await fetchFn(rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': '1',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBalance',
          params: [options.address, { commitment: 'confirmed' }],
        }),
      })

      if (!response.ok) {
        throw new Error(`Solana RPC HTTP error: ${response.status}`)
      }

      const data = (await response.json()) as {
        error?: { message?: string }
        result?: { value?: number | string | bigint }
      }

      if (data.error) {
        throw new Error(data.error.message || 'Solana RPC error')
      }

      const rawValue = data.result?.value ?? 0
      const lamports = BigInt(rawValue)
      const formatted = `${formatBaseUnit(lamports, 9)} ${unit}`

      return {
        lamports,
        formatted,
        unit,
        networkId: canonicalNetwork,
      }
    } catch (err) {
      lastError = err
    }
  }

  throw lastError ?? new Error('Failed to connect to any Solana RPC endpoint')
}

/**
 * Public, read-only Solana SPL token accounts fetcher by owner address via standard JSON-RPC.
 * Queries `getTokenAccountsByOwner` for SPL Token Program (Tokenkeg...).
 * Automatically parses token amounts, decimals, symbols, and computes thermodynamic AVU value.
 */
export async function fetchSolanaTokenAccounts(
  options: FetchSolanaBalanceOptions,
): Promise<SolanaTokenAccount[]> {
  const isTestnet =
    options.networkId === undefined ||
    options.networkId === 'solana-devnet' ||
    options.networkId === 'solana-testnet' ||
    options.networkId.includes('testnet') ||
    options.networkId.includes('devnet')

  const canonicalNetwork: 'solana-devnet' | 'solana-mainnet' = isTestnet
    ? 'solana-devnet'
    : 'solana-mainnet'

  const rpcUrls = getSolanaRpcUrls({
    networkId: canonicalNetwork,
    relayBaseUrl: options.relayBaseUrl,
    rpcUrl: options.rpcUrl,
    rpcUrls: options.rpcUrls,
  })

  const fetchFn = options.fetchImpl ?? globalThis.fetch
  if (!fetchFn) {
    throw new Error('fetch is not available in the current environment')
  }

  for (const rpcUrl of rpcUrls) {
    try {
      const response = await fetchFn(rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': '1',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountsByOwner',
          params: [
            options.address,
            { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
            { encoding: 'jsonParsed' },
          ],
        }),
      })

      if (!response.ok) {
        continue
      }

      const data = (await response.json()) as {
        error?: { message?: string }
        result?: {
          value?: Array<{
            pubkey: string
            account: {
              data: {
                parsed: {
                  info: {
                    mint: string
                    tokenAmount: {
                      amount: string
                      decimals: number
                      uiAmount: number | null
                      uiAmountString: string
                    }
                  }
                }
              }
            }
          }>
        }
      }

      if (data.error || !data.result?.value) {
        continue
      }

      const rawAccounts = data.result.value
      const tokens: SolanaTokenAccount[] = []

      for (const item of rawAccounts) {
        const info = item.account?.data?.parsed?.info
        if (!info || !info.mint) continue

        const mint = info.mint
        const decimals = info.tokenAmount?.decimals ?? 6
        const amountStr = info.tokenAmount?.amount ?? '0'
        const uiAmount =
          info.tokenAmount?.uiAmount ??
          (Number(amountStr) / Math.pow(10, decimals) || 0)

        const known = KNOWN_SOLANA_DEVNET_TOKENS[mint]
        const symbol =
          known?.symbol ?? `${mint.slice(0, 4)}...${mint.slice(-4)}`
        const name = known?.name ?? `SPL Token (${mint.slice(0, 4)}...)`
        const priceUsd = known?.priceUsd ?? 0
        const avuPerUsd = 11.90476
        const avuTotal = uiAmount * priceUsd * avuPerUsd
        const avuFormatted =
          avuTotal > 0
            ? `≈ ${avuTotal.toLocaleString('en-US', {
                minimumFractionDigits: 1,
                maximumFractionDigits: 1,
              })} AVU`
            : ''

        tokens.push({
          mint,
          symbol,
          name,
          balanceRaw: BigInt(amountStr),
          decimals,
          uiAmount,
          formatted: `${uiAmount.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 6,
          })} ${symbol}`,
          avuFormatted,
          tokenAccountAddress: item.pubkey,
        })
      }

      return tokens
    } catch {
      // Try next failover endpoint
    }
  }

  return []
}
