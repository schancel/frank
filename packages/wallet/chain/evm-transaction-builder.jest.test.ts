import {
  NativeEvmTransactionBuilder,
  defaultNativeEvmTransactionBuilder,
  Tip20TransactionBuilder,
  defaultTempoTransactionBuilder,
  TEMPO_PATH_USD_ADDRESS,
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

  describe("buildZeroRefundDrain", () => {
    const from = "0x1111111111111111111111111111111111111111";
    const recipient = "0x2222222222222222222222222222222222222222";
    const baseFeeWei = 25_000_000_000n;

    it("produces equal maxFeePerGas and maxPriorityFeePerGas with default 1 gwei tip", async () => {
      const balanceWei = 1_000_000_000_000_000_000n;
      const tx = await builder.buildZeroRefundDrain({
        from,
        recipient,
        balanceWei,
        baseFeeWei,
      });

      const expectedMaxFee = baseFeeWei + 1_000_000_000n;
      expect(tx.maxFeePerGas).toBe(expectedMaxFee);
      expect(tx.maxPriorityFeePerGas).toBe(expectedMaxFee);
      expect(tx.gasLimit).toBe(21_000n);
      expect(tx.from).toBe(from);
      expect(tx.to).toBe(recipient);
      expect(tx.data).toBe("0x");
    });

    it("verifies value + gasLimit * maxFeePerGas === balanceWei", async () => {
      const balanceWei = 500_000_000_000_000_000n;
      const tx = await builder.buildZeroRefundDrain({
        from,
        recipient,
        balanceWei,
        baseFeeWei,
      });

      const gasLimit = BigInt(tx.gasLimit as bigint);
      const maxFeePerGas = BigInt(tx.maxFeePerGas as bigint);
      const value = BigInt(tx.value as bigint);

      expect(value + gasLimit * maxFeePerGas).toBe(balanceWei);
      expect(value).toBe(balanceWei - 21_000n * (baseFeeWei + 1_000_000_000n));
    });

    it("honors custom gasLimit, priorityTipWei, and nonce", async () => {
      const balanceWei = 100_000_000_000_000_000n;
      const customGasLimit = 35_000n;
      const customTip = 2_500_000_000n;
      const customNonce = 12;

      const tx = await builder.buildZeroRefundDrain({
        from,
        recipient,
        balanceWei,
        baseFeeWei,
        priorityTipWei: customTip,
        gasLimit: customGasLimit,
        nonce: customNonce,
      });

      const expectedMaxFee = baseFeeWei + customTip;
      expect(tx.gasLimit).toBe(customGasLimit);
      expect(tx.maxFeePerGas).toBe(expectedMaxFee);
      expect(tx.maxPriorityFeePerGas).toBe(expectedMaxFee);
      expect(tx.nonce).toBe(customNonce);

      const gasLimit = BigInt(tx.gasLimit as bigint);
      const maxFeePerGas = BigInt(tx.maxFeePerGas as bigint);
      const value = BigInt(tx.value as bigint);
      expect(value + gasLimit * maxFeePerGas).toBe(balanceWei);
    });

    it("throws RangeError if balance is strictly less than required zero-refund drain fee", async () => {
      const gasLimit = 21_000n;
      const maxFeePerGas = baseFeeWei + 1_000_000_000n;
      const exactFee = gasLimit * maxFeePerGas;

      await expect(
        builder.buildZeroRefundDrain({
          from,
          recipient,
          balanceWei: exactFee - 1n,
          baseFeeWei,
        })
      ).rejects.toThrow(
        new RangeError(
          "Account balance is insufficient to pay zero-refund drain fee"
        )
      );
    });

    it("throws RangeError if balance is exactly equal to zero-refund drain fee", async () => {
      const gasLimit = 21_000n;
      const maxFeePerGas = baseFeeWei + 1_000_000_000n;
      const exactFee = gasLimit * maxFeePerGas;

      await expect(
        builder.buildZeroRefundDrain({
          from,
          recipient,
          balanceWei: exactFee,
          baseFeeWei,
        })
      ).rejects.toThrow(
        new RangeError(
          "Account balance is insufficient to pay zero-refund drain fee"
        )
      );
    });

    it("throws RangeError if balance is zero", async () => {
      await expect(
        builder.buildZeroRefundDrain({
          from,
          recipient,
          balanceWei: 0n,
          baseFeeWei,
        })
      ).rejects.toThrow(
        new RangeError(
          "Account balance is insufficient to pay zero-refund drain fee"
        )
      );
    });
  });

  it("exports a singleton defaultNativeEvmTransactionBuilder", () => {
    expect(defaultNativeEvmTransactionBuilder).toBeInstanceOf(
      NativeEvmTransactionBuilder
    );
  });
});

