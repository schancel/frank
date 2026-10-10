/**
 * UTXO chains against the real networks, through a real relay.
 *
 * Runs only when FRANK_LIVE_RELAY_URL names a running `cashwebd` (for example the one
 * `backend/cashweb/run-local-monad.sh` starts) whose config has the eCash Chronik upstream and
 * the Bitcoin and Bitcoin Cash testnet Electrum upstreams of `cashwebd.local.toml`:
 *
 *   FRANK_LIVE_RELAY_URL=http://127.0.0.1:8098 yarn --cwd packages/wallet test --runInBand \
 *     --runTestsByPath utxo-chains.live.jest.test.ts
 *
 * Nothing here is simulated. No test spends: the wallets are new and empty. A confirmed send
 * needs testnet coins at the address the test prints (set FRANK_LIVE_UTXO_SEED_HEX to keep one
 * wallet across runs, fund it, and set FRANK_LIVE_SEND=1).
 */
import { execFileSync } from "child_process";
import path from "path";
import { ChronikClient } from "chronik-client";
import { parseTransaction } from "@frank/nakamoto";
import { fetchEcashBalance } from "./chain/ecash-balance";
import { ElectrumClient } from "./chain/electrum-client";
import { electrumIndexer, relayElectrumUrl } from "./chain/electrum-indexer";
import { createUtxoChain } from "./chain/utxo-chain";
import {
  memoryUtxoWalletStore,
  UTXO_NETWORKS,
  UtxoBroadcastRefused,
} from "./utxo-wallet";
import { encodeCashAddress } from "ecashaddrjs";

const relay = process.env.FRANK_LIVE_RELAY_URL?.replace(/\/+$/, "");
const live = relay ? describe : describe.skip;
const seedHex = process.env.FRANK_LIVE_UTXO_SEED_HEX;
const seed = () =>
  seedHex
    ? Uint8Array.from(Buffer.from(seedHex, "hex"))
    : crypto.getRandomValues(new Uint8Array(32));
const sendLive = process.env.FRANK_LIVE_SEND === "1";
const unhex = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

// A well-formed transaction spending an output that does not exist: every node must refuse it.
const UNFUNDED_BTC =
  "02000000000101aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000ffffffff021027000000000000160014751e76e8199196d454941c45d1b3a323f1433bd646e9000000000000160014d0ffd12f68456932f6575286dd5516c827b9111802473044022058ad73ab430fe1681d952572c426f83990a64d2a46727336bfb1bc47d17da43002206a49701cc24573f45fd142c2a7e374c69f19e82e0b850b3a2fd9cc04d3395639012102354ac74af827776ed43fd5c848cc685dd3227728ac6aaab48f269e407d726c5b00000000";
const UNFUNDED_LEGACY =
  "0200000001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000000006a47304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee412102354ac74af827776ed43fd5c848cc685dd3227728ac6aaab48f269e407d726c5bffffffff0110270000000000001976a914751e76e8199196d454941c45d1b3a323f1433bd688ac00000000";

jest.setTimeout(120_000);

live("eCash testnet through the relay's Chronik proxy", () => {
  const chronik = () =>
    new ChronikClient([`${relay}/chain-rpc/xec-testnet/chronik`]);

  it("opens the SDK wallet, checks the chain's checkpoint, and reads balance and receive address", () => {
    // Jest cannot load the SDK's WASM glue; the real wallet runs in a Node subprocess.
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", path.join(__dirname, "ecash-wallet.livecheck.ts")],
      { cwd: __dirname, env: process.env, encoding: "utf8" }
    );
    const result = JSON.parse(output.trim().split("\n").pop()!);
    console.info(`eCash testnet wallet: ${JSON.stringify(result)}`);
    expect(result.address.startsWith("ectest:q")).toBe(true);
    expect(result.parses).toBe(true);
    expect(BigInt(result.balance)).toBeGreaterThanOrEqual(0n);
    if (result.balance === "0") {
      expect(result.emptySend).not.toBe("sent");
      expect(result.unresolved).toBeNull();
    } else if (sendLive) {
      expect(result.sent).toMatch(/^[0-9a-f]{64}$/);
      expect(result.status).not.toBe("unknown");
    }
  });

  it("reads the real unspent outputs of a funded address", async () => {
    // Find a paid script on the real chain directly, then read it through the relay.
    const direct = new ChronikClient(["https://chronik-testnet.fabien.cash"]);
    const tip = (await direct.blockchainInfo()).tipHeight;
    const coinbase = (await direct.blockTxs(tip - 1)).txs[0];
    const paid = coinbase.outputs.find((output) =>
      /^76a914[0-9a-f]{40}88ac$/.test(output.outputScript)
    );
    if (!paid) throw new Error("coinbase has no P2PKH output");
    const address = encodeCashAddress(
      "ectest",
      "p2pkh",
      paid.outputScript.slice(6, 46)
    );
    const result = await fetchEcashBalance({
      address,
      networkId: "xec-testnet",
      relayBaseUrl: relay,
    });
    expect(result.sats).toBeGreaterThanOrEqual(BigInt(paid.sats));
  });

  it("gets an explicit refusal for a transaction the node cannot accept", async () => {
    await expect(chronik().broadcastTxs([UNFUNDED_LEGACY])).rejects.toThrow(
      /^Failed getting /
    );
  });
});

