import {
  InMemoryEcashOperationStore,
  parseEcashOperationLedger,
} from "./ecash-operation-store";
import type { EcashOperationLedger } from "./ecash-operation-store";

const ledger: EcashOperationLedger = {
  version: 1,
  chainIdentifier: "xec-mainnet",
  walletAddress: "ecash:synthetic-wallet-identity",
  nextChangeIndex: 1,
  operations: [
    {
      operationId: "operation",
      intent: {
        recipient: "ecash:synthetic-recipient",
        value: "9007199254740993000",
        maxFee: "1000",
      },
      state: "prepared",
      transactions: [{ txid: "11".repeat(32), rawTransaction: "aabb" }],
      inputs: [
        { txid: "22".repeat(32), vout: 0, satoshis: "9007199254740994000" },
      ],
      fee: "1000",
      nextChangeIndex: 1,
    },
  ],
};

it("round-trips exact quantities and isolates returned aliases", async () => {
  const store = new InMemoryEcashOperationStore();
  await store.put("canonical-key", ledger);
  const copy = (await store.get("canonical-key"))!;
  expect(copy).toEqual(ledger);
  (copy.operations as unknown[]).length = 0;
  expect(await store.get("canonical-key")).toEqual(ledger);
});

it.each([
  { ...ledger, version: 2 },
  { ...ledger, nextChangeIndex: 0 },
  {
    ...ledger,
    operations: [
      ...ledger.operations,
      { ...ledger.operations[0], operationId: "overlap" },
    ],
  },
  { ...ledger, operations: [{ ...ledger.operations[0], state: "exposed" }] },
  {
    ...ledger,
    operations: [
      {
        ...ledger.operations[0],
        state: "prepared",
        exposure: { kind: "native-rpc" },
      },
    ],
  },
  {
    ...ledger,
    operations: [
      {
        ...ledger.operations[0],
        intent: { ...ledger.operations[0].intent, value: 9007199254740993000 },
      },
    ],
  },
  {
    ...ledger,
    operations: [
      {
        ...ledger.operations[0],
        state: "exposed",
        exposure: {
          kind: "external-payload",
          binding: {
            chainIdentifier: "xec-testnet",
            walletAddress: ledger.walletAddress,
            transactionHashes: ["11".repeat(32)],
            externalPayloadDigest: "33".repeat(32),
          },
        },
      },
    ],
  },
])("rejects corrupt or overlapping financial facts (%#)", (value) => {
  expect(() => parseEcashOperationLedger(JSON.stringify(value))).toThrow();
});
