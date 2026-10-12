import type { PriceFeedProvider, PriceSample } from '../types'
import { ORACLE_ENDPOINTS } from '../config'

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
export const DEFAULT_ARBITRUM_RPC = ORACLE_ENDPOINTS.chainlink.arbitrumRpc

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
          'Accept': 'application/json',
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

      const hex = rawHex.startsWith('0x') ? rawHex.slice(2) : rawHex
      if (!/^[0-9a-fA-F]{320}$/.test(hex)) return null
      const word = (index: number) =>
        BigInt('0x' + hex.slice(index * 64, (index + 1) * 64))
      const round = word(0),
        answer = word(1),
        startedAt = word(2),
        updatedAt = word(3)
      if (
        round === 0n ||
        answer <= 0n ||
        answer >= 1n << 255n ||
        startedAt === 0n ||
        startedAt > updatedAt ||
        updatedAt > BigInt(Math.floor(Date.now() / 1000)) ||
        updatedAt * 1000n > BigInt(Number.MAX_SAFE_INTEGER) ||
        word(4) < round
      )
        return null
      const price = Number(answer) / Math.pow(10, config.decimals)
      if (!Number.isFinite(price) || price <= 0) return null

      return {
        provider: 'chainlink',
        asset: asset.toUpperCase(),
        price,
        timestamp: Number(updatedAt) * 1000,
        latencyMs: Date.now() - startTime,
      }
    } catch {
      return null
    }
  }
}