live.each([
  ["btc-testnet", UNFUNDED_BTC],
  ["bch-testnet", UNFUNDED_LEGACY],
] as const)("%s through the relay's Electrum route", (chainIdentifier, unfunded) => {
  const network = UTXO_NETWORKS[chainIdentifier];
  let client: ElectrumClient;
  beforeEach(() => {
    client = new ElectrumClient({
      endpoints: [relayElectrumUrl(relay!, chainIdentifier)],
      requestTimeoutMs: 30_000,
    });
  });
  afterEach(() => client.close());

  it("reads a real, just-paid output as an unspent coin", async () => {
    const indexer = electrumIndexer(client);
    const tip = await client.request<{ height: number }>(
      "blockchain.headers.subscribe"
    );
    expect(await indexer.hasTransaction("00".repeat(32))).toBe(false);
    // Look through the newest block for an output nobody has spent yet. Scripts with a very
    // long history (busy miners) are refused by public servers; skip those.
    let found: string | undefined;
    for (let position = 0; position < 8 && !found; position++) {
      let txid: string;
      try {
        txid = await client.request<string>(
          "blockchain.transaction.id_from_pos",
          tip.height,
          position
        );
      } catch {
        break;
      }
      expect(await indexer.hasTransaction(txid)).toBe(true);
      const raw = await client.request<string>("blockchain.transaction.get", txid);
      const parsed = parseTransaction(unhex(raw), network.descriptor);
      if (!parsed.ok) throw new Error(`unparseable transaction: ${parsed.error.code}`);
      for (const [vout, paid] of parsed.value.outputs.entries()) {
        if (paid.value === 0n) continue;
        const unspent = await indexer.listUnspent(paid.scriptPubKey).catch(() => []);
        const coin = unspent.find((c) => c.txid === txid && c.vout === vout);
        if (!coin) continue;
        expect(coin).toEqual({ txid, vout, amount: paid.value, height: tip.height });
        expect(await indexer.hasHistory(paid.scriptPubKey)).toBe(true);
        found = `${txid}:${vout} pays ${paid.value} to ${hex(paid.scriptPubKey)}`;
        break;
      }
    }
    console.info(`${chainIdentifier} tip ${tip.height}: ${found}`);
    expect(found).toBeDefined();
  });

  it("opens a wallet, reads its balance and receive address, and cannot overspend", async () => {
    const chain = createUtxoChain({
      chainIdentifier,
      indexer: electrumIndexer(client),
      storeFor: () => memoryUtxoWalletStore(),
    });
    const wallet = await chain.createWallet(seed());
    const address = (await wallet.getReceiveAddress()).raw;
    const balance = await wallet.getBalance();
    console.info(`${chainIdentifier} wallet ${address} balance ${balance}`);
    expect(chain.parseAddress(address)).toEqual({ raw: address });
    if (balance === 0n) {
      await expect(
        chain.nativeTransfers.send({
          wallet,
          recipient: { raw: address },
          value: 10_000n,
        })
      ).rejects.toThrow("Insufficient funds");
      expect(wallet.getUnresolvedNativeTransaction()).toBeUndefined();
    } else if (sendLive) {
      const next = (await wallet.getReceiveAddress()).raw;
      const sent = await chain.nativeTransfers.send({
        wallet,
        recipient: { raw: next },
        value: 10_000n,
      });
      console.info(`${chainIdentifier} send ${sent.txHash}`);
      expect(
        await chain.nativeTransfers.getTransactionStatus({ wallet, transaction: sent })
      ).toBe("pending");
    }
  });

  it("gets an explicit refusal for a transaction the node cannot accept", async () => {
    await expect(electrumIndexer(client).broadcast(unfunded)).rejects.toBeInstanceOf(
      UtxoBroadcastRefused
    );
  });

  it("is refused methods outside the wallet's needs", async () => {
    await expect(client.request("server.peers.subscribe")).rejects.toThrow(
      "method denied by relay"
    );
  });
});
