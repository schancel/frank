import { fixedStampDefault } from '../oracle/stamp-policy.testutil'
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
  providerBroadcasts,
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
import type { MonadRootBundle } from "../evm-wallet-material";
import type { EvmChainWalletHandle } from "../evm-wallet-handle";
import { MonadAccountTxSigner } from "../evm-account-tx";
import { FUND_AHEAD_RECEIPT_WAIT_MS } from "../evm-account-pool";
import type { CanonicalDirectory } from "./canonical-dm";
import { FUND_AHEAD_MESSAGES } from "./active-chain";
import {
  FUND_AHEAD_BACKOFF_MAX_MS,
  FUND_AHEAD_BACKOFF_MIN_MS,
  installCanonicalDirectory,
  prepareCanonicalStampInventory,
} from "./evm-chain";

jest.mock("../evm-provider", () =>
  require("./canonical-two-wallets.testutil").offlineProviderModule()
);
// The shared stand-in remembers what it mined for the life of the module, and these wallets sign
// the same first transfer in every test. This one forgets between tests (`mockMined`).
const mockMined = new Set<string>();
jest.mock("../evm-http", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ethers = require("ethers");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const shared = require("./canonical-two-wallets.testutil");
  return {
    ...jest.requireActual("../evm-http"),
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
jest.mock("@frank/cashweb/relay/mailbox-client", () =>
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
    providerBroadcasts.length = 0;
    chainHttpRequests.length = 0;
    atRelay = undefined;
    relayBodies = [];
    mockMined.clear();
    f = await fixture({ resolveDefaultStamp: fixedStampDefault(STAMP )});
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
    providerBroadcasts.filter(tx => tx.to === address.toLowerCase());
  /** The pair is visible in the coin inventory and its exact target balances are present. */
  function expectOnePairFundedOnce() {
    const funded = rows("available");
    expect(funded).toHaveLength(2);
    for (const record of funded)
      expect(transfersTo(record.address).length).toBeGreaterThan(0);
    expect(funded.reduce((sum, record) =>
      sum + (mockBalances.get(record.address.toLowerCase()) ?? 0n), 0n
    )).toBeGreaterThanOrEqual(STAMP);
    expect(rows("funding")).toEqual([]);
  }

  it("quotes the real messaging payer without signing, funding, relay handoff or inventory writes", async () => {
    const sign = jest.spyOn(MonadAccountTxSigner.prototype, "signFrozenUnsigned");
    const records = alice.pool.records();
    const balances = new Map(mockBalances);
    const quote = await f.chain.directMessages.quoteStamp!({ wallet: alice, stampValue: STAMP });
    expect(quote).toMatchObject({ status: "available", chainIdentifier: alice.chainIdentifier,
      stampValueAtomic: STAMP, maximumNativeFeeAtomic: RESERVE });
    expect(quote.spendableCapacityAtomic).toBeGreaterThanOrEqual(STAMP);
    expect(sign).not.toHaveBeenCalled();
    expect(alice.pool.records()).toEqual(records);
    expect(mockBalances).toEqual(balances);
    expect(mockFunded).toEqual([]);
    expect(chainHttpRequests).toEqual([]);
    expect(relayBodies).toEqual([]);
    expect(alice.pool.accountClaimedBy(main)).toBeUndefined();
    expect(await f.chain.directMessages.quoteStamp!({ wallet: alice, stampValue: STAMP,
      excludedAddresses: [main] })).toMatchObject({ status: "insufficient", spendableCapacityAtomic: 0n });
    await reopen();
    expect(await f.chain.directMessages.quoteStamp!({ wallet: alice, stampValue: STAMP }))
      .toMatchObject({ status: "available", maximumNativeFeeAtomic: RESERVE });
  });

  it("quotes funded pool fragmentation with the sender's exact fees, excluding held inputs", async () => {
    await fundAhead();
    const funded = rows("available");
    const transfers = providerBroadcasts.length;
    const quote = await f.chain.directMessages.quoteStamp!({ wallet: alice, stampValue: STAMP });
    expect(quote).toMatchObject({ status: "available", maximumNativeFeeAtomic: RESERVE * 2n });
    expect(funded.map(record => alice.pool.claimedBy(record.index))).toEqual([undefined, undefined]);
    alice.pool.restoreClaim("earlier-message", funded.map(record => record.index));
    expect(await f.chain.directMessages.quoteStamp!({ wallet: alice, stampValue: STAMP,
      excludedAddresses: [main] })).toMatchObject({ status: "insufficient" });
    expect(providerBroadcasts).toHaveLength(transfers);
    alice.pool.releaseClaim("earlier-message");
  });

  it("free stamps read no node, rejects below-fee paid stamps, and refuses closed handles", async () => {
    const before = requests();
    expect(await f.chain.directMessages.quoteStamp!({ wallet: alice, stampValue: 0n }))
      .toMatchObject({ status: "available", maximumNativeFeeAtomic: 0n, spendableCapacityAtomic: 0n });
    expect(requests()).toBe(before);
    offlineChain.gasPrice = 1n;
    await expect(f.chain.directMessages.quoteStamp!({ wallet: alice, stampValue: 1n }))
      .rejects.toThrow();
    await alice.close();
    await expect(f.chain.directMessages.quoteStamp!({ wallet: alice, stampValue: STAMP }))
      .rejects.toThrow();
  });

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
    expect(ahead).toMatchObject({ outcome: "funded" });
    expect(ahead.fundingTxHashes.length).toBeGreaterThan(0);
    const fundedAddresses = new Set(rows("available").map(record => record.address.toLowerCase()));
    expect(providerBroadcasts.some(tx => fundedAddresses.has(tx.to))).toBe(true);
    expect(
      rows("available").map(record => record.address.toLowerCase()).sort()
    ).toEqual([...fundedAddresses].sort());
    const fundedSenderAddresses = [...fundedAddresses].sort();

    providerRequests.length = 0;
    chainHttpRequests.length = 0;
    atRelay = undefined;
    // Past the few seconds a fee quote is remembered for: this send quotes its own.
    later(10_000);
    const sent = await send("finds its accounts ready");

    // No funding transaction, no receipt read, no funding-related request at all.
    expect(sent.preparationTxHashes).toEqual([]);
    expect(mockFunded).toEqual([]);
    expect(atRelay!.chainHttp).toEqual([]);
    expect(atRelay!.rpc.filter((name) => name === "estimateGas")).toEqual([]);
    // The quoted set and the final send each refresh both funded accounts' latest and pending
    // nonces; funding itself already completed in the durable shared transaction sets.
    expect(atRelay!.rpc.filter((name) => name === "getTransactionCount")).toHaveLength(4);
    expect(sent.stampPayments.reduce((sum, p) => sum + p.valueWei, 0n)).toBe(
      STAMP
    );
    expect(sent.stampPayments).toHaveLength(2);
    // Paid by the funded pair, not by the main account.
    expect(payersAtRelay(1).sort()).toEqual(fundedSenderAddresses);
    expect(alice.pool.accountClaimedBy(main)).toBeUndefined();
    // Both accounts are that message's: nothing funded is left free, and both are spent once
    // the chain shows the payments.
    expect(held()).toHaveLength(2);
    await tick();
    expect(rows("available")).toEqual([]);
    expect(rows("spent")).toHaveLength(2);
    // Before exposure the send quotes its fee and reads the freshly funded pair into the coin
    // list once (its nonce and what it holds): no funding request.
    expect(new Set(atRelay!.rpc)).toEqual(
      new Set(["getBlock", "getGasPrice", "getPriorityFee", "getBlockNumber", "getTransactionCount", "getBalance"])
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
    // Seed an independent valid source so the send can progress while the root coin is reserved.
    const identity = alice.identity!.address.raw.toLowerCase();
    mockBalances.set(identity, STAMP + 4n * RESERVE);
    await alice.refreshTransactionSetInventory?.();
    // Pause after a complete shared set has reserved and signed its sources, before the
    // fund-ahead lifecycle submits it. A direct message must still use other available coins.
    let releaseConstruction!: () => void;
    const constructionReleased = new Promise<void>((resolve) => (releaseConstruction = resolve));
    let constructionReady!: () => void;
    const afterConstruction = new Promise<void>((resolve) => (constructionReady = resolve));
    let paused = false;
    const preparer = alice.transactionSetPreparer!;
    const construct = preparer.constructTransactionSet.bind(preparer);
    jest
      .spyOn(preparer, "constructTransactionSet")
      .mockImplementation(async request => {
        const prepared = await construct(request);
        if (!paused && request.operationId.startsWith("stamp-fund-ahead-")) {
          paused = true;
          constructionReady();
          await constructionReleased;
        }
        return prepared;
      });
    const funding = fundAhead();
    await afterConstruction;
    let sent: Awaited<ReturnType<typeof send>>;
    try {
      sent = await send("racing");
    } finally {
      releaseConstruction();
    }
    const ahead = await funding;
    expect(ahead.outcome).toBe("funded");
    expect(sent.preparationTxHashes).toEqual([]);
    expect(mockFunded).toEqual([]);
    expect(relayBodies).toHaveLength(1);
    expect(sent.stampPayments.reduce((sum, p) => sum + p.valueWei, 0n)).toBe(STAMP);
    for (const payment of sent.stampPayments)
      expect(offlineChain.mined.has(payment.txHash)).toBe(true);
    expect(mailboxes.get(toHex(f.bob.identity.compressedPubKey))).toHaveLength(1);
    await tick();
    // The concurrent message used the independent identity coin while the fund-ahead set held
    // its sources; both newly funded stamp accounts remain available afterward.
    expect(rows("available")).toHaveLength(2);
    expect(rows("spent")).toHaveLength(0);
  });

  it("funds the approved pair through wallet inventory and does nothing with an empty wallet", async () => {
    const funded = await fundAhead();
    expect(funded.outcome).toBe("funded");
    expectOnePairFundedOnce();
    const beforeBobBroadcasts = providerBroadcasts.length;

    // A wallet with no available inventory signs or broadcasts nothing.
    const bob = f.bob;
    mockBalances.set((await bob.getReceiveAddress()).raw.toLowerCase(), 0n);
    providerRequests.length = 0;
    chainHttpRequests.length = 0;
    expect(await fundAhead(bob)).toEqual({
      outcome: "not-funded",
      fundingTxHashes: [],
      reason: "insufficient-funds",
    });
    expect(chainHttpRequests).toEqual([]);
    expect(providerBroadcasts).toHaveLength(beforeBobBroadcasts);
  });

  it("a fee reserve above the ceiling, or a transfer costing more than it moves, moves nothing", async () => {
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
    expect(providerBroadcasts).toEqual([]);
    fee.mockRestore();
    // Past the wait the refused pass earned (see the backoff tests below).
    later(FUND_AHEAD_BACKOFF_MIN_MS);

    // A transfer whose own fee cap exceeds its value: refused after signing, before any write.
    jest.spyOn(alice.transactionSetPreparer!, "constructTransactionSet")
      .mockRejectedValueOnce(new Error("Transaction-set fee exceeds authorized bound"));
    expect(await fundAhead()).toMatchObject({
      outcome: "not-funded",
      reason: "uneconomic",
    });
    expect(providerBroadcasts).toEqual([]);
    expect(rows("available")).toEqual([]);
  });

  it("fees rose after the accounts were funded ahead: the shared send still pays exactly the stamp", async () => {
    await fundAhead();
    const internalBroadcasts = providerBroadcasts.length;
    // 21,000 gas at 10 wei is more than the reserve either account was funded with.
    jest.spyOn(alice.provider, "getFeeData").mockResolvedValue({
      gasPrice: null,
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 1n,
    } as never);

    const sent = await send("after a fee rise");

    expect(sent.preparationTxHashes).toEqual([]);
    expect(mockFunded).toEqual([]);
    expect(sent.stampPayments.reduce((sum, payment) => sum + payment.valueWei, 0n)).toBe(STAMP);
    expect(providerBroadcasts.length).toBeGreaterThanOrEqual(internalBroadcasts);
    expect(rows("available")).toHaveLength(2);
  });

  it("rejects for a closed wallet", async () => {
    await alice.close();
    await expect(fundAhead()).rejects.toThrow("closed");
    expect(mockFunded).toEqual([]);
  });

  describe("wallet open", () => {
    it("reopen is read-only; explicit recovery replays the durable shared operation", async () => {
      offlineChain.broadcastDown = true;
      expect((await fundAhead()).outcome).toBe("not-funded");
      const operation = alice.getNativeOperations!().find(row =>
        row.kind === "transaction-set" && row.preparationId?.startsWith("evm-transaction-set:stamp-fund-ahead-"),
      )!;
      const signed = operation.members.map(member => member.signed!.rawTransaction);
      await alice.close();
      offlineChain.broadcastDown = false;
      providerRequests.length = 0;
      chainHttpRequests.length = 0;
      alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle;
      installCanonicalDirectory(alice, directory);
      await new Promise((resolve) => setImmediate(resolve));
      expect(providerRequests).toEqual([]);
      expect(chainHttpRequests).toEqual([]);
      const recovered = await fundAhead();
      expect(recovered.outcome).toBe("funded");
      expect(alice.getNativeOperations!().find(row => row.operationId === operation.operationId)!
        .members.map(member => member.signed!.rawTransaction)).toEqual(signed);
      expect(requests()).toBeGreaterThan(0);
    });
  });

  describe("shared fund-ahead recovery across restart", () => {
    it("replays the exact durable signed set after an ambiguous broadcast", async () => {
      offlineChain.broadcastDown = true;
      const first = await fundAhead();
      expect(first.outcome).toBe("not-funded");
      const operations = alice.getNativeOperations!().filter(row =>
        row.kind === "transaction-set" && row.preparationId?.startsWith("evm-transaction-set:stamp-fund-ahead-"),
      );
      expect(operations.length).toBeGreaterThan(0);
      const originalByOperation = new Map(operations.map(row => [
        row.preparationId,
        row.members.map(member => member.signed!.rawTransaction),
      ]));
      await alice.close();
      offlineChain.broadcastDown = false;
      alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle;
      installCanonicalDirectory(alice, directory);
      const replayed = await fundAhead();
      expect(replayed.outcome).toBe("funded");
      const recovered = alice.getNativeOperations!().filter(row =>
        row.kind === "transaction-set" && row.preparationId?.startsWith("evm-transaction-set:stamp-fund-ahead-"),
      );
      for (const row of recovered) {
        const original = originalByOperation.get(row.preparationId);
        if (original !== undefined)
          expect(row.members.map(member => member.signed!.rawTransaction)).toEqual(original);
      }
      expect(recovered.filter(row => originalByOperation.has(row.preparationId))).toHaveLength(originalByOperation.size);
      expectOnePairFundedOnce();
    });
  });
  describe("shared inventory fund-ahead", () => {
    it("can fund from wallet coins other than main and then send the exact stamp", async () => {
      mockBalances.set(main, STAMP + RESERVE);
      const funded = await fundAhead();
      expect(funded.outcome).toBe("funded");
      expectOnePairFundedOnce();
      const sent = await send("from shared wallet inventory");
      expect(sent.stampPayments.reduce((sum, payment) => sum + payment.valueWei, 0n)).toBe(STAMP);
      expect(sent.preparationTxHashes).toEqual([]);
    });

    it("uses the same shared path through the canonical stamp inventory capability", async () => {
      const peer = (await directory.peerCurrent({ address: f.bob.identity.address.raw }))!;
      const funded = await prepareCanonicalStampInventory(alice, {
        stampValueWei: STAMP,
        recipientStampKey: peer.current.stampKey.keyBytes,
      });
      expect(funded.length).toBeGreaterThan(0);
      expectOnePairFundedOnce();
      const sent = await send("after canonical inventory preparation");
      expect(sent.stampPayments.reduce((sum, payment) => sum + payment.valueWei, 0n)).toBe(STAMP);
      expect(sent.preparationTxHashes).toEqual([]);
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
