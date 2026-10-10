/**
 * Curated registry of whitelisted tokens and native assets across supported chains
 * (Monad, Ethereum, Solana, eCash/XEC).
 *
 * Provides instant local lookup of token metadata (decimals, standard, permit support)
 * without polling external RPCs.
 */

export type TokenStandard = 'erc20' | 'spl' | 'native'

export interface TokenDefinition {
  symbol: string
  name: string
  contractAddress: string
  chainId: string | number
  decimals: number
  hasPermit: boolean
  standard: TokenStandard
}

/**
 * Normalizes chain identifiers across numeric IDs, aliases, and names.
 */
export function normalizeChainId(chainId: string | number): string {
  const s = String(chainId).toLowerCase().trim()
  switch (s) {
    case '1':
    case 'ethereum':
    case 'eth-mainnet':
      return 'ethereum'
    case '10143':
    case 'monad':
    case 'monad-testnet':
    case '20143':
    case 'monad-regtest':
      return 'monad'
    case 'solana':
    case 'solana-mainnet':
    case 'solana-devnet':
      return 'solana'
    case 'xec':
    case 'ecash':
    case 'xec-mainnet':
      return 'xec'
    default:
      return s
  }
}

/**
 * Normalizes contract or account addresses for comparison.
 */
export function normalizeTokenAddress(address: string): string {
  const trimmed = address.trim()
  if (trimmed.startsWith('0x') || /^[0-9a-fA-F]{40}$/.test(trimmed)) {
    return trimmed.toLowerCase()
  }
  return trimmed
}

export const WHITELISTED_TOKENS: TokenDefinition[] = [
  // 1. USDC (Monad, Ethereum, Solana)
  {
    symbol: 'USDC',
    name: 'USD Coin',
    contractAddress: '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea',
    chainId: 'monad',
    decimals: 6,
    hasPermit: true,
    standard: 'erc20',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    chainId: 'ethereum',
    decimals: 6,
    hasPermit: true,
    standard: 'erc20',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    chainId: 'solana',
    decimals: 6,
    hasPermit: false,
    standard: 'spl',
  },

  // 2. USDT (Ethereum, Monad, Solana)
  {
    symbol: 'USDT',
    name: 'Tether USD',
    contractAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    chainId: 'ethereum',
    decimals: 6,
    hasPermit: false,
    standard: 'erc20',
  },
  {
    symbol: 'USDT',
    name: 'Tether USD',
    contractAddress: '0x88b8E2161DEDC77EF4ab7585569D2415a1C10552',
    chainId: 'monad',
    decimals: 6,
    hasPermit: false,
    standard: 'erc20',
  },
  {
    symbol: 'USDT',
    name: 'Tether USD',
    contractAddress: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    chainId: 'solana',
    decimals: 6,
    hasPermit: false,
    standard: 'spl',
  },

  // AVU is a unit of account for comparing coins, not a token: it has no entry here.

  // 4. Native Coins: MON, SOL, ETH, XEC
  {
    symbol: 'MON',
    name: 'Monad Native',
    contractAddress: '0x0000000000000000000000000000000000000000',
    chainId: 'monad',
    decimals: 18,
    hasPermit: false,
    standard: 'native',
  },
  {
    symbol: 'SOL',
    name: 'Solana Native',
    contractAddress: '11111111111111111111111111111111',
    chainId: 'solana',
    decimals: 9,
    hasPermit: false,
    standard: 'native',
  },
  {
    symbol: 'ETH',
    name: 'Ether Native',
    contractAddress: '0x0000000000000000000000000000000000000000',
    chainId: 'ethereum',
    decimals: 18,
    hasPermit: false,
    standard: 'native',
  },
  {
    symbol: 'XEC',
    name: 'eCash Native',
    contractAddress: 'native',
    chainId: 'xec',
    decimals: 2,
    hasPermit: false,
    standard: 'native',
  },
]

export class TokenRegistry {
  private tokens: TokenDefinition[] = []

  constructor(initialTokens: TokenDefinition[] = WHITELISTED_TOKENS) {
    this.tokens = initialTokens.map(t => ({ ...t }))
  }

  registerToken(token: TokenDefinition): void {
    const normChain = normalizeChainId(token.chainId)
    const normAddr = normalizeTokenAddress(token.contractAddress)
    const existingIndex = this.tokens.findIndex(
      t =>
        normalizeChainId(t.chainId) === normChain &&
        normalizeTokenAddress(t.contractAddress) === normAddr,
    )
    if (existingIndex >= 0) {
      this.tokens[existingIndex] = { ...token }
    } else {
      this.tokens.push({ ...token })
    }
  }

  getToken(
    chainId: string | number,
    addressOrSymbol: string,
  ): TokenDefinition | undefined {
    const normChain = normalizeChainId(chainId)
    const normAddr = normalizeTokenAddress(addressOrSymbol)
    const upperSym = addressOrSymbol.toUpperCase().trim()

    return this.tokens.find(t => {
      if (normalizeChainId(t.chainId) !== normChain) return false
      if (normalizeTokenAddress(t.contractAddress) === normAddr) return true
      if (t.symbol.toUpperCase() === upperSym) return true
      if (
        t.standard === 'native' &&
        (normAddr === 'native' ||
          normAddr === '0x0000000000000000000000000000000000000000' ||
          normAddr === '11111111111111111111111111111111')
      ) {
        return true
      }
      return false
    })
  }

  hasToken(chainId: string | number, addressOrSymbol: string): boolean {
    return this.getToken(chainId, addressOrSymbol) !== undefined
  }

  listTokensForChain(chainId: string | number): TokenDefinition[] {
    const normChain = normalizeChainId(chainId)
    return this.tokens.filter(t => normalizeChainId(t.chainId) === normChain)
  }

  getAllTokens(): TokenDefinition[] {
    return this.tokens.map(t => ({ ...t }))
  }
}

export const tokenRegistry = new TokenRegistry()

export function getToken(
  chainId: string | number,
  addressOrSymbol: string,
): TokenDefinition | undefined {
  return tokenRegistry.getToken(chainId, addressOrSymbol)
}

export function listTokensForChain(
  chainId: string | number,
): TokenDefinition[] {
  return tokenRegistry.listTokensForChain(chainId)
}
