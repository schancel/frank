/**
 * A real Lotus v2 regtest node with Chronik, for suites that exercise the Lotus wallet.
 *
 * `findLotusd` finds the binary: LOTUSD_BIN when set (the only candidate; a set path that does
 * not exist is missing), else `lotusd` on PATH. Lotus v2 publishes no release, so this is a
 * local build of the Lotus repository's v2 series (for example
 * `<lotus>/daemon/.build/v2/src/lotusd`). Suites pass `lotusdBinary(findLotusd())` to
 * `nodeSuiteReady`, which skips them as NOT RUN, or fails them under FRANK_REQUIRE_NODES=1.
 *
 * The faucet is a public test key whose native coinbases the node mines; `fund` pays from a
 * matured coinbase with a native v7 transaction built by Frank's own codec and mines a block.
 */
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";

import type { NodeBinary } from "../node-binaries.testutil";
import {
  branchLeaf,
  decodeAddress,
  encodeKeyhashAddress,
  keyhashOf,
  keyhashProgram,
  nativeTransactionSize,
  rpcTxid,
  signNativeTransaction,
  toHex,
  xOnlyPublicKey,
} from "./native";

type Env = Record<string, string | undefined>;

export function findLotusd(env: Env = process.env): string | undefined {
  if (env.LOTUSD_BIN) return existsSync(env.LOTUSD_BIN) ? env.LOTUSD_BIN : undefined;
  return spawnSync("lotusd", ["-version"]).status === 0 ? "lotusd" : undefined;
}

export const lotusdBinary = (path: string | undefined): NodeBinary => ({
  name: "a Lotus v2 lotusd with Chronik",
  found: path !== undefined,
  hint: "set LOTUSD_BIN to a lotusd built from the Lotus repository's v2 series (daemon/.build/v2/src/lotusd), or put it on PATH",
});

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const COINBASE_MATURITY = 100;

export interface LotusRegtest {
  readonly chronikUrl: string;
  readonly checkpoint: { readonly height: number; readonly hash: string };
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  /** Pays `atoms` to `address` from a matured coinbase, mines it, returns the wire txid. */
  fund(address: string, atoms: bigint): Promise<string>;
  /** Mines `blocks` blocks; their coinbases pay `address` (default the faucet). */
  mine(blocks?: number, address?: string): Promise<void>;
  stop(): Promise<void>;
}

export async function startLotusRegtest(lotusd: string): Promise<LotusRegtest> {
  const dir = mkdtempSync(join(tmpdir(), "frank-lotus-regtest-"));
  const [rpcPort, chronikPort, p2pPort] = [await freePort(), await freePort(), await freePort()];
  const child: ChildProcess = spawn(
    lotusd,
    [
      "-regtest",
      `-datadir=${dir}`,
      "-server",
      "-listen=0",
      `-port=${p2pPort}`,
      "-rpcuser=frank",
      "-rpcpassword=frank",
      `-rpcport=${rpcPort}`,
      "-rpcbind=127.0.0.1",
      "-rpcallowip=127.0.0.1",
      "-txindex=1",
      "-chronik=1",
      `-chronikbind=127.0.0.1:${chronikPort}`,
    ],
    { stdio: "ignore" }
  );
  let exited = false;
  const exit = new Promise<void>((resolve) =>
    child.once("exit", () => {
      exited = true;
      resolve();
    })
  );
  const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${rpcPort}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from("frank:frank").toString("base64")}`,
      },
      body: JSON.stringify({ jsonrpc: "1.0", id: "frank", method, params }),
    });
    const body = (await response.json()) as { result: T; error: { message: string } | null };
    if (body.error) throw new Error(`lotusd ${method}: ${body.error.message}`);
    return body.result;
  };
  const stop = async () => {
    if (!exited) {
      await rpc("stop").catch(() => undefined);
      await Promise.race([exit, sleep(20_000)]);
      if (!exited) child.kill("SIGKILL");
      await exit;
    }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (exited) throw new Error("lotusd exited during startup");
      try {
        await rpc("getblockcount");
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("lotusd did not answer in time");
        await sleep(250);
      }
    }
    const chronikUrl = `http://127.0.0.1:${chronikPort}`;
    // Faucet: public test scalar 7. Its coinbases are the only funds on this chain.
    const faucetSecret = new Uint8Array(32);
    faucetSecret[31] = 7;
    const faucetKeyhash = keyhashOf(xOnlyPublicKey(faucetSecret));
    const faucetAddress = encodeKeyhashAddress("regtest", faucetKeyhash);
    const faucetRoot = toHex(branchLeaf(keyhashProgram(faucetKeyhash)));
    const used = new Set<string>();
    const waitIndexed = async () => {
      const height = await rpc<number>("getblockcount");
      for (let i = 0; i < 200; i++) {
        const status = (await (await fetch(`${chronikUrl}/v2/status`)).json()) as {
          ready: boolean;
          snapshot?: { height: string };
        };
        if (status.ready && Number(status.snapshot?.height) >= height) return;
        await sleep(100);
      }
      throw new Error("Chronik did not index the tip in time");
    };
    const mine = async (blocks = 1, address = faucetAddress) => {
      await rpc("generatetoaddress", [blocks, address]);
      await waitIndexed();
    };
    await mine(COINBASE_MATURITY + 40);
    const checkpointHash = await rpc<string>("getblockhash", [1]);
    const fund = async (address: string, atoms: bigint) => {
      const tip = await rpc<number>("getblockcount");
      type Rec = { txid: string; out_idx: number; value: string; creation: { height: string; tx_index: number } };
      const records: Rec[] = [];
      let cursor: string | null = null;
      do {
        const page = (await (
          await fetch(`${chronikUrl}/v2/branches/utxos`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ any_branch: [faucetRoot], page_size: 100, ...(cursor ? { cursor } : {}) }),
          })
        ).json()) as { cursor: string | null; outputs: { record: Rec }[] };
        if (!page.outputs) throw new Error(`Chronik refused the faucet query: ${JSON.stringify(page)}`);
        records.push(...page.outputs.map((o) => o.record));
        cursor = page.cursor;
      } while (cursor);
      const coin = records.find(
          (r) =>
            r.creation.tx_index === 0 &&
            Number(r.creation.height) <= tip - COINBASE_MATURITY &&
            !used.has(`${r.txid}:${r.out_idx}`) &&
            BigInt(r.value) >= atoms + 10_000n
        );
      if (!coin) throw new Error("The faucet has no matured coinbase left");
      used.add(`${coin.txid}:${coin.out_idx}`);
      const fee = BigInt(nativeTransactionSize(1, 2));
      const tx = signNativeTransaction({
        network: "regtest",
        inputs: [{ txid: coin.txid, outIdx: coin.out_idx, value: BigInt(coin.value), secret: faucetSecret }],
        outputs: [
          { value: atoms, root: decodeAddress("regtest", address).root },
          { value: BigInt(coin.value) - atoms - fee, root: faucetRoot },
        ],
      });
      const accepted = await rpc<string>("sendrawtransaction", [tx.raw]);
      if (accepted !== rpcTxid(tx.txid)) throw new Error("lotusd reported another txid");
      await mine(1);
      return tx.txid;
    };
    return {
      chronikUrl,
      checkpoint: { height: 1, hash: checkpointHash },
      rpc,
      fund,
      mine,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
