import { applyWalletSyncItem } from "./sync-dispatcher";
import type { WalletSyncItem } from "@frank/cashweb/types/messages";

describe("applyWalletSyncItem (Issue #1118)", () => {
  it("returns empty result if wallet or item is undefined", () => {
    expect(applyWalletSyncItem(undefined, undefined as any)).toEqual({});
    expect(applyWalletSyncItem({}, undefined as any)).toEqual({});
  });

  it("dispatches to wallet.pool.processSyncTransaction", () => {
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

    const res = applyWalletSyncItem(wallet, item);
    expect(mockPool.processSyncTransaction).toHaveBeenCalledWith(item);
    expect(res.affectedIndices).toEqual([1, 2]);
  });

  it("falls back to wallet.pool.setStatus if processSyncTransaction is absent", () => {
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

    const res = applyWalletSyncItem(wallet, item);
    expect(mockPool.setStatus).toHaveBeenCalledWith(0, "spent");
    expect(res.affectedIndices).toEqual([0]);
  });

  it("dispatches to wallet.inventory.processSyncTransaction", () => {
    const mockInventory = {
      processSyncTransaction: jest.fn().mockReturnValue({ affectedAccounts: ["0xabc"] }),
    };
    const wallet = { inventory: mockInventory };
    const item: WalletSyncItem = {
      type: "wallet-sync",
      direction: "out",
      chainIdentifier: "monad-testnet",
      txHash: "0x123",
      spentInputs: [{ address: "0xabc", nonce: 1 }],
    };

    const res = applyWalletSyncItem(wallet, item);
    expect(mockInventory.processSyncTransaction).toHaveBeenCalledWith(item);
    expect(res.affectedAccounts).toEqual(["0xabc"]);
  });

  it("falls back to wallet.inventory markSpent / consumeNonce", () => {
    const mockInventory = {
      markSpent: jest.fn(),
      consumeNonce: jest.fn(),
    };
    const wallet = { inventory: mockInventory };
    const item: WalletSyncItem = {
      type: "wallet-sync",
      direction: "out",
      chainIdentifier: "monad-testnet",
      txHash: "0x123",
      spentInputs: [{ address: "0xabc", nonce: 2 }],
    };

    const res = applyWalletSyncItem(wallet, item);
    expect(mockInventory.markSpent).toHaveBeenCalledWith("0xabc");
    expect(mockInventory.consumeNonce).toHaveBeenCalledWith("0xabc", 2);
    expect(res.affectedAccounts).toEqual(["0xabc"]);
  });

  it("dispatches to wallet.deleteUtxo for spentInputs with outpoints", () => {
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

    const res = applyWalletSyncItem(wallet, item);
    expect(mockDelete).toHaveBeenCalledWith("txid0:0");
    expect(mockDelete).toHaveBeenCalledWith("txid1:1");
    expect(res.deletedUtxos).toEqual(["txid0:0", "txid1:1"]);
  });

  it("dispatches to wallet.putUtxo for createdOutputs with outpoints", () => {
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

    const res = applyWalletSyncItem(wallet, item);
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
