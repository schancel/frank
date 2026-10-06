import {
  PROTOCOL_CHAINS,
  getChainRegistryEntry,
  getChainRegistryByKind,
} from "./chains-registry";

describe("chains-registry", () => {
  it("defines all canonical mainnet and testnet chain configurations", () => {
    expect(PROTOCOL_CHAINS["monad-testnet"]).toEqual({
      id: "monad-testnet",
      kind: "monad",
      family: "evm",
      network: "testnet",
      isTestnet: true,
      name: "Monad Testnet",
      unit: "MONT",
      caip2: "eip155:10143",
      nativeChainId: 10143,
      networkTag: "MONT",
      contracts: {
        channelVault: "0x720472c8ce72c2A2D711333e064ABD3E6BbEAdd3",
        tablePotVault: "0xe8D2A1E88c91DCd5433208d4152Cc4F399a7e91d",
        htlc: "0x5067457698Fd6Fa1C6964e416b3f42713513B3dD",
      },
    });

    expect(PROTOCOL_CHAINS["monad-mainnet"]).toEqual({
      id: "monad-mainnet",
      kind: "monad",
      family: "evm",
      network: "mainnet",
      isTestnet: false,
      name: "Monad",
      unit: "MON",
      caip2: "eip155:143",
      nativeChainId: 143,
      networkTag: "MON1",
      contracts: {
        channelVault: "0x720472c8ce72c2A2D711333e064ABD3E6BbEAdd3",
        tablePotVault: "0xe8D2A1E88c91DCd5433208d4152Cc4F399a7e91d",
        htlc: "0x5067457698Fd6Fa1C6964e416b3f42713513B3dD",
      },
    });

    expect(PROTOCOL_CHAINS["ecash-testnet"]).toEqual({
      id: "ecash-testnet",
      kind: "ecash",
      family: "bitcoin",
      network: "testnet",
      isTestnet: true,
      name: "eCash Testnet",
      unit: "tXEC",
      addressPrefix: "ectest",
    });

    expect(PROTOCOL_CHAINS["ecash-mainnet"]).toEqual({
      id: "ecash-mainnet",
      kind: "ecash",
      family: "bitcoin",
      network: "mainnet",
      isTestnet: false,
      name: "eCash",
      unit: "XEC",
      addressPrefix: "ecash",
    });

    expect(PROTOCOL_CHAINS["solana-testnet"]).toEqual({
      id: "solana-testnet",
      kind: "solana",
      family: "solana",
      network: "testnet",
      isTestnet: true,
      name: "Solana Testnet",
      unit: "tSOL",
      caip2: "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
    });

    expect(PROTOCOL_CHAINS["solana-mainnet"]).toEqual({
      id: "solana-mainnet",
      kind: "solana",
      family: "solana",
      network: "mainnet",
      isTestnet: false,
      name: "Solana",
      unit: "SOL",
      caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    });
  });

  it("resolves entries by id and by kind + isTestnet", () => {
    expect(getChainRegistryEntry("monad-testnet")?.unit).toBe("MONT");
    expect(getChainRegistryEntry("monad-mainnet")?.unit).toBe("MON");
    expect(getChainRegistryEntry("non-existent")).toBeUndefined();

    expect(getChainRegistryByKind("monad", true).unit).toBe("MONT");
    expect(getChainRegistryByKind("monad", false).unit).toBe("MON");
    expect(getChainRegistryByKind("ecash", true).unit).toBe("tXEC");
    expect(getChainRegistryByKind("ecash", false).unit).toBe("XEC");
    expect(getChainRegistryByKind("solana", true).unit).toBe("tSOL");
    expect(getChainRegistryByKind("solana", false).unit).toBe("SOL");
  });
});
