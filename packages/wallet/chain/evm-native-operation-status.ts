import { Transaction } from "ethers";
import type { EvmNativeOperation } from "../storage/evm-native-operation-journal";

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
    /** The chain could not be read, so nothing is known. Never a state of the transfer. */
    | "unknown"
    | "cancelled";
  readonly finalTransactionHash?: string;
  readonly members: readonly {
    readonly transactionHash?: string;
    readonly state:
      | "unknown"
      | "missing"
      | "pending"
      | "included-success"
      | "included-revert";
    readonly blockNumber?: number;
    readonly feeWei?: string;
  }[];
  readonly observedFeeWei: string;
  readonly feeCoverage: "complete" | "partial" | "unknown";
  /** The note that tells the account's other devices about this operation: `shared` once the
   * relay took it for every member, `failed` when this session's last attempt did not get through
   * (it is tried again), `not-shared` otherwise. Information only, never the payment's outcome,
   * and not a confirmation that another device applied it. */
  readonly sharing: "shared" | "not-shared" | "failed";
}

/** Pure projection of validated owner rows; never exposes signing bytes or derivation material. */
export function summarizeEvmNativeOperation(
  row: EvmNativeOperation,
  /** From the wallet handle's `nativeOperationSyncFailed`; session memory, not a journal fact. */
  syncFailed = false
): EvmNativeOperationStatus {
  const final = row.members[row.members.length - 1];
  if (!final) throw new Error("Native operation has no recipient member");
  const transaction = Transaction.from(final.unsignedTransaction);
  if (
    transaction.to?.toLowerCase() !== row.recipient.toLowerCase() ||
    transaction.value.toString() !== row.intendedValueWei ||
    transaction.chainId.toString() !== row.binding.nativeChainId ||
    (transaction.data !== "0x") !== (row.kind === "contract")
  )
    throw new Error("Native operation recipient evidence does not match");
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
      transactionHash: member.signed?.transactionHash,
      state: observation.state,
      ...(included
        ? { blockNumber: observation.blockNumber, feeWei: observation.feeWei }
        : {}),
    };
  });
  const observed = members.filter((member) => member.feeWei !== undefined);
  const payment = row.cancelled
    ? "cancelled"
    : final.observation.state === "included-success"
    ? "included"
    : final.observation.state === "included-revert"
    ? "reverted"
    : members.some((member) => member.state === "included-success")
    ? "partial"
    : members.some((member) => member.state === "pending")
    ? "pending"
    : members.some((member) => member.state === "missing")
    ? "missing"
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
    sharing: row.members.every((member) => member.syncApplied)
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
