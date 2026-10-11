/** Pure native receipt evaluation, not message authentication or payment discovery.
 * The authenticated received-coin owner must first validate canonical chain affinity and
 * derive recipientAddress from its message/note using the existing stamp/stealth primitives.
 * In particular receipts cannot prove payload-digest linkage or the stealth ECDH relation.
 * The driver supplies canonical blocks at one pinned head; no keys, RPC or state live here.
 */
import { getAddress, Transaction } from "ethers";

export interface ReceivedEvidenceOwnerContext {
  readonly chainIdentifier: string;
  readonly nativeChainId: bigint;
  readonly recipientAddress: string;
}
export interface ReceivedEvidenceBlock {
  readonly chainIdentifier: string;
  readonly number: number;
  readonly hash: string;
  readonly transactionHashes: readonly string[];
}
export type ReceivedEvidenceReceipt =
  | { readonly kind: "pending" }
  | {
      readonly kind: "unavailable";
      readonly reason: "rpc-unavailable" | "receipt-unavailable";
    }
  | {
      readonly kind: "included";
      readonly transactionHash: string;
      readonly blockNumber: number;
      readonly blockHash: string;
      readonly status: 0 | 1;
    };
export interface ReceivedEvidenceFact {
  readonly chainIdentifier: string;
  readonly transactionHash: string;
  /** Required for a hash-only candidate; signed bytes reconstructed by the driver are valid. */
  readonly rawTransaction?: string;
  readonly receipt: ReceivedEvidenceReceipt;
}
export type ReceivedEvidenceIssueReason =
  | "rpc-unavailable"
  | "historical-state-unavailable"
  | "transaction-unavailable"
  | "receipt-unavailable"
  | "canonical-block-unavailable"
  | "canonical-head-changed"
  | "conflicting-chain-evidence"
  | "unexplained-incoming-value"
  | "spent-discovery-unavailable";
export interface ReceivedEvidenceIssue {
  readonly reason: ReceivedEvidenceIssueReason;
  readonly transactionHash?: string;
}
export type ReceivedEvidenceRejectionReason =
  | "malformed-proof"
  | "unsigned-transaction"
  | "wrong-native-chain"
  | "wrong-recipient"
  | "self-transfer"
  | "not-plain-positive-transfer"
  | "wrong-chain-context"
  | "transaction-hash-mismatch"
  | "receipt-hash-mismatch"
  | "malformed-receipt"
  | "not-in-canonical-block"
  | "conflicting-canonical-nonce";
export interface ReceivedEvidenceRejection {
  readonly candidateIndex: number;
  readonly reason: ReceivedEvidenceRejectionReason;
}
export interface ReceivedEvidenceEvaluation {
  /** Sum of independently proven successful incoming values, even when other evidence is missing. */
  readonly verifiedReceivedWei: bigint;
  /** Canonical successful incoming signed bytes, unique by transaction hash, sorted by hash. */
  readonly verifiedTransactions: readonly string[];
  readonly pendingTransactionHashes: readonly string[];
  readonly revertedTransactionHashes: readonly string[];
  readonly supersededTransactionHashes: readonly string[];
  readonly issues: readonly ReceivedEvidenceIssue[];
  readonly rejected: readonly ReceivedEvidenceRejection[];
}
const bare = (hex: string): string => hex.replace(/^0x/i, "").toLowerCase();
const hashOf = (hex: string): string | undefined =>
  /^[0-9a-f]{64}$/.test(bare(hex)) ? `0x${bare(hex)}` : undefined;
const height = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
function receiptFingerprint(fact: ReceivedEvidenceFact): string {
  const receipt = fact.receipt;
  return JSON.stringify([
    fact.chainIdentifier,
    bare(fact.transactionHash),
    receipt.kind,
    ...(receipt.kind === "included"
      ? [
          bare(receipt.transactionHash),
          receipt.blockNumber,
          bare(receipt.blockHash),
          receipt.status,
        ]
      : receipt.kind === "unavailable"
      ? [receipt.reason]
      : []),
  ]);
}

