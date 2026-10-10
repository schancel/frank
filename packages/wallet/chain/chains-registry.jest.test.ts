import { readFileSync } from "fs";
import { join } from "path";
import { DEPLOYMENTS } from "../../contracts/deployments";
import {
  PROTOCOL_CHAINS,
  CANONICAL_SOLANA_CONTRACTS,
  getChainRegistryEntry,
  getChainRegistryByKind,
  getChainRegistryByNetworkTag,
  getChainRegistryByCaip2,
  getChainsByCurve,
  resolveChainIdentifier,
  requireChainContract,
  getAllChainsByKind,
  getChainsByFamily,
  getChainExchangeConfig,
  isChainEnabled,
  getChainsByNetwork,
  resolveNetworkId,
  validateChainAddress,
} from "./chains-registry";

describe("chains-registry", () => {
  it("exposes only protocol-owned networks and their full identity requirements", () => {
    const source = JSON.parse(
      readFileSync(
        join(__dirname, "../../../docs/protocol/chains/v1.json"),
        "utf8"
      )
    );
    const byId = new Map(
      source.chains.map((row: { id: string }) => [row.id, row])
    );
    for (const [id, entry] of Object.entries(PROTOCOL_CHAINS)) {
      const row = byId.get(id) as {
        allowed_proxy_capabilities: string[];
        identity_probes: unknown[];
      };
      expect(row).toBeDefined();
      expect(entry).toMatchObject({
        allowedProxyCapabilities: row.allowed_proxy_capabilities,
        identityProbes: row.identity_probes,
      });
    }
  });

  it("does not expose client-only Holesky as a supported canonical network", () => {
    expect(getChainRegistryEntry("ethereum-holesky")).toBeUndefined();
    expect(
      getAllChainsByKind("ethereum").map((chain) => chain.id)
    ).not.toContain("ethereum-holesky");
  });

  it("uses only the two existing public Sepolia defaults in order", () => {
    const urls = PROTOCOL_CHAINS["ethereum-sepolia"].rpcUrls;
    const publicDefaults = [
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://rpc.sepolia.org",
    ];
    // Counts and boolean comparison keep rejected operator URLs out of failure output.
    expect(urls?.length).toBe(2);
    expect(urls?.every((url, index) => url === publicDefaults[index])).toBe(
      true
    );
  });

  it("defines all canonical mainnet and testnet chain configurations", () => {
    expect(PROTOCOL_CHAINS["monad-testnet"]).toMatchObject({
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
      exchange: {
        pluginId: "uniswap-universal-router",
        routerName: "Uniswap Universal Router",
        adapterType: "dex-router",
        defaultPair: { from: "MON", to: "USDC", defaultAmount: "100" },
        supportedAssets: ["MON", "USDC", "USDT", "AVU"],
      },
    });

    expect(PROTOCOL_CHAINS["monad-mainnet"]).toMatchObject({
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
      exchange: {
        pluginId: "uniswap-universal-router",
        routerName: "Uniswap Universal Router",
        adapterType: "dex-router",
        defaultPair: { from: "MON", to: "USDC", defaultAmount: "100" },
        supportedAssets: ["MON", "USDC", "USDT", "AVU"],
      },
    });

    expect(PROTOCOL_CHAINS["xec-testnet"]).toMatchObject({
      id: "xec-testnet",
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
      exchange: {
        pluginId: "ecash-atomic-swap",
        routerName: "eCash Atomic Swap Router",
        adapterType: "atomic-swap",
        defaultPair: { from: "XEC", to: "USDC", defaultAmount: "1000000" },
        supportedAssets: ["XEC", "USDC", "USDT", "AVU"],
      },
    });

    expect(PROTOCOL_CHAINS["xec-mainnet"]).toMatchObject({
      id: "xec-mainnet",
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
      exchange: {
        pluginId: "ecash-atomic-swap",
        routerName: "eCash Atomic Swap Router",
        adapterType: "atomic-swap",
        defaultPair: { from: "XEC", to: "USDC", defaultAmount: "1000000" },
        supportedAssets: ["XEC", "USDC", "USDT", "AVU"],
      },
    });

    expect(PROTOCOL_CHAINS["solana-devnet"]).toMatchObject({
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
      exchange: {
        pluginId: "jupiter-aggregator",
        routerName: "Jupiter Aggregator v6",
        adapterType: "dex-aggregator",
        defaultPair: { from: "SOL", to: "USDC", defaultAmount: "1" },
        supportedAssets: ["SOL", "USDC", "USDT", "AVU"],
      },
    });

    expect(PROTOCOL_CHAINS["solana-testnet"]).toMatchObject({
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
      exchange: {
        pluginId: "jupiter-aggregator",
        routerName: "Jupiter Aggregator v6",
        adapterType: "dex-aggregator",
        defaultPair: { from: "SOL", to: "USDC", defaultAmount: "1" },
        supportedAssets: ["SOL", "USDC", "USDT", "AVU"],
      },
    });

    expect(PROTOCOL_CHAINS["solana-mainnet"]).toMatchObject({
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
      exchange: {
        pluginId: "jupiter-aggregator",
        routerName: "Jupiter Aggregator v6",
        adapterType: "dex-aggregator",
        defaultPair: { from: "SOL", to: "USDC", defaultAmount: "1" },
        supportedAssets: ["SOL", "USDC", "USDT", "AVU"],
      },
    });

    expect(PROTOCOL_CHAINS["ethereum-sepolia"]).toMatchObject({
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
      rpcUrls: [
        "https://ethereum-sepolia-rpc.publicnode.com",
        "https://rpc.sepolia.org",
      ],
      exchange: {
        pluginId: "uniswap-universal-router",
        routerName: "Uniswap Universal Router",
        adapterType: "dex-router",
        defaultPair: { from: "ETH", to: "USDC", defaultAmount: "0.1" },
        supportedAssets: ["ETH", "USDC", "USDT", "AVU"],
      },
    });

    expect(PROTOCOL_CHAINS["ethereum-mainnet"]).toMatchObject({
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
      exchange: {
        pluginId: "uniswap-universal-router",
        routerName: "Uniswap Universal Router",
        adapterType: "dex-router",
        defaultPair: { from: "ETH", to: "USDC", defaultAmount: "0.1" },
        supportedAssets: ["ETH", "USDC", "USDT", "AVU"],
      },
    });

    expect(PROTOCOL_CHAINS["hyperliquid-mainnet"]).toMatchObject({
      id: "hyperliquid-mainnet",
      kind: "hyperliquid",
      family: "evm",
      curve: "secp256k1",
      keyType: 1,
      network: "mainnet",
      isTestnet: false,
      name: "Hyperliquid",
      unit: "HYPE",
      caip2: "eip155:999",
      nativeChainId: 999,
      networkTag: "HYPE",
      exchange: {
        pluginId: "hyperliquid-l1",
        routerName: "Hyperliquid L1 Orderbook Router",
        adapterType: "clob-orderbook",
        defaultPair: { from: "HYPE", to: "USDC", defaultAmount: "10" },
        supportedAssets: ["HYPE", "USDC", "USDT", "AVU"],
      },
    });

    expect(PROTOCOL_CHAINS["hyperliquid-testnet"]).toMatchObject({
      id: "hyperliquid-testnet",
      kind: "hyperliquid",
      family: "evm",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "Hyperliquid Testnet",
      unit: "tHYPE",
      caip2: "eip155:998",
      nativeChainId: 998,
      networkTag: "HYPT",
      exchange: {
        pluginId: "hyperliquid-l1",
        routerName: "Hyperliquid L1 Orderbook Router",
        adapterType: "clob-orderbook",
        defaultPair: { from: "HYPE", to: "USDC", defaultAmount: "10" },
        supportedAssets: ["HYPE", "USDC", "USDT", "AVU"],
      },
    });

    expect(PROTOCOL_CHAINS["tempo-mainnet"]).toMatchObject({
      id: "tempo-mainnet",
      kind: "tempo",
      family: "evm",
      curve: "secp256k1",
      keyType: 1,
      network: "mainnet",
      isTestnet: false,
      name: "Tempo",
      unit: "USD",
      caip2: "eip155:4217",
      nativeChainId: 4217,
      networkTag: "TMPO",
      exchange: {
        pluginId: "tempo-router",
        routerName: "Tempo Settlement Engine",
        adapterType: "settlement-engine",
        defaultPair: { from: "USD", to: "USDC", defaultAmount: "100" },
        supportedAssets: ["USD", "USDC", "USDT", "AVU"],
      },
    });

    expect(PROTOCOL_CHAINS["tempo-testnet"]).toMatchObject({
      id: "tempo-testnet",
      kind: "tempo",
      family: "evm",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "Tempo Moderato",
      unit: "tUSD",
      caip2: "eip155:42431",
      nativeChainId: 42431,
      networkTag: "TMPT",
      exchange: {
        pluginId: "tempo-router",
        routerName: "Tempo Settlement Engine",
        adapterType: "settlement-engine",
        defaultPair: { from: "USD", to: "USDC", defaultAmount: "100" },
        supportedAssets: ["USD", "USDC", "USDT", "AVU"],
      },
    });

    expect(PROTOCOL_CHAINS["btc-mainnet"]).toMatchObject({
      id: "btc-mainnet",
      kind: "bitcoin",
      family: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      network: "mainnet",
      isTestnet: false,
      name: "Bitcoin",
      unit: "BTC",
      caip2: "bip122:000000000019d6689c085ae165831e93",
      networkTag: "BTC1",
    });

    expect(PROTOCOL_CHAINS["btc-testnet"]).toMatchObject({
      id: "btc-testnet",
      kind: "bitcoin",
      family: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "Bitcoin Testnet",
      unit: "tBTC",
      caip2: "bip122:000000000933ea01ad0ee984209779ba",
      networkTag: "BTCT",
    });

    expect(PROTOCOL_CHAINS["btc-testnet4"]).toMatchObject({
      id: "btc-testnet4",
      kind: "bitcoin",
      family: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "Bitcoin Testnet4",
      unit: "tBTC",
      networkTag: "BTC4",
    });

    expect(PROTOCOL_CHAINS["bch-mainnet"]).toMatchObject({
      id: "bch-mainnet",
      kind: "bitcoincash",
      family: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      network: "mainnet",
      isTestnet: false,
      name: "Bitcoin Cash",
      unit: "BCH",
      addressPrefix: "bitcoincash",
      networkTag: "BCH1",
    });

    expect(PROTOCOL_CHAINS["bch-testnet"]).toMatchObject({
      id: "bch-testnet",
      kind: "bitcoincash",
      family: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "Bitcoin Cash Chipnet",
      unit: "tBCH",
      addressPrefix: "bchtest",
      networkTag: "BCHT",
    });

    expect(PROTOCOL_CHAINS["doge-mainnet"]).toMatchObject({
      id: "doge-mainnet",
      kind: "dogecoin",
      family: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      network: "mainnet",
      isTestnet: false,
      name: "Dogecoin",
      unit: "DOGE",
      networkTag: "DOGE",
    });

    expect(PROTOCOL_CHAINS["doge-testnet"]).toMatchObject({
      id: "doge-testnet",
      kind: "dogecoin",
      family: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "Dogecoin Testnet",
      unit: "tDOGE",
      networkTag: "DOGT",
    });
  });

  it("resolves exchange router configuration via getChainExchangeConfig", () => {
    expect(getChainExchangeConfig("monad")?.routerName).toBe(
      "Uniswap Universal Router"
    );
    expect(getChainExchangeConfig("ecash")?.routerName).toBe(
      "eCash Atomic Swap Router"
    );
    expect(getChainExchangeConfig("ecash")?.pluginId).toBe("ecash-atomic-swap");
    expect(getChainExchangeConfig("xec-mainnet")?.adapterType).toBe(
      "atomic-swap"
    );
    expect(getChainExchangeConfig("solana")?.routerName).toBe(
      "Jupiter Aggregator v6"
    );
    expect(getChainExchangeConfig("solana")?.pluginId).toBe(
      "jupiter-aggregator"
    );
    expect(getChainExchangeConfig("ethereum")?.routerName).toBe(
      "Uniswap Universal Router"
    );
    expect(getChainExchangeConfig("hyperliquid")?.routerName).toBe(
      "Hyperliquid L1 Orderbook Router"
    );
    expect(getChainExchangeConfig("tempo")?.routerName).toBe(
      "Tempo Settlement Engine"
    );
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
    expect(getChainRegistryByKind("hyperliquid", true).unit).toBe("tHYPE");
    expect(getChainRegistryByKind("hyperliquid", false).unit).toBe("HYPE");
    expect(getChainRegistryByKind("tempo", true).unit).toBe("tUSD");
    expect(getChainRegistryByKind("tempo", false).unit).toBe("USD");
  });

  it("resolves entries by networkTag", () => {
    expect(getChainRegistryByNetworkTag("MONT")?.id).toBe("monad-testnet");
    expect(getChainRegistryByNetworkTag("MON1")?.id).toBe("monad-mainnet");
    expect(getChainRegistryByNetworkTag("SOLD")?.id).toBe("solana-devnet");
    expect(getChainRegistryByNetworkTag("SOL1")?.id).toBe("solana-mainnet");
    expect(getChainRegistryByNetworkTag("SEPO")?.id).toBe("ethereum-sepolia");
    expect(getChainRegistryByNetworkTag("HYPE")?.id).toBe(
      "hyperliquid-mainnet"
    );
    expect(getChainRegistryByNetworkTag("HYPT")?.id).toBe(
      "hyperliquid-testnet"
    );
    expect(getChainRegistryByNetworkTag("TMPO")?.id).toBe("tempo-mainnet");
    expect(getChainRegistryByNetworkTag("TMPT")?.id).toBe("tempo-testnet");
    expect(getChainRegistryByNetworkTag("UNKNOWN")).toBeUndefined();
  });

  it("resolves entries by CAIP-2", () => {
    expect(getChainRegistryByCaip2("eip155:10143")?.id).toBe("monad-testnet");
    expect(getChainRegistryByCaip2("eip155:1")?.id).toBe("ethereum-mainnet");
    expect(getChainRegistryByCaip2("eip155:999")?.id).toBe(
      "hyperliquid-mainnet"
    );
    expect(getChainRegistryByCaip2("eip155:4217")?.id).toBe("tempo-mainnet");
    expect(
      getChainRegistryByCaip2("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")?.id
    ).toBe("solana-mainnet");
    expect(getChainRegistryByCaip2("invalid:caip2")).toBeUndefined();
  });

  it("groups chains by curve family", () => {
    const secp256k1Chains = getChainsByCurve("secp256k1");
    expect(
      secp256k1Chains.every((c) => c.curve === "secp256k1" && c.keyType === 1)
    ).toBe(true);
    expect(secp256k1Chains.map((c) => c.id)).toContain("monad-testnet");
    expect(secp256k1Chains.map((c) => c.id)).toContain("ethereum-mainnet");

    const ed25519Chains = getChainsByCurve("ed25519");
    expect(
      ed25519Chains.every((c) => c.curve === "ed25519" && c.keyType === 2)
    ).toBe(true);
    expect(ed25519Chains.map((c) => c.id)).toContain("solana-mainnet");
    expect(ed25519Chains.map((c) => c.id)).toContain("solana-devnet");
  });

  it("resolves chain identifier from id, networkTag, or CAIP-2", () => {
    expect(resolveChainIdentifier("monad-testnet")?.id).toBe("monad-testnet");
    expect(resolveChainIdentifier("MONT")?.id).toBe("monad-testnet");
    expect(resolveChainIdentifier("eip155:10143")?.id).toBe("monad-testnet");
    expect(resolveChainIdentifier("solana-devnet")?.id).toBe("solana-devnet");
    expect(resolveChainIdentifier("SOLD")?.id).toBe("solana-devnet");
    expect(resolveChainIdentifier("ethereum-sepolia")?.id).toBe(
      "ethereum-sepolia"
    );
    expect(resolveChainIdentifier("SEPO")?.id).toBe("ethereum-sepolia");
    expect(resolveChainIdentifier("eip155:11155111")?.id).toBe(
      "ethereum-sepolia"
    );
    expect(resolveChainIdentifier("nonexistent")).toBeUndefined();
  });

  it("gives an EVM network the contract addresses of its own deployment record and nothing otherwise", () => {
    for (const entry of getChainsByFamily("evm")) {
      const record = DEPLOYMENTS[entry.id];
      if (!record) {
        expect([entry.id, entry.contracts]).toEqual([entry.id, undefined]);
        expect(() => requireChainContract(entry.id, "htlc")).toThrow(
          `GenericHTLC is not deployed on ${entry.id}`
        );
        expect(() => requireChainContract(entry.id, "stateChannel")).toThrow(
          `StateChannel is not deployed on ${entry.id}`
        );
        continue;
      }
      expect(record.chainIdentifier).toBe(entry.id);
      expect(record.chainId).toBe(String(entry.nativeChainId));
      expect(entry.contracts).toEqual({
        htlc: record.contracts.GenericHTLC.address,
        stateChannel: record.contracts.StateChannel.address,
      });
      expect(requireChainContract(entry.id, "htlc")).toBe(
        record.contracts.GenericHTLC.address
      );
    }
  });

  it("lists deployment records only for client-supported EVM networks, one address per network", () => {
    const addresses: string[] = [];
    for (const [id, record] of Object.entries(DEPLOYMENTS)) {
      expect([id, PROTOCOL_CHAINS[id]?.family]).toEqual([id, "evm"]);
      for (const contract of Object.values(record.contracts)) {
        expect(contract.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(contract.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
        addresses.push(`${id}:${contract.address}`);
      }
    }
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it("has no contract address for a network that is not EVM or Solana, or is unknown", () => {
    expect(PROTOCOL_CHAINS["xec-mainnet"].contracts).toBeUndefined();
    expect(() => requireChainContract("xec-mainnet", "htlc")).toThrow(
      "GenericHTLC is not deployed on xec-mainnet"
    );
    expect(() => requireChainContract("monad", "htlc")).toThrow(
      'Unknown chain identifier "monad"'
    );
    expect(() => requireChainContract("evm", "htlc")).toThrow(
      'Unknown chain identifier "evm"'
    );
    // The addresses once registered for every EVM network never held code anywhere.
    expect(JSON.stringify(PROTOCOL_CHAINS)).not.toMatch(
      /391a080Bd6FF21CB4598adF063Dc94018CD186E5|18E98e3B789F0b84c7060Bb28bF4385809F3aF57/i
    );
    // Solana still carries placeholder program ids; no program is deployed there.
    expect(PROTOCOL_CHAINS["solana-mainnet"].contracts).toEqual(
      CANONICAL_SOLANA_CONTRACTS
    );
  });

  describe("multi-testnet and family queries", () => {
    it("returns all testnets for a chain kind supporting multiple concurrent testnets", () => {
      const ethTestnets = getAllChainsByKind("ethereum", { isTestnet: true });
      expect(ethTestnets.map((c) => c.id)).toEqual(["ethereum-sepolia"]);

      const ethMainnets = getAllChainsByKind("ethereum", { isTestnet: false });
      expect(ethMainnets.map((c) => c.id)).toEqual(["ethereum-mainnet"]);

      const allEth = getAllChainsByKind("ethereum");
      expect(allEth.map((c) => c.id)).toEqual([
        "ethereum-sepolia",
        "ethereum-mainnet",
      ]);

      const solTestnets = getAllChainsByKind("solana", { isTestnet: true });
      expect(solTestnets.map((c) => c.id)).toEqual([
        "solana-devnet",
        "solana-testnet",
      ]);
    });

    it("returns chains filtered by cryptographic/VM family", () => {
      const evmTestnets = getChainsByFamily("evm", { isTestnet: true });
      const evmTestnetIds = evmTestnets.map((c) => c.id);
      expect(evmTestnetIds).toContain("monad-testnet");
      expect(evmTestnetIds).toContain("ethereum-sepolia");
      expect(evmTestnetIds).toContain("hyperliquid-testnet");
      expect(evmTestnetIds).toContain("tempo-testnet");
      expect(evmTestnets.every((c) => c.family === "evm" && c.isTestnet)).toBe(
        true
      );

      const solanaChains = getChainsByFamily("solana");
      expect(solanaChains.map((c) => c.id)).toEqual([
        "solana-devnet",
        "solana-testnet",
        "solana-mainnet",
      ]);
    });
  });

  describe("relay protocol synchronization (docs/protocol/chains/v1.json)", () => {
    const protocolRegistry = JSON.parse(
      readFileSync(
        join(__dirname, "../../../docs/protocol/chains/v1.json"),
        "utf8"
      )
    ) as {
      schema_version: number;
      chains: Array<{
        id: string;
        family: string;
        network: string;
        caip2: string | null;
        native_chain_id: string | null;
        identity_probes: unknown[];
        allowed_proxy_capabilities: string[];
      }>;
    };

    it("verifies protocol registry schema version and chain count", () => {
      expect(protocolRegistry.schema_version).toBe(1);
      expect(protocolRegistry.chains.length).toBe(26);
    });

    it("agrees with every supported protocol row, including Bitcoin-family probes and capability limits", () => {
      const source = new Map(
        protocolRegistry.chains.map((row) => [row.id, row])
      );
      for (const entry of Object.values(PROTOCOL_CHAINS)) {
        const row = source.get(entry.id);
        if (!row) throw new Error(`Missing authoritative row ${entry.id}`);
        expect(row).toBeDefined();
        expect(entry.family).toBe(row.family);
        expect(entry.network).toBe(row.network);
        expect(entry.isTestnet).toBe(row.network !== "mainnet");
        expect(entry.caip2).toBe(row.caip2 ?? undefined);
        expect(
          entry.nativeChainId === undefined
            ? undefined
            : String(entry.nativeChainId)
        ).toBe(row.native_chain_id ?? undefined);
        expect(entry.allowedProxyCapabilities).toEqual(
          row.allowed_proxy_capabilities
        );
        expect(entry.identityProbes).toEqual(row.identity_probes);
      }
    });

    it("supports an explicit all-family subset and leaves every omitted protocol row unavailable", () => {
      const omitted = [
        "btc-regtest",
        "bch-regtest",
        "xpi-mainnet",
        "xpi-testnet",
        "xpi-regtest",
      ];
      const supported = [
        "monad-testnet",
        "monad-mainnet",
        "xec-testnet",
        "xec-regtest",
        "xec-mainnet",
        "solana-devnet",
        "solana-testnet",
        "solana-mainnet",
        "ethereum-sepolia",
        "ethereum-mainnet",
        "hyperliquid-mainnet",
        "hyperliquid-testnet",
        "tempo-mainnet",
        "tempo-testnet",
        "btc-mainnet",
        "btc-testnet",
        "btc-testnet4",
        "bch-mainnet",
        "bch-testnet",
        "doge-mainnet",
        "doge-testnet",
      ];
      expect(Object.keys(PROTOCOL_CHAINS)).toEqual(supported);
      expect(
        protocolRegistry.chains
          .map((row) => row.id)
          .filter((id) => !supported.includes(id))
          .sort()
      ).toEqual(omitted.sort());
      for (const id of [
        ...omitted,
        "ethereum-holesky",
        "unknown",
        "toString",
        "__proto__",
      ])
        expect(getChainRegistryEntry(id)).toBeUndefined();
    });
  });

  describe("isChainEnabled and getChainsByNetwork", () => {
    it("defaults testnet chains to enabled and mainnet chains to disabled", () => {
      expect(isChainEnabled("monad-testnet")).toBe(true);
      expect(isChainEnabled("btc-testnet")).toBe(true);
      expect(isChainEnabled("bch-testnet")).toBe(true);
      expect(isChainEnabled("doge-testnet")).toBe(true);
      expect(isChainEnabled("solana-devnet")).toBe(true);
      expect(isChainEnabled("ethereum-sepolia")).toBe(true);

      expect(isChainEnabled("monad-mainnet")).toBe(false);
      expect(isChainEnabled("btc-mainnet")).toBe(false);
      expect(isChainEnabled("bch-mainnet")).toBe(false);
      expect(isChainEnabled("doge-mainnet")).toBe(false);
      expect(isChainEnabled("solana-mainnet")).toBe(false);
      expect(isChainEnabled("ethereum-mainnet")).toBe(false);
    });

    it("filters chains by network type", () => {
      const testnets = getChainsByNetwork(true);
      const mainnets = getChainsByNetwork(false);

      expect(testnets.length).toBeGreaterThanOrEqual(9);
      expect(mainnets.length).toBeGreaterThanOrEqual(7);
      expect(testnets.every((c) => c.isTestnet)).toBe(true);
      expect(mainnets.every((c) => !c.isTestnet)).toBe(true);
    });
  });

  describe("validateChainAddress", () => {
    it("validates EVM addresses across Monad, Ethereum, Tempo, Hyperliquid", () => {
      const evm = "0x18E98e3B789F0b84c7060Bb28bF4385809F3aF57";
      expect(validateChainAddress("monad", evm)).toBe(true);
      expect(validateChainAddress("ethereum", evm)).toBe(true);
      expect(validateChainAddress("tempo", evm)).toBe(true);
      expect(validateChainAddress("hyperliquid", evm)).toBe(true);
      expect(validateChainAddress("monad", "0xinvalid")).toBe(false);
    });

    it("validates Solana base58 addresses", () => {
      const sol = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
      expect(validateChainAddress("solana", sol)).toBe(true);
      expect(
        validateChainAddress(
          "solana",
          "0x18E98e3B789F0b84c7060Bb28bF4385809F3aF57"
        )
      ).toBe(false);
    });

    it("validates Bitcoin Bech32 and Legacy addresses", () => {
      expect(
        validateChainAddress(
          "bitcoin",
          "bc1qqyqszqgpqyqszqgpqyqszqgpqyqszqgpyfl4f3"
        )
      ).toBe(true);
      expect(
        validateChainAddress(
          "bitcoin",
          "tb1qqyqszqgpqyqszqgpqyqszqgpqyqszqgpw0yxjz"
        )
      ).toBe(true);
      expect(
        validateChainAddress("bitcoin", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")
      ).toBe(true);
      expect(
        validateChainAddress(
          "bitcoin",
          "0x18E98e3B789F0b84c7060Bb28bF4385809F3aF57"
        )
      ).toBe(false);
    });

    it("validates Bitcoin Cash CashAddress", () => {
      expect(
        validateChainAddress(
          "bitcoincash",
          "bitcoincash:qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyrygcdp8p"
        )
      ).toBe(true);
      expect(
        validateChainAddress(
          "bitcoincash",
          "bchtest:qqqszqgpqyqszqgpqyqszqgpqyqszqgpqy8kvl0kqa"
        )
      ).toBe(true);
      expect(validateChainAddress("bitcoincash", "not-an-address")).toBe(false);
    });

    it("validates Dogecoin Base58 addresses", () => {
      expect(
        validateChainAddress("dogecoin", "D5EQRCnPMXmRvUoZwC7gu7fYspean3PQ9a")
      ).toBe(true);
      expect(
        validateChainAddress("dogecoin", "nUHU9DXJHWE9oTNky1m99XFr7h2snReVPP")
      ).toBe(true);
      expect(validateChainAddress("dogecoin", "invalid-doge")).toBe(false);
    });
  });

  describe("resolveNetworkId", () => {
    it("resolves canonical network IDs for both testnet and mainnet", () => {
      // Direct canonical IDs are returned unchanged
      expect(resolveNetworkId("btc-testnet")).toBe("btc-testnet");
      expect(resolveNetworkId("btc-mainnet")).toBe("btc-mainnet");
      expect(resolveNetworkId("xec-testnet")).toBe("xec-testnet");

      // Chain kinds resolve according to isTestnet flag
      expect(resolveNetworkId("bitcoin", true)).toBe("btc-testnet");
      expect(resolveNetworkId("bitcoin", false)).toBe("btc-mainnet");
      expect(resolveNetworkId("bitcoincash", true)).toBe("bch-testnet");
      expect(resolveNetworkId("bitcoincash", false)).toBe("bch-mainnet");
      expect(resolveNetworkId("dogecoin", true)).toBe("doge-testnet");
      expect(resolveNetworkId("dogecoin", false)).toBe("doge-mainnet");
      expect(resolveNetworkId("ecash", true)).toBe("xec-testnet");
      expect(resolveNetworkId("ecash", false)).toBe("xec-mainnet");
      expect(resolveNetworkId("solana", true)).toBe("solana-devnet");
      expect(resolveNetworkId("solana", false)).toBe("solana-mainnet");
      expect(resolveNetworkId("monad", true)).toBe("monad-testnet");
      expect(resolveNetworkId("monad", false)).toBe("monad-mainnet");
      expect(resolveNetworkId("ethereum", true)).toBe("ethereum-sepolia");
      expect(resolveNetworkId("ethereum", false)).toBe("ethereum-mainnet");
    });
  });
});

describe("wallet support", () => {
  it("names exactly the networks the app has a wallet for, and how each is read", () => {
    const supported = Object.fromEntries(
      Object.values(PROTOCOL_CHAINS)
        .filter((chain) => chain.wallet !== undefined)
        .map((chain) => [chain.id, chain.wallet])
    );
    expect(supported).toEqual({
      "monad-testnet": { indexer: "json-rpc" },
      "monad-mainnet": { indexer: "json-rpc" },
      "solana-devnet": { indexer: "json-rpc" },
      "solana-mainnet": { indexer: "json-rpc" },
      "xec-testnet": { indexer: "chronik" },
      "xec-regtest": { indexer: "chronik" },
      "btc-testnet": { indexer: "electrum" },
      "bch-testnet": { indexer: "electrum" },
    });
  });

  it("reads every wallet through a proxy capability the protocol permits for that chain", () => {
    for (const chain of Object.values(PROTOCOL_CHAINS)) {
      if (chain.wallet === undefined) continue;
      expect(chain.allowedProxyCapabilities).toContain(chain.wallet.indexer);
    }
  });
});
