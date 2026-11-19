import { LotusV2UnsupportedNetworkError } from "../lotus-v2/network";
import { resolveBaseChain, UnsupportedBaseChainError } from "./base-chain";
import { openRelayUtxoChain } from "./utxo-family";

describe("base chain by configuration", () => {
  it("is absent when nothing is configured: no default network is chosen", () => {
    expect(resolveBaseChain(undefined)).toBeUndefined();
    expect(resolveBaseChain(" ")).toBeUndefined();
  });

  it("resolves the configured Lotus v2 regtest row", () => {
    const entry = resolveBaseChain("lotus-v2-regtest")!;
    expect(entry).toMatchObject({ id: "lotus-v2-regtest", family: "bitcoin", kind: "lotus", nativeDecimals: 6 });
    expect(entry.wallet).toEqual({ indexer: "chronik" });
  });

  it("refuses unknown, family, walletless and adapterless identifiers instead of defaulting", () => {
    for (const id of ["monad", "evm", "bitcoin", "lotus", "xpi-regtest", "xec-mainnet", "solana-devnet"])
      expect(() => resolveBaseChain(id)).toThrow(UnsupportedBaseChainError);
  });
});

describe("openRelayUtxoChain picks the adapter by registry kind", () => {
  it("opens the Lotus v2 adapter for the lotus row, and requires the run's checkpoint", () => {
    expect(() =>
      openRelayUtxoChain({ chainIdentifier: "lotus-v2-regtest", relayBaseUrl: "http://relay.invalid" })
    ).toThrow(/operator checkpoint/);
    const relay = openRelayUtxoChain({
      chainIdentifier: "lotus-v2-regtest",
      relayBaseUrl: "http://relay.invalid",
      checkpoint: { height: 1, hash: "00".repeat(32) },
    });
    expect(relay.chain).toMatchObject({ chainIdentifier: "lotus-v2-regtest", unit: "rXPI", family: "bitcoin" });
    expect(relay.chain.toDisplayAmount(1_500_000n)).toBe("1.5");
    expect(relay.chain.parseAddress("rxpi1pl8e2pv6n7jp0g9fgrk36qzff6z98mxnynqz57hhkvga4tq8xqlmsq2859j5u")).toBeDefined();
    expect(relay.chain.parseAddress("ecregtest:qq")).toBeUndefined();
  });

  it("never opens a Lotus row through the eCash adapter, nor Lotus v1 rows at all", () => {
    expect(() =>
      openRelayUtxoChain({ chainIdentifier: "xpi-regtest", relayBaseUrl: "http://relay.invalid" })
    ).toThrow(/No wallet is available/);
  });

  it("the Lotus chain itself refuses any row that is not Lotus v2 regtest", async () => {
    const { createLotusV2Chain } = await import("../lotus-v2/chain");
    for (const chainIdentifier of ["xec-regtest", "xpi-mainnet", "monad-testnet"])
      expect(() =>
        createLotusV2Chain({
          chainIdentifier,
          indexer: {} as never,
          checkpoint: { height: 1, hash: "00".repeat(32) },
          storeFor: () => ({ load: () => undefined, save: () => undefined }),
        })
      ).toThrow(LotusV2UnsupportedNetworkError);
  });
});
