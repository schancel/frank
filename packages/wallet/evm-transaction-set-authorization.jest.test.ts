import { Transaction, Wallet } from "ethers";
import { EvmCoinList } from "./evm-coin-list";
import { MemoryRecordStore } from "./storage/evm-coin-store";
import { EvmNativeOperationJournal } from "./storage/evm-native-operation-journal";
import { EvmTransactionSetPreparer } from "./evm-transaction-set";
import type { EvmTransactionSetPolicy } from "./evm-transaction-set-types";
const signer = (index: number) =>
  new Wallet("0x" + index.toString(16).padStart(64, "0"));
const policy: EvmTransactionSetPolicy = {
  sourceOrder: [
    "stealth",
    "stamp",
    "change",
    "deterministic",
    "root",
    "identity",
  ],
  gasPriceWei: 1n,
  paymentGasLimit: () => 21000n,
  changeGasLimit: 21000n,
  paymentFeeIsExact: true,
  dustWei: 1000n,
  radix: 2,
  jitterBps: 1500,
  maxChangeOutputs: 16,
  head: 100,
};
async function setup(values = [1000000n, 900000n], selectedPolicy = policy) {
  const store = new MemoryRecordStore<
    import("./evm-coin-list").StoredEvmListCoin
  >();
  const coins = await EvmCoinList.open(store);
  for (const [index, valueWei] of values.entries())
    await coins.put({
      account: signer(index + 1).address,
      privateKey: signer(index + 1).privateKey,
      nonce: 4,
      valueWei,
      origin: "stealth",
      lastSpentInBlock: 50,
    });
  const journal = new EvmNativeOperationJournal({
    testOnlyEphemeral: true,
    binding: {
      chainIdentifier: "monad-testnet",
      nativeChainId: "10143",
      publicTuple: "test",
    },
  });
  await journal.Open();
  const options = {
    coins,
    journal,
    policy: () => selectedPolicy,
    recoverySpendRule: selectedPolicy.spendRule,
    random: () => 0.01,
    deriveChange: (index: number) => ({
      account: signer(100 + index).address.toLowerCase(),
      privateKey: signer(100 + index).privateKey,
      changeIndex: index,
    }),
  };
  return {
    store,
    coins,
    journal,
    options,
    preparer: new EvmTransactionSetPreparer(options),
  };
}

import { getBytes, hexlify } from "ethers";
import { evmTransactionSetCapability } from "./evm-transaction-set-public";
import {
  createEvmStealthPayments,
  type EvmStealthPreparation,
  type EvmStealthPaymentDriver,
} from "./chain/evm-stealth-payments";
it("snapshots the public KDF before asynchronous construction", async () => {
  const f = await setup();
  const request = {
    operationId: "mutation",
    amountAtomic: 300000n,
    kdf: () => getBytes(signer(50).address),
  };
  const pending = evmTransactionSetCapability(
    f.preparer
  ).constructTransactionSet(request);
  request.kdf = () => getBytes(signer(51).address);
  const result = await pending;
  expect(Transaction.from(hexlify(result.bundle[0].rawTransaction)).to).toBe(
    signer(50).address
  );
  expect(
    f.journal
      .list()[0]
      .members.some(
        (m) =>
          m.signed &&
          Transaction.from(m.signed.rawTransaction).to === signer(50).address
      )
  ).toBe(true);
});
it("retains the authorized stamp reserve despite caller mutation during persistence", async () => {
  const f = await setup();
  const store = new MemoryRecordStore<EvmStealthPreparation>();
  const stamp = { amountAtomic: 200000n, maxNativeFeeAtomic: 100000n };
  const original = store.compareAndPut.bind(store);
  jest
    .spyOn(store, "compareAndPut")
    .mockImplementation(async (id, old, next) => {
      const result = await original(id, old, next);
      if (next.feeAuthorization.status === "approved") {
        stamp.amountAtomic = 1n;
        stamp.maxNativeFeeAtomic = 1n;
      }
      return result;
    });
  const construct = jest.fn(async (request) => {
    await f.preparer.constructTransactionSet(request);
    return f.preparer.getOperation(request.operationId)!;
  });
  const driver = {
    chainIdentifier: "monad-testnet",
    nativeChainId: 10143n,
    coordinationKey: "mutation-review",
    store,
    assertActive() {},
    refreshJournal: async () => {},
    operations: () => f.journal.list(),
    derive: () => ({
      stealthAddress: signer(50).address,
      ephemeralPubKey: getBytes(signer(50).signingKey.compressedPublicKey),
    }),
    constructNativePayment: construct,
  } as unknown as EvmStealthPaymentDriver;
  const result = await createEvmStealthPayments(driver).prepare({
    operationId: "stamp-mutation",
    chainIdentifier: "monad-testnet",
    asset: { kind: "native" },
    amountAtomic: 300000n,
    recipientSpendPublicKey: getBytes(
      signer(50).signingKey.compressedPublicKey
    ),
    maxNativeFeeAtomic: 200000n,
    messageStamp: stamp,
  });
  expect(result.members.length).toBeGreaterThan(0);
  expect(store.get("stamp-mutation")!.messageStamp).toEqual({
    amountAtomic: "200000",
    maxNativeFeeAtomic: "100000",
  });
  expect(construct.mock.calls[0][0].reserveForContinuationWei).toBe(300000n);
  expect(construct.mock.calls[0][0].maxFeeWei).toBe(300000n);
});
