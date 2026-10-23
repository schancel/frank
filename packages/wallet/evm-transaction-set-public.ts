import { getAddress, getBytes, hexlify } from "ethers";
import type {
  ConstructEvmTransactionSetRequest,
  PreparedEvmTransactionSet,
} from "./evm-transaction-set-types";
import type {
  TransactionSetCapability,
  PreparedTransactionSet,
} from "./transaction-set";

/** Adapt the wallet-owned EVM preparer without exposing nonce/gas/account construction state. */
export function evmTransactionSetCapability(preparer: {
  constructTransactionSet(request: ConstructEvmTransactionSetRequest): Promise<PreparedEvmTransactionSet>;
}): TransactionSetCapability {
  return {
    async constructTransactionSet(request): Promise<PreparedTransactionSet> {
      const result = await preparer.constructTransactionSet({
        operationId: request.operationId,
        amountWei: request.amountAtomic,
        kdf(index) {
          const destination = request.kdf(index, 0);
          if (destination.length !== 20)
            throw new Error("EVM transaction-set destination must be exactly 20 bytes");
          return getAddress(hexlify(destination));
        },
        ...(request.calldata === undefined ? {} : { calldata: hexlify(request.calldata) }),
        ...(request.maxNativeFeeAtomic === undefined ? {} : { maxFeeWei: request.maxNativeFeeAtomic }),
      });
      return {
        operationId: result.operationId,
        chainIdentifier: result.chainIdentifier,
        bundle: result.bundle.map((member) => ({
          index: member.logicalIndex,
          rawTransaction: getBytes(member.rawTransaction),
          txId: member.txHash,
          recipientOutputs: [{
            outputIndex: 0,
            destination: getBytes(member.destination),
            amountAtomic: member.valueWei,
          }],
        })),
        otherTransactions: result.otherTransactions.map((member) => ({
          rawTransaction: getBytes(member.rawTransaction),
          txId: member.txHash,
        })),
      };
    },
  };
}
