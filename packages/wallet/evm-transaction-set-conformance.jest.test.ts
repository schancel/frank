/**
 * Offline conformance at the financial preparation boundary, using real LevelDB and signed
 * Ethereum transactions. These tests prove no relay acceptance, broadcast or Monad settlement.
 * Fee, dust and radix values below are fixture inputs, not wallet policy defaults.
 */
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Transaction, Wallet, parseEther } from "ethers";
import {
  EvmCoinList,
  EVM_COIN_LIST_NAMESPACE,
  type StoredEvmListCoin,
} from "./evm-coin-list";
import { EvmTransactionSetPreparer } from "./evm-transaction-set";
import type {
  EvmTransactionSetPolicy,
  PreparedEvmTransactionSet,
} from "./evm-transaction-set-types";
import { LevelRecordStore } from "./storage/evm-coin-store";
import { EvmNativeOperationJournal } from "./storage/evm-native-operation-journal";

const key = (index: number) => "0x" + index.toString(16).padStart(64, "0");
const account = (index: number) => new Wallet(key(index));
const address = (index: number) => account(index).address.toLowerCase();
const FEE_PRICE = 3n;
const TRANSFER_GAS = 21_000n;
const FEE = FEE_PRICE * TRANSFER_GAS;
const fixturePolicy: EvmTransactionSetPolicy = {
  gasPriceWei: FEE_PRICE,
  paymentGasLimit: (data) => (data === "0x" ? TRANSFER_GAS : 50_000n),
  changeGasLimit: TRANSFER_GAS,
  paymentFeeIsExact: true,
  dustWei: 10n ** 12n,
  radix: 10,
  jitterBps: 0,
  maxChangeOutputs: 32,
  head: 100,
  sourceOrder: [
    "stealth",
    "stamp",
    "change",
    "deterministic",
    "root",
    "identity",
  ],
};

const allTransactions = (set: PreparedEvmTransactionSet) => [
  ...set.bundle,
  ...set.otherTransactions,
];
// Independent decimal magnitude oracle for this fixture's explicitly chosen radix.
const decimalBucket = (value: bigint) => value.toString().length - 1;

