/**
 * Wallet sync dispatcher (Issue #1118).
 * Decouples message inbox sync dispatch from WalletHandle.
 *
 * Dispatches a generic WalletSyncItem across wallet sub-systems:
 * - Sub-account pool: marks spent sub-accounts to avoid multi-device desync
 * - HD address inventory: consumes nonces, records spends, updates branch balances
 * - Legacy UTXO storage: deletes spent outpoints, registers created outpoints
 */
import type { WalletSyncItem } from "./types/messages";

export interface WalletSyncDispatchResult {
  affectedIndices?: number[];
  affectedAccounts?: string[];
  deletedUtxos?: string[];
  putUtxos?: unknown[];
}

export function applyWalletSyncItem(
  wallet: any,
  item: WalletSyncItem
): WalletSyncDispatchResult {
  if (!wallet || !item) {
    return {};
  }

  const result: WalletSyncDispatchResult = {};

  // 1. Dispatch to wallet.pool (MonadSubAccountPool)
  if (wallet.pool) {
    try {
      if (typeof wallet.pool.processSyncTransaction === "function") {
        const poolRes = wallet.pool.processSyncTransaction(item);
        if (poolRes?.affectedIndices && poolRes.affectedIndices.length > 0) {
          result.affectedIndices = poolRes.affectedIndices;
        }
      } else if (
        typeof wallet.pool.setStatus === "function" &&
        item.direction === "out" &&
        item.spentInputs
      ) {
        const affected: number[] = [];
        const spentSet = new Set(
          item.spentInputs.map((i: { address: string }) =>
            i.address.toLowerCase()
          )
        );
        const records =
          typeof wallet.pool.store?.getAll === "function"
            ? wallet.pool.store.getAll()
            : [];
        for (const record of records) {
          if (
            record &&
            spentSet.has(record.address.toLowerCase()) &&
            record.status !== "spent" &&
            record.status !== "retired"
          ) {
            wallet.pool.setStatus(record.index, "spent");
            affected.push(record.index);
          }
        }
        if (affected.length > 0) {
          result.affectedIndices = affected;
        }
      }
    } catch (err) {
      console.warn("applyWalletSyncItem: pool dispatch failed:", err);
    }
  }

  // 2. Dispatch to wallet.inventory (MonadAddressInventory / EvmAddressInventory)
  if (wallet.inventory) {
    try {
      if (typeof wallet.inventory.processSyncTransaction === "function") {
        const invRes = wallet.inventory.processSyncTransaction(item);
        if (invRes?.affectedAccounts && invRes.affectedAccounts.length > 0) {
          result.affectedAccounts = invRes.affectedAccounts;
        }
      } else {
        const affected: string[] = [];
        if (item.direction === "out" && item.spentInputs) {
          for (const input of item.spentInputs) {
            if (typeof wallet.inventory.markSpent === "function") {
              wallet.inventory.markSpent(input.address);
              affected.push(input.address);
            }
            if (typeof wallet.inventory.consumeNonce === "function") {
              wallet.inventory.consumeNonce(input.address, input.nonce);
            }
          }
        }
        if (affected.length > 0) {
          result.affectedAccounts = affected;
        }
      }
    } catch (err) {
      console.warn("applyWalletSyncItem: inventory dispatch failed:", err);
    }
  }

  // 3. Dispatch UTXO operations: wallet.deleteUtxo
  if (item.direction === "out" && item.spentInputs) {
    const deleted: string[] = [];
    for (const input of item.spentInputs) {
      if (input.outpoint && typeof wallet.deleteUtxo === "function") {
        try {
          wallet.deleteUtxo(input.outpoint);
          deleted.push(input.outpoint);
        } catch (err) {
          console.warn("applyWalletSyncItem: deleteUtxo failed:", err);
        }
      }
    }
    if (deleted.length > 0) {
      result.deletedUtxos = deleted;
    }
  }

  // 4. Dispatch UTXO operations: wallet.putUtxo
  if (item.direction === "in" && typeof wallet.putUtxo === "function") {
    const put: unknown[] = [];
    if (item.createdOutputs) {
      for (const output of item.createdOutputs) {
        if (output.outpoint && output.valueWei !== undefined) {
          try {
            const utxo = {
              outpoint: output.outpoint,
              address: output.address,
              value: output.valueWei,
              outputIndex: output.index ?? 0,
            };
            wallet.putUtxo(utxo);
            put.push(utxo);
          } catch (err) {
            console.warn("applyWalletSyncItem: putUtxo failed:", err);
          }
        }
      }
    }
    if (
      item.transfer &&
      item.transfer.txId &&
      item.transfer.vout !== undefined
    ) {
      try {
        const utxo = {
          txId: item.transfer.txId,
          outputIndex: item.transfer.vout,
          address: item.transfer.destination,
          value: item.transfer.value,
        };
        wallet.putUtxo(utxo);
        put.push(utxo);
      } catch (err) {
        console.warn("applyWalletSyncItem: putUtxo transfer failed:", err);
      }
    }
    if (put.length > 0) {
      result.putUtxos = put;
    }
  }

  return result;
}
