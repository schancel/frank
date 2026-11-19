/**
 * INTEGRATION: the Lotus v2 wallet on a real `lotusd -regtest` with Chronik. Every transaction
 * here is a native v7 transaction built and signed by Frank and accepted (or refused) by the node.
 *
 * Needs a Lotus v2 lotusd (LOTUSD_BIN, see lotusd-regtest.testutil.ts). Without one the suite
 * reports itself as NOT RUN, or fails under FRANK_REQUIRE_NODES=1.
 */
import { randomBytes } from "crypto";

import { NativeTransactionRefusedError, NativeTransactionSubmissionError } from "../chain/chain-wallet";
import { nodeSuiteReady } from "../node-binaries.testutil";
import { chronikLotusV2Indexer, type LotusV2Indexer } from "./chronik";
import { findLotusd, lotusdBinary, startLotusRegtest, type LotusRegtest } from "./lotusd-regtest.testutil";
import { nativeTransactionSize } from "./native";
import { LotusV2Wallet, memoryLotusV2WalletStore, type LotusV2WalletStore } from "./wallet";

const lotusd = findLotusd();
const suite = nodeSuiteReady("lotus-v2 wallet.regtest", [lotusdBinary(lotusd)]) ? describe : describe.skip;
const XPI = 1_000_000n;

