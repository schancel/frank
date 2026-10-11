/** Bounded read-only collection of native evidence. No authentication, keys, persistence,
 * provider lifetime, broadcast or message transport. The injected RPC methods each perform
 * exactly ONE underlying attempt (no hidden retries); composition owns upstream identity.
 */
import {
  getAddress,
  Transaction,
  type AccessList,
  type Authorization,
  type SignatureLike,
} from "ethers";
import {
  evaluateReceivedEvidence,
  type ReceivedEvidenceBlock,
  type ReceivedEvidenceFact,
  type ReceivedEvidenceIssue,
  type ReceivedEvidenceIssueReason,
  type ReceivedEvidenceOwnerContext,
  type ReceivedEvidenceReceipt,
} from "./evm-received-evidence";

export interface ReceivedEvidenceRpcTransaction {
  readonly hash: string;
  readonly from: string;
  readonly type: number;
  readonly chainId: bigint;
  readonly nonce: number;
  readonly to: string | null;
  readonly value: bigint;
  readonly data: string;
  readonly gasLimit: bigint;
  readonly signature: SignatureLike;
  readonly gasPrice?: bigint;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
  readonly accessList?: AccessList;
  readonly maxFeePerBlobGas?: bigint;
  readonly blobVersionedHashes?: readonly string[];
  readonly authorizationList?: readonly Authorization[];
}
export interface ReceivedEvidenceReadRpc {
  /** The canonical chain whose upstream identity composition has already verified. */
  readonly chainIdentifier: string;
  block(
    number: number | "latest",
    signal?: AbortSignal
  ): Promise<ReceivedEvidenceBlock | null>;
  transaction(
    hash: string,
    signal?: AbortSignal
  ): Promise<ReceivedEvidenceRpcTransaction | null>;
  receipt(
    hash: string,
    signal?: AbortSignal
  ): Promise<Extract<ReceivedEvidenceReceipt, { kind: "included" }> | null>;
  balance(
    address: string,
    number: number,
    signal?: AbortSignal
  ): Promise<bigint>;
  nonce(address: string, number: number, signal?: AbortSignal): Promise<number>;
  code(address: string, number: number, signal?: AbortSignal): Promise<string>;
}
export interface ReceivedEvidenceDriverBudget {
  readonly maxCalls: number;
  readonly maxFundingBlocks: number;
  readonly maxTransactionsPerBlock: number;
  /** Absolute wall-clock deadline, milliseconds since epoch. */
  readonly deadlineMs: number;
}
export type ReceivedEvidenceCollection =
  | {
      readonly kind: "checked";
      readonly owner: ReceivedEvidenceOwnerContext;
      readonly head: { readonly number: number; readonly hash: string };
      readonly candidates: readonly string[];
      readonly facts: readonly ReceivedEvidenceFact[];
      readonly canonicalBlocks: readonly ReceivedEvidenceBlock[];
      readonly coverageIssues: readonly ReceivedEvidenceIssue[];
      /** Absent means only the named/resolved proof set was checked, not all funding history. */
      readonly discoveryWindow?: {
        readonly fromBlock: number;
        readonly toBlock: number;
      };
      readonly callsUsed: number;
    }
  | {
      readonly kind: "unavailable";
      readonly issue: ReceivedEvidenceIssue;
      readonly retryCandidates: readonly string[];
      readonly callsUsed: number;
    }
  | { readonly kind: "cancelled"; readonly callsUsed: number };

const normalizedHash = (value: string): string | undefined =>
  /^(?:0x)?[a-f\d]{64}$/i.test(value)
    ? `0x${value.replace(/^0x/i, "").toLowerCase()}`
    : undefined;
const integer = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;
const nonnegative = (value: unknown): value is bigint =>
  typeof value === "bigint" && value >= 0n;
class CollectionStop extends Error {
  constructor(readonly reason: ReceivedEvidenceIssueReason | "cancelled") {
    super(reason);
  }
}

