/**
 * Send to an address is a single-recipient transaction set over the wallet's one coin list.
 * Its review quote (`quoteLegacyTransactionSet`) makes the same selection and change split that
 * construction makes, so the fee shown is the fee paid, and "Max" spends every coin that can
 * pay for its own move.
 *
 * Values mirror monad-regtest: gas price 102 gwei, so one transfer costs 0.002142 MON.
 */
import { Transaction, Wallet, parseEther } from "ethers";
import { EvmCoinList, type EvmCoinListOrigin } from "./evm-coin-list";
import { MemoryRecordStore } from "./storage/evm-coin-store";
import { EvmNativeOperationJournal } from "./storage/evm-native-operation-journal";
import {
  EvmTransactionSetFeeExceededError,
  EvmTransactionSetPreparer,
} from "./evm-transaction-set";
import {
  EvmTransactionSetInsufficientFundsError,
  type EvmTransactionSetPolicy,
  type PreparedEvmTransactionSet,
} from "./evm-transaction-set-types";

const signer = (index: number) =>
  new Wallet("0x" + index.toString(16).padStart(64, "0"));
const PRICE = 102_000_000_000n;
const FEE = 21_000n * PRICE;
const HEAD = 1_000;
const basePolicy: EvmTransactionSetPolicy = {
  sourceOrder: [
    "stealth",
    "stamp",
    "change",
    "deterministic",
    "root",
    "identity",
  ],
  gasPriceWei: PRICE,
  paymentGasLimit: () => 21_000n,
  changeGasLimit: 21_000n,
  paymentFeeIsExact: true,
  dustWei: 10n * FEE,
  radix: 2,
  jitterBps: 1_500,
  maxChangeOutputs: 20,
  head: HEAD,
};
const monadPolicy: EvmTransactionSetPolicy = {
  ...basePolicy,
  spendRule: { belowWei: parseEther("10"), waitBlocks: 3 },
};
const RECIPIENT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

interface CoinSpec {
  valueWei: bigint;
  origin?: EvmCoinListOrigin;
  nonce?: number;
  lastSpentInBlock?: number;
}

async function setup(specs: readonly CoinSpec[], policy = basePolicy) {
  const coins = await EvmCoinList.open(
    new MemoryRecordStore<import("./evm-coin-list").StoredEvmListCoin>()
  );
  for (const [index, spec] of specs.entries())
    await coins.put({
      account: signer(index + 1).address,
      privateKey: signer(index + 1).privateKey,
      nonce: spec.nonce ?? 0,
      valueWei: spec.valueWei,
      origin: spec.origin ?? "change",
      ...(spec.origin === undefined || spec.origin === "change"
        ? { changeIndex: index }
        : {}),
      ...(spec.lastSpentInBlock === undefined
        ? {}
        : { lastSpentInBlock: spec.lastSpentInBlock }),
    });
  const journal = new EvmNativeOperationJournal({
    testOnlyEphemeral: true,
    binding: {
      chainIdentifier: "monad-regtest",
      nativeChainId: "20143",
      publicTuple: "legacy-quote",
    },
  });
  await journal.Open();
  let entropy = 1;
  const preparer = new EvmTransactionSetPreparer({
    coins,
    journal,
    policy: () => policy,
    recoverySpendRule: policy.spendRule,
    random: () =>
      (entropy = (entropy * 48_271) % 2_147_483_647) / 2_147_483_647,
    deriveChange: (index: number) => ({
      account: signer(10_000 + index).address.toLowerCase(),
      privateKey: signer(10_000 + index).privateKey,
      changeIndex: index,
    }),
  });
  return { coins, preparer };
}

const all = (set: PreparedEvmTransactionSet) => [
  ...set.bundle,
  ...set.otherTransactions,
];
/** What every signed transaction of the set pays in gas. */
const feePaid = (set: PreparedEvmTransactionSet) =>
  all(set).reduce((sum, tx) => sum + tx.gasLimit * PRICE, 0n);
const toRecipient = (set: PreparedEvmTransactionSet) =>
  all(set)
    .filter((tx) => tx.destination.toLowerCase() === RECIPIENT.toLowerCase())
    .reduce((sum, tx) => sum + tx.valueWei, 0n);

