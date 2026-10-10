/**
 * The parallel-send rewrite against the real relay binary and Monad testnet. Real wallets, real
 * transfers; nothing is simulated except where a phase says what it stands between (one HTTP
 * answer dropped, one request's boundary broken, one process killed). Not part of CI: it spends
 * testnet funds and takes minutes.
 *
 *   CASHWEBD_BIN=<relay built from the tree under test> FRANK_TEST_WALLET_JSON=<funded test wallet> \
 *   FRANK_DEMO_ENV_FILE=<repo .env> yarn tsx parallel-send.livecheck.ts
 *
 *   PHASES=e,d,b,a,f   which phases, in this order (also: unfreeze, inspect, review)
 *   MESSAGES=10        how many messages phase a sends together
 *   FUNDED=3           how many accounts phase b funds ahead
 *   SENDER=bob         swap the two wallets' roles
 *   BUDGET_WEI=...     the most this run may cost the test wallet; a phase that could pass it is
 *                      skipped and reported as skipped (default 0.1 MON)
 *   REVIEW_SINCE_MS    for `review`: list what bob received since then, with each payment's
 *                      sender, nonce and block, read from chain
 *
 * Every paid message here carries a stamp of exactly the fee floor (`minimumStamp`), named
 * explicitly: the wallet's configured default stamp on testnet is 0.01 MON, about five times
 * the floor, and is not what is being measured.
 *
 * Configuration is the harness's (`demo/real-stack.ts`). The persistent test wallets `alice` and
 * `bob` under ~/.frank-real-stack are reused; alice is topped up only by what a phase needs, and
 * what is left in her main and identity accounts is swept back at the end. Every figure printed
 * is read from the chain or the relay, never assumed.
 *
 *   a  ten paid messages started together from a wallet whose money is only in its main
 *      account: all delivered, each payment mined once, nonces consecutive, each mined in a
 *      later block than the one before (nothing signed over an unmined payment), wall time
 *   c  (inside a) one native send issued while those are in flight: it waits its turn and lands
 *   b  FUNDED (default 3) single-use accounts funded ahead, then that many messages together:
 *      wall time, each paid from its own account, the main account's nonce unchanged
 *   d  a message the relay refuses outright, then at once a paid send and a native send: the
 *      main account is not held. Two refusals: an address with no directory entry (refused
 *      before anything is claimed), and a signed message whose request the relay rejects
 *   e  the wallet process is killed (SIGKILL) between the relay's `delivered` answer and the
 *      wallet's own broadcast; reopened: the payment is mined once, the message stays delivered
 *   f  an UNPAID named message whose first answer is dropped, sent again: the same bytes, the
 *      relay's answer, and how many copies the recipient sees
 *   g  what a message cost, read from chain: gas used x price, plus the stamp
 *   h  the chain made unreachable (only on a stack that can do that: `chainOutage`): a paid
 *      send queues with the wallet's chain warning set, nothing claimed or sent; a free
 *      message goes meanwhile; the paid one completes when the chain is back
 *   w  money that arrived as payments pays for a send: the recipient of two 0.02 stamps, with
 *      nothing in its main account, sends a message with a 0.03 stamp: two transfers, one from
 *      each received coin
 *   m  a native send that needs more than one account (the main address and a received coin):
 *      every transaction mined, the recipient paid, the fee quoted is the fee paid
 *   n  (local chain only) a payment the node refuses, because its account was paid a moment
 *      ago and the wallet's wait for that is switched off in the check: delivered all the same,
 *      then signed again at its nonce and paid once, within seconds
 *   s  (local chain only) a new wallet holding 0.1 MON at its profile address, where a faucet
 *      pays: MESSAGES paid messages together; wall time, the paying accounts, the blocks
 *   t  (local chain only) the same from a new wallet holding 20 MON in its main account
 *      SPREAD_WAIT_MS gives the wallet's background funding that long before the burst
 *   r  a stamp made to revert on purpose (the CHECK signs it inside the chain's spacing window,
 *      behind a transfer of its own from the same account; the wallet's spacing is bypassed for
 *      that one payment and nowhere else): seen reverted, paid again once, never a third time
 *
 * PSEND_STACK_MODULE names a module exporting `startCheckStack(options)` that returns the
 * harness's `RealStack` for another network (the local Monad chain: see
 * `demo/regtest/monad-parallel-send-stack.ts` once the Monad regtest harness is in the tree).
 * Unset: Monad testnet through `demo/real-stack.ts`. The run ends with one line per phase,
 * OK or FAILED with what failed, and exits 1 if any failed.
 */
import { createHash, randomUUID } from "crypto";
import { spawn } from "child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve as resolvePath } from "path";
import { Transaction, formatEther, hexlify } from "ethers";
import {
  defaultCanonicalFetch,
  restoreCanonicalRequest,
  type CanonicalFetch,
} from "@frank/cashweb/relay/canonical-dm-transport";
import { installCanonicalDirectory } from "@frank/wallet/chain/monad-chain";
import { EvmStampPayer } from "@frank/wallet/evm-stamp-payer";
import {
  startRealStack,
  type RealStack,
  type RealWallet,
} from "./demo/real-stack";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const say = (...parts: unknown[]) => console.log("[parallel-send]", ...parts);
const mon = (wei: bigint) => `${formatEther(wei)} MON`;
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex").slice(0, 16);

/** What one message request to the relay carried, as the wallet handed it over. */
interface Submitted {
  digest: string;
  rawTransactions: string[];
  deliveryHash: string;
  bodyHash: string;
  status?: number;
  answer?: string;
}

/** Stands between a wallet and its relay for message requests only: records each one, and lets
 * a phase act on the next one. Everything else goes straight through. */
function intercept(wallet: RealWallet) {
  const submitted: Submitted[] = [];
  let next:
    | ((
        send: () => ReturnType<CanonicalFetch>,
        init: Parameters<CanonicalFetch>[1],
        url: string
      ) => ReturnType<CanonicalFetch>)
    | undefined;
  let nextPaidOnly = false;
  const base = wallet.directory;
  const fetch: CanonicalFetch = async (url, init) => {
    let record: Submitted | undefined;
    if (init.method !== "GET" && init.body)
      try {
        const request = restoreCanonicalRequest({
          body: new Uint8Array(init.body),
          contentType: init.headers["Content-Type"],
        });
        record = {
          digest: request.identity.payload_hash,
          rawTransactions: request.parts.transactions.map((raw) =>
            hexlify(raw)
          ),
          deliveryHash: sha(request.parts.delivery),
          bodyHash: sha(request.body),
        };
        submitted.push(record);
      } catch {
        // Not a message request.
      }
    const real = async () => {
      const response = await (base.fetch ?? defaultCanonicalFetch)(url, init);
      if (record) record.status = response.status;
      return response;
    };
    // The wallet also writes free notes to itself in the background (a received coin, a native
    // send): a phase that waits for its own PAID message must not be handed one of those.
    if (record && next && (!nextPaidOnly || record.rawTransactions.length > 0)) {
      const act = next;
      next = undefined;
      return act(real, init, url);
    }
    return real();
  };
  installCanonicalDirectory(wallet.handle, {
    network: base.network,
    homeEndpoint: base.homeEndpoint,
    ...(base.isHomeRelay
      ? { isHomeRelay: (endpoint: string) => base.isHomeRelay!(endpoint) }
      : {}),
    selfCurrent: () => base.selfCurrent(),
    peerCurrent: (peer) => base.peerCurrent(peer),
    ...(base.peerHistorical
      ? { peerHistorical: (peer) => base.peerHistorical!(peer) }
      : {}),
    ...(base.forwarding ? { forwarding: () => base.forwarding!() } : {}),
    fetch,
  });
  return {
    submitted,
    /** The next message request is handed to `act` instead of sent as it is. */
    onNext(act: NonNullable<typeof next>, paidOnly = false) {
      next = act;
      nextPaidOnly = paidOnly;
    },
    of: (digest: string) => submitted.filter((s) => s.digest === digest),
  };
}

interface Sent {
  digest: string;
  ms: number;
  /** The call resolved (delivered at once), or was pending and reconciled to delivered. */
  how: "resolved" | "reconciled";
}

/** One paid message whose stamp is exactly the chain's fee floor right now. */
async function sendPaid(
  wallet: RealWallet,
  to: string,
  text: string,
  onStage?: (stage: string) => void
): Promise<Sent> {
  const started = Date.now();
  let digest: string | undefined;
  const messageId = randomUUID();
  let stampValue = await wallet.chain.directMessages.minimumStamp!({
    wallet: wallet.handle,
  });
  for (let attempt = 0; ; attempt++)
    try {
      const sent = await wallet.chain.directMessages.send({
        wallet: wallet.handle,
        recipient: { raw: to },
        items: [{ type: "text", text }],
        messageId,
        stampValue,
        onAttemptCreated: (created) => void (digest = created),
        onPreparationProgress: (progress) => onStage?.(progress.stage),
      });
      return {
        digest: sent.payloadDigest,
        ms: Date.now() - started,
        how: "resolved",
      };
    } catch (error) {
      // The floor moved between the reading and the send: nothing was paid; once more at it.
      if (
        digest === undefined &&
        attempt === 0 &&
        (error as Error).name === "DirectMessageStampBelowFeeError"
      ) {
        stampValue = (error as unknown as { floorWei: bigint }).floorWei;
        continue;
      }
      if (digest === undefined) throw error;
      break;
    }
  for (const deadline = Date.now() + 180_000; ; ) {
    const status = (
      await wallet.chain.directMessages.reconcileAttempts({
        wallet: wallet.handle,
        payloadDigests: [digest],
        maxPutAttempts: 2,
      })
    )[digest];
    if (status === "delivered")
      return { digest, ms: Date.now() - started, how: "reconciled" };
    if (status === "dead") throw new Error(`the relay ended ${digest}`);
    if (Date.now() > deadline)
      throw new Error(`${digest} not delivered in time (${status})`);
    await sleep(1500);
  }
}

