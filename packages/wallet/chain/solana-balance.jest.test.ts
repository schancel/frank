import {
  fetchSolanaBalance,
  fetchSolanaTokenAccounts,
  getSolanaRpcUrls,
  DEFAULT_SOLANA_RPC_URLS,
} from './solana-balance'

describe('solana-balance', () => {
  const sampleAddress = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'

  describe('getSolanaRpcUrls', () => {
    it('returns relay proxy first when relayBaseUrl is provided', () => {
      const urls = getSolanaRpcUrls({
        networkId: 'solana-devnet',
        relayBaseUrl: 'http://127.0.0.1:8098/',
      })
      expect(urls).toEqual([
        'http://127.0.0.1:8098/chain-rpc/solana-devnet/rpc',
        DEFAULT_SOLANA_RPC_URLS['solana-devnet'],
      ])
    })

    it('returns default upstream when relayBaseUrl is omitted', () => {
      const urls = getSolanaRpcUrls({
        networkId: 'solana-devnet',
      })
      expect(urls).toEqual([DEFAULT_SOLANA_RPC_URLS['solana-devnet']])
    })

    it('respects explicit rpcUrls override', () => {
      const urls = getSolanaRpcUrls({
        networkId: 'solana-devnet',
        relayBaseUrl: 'http://127.0.0.1:8098',
        rpcUrls: ['https://custom-solana-1.example.com'],
      })
      expect(urls).toEqual(['https://custom-solana-1.example.com'])
    })

    it('respects single rpcUrl override', () => {
      const urls = getSolanaRpcUrls({
        networkId: 'solana-devnet',
        rpcUrl: 'https://single-rpc.example.com',
      })
      expect(urls).toEqual(['https://single-rpc.example.com'])
    })
  })

  describe('fetchSolanaBalance', () => {
    it.each(['solana-testnet', 'custom-devnet'])(
      'uses the actual returned devnet unit without changing normalization for %s',
      async networkId => {
        const mockFetch = jest.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ result: { value: 1_000_000_001 } }),
        })
        const result = await fetchSolanaBalance({
          address: sampleAddress,
          networkId,
          relayBaseUrl: 'http://127.0.0.1:8098',
          fetchImpl: mockFetch,
        })
        expect(result).toMatchObject({
          networkId: 'solana-devnet',
          unit: 'dSOL',
          lamports: 1_000_000_001n,
          formatted: '1.000000001 dSOL',
        })
        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:8098/chain-rpc/solana-devnet/rpc',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'getBalance',
              params: [sampleAddress, { commitment: 'confirmed' }],
            }),
          }),
        )
      },
    )

    it('fetches zero balance from devnet by default', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          result: { context: { slot: 100 }, value: 0 },
          id: 1,
        }),
      })

      const result = await fetchSolanaBalance({
        address: sampleAddress,
        fetchImpl: mockFetch as unknown as typeof fetch,
      })

      expect(mockFetch).toHaveBeenCalledWith(
        DEFAULT_SOLANA_RPC_URLS['solana-devnet'],
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'ngrok-skip-browser-warning': '1',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBalance',
            params: [sampleAddress, { commitment: 'confirmed' }],
          }),
        }),
      )

      expect(result.lamports).toBe(0n)
      expect(result.formatted).toBe('0 dSOL')
      expect(result.unit).toBe('dSOL')
      expect(result.networkId).toBe('solana-devnet')
    })

    it('routes through relay proxy when relayBaseUrl is given', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          result: { context: { slot: 100 }, value: 1000000000 },
          id: 1,
        }),
      })

      const result = await fetchSolanaBalance({
        address: sampleAddress,
        relayBaseUrl: 'http://127.0.0.1:8098',
        fetchImpl: mockFetch as unknown as typeof fetch,
      })

      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:8098/chain-rpc/solana-devnet/rpc',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'ngrok-skip-browser-warning': '1',
          }),
        }),
      )

      expect(result.lamports).toBe(1000000000n)
      expect(result.formatted).toBe('1 dSOL')
    })

    it('fails over to secondary RPC when primary returns rate-limit (429)', async () => {
      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: '2.0',
            result: { context: { slot: 105 }, value: 500000000 },
            id: 1,
          }),
        })

      const result = await fetchSolanaBalance({
        address: sampleAddress,
        relayBaseUrl: 'http://127.0.0.1:8098',
        fetchImpl: mockFetch as unknown as typeof fetch,
      })

      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        'http://127.0.0.1:8098/chain-rpc/solana-devnet/rpc',
        expect.anything(),
      )
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        DEFAULT_SOLANA_RPC_URLS['solana-devnet'],
        expect.anything(),
      )
      expect(result.lamports).toBe(500000000n)
      expect(result.formatted).toBe('0.5 dSOL')
    })

    it('formats whole and fractional SOL balances correctly on devnet', async () => {
      // 2.5 SOL = 2,500,000,000 lamports
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          result: { context: { slot: 100 }, value: 2500000000 },
          id: 1,
        }),
      })

      const result = await fetchSolanaBalance({
        address: sampleAddress,
        networkId: 'solana-devnet',
        fetchImpl: mockFetch as unknown as typeof fetch,
      })

      expect(result.lamports).toBe(2500000000n)
      expect(result.formatted).toBe('2.5 dSOL')
      expect(result.unit).toBe('dSOL')
      expect(result.networkId).toBe('solana-devnet')
    })

    it('supports mainnet networkId and formats with SOL unit', async () => {
      // 1 SOL = 1,000,000,000 lamports
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          result: { context: { slot: 200 }, value: 1000000000 },
          id: 1,
        }),
      })

      const result = await fetchSolanaBalance({
        address: sampleAddress,
        networkId: 'solana-mainnet',
        fetchImpl: mockFetch as unknown as typeof fetch,
      })

      expect(mockFetch).toHaveBeenCalledWith(
        DEFAULT_SOLANA_RPC_URLS['solana-mainnet'],
        expect.anything(),
      )
      expect(result.lamports).toBe(1000000000n)
      expect(result.formatted).toBe('1 SOL')
      expect(result.unit).toBe('SOL')
      expect(result.networkId).toBe('solana-mainnet')
    })

    it('supports custom rpcUrl override', async () => {
      const customRpc = 'https://custom-solana-rpc.example.com'
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          result: { context: { slot: 300 }, value: 500000000 }, // 0.5 SOL
          id: 1,
        }),
      })

      const result = await fetchSolanaBalance({
        address: sampleAddress,
        rpcUrl: customRpc,
        fetchImpl: mockFetch as unknown as typeof fetch,
      })

      expect(mockFetch).toHaveBeenCalledWith(customRpc, expect.anything())
      expect(result.formatted).toBe('0.5 dSOL')
    })

    it('throws on HTTP error status when all endpoints fail', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      })

      await expect(
        fetchSolanaBalance({
          address: sampleAddress,
          fetchImpl: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow('Solana RPC HTTP error: 503')
    })

    it('throws on RPC error response', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          error: { code: -32602, message: 'Invalid param: Invalid base58' },
          id: 1,
        }),
      })

      await expect(
        fetchSolanaBalance({
          address: 'invalid-address',
          fetchImpl: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow('Invalid param: Invalid base58')
    })
  })

  describe('fetchSolanaTokenAccounts', () => {
    it('parses devnet tUSDC token accounts and calculates AVU equivalent', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          result: {
            value: [
              {
                pubkey: 'TokenAccountPubkey123',
                account: {
                  data: {
                    parsed: {
                      info: {
                        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // devnet USDC
                        tokenAmount: {
                          amount: '100000000',
                          decimals: 6,
                          uiAmount: 100.0,
                          uiAmountString: '100',
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
          id: 1,
        }),
      })

      const tokens = await fetchSolanaTokenAccounts({
        address: sampleAddress,
        networkId: 'solana-devnet',
        fetchImpl: mockFetch as unknown as typeof fetch,
      })

      expect(tokens).toHaveLength(1)
      expect(tokens[0].symbol).toBe('tUSDC')
      expect(tokens[0].name).toBe('USD Coin (Devnet)')
      expect(tokens[0].uiAmount).toBe(100.0)
      expect(tokens[0].balanceRaw).toBe(100000000n)
      expect(tokens[0].formatted).toBe('100.00 tUSDC')
      expect(tokens[0].avuFormatted).toContain('1,190.5 AVU')
      expect(tokens[0].tokenAccountAddress).toBe('TokenAccountPubkey123')
    })

    it('rejects exhausted endpoints without exposing provider diagnostics', async () => {
      const mockFetch = jest
        .fn()
        .mockRejectedValue(new Error('https://user:secret@rpc.example/key'))
      await expect(
        fetchSolanaTokenAccounts({
          address: sampleAddress,
          rpcUrls: ['https://rpc-one.example', 'https://rpc-two.example'],
          fetchImpl: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow(
        'Unable to read Solana token accounts from any RPC endpoint',
      )
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('accepts a successful empty response', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: { value: [] } }),
      })
      await expect(
        fetchSolanaTokenAccounts({
          address: sampleAddress,
          fetchImpl: mockFetch as unknown as typeof fetch,
        }),
      ).resolves.toEqual([])
    })

    it.each([
      { result: {} },
      { result: { value: {} } },
      { result: { value: [null] } },
      { result: { value: [{ pubkey: 'account', account: { data: {} } }] } },
      {
        result: {
          value: [
            {
              pubkey: 'account',
              account: {
                data: {
                  parsed: {
                    info: {
                      mint: 'mint',
                      tokenAmount: { amount: 'nope', decimals: 6 },
                    },
                  },
                },
              },
            },
          ],
        },
      },
      { error: { message: 'provider-secret' } },
    ])(
      'rejects unusable response %j instead of confirming empty holdings',
      async data => {
        const mockFetch = jest
          .fn()
          .mockResolvedValue({ ok: true, json: async () => data })
        await expect(
          fetchSolanaTokenAccounts({
            address: sampleAddress,
            fetchImpl: mockFetch as unknown as typeof fetch,
          }),
        ).rejects.toThrow(
          'Unable to read Solana token accounts from any RPC endpoint',
        )
      },
    )

    it.each([
      { amount: '50', decimals: -1 },
      { amount: '50', decimals: 1.5 },
      { amount: '50', decimals: 6, uiAmount: Infinity },
      { amount: '50', decimals: 6, uiAmount: '50' },
    ])('rejects unusable token amounts %j', async tokenAmount => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          result: {
            value: [
              {
                pubkey: 'account',
                account: {
                  data: { parsed: { info: { mint: 'mint', tokenAmount } } },
                },
              },
            ],
          },
        }),
      })
      await expect(
        fetchSolanaTokenAccounts({
          address: sampleAddress,
          fetchImpl: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow(
        'Unable to read Solana token accounts from any RPC endpoint',
      )
    })

    it('fails over from an unusable response to valid emptiness', async () => {
      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: { value: [{}] } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: { value: [] } }),
        })
      await expect(
        fetchSolanaTokenAccounts({
          address: sampleAddress,
          rpcUrls: ['https://one.example', 'https://two.example'],
          fetchImpl: mockFetch as unknown as typeof fetch,
        }),
      ).resolves.toEqual([])
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })
  })
})
