import {
  fetchEcashBalance,
  getEcashChronikUrls,
  DEFAULT_CHRONIK_UPSTREAMS,
} from "./ecash-balance";

describe("ecash-balance", () => {
  describe("getEcashChronikUrls", () => {
    it("returns proxy URL and default upstream when relayBaseUrl is given", () => {
      const urls = getEcashChronikUrls({
        networkId: "xec-testnet",
        relayBaseUrl: "http://127.0.0.1:8098/",
      });
      expect(urls).toEqual([
        "http://127.0.0.1:8098/chain-rpc/xec-testnet/chronik",
        DEFAULT_CHRONIK_UPSTREAMS["xec-testnet"],
      ]);
    });

    it("returns mainnet proxy URL and mainnet default upstream", () => {
      const urls = getEcashChronikUrls({
        networkId: "xec-mainnet",
        relayBaseUrl: "https://relay.frank.cash",
      });
      expect(urls).toEqual([
        "https://relay.frank.cash/chain-rpc/xec-mainnet/chronik",
        DEFAULT_CHRONIK_UPSTREAMS["xec-mainnet"],
      ]);
    });

    it("returns only default upstream when relayBaseUrl is omitted", () => {
      const urls = getEcashChronikUrls({
        networkId: "xec-testnet",
      });
      expect(urls).toEqual([DEFAULT_CHRONIK_UPSTREAMS["xec-testnet"]]);
    });

    it("respects explicit chronikUrls override", () => {
      const urls = getEcashChronikUrls({
        networkId: "xec-testnet",
        relayBaseUrl: "http://127.0.0.1:8098",
        chronikUrls: ["https://custom-chronik.internal"],
      });
      expect(urls).toEqual(["https://custom-chronik.internal"]);
    });
  });

  describe("fetchEcashBalance", () => {
    const TESTNET_ADDR = "ectest:qre5rmxznz7gm2akscph073dmx5cln89tc5k4q5ah7";
    const MAINNET_ADDR = "ecash:qq86jv6h0y97q8l63ndynvk3fn9aq8fqru3exew8gl";

    it("fetches testnet balance and formats tXEC correctly", async () => {
      const mockScript = jest.fn(() => ({
        utxos: jest.fn().mockResolvedValue({
          utxos: [{ sats: 1_000_000n }, { sats: 50_000n }],
        }),
      }));

      const result = await fetchEcashBalance({
        address: TESTNET_ADDR,
        client: { script: mockScript },
      });

      expect(mockScript).toHaveBeenCalledWith(
        "p2pkh",
        "f341ecc298bc8dabb6860377fa2dd9a98fcce55e"
      );
      expect(result.networkId).toBe("xec-testnet");
      expect(result.unit).toBe("tXEC");
      expect(result.sats).toBe(1_050_000n);
      expect(result.formatted).toBe("10500 tXEC");
    });

    it("fetches mainnet balance and formats XEC correctly", async () => {
      const mockScript = jest.fn(() => ({
        utxos: jest.fn().mockResolvedValue({
          utxos: [{ sats: 250_050n }],
        }),
      }));

      const result = await fetchEcashBalance({
        address: MAINNET_ADDR,
        client: { script: mockScript },
      });

      expect(mockScript).toHaveBeenCalledWith(
        "p2pkh",
        "0fa93357790be01ffa8cda49b2d14ccbd01d201f"
      );
      expect(result.networkId).toBe("xec-mainnet");
      expect(result.unit).toBe("XEC");
      expect(result.sats).toBe(250_050n);
      expect(result.formatted).toBe("2500.5 XEC");
    });

    it("fails over to secondary Chronik URL when primary fails", async () => {
      const calledUrls: string[] = [];
      const clientFactory = (url: string) => {
        calledUrls.push(url);
        if (url.includes("127.0.0.1")) {
          return {
            script: () => ({
              utxos: jest
                .fn()
                .mockRejectedValue(
                  new Error("Error connecting to known Chronik instances")
                ),
            }),
          };
        }
        return {
          script: () => ({
            utxos: jest.fn().mockResolvedValue({
              utxos: [{ sats: 300_000n }],
            }),
          }),
        };
      };

      const result = await fetchEcashBalance({
        address: TESTNET_ADDR,
        relayBaseUrl: "http://127.0.0.1:8098",
        client: clientFactory,
      });

      expect(calledUrls).toEqual([
        "http://127.0.0.1:8098/chain-rpc/xec-testnet/chronik",
        DEFAULT_CHRONIK_UPSTREAMS["xec-testnet"],
      ]);
      expect(result.sats).toBe(300_000n);
      expect(result.formatted).toBe("3000 tXEC");
    });

    it("handles empty utxo list as 0 balance", async () => {
      const mockScript = jest.fn(() => ({
        utxos: jest.fn().mockResolvedValue({ utxos: [] }),
      }));

      const result = await fetchEcashBalance({
        address: TESTNET_ADDR,
        client: { script: mockScript },
      });

      expect(result.sats).toBe(0n);
      expect(result.formatted).toBe("0 tXEC");
    });

    it("throws on invalid address", async () => {
      await expect(
        fetchEcashBalance({
          address: "not-a-cash-address",
        })
      ).rejects.toThrow();
    });
  });
});