/** Ticks the wallet until the chain has answered for every payment of these messages. */
async function settle(wallet: RealWallet, digests: string[]) {
  for (const deadline = Date.now() + 180_000; ; ) {
    const statuses = await wallet.chain.directMessages.reconcileAttempts({
      wallet: wallet.handle,
      payloadDigests: digests,
      maxPutAttempts: 2,
    });
    const payments = digests.map(
      (digest) =>
        wallet.chain.directMessages.paymentsOf?.({
          wallet: wallet.handle,
          payloadDigest: digest,
        }) ?? []
    );
    if (payments.every((states) => states.every((s) => s !== "pending")))
      return { statuses, payments };
    if (Date.now() > deadline)
      throw new Error(
        `payments still pending: ${JSON.stringify(payments)} ${JSON.stringify(
          statuses
        )}`
      );
    await sleep(1000);
  }
}

/** What the chain says about one signed transaction. */
async function onChain(stack: RealStack, rawTx: string) {
  const tx = Transaction.from(rawTx);
  let receipt = await stack.provider.getTransactionReceipt(tx.hash!);
  for (let i = 0; !receipt && i < 30; i++) {
    await sleep(1000);
    receipt = await stack.provider.getTransactionReceipt(tx.hash!);
  }
  return {
    hash: tx.hash!,
    from: tx.from!.toLowerCase(),
    nonce: tx.nonce,
    valueWei: tx.value,
    mined: receipt !== null,
    status: receipt?.status,
    block: receipt?.blockNumber,
    gasUsed: receipt?.gasUsed,
    gasPrice: receipt?.gasPrice,
    feeWei: receipt ? receipt.gasUsed * receipt.gasPrice : undefined,
  };
}

/** How many times each digest is in the recipient's mailbox. */
async function seenBy(bob: RealWallet, digests: string[], sinceMs: number) {
  for (const deadline = Date.now() + 60_000; ; ) {
    const inbound = (
      await bob.chain.directMessages.fetchSince({
        wallet: bob.handle,
        sinceMs,
      })
    ).filter((message) => !message.outbound);
    const counts = digests.map(
      (digest) => inbound.filter((m) => m.payloadDigest === digest).length
    );
    if (counts.every((count) => count >= 1) || Date.now() > deadline)
      return counts;
    await sleep(2000);
  }
}

/** A native send that reports a failure instead of throwing: what the wallet said and why
 * (the node's own words when it gave any), and what the chain shows of the transaction. */
async function sendNativeReported(
  stack: RealStack,
  wallet: RealWallet,
  to: string,
  valueWei: bigint
) {
  const started = Date.now();
  let txHash: string | undefined;
  let error: string | undefined;
  try {
    txHash = (
      await wallet.handle.sendNative({ recipient: { raw: to }, value: valueWei })
    ).txHash;
  } catch (caught) {
    const failure = caught as Error & {
      reason?: unknown;
      transaction?: { txHash?: string };
    };
    const reason = failure.reason as
      | (Error & { info?: unknown; shortMessage?: string })
      | undefined;
    error = `${failure.name}: ${failure.message}; reason: ${
      reason?.shortMessage ?? reason?.message ?? String(reason)
    } ${JSON.stringify(reason?.info ?? "").slice(0, 400)}`;
    txHash = failure.transaction?.txHash || undefined;
  }
  const returnedMs = Date.now() - started;
  let receipt = txHash
    ? await stack.provider.getTransactionReceipt(txHash)
    : null;
  for (let i = 0; txHash && !receipt && i < 20; i++) {
    await sleep(1000);
    receipt = await stack.provider.getTransactionReceipt(txHash);
  }
  const tx = txHash ? await stack.provider.getTransaction(txHash) : null;
  return {
    returnedMs,
    txHash,
    error,
    knownToTheNode: tx !== null,
    nonce: tx?.nonce,
    status: receipt?.status,
    block: receipt?.blockNumber,
    feeWei: receipt ? (receipt.gasUsed * receipt.gasPrice).toString() : undefined,
  };
}

/** A stack this check can run on: the harness's, and optionally a way to cut the chain off. */
export type CheckStack = RealStack & {
  /** Makes the chain's node unreachable for the relay and the wallets, and reachable again. */
  chainOutage?: { down(): Promise<void>; up(): Promise<void> };
};
export type StartCheckStack = (options?: {
  relayUrl?: string;
}) => Promise<CheckStack>;

/** The stack named by PSEND_STACK_MODULE, or Monad testnet through the real-stack harness. */
async function startStack(options?: { relayUrl?: string }): Promise<CheckStack> {
  const named = process.env.PSEND_STACK_MODULE;
  if (!named) return startRealStack(options);
  const loaded = (await import(resolvePath(named))) as {
    startCheckStack: StartCheckStack;
  };
  return loaded.startCheckStack(options);
}

const mainNonce = (stack: RealStack, wallet: RealWallet) =>
  stack.provider.getTransactionCount(wallet.mainAccount, "latest");
const heldBy = (wallet: RealWallet, address: string) =>
  wallet.handle.pool.accountClaimedBy(address) ?? "nobody";

/** Makes sure alice's main account holds at least `wei`, from the test wallet. */
async function ensureMain(stack: RealStack, alice: RealWallet, wei: bigint) {
  const has = await stack.provider.getBalance(alice.mainAccount);
  if (has >= wei) return;
  if (!stack.fundingAddress)
    throw new Error(
      `the sender's main account holds ${mon(has)} and this phase needs ${mon(
        wei
      )}; FRANK_TEST_WALLET_JSON is not set, so it cannot be topped up`
    );
  const tx = await stack.fund(alice.mainAccount, wei - has);
  say(`funded alice's main account with ${mon(wei - has)} (${tx})`);
}

