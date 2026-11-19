/**
 * Two devices of one eCash account on a real Bitcoin ABC regtest node with Chronik (issue 2084).
 * No fake chain. Each device is its own `EcashWallet` with its own operation store; the only
 * thing they share is the seed (here the eCash domain root) and the chain.
 *
 *   yarn --cwd packages/bot regtest:ecash-shared-seed
 *
 * Needs a Chronik-enabled `bitcoind` (FRANK_BITCOIN_ABC_BIN_DIR, or `yarn --cwd packages/bot
 * regtest:fetch`). The Jest wrapper `ecash-shared-seed.regtest.jest.test.ts` runs this file.
 *
 * Checks, in order:
 *   1. Devices 1 and 2 open from the same seed before any coin exists. Device 1 is funded and
 *      pays three times; each payment spends the previous change, so the account's only coin
 *      ends on change address 1/2, which device 2 never allocated.
 *   2. Device 2, still open, sees the full balance and spends that change; its own change goes
 *      to an address neither device used before.
 *   3. Device 1, still open, sees device 2's change and the same balance.
 *   4. Device 1 restarted with a wiped operation store sees the same balance and spends it.
 */
import assert from "assert/strict";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { ChronikClient } from "chronik-client";
import { Address } from "ecash-lib/dist/address/address";
import { InMemoryNativeTransactionAttemptStore } from "@frank/wallet/chain/chain-wallet";
import { InMemoryEcashOperationStore } from "@frank/wallet/ecash-operation-store";
import { EcashWallet } from "@frank/wallet/ecash-wallet";

import {
  ECASH_REGTEST_CHAIN,
  startEcashRegtest,
  type EcashRegtest,
} from "./ecash-regtest";
import { sleep } from "./regtest-chain";

const CHAIN = ECASH_REGTEST_CHAIN;
const FUNDING = 1_000_000n;

interface VerboseTx {
  txid: string;
  vout: Array<{ n: number; value: number; scriptPubKey: { hex: string } }>;
}

export async function ecashSharedSeedCheck(
  xec: EcashRegtest
): Promise<string[]> {
  const steps: string[] = [];
  const step = (line: string) => {
    steps.push(line);
    console.log(`ok - ${line}`);
  };
  const chronik = new ChronikClient([xec.chronikUrl]);
  /** One device: its own attempt and operation stores, nothing shared but the seed. */
  const open = (root: Uint8Array) =>
    EcashWallet.fromDomainRoot({
      domainRoot: {
        registry: "frank-domain-roots-v1",
        purpose: "ecash-bch-wallet",
        bytes: Uint8Array.from(root),
      },
      networkId: CHAIN,
      checkpoint: xec.checkpoint,
      chronik,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
      operationStore: new InMemoryEcashOperationStore(),
      rebroadcast: async (raws) => {
        for (const raw of raws) await chronik.broadcastTx(raw);
      },
    });
  const waitFor = async <T>(
    label: string,
    read: () => Promise<T | undefined>
  ): Promise<T> => {
    let last: unknown;
    for (let i = 0; i < 100; i++) {
      const value = await read().catch((error) => {
        last = error;
        return undefined;
      });
      if (value !== undefined) return value;
      await sleep(100);
    }
    throw new Error(
      `timed out waiting for ${label}${last ? `: ${String(last)}` : ""}`
    );
  };
  const balanceOf = (wallet: EcashWallet, expected: bigint, label: string) =>
    waitFor(label, async () => {
      const balance = await wallet.getBalance();
      return balance === expected ? balance : undefined;
    }).catch(async (error) => {
      throw new Error(
        `${
          error.message
        } (expected ${expected}, saw ${await wallet.getBalance()})`
      );
    });
  const minedTx = async (txid: string): Promise<VerboseTx> => {
    const block = await xec.rpc<{ tx: VerboseTx[] }>("getblock", [
      await xec.rpc<string>("getbestblockhash"),
      2,
    ]);
    const tx = block.tx.find((item) => item.txid === txid);
    assert.ok(tx, `${txid} is mined in the tip block`);
    return tx;
  };

  const root = new Uint8Array(randomBytes(32));
  const device1 = await open(root);
  const device2 = await open(root);
  const payee = (
    await (await open(new Uint8Array(randomBytes(32)))).getReceiveAddress()
  ).raw;
  const payeeScript = Address.fromCashAddress(payee).toScript().toHex();

  let expected = FUNDING;
  /** Change scripts of every payment so far: no device may reuse one. */
  const changeScripts = new Set<string>();
  const pay = async (wallet: EcashWallet, value: bigint, label: string) => {
    const operationId = `shared-seed:${randomBytes(16).toString("hex")}`;
    const operation = await wallet.prepareNativeOperation({
      operationId,
      recipient: { raw: payee },
      value,
    });
    const sent = await wallet.submitNativeOperation(operationId);
    await xec.mine(1);
    const tx = await minedTx(sent.txHash);
    const change = tx.vout.filter(
      (output) => output.scriptPubKey.hex !== payeeScript
    );
    assert.equal(change.length, 1, `${label}: one change output`);
    assert.ok(
      !changeScripts.has(change[0].scriptPubKey.hex),
      `${label}: change goes to a fresh address`
    );
    changeScripts.add(change[0].scriptPubKey.hex);
    expected -= value + BigInt(operation.fee);
    return { operation, txid: sent.txHash };
  };

  // 1. Device 1 is funded and pays three times, each spending the previous change.
  await xec.fund((await device1.getReceiveAddress()).raw, FUNDING);
  await balanceOf(device1, FUNDING, "device 1 funding");
  for (const value of [100_000n, 100_000n, 100_000n]) {
    const { operation } = await pay(device1, value, "device 1 payment");
    assert.equal(
      operation.inputs.length,
      1,
      "each payment spends the single coin the account holds"
    );
    await balanceOf(device1, expected, "device 1 balance after its payment");
  }
  step(
    `device 1 paid three times; the account's ${expected} sats sit on its third change address`
  );

  // 2. Device 2 opened before any of that and never allocated those change addresses.
  await balanceOf(device2, expected, "device 2 balance from the same seed");
  step(
    `device 2 of the same seed (separate operation store) sees the full ${expected} sats`
  );
  const large = expected / 2n + 1n;
  const { operation: spent } = await pay(device2, large, "device 2 payment");
  assert.equal(spent.inputs.length, 1);
  step(
    `device 2 spent device 1's change: ${large} sats to the payee, its change on a fresh address`
  );

  // 3. Device 1, still running, sees device 2's change.
  await balanceOf(device1, expected, "device 1 sees device 2 change");
  await balanceOf(device2, expected, "device 2 after its payment");
  step(`device 1 sees device 2's change: both report ${expected} sats`);

  // 4. Device 1 restarts with a wiped operation store.
  const restarted = await open(root);
  await balanceOf(restarted, expected, "restarted device 1 balance");
  await pay(restarted, 50_000n, "restarted device 1 payment");
  await balanceOf(restarted, expected, "restarted device 1 after its payment");
  await balanceOf(
    device2,
    expected,
    "device 2 sees the restarted device change"
  );
  step(
    `device 1 restarted with a wiped operation store sees ${expected} sats and spends from them`
  );
  return steps;
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), "frank-ecash-shared-seed-"));
  // Blocks only when the check mines.
  const xec = await startEcashRegtest({
    stateDir,
    blockIntervalMs: 24 * 3600_000,
  });
  try {
    const steps = await ecashSharedSeedCheck(xec);
    console.log(`eCash shared-seed regtest: OK (${steps.length} checks)`);
  } finally {
    await xec.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
