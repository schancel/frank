/**
 * INTEGRATION: the Lotus v2 wallet on a real `lotusd -regtest` with Chronik. Every transaction
 * here is a native v7 transaction built and signed by Frank and accepted (or refused) by the node.
 *
 * Needs a Lotus v2 lotusd (LOTUSD_BIN, see lotusd-regtest.testutil.ts). Without one the suite
 * reports itself as NOT RUN, or fails under FRANK_REQUIRE_NODES=1.
 */
import { randomBytes } from "crypto";

import {
  NativeFeeExceededError,
  NativeTransactionRefusedError,
  NativeTransactionSubmissionError,
} from "../chain/chain-wallet";
import { nodeSuiteReady } from "../node-binaries.testutil";
import { createLotusV2Chain } from "./chain";
import { chronikLotusV2Indexer, LotusV2BroadcastRefused, type LotusV2Indexer } from "./chronik";
import { findLotusd, lotusdBinary, startLotusRegtest, type LotusRegtest } from "./lotusd-regtest.testutil";
import { keyhashPaymentSize } from "./network";
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
    const fee = BigInt(keyhashPaymentSize(1, 2));
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
    expect(await after.getBalance()).toBe(10n * XPI - 4n * XPI - BigInt(keyhashPaymentSize(1, 2)));
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
    const remaining = 2n * XPI - XPI - BigInt(keyhashPaymentSize(1, 2));
    expect(await deviceOne.getBalance()).toBe(remaining);
    expect(await deviceTwo.getBalance()).toBe(remaining);
  }, 60_000);

  it("recorded bytes another party mined before the wallet's own broadcast settle the send; nothing is paid twice", async () => {
    const alice = await fresh();
    const bob = await fresh();
    await node.fund((await alice.wallet.getReceiveAddress()).raw, 4n * XPI);
    const recipient = await bob.wallet.getReceiveAddress();
    let exposed: string | undefined;
    const sent = await alice.wallet.sendNative({
      recipient,
      value: XPI,
      // Another tab (or a relay) holding the recorded bytes broadcasts them and a block mines
      // them before this wallet's broadcast: the node then refuses that broadcast.
      onSigned: async (signed) => {
        exposed = signed.rawTransactions![0]!;
        await node.rpc("sendrawtransaction", [exposed]);
        await node.mine(1);
      },
    });
    expect(exposed).toBeDefined();
    expect(await indexer.transactionState(sent.txHash)).toBe("confirmed");
    // What the wallet's own broadcast met: a refusal, not an acceptance.
    await expect(indexer.broadcast(exposed!)).rejects.toBeInstanceOf(LotusV2BroadcastRefused);
    // Settled as mined: the claim is not released, so its coin is never offered again.
    expect(alice.wallet.pendingSends()).toEqual([]);
    const fee = BigInt(keyhashPaymentSize(1, 2));
    expect(await alice.wallet.getBalance()).toBe(4n * XPI - XPI - fee);
    // The remaining coin pays a second send; nothing spends the first coin again.
    await alice.wallet.sendNative({ recipient, value: XPI });
    await node.mine(1);
    expect(await bob.wallet.getBalance()).toBe(2n * XPI);
    expect(await alice.wallet.getBalance()).toBe(4n * XPI - 2n * XPI - 2n * fee);
  }, 90_000);

  it("a coinbase the wallet mined is neither balance nor spendable until the next block is 100 above it", async () => {
    const miner = await fresh();
    await node.mine(1, (await miner.wallet.getReceiveAddress()).raw);
    expect(await miner.wallet.getBalance()).toBe(0n);
    const recipient = await (await fresh()).wallet.getReceiveAddress();
    await expect(miner.wallet.sendNative({ recipient, value: XPI })).rejects.toThrow(/Insufficient funds/);
    await node.mine(98);
    expect(await miner.wallet.getBalance()).toBe(0n);
    await node.mine(1);
    const matured = await miner.wallet.getBalance();
    expect(matured).toBeGreaterThan(XPI);
    // Once mature the node accepts the spend.
    await miner.wallet.sendNative({ recipient, value: XPI });
    await node.mine(1);
    expect(await miner.wallet.getBalance()).toBe(matured - XPI - BigInt(keyhashPaymentSize(1, 2)));
  }, 120_000);

  it("gathers several coins into one send, and refuses a send whose fee is above the reviewed maximum", async () => {
    const alice = await fresh();
    const bob = await fresh();
    for (let i = 0; i < 3; i++) await node.fund((await alice.wallet.getReceiveAddress()).raw, XPI);
    const recipient = await bob.wallet.getReceiveAddress();
    const quote = await createLotusV2Chain({
      chainIdentifier: "lotus-v2-regtest",
      indexer,
      checkpoint: node.checkpoint,
      storeFor: () => memoryLotusV2WalletStore(),
    }).nativeTransfers.estimateLegacyFee!({ wallet: alice.wallet, recipient, value: (5n * XPI) / 2n });
    const fee = BigInt(keyhashPaymentSize(3, 2));
    expect(quote).toEqual({ totalFee: fee, inputCount: 3, deliveryFee: fee });
    await expect(
      alice.wallet.sendNative({ recipient, value: (5n * XPI) / 2n, maxFee: fee - 1n })
    ).rejects.toThrow(NativeFeeExceededError);
    expect(alice.wallet.pendingSends()).toEqual([]);
    const sent = await alice.wallet.sendNative({ recipient, value: (5n * XPI) / 2n, maxFee: fee });
    expect(alice.wallet.pendingSends()[0]!.inputs).toHaveLength(3);
    await node.mine(1);
    expect(await indexer.transactionState(sent.txHash)).toBe("confirmed");
    expect(await bob.wallet.getBalance()).toBe((5n * XPI) / 2n);
    expect(await alice.wallet.getBalance()).toBe(3n * XPI - (5n * XPI) / 2n - fee);
  }, 120_000);

  it("the chain adapter (what openRelayUtxoChain hands the app) reads, sends and reports status", async () => {
    const chain = createLotusV2Chain({
      chainIdentifier: "lotus-v2-regtest",
      indexer,
      checkpoint: node.checkpoint,
      storeFor: () => memoryLotusV2WalletStore(),
    });
    const wallet = await chain.createWallet(Uint8Array.from(randomBytes(32)));
    const bob = await fresh();
    await node.fund((await wallet.getReceiveAddress()).raw, chain.fromDisplayAmount("3"));
    expect(chain.toDisplayAmount(await chain.nativeTransfers.getBalance({ wallet }))).toBe("3");
    const recipient = chain.parseAddress((await bob.wallet.getReceiveAddress()).raw)!;
    const quote = await chain.nativeTransfers.estimateLegacyFee!({ wallet, recipient, value: XPI });
    const sent = await chain.nativeTransfers.send({ wallet, recipient, value: XPI, maxFee: quote.totalFee });
    expect(await chain.nativeTransfers.getTransactionStatus({ wallet, transaction: sent })).toBe("pending");
    await node.mine(1);
    expect(await chain.nativeTransfers.getTransactionStatus({ wallet, transaction: sent })).toBe("confirmed");
    expect(await bob.wallet.getBalance()).toBe(XPI);
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
