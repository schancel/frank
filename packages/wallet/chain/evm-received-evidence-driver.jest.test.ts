/** Unit controls at the injected read seam. No chain/relay simulator or integration claim. */
import { Transaction, Wallet, type TransactionRequest } from "ethers";
import {
  evaluateReceivedEvidence,
  type ReceivedEvidenceBlock,
} from "./evm-received-evidence";
import {
  collectReceivedEvidence,
  type ReceivedEvidenceCollection,
  type ReceivedEvidenceReadRpc,
  type ReceivedEvidenceRpcTransaction,
} from "./evm-received-evidence-driver";

const payer = new Wallet(`0x${"11".repeat(32)}`);
const recipient = new Wallet(`0x${"22".repeat(32)}`);
const independent = new Wallet(`0x${"33".repeat(32)}`);
const owner = {
  chainIdentifier: "monad-testnet",
  nativeChainId: 10143n,
  recipientAddress: recipient.address,
};
const hashAt = (number: number) => `0x${number.toString(16).padStart(64, "0")}`;
const hashOf = (raw: string) => Transaction.from(raw).hash!;
const sign = (overrides: TransactionRequest = {}, wallet = payer) =>
  wallet.signTransaction({
    chainId: owner.nativeChainId,
    type: 0,
    gasPrice: 2n,
    gasLimit: 21000n,
    nonce: 0,
    to: recipient.address,
    value: 10n,
    ...overrides,
  });
function wire(raw: string): ReceivedEvidenceRpcTransaction {
  const tx = Transaction.from(raw);
  return {
    hash: tx.hash!,
    from: tx.from!,
    type: tx.type!,
    chainId: tx.chainId,
    nonce: tx.nonce,
    to: tx.to,
    value: tx.value,
    data: tx.data,
    gasLimit: tx.gasLimit,
    signature: tx.signature!,
    ...(tx.gasPrice === null ? {} : { gasPrice: tx.gasPrice }),
    ...(tx.maxFeePerGas === null ? {} : { maxFeePerGas: tx.maxFeePerGas }),
    ...(tx.maxPriorityFeePerGas === null
      ? {}
      : { maxPriorityFeePerGas: tx.maxPriorityFeePerGas }),
    ...(tx.accessList === null ? {} : { accessList: tx.accessList }),
    ...(tx.maxFeePerBlobGas === null
      ? {}
      : { maxFeePerBlobGas: tx.maxFeePerBlobGas }),
    ...(tx.blobVersionedHashes === null
      ? {}
      : { blobVersionedHashes: tx.blobVersionedHashes }),
    ...(tx.authorizationList === null
      ? {}
      : { authorizationList: tx.authorizationList }),
  };
}
function fixture(
  entries: readonly { raw: string; number: number; status?: 0 | 1 }[] = []
) {
  const calls: { method: string; args: readonly unknown[] }[] = [];
  const record = <T>(method: string, args: readonly unknown[], value: T): T => {
    calls.push({ method, args });
    return value;
  };
  const block = (number: number): ReceivedEvidenceBlock => ({
    chainIdentifier: owner.chainIdentifier,
    number,
    hash: hashAt(number),
    transactionHashes: entries
      .filter((entry) => entry.number === number)
      .map((entry) => hashOf(entry.raw)),
  });
  const rpc: ReceivedEvidenceReadRpc = {
    chainIdentifier: owner.chainIdentifier,
    block: jest.fn(async (number) =>
      record("block", [number], block(number === "latest" ? 10 : number))
    ),
    transaction: jest.fn(async (hash) => {
      const entry = entries.find((item) => hashOf(item.raw) === hash);
      return record(
        "transaction",
        [hash],
        entry === undefined ? null : wire(entry.raw)
      );
    }),
    receipt: jest.fn(async (hash) => {
      const entry = entries.find((item) => hashOf(item.raw) === hash);
      return record(
        "receipt",
        [hash],
        entry === undefined
          ? null
          : {
              kind: "included" as const,
              transactionHash: hash,
              blockNumber: entry.number,
              blockHash: hashAt(entry.number),
              status: entry.status ?? 1,
            }
      );
    }),
    nonce: jest.fn(async (address, number) =>
      record("nonce", [address, number], 0)
    ),
    balance: jest.fn(async (address, number) =>
      record("balance", [address, number], 0n)
    ),
    code: jest.fn(async (address, number) =>
      record("code", [address, number], "0x")
    ),
  };
  const collect = (
    candidates: readonly string[],
    extra: Partial<Parameters<typeof collectReceivedEvidence>[0]> = {}
  ) =>
    collectReceivedEvidence({
      owner,
      candidates,
      rpc,
      signal: new AbortController().signal,
      budget: {
        maxCalls: 500,
        maxFundingBlocks: 8,
        maxTransactionsPerBlock: 100,
        deadlineMs: Date.now() + 10000,
      },
      ...extra,
    });
  return { rpc, calls, collect, block };
}
function checked(result: ReceivedEvidenceCollection) {
  if (result.kind !== "checked")
    throw new Error(`Expected checked, got ${result.kind}`);
  return { result, value: evaluateReceivedEvidence(result) };
}

