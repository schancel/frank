import { Wallet, Transaction, getBytes, hexlify } from "ethers";
import { MemoryRecordStore } from "../storage/evm-coin-store";
import {
  EvmNativeOperationJournal,
  evmNativeOperationDigest,
} from "../storage/evm-native-operation-journal";
import {
  createEvmStealthPayments,
  type EvmStealthPreparation,
  type EvmStealthPaymentDriver,
} from "./evm-stealth-payments";

const source = new Wallet("0x" + "51".repeat(32));
const recipient = new Wallet("0x" + "52".repeat(32));
const binding = {
  chainIdentifier: "monad-testnet",
  nativeChainId: "10143",
  publicTuple: "legacy-fixture",
};
const intent = {
  operationId: "old-payment",
  chainIdentifier: binding.chainIdentifier,
  asset: { kind: "native" as const },
  recipientSpendPublicKey: getBytes(recipient.signingKey.compressedPublicKey),
  amountAtomic: 1000n,
  maxNativeFeeAtomic: 21000n,
};
// Shape emitted by git 735176a3 evm-stealth-payments.ts ensureIntent/ensureAllocation: quoted allocation, no signed journal required.
function retained(approved = false): EvmStealthPreparation {
  return {
    version: 2,
    operationId: intent.operationId,
    chainIdentifier: binding.chainIdentifier,
    asset: { kind: "native" },
    recipientSpendPublicKey: hexlify(intent.recipientSpendPublicKey),
    amountAtomic: "1000",
    feeAuthorization: approved
      ? { status: "approved", maxNativeFeeAtomic: "21000" }
      : { status: "unapproved" },
    recipientAddress: recipient.address.toLowerCase(),
    ephemeralPublicKey: hexlify(intent.recipientSpendPublicKey),
    allocation: {
      sources: [
        {
          sourceAddress: source.address.toLowerCase(),
          recipientAmountAtomic: "1000",
          nativeBalanceAtomic: "22000",
          assetBalanceAtomic: "22000",
          estimatedNativeFeeAtomic: "21000",
        },
      ],
    },
  };
}
async function fixture(row = retained()) {
  const store = new MemoryRecordStore<EvmStealthPreparation>();
  await store.put(row.operationId, row);
  const journal = new EvmNativeOperationJournal({
    binding,
    testOnlyEphemeral: true,
  });
  await journal.Open();
  const signIndependentPayment = jest.fn<
    EvmStealthPaymentDriver["signIndependentPayment"] extends (
      ...args: infer A
    ) => infer R
      ? R
      : never,
    Parameters<EvmStealthPaymentDriver["signIndependentPayment"]>
  >(async (input) => {
    const transactions = input.members.map((member) =>
      Transaction.from({
        type: 2,
        chainId: 10143,
        nonce: 0,
        to: input.recipient.raw,
        value: member.value,
        gasLimit: member.gasLimit ?? 21000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      })
    );
    const operation = await journal.prepare({
      kind: input.kind,
      preparationId: input.preparationId,
      recipient: input.recipient.raw,
      intendedValueWei: "1000",
      members: transactions.map((tx) => ({
        source: { kind: "main", address: source.address.toLowerCase() },
        dependencies: [],
        unsignedTransaction: tx.unsignedSerialized,
      })),
    });
    for (const [index, tx] of transactions.entries())
      await journal.checkpointSigned(
        operation.operationId,
        index,
        await source.signTransaction(tx)
      );
    return journal.get(operation.operationId);
  });
  const driver: EvmStealthPaymentDriver = {
    chainIdentifier: binding.chainIdentifier,
    nativeChainId: 10143n,
    coordinationKey: `legacy-${Math.random()}`,
    store,
    assertActive() {},
    refreshJournal: async (id) => {
      await journal.refreshPreparation(id);
    },
    readPreparation: (id) => journal.refreshPreparation(id),
    operations: () => journal.list(),
    derive: jest.fn(() => ({
      stealthAddress: recipient.address,
      ephemeralPubKey: intent.recipientSpendPublicKey,
    })),
    quote: jest.fn(async () => {
      throw new Error("must retain old allocation");
    }),
    quoteNative: jest.fn(async () => ({
      nativeBalanceAtomic: 22000n,
      assetBalanceAtomic: 22000n,
      estimatedNativeFeeAtomic: 21000n,
    })),
    constructNativePayment: jest.fn(async () => {
      throw new Error("must not reinterpret v2");
    }),
    signIndependentPayment,
    tokenBalance: async () => 0n,
    tokenReceipt: async () => undefined,
    submit: jest.fn(async () => undefined),
    observe: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
  };
  return {
    store,
    journal,
    driver,
    signIndependentPayment,
    payment: createEvmStealthPayments(driver),
  };
}

