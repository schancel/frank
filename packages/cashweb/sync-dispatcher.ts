/**
 * Wallet sync dispatcher (Issue #1118).
 * Decouples message inbox sync dispatch from WalletHandle.
 *
 * Dispatches a generic WalletSyncItem across wallet sub-systems:
 * - Sub-account pool: records a spent sub-account through the pool's own sync operation
 * - Legacy UTXO storage: deletes spent outpoints, registers created outpoints
 * - Received coins: a `received-coin` note is handed to the wallet's coin list
 *   (`recordReceivedCoin`), which derives the key itself and records the coin only if it opens the
 *   named account. Recording a coin twice changes nothing.
 *
 * Order and failure (Issue #1235). Chain affinity is checked first, before any branch. The pool
 * branch then decides before the UTXO branches mutate: it is awaited, and its
 * refusal rejects the dispatch with the pool's own typed error, so a refused item changes
 * nothing and the caller sees it. The pool is only ever asked through `processSyncTransaction`;
 * a pool that does not offer it is not written to.
 *
 * Do not call this from inside the wallet's own operation queue (a send, a canonical or a topic
 * operation): the pool's spend applier may enter that queue and would wait for itself.
 */
import type { ReceivedCoinItem, WalletSyncItem } from "./types/messages";

export interface WalletSyncDispatchResult {
  affectedIndices?: number[];
  /** Addresses of received coins the wallet's own keys open (new or known already). */
  recordedCoins?: string[];
  deletedUtxos?: string[];
  putUtxos?: unknown[];
}

/** The item was refused at the sync boundary before any wallet sub-system was asked to apply it. */
export class WalletSyncItemRejectedError extends Error {
  constructor(
    readonly code: "chain-mismatch",
    readonly walletChainIdentifier: string,
    readonly itemChainIdentifier: unknown
  ) {
    super(
      `Wallet sync item rejected (${code}): the wallet is bound to "${walletChainIdentifier}", the item names ${
        typeof itemChainIdentifier === "string"
          ? `"${itemChainIdentifier}"`
          : "no chain"
      }`
    );
    this.name = "WalletSyncItemRejectedError";
  }
}

export async function applyWalletSyncItem(
  wallet: any,
  item: WalletSyncItem | ReceivedCoinItem
): Promise<WalletSyncDispatchResult> {
  if (!wallet || !item) {
    return {};
  }

  // 0. Chain affinity, before any branch: a wallet bound to one canonical chain takes only that
  // chain's items. A wallet that names no chain (the legacy UTXO wallet) is not checked here.
  if (
    typeof wallet.chainIdentifier === "string" &&
    wallet.chainIdentifier !== item.chainIdentifier
  ) {
    throw new WalletSyncItemRejectedError(
      "chain-mismatch",
      wallet.chainIdentifier,
      item.chainIdentifier
    );
  }

  const result: WalletSyncDispatchResult = {};

  // A received coin's derivation note goes to the coin list and nowhere else. A wallet with no
  // coin list ignores it.
  if (item.type === "received-coin") {
    if (
      typeof wallet.recordReceivedCoin === "function" &&
      (await wallet.recordReceivedCoin(item))
    )
      result.recordedCoins = [item.address.toLowerCase()];
    return result;
  }

  // 1. Dispatch to wallet.pool (MonadSubAccountPool). Awaited and not caught: a refusal stops the
  // dispatch before the branches below mutate anything.
  if (wallet.pool && typeof wallet.pool.processSyncTransaction === "function") {
    const poolRes = await wallet.pool.processSyncTransaction(item);
    if (poolRes?.affectedIndices && poolRes.affectedIndices.length > 0) {
      result.affectedIndices = poolRes.affectedIndices;
    }
  }

  // 2. Dispatch UTXO operations: wallet.deleteUtxo
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

  // 3. Dispatch UTXO operations: wallet.putUtxo
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