it("collects original receipts once, pins numeric anchors, and ignores claimed amounts", async () => {
  const raw = await sign();
  const f = fixture([{ raw, number: 9 }]);
  const { result, value } = checked(await f.collect([hashOf(raw), raw, raw]));
  expect(value.verifiedReceivedWei).toBe(10n);
  expect(value.issues).toEqual([]);
  expect(result.candidates).toEqual([raw]);
  expect(result.callsUsed).toBe(f.calls.length);
  expect(f.rpc.receipt).toHaveBeenCalledTimes(1);
  expect(f.rpc.block).toHaveBeenLastCalledWith(10, expect.anything());
  expect(
    f.calls
      .filter((call) => call.method === "block")
      .map((call) => call.args[0])
  ).toEqual(["latest", 9, 9, 10]);
});

it.each([0, 1, 2, 3, 4])(
  "reconstructs complete signed type %s fields from a hash",
  async (type) => {
    const dynamic =
      type >= 2
        ? { gasPrice: null, maxFeePerGas: 3n, maxPriorityFeePerGas: 1n }
        : {};
    const raw = await sign({
      type,
      ...dynamic,
      ...(type >= 1 ? { accessList: [] } : {}),
      ...(type === 3
        ? {
            maxFeePerBlobGas: 1n,
            blobVersionedHashes: [`0x01${"ab".repeat(31)}`],
          }
        : {}),
      ...(type === 4 ? { authorizationList: [] } : {}),
    });
    const f = fixture([{ raw, number: 9 }]);
    const { result, value } = checked(await f.collect([hashOf(raw)]));
    expect(result.candidates).toEqual([raw]);
    expect(value.verifiedReceivedWei).toBe(10n);
  }
);

it.each([
  "missing-fee",
  "wrong-hash",
  "wrong-sender",
  "bad-signature",
] as const)(
  "does not invent signed bytes for %s RPC fields, retaining independent value",
  async (kind) => {
    const good = await sign({}, independent);
    const missing = await sign();
    const f = fixture([
      { raw: good, number: 8 },
      { raw: missing, number: 9 },
    ]);
    const actual = f.rpc.transaction.bind(f.rpc);
    f.rpc.transaction = jest.fn(async (hash) => {
      const tx = await actual(hash);
      if (hash !== hashOf(missing) || tx === null) return tx;
      return {
        ...tx,
        ...(kind === "missing-fee" ? { gasPrice: undefined } : {}),
        ...(kind === "wrong-hash" ? { hash: hashAt(123) } : {}),
        ...(kind === "wrong-sender" ? { from: recipient.address } : {}),
        ...(kind === "bad-signature"
          ? { signature: { r: hashAt(0), s: hashAt(1), v: 27 } }
          : {}),
      };
    });
    const { value } = checked(await f.collect([good, hashOf(missing)]));
    expect(value.verifiedReceivedWei).toBe(10n);
    expect(value.issues).toContainEqual({
      reason: "transaction-unavailable",
      transactionHash: hashOf(missing),
    });
  }
);

