import type { PriceFeedProvider, PriceSample } from '../types'

export const CHAINLINK_ARBITRUM_FEEDS: Record<
  string,
  { address: string; decimals: number }
> = {
  ETH: { address: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612', decimals: 8 },
  BTC: { address: '0x6ce185860a4963106506C203335A2910413708e9', decimals: 8 },
  // XAU / USD proxy as listed in Chainlink's Arbitrum address table; the contract's
  // own description() answers "XAU / USD".
  GOLD: { address: '0x1F954Dc24a49708C26E0C1777f16750B5C6d5a2c', decimals: 8 },
  XAU: { address: '0x1F954Dc24a49708C26E0C1777f16750B5C6d5a2c', decimals: 8 },
}

export const LATEST_ROUND_DATA_SELECTOR = '0xfeaf968c'
export const DEFAULT_ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc'

export interface ChainlinkProviderOptions {
  rpcUrl?: string
  relayRpcUrl?: string
  fetchFn?: typeof fetch
}

export class ChainlinkProvider implements PriceFeedProvider {
  readonly id = 'chainlink' as const
  private rpcUrl: string
  private fetchFn: typeof fetch

  constructor(options: ChainlinkProviderOptions = {}) {
    this.rpcUrl = options.relayRpcUrl || options.rpcUrl || DEFAULT_ARBITRUM_RPC
    this.fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis)
  }

  supportsAsset(asset: string): boolean {
    return Boolean(CHAINLINK_ARBITRUM_FEEDS[asset.toUpperCase()])
  }

  async fetchPrice(
    asset: string,
    signal?: AbortSignal,
  ): Promise<PriceSample | null> {
    const config = CHAINLINK_ARBITRUM_FEEDS[asset.toUpperCase()]
    if (!config) return null

    const startTime = Date.now()
    try {
      const response = await this.fetchFn(this.rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [
            {
              to: config.address,
              data: LATEST_ROUND_DATA_SELECTOR,
            },
            'latest',
          ],
        }),
        signal,
      })

      if (!response.ok) return null
      const data = await response.json()
      const rawHex = typeof data?.result === 'string' ? data.result : ''

      // Clean 0x prefix
      const hex = rawHex.startsWith('0x') ? rawHex.slice(2) : rawHex
      // Result has 5 * 32-byte words (roundId, answer, startedAt, updatedAt, answeredInRound)
      if (hex.length < 128) return null

      // Word 1: index 64..128 (answer)
      const answerHex = hex.slice(64, 128)
      let answerBig = BigInt('0x' + answerHex)
      // Check 256-bit signed negative bit
      if (answerBig >= 1n << 255n) {
        answerBig -= 1n << 256n
      }

      if (answerBig <= 0n) return null
      const price = Number(answerBig) / Math.pow(10, config.decimals)

      return {
        provider: 'chainlink',
        asset: asset.toUpperCase(),
        price,
        timestamp: Date.now(),
        latencyMs: Date.now() - startTime,
      }
    } catch {
      return null
    }
  }
}
