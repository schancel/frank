import {
  NativeEvmTransactionBuilder,
  defaultNativeEvmTransactionBuilder,
} from "./evm-transaction-builder";

describe("NativeEvmTransactionBuilder", () => {
  const builder = new NativeEvmTransactionBuilder();

  it("queries provider for native balance", async () => {
    const mockProvider = {
      getBalance: jest.fn().mockResolvedValue(1000000000000000000n),
    } as any;

    const balance = await builder.getBalance({
      address: "0x1111111111111111111111111111111111111111",
      provider: mockProvider,
    });

    expect(mockProvider.getBalance).toHaveBeenCalledWith(
      "0x1111111111111111111111111111111111111111"
    );
    expect(balance).toBe(1000000000000000000n);
  });

  it("builds a native transfer with 21,000 gas limit default", async () => {
    const tx = await builder.buildTransfer({
      from: "0x1111111111111111111111111111111111111111",
      recipient: "0x2222222222222222222222222222222222222222",
      amount: 500000000000000000n,
    });

    expect(tx).toEqual({
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222",
      value: 500000000000000000n,
      data: "0x",
      gasLimit: 21_000n,
    });
  });

  it("honors overrides when building a native transfer", async () => {
    const tx = await builder.buildTransfer({
      from: "0x1111111111111111111111111111111111111111",
      recipient: "0x2222222222222222222222222222222222222222",
      amount: 100n,
      overrides: {
        gasLimit: 30_000n,
        maxFeePerGas: 2000000000n,
        maxPriorityFeePerGas: 1000000000n,
        nonce: 5,
      },
    });

    expect(tx.gasLimit).toBe(30_000n);
    expect(tx.maxFeePerGas).toBe(2000000000n);
    expect(tx.maxPriorityFeePerGas).toBe(1000000000n);
    expect(tx.nonce).toBe(5);
  });

  it("builds a burn transaction carrying commitment data", async () => {
    const tx = await builder.buildBurn({
      from: "0x1111111111111111111111111111111111111111",
      burnAddress: "0x000000000000000000000000000000000000dEaD",
      amount: 10000000000000000n,
      commitmentData: "0xdeadbeef",
    });

    expect(tx).toEqual({
      from: "0x1111111111111111111111111111111111111111",
      to: "0x000000000000000000000000000000000000dEaD",
      value: 10000000000000000n,
      data: "0xdeadbeef",
    });
  });

  it("exports a singleton defaultNativeEvmTransactionBuilder", () => {
    expect(defaultNativeEvmTransactionBuilder).toBeInstanceOf(
      NativeEvmTransactionBuilder
    );
  });
});
