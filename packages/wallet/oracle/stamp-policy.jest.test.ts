import {
  avuToRawCeil,
  DEFAULT_STAMP_TARGET_AVU,
  quoteDefaultStamp,
  stampPolicyConfig,
} from "./stamp-policy";

describe("the default stamp AVU policy", () => {
  it("defaults to a fixed 0.1 AVU recipient target and accepts the public override", () => {
    expect(DEFAULT_STAMP_TARGET_AVU).toBe("0.1");
    expect(stampPolicyConfig()).toEqual({ targetAvu: "0.1" });
    expect(stampPolicyConfig("0.25")).toEqual({ targetAvu: "0.25" });
    for (const value of ["0", "-1", "NaN", "Infinity", "", "1x"])
      expect(() => stampPolicyConfig(value)).toThrow();
  });

  it.each([
    [18, "0.24", 416666666666666667n],
    [9, "150", 666667n],
    [2, "0.0003", 33334n],
  ] as const)(
    "rounds upward at %s decimals without floating monetary arithmetic",
    (decimals, rate, expected) => {
      expect(avuToRawCeil("0.1", rate, decimals)).toBe(expected);
    }
  );

  it("retains exact whole results, scientific rate notation, and amounts beyond Number precision", () => {
    expect(avuToRawCeil("0.1", "0.25", 18)).toBe(400000000000000000n);
    expect(avuToRawCeil("0.100000000000000001", "0.3", 18)).toBe(
      333333333333333337n
    );
    expect(avuToRawCeil("0.1", 1e-9, 9)).toBe(100000000000000000n);
    expect(avuToRawCeil("9007199254740993", "1", 0)).toBe(9007199254740993n);
    expect(avuToRawCeil("0.000000000000000001", "2", 18)).toBe(1n);
  });

  const observation = {
    chainIdentifier: "monad-testnet",
    supportsDirectMessages: true,
    decimals: 18,
    config: stampPolicyConfig(),
    avuPerCoin: "0.25",
    rateAt: 1791633600,
    minimumStamp: 2100000000000000n,
  };

  it("uses the target or the selected adapter floor, whichever is larger", () => {
    expect(quoteDefaultStamp(observation)).toEqual({
      status: "available",
      chainIdentifier: "monad-testnet",
      amount: 400000000000000000n,
      targetAmount: 400000000000000000n,
      minimumStamp: observation.minimumStamp,
      rateAt: observation.rateAt,
    });
    expect(
      quoteDefaultStamp({ ...observation, minimumStamp: 500000000000000000n })
    ).toMatchObject({ amount: 500000000000000000n });
  });

  it.each([
    [{ supportsDirectMessages: false }, "unsupported"],
    [{ avuPerCoin: undefined }, "missing-rate"],
    [{ avuPerCoin: 0 }, "missing-rate"],
    [{ rateAt: undefined }, "missing-rate"],
    [{ rateAt: NaN }, "missing-rate"],
    [{ rateStale: true }, "stale-rate"],
    [{ minimumStamp: undefined }, "missing-fee"],
  ] as const)("reports unavailable inputs explicitly", (overrides, reason) => {
    expect(quoteDefaultStamp({ ...observation, ...overrides })).toEqual({
      status: "unavailable",
      chainIdentifier: "monad-testnet",
      reason,
    });
  });

  it("carries canonical network identity and supports family-specific units without EVM fee assumptions", () => {
    expect(
      quoteDefaultStamp({
        ...observation,
        chainIdentifier: "solana-devnet",
        decimals: 9,
        avuPerCoin: "150",
        minimumStamp: 5000n,
      })
    ).toMatchObject({ chainIdentifier: "solana-devnet", amount: 666667n });
    expect(
      quoteDefaultStamp({
        ...observation,
        chainIdentifier: "xec-testnet",
        decimals: 2,
        avuPerCoin: "0.0003",
        minimumStamp: 600n,
      })
    ).toMatchObject({ chainIdentifier: "xec-testnet", amount: 33334n });
  });
});
