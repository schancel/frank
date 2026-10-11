/** Unit facts at the pure proof boundary; no chain, relay, wallet or integration simulator. */
import { decodeRlp, encodeRlp, Transaction, Wallet } from "ethers";
import {
  evaluateReceivedEvidence,
  type ReceivedEvidenceFact,
  type ReceivedEvidenceReceipt,
} from "./evm-received-evidence";

const payer = new Wallet(`0x${"11".repeat(32)}`);
const recipient = new Wallet(`0x${"22".repeat(32)}`);
const otherPayer = new Wallet(`0x${"33".repeat(32)}`);
const chainIdentifier = "monad-testnet";
const nativeChainId = 10143n;
const blockHash = `0x${"ab".repeat(32)}`;
const headHash = `0x${"cd".repeat(32)}`;
const sign = (
  overrides: Parameters<Wallet["signTransaction"]>[0] = {},
  wallet = payer
) =>
  wallet.signTransaction({
    to: recipient.address,
    value: 10n,
    nonce: 0,
    chainId: nativeChainId,
    gasLimit: 21000n,
    gasPrice: 2n,
    type: 0,
    ...overrides,
  });
function fact(
  raw: string,
  receipt?: ReceivedEvidenceReceipt
): ReceivedEvidenceFact {
  const hash = Transaction.from(raw).hash!;
  return {
    chainIdentifier,
    transactionHash: hash,
    rawTransaction: raw,
    receipt: receipt ?? {
      kind: "included",
      transactionHash: hash,
      blockNumber: 9,
      blockHash,
      status: 1,
    },
  };
}
function evaluate(
  candidates: readonly string[],
  facts: readonly ReceivedEvidenceFact[],
  extra: Partial<Parameters<typeof evaluateReceivedEvidence>[0]> = {}
) {
  return evaluateReceivedEvidence({
    owner: {
      chainIdentifier,
      nativeChainId,
      recipientAddress: recipient.address,
    },
    head: { number: 10, hash: headHash },
    candidates,
    facts,
    canonicalBlocks: [
      {
        chainIdentifier,
        number: 9,
        hash: blockHash,
        transactionHashes: facts.map((entry) => entry.transactionHash),
      },
    ],
    ...extra,
  });
}

it("sums exact canonical values once across raw/hash duplicates and input order", async () => {
  const first = await sign({ value: 900719925474099312345n });
  const second = await sign({ value: 7n }, otherPayer);
  const hash = Transaction.from(first).hash!;
  for (const candidates of [
    [hash, first, second, first],
    [second, first, hash],
  ]) {
    const result = evaluate(candidates, [fact(first), fact(second)]);
    expect(result.verifiedReceivedWei).toBe(900719925474099312352n);
    expect(result.verifiedTransactions).toHaveLength(2);
    expect(result.issues).toEqual([]);
    expect(result.rejected).toEqual([]);
  }
});

it("uses a carried signed raw when a hash-only fact has no transaction bytes", async () => {
  const raw = await sign();
  const withRaw = fact(raw);
  const { rawTransaction: _raw, ...hashOnly } = withRaw;
  for (const candidates of [
    [withRaw.transactionHash, raw],
    [raw, withRaw.transactionHash],
  ]) {
    expect(evaluate(candidates, [hashOnly]).verifiedReceivedWei).toBe(10n);
  }
});

it("resolves a hash through actual signed bytes, never a peer's claimed amount", async () => {
  const raw = await sign({ value: 3n });
  expect(
    evaluate([Transaction.from(raw).hash!], [fact(raw)]).verifiedReceivedWei
  ).toBe(3n);
});

it("an absent original and successful same-nonce replacement do not both count", async () => {
  const original = await sign();
  const replacement = await sign({ gasPrice: 3n, value: 12n });
  // Only replacement is canonical; the consumed original hash is simply unknown to this check.
  const result = evaluate(
    [original, replacement],
    [fact(original, { kind: "pending" }), fact(replacement)]
  );
  expect(result.verifiedReceivedWei).toBe(12n);
  expect(result.pendingTransactionHashes).toEqual([]);
  expect(result.supersededTransactionHashes).toEqual([
    Transaction.from(original).hash,
  ]);
});

