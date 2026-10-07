import { ChainlinkProvider } from '../src/providers/chainlink'
import { PythProvider } from '../src/providers/pyth'
import { CoinbaseProvider } from '../src/providers/coinbase'
import { KrakenProvider } from '../src/providers/kraken'
import { CoinGeckoProvider } from '../src/providers/coingecko'
import { BinanceProvider } from '../src/providers/binance'

describe('Price Feed Providers', () => {
  describe('ChainlinkProvider', () => {
    it('decodes eth_call response with 8 decimals', async () => {
      // Hex representing 265050000000 (0x3db5515200) in word 1 (bytes 32..64)
      const mockResult =
        '0x0000000000000000000000000000000000000000000000000000000000000001' + // roundId 1
        '0000000000000000000000000000000000000000000000000000003db6360a80' + // answer: 265050000000 (2650.50)
        '0000000000000000000000000000000000000000000000000000000067039200' + // startedAt
        '0000000000000000000000000000000000000000000000000000000067039200' + // updatedAt
        '0000000000000000000000000000000000000000000000000000000000000001'

      const mockFetch: typeof fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: mockResult }),
      } as any)

      const provider = new ChainlinkProvider({ fetchFn: mockFetch })
      expect(provider.supportsAsset('ETH')).toBe(true)
      expect(provider.supportsAsset('UNKNOWN')).toBe(false)

      const sample = await provider.fetchPrice('ETH')
      expect(sample).not.toBeNull()
      expect(sample?.provider).toBe('chainlink')
      expect(sample?.asset).toBe('ETH')
      expect(sample?.price).toBe(2650.5)
    })
  })

  describe('PythProvider', () => {
    it('decodes Hermes price and exponent', async () => {
      const mockFetch: typeof fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          parsed: [
            {
              id: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
              price: { price: '260025000000', expo: -8 },
            },
          ],
        }),
      } as any)

      const provider = new PythProvider({ fetchFn: mockFetch })
      expect(provider.supportsAsset('ETH')).toBe(true)

      const sample = await provider.fetchPrice('ETH')
      expect(sample).not.toBeNull()
      expect(sample?.provider).toBe('pyth')
      expect(sample?.price).toBe(2600.25)
    })
  })

  describe('CoinbaseProvider', () => {
    it('fetches and parses spot amount', async () => {
      const mockFetch: typeof fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { base: 'ETH', currency: 'USD', amount: '2605.10' },
        }),
      } as any)

      const provider = new CoinbaseProvider({ fetchFn: mockFetch })
      expect(provider.supportsAsset('ETH')).toBe(true)

      const sample = await provider.fetchPrice('ETH')
      expect(sample?.price).toBe(2605.1)
      expect(sample?.provider).toBe('coinbase')
    })
  })

  describe('KrakenProvider', () => {
    it('fetches and parses ticker last close', async () => {
      const mockFetch: typeof fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          error: [],
          result: {
            XETHZUSD: { c: ['2604.80', '1.2'] },
          },
        }),
      } as any)

      const provider = new KrakenProvider({ fetchFn: mockFetch })
      expect(provider.supportsAsset('ETH')).toBe(true)

      const sample = await provider.fetchPrice('ETH')
      expect(sample?.price).toBe(2604.8)
      expect(sample?.provider).toBe('kraken')
    })
  })

  describe('CoinGeckoProvider', () => {
    it('fetches single and batch prices', async () => {
      const mockFetch: typeof fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ethereum: { usd: 2600 },
          solana: { usd: 150 },
          ecash: { usd: 0.000035 },
        }),
      } as any)

      const provider = new CoinGeckoProvider({ fetchFn: mockFetch })
      expect(provider.supportsAsset('XEC')).toBe(true)

      const sample = await provider.fetchPrice('XEC')
      expect(sample?.price).toBe(0.000035)

      const batch = await provider.fetchPrices(['ETH', 'SOL', 'XEC'])
      expect(batch.length).toBe(3)
    })
  })

  describe('BinanceProvider', () => {
    it('fetches ticker price with fallback', async () => {
      const mockFetch: typeof fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          symbol: 'XECUSDT',
          price: '0.00003550',
        }),
      } as any)

      const provider = new BinanceProvider({ fetchFn: mockFetch })
      expect(provider.supportsAsset('XEC')).toBe(true)

      const sample = await provider.fetchPrice('XEC')
      expect(sample?.price).toBe(0.0000355)
      expect(sample?.provider).toBe('binance')
    })
  })
})
