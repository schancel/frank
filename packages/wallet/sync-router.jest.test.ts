import {
  routeWalletSyncItem,
  type MultiChainWalletResolver,
} from "./sync-router";
import type { WalletSyncItem } from "@frank/cashweb/types/messages";

describe("routeWalletSyncItem (Issue #1126)", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("returns empty result if item is undefined or null", async () => {
    const resolver: MultiChainWalletResolver = {
      getWalletForChain: jest.fn(),
    };
    expect(await routeWalletSyncItem(undefined as any, { resolver })).toEqual(
      {}
    );
    expect(await routeWalletSyncItem(null as any, { resolver })).toEqual({});
    expect(resolver.getWalletForChain).not.toHaveBeenCalled();
  });

  it("returns empty result if item lacks chainIdentifier and chainId", async () => {
    const resolver: MultiChainWalletResolver = {
      getWalletForChain: jest.fn(),
    };
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const item = {
      type: "wallet-sync",
      direction: "out",
      txHash: "0xabc",
    } as any;

    const res = await routeWalletSyncItem(item, { resolver });
    expect(res).toEqual({});
    expect(resolver.getWalletForChain).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("item missing chainIdentifier")
    );
    warnSpy.mockRestore();
  });

  it("routes an EVM WalletSyncItem ('monad-testnet') to the EVM wallet mock", async () => {
    const mockEvmPool = {
      processSyncTransaction: jest
        .fn()
        .mockReturnValue({ affectedIndices: [0, 1] }),
    };
    const evmWallet = {
      pool: mockEvmPool,
    };

    const mockUtxoWallet = {
      deleteUtxo: jest.fn(),
      putUtxo: jest.fn(),
    };

    const resolver: MultiChainWalletResolver = {
      getWalletForChain: jest.fn(async (chainId: string) => {
        if (chainId === "monad-testnet") return evmWallet;
        if (chainId === "xec-mainnet") return mockUtxoWallet;
        return undefined;
      }),
    };

    const item: WalletSyncItem = {
      type: "wallet-sync",
      direction: "out",
      chainIdentifier: "monad-testnet",
      txHash: "0xevmtx",
      spentInputs: [{ address: "0x123", nonce: 4 }],
    };

    const res = await routeWalletSyncItem(item, { resolver });

    expect(resolver.getWalletForChain).toHaveBeenCalledWith("monad-testnet");
    expect(mockEvmPool.processSyncTransaction).toHaveBeenCalledWith(item);
    expect(mockUtxoWallet.deleteUtxo).not.toHaveBeenCalled();
    expect(res.affectedIndices).toEqual([0, 1]);
  });

  it("routes a Bitcoin / eCash WalletSyncItem ('xec-mainnet') to the UTXO wallet mock", async () => {
    const mockEvmWallet = {
      pool: { processSyncTransaction: jest.fn() },
    };

    const mockUtxoWallet = {
      deleteUtxo: jest.fn(),
      putUtxo: jest.fn(),
    };

    const resolver: MultiChainWalletResolver = {
      getWalletForChain: jest.fn(async (chainId: string) => {
        if (chainId === "monad-testnet") return mockEvmWallet;
        if (chainId === "xec-mainnet") return mockUtxoWallet;
        return undefined;
      }),
    };

    const item: WalletSyncItem = {
      type: "wallet-sync",
      direction: "out",
      chainIdentifier: "xec-mainnet",
      txHash: "0xxectx",
      spentInputs: [
        { address: "ecash:qp1", outpoint: "tx0:0" },
        { address: "ecash:qp2", outpoint: "tx0:1" },
      ],
    };

    const res = await routeWalletSyncItem(item, { resolver });

    expect(resolver.getWalletForChain).toHaveBeenCalledWith("xec-mainnet");
    expect(mockUtxoWallet.deleteUtxo).toHaveBeenCalledWith("tx0:0");
    expect(mockUtxoWallet.deleteUtxo).toHaveBeenCalledWith("tx0:1");
    expect(mockEvmWallet.pool.processSyncTransaction).not.toHaveBeenCalled();
    expect(res.deletedUtxos).toEqual(["tx0:0", "tx0:1"]);
  });

  it("canonicalizes aliases like 'ecash-mainnet' to 'xec-mainnet' via getChainRegistryEntry", async () => {
    const mockUtxoWallet = {
      deleteUtxo: jest.fn(),
    };

    const resolver: MultiChainWalletResolver = {
      getWalletForChain: jest.fn(async (chainId: string) => {
        if (chainId === "xec-mainnet") return mockUtxoWallet;
        return undefined;
      }),
    };

    const item: WalletSyncItem = {
      type: "wallet-sync",
      direction: "out",
      chainIdentifier: "ecash-mainnet",
      txHash: "0xecashalias",
      spentInputs: [{ address: "ecash:qp1", outpoint: "txalias:0" }],
    };

    const res = await routeWalletSyncItem(item, { resolver });

    expect(resolver.getWalletForChain).toHaveBeenCalledWith("xec-mainnet");
    expect(mockUtxoWallet.deleteUtxo).toHaveBeenCalledWith("txalias:0");
    expect(res.deletedUtxos).toEqual(["txalias:0"]);
  });

  it("falls back to deprecated chainId if chainIdentifier is absent", async () => {
    const mockWallet = {
      deleteUtxo: jest.fn(),
    };

    const resolver: MultiChainWalletResolver = {
      getWalletForChain: jest.fn(async (chainId: string) => {
        if (chainId === "xec-mainnet") return mockWallet;
        return undefined;
      }),
    };

    const item = {
      type: "wallet-sync",
      direction: "out",
      chainId: "xec-mainnet",
      txHash: "0xlegacy",
      spentInputs: [{ address: "ecash:qp1", outpoint: "legacytx:0" }],
    } as unknown as WalletSyncItem;

    const res = await routeWalletSyncItem(item, { resolver });

    expect(resolver.getWalletForChain).toHaveBeenCalledWith("xec-mainnet");
    expect(mockWallet.deleteUtxo).toHaveBeenCalledWith("legacytx:0");
    expect(res.deletedUtxos).toEqual(["legacytx:0"]);
  });

  it("routes Solana WalletSyncItem to the Solana wallet mock", async () => {
    const mockSolanaPool = {
      processSyncTransaction: jest
        .fn()
        .mockResolvedValue({ affectedIndices: [10] }),
    };
    const mockSolanaWallet = {
      pool: mockSolanaPool,
    };

    const resolver: MultiChainWalletResolver = {
      getWalletForChain: jest.fn(async (chainId: string) => {
        if (chainId === "solana-mainnet") return mockSolanaWallet;
        return undefined;
      }),
    };

    const item: WalletSyncItem = {
      type: "wallet-sync",
      direction: "out",
      chainIdentifier: "solana-mainnet",
      txHash: "5abc123",
      spentInputs: [{ address: "SolAddr123", nonce: 10 }],
    };

    const res = await routeWalletSyncItem(item, { resolver });

    expect(resolver.getWalletForChain).toHaveBeenCalledWith("solana-mainnet");
    expect(mockSolanaPool.processSyncTransaction).toHaveBeenCalledWith(item);
    expect(res.affectedIndices).toEqual([10]);
  });

  it("falls back to fallbackWallet if resolver returns undefined", async () => {
    const fallbackWallet = {
      deleteUtxo: jest.fn(),
    };

    const resolver: MultiChainWalletResolver = {
      getWalletForChain: jest.fn().mockResolvedValue(undefined),
    };

    const item: WalletSyncItem = {
      type: "wallet-sync",
      direction: "out",
      chainIdentifier: "custom-unresolved-chain",
      txHash: "0xfallback",
      spentInputs: [{ address: "addr", outpoint: "outp:1" }],
    };

    const res = await routeWalletSyncItem(item, {
      resolver,
      fallbackWallet,
    });

    expect(resolver.getWalletForChain).toHaveBeenCalledWith(
      "custom-unresolved-chain"
    );
    expect(fallbackWallet.deleteUtxo).toHaveBeenCalledWith("outp:1");
    expect(res.deletedUtxos).toEqual(["outp:1"]);
  });

  it("warns and returns empty result if no wallet resolved and no fallback", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const resolver: MultiChainWalletResolver = {
      getWalletForChain: jest.fn().mockResolvedValue(undefined),
    };

    const item: WalletSyncItem = {
      type: "wallet-sync",
      direction: "out",
      chainIdentifier: "unknown-chain",
      txHash: "0xunknown",
    };

    const res = await routeWalletSyncItem(item, { resolver });

    expect(res).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no wallet resolved for chain "unknown-chain"')
    );
    warnSpy.mockRestore();
  });

  it("handles synchronous getWalletForChain cleanly", async () => {
    const mockWallet = {
      deleteUtxo: jest.fn(),
    };

    const resolver: MultiChainWalletResolver = {
      getWalletForChain: (chainId: string) => {
        if (chainId === "xec-mainnet") return mockWallet;
        return undefined;
      },
    };

    const item: WalletSyncItem = {
      type: "wallet-sync",
      direction: "out",
      chainIdentifier: "xec-mainnet",
      txHash: "0xsync",
      spentInputs: [{ address: "addr", outpoint: "sync:0" }],
    };

    const res = await routeWalletSyncItem(item, { resolver });
    expect(mockWallet.deleteUtxo).toHaveBeenCalledWith("sync:0");
    expect(res.deletedUtxos).toEqual(["sync:0"]);
  });

  it("handles double-dispatch idempotently", async () => {
    const deleted: string[] = [];
    const mockWallet = {
      deleteUtxo: jest.fn((outpoint: string) => {
        if (!deleted.includes(outpoint)) {
          deleted.push(outpoint);
        }
      }),
    };

    const resolver: MultiChainWalletResolver = {
      getWalletForChain: jest.fn().mockResolvedValue(mockWallet),
    };

    const item: WalletSyncItem = {
      type: "wallet-sync",
      direction: "out",
      chainIdentifier: "xec-mainnet",
      txHash: "0xrepeat",
      spentInputs: [{ address: "addr", outpoint: "repeat:0" }],
    };

    const res1 = await routeWalletSyncItem(item, { resolver });
    const res2 = await routeWalletSyncItem(item, { resolver });

    expect(res1.deletedUtxos).toEqual(["repeat:0"]);
    expect(res2.deletedUtxos).toEqual(["repeat:0"]);
    expect(mockWallet.deleteUtxo).toHaveBeenCalledTimes(2);
    expect(deleted).toEqual(["repeat:0"]);
  });

  it("routes supported Sepolia without dynamic registration", async () => {
    const mockEvmWallet = {
      pool: {
        processSyncTransaction: jest
          .fn()
          .mockResolvedValue({ affectedIndices: [5] }),
      },
    };

    const resolver: MultiChainWalletResolver = {
      getWalletForChain: jest.fn(async (chainId: string) => {
        if (chainId === "ethereum-sepolia") return mockEvmWallet;
        return undefined;
      }),
    };

    const item: WalletSyncItem = {
      type: "wallet-sync",
      direction: "out",
      chainIdentifier: "ethereum-sepolia",
      txHash: "0xrollup",
      spentInputs: [{ address: "0xrollupaddr", nonce: 5 }],
    };

    const res = await routeWalletSyncItem(item, { resolver });

    expect(resolver.getWalletForChain).toHaveBeenCalledWith("ethereum-sepolia");
    expect(mockEvmWallet.pool.processSyncTransaction).toHaveBeenCalledWith(item);
    expect(res.affectedIndices).toEqual([5]);
  });
  // On the base the dispatcher catches the pool's error and the route resolves as if applied.
  it("surfaces the pool's refusal to the caller that awaits the route (#1235)", async () => {
    class PoolRefusal extends Error {
      readonly code = "no-applier";
    }
    const refusal = new PoolRefusal("refused");
    const evmWallet = {
      chainIdentifier: "monad-testnet",
      pool: { processSyncTransaction: jest.fn().mockRejectedValue(refusal) },
    };
    const resolver: MultiChainWalletResolver = {
      getWalletForChain: jest.fn().mockResolvedValue(evmWallet),
    };
    const item: WalletSyncItem = {
      type: "wallet-sync",
      direction: "out",
      chainIdentifier: "monad-testnet",
      txHash: "0xevmtx",
      rawTx: "0x02",
      spentInputs: [{ address: "0x123", nonce: 4 }],
    };

    await expect(routeWalletSyncItem(item, { resolver })).rejects.toBe(refusal);
  });

  // On the base a Sepolia item routed to the one EVM wallet is applied to it.
  it("rejects an item routed to a wallet bound to another chain (#1235)", async () => {
    const evmWallet = {
      chainIdentifier: "monad-testnet",
      pool: { processSyncTransaction: jest.fn() },
    };
    const resolver: MultiChainWalletResolver = {
      getWalletForChain: jest.fn().mockResolvedValue(evmWallet),
    };
    const item: WalletSyncItem = {
      type: "wallet-sync",
      direction: "out",
      chainIdentifier: "ethereum-sepolia",
      txHash: "0xevmtx",
      spentInputs: [{ address: "0x123", nonce: 4 }],
    };

    await expect(routeWalletSyncItem(item, { resolver })).rejects.toMatchObject(
      {
        name: "WalletSyncItemRejectedError",
        code: "chain-mismatch",
      }
    );
    expect(evmWallet.pool.processSyncTransaction).not.toHaveBeenCalled();
  });
});