it("a reverted original contributes zero and fresh-nonce repayment contributes its actual value", async () => {
  const original = await sign();
  const repayment = await sign({ nonce: 1, value: 14n });
  const failed = fact(original);
  const result = evaluate(
    [original, repayment],
    [
      {
        ...failed,
        receipt: {
          kind: "included",
          transactionHash: failed.transactionHash,
          blockNumber: 9,
          blockHash,
          status: 0,
        },
      },
      fact(repayment),
    ]
  );
  expect(result.verifiedReceivedWei).toBe(14n);
  expect(result.revertedTransactionHashes).toEqual([failed.transactionHash]);
});

it.each([
  ["wrong-native-chain", { chainId: 1n }],
  ["wrong-recipient", { to: otherPayer.address }],
  ["not-plain-positive-transfer", { data: "0x1234" }],
  ["not-plain-positive-transfer", { value: 0n }],
] as const)(
  "rejects %s without inventing receipt value",
  async (reason, overrides) => {
    const raw = await sign(overrides);
    const result = evaluate([raw], [fact(raw)]);
    expect(result.verifiedReceivedWei).toBe(0n);
    expect(result.rejected).toEqual([{ candidateIndex: 0, reason }]);
  }
);

it("excludes self-transfer value and malformed/unsigned candidates separately from missing evidence", async () => {
  const self = await sign({}, recipient);
  const unsigned = Transaction.from({
    to: recipient.address,
    value: 2n,
  }).unsignedSerialized;
  const result = evaluate([self, "invalid", unsigned], [fact(self)]);
  expect(result.verifiedReceivedWei).toBe(0n);
  expect(result.rejected.map((entry) => entry.reason).sort()).toEqual([
    "malformed-proof",
    "self-transfer",
    "unsigned-transaction",
  ]);
  expect(result.issues).toEqual([]);
});

it.each(["rpc-unavailable", "receipt-unavailable"] as const)(
  "preserves independently verified value when another receipt is %s",
  async (reason) => {
    const known = await sign();
    const missing = await sign({}, otherPayer);
    const result = evaluate(
      [known, missing],
      [fact(known), fact(missing, { kind: "unavailable", reason })]
    );
    expect(result.verifiedReceivedWei).toBe(10n);
    expect(result.issues).toEqual([
      { reason, transactionHash: Transaction.from(missing).hash },
    ]);
  }
);

it("distinguishes unavailable transaction bytes from unavailable receipt and observed coverage gap", async () => {
  const raw = await sign();
  const hash = Transaction.from(raw).hash!;
  expect(evaluate([hash], []).issues).toEqual([
    { reason: "transaction-unavailable", transactionHash: hash },
  ]);
  expect(evaluate([raw], []).issues).toEqual([
    { reason: "receipt-unavailable", transactionHash: hash },
  ]);
  const result = evaluate([raw], [fact(raw)], {
    coverageIssues: [{ reason: "historical-state-unavailable" }],
  });
  expect(result.verifiedReceivedWei).toBe(10n);
  expect(result.issues).toEqual([{ reason: "historical-state-unavailable" }]);
});

it("requires receipt hash, canonical block identity and block membership", async () => {
  const raw = await sign();
  const entry = fact(raw);
  const receipt = entry.receipt as Extract<
    ReceivedEvidenceReceipt,
    { kind: "included" }
  >;
  const wrongHash = evaluate(
    [raw],
    [{ ...entry, receipt: { ...receipt, transactionHash: headHash } }]
  );
  expect(wrongHash.rejected[0].reason).toBe("receipt-hash-mismatch");
  const reorg = evaluate(
    [raw],
    [{ ...entry, receipt: { ...receipt, blockHash: headHash } }]
  );
  expect(reorg.issues[0].reason).toBe("canonical-head-changed");
  const missingBlock = evaluate([raw], [entry], { canonicalBlocks: [] });
  expect(missingBlock.issues[0].reason).toBe("canonical-block-unavailable");
  const absent = evaluate([raw], [entry], {
    canonicalBlocks: [
      { chainIdentifier, number: 9, hash: blockHash, transactionHashes: [] },
    ],
  });
  expect(absent.verifiedReceivedWei).toBe(0n);
  expect(absent.rejected[0].reason).toBe("not-in-canonical-block");
});