let operations = 0;
const send = (
  preparer: EvmTransactionSetPreparer,
  amountWei: bigint,
  maxFeeWei: bigint
) =>
  preparer.constructLegacyTransactionSet({
    operationId: `legacy-quote-${operations++}`,
    amountWei,
    kdf: () => RECIPIENT,
    maxFeeWei,
  });

/** Seventeen change coins left by stamps and earlier sends (the live 0.809676 MONR case),
 * plus one coin smaller than the fee of moving it. */
const FRAGMENTED: CoinSpec[] = [
  ...Array.from({ length: 17 }, (_, i) => ({
    valueWei: parseEther("0.05") + BigInt(i) * 1_234_567_890_123n,
  })),
  { valueWei: FEE / 2n },
];
const total = (specs: readonly CoinSpec[]) =>
  specs.reduce((sum, spec) => sum + spec.valueWei, 0n);

describe("Send to an address: quote and construction agree", () => {
  it("Max spends every change coin that can pay for its own move and leaves only unspendable dust", async () => {
    const { coins, preparer } = await setup(FRAGMENTED);
    const quote = await preparer.quoteLegacyTransactionSet({
      destination: RECIPIENT,
    });
    // Quoting reserves nothing.
    expect(coins.all().every((coin) => coin.state === "unspent")).toBe(true);
    // 17 moves into one fresh account, then one payment from it; nothing is left for change.
    expect(quote.inputCount).toBe(17);
    expect(quote.consolidationFeeWei).toBe(17n * FEE);
    expect(quote.deliveryFeeWei).toBe(FEE);
    expect(quote.changeFeeWei).toBe(0n);
    expect(quote.feeWei).toBe(18n * FEE);
    const spendable = total(FRAGMENTED.slice(0, 17));
    expect(quote.amountWei).toBe(spendable - quote.feeWei);

    const set = await send(preparer, quote.amountWei, quote.feeWei);
    expect(toRecipient(set)).toBe(quote.amountWei);
    expect(feePaid(set)).toBe(quote.feeWei);
    // Every change coin is in the payment; what is still unspent is the coin worth less than
    // one transfer fee (FEE / 2): a transaction moving it could not pay its own gas.
    const left = coins.all().filter((coin) => coin.state === "unspent");
    expect(left.map((coin) => coin.valueWei)).toEqual([FEE / 2n]);
    expect(left.every((coin) => coin.valueWei < FEE)).toBe(true);
  });

  it("a quote for a given amount shows exactly the fee construction pays, not a per-input bound", async () => {
    const { preparer } = await setup(FRAGMENTED);
    const amountWei = parseEther("0.6");
    const quote = await preparer.quoteLegacyTransactionSet({
      destination: RECIPIENT,
      amountWei,
    });
    const set = await send(preparer, amountWei, quote.feeWei);
    expect(toRecipient(set)).toBe(amountWei);
    expect(feePaid(set)).toBe(quote.feeWei);
    // The old review bound was inputCount × (fee + maxChangeOutputs × fee) + a change bound:
    // more than 0.8 MON here, against a few hundredths actually paid.
    const oldBound = BigInt(quote.inputCount) * (FEE + 20n * FEE);
    expect(quote.feeWei).toBeLessThan(oldBound / 10n);
  });

  it("one coin that covers the transfer pays it directly; the fee includes its change split", async () => {
    const { preparer } = await setup([{ valueWei: parseEther("1") }]);
    const amountWei = parseEther("0.3");
    const quote = await preparer.quoteLegacyTransactionSet({
      destination: RECIPIENT,
      amountWei,
    });
    expect(quote.inputCount).toBe(1);
    expect(quote.consolidationFeeWei).toBe(0n);
    const set = await send(preparer, amountWei, quote.feeWei);
    expect(toRecipient(set)).toBe(amountWei);
    expect(feePaid(set)).toBe(quote.feeWei);
    expect(quote.changeFeeWei).toBe(feePaid(set) - FEE);
  });

  it("refuses to pay more than the reviewed fee, signing and reserving nothing", async () => {
    const { coins, preparer } = await setup(FRAGMENTED);
    const quote = await preparer.quoteLegacyTransactionSet({
      destination: RECIPIENT,
    });
    const refused = send(preparer, quote.amountWei, quote.feeWei - 1n);
    await expect(refused).rejects.toBeInstanceOf(
      EvmTransactionSetFeeExceededError
    );
    await expect(refused).rejects.toMatchObject({ feeWei: quote.feeWei });
    expect(coins.all().every((coin) => coin.state === "unspent")).toBe(true);
  });

  it("a wallet of dust has nothing to send", async () => {
    const { preparer } = await setup([
      { valueWei: FEE / 2n },
      { valueWei: FEE },
    ]);
    await expect(
      preparer.quoteLegacyTransactionSet({ destination: RECIPIENT })
    ).rejects.toBeInstanceOf(EvmTransactionSetInsufficientFundsError);
  });
});