test.each([false, true])(
  "retains v2 approved=%s without startup signing and explicitly continues original allocation",
  async (approved) => {
    const row = retained(approved),
      f = await fixture(row);
    try {
      await f.payment.recoverReleases();
      expect(f.store.all()).toEqual([row]);
      expect(f.signIndependentPayment).not.toHaveBeenCalled();
      expect((await f.payment.quote!(intent)).sources[0]!.sourceAddress).toBe(
        source.address.toLowerCase()
      );
      const prepared = await f.payment.prepare(intent);
      expect(f.signIndependentPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          preparationId: "stealth-payment:old-payment",
          kind: "native",
          members: [
            {
              sourceAddress: source.address.toLowerCase(),
              value: 1000n,
              gasLimit: 21000n,
            },
          ],
        })
      );
      expect(f.store.get(intent.operationId)!.version).toBe(2);
      expect((await f.payment.prepare(intent)).members).toEqual(
        prepared.members
      );
      expect(f.signIndependentPayment).toHaveBeenCalledTimes(1);
      expect(f.driver.constructNativePayment).not.toHaveBeenCalled();
      expect(f.driver.derive).not.toHaveBeenCalled();
    } finally {
      await f.journal.Close();
    }
  }
);

test("recovers signed crash-before-link and durable original bytes independently of the active-list view", async () => {
  const f = await fixture(retained(true));
  try {
    const first = await f.payment.prepare(intent);
    const row = f.store.get(intent.operationId)!,
      id = row.journalOperationId!;
    const { journalOperationId: _id, ...unlinked } = row;
    await f.store.put(intent.operationId, unlinked);
    expect(
      (await createEvmStealthPayments(f.driver).prepare(intent)).members
    ).toEqual(first.members);
    await f.payment.expose({
      operationId: intent.operationId,
      payloadDigest: "ab".repeat(32),
    });
    await f.payment.submit(intent.operationId);
    expect(f.driver.submit).toHaveBeenCalledWith(id);
    await f.journal.markExposed(id, 0);
    await f.journal.recordObservation(
      f.journal.beginCapture(id, 0),
      {
        state: "included-success",
        transactionHash: first.members[0]!.txHash,
        blockHash: "0x" + "cd".repeat(32),
        blockNumber: 2,
        transactionIndex: 0,
        feeWei: "21000",
      },
      {
        blockHash: "0x" + "cd".repeat(32),
        blockNumber: 2,
        nonce: 1,
        balanceWei: "0",
      }
    );
    // Completed legacy native rows are not archivable under the journal's current policy.
    // Recovery still uses the durable lookup, independently of the active-list projection.
    f.driver.operations = () => [];
    const reopened = createEvmStealthPayments(f.driver);
    await reopened.recoverReleases();
    expect((await reopened.get(intent.operationId))!.members).toEqual(
      first.members
    );
    expect((await reopened.prepare(intent)).members).toEqual(first.members);
    expect((await reopened.reconcile(intent.operationId)).status).toBe(
      "succeeded"
    );
    expect(f.signIndependentPayment).toHaveBeenCalledTimes(1);
    expect(await reopened.release(intent.operationId)).toBe(false);
  } finally {
    await f.journal.Close();
  }
});

