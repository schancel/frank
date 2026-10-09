import { Transaction } from "ethers";
import type { EvmNativeOperation } from "../storage/evm-native-operation-journal";

/** Public evidence only. The native journal remains the sole financial authority. */
export interface EvmNativeOperationStatus {
  readonly operationId: string;
  readonly chainIdentifier: string;
  readonly recipient: string;
  readonly intendedValueWei: string;
  readonly payment:
    | "included"
    | "reverted"
    | "partial"
    | "pending"
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
  /** Records callback completion only, never local or all-device synchronization. */
  readonly syncCallbackComplete: boolean;
}

/** Pure projection of validated owner rows; never exposes signing bytes or derivation material. */
export function summarizeEvmNativeOperation(
  row: EvmNativeOperation
): EvmNativeOperationStatus {
  const final = row.members[row.members.length - 1];
  if (!final) throw new Error("Native operation has no recipient member");
  const transaction = Transaction.from(final.unsignedTransaction);
  if (
    transaction.to?.toLowerCase() !== row.recipient.toLowerCase() ||
    transaction.value.toString() !== row.intendedValueWei ||
    transaction.chainId.toString() !== row.binding.nativeChainId ||
    transaction.data !== "0x"
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
    : "unknown";
  return {
    operationId: row.operationId,
    chainIdentifier: row.binding.chainIdentifier,
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
    syncCallbackComplete: row.members.every((member) => member.syncApplied),
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