it("locates actual same-nonce replacement without broadcasting the immutable original", async () => {
  const original = await sign();
  const replacement = await sign({ value: 12n, gasPrice: 3n });
  const unrelated = await sign({ value: 31n, to: payer.address }, independent);
  const f = fixture([
    { raw: replacement, number: 4 },
    { raw: unrelated, number: 4 },
  ]);
  f.rpc.nonce = jest.fn(async (_address, number) => (number >= 4 ? 1 : 0));
  f.rpc.balance = jest.fn(async () => 12n);
  const { result, value } = checked(await f.collect([original]));
  expect(value.verifiedReceivedWei).toBe(12n);
  expect(value.supersededTransactionHashes).toEqual([hashOf(original)]);
  expect(value.issues).toEqual([]);
  expect(result.candidates).toEqual([original, replacement]);
  expect(f.rpc.receipt).not.toHaveBeenCalledWith(
    hashOf(unrelated),
    expect.anything()
  );
});

it("canonical wrong-recipient replacement contributes no incoming value", async () => {
  const original = await sign();
  const replacement = await sign({ to: independent.address, gasPrice: 3n });
  const f = fixture([{ raw: replacement, number: 4 }]);
  f.rpc.nonce = jest.fn(async (_address, number) => (number >= 4 ? 1 : 0));
  const { value } = checked(await f.collect([original]));
  expect(value.verifiedReceivedWei).toBe(0n);
  expect(value.supersededTransactionHashes).toEqual([hashOf(original)]);
  expect(
    value.rejected.some((entry) => entry.reason === "wrong-recipient")
  ).toBe(true);
});

it("absent hash with no sender/nonce cannot launch replacement discovery", async () => {
  const f = fixture();
  const { value } = checked(await f.collect([hashAt(44)]));
  expect(value.issues).toContainEqual({
    reason: "transaction-unavailable",
    transactionHash: hashAt(44),
  });
  expect(f.rpc.nonce).not.toHaveBeenCalled();
  expect(value.verifiedReceivedWei).toBe(0n);
});

it.each([0, 10])(
  "locates nonce consumption at boundary block %s",
  async (number) => {
    const original = await sign();
    const replacement = await sign({ value: 12n });
    const f = fixture([{ raw: replacement, number }]);
    f.rpc.nonce = jest.fn(async (_address, height) =>
      height >= number ? 1 : 0
    );
    f.rpc.balance = jest.fn(async () => 12n);
    expect(checked(await f.collect([original])).value.verifiedReceivedWei).toBe(
      12n
    );
  }
);

it("does not search history for a nonce that remains unused", async () => {
  const original = await sign();
  const f = fixture();
  const { value } = checked(await f.collect([original]));
  expect(value.pendingTransactionHashes).toEqual([hashOf(original)]);
  expect(f.rpc.transaction).not.toHaveBeenCalled();
  expect(f.rpc.nonce).toHaveBeenCalledTimes(1);
});

it("finds fresh repayment after a revert in a verified zero/nonce-zero window", async () => {
  const reverted = await sign();
  const repaid = await sign({ nonce: 1, value: 12n });
  const f = fixture([
    { raw: reverted, number: 3, status: 0 },
    { raw: repaid, number: 5 },
  ]);
  f.rpc.balance = jest.fn(async (_address, number) => (number < 5 ? 0n : 12n));
  const { value } = checked(await f.collect([reverted], { lowerBlock: 0 }));
  expect(value.verifiedReceivedWei).toBe(12n);
  expect(value.revertedTransactionHashes).toEqual([hashOf(reverted)]);
  expect(value.issues).toEqual([]);
});

it("finds multiple funding blocks and sums only verified transfer values", async () => {
  const first = await sign();
  const second = await sign({ value: 9n }, independent);
  const f = fixture([
    { raw: first, number: 4 },
    { raw: second, number: 7 },
  ]);
  f.rpc.balance = jest.fn(async (_address, number) =>
    number < 4 ? 0n : number < 7 ? 10n : 19n
  );
  const { value } = checked(await f.collect([], { lowerBlock: 0 }));
  expect(value.verifiedReceivedWei).toBe(19n);
  expect(value.issues).toEqual([]);
});

