/**
 * #1235 Q4: the next message's sender accounts are funded ahead of it, through the recorded
 * funding path, so its send does not fund inline.
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
  providerRequests,
  type Fixture,
  type InboxRecord,
} from "./canonical-two-wallets.testutil";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Transaction, getBytes } from "ethers";
import { toHex } from "@frank/codec";
import domainVectors from "../../domain-roots/vectors/domain-roots-v1.json";
import type { MonadRootBundle } from "../monad-wallet-material";
import type { EvmChainWalletHandle } from "../evm-wallet-handle";
import { MonadAccountTxSigner } from "../monad-account-tx";
import { MonadSubAccountPool } from "../monad-account-pool";
import { MonadStampPendingAttemptError } from "../monad-stamp-client";
import type { CanonicalDirectory } from "./monad-canonical-dm";
import { FUND_AHEAD_MESSAGES } from "./active-chain";
import { installCanonicalDirectory } from "./monad-chain";

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

/** The production default stamp value, and what the stand-in chain quotes as one fee reserve. */
const STAMP = 10n ** 16n;
const RESERVE = 187_500n;
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

  beforeEach(async () => {
    mockBalances.clear();
    mockFunded.length = 0;
    mailboxes.clear();
    providerRequests.length = 0;
    chainHttpRequests.length = 0;
    atRelay = undefined;
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
        return base.fetch!(url, init);
      },
    };
    installCanonicalDirectory(alice, directory);
    const bobInbox: InboxRecord[] = [];
    mailboxes.set(toHex(f.bob.identity.compressedPubKey), bobInbox);
    f.setMailbox(bobInbox);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await alice.close().catch(() => undefined);
    await f.close().catch(() => undefined);
  });

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

  it("funds exactly the pair one message needs; the send that follows makes no funding transaction and far fewer requests before its relay request than a send that funds inline", async () => {
    expect(FUND_AHEAD_MESSAGES).toBe(1);
    // A send with nothing ready: today's path, the baseline.
    const inline = await send("funds its own accounts");
    expect(inline.preparationTxHashes).toHaveLength(2);
    expect(mockFunded).toHaveLength(2);
    const inlineSteps = atRelay!;
    expect(
      inlineSteps.chainHttp.filter((name) => name === "submitRawTransaction")
    ).toHaveLength(2);

    mockFunded.length = 0;
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
    expect(atRelay!.rpc.length).toBeLessThan(inlineSteps.rpc.length / 2);
    expect(sent.stampPayments.reduce((sum, p) => sum + p.valueWei, 0n)).toBe(
      STAMP
    );
    expect(sent.stampPayments).toHaveLength(2);
    // Both accounts were spent by that message: nothing funded is left over.
    expect(rows("available")).toEqual([]);
    // Before its relay request the pre-funded send only quotes the fee, twice (the inventory
    // check and the payment intent); the inline send made 28 RPC and 4 chain requests here.
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
    // A message the relay retained: its two accounts stay leased to it.
    f.setPhase("retained");
    await expect(send("held")).rejects.toBeInstanceOf(
      MonadStampPendingAttemptError
    );
    const held = structuredClone(rows("in-use"));
    expect(held).toHaveLength(2);
    mockFunded.length = 0;

    expect((await fundAhead()).outcome).toBe("funded");

    expect(mockFunded).toHaveLength(2);
    for (const record of held) {
      expect(transfersTo(record.address)).toEqual([]);
      expect(alice.pool.getRecord(record.index)).toEqual(record);
    }
    expect(rows("available")).toHaveLength(2);
  });

  it("fees rose after the accounts were funded ahead: the send funds what is missing instead of failing", async () => {
    await fundAhead();
    expect(mockFunded).toHaveLength(2);
    // 21,000 gas at 10 wei is more than the reserve either account was funded with.
    jest.spyOn(alice.provider, "getFeeData").mockResolvedValue({
      gasPrice: null,
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 1n,
    } as never);

    const sent = await send("after a fee rise");

    expect(sent.preparationTxHashes.length).toBeGreaterThan(0);
    expect(sent.stampPayments.reduce((sum, p) => sum + p.valueWei, 0n)).toBe(
      STAMP
    );
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

    it("the next SEND, not a call, finishes a recorded transfer too", async () => {
      jest
        .spyOn(alice.httpClient, "submitRawTransaction")
        .mockRejectedValueOnce(new Error("fixture: stopped before the submit"));
      await fundAhead();
      const [recorded] = rows("funding");

      await reopen();
      const sent = await send("after a restart");

      expect(sent.preparationTxHashes[0]).toBe(recorded.fundingAttempt!.txHash);
      expect(transfersTo(recorded.address)).toHaveLength(1);
      expect(mockFunded).toHaveLength(2);
    });
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