async function main() {
  const phases = (process.env.PHASES ?? "e,d,b,a,f").split(",");
  const funded = Number(process.env.FUNDED ?? "3");
  const messages = Number(process.env.MESSAGES ?? "10");
  const budget = BigInt(process.env.BUDGET_WEI ?? "100000000000000000");
  const stack = await startStack();
  // The relay this run started writes its log under the stack's state: what it logs from here
  // on is read at the end.
  const relayLogPath = join(stack.stateDir, "logs", "relay.log");
  const relayLogStart = existsSync(relayLogPath) ? statSync(relayLogPath).size : 0;
  const relayLog = existsSync(relayLogPath)
    ? () =>
        readFileSync(relayLogPath)
          .subarray(relayLogStart)
          .toString("utf8")
          .split("\n")
    : undefined;
  const results: Record<string, unknown> = {};
  /** What each phase was required to show, and whether it did. */
  const verdicts: Record<string, string[]> = {};
  const require_ = (phase: string, what: string, held: boolean) => {
    (verdicts[phase] ??= []).push(...(held ? [] : [what]));
  };
  const provider = stack.provider;
  const fundingBefore = stack.fundingAddress
    ? await provider.getBalance(stack.fundingAddress)
    : 0n;
  // SENDER names the persistent wallet that sends (and is called alice below); the other one
  // of the pair receives.
  const senderLabel = process.env.SENDER === "bob" ? "bob" : "alice";
  // The sender's configured default stamp is the fee floor too, so that funding ahead (which
  // funds for the default stamp) is funding for the messages sent here.
  const floorNow = 21_000n * BigInt(await provider.send("eth_gasPrice", []));
  let alice = await stack.openWallet(senderLabel, { stampValueWei: floorNow });
  const bob = await stack.openWallet(senderLabel === "bob" ? "alice" : "bob");
  let tap = intercept(alice);
  const startedAt = Date.now() - 60_000;
  try {
    const floor = await alice.chain.directMessages.minimumStamp!({
      wallet: alice.handle,
    });
    const gasPrice = BigInt(await provider.send("eth_gasPrice", []));
    const fee = await provider.getFeeData();
    // What one main-paid message needs in the account: the stamp, and the fee at its cap.
    const perMessage = floor + 21_000n * (fee.maxFeePerGas ?? gasPrice);
    // What one plain transfer is charged at the node's price now.
    const txFee = 21_000n * gasPrice;
    const rows = alice.handle.pool.records();
    say("relay", stack.relayUrl, "state", stack.stateDir);
    say(
      `gas price ${gasPrice} wei; fee floor for a stamp ${mon(floor)}; alice main ${
        alice.mainAccount
      } holds ${mon(
        await provider.getBalance(alice.mainAccount)
      )}, identity ${alice.address} holds ${mon(
        await provider.getBalance(alice.address)
      )}; pool rows: ${JSON.stringify(
        rows.reduce<Record<string, number>>(
          (count, row) => ({
            ...count,
            [row.status]: (count[row.status] ?? 0) + 1,
          }),
          {}
        )
      )}`
    );
    const funds = await alice.handle.pool.fundedCapacities(
      provider,
      21_000n * (fee.maxFeePerGas ?? gasPrice),
      { fromBalance: true }
    );
    say(
      `alice's funded single-use accounts that could pay a stamp now: ${
        funds.filter((account) => account.capacityWei >= floor).length
      } (of ${funds.length} with any capacity)`
    );
    if (phases.includes("inspect")) return;
    /** What this run has cost the test wallet so far, counting what alice's main account
     * holds as coming back (less the fee of sending it back). */
    const spentSoFar = async () => {
      // No test wallet configured: nothing can be funded, so nothing of it is spent. The run
      // uses what the persistent wallets already hold.
      if (!stack.fundingAddress) return 0n;
      const now = await provider.getBalance(stack.fundingAddress);
      const main = await provider.getBalance(alice.mainAccount);
      return fundingBefore - now - (main > txFee ? main - txFee : 0n);
    };
    /** Whether a phase that can cost up to `wei` more (two further fees are kept for funding
     * alice and for the sweep) still fits the budget. Says so when it does not. */
    const affordable = async (phase: string, wei: bigint) => {
      const spent = await spentSoFar();
      if (spent + wei + 2n * txFee <= budget) return true;
      results[phase] = `SKIPPED: it could cost ${mon(wei)} more and ${mon(
        spent
      )} of the ${mon(budget)} budget is spent`;
      say(phase, results[phase]);
      return false;
    };
    if (phases.includes("review")) {
      const inbound = (
        await bob.chain.directMessages.fetchSince({
          wallet: bob.handle,
          sinceMs: Number(process.env.REVIEW_SINCE_MS ?? Date.now() - 3_600_000),
        })
      ).filter((message) => !message.outbound);
      const rows = [];
      for (const message of inbound)
        for (const payment of message.stampPayments ?? []) {
          const tx = await provider.getTransaction(payment.txHash);
          const receipt = await provider.getTransactionReceipt(payment.txHash);
          rows.push(
            `${new Date(message.receivedTime).toISOString()} ${JSON.stringify(
              message.items.map((item) => (item.type === "text" ? item.text : item.type))
            )} digest ${message.payloadDigest.slice(0, 12)} stamp ${mon(
              payment.valueWei
            )} from ${tx?.from} nonce ${tx?.nonce} block ${
              receipt?.blockNumber
            } status ${receipt?.status} fee ${
              receipt ? mon(receipt.gasUsed * receipt.gasPrice) : "?"
            }`
          );
        }
      results.review = {
        aliceMainNonce: await mainNonce(stack, alice),
        bobMainBalance: mon(await provider.getBalance(bob.mainAccount)),
        received: rows,
      };
      say("review", JSON.stringify(results.review, null, 1));
      return;
    }

    // ---- a + c -------------------------------------------------------------------------
    let costOfMainPaid: bigint | undefined;
    const runA = async () => {
      if (!(await affordable("a", BigInt(messages) * (floor + txFee) + txFee)))
        return;
      // The stamps and their fees, the native send's fee, and the headroom the last message
      // must show (its fee at the cap) before it may sign.
      await ensureMain(
        stack,
        alice,
        BigInt(messages) * (floor + txFee) + txFee + perMessage + floor / 2n
      );
      const nonce0 = await mainNonce(stack, alice);
      const stages: string[][] = [];
      const started = Date.now();
      const sends = Array.from({ length: messages }, (_, n) => {
        stages.push([]);
        return sendPaid(alice, bob.address, `a${n} ${started}`, (stage) =>
          stages[n].push(stage)
        );
      });
      // c: a native send issued in the middle.
      await sleep(2500);
      const nativeStarted = Date.now();
      const nonceAtNative = await mainNonce(stack, alice);
      const native = await sendNativeReported(
        stack,
        alice,
        bob.mainAccount,
        1_000_000_000_000n
      );
      const sent = await Promise.all(sends);
      const wallMs = Date.now() - started;
      const settled = await settle(
        alice,
        sent.map((s) => s.digest)
      );
      const payments = await Promise.all(
        sent.map(async (s) => {
          const raws = tap.of(s.digest)[0]?.rawTransactions ?? [];
          return Promise.all(raws.map((raw) => onChain(stack, raw)));
        })
      );
      const flat = payments.flat();
      const all = [
        ...flat.map((p) => ({ nonce: p.nonce, block: p.block!, what: "stamp" })),
        ...(native.nonce !== undefined && native.block !== undefined
          ? [{ nonce: native.nonce, block: native.block, what: "native" }]
          : []),
      ].sort((x, y) => x.nonce - y.nonce);
      const seen = await seenBy(
        bob,
        sent.map((s) => s.digest),
        startedAt
      );
      costOfMainPaid = flat[0]?.feeWei! + flat[0]?.valueWei!;
      results.a = {
        wallMs,
        perSendMs: sent.map((s) => s.ms),
        how: sent.map((s) => s.how),
        delivered: Object.values(settled.statuses),
        paymentStates: settled.payments.map((states) => states.join(",")),
        paymentsPerMessage: payments.map((p) => p.length),
        allFromMain: flat.every(
          (p) => p.from === alice.mainAccount.toLowerCase()
        ),
        allMinedOk: flat.every((p) => p.mined && p.status === 1),
        nonceBefore: nonce0,
        nonceAfter: await mainNonce(stack, alice),
        noncesAndBlocks: all.map((t) => `${t.nonce}@${t.block}:${t.what}`),
        consecutive: all.every((t, i) => t.nonce === nonce0 + i),
        blocksBetween: all.slice(1).map((t, i) => t.block - all[i].block),
        recipientCopies: seen,
        waitedStage: stages.filter((s) => s.includes("waiting-for-payment"))
          .length,
        stampWei: flat.map((p) => p.valueWei.toString()),
        gasUsed: flat.map((p) => p.gasUsed?.toString()),
        feeWei: flat.map((p) => p.feeWei?.toString()),
        submitsPerMessage: sent.map((s) => tap.of(s.digest).length),
      };
      results.c = {
        issuedAfterMs: nativeStarted - started,
        mainNonceWhenIssued: nonceAtNative,
        ...native,
      };
      say("a", JSON.stringify(results.a, null, 1));
      say("c", JSON.stringify(results.c, null, 1));
      const spacing = Number(process.env.SPACING_BLOCKS ?? "3");
      say(
        `a: ${messages} messages together, wall ${wallMs} ms; nonce@block ${all
          .map((t) => `${t.nonce}@${t.block}`)
          .join(" ")}; blocks between ${all
          .slice(1)
          .map((t, i) => t.block - all[i].block)
          .join(",")}`
      );
      require_("a", "every message delivered", Object.values(settled.statuses).every((x) => x === "delivered") && sent.length === messages);
      require_("a", "one payment per message, all from the main account", payments.every((p) => p.length === 1) && flat.every((p) => p.from === alice.mainAccount.toLowerCase()));
      require_("a", "every payment mined with status 1 (zero reverts)", flat.every((p) => p.mined && p.status === 1));
      require_("a", "consecutive nonces", all.every((t, i) => t.nonce === nonce0 + i));
      require_("a", `each at least ${spacing} blocks after the previous one`, all.slice(1).every((t, i) => t.block - all[i].block >= spacing));
      require_("a", "one copy of each at the recipient", seen.every((count) => count === 1));
      // Each main-paid message waits the chain's spacing after the one before: a few blocks.
      // Ten of them in minutes means one was stuck.
      require_("a", `done within ${Number(process.env.MAX_SECONDS_PER_MESSAGE ?? "6")} s a message (took ${Math.round(wallMs / 1000)} s)`, wallMs <= messages * 1000 * Number(process.env.MAX_SECONDS_PER_MESSAGE ?? "6"));
      require_("c", "the native send issued mid-burst was mined with status 1", native.status === 1);
      require_("c", "at a nonce of its own", native.nonce !== undefined && flat.every((p) => p.nonce !== native.nonce));
    };

    // ---- b -----------------------------------------------------------------------------
    const runB = async () => {
      const reserve = 21_000n * (fee.maxFeePerGas ?? gasPrice);
      const each = floor + reserve + reserve / 100n;
      if (
        funded <= 0 ||
        !(await affordable("b", BigInt(funded) * (each + txFee)))
      )
        return;
      // First the wallet's own fund-ahead (one message's accounts, from the main account):
      // what it funds is read back from the pool and from chain.
      await ensureMain(stack, alice, each + txFee + floor / 4n);
      const usable = async () =>
        (
          await alice.handle.pool.fundedCapacities(provider, reserve, {
            fromBalance: true,
            maxCacheAgeMs: 0,
          })
        ).filter((account) => account.capacityWei >= floor);
      const usableBefore = (await usable()).map((account) => account.index);
      const aheadStarted = Date.now();
      const ahead = await alice.chain.directMessages.fundAhead!({
        wallet: alice.handle,
      });
      const aheadMs = Date.now() - aheadStarted;
      const fundedAhead = (await usable()).filter(
        (account) => !usableBefore.includes(account.index)
      );
      const aheadTransfers = await Promise.all(
        ahead.fundingTxHashes.map(async (hash) => {
          const receipt = await provider.getTransactionReceipt(hash);
          const tx = await provider.getTransaction(hash);
          return `${tx?.to} value ${tx ? mon(tx.value) : "?"} nonce ${
            tx?.nonce
          } block ${receipt?.blockNumber} status ${receipt?.status}`;
        })
      );
      // Then accounts funded from outside, up to FUNDED in all.
      const direct = Math.max(0, funded - fundedAhead.length);
      const before = alice.handle.pool.records().length;
      const added = alice.handle.pool.ensureSize(before + direct).slice(before);
      await alice.handle.pool.flush();
      const fundingStarted = Date.now();
      for (const row of added) await stack.fund(row.address, each);
      const fundingMs = Date.now() - fundingStarted;
      const targets = [
        ...fundedAhead.map((account) => ({ address: account.address })),
        ...added,
      ];
      const nonce0 = await mainNonce(stack, alice);
      const started = Date.now();
      const sent = await Promise.all(
        targets.map((_, n) => sendPaid(alice, bob.address, `b${n} ${started}`))
      );
      const wallMs = Date.now() - started;
      const settled = await settle(
        alice,
        sent.map((s) => s.digest)
      );
      const flat = (
        await Promise.all(
          sent.map((s) =>
            Promise.all(
              (tap.of(s.digest)[0]?.rawTransactions ?? []).map((raw) =>
                onChain(stack, raw)
              )
            )
          )
        )
      ).flat();
      results.b = {
        fundAhead: {
          outcome: ahead.outcome,
          reason: ahead.reason,
          ms: aheadMs,
          transfers: aheadTransfers,
          accountsItMadeUsableForAFloorStamp: fundedAhead.length,
        },
        fundedAccounts: targets.length,
        fundingMs,
        wallMs,
        perSendMs: sent.map((s) => s.ms),
        delivered: Object.values(settled.statuses),
        paymentStates: settled.payments.map((states) => states.join(",")),
        payers: flat.map((p) => `${p.from}#${p.nonce}@${p.block}`),
        eachFromItsOwnFundedAccount:
          new Set(flat.map((p) => p.from)).size === flat.length &&
          flat.every((p) =>
            targets.some((row) => row.address.toLowerCase() === p.from)
          ),
        allMinedOk: flat.every((p) => p.mined && p.status === 1),
        mainNonceBefore: nonce0,
        mainNonceAfter: await mainNonce(stack, alice),
        recipientCopies: await seenBy(
          bob,
          sent.map((s) => s.digest),
          startedAt
        ),
        feeWei: flat.map((p) => p.feeWei?.toString()),
        leftInSpentAccountsWei: (
          await Promise.all(
            targets.map((row) => provider.getBalance(row.address))
          )
        ).map(String),
      };
      say("b", JSON.stringify(results.b, null, 1));
      say(
        `b: ${targets.length} messages together from funded accounts, wall ${wallMs} ms; payers ${flat
          .map((p) => `${p.from.slice(0, 8)}#${p.nonce}@${p.block}`)
          .join(" ")}`
      );
      const b = results.b as { eachFromItsOwnFundedAccount: boolean; mainNonceBefore: number; mainNonceAfter: number };
      require_("b", "every message delivered", Object.values(settled.statuses).every((x) => x === "delivered") && sent.length === targets.length);
      require_("b", "each paid from its own funded account", b.eachFromItsOwnFundedAccount);
      require_("b", "every payment mined with status 1", flat.every((p) => p.mined && p.status === 1));
      require_("b", "the main account's nonce unchanged", b.mainNonceBefore === b.mainNonceAfter);
    };

    // ---- d -----------------------------------------------------------------------------
    /** At once after a refusal: a paid send and a native send, and what the chain shows. */
    const proveMainFree = async (label: string) => {
      const heldBefore = heldBy(alice, alice.mainAccount);
      const started = Date.now();
      const paid = await sendPaid(alice, bob.address, `${label} ${started}`);
      const paidMs = Date.now() - started;
      const native = await sendNativeReported(
        stack,
        alice,
        bob.mainAccount,
        1_000_000_000_000n
      );
      await settle(alice, [paid.digest]);
      const raw = tap.of(paid.digest)[0]?.rawTransactions[0];
      const paidOnChain = raw ? await onChain(stack, raw) : undefined;
      return {
        mainHeldByRightAfterTheRefusal: heldBefore,
        paidSendMs: paidMs,
        paidSendNonce: paidOnChain?.nonce,
        paidSendStatus: paidOnChain?.status,
        paidSendFrom: paidOnChain?.from,
        native,
      };
    };
    const runD = async () => {
      // Up to three messages and two native sends: one paid send after each refusal, and the
      // "refused" one itself should the relay turn out not to refuse it for good.
      if (!(await affordable("d", 3n * (floor + txFee) + 2n * txFee))) return;
      await ensureMain(
        stack,
        alice,
        perMessage + 2n * (floor + txFee) + 2n * txFee + floor
      );
      const nonce0 = await mainNonce(stack, alice);
      // d1: no directory entry.
      const nobody = "0x" + "d1".repeat(20);
      const requestsBefore = tap.submitted.length;
      const d1 = await sendPaid(alice, nobody, "to nobody").then(
        () => "SENT (unexpected)",
        (error) => `${(error as Error).name}: ${(error as Error).message}`
      );
      const d1Requests = tap.submitted.length - requestsBefore;
      const afterD1 = await proveMainFree("d1 after");
      // d2: a signed, stored message whose request the relay cannot read (its multipart
      // boundary is replaced on the way out, this once): the relay refuses the request.
      const refusal: { status?: number; answer?: string } = {};
      let refusedRequest: Submitted | undefined;
      tap.onNext(async (_send, init, url) => {
        refusedRequest = tap.submitted[tap.submitted.length - 1];
        const response = await defaultCanonicalFetch(url, {
          ...init,
          headers: {
            ...init.headers,
            "Content-Type": init.headers["Content-Type"].replace(
              /boundary=.*/,
              "boundary=not-the-boundary-of-this-body"
            ),
          },
        });
        refusal.status = response.status;
        return response;
      }, true);
      const d2Started = Date.now();
      const d2 = await sendPaid(alice, bob.address, "refused outright").then(
        (sent) => `SENT ${sent.digest} (${sent.how})`,
        (error) => `${(error as Error).name}: ${(error as Error).message}`
      );
      const d2Ms = Date.now() - d2Started;
      const refused = refusedRequest as Submitted | undefined;
      const refusedPayment = refused?.rawTransactions[0]
        ? Transaction.from(refused.rawTransactions[0])
        : undefined;
      const refusedState = refused
        ? {
            status: (
              await alice.chain.directMessages.reconcileAttempts({
                wallet: alice.handle,
                payloadDigests: [refused.digest],
              })
            )[refused.digest],
            payments: alice.chain.directMessages.paymentsOf?.({
              wallet: alice.handle,
              payloadDigest: refused.digest,
            }),
          }
        : undefined;
      const afterD2 = await proveMainFree("d2 after");
      results.d = {
        d1: {
          result: d1,
          requestsThatReachedTheRelay: d1Requests,
          then: afterD1,
        },
        d2: {
          result: d2,
          ms: d2Ms,
          relayAnswerToBrokenRequest: refusal.status,
          signedPaymentNonce: refusedPayment?.nonce,
          walletRecord: refusedState,
          signedPaymentOnChain: refusedPayment
            ? (await provider.getTransactionReceipt(refusedPayment.hash!)) !==
              null
            : undefined,
          recipientCopies: refused
            ? (
                await bob.chain.directMessages.fetchSince({
                  wallet: bob.handle,
                  sinceMs: startedAt,
                })
              ).filter((m) => m.payloadDigest === refused.digest).length
            : undefined,
          then: afterD2,
        },
        mainNonceBefore: nonce0,
        mainNonceAfter: await mainNonce(stack, alice),
      };
      say("d", JSON.stringify(results.d, null, 1));
      require_("d", "a message to an address with no directory entry is refused before any request", !d1.startsWith("SENT") && d1Requests === 0);
      require_("d", "after it a paid send is mined with status 1 and a native send too", afterD1.paidSendStatus === 1 && afterD1.native.status === 1);
      require_("d", "the relay refused the broken request and the message failed", !d2.startsWith("SENT") && refusal.status !== undefined && refusal.status >= 400);
      require_("d", "the refused message's payment is unsent and not on chain", refusedState?.payments?.every((x) => x === "unsent") === true);
      require_("d", "after the refusal a paid send reuses the nonce and is mined with status 1", afterD2.paidSendStatus === 1 && afterD2.paidSendNonce === refusedPayment?.nonce);
      require_("d", "and a native send lands", afterD2.native.status === 1);
    };

    // ---- e -----------------------------------------------------------------------------
    const runE = async () => {
      if (!(await affordable("e", floor + txFee))) return;
      await ensureMain(stack, alice, perMessage + floor / 4n);
      // Let whatever alice's last native send left be decided before the process is replaced.
      await sleep(3000);
      const nonce0 = await mainNonce(stack, alice);
      const note = join(mkdtempSync(join(tmpdir(), "psend-")), "killed.json");
      await alice.close();
      const child = spawn(
        process.execPath,
        ["--import", "tsx", __filename],
        {
          env: {
            ...process.env,
            PSEND_CHILD: "kill-after-delivered",
            PSEND_RELAY: stack.relayUrl,
            PSEND_STATE_DIR: stack.stateDir,
            PSEND_TO: bob.address,
            PSEND_NOTE: note,
            PSEND_LABEL: senderLabel,
          },
          stdio: ["ignore", "inherit", "inherit"],
        }
      );
      const exit = await new Promise<string>((resolve) =>
        child.on("exit", (code, signal) => resolve(signal ?? `code ${code}`))
      );
      const killed = existsSync(note)
        ? (JSON.parse(readFileSync(note, "utf8")) as {
            digest: string;
            rawTx: string;
            relayStatus: number;
            relayAnswer: string;
          })
        : undefined;
      alice = await stack.openWallet(senderLabel, { stampValueWei: floorNow });
      tap = intercept(alice);
      if (!killed) {
        results.e = { exit, error: "the child left no note" };
      } else {
        const tx = Transaction.from(killed.rawTx);
        const atReopen = {
          payments: alice.chain.directMessages.paymentsOf?.({
            wallet: alice.handle,
            payloadDigest: killed.digest,
          }),
          mainHeldBy: heldBy(alice, alice.mainAccount),
        };
        const settled = await settle(alice, [killed.digest]);
        const chain = await onChain(stack, killed.rawTx);
        results.e = {
          childEndedBy: exit,
          relayAnswerBeforeKill: `${killed.relayStatus} ${killed.relayAnswer}`,
          atReopen,
          statusAfter: settled.statuses[killed.digest],
          paymentAfter: settled.payments[0],
          paymentNonce: tx.nonce,
          minedOk: chain.status === 1,
          block: chain.block,
          mainNonceBefore: nonce0,
          mainNonceAfter: await mainNonce(stack, alice),
          mainHeldAfter: heldBy(alice, alice.mainAccount),
          recipientCopies: await seenBy(bob, [killed.digest], startedAt),
          submitsAfterReopen: tap.of(killed.digest).length,
        };
      }
      say("e", JSON.stringify(results.e, null, 1));
      const e = results.e as { childEndedBy?: string; statusAfter?: string; minedOk?: boolean; mainNonceBefore?: number; mainNonceAfter?: number; recipientCopies?: number[]; submitsAfterReopen?: number };
      require_("e", "the wallet process was killed after the relay answered", e.childEndedBy === "SIGKILL");
      require_("e", "reopened: delivered, the payment mined with status 1", e.statusAfter === "delivered" && e.minedOk === true);
      require_("e", "paid once: one payment recorded, spent; one copy at the recipient", (e as { paymentAfter?: string[] }).paymentAfter?.join(",") === "spent" && e.recipientCopies?.[0] === 1);
    };

    // ---- h -----------------------------------------------------------------------------
    const runH = async () => {
      const outage = stack.chainOutage;
      if (!outage) {
        results.h = "NOT RUN: this stack cannot make the chain unreachable";
        say("h", results.h);
        return;
      }
      await ensureMain(stack, alice, 2n * perMessage + floor);
      await sleep(3000);
      const nonce0 = await mainNonce(stack, alice);
      const health = () =>
        alice.chain.directMessages.chainHealth?.({ wallet: alice.handle });
      const healthBefore = health();
      const requestsBefore = tap.submitted.length;
      // Let the wallet's few-second fee quote age out, then cut the chain off.
      await sleep(7000);
      await outage.down();
      const stages: string[] = [];
      const started = Date.now();
      let done: { digest?: string; error?: string; ms?: number } | undefined;
      const sending = alice.chain.directMessages
        .send({
          wallet: alice.handle,
          recipient: { raw: bob.address },
          items: [{ type: "text", text: `h queued ${started}` }],
          messageId: randomUUID(),
          stampValue: floor,
          onPreparationProgress: (progress) => stages.push(progress.stage),
        })
        .then(
          (sent) => (done = { digest: sent.payloadDigest, ms: Date.now() - started }),
          (error) => (done = { error: `${(error as Error).name}: ${(error as Error).message}` })
        );
      for (let i = 0; i < 60 && !stages.includes("waiting-for-chain") && !done; i++)
        await sleep(500);
      const queuedAfterMs = Date.now() - started;
      const healthWhileDown = health();
      // A free message does not need the chain.
      const free = await alice.chain.directMessages
        .send({
          wallet: alice.handle,
          recipient: { raw: bob.address },
          items: [{ type: "text", text: `h free ${started}` }],
          messageId: randomUUID(),
          stampValue: 0n,
        })
        .then(
          (sent) => `delivered ${sent.payloadDigest.slice(0, 12)}`,
          (error) => `${(error as Error).name}: ${(error as Error).message}`
        );
      await sleep(5000);
      const whileDown = {
        paidSendSettled: done !== undefined,
        mainHeldBy: heldBy(alice, alice.mainAccount),
        // The free message is one request; the queued paid one has made none.
        relayRequests: tap.submitted.length - requestsBefore,
      };
      const downMs = Date.now() - started;
      await outage.up();
      await sending;
      const backMs = Date.now() - started - downMs;
      const settled = done?.digest ? await settle(alice, [done.digest]) : undefined;
      const raw = done?.digest ? tap.of(done.digest)[0]?.rawTransactions[0] : undefined;
      const chain = raw ? await onChain(stack, raw) : undefined;
      results.h = {
        healthBefore,
        stages: [...new Set(stages)],
        queuedAfterMs,
        healthWhileDown,
        freeMessageWhileDown: free,
        whileDown,
        chainDownForMs: downMs,
        completedMsAfterChainBack: backMs,
        result: done,
        healthAfter: health(),
        status: settled?.statuses[done!.digest!],
        payment: chain && { nonce: chain.nonce, block: chain.block, status: chain.status },
        mainNonceBefore: nonce0,
        mainNonceAfter: await mainNonce(stack, alice),
      };
      say("h", JSON.stringify(results.h, null, 1));
      require_("h", "the paid send reported waiting-for-chain", stages.includes("waiting-for-chain"));
      require_("h", "the wallet's chain warning was set while the chain was down", healthWhileDown?.reachable === false);
      require_("h", "while down the queued message claimed nothing and made no relay request", !whileDown.paidSendSettled && !whileDown.mainHeldBy.includes("frank-dm:") && whileDown.relayRequests <= 1);
      require_("h", "a free message was delivered while the chain was down", free.startsWith("delivered"));
      require_("h", "when the chain came back the same send completed, its payment mined with status 1", done?.digest !== undefined && chain?.status === 1 && settled?.payments[0]?.join(",") === "spent");
      require_("h", "the chain warning cleared", health()?.reachable === true);
    };

    // ---- w -----------------------------------------------------------------------------
    /** Money that arrived as payments pays for a send: the recipient of two stamps, holding
     * nothing else, sends a message whose stamp neither received coin covers alone. */
    const runW = async () => {
      const each = 20_000_000_000_000_000n; // 0.02
      const wanted = 30_000_000_000_000_000n; // 0.03
      if (!(await affordable("w", 2n * (each + txFee) + 2n * txFee))) return;
      await ensureMain(stack, alice, 2n * (each + perMessage) + floor);
      await sleep(3000);
      const bobMainBefore = await provider.getBalance(bob.mainAccount);
      const bobNonceBefore = await mainNonce(stack, bob);
      const paidIn: string[] = [];
      for (const n of [1, 2]) {
        const sent = await alice.chain.directMessages.send({
          wallet: alice.handle,
          recipient: { raw: bob.address },
          items: [{ type: "text", text: `w pays bob ${n} ${Date.now()}` }],
          messageId: randomUUID(),
          stampValue: each,
        });
        paidIn.push(sent.payloadDigest);
      }
      await settle(alice, paidIn);
      // Bob reads his mailbox (that is how a wallet learns of the coins) until the chain shows
      // both funded.
      let coins: { spendable: boolean; amountWei: bigint }[] = [];
      for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
        await bob.chain.directMessages.fetchSince({ wallet: bob.handle, sinceMs: startedAt });
        coins = [...((await bob.handle.refreshReceivedPayments?.()) ?? [])].filter(
          (coin) => coin.spendable && coin.amountWei === each
        );
        if (coins.length >= 2) break;
        await sleep(1500);
      }
      const headline = await bob.handle.getBalance();
      const started = Date.now();
      const stages: string[] = [];
      const out = await bob.chain.directMessages
        .send({
          wallet: bob.handle,
          recipient: { raw: alice.address },
          items: [{ type: "text", text: `w from received coins ${started}` }],
          messageId: randomUUID(),
          stampValue: wanted,
          onPreparationProgress: (progress) => stages.push(progress.stage),
        })
        .then(
          (sent) => ({ sent }),
          (error) => ({ error: `${(error as Error).name}: ${(error as Error).message}` })
        );
      const ms = Date.now() - started;
      const paid =
        "sent" in out
          ? await Promise.all(
              out.sent.stampPayments.map(async (payment) => {
                let receipt = await provider.getTransactionReceipt(payment.txHash);
                for (let i = 0; !receipt && i < 30; i++) {
                  await sleep(1000);
                  receipt = await provider.getTransactionReceipt(payment.txHash);
                }
                const tx = await provider.getTransaction(payment.txHash);
                return {
                  from: tx?.from.toLowerCase(),
                  valueWei: payment.valueWei,
                  status: receipt?.status,
                  block: receipt?.blockNumber,
                  feeWei: receipt ? receipt.gasUsed * receipt.gasPrice : undefined,
                };
              })
            )
          : [];
      results.w = {
        bobMainBefore: mon(bobMainBefore),
        receivedCoinsSpendable: coins.length,
        bobHeadlineBalance: mon(headline),
        stampWanted: mon(wanted),
        ms,
        stages: [...new Set(stages)],
        result: "sent" in out ? out.sent.payloadDigest : out.error,
        payments: paid.map(
          (p) => `${p.from} pays ${mon(p.valueWei)} block ${p.block} status ${p.status} fee ${p.feeWei === undefined ? "?" : mon(p.feeWei)}`
        ),
        bobMainNonceBefore: bobNonceBefore,
        bobMainNonceAfter: await mainNonce(stack, bob),
        recipientCopies:
          "sent" in out
            ? await (async () => {
                for (const deadline = Date.now() + 60_000; ; ) {
                  const got = (
                    await alice.chain.directMessages.fetchSince({ wallet: alice.handle, sinceMs: startedAt })
                  ).filter((m) => !m.outbound && m.payloadDigest === out.sent.payloadDigest);
                  if (got.length > 0 || Date.now() > deadline)
                    return got.map((m) => mon(m.stampValueWei ?? 0n));
                  await sleep(1500);
                }
              })()
            : [],
      };
      say("w", JSON.stringify(results.w, null, 1));
      require_("w", "the two received payments became spendable coins", coins.length >= 2);
      require_("w", "a stamp neither coin covers alone was sent", "sent" in out);
      require_("w", "paid by two transfers from two different received coins, both mined with status 1, adding up to the stamp", paid.length === 2 && new Set(paid.map((p) => p.from)).size === 2 && paid.every((p) => p.status === 1 && p.from !== bob.mainAccount.toLowerCase()) && paid.reduce((sum, p) => sum + p.valueWei, 0n) === wanted);
      require_("w", "the main account was not used", (results.w as { bobMainNonceAfter: number }).bobMainNonceAfter === bobNonceBefore);
      require_("w", "the recipient has one copy carrying the whole stamp", (results.w as { recipientCopies: string[] }).recipientCopies.join() === mon(wanted));
    };

    // ---- m -----------------------------------------------------------------------------
    /** A native send that needs more than one account: money at the main address and in a
     * received coin, sent together to an outside address. */
    const runM = async () => {
      const coinWei = 20_000_000_000_000_000n; // 0.02
      const mainWei = 12_000_000_000_000_000n; // 0.012
      const value = 22_000_000_000_000_000n; // 0.022: more than either holds
      if (!(await affordable("m", coinWei + mainWei + 3n * txFee))) return;
      await ensureMain(stack, alice, coinWei + perMessage + floor);
      await sleep(3000);
      const paid = await alice.chain.directMessages.send({
        wallet: alice.handle,
        recipient: { raw: bob.address },
        items: [{ type: "text", text: `m pays bob ${Date.now()}` }],
        messageId: randomUUID(),
        stampValue: coinWei,
      });
      await settle(alice, [paid.payloadDigest]);
      const bobMain = await provider.getBalance(bob.mainAccount);
      if (bobMain < mainWei) await stack.fund(bob.mainAccount, mainWei - bobMain);
      for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
        await bob.chain.directMessages.fetchSince({ wallet: bob.handle, sinceMs: startedAt });
        const coins = [...((await bob.handle.refreshReceivedPayments?.()) ?? [])];
        if (coins.some((coin) => coin.spendable && coin.amountWei === coinWei)) break;
        await sleep(1500);
      }
      const { Wallet } = await import("ethers");
      const outside = Wallet.createRandom().address;
      const estimate = await bob.handle
        .estimateLegacyFee?.({ recipient: { raw: outside }, value })
        .catch((error: Error) => `${error.name}: ${error.message}`);
      const started = Date.now();
      const out = await bob.handle.sendLegacy!({ recipient: { raw: outside }, value }).then(
        (sent) => ({ sent }),
        (error: Error & { transaction?: { txHash?: string; relatedTxHashes?: string[] } }) => ({
          error: `${error.name}: ${error.message}`,
          hashes: [...(error.transaction?.relatedTxHashes ?? []), error.transaction?.txHash].filter(Boolean) as string[],
        })
      );
      const ms = Date.now() - started;
      const hashes = "sent" in out ? [...(out.sent.intermediateTxHashes ?? []), out.sent.txHash] : out.hashes;
      const onChainNow = await Promise.all(
        hashes.map(async (hash) => {
          let receipt = await provider.getTransactionReceipt(hash);
          for (let i = 0; !receipt && i < 20; i++) {
            await sleep(1000);
            receipt = await provider.getTransactionReceipt(hash);
          }
          const tx = await provider.getTransaction(hash);
          return `${tx?.from.slice(0, 10)} -> ${tx?.to?.slice(0, 10)} ${tx ? mon(tx.value) : "?"} gas ${tx?.gasLimit} block ${receipt?.blockNumber} status ${receipt?.status} fee ${receipt ? mon(receipt.gasUsed * receipt.gasPrice) : "?"}`;
        })
      );
      results.m = {
        value: mon(value),
        feeQuoted: typeof estimate === "object" && estimate ? { inputs: estimate.inputCount, total: mon(estimate.totalFee) } : estimate,
        ms,
        result: "sent" in out ? `sent ${out.sent.txHash}` : out.error,
        feePaid: "sent" in out ? mon(out.sent.totalFeePaid) : undefined,
        transactions: onChainNow,
        recipientHolds: mon(await provider.getBalance(outside)),
      };
      say("m", JSON.stringify(results.m, null, 1));
      require_("m", "the send returned sent", "sent" in out);
      require_("m", "it took more than one transaction, every one mined with status 1", onChainNow.length >= 2 && onChainNow.every((line) => line.includes("status 1")));
      require_("m", "the recipient holds the whole amount", (await provider.getBalance(outside)) === value);
      require_("m", "the fee quoted is the fee paid", "sent" in out && typeof estimate === "object" && !!estimate && estimate.totalFee === out.sent.totalFeePaid);
    };

    // ---- n -----------------------------------------------------------------------------
    /** A payment the node refuses: a new account is paid and sends at once, with the wallet's
     * wait for newly arrived funds switched off IN THIS CHECK ONLY. The node refuses the stamp
     * (and goes on refusing those bytes); the wallet signs the same payment again at its nonce.
     * Only on a chain made for tests: it opens a wallet of its own. */
    const runN = async () => {
      if (!stack.chainOutage) {
        results.n = "NOT RUN: only on the local chain (it opens a new wallet)";
        say("n", results.n);
        return;
      }
      const carol = await stack.openWallet("carol", { stampValueWei: floorNow });
      const carolTap = intercept(carol);
      const payer = EvmStampPayer.prototype as unknown as {
        untilFundsSettled(...args: unknown[]): Promise<void>;
      };
      const settledWait = payer.untilFundsSettled;
      payer.untilFundsSettled = async () => undefined;
      let sent: Sent;
      const started = Date.now();
      try {
        await stack.fund(carol.mainAccount, 3n * perMessage);
        sent = await sendPaid(carol, bob.address, `n refused ${started}`);
      } finally {
        payer.untilFundsSettled = settledWait;
      }
      const deliveredMs = Date.now() - started;
      const first = carolTap.of(sent.digest)[0]?.rawTransactions[0];
      const statesAtDelivery =
        carol.chain.directMessages.paymentsOf?.({ wallet: carol.handle, payloadDigest: sent.digest }) ?? [];
      const firstKnownToNode = first
        ? (await provider.getTransaction(Transaction.from(first).hash!)) !== null
        : undefined;
      const settled = await settle(carol, [sent.digest]);
      const paidMs = Date.now() - started;
      const firstTx = first ? Transaction.from(first) : undefined;
      const stampAddress = firstTx?.to?.toLowerCase() ?? "";
      const toStamp: string[] = [];
      const head = await provider.getBlockNumber();
      for (let number = head - 80; number <= head; number++) {
        const block = await provider.getBlock(number, true);
        for (const tx of block?.prefetchedTransactions ?? [])
          if (tx.from.toLowerCase() === carol.mainAccount.toLowerCase() && tx.to?.toLowerCase() === stampAddress) {
            const receipt = await provider.getTransactionReceipt(tx.hash);
            toStamp.push(`${tx.hash.slice(0, 12)} nonce ${tx.nonce} block ${number} status ${receipt?.status} maxFee ${tx.maxFeePerGas}`);
          }
      }
      const next = await sendPaid(carol, bob.address, `n next ${Date.now()}`);
      const nextSettled = await settle(carol, [next.digest]);
      results.n = {
        deliveredMs,
        paymentStatesAtDelivery: statesAtDelivery,
        firstSignedPayment: firstTx && `${firstTx.hash!.slice(0, 12)} nonce ${firstTx.nonce} maxFee ${firstTx.maxFeePerGas}`,
        firstKnownToTheNode: firstKnownToNode,
        paidAfterMs: paidMs,
        paymentStates: settled.payments[0],
        summary: carol.chain.directMessages.paymentSummaryOf?.({ wallet: carol.handle, payloadDigest: sent.digest }),
        transfersToTheStampAddressOnChain: toStamp,
        stampAddressBalance: mon(await provider.getBalance(stampAddress)),
        mainNonceAfter: await mainNonce(stack, carol),
        nextMessage: `${nextSettled.statuses[next.digest]} ${nextSettled.payments[0]?.join(",")} in ${next.ms} ms`,
        recipientCopies: await seenBy(bob, [sent.digest], startedAt),
      };
      await carol.close().catch(() => undefined);
      say("n", JSON.stringify(results.n, null, 1));
      const n = results.n as { paymentStates?: string[]; mainNonceAfter: number };
      require_("n", "the node refused the first signed payment (it does not know it)", firstKnownToNode === false && statesAtDelivery.includes("pending"));
      require_("n", "the message was delivered all the same, once", (results.n as { recipientCopies: number[] }).recipientCopies[0] === 1);
      require_("n", "the payment was signed again and paid: one transfer to the stamp address on chain, status 1, at the same nonce", toStamp.length === 1 && toStamp[0].includes("status 1") && toStamp[0].includes(`nonce ${firstTx?.nonce} `) && !toStamp[0].startsWith(firstTx?.hash?.slice(0, 12) ?? "?"));
      require_("n", "recorded as the refused bytes failed and the new ones spent; paid", n.paymentStates?.join(",") === "failed,spent");
      require_("n", `paid within 20 s of the send (took ${Math.round(paidMs / 1000)} s)`, paidMs < 20_000);
      require_("n", "the account was not left held: the next message is delivered and paid", nextSettled.statuses[next.digest] === "delivered" && nextSettled.payments[0]?.join(",") === "spent");
    };

    // ---- s, t ------------------------------------------------------------------------
    /** A burst from a wallet whose money is at ONE address: `messages` paid messages started
     * together. `where`: the profile address (where a faucet pays a new user) or the main
     * account. With SPREAD_WAIT_MS the wallet's background funding is first given that long
     * (the host's tick, as the app and the bots call it). Local chain only: a new wallet. */
    const burstFrom = async (
      phase: string,
      label: string,
      where: "profile" | "main",
      fundWei: bigint
    ) => {
      if (!stack.chainOutage) {
        results[phase] = "NOT RUN: only on the local chain (it opens a new wallet)";
        say(phase, results[phase]);
        return;
      }
      const wallet = await stack.openWallet(label, { stampValueWei: floorNow });
      const funded = where === "profile" ? wallet.address : wallet.mainAccount;
      await stack.fund(funded, fundWei);
      const fundedAt = await provider.getBlockNumber();
      // As a person would: the money has arrived and been seen before the first message.
      while ((await provider.getBlockNumber()) < fundedAt + 6) await sleep(100);
      const spreadMs = Number(process.env.SPREAD_WAIT_MS ?? "0");
      const spreadStarted = Date.now();
      const passes: string[] = [];
      while (Date.now() - spreadStarted < spreadMs) {
        const pass = await wallet.chain.directMessages.fundAhead?.({ wallet: wallet.handle });
        passes.push(`${pass?.outcome}${pass?.reason ? `(${pass.reason})` : ""}:${pass?.fundingTxHashes.length ?? 0}`);
        if (pass?.outcome === "ready") break;
        await sleep(1000);
      }
      const partsBefore = await wallet.handle.getBalanceParts?.();
      const started = Date.now();
      const firstBlock = await provider.getBlockNumber();
      const outcomes = await Promise.all(
        Array.from({ length: messages }, (_, n) =>
          sendPaid(wallet, bob.address, `${phase}${n} ${started}`).then(
            (sent) => ({ sent }),
            (error) => ({ error: `${(error as Error).name}: ${(error as Error).message}`.slice(0, 200) })
          )
        )
      );
      const wallMs = Date.now() - started;
      const sent = outcomes.flatMap((o) => ("sent" in o ? [o.sent] : []));
      const settled = sent.length > 0 ? await settle(wallet, sent.map((x) => x.digest)) : undefined;
      // Every transaction of the wallet's accounts since the burst began, from the chain.
      const ours = new Set([wallet.address.toLowerCase(), wallet.mainAccount.toLowerCase()]);
      const lastBlock = await provider.getBlockNumber();
      const txs: { from: string; nonce: number; block: number; status?: number; toOwn: boolean }[] = [];
      for (let number = fundedAt; number <= lastBlock; number++) {
        const block = await provider.getBlock(number, true);
        for (const tx of block?.prefetchedTransactions ?? []) {
          if (!ours.has(tx.from.toLowerCase())) continue;
          const receipt = await provider.getTransactionReceipt(tx.hash);
          // An account the wallet's own accounts pay into before the burst is one of its own.
          const beforeBurst = number < firstBlock;
          if (beforeBurst && tx.to) ours.add(tx.to.toLowerCase());
          txs.push({ from: tx.from.toLowerCase(), nonce: tx.nonce, block: number, status: receipt?.status ?? undefined, toOwn: beforeBurst });
        }
      }
      const burst = txs.filter((tx) => !tx.toOwn);
      const partsAfter = await wallet.handle.getBalanceParts?.();
      const total = (parts?: { main: bigint; profile: bigint; received: bigint; sending: bigint }) =>
        parts ? mon(parts.main + parts.profile + parts.received + parts.sending) : "?";
      results[phase] = {
        funded: `${mon(fundWei)} at the ${where} address`,
        backgroundFunding: spreadMs > 0 ? { waitedMs: Date.now() - spreadStarted - wallMs, passes, transfers: txs.filter((tx) => tx.toOwn).length } : "not given time",
        balanceBeforeBurst: total(partsBefore),
        wallMs,
        delivered: sent.length,
        failed: outcomes.flatMap((o) => ("error" in o ? [o.error] : [])),
        perSendMs: sent.map((x) => x.ms).sort((a, b) => a - b),
        paymentStates: settled?.payments.map((states) => states.join(",")),
        payingAccounts: new Set(burst.map((tx) => tx.from)).size,
        payments: burst.map((tx) => `${tx.from.slice(0, 8)}#${tx.nonce}@${tx.block}${tx.status === 1 ? "" : ` STATUS ${tx.status}`}`),
        blocksFirstToLast: burst.length ? burst[burst.length - 1].block - burst[0].block : undefined,
        reverted: burst.filter((tx) => tx.status !== 1).length,
        balanceAfter: total(partsAfter),
        recipientCopies: sent.length ? (await seenBy(bob, sent.map((x) => x.digest), startedAt)).filter((count) => count === 1).length : 0,
      };
      await wallet.close().catch(() => undefined);
      say(phase, JSON.stringify(results[phase], null, 1));
      const r = results[phase] as { wallMs: number; payments: string[]; blocksFirstToLast?: number; payingAccounts: number };
      say(`${phase}: ${messages} together from ${mon(fundWei)} at one ${where} address: ${r.wallMs} ms, ${r.payingAccounts} paying account(s), blocks first to last ${r.blocksFirstToLast}; ${r.payments.join(" ")}`);
      require_(phase, "every message delivered, one copy each", sent.length === messages && (results[phase] as { recipientCopies: number }).recipientCopies === messages);
      require_(phase, "every payment mined with status 1 (zero reverts)", burst.length >= messages && burst.every((tx) => tx.status === 1));
    };
    const runS = () => burstFrom("s", `small-${Date.now()}`, "profile", 100_000_000_000_000_000n);
    const runT = () => burstFrom("t", `rich-${Date.now()}`, "main", 20n * 10n ** 18n);

    // ---- r -----------------------------------------------------------------------------
    const runR = async () => {
      if (!(await affordable("r", 2n * (floor + txFee) + 2n * txFee))) return;
      await ensureMain(stack, alice, 3n * perMessage + 2n * txFee);
      const mainKey = alice.handle.mainPrivateKey;
      if (!mainKey) throw new Error("the sender's main key is not available to the check");
      const { Wallet } = await import("ethers");
      const direct = new Wallet(mainKey, provider);
      // Quiet for longer than the window, so only what follows counts.
      await sleep(4000);
      const nonce0 = await mainNonce(stack, alice);
      const main = alice.mainAccount.toLowerCase();
      // THE BYPASS, in this check only: the wallet is told its main coin is at the nonce after
      // the check's own transfer and may be spent now. Restored below.
      const payer = EvmStampPayer.prototype as unknown as {
        coinOf(address: string, signal?: AbortSignal): Promise<{ nonce: number; notBeforeBlock: number }>;
      };
      const realCoinOf = payer.coinOf;
      payer.coinOf = async function (this: unknown, address, signal) {
        if (address.toLowerCase() !== main) return realCoinOf.call(this, address, signal);
        payer.coinOf = realCoinOf;
        return { nonce: nonce0 + 1, notBeforeBlock: 0 };
      };
      let ownTransfer: string | undefined;
      // The check's own transfer (nonce n) is handed to the node first, then the message with
      // the stamp at nonce n+1 goes to the relay: both are mined inside the window.
      tap.onNext(async (send) => {
        const feeNow = await provider.getFeeData();
        ownTransfer = (
          await direct.sendTransaction({
            to: bob.mainAccount,
            value: 1_000_000_000_000n,
            nonce: nonce0,
            gasLimit: 21_000n,
            type: 2,
            maxFeePerGas: feeNow.maxFeePerGas ?? gasPrice,
            maxPriorityFeePerGas: feeNow.maxPriorityFeePerGas ?? 0n,
          })
        ).hash;
        return send();
      }, true);
      let sent: Sent;
      try {
        sent = await sendPaid(alice, bob.address, `r reverted ${Date.now()}`);
      } finally {
        payer.coinOf = realCoinOf;
      }
      const original = tap.of(sent.digest)[0]?.rawTransactions[0];
      const states = () =>
        alice.chain.directMessages.paymentsOf?.({
          wallet: alice.handle,
          payloadDigest: sent.digest,
        }) ?? [];
      const tick = () =>
        alice.chain.directMessages.reconcileAttempts({
          wallet: alice.handle,
          payloadDigests: [sent.digest],
          maxPutAttempts: 2,
        });
      const seen: string[] = [];
      for (const deadline = Date.now() + 90_000; Date.now() < deadline; ) {
        await tick();
        const now = states().join(",");
        if (seen[seen.length - 1] !== now) seen.push(now);
        if (states().length >= 2 && states().every((x) => x !== "pending")) break;
        if (states().length === 1 && states()[0] === "spent") break;
        await sleep(700);
      }
      // Further ticks: a third payment must never appear.
      for (let i = 0; i < 8; i++) {
        await tick();
        await sleep(700);
      }
      const first = original ? await onChain(stack, original) : undefined;
      const own = ownTransfer ? await provider.getTransactionReceipt(ownTransfer) : null;
      // Every transfer the main account made to the stamp's address, read from the chain.
      const stampAddress = original ? Transaction.from(original).to!.toLowerCase() : "";
      const toStamp: string[] = [];
      const head = await provider.getBlockNumber();
      for (let number = first?.block ?? head; number <= head; number++) {
        const block = await provider.getBlock(number, true);
        for (const tx of block?.prefetchedTransactions ?? [])
          if (tx.from.toLowerCase() === main && tx.to?.toLowerCase() === stampAddress) {
            const receipt = await provider.getTransactionReceipt(tx.hash);
            toStamp.push(`nonce ${tx.nonce} block ${number} status ${receipt?.status} value ${mon(tx.value)}`);
          }
      }
      results.r = {
        checksOwnTransfer: own && `nonce ${nonce0} block ${own.blockNumber} status ${own.status}`,
        stampSignedAtNonce: first?.nonce,
        stampBlock: first?.block,
        stampStatus: first?.status,
        blocksAfterOwnTransfer: own && first?.block !== undefined ? first.block - own.blockNumber : undefined,
        paymentStatesSeen: seen,
        paymentStatesAfterMoreTicks: states(),
        summary: alice.chain.directMessages.paymentSummaryOf?.({ wallet: alice.handle, payloadDigest: sent.digest }),
        transfersToTheStampAddressOnChain: toStamp,
        stampAddressBalance: mon(await provider.getBalance(stampAddress)),
        mainNonceBefore: nonce0,
        mainNonceAfter: await mainNonce(stack, alice),
        recipientCopies: await seenBy(bob, [sent.digest], startedAt),
      };
      say("r", JSON.stringify(results.r, null, 1));
      require_("r", "the stamp was mined and reverted (status 0)", first?.status === 0);
      require_("r", "the wallet recorded it reverted and paid again once: reverted,spent", states().join(",") === "reverted,spent");
      require_("r", "on chain: exactly two transfers to the stamp address, one status 0 and one status 1", toStamp.length === 2 && toStamp.filter((line) => line.includes("status 1")).length === 1);
      require_("r", "the stamp address holds exactly one stamp", (await provider.getBalance(stampAddress)) === floor || (await provider.getBalance(stampAddress)) === first?.valueWei);
      require_("r", "the message was delivered once", (results.r as { recipientCopies: number[] }).recipientCopies[0] === 1);
    };

    // ---- f -----------------------------------------------------------------------------
    const runF = async () => {
      const messageId = randomUUID();
      const items = [{ type: "text" as const, text: `f unpaid ${Date.now()}` }];
      const first: { status?: number } = {};
      // The relay receives and answers the first request; the answer never reaches the wallet.
      tap.onNext(async (send) => {
        const response = await send();
        first.status = response.status;
        await response.body?.getReader().cancel();
        throw new Error("the answer was dropped on the way back");
      });
      const sendUnpaid = () =>
        alice.chain.directMessages
          .send({
            wallet: alice.handle,
            recipient: { raw: bob.address },
            items,
            messageId,
            stampValue: 0n,
          })
          .then(
            (sent) => ({ digest: sent.payloadDigest }),
            (error) => ({
              error: `${(error as Error).name}: ${(error as Error).message}`,
            })
          );
      const before = tap.submitted.length;
      const one = await sendUnpaid();
      const two = await sendUnpaid();
      const requests = tap.submitted.slice(before);
      const digest = requests[0]?.digest;
      results.f = {
        firstCall: one,
        relayAnsweredFirstRequestWith: first.status,
        secondCall: two,
        requests: requests.map(
          (r) =>
            `digest ${r.digest.slice(0, 16)} delivery ${r.deliveryHash} body ${r.bodyHash} payments ${r.rawTransactions.length} -> HTTP ${r.status}`
        ),
        sameDeliveryBytes:
          requests.length === 2 &&
          requests[0].deliveryHash === requests[1].deliveryHash,
        sameRequestBody:
          requests.length === 2 && requests[0].bodyHash === requests[1].bodyHash,
        recipientCopies: digest
          ? await seenBy(bob, [digest], startedAt)
          : undefined,
      };
      say("f", JSON.stringify(results.f, null, 1));
    };

    // ---- unfreeze ----------------------------------------------------------------------
    /** A native transfer whose nonce went to another transaction: what the wallet lists as
     * unresolved, and whether the main account is busy, before and after one look at the
     * chain (the look every native send and every funds reading makes). Costs nothing. */
    const runUnfreeze = async () => {
      const rows = () =>
        (alice.handle.getNativeOperations?.() ?? [])
          .filter((row) => !row.cancelled)
          .flatMap((row) =>
            row.members
              .filter((m) => m.signed && !("transactionHash" in m.observation))
              .map(
                (m) =>
                  `${row.operationId} ${row.kind} nonce ${
                    Transaction.from(m.unsignedTransaction).nonce
                  } observed ${m.observation.state} accountNonce ${
                    m.account?.nonce
                  }`
              )
          );
      const before = {
        notIncluded: rows(),
        unresolved: alice.handle.getUnresolvedNativeTransaction?.() ?? null,
      };
      const funds = await alice.handle.getContractCallFunds!();
      results.unfreeze = {
        mainNonceOnChain: await mainNonce(stack, alice),
        before,
        afterOneLook: {
          mainBusy: funds.mainBusy,
          notIncluded: rows(),
          unresolved: alice.handle.getUnresolvedNativeTransaction?.() ?? null,
        },
      };
      say("unfreeze", JSON.stringify(results.unfreeze, null, 1));
    };

    // The phases, in the order asked for. One that throws is reported and the rest still run.
    const run: Record<string, () => Promise<void>> = {
      a: runA,
      b: runB,
      d: runD,
      e: runE,
      f: runF,
      h: runH,
      r: runR,
      w: runW,
      m: runM,
      n: runN,
      s: runS,
      t: runT,
      unfreeze: runUnfreeze,
    };
    for (const phase of phases) {
      if (!run[phase]) continue;
      try {
        await run[phase]();
      } catch (error) {
        results[`${phase} FAILED`] =
          error instanceof Error ? error.stack ?? error.message : String(error);
        (verdicts[phase] ??= []).push(
          `it threw: ${error instanceof Error ? error.message : String(error)}`
        );
        say(phase, "FAILED", results[`${phase} FAILED`]);
        // Let whatever it left in flight be decided before the next phase signs.
        await sleep(5000);
      }
    }

    // ---- g -----------------------------------------------------------------------------
    if (costOfMainPaid !== undefined)
      results.g = {
        mainPaidMessageCostWei: costOfMainPaid.toString(),
        mainPaidMessageCost: mon(costOfMainPaid),
        ofWhichStamp: mon(floor),
        oldCostQuoted: "about 0.0157 MON",
      };
  } finally {
    // The sweep is a plain transfer too: let Monad's three-block spacing pass first.
    await sleep(3000);
    const address = stack.fundingAddress;
    const rpcUrl = stack.rpcUrl;
    // Read now: a stack on a throwaway chain removes its state when it stops.
    const relayLines = relayLog?.();
    // The harness returns what is left, prints the one funds line, and stops.
    await stack.finish();
    if (address) {
      const { JsonRpcProvider } = await import("ethers");
      const reader = new JsonRpcProvider(rpcUrl.split(",")[0]);
      const after = await reader.getBalance(address);
      reader.destroy();
      say("RESULTS", JSON.stringify(results, null, 1));
      if (relayLines !== undefined) {
        const notBroadcast = relayLines.filter((line) =>
          /payment not broadcast/i.test(line)
        );
        say(
          `relay log: ${notBroadcast.length} "payment not broadcast" line(s)${
            notBroadcast.length > 0 ? `: ${notBroadcast[0].slice(0, 300)}` : ""
          }`
        );
        // Phase n hands the relay a payment the node refuses, on purpose; nothing else may.
        (verdicts["relay log"] ??= []).push(
          ...(notBroadcast.length <= (phases.includes("n") ? 1 : 0)
            ? []
            : [`${notBroadcast.length} payments the relay could not broadcast`])
        );
      }
      for (const [phase, failed] of Object.entries(verdicts))
        say(
          `VERDICT ${phase}: ${
            failed.length === 0 ? "OK" : `FAILED: ${failed.join("; ")}`
          }`
        );
      if (Object.values(verdicts).some((failed) => failed.length > 0))
        process.exitCode = 1;
      say(
        `the test wallet spent ${mon(fundingBefore - after)} in all (before ${mon(
          fundingBefore
        )}, after ${mon(after)})`
      );
    }
  }
}

