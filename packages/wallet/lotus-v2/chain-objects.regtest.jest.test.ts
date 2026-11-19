/**
 * INTEGRATION: `@frank/nakamoto/lotus-v2` chain objects against a real `lotusd -regtest`, beyond
 * what the wallet itself builds: wide transactions (several odd layers in the indexed input and
 * output trees), a coin locked to an explicit two-leaf script tree (type-0 address) spent through
 * a membership proof with both partial signing modes, and parsing the node's own transactions,
 * coinbases included.
 *
 * Needs a Lotus v2 lotusd (LOTUSD_BIN, see lotusd-regtest.testutil.ts). Without one the suite
 * reports itself as NOT RUN, or fails under FRANK_REQUIRE_NODES=1. Regtest only.
 */
import { privateKeyFromSecretBytes, signingKey } from "@frank/nakamoto";
import {
  decodeLotusV2Transaction,
  encodeLotusV2Address,
  encodeLotusV2Transaction,
  LOTUS_V2_REGTEST,
  lotusV2BranchLeaf,
  lotusV2BranchNode,
  type LotusV2Output,
  lotusV2PublicKeyTemplate,
  lotusV2TemplatePaymentSize,
  lotusV2TransactionIdentities,
  signLotusV2Transaction,
  type LotusV2SigningMode,
  type LotusV2SignatureTemplate,
} from "@frank/nakamoto/lotus-v2";

import { nodeSuiteReady } from "../node-binaries.testutil";
import { findLotusd, lotusdBinary, startLotusRegtest, type LotusRegtest } from "./lotusd-regtest.testutil";
import { fromHex, lotusV2KeyhashDestination, lotusV2XOnlyKey, rpcTxid, toHex } from "./network";

const lotusd = findLotusd();
const suite = nodeSuiteReady("lotus-v2 chain-objects.regtest", [lotusdBinary(lotusd)]) ? describe : describe.skip;
const chain = LOTUS_V2_REGTEST;
const XPI = 1_000_000n;

const secret = (n: number) => {
  const out = new Uint8Array(32);
  out[30] = (n >> 8) & 255;
  out[31] = n & 255;
  return out;
};
const signer = (n: number) => {
  const key = privateKeyFromSecretBytes(secret(n), true);
  if (!key.ok) throw new Error("key");
  const made = signingKey("schnorr", { key: key.value, aux: secret(n + 1) });
  if (!made.ok) throw new Error("signer");
  return made.value;
};
const oneBranch = (value: bigint, root: Uint8Array): LotusV2Output => ({ value, branches: [root], paths: [[0]] });

interface Utxo {
  readonly txid: string;
  readonly out_idx: number;
  readonly value: string;
}

