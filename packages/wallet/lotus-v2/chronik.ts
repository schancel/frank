/**
 * What the Lotus v2 wallet reads from a Lotus node's Chronik, and the one implementation of it.
 *
 * - Unspent coins and address history come from the opt-in `/v2/*` JSON routes. They are
 *   **confirmed-only** (`confirmed_only: true`): a mempool output or spend is not there.
 * - Whether the node knows a transaction (mempool or block) and broadcasting use the legacy
 *   routes `GET /tx/:id` and `POST /broadcast-tx`, which the Lotus v2 node serves for native v7
 *   transactions too. Those routes print ids byte-reversed; this file converts, so everything
 *   above it uses wire-order ids.
 * - The checkpoint check uses legacy `GET /block/:height`.
 *
 * The base URL is a relay's `/chain-rpc/<chain>/chronik` proxy or, in tests, the node's own
 * Chronik. Nothing here parses a transaction.
 */
import { ChronikClient } from "chronik-client";

import { rpcTxid } from "./network";

export interface LotusV2IndexedCoin {
  /** Wire-order txid. */
  readonly txid: string;
  readonly outIdx: number;
  readonly value: bigint;
  readonly height: number;
  /** A coinbase output (the block's first transaction): spendable only once mature. */
  readonly coinbase: boolean;
}

/** The node answered and refused the transaction; it was not accepted by this call. */
export class LotusV2BroadcastRefused extends Error {
  constructor(readonly reason?: string) {
    super(reason ? `The network refused the transaction: ${reason}` : "The network refused the transaction");
    this.name = "LotusV2BroadcastRefused";
  }
}

export interface LotusV2Indexer {
  /** Confirmed unspent native coins locked to exactly `root` (one branch, path `[[0]]`). */
  listUnspent(root: string): Promise<readonly LotusV2IndexedCoin[]>;
  /** True once a confirmed output was ever locked to `root`. */
  hasHistory(root: string): Promise<boolean>;
  /** `confirmed` when mined, `pending` while in the mempool, `unknown` when the node lacks it. */
  transactionState(txid: string): Promise<"confirmed" | "pending" | "unknown">;
  /** Throws {@link LotusV2BroadcastRefused} when the node says no; any other error is unknown. */
  broadcast(rawHex: string): Promise<void>;
  /** Hash of the block at `height`, in the node's display order. */
  blockHash(height: number): Promise<string>;
  /** Height of the tip the confirmed `/v2` index has reached. */
  tipHeight(): Promise<number>;
}

interface V2Record {
  txid: string;
  out_idx: number;
  flags: number;
  value: string;
  token_id: string;
  branches: string[];
  paths: number[][];
  creation: { height: string; tx_index: number };
  spend: unknown;
}

const ZERO_TOKEN = "00".repeat(32);

export function chronikLotusV2Indexer(params: {
  /** Chronik base URL, without a trailing slash. */
  readonly url: string;
  readonly fetch?: typeof fetch;
}): LotusV2Indexer {
  const base = params.url.replace(/\/+$/, "");
  const doFetch = params.fetch ?? fetch;
  const chronik = new ChronikClient([base]);
  const read = async (path: string, body?: unknown): Promise<unknown> => {
    const request = () =>
      body === undefined
        ? doFetch(`${base}${path}`)
        : doFetch(`${base}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
    let response = await request();
    // Lotus v2 Chronik answers 503 `index_unavailable` at once, without waiting, while its writer
    // holds the confirmed database (connecting a block); a relay passes that on as 502. These reads
    // are safe to repeat.
    for (let attempt = 1; [502, 503].includes(response.status) && attempt <= 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      response = await request();
    }
    if (!response.ok)
      throw new Error(`Lotus Chronik ${path}: HTTP ${response.status}`);
    return response.json();
  };
  const post = async (path: string, body: unknown) =>
    (await read(path, body)) as {
      confirmed_only?: boolean;
      cursor: string | null;
      outputs: { record: V2Record }[];
    };
  const matches = (root: string, record: V2Record) =>
    record.flags === 0 &&
    record.token_id === ZERO_TOKEN &&
    record.branches.length === 1 &&
    record.branches[0] === root &&
    JSON.stringify(record.paths) === "[[0]]";
  return {
    async listUnspent(root) {
      const coins: LotusV2IndexedCoin[] = [];
      let cursor: string | null = null;
      // Bounded: 100 pages of 100 outputs per address is far more than a wallet address holds.
      for (let page = 0; page < 100; page++) {
        const result = await post("/v2/branches/utxos", {
          any_branch: [root],
          page_size: 100,
          ...(cursor ? { cursor } : {}),
        });
        for (const { record } of result.outputs) {
          if (record.spend !== null || !matches(root, record)) continue;
          coins.push({
            txid: record.txid,
            outIdx: record.out_idx,
            value: BigInt(record.value),
            height: Number(record.creation.height),
            coinbase: record.creation.tx_index === 0,
          });
        }
        cursor = result.cursor;
        if (!cursor) return coins;
      }
      throw new Error("Lotus Chronik returned too many pages of coins for one address");
    },
    async hasHistory(root) {
      const result = await post("/v2/branches/outputs", { any_branch: [root], page_size: 1 });
      return result.outputs.length > 0;
    },
    async transactionState(txid) {
      try {
        const tx = await chronik.tx(rpcTxid(txid));
        return tx.block === undefined ? "pending" : "confirmed";
      } catch (error) {
        if (error instanceof Error && /: 404: /.test(error.message)) return "unknown";
        throw error;
      }
    },
    async broadcast(rawHex) {
      try {
        await chronik.broadcastTx(rawHex);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Chronik answers 400 when the node's mempool rejected the transaction.
        const refused = /: 400: (.*)$/s.exec(message);
        if (refused) throw new LotusV2BroadcastRefused(refused[1]);
        throw error;
      }
    },
    async blockHash(height) {
      return (await chronik.block(height)).blockInfo.hash;
    },
    async tipHeight() {
      const status = (await read("/v2/status")) as { ready?: boolean; snapshot?: { height?: string } };
      const height = Number(status.snapshot?.height);
      if (!status.ready || !Number.isSafeInteger(height))
        throw new Error("Lotus Chronik /v2 index is not ready");
      return height;
    },
  };
}
