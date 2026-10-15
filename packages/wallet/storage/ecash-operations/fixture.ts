import type { EcashOperationLedger } from "../../ecash-operation-store";

/** Public synthetic persistence fixture. No usable address, key or transaction. */
export const binding = {
  chainIdentifier: "xec-testnet",
  walletAddress: "ectest:synthetic-store-fixture",
};

export function fixture(): EcashOperationLedger {
  return {
    version: 1,
    ...binding,
    nextChangeIndex: 1,
    operations: [
      {
        operationId: "synthetic-original",
        intent: {
          recipient: "ectest:synthetic-recipient",
          value: "9007199254740993000",
          maxFee: "1000",
        },
        state: "exposed",
        exposure: { kind: "native-rpc" },
        transactions: [{ txid: "11".repeat(32), rawTransaction: "aabb" }],
        inputs: [
          { txid: "22".repeat(32), vout: 3, satoshis: "9007199254740994000" },
        ],
        fee: "1000",
        nextChangeIndex: 1,
      },
    ],
    consumedInputs: [{ txid: "33".repeat(32), vout: 4 }],
  };
}