/** Phase e's other process: opens alice against the running relay, sends one paid message, and
 * is killed the moment the relay's answer to it has arrived, before the wallet can act on it. */
async function killedAfterDelivered() {
  const stack = await startStack({ relayUrl: process.env.PSEND_RELAY! });
  const alice = await stack.openWallet(process.env.PSEND_LABEL ?? "alice");
  const tap = intercept(alice);
  tap.onNext(async (send, init) => {
    const response = await send();
    const chunks: Uint8Array[] = [];
    const reader = response.body?.getReader();
    for (;;) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      if (chunk.value) chunks.push(chunk.value);
    }
    const request = restoreCanonicalRequest({
      body: new Uint8Array(init.body!),
      contentType: init.headers["Content-Type"],
    });
    writeFileSync(
      process.env.PSEND_NOTE!,
      JSON.stringify({
        digest: request.identity.payload_hash,
        rawTx: hexlify(request.parts.transactions[0]),
        relayStatus: response.status,
        relayAnswer: Buffer.concat(chunks).toString("utf8").slice(0, 200),
      })
    );
    // The relay has answered. The wallet has not seen the answer and has broadcast nothing.
    process.kill(process.pid, "SIGKILL");
    await sleep(60_000);
    return response;
  }, true);
  await alice.chain.directMessages.send({
    wallet: alice.handle,
    recipient: { raw: process.env.PSEND_TO! },
    items: [{ type: "text", text: `e killed ${Date.now()}` }],
    messageId: randomUUID(),
    // Named, at the fee floor: never the configured default.
    stampValue: await alice.chain.directMessages.minimumStamp!({
      wallet: alice.handle,
    }),
  });
}

if (require.main === module) {
  (process.env.PSEND_CHILD === "kill-after-delivered"
    ? killedAfterDelivered()
    : main()
  ).then(
    () => process.exit(Number(process.exitCode ?? 0)),
    (error) => {
      console.error("run failed:", error instanceof Error ? error.stack : error);
      process.exit(1);
    }
  );
}
