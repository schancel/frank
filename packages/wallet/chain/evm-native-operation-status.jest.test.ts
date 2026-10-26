import { Transaction, Wallet } from "ethers";
import {
  EvmNativeOperationJournal,
  type EvmNativeObservation,
} from "../storage/evm-native-operation-journal";
import {
  classifyEvmOperation,
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
          : state === "missing"
          ? "missing"
          : "unknown"
      );
      expect(status.feeCoverage).toBe(
        state.startsWith("included") ? "complete" : "unknown"
      );
      // Only a member included with success is ever shared with the account's other devices.
      expect(status.sharing).toBe(
        state === "included-success" ? "not-shared" : "none"
      );
      expect(status.intendedValueWei).toBe("1000");
      expect(status.members[0]!.transactionHash).toBe(
        fixture.row.members[0]!.signed!.transactionHash
      );
      // Every member of an operation that is not a transaction set pays the recipient.
      expect(status.members[0]!.role).toBe("payment");
      expect(status.members[0]!.blockHash).toBe(
        state.startsWith("included") ? hash : undefined
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

it("a transfer the node no longer knows, its account's nonce past it, is final: superseded, not offered again", async () => {
  const fixture = await retained();
  try {
    // The look that finds no transfer and the account's nonce already past the transfer's own.
    await fixture.journal.recordObservation(
      fixture.journal.beginCapture(fixture.row.operationId, 0),
      { state: "missing" },
      { blockHash: hash, blockNumber: 9, nonce: 1, balanceWei: "0" }
    );
    const status = summarizeEvmNativeOperation(
      fixture.journal.get(fixture.row.operationId)
    );
    expect(status.payment).toBe("superseded");
    expect(status.members[0]!.state).toBe("superseded");
    // Nothing landed, so nothing is, or ever will be, shared: not "not yet shared".
    expect(status.sharing).toBe("none");
    // Missing with the nonce still free stays "missing": the same bytes are offered again.
    await fixture.journal.recordObservation(
      fixture.journal.beginCapture(fixture.row.operationId, 0),
      { state: "missing" },
      { blockHash: hash, blockNumber: 10, nonce: 0, balanceWei: "0" }
    );
    expect(
      summarizeEvmNativeOperation(fixture.journal.get(fixture.row.operationId)).payment
    ).toBe("missing");
  } finally {
    await fixture.journal.Close();
  }
});

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
      sharing: "not-shared",
    });
    const sharing = (failed?: boolean) =>
      summarizeEvmNativeOperation(
        fixture.journal.get(fixture.row.operationId),
        failed
      ).sharing;
    // A failed attempt is session information; it is never shown once every member is shared.
    expect(sharing(true)).toBe("failed");
    await fixture.journal.markSyncApplied(fixture.row.operationId, 0);
    expect(sharing()).toBe("not-shared");
    await fixture.journal.markSyncApplied(fixture.row.operationId, 1);
    expect(sharing()).toBe("shared");
    expect(sharing(true)).toBe("shared");
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

const MESSAGE = "0123456789abcdef0123456789abcdef";

it("names every kind of send the wallet makes from its operation identity", () => {
  const set = (id: string) => `evm-transaction-set:${id}`;
  expect(classifyEvmOperation(set(`stamp-${MESSAGE}`))).toEqual({
    purpose: "stamp",
    messageId: MESSAGE,
  });
  // A stamp paid again after its coins were taken is still that message's stamp.
  expect(classifyEvmOperation(set(`stamp-${MESSAGE}-r2`))).toEqual({
    purpose: "stamp",
    messageId: MESSAGE,
  });
  expect(classifyEvmOperation(set(`contact-${MESSAGE}`))).toEqual({
    purpose: "contact-payment",
    messageId: MESSAGE,
  });
  // A payment made in a chat is a payment to a contact, as Send to Contact is.
  expect(classifyEvmOperation(set(`stealth-${"ab".repeat(32)}`))).toEqual({
    purpose: "contact-payment",
  });
  expect(classifyEvmOperation("stealth-payment:chat-payment-1")).toEqual({
    purpose: "contact-payment",
  });
  expect(classifyEvmOperation(set(`forum-${"cd".repeat(16)}`))).toEqual({
    purpose: "forum",
  });
  // Creating a group, or writing in one, pays for a group write; it is no forum post.
  expect(classifyEvmOperation(set(`group-write-${"ef".repeat(32)}`))).toEqual({
    purpose: "group-write",
  });
  expect(classifyEvmOperation(set(`legacy-${"12".repeat(16)}`))).toEqual({
    purpose: "transfer",
  });
  expect(classifyEvmOperation(undefined)).toEqual({ purpose: "transfer" });
  expect(classifyEvmOperation(`tx-0x${"34".repeat(32)}`)).toEqual({
    purpose: "transfer",
  });
  // A message's stamp appended to a payment is that message's stamp.
  expect(
    classifyEvmOperation(set(`stealth-${"ab".repeat(32)}`), `stamp-${MESSAGE}`)
  ).toEqual({ purpose: "stamp", messageId: MESSAGE });
});
