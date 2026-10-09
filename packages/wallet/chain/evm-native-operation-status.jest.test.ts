import { Transaction, Wallet } from "ethers";
import {
  EvmNativeOperationJournal,
  type EvmNativeObservation,
} from "../storage/evm-native-operation-journal";
import {
  summarizeEvmNativeOperation,
  findEvmNativeOperationStatus,
} from "./evm-native-operation-status";

const signer = new Wallet("0x" + "41".repeat(32));
const staging = new Wallet("0x" + "42".repeat(32));
const recipient = "0x000000000000000000000000000000000000dead";
const binding = {
  chainIdentifier: "monad-testnet",
  nativeChainId: "10143",
  publicTuple: "projection test",
};
const hash = "0x" + "12".repeat(32);

async function retained(fanIn = false) {
  const journal = new EvmNativeOperationJournal({
    binding,
    testOnlyEphemeral: true,
  });
  await journal.Open();
  const signers = fanIn ? [signer, staging] : [signer];
  let row = await journal.prepare({
    kind: "legacy",
    recipient,
    intendedValueWei: "1000",
    members: signers.map((wallet, index) => ({
      source: { kind: "main", address: wallet.address.toLowerCase() },
      unsignedTransaction: Transaction.from({
        type: 2,
        chainId: 10143n,
        nonce: 0,
        to: fanIn && index === 0 ? staging.address : recipient,
        value: 1000n,
        gasLimit: 21000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      }).unsignedSerialized,
      dependencies: index ? [0] : [],
    })),
  });
  for (let index = 0; index < signers.length; index++) {
    row = await journal.checkpointSigned(
      row.operationId,
      index,
      await signers[index]!.signTransaction(
        Transaction.from(row.members[index]!.unsignedTransaction)
      )
    );
  }
  const observe = async (
    index: number,
    state: EvmNativeObservation["state"]
  ) => {
    await journal.recordObservation(
      journal.beginCapture(row.operationId, index),
      state === "included-success" || state === "included-revert"
        ? {
            state,
            transactionHash: row.members[index]!.signed!.transactionHash,
            blockHash: hash,
            blockNumber: 5,
            transactionIndex: index,
            feeWei: "21000",
          }
        : { state },
      null
    );
    return summarizeEvmNativeOperation(journal.get(row.operationId));
  };
  return { journal, row, observe };
}

it.each([
  "unknown",
  "missing",
  "pending",
  "included-revert",
  "included-success",
] as const)(
  "projects %s evidence without inventing payment or fees",
  async (state) => {
    const fixture = await retained();
    try {
      const status = await fixture.observe(0, state);
      expect(status.payment).toBe(
        state === "included-success"
          ? "included"
          : state === "included-revert"
          ? "reverted"
          : state === "pending"
          ? "pending"
          : "unknown"
      );
      expect(status.feeCoverage).toBe(
        state.startsWith("included") ? "complete" : "unknown"
      );
      expect(status.syncCallbackComplete).toBe(false);
      expect(status.intendedValueWei).toBe("1000");
      expect(status.members[0]!.transactionHash).toBe(
        fixture.row.members[0]!.signed!.transactionHash
      );
      const serialized = JSON.stringify(status);
      for (const forbidden of [
        "rawTransaction",
        "unsignedTransaction",
        "publicTuple",
        "source",
        signer.privateKey,
        fixture.row.members[0]!.signed!.rawTransaction,
      ])
        expect(serialized).not.toContain(forbidden);
    } finally {
      await fixture.journal.Close();
    }
  }
);

it("keeps partial fan-in separate from recipient inclusion and incomplete total fees", async () => {
  const fixture = await retained(true);
  try {
    const partial = await fixture.observe(0, "included-success");
    expect(partial).toMatchObject({
      payment: "partial",
      observedFeeWei: "21000",
      feeCoverage: "partial",
    });
    const included = await fixture.observe(1, "included-success");
    expect(included).toMatchObject({
      payment: "included",
      observedFeeWei: "42000",
      feeCoverage: "complete",
      syncCallbackComplete: false,
    });
    await fixture.journal.markSyncApplied(fixture.row.operationId, 0);
    expect(
      summarizeEvmNativeOperation(fixture.journal.get(fixture.row.operationId))
        .syncCallbackComplete
    ).toBe(false);
    await fixture.journal.markSyncApplied(fixture.row.operationId, 1);
    expect(
      summarizeEvmNativeOperation(fixture.journal.get(fixture.row.operationId))
        .syncCallbackComplete
    ).toBe(true);
  } finally {
    await fixture.journal.Close();
  }
});

it("associates only a unique final hash on the captured chain and rejects mismatching recipient evidence", async () => {
  const fixture = await retained(true);
  try {
    const status = await fixture.observe(1, "included-success");
    expect(
      findEvmNativeOperationStatus(
        [status],
        binding.chainIdentifier,
        status.finalTransactionHash
      )
    ).toBe(status);
    expect(
      findEvmNativeOperationStatus(
        [status, status],
        binding.chainIdentifier,
        status.finalTransactionHash
      )
    ).toBeUndefined();
    expect(
      findEvmNativeOperationStatus(
        [status],
        "monad-mainnet",
        status.finalTransactionHash
      )
    ).toBeUndefined();
    expect(
      findEvmNativeOperationStatus(
        [status],
        binding.chainIdentifier,
        fixture.row.members[0]!.signed!.transactionHash
      )
    ).toBeUndefined();
    expect(
      findEvmNativeOperationStatus(
        [status],
        binding.chainIdentifier,
        "not-a-hash"
      )
    ).toBeUndefined();
    expect(() =>
      summarizeEvmNativeOperation({ ...fixture.row, intendedValueWei: "2000" })
    ).toThrow("recipient evidence");
    const bad = fixture.journal.get(fixture.row.operationId);
    bad.members[1]!.observation = {
      state: "included-success",
      transactionHash: hash,
      blockHash: hash,
      blockNumber: 5,
      transactionIndex: 1,
      feeWei: "1",
    };
    expect(() => summarizeEvmNativeOperation(bad)).toThrow(
      "does not match signed"
    );
  } finally {
    await fixture.journal.Close();
  }
});