suite("Lotus v2 nakamoto chain objects on a real regtest node", () => {
  let node: LotusRegtest;

  const utxosOf = async (root: string): Promise<Utxo[]> => {
    const response = await fetch(`${node.chronikUrl}/v2/branches/utxos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ any_branch: [root], page_size: 100 }),
    });
    const page = (await response.json()) as { outputs?: { record: Utxo }[] };
    if (!page.outputs) throw new Error(`Chronik refused the query: ${JSON.stringify(page)}`);
    return page.outputs.map((o) => o.record);
  };

  /** Broadcast, check the node names the TxID nakamoto computed, and mine it. */
  const broadcast = async (raw: Uint8Array, txid: Uint8Array) => {
    expect(await node.rpc<string>("testmempoolaccept", [[toHex(raw)]])).toMatchObject([{ allowed: true }]);
    expect(await node.rpc<string>("sendrawtransaction", [toHex(raw)])).toBe(rpcTxid(toHex(txid)));
    await node.mine(1);
  };

  beforeAll(async () => {
    node = await startLotusRegtest(lotusd!);
  }, 120_000);
  afterAll(async () => {
    await node?.stop();
  }, 60_000);

  it("a 5-input, 37-output payment: the node accepts nakamoto's indexed trees with odd layers", async () => {
    const owner = lotusV2KeyhashDestination("regtest", lotusV2XOnlyKey(secret(11)));
    for (let i = 0; i < 5; i++) await node.fund(owner.address, 2n * XPI);
    const coins = await utxosOf(owner.root);
    expect(coins).toHaveLength(5);
    const payees = Array.from({ length: 37 }, (_, i) =>
      lotusV2KeyhashDestination("regtest", lotusV2XOnlyKey(secret(100 + i)))
    );
    const total = coins.reduce((sum, c) => sum + BigInt(c.value), 0n);
    const fee = BigInt(lotusV2TemplatePaymentSize(owner.template, 5, 37));
    const each = (total - fee) / 37n;
    const outputs = payees.map((p, i) =>
      oneBranch(i === 36 ? total - fee - each * 36n : each, fromHex(p.root, 32))
    );
    const signed = signLotusV2Transaction({
      chain,
      inputs: coins.map((c) => ({
        prevTxid: fromHex(c.txid, 32),
        prevIndex: c.out_idx,
        coin: oneBranch(BigInt(c.value), fromHex(owner.root, 32)),
        template: owner.template,
        signer: signer(11),
      })),
      outputs,
    });
    expect(signed.raw.length).toBe(Number(fee));
    await broadcast(signed.raw, signed.txid);
    for (const [i, payee] of payees.entries()) {
      const found = await utxosOf(payee.root);
      expect(found).toEqual([expect.objectContaining({ txid: toHex(signed.txid), out_idx: i })]);
      expect(BigInt(found[0]!.value)).toBe(outputs[i]!.value);
    }
  }, 180_000);

  it("a type-0 address over a two-leaf script tree spends through a membership proof in modes 01 and 02", async () => {
    const left = lotusV2PublicKeyTemplate(lotusV2XOnlyKey(secret(21)));
    const right = lotusV2PublicKeyTemplate(lotusV2XOnlyKey(secret(22)));
    const leftLeaf = lotusV2BranchLeaf(chain, left.script);
    const rightLeaf = lotusV2BranchLeaf(chain, right.script);
    const root = lotusV2BranchNode(chain, leftLeaf, rightLeaf);
    const address = encodeLotusV2Address(chain, 0, root);
    expect(address).toMatch(/^rxpi1q/);
    await node.fund(address, 3n * XPI);
    await node.fund(address, 4n * XPI);
    const coins = (await utxosOf(toHex(root))).sort((a, b) => Number(BigInt(a.value) - BigInt(b.value)));
    expect(coins.map((c) => BigInt(c.value))).toEqual([3n * XPI, 4n * XPI]);
    const payee = lotusV2KeyhashDestination("regtest", lotusV2XOnlyKey(secret(23)));
    const spends: [Utxo, LotusV2SignatureTemplate, Uint8Array, number, LotusV2SigningMode][] = [
      [coins[0]!, left, rightLeaf, 21, 1],
      [coins[1]!, right, leftLeaf, 22, 2],
    ];
    const fee = 1_000n;
    const signed = signLotusV2Transaction({
      chain,
      inputs: spends.map(([coin, template, sibling, key, mode]) => ({
        prevTxid: fromHex(coin.txid, 32),
        prevIndex: coin.out_idx,
        coin: oneBranch(BigInt(coin.value), root),
        template,
        siblings: [sibling],
        signer: signer(key),
        mode,
      })),
      // Mode 02 pairs input 1 with output 1.
      outputs: [oneBranch(3n * XPI - fee, fromHex(payee.root, 32)), oneBranch(4n * XPI, fromHex(payee.root, 32))],
    });
    expect(signed.raw.length).toBeLessThan(Number(fee));
    await broadcast(signed.raw, signed.txid);
    expect((await utxosOf(payee.root)).map((c) => c.txid)).toEqual([toHex(signed.txid), toHex(signed.txid)]);
    expect(await utxosOf(toHex(root))).toEqual([]);
  }, 120_000);

  it("parses the node's own transactions, coinbases included, to the TxIDs the node reports", async () => {
    const owner = lotusV2KeyhashDestination("regtest", lotusV2XOnlyKey(secret(31)));
    const funding = await node.fund(owner.address, XPI);
    const tip = await node.rpc<string>("getbestblockhash");
    const block = await node.rpc<{ tx: (string | { txid: string })[] }>("getblock", [tip, 1]);
    const ids = block.tx.map((t) => (typeof t === "string" ? t : t.txid));
    expect(ids.length).toBeGreaterThanOrEqual(2);
    for (const id of ids) {
      const raw = fromHex(await node.rpc<string>("getrawtransaction", [id, false]));
      const tx = decodeLotusV2Transaction(chain, raw);
      expect(encodeLotusV2Transaction(chain, tx)).toEqual(raw);
      expect(rpcTxid(toHex(lotusV2TransactionIdentities(chain, tx).txid))).toBe(id);
    }
    const coinbase = decodeLotusV2Transaction(
      chain,
      fromHex(await node.rpc<string>("getrawtransaction", [ids[0], false]))
    );
    expect(coinbase.inputs[0]!.kind).toBe("coinbase");
    expect(ids).toContain(rpcTxid(funding));
  }, 60_000);
});
