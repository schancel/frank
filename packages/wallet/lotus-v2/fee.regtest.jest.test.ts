/**
 * INTEGRATION: the fee `@frank/nakamoto/lotus-v2` computes against a real `lotusd -regtest`.
 * Under the rule the node enforces today (lotusd v0.34.1: fee >= ByteFee(size), and the
 * token burn), a transaction the fee-aware builder signs is accepted, and the same
 * transaction paying one atom less is refused with `bad-txns-fee-floor`. A rule (c)
 * transaction paying exactly the shared Lotus vector's fee is accepted too.
 *
 * `testv2transaction` checks scripts and costs only ("fees, finality and mempool policy are
 * not checked"), so the one-atom-short transaction still evaluates valid there; the fee
 * floor is the mempool's (`testmempoolaccept`, `sendrawtransaction`).
 *
 * Needs a Lotus v2 lotusd (LOTUSD_BIN, see lotusd-regtest.testutil.ts). Without one the suite
 * reports itself as NOT RUN, or fails under FRANK_REQUIRE_NODES=1. Regtest only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { privateKeyFromSecretBytes, signingKey } from "@frank/nakamoto";
import {
  buildLotusV2Transaction,
  LOTUS_V2_REGTEST,
  LOTUS_V2_REGTEST_NODE_FEE_RULE,
  LOTUS_V2_SPEC_FEE_RULE,
  lotusV2KeyhashTemplate,
  type LotusV2Output,
  type LotusV2TemplateSpend,
  signLotusV2Transaction,
} from "@frank/nakamoto/lotus-v2";

import { nodeSuiteReady } from "../node-binaries.testutil";
import { findLotusd, lotusdBinary, startLotusRegtest, type LotusRegtest } from "./lotusd-regtest.testutil";
import { fromHex, lotusV2KeyhashDestination, lotusV2XOnlyKey, rpcTxid, toHex } from "./network";

// The shared Lotus fee vectors, as copied into @frank/nakamoto's fixtures.
const sharedVectors = JSON.parse(
  readFileSync(join(__dirname, "../../nakamoto/test/fixtures/lotus-v2/fee_vectors.json"), "utf8"),
) as {
  vectors: {
    name: string;
    size_bytes: number;
    base_cost_cu: string;
    recommended_fee_atoms: string;
    inputs: {
      ema_block_cost: string;
      cu_index: { subsidy: string; parent_work: string };
      byte_fee_index: { subsidy: string; parent_work: string };
    };
  }[];
};

const lotusd = findLotusd();
const suite = nodeSuiteReady("lotus-v2 fee.regtest", [lotusdBinary(lotusd)]) ? describe : describe.skip;
const chain = LOTUS_V2_REGTEST;
const XPI = 1_000_000n;

const secret = (n: number) => {
  const out = new Uint8Array(32);
  out[31] = n;
  return out;
};
const signer = (n: number) => {
  const key = privateKeyFromSecretBytes(secret(n), true);
  if (!key.ok) throw new Error("key");
  const made = signingKey("schnorr", { key: key.value, aux: new Uint8Array(32) });
  if (!made.ok) throw new Error("signer");
  return made.value;
};
const destination = (n: number) => lotusV2KeyhashDestination("regtest", lotusV2XOnlyKey(secret(n)));
const lockedTo = (n: number, value: bigint): LotusV2Output => ({
  value,
  branches: [fromHex(destination(n).root)],
  paths: [[0]],
});

interface MempoolResult {
  allowed: boolean;
  "reject-reason"?: string;
}

suite("Lotus v2 fees on a real regtest node", () => {
  let node: LotusRegtest;

  /** A coin of `atoms` paid to key `n` and mined. */
  const fundedSpend = async (n: number, atoms: bigint): Promise<LotusV2TemplateSpend> => {
    const txid = await node.fund(destination(n).address, atoms);
    return {
      prevTxid: fromHex(txid),
      prevIndex: 0,
      coin: lockedTo(n, atoms),
      template: lotusV2KeyhashTemplate(lotusV2XOnlyKey(secret(n))),
      signer: signer(n),
    };
  };
  const accept = (raw: Uint8Array) =>
    node.rpc<MempoolResult[]>("testmempoolaccept", [[toHex(raw)]]).then((r) => r[0]!);
  const scriptsValid = (raw: Uint8Array) =>
    node.rpc<{ valid: boolean }>("testv2transaction", [toHex(raw)]).then((r) => r.valid);

  beforeAll(async () => {
    node = await startLotusRegtest(lotusd!);
  }, 180_000);
  afterAll(async () => {
    await node?.stop();
  }, 60_000);

  test("the node's rule: the exact fee is accepted and one atom less is refused", async () => {
    const spend = await fundedSpend(101, 10n * XPI);
    const change = lockedTo(101, 0n);
    const built = buildLotusV2Transaction({
      chain,
      inputs: [spend],
      outputs: [lockedTo(102, 3n * XPI)],
      change: { branches: change.branches, paths: change.paths },
      rule: LOTUS_V2_REGTEST_NODE_FEE_RULE,
      maxFee: 10_000n,
    });
    // The keyhash 1-in/2-out payment is 287 bytes: 287 atoms at 1,000 atoms/kB.
    expect(built.signed.raw.length).toBe(287);
    expect(built.fee).toBe(287n);
    expect(built.breakdown).toMatchObject({ byteFloor: 287n, tokenBurn: 0n, total: 287n });

    // Same shape, change one atom larger: the fee is 286.
    const short = signLotusV2Transaction({
      chain,
      inputs: [spend],
      outputs: [lockedTo(102, 3n * XPI), lockedTo(101, built.change!.value + 1n)],
    });
    expect(short.raw.length).toBe(built.signed.raw.length);
    expect(await scriptsValid(short.raw)).toBe(true);
    expect(await accept(short.raw)).toMatchObject({ allowed: false, "reject-reason": "bad-txns-fee-floor" });
    await expect(node.rpc("sendrawtransaction", [toHex(short.raw)])).rejects.toThrow(/bad-txns-fee-floor/);

    expect(await scriptsValid(built.signed.raw)).toBe(true);
    expect(await accept(built.signed.raw)).toMatchObject({ allowed: true });
    expect(await node.rpc<string>("sendrawtransaction", [toHex(built.signed.raw)])).toBe(
      rpcTxid(toHex(built.signed.txid))
    );
    await node.mine(1);
  }, 120_000);

  test("several inputs, and sub-dust change dropped into the fee, at the node's floor", async () => {
    const spends = [await fundedSpend(103, 2n * XPI), await fundedSpend(104, 1n * XPI)];
    const value = 3n * XPI - 700n;
    const change = lockedTo(103, 0n);
    const built = buildLotusV2Transaction({
      chain,
      inputs: spends,
      outputs: [lockedTo(102, value)],
      change: { branches: change.branches, paths: change.paths },
      rule: LOTUS_V2_REGTEST_NODE_FEE_RULE,
      maxFee: 10_000n,
    });
    // 700 atoms cannot pay a two-output fee and leave 546 of change.
    expect(built.change).toBeUndefined();
    expect(built.fee).toBe(700n);
    expect(built.breakdown.total).toBe(BigInt(built.signed.raw.length));
    expect(await accept(built.signed.raw)).toMatchObject({ allowed: true });
    await node.rpc("sendrawtransaction", [toHex(built.signed.raw)]);
    await node.mine(1);
  }, 120_000);

  test("the exact rule (c) fee of the shared keyhash vector is accepted", async () => {
    // The shared Lotus vector keyhash-payment-1in-2out (nakamoto
    // test/fixtures/lotus-v2/fee_vectors.json, Lotus 3f72f1cca3) prices a 1-in/2-out
    // keyhash payment at I = 1, E = E_min. This transaction has the same shape (keys and
    // amounts differ, never the length), so it pays exactly that fee.
    const vector = sharedVectors.vectors.find((v) => v.name === "keyhash-payment-1in-2out");
    if (vector === undefined) throw new Error("shared vector keyhash-payment-1in-2out is missing");
    const index = (i: { subsidy: string; parent_work: string }) => ({
      subsidy: BigInt(i.subsidy),
      work: BigInt(i.parent_work),
    });
    const spend = await fundedSpend(105, 10n * XPI);
    const change = lockedTo(105, 0n);
    const built = buildLotusV2Transaction({
      chain,
      inputs: [spend],
      outputs: [lockedTo(102, 3n * XPI)],
      change: { branches: change.branches, paths: change.paths },
      rule: LOTUS_V2_SPEC_FEE_RULE,
      state: {
        ema: BigInt(vector.inputs.ema_block_cost),
        byteFeeIndex: index(vector.inputs.byte_fee_index),
        cuIndex: index(vector.inputs.cu_index),
        blockCostCu: BigInt(vector.base_cost_cu),
      },
      maxFee: 100_000n,
    });
    expect(built.signed.raw.length).toBe(vector.size_bytes);
    expect(built.fee).toBe(BigInt(vector.recommended_fee_atoms));
    expect(built.change?.value).toBe(7n * XPI - built.fee);
    expect(await accept(built.signed.raw)).toMatchObject({ allowed: true });
    await node.rpc("sendrawtransaction", [toHex(built.signed.raw)]);
    await node.mine(1);
  }, 120_000);
});