it("excludes receipts later than the pinned head and checks its exact head hash", async () => {
  const raw = await sign();
  const entry = fact(raw);
  const receipt = entry.receipt as Extract<
    ReceivedEvidenceReceipt,
    { kind: "included" }
  >;
  const future = evaluate(
    [raw],
    [{ ...entry, receipt: { ...receipt, blockNumber: 11 } }]
  );
  expect(future.verifiedReceivedWei).toBe(0n);
  expect(future.pendingTransactionHashes).toEqual([entry.transactionHash]);
  const changedHead = evaluate([raw], [entry], {
    head: { number: 9, hash: headHash },
  });
  expect(changedHead.issues[0].reason).toBe("canonical-head-changed");
});

it("rejects cross-chain facts and a hash resolved to another signed transaction", async () => {
  const raw = await sign();
  const another = await sign({ value: 11n });
  const entry = fact(raw);
  expect(
    evaluate([raw], [{ ...entry, chainIdentifier: "ethereum-sepolia" }])
      .rejected[0].reason
  ).toBe("wrong-chain-context");
  expect(
    evaluate([entry.transactionHash], [{ ...entry, rawTransaction: another }])
      .rejected[0].reason
  ).toBe("transaction-hash-mismatch");
});

it("rejects contradictory canonical alternatives at one sender nonce while preserving another payer", async () => {
  const original = await sign();
  const replacement = await sign({ gasPrice: 3n });
  const independent = await sign({ value: 19n }, otherPayer);
  const result = evaluate(
    [original, replacement, independent],
    [fact(original), fact(replacement), fact(independent)]
  );
  expect(result.verifiedReceivedWei).toBe(19n);
  expect(result.rejected.map((entry) => entry.reason)).toEqual([
    "conflicting-canonical-nonce",
    "conflicting-canonical-nonce",
  ]);
});

it("complete known successful proof has no hypothetical future-funding issue, including spent recovery", async () => {
  const raw = await sign();
  // Current balance, spend nonce and claimed amount are deliberately not inputs to receipt value.
  const result = evaluate([raw], [fact(raw)]);
  expect(result.verifiedReceivedWei).toBe(10n);
  expect(result.issues).toEqual([]);
  expect(result.pendingTransactionHashes).toEqual([]);
});

it.each(["candidate", "fact"] as const)(
  "contains signer recovery errors in %s bytes while retaining an independent valid value",
  async (location) => {
    const good = await sign();
    const fields = decodeRlp(good) as string[];
    fields[7] = "0x"; // Zero r is an encoded signature, but cannot recover a secp256k1 signer.
    fields[8] = "0x01";
    const bad = encodeRlp(fields);
    const parsed = Transaction.from(bad);
    expect(parsed.isSigned()).toBe(true);
    expect(() => parsed.from).toThrow();
    const result =
      location === "candidate"
        ? evaluate([bad, good], [fact(good)])
        : evaluate([parsed.hash!, good], [fact(bad), fact(good)]);
    expect(result.verifiedReceivedWei).toBe(10n);
    expect(result.rejected).toEqual([
      { candidateIndex: 0, reason: "malformed-proof" },
    ]);
  }
);

it("contradictory receipt facts never select whichever was supplied first", async () => {
  const raw = await sign();
  const entry = fact(raw);
  const different = { ...entry, receipt: { kind: "pending" as const } };
  for (const facts of [
    [entry, different],
    [different, entry],
  ]) {
    const result = evaluate([raw], facts);
    expect(result.verifiedReceivedWei).toBe(0n);
    expect(result.issues[0].reason).toBe("conflicting-chain-evidence");
  }
});

it("merges complementary receipt bytes in either order without losing verified value", async () => {
  const raw = await sign();
  const complete = fact(raw);
  const { rawTransaction: _raw, ...withoutBytes } = complete;
  for (const facts of [
    [complete, withoutBytes],
    [withoutBytes, complete],
  ]) {
    const result = evaluate([complete.transactionHash], facts);
    expect(result.verifiedReceivedWei).toBe(10n);
    expect(result.verifiedTransactions).toEqual([raw]);
    expect(result.issues).toEqual([]);
    expect(result.rejected).toEqual([]);
  }
});

