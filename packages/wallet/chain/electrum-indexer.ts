/**
 * The Electrum side of a UTXO wallet: what `UtxoWallet` needs, asked of one `ElectrumClient`.
 */
import {
  ElectrumClient,
  ElectrumRpcError,
  toElectrumScriptHash,
} from "./electrum-client";
import { UtxoBroadcastRefused } from "../utxo-wallet";
import type { UtxoIndexer } from "../utxo-wallet";

/** The relay's Electrum WebSocket for one chain (`/chain-rpc/<chain>/electrum`). */
export function relayElectrumUrl(
  relayBaseUrl: string,
  chainIdentifier: string
): string {
  const url = new URL(
    `${relayBaseUrl.replace(/\/+$/, "")}/chain-rpc/${chainIdentifier}/electrum`
  );
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Relay base URL must be http(s)");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * The relay's error codes say who answered (backend `http/electrum_proxy.rs`). Only these two
 * come from the chain's side; every other code is the relay's own (quota, busy, bad request) and
 * says nothing about a transaction.
 */
export const RELAY_NODE_REFUSED_BROADCAST = -32000;
export const RELAY_UPSTREAM_ERROR = -32001;

export function electrumIndexer(client: ElectrumClient): UtxoIndexer {
  return {
    async listUnspent(scriptPubKey) {
      const outputs = await client.listUnspent(
        toElectrumScriptHash(scriptPubKey)
      );
      return outputs.map((output) => ({
        txid: output.tx_hash,
        vout: output.tx_pos,
        amount: BigInt(output.value),
        height: output.height,
      }));
    },
    async hasHistory(scriptPubKey) {
      const history = await client.getHistory(
        toElectrumScriptHash(scriptPubKey)
      );
      return history.length > 0;
    },
    async hasTransaction(txid) {
      try {
        await client.request<string>("blockchain.transaction.get", txid);
        return true;
      } catch (error) {
        // The Electrum server answered with an error: it has no such transaction. An error
        // from the relay itself, or no answer, leaves the question open.
        if (
          error instanceof ElectrumRpcError &&
          error.code === RELAY_UPSTREAM_ERROR
        ) {
          return false;
        }
        throw error;
      }
    },
    async broadcast(rawHex) {
      try {
        await client.broadcastTransaction(rawHex);
      } catch (error) {
        // Only the node's own refusal means "not broadcast". A relay error (quota, busy) or a
        // lost connection does not.
        if (
          error instanceof ElectrumRpcError &&
          error.code === RELAY_NODE_REFUSED_BROADCAST
        ) {
          throw new UtxoBroadcastRefused(error.serverMessage);
        }
        throw error;
      }
    },
    async feeRate() {
      // Coins per kilobyte for confirmation within two blocks; -1 when the server cannot say.
      const perKb = await client.request<number>("blockchain.estimatefee", 2);
      if (typeof perKb !== "number" || !(perKb > 0)) return undefined;
      return BigInt(Math.ceil(perKb * 100_000));
    },
  };
}
