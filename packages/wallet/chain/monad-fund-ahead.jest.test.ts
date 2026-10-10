/**
 * #1235 Q4: the next message's sender accounts are funded ahead of it, through the recorded
 * funding path. A send itself never funds: it pays from the funded accounts when they cover the
 * stamp, and otherwise makes one payment from the main account.
 *
 * `DirectMessageClient.fundAhead` does not exist on main 8c656f32: every test here fails there for
 * that reason unless it says it is a pin. Real typed custody, real Level stores, real directory
 * admission, real sealing and real stamp funding, from the shared two-wallet fixture
 * (`canonical-two-wallets.testutil.ts`); only the chain RPC, the chain HTTP client and the relay's
 * HTTP surface are stand-ins. The stand-in chain mines a submitted transfer at once.
 */
// First: the mock factories below load this file while the wallet modules are still loading.
import {
  chainHttpRequests,
  fixture,
  mailboxes,
  mockBalances,
  mockFunded,
  offlineChain,
  providerRequests,
  type Fixture,
  type InboxRecord,
} from "./canonical-two-wallets.testutil";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Transaction, getBytes, hexlify } from "ethers";
import { restoreCanonicalRequest } from "@frank/cashweb/relay/canonical-dm-transport";
import { toHex } from "@frank/codec";
import domainVectors from "../../domain-roots/vectors/domain-roots-v1.json";
import type { MonadRootBundle } from "../monad-wallet-material";
import type { EvmChainWalletHandle } from "../evm-wallet-handle";
import { MonadAccountTxSigner } from "../monad-account-tx";
import {
  FUND_AHEAD_RECEIPT_WAIT_MS,
  MonadSubAccountPool,
} from "../monad-account-pool";
import { MonadStampPendingAttemptError } from "../monad-stamp-client";
import type { CanonicalDirectory } from "./monad-canonical-dm";
import { FUND_AHEAD_MESSAGES } from "./active-chain";
import {
  FUND_AHEAD_BACKOFF_MAX_MS,
  FUND_AHEAD_BACKOFF_MIN_MS,
  installCanonicalDirectory,
  prepareCanonicalStampInventory,
} from "./monad-chain";

jest.mock("../monad-provider", () =>
  require("./canonical-two-wallets.testutil").offlineProviderModule()
);
// The shared stand-in remembers what it mined for the life of the module, and these wallets sign
// the same first transfer in every test. This one forgets between tests (`mockMined`).
const mockMined = new Set<string>();
jest.mock("../monad-http", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ethers = require("ethers");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const shared = require("./canonical-two-wallets.testutil");
  return {
    ...jest.requireActual("../monad-http"),
    MonadHttpClient: class {
      async submitRawTransaction(raw: string) {
        shared.chainHttpRequests.push("submitRawTransaction");
        const tx = ethers.Transaction.from(raw);
        const to = tx.to.toLowerCase(),
          from = tx.from.toLowerCase();
        shared.mockBalances.set(
          to,
          (shared.mockBalances.get(to) ?? 0n) + tx.value
        );
        shared.mockBalances.set(
          from,
          (shared.mockBalances.get(from) ?? 0n) - tx.value
        );
        shared.mockFunded.push({ from, to, value: tx.value });
        mockMined.add(tx.hash);
        return tx.hash;
      }
      async getTransactionReceipt(hash: string) {
        shared.chainHttpRequests.push("getTransactionReceipt");
        return mockMined.has(hash) ? { status: "success" } : undefined;
      }
      destroy() {
        return undefined;
      }
    },
  };
});
jest.mock("@frank/cashweb/relay/monad-mailbox-client", () =>
  require("./canonical-two-wallets.testutil").offlineMailboxModule()
);

function roots(index: number): MonadRootBundle {
  const outputs = domainVectors.vectors[index].outputs;
  const root = <
    P extends "evm-wallet" | "identity-authentication" | "messaging-encryption"
  >(
    purpose: P
  ) => ({
    registry: "frank-domain-roots-v1" as const,
    purpose,
    bytes: getBytes(`0x${outputs[purpose]}`),
  });
  return {
    evm: root("evm-wallet"),
    authentication: root("identity-authentication"),
    messaging: root("messaging-encryption"),
  };
}

/** The production default stamp value, and the fee one payment keeps back on the stand-in chain:
 * 21,000 gas at its fee cap of 3 wei. A funded account is given exactly that. */
const STAMP = 10n ** 16n;
const RESERVE = 21_000n * 3n;
const SMALL = (STAMP * 3n) / 8n;
const LARGE = STAMP - SMALL;