it.each(["no-anchor", "nonzero-anchor", "spent", "code", "internal"] as const)(
  "keeps unexplained funding explicit for %s instead of inferring an amount",
  async (kind) => {
    const f = fixture();
    f.rpc.balance = jest.fn(async (_address, number) =>
      number === 10 ? 12n : kind === "nonzero-anchor" ? 2n : 0n
    );
    if (kind === "spent") f.rpc.nonce = jest.fn(async () => 1);
    if (kind === "code") f.rpc.code = jest.fn(async () => "0xef0100");
    const { value } = checked(
      await f.collect([], kind === "no-anchor" ? {} : { lowerBlock: 0 })
    );
    expect(value.verifiedReceivedWei).toBe(0n);
    expect(
      value.issues.some(
        (issue) =>
          issue.reason ===
          (kind === "spent"
            ? "spent-discovery-unavailable"
            : "unexplained-incoming-value")
      )
    ).toBe(true);
  }
);

it("complete known spent proofs do not create a hypothetical fresh-funding issue", async () => {
  const raw = await sign();
  const f = fixture([{ raw, number: 9 }]);
  f.rpc.nonce = jest.fn(async () => 5);
  const { value } = checked(await f.collect([raw], { lowerBlock: 0 }));
  expect(value.verifiedReceivedWei).toBe(10n);
  expect(value.issues).toEqual([]);
  expect(f.rpc.nonce).not.toHaveBeenCalled();
});

it("retains an independent verified receipt when required history is unavailable", async () => {
  const good = await sign({}, independent);
  const original = await sign();
  const f = fixture([{ raw: good, number: 9 }]);
  f.rpc.nonce = jest.fn(async (_address, number) => {
    if (number !== 10) throw new Error("pruned");
    return 1;
  });
  const { value } = checked(await f.collect([good, original]));
  expect(value.verifiedReceivedWei).toBe(10n);
  expect(value.issues).toContainEqual({
    reason: "historical-state-unavailable",
    transactionHash: hashOf(original),
  });
});

it("reserved anchor calls preserve checked lower bound at the exact method budget", async () => {
  const good = await sign({}, independent);
  const missing = await sign();
  const f = fixture([{ raw: good, number: 9 }]);
  const { result, value } = checked(
    await f.collect([good, missing], {
      budget: {
        maxCalls: 5,
        maxFundingBlocks: 8,
        maxTransactionsPerBlock: 100,
        deadlineMs: Date.now() + 10000,
      },
    })
  );
  expect(result.callsUsed).toBe(5);
  expect(f.calls).toHaveLength(5);
  expect(value.verifiedReceivedWei).toBe(10n);
  expect(value.issues).toContainEqual({ reason: "request-budget-exhausted" });
  expect(f.rpc.block).toHaveBeenLastCalledWith(10, expect.anything());
});

it.each(["funding-block", "transactions"] as const)(
  "bounds one attempt's %s discovery without claiming zero closure",
  async (kind) => {
    const raw = await sign();
    const f = fixture([{ raw, number: 5 }]);
    f.rpc.balance = jest.fn(async (_address, number) =>
      number < 5 ? 0n : 10n
    );
    const { value } = checked(
      await f.collect([], {
        lowerBlock: 0,
        budget: {
          maxCalls: 100,
          maxFundingBlocks: kind === "funding-block" ? 0 : 2,
          maxTransactionsPerBlock: kind === "transactions" ? 0 : 100,
          deadlineMs: Date.now() + 10000,
        },
      })
    );
    expect(value.verifiedReceivedWei).toBe(0n);
    expect(value.issues).toContainEqual({ reason: "request-budget-exhausted" });
  }
);