test.each([
  "linked",
  "exposed",
  "combined-stamp",
  "foreign-chain",
  "changed-allocation",
  "changed-fee",
  "changed-linked-id",
  "missing-allocation",
  "wrong-preparation-reader",
] as const)("refuses unsafe v2 continuation: %s", async (condition) => {
  const f = await fixture(retained(true));
  try {
    if (
      condition.startsWith("changed-") ||
      condition === "wrong-preparation-reader"
    )
      await f.payment.prepare(intent);
    const row = f.store.get(intent.operationId)!;
    if (condition === "missing-allocation") {
      delete row.allocation;
      row.feeAuthorization = { status: "unapproved" };
    }
    if (condition === "wrong-preparation-reader") {
      const wrong = {
        ...f.journal.list()[0]!,
        preparationId: "stealth-payment:another-operation",
      };
      f.driver.readPreparation = async () => wrong;
    }
    if (condition === "linked") row.journalOperationId = "missing-original";
    if (condition === "exposed") row.payloadDigest = "ab".repeat(32);
    if (condition === "foreign-chain") row.chainIdentifier = "ethereum-sepolia";
    if (condition === "changed-allocation")
      row.allocation!.sources[0]!.sourceAddress =
        recipient.address.toLowerCase();
    if (condition === "changed-fee")
      row.feeAuthorization = { status: "approved", maxNativeFeeAtomic: "0" };
    if (condition === "changed-linked-id")
      row.journalOperationId = "different-original";
    await f.store.put(intent.operationId, row);
    f.signIndependentPayment.mockClear();
    await expect(
      f.payment.prepare({
        ...intent,
        ...(condition === "combined-stamp"
          ? { messageStamp: { amountAtomic: 1n, maxNativeFeeAtomic: 21000n } }
          : {}),
      })
    ).rejects.toThrow();
    expect(f.signIndependentPayment).not.toHaveBeenCalled();
    expect(f.driver.constructNativePayment).not.toHaveBeenCalled();
    expect(f.store.get(intent.operationId)).toEqual(row);
  } finally {
    await f.journal.Close();
  }
});

test("released original is recovered through its original authority and never signed again", async () => {
  const f = await fixture(retained(true));
  try {
    await f.payment.prepare(intent);
    const row = {
      ...f.store.get(intent.operationId)!,
      released: true as const,
    };
    await f.store.put(intent.operationId, row);
    await createEvmStealthPayments(f.driver).recoverReleases();
    expect(f.driver.release).toHaveBeenCalledWith(row.journalOperationId);
    await expect(f.payment.prepare(intent)).rejects.toThrow(/released/);
    expect(f.signIndependentPayment).toHaveBeenCalledTimes(1);
    expect(f.store.get(intent.operationId)).toEqual(row);
  } finally {
    await f.journal.Close();
  }
});

test("released cancelled v2 tombstone remains authoritative after archival", async () => {
  const f = await fixture(retained(true));
  try {
    await f.payment.prepare(intent);
    const row = {
      ...f.store.get(intent.operationId)!,
      released: true as const,
    };
    await f.store.put(intent.operationId, row);
    const cancelled = await f.journal.discardUnexposed(row.journalOperationId!);
    await f.journal.archiveCompleted(cancelled.operationId, {
      expectedOperationHash: evmNativeOperationDigest(cancelled),
      ownerReference: "test:legacy-release",
      sync: "not-required",
      delivery: "complete",
      dependencies: "complete",
    });
    expect(f.journal.list()).toEqual([]);
    const reopened = createEvmStealthPayments(f.driver);
    await reopened.recoverReleases();
    expect(await reopened.get(intent.operationId)).toBeUndefined();
    expect(await reopened.list()).toEqual([]);
    expect(await reopened.release(intent.operationId)).toBe(true);
    await expect(reopened.prepare(intent)).rejects.toThrow(/released/);
    expect(f.store.get(intent.operationId)).toEqual(row);
    expect(f.signIndependentPayment).toHaveBeenCalledTimes(1);
  } finally {
    await f.journal.Close();
  }
});
