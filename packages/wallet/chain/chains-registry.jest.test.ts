import {
  PROTOCOL_CHAINS,
  CANONICAL_EVM_CONTRACTS,
  CANONICAL_SOLANA_CONTRACTS,
  getChainRegistryEntry,
  getChainRegistryByKind,
  getChainRegistryByNetworkTag,
  getChainRegistryByCaip2,
  getChainsByCurve,
  resolveChainIdentifier,
} from "./chains-registry";

describe("chains-registry", () => {
  it("defines all canonical mainnet and testnet chain configurations", () => {
    expect(PROTOCOL_CHAINS["monad-testnet"]).toEqual({
      id: "monad-testnet",
      kind: "monad",
      family: "evm",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "Monad Testnet",
      unit: "MONT",
      caip2: "eip155:10143",
      nativeChainId: 10143,
      networkTag: "MONT",
      contracts: CANONICAL_EVM_CONTRACTS,
    });

    expect(PROTOCOL_CHAINS["monad-mainnet"]).toEqual({
      id: "monad-mainnet",
      kind: "monad",
      family: "evm",
      curve: "secp256k1",
      keyType: 1,
      network: "mainnet",
      isTestnet: false,
      name: "Monad",
      unit: "MON",
      caip2: "eip155:143",
      nativeChainId: 143,
      networkTag: "MON1",
      contracts: CANONICAL_EVM_CONTRACTS,
    });

    expect(PROTOCOL_CHAINS["ecash-testnet"]).toEqual({
      id: "ecash-testnet",
      kind: "ecash",
      family: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "eCash Testnet",
      unit: "tXEC",
      addressPrefix: "ectest",
      networkTag: "XECT",
    });

    expect(PROTOCOL_CHAINS["ecash-mainnet"]).toEqual({
      id: "ecash-mainnet",
      kind: "ecash",
      family: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      network: "mainnet",
      isTestnet: false,
      name: "eCash",
      unit: "XEC",
      addressPrefix: "ecash",
      networkTag: "XEC1",
    });

    expect(PROTOCOL_CHAINS["solana-devnet"]).toEqual({
      id: "solana-devnet",
      kind: "solana",
      family: "solana",
      curve: "ed25519",
      keyType: 2,
      network: "testnet",
      isTestnet: true,
      name: "Solana Devnet",
      unit: "dSOL",
      caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      networkTag: "SOLD",
      contracts: CANONICAL_SOLANA_CONTRACTS,
    });

    expect(PROTOCOL_CHAINS["solana-testnet"]).toEqual({
      id: "solana-testnet",
      kind: "solana",
      family: "solana",
      curve: "ed25519",
      keyType: 2,
      network: "testnet",
      isTestnet: true,
      name: "Solana Testnet",
      unit: "tSOL",
      caip2: "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
      networkTag: "SOLT",
      contracts: CANONICAL_SOLANA_CONTRACTS,
    });

    expect(PROTOCOL_CHAINS["solana-mainnet"]).toEqual({
      id: "solana-mainnet",
      kind: "solana",
      family: "solana",
      curve: "ed25519",
      keyType: 2,
      network: "mainnet",
      isTestnet: false,
      name: "Solana",
      unit: "SOL",
      caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      networkTag: "SOL1",
      contracts: CANONICAL_SOLANA_CONTRACTS,
    });

    expect(PROTOCOL_CHAINS["ethereum-sepolia"]).toEqual({
      id: "ethereum-sepolia",
      kind: "ethereum",
      family: "evm",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "Sepolia",
      unit: "SEP",
      caip2: "eip155:11155111",
      nativeChainId: 11155111,
      networkTag: "SEPO",
      contracts: CANONICAL_EVM_CONTRACTS,
    });

    expect(PROTOCOL_CHAINS["ethereum-holesky"]).toEqual({
      id: "ethereum-holesky",
      kind: "ethereum",
      family: "evm",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "Holesky",
      unit: "HOL",
      caip2: "eip155:17000",
      nativeChainId: 17000,
      networkTag: "HOLE",
      contracts: CANONICAL_EVM_CONTRACTS,
    });

    expect(PROTOCOL_CHAINS["ethereum-mainnet"]).toEqual({
      id: "ethereum-mainnet",
      kind: "ethereum",
      family: "evm",
      curve: "secp256k1",
      keyType: 1,
      network: "mainnet",
      isTestnet: false,
      name: "Ethereum",
      unit: "ETH",
      caip2: "eip155:1",
      nativeChainId: 1,
      networkTag: "ETH1",
      contracts: CANONICAL_EVM_CONTRACTS,
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
    expect(getChainRegistryByKind("solana", true).unit).toBe("dSOL");
    expect(getChainRegistryByKind("solana", false).unit).toBe("SOL");
    expect(getChainRegistryByKind("ethereum", true).unit).toBe("SEP");
    expect(getChainRegistryByKind("ethereum", false).unit).toBe("ETH");
  });

  it("resolves entries by networkTag", () => {
    expect(getChainRegistryByNetworkTag("MONT")?.id).toBe("monad-testnet");
    expect(getChainRegistryByNetworkTag("MON1")?.id).toBe("monad-mainnet");
    expect(getChainRegistryByNetworkTag("SOLD")?.id).toBe("solana-devnet");
    expect(getChainRegistryByNetworkTag("SOL1")?.id).toBe("solana-mainnet");
    expect(getChainRegistryByNetworkTag("SEPO")?.id).toBe("ethereum-sepolia");
    expect(getChainRegistryByNetworkTag("UNKNOWN")).toBeUndefined();
  });

  it("resolves entries by CAIP-2", () => {
    expect(getChainRegistryByCaip2("eip155:10143")?.id).toBe("monad-testnet");
    expect(getChainRegistryByCaip2("eip155:1")?.id).toBe("ethereum-mainnet");
    expect(getChainRegistryByCaip2("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")?.id).toBe(
      "solana-mainnet"
    );
    expect(getChainRegistryByCaip2("invalid:caip2")).toBeUndefined();
  });

  it("groups chains by curve family", () => {
    const secp256k1Chains = getChainsByCurve("secp256k1");
    expect(secp256k1Chains.every((c) => c.curve === "secp256k1" && c.keyType === 1)).toBe(true);
    expect(secp256k1Chains.map((c) => c.id)).toContain("monad-testnet");
    expect(secp256k1Chains.map((c) => c.id)).toContain("ethereum-mainnet");

    const ed25519Chains = getChainsByCurve("ed25519");
    expect(ed25519Chains.every((c) => c.curve === "ed25519" && c.keyType === 2)).toBe(true);
    expect(ed25519Chains.map((c) => c.id)).toContain("solana-mainnet");
    expect(ed25519Chains.map((c) => c.id)).toContain("solana-devnet");
  });

  it("resolves chain identifier from id, networkTag, or CAIP-2", () => {
    expect(resolveChainIdentifier("monad-testnet")?.id).toBe("monad-testnet");
    expect(resolveChainIdentifier("MONT")?.id).toBe("monad-testnet");
    expect(resolveChainIdentifier("eip155:10143")?.id).toBe("monad-testnet");
    expect(resolveChainIdentifier("solana-devnet")?.id).toBe("solana-devnet");
    expect(resolveChainIdentifier("SOLD")?.id).toBe("solana-devnet");
    expect(resolveChainIdentifier("ethereum-sepolia")?.id).toBe("ethereum-sepolia");
    expect(resolveChainIdentifier("SEPO")?.id).toBe("ethereum-sepolia");
    expect(resolveChainIdentifier("eip155:11155111")?.id).toBe("ethereum-sepolia");
    expect(resolveChainIdentifier("nonexistent")).toBeUndefined();
  });

  it("exposes canonical smart contract addresses for EVM chains and undefined for non-EVM", () => {
    expect(CANONICAL_EVM_CONTRACTS.stateChannel).toBe(
      "0x18E98e3B789F0b84c7060Bb28bF4385809F3aF57"
    );
    expect(CANONICAL_EVM_CONTRACTS.htlc).toBe(
      "0x391a080Bd6FF21CB4598adF063Dc94018CD186E5"
    );
    expect(CANONICAL_EVM_CONTRACTS.channelVault).toBe(
      "0x18E98e3B789F0b84c7060Bb28bF4385809F3aF57"
    );
    expect(CANONICAL_EVM_CONTRACTS.tablePotVault).toBe(
      "0x391a080Bd6FF21CB4598adF063Dc94018CD186E5"
    );

    expect(PROTOCOL_CHAINS["monad-testnet"].contracts).toBe(CANONICAL_EVM_CONTRACTS);
    expect(PROTOCOL_CHAINS["monad-mainnet"].contracts).toBe(CANONICAL_EVM_CONTRACTS);
    expect(PROTOCOL_CHAINS["solana-mainnet"].contracts).toBe(CANONICAL_SOLANA_CONTRACTS);
    expect(PROTOCOL_CHAINS["ecash-mainnet"].contracts).toBeUndefined();
  });
});