it("changed pinned head invalidates the entire freshly collected observation", async () => {
  const raw = await sign();
  const f = fixture([{ raw, number: 9 }]);
  f.rpc.block = jest.fn(async (number) => ({
    ...f.block(number === "latest" ? 10 : number),
    ...(number === 10 ? { hash: hashAt(111) } : {}),
  }));
  const result = await f.collect([raw]);
  expect(result.kind).toBe("unavailable");
  if (result.kind !== "unavailable") throw new Error("Expected unavailable");
  expect(result.issue.reason).toBe("canonical-head-changed");
  expect(result).not.toHaveProperty("canonicalBlocks");
  expect(result).not.toHaveProperty("verifiedReceivedWei");
});

it("changed receipt-block anchor excludes that proof but preserves a freshly anchored independent receipt", async () => {
  const first = await sign();
  const second = await sign({}, independent);
  const f = fixture([
    { raw: first, number: 9 },
    { raw: second, number: 8 },
  ]);
  let visits = 0;
  f.rpc.block = jest.fn(async (number) => ({
    ...f.block(number === "latest" ? 10 : number),
    ...(number === 9 && ++visits > 1 ? { hash: hashAt(999) } : {}),
  }));
  const { value } = checked(await f.collect([first, second]));
  expect(value.verifiedReceivedWei).toBe(10n);
  expect(value.issues).toContainEqual({ reason: "canonical-head-changed" });
});

it("a receipt beyond H cannot contribute or create a historical anchor beyond H", async () => {
  const raw = await sign();
  const f = fixture([{ raw, number: 11 }]);
  const { value } = checked(await f.collect([raw]));
  expect(value.verifiedReceivedWei).toBe(0n);
  expect(value.pendingTransactionHashes).toEqual([hashOf(raw)]);
  expect(f.rpc.block).not.toHaveBeenCalledWith(11, expect.anything());
});

it("rejects chain-affinity mismatch before requesting anything", async () => {
  const f = fixture();
  await expect(
    f.collect([], { owner: { ...owner, chainIdentifier: "ethereum-sepolia" } })
  ).rejects.toThrow(TypeError);
  expect(f.calls).toEqual([]);
});

it("pre-abort schedules no read", async () => {
  const f = fixture();
  const abort = new AbortController();
  abort.abort();
  expect(await f.collect([], { signal: abort.signal })).toEqual({
    kind: "cancelled",
    callsUsed: 0,
  });
  expect(f.calls).toEqual([]);
});

it.each([
  "block",
  "transaction",
  "receipt",
  "balance",
  "nonce",
  "code",
] as const)(
  "promptly cancels an unresponsive %s attempt, handles late rejection and schedules no later read",
  async (method) => {
    const original = await sign();
    const f = fixture();
    f.rpc.balance = jest.fn(async (_address, number) =>
      number === 10 ? 1n : 0n
    );
    const abort = new AbortController();
    let entered = false;
    let fail: ((error: Error) => void) | undefined;
    const hanging = jest.fn(() => {
      entered = true;
      return new Promise<never>((_resolve, reject) => {
        fail = reject;
      });
    });
    // The assignment union is avoided by assigning a structurally compatible never-returning method.
    f.rpc[method] = hanging;
    const destroy = jest.fn();
    Object.assign(f.rpc, { destroy });
    const run = f.collect(
      method === "transaction"
        ? [hashAt(44)]
        : method === "code"
        ? []
        : [original],
      { signal: abort.signal, ...(method === "code" ? { lowerBlock: 0 } : {}) }
    );
    for (let i = 0; i < 100 && !entered; i++) await Promise.resolve();
    expect(entered).toBe(true);
    abort.abort();
    const result = await run;
    expect(result.kind).toBe("cancelled");
    const totalCalls = () =>
      (
        ["block", "transaction", "receipt", "balance", "nonce", "code"] as const
      ).reduce(
        (sum, name) => sum + (f.rpc[name] as jest.Mock).mock.calls.length,
        0
      );
    const after = totalCalls();
    fail!(new Error("late transport failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(totalCalls()).toBe(after);
    expect(destroy).not.toHaveBeenCalled();
  }
);

it.each(["read", "final-anchor"] as const)(
  "deadline during %s never exposes unanchored evaluator blocks",
  async (location) => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(0);
      const f = fixture();
      let entered = false;
      const actual = f.rpc.block.bind(f.rpc);
      if (location === "read")
        f.rpc.block = jest.fn(() => {
          entered = true;
          return new Promise<never>(() => {});
        });
      else
        f.rpc.block = jest.fn((number) =>
          number === 10
            ? ((entered = true), new Promise<never>(() => {}))
            : actual(number)
        );
      const run = f.collect([], {
        budget: {
          maxCalls: 100,
          maxFundingBlocks: 8,
          maxTransactionsPerBlock: 100,
          deadlineMs: 50,
        },
      });
      for (let i = 0; i < 100 && !entered; i++) await Promise.resolve();
      expect(entered).toBe(true);
      jest.advanceTimersByTime(51);
      const result = await run;
      expect(result.kind).toBe("unavailable");
      if (result.kind !== "unavailable")
        throw new Error("Expected unavailable");
      expect(result.issue.reason).toBe("deadline-exceeded");
      expect(result).not.toHaveProperty("canonicalBlocks");
    } finally {
      jest.useRealTimers();
    }
  }
);

