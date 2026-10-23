import { getBytes, hexlify, Transaction, Wallet } from "ethers";
import { evmTransactionSetCapability } from "./evm-transaction-set-public";
import type { ConstructEvmTransactionSetRequest, PreparedEvmTransaction } from "./evm-transaction-set-types";
import type { ConstructTransactionSetRequest, PreparedTransactionSet } from "./transaction-set";

it("projects signed EVM recipient bytes through the family-neutral API and excludes self change", async () => {
  const source = new Wallet(`0x${"11".repeat(32)}`);
  const destination = `0x${"22".repeat(20)}`;
  const change = `0x${"33".repeat(20)}`;
  const amount = 9_007_199_254_740_993n;
  const calldata = new Uint8Array([0, 1, 0xff]);
  const kdf = jest.fn(() => getBytes(destination));
  const construct = jest.fn(async (request: ConstructEvmTransactionSetRequest) => {
    const to = request.kdf(3);
    const members: PreparedEvmTransaction[] = [];
    for (const [index, address, value, data] of [
      [3, to, request.amountWei, request.calldata],
      [4, change, 100_000n, "0x"],
    ] as const) {
      const rawTransaction = await source.signTransaction({
        chainId: 1337, nonce: index, to: address, value, data,
        gasLimit: 50_000n, gasPrice: 1n,
      });
      members.push({
        logicalIndex: index, sourceAccount: source.address, nonce: index,
        destination: address, valueWei: value, gasLimit: 50_000n,
        rawTransaction, txHash: Transaction.from(rawTransaction).hash!,
      });
    }
    return {
      operationId: request.operationId, chainIdentifier: "evm-local",
      bundle: [members[0]], otherTransactions: [members[1]],
    };
  });
  const capability = evmTransactionSetCapability({ constructTransactionSet: construct });
  // The same request/result types compile for Bitcoin's NativeWalletHandle capability.
  const request: ConstructTransactionSetRequest = {
    operationId: "common", amountAtomic: amount, kdf, calldata,
    maxNativeFeeAtomic: 100_000n,
  };
  const result: PreparedTransactionSet = await capability.constructTransactionSet(request);
  expect(kdf).toHaveBeenCalledWith(3, 0);
  expect(construct.mock.calls[0][0]).toMatchObject({
    operationId: "common", amountWei: amount, calldata: "0x0001ff", maxFeeWei: 100_000n,
  });
  expect(result.bundle).toHaveLength(1);
  expect(result.bundle[0]).toMatchObject({
    index: 3, recipientOutputs: [{ outputIndex: 0, destination: getBytes(destination), amountAtomic: amount }],
  });
  const decoded = Transaction.from(hexlify(result.bundle[0].rawTransaction));
  expect(decoded.from).toBe(source.address);
  expect(decoded.to?.toLowerCase()).toBe(destination);
  expect(decoded.value).toBe(amount);
  expect(decoded.data).toBe(hexlify(calldata));
  expect(decoded.hash).toBe(result.bundle[0].txId);
  expect(result.otherTransactions).toHaveLength(1);
  expect(Transaction.from(hexlify(result.otherTransactions[0].rawTransaction)).to?.toLowerCase()).toBe(change);
  expect(Object.keys(result.otherTransactions[0]).sort()).toEqual(["rawTransaction", "txId"]);
});

it("rejects a non-address EVM destination at the preparation boundary", async () => {
  const capability = evmTransactionSetCapability({
    async constructTransactionSet(request) {
      request.kdf(0);
      throw new Error("unreachable");
    },
  });
  await expect(capability.constructTransactionSet({
    operationId: "bad", amountAtomic: 1n, kdf: () => new Uint8Array(19),
  })).rejects.toThrow("exactly 20 bytes");
});