describe("durable shared EVM transaction-set conformance", () => {
  let directory: string;
  let store: LevelRecordStore<StoredEvmListCoin>;
  let coins: EvmCoinList;
  let journal: EvmNativeOperationJournal;
  const derivedIndices: number[] = [];

  async function open() {
    store = await LevelRecordStore.open(directory, EVM_COIN_LIST_NAMESPACE);
    coins = await EvmCoinList.open(store);
    journal = new EvmNativeOperationJournal({
      location: directory,
      binding: {
        chainIdentifier: "monad-regtest",
        nativeChainId: "20143",
        publicTuple: "transaction-set-conformance-wallet",
      },
    });
    await journal.Open();
  }
  async function close() {
    await journal.Close();
    await store.close();
  }
  async function seed(index: number, valueWei: bigint, nonce = 0) {
    await coins.put({
      account: address(index),
      privateKey: key(index),
      valueWei,
      nonce,
      origin: "stealth",
    });
  }
  function preparer(policy: EvmTransactionSetPolicy = fixturePolicy) {
    return new EvmTransactionSetPreparer({
      coins,
      journal,
      policy: () => policy,
      deriveChange: (index) => {
        derivedIndices.push(index);
        return {
          account: address(10_000 + index),
          privateKey: key(10_000 + index),
          changeIndex: index,
        };
      },
      random: () => 0.25,
    });
  }
  function assertSigned(set: PreparedEvmTransactionSet) {
    expect(set.chainIdentifier).toBe("monad-regtest");
    for (const member of allTransactions(set)) {
      const decoded = Transaction.from(member.rawTransaction);
      expect(decoded.isSigned()).toBe(true);
      expect(decoded.chainId).toBe(20143n);
      expect(decoded.from!.toLowerCase()).toBe(
        member.sourceAccount.toLowerCase()
      );
      expect(decoded.to!.toLowerCase()).toBe(member.destination.toLowerCase());
      expect(decoded.nonce).toBe(member.nonce);
      expect(decoded.value).toBe(member.valueWei);
      expect(decoded.gasLimit).toBe(member.gasLimit);
      expect(decoded.hash).toBe(member.txHash);
      expect(decoded.maxFeePerGas ?? decoded.gasPrice).toBe(FEE_PRICE);
    }
  }
  function assertSourceConserved(
    set: PreparedEvmTransactionSet,
    sourceIndex: number,
    originalValue: bigint
  ) {
    const source = allTransactions(set)
      .map((member) => Transaction.from(member.rawTransaction))
      .filter((tx) => tx.from!.toLowerCase() === address(sourceIndex));
    expect(
      source.reduce((sum, tx) => sum + tx.value + tx.gasLimit * FEE_PRICE, 0n)
    ).toBe(originalValue);
    const nonces = source.map((tx) => tx.nonce).sort((a, b) => a - b);
    expect(nonces).toEqual(
      Array.from({ length: source.length }, (_, index) => nonces[0]! + index)
    );
  }

  beforeEach(async () => {
    directory = await mkdtemp(
      join(tmpdir(), "frank-transaction-set-conformance-")
    );
    derivedIndices.length = 0;
    await open();
  });
  afterEach(async () => {
    await close();
    await rm(directory, { recursive: true, force: true });
  });

  it("two independently composed preparers reserve disjoint sources and persist every signed byte before returning", async () => {
    await seed(1, parseEther("100"), 4);
    await seed(2, parseEther("100"), 7);
    const [first, second] = await Promise.all(
      [preparer(), preparer()].map((builder, index) =>
        builder.constructTransactionSet({
          operationId: `parallel-${index}`,
          amountWei: parseEther("2.4578"),
          kdf: (paymentIndex) => address(100 + index * 10 + paymentIndex),
        })
      )
    );
    const firstSources = new Set(
      allTransactions(first).map((tx) => tx.sourceAccount)
    );
    expect(
      allTransactions(second).every((tx) => !firstSources.has(tx.sourceAccount))
    ).toBe(true);
    for (const set of [first, second]) assertSigned(set);
    const expected = [...allTransactions(first), ...allTransactions(second)]
      .map((tx) => tx.rawTransaction)
      .sort();
    const durableBytes = () =>
      journal
        .list()
        .flatMap((row) =>
          row.members.map((member) => member.signed?.rawTransaction)
        )
        .sort();
    expect(durableBytes()).toEqual(expected);
    await close();
    await open();
    expect(durableBytes()).toEqual(expected);
    for (const index of [1, 2]) {
      const coin = coins.latestOf(address(index))!;
      expect(coin.state).toBe("pending_receipt");
      expect(expected).toContain(coin.spendingTx);
    }
  });

  it("logical KDF indices belong only to recipient payments and calldata never leaks into change", async () => {
    await seed(1, parseEther("4"));
    await seed(2, parseEther("3"));
    const indices: number[] = [];
    const set = await preparer().constructTransactionSet({
      operationId: "multiple-call-payments",
      amountWei: parseEther("5.25"),
      calldata: "0x12345678",
      kdf: (index) => {
        indices.push(index);
        return address(100 + index);
      },
    });
    expect(set.bundle.length).toBeGreaterThan(1);
    expect(indices).toEqual(set.bundle.map((_, index) => index));
    expect(set.otherTransactions.length).toBeGreaterThan(1);
    for (const [index, member] of set.bundle.entries()) {
      expect(member.logicalIndex).toBe(index);
      expect(member.destination.toLowerCase()).toBe(address(100 + index));
      expect(Transaction.from(member.rawTransaction).data).toBe("0x12345678");
    }
    const recipientAddresses = new Set(
      indices.map((index) => address(100 + index))
    );
    for (const member of set.otherTransactions) {
      expect(Transaction.from(member.rawTransaction).data).toBe("0x");
      expect(recipientAddresses.has(member.destination.toLowerCase())).toBe(
        false
      );
    }
    assertSigned(set);
    assertSourceConserved(set, 1, parseEther("4"));
    assertSourceConserved(set, 2, parseEther("3"));
  });

  it("excludes the last source payment magnitude rather than the total payment magnitude, including residual absorption", async () => {
    // The first source is exhausted. The second pays about 2 MON of a 52 MON total.
    // Radix ten puts those amounts in different buckets, exposing a total-based exclusion.
    await seed(1, parseEther("50") + FEE);
    await seed(2, parseEther("40"));
    const set = await preparer().constructTransactionSet({
      operationId: "per-source-exclusion",
      amountWei: parseEther("52.4578"),
      kdf: (index) => address(100 + index),
    });
    const lastPayment = set.bundle.find(
      (tx) => tx.sourceAccount.toLowerCase() === address(2)
    )!;
    expect(decimalBucket(lastPayment.valueWei)).not.toBe(
      decimalBucket(parseEther("52.4578"))
    );
    const change = set.otherTransactions.filter(
      (tx) => tx.sourceAccount.toLowerCase() === address(2)
    );
    expect(change.length).toBeGreaterThan(1);
    expect(change.length).toBeLessThanOrEqual(fixturePolicy.maxChangeOutputs);
    expect(
      change.some(
        (member) =>
          decimalBucket(member.valueWei) ===
          decimalBucket(parseEther("52.4578"))
      )
    ).toBe(true);
    for (const member of change) {
      expect(member.valueWei).toBeGreaterThanOrEqual(fixturePolicy.dustWei);
      expect(decimalBucket(member.valueWei)).not.toBe(
        decimalBucket(lastPayment.valueWei)
      );
    }
    assertSourceConserved(set, 1, parseEther("50") + FEE);
    assertSourceConserved(set, 2, parseEther("40"));
  });

  it("reserves fresh change indices across reopen while unknown submissions retain their original signed payments", async () => {
    await seed(1, parseEther("100"));
    const request = {
      operationId: "durable-original",
      amountWei: parseEther("2.4578"),
      kdf: (index: number) => address(100 + index),
    };
    const original = await preparer().constructTransactionSet(request);
    const originalChange = new Set(
      original.otherTransactions.map((tx) => tx.destination.toLowerCase())
    );
    expect(originalChange.size).toBeGreaterThan(1);
    const firstIndices = [...derivedIndices];
    expect(new Set(firstIndices).size).toBe(firstIndices.length);
    await close();
    await open();
    const resumed = await preparer().constructTransactionSet(request);
    expect(resumed).toEqual(original);
    await seed(2, parseEther("100"));
    const next = await preparer().constructTransactionSet({
      ...request,
      operationId: "after-restart",
    });
    expect(
      next.otherTransactions.every(
        (tx) => !originalChange.has(tx.destination.toLowerCase())
      )
    ).toBe(true);
    expect(new Set(derivedIndices).size).toBe(derivedIndices.length);
    expect(coins.get(address(1), 0)!.state).toBe("pending_receipt");
    expect(journal.list().filter((row) => !row.cancelled)).toHaveLength(2);
    assertSigned(next);
  });

  it("gifts sub-dust residue to the intended recipient and signs an exact full-balance drain", async () => {
    const intended = parseEther("2.4578");
    const gift = fixturePolicy.dustWei - 1n;
    await seed(1, intended + FEE + gift, 9);
    const set = await preparer().constructTransactionSet({
      operationId: "dust-gift",
      amountWei: intended,
      kdf: () => address(100),
    });
    expect(set.bundle).toHaveLength(1);
    expect(set.otherTransactions).toEqual([]);
    expect(Transaction.from(set.bundle[0]!.rawTransaction).value).toBe(
      intended + gift
    );
    expect(set.bundle[0]!.nonce).toBe(9);
    assertSourceConserved(set, 1, intended + FEE + gift);
  });
});