it("merges mixed-case raw/hash duplicates before any lookup", async () => {
  const raw = await sign();
  const f = fixture([{ raw, number: 9 }]);
  const { result, value } = checked(
    await f.collect([hashOf(raw).toUpperCase(), raw.toUpperCase(), raw])
  );
  expect(result.candidates).toEqual([raw]);
  expect(value.verifiedReceivedWei).toBe(10n);
  expect(f.rpc.receipt).toHaveBeenCalledTimes(1);
  expect(f.rpc.transaction).not.toHaveBeenCalled();
});

it("observes cancellation raised by a completed read before issuing its dependent request", async () => {
  const raw = await sign();
  const f = fixture([{ raw, number: 9 }]);
  const abort = new AbortController();
  const receipt = f.rpc.receipt.bind(f.rpc);
  f.rpc.receipt = jest.fn(async (hash) => {
    const result = await receipt(hash);
    abort.abort();
    return result;
  });
  expect((await f.collect([raw], { signal: abort.signal })).kind).toBe(
    "cancelled"
  );
  expect(f.rpc.block).toHaveBeenCalledTimes(1);
  expect(f.rpc.balance).not.toHaveBeenCalled();
});

it.each(["receipt", "block"] as const)(
  "preserves an independent amount through an unavailable %s lookup",
  async (method) => {
    const good = await sign({}, independent);
    const missing = await sign();
    const f = fixture([
      { raw: good, number: 8 },
      { raw: missing, number: 9 },
    ]);
    if (method === "receipt") {
      const original = f.rpc.receipt.bind(f.rpc);
      f.rpc.receipt = jest.fn(async (hash) => {
        if (hash === hashOf(missing)) throw new Error("offline");
        return original(hash);
      });
    } else {
      const original = f.rpc.block.bind(f.rpc);
      f.rpc.block = jest.fn(async (number) =>
        number === 9 ? null : original(number)
      );
    }
    const { value } = checked(await f.collect([good, missing]));
    expect(value.verifiedReceivedWei).toBe(10n);
    expect(
      value.issues.some(
        (issue) =>
          issue.reason ===
          (method === "receipt"
            ? "rpc-unavailable"
            : "canonical-block-unavailable")
      )
    ).toBe(true);
  }
);

it("an unavailable final head never returns a checked observation", async () => {
  const raw = await sign();
  const f = fixture([{ raw, number: 9 }]);
  const original = f.rpc.block.bind(f.rpc);
  f.rpc.block = jest.fn(async (number) =>
    number === 10 ? null : original(number)
  );
  const result = await f.collect([raw]);
  expect(result.kind).toBe("unavailable");
  expect(result).not.toHaveProperty("canonicalBlocks");
});