describe("funding the next message ahead (#1235 Q4)", () => {
  jest.setTimeout(120_000);
  let f: Fixture;
  let alice: EvmChainWalletHandle;
  let directory: CanonicalDirectory;
  let main: string;
  /** Requests the wallet had made when its payment set first reached the relay. */
  let atRelay: { rpc: string[]; chainHttp: string[] } | undefined;
  /** Every request the relay was handed, in order. */
  let relayBodies: { body: Uint8Array; contentType: string }[];

  beforeEach(async () => {
    // These wallets derive the same accounts in every test: a payment mined in one test must not
    // read as a consumed nonce in the next.
    offlineChain.reset();
    mockBalances.clear();
    mockFunded.length = 0;
    mailboxes.clear();
    providerRequests.length = 0;
    chainHttpRequests.length = 0;
    atRelay = undefined;
    relayBodies = [];
    mockMined.clear();
    f = await fixture({ defaultStampValueWei: STAMP });
    alice = f.alice;
    main = (await alice.getReceiveAddress()).raw.toLowerCase();
    const base = await f.directoryFor("alice", f.alice, f.bob);
    directory = {
      ...base,
      fetch: async (url, init) => {
        atRelay ??= {
          rpc: [...providerRequests],
          chainHttp: [...chainHttpRequests],
        };
        relayBodies.push({
          body: new Uint8Array(init.body!),
          contentType: init.headers["Content-Type"],
        });
        return base.fetch!(url, init);
      },
    };
    installCanonicalDirectory(alice, directory);
    const bobInbox: InboxRecord[] = [];
    mailboxes.set(toHex(f.bob.identity.compressedPubKey), bobInbox);
    f.setMailbox(bobInbox);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    clockOffsetMs = 0;
    const now = Date.now.bind(Date);
    jest.spyOn(Date, "now").mockImplementation(() => now() + clockOffsetMs);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await alice.close().catch(() => undefined);
    await f.close().catch(() => undefined);
  });

  /** The wallet's clock, moved forward without waiting. */
  let clockOffsetMs = 0;
  const later = (ms: number) => void (clockOffsetMs += ms);
  const fundAhead = (wallet: EvmChainWalletHandle = alice) =>
    f.chain.directMessages.fundAhead!({ wallet });
  const send = (text: string) =>
    f.chain.directMessages.send({
      wallet: alice,
      recipient: f.bob.identity.address,
      items: [{ type: "text", text }],
    });
  /** Closes the file-backed wallet and opens it again from its storage: a real restart. */
  async function reopen() {
    await alice.close().catch(() => undefined);
    alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle;
    installCanonicalDirectory(alice, directory);
  }
  const rows = (status: string) =>
    alice.pool.records().filter((record) => record.status === status);
  /** Funded accounts a message holds: still `available` on disk until the chain shows its payment. */
  const held = () =>
    rows("available").filter(
      (record) => alice.pool.claimedBy(record.index) !== undefined
    );
  /** Senders of the payments in the n-th request the relay was handed. */
  const payersAtRelay = (index: number) =>
    restoreCanonicalRequest(relayBodies[index]).parts.transactions.map((raw) =>
      Transaction.from(hexlify(raw)).from!.toLowerCase()
    );
  /** The background pass: learns from the chain which payments landed. */
  const tick = () =>
    f.chain.directMessages.reconcileAttempts({
      wallet: alice,
      payloadDigests: [],
    });
  const requests = () => providerRequests.length + chainHttpRequests.length;
  const transfersTo = (address: string) =>
    mockFunded.filter((tx) => tx.to === address.toLowerCase());
  /** One pair, each account funded by exactly one transfer, and no transfer besides. */
  function expectOnePairFundedOnce() {
    const funded = rows("available");
    expect(funded).toHaveLength(2);
    expect(mockFunded).toHaveLength(2);
    for (const record of funded)
      expect(transfersTo(record.address)).toHaveLength(1);
    expect(mockFunded.map((tx) => tx.value).sort()).toEqual([
      SMALL + RESERVE,
      LARGE + RESERVE,
    ]);
    expect(rows("funding")).toEqual([]);
  }

  it("funds exactly the pair one message needs; the send that follows pays from that pair, while a send with nothing funded makes one payment from the main account; neither makes a funding transaction", async () => {
    expect(FUND_AHEAD_MESSAGES).toBe(1);
    // A send with nothing funded: one payment of the whole stamp from the main account.
    const plain = await send("pays from the main account");
    expect(plain.preparationTxHashes).toEqual([]);
    expect(mockFunded).toEqual([]);
    expect(plain.stampPayments.map((p) => p.valueWei)).toEqual([STAMP]);
    expect(payersAtRelay(0)).toEqual([main]);
    expect(atRelay!.chainHttp).toEqual([]);
    expect(alice.pool.records()).toEqual([]);
    // The send looked at the chain once after its own broadcast: the payment is in a block
    // (the relay stand-in mines it), so the main account is free for the next payment already.
    expect(alice.pool.accountClaimedBy(main)).toBeUndefined();

    const ahead = await fundAhead();
    expect(ahead.outcome).toBe("funded");
    expect(ahead.fundingTxHashes).toHaveLength(2);
    expect(mockFunded.map((tx) => [tx.from, tx.value])).toEqual([
      [main, SMALL + RESERVE],
      [main, LARGE + RESERVE],
    ]);
    expect(
      rows("available").map((record) => record.address.toLowerCase())
    ).toEqual(mockFunded.map((tx) => tx.to));

    providerRequests.length = 0;
    chainHttpRequests.length = 0;
    atRelay = undefined;
    // Past the few seconds a fee quote is remembered for: this send quotes its own.
    later(10_000);
    const sent = await send("finds its accounts ready");

    // No funding transaction, no receipt read, no funding-related request at all.
    expect(sent.preparationTxHashes).toEqual([]);
    expect(mockFunded).toHaveLength(2);
    expect(atRelay!.chainHttp).toEqual([]);
    expect(
      atRelay!.rpc.filter(
        (name) => name === "estimateGas" || name === "getTransactionCount"
      )
    ).toEqual([]);
    expect(sent.stampPayments.reduce((sum, p) => sum + p.valueWei, 0n)).toBe(
      STAMP
    );
    expect(sent.stampPayments).toHaveLength(2);
    // Paid by the funded pair, not by the main account.
    expect(payersAtRelay(1).sort()).toEqual(mockFunded.map((tx) => tx.to).sort());
    expect(alice.pool.accountClaimedBy(main)).toBeUndefined();
    // Both accounts are that message's: nothing funded is left free, and both are spent once
    // the chain shows the payments.
    expect(held()).toHaveLength(2);
    await tick();
    expect(rows("available")).toEqual([]);
    expect(rows("spent")).toHaveLength(2);
    // Before its relay request the pre-funded send only quotes the fee.
    expect(new Set(atRelay!.rpc)).toEqual(
      new Set(["getBlock", "getGasPrice", "getPriorityFee"])
    );
  });

  it("repeated and concurrent calls fund nothing extra, and a call that finds the accounts ready makes no request", async () => {
    const together = await Promise.all([fundAhead(), fundAhead(), fundAhead()]);
    expect(together.map((result) => result.outcome)).toEqual([
      "funded",
      "funded",
      "funded",
    ]);
    // One pass answered all three.
    expect(
      new Set(together.map((result) => result.fundingTxHashes.join())).size
    ).toBe(1);
    expectOnePairFundedOnce();

    providerRequests.length = 0;
    chainHttpRequests.length = 0;
    for (let i = 0; i < 20; i++)
      expect(await fundAhead()).toEqual({
        outcome: "ready",
        fundingTxHashes: [],
      });
    expect(requests()).toBe(0);
    expectOnePairFundedOnce();
    // Positive control: the counters see a wallet request.
    await alice.getBalance();
    expect(requests()).toBeGreaterThan(0);
  });

  it("a pass racing a send funds one pair between them", async () => {
    const [ahead, sent] = await Promise.all([fundAhead(), send("racing")]);
    expect(ahead.outcome).toBe("funded");
    expect(sent.preparationTxHashes).toEqual([]);
    expect(mockFunded).toHaveLength(2);
    expect(new Set(mockFunded.map((tx) => tx.to)).size).toBe(2);
  });

  it("moves at most two transfers and the stamp value plus two fee reserves in one call, and nothing when the main account cannot pay", async () => {
    const before = mockBalances.get(main)!;
    await fundAhead();
    expect(mockFunded).toHaveLength(2);
    expect(before - mockBalances.get(main)!).toBe(STAMP + 2n * RESERVE);

    // A wallet with nothing in its main account: one balance read, nothing signed.
    const bob = f.bob;
    mockBalances.set((await bob.getReceiveAddress()).raw.toLowerCase(), 0n);
    const sign = jest.spyOn(
      MonadAccountTxSigner.prototype,
      "buildAndSignTransfer"
    );
    providerRequests.length = 0;
    chainHttpRequests.length = 0;
    expect(await fundAhead(bob)).toEqual({
      outcome: "not-funded",
      fundingTxHashes: [],
      reason: "insufficient-funds",
    });
    expect(providerRequests).toEqual(["getBalance"]);
    expect(chainHttpRequests).toEqual([]);
    expect(sign).not.toHaveBeenCalled();
    expect(mockFunded).toHaveLength(2);
  });

  it("a fee reserve above the ceiling, or a transfer costing more than it moves, moves nothing", async () => {
    const pass = jest.spyOn(
      MonadSubAccountPool.prototype,
      "fundStampInventoryAhead"
    );
    // The stand-in chain quotes 3 wei per gas. At 10^12 the reserve is far above the ceiling.
    const fee = jest.spyOn(alice.provider, "getFeeData").mockResolvedValue({
      gasPrice: null,
      maxFeePerGas: 10n ** 12n,
      maxPriorityFeePerGas: 1n,
    } as never);
    expect(await fundAhead()).toMatchObject({
      outcome: "not-funded",
      reason: "over-bound",
    });
    // The limit the pass was given: the stamp value plus two reserves of at most that value.
    expect(pass.mock.calls[0]![0].maxValueWei).toBe(3n * STAMP);
    fee.mockRestore();
    // Past the wait the refused pass earned (see the backoff tests below).
    later(FUND_AHEAD_BACKOFF_MIN_MS);

    // A transfer whose own fee cap exceeds its value: refused after signing, before any write.
    const sign = jest
      .spyOn(MonadAccountTxSigner.prototype, "buildAndSignTransfer")
      .mockImplementation(async function (
        this: MonadAccountTxSigner,
        to: string,
        value: bigint
      ) {
        const signed = await (
          this as unknown as {
            buildAndSign: MonadAccountTxSigner["buildAndSignCall"];
          }
        ).buildAndSign(to, value, "0x", {
          maxFeePerGas: value,
          gasLimit: 21_000n,
        });
        return signed;
      });
    expect(await fundAhead()).toMatchObject({
      outcome: "not-funded",
      reason: "uneconomic",
    });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(mockFunded).toEqual([]);
    expect(rows("funding")).toEqual([]);
    expect(rows("available")).toEqual([]);
  });

  it("never funds or counts the accounts a pending message holds", async () => {
    // A message the relay retained: the two funded accounts it pays from stay claimed by it.
    expect((await fundAhead()).outcome).toBe("funded");
    f.setPhase("retained");
    await expect(send("held")).rejects.toBeInstanceOf(
      MonadStampPendingAttemptError
    );
    const claimed = structuredClone(held());
    expect(claimed).toHaveLength(2);
    const holders = claimed.map((record) => alice.pool.claimedBy(record.index));
    mockFunded.length = 0;

    expect((await fundAhead()).outcome).toBe("funded");

    expect(mockFunded).toHaveLength(2);
    for (const [i, record] of claimed.entries()) {
      expect(transfersTo(record.address)).toEqual([]);
      expect(alice.pool.getRecord(record.index)).toEqual(record);
      expect(alice.pool.claimedBy(record.index)).toBe(holders[i]);
    }
    // Two more funded accounts, free for the next message, beside the two that are held.
    expect(rows("available")).toHaveLength(4);
    expect(held()).toHaveLength(2);
  });

  it("fees rose after the accounts were funded ahead: the send pays from the main account instead of failing, and funds nothing", async () => {
    await fundAhead();
    expect(mockFunded).toHaveLength(2);
    // 21,000 gas at 10 wei is more than the reserve either account was funded with.
    jest.spyOn(alice.provider, "getFeeData").mockResolvedValue({
      gasPrice: null,
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 1n,
    } as never);

    const sent = await send("after a fee rise");

    expect(sent.preparationTxHashes).toEqual([]);
    expect(mockFunded).toHaveLength(2);
    expect(sent.stampPayments.map((p) => p.valueWei)).toEqual([STAMP]);
    expect(payersAtRelay(0)).toEqual([main]);
    // The funded pair was not touched.
    expect(rows("available")).toHaveLength(2);
    expect(held()).toEqual([]);
  });

  it("rejects for a closed wallet", async () => {
    await alice.close();
    await expect(fundAhead()).rejects.toThrow("closed");
    expect(mockFunded).toEqual([]);
  });

  describe("wallet open", () => {
    it("makes no request and funds nothing, with a funded main account, an empty inventory and a recorded transfer waiting", async () => {
      // A recorded transfer the last session never submitted.
      jest
        .spyOn(alice.httpClient, "submitRawTransaction")
        .mockRejectedValueOnce(new Error("fixture: stopped before the submit"));
      expect((await fundAhead()).outcome).toBe("not-funded");
      expect(rows("funding")).toHaveLength(1);
      const pass = jest.spyOn(
        MonadSubAccountPool.prototype,
        "fundStampInventoryAhead"
      );
      const prepare = jest.spyOn(
        MonadSubAccountPool.prototype,
        "prepareStampInventory"
      );
      const sign = jest.spyOn(
        MonadAccountTxSigner.prototype,
        "buildAndSignTransfer"
      );
      providerRequests.length = 0;
      chainHttpRequests.length = 0;

      await reopen();
      await new Promise((resolve) => setImmediate(resolve));

      expect(providerRequests).toEqual([]);
      expect(chainHttpRequests).toEqual([]);
      expect(pass).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
      expect(mockFunded).toEqual([]);
      expect(rows("funding")).toHaveLength(1);

      // Positive control: asked explicitly, the same wallet does make requests and does fund.
      expect((await fundAhead()).outcome).toBe("funded");
      expect(requests()).toBeGreaterThan(0);
      expectOnePairFundedOnce();
    });
  });

  describe("stopped part way, with the file-backed wallet closed and reopened", () => {
    it("after the transfer is recorded and before it is submitted: the next call submits those bytes, and no second transfer is made for that account", async () => {
      jest
        .spyOn(alice.httpClient, "submitRawTransaction")
        .mockRejectedValueOnce(new Error("fixture: stopped before the submit"));
      expect(await fundAhead()).toMatchObject({ outcome: "not-funded" });
      const [recorded] = rows("funding");
      expect(recorded.fundingAttempt).toBeDefined();
      expect(mockFunded).toEqual([]);

      await reopen();
      expect(rows("funding")).toEqual([recorded]);
      const submit = jest.spyOn(alice.httpClient, "submitRawTransaction");
      const result = await fundAhead();

      expect(result.outcome).toBe("funded");
      expect(result.fundingTxHashes[0]).toBe(recorded.fundingAttempt!.txHash);
      expect(submit.mock.calls[0]![0]).toBe(recorded.fundingAttempt!.rawTx);
      expectOnePairFundedOnce();
    });

    it("after the submit and before the receipt: the next call reads the receipt and submits nothing for that account", async () => {
      jest
        .spyOn(alice.httpClient, "getTransactionReceipt")
        .mockRejectedValueOnce(
          new Error("fixture: stopped before the receipt")
        );
      expect(await fundAhead()).toMatchObject({ outcome: "not-funded" });
      const [recorded] = rows("funding");
      expect(mockFunded.map((tx) => tx.to)).toEqual([
        recorded.address.toLowerCase(),
      ]);

      await reopen();
      const submit = jest.spyOn(alice.httpClient, "submitRawTransaction");
      const result = await fundAhead();

      expect(result.fundingTxHashes[0]).toBe(recorded.fundingAttempt!.txHash);
      expect(
        submit.mock.calls.map(([raw]) =>
          Transaction.from(raw).to!.toLowerCase()
        )
      ).not.toContain(recorded.address.toLowerCase());
      expectOnePairFundedOnce();
    });

    it("after the receipt and before the row is marked available: the row is funding on disk, and the next call marks it without a transfer", async () => {
      // The receipt is read; every pool write after it fails, as if the process had stopped.
      const flush = jest.spyOn(alice.pool, "flush");
      const store = (
        alice.pool as unknown as {
          store: { put: (record: unknown) => void; flush: () => Promise<void> };
        }
      ).store;
      const put = store.put.bind(store);
      let stopped = false;
      jest.spyOn(store, "put").mockImplementation((record) => {
        if (stopped) throw new Error("fixture: stopped before the write");
        put(record);
      });
      const receipt = alice.httpClient.getTransactionReceipt.bind(
        alice.httpClient
      );
      jest
        .spyOn(alice.httpClient, "getTransactionReceipt")
        .mockImplementationOnce(async (hash) => {
          stopped = true;
          return receipt(hash);
        });
      expect(await fundAhead()).toMatchObject({ outcome: "not-funded" });
      expect(flush).toBeDefined();
      expect(mockFunded).toHaveLength(1);
      const child = mockFunded[0]!.to;

      await reopen();
      const [recorded] = rows("funding");
      expect(recorded.address.toLowerCase()).toBe(child);
      const submit = jest.spyOn(alice.httpClient, "submitRawTransaction");
      const result = await fundAhead();

      expect(result.fundingTxHashes[0]).toBe(recorded.fundingAttempt!.txHash);
      expect(
        submit.mock.calls.map(([raw]) =>
          Transaction.from(raw).to!.toLowerCase()
        )
      ).not.toContain(child);
      expectOnePairFundedOnce();
    });

    it("during a second call: both calls end with the first one's stop, and the next call finishes that transfer", async () => {
      let entered!: () => void;
      const inSubmit = new Promise<void>((resolve) => (entered = resolve));
      let stop!: () => void;
      const stopping = new Promise<void>((resolve) => (stop = resolve));
      jest
        .spyOn(alice.httpClient, "submitRawTransaction")
        .mockImplementationOnce(async () => {
          entered();
          await stopping;
          throw new Error("fixture: stopped during the submit");
        });
      const first = fundAhead();
      await inSubmit;
      const second = fundAhead();
      stop();
      expect((await first).outcome).toBe("not-funded");
      expect((await second).outcome).toBe("not-funded");
      const [recorded] = rows("funding");
      expect(mockFunded).toEqual([]);

      await reopen();
      const results = await Promise.all([fundAhead(), fundAhead()]);

      expect(results[0]!.fundingTxHashes[0]).toBe(
        recorded.fundingAttempt!.txHash
      );
      expectOnePairFundedOnce();
    });

    it("the next SEND does not touch a recorded transfer: it pays from the main account, and the next call finishes the transfer", async () => {
      jest
        .spyOn(alice.httpClient, "submitRawTransaction")
        .mockRejectedValueOnce(new Error("fixture: stopped before the submit"));
      await fundAhead();
      const [recorded] = rows("funding");

      await reopen();
      const submit = jest.spyOn(alice.httpClient, "submitRawTransaction");
      const sent = await send("after a restart");

      // A send funds nothing and resumes no funding: one payment from the main account.
      expect(sent.preparationTxHashes).toEqual([]);
      expect(submit).not.toHaveBeenCalled();
      expect(mockFunded).toEqual([]);
      expect(payersAtRelay(0)).toEqual([main]);
      expect(rows("funding")).toEqual([recorded]);

      // The chain shows the payment; then the next call finishes the recorded transfer.
      await tick();
      later(FUND_AHEAD_BACKOFF_MAX_MS);
      const result = await fundAhead();
      expect(result.outcome).toBe("funded");
      expect(result.fundingTxHashes[0]).toBe(recorded.fundingAttempt!.txHash);
      expect(submit.mock.calls[0]![0]).toBe(recorded.fundingAttempt!.rawTx);
      expectOnePairFundedOnce();
    });
  });
  // Review of a03ea904. Each test says how it fails there, or that it is a pin.
  describe("only as a pair; one covering account is ready (review of a03ea904)", () => {
    /** One funding transfer on the stand-in chain: 50,000 gas at 3 wei. */
    const FUNDING_FEE = 150_000n;
    /** What a send needs in the main account: the stamp and the fee of its one payment. */
    const ONE_PAYMENT = STAMP + RESERVE;
    /** What funding one whole-stamp account costs the main account. */
    const ONE_ACCOUNT = STAMP + RESERVE + FUNDING_FEE;
    const PAIR = STAMP + 2n * RESERVE + 2n * FUNDING_FEE;

    // On a03ea904 the pass funded ONE account with the whole stamp, the send then asked for a
    // top-up the emptied main account could not pay, and failed on every retry.
    it("a main account that can pay for the stamp but not for a funded pair: the pass funds nothing and the send goes through exactly as without it, one payment from the main account", async () => {
      mockBalances.set(main, ONE_ACCOUNT + 1_000n);
      expect(ONE_ACCOUNT + 1_000n).toBeLessThan(PAIR);

      expect(await fundAhead()).toEqual({
        outcome: "not-funded",
        fundingTxHashes: [],
        reason: "insufficient-funds",
      });
      expect(mockFunded).toEqual([]);
      expect(mockBalances.get(main)).toBe(ONE_ACCOUNT + 1_000n);
      expect(alice.pool.records().every((r) => r.status === "unfunded")).toBe(
        true
      );

      const sent = await send("from the main account");

      expect(sent.preparationTxHashes).toEqual([]);
      expect(mockFunded).toEqual([]);
      expect(sent.stampPayments.map((p) => p.valueWei)).toEqual([STAMP]);
      expect(payersAtRelay(0)).toEqual([main]);
    });

    // Inventory preparation by itself, no pass anywhere: one whole-stamp account was funded and
    // the send did not happen. On a03ea904 (and before this stage) the retry asked for a second
    // account and failed with "Insufficient main account balance".
    it("one whole-stamp account already funded, main account all but empty: the send is ready and funds nothing", async () => {
      mockBalances.set(main, ONE_ACCOUNT);
      const peer = (await directory.peerCurrent({
        address: f.bob.identity.address.raw,
      }))!;
      const funded = await prepareCanonicalStampInventory(alice, {
        stampValueWei: STAMP,
        recipientStampKey: peer.current.stampKey.keyBytes,
      });
      expect(funded).toHaveLength(1);
      // The stand-in chain moves values and charges no fee: what is left is the fee's worth,
      // far short of any second account.
      expect(mockBalances.get(main)).toBe(FUNDING_FEE);
      atRelay = undefined;
      providerRequests.length = 0;
      chainHttpRequests.length = 0;

      const sent = await send("from the one account");

      expect(sent.preparationTxHashes).toEqual([]);
      expect(mockFunded).toHaveLength(1);
      expect(atRelay!.chainHttp).toEqual([]);
      expect(sent.stampPayments.map((p) => p.valueWei)).toEqual([STAMP]);
      const again = await prepareCanonicalStampInventory(alice, {
        stampValueWei: STAMP,
        recipientStampKey: peer.current.stampKey.keyBytes,
      }).catch((error: Error) => error.message);
      // Pin: with that account spent, the all but empty main account cannot fund another.
      expect(again).toContain("Insufficient main account balance");
    });

    // The same question through whole wallets, at the balances where the answer changes.
    it("at every threshold balance: a send that succeeds without a pass succeeds after one", async () => {
      const balances = [
        0n,
        STAMP - 1n,
        ONE_PAYMENT - 1n,
        ONE_PAYMENT,
        ONE_PAYMENT + 1n,
        PAIR - 1n,
        PAIR,
        PAIR + 1n,
        2n * STAMP,
      ];
      // Each attempt opens its own pair of wallets on the same roots.
      await f.close();
      const attempt = async (balance: bigint, withPass: boolean) => {
        offlineChain.reset();
        mockBalances.clear();
        mockFunded.length = 0;
        mockMined.clear();
        const g = await fixture({ defaultStampValueWei: STAMP });
        try {
          installCanonicalDirectory(
            g.alice,
            await g.directoryFor("alice", g.alice, g.bob)
          );
          mockBalances.set(
            (await g.alice.getReceiveAddress()).raw.toLowerCase(),
            balance
          );
          const funded = withPass
            ? (await g.chain.directMessages.fundAhead!({ wallet: g.alice }))
                .fundingTxHashes.length
            : 0;
          const ok = await g.chain.directMessages
            .send({
              wallet: g.alice,
              recipient: g.bob.identity.address,
              items: [{ type: "text", text: "sweep" }],
            })
            .then(
              () => true,
              () => false
            );
          return { ok, funded };
        } finally {
          await g.close();
        }
      };
      const table: Record<string, string> = {};
      for (const balance of balances) {
        const without = await attempt(balance, false);
        const withPass = await attempt(balance, true);
        table[String(balance - STAMP)] = `${without.ok}/${withPass.ok}/${withPass.funded}`;
        expect(without.ok).toBe(balance >= ONE_PAYMENT);
        expect(withPass.ok).toBe(without.ok);
        expect(withPass.funded).toBe(balance >= PAIR ? 2 : 0);
      }
      // The window the review found: a send works, a pass must fund nothing.
      expect(
        Object.values(table).filter((row) => row === "true/true/0")
      ).toHaveLength(3);
    });
  });

  // Review of a03ea904: a call that could fund nothing repeated its whole pass on every tick.
  describe("what a call costs when there is nothing to fund", () => {
    const counts = () => ({
      rpc: providerRequests.length,
      chainHttp: chainHttpRequests.length,
    });
    const clear = () => {
      providerRequests.length = 0;
      chainHttpRequests.length = 0;
    };
    /** Twenty calls, as twenty host ticks inside the wait would make. */
    const twentyTicks = async () => {
      const answers = new Set<string>();
      for (let tick = 0; tick < 20; tick++)
        answers.add(JSON.stringify(await fundAhead()));
      return [...answers];
    };

    it("an unfunded wallet: one balance read, then nothing until the wait ends; the wait doubles and is capped", async () => {
      mockBalances.set(main, 0n);
      clear();
      const first = await fundAhead();
      expect(first.reason).toBe("insufficient-funds");
      expect(providerRequests).toEqual(["getBalance"]);
      expect(chainHttpRequests).toEqual([]);

      clear();
      expect(await twentyTicks()).toEqual([JSON.stringify(first)]);
      expect(counts()).toEqual({ rpc: 0, chainHttp: 0 });

      // On a03ea904 each of these calls read the balance.
      let wait = FUND_AHEAD_BACKOFF_MIN_MS;
      let passes = 0;
      for (; wait < FUND_AHEAD_BACKOFF_MAX_MS; wait *= 2) {
        // A second short of the wait (the test's own running time is real).
        later(wait - 1_000);
        await fundAhead();
        expect(counts()).toEqual({ rpc: passes, chainHttp: 0 });
        later(1_000);
        await fundAhead();
        expect(counts()).toEqual({ rpc: ++passes, chainHttp: 0 });
      }
      // Capped: once at the maximum, a pass runs every maximum, not later.
      for (let i = 0; i < 2; i++) {
        later(FUND_AHEAD_BACKOFF_MAX_MS - 1_000);
        await fundAhead();
        expect(counts().rpc).toBe(passes);
        later(1_000);
        await fundAhead();
        expect(counts().rpc).toBe(++passes);
      }
    });

    it("a pair it cannot afford: one pass, then nothing until the wait ends", async () => {
      mockBalances.set(main, STAMP + 1_000n);
      clear();
      const first = await fundAhead();
      expect(first.reason).toBe("insufficient-funds");
      const pass = counts();
      expect(pass.chainHttp).toBe(0);
      expect(pass.rpc).toBeGreaterThan(1);
      expect(mockFunded).toEqual([]);

      clear();
      expect(await twentyTicks()).toEqual([JSON.stringify(first)]);
      expect(counts()).toEqual({ rpc: 0, chainHttp: 0 });
      later(FUND_AHEAD_BACKOFF_MIN_MS);
      await fundAhead();
      expect(counts()).toEqual(pass);
      // The whole pass: the balance, the fee read, the plan's own estimates, and the one
      // further fee read that decides between a pair and a single account (three requests).
      expect(pass).toEqual({ rpc: 16, chainHttp: 0 });
    });

    it("a transfer the chain has not mined: its bytes are offered again once per wait, with no fee quote, and never on the ticks between", async () => {
      // Accepted by the node, never mined.
      const accept = jest
        .spyOn(alice.httpClient, "submitRawTransaction")
        .mockImplementation(async (raw: string) => {
          chainHttpRequests.push("submitRawTransaction");
          return Transaction.from(raw).hash!;
        });
      expect((await fundAhead()).outcome).toBe("not-funded");
      const [recorded] = rows("funding");
      expect(accept).toHaveBeenCalledTimes(1);

      clear();
      await twentyTicks();
      expect(counts()).toEqual({ rpc: 0, chainHttp: 0 });
      expect(accept).toHaveBeenCalledTimes(1);

      later(FUND_AHEAD_BACKOFF_MIN_MS);
      expect(await fundAhead()).toMatchObject({
        outcome: "not-funded",
        reason: "unresolved-funding",
      });
      // One receipt read, the same bytes again, then the nonce and the balance. No fee quote,
      // no estimate: on a03ea904 this call also made 7 RPC requests for a quote it never used.
      expect(chainHttpRequests).toEqual([
        "getTransactionReceipt",
        "submitRawTransaction",
      ]);
      expect(providerRequests).toEqual(["getTransactionCount", "getBalance"]);
      expect(accept.mock.calls.map(([raw]) => raw)).toEqual([
        recorded.fundingAttempt!.rawTx,
        recorded.fundingAttempt!.rawTx,
      ]);
      clear();
      await twentyTicks();
      expect(counts()).toEqual({ rpc: 0, chainHttp: 0 });
    });

    it("the wait ends when the wallet's own balance read shows the main account grew", async () => {
      mockBalances.set(main, 0n);
      expect((await fundAhead()).reason).toBe("insufficient-funds");
      mockBalances.set(main, 10n * STAMP);
      // Nothing has shown the wallet the new balance yet: still waiting, still no request.
      clear();
      expect((await fundAhead()).outcome).toBe("not-funded");
      expect(counts()).toEqual({ rpc: 0, chainHttp: 0 });

      // The balance read a host makes anyway (the app polls it while the balance is zero).
      alice.invalidateBalanceCache?.();
      expect(await alice.getBalance()).toBeGreaterThanOrEqual(10n * STAMP);

      expect((await fundAhead()).outcome).toBe("funded");
      expectOnePairFundedOnce();
    });

    it("a send that takes the funded accounts ends the wait: the call after it funds the next pair at once", async () => {
      expect((await fundAhead()).outcome).toBe("funded");
      // Ready, and now waiting: the calls after it ask nothing.
      expect(await fundAhead()).toEqual({ outcome: "ready", fundingTxHashes: [] });
      clear();
      await twentyTicks();
      expect(counts()).toEqual({ rpc: 0, chainHttp: 0 });

      const sent = await send("ends the wait");
      expect(sent.stampPayments).toHaveLength(2);
      // The chain shows that message's payments: its accounts are spent, not inventory.
      await tick();
      mockFunded.length = 0;

      expect((await fundAhead()).outcome).toBe("funded");
      expectOnePairFundedOnce();
    });
  });

  // Review of a03ea904: a pass waited the send's full minute for a receipt, holding the wallet.
  it("a receipt that never arrives: the pass ends within its own short wait, the wallet is free, and the next send goes through at once without touching that transfer", async () => {
    const accept = jest
      .spyOn(alice.httpClient, "submitRawTransaction")
      .mockImplementationOnce(async (raw: string) => Transaction.from(raw).hash!);
    const started = performance.now();

    const result = await fundAhead();

    const elapsed = performance.now() - started;
    expect(result.outcome).toBe("not-funded");
    expect(result.reason).toContain("still pending");
    // On a03ea904 this took the default 60 s.
    expect(elapsed).toBeLessThan(FUND_AHEAD_RECEIPT_WAIT_MS + 2_000);
    expect(elapsed).toBeGreaterThan(FUND_AHEAD_RECEIPT_WAIT_MS - 500);
    const [recorded] = rows("funding");
    expect(accept).toHaveBeenCalledTimes(1);
    expect(mockFunded).toEqual([]);

    // Nothing holds the wallet: the send runs now and pays from the main account. A send
    // funds nothing and resumes no funding, so the recorded transfer is as the pass left it.
    const sentAt = performance.now();
    const sent = await send("after a pass that could not wait");

    expect(performance.now() - sentAt).toBeLessThan(2_000);
    expect(sent.preparationTxHashes).toEqual([]);
    expect(sent.stampPayments.map((p) => p.valueWei)).toEqual([STAMP]);
    expect(payersAtRelay(0)).toEqual([main]);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(mockFunded).toEqual([]);
    expect(rows("funding")).toEqual([recorded]);
  });
});

