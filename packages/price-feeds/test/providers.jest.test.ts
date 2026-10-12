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
      expect(sample?.timestamp).toBe(Number(0x67039200) * 1000)
    })
  })

  describe('dated Chainlink rounds', () => {
    const now = 1_800_000_000
    const encode = (words: bigint[]) =>
      '0x' + words.map(word => word.toString(16).padStart(64, '0')).join('')
    const valid = [
      2n,
      4000n * 100_000_000n,
      BigInt(now - 3600),
      BigInt(now - 3600),
      2n,
    ]
    async function read(words: bigint[] | string) {
      const fetchFn = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          result: typeof words === 'string' ? words : encode(words),
        }),
      })
      return new ChainlinkProvider({ fetchFn }).fetchPrice('GOLD')
    }
    beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(now * 1000))
    afterEach(() => jest.restoreAllMocks())
    it('retains the original observation timestamp on repeated fetches', async () => {
      const first = await read(valid)
      jest.spyOn(Date, 'now').mockReturnValue((now + 600) * 1000)
      expect(await read(valid)).toMatchObject({
        price: 4000,
        timestamp: (now - 3600) * 1000,
      })
      expect(first?.timestamp).toBe((now - 3600) * 1000)
    })
    it.each([
      [0, 0n],
      [1, 0n],
      [1, 1n << 255n],
      [2, 0n],
      [2, BigInt(now)],
      [3, 0n],
      [3, BigInt(now + 1)],
      [4, 1n],
    ])('rejects invalid word %s (%s)', async (index, value) => {
      const words = [...valid]
      words[Number(index)] = BigInt(value)
      expect(await read(words)).toBeNull()
    })
    it('rejects truncated and nonhex ABI', async () => {
      expect(await read(encode(valid).slice(0, 130))).toBeNull()
      expect(await read('0x' + 'z'.repeat(320))).toBeNull()
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

describe('providers only report prices a market actually made', () => {
  const { BinanceProvider, ChainlinkProvider, CHAINLINK_ARBITRUM_FEEDS } =
    jest.requireActual('../src')

  it('does not take XEC from binance.us, where the market has no trades', async () => {
    const fetchFn = jest.fn(async (url: string) =>
      url.includes('binance.us')
        ? { ok: true, json: async () => ({ price: '0.00000911' }) }
        : { ok: false, json: async () => ({}) },
    )
    const provider = new BinanceProvider({ fetchFn })
    expect(await provider.fetchPrice('XEC')).toBeNull()
    expect(fetchFn.mock.calls.some(c => c[0].includes('binance.us'))).toBe(
      false,
    )
    // A traded market on binance.us is still used when binance.com is unreachable.
    expect((await provider.fetchPrice('BCH'))?.price).toBeCloseTo(0.00000911)
  })

  it('reads gold from the XAU / USD feed address, and answers nothing for an empty contract reply', async () => {
    expect(CHAINLINK_ARBITRUM_FEEDS.GOLD.address).toBe(
      '0x1F954Dc24a49708C26E0C1777f16750B5C6d5a2c',
    )
    const empty = jest.fn(async () => ({
      ok: true,
      json: async () => ({ result: '0x' }),
    }))
    expect(
      await new ChainlinkProvider({ fetchFn: empty }).fetchPrice('GOLD'),
    ).toBeNull()
  })
})