/** Complete field reconstruction deliberately does not let ethers default omitted wire facts. */
function reconstructed(
  wire: ReceivedEvidenceRpcTransaction,
  hash: string
): Transaction {
  if (
    !integer(wire.nonce) ||
    !nonnegative(wire.chainId) ||
    !nonnegative(wire.value) ||
    !nonnegative(wire.gasLimit) ||
    !/^0x(?:[a-f\d]{2})*$/i.test(wire.data) ||
    wire.signature == null ||
    ![0, 1, 2, 3, 4].includes(wire.type) ||
    (wire.to !== null && typeof wire.to !== "string")
  )
    throw new Error("Incomplete transaction fields");
  if ((wire.type === 0 || wire.type === 1) && !nonnegative(wire.gasPrice))
    throw new Error("Missing gas price");
  if (
    wire.type >= 2 &&
    (!nonnegative(wire.maxFeePerGas) || !nonnegative(wire.maxPriorityFeePerGas))
  )
    throw new Error("Missing dynamic fee fields");
  if (wire.type >= 1 && !Array.isArray(wire.accessList))
    throw new Error("Missing access list");
  if (
    wire.type === 3 &&
    (!nonnegative(wire.maxFeePerBlobGas) ||
      !Array.isArray(wire.blobVersionedHashes))
  )
    throw new Error("Missing blob fields");
  if (wire.type === 4 && !Array.isArray(wire.authorizationList))
    throw new Error("Missing authorizations");
  const tx = Transaction.from({
    type: wire.type,
    chainId: wire.chainId,
    nonce: wire.nonce,
    to: wire.to,
    value: wire.value,
    data: wire.data,
    gasLimit: wire.gasLimit,
    signature: wire.signature,
    ...(wire.type <= 1
      ? { gasPrice: wire.gasPrice }
      : {
          maxFeePerGas: wire.maxFeePerGas,
          maxPriorityFeePerGas: wire.maxPriorityFeePerGas,
        }),
    ...(wire.type >= 1 ? { accessList: wire.accessList } : {}),
    ...(wire.type === 3
      ? {
          maxFeePerBlobGas: wire.maxFeePerBlobGas,
          blobVersionedHashes: [...wire.blobVersionedHashes!],
        }
      : {}),
    ...(wire.type === 4
      ? { authorizationList: [...wire.authorizationList!] }
      : {}),
  });
  if (
    !tx.isSigned() ||
    tx.hash !== hash ||
    normalizedHash(wire.hash) !== hash ||
    tx.from.toLowerCase() !== getAddress(wire.from).toLowerCase()
  )
    throw new Error("Transaction identity mismatch");
  return tx;
}

