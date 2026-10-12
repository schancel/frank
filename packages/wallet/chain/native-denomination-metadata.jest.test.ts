import { PROTOCOL_CHAINS, getChainRegistryEntry } from "./chains-registry";
import source from "../../../docs/protocol/chains/v1.json";
import { projectProtocolChains } from "./protocol-chain-registry";

it("offers native denomination facts for every configured canonical network without a wallet", () => {
  const expected = {
    "monad-testnet": 18,
    "monad-regtest": 18,
    "monad-mainnet": 18,
    "xec-testnet": 2,
    "xec-regtest": 2,
    "xec-mainnet": 2,
    "solana-devnet": 9,
    "solana-testnet": 9,
    "solana-mainnet": 9,
    "ethereum-sepolia": 18,
    "ethereum-mainnet": 18,
    "hyperliquid-mainnet": 18,
    "hyperliquid-testnet": 18,
    "tempo-mainnet": null,
    "tempo-testnet": null,
    "btc-mainnet": 8,
    "btc-testnet": 8,
    "btc-testnet4": 8,
    "bch-mainnet": 8,
    "bch-testnet": 8,
    "doge-mainnet": 8,
    "doge-testnet": 8,
  };
  expect(
    Object.fromEntries(
      Object.values(PROTOCOL_CHAINS).map((entry) => [
        entry.id,
        entry.nativeDecimals,
      ])
    )
  ).toEqual(expected);
  for (const [id, nativeDecimals] of Object.entries(expected)) {
    expect(getChainRegistryEntry(id)).toMatchObject({ id, nativeDecimals });
    expect(Object.isFrozen(getChainRegistryEntry(id))).toBe(true);
  }
  expect(getChainRegistryEntry("unknown")).toBeUndefined();
});

it.each([null, 0, 2, 8, 9, 18, 255])(
  "preserves explicit nativeDecimals %s in the pure projection",
  (nativeDecimals) => {
    const extension = {
      kind: "monad",
      curve: "secp256k1",
      keyType: 1,
      name: "fixture",
      unit: "MON",
      nativeDecimals,
    };
    const projected = projectProtocolChains(source, {
      "monad-testnet": extension,
    });
    expect(projected["monad-testnet"].nativeDecimals).toBe(nativeDecimals);
    extension.nativeDecimals = 7;
    expect(projected["monad-testnet"].nativeDecimals).toBe(nativeDecimals);
  }
);

it.each([undefined, -1, 0.5, NaN, Infinity, 256, "18", false])(
  "rejects invalid or missing nativeDecimals %s",
  (nativeDecimals) => {
    expect(() =>
      projectProtocolChains(source, {
        "monad-testnet": { name: "fixture", unit: "MON", nativeDecimals },
      })
    ).toThrow("nativeDecimals");
  }
);
