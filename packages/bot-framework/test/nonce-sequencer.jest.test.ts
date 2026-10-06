import { EVMNonceSequencer } from "../src/nonce-sequencer";

describe("EVMNonceSequencer", () => {
  it("serializes operations and queries nonce once initialized", async () => {
    let mockOnChainNonce = 5;
    const mockProvider = {
      getTransactionCount: jest
        .fn()
        .mockImplementation(async () => mockOnChainNonce),
    } as any;

    const sequencer = new EVMNonceSequencer(
      mockProvider,
      "0x1234567890123456789012345678901234567890"
    );

    const executionOrder: number[] = [];

    const p1 = sequencer.withNonce(async (nonce) => {
      executionOrder.push(1);
      expect(nonce).toBe(5);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "tx1";
    });

    const p2 = sequencer.withNonce(async (nonce) => {
      executionOrder.push(2);
      expect(nonce).toBe(6);
      return "tx2";
    });

    const [res1, res2] = await Promise.all([p1, p2]);

    expect(res1).toBe("tx1");
    expect(res2).toBe("tx2");
    expect(executionOrder).toEqual([1, 2]);
    expect(mockProvider.getTransactionCount).toHaveBeenCalledTimes(1);
  });

  it("resets cached nonce on error to re-sync with chain", async () => {
    let mockOnChainNonce = 10;
    const mockProvider = {
      getTransactionCount: jest
        .fn()
        .mockImplementation(async () => mockOnChainNonce),
    } as any;

    const sequencer = new EVMNonceSequencer(
      mockProvider,
      "0x1234567890123456789012345678901234567890"
    );

    await expect(
      sequencer.withNonce(async () => {
        throw new Error("Transaction reverted");
      })
    ).rejects.toThrow("Transaction reverted");

    mockOnChainNonce = 11;
    const res = await sequencer.withNonce(async (nonce) => {
      expect(nonce).toBe(11);
      return "ok";
    });
    expect(res).toBe("ok");
    expect(mockProvider.getTransactionCount).toHaveBeenCalledTimes(2);
  });
});
