/**
 * Runs the bots' payment check (`src/bots/money.ts` `confirmReceived`) against a real chain,
 * read-only: no key, no funds, nothing sent.
 *
 *   MONAD_TESTNET_HTTP_RPC_URL=... yarn tsx money-receipt.livecheck.ts
 *
 * It takes a real, mined, successful value transfer from a recent block and checks that the bots
 * count it at its value, count nothing for the same transfer described with another value or
 * destination, count it for one message only, and report a transfer the chain has never seen as
 * unconfirmed. Exits non-zero if any of that does not hold.
 */
import { JsonRpcProvider } from "ethers";
import type { BotContext } from "@frank/bot-framework";
import { confirmReceived } from "./src/bots/money";

async function main() {
  const url = process.env.MONAD_TESTNET_HTTP_RPC_URL ?? process.env.MONAD_RPC_URL;
  if (!url) throw new Error("Set MONAD_TESTNET_HTTP_RPC_URL");
  const provider = new JsonRpcProvider(url);
  const { chainId } = await provider.getNetwork();
  const head = await provider.getBlockNumber();
  let found: { hash: string; to: string; value: bigint } | undefined;
  for (let number = head - 2; number > head - 400 && !found; number--) {
    const block = await provider.getBlock(number, true);
    for (const tx of block?.prefetchedTransactions ?? []) {
      if (!tx.to || tx.value <= 0n || tx.data !== "0x") continue;
      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (receipt?.status !== 1) continue;
      found = { hash: tx.hash, to: tx.to, value: tx.value };
      break;
    }
  }
  if (!found) throw new Error("No plain value transfer in the last 400 blocks");

  const data = new Map<string, string>();
  const ctx = {
    provider,
    state: {
      get: async (key: string) => data.get(key),
      put: async (key: string, value: string) => void data.set(key, value),
    },
  } as unknown as BotContext;
  const message = (digest: string, to: string, valueWei: bigint, txHash = found!.hash) => ({
    payloadDigest: digest,
    stampPayments: [{ txHash, destinationAddress: to, valueWei }],
  });
  const check = (name: string, ok: boolean) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
    if (!ok) process.exitCode = 1;
  };

  console.log(
    `chain ${chainId}, block ${head}: transfer ${found.hash} of ${found.value} wei to ${found.to}`
  );
  const wrongValue = await confirmReceived(message("a1", found.to, found.value + 1n), ctx, 0);
  check("the same transfer described with another value counts for nothing", wrongValue.confirmedWei === 0n && wrongValue.unconfirmed.length === 0);
  data.clear();
  const wrongTo = await confirmReceived(
    message("a2", "0x000000000000000000000000000000000000dEaD", found.value),
    ctx,
    0
  );
  check("the same transfer described with another destination counts for nothing", wrongTo.confirmedWei === 0n);
  data.clear();
  const real = await confirmReceived(message("a3", found.to, found.value), ctx, 0);
  check("a mined, successful transfer counts at its value", real.confirmedWei === found.value);
  const replay = await confirmReceived(message("a4", found.to, found.value), ctx, 0);
  check("a second message naming it gets nothing", replay.confirmedWei === 0n);
  const unseen = await confirmReceived(
    message("a5", found.to, found.value, "0x" + "ab".repeat(32)),
    ctx,
    2000
  );
  check(
    "a transfer the chain has never seen is not received, and is reported unconfirmed",
    unseen.confirmedWei === 0n && unseen.unconfirmed.length === 1
  );
}

main().catch((error) => {
  console.error("money receipt check failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