suite("Lotus v2 wallet on a real regtest node", () => {
  let node: LotusRegtest;
  let indexer: LotusV2Indexer;
  const open = (seed: Uint8Array, store: LotusV2WalletStore, using: LotusV2Indexer = indexer) =>
    LotusV2Wallet.create({
      chainIdentifier: "lotus-v2-regtest",
      seed,
      indexer: using,
      storeFor: () => store,
      checkpoint: node.checkpoint,
    });
  const fresh = async () => {
    const seed = Uint8Array.from(randomBytes(32));
    const store = memoryLotusV2WalletStore();
    return { seed, store, wallet: await open(seed, store) };
  };

  beforeAll(async () => {
    node = await startLotusRegtest(lotusd!);
    indexer = chronikLotusV2Indexer({ url: node.chronikUrl });
  }, 120_000);
  afterAll(async () => {
    await node?.stop();
  }, 60_000);

  it("refuses a node that is not on the checkpoint chain", async () => {
    await expect(
      LotusV2Wallet.create({
        chainIdentifier: "lotus-v2-regtest",
        seed: Uint8Array.from(randomBytes(32)),
        indexer,
        storeFor: () => memoryLotusV2WalletStore(),
        checkpoint: { height: 1, hash: "ab".repeat(32) },
      })
    ).rejects.toThrow(/not on the checkpoint chain/);
  }, 30_000);

  it("receives: a mined payment shows in the balance and the receive address moves on", async () => {
    const { wallet } = await fresh();
    const first = await wallet.getReceiveAddress();
    expect(first.raw).toMatch(/^rxpi1p/);
    expect(await wallet.getBalance()).toBe(0n);
    await node.fund(first.raw, 10n * XPI);
    expect(await wallet.getBalance()).toBe(10n * XPI);
    expect((await wallet.getReceiveAddress()).raw).not.toBe(first.raw);
  }, 60_000);

  it("sends with change: the payee gets the exact value, the fee is the signed size, change is spendable", async () => {
    const alice = await fresh();
    const bob = await fresh();
    await node.fund((await alice.wallet.getReceiveAddress()).raw, 10n * XPI);
    const sent = await alice.wallet.sendNative({
      recipient: await bob.wallet.getReceiveAddress(),
      value: 3n * XPI,
    });
    expect(await indexer.transactionState(sent.txHash)).toBe("pending");
    await node.mine(1);
    expect(await bob.wallet.getBalance()).toBe(3n * XPI);
    const fee = BigInt(nativeTransactionSize(1, 2));
    expect(await alice.wallet.getBalance()).toBe(10n * XPI - 3n * XPI - fee);
    expect(alice.wallet.coins().map((coin) => coin.origin)).toEqual(["change"]);
    expect(alice.wallet.pendingSends()).toEqual([]);
    // The change coin spends like any other.
    await alice.wallet.sendNative({ recipient: await bob.wallet.getReceiveAddress(), value: 2n * XPI });
    await node.mine(1);
    expect(await bob.wallet.getBalance()).toBe(5n * XPI);
  }, 90_000);

  it("restart mid-send: bytes recorded but never delivered are sent again unchanged; the payee is paid once", async () => {
    const alice = await fresh();
    const bob = await fresh();
    await node.fund((await alice.wallet.getReceiveAddress()).raw, 10n * XPI);
    // The broadcast never reaches the node: a transport failure, not a refusal.
    const lost: LotusV2Indexer = {
      ...indexer,
      broadcast: async () => {
        throw new Error("socket hang up");
      },
    };
    const before = await open(alice.seed, alice.store, lost);
    const recipient = await bob.wallet.getReceiveAddress();
    const failure = await before.sendNative({ recipient, value: 4n * XPI }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NativeTransactionSubmissionError);
    const txid = (failure as NativeTransactionSubmissionError).transaction.txHash;
    expect(await indexer.transactionState(txid)).toBe("unknown");
    // Its coin stays claimed: the same wallet cannot spend it again meanwhile.
    expect(before.pendingSends().map((send) => send.txid)).toEqual([txid]);
    await expect(before.sendNative({ recipient, value: 4n * XPI })).rejects.toThrow(/Insufficient funds/);
    // Reopened on the same store (a restart): the recorded bytes go out, under the same id.
    const after = await open(alice.seed, alice.store);
    expect(await indexer.transactionState(txid)).toBe("pending");
    await node.mine(1);
    expect(await indexer.transactionState(txid)).toBe("confirmed");
    expect(await bob.wallet.getBalance()).toBe(4n * XPI);
    expect(await after.getBalance()).toBe(10n * XPI - 4n * XPI - BigInt(nativeTransactionSize(1, 2)));
    expect(after.pendingSends()).toEqual([]);
    // Reopening again sends nothing more.
    await open(alice.seed, alice.store);
    await node.mine(1);
    expect(await bob.wallet.getBalance()).toBe(4n * XPI);
  }, 120_000);

  it("two concurrent sends choose different coins; both land and nothing is spent twice", async () => {
    const alice = await fresh();
    const bob = await fresh();
    for (let i = 0; i < 3; i++) await node.fund((await alice.wallet.getReceiveAddress()).raw, 2n * XPI);
    expect(await alice.wallet.getBalance()).toBe(6n * XPI);
    const recipient = await bob.wallet.getReceiveAddress();
    const [one, two] = await Promise.all([
      alice.wallet.sendNative({ recipient, value: (3n * XPI) / 2n }),
      alice.wallet.sendNative({ recipient, value: (3n * XPI) / 2n }),
    ]);
    expect(one.txHash).not.toBe(two.txHash);
    const inputs = alice.wallet.pendingSends().flatMap((send) => send.inputs.map((o) => `${o.txid}:${o.outIdx}`));
    expect(inputs).toHaveLength(2);
    expect(new Set(inputs).size).toBe(2);
    expect(await indexer.transactionState(one.txHash)).toBe("pending");
    expect(await indexer.transactionState(two.txHash)).toBe("pending");
    // A third concurrent pair cannot both be covered by the one coin left: one fails cleanly.
    const results = await Promise.allSettled([
      alice.wallet.sendNative({ recipient, value: (3n * XPI) / 2n }),
      alice.wallet.sendNative({ recipient, value: (3n * XPI) / 2n }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
    expect(String(rejected.reason)).toMatch(/Insufficient funds/);
    await node.mine(1);
    expect(await bob.wallet.getBalance()).toBe(3n * ((3n * XPI) / 2n));
    // Alice's next read sees her three sends mined and retires their records.
    await alice.wallet.getBalance();
    expect(alice.wallet.pendingSends()).toEqual([]);
  }, 120_000);

  it("a send the node refuses (another device spent the coin first) frees its claim and pays nothing", async () => {
    const seed = Uint8Array.from(randomBytes(32));
    const deviceOne = await open(seed, memoryLotusV2WalletStore());
    const deviceTwo = await open(seed, memoryLotusV2WalletStore());
    const bob = await fresh();
    await node.fund((await deviceOne.getReceiveAddress()).raw, 2n * XPI);
    expect(await deviceTwo.getBalance()).toBe(2n * XPI);
    const recipient = await bob.wallet.getReceiveAddress();
    await deviceOne.sendNative({ recipient, value: XPI });
    // The index is confirmed-only, so device two still sees the coin and signs from it.
    const refusal = await deviceTwo
      .sendNative({ recipient, value: XPI / 2n })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(NativeTransactionRefusedError);
    expect(String(refusal)).toMatch(/txn-mempool-conflict/);
    expect(deviceTwo.pendingSends()).toEqual([]);
    await node.mine(1);
    expect(await bob.wallet.getBalance()).toBe(XPI);
    const remaining = 2n * XPI - XPI - BigInt(nativeTransactionSize(1, 2));
    expect(await deviceOne.getBalance()).toBe(remaining);
    expect(await deviceTwo.getBalance()).toBe(remaining);
  }, 60_000);

  it("a recipient of another network is refused before anything is signed", async () => {
    const alice = await fresh();
    await node.fund((await alice.wallet.getReceiveAddress()).raw, 2n * XPI);
    await expect(
      alice.wallet.sendNative({
        recipient: { raw: "xpi1q80z6tf5zlwd794z4dpe28fehp3qdt2lg8q3jz3mzacmrqw20vseq37xlywnx" },
        value: XPI,
      })
    ).rejects.toThrow(/supported only on regtest/);
    expect(alice.wallet.pendingSends()).toEqual([]);
    expect(await alice.wallet.getBalance()).toBe(2n * XPI);
  }, 60_000);
});
