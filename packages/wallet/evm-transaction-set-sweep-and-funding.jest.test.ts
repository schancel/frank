/**
 * Two transfers that used to have their own spending path now go through the one coin list and
 * the transaction-set preparer, like every payment:
 *
 * - funding the main account for a swap: a Send to the main account that never pays out of the
 *   main account's own coin (`excludedSourceAccounts`);
 * - sweeping received coins to the wallet's own account: each named coin moves its whole value,
 *   and only a coin worth more than its own move is moved (`quoteSweepTransactionSet`, then a
 *   set restricted to `sourceAccounts`).
 *
 * Both select, reserve, journal and replay exactly as a payment does.
 */
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Wallet } from "ethers";
import { EvmCoinList } from "./evm-coin-list";
import { MemoryRecordStore } from "./storage/evm-coin-store";
import { EvmNativeOperationJournal } from "./storage/evm-native-operation-journal";
import { EvmTransactionSetPreparer } from "./evm-transaction-set";
import {
  EvmTransactionSetInsufficientFundsError,
  type EvmTransactionSetPolicy,
  type PreparedEvmTransactionSet,
} from "./evm-transaction-set-types";

const signer = (index: number) =>
  new Wallet("0x" + index.toString(16).padStart(64, "0"));
const PRICE = 1_000n;
const FEE = 21_000n * PRICE;
const policy: EvmTransactionSetPolicy = {
  sourceOrder: ["stealth", "stamp", "change", "deterministic", "root", "identity"],
  gasPriceWei: PRICE,
  paymentGasLimit: () => 21_000n,
  changeGasLimit: 21_000n,
  paymentFeeIsExact: true,
  dustWei: 10n * FEE,
  radix: 2,
  jitterBps: 1_500,
  maxChangeOutputs: 20,
  head: 100,
};
const MAIN = signer(1);
const OWN = signer(2).address.toLowerCase();
const RECIPIENT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

type Store = MemoryRecordStore<import("./evm-coin-list").StoredEvmListCoin>;

async function open(coinStore: Store, journalPath?: string) {
  const coins = await EvmCoinList.open(coinStore);
  const journal = new EvmNativeOperationJournal({
    ...(journalPath === undefined ? { testOnlyEphemeral: true } : { location: journalPath }),
    binding: {
      chainIdentifier: "monad-regtest",
      nativeChainId: "20143",
      publicTuple: "sweep-and-funding",
    },
  });
  await journal.Open();
  let entropy = 7;
  const preparer = new EvmTransactionSetPreparer({
    coins,
    journal,
    policy: () => policy,
    random: () => (entropy = (entropy * 48_271) % 2_147_483_647) / 2_147_483_647,
    deriveChange: (index: number) => ({
      account: signer(10_000 + index).address.toLowerCase(),
      privateKey: signer(10_000 + index).privateKey,
      changeIndex: index,
    }),
  });
  return { coins, journal, preparer };
}

async function setup(
  specs: readonly { valueWei: bigint; origin?: "stealth" | "root" | "change" }[],
) {
  const coinStore: Store = new MemoryRecordStore();
  const f = await open(coinStore);
  const accounts: string[] = [];
  for (const [i, spec] of specs.entries()) {
    const key = spec.origin === "root" ? MAIN : signer(100 + i);
    accounts.push(key.address.toLowerCase());
    await f.coins.put({
      account: key.address,
      privateKey: key.privateKey,
      nonce: 0,
      valueWei: spec.valueWei,
      origin: spec.origin ?? "stealth",
      ...(spec.origin === "change" ? { changeIndex: 500 + i } : {}),
    });
  }
  return { ...f, coinStore, accounts };
}

const all = (set: PreparedEvmTransactionSet) => [...set.bundle, ...set.otherTransactions];
const sources = (set: PreparedEvmTransactionSet) =>
  new Set(all(set).filter(tx => tx.predecessor === undefined).map(tx => tx.sourceAccount.toLowerCase()));
const paidTo = (set: PreparedEvmTransactionSet, to: string) =>
  all(set)
    .filter(tx => tx.destination.toLowerCase() === to.toLowerCase())
    .reduce((sum, tx) => sum + tx.valueWei, 0n);
