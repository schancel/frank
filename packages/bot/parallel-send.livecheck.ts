/**
 * The parallel-send rewrite against the real relay binary and Monad testnet. Real wallets, real
 * transfers; nothing is simulated except where a phase says what it stands between (one HTTP
 * answer dropped, one request's boundary broken, one process killed). Not part of CI: it spends
 * testnet funds and takes minutes.
 *
 *   CASHWEBD_BIN=<relay built from the tree under test> FRANK_TEST_WALLET_JSON=<funded test wallet> \
 *   FRANK_DEMO_ENV_FILE=<repo .env> yarn tsx parallel-send.livecheck.ts
 *
 *   PHASES=a,d,e,f,b   which phases, in this order (also: inspect, review)
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
 */
import { createHash, randomUUID } from "crypto";
import { spawn } from "child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Transaction, formatEther, hexlify } from "ethers";
import {
  defaultCanonicalFetch,
  restoreCanonicalRequest,
  type CanonicalFetch,
} from "@frank/cashweb/relay/canonical-dm-transport";
import { installCanonicalDirectory } from "@frank/wallet/chain/monad-chain";
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
    if (record && next) {
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
    onNext(act: NonNullable<typeof next>) {
      next = act;
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

const mainNonce = (stack: RealStack, wallet: RealWallet) =>
  stack.provider.getTransactionCount(wallet.mainAccount, "latest");
const heldBy = (wallet: RealWallet, address: string) =>
  wallet.handle.pool.accountClaimedBy(address) ?? "nobody";

/** Makes sure alice's main account holds at least `wei`, from the test wallet. */
async function ensureMain(stack: RealStack, alice: RealWallet, wei: bigint) {
  const has = await stack.provider.getBalance(alice.mainAccount);
  if (has >= wei) return;
  const tx = await stack.fund(alice.mainAccount, wei - has);
  say(`funded alice's main account with ${mon(wei - has)} (${tx})`);
}

async function main() {
  const phases = (process.env.PHASES ?? "a,d,e,f,b").split(",");
  const funded = Number(process.env.FUNDED ?? "3");
  const messages = Number(process.env.MESSAGES ?? "10");
  const budget = BigInt(process.env.BUDGET_WEI ?? "100000000000000000");
  const stack = await startRealStack();
  const results: Record<string, unknown> = {};
  const provider = stack.provider;
  const fundingBefore = stack.fundingAddress
    ? await provider.getBalance(stack.fundingAddress)
    : 0n;
  // SENDER names the persistent wallet that sends (and is called alice below); the other one
  // of the pair receives.
  const senderLabel = process.env.SENDER === "bob" ? "bob" : "alice";
  let alice = await stack.openWallet(senderLabel);
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
    if (
      phases.includes("a") &&
      (await affordable("a", BigInt(messages) * (floor + txFee) + txFee))
    ) {
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
    }

    // ---- b -----------------------------------------------------------------------------
    const runB = async () => {
      const reserve = 21_000n * (fee.maxFeePerGas ?? gasPrice);
      const each = floor + reserve + reserve / 100n;
      if (
        funded <= 0 ||
        !(await affordable("b", BigInt(funded) * (each + txFee)))
      )
        return;
      const before = alice.handle.pool.records().length;
      const targets = alice.handle.pool
        .ensureSize(before + funded)
        .slice(before);
      await alice.handle.pool.flush();
      const fundingStarted = Date.now();
      for (const row of targets) await stack.fund(row.address, each);
      const fundingMs = Date.now() - fundingStarted;
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
    };

    if (phases.includes("b") && phases.indexOf("b") < phases.indexOf("d"))
      await runB();

    // ---- d -----------------------------------------------------------------------------
    // Two messages at most: the one after the refusal, and the refused one itself should the
    // relay turn out not to refuse it for good (it is then delivered by the resend pass).
    if (phases.includes("d") && (await affordable("d", 2n * (floor + txFee)))) {
      const withNative = process.env.D_NATIVE !== "0";
      await ensureMain(
        stack,
        alice,
        perMessage + (floor + txFee) + (withNative ? txFee : 0n) + floor
      );
      const nonce0 = await mainNonce(stack, alice);
      // d1: no directory entry. Refused before anything is claimed or signed.
      const nobody = "0x" + "d1".repeat(20);
      const d1 = await sendPaid(alice, nobody, "to nobody").then(
        () => "SENT (unexpected)",
        (error) => `${(error as Error).name}: ${(error as Error).message}`
      );
      const heldAfterD1 = heldBy(alice, alice.mainAccount);
      // d2: a signed, stored message whose request the relay cannot read (its multipart
      // boundary is replaced on the way out, this once): the relay refuses the request.
      let refusal: { status?: number; body?: string } = {};
      tap.onNext(async (_send, init, url) => {
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
      });
      const d2Started = Date.now();
      const d2 = await sendPaid(alice, bob.address, "refused outright").then(
        (sent) => `SENT ${sent.digest} (${sent.how})`,
        (error) => `${(error as Error).name}: ${(error as Error).message}`
      );
      const refused = tap.submitted[tap.submitted.length - 1];
      const heldAfterD2 = heldBy(alice, alice.mainAccount);
      const refusedPayment = refused?.rawTransactions[0]
        ? Transaction.from(refused.rawTransactions[0])
        : undefined;
      // At once: a normal paid send and a native send.
      const after = Date.now();
      const paid = await sendPaid(alice, bob.address, `d after ${after}`);
      const paidMs = Date.now() - after;
      const nativeStarted = Date.now();
      const native = withNative
        ? await sendNativeReported(
            stack,
            alice,
            bob.mainAccount,
            1_000_000_000_000n
          )
        : undefined;
      void nativeStarted;
      await settle(alice, [paid.digest]);
      const paidOnChain = await onChain(
        stack,
        tap.of(paid.digest)[0].rawTransactions[0]
      );
      results.d = {
        d1,
        mainHeldAfterD1: heldAfterD1,
        d2,
        d2Ms: after - d2Started,
        relayAnswerToBrokenRequest: refusal.status,
        refusedPaymentNonce: refusedPayment?.nonce,
        refusedPaymentState: refused
          ? alice.chain.directMessages.paymentsOf?.({
              wallet: alice.handle,
              payloadDigest: refused.digest,
            })
          : undefined,
        refusedPaymentOnChain: refusedPayment
          ? (await provider.getTransactionReceipt(refusedPayment.hash!)) !== null
          : undefined,
        mainHeldAfterD2: heldAfterD2,
        nextPaidSendMs: paidMs,
        nextPaidSendNonce: paidOnChain.nonce,
        nextPaidSendMined: paidOnChain.status === 1,
        native: native ?? "not sent (D_NATIVE=0)",
        mainNonceBefore: nonce0,
        mainNonceAfter: await mainNonce(stack, alice),
      };
      say("d", JSON.stringify(results.d, null, 1));
    }

    // ---- e -----------------------------------------------------------------------------
    if (phases.includes("e") && (await affordable("e", floor + txFee))) {
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
      alice = await stack.openWallet(senderLabel);
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
    }

    // ---- f -----------------------------------------------------------------------------
    if (phases.includes("f")) {
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
    }

    if (
      phases.includes("b") &&
      !(phases.includes("d") && phases.indexOf("b") < phases.indexOf("d"))
    )
      await runB();

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
    const returned = await stack.sweep().catch((error) => {
      say("sweep failed:", error instanceof Error ? error.message : error);
      return 0n;
    });
    say("returned to the test wallet:", mon(returned));
    const address = stack.fundingAddress;
    const rpcUrl = stack.rpcUrl;
    await stack.stop();
    if (address) {
      const { JsonRpcProvider } = await import("ethers");
      const reader = new JsonRpcProvider(rpcUrl.split(",")[0]);
      const after = await reader.getBalance(address);
      reader.destroy();
      say("RESULTS", JSON.stringify(results, null, 1));
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
  const stack = await startRealStack({ relayUrl: process.env.PSEND_RELAY! });
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
  });
  await alice.chain.directMessages.send({
    wallet: alice.handle,
    recipient: { raw: process.env.PSEND_TO! },
    items: [{ type: "text", text: `e killed ${Date.now()}` }],
    messageId: randomUUID(),
  });
}

if (require.main === module) {
  (process.env.PSEND_CHILD === "kill-after-delivered"
    ? killedAfterDelivered()
    : main()
  ).then(
    () => process.exit(0),
    (error) => {
      console.error("run failed:", error instanceof Error ? error.stack : error);
      process.exit(1);
    }
  );
}
