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
  /** What the operation was for, from the identity the wallet gave it: a message's stamp, a
   * payment to a contact, a forum post's burn, or a transfer (Send to Address, a contract call). */
  readonly purpose: "stamp" | "contact-payment" | "forum" | "transfer";
  /** The message a stamp or contact payment belongs to: its 32 hex digit ID. */
  readonly messageId?: string;
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
  const logical = row.preparationId?.startsWith("evm-transaction-set:")
    ? row.preparationId.slice("evm-transaction-set:".length)
    : undefined;
  const labelled = /^(stamp|contact|forum)-([0-9a-f]+)$/.exec(logical ?? "");
  const purpose =
    labelled?.[1] === "stamp"
      ? ("stamp" as const)
      : labelled?.[1] === "contact"
      ? ("contact-payment" as const)
      : labelled?.[1] === "forum"
      ? ("forum" as const)
      : ("transfer" as const);
  return {
    operationId: row.operationId,
    chainIdentifier: row.binding.chainIdentifier,
    kind: row.kind,
    recipient: row.recipient,
    purpose,
    ...(labelled && labelled[1] !== "forum" && labelled[2].length === 32
      ? { messageId: labelled[2] }
      : {}),
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

/**
 * The message stamps appended to an operation as their own stages (a contact payment and its
 * message's stamp are one transaction set: `stamp-<message id>` stages after the payment leg).
 * Each is shown as its own send, with purpose `stamp`: its members, what it paid and what the
 * chain did with it. The operation's own summary keeps every member (so none is shown twice).
 */
export function summarizeEvmNativeStampStages(
  row: EvmNativeOperation,
  syncFailed = false
): EvmNativeOperationStatus[] {
  if (row.kind !== "transaction-set") return [];
  const whole = summarizeEvmNativeOperation(row, syncFailed);
  return (row.transactionSetStages ?? []).flatMap((stage) => {
    const labelled = /^stamp-([0-9a-f]+)$/.exec(stage.stageId ?? "");
    if (!labelled) return [];
    const indexes = row.members.flatMap((member, index) =>
      member.transactionSet?.stageId === stage.stageId ? [index] : []
    );
    const payments = indexes.filter(
      (index) => row.members[index]!.transactionSet!.role === "payment"
    );
    const first = payments[0];
    if (first === undefined) return [];
    const members = indexes.map((index) => whole.members[index]!);
    const states = payments.map((index) => whole.members[index]!.state);
    const observed = members.filter((member) => member.feeWei !== undefined);
    const included = indexes.filter(
      (index) => row.members[index]!.observation.state === "included-success"
    );
    const payment = row.cancelled
      ? "cancelled"
      : states.every((state) => state === "included-success")
      ? "included"
      : states.every((state) => state === "included-revert")
      ? "reverted"
      : states.some((state) => state === "included-success")
      ? "partial"
      : states.some((state) => state === "pending")
      ? "pending"
      : states.some((state) => state === "missing")
      ? "missing"
      : states.every((state) => state === "superseded")
      ? "superseded"
      : "unknown";
    const status: EvmNativeOperationStatus = {
      operationId: `${row.operationId}:${stage.stageId}`,
      chainIdentifier: row.binding.chainIdentifier,
      kind: row.kind,
      recipient: Transaction.from(
        row.members[first]!.unsignedTransaction
      ).to!.toLowerCase(),
      purpose: "stamp",
      ...(labelled[1].length === 32 ? { messageId: labelled[1] } : {}),
      intendedValueWei: stage.intendedValueWei,
      payment,
      finalTransactionHash:
        row.members[payments[payments.length - 1]!]!.signed?.transactionHash,
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
      sharing:
        included.length === 0
          ? "none"
          : included.every((index) => row.members[index]!.syncApplied)
          ? "shared"
          : syncFailed
          ? "failed"
          : "not-shared",
    };
    return [status];
  });
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