/**
 * After this stage funds reach a sub-account one way: `fundAccount`, which stores the signed
 * transfer before it submits it. The background funder that broadcast first and recorded
 * afterwards is gone, and so is every hook that started it. On main 8c656f32 each name below
 * still appears in a production module.
 */
describe("no unrecorded funding path remains (#1235 Q4)", () => {
  const walletRoot = join(__dirname, "..");
  const repoRoot = join(walletRoot, "..", "..");
  const removed =
    /fanOutFundSubAccounts|\bfundAll\b|fundPoolWithRetry|ProactiveWarming|ensureMinimumAvailableCapacity|EnsureMinimumCapacityParams|activeWarmingPromise|onLeaseReleased|notifyWarming|warmInventory/;
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === "node_modules" || entry.name === "dist") return [];
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.(ts|vue)$/.test(entry.name) ? [path] : [];
    });
  }

  it("in any source file of the wallet, the bots, the bot host or the app", () => {
    const files = [
      walletRoot,
      join(repoRoot, "packages", "bot"),
      join(repoRoot, "packages", "bot-framework"),
      join(repoRoot, "app", "src"),
    ].flatMap(sources);
    expect(files.length).toBeGreaterThan(200);
    const self = __filename;
    const offenders = files
      .filter((file) => file !== self)
      .filter((file) => removed.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(repoRoot.length + 1));
    expect(offenders).toEqual([]);
    // Positive control: the scan reads file contents, this file's among them.
    expect(removed.test(readFileSync(self, "utf8"))).toBe(true);
  });
});