export function evaluateReceivedEvidence(input: {
  readonly owner: ReceivedEvidenceOwnerContext;
  readonly head: { readonly number: number; readonly hash: string };
  readonly candidates: readonly string[];
  readonly facts: readonly ReceivedEvidenceFact[];
  readonly canonicalBlocks: readonly ReceivedEvidenceBlock[];
  /** Only concrete discovery/lookup gaps observed by the driver; never hypothetical future funds. */
  readonly coverageIssues?: readonly ReceivedEvidenceIssue[];
}): ReceivedEvidenceEvaluation {
  const { owner, head } = input;
  const recipient = getAddress(owner.recipientAddress).toLowerCase();
  if (
    !owner.chainIdentifier ||
    owner.nativeChainId <= 0n ||
    !height(head.number) ||
    !hashOf(head.hash)
  )
    throw new TypeError(
      "Invalid received-evidence owner context or pinned head"
    );
  const issues: ReceivedEvidenceIssue[] = [...(input.coverageIssues ?? [])];
  const rejected: ReceivedEvidenceRejection[] = [];
  const pending = new Set<string>();
  const reverted = new Set<string>();
  const validTransactions = new Map<string, Transaction>();
  const superseded = new Set<string>();
  const known = new Map<
    string,
    { tx: Transaction; index: number; status: 0 | 1 }
  >();
  const reject = (
    candidateIndex: number,
    reason: ReceivedEvidenceRejectionReason
  ) => rejected.push({ candidateIndex, reason });
  const issue = (
    reason: ReceivedEvidenceIssueReason,
    transactionHash: string
  ) => issues.push({ reason, transactionHash });

  const factsByHash = new Map<string, ReceivedEvidenceFact[]>();
  for (const fact of input.facts) {
    const hash = hashOf(fact.transactionHash);
    if (hash !== undefined)
      factsByHash.set(hash, [...(factsByHash.get(hash) ?? []), fact]);
  }
  const blocksByHeight = new Map<number, ReceivedEvidenceBlock[]>();
  for (const block of input.canonicalBlocks) {
    if (block.chainIdentifier === owner.chainIdentifier)
      blocksByHeight.set(block.number, [
        ...(blocksByHeight.get(block.number) ?? []),
        block,
      ]);
  }
  const candidates = new Map<string, { tx?: Transaction; index: number }>();
  for (const [index, candidate] of input.candidates.entries()) {
    let tx: Transaction | undefined;
    let hash = hashOf(candidate);
    try {
      if (hash === undefined) {
        tx = Transaction.from(`0x${bare(candidate)}`);
        if (!tx.isSigned()) {
          reject(index, "unsigned-transaction");
          continue;
        }
        if (!tx.from) throw new Error("Signer recovery failed");
        hash = tx.hash!;
      }
    } catch {
      reject(index, "malformed-proof");
      continue;
    }
    const prior = candidates.get(hash);
    candidates.set(hash, { tx: tx ?? prior?.tx, index: prior?.index ?? index });
  }
  for (const [hash, candidate] of candidates) {
    let tx = candidate.tx;
    const index = candidate.index;
    const matches = factsByHash.get(hash) ?? [];
    // Missing bytes and failed lookups add no contradictory chain fact. Merge them
    // with a successful lookup, but never choose between different asserted receipts
    // or different supplied transaction bytes merely because one came first.
    const asserted = matches.filter(
      (entry) => entry.receipt.kind !== "unavailable"
    );
    const rawTransactions = new Set(
      matches.flatMap((entry) =>
        entry.rawTransaction === undefined ? [] : [bare(entry.rawTransaction)]
      )
    );
    if (
      new Set(matches.map((entry) => entry.chainIdentifier)).size > 1 ||
      new Set(asserted.map(receiptFingerprint)).size > 1 ||
      rawTransactions.size > 1
    ) {
      issue("conflicting-chain-evidence", hash);
      continue;
    }
    const source = asserted[0] ?? matches[0];
    if (
      source !== undefined &&
      source.chainIdentifier !== owner.chainIdentifier
    ) {
      reject(index, "wrong-chain-context");
      continue;
    }
    const fact =
      source === undefined
        ? undefined
        : {
            ...source,
            rawTransaction: rawTransactions.values().next().value,
          };
    if (fact?.rawTransaction !== undefined) {
      try {
        const actual = Transaction.from(`0x${bare(fact.rawTransaction)}`);
        if (!actual.isSigned()) {
          reject(index, "unsigned-transaction");
          continue;
        }
        if (!actual.from) throw new Error("Signer recovery failed");
        if (actual.hash !== hash) {
          reject(index, "transaction-hash-mismatch");
          continue;
        }
        tx = actual;
      } catch {
        reject(index, "malformed-proof");
        continue;
      }
    }
    if (tx === undefined) {
      issue("transaction-unavailable", hash);
      continue;
    }
    if (tx.chainId !== owner.nativeChainId) {
      reject(index, "wrong-native-chain");
      continue;
    }
    if (tx.to?.toLowerCase() !== recipient) {
      reject(index, "wrong-recipient");
    } else if (tx.from?.toLowerCase() === recipient) {
      reject(index, "self-transfer");
    } else if (tx.data !== "0x" || tx.value <= 0n) {
      reject(index, "not-plain-positive-transfer");
    } else {
      validTransactions.set(hash, tx);
    }
    // Even a noncontributing native transaction can contradict another canonical
    // transaction at its sender nonce. Classify its receipt before excluding value.
    if (fact === undefined) {
      issue("receipt-unavailable", hash);
      continue;
    }
    const receipt = fact.receipt;
    if (receipt.kind === "unavailable") {
      for (const entry of matches) {
        if (entry.receipt.kind === "unavailable")
          issue(entry.receipt.reason, hash);
      }
      continue;
    }
    if (receipt.kind === "pending") {
      if (validTransactions.has(hash)) pending.add(hash);
      continue;
    }
    if (hashOf(receipt.transactionHash) !== hash) {
      reject(index, "receipt-hash-mismatch");
      continue;
    }
    if (
      !height(receipt.blockNumber) ||
      !hashOf(receipt.blockHash) ||
      (receipt.status !== 0 && receipt.status !== 1)
    ) {
      reject(index, "malformed-receipt");
      continue;
    }
    if (receipt.blockNumber > head.number) {
      if (validTransactions.has(hash)) pending.add(hash);
      continue;
    }
    const blocks = blocksByHeight.get(receipt.blockNumber) ?? [];
    if (blocks.length === 0) {
      issue("canonical-block-unavailable", hash);
      continue;
    }
    if (
      blocks.some(
        (block) => hashOf(block.hash) !== hashOf(receipt.blockHash)
      ) ||
      (receipt.blockNumber === head.number &&
        hashOf(receipt.blockHash) !== hashOf(head.hash))
    ) {
      issue("canonical-head-changed", hash);
      continue;
    }
    if (
      !blocks.every((block) =>
        block.transactionHashes.some((entry) => hashOf(entry) === hash)
      )
    ) {
      reject(index, "not-in-canonical-block");
      issue("conflicting-chain-evidence", hash);
      continue;
    }
    known.set(hash, { tx, index, status: receipt.status });
  }
  // Contradictory canonical facts cannot make two alternatives at one sender nonce count.
  const nonces = new Map<string, string[]>();
  for (const [hash, { tx }] of known) {
    const key = `${tx.from!.toLowerCase()}:${tx.nonce}`;
    nonces.set(key, [...(nonces.get(key) ?? []), hash]);
  }
  for (const alternatives of nonces.values())
    if (alternatives.length > 1) {
      for (const hash of alternatives) {
        reject(known.get(hash)!.index, "conflicting-canonical-nonce");
        issue("conflicting-chain-evidence", hash);
        known.delete(hash);
      }
    }
  // A canonical alternative consumes the nonce: an absent original is not still pending.
  for (const [hash, tx] of validTransactions) {
    if (known.has(hash)) continue;
    const alternatives =
      nonces.get(`${tx.from!.toLowerCase()}:${tx.nonce}`) ?? [];
    if (alternatives.length !== 1 || !known.has(alternatives[0])) continue;
    if (
      pending.has(hash) ||
      issues.some(
        (entry) =>
          entry.transactionHash === hash &&
          (entry.reason === "rpc-unavailable" ||
            entry.reason === "receipt-unavailable")
      )
    ) {
      pending.delete(hash);
      superseded.add(hash);
    }
  }
  let verifiedReceivedWei = 0n;
  const verifiedTransactions: string[] = [];
  for (const [hash, { tx, status }] of [...known].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (!validTransactions.has(hash)) continue;
    if (status === 0) reverted.add(hash);
    else {
      verifiedReceivedWei += tx.value;
      verifiedTransactions.push(tx.serialized);
    }
  }
  return {
    verifiedReceivedWei,
    verifiedTransactions,
    pendingTransactionHashes: [...pending].sort(),
    revertedTransactionHashes: [...reverted].sort(),
    supersededTransactionHashes: [...superseded].sort(),
    issues: [
      ...new Map(
        issues
          .filter(
            (entry) =>
              !superseded.has(entry.transactionHash ?? "") ||
              (entry.reason !== "rpc-unavailable" &&
                entry.reason !== "receipt-unavailable")
          )
          .map((entry) => [JSON.stringify(entry), entry])
      ).values(),
    ],
    rejected,
  };
}