describe("Send to an address under the Monad reserve rule (10 MON, 3 blocks)", () => {
  it("Max counts what each account may move now: all of a quiet account, only the value above 10 MON of one that just sent", async () => {
    const { preparer } = await setup(
      [
        // Sent one block ago and holds less than 10 MON: may not move anything yet.
        { valueWei: parseEther("0.5"), nonce: 1, lastSpentInBlock: HEAD - 1 },
        // Never sent (nonce 0): may move everything.
        { valueWei: parseEther("0.3") },
        // Sent long enough ago: quiet again, may move everything.
        { valueWei: parseEther("0.2"), nonce: 2, lastSpentInBlock: HEAD - 10 },
      ],
      monadPolicy
    );
    const quote = await preparer.quoteLegacyTransactionSet({
      destination: RECIPIENT,
    });
    // The busy account is left out of the fan-in; the two others move into one account.
    expect(quote.inputCount).toBe(2);
    expect(quote.amountWei).toBe(parseEther("0.5") - 3n * FEE);
    const set = await send(preparer, quote.amountWei, quote.feeWei);
    expect(toRecipient(set)).toBe(quote.amountWei);
    expect(feePaid(set)).toBe(quote.feeWei);
    expect(
      all(set).some(
        (tx) => tx.sourceAccount === signer(1).address.toLowerCase()
      )
    ).toBe(false);
  });

  it("an account above the reserve that just sent can pay out what it holds above 10 MON", async () => {
    const { preparer } = await setup(
      [
        { valueWei: parseEther("12"), nonce: 1, lastSpentInBlock: HEAD - 1 },
        { valueWei: parseEther("0.3") },
      ],
      monadPolicy
    );
    const quote = await preparer.quoteLegacyTransactionSet({
      destination: RECIPIENT,
    });
    expect(quote.inputCount).toBe(1);
    expect(quote.amountWei).toBe(parseEther("2") - FEE);
    const set = await send(preparer, quote.amountWei, quote.feeWei);
    expect(toRecipient(set)).toBe(quote.amountWei);
    expect(feePaid(set)).toBe(quote.feeWei);
    const payment = set.bundle.find(
      (tx) => tx.destination.toLowerCase() === RECIPIENT.toLowerCase()
    )!;
    expect(payment.sourceAccount).toBe(signer(1).address.toLowerCase());
    expect(Transaction.from(payment.rawTransaction).value).toBe(
      quote.amountWei
    );
  });
});

describe('a contact (stealth) payment quote', () => {
  it('counts only the inputs the amount needs, and equals the fee construction pays', async () => {
    // The stealth review used to quote every coin times the most change (about 0.63 MONR on a
    // 0.49 MONR wallet), so no amount could ever pass review.
    for (const amountWei of [parseEther('0.01'), parseEther('0.12'), parseEther('0.7')]) {
      const { preparer } = await setup(FRAGMENTED)
      const request = { amountWei, kdf: () => RECIPIENT, maxPaymentParts: 16 }
      const quote = await preparer.quoteTransactionSet(request)
      const set = await preparer.constructTransactionSet({
        ...request,
        operationId: `stealth-quote-${operations++}`,
        maxFeeWei: quote.feeWei,
      })
      expect(toRecipient(set)).toBe(amountWei)
      expect(feePaid(set)).toBe(quote.feeWei)
      expect(quote.inputCount).toBe(
        new Set(set.bundle.map(tx => tx.sourceAccount)).size,
      )
    }
  })

  it('a small payment from a wallet of many coins draws on one coin', async () => {
    const { preparer } = await setup(FRAGMENTED)
    const quote = await preparer.quoteTransactionSet({
      amountWei: parseEther('0.01'),
      kdf: () => RECIPIENT,
      maxPaymentParts: 16,
    })
    expect(quote.inputCount).toBe(1)
    expect(quote.feeWei).toBeLessThan(total(FRAGMENTED))
  })
})