export async function collectReceivedEvidence(input: {
  readonly owner: ReceivedEvidenceOwnerContext;
  readonly candidates: readonly string[];
  readonly rpc: ReceivedEvidenceReadRpc;
  /** An owner-proposed lower height, independently verified here; never an assumed zero. */
  readonly lowerBlock?: number;
  readonly budget: ReceivedEvidenceDriverBudget;
  readonly signal: AbortSignal;
}): Promise<ReceivedEvidenceCollection> {
  const { rpc, signal } = input;
  const owner = { ...input.owner };
  const budget = { ...input.budget };
  const initialCandidates = [...input.candidates];
  const lowerBlock = input.lowerBlock;
  const recipient = getAddress(owner.recipientAddress).toLowerCase();
  if (
    !owner.chainIdentifier ||
    rpc.chainIdentifier !== owner.chainIdentifier ||
    owner.nativeChainId <= 0n ||
    !integer(budget.maxCalls) ||
    !integer(budget.maxFundingBlocks) ||
    !integer(budget.maxTransactionsPerBlock) ||
    !Number.isSafeInteger(budget.deadlineMs) ||
    (lowerBlock !== undefined && !integer(lowerBlock))
  )
    throw new TypeError("Invalid received-evidence collection context/budget");
  let callsUsed = 0;
  const issues: ReceivedEvidenceIssue[] = [];
  const facts: ReceivedEvidenceFact[] = [];
  const candidates = new Map<string, string>();
  const transactions = new Map<string, Transaction>();
  const anchors = new Map<number, ReceivedEvidenceBlock>();
  const receipts = new Map<string, ReceivedEvidenceReceipt>();
  const nonceCache = new Map<string, number>();
  const balanceCache = new Map<number, bigint>();
  let head: ReceivedEvidenceBlock | undefined;
  let discoveryWindow: { fromBlock: number; toBlock: number } | undefined;
  const addIssue = (
    reason: ReceivedEvidenceIssueReason,
    transactionHash?: string
  ) =>
    issues.push({
      reason,
      ...(transactionHash === undefined ? {} : { transactionHash }),
    });
  const guard = () => {
    if (signal.aborted) throw new CollectionStop("cancelled");
    if (Date.now() >= budget.deadlineMs)
      throw new CollectionStop("deadline-exceeded");
  };
  // Reserve one uncached recheck per used block, including the final head read.
  const request = async <T>(
    operation: () => Promise<T>,
    reserve = anchors.size
  ): Promise<T> => {
    guard();
    if (callsUsed + 1 + reserve > budget.maxCalls)
      throw new CollectionStop("request-budget-exhausted");
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (
        outcome: { ok: true; value: T } | { ok: false; error: unknown }
      ) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (outcome.ok) resolve(outcome.value);
        else reject(outcome.error);
      };
      const abort = () =>
        finish({ ok: false, error: new CollectionStop("cancelled") });
      const deadline = () => {
        if (Date.now() >= budget.deadlineMs)
          finish({ ok: false, error: new CollectionStop("deadline-exceeded") });
        else
          timer = setTimeout(
            deadline,
            Math.min(budget.deadlineMs - Date.now(), 2147483647)
          );
      };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        deadline,
        Math.min(budget.deadlineMs - Date.now(), 2147483647)
      );
      Promise.resolve()
        .then(() => {
          guard();
          callsUsed++;
          return operation();
        })
        .then(
          (value) => {
            try {
              guard();
              finish({ ok: true, value });
            } catch (error) {
              finish({ ok: false, error });
            }
          },
          (error: unknown) => finish({ ok: false, error })
        );
    });
  };
  const validBlock = (
    block: ReceivedEvidenceBlock | null,
    number?: number
  ): block is ReceivedEvidenceBlock =>
    block !== null &&
    block.chainIdentifier === owner.chainIdentifier &&
    integer(block.number) &&
    (number === undefined || block.number === number) &&
    normalizedHash(block.hash) !== undefined &&
    Array.isArray(block.transactionHashes) &&
    block.transactionHashes.every((hash) => normalizedHash(hash) !== undefined);
  const blockAt = async (number: number): Promise<ReceivedEvidenceBlock> => {
    if (anchors.has(number)) return anchors.get(number)!;
    // A newly used block adds its own mandatory final recheck.
    const block = await request(
      () => rpc.block(number, signal),
      anchors.size + 1
    );
    if (!validBlock(block, number))
      throw new CollectionStop("canonical-block-unavailable");
    anchors.set(number, block);
    return block;
  };
  const nonceAt = async (address: string, number: number): Promise<number> => {
    const key = `${address.toLowerCase()}:${number}`;
    if (nonceCache.has(key)) return nonceCache.get(key)!;
    await blockAt(number);
    let nonce: number;
    try {
      nonce = await request(() => rpc.nonce(address, number, signal));
    } catch (error) {
      if (error instanceof CollectionStop) throw error;
      throw new CollectionStop("historical-state-unavailable");
    }
    if (!integer(nonce))
      throw new CollectionStop("historical-state-unavailable");
    nonceCache.set(key, nonce);
    return nonce;
  };
  const balanceAt = async (number: number): Promise<bigint> => {
    if (balanceCache.has(number)) return balanceCache.get(number)!;
    await blockAt(number);
    let balance: bigint;
    try {
      balance = await request(() => rpc.balance(recipient, number, signal));
    } catch (error) {
      if (error instanceof CollectionStop) throw error;
      throw new CollectionStop("historical-state-unavailable");
    }
    if (!nonnegative(balance))
      throw new CollectionStop("historical-state-unavailable");
    balanceCache.set(number, balance);
    return balance;
  };
  const lookupTransaction = async (
    hash: string
  ): Promise<Transaction | undefined> => {
    if (transactions.has(hash)) return transactions.get(hash);
    try {
      const wire = await request(() => rpc.transaction(hash, signal));
      if (wire === null) {
        addIssue("transaction-unavailable", hash);
        return;
      }
      const tx = reconstructed(wire, hash);
      transactions.set(hash, tx);
      if (candidates.has(hash)) candidates.set(hash, tx.serialized);
      return tx;
    } catch (error) {
      if (error instanceof CollectionStop) throw error;
      addIssue("transaction-unavailable", hash);
      return;
    }
  };
  const receiptOf = async (hash: string): Promise<ReceivedEvidenceReceipt> => {
    if (receipts.has(hash)) return receipts.get(hash)!;
    if (transactions.has(hash))
      candidates.set(hash, transactions.get(hash)!.serialized);
    let receipt: ReceivedEvidenceReceipt;
    try {
      receipt = (await request(() => rpc.receipt(hash, signal))) ?? {
        kind: "pending",
      };
    } catch (error) {
      if (error instanceof CollectionStop) throw error;
      receipt = { kind: "unavailable", reason: "rpc-unavailable" };
    }
    receipts.set(hash, receipt);
    facts.push({
      chainIdentifier: owner.chainIdentifier,
      transactionHash: hash,
      ...(transactions.has(hash)
        ? { rawTransaction: transactions.get(hash)!.serialized }
        : {}),
      receipt,
    });
    if (
      receipt.kind === "included" &&
      integer(receipt.blockNumber) &&
      receipt.blockNumber <= head!.number
    )
      await blockAt(receipt.blockNumber);
    return receipt;
  };
  const inspect = async (number: number): Promise<readonly Transaction[]> => {
    const block = await blockAt(number);
    if (block.transactionHashes.length > budget.maxTransactionsPerBlock)
      throw new CollectionStop("request-budget-exhausted");
    const found: Transaction[] = [];
    for (const hash of new Set(
      block.transactionHashes.map((value) => normalizedHash(value)!)
    )) {
      const tx = await lookupTransaction(hash);
      if (tx !== undefined && tx.chainId === owner.nativeChainId)
        found.push(tx);
    }
    return found;
  };
  const replace = async (tx: Transaction): Promise<void> => {
    const used = await nonceAt(tx.from!, head!.number);
    if (used <= tx.nonce) return;
    let low = -1;
    let high = head!.number;
    while (high - low > 1) {
      const mid = low + Math.floor((high - low) / 2);
      if ((await nonceAt(tx.from!, mid)) > tx.nonce) high = mid;
      else low = mid;
    }
    const alternatives = (await inspect(high)).filter(
      (other) =>
        other.from!.toLowerCase() === tx.from!.toLowerCase() &&
        other.nonce === tx.nonce
    );
    if (alternatives.length === 0) {
      addIssue("transaction-unavailable", tx.hash!);
      return;
    }
    for (const alternative of alternatives) await receiptOf(alternative.hash!);
    if (alternatives.length > 1)
      addIssue("conflicting-chain-evidence", tx.hash!);
  };
  const fresh = async (): Promise<void> => {
    const endBalance = await balanceAt(head!.number);
    const knownValue = evaluateReceivedEvidence({
      owner,
      head: head!,
      candidates: [...candidates.values()],
      facts,
      canonicalBlocks: [...anchors.values()],
    }).verifiedReceivedWei;
    // A spent account with complete known receipts remains positive. Only actual
    // unexplained observed funding requests the bounded fresh-payment locator.
    if (endBalance <= knownValue) return;
    if (lowerBlock === undefined) {
      addIssue("unexplained-incoming-value");
      return;
    }
    const lower = lowerBlock;
    if (lower > head!.number) {
      addIssue("historical-state-unavailable");
      return;
    }
    const beginBalance = await balanceAt(lower);
    if (beginBalance !== 0n) {
      addIssue("unexplained-incoming-value");
      return;
    }
    if (
      (await nonceAt(recipient, lower)) !== 0 ||
      (await nonceAt(recipient, head!.number)) !== 0
    ) {
      addIssue("spent-discovery-unavailable");
      return;
    }
    for (const number of new Set([lower, head!.number])) {
      const code = await request(() => rpc.code(recipient, number, signal));
      if (code !== "0x") {
        addIssue("unexplained-incoming-value");
        return;
      }
    }
    let low = lower;
    let previousBalance = 0n;
    let fundingBlocks = 0;
    while (previousBalance < endBalance) {
      if (fundingBlocks >= budget.maxFundingBlocks)
        throw new CollectionStop("request-budget-exhausted");
      let left = low;
      let right = head!.number;
      while (right - left > 1) {
        const mid = left + Math.floor((right - left) / 2);
        const balance = await balanceAt(mid);
        if (balance < previousBalance || balance > endBalance) {
          addIssue("unexplained-incoming-value");
          return;
        }
        if (balance > previousBalance) right = mid;
        else left = mid;
      }
      const atRise = await balanceAt(right);
      if (right <= low || atRise <= previousBalance) {
        addIssue("unexplained-incoming-value");
        return;
      }
      let explained = 0n;
      for (const tx of await inspect(right)) {
        if (
          tx.to?.toLowerCase() !== recipient ||
          tx.from!.toLowerCase() === recipient ||
          tx.data !== "0x" ||
          tx.value <= 0n
        )
          continue;
        const receipt = await receiptOf(tx.hash!);
        if (
          receipt.kind === "included" &&
          receipt.status === 1 &&
          receipt.blockNumber === right &&
          normalizedHash(receipt.transactionHash) === tx.hash &&
          normalizedHash(receipt.blockHash) ===
            normalizedHash(anchors.get(right)!.hash)
        )
          explained += tx.value;
      }
      if (explained !== atRise - previousBalance) {
        addIssue("unexplained-incoming-value");
        return;
      }
      fundingBlocks++;
      low = right;
      previousBalance = atRise;
    }
    discoveryWindow = { fromBlock: lower, toBlock: head!.number };
  };
  const unavailable = (
    reason: ReceivedEvidenceIssueReason
  ): ReceivedEvidenceCollection => ({
    kind: "unavailable",
    issue: { reason },
    retryCandidates: [...candidates.keys()].flatMap((hash) => {
      const tx = transactions.get(hash);
      return tx?.chainId === owner.nativeChainId ? [tx.serialized] : [];
    }),
    callsUsed,
  });
  try {
    const pinned = await request(() => rpc.block("latest", signal), 1);
    if (!validBlock(pinned)) return unavailable("canonical-block-unavailable");
    head = pinned;
    anchors.set(head.number, head);
    for (const candidate of initialCandidates) {
      const hash = normalizedHash(candidate);
      if (hash !== undefined) {
        if (!candidates.has(hash)) candidates.set(hash, hash);
        continue;
      }
      try {
        const tx = Transaction.from(
          `0x${candidate.replace(/^0x/i, "").toLowerCase()}`
        );
        if (tx.isSigned() && tx.from) {
          transactions.set(tx.hash!, tx);
          candidates.set(tx.hash!, tx.serialized);
        } else candidates.set(candidate, candidate);
      } catch {
        candidates.set(candidate, candidate);
      }
    }
    try {
      // Snapshot inputs: discovering candidates must not recursively launch an unbounded search.
      for (const hash of [...candidates.keys()]) {
        if (normalizedHash(hash) === undefined) continue;
        try {
          const tx = transactions.get(hash) ?? (await lookupTransaction(hash));
          if (tx === undefined || tx.chainId !== owner.nativeChainId) continue;
          const receipt = await receiptOf(hash);
          if (receipt.kind === "pending") await replace(tx);
        } catch (error) {
          if (
            error instanceof CollectionStop &&
            ![
              "cancelled",
              "deadline-exceeded",
              "request-budget-exhausted",
            ].includes(error.reason)
          )
            addIssue(error.reason, hash);
          else throw error;
        }
      }
      await fresh();
    } catch (error) {
      if (error instanceof CollectionStop) {
        if (
          error.reason === "cancelled" ||
          error.reason === "deadline-exceeded"
        )
          throw error;
        addIssue(error.reason);
      } else addIssue("rpc-unavailable");
    }
    // These reads consume the reserved budget and must not use earlier cached answers.
    const canonicalBlocks: ReceivedEvidenceBlock[] = [];
    const ordered = [...anchors.values()].filter(
      (block) => block.number !== head!.number
    );
    ordered.push(head);
    for (const anchor of ordered) {
      let current: ReceivedEvidenceBlock | null;
      try {
        current = await request(() => rpc.block(anchor.number, signal), 0);
      } catch (error) {
        if (error instanceof CollectionStop) throw error;
        if (anchor.number === head.number)
          return unavailable("rpc-unavailable");
        discoveryWindow = undefined;
        addIssue("canonical-block-unavailable");
        continue;
      }
      if (
        !validBlock(current, anchor.number) ||
        normalizedHash(current.hash) !== normalizedHash(anchor.hash)
      ) {
        if (anchor.number === head.number)
          return unavailable("canonical-head-changed");
        discoveryWindow = undefined;
        addIssue("canonical-head-changed");
        continue;
      }
      canonicalBlocks.push(current);
    }
    guard();
    return {
      kind: "checked",
      owner,
      head: { number: head.number, hash: head.hash },
      candidates: [...candidates.values()],
      facts,
      canonicalBlocks,
      coverageIssues: issues,
      ...(discoveryWindow === undefined ? {} : { discoveryWindow }),
      callsUsed,
    };
  } catch (error) {
    if (error instanceof CollectionStop)
      return error.reason === "cancelled"
        ? { kind: "cancelled", callsUsed }
        : unavailable(error.reason);
    return unavailable("rpc-unavailable");
  }
}