let ids = 0;

describe("received-coin sweep: named coins, each moved whole", () => {
  it("quotes only the named coins worth more than their own move, and the set moves exactly that", async () => {
    const f = await setup([
      { valueWei: 5n * FEE },
      { valueWei: 3n * FEE },
      // Not worth its move: it would arrive as at most one fee.
      { valueWei: 2n * FEE },
      // Not named: never touched.
      { valueWei: 9n * FEE },
    ]);
    const named = f.accounts.slice(0, 3);
    const quote = await f.preparer.quoteSweepTransactionSet({ destination: OWN, sourceAccounts: named });
    expect(new Set(quote.sourceAccounts)).toEqual(new Set(named.slice(0, 2)));
    expect(quote.amountWei).toBe(4n * FEE + 2n * FEE);
    expect(quote.feeWei).toBe(2n * FEE);
    const set = await f.preparer.constructTransactionSet({
      operationId: `sweep-${ids++}`,
      amountWei: quote.amountWei,
      kdf: () => OWN,
      sourceAccounts: quote.sourceAccounts,
      maxPaymentParts: quote.inputCount,
      maxFeeWei: quote.feeWei,
    });
    expect(sources(set)).toEqual(new Set(quote.sourceAccounts));
    expect(paidTo(set, OWN)).toBe(quote.amountWei);
    // Whole coins: no change account, nothing left on a source.
    expect(all(set).every(tx => tx.destination.toLowerCase() === OWN)).toBe(true);
    expect(all(set).reduce((sum, tx) => sum + tx.valueWei + tx.gasLimit * PRICE, 0n)).toBe(8n * FEE);
    expect(f.coins.get(f.accounts[2]!, 0)?.state).toBe("unspent");
    expect(f.coins.get(f.accounts[3]!, 0)?.state).toBe("unspent");
    await f.journal.Close();
  });

  it("never moves the destination's own coin and refuses when nothing named is worth moving", async () => {
    const f = await setup([{ valueWei: 2n * FEE }]);
    const ownKey = signer(2);
    await f.coins.put({ account: ownKey.address, privateKey: ownKey.privateKey, nonce: 0, valueWei: 50n * FEE, origin: "stealth" });
    await expect(
      f.preparer.quoteSweepTransactionSet({ destination: OWN, sourceAccounts: [f.accounts[0]!, OWN] }),
    ).rejects.toBeInstanceOf(EvmTransactionSetInsufficientFundsError);
    await f.journal.Close();
  });

  it("a sweep and a payment never take the same coin, in either order", async () => {
    const f = await setup([{ valueWei: 50n * FEE }, { valueWei: 50n * FEE }]);
    // A payment takes one coin first.
    const payment = await f.preparer.constructLegacyTransactionSet({
      operationId: `legacy-pay-${ids++}`,
      amountWei: 10n * FEE,
      kdf: () => RECIPIENT,
    });
    const paid = sources(payment);
    expect(paid.size).toBe(1);
    const quote = await f.preparer.quoteSweepTransactionSet({ destination: OWN, sourceAccounts: f.accounts });
    expect(quote.sourceAccounts.some(account => paid.has(account))).toBe(false);
    const sweep = await f.preparer.constructTransactionSet({
      operationId: `sweep-${ids++}`,
      amountWei: quote.amountWei,
      kdf: () => OWN,
      sourceAccounts: quote.sourceAccounts,
      maxPaymentParts: quote.inputCount,
      maxFeeWei: quote.feeWei,
    });
    expect([...sources(sweep)].some(account => paid.has(account))).toBe(false);
    // Every coin is now held: a further payment has nothing to select.
    await expect(
      f.preparer.constructLegacyTransactionSet({ operationId: `legacy-pay-${ids++}`, amountWei: FEE, kdf: () => RECIPIENT }),
    ).rejects.toBeInstanceOf(EvmTransactionSetInsufficientFundsError);
    await f.journal.Close();
  });

  it("an interrupted sweep reopens as the same signed set: the same id replays its bytes and signs nothing new", async () => {
    const coinStore: Store = new MemoryRecordStore();
    const dir = await mkdtemp(join(tmpdir(), "frank-sweep-"));
    const journalPath = dir;
    let f = await open(coinStore, journalPath);
    const key = signer(300);
    await f.coins.put({ account: key.address, privateKey: key.privateKey, nonce: 0, valueWei: 40n * FEE, origin: "stealth" });
    const account = key.address.toLowerCase();
    const quote = await f.preparer.quoteSweepTransactionSet({ destination: OWN, sourceAccounts: [account] });
    const request = {
      operationId: "sweep-restart",
      amountWei: quote.amountWei,
      kdf: () => OWN,
      sourceAccounts: quote.sourceAccounts,
      maxPaymentParts: quote.inputCount,
      maxFeeWei: quote.feeWei,
    };
    const first = await f.preparer.constructTransactionSet(request);
    await f.journal.Close();
    f = await open(coinStore, journalPath);
    // Still held after the reopen: a payment cannot take it.
    expect(f.coins.get(account, 0)?.state).not.toBe("unspent");
    const again = await f.preparer.constructTransactionSet(request);
    expect(all(again).map(tx => tx.txHash)).toEqual(all(first).map(tx => tx.txHash));
    await f.journal.Close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("swap funding: a Send to the main account that never pays out of it", () => {
  it("one other coin that suffices pays main directly; main's own coin is never an input", async () => {
    const f = await setup([{ valueWei: 100n * FEE, origin: "root" }, { valueWei: 40n * FEE }]);
    const main = MAIN.address.toLowerCase();
    const set = await f.preparer.constructLegacyTransactionSet({
      operationId: `legacy-fund-${ids++}`,
      amountWei: 20n * FEE,
      kdf: () => MAIN.address,
      excludedSourceAccounts: [main],
    });
    expect(sources(set)).toEqual(new Set([f.accounts[1]]));
    expect(paidTo(set, main)).toBe(20n * FEE);
    expect(f.coins.get(main, 0)?.state).toBe("unspent");
    await f.journal.Close();
  });

  it("no single coin suffices: the coins fan in to one fresh account, which then pays main", async () => {
    const f = await setup([
      { valueWei: 100n * FEE, origin: "root" },
      { valueWei: 15n * FEE },
      { valueWei: 15n * FEE },
      { valueWei: 15n * FEE },
    ]);
    const main = MAIN.address.toLowerCase();
    const set = await f.preparer.constructLegacyTransactionSet({
      operationId: `legacy-fund-${ids++}`,
      amountWei: 30n * FEE,
      kdf: () => MAIN.address,
      excludedSourceAccounts: [main],
    });
    expect(sources(set).has(main)).toBe(false);
    expect(sources(set).size).toBeGreaterThan(1);
    const toMain = all(set).filter(tx => tx.destination.toLowerCase() === main);
    // One transfer reaches main, from the fan-in account, after its funding.
    expect(toMain).toHaveLength(1);
    expect(toMain[0]!.valueWei).toBe(30n * FEE);
    expect(f.accounts.slice(1)).not.toContain(toMain[0]!.sourceAccount.toLowerCase());
    expect(f.coins.get(main, 0)?.state).toBe("unspent");
    await f.journal.Close();
  });

  it("only main holds money: funding main is refused and nothing is reserved", async () => {
    const f = await setup([{ valueWei: 100n * FEE, origin: "root" }]);
    const main = MAIN.address.toLowerCase();
    await expect(
      f.preparer.constructLegacyTransactionSet({
        operationId: `legacy-fund-${ids++}`,
        amountWei: FEE,
        kdf: () => MAIN.address,
        excludedSourceAccounts: [main],
      }),
    ).rejects.toBeInstanceOf(EvmTransactionSetInsufficientFundsError);
    expect(f.coins.get(main, 0)?.state).toBe("unspent");
    expect(f.coins.isAccountReserved(main)).toBe(false);
    // The quote agrees: there is nothing to move to main.
    await expect(
      f.preparer.quoteLegacyTransactionSet({ destination: MAIN.address, excludedSourceAccounts: [main] }),
    ).rejects.toBeInstanceOf(EvmTransactionSetInsufficientFundsError);
    await f.journal.Close();
  });
});