describe("Tip20TransactionBuilder", () => {
  const builder = new Tip20TransactionBuilder();

  it("queries balanceOf via provider.call", async () => {
    // abi-encoded uint256(5000000) = 0x0000...004c4b40
    const encodedValue =
      "0x00000000000000000000000000000000000000000000000000000000004c4b40";
    const mockProvider = {
      call: jest.fn().mockResolvedValue(encodedValue),
    } as any;

    const balance = await builder.getBalance({
      address: "0x1111111111111111111111111111111111111111",
      provider: mockProvider,
    });

    expect(mockProvider.call).toHaveBeenCalledWith(
      expect.objectContaining({
        to: TEMPO_PATH_USD_ADDRESS,
      })
    );
    expect(balance).toBe(5000000n);
  });

  it("returns 0n if provider.call returns empty data", async () => {
    const mockProvider = {
      call: jest.fn().mockResolvedValue("0x"),
    } as any;

    const balance = await builder.getBalance({
      address: "0x1111111111111111111111111111111111111111",
      provider: mockProvider,
    });

    expect(balance).toBe(0n);
  });

  it("builds a TIP-20 transfer with value: 0n and calldata encoded", async () => {
    const tx = await builder.buildTransfer({
      from: "0x1111111111111111111111111111111111111111",
      recipient: "0x2222222222222222222222222222222222222222",
      amount: 1000000n,
    });

    expect(tx.to).toBe(TEMPO_PATH_USD_ADDRESS);
    expect(tx.from).toBe("0x1111111111111111111111111111111111111111");
    expect(tx.value).toBe(0n);
    expect(tx.gasLimit).toBe(65_000n);
    // transfer(address,uint256) selector is 0xa9059cbb
    expect(typeof tx.data === "string" && tx.data.startsWith("0xa9059cbb")).toBe(
      true
    );
  });

  it("builds a burn transaction targeting the token contract with transfer to burnAddress", async () => {
    const tx = await builder.buildBurn({
      from: "0x1111111111111111111111111111111111111111",
      burnAddress: "0x000000000000000000000000000000000000dEaD",
      amount: 1000000n,
      commitmentData: "0xfeedbeef",
    });

    expect(tx.to).toBe(TEMPO_PATH_USD_ADDRESS);
    expect(tx.value).toBe(0n);
    // Should include transfer selector and end with commitment bytes
    expect(typeof tx.data === "string" && tx.data.startsWith("0xa9059cbb")).toBe(
      true
    );
    expect(typeof tx.data === "string" && tx.data.endsWith("feedbeef")).toBe(
      true
    );
  });

  describe("buildZeroRefundDrain", () => {
    const from = "0x1111111111111111111111111111111111111111";
    const recipient = "0x2222222222222222222222222222222222222222";
    const baseFeeWei = 25_000_000_000n;

    it("builds a TIP-20 zero-refund drain encoding transfer data and value 0n", async () => {
      const balanceWei = 50_000_000_000_000_000n;
      const tx = await builder.buildZeroRefundDrain({
        from,
        recipient,
        balanceWei,
        baseFeeWei,
      });

      const expectedMaxFee = baseFeeWei + 1_000_000_000n;
      expect(tx.maxFeePerGas).toBe(expectedMaxFee);
      expect(tx.maxPriorityFeePerGas).toBe(expectedMaxFee);
      expect(tx.gasLimit).toBe(65_000n);
      expect(tx.to).toBe(TEMPO_PATH_USD_ADDRESS);
      expect(tx.value).toBe(0n);
      expect(
        typeof tx.data === "string" && tx.data.startsWith("0xa9059cbb")
      ).toBe(true);
    });

    it("throws RangeError on insufficient balance", async () => {
      await expect(
        builder.buildZeroRefundDrain({
          from,
          recipient,
          balanceWei: 100n,
          baseFeeWei,
        })
      ).rejects.toThrow(
        new RangeError(
          "Account balance is insufficient to pay zero-refund drain fee"
        )
      );
    });
  });

  it("exports defaultTempoTransactionBuilder pointing to pathUSD", () => {
    expect(defaultTempoTransactionBuilder.tokenAddress).toBe(
      TEMPO_PATH_USD_ADDRESS
    );
  });
});

