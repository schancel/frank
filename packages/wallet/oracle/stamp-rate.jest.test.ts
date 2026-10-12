import {
  createStampDefaultResolver,
  STALE_AFTER_MS,
  MINING_STALE_AFTER_MS,
} from "./stamp-rate";
import { stampPolicyConfig } from "./stamp-policy";
import {
  ASSET_DECIMALS,
  unavailableOracleRates,
  type SupportedAsset,
} from "./price-oracle";

const NOW = 1_800_000_000_000;
function observation(asset: SupportedAsset = "monad") {
  return {
    ...unavailableOracleRates(NOW / 1000),
    rates: { [asset]: 0.25 },
    priceAt: { [asset]: NOW / 1000 },
    avuHash: {
      kwhPerValue: 10,
      entries: [],
      leftOut: [],
      basketSize: 1,
      oldestInputAt: NOW / 1000,
      stale: false,
    },
  };
}
const context = { chainIdentifier: "monad-testnet", minimumStamp: 1n };
function resolver(
  getRates: () => ReturnType<typeof observation>,
  asset: SupportedAsset = "monad",
  supportsDirectMessages = true
) {
  return createStampDefaultResolver({
    chainIdentifier: context.chainIdentifier,
    asset,
    supportsDirectMessages,
    baseUnitsPerCoin: 10n ** BigInt(ASSET_DECIMALS[asset]),
    config: stampPolicyConfig(),
    getRates,
    now: () => NOW,
  });
}

describe("host observations for AVU stamp defaults", () => {
  it("uses a configured native-unit fallback while the conversion rate is missing, without inventing a rate", async () => {
    const resolve = createStampDefaultResolver({
      chainIdentifier: context.chainIdentifier,
      asset: "monad",
      supportsDirectMessages: true,
      baseUnitsPerCoin: 10n ** 18n,
      config: stampPolicyConfig(),
      fallbackStamp: 10n ** 16n,
      getRates: () => unavailableOracleRates(NOW / 1000),
      now: () => NOW,
    });
    expect(
      await resolve({ ...context, minimumStamp: 2n * 10n ** 16n })
    ).toEqual({
      status: "available",
      chainIdentifier: context.chainIdentifier,
      amount: 2n * 10n ** 16n,
      targetAmount: 10n ** 16n,
      minimumStamp: 2n * 10n ** 16n,
      pricingBasis: "configured-fallback",
    });
    expect(
      await resolve({ ...context, minimumStamp: undefined })
    ).toMatchObject({
      status: "unavailable",
      reason: "missing-fee",
    });
    expect(
      await resolve({ ...context, minimumStamp: -1n })
    ).toMatchObject({ status: "unavailable", reason: "missing-fee" });
    expect(
      await createStampDefaultResolver({
        chainIdentifier: context.chainIdentifier,
        asset: "monad",
        supportsDirectMessages: true,
        baseUnitsPerCoin: 10n ** 18n,
        config: stampPolicyConfig(),
        fallbackStamp: 0n,
        getRates: () => unavailableOracleRates(NOW / 1000),
        now: () => NOW,
      })(context)
    ).toMatchObject({ status: "unavailable", reason: "missing-rate" });
  });
  it("prefers a fresh AVU quote and uses the native fallback only when that quote is stale", async () => {
    const rates = observation();
    const resolve = createStampDefaultResolver({
      chainIdentifier: context.chainIdentifier,
      asset: "monad",
      supportsDirectMessages: true,
      baseUnitsPerCoin: 10n ** 18n,
      config: stampPolicyConfig(),
      fallbackStamp: 10n ** 16n,
      getRates: () => rates,
      now: () => NOW,
    });
    expect(await resolve(context)).toMatchObject({
      status: "available",
      amount: 400000000000000000n,
      rateAt: NOW / 1000,
    });
    rates.avuHash.stale = true;
    expect(await resolve(context)).toMatchObject({
      status: "available",
      amount: 10n ** 16n,
      pricingBasis: "configured-fallback",
    });
  });
  it.each([
    ["monad", 400000000000000000n],
    ["solana", 400000000n],
    ["ecash", 40n],
  ] as const)(
    "uses existing %s asset base units with an injected adapter floor",
    async (asset, amount) => {
      expect(
        await resolver(() => observation(asset), asset)(context)
      ).toMatchObject({ status: "available", amount });
    }
  );
  it("rejects price and mining readings past the shared oracle freshness thresholds", async () => {
    const rates = observation();
    rates.priceAt.monad -= (STALE_AFTER_MS + 1) / 1000;
    expect(await resolver(() => rates)(context)).toMatchObject({
      reason: "stale-rate",
    });
    rates.priceAt.monad = NOW / 1000;
    rates.avuHash.oldestInputAt -= (MINING_STALE_AFTER_MS + 1) / 1000;
    expect(await resolver(() => rates)(context)).toMatchObject({
      reason: "stale-rate",
    });
  });
  it("honors provider stale flags and reports missing observations without a fallback", async () => {
    const rates = observation();
    rates.avuHash.stale = true;
    expect(await resolver(() => rates)(context)).toMatchObject({
      reason: "stale-rate",
    });
    expect(
      await createStampDefaultResolver({
        chainIdentifier: context.chainIdentifier,
        asset: "monad",
        supportsDirectMessages: true,
        baseUnitsPerCoin: 10n ** 18n,
        config: stampPolicyConfig(),
        getRates: () => unavailableOracleRates(),
        now: () => NOW,
      })(context)
    ).toMatchObject({ reason: "missing-rate" });
  });
  it("does not read a quote for unsupported capabilities or another canonical chain", async () => {
    const getRates = jest.fn(() => observation());
    expect(await resolver(getRates, "monad", false)(context)).toMatchObject({
      reason: "unsupported",
    });
    expect(
      await resolver(getRates)({
        ...context,
        chainIdentifier: "monad-mainnet",
      })
    ).toMatchObject({ reason: "unsupported" });
    expect(getRates).not.toHaveBeenCalled();
  });
});

it("refuses a priced asset whose raw unit differs from the configured adapter", async () => {
  const getRates = jest.fn(() => observation("tempo"));
  const resolve = createStampDefaultResolver({
    chainIdentifier: "tempo-testnet",
    asset: "tempo",
    supportsDirectMessages: true,
    baseUnitsPerCoin: 10n ** 18n,
    config: stampPolicyConfig(),
    getRates,
    now: () => NOW,
  });
  expect(
    await resolve({ chainIdentifier: "tempo-testnet", minimumStamp: 0n })
  ).toMatchObject({ reason: "unsupported" });
  expect(getRates).not.toHaveBeenCalled();
});

it("accepts an adapter zero fee floor, distinct from a missing fee estimate", async () => {
  const getRates = jest.fn(() => observation());
  const resolve = resolver(getRates);
  expect(await resolve({ ...context, minimumStamp: 0n })).toMatchObject({
    status: "available",
    minimumStamp: 0n,
  });
  getRates.mockClear();
  expect(
    await resolve({ chainIdentifier: context.chainIdentifier })
  ).toMatchObject({ reason: "missing-fee" });
  expect(getRates).not.toHaveBeenCalled();
});

it("carries the subsidy-only rate basis into the native default quote", async () => {
  const rates = observation();
  Object.assign(rates.avuHash, {
    entries: [{ id: "bitcoin", label: "Bitcoin", feesIncluded: false }],
  });
  expect(await resolver(() => rates)(context)).toMatchObject({
    status: "available",
    amount: 400000000000000000n,
    rateFeeCoverage: "subsidy-only",
  });
});
