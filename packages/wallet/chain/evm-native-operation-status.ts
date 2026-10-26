import { Transaction } from "ethers";
import {
  nativeMemberSuperseded,
  type EvmNativeOperation,
} from "../storage/evm-native-operation-journal";

/** Public evidence only. The native journal remains the sole financial authority. */
export interface EvmNativeOperationStatus {
  readonly operationId: string;
  readonly chainIdentifier: string;
  /** `contract`: the recipient is a contract and the value is what the call carried, if any. */
  readonly kind: EvmNativeOperation["kind"];
  readonly recipient: string;
  readonly intendedValueWei: string;
  readonly payment:
    | "included"
    | "reverted"
    | "partial"
    | "pending"
    /** The node answers and knows neither the transfer nor a receipt for it: it has not
     * arrived yet, or was dropped. The same bytes are offered again. */
    | "missing"
    /** The node knows neither the transfer nor a receipt for it, and its account's nonce is
     * already past it: it was included earlier (on a node that no longer keeps it) or another
     * transaction took its nonce. Final: it is never offered again. */
    | "superseded"
    /** The chain could not be read, so nothing is known. Never a state of the transfer. */
    | "unknown"
    | "cancelled";
  readonly finalTransactionHash?: string;
  readonly members: readonly {
    /** What the transaction does for the operation: `payment` moves value to the recipient,
     * `funding` gathers the sender's coins into the account that pays, `change` returns what
     * is left to the wallet's own accounts. Every member of a non-set operation is `payment`. */
    readonly role: "payment" | "funding" | "change";
    readonly transactionHash?: string;
    readonly state:
      | "unknown"
      | "missing"
      /** Unknown to the node, its account's nonce past it (`nativeMemberSuperseded`). */
      | "superseded"
      | "pending"
      | "included-success"
      | "included-revert";
    readonly blockNumber?: number;
    /** The block the transaction was included in; with `blockNumber`, only once included. */
    readonly blockHash?: string;
    readonly feeWei?: string;
  }[];
  readonly observedFeeWei: string;
  readonly feeCoverage: "complete" | "partial" | "unknown";
  /** The note that tells the account's other devices about this operation. Only a member
   * included with success has one (a reverted, replaced, cancelled or unsent member is never
   * shared). `shared` once the relay took it for every such member, `failed` when this session's
   * last attempt did not get through (it is tried again), `not-shared` otherwise, and `none` while
   * no member has landed (nothing to share; a transfer that never lands never has any).
   * Information only, never the payment's outcome, and not a confirmation that another device
   * applied it. */
  readonly sharing: "shared" | "not-shared" | "failed" | "none";
}

/** Pure projection of validated owner rows; never exposes signing bytes or derivation material. */
export function summarizeEvmNativeOperation(
  row: EvmNativeOperation,
  /** From the wallet handle's `nativeOperationSyncFailed`; session memory, not a journal fact. */
  syncFailed = false
): EvmNativeOperationStatus {
  const shared = row.kind === "transaction-set";
  const primary = shared
    ? row.members.filter(member => member.transactionSet?.role === "payment" && member.transactionSet.stageId === undefined)
    : row.members;
  const final = primary[primary.length - 1];
  if (!final) throw new Error("Native operation has no recipient member");
  const independent = row.kind !== "legacy" && primary.length > 1;
  const recipients = shared || independent ? primary : [final];
  let value = 0n;
  for (const [index, member] of recipients.entries()) {
    const transaction = Transaction.from(member.unsignedTransaction);
    const intended = shared && member.transactionSet?.intendedValueWei !== undefined
      ? BigInt(member.transactionSet.intendedValueWei) : transaction.value;
    if (
      ((!shared || index === 0) && transaction.to?.toLowerCase() !== row.recipient.toLowerCase()) ||
      transaction.chainId.toString() !== row.binding.nativeChainId ||
      (!shared && (transaction.data !== "0x") !== (row.kind === "contract")) ||
      (!shared && independent && member.dependencies.length !== 0) ||
      transaction.value < intended
    )
      throw new Error("Native operation recipient evidence does not match");
    value += intended;
  }
  if (value.toString() !== row.intendedValueWei)
    throw new Error("Native operation recipient evidence does not match");
  const stateOf = (member: EvmNativeOperation["members"][number]) =>
    nativeMemberSuperseded(member) ? ("superseded" as const) : member.observation.state;
  const members = row.members.map((member) => {
    const observation = member.observation;
    const included = "transactionHash" in observation;
    if (
      included &&
      observation.transactionHash !== member.signed?.transactionHash
    )
      throw new Error(
        "Native operation observation does not match signed transaction"
      );
    return {
      role: member.transactionSet?.role ?? "payment",
      transactionHash: member.signed?.transactionHash,
      state: stateOf(member),
      ...(included
        ? {
            blockNumber: observation.blockNumber,
            blockHash: observation.blockHash,
            feeWei: observation.feeWei,
          }
        : {}),
    };
  });
  const observed = members.filter((member) => member.feeWei !== undefined);
  const paymentMembers = shared ? recipients.map(member => ({ state: stateOf(member) })) : members;
  const payment = row.cancelled
    ? "cancelled"
    : (
        independent
          ? paymentMembers.every((member) => member.state === "included-success")
          : final.observation.state === "included-success"
      )
    ? "included"
    : (
        independent
          ? paymentMembers.every((member) => member.state === "included-revert")
          : final.observation.state === "included-revert"
      )
    ? "reverted"
    : paymentMembers.some((member) => member.state === "included-success")
    ? "partial"
    : paymentMembers.some((member) => member.state === "pending")
    ? "pending"
    : paymentMembers.some((member) => member.state === "missing")
    ? "missing"
    : paymentMembers.length > 0 &&
      paymentMembers.every((member) => member.state === "superseded")
    ? "superseded"
    : "unknown";
  return {
    operationId: row.operationId,
    chainIdentifier: row.binding.chainIdentifier,
    kind: row.kind,
    recipient: row.recipient,
    intendedValueWei: row.intendedValueWei,
    payment,
    finalTransactionHash: final.signed?.transactionHash,
    members,
    observedFeeWei: observed
      .reduce((sum, member) => sum + BigInt(member.feeWei!), 0n)
      .toString(),
    feeCoverage:
      observed.length === members.length
        ? "complete"
        : observed.length
        ? "partial"
        : "unknown",
    sharing: !row.members.some(
      (member) => member.observation.state === "included-success"
    )
      ? "none"
      : row.members.every(
          (member) =>
            member.observation.state !== "included-success" ||
            member.syncApplied
        )
      ? "shared"
      : syncFailed
      ? "failed"
      : "not-shared",
  };
}

/** A hash binds only a unique recipient member in the captured wallet and canonical chain. */
export function findEvmNativeOperationStatus(
  operations: readonly EvmNativeOperationStatus[],
  chainIdentifier: string,
  finalTransactionHash: string | undefined
): EvmNativeOperationStatus | undefined {
  if (!finalTransactionHash || !/^0x[0-9a-f]{64}$/i.test(finalTransactionHash))
    return undefined;
  const matches = operations.filter(
    (operation) =>
      operation.chainIdentifier === chainIdentifier &&
      operation.finalTransactionHash?.toLowerCase() ===
        finalTransactionHash.toLowerCase()
  );
  return matches.length === 1 ? matches[0] : undefined;
}
