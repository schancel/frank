import { applyWalletSyncItem } from "./sync-dispatcher";
import { WalletSyncItemRejectedError } from "@frank/cashweb/sync-dispatcher";
import type { WalletSyncItem } from "@frank/cashweb/types/messages";

describe("applyWalletSyncItem (Issue #1118)", () => {
  /** The dispatch's rejection, or undefined; a synchronous throw counts as one. */
  const rejectionOf = async (wallet: unknown, item: WalletSyncItem) => {
    try {
      await applyWalletSyncItem(wallet, item);
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it("returns empty result if wallet or item is undefined", async () => {
    expect(await applyWalletSyncItem(undefined, undefined as any)).toEqual({});
    expect(await applyWalletSyncItem({}, undefined as any)).toEqual({});
  });

  it("dispatches to wallet.pool.processSyncTransaction", async () => {
    const mockPool = {
      processSyncTransaction: jest.fn().mockReturnValue({ affectedIndices: [1, 2] }),
    };
    const wallet = { pool: mockPool };
    const item: WalletSyncItem = {
      type: "wallet-sync",
      direction: "out",
      chainIdentifier: "monad-testnet",
      txHash: "0x123",
      spentInputs: [{ address: "0xabc", valueWei: "100" }],
    };

    const res = await applyWalletSyncItem(wallet, item);
    expect(mockPool.processSyncTransaction).toHaveBeenCalledWith(item);
    expect(res.affectedIndices).toEqual([1, 2]);
  });

  // Replaces "falls back to wallet.pool.setStatus if processSyncTransaction is absent" (#1235).
  // That test asserted `setStatus(0, "spent")`: a terminal status written from an item's address
  // alone, with no signed transaction and no spend checkpoint. Only test doubles could reach it;
  // the fallback is deleted. On the base this fails: setStatus is called and index 0 reported.
  it("writes nothing to a pool that does not offer processSyncTransaction", async () => {
    const mockPool = {
      store: {
        getAll: () => [
          { index: 0, address: "0xabc", status: "available" },
          { index: 1, address: "0xdef", status: "available" },
        ],
      },
      setStatus: jest.fn(),
    };
    const wallet = { pool: mockPool };
    const item: WalletSyncItem = {
      type: "wallet-sync",
      direction: "out",
      chainIdentifier: "monad-testnet",
      txHash: "0x123",
      spentInputs: [{ address: "0xABC" }],
    };

    const res = await applyWalletSyncItem(wallet, item);
    expect(mockPool.setStatus).not.toHaveBeenCalled();
    expect(res.affectedIndices).toBeUndefined();
  });

  // On the base each of these is dispatched to every branch: the chain is never compared.
  it.each([
    ["another EVM network", "ethereum-sepolia"],
    ["a family name", "evm"],
    ["no identifier", undefined],
  ])(
    "rejects an item for %s before the pool or UTXO branch is asked (#1235)",
    async (_label, chainIdentifier) => {
      const pool = { processSyncTransaction: jest.fn() };
      const wallet = {
        chainIdentifier: "monad-testnet",
        pool,
        deleteUtxo: jest.fn(),
        putUtxo: jest.fn(),
      };
      for (const direction of ["out", "in"] as const) {
        const item = {
          type: "wallet-sync",
          direction,
          chainIdentifier,
          txHash: "0x123",
          spentInputs: [{ address: "0xabc", nonce: 1, outpoint: "tx:0" }],
          createdOutputs: [{ address: "0xdef", outpoint: "tx:1", valueWei: "1" }],
        } as unknown as WalletSyncItem;
        const rejection = await rejectionOf(wallet, item);
        expect(rejection).toMatchObject({
          name: "WalletSyncItemRejectedError",
          code: "chain-mismatch",
          walletChainIdentifier: "monad-testnet",
          itemChainIdentifier: chainIdentifier,
        });
        expect(rejection).toBeInstanceOf(WalletSyncItemRejectedError);
      }
      expect(pool.processSyncTransaction).not.toHaveBeenCalled();
      expect(wallet.deleteUtxo).not.toHaveBeenCalled();
      expect(wallet.putUtxo).not.toHaveBeenCalled();
    }
  );

  it("applies an item whose chain is the wallet's, and does not check a wallet that names none", async () => {
    const item: WalletSyncItem = {
      type: "wallet-sync",
      direction: "out",
      chainIdentifier: "monad-testnet",
      txHash: "0x123",
      spentInputs: [{ address: "0xabc", nonce: 1 }],
    };
    const bound = {
      chainIdentifier: "monad-testnet",
      pool: {
        processSyncTransaction: jest
          .fn()
          .mockResolvedValue({ affectedIndices: [4] }),
      },
    };
    expect(await applyWalletSyncItem(bound, item)).toEqual({
      affectedIndices: [4],
    });
    // The legacy UTXO wallet has no chainIdentifier; it keeps taking its own items.
    const unbound = { deleteUtxo: jest.fn() };
    expect(
      await applyWalletSyncItem(unbound, {
        ...item,
        chainIdentifier: "ecash-mainnet",
        spentInputs: [{ address: "ecash:qp1", outpoint: "tx:0" }],
      })
    ).toEqual({ deletedUtxos: ["tx:0"] });
  });

  // On the base the pool's error is caught and warned, the dispatch returns a result, and the
  // UTXO branches have already applied the refused item.
  it("propagates a pool refusal and leaves the UTXO branches unasked (#1235)", async () => {
    class PoolRefusal extends Error {
      readonly code = "missing-transaction";
    }
    const refusal = new PoolRefusal("refused");
    const wallet = {
      chainIdentifier: "monad-testnet",
      pool: { processSyncTransaction: jest.fn().mockRejectedValue(refusal) },
      deleteUtxo: jest.fn(),
      putUtxo: jest.fn(),
    };
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        await rejectionOf(wallet, {
          type: "wallet-sync",
          direction: "out",
          chainIdentifier: "monad-testnet",
          txHash: "0x123",
          spentInputs: [
            { address: "0xabc", nonce: 0, valueWei: "10", outpoint: "tx:0" },
          ],
        })
      ).toBe(refusal);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(wallet.deleteUtxo).not.toHaveBeenCalled();
    expect(wallet.putUtxo).not.toHaveBeenCalled();
  });

  it("dispatches to wallet.deleteUtxo for spentInputs with outpoints", async () => {
    const mockDelete = jest.fn();
    const wallet = { deleteUtxo: mockDelete };
    const item: WalletSyncItem = {
      type: "wallet-sync",
      direction: "out",
      chainIdentifier: "lotus",
      txHash: "0x123",
      spentInputs: [
        { address: "lotus:1", outpoint: "txid0:0" },
        { address: "lotus:2", outpoint: "txid1:1" },
      ],
    };

    const res = await applyWalletSyncItem(wallet, item);
    expect(mockDelete).toHaveBeenCalledWith("txid0:0");
    expect(mockDelete).toHaveBeenCalledWith("txid1:1");
    expect(res.deletedUtxos).toEqual(["txid0:0", "txid1:1"]);
  });

  it("dispatches to wallet.putUtxo for createdOutputs with outpoints", async () => {
    const mockPut = jest.fn();
    const wallet = { putUtxo: mockPut };
    const item: WalletSyncItem = {
      type: "wallet-sync",
      direction: "in",
      chainIdentifier: "lotus",
      txHash: "0x123",
      createdOutputs: [
        { address: "lotus:1", outpoint: "txid0:0", valueWei: "1000", index: 0 },
      ],
      transfer: {
        networkTag: "XEC1",
        txId: "txid2",
        vout: 1,
        destination: "lotus:2",
        value: "2000",
      },
    };

    const res = await applyWalletSyncItem(wallet, item);
    expect(mockPut).toHaveBeenCalledWith({
      outpoint: "txid0:0",
      address: "lotus:1",
      value: "1000",
      outputIndex: 0,
    });
    expect(mockPut).toHaveBeenCalledWith({
      txId: "txid2",
      outputIndex: 1,
      address: "lotus:2",
      value: "2000",
    });
    expect(res.putUtxos?.length).toBe(2);
  });
});