it.each(["recipient", "calldata"] as const)(
  "retains canonical nonce contradictions across a %s alternative in either order",
  async (field) => {
    const incoming = await sign();
    const alternative = await sign(
      field === "recipient" ? { to: independent.address } : { data: "0x1234" }
    );
    const other = await sign({ value: 19n }, independent);
    const f = fixture([
      { raw: incoming, number: 9 },
      { raw: alternative, number: 9 },
      { raw: other, number: 8 },
    ]);
    for (const alternatives of [
      [incoming, alternative],
      [alternative, incoming],
    ]) {
      const { value } = checked(await f.collect([...alternatives, other]));
      expect(value.verifiedReceivedWei).toBe(19n);
      expect(
        value.rejected.filter(
          (entry) => entry.reason === "conflicting-canonical-nonce"
        )
      ).toHaveLength(2);
    }
  }
);

it("does not retry a failed underlying attempt or disguise budget-free work", async () => {
  const raw = await sign();
  const f = fixture();
  f.rpc.transaction = jest.fn(async () => {
    throw new Error("one failed attempt");
  });
  const { result, value } = checked(await f.collect([hashOf(raw)]));
  expect(f.rpc.transaction).toHaveBeenCalledTimes(1);
  expect(result.callsUsed).toBe(4); // Pin, transaction attempt, current balance, final head.
  expect(value.issues).toContainEqual({
    reason: "transaction-unavailable",
    transactionHash: hashOf(raw),
  });
});

it("retires only an obsolete hash lookup gap after fresh discovery proves its canonical receipt", async () => {
  const raw = await sign();
  const f = fixture([{ raw, number: 4 }]);
  f.rpc.balance = jest.fn(async (_address, number) => (number < 4 ? 0n : 10n));
  const lookup = f.rpc.transaction.bind(f.rpc);
  let attempts = 0;
  f.rpc.transaction = jest.fn(async (hash) => {
    if (hash === hashOf(raw) && ++attempts === 1)
      throw new Error("transient lookup failure");
    return lookup(hash);
  });
  const { result, value } = checked(
    await f.collect([hashOf(raw)], { lowerBlock: 0 })
  );
  expect(attempts).toBe(2);
  expect(value.verifiedReceivedWei).toBe(10n);
  expect(result.discoveryWindow).toEqual({ fromBlock: 0, toBlock: 10 });
  expect(result.coverageIssues).toEqual([]);
  expect(value.issues).toEqual([]);
});

it.each(["unrelated", "wrong-recipient", "wrong-chain", "malformed"] as const)(
  "does not retire an unresolved %s gap when another lookup succeeds",
  async (kind) => {
    const raw = await sign(
      kind === "wrong-recipient"
        ? { to: independent.address }
        : kind === "wrong-chain"
        ? { chainId: 1n }
        : {}
    );
    const hash = hashOf(raw);
    const unresolved = hashAt(44);
    const f = fixture([{ raw, number: 4 }]);
    f.rpc.balance = jest.fn(async (_address, number) =>
      number < 4 ? 0n : 10n
    );
    const lookup = f.rpc.transaction.bind(f.rpc);
    let attempts = 0;
    f.rpc.transaction = jest.fn(async (target) => {
      if (target === hash && ++attempts === 1)
        throw new Error("transient lookup failure");
      const tx = await lookup(target);
      return kind === "malformed" && target === hash && tx !== null
        ? { ...tx, gasPrice: undefined }
        : tx;
    });
    const { result, value } = checked(
      await f.collect(kind === "unrelated" ? [hash, unresolved] : [hash], {
        lowerBlock: 0,
      })
    );
    expect(attempts).toBe(2);
    expect(value.verifiedReceivedWei).toBe(kind === "unrelated" ? 10n : 0n);
    const expected = {
      reason: "transaction-unavailable",
      transactionHash: kind === "unrelated" ? unresolved : hash,
    };
    expect(result.coverageIssues).toContainEqual(expected);
    expect(value.issues).toContainEqual(expected);
    if (kind === "unrelated")
      expect(result.coverageIssues).not.toContainEqual({
        reason: "transaction-unavailable",
        transactionHash: hash,
      });
  }
);
