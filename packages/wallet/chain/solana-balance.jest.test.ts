import {
  fetchSolanaBalance,
  getSolanaRpcUrls,
  DEFAULT_SOLANA_RPC_URLS,
} from "./solana-balance";

describe("solana-balance", () => {
  const sampleAddress = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

  describe("getSolanaRpcUrls", () => {
    it("returns relay proxy first when relayBaseUrl is provided", () => {
      const urls = getSolanaRpcUrls({
        networkId: "solana-devnet",
        relayBaseUrl: "http://127.0.0.1:8098/",
      });
      expect(urls).toEqual([
        "http://127.0.0.1:8098/chain-rpc/solana-devnet/rpc",
        DEFAULT_SOLANA_RPC_URLS["solana-devnet"],
      ]);
    });

    it("returns default upstream when relayBaseUrl is omitted", () => {
      const urls = getSolanaRpcUrls({
        networkId: "solana-devnet",
      });
      expect(urls).toEqual([DEFAULT_SOLANA_RPC_URLS["solana-devnet"]]);
    });

    it("respects explicit rpcUrls override", () => {
      const urls = getSolanaRpcUrls({
        networkId: "solana-devnet",
        relayBaseUrl: "http://127.0.0.1:8098",
        rpcUrls: ["https://custom-solana-1.example.com"],
      });
      expect(urls).toEqual(["https://custom-solana-1.example.com"]);
    });

    it("respects single rpcUrl override", () => {
      const urls = getSolanaRpcUrls({
        networkId: "solana-devnet",
        rpcUrl: "https://single-rpc.example.com",
      });
      expect(urls).toEqual(["https://single-rpc.example.com"]);
    });
  });

  describe("fetchSolanaBalance", () => {
    it("fetches zero balance from devnet by default", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: "2.0",
          result: { context: { slot: 100 }, value: 0 },
          id: 1,
        }),
      });

      const result = await fetchSolanaBalance({
        address: sampleAddress,
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        DEFAULT_SOLANA_RPC_URLS["solana-devnet"],
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "ngrok-skip-browser-warning": "1",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getBalance",
            params: [sampleAddress, { commitment: "confirmed" }],
          }),
        })
      );

      expect(result.lamports).toBe(0n);
      expect(result.formatted).toBe("0 tSOL");
      expect(result.unit).toBe("tSOL");
      expect(result.networkId).toBe("solana-devnet");
    });

    it("routes through relay proxy when relayBaseUrl is given", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: "2.0",
          result: { context: { slot: 100 }, value: 1000000000 },
          id: 1,
        }),
      });

      const result = await fetchSolanaBalance({
        address: sampleAddress,
        relayBaseUrl: "http://127.0.0.1:8098",
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8098/chain-rpc/solana-devnet/rpc",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "ngrok-skip-browser-warning": "1",
          }),
        })
      );

      expect(result.lamports).toBe(1000000000n);
      expect(result.formatted).toBe("1 tSOL");
    });

    it("fails over to secondary RPC when primary returns rate-limit (429)", async () => {
      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            result: { context: { slot: 105 }, value: 500000000 },
            id: 1,
          }),
        });

      const result = await fetchSolanaBalance({
        address: sampleAddress,
        relayBaseUrl: "http://127.0.0.1:8098",
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "http://127.0.0.1:8098/chain-rpc/solana-devnet/rpc",
        expect.anything()
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        DEFAULT_SOLANA_RPC_URLS["solana-devnet"],
        expect.anything()
      );
      expect(result.lamports).toBe(500000000n);
      expect(result.formatted).toBe("0.5 tSOL");
    });

    it("formats whole and fractional SOL balances correctly on devnet", async () => {
      // 2.5 SOL = 2,500,000,000 lamports
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: "2.0",
          result: { context: { slot: 100 }, value: 2500000000 },
          id: 1,
        }),
      });

      const result = await fetchSolanaBalance({
        address: sampleAddress,
        networkId: "solana-devnet",
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      expect(result.lamports).toBe(2500000000n);
      expect(result.formatted).toBe("2.5 tSOL");
      expect(result.unit).toBe("tSOL");
      expect(result.networkId).toBe("solana-devnet");
    });

    it("supports mainnet networkId and formats with SOL unit", async () => {
      // 1 SOL = 1,000,000,000 lamports
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: "2.0",
          result: { context: { slot: 200 }, value: 1000000000 },
          id: 1,
        }),
      });

      const result = await fetchSolanaBalance({
        address: sampleAddress,
        networkId: "solana-mainnet",
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        DEFAULT_SOLANA_RPC_URLS["solana-mainnet"],
        expect.anything()
      );
      expect(result.lamports).toBe(1000000000n);
      expect(result.formatted).toBe("1 SOL");
      expect(result.unit).toBe("SOL");
      expect(result.networkId).toBe("solana-mainnet");
    });

    it("supports custom rpcUrl override", async () => {
      const customRpc = "https://custom-solana-rpc.example.com";
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: "2.0",
          result: { context: { slot: 300 }, value: 500000000 }, // 0.5 SOL
          id: 1,
        }),
      });

      const result = await fetchSolanaBalance({
        address: sampleAddress,
        rpcUrl: customRpc,
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      expect(mockFetch).toHaveBeenCalledWith(customRpc, expect.anything());
      expect(result.formatted).toBe("0.5 tSOL");
    });

    it("throws on HTTP error status when all endpoints fail", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      });

      await expect(
        fetchSolanaBalance({
          address: sampleAddress,
          fetchImpl: mockFetch as unknown as typeof fetch,
        })
      ).rejects.toThrow("Solana RPC HTTP error: 503");
    });

    it("throws on RPC error response", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: "2.0",
          error: { code: -32602, message: "Invalid param: Invalid base58" },
          id: 1,
        }),
      });

      await expect(
        fetchSolanaBalance({
          address: "invalid-address",
          fetchImpl: mockFetch as unknown as typeof fetch,
        })
      ).rejects.toThrow("Invalid param: Invalid base58");
    });
  });
});