it.each(["rpc-unavailable", "receipt-unavailable"] as const)(
  "resolves a duplicate %s lookup with a verified receipt in either order",
  async (reason) => {
    const raw = await sign();
    const complete = fact(raw);
    const unavailable = {
      ...complete,
      rawTransaction: undefined,
      receipt: { kind: "unavailable" as const, reason },
    };
    for (const facts of [
      [complete, unavailable],
      [unavailable, complete],
    ]) {
      const result = evaluate([complete.transactionHash], facts);
      expect(result.verifiedReceivedWei).toBe(10n);
      expect(result.verifiedTransactions).toEqual([raw]);
      expect(result.issues).toEqual([]);
      expect(result.rejected).toEqual([]);
    }
  }
);

it.each(["status", "block", "hash", "raw"] as const)(
  "excludes genuinely contradictory %s facts in either order",
  async (field) => {
    const raw = await sign();
    const entry = fact(raw);
    if (entry.receipt.kind !== "included")
      throw new Error("Expected included fixture");
    const conflicting =
      field === "raw"
        ? { ...entry, rawTransaction: await sign({ value: 11n }) }
        : {
            ...entry,
            receipt: {
              ...entry.receipt,
              ...(field === "status"
                ? { status: 0 as const }
                : field === "block"
                ? { blockHash: headHash }
                : { transactionHash: headHash }),
            },
          };
    for (const facts of [
      [entry, conflicting],
      [conflicting, entry],
    ]) {
      const result = evaluate([raw], facts);
      expect(result.verifiedReceivedWei).toBe(0n);
      expect(result.issues).toEqual([
        {
          reason: "conflicting-chain-evidence",
          transactionHash: entry.transactionHash,
        },
      ]);
    }
  }
);

it.each(["recipient", "calldata"] as const)(
  "detects a canonical noncontributing %s alternative at the same sender nonce in either order",
  async (field) => {
    const incoming = await sign();
    const alternative = await sign(
      field === "recipient" ? { to: otherPayer.address } : { data: "0x1234" }
    );
    const independent = await sign({ value: 19n }, otherPayer);
    for (const alternatives of [
      [incoming, alternative],
      [alternative, incoming],
    ]) {
      const result = evaluate(
        [...alternatives, independent],
        [...alternatives.map((raw) => fact(raw)), fact(independent)]
      );
      expect(result.verifiedReceivedWei).toBe(19n);
      expect(result.verifiedTransactions).toEqual([independent]);
      expect(
        result.rejected.filter(
          (entry) => entry.reason === "conflicting-canonical-nonce"
        )
      ).toHaveLength(2);
      expect(
        result.issues.filter(
          (entry) => entry.reason === "conflicting-chain-evidence"
        )
      ).toHaveLength(2);
    }
  }
);

it.each(["wrong-chain", "noncanonical", "malformed"] as const)(
  "does not let a %s alternative poison a canonical incoming receipt",
  async (kind) => {
    const incoming = await sign();
    const alternative = await sign({
      to: otherPayer.address,
      ...(kind === "wrong-chain" ? { chainId: 1n } : {}),
    });
    const alternativeFact = fact(alternative);
    const facts = [
      fact(incoming),
      kind === "noncanonical" && alternativeFact.receipt.kind === "included"
        ? {
            ...alternativeFact,
            receipt: { ...alternativeFact.receipt, blockHash: headHash },
          }
        : alternativeFact,
    ];
    for (const alternatives of [
      [incoming, alternative],
      [alternative, incoming],
    ]) {
      const result = evaluate(
        kind === "malformed" ? [incoming, "0x1234"] : alternatives,
        facts
      );
      expect(result.verifiedReceivedWei).toBe(10n);
      expect(result.verifiedTransactions).toEqual([incoming]);
      expect(
        result.rejected.some(
          (entry) => entry.reason === "conflicting-canonical-nonce"
        )
      ).toBe(false);
    }
  }
);
