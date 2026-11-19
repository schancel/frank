/**
 * INTEGRATION: the Lotus v2 wallet the app opens, through the real relay binary, on a real
 * `lotusd -regtest` with Chronik. The wallet takes its checkpoint from the relay's GET /chains
 * (the block the relay verified its Chronik upstream against), reads coins through the relay's
 * `/v2` Chronik routes and broadcasts native v7 transactions through it.
 *
 * Needs LOTUSD_BIN (see lotusd-regtest.testutil.ts) and CASHWEBD_BIN, a built `cashwebd-exe`
 * (`cargo build -p cashwebd-exe` in backend/cashweb). Without them the suite is NOT RUN, or fails
 * under FRANK_REQUIRE_NODES=1.
 */
import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { openRelayUtxoChain } from "../chain/utxo-family";
import { nodeSuiteReady } from "../node-binaries.testutil";
import { findLotusd, freePort, lotusdBinary, startLotusRegtest, type LotusRegtest } from "./lotusd-regtest.testutil";
import { keyhashPaymentSize } from "./network";
import { memoryLotusV2WalletStore } from "./wallet";

const lotusd = findLotusd();
const cashwebd = process.env.CASHWEBD_BIN && existsSync(process.env.CASHWEBD_BIN) ? process.env.CASHWEBD_BIN : undefined;
const suite = nodeSuiteReady("lotus-v2 relay.regtest", [
  lotusdBinary(lotusd),
  { name: "cashwebd-exe", found: cashwebd !== undefined, hint: "set CASHWEBD_BIN to a cargo-built cashwebd-exe" },
])
  ? describe
  : describe.skip;
const XPI = 1_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

suite("Lotus v2 wallet through the real relay on a real regtest node", () => {
  let node: LotusRegtest;
  let relay: ChildProcess | undefined;
  let relayUrl: string;
  let dir: string;
  const log: string[] = [];

  beforeAll(async () => {
    node = await startLotusRegtest(lotusd!);
    dir = mkdtempSync(join(tmpdir(), "frank-lotus-relay-"));
    const port = await freePort();
    relayUrl = `http://127.0.0.1:${port}`;
    const config = join(dir, "relay.toml");
    writeFileSync(
      config,
      [
        `host = "127.0.0.1:${port}"`,
        `url = "${relayUrl}"`,
        "",
        "[registry]",
        'group_writes = { min_price_wei = "1000000000000", payee = "0x000000000000000000000000000000000000dEaD" }',
        `db_path = ${JSON.stringify(join(dir, "relay-db"))}`,
        'network = "monad-regtest"',
        'net = "regtest"',
        "peers = []",
        "public_relay_urls = []",
        "",
        "[registry.evm_mailbox]",
        "enabled = false",
        "",
        "[registry.pop]",
        "enabled = false",
        'evm_rpc_url = "http://unused.invalid"',
        'hmac_secret = "unused-because-pop-is-disabled"',
        'payment_recipient = "0x0000000000000000000000000000000000000000"',
        'min_value_wei = "0"',
        "",
        "[registry.bitcoin_proxy]",
        "enabled = true",
        "",
        "[[registry.bitcoin_proxy.chains]]",
        'id = "lotus-v2-regtest"',
        'chronik_upstream_env = "LOTUS_V2_REGTEST_CHRONIK_URL"',
        `checkpoint_height = ${node.checkpoint.height}`,
        `checkpoint_hash = "${node.checkpoint.hash}"`,
        "",
        "[registry.oracle]",
        "collect = false",
        "",
      ].join("\n"),
      { mode: 0o600 }
    );
    relay = spawn(cashwebd!, [config], {
      cwd: dir,
      env: { ...process.env, LOTUS_V2_REGTEST_CHRONIK_URL: node.chronikUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    relay.stdout?.on("data", (chunk) => log.push(String(chunk)));
    relay.stderr?.on("data", (chunk) => log.push(String(chunk)));
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const response = await fetch(`${relayUrl}/chain-rpc/lotus-v2-regtest/chronik/v2/status`);
        if (response.ok) break;
      } catch {
        // not listening yet
      }
      if (relay.exitCode !== null || Date.now() > deadline)
        throw new Error(`the relay did not start:\n${log.join("").slice(-4000)}`);
      await sleep(250);
    }
  }, 180_000);
  afterAll(async () => {
    if (relay && relay.exitCode === null) {
      const exited = new Promise((resolve) => relay!.once("exit", resolve));
      relay.kill("SIGTERM");
      await exited;
    }
    relay?.stdout?.destroy();
    relay?.stderr?.destroy();
    await node?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  const checkpointFromRelay = async () => {
    const document = (await (await fetch(`${relayUrl}/chains`)).json()) as {
      chains: { id: string; operator_checkpoint?: { block_number: number; block_hash: string } }[];
    };
    const row = document.chains.find((chain) => chain.id === "lotus-v2-regtest");
    if (!row?.operator_checkpoint) throw new Error("the relay names no Lotus checkpoint");
    return { height: row.operator_checkpoint.block_number, hash: row.operator_checkpoint.block_hash };
  };
  const openWallet = async () => {
    const opened = openRelayUtxoChain({
      chainIdentifier: "lotus-v2-regtest",
      relayBaseUrl: relayUrl,
      checkpoint: await checkpointFromRelay(),
      lotusStoreFor: () => memoryLotusV2WalletStore(),
    });
    const wallet = await opened.createWallet(Uint8Array.from(randomBytes(32)));
    return { chain: opened.chain, wallet, close: opened.close };
  };

  it("names the checkpoint it verified, and the wallet opened on it receives, sends with change and settles", async () => {
    expect(await checkpointFromRelay()).toEqual(node.checkpoint);
    const alice = await openWallet();
    const bob = await openWallet();
    await node.fund((await alice.wallet.getReceiveAddress()).raw, 5n * XPI);
    const transfers = alice.chain.nativeTransfers!;
    expect(await transfers.getBalance({ wallet: alice.wallet })).toBe(5n * XPI);
    const recipient = alice.chain.parseAddress((await bob.wallet.getReceiveAddress()).raw)!;
    const quote = await transfers.estimateLegacyFee!({ wallet: alice.wallet, recipient, value: 2n * XPI });
    const sent = await transfers.send({ wallet: alice.wallet, recipient, value: 2n * XPI, maxFee: quote.totalFee });
    expect(await transfers.getTransactionStatus({ wallet: alice.wallet, transaction: sent })).toBe("pending");
    await node.mine(1);
    expect(await transfers.getTransactionStatus({ wallet: alice.wallet, transaction: sent })).toBe("confirmed");
    expect(await bob.wallet.getBalance()).toBe(2n * XPI);
    expect(await alice.wallet.getBalance()).toBe(3n * XPI - BigInt(keyhashPaymentSize(1, 2)));
    await alice.close();
    await bob.close();
  }, 120_000);

  it("a wallet given a checkpoint the relay's chain does not have is refused", async () => {
    const opened = openRelayUtxoChain({
      chainIdentifier: "lotus-v2-regtest",
      relayBaseUrl: relayUrl,
      checkpoint: { height: 1, hash: "ab".repeat(32) },
      lotusStoreFor: () => memoryLotusV2WalletStore(),
    });
    await expect(opened.createWallet(Uint8Array.from(randomBytes(32)))).rejects.toThrow(/not on the checkpoint chain/);
    await opened.close();
  }, 60_000);
});
